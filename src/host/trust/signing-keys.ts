// Baked-in Ed25519 trust anchors for artifact signatures: the project's own
// release keys. This is the ONLY authenticity root HX Fortress trusts for
// downloaded artifacts (self-update binary, embedded-PG bundle, pgvector native
// lib, a module's release). It is compiled INTO the binary and is NEVER fetched,
// overridden by config, or sourced from the network — a same-origin `.sha256`
// proves integrity, but only a signature made by one of these keys proves
// authenticity.
//
// These are keys of the project that publishes HX Fortress. No key of any
// control plane is in this file or anywhere else in the program: an HX Fortress
// learns its control plane's key on its own host (./control-plane-keys.ts).
//
// `publicKey` is the base64url encoding of the raw 32-byte Ed25519 public key
// (the JWK `x` parameter), so it feeds `importJWK({kty:"OKP",crv:"Ed25519",x})`
// directly (see src/gateway/capability-token.ts for the same pattern).

import { importJWK } from "jose";

import type { KeyProof } from "../../protocol";

export interface TrustedSigningKey {
  /** Stable id recorded in each signature sidecar; selects which anchor verifies. */
  keyid: string;
  /** base64url raw 32-byte Ed25519 public key (JWK `x`). */
  publicKey: string;
  /** True only for an anchor whose private half lives in the release pipeline's
   *  secret store. The console's update-apply enforces signatures and therefore
   *  refuses to run at all unless at least one baked anchor is production: a
   *  development key would make the enforcement a formality anybody who has the
   *  repository could satisfy. */
  production: boolean;
}

/** The keyid shape a production anchor must carry. Pinned in both directions —
 *  the flag and the prefix have to agree — so a key promoted by editing one
 *  field alone is not silently trusted. */
export const PRODUCTION_KEYID_PREFIX = "hxf-prod-";

export function isProductionAnchor(key: TrustedSigningKey): boolean {
  return key.production && key.keyid.startsWith(PRODUCTION_KEYID_PREFIX);
}

/** Whether this BUILD can enforce artifact signatures at all. */
export function hasProductionAnchor(
  keys: readonly TrustedSigningKey[] = TRUSTED_SIGNING_KEYS,
): boolean {
  return keys.some(isProductionAnchor);
}

// The anchor set replacement is a RELEASE act, not a code edit: the production
// keypairs are generated into the release pipeline's secret store (private JWK =
// the FORTRESS_SIGNING_KEY secret) and only their public halves land here, as a
// CURRENT and a NEXT entry so a mid-rotation release verifies against both. That
// replacement drops the development key below. Until it happens no anchor is
// production, and every path that requires one refuses BY NAME rather than
// pretending a development key is a release key.
export const TRUSTED_SIGNING_KEYS: readonly TrustedSigningKey[] = [
  {
    keyid: "hxf-dev-2026-07",
    publicKey: "2MkypwQYWd8sFrN2hvhWzkf4gf6wg8KFB50Njy_l5Os",
    production: false,
  },
];

// WebCrypto's verify() wants a concrete ArrayBuffer view, not the generic
// ArrayBufferLike a plain Uint8Array/Buffer carries — copy into a fresh buffer.
function toView(u8: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(u8.byteLength);
  out.set(u8);
  return out;
}

/** Verify the proof that comes with a change of the organization's key (H-2).
 *
 *  A control plane signs `${orgId}|${signingPublicKey}|${notBefore}` with its
 *  own key, so that nothing between it and HX Fortress can swap the key the
 *  gateway verifies grants with. `keys` are the keys of that control plane
 *  which this HX Fortress trusts: named on this host, or pinned here
 *  (./control-plane-keys.ts). None is compiled into the program, so the caller
 *  has to pass them, and with an empty list every proof is false.
 *
 *  Returns true only on a valid proof; never throws (a malformed or wrong-key
 *  proof is simply `false`, so the caller keeps the existing pin). */
export async function verifyKeyProof(
  orgId: string,
  signingPublicKey: string,
  proof: KeyProof,
  keys: readonly Pick<TrustedSigningKey, "publicKey">[],
): Promise<boolean> {
  if (!proof || proof.alg !== "Ed25519-root") return false;
  if (typeof proof.notBefore !== "string" || typeof proof.sig !== "string") return false;
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = toView(Buffer.from(proof.sig, "base64url"));
  } catch {
    return false;
  }
  const message = toView(new TextEncoder().encode(`${orgId}|${signingPublicKey}|${proof.notBefore}`));
  for (const trusted of keys) {
    try {
      const key = (await importJWK({ kty: "OKP", crv: "Ed25519", x: trusted.publicKey }, "EdDSA")) as CryptoKey;
      if (await crypto.subtle.verify("Ed25519", key, sig, message)) return true;
    } catch {
      // Try the next key.
    }
  }
  return false;
}
