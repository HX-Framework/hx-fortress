// Rate buckets and lockout, and the two rules that shape both.
//
// RULE ONE — a lockout is never org-wide. Every counter that can REFUSE a named
// principal is keyed on (login, remote-key), so an attacker who guesses at one
// account from one network cannot lock that account out for everybody else, and
// cannot lock out a colleague at all.
//
// The gate-level buckets below are the exception that proves it: they are spent
// before the body is read, so they can only be keyed on the address — which
// behind a proxy every caller shares. They are therefore FLOOD SHEDS, sized for
// an organization rather than a person, and nothing that refuses a principal is
// decided by them. A process-wide sign-in ceiling used to sit above all of this
// and was removed for the same reason: a counter that cannot tell principals
// apart can only refuse them all.
//
// RULE TWO — a remote is never hard-locked. Repeated failures buy an
// exponentially growing delay with a ceiling, not a permanent refusal: a
// permanent one is a denial-of-service an attacker can aim at the operator by
// failing on their behalf. `hx-fortress ui user reset` is the stated remedy for
// the case where the delay is not enough, and it clears state held in another
// process's memory by bumping the user's lockoutEpoch.
//
// Counters live in memory. They are hot — a flood touches them thousands of times
// a second — and users.json is the file `ui user disable` has to write; putting
// the two in one place would queue revocation behind an attack.

export interface BucketPolicy {
  limit: number;
  windowMs: number;
}

/** Every bucket the console meters, with the key each is stored under.
 *
 *  `asset` sits above a full cold load of the SPA (the shell plus every hashed
 *  chunk and font) so a first visit never trips it. `/healthz` is exempt entirely:
 *  a platform health check runs on its own schedule and must not be able to
 *  starve itself. The instance probe gets its own bucket because it answers
 *  before any session exists and is reachable from loopback alone. */
export const BUCKETS = {
  /** Keyed (login, remote-key), and spent INSIDE `signIn` where the login is
   *  known — never at the gate, which runs before the body is read and could
   *  only key it on the address. That address is shared by every caller behind a
   *  proxy (the deployment this console ships for: `publicUrl` set,
   *  `trustedProxies: []`), so a gate-level take of five per minute was the
   *  whole organization's budget and five requests from anywhere denied sign-in
   *  to everybody — a lockout that is org-wide, which RULE ONE above forbids.
   *  The gate keeps its shed for this route through `publicSignIn` below. */
  signIn: { limit: 5, windowMs: 60_000 },
  /** The GATE's shed for the sign-in route, keyed remote-key because that is all
   *  a pre-body check has. Sized for a shared address rather than one person: it
   *  is a flood shed, not a lockout, and the real per-principal metering is
   *  `signIn` above, the exponential account lockout, and the argon gate. */
  publicSignIn: { limit: 240, windowMs: 60_000 },
  // EVERY gate-level bucket below is keyed on the remote key, and behind a
  // proxy — the shape this console ships for, `publicUrl` set with the default
  // `trustedProxies: []` — every caller presents the same one. So each of these
  // is the ORGANIZATION'S budget, not a person's, and a limit sized for one
  // person is an org-wide lockout anybody can trigger: ten unauthenticated
  // requests denying the whole company its one-click entry, twenty denying every
  // new operator their setup link, three hundred making the SPA unloadable for
  // everyone. They are FLOOD SHEDS and are sized as such; the real per-principal
  // metering happens inside each handler, where the principal is known.
  /** Separate from sign-in so a burst of one cannot exhaust the other's budget. */
  ssoEntry: { limit: 240, windowMs: 60_000 },
  /** Shared by setup-status GET and setup completion POST. */
  setup: { limit: 240, windowMs: 60_000 },
  /** A full cold SPA load is dozens of requests, times everyone behind the
   *  proxy who opens the console at the start of a shift. */
  asset: { limit: 3_000, windowMs: 60_000 },
  /** Keyed remote-key (loopback peers only ever reach it). */
  instanceProbe: { limit: 30, windowMs: 60_000 },
  /** Every write the console makes: service control and every command it asks
   *  the daemon for. Keyed remote-key. Low by design — these are operator
   *  gestures, and a rotation or an update is not something anyone does in a
   *  loop. */
  control: { limit: 30, windowMs: 60_000 },
  /** The shared budget for the read class's enumerated store operations. A read
   *  route that reaches the object store is still a read, but it is the one that
   *  can be made to cost money and latency from outside. */
  storeOp: { limit: 60, windowMs: 60_000 },
  /** The read routes that leave a record of themselves. Keyed remote-key. Each
   *  call appends to `hx.admin_audit`, which no role holds DELETE on and nothing
   *  sweeps — so an unmetered one lets a READONLY session grow the embedded
   *  Postgres without bound and without an operator remedy short of dropping the
   *  database. Generous, because these are legitimate operator exports. */
  auditedRead: { limit: 60, windowMs: 60_000 },
} as const satisfies Record<string, BucketPolicy>;

export type BucketName = keyof typeof BUCKETS;

export type BucketVerdict = { ok: true } | { ok: false; retryAfterMs: number };

interface CountingWindow {
  start: number;
  count: number;
}

/** Fixed windows, not a token bucket: the console needs a Retry-After it can
 *  state honestly, and a window boundary is one. */
export class RateLimiter {
  private readonly windows = new Map<string, CountingWindow>();

  take(bucket: BucketName, key: string, now = Date.now()): BucketVerdict {
    return this.takeWith(`${bucket}:${key}`, BUCKETS[bucket], now);
  }


  private takeWith(key: string, policy: BucketPolicy, now: number): BucketVerdict {
    const window = this.windows.get(key);
    if (!window || now - window.start >= policy.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      return { ok: true };
    }
    if (window.count < policy.limit) {
      window.count += 1;
      return { ok: true };
    }
    return { ok: false, retryAfterMs: policy.windowMs - (now - window.start) };
  }

  /** Drop windows that have expired. Called on the server's sweep timer; without
   *  it a wide flood leaves one entry per source forever. */
  sweep(now = Date.now()): number {
    let dropped = 0;
    const longest = Math.max(...Object.values(BUCKETS).map((b) => b.windowMs));
    for (const [key, window] of this.windows) {
      if (now - window.start >= longest) {
        this.windows.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  get size(): number {
    return this.windows.size;
  }
}

// -- Lockout -----------------------------------------------------------------

/** Failures before the delay starts growing. Below it, a mistyped password costs
 *  nothing but the argon2 verify. */
export const LOCKOUT_FREE_ATTEMPTS = 5;
export const LOCKOUT_BASE_MS = 1_000;
/** The ceiling. Deliberately survivable: this is a delay, never a wall. */
export const LOCKOUT_MAX_MS = 15 * 60_000;
/** How long a failure stays "recent" — for the delay, and for the argon gate's
 *  reserved slot. */
export const FAILURE_MEMORY_MS = 30 * 60_000;

interface FailureRecord {
  failures: number;
  lastAt: number;
  lockedUntil: number;
  /** The user's lockoutEpoch when this record was written. A record below the
   *  stored epoch is dropped — that is how `ui user reset` clears a lockout held
   *  in a different process's memory. */
  epoch: number;
}

export type LockoutState =
  | { locked: false; failures: number }
  | { locked: true; failures: number; retryAfterMs: number };

export interface LockoutSnapshot {
  entries: Array<[string, FailureRecord]>;
}

export class LockoutTable {
  private readonly records = new Map<string, FailureRecord>();
  private readonly recentByRemote = new Map<string, number>();
  /** The same memory, keyed by LOGIN. Behind a reverse proxy every principal
   *  shares one remote key, so the remote-only memory says "dirty" for everyone
   *  the moment any one attempt fails — and the reservation that exists to let a
   *  real operator through a flood stopped applying to anybody. The login is the
   *  discriminator that survives a shared address. */
  private readonly recentByLogin = new Map<string, { at: number; epoch: number }>();

  private static key(login: string, remoteKey: string): string {
    return `${login} ${remoteKey}`;
  }

  /** Reads the CURRENT epoch from the user record on every call: a record written
   *  before the last `ui user reset` is dropped rather than consulted. */
  state(login: string, remoteKey: string, lockoutEpoch: number, now = Date.now()): LockoutState {
    const key = LockoutTable.key(login, remoteKey);
    const record = this.records.get(key);
    if (!record) return { locked: false, failures: 0 };
    if (record.epoch < lockoutEpoch || now - record.lastAt > FAILURE_MEMORY_MS) {
      this.records.delete(key);
      return { locked: false, failures: 0 };
    }
    return record.lockedUntil > now
      ? { locked: true, failures: record.failures, retryAfterMs: record.lockedUntil - now }
      : { locked: false, failures: record.failures };
  }

  recordFailure(
    login: string,
    remoteKey: string,
    lockoutEpoch: number,
    now = Date.now(),
  ): LockoutState {
    const key = LockoutTable.key(login, remoteKey);
    const current = this.state(login, remoteKey, lockoutEpoch, now);
    const failures = current.failures + 1;
    const over = failures - LOCKOUT_FREE_ATTEMPTS;
    const delay = over <= 0 ? 0 : Math.min(LOCKOUT_BASE_MS * 2 ** (over - 1), LOCKOUT_MAX_MS);
    this.records.set(key, { failures, lastAt: now, lockedUntil: now + delay, epoch: lockoutEpoch });
    this.recentByRemote.set(remoteKey, now);
    this.recentByLogin.set(login, { at: now, epoch: lockoutEpoch });
    return delay > 0 ? { locked: true, failures, retryAfterMs: delay } : { locked: false, failures };
  }

  recordSuccess(login: string, remoteKey: string): void {
    this.records.delete(LockoutTable.key(login, remoteKey));
    // A proven password is POSITIVE evidence about this principal, so the
    // failure memory that decides `isCleanPrincipal` goes with the record. It
    // used to survive a successful sign-in for the full FAILURE_MEMORY_MS. The
    // other way it ends is `ui user reset`, which runs in the CLI process and
    // can only reach this in-memory table through `lockoutEpoch` — which is why
    // the memory carries the epoch it was recorded under.
    this.recentByLogin.delete(login);
  }

  /** A remote with no failure in living memory. The argon gate keeps a slot for
   *  exactly these, so a genuine sign-in gets through a flood. */
  isClean(remoteKey: string, now = Date.now()): boolean {
    const last = this.recentByRemote.get(remoteKey);
    return last === undefined || now - last > FAILURE_MEMORY_MS;
  }

  /** A PRINCIPAL with no failure in living memory — quiet source OR quiet login.
   *
   *  OR, not AND, and that is the whole point. On the deployment this console
   *  ships for (a `publicUrl` behind a proxy, `trustedProxies: []` by default)
   *  every caller collapses onto the peer address, so one attacker failure marks
   *  the shared key dirty for half an hour and the operator — whose own login has
   *  not failed at all — pays a ceiling the attacker is saturating. Asking about
   *  the login as well restores the reservation for exactly the person it was
   *  written for, and takes nothing from the attacker case: a stranger's first
   *  attempt was already clean under the remote-only rule. */
  isCleanPrincipal(
    login: string,
    remoteKey: string,
    now = Date.now(),
    /** The account's current lockout epoch. `ui user reset` bumps it, and that
     *  is the ONLY signal that crosses the process boundary — the CLI cannot
     *  reach this in-memory table, so a memory recorded under an older epoch is
     *  one the operator has already cleared. */
    lockoutEpoch = 0,
  ): boolean {
    if (this.isClean(remoteKey, now)) return true;
    const last = this.recentByLogin.get(login);
    if (last === undefined) return true;
    if (last.epoch < lockoutEpoch) return true;
    return now - last.at > FAILURE_MEMORY_MS;
  }

  sweep(now = Date.now()): number {
    let dropped = 0;
    for (const [key, record] of this.records) {
      if (now - record.lastAt > FAILURE_MEMORY_MS) {
        this.records.delete(key);
        dropped += 1;
      }
    }
    for (const [key, at] of this.recentByRemote) {
      if (now - at > FAILURE_MEMORY_MS) this.recentByRemote.delete(key);
    }
    for (const [key, held] of this.recentByLogin) {
      if (now - held.at > FAILURE_MEMORY_MS) this.recentByLogin.delete(key);
    }
    return dropped;
  }

  /** Periodically persisted by the server so a restart does not hand an attacker
   *  a clean slate. Carries no secret — logins, addresses and counts only. */
  snapshot(): LockoutSnapshot {
    return { entries: [...this.records.entries()] };
  }

  hydrate(snapshot: LockoutSnapshot, now = Date.now()): void {
    for (const [key, record] of snapshot.entries) {
      if (now - record.lastAt > FAILURE_MEMORY_MS) continue;
      this.records.set(key, record);
      const [login, remoteKey] = key.split(" ");
      if (remoteKey) this.recentByRemote.set(remoteKey, record.lastAt);
      if (login) this.recentByLogin.set(login, { at: record.lastAt, epoch: record.epoch });
    }
  }

  get size(): number {
    return this.records.size;
  }
}
