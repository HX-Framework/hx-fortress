// The console door: a dedicated verifier for the workbench's one-click grant,
// and the single-use entry record it produces.
//
// It is deliberately NOT the capability-token verifier. That one authorizes
// ingest and read against a bucket and a scope; this one authorizes nothing at
// all — a valid grant lands a browser on the SIGN-IN FORM carrying an
// annotation, and every capability the session eventually has comes from the
// local account whose password was typed into that form. Keeping the two apart
// is what makes "a compromised cloud cannot mutate this fortress" a property of
// the code rather than a promise.
//
// Four checks, in this order, and the ORDER is the security property:
//
//   1. SIGNATURE first. A token this fortress cannot verify is not evidence of
//      anything — not of an expiry, not of an origin, not of an organization —
//      so it renders the generic page and names nothing.
//   2. purpose === console. A read or ingest grant must never open this door,
//      and a console grant must never open theirs.
//   3. org === aud === this fortress's own org.
//   4. origin === this console's own advertised origin, and exp within a 30s
//      skew — the ONE place a skew allowance exists, because a browser hand-off
//      is a live round trip and nothing else here is.

import { importJWK, jwtVerify, decodeJwt } from "jose";
import { randomBytes } from "node:crypto";

/** The purpose claim this door accepts, and no other surface does. */
export const CONSOLE_GRANT_PURPOSE = "console";

/** The only clock allowance in the fortress. A one-click hand-off is a live
 *  round trip between two machines; everything else here is a file or a row. */
export const CONSOLE_GRANT_SKEW_SECONDS = 30;

/** How long an exchanged entry record stays usable. Long enough to read the
 *  page and type a password, short enough that a copied link is worthless. */
export const ENTRY_TTL_MS = 10 * 60 * 1000;

/**
 * Why a grant was refused. Each is its own page with its own remediation —
 * except `generic`, which is what an unverifiable token gets: naming a reason
 * would be describing a token this fortress has no key to read.
 */
export type GrantRejection =
  | "sso_disabled"
  | "origin_mismatch"
  | "expired"
  | "wrong_org"
  | "clock_skew"
  | "grant_used"
  | "generic";

export interface ConsoleGrantClaims {
  jti: string;
  org: string;
  sub: string;
  exp: number;
}

export type GrantVerdict =
  | { ok: true; claims: ConsoleGrantClaims }
  | { ok: false; reason: GrantRejection; offsetSeconds?: number };

export interface VerifyConsoleGrantArgs {
  grant: string;
  /** The pinned per-org Ed25519 public key (base64url raw), or null when this
   *  fortress holds none — which is a PRE-verification state, not a rejection
   *  page of its own. */
  publicKey: string | null;
  /** This fortress's own org id, from its enrolled credential. */
  orgId: string | null;
  /** The console's effective advertised origin. */
  publicUrlOrigin: string | null;
  /** ui.sso, effective. */
  ssoEnabled: boolean;
  now?: () => Date;
  /** Called with the measured offset whenever the clock is the reason. */
  onClockSkew?: (offsetSeconds: number) => void | Promise<void>;
  /** A hand-off that WORKED. The skew record is otherwise sticky — one writer,
   *  no deleter — so a single measurement drove the Posture warning forever,
   *  including one taken from a merely stale grant. A successful exchange is
   *  positive evidence that this host's clock is usable, so it clears it. */
  onClockOk?: () => void | Promise<void>;
  /** Consume `jti`. Returns false when this grant was already used. */
  consume?: (jti: string, expiresAt: Date) => boolean;
}

export async function verifyConsoleGrant(args: VerifyConsoleGrantArgs): Promise<GrantVerdict> {
  const now = (args.now ?? ((): Date => new Date()))();
  // SIGNATURE FIRST, before sso-disabled and before anything the token claims:
  // a token nobody can verify must not be able to tell an unauthenticated
  // caller whether SSO is on, which org this is, or what time this host thinks
  // it is.
  if (!args.publicKey) return { ok: false, reason: "generic" };
  let payload: Record<string, unknown>;
  try {
    const key = await importJWK({ kty: "OKP", crv: "Ed25519", x: args.publicKey }, "EdDSA");
    const verified = await jwtVerify(args.grant, key, {
      algorithms: ["EdDSA"],
      requiredClaims: ["exp", "jti"],
      clockTolerance: CONSOLE_GRANT_SKEW_SECONDS,
      currentDate: now,
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (error) {
    // A failure of the SIGNATURE and a failure of the CLOCK are different
    // answers, and only the second may say anything about the token: a grant
    // this fortress cannot verify is not evidence that anything expired.
    if (!isTimeFailure(error)) return { ok: false, reason: "generic" };
    // The signature held; the window did not. Read the claims to decide which
    // page — an operator whose host drifted needs to be told that, and an
    // expired page sends them re-clicking a button that cannot work.
    const unverified = decodeUnverified(args.grant);
    const skew = clockSkewSeconds(unverified, now);
    if (skew !== null && Math.abs(skew) > CONSOLE_GRANT_SKEW_SECONDS) {
      await args.onClockSkew?.(skew);
      return { ok: false, reason: "clock_skew", offsetSeconds: skew };
    }
    return { ok: false, reason: "expired" };
  }

  if (payload.purpose !== CONSOLE_GRANT_PURPOSE) return { ok: false, reason: "generic" };
  if (!args.ssoEnabled) return { ok: false, reason: "sso_disabled" };

  const org = typeof payload.org === "string" ? payload.org : null;
  const aud = typeof payload.aud === "string" ? payload.aud : null;
  if (!args.orgId || !org || org !== aud || org !== args.orgId) {
    return { ok: false, reason: "wrong_org" };
  }

  const origin = typeof payload.origin === "string" ? payload.origin : null;
  if (!args.publicUrlOrigin || origin !== args.publicUrlOrigin) {
    return { ok: false, reason: "origin_mismatch" };
  }

  const jti = typeof payload.jti === "string" ? payload.jti : null;
  const exp = typeof payload.exp === "number" ? payload.exp : null;
  if (!jti || exp === null) return { ok: false, reason: "generic" };
  // SINGLE USE, keyed on jti. Residual, stated: a console restart inside the
  // grant's own TTL re-opens replay for grants that were never exchanged.
  if (args.consume && !args.consume(jti, new Date(exp * 1000))) {
    return { ok: false, reason: "grant_used" };
  }

  // The clock was good enough to verify a grant, so whatever the skew record
  // says is stale. Cleared here rather than on a timer: this is the only moment
  // that produces positive evidence, and the record's own header says a warning
  // that is always on is one nobody reads.
  await args.onClockOk?.();

  return {
    ok: true,
    claims: { jti, org, sub: typeof payload.sub === "string" ? payload.sub : "", exp },
  };
}

/** jose distinguishes a bad signature from a bad window by error code. Only the
 *  second is allowed to influence which page is rendered. */
function isTimeFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ERR_JWT_EXPIRED" || code === "ERR_JWT_CLAIM_VALIDATION_FAILED";
}

function decodeUnverified(grant: string): Record<string, unknown> | null {
  try {
    return decodeJwt(grant) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Past-expiry evidence has to clear THIS much before it is read as a clock
 *  fault rather than a stale link. A grant is delivered by a redirect the
 *  operator clicks, so "old" is bounded by attention span; a quarter of an hour
 *  beyond a window that was minutes wide is not a slow click. Without a floor,
 *  a short-TTL grant exchanged half a minute late was diagnosed as skew and
 *  pinned a permanent warning on a perfectly good host. */
export const SKEW_EVIDENCE_FLOOR_SECONDS = 15 * 60;

/** How far this host's clock sits from the one that minted the grant. Positive
 *  means this host is AHEAD. Null when the token carries no usable window. */
function clockSkewSeconds(payload: Record<string, unknown> | null, now: Date): number | null {
  if (!payload) return null;
  const seconds = Math.floor(now.getTime() / 1000);
  const iat = typeof payload.iat === "number" ? payload.iat : null;
  const nbf = typeof payload.nbf === "number" ? payload.nbf : null;
  const start = nbf ?? iat;
  if (start !== null && seconds < start) return seconds - start;
  const exp = typeof payload.exp === "number" ? payload.exp : null;
  // An expiry in the past is only skew when it is beyond ANY plausible TTL;
  // otherwise it is an old grant, which is a different page.
  if (exp !== null && iat !== null && seconds > exp) {
    const ttl = exp - iat;
    const over = seconds - exp;
    return over > Math.max(ttl, SKEW_EVIDENCE_FLOOR_SECONDS) ? over : null;
  }
  return null;
}

// ── the consumed set ────────────────────────────────────────────────────────

/** Grants already exchanged, held until they would have expired anyway. In
 *  memory on purpose: the set only has to outlive the grants it guards, and a
 *  file would put a workbench-minted identifier on this host's disk. */
export class ConsumedGrants {
  private readonly seen = new Map<string, number>();

  consume(jti: string, expiresAt: Date, now: Date = new Date()): boolean {
    this.sweep(now);
    if (this.seen.has(jti)) return false;
    this.seen.set(jti, expiresAt.getTime());
    return true;
  }

  private sweep(now: Date): void {
    for (const [jti, expiry] of this.seen) {
      // Retained past `exp` by the same skew the verifier ALLOWS. jwtVerify
      // accepts a grant until `exp + CONSOLE_GRANT_SKEW_SECONDS`, so dropping the
      // consumed record at `exp` reopened it for that whole tail — and because
      // this sweep runs BEFORE the `has(jti)` check, the record was deleted and
      // re-added on every call, making a spent grant unboundedly redeemable
      // rather than merely twice.
      if (expiry + CONSOLE_GRANT_SKEW_SECONDS * 1000 <= now.getTime()) this.seen.delete(jti);
    }
  }

  get size(): number {
    return this.seen.size;
  }
}

// ── the entry record ────────────────────────────────────────────────────────

export interface EntryRecord {
  id: string;
  workbenchSub: string;
  org: string;
  createdAt: number;
}

/**
 * The ONLY carrier of the workbench identity between the exchange and the
 * sign-in.
 *
 * The exchange returns `workbenchSub` and `org` for DISPLAY, and the sign-in
 * carries the entry ID alone: the server stamps the identity from this record,
 * never from what the client posts. A forged sub therefore annotates nothing —
 * the worst it can do is put a wrong name on a page nobody has signed into yet.
 */
export class EntryContexts {
  private readonly records = new Map<string, EntryRecord>();

  constructor(private readonly ttlMs: number = ENTRY_TTL_MS) {}

  create(args: { workbenchSub: string; org: string }, now: Date = new Date()): EntryRecord {
    this.sweep(now);
    const record: EntryRecord = {
      id: randomBytes(24).toString("base64url"),
      workbenchSub: args.workbenchSub,
      org: args.org,
      createdAt: now.getTime(),
    };
    this.records.set(record.id, record);
    return record;
  }

  /** Read WITHOUT consuming: a person may fail a password and try again, and
   *  burning the annotation on the first attempt would silently drop the dual
   *  identity from the record of the attempt that succeeded. */
  read(id: string | null | undefined, now: Date = new Date()): EntryRecord | null {
    if (!id) return null;
    this.sweep(now);
    return this.records.get(id) ?? null;
  }

  private sweep(now: Date): void {
    for (const [id, record] of this.records) {
      if (now.getTime() - record.createdAt > this.ttlMs) this.records.delete(id);
    }
  }

  get size(): number {
    return this.records.size;
  }
}
