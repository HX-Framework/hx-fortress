import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import type { ZonkyClassifier } from "./classifier";
import { PINNED_PG_SHA256 } from "./pinned-hashes";
import { ProgressBar } from "../../progress";

export function zonkyJarUrl(
  binariesUrl: string,
  classifier: ZonkyClassifier,
  version: string,
): string {
  const base = binariesUrl.replace(/\/+$/, "");
  const artifact = `embedded-postgres-binaries-${classifier}`;
  return `${base}/io/zonky/test/postgres/${artifact}/${version}/${artifact}-${version}.jar`;
}

export interface AcquireDeps {
  fetchImpl: typeof fetch;
  extract: (jarPath: string, destDir: string) => Promise<void>;
  cacheDir: string;
  versionDir: string;
  classifier: ZonkyClassifier;
  version: string;
  binariesUrl: string;
  /** Strict mode (FORTRESS_PG_REQUIRE_PINNED): refuse a jar with no pinned hash
   *  rather than falling back to the network `.sha256`. Default off (non-bricking). */
  requirePinned?: boolean;
  /** Escape hatch (FORTRESS_PG_ALLOW_UNPINNED) that re-permits the fallback even
   *  under strict mode. */
  allowUnpinned?: boolean;
  /** Structured warn sink for the "unpinned PG binary" SECURITY notice. */
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export async function acquireBinaries(deps: AcquireDeps): Promise<string> {
  const binDir = path.join(deps.versionDir, "bin");
  const sentinel = path.join(deps.versionDir, ".ready");
  if (existsSync(sentinel)) return binDir;

  const url = zonkyJarUrl(deps.binariesUrl, deps.classifier, deps.version);
  // MC-2464: show the same dim-label + blue-bar + percent indicator the curl
  // installer and `hx-fortress update` use while the Postgres runtime downloads.
  const bar = new ProgressBar();
  bar.status("Downloading the Postgres runtime…");
  const jarBytes = await fetchBytes(deps.fetchImpl, url, (received, total) => {
    if (total > 0) bar.draw((received / total) * 100, "Downloading");
  });
  bar.end();
  const actual = createHash("sha256").update(jarBytes).digest("hex");
  await verifyJarIntegrity(deps, url, actual);

  await mkdir(deps.cacheDir, { recursive: true, mode: 0o700 });
  const jarPath = path.join(deps.cacheDir, `${deps.classifier}-${deps.version}.jar`);
  await writeFile(jarPath, jarBytes);

  await rm(deps.versionDir, { recursive: true, force: true });
  await mkdir(deps.versionDir, { recursive: true, mode: 0o700 });
  await deps.extract(jarPath, deps.versionDir);
  await writeFile(sentinel, `${deps.version}\n`);
  return binDir;
}

/**
 * Verify the downloaded jar's integrity (M-3). A BAKED pinned hash is
 * fail-closed and needs no network `.sha256` — it defeats a hostile Maven mirror
 * / repointed FORTRESS_PG_BINARIES_URL. When the `${version}/${classifier}` key
 * is not yet pinned, fall back to the same-origin `.sha256` and emit a SECURITY
 * warning, so an empty pin map never bricks boot. Strict mode
 * (FORTRESS_PG_REQUIRE_PINNED, minus the FORTRESS_PG_ALLOW_UNPINNED escape)
 * turns the unpinned case into a hard failure.
 */
async function verifyJarIntegrity(
  deps: AcquireDeps,
  url: string,
  actual: string,
): Promise<void> {
  const key = `${deps.version}/${deps.classifier}`;
  const pinned = PINNED_PG_SHA256[key]?.trim().toLowerCase();
  if (pinned) {
    if (actual !== pinned) {
      throw new Error(
        `Postgres binary pinned-hash mismatch for ${key} (expected ${pinned}, got ${actual})`,
      );
    }
    return;
  }

  if (deps.requirePinned && !deps.allowUnpinned) {
    throw new Error(
      `Postgres binary ${key} is not in PINNED_PG_SHA256 and FORTRESS_PG_REQUIRE_PINNED is set ` +
        `(set FORTRESS_PG_ALLOW_UNPINNED=1 to override)`,
    );
  }

  deps.log?.("SECURITY: PG binary unpinned; add to PINNED_PG_SHA256", { key, actual });
  const expected = await fetchExpectedSha(deps.fetchImpl, `${url}.sha256`);
  if (actual !== expected) {
    throw new Error(`Postgres binary checksum mismatch for ${url}`);
  }
}

async function fetchBytes(
  fetchImpl: typeof fetch,
  url: string,
  onProgress?: (received: number, total: number) => void,
): Promise<Uint8Array> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Postgres binary download failed (${res.status}) for ${url}`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  onProgress?.(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length > 0) {
      chunks.push(value);
      received += value.length;
      onProgress?.(received, total);
    }
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function fetchExpectedSha(fetchImpl: typeof fetch, url: string): Promise<string> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Postgres checksum download failed (${res.status}) for ${url}`);
  const text = await res.text();
  const token = text.trim().split(/\s+/)[0] ?? "";
  return token.toLowerCase();
}
