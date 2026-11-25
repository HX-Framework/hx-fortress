// Idempotent, MANDATORY inject of pgvector into the fortress's *own* embedded
// Postgres bundle. Runs on every boot before migrate: if `vector.control` isn't
// already present, download the matching per-platform artifact (checksum
// verified) and drop `vector.<so|dylib>` + control + SQL into the bundle's own
// lib / extension dirs (all under ~/.let — relocatable PG resolves $libdir /
// sharedir relative to the extracted binary).
//
// pgvector is required, not best-effort: semantic search is a core feature, so
// any failure THROWS and fails the boot fast — the same stance main.ts already
// takes for a missing OpenAI key ("refuse to start rather than silently degrade
// to keyword-only search"). Sentinel-independent, so it also upgrades existing
// installs without touching the data dir; idempotent, so a present install is a
// cheap no-op.

import { existsSync, type Dirent } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, writeFile, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { followingHttpsRedirects } from "../../https-redirects";
import { ownReleaseBases, type UpdateSource } from "../../update-source";
import { assertHttpsDownloadUrl } from "../config";
import type { ZonkyClassifier } from "./classifier";
import { pgvectorArtifactUrl, verifySha256 } from "./pgvector-artifact";
import {
  SIGNATURE_ENFORCE,
  verifyFetchedArtifact,
  type VerifyFetchedArtifactOptions,
} from "../trust/verify";

export interface EnsurePgvectorDeps {
  /** ~/.let/hx-fortress/postgres/<version> — the extracted zonky bundle root. */
  versionDir: string;
  classifier: ZonkyClassifier;
  pgMajor: number;
  /** The base addresses that may hold the pgvector files, in the order to ask.
   *  The next one is asked only when the one before it answers that it has no
   *  such file. A function is called only when the files are not on this disk
   *  yet, so a host that already holds them asks nobody for an address. It may
   *  throw: a setting that cannot be understood is reported by name, and
   *  nothing is downloaded. */
  baseUrls: readonly string[] | (() => Promise<readonly string[]>);
  /** macOS → strip quarantine + ad-hoc sign the downloaded .dylib so dlopen works. */
  darwin: boolean;
  fetchImpl: typeof fetch;
  extractTarGz: (tarPath: string, destDir: string) => Promise<void>;
  /** Run a host command (xattr/codesign). Throws on non-zero. */
  spawn: (cmd: string[]) => Promise<void>;
  log: (msg: string, meta?: Record<string, unknown>) => void;
  /** Signature-verification seam; defaults to the real verifier. Injectable so
   *  the inject flow unit-tests without a live `.sig` fetch. */
  verify?: (opts: VerifyFetchedArtifactOptions) => Promise<void>;
}

export type EnsurePgvectorResult = "present" | "installed";

/** How long the download of the extension's archive may take, and how long
 *  each of its two small files (the checksum, the signature) may take. */
const PGVECTOR_FILE_TIMEOUT_MS = 300_000;
const PGVECTOR_SMALL_TIMEOUT_MS = 30_000;

/** Whether the extension is already in the database program's own folder: an
 *  earlier start put it there, and it needs no download. */
export async function pgvectorPresent(versionDir: string): Promise<boolean> {
  const extDir = await findExtensionDir(versionDir).catch(() => null);
  return extDir !== null && existsSync(path.join(extDir, "vector.control"));
}

/**
 * What a start does about the extension.
 *
 * There is always a place to download it from: the extension's files are
 * published beside the program, so they come from the release of this version
 * of the program, or from the address this host names. No control plane takes
 * part. So the question here is only whether to download, and the answer does
 * not depend on where from.
 *
 * Three cases, in this order. An extension an earlier start installed is
 * used, and nothing is asked of any address. An HX Fortress in which nothing
 * that is switched on searches goes on without it: nothing is downloaded that
 * nothing needs, and the gated migrations are skipped and tried again at a
 * later start. Otherwise it is downloaded.
 */
export async function planPgvector(args: {
  versionDir: string;
  /** False when nothing that is switched on needs the extension. */
  needed?: boolean;
}): Promise<"download" | "use-installed" | "leave-out"> {
  if (await pgvectorPresent(args.versionDir)) return "use-installed";
  if (args.needed === false) return "leave-out";
  return "download";
}

/**
 * The base addresses the extension's files are asked at, in order.
 *
 * An address this host names for them alone is the only one, and then the
 * update settings are not read at all: a host whose update settings cannot be
 * understood still gets the extension from the address it names for it.
 *
 * Otherwise they are files of THIS version: built for the Postgres this
 * version runs, and signed with the keys it carries. So the release of this
 * version is asked first, then the build of this version. For the project's
 * releases the newest release is asked last: a program built from a source
 * that no release was cut from yet finds them there. An address the
 * organization names holds one release's files, and is asked alone.
 */
export async function pgvectorBaseUrls(args: {
  /** FORTRESS_PGVECTOR_URL or postgres.pgvectorUrl, or "" when neither is set. */
  ownUrl: string;
  /** Read only when `ownUrl` is empty. It may throw, by name. */
  updateSource: () => Promise<UpdateSource>;
  /** The version of the program that runs. */
  version: string;
}): Promise<string[]> {
  if (args.ownUrl) return [args.ownUrl];
  const source = await args.updateSource();
  const bases = [...ownReleaseBases(source, args.version)];
  if (source.from === "project-releases") bases.push(source.base);
  for (const base of bases) assertHttpsDownloadUrl(base, "the update source");
  return bases;
}

export async function ensurePgvectorInstalled(
  deps: EnsurePgvectorDeps,
): Promise<EnsurePgvectorResult> {
  const extDir = await findExtensionDir(deps.versionDir);
  if (!extDir) {
    throw new Error(`pgvector inject: no extension dir found under ${deps.versionDir}`);
  }
  if (existsSync(path.join(extDir, "vector.control"))) return "present";

  const baseUrls = typeof deps.baseUrls === "function" ? await deps.baseUrls() : deps.baseUrls;
  // Every request has a deadline, and a redirect is followed only to https.
  // This runs inside the start of the database: on a network that drops the
  // traffic without an answer, a request with no deadline would hold the start
  // for as long as the system keeps the connection.
  const fetchImpl = followingHttpsRedirects(deps.fetchImpl);
  const within =
    (ms: number): typeof fetch =>
    ((input, init) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(ms) })) as typeof fetch;
  let found: { url: string; tarBytes: Uint8Array } | null = null;
  const asked: string[] = [];
  for (const baseUrl of baseUrls) {
    const candidate = pgvectorArtifactUrl(baseUrl, deps.pgMajor, deps.classifier);
    asked.push(candidate);
    const tarBytes = await fetchBytes(within(PGVECTOR_FILE_TIMEOUT_MS), candidate);
    if (tarBytes) {
      found = { url: candidate, tarBytes };
      break;
    }
  }
  if (!found) {
    throw new Error(
      `pgvector inject: the files for Postgres ${deps.pgMajor} on ${deps.classifier} are not at ${asked.join(" or ")}. ` +
        "They are published with each version of HX Fortress. Update HX Fortress, or name an address that " +
        "holds them in FORTRESS_PGVECTOR_URL.",
    );
  }
  const { url, tarBytes } = found;
  const expected = await fetchText(within(PGVECTOR_SMALL_TIMEOUT_MS), `${url}.sha256`);
  // Same-origin `.sha256` is a cheap integrity pre-check (a corrupt download
  // fails fast here); authenticity is the detached signature gate below.
  if (!verifySha256(tarBytes, expected)) {
    throw new Error(`pgvector inject: checksum mismatch for ${url}`);
  }
  // Verify the detached Ed25519 signature over the tarball BEFORE extracting or
  // codesigning any of its bytes. Verify-if-present in Release A: a present
  // signature must verify; an absent one warns (non-bricking) until CI signs.
  const verify = deps.verify ?? verifyFetchedArtifact;
  await verify({
    fetchImpl: within(PGVECTOR_SMALL_TIMEOUT_MS),
    url,
    bytes: tarBytes,
    enforce: SIGNATURE_ENFORCE,
    log: (msg, fields) => deps.log(msg, fields),
  });

  const tmp = await mkdtemp(path.join(os.tmpdir(), "pgv-inject-"));
  try {
    const tarPath = path.join(tmp, "vector.tar.gz");
    await writeFile(tarPath, tarBytes);
    await deps.extractTarGz(tarPath, tmp);

    const libDir = await findLibDir(deps.versionDir);
    if (!libDir) {
      throw new Error(`pgvector inject: no lib dir found under ${deps.versionDir}`);
    }
    await copyInto(path.join(tmp, "lib"), libDir, /^vector\.(so|dylib)$/);
    await copyInto(
      path.join(tmp, "share", "extension"),
      extDir,
      /^vector(\.control|--.*\.sql)$/,
    );

    // A DOWNLOADED .dylib carries a com.apple.quarantine xattr that blocks
    // dlopen by the local postgres process. Strip it and ad-hoc re-sign so the
    // library loads — still entirely within ~/.let, nothing host-wide. No-op on
    // Linux (deps.darwin false). These stay best-effort (swallowed): quarantine
    // is often absent on fetch-written files, and if the module truly won't
    // load, the extension-creating migration fails loudly right after.
    if (deps.darwin) {
      // The module suffix is whatever this PG build uses (.dylib or .so), so
      // sign whichever one actually landed rather than assuming .dylib.
      const mod = ["vector.dylib", "vector.so"]
        .map((n) => path.join(libDir, n))
        .find((p) => existsSync(p));
      if (mod) {
        await deps.spawn(["xattr", "-d", "com.apple.quarantine", mod]).catch(() => {});
        await deps.spawn(["codesign", "--force", "--sign", "-", mod]).catch(() => {});
      }
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  deps.log("pgvector installed into embedded bundle", {
    classifier: deps.classifier,
    pgMajor: deps.pgMajor,
  });
  return "installed";
}

// The zonky bundle's extension + pkglib dirs vary by build layout
// (share/extension vs share/postgresql/extension; lib vs lib/postgresql), so we
// self-locate against a stock file rather than hardcode a path. plpgsql is
// always present, so its control file anchors the extension dir and its module
// anchors the pkglib dir — exactly where postgres will look for `vector`.

async function findExtensionDir(versionDir: string): Promise<string | null> {
  return findDirContaining(versionDir, (name) => name.endsWith(".control"));
}

async function findLibDir(versionDir: string): Promise<string | null> {
  const byModule = await findDirContaining(versionDir, (name) =>
    /^(plpgsql|pgcrypto|pg_trgm)\.(so|dylib)$/.test(name),
  );
  if (byModule) return byModule;
  const fallback = path.join(versionDir, "lib");
  return existsSync(fallback) ? fallback : null;
}

async function findDirContaining(
  root: string,
  matches: (name: string) => boolean,
  maxDepth = 4,
): Promise<string | null> {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((e) => e.isFile() && matches(e.name))) return dir;
    if (depth < maxDepth) {
      for (const e of entries) {
        if (e.isDirectory()) queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
      }
    }
  }
  return null;
}

async function copyInto(srcDir: string, destDir: string, re: RegExp): Promise<void> {
  const names = await readdir(srcDir);
  await mkdir(destDir, { recursive: true });
  for (const name of names) {
    if (re.test(name)) await copyFile(path.join(srcDir, name), path.join(destDir, name));
  }
}

/** The file's bytes, or null when the address answers that it has no such
 *  file. Any other failure throws. */
async function fetchBytes(fetchImpl: typeof fetch, url: string): Promise<Uint8Array | null> {
  const res = await fetchImpl(url);
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchText(fetchImpl: typeof fetch, url: string): Promise<string> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return res.text();
}
