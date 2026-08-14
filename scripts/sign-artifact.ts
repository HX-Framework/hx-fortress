// CI release signer — emit a detached Ed25519 `<path>.sig` sidecar for each
// artifact so the runtime can verify authenticity (not just a same-origin
// `.sha256`) against the trust anchors baked into the binary
// (src/host/trust/signing-keys.ts). Run over the DECOMPRESSED binary (before
// gzip) and over the pgvector tarball.
//
//   FORTRESS_SIGNING_KEY   base64url(JSON) of the PRIVATE Ed25519 JWK (CI secret)
//   FORTRESS_SIGNING_KEYID keyid recorded in the sidecar — MUST match a baked
//                          TRUSTED_SIGNING_KEYS entry, else the runtime rejects it
//
//   bun run scripts/sign-artifact.ts <path> [<path> ...]
//
// The sidecar format matches parseSignatureSidecar():
//   {"v":1,"alg":"Ed25519","keyid":"<keyid>","sig":"<base64url raw signature>"}
import { readFile, writeFile } from "node:fs/promises";

import { importJWK, type JWK } from "jose";

async function main(): Promise<void> {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    throw new Error("usage: bun run scripts/sign-artifact.ts <path> [<path> ...]");
  }

  const rawKey = process.env.FORTRESS_SIGNING_KEY?.trim();
  const keyid = process.env.FORTRESS_SIGNING_KEYID?.trim();
  if (!rawKey) throw new Error("FORTRESS_SIGNING_KEY is not set");
  if (!keyid) throw new Error("FORTRESS_SIGNING_KEYID is not set");

  let jwk: JWK;
  try {
    jwk = JSON.parse(Buffer.from(rawKey, "base64url").toString("utf8")) as JWK;
  } catch {
    throw new Error("FORTRESS_SIGNING_KEY must be base64url(JSON) of a private Ed25519 JWK");
  }

  const key = (await importJWK(jwk, "EdDSA")) as CryptoKey;
  if (key.type !== "private") {
    throw new Error("FORTRESS_SIGNING_KEY must be a PRIVATE Ed25519 JWK (has the `d` parameter)");
  }

  for (const path of paths) {
    const bytes = await readFile(path);
    const sigBuf = await crypto.subtle.sign("Ed25519", key, bytes);
    const sig = Buffer.from(new Uint8Array(sigBuf)).toString("base64url");
    const sidecar = { v: 1, alg: "Ed25519", keyid, sig };
    await writeFile(`${path}.sig`, `${JSON.stringify(sidecar)}\n`);
    console.log(`signed ${path} -> ${path}.sig (keyid=${keyid})`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
