// `hx-fortress update` — fetch the newest hx-fortress binary from the workbench
// download proxy, verify its SHA-256, and atomically swap it over the
// currently-running binary's path. Mirrors the `hx-client/update.ts` flow
// and messaging exactly.
//
// The binary lives in the private `let-ai/hx-fortress` GitHub release tagged
// `hx-fortress-latest`. We never hit github.com directly — workbench-api's
// `GET /api/hx-gateway/download/:asset` is a server-side proxy that
// authenticates to GitHub with a PAT and streams the asset back.
//
// Atomic swap rationale: on POSIX, `rename(2)` on the same filesystem replaces
// the destination inode in one operation. A process already executing the old
// binary keeps its open file descriptor on the old inode; the kernel only
// releases the inode once that process exits. So overwriting while modules are
// running is safe — they keep their old code until a restart.
//
// Restart: the caller (cli.ts) is responsible for restarting the service after
// a successful install. runFortressUpdate itself only swaps the binary.

import { arch, platform } from "node:os";
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { dirname } from "node:path";
import {
  compareStableSemver,
  FORTRESS_VERSION,
  parseStableSemver,
} from "./version.js";
import { assertHttpsDownloadUrl, isLoopbackHost } from "./host/config";
import { SIGNATURE_ENFORCE, verifyFetchedArtifact } from "./host/trust/verify";
import type { TrustedSigningKey } from "./host/trust/signing-keys";

/** Hard ceiling on the decompressed self-update binary — a gzip-bomb guard. Well
 *  above a real single-file fortress binary, so it never trips on a legit build. */
const MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024;

export interface UpdateProgress {
  phase: "download" | "unpack" | "verify";
  pct: number;
  received?: number;
  total?: number;
}

export interface UpdateOpts {
  /**
   * Absolute base URL for the workbench-api `hx-gateway/download` mount, e.g.
   * `https://workbench.let.ai/_api/hx-gateway/download`. Derived from the
   * fortress config's `cloud.url` via `downloadBaseFromCloudUrl`.
   */
  downloadBaseUrl: string;
  /** Override the destination binary path. Defaults to `process.execPath`. */
  binPath?: string;
  log?: (msg: string) => void;
  onProgress?: (ev: UpdateProgress) => void;
  /**
   * Trust anchors for the detached signature. Defaults to the anchors baked into
   * this binary — the ONLY set a released fortress ever uses. The rig overrides
   * it so the enforced path can be driven against a fixture origin whose key
   * exists nowhere in the repository.
   */
  trustedKeys?: readonly TrustedSigningKey[];
  /** Defaults to SIGNATURE_ENFORCE. Overridden only to prove the enforcing
   *  release's behaviour before the flag flips. */
  enforceSignature?: boolean;
}

export interface UpdateResult {
  asset: string;
  sha256: string | null;
  installedPath: string;
  alreadyLatest: boolean;
  localVersion: string;
  remoteVersion: string | null;
}

/**
 * Derive the HTTP download base URL from the fortress cloud WebSocket URL.
 *
 * The cloud URL pattern (from `deriveFortressUrls`) is:
 *   `wss://{host}{prefix}/_api/hx-gateway/vault-tunnel`
 * The download base is:
 *   `https://{host}{prefix}/_api/hx-gateway/download`
 *
 * Transformation: convert a `wss` URL to `https`; convert a `ws` URL to `http`
 * ONLY for a loopback host (local dev) and otherwise UPGRADE it to https:// (M-2 no
 * silent downgrade of a remote origin), then replace the `/vault-tunnel` suffix
 * with `/download`. The result is asserted https-or-loopback (M-12) so a
 * tampered cloud URL can't point the self-updater at a cleartext remote origin.
 */
export function downloadBaseFromCloudUrl(cloudUrl: string): string {
  let base: string;
  try {
    const url = new URL(cloudUrl);
    if (url.protocol === "wss:") {
      url.protocol = "https:";
    } else if (url.protocol === "ws:") {
      url.protocol = isLoopbackHost(url.hostname) ? "http:" : "https:";
    }
    base = url.toString().replace(/\/vault-tunnel\/?$/, "/download");
  } catch {
    // Non-URL input (shouldn't happen post config-validation): fall back to a
    // conservative string map that never downgrades to cleartext.
    base = cloudUrl
      .replace(/^wss:\/\//, "https://")
      .replace(/^ws:\/\//, "https://")
      .replace(/\/vault-tunnel$/, "/download");
  }
  assertHttpsDownloadUrl(base, "cloud.url download base");
  return base;
}

/**
 * One updater at a time per binary.
 *
 * The console and the terminal can both reach this, and two swaps racing on one
 * path is a half-written binary or a lost one. The lock is an O_EXCL create
 * beside the target, so the two callers collide on the same name whichever
 * process they run in; a lock whose holder is gone is reclaimed, because a
 * crashed updater must not brick every later one.
 */
export async function acquireUpdateLock(
  binPath: string,
): Promise<{ ok: true; release: () => Promise<void> } | { ok: false; holder: number }> {
  const lockPath = `${binPath}.update.lock`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      await handle.close();
      return {
        ok: true,
        release: async (): Promise<void> => {
          await rm(lockPath, { force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = await readLockHolder(lockPath);
      if (holder !== null && processAlive(holder)) return { ok: false, holder };
      // The holder is gone. Clear it once and try again; a second EEXIST means
      // somebody else won the reclaim, and they are the live updater.
      await rm(lockPath, { force: true });
    }
  }
  return { ok: false, holder: 0 };
}

async function readLockHolder(lockPath: string): Promise<number | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    const pid = (raw as { pid?: unknown }).pid;
    return typeof pid === "number" && Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function runFortressUpdate(opts: UpdateOpts): Promise<UpdateResult> {
  const binPath = opts.binPath ?? process.execPath;
  const lock = await acquireUpdateLock(binPath);
  if (!lock.ok) {
    throw new Error(
      `another update is already running for ${binPath}` +
        (lock.holder ? ` (pid ${lock.holder})` : "") +
        ". Wait for it to finish, then run this again.",
    );
  }
  try {
    return await performUpdate(opts, binPath);
  } finally {
    await lock.release();
  }
}

async function performUpdate(opts: UpdateOpts, binPath: string): Promise<UpdateResult> {
  const log = opts.log ?? noop;
  const onProgress = opts.onProgress ?? noopProgress;
  const downloadBase = opts.downloadBaseUrl.replace(/\/+$/, "");

  const target = detectTarget();
  const asset = `hx-fortress-${target}`;
  const localVersion = FORTRESS_VERSION;
  const localStableVersion = parseStableSemver(localVersion);
  if (!localStableVersion) {
    throw new Error(`invalid local Fortress version: ${localVersion}`);
  }

  // Cheap version pre-check: skip the ~24 MB download when already current.
  const remoteVersionCheck = await fetchRemoteVersion(downloadBase);
  if (remoteVersionCheck.kind === "unsafe") {
    return alreadyLatest(asset, binPath, localVersion, null);
  }
  const remoteVersion =
    remoteVersionCheck.kind === "stable" ? remoteVersionCheck.version : null;
  if (
    remoteVersion &&
    compareStableSemver(remoteVersion.parsed, localStableVersion) <= 0
  ) {
    return alreadyLatest(asset, binPath, localVersion, remoteVersion.raw);
  }

  const binUrl = `${downloadBase}/${asset}.gz`;
  const shaUrl = `${downloadBase}/${asset}.sha256`;

  const gzBytes = await fetchBytesWithProgress(binUrl, (received, total) => {
    const pct = total > 0 ? Math.min(85, Math.floor((received * 85) / total)) : 0;
    onProgress({ phase: "download", pct, received, total });
  });

  onProgress({ phase: "unpack", pct: 90 });
  // Bound the decompressed size BEFORE materializing it: a compromised origin
  // could serve a gzip bomb that expands to gigabytes and OOMs the updater.
  // `maxOutputLength` makes gunzipSync throw ERR_BUFFER_TOO_LARGE past the cap
  // (fail-closed). 512 MiB is orders of magnitude above a real fortress binary.
  const binBytes = gunzipSync(gzBytes, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
  const shaText = (await fetchBytes(shaUrl)).toString("utf8").trim();

  // sha256sum format: "<hex>  <filename>" or bare hex.
  const expected = shaText.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error(`malformed sha256 for ${asset}: ${shaText.slice(0, 200)}`);
  }
  onProgress({ phase: "verify", pct: 96 });
  const actual = sha256(binBytes);
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
  }
  onProgress({ phase: "verify", pct: 100 });

  // Fallback no-op guard: if the downloaded binary is byte-identical to the
  // installed one (version pre-check was inconclusive), skip the swap.
  if ((await sha256OfFile(binPath)) === actual) {
    return alreadyLatest(asset, binPath, localVersion, remoteVersion?.raw ?? null);
  }

  // Authenticity gate BEFORE the swap: verify the detached signature over the
  // DECOMPRESSED binary (the CI signs pre-gzip). The sidecar lives at
  // `${asset}.sig` (not `.gz.sig`). Verify-if-present in Release A — a present
  // signature must verify; an absent one warns (non-bricking) until CI signs.
  await verifyFetchedArtifact({
    fetchImpl: fetch,
    url: `${downloadBase}/${asset}`,
    bytes: binBytes,
    enforce: opts.enforceSignature ?? SIGNATURE_ENFORCE,
    trustedKeys: opts.trustedKeys,
    // Surface the "proceeding unverified" SECURITY warning (verify-if-present) —
    // without a log it is silently swallowed on every update.
    log,
  });

  await mkdir(dirname(binPath), { recursive: true });
  // Unique per attempt: a fixed `.new` is a name two updaters would write at
  // once, and the loser's bytes would be the ones renamed into place.
  const tmpPath = `${binPath}.${process.pid}.${randomBytes(4).toString("hex")}.new`;
  await writeFile(tmpPath, binBytes);
  await chmod(tmpPath, 0o755);

  // Atomic on same fs — no half-written binary even on power loss.
  await rename(tmpPath, binPath);
  log(`installed → ${binPath}`);

  return {
    asset,
    sha256: actual,
    installedPath: binPath,
    alreadyLatest: false,
    localVersion,
    remoteVersion: remoteVersion?.raw ?? null,
  };
}

function alreadyLatest(
  asset: string,
  binPath: string,
  localVersion: string,
  remoteVersion: string | null,
): UpdateResult {
  return {
    asset,
    sha256: null,
    installedPath: binPath,
    alreadyLatest: true,
    localVersion,
    remoteVersion,
  };
}

async function fetchRemoteVersion(downloadBase: string): Promise<
  | { kind: "stable"; version: { raw: string; parsed: NonNullable<ReturnType<typeof parseStableSemver>> } }
  | { kind: "unsafe" }
  | { kind: "unavailable" }
> {
  try {
    const res = await fetch(`${downloadBase}/hx-fortress-version`, {
      headers: { "User-Agent": `hx-fortress/${FORTRESS_VERSION}` },
      redirect: "follow",
    });
    if (!res.ok) return { kind: "unavailable" };
    const raw = (await res.text()).trim();
    const parsed = parseStableSemver(raw);
    if (!parsed) {
      return { kind: "unsafe" };
    }
    return { kind: "stable", version: { raw, parsed } };
  } catch {
    return { kind: "unavailable" };
  }
}

async function sha256OfFile(path: string): Promise<string | null> {
  try {
    return sha256(await readFile(path));
  } catch {
    return null;
  }
}

function detectTarget(): string {
  const osMap: Record<string, string> = {
    darwin: "darwin",
    linux: "linux",
  };
  const archMap: Record<string, string> = {
    x64: "x64",
    arm64: "arm64",
  };
  const os = osMap[platform()];
  const a = archMap[arch()];
  if (!os) throw new Error(`hx-fortress update: unsupported OS ${platform()}`);
  if (!a) throw new Error(`hx-fortress update: unsupported arch ${arch()}`);
  return `${os}-${a}`;
}

async function fetchBytes(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { "User-Agent": `hx-fortress/${FORTRESS_VERSION}` },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function fetchBytesWithProgress(
  url: string,
  onChunk: (received: number, total: number) => void,
): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { "User-Agent": `hx-fortress/${FORTRESS_VERSION}` },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    onChunk(buf.length, total || buf.length);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  onChunk(0, total);
  for (; ;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length > 0) {
      chunks.push(Buffer.from(value));
      received += value.length;
      onChunk(received, total);
    }
  }
  return Buffer.concat(chunks);
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function noop(): void { }

function noopProgress(): void { }
