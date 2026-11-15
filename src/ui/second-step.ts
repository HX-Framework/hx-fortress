// The ticket that stands between a proved first factor and a session, while
// the console waits for the code of the second step.
//
// A ticket carries no authority except to finish the one sign-in or the one
// setup it was issued for. It is not a session: the gate never reads it, no
// route but the second step's accepts it, and nothing it unlocks exists until
// a right code arrives. So it is kept the way the gate keeps sessions, in this
// process's memory, by the digest of its value:
//
//   • 32 random bytes, handed to the browser once, in the reply that issued it;
//   • bound to the login and to the caller's network key, so a ticket that
//     travels to another network is refused there;
//   • good for five minutes, void after five wrong codes, used by ONE right
//     code: it is claimed before anything is awaited, so two requests that
//     both carry a right code make one session at most;
//   • gone when the console restarts, which ends every sign-in in progress.
//
// Two kinds. A `code` ticket follows a right password for an account whose
// second step is in force. A `setup` ticket follows a setup link and a
// password that passed the rules: it holds the password's hash and the new
// secret, in memory, and the first right code writes both and spends the link
// in one write. Until then nothing about the account has changed.

import { createHash, randomBytes } from "node:crypto";

/** How long a ticket waits for its code. */
export const TICKET_TTL_MS = 5 * 60_000;
/** Wrong codes a ticket takes before it is void. */
export const TICKET_WRONG_CODES = 5;

/** What the second step asks of this ticket: the code from an app already set
 *  up, or the first code of a new one, set up from a link. */
export type SecondStepKind = "code" | "setup";

export interface TicketRecord {
  kind: SecondStepKind;
  login: string;
  /** The network key of the caller who proved the first factor. */
  remoteKey: string;
  /** The control plane's identity for the person, from a verified entry, when
   *  the password step carried one. Stamped on the session as it would have
   *  been without a second step. */
  controlPlaneSub: string | null;
  /** The account as it stood when the first factor was proved. A reset, a new
   *  password or a disable since then voids the ticket. */
  credentialEpoch: number;
  pwdVersion: number;
  /** The account's lockout epoch then: the count of wrong codes for the
   *  account (CodeCeiling) is kept under it. */
  lockoutEpoch: number;
  /** Setup only: the new secret, in base32. */
  secret: string | null;
  /** Setup only: the sha256 of the link's token, which the first right code
   *  spends, and the hash of the password chosen on that link. */
  setupDigest: string | null;
  pwdHash: string | null;
  createdAt: number;
  /** Wrong codes so far. */
  wrong: number;
}

/** A ticket found for its holder. `digest` is how the table names it. */
export interface HeldTicket {
  digest: string;
  record: TicketRecord;
}

const TICKET_SHAPE = /^[0-9a-f]{64}$/;

function digestOf(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}

export class SecondStepTickets {
  /** Keyed by digest, so a dump of the table is not a list of live tickets. */
  private readonly byDigest = new Map<string, TicketRecord>();

  constructor(
    private readonly ttlMs: number = TICKET_TTL_MS,
    private readonly wrongCodes: number = TICKET_WRONG_CODES,
  ) {}

  /** A new ticket. The value is returned once and kept nowhere. A setup
   *  ticket replaces any other for the same link: the newest password and the
   *  newest QR code are the ones that count. */
  issue(record: Omit<TicketRecord, "wrong">): string {
    this.sweep(record.createdAt);
    if (record.setupDigest !== null) {
      for (const [digest, held] of this.byDigest) {
        if (held.setupDigest === record.setupDigest) this.byDigest.delete(digest);
      }
    }
    const ticket = randomBytes(32).toString("hex");
    this.byDigest.set(digestOf(ticket), { ...record, wrong: 0 });
    return ticket;
  }

  /**
   * The live ticket this caller holds, or null.
   *
   * Null covers every way a ticket can be dead (never issued, expired, void,
   * used, being finished, or presented from another network) and the caller
   * answers all of them alike. A ticket presented from another network is left
   * as it is: the person who holds it on the right network can still finish.
   */
  find(ticket: unknown, remoteKey: string, now: number): HeldTicket | null {
    if (typeof ticket !== "string" || !TICKET_SHAPE.test(ticket)) return null;
    const digest = digestOf(ticket);
    const record = this.byDigest.get(digest);
    if (!record) return null;
    if (now - record.createdAt >= this.ttlMs) {
      this.byDigest.delete(digest);
      return null;
    }
    if (record.remoteKey !== remoteKey) return null;
    return { digest, record };
  }

  /**
   * Take the ticket for the one request that finishes it. True for the first
   * caller only: the ticket leaves the table here, synchronously, so a second
   * request on it, even one already past `find`, is refused. Call it after the
   * code is judged right and before anything is awaited.
   */
  claim(held: HeldTicket): boolean {
    if (this.byDigest.get(held.digest) !== held.record) return false;
    this.byDigest.delete(held.digest);
    return true;
  }

  /** Count one wrong code. True when it was the last one the ticket takes,
   *  and the ticket is void from now on. */
  wrong(held: HeldTicket): boolean {
    held.record.wrong += 1;
    if (held.record.wrong < this.wrongCodes) return false;
    this.byDigest.delete(held.digest);
    return true;
  }

  /** Void: it answers nothing again. */
  drop(held: HeldTicket): void {
    if (this.byDigest.get(held.digest) === held.record) this.byDigest.delete(held.digest);
  }

  /** Drop the tickets whose time is up. */
  sweep(now: number): number {
    let dropped = 0;
    for (const [digest, record] of this.byDigest) {
      if (now - record.createdAt >= this.ttlMs) {
        this.byDigest.delete(digest);
        dropped += 1;
      }
    }
    return dropped;
  }

  get size(): number {
    return this.byDigest.size;
  }
}

// ── The ceiling on wrong codes for one account ──────────────────────────────

/** Wrong codes for one login, from any address, that close its second step. */
export const CEILING_WRONG_CODES = 10;
/** The window those wrong codes are counted in. */
export const CEILING_WINDOW_MS = 15 * 60_000;
/** How long the second step stays closed for that login once they are reached. */
export const CEILING_CLOSED_MS = 15 * 60_000;

/** One account's wrong codes, under the lockout epoch they were counted at. */
export interface CeilingRecord {
  /** The account's `lockoutEpoch` when these codes were counted. `ui user
   *  reset` raises it, and a record from an earlier epoch counts for nothing. */
  epoch: number;
  /** When the recent wrong codes came: at most CEILING_WRONG_CODES of them. */
  wrongAt: number[];
  /** The second step is closed until this time. 0 while it is open. */
  closedUntil: number;
}

/** What a restart reads back: see UiRuntime.persistLockouts. */
export type CeilingSnapshot = Array<[string, CeilingRecord]>;

function isCeilingRecord(value: unknown): value is CeilingRecord {
  const record = value as Partial<CeilingRecord> | null;
  return (
    typeof record === "object" &&
    record !== null &&
    Number.isSafeInteger(record.epoch) &&
    (record.epoch as number) >= 0 &&
    Array.isArray(record.wrongAt) &&
    record.wrongAt.length <= CEILING_WRONG_CODES &&
    record.wrongAt.every((at) => Number.isFinite(at)) &&
    Number.isFinite(record.closedUntil)
  );
}

/**
 * Wrong codes counted for the ACCOUNT, from every address.
 *
 * Every other meter on the sign-in path is keyed on (login, network), so that
 * nobody can lock a colleague out from their own address. That leaves a hole
 * the second step must not have: a person who knows the password and controls
 * many addresses gets five codes per ticket and five attempts per minute on
 * each of them, which adds up to more than a hundred guesses a second against
 * one account. This counts the wrong codes of the account wherever they come
 * from, and closes its second step, everywhere, for a while.
 *
 * The count is kept under the login together with the account's lockout
 * epoch, the counter `ui user reset` raises. So a reset reopens the second
 * step at once, for the new link's first code, and nothing a caller can do
 * without a shell on the host does: a right code does not reopen it early, and
 * neither does anything else that reaches the console.
 *
 * It cannot be turned into a way to lock somebody out: a code can be typed only
 * on a ticket, and a ticket is issued only after the right password (or a live
 * setup link). A stranger who knows neither never reaches this count. Wrong
 * passwords are not counted here.
 *
 * Its memory is bounded: one record per account that has had a wrong code in
 * the last fifteen minutes, each holding at most CEILING_WRONG_CODES numbers.
 * Only an account in users.json can have a ticket, so there are never more
 * records than accounts.
 */
export class CodeCeiling {
  private readonly byLogin = new Map<string, CeilingRecord>();

  /** The record that counts for this account now. One counted under an
   *  earlier epoch is dropped: a reset came after it. */
  private current(login: string, epoch: number): CeilingRecord | null {
    const record = this.byLogin.get(login);
    if (!record) return null;
    if (record.epoch < epoch) {
      this.byLogin.delete(login);
      return null;
    }
    return record;
  }

  /** How long the second step stays closed for this account, or 0 when open. */
  closedFor(login: string, epoch: number, now: number): number {
    const record = this.current(login, epoch);
    if (!record || record.closedUntil <= now) return 0;
    return record.closedUntil - now;
  }

  /** Count one wrong code for this account. True when this one closed its
   *  second step. */
  wrong(login: string, epoch: number, now: number): boolean {
    const record = this.current(login, epoch) ?? { epoch, wrongAt: [], closedUntil: 0 };
    const recent = record.wrongAt.filter((at) => now - at < CEILING_WINDOW_MS);
    recent.push(now);
    // Only the last few matter, so a flood of wrong codes holds a few numbers.
    record.wrongAt = recent.slice(-CEILING_WRONG_CODES);
    const closes = recent.length >= CEILING_WRONG_CODES;
    if (closes) {
      record.closedUntil = now + CEILING_CLOSED_MS;
      record.wrongAt = [];
    }
    this.byLogin.set(login, record);
    return closes;
  }

  sweep(now: number): void {
    for (const [login, record] of this.byLogin) {
      record.wrongAt = record.wrongAt.filter((at) => now - at < CEILING_WINDOW_MS);
      if (record.wrongAt.length === 0 && record.closedUntil <= now) this.byLogin.delete(login);
    }
  }

  /** The records that still count, for a restart to read back. */
  snapshot(now: number): CeilingSnapshot {
    this.sweep(now);
    return [...this.byLogin.entries()].map(([login, record]) => [login, { ...record, wrongAt: [...record.wrongAt] }]);
  }

  /** Take back what a snapshot holds. An entry of the wrong shape, or one
   *  whose time is over, is skipped. */
  hydrate(snapshot: unknown, now: number): void {
    if (!Array.isArray(snapshot)) return;
    for (const entry of snapshot) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [login, record] = entry as [unknown, unknown];
      if (typeof login !== "string" || !isCeilingRecord(record)) continue;
      const wrongAt = record.wrongAt.filter((at) => now - at < CEILING_WINDOW_MS);
      if (wrongAt.length === 0 && record.closedUntil <= now) continue;
      this.byLogin.set(login, { epoch: record.epoch, wrongAt, closedUntil: record.closedUntil });
    }
  }

  get size(): number {
    return this.byLogin.size;
  }
}
