import { importJWK, jwtVerify } from "jose";

import { parseBooleanEnv } from "../env";

export interface CapabilityClaims {
  org: string;
  project?: string;
  repo: string;
  deviceId?: string;
  sub?: string;
  /** Target fortress org id the cloud bound the token to (anti cross-org replay). */
  aud?: string;
  /** v2 capability-grant purpose. Present ⇒ a v2 grant, not a legacy v1 token. */
  purpose?: "ingest" | "read";
  /** v2 read-grant scope commitment: base64url(sha256(canonical scope)). */
  scopeHash?: string;
  /** Grant schema version (2 for a capability grant). Absent on v1 tokens. */
  v?: number;
}

/** A verified v2 capability grant — a cloud-signed, purpose-scoped, object-bound
 *  authorization the fortress verifies offline against the per-org signing key.
 *  Every claim is required except the object binders (`scopeHash` on reads; the
 *  `repo`/`project`/`deviceId` ingest binders). */
export interface GrantClaims {
  v: number;
  purpose: "ingest" | "read";
  org: string;
  aud: string;
  sub: string;
  scopeHash?: string;
  repo?: string;
  project?: string;
  deviceId?: string;
}

/** A verified MODULE grant: the authorization for one ask to one module.
 *
 *  Narrower than the other grants in every direction. `sub` names the module and
 *  the ask, `scopeHash` commits to the arguments, `jti` makes it usable once,
 *  and it lives for at most a minute. Every field is required: there is no
 *  optional binder on this one. */
export interface ModuleGrantClaims {
  v: number;
  purpose: "module";
  org: string;
  aud: string;
  /** `<module>:<ask>`. */
  sub: string;
  scopeHash: string;
  /** Seconds since the epoch, as the token carries them. */
  iat: number;
  exp: number;
  /** A random id per mint. The caller refuses a second use of it. */
  jti: string;
}

/** The longest a module grant may live, from `iat` to `exp`. */
export const MODULE_GRANT_MAX_LIFETIME_SECONDS = 60;
/** How far ahead of this host's clock a module grant's `iat` may be. Without a
 *  bound, a fortress whose clock runs behind would accept every grant for longer
 *  than the minute it was minted for. */
export const MODULE_GRANT_MAX_CLOCK_SKEW_SECONDS = 60;
const MODULE_GRANT_JTI_MAX_CHARS = 128;

/** Which rule refused a grant. Recorded in the audit trail beside the refusal;
 *  the relay is told only that the grant was invalid. */
export type GrantRule =
  | "version"
  | "purpose"
  | "organization"
  | "subject"
  | "scope"
  | "expired"
  | "lifetime"
  | "not_yet_valid"
  | "single_use_id";

/** A grant this verifier examined and refused, with the rule that refused it.
 *  A token whose signature or encoding is bad never gets this far: that is the
 *  JOSE library's own error, and it is refused all the same. */
export class GrantRefused extends Error {
  readonly rule: GrantRule;

  constructor(rule: GrantRule, message: string) {
    super(message);
    this.name = "GrantRefused";
    this.rule = rule;
  }
}

/** The wire error code for the "enforcement is on and the caller presented NO
 *  grant" condition — unified across the HTTP gateway (`enforceRoutePurpose` /
 *  `mcpGrant`), the MCP tool layer (`checkScopeGrant`), and the reverse tunnel
 *  (vault-RPC dispatch) so a client sees ONE code regardless of surface. Kept
 *  distinct from a PRESENT-but-invalid grant (`grant_invalid` / `unauthorized`)
 *  and from a scope-hash mismatch (`scope_not_granted`). */
export const GRANT_REQUIRED_ERROR = "grant_required";

/** The ONE place the "require a grant" decision is encoded for the HTTP surface
 *  (gateway upload/read routes + POST /mcp). Default OFF: a grant is verified
 *  IF present but not REQUIRED, so the current grant-less workbench keeps working.
 *  The human flips FORTRESS_GRANT_ENFORCE=1 after the workbench mint side ships. */
export function isGrantEnforcing(): boolean {
  return parseBooleanEnv(process.env.FORTRESS_GRANT_ENFORCE);
}

/** The reverse-tunnel equivalent of isGrantEnforcing (vault RPC + tunnel MCP).
 *  Default OFF for the same non-bricking reason; FORTRESS_TUNNEL_GRANT_ENFORCE. */
export function isTunnelGrantEnforcing(): boolean {
  return parseBooleanEnv(process.env.FORTRESS_TUNNEL_GRANT_ENFORCE);
}

/** True when the token carries v2-grant framing (an `aud`, a `purpose`, or v===2)
 *  — as opposed to a legacy v1 capability token bound only by the signing key. */
export function isV2Claims(claims: CapabilityClaims): boolean {
  return claims.purpose !== undefined || claims.aud !== undefined || claims.v === 2;
}

/** Verify an EdDSA capability JWT against a base64url raw Ed25519 public key.
 *  Throws on a bad signature, a missing/expired `exp`, or missing required claims.
 *
 *  `expectedOrgId` is THIS fortress's own org id (from its enrolled cloud
 *  credential), or null before enrollment. Binding rules:
 *   • A v1 token (no `aud`/`purpose`) is accepted as-is DURING THE COMPAT WINDOW
 *     (FORTRESS_GRANT_ENFORCE off) — its per-org signing key is its only binding,
 *     matching pre-grant traffic so nothing breaks.
 *   • Otherwise (a v2 token, OR enforcement on) the token MUST be bound to this
 *     fortress's own org: `aud === org === expectedOrgId`. We must know our own
 *     org id to bind — refuse when we don't (fail-closed). This is the tightening
 *     from the pre-grant era, where the gateway deliberately left `org` unchecked. */
export async function verifyCapabilityToken(
  token: string,
  publicKeyB64url: string,
  expectedOrgId: string | null,
): Promise<CapabilityClaims> {
  const key = await importJWK({ kty: "OKP", crv: "Ed25519", x: publicKeyB64url }, "EdDSA");
  // requiredClaims forces `exp` to be PRESENT; jwtVerify already rejects an `exp`
  // in the past — together they require a live, bounded expiry (no eternal token).
  const { payload } = await jwtVerify(token, key, {
    algorithms: ["EdDSA"],
    requiredClaims: ["exp"],
  });
  const p = payload as Record<string, unknown>;
  const { org, repo, aud, purpose } = p;
  if (typeof org !== "string" || typeof repo !== "string") {
    throw new Error("capability token missing org/repo");
  }
  // A purpose this realm does not serve is a REFUSAL, never a token read as
  // purpose-less. The console door mints and accepts `console`; coercing an
  // unknown purpose to undefined would make such a grant indistinguishable from
  // a legacy token here, and the compat window would admit it.
  if (purpose !== undefined && purpose !== "ingest" && purpose !== "read") {
    throw new Error(`capability token purpose is not valid here: ${String(purpose)}`);
  }
  const claims: CapabilityClaims = {
    org,
    repo,
    project: typeof p.project === "string" ? p.project : undefined,
    deviceId: typeof p.deviceId === "string" ? p.deviceId : undefined,
    sub: typeof p.sub === "string" ? p.sub : undefined,
    aud: typeof aud === "string" ? aud : undefined,
    purpose: purpose === "ingest" || purpose === "read" ? purpose : undefined,
    scopeHash: typeof p.scopeHash === "string" ? p.scopeHash : undefined,
    v: typeof p.v === "number" ? p.v : undefined,
  };

  const isV1 = claims.aud === undefined && claims.purpose === undefined;
  if (isV1 && !isGrantEnforcing()) {
    return claims;
  }

  if (!expectedOrgId) {
    throw new Error("capability token: fortress org id unknown");
  }
  if (claims.aud !== expectedOrgId || claims.org !== expectedOrgId) {
    throw new Error("capability token audience mismatch");
  }
  return claims;
}

/** Verify a v2 capability GRANT against the per-org Ed25519 signing key (the same
 *  key that signs v1 capability tokens). Fail-closed on tampering: any bad claim
 *  throws a specific error.
 *
 *  Requires `v === 2`, `purpose === opts.purpose`, `org === aud === expectedOrgId`,
 *  and a non-empty `sub`. `opts.requireScope` (default true) governs the read-grant
 *  scope commitment:
 *   • SCOPE-BOUND reads (the MCP query tools) pass `requireScope:true` — a present
 *     `scopeHash` is REQUIRED and the caller recomputes it over the tool args.
 *   • OWN-OBJECT reads (the vault-RPC own-data reads + the HTTP `/sessions` reads)
 *     pass `requireScope:false` — these grants are `sub`-bound with NO scopeHash;
 *     the boundary is `key.userId === sub`, enforced by the caller. Requiring a
 *     scopeHash here would throw `unauthorized` on every such read once grants ship.
 *  The caller then binds the grant to the object it touches (write / own-object) or
 *  recomputes the scope hash over the tool args (scope-bound read).
 *
 *  A MODULE grant (`purpose: "module"`) is bound here rather than by the caller:
 *  `opts.sub` and `opts.scopeHash` are what the ask that arrived commits to, and
 *  the grant must carry exactly those. Its checks run in one stated order — the
 *  signature, the purpose, the organization, `sub`, the scope hash, then the
 *  expiry — so the rule a refusal names does not depend on which fault a token
 *  happens to have first. No other surface accepts a module grant: every other
 *  caller passes its own purpose, and a mismatch is a refusal.
 *
 *  `opts.scopeHash` may be a function. It is then called only after the
 *  signature, the purpose, the organization and `sub` have passed, so a caller
 *  whose token does not verify cannot make this host hash anything. What it
 *  throws is rethrown as it is. */
export function verifyGrant(
  token: string,
  publicKeyB64url: string,
  expectedOrgId: string,
  opts: { purpose: "module"; sub: string; scopeHash: string | (() => string); now?: () => Date },
): Promise<ModuleGrantClaims>;
export function verifyGrant(
  token: string,
  publicKeyB64url: string,
  expectedOrgId: string,
  opts: { purpose: "ingest" | "read"; requireScope?: boolean },
): Promise<GrantClaims>;
export async function verifyGrant(
  token: string,
  publicKeyB64url: string,
  expectedOrgId: string,
  opts:
    | { purpose: "module"; sub: string; scopeHash: string | (() => string); now?: () => Date }
    | { purpose: "ingest" | "read"; requireScope?: boolean },
): Promise<GrantClaims | ModuleGrantClaims> {
  const key = await importJWK({ kty: "OKP", crv: "Ed25519", x: publicKeyB64url }, "EdDSA");
  const now = opts.purpose === "module" ? (opts.now?.() ?? new Date()) : undefined;
  let p: Record<string, unknown>;
  // Set when the signature verified and only the expiry failed. A module grant's
  // other claims are examined first, in the documented order; every other
  // purpose rethrows at once, exactly as before.
  let expired = false;
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["EdDSA"],
      requiredClaims: ["exp"],
      ...(now ? { currentDate: now } : {}),
    });
    p = payload as Record<string, unknown>;
  } catch (err) {
    const carried = (err as { code?: unknown; payload?: unknown } | null) ?? {};
    if (
      opts.purpose !== "module" ||
      carried.code !== "ERR_JWT_EXPIRED" ||
      typeof carried.payload !== "object" ||
      carried.payload === null
    ) {
      throw err;
    }
    p = carried.payload as Record<string, unknown>;
    expired = true;
  }
  const v = typeof p.v === "number" ? p.v : undefined;
  const { purpose, org, aud, sub } = p;
  if (v !== 2) throw new GrantRefused("version", "grant version unsupported");
  if (purpose !== "ingest" && purpose !== "read" && purpose !== "module") {
    throw new GrantRefused("purpose", "grant purpose invalid");
  }
  if (purpose !== opts.purpose) throw new GrantRefused("purpose", "grant purpose mismatch");
  if (typeof org !== "string" || org !== expectedOrgId) {
    throw new GrantRefused("organization", "grant org mismatch");
  }
  if (typeof aud !== "string" || aud !== expectedOrgId) {
    throw new GrantRefused("organization", "grant audience mismatch");
  }
  if (typeof sub !== "string" || sub.length === 0) {
    throw new GrantRefused("subject", "grant missing sub");
  }
  const scopeHash = typeof p.scopeHash === "string" ? p.scopeHash : undefined;

  if (opts.purpose === "module") {
    if (sub !== opts.sub) throw new GrantRefused("subject", "grant is for another module or ask");
    const expectedScope = typeof opts.scopeHash === "function" ? opts.scopeHash() : opts.scopeHash;
    if (!scopeHash || scopeHash !== expectedScope) {
      throw new GrantRefused("scope", "grant does not commit to these arguments");
    }
    if (expired) throw new GrantRefused("expired", "grant expired");
    const { iat, exp, jti } = p;
    if (typeof iat !== "number" || typeof exp !== "number" || !Number.isFinite(iat)) {
      throw new GrantRefused("lifetime", "module grant must carry iat and exp");
    }
    if (exp - iat > MODULE_GRANT_MAX_LIFETIME_SECONDS || exp <= iat) {
      throw new GrantRefused("lifetime", "module grant lives longer than a minute");
    }
    const nowSeconds = (now ?? new Date()).getTime() / 1000;
    if (iat > nowSeconds + MODULE_GRANT_MAX_CLOCK_SKEW_SECONDS) {
      throw new GrantRefused("not_yet_valid", "module grant was issued in the future");
    }
    if (typeof jti !== "string" || jti.length === 0 || jti.length > MODULE_GRANT_JTI_MAX_CHARS) {
      throw new GrantRefused("single_use_id", "module grant must carry a jti");
    }
    return { v, purpose: "module", org, aud, sub, scopeHash, iat, exp, jti };
  }

  // Unreachable for a well-typed caller (the mismatch above already refused it),
  // and stated so the returned type cannot carry a module purpose.
  if (purpose === "module") throw new GrantRefused("purpose", "grant purpose mismatch");
  // Default to REQUIRING a scopeHash on reads (the scope-bound MCP path); own-object
  // read callers opt out with requireScope:false.
  const requireScope = opts.requireScope ?? true;
  if (opts.purpose === "read" && requireScope && !scopeHash) {
    throw new GrantRefused("scope", "read grant missing scopeHash");
  }
  return {
    v,
    purpose,
    org,
    aud,
    sub,
    scopeHash,
    repo: typeof p.repo === "string" ? p.repo : undefined,
    project: typeof p.project === "string" ? p.project : undefined,
    deviceId: typeof p.deviceId === "string" ? p.deviceId : undefined,
  };
}
