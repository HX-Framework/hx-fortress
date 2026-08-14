// Detached Ed25519 signature verification for downloaded artifacts.
//
// Threat: every artifact the fortress downloads (the self-update binary, the
// embedded Postgres bundle, the pgvector native lib, and future hub modules) is
// only integrity-checked against a SAME-ORIGIN `.sha256` — an attacker who
// controls the download origin (or a proxy in front of it) can serve a matching
// hash for tampered bytes. A detached signature made by a key BAKED INTO the
// binary (src/host/trust/signing-keys.ts) closes that gap: authenticity, not
// just integrity.
//
// Rollout is fail-closed but non-bricking. `SIGNATURE_ENFORCE` is `false` for
// Release A ("verify-if-present"): a PRESENT signature must verify (a tampered
// or wrong-key signature always throws), but an ABSENT signature only warns and
// proceeds — so releases signed by the CI can roll out before the enforcing
// release flips the flag. A present-but-invalid signature is a hard failure in
// every mode; only the missing-signature case is governed by the flag.

import { importJWK } from "jose";

import {
  hasProductionAnchor,
  TRUSTED_SIGNING_KEYS,
  type TrustedSigningKey,
} from "./signing-keys";

/** Release A = verify-if-present. The enforcing release flips this to `true`,
 *  turning a MISSING signature into a hard failure. Do not flip here. */
export const SIGNATURE_ENFORCE = false;

/**
 * The CONSOLE's update path enforces separately from the terminal's.
 *
 * A console operator applying an update is host code execution reached through a
 * browser session, so that path takes the strictest available verification: with
 * production anchors baked in it enforces, and an unsigned artifact is refused by
 * name. It flips to `true` at the release where production-signed artifacts
 * exist; until then the console runs verify-if-present and SAYS SO — a button
 * that is simply dead teaches an operator that the console is broken, not that
 * this build cannot prove authenticity.
 */
export const CONSOLE_SIGNATURE_ENFORCE = false;

/** Shown wherever the console offers an update it cannot prove the origin of. */
export const UNSIGNED_BUILD_WARNING =
  "this build has no release signing anchor, so an update is checked against its published " +
  "checksum only — that proves the bytes were not corrupted, not who produced them";

export function productionAnchorRefusal(): string {
  return (
    "refusing to apply an update from the console: signature enforcement is on, but this binary " +
    "carries no production signing anchor to enforce against. Install a release build, or apply " +
    "the update from the fortress terminal."
  );
}

export interface ConsoleUpdateGate {
  /** Whether the artifact's detached signature is REQUIRED. */
  enforce: boolean;
  /** What the operator is told when it is not. Null when it is. */
  warning: string | null;
}

/** The console's verification posture for THIS build. Throws the named refusal
 *  when enforcement is on and no production anchor exists to enforce with. */
export function consoleUpdateGate(
  trustedKeys: readonly TrustedSigningKey[] = TRUSTED_SIGNING_KEYS,
  enforcing: boolean = CONSOLE_SIGNATURE_ENFORCE,
): ConsoleUpdateGate {
  // BOTH conditions. Enforcing on the anchor alone made the release runbook's own
  // sequence break the Update button: rung 8 bakes production anchors while its
  // acceptance criterion is that the assets still carry no `.sig`, and signing
  // does not start until rung 12 — a separate later release. For that whole
  // window every console-initiated update failed on a missing signature, which
  // is the outcome this file names as the one to avoid.
  //
  // The refusal keeps its own case: asking for enforcement with nothing to
  // enforce with is a misconfiguration, not a posture.
  if (enforcing && !hasProductionAnchor(trustedKeys)) throw new Error(productionAnchorRefusal());
  if (hasProductionAnchor(trustedKeys) && enforcing) return { enforce: true, warning: null };
  return {
    enforce: false,
    warning: hasProductionAnchor(trustedKeys) ? null : UNSIGNED_BUILD_WARNING,
  };
}

/** The detached-signature sidecar written next to an artifact as `<name>.sig`.
 *  `sig` is base64url(raw Ed25519 signature); `keyid` selects the trust anchor. */
export interface SignatureSidecar {
  v: 1;
  alg: "Ed25519";
  keyid: string;
  sig: string;
}

/** Parse + strictly validate a `.sig` sidecar's JSON text. Throws on anything
 *  that is not exactly `{v:1, alg:"Ed25519", keyid:<string>, sig:<string>}`. */
export function parseSignatureSidecar(text: string): SignatureSidecar {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("malformed signature sidecar: not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("malformed signature sidecar: not an object");
  }
  const v = value as Record<string, unknown>;
  if (v.v !== 1) throw new Error("unsupported signature sidecar version");
  if (v.alg !== "Ed25519") throw new Error("unsupported signature algorithm");
  if (typeof v.keyid !== "string" || v.keyid.length === 0) {
    throw new Error("signature sidecar missing keyid");
  }
  if (typeof v.sig !== "string" || v.sig.length === 0) {
    throw new Error("signature sidecar missing sig");
  }
  return { v: 1, alg: "Ed25519", keyid: v.keyid, sig: v.sig };
}

// Cache imported CryptoKeys by their base64url material (not by keyid) so the
// same public key resolves once regardless of which trusted-key set referenced
// it — importJWK is async and otherwise re-runs on every artifact.
const keyCache = new Map<string, Promise<CryptoKey>>();

function importTrustedKey(publicKey: string): Promise<CryptoKey> {
  let cached = keyCache.get(publicKey);
  if (!cached) {
    // Same importJWK shape as the capability-token verifier.
    cached = importJWK({ kty: "OKP", crv: "Ed25519", x: publicKey }, "EdDSA").then(
      (k) => k as CryptoKey,
    );
    keyCache.set(publicKey, cached);
  }
  return cached;
}

function base64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const buf = Buffer.from(s, "base64url");
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}

// WebCrypto's BufferSource typing requires a concrete ArrayBuffer (not the
// generic ArrayBufferLike a plain Uint8Array carries), so copy the artifact
// bytes into a fresh, non-shared buffer rather than reach for an unsafe cast.
function toArrayBufferView(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(u.byteLength);
  out.set(u);
  return out;
}

/** Verify `bytes` against the detached sidecar text using the baked trust
 *  anchors. Throws on: a malformed sidecar, a `keyid` naming no trusted key
 *  ("untrusted signing key id"), or a signature that does not verify. The
 *  `trustedKeys` seam defaults to the baked anchors and exists for tests. */
export async function verifyDetachedSignature(
  bytes: Uint8Array,
  sidecarText: string,
  trustedKeys: readonly TrustedSigningKey[] = TRUSTED_SIGNING_KEYS,
): Promise<void> {
  const sidecar = parseSignatureSidecar(sidecarText);
  const trusted = trustedKeys.find((k) => k.keyid === sidecar.keyid);
  if (!trusted) {
    throw new Error(`untrusted signing key id: ${sidecar.keyid}`);
  }
  const key = await importTrustedKey(trusted.publicKey);
  const ok = await crypto.subtle.verify(
    "Ed25519",
    key,
    base64urlToBytes(sidecar.sig),
    toArrayBufferView(bytes),
  );
  if (!ok) {
    throw new Error(`signature verification failed for key ${sidecar.keyid}`);
  }
}

export interface VerifyFetchedArtifactOptions {
  /** Fetch used to retrieve the `<url>.sig` sidecar (injectable for tests). */
  fetchImpl: typeof fetch;
  /** The artifact URL; the sidecar is fetched from `<url>.sig`. */
  url: string;
  /** The already-downloaded artifact bytes to verify. */
  bytes: Uint8Array;
  /** When true, a missing signature is a hard failure (enforcing release). */
  enforce: boolean;
  /** Optional structured log for the verify-if-present "no signature" warning. */
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  /** Trust-anchor override for tests; defaults to the baked keys. */
  trustedKeys?: readonly TrustedSigningKey[];
}

/** Fetch `<url>.sig` and verify the given bytes against it.
 *  - sidecar unreachable / not found: `enforce` ? throw "missing signature"
 *    : log a SECURITY warning and return (verify-if-present).
 *  - sidecar present: verify; any failure throws regardless of `enforce`. */
export async function verifyFetchedArtifact(o: VerifyFetchedArtifactOptions): Promise<void> {
  const sigUrl = `${o.url}.sig`;
  let res: Response;
  try {
    res = await o.fetchImpl(sigUrl);
  } catch (err) {
    // A transport error fetching the sidecar is treated as "absent".
    if (o.enforce) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`missing signature for ${o.url} (${sigUrl}: ${detail})`, { cause: err });
    }
    o.log?.(`SECURITY: signature sidecar unreachable, proceeding unverified: ${sigUrl}`, {
      url: o.url,
    });
    return;
  }
  if (!res.ok) {
    if (o.enforce) {
      throw new Error(`missing signature for ${o.url} (${sigUrl} -> ${res.status})`);
    }
    o.log?.(`SECURITY: no signature sidecar, proceeding unverified: ${sigUrl} (${res.status})`, {
      url: o.url,
      status: res.status,
    });
    return;
  }
  const sigText = await res.text();
  await verifyDetachedSignature(o.bytes, sigText, o.trustedKeys);
}
