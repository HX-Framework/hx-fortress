// `hx-fortress update` — fetch the newest hx-fortress binary from the update
// source, verify its SHA-256 and, when the release has one, its signature, and
// atomically swap it over the currently-running binary's path.
//
// The update source is ONE base address: the project's own releases, or an
// address the organization names. `src/update-source.ts` resolves it and lists
// the files a base address holds. It is never a control plane's address: what
// runs on this host is decided on this host.
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
import { assertHttpsDownloadUrl } from "./host/config";
import { SIGNATURE_ENFORCE, verifyFetchedArtifact } from "./host/trust/verify";
import type { TrustedSigningKey } from "./host/trust/signing-keys";
import { followingHttpsRedirects } from "./https-redirects";
import { fetchPublishedVersion, VERSION_FILE } from "./update-source";

/** How long the source may take to say which version it holds. */
const VERSION_TIMEOUT_MS = 30_000;

/** Every request of an update: a redirect is followed only to https. */
const download = followingHttpsRedirects();

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
   * The base address of the update source, e.g. `https://updates.example/hx-fortress`.
   * One release's files are found under it by name. `resolveUpdateSource` in
   * `src/update-source.ts` works it out from this host's settings.
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
  // Whoever resolved the address has already held it to this rule. It is held
  // to it again here, at the one place a download starts: https, or http to
  // this host itself.
  assertHttpsDownloadUrl(downloadBase, "the update source");

  const target = detectTarget();
  const asset = `hx-fortress-${target}`;
  const localVersion = FORTRESS_VERSION;
  const localStableVersion = parseStableSemver(localVersion);
  if (!localStableVersion) {
    throw new Error(`invalid local Fortress version: ${localVersion}`);
  }

  // The source says which version it holds, and only a NEWER one is taken. A
  // source that does not say is not asked for a program: without the version
  // there is no telling an update from a step back, and an update never goes
  // backwards. The statement is the source's own, in a file that carries no
  // signature. It decides whether a download starts, and the checksum and the
  // signature decide what may be put in place.
  const stated = await fetchPublishedVersion(downloadBase, {
    timeoutMs: VERSION_TIMEOUT_MS,
    userAgent: `hx-fortress/${FORTRESS_VERSION}`,
  });
  if (stated.state === "unreachable") {
    throw new Error(
      `The update source did not answer when asked which version it holds (${downloadBase}/${VERSION_FILE}). ` +
        "Nothing was installed.",
    );
  }
  const remoteParsed = stated.state === "version" ? parseStableSemver(stated.version) : null;
  if (stated.state !== "version" || !remoteParsed) {
    throw new Error(
      `The update source does not say which version it holds: ${downloadBase}/${VERSION_FILE} ` +
        `answered ${stated.state === "none" ? stated.status : "with no version"}, and a version such as 1.2.3 ` +
        "was expected. Nothing was installed.",
    );
  }
  const remoteVersion = { raw: stated.version, parsed: remoteParsed };
  if (compareStableSemver(remoteVersion.parsed, localStableVersion) <= 0) {
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

  // If the downloaded program is byte for byte the installed one, there is
  // nothing to put in place.
  if ((await sha256OfFile(binPath)) === actual) {
    return alreadyLatest(asset, binPath, localVersion, remoteVersion.raw);
  }

  // Authenticity gate BEFORE the swap: verify the detached signature over the
  // DECOMPRESSED binary (the CI signs pre-gzip). The sidecar lives at
  // `${asset}.sig` (not `.gz.sig`). Verify-if-present in Release A — a present
  // signature must verify; an absent one warns (non-bricking) until CI signs.
  await verifyFetchedArtifact({
    fetchImpl: download,
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
    remoteVersion: remoteVersion.raw,
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
  const res = await download(url, {
    headers: { "User-Agent": `hx-fortress/${FORTRESS_VERSION}` },
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
  const res = await download(url, {
    headers: { "User-Agent": `hx-fortress/${FORTRESS_VERSION}` },
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
