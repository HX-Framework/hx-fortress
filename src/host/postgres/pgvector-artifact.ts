// Pure helpers for locating + verifying the per-platform pgvector artifact the
// release workflow publishes alongside the fortress binaries. Kept side-effect
// free so they unit-test without fs/network. See ./pgvector-install for the
// idempotent inject that consumes these.

import { createHash } from "node:crypto";

import type { ZonkyClassifier } from "./classifier";

/** `"18.4.0" → 18`. Throws on a version whose leading segment isn't numeric. */
export function pgMajorOf(version: string): number {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (!Number.isInteger(major)) throw new Error(`bad PG version: ${version}`);
  return major;
}

/** `pgvector-pg18-linux-amd64.tar.gz` — matches the release asset name. */
export function pgvectorArtifactName(pgMajor: number, classifier: ZonkyClassifier): string {
  return `pgvector-pg${pgMajor}-${classifier}.tar.gz`;
}

export function pgvectorArtifactUrl(
  baseUrl: string,
  pgMajor: number,
  classifier: ZonkyClassifier,
): string {
  return `${baseUrl.replace(/\/+$/, "")}/${pgvectorArtifactName(pgMajor, classifier)}`;
}

/** Constant-length-agnostic sha256 check against a `.sha256` sidecar's hex. */
export function verifySha256(bytes: Uint8Array, expectedHex: string): boolean {
  const actual = createHash("sha256").update(bytes).digest("hex");
  // sidecars are `<hex>` or `<hex>  <name>`; tolerate whitespace + case.
  const expected = expectedHex.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return actual === expected;
}
