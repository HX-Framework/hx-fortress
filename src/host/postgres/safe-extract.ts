// Pre-extraction audit for downloaded archives (zip-slip / tar-slip / symlink
// guard). A tampered pgvector tarball or zonky jar could carry a member that
// writes OUTSIDE the destination — an absolute path, a `..` traversal, or a
// symlink/hardlink pointing at a host file the fortress can then overwrite via a
// follow-up member. `tar`/`unzip` extract such members faithfully, so we LIST
// the archive first (`tar -t…`) and refuse to extract if any member is unsafe.
//
// The binaries are invoked by absolute path (resolved once via Bun.which) so a
// hostile $PATH can't shadow `tar`/`unzip`; if resolution fails we fall back to
// the bare name (dev machines where which() misses but the tool is on PATH).

import type { Spawner } from "./spawn";

const binCache = new Map<string, string>();

/** Absolute path to a system binary, resolved once and memoized. Falls back to
 *  the bare name when `Bun.which` can't locate it. */
export function resolveBin(name: string): string {
  const cached = binCache.get(name);
  if (cached) return cached;
  const resolved = Bun.which(name) ?? name;
  binCache.set(name, resolved);
  return resolved;
}

// Cap the captured `tar -t…` listing — a tampered archive with billions of
// members would otherwise stream an unbounded listing into memory. A real
// pgvector/zonky listing is a few KB; 16 MiB is orders of magnitude of headroom.
const MAX_LISTING_BYTES = 16 * 1024 * 1024;

async function capture(spawner: Spawner, cmd: string[]): Promise<string> {
  const { code, stdout, stderr } = await spawner.run(cmd, { maxStdoutBytes: MAX_LISTING_BYTES });
  if (code !== 0) throw new Error(`${cmd[0]} failed: ${stderr.trim()}`);
  return stdout ?? "";
}

/** Throw if a tar member path escapes the destination (absolute or contains a
 *  `..` segment). A leading `./` (how `tar -C . …` packs entries) is stripped. */
function assertSafeMemberPath(name: string, tarPath: string): void {
  const p = name.replace(/^\.\/+/, "");
  if (name.startsWith("/") || p.startsWith("/")) {
    throw new Error(`unsafe tar member (absolute path) in ${tarPath}: ${name}`);
  }
  if (p.split("/").some((seg) => seg === "..")) {
    throw new Error(`unsafe tar member (parent-dir escape) in ${tarPath}: ${name}`);
  }
}

/** A symlink/hardlink member is SAFE iff its target stays INSIDE the archive
 *  tree — a relative, non-escaping link. Real artifacts legitimately ship these
 *  (the zonky Postgres bundle carries `.so` version symlinks like
 *  `lib/libpq.so -> libpq.so.5.18`). We reject only an ABSOLUTE target or one
 *  that resolves outside the root, which a later member could then be written
 *  THROUGH to escape. `linkFrom` is the member's own path (a relative symlink
 *  target resolves against its directory); a hardlink target is archive-root
 *  relative, so pass `linkFrom=""`. */
function assertSafeLinkTarget(linkFrom: string, target: string, archivePath: string): void {
  if (target.startsWith("/")) {
    throw new Error(`unsafe link (absolute target) in ${archivePath}: ${linkFrom} -> ${target}`);
  }
  // Runtime-independent segment-depth walk — do NOT use path.posix.normalize:
  // Bun 1.3.14 mis-normalizes `xx../../..` (leaves it unchanged instead of `..`),
  // which would let a top-level symlink escape. Start at the symlink's directory
  // depth, apply the target's segments, and reject if depth ever drops below root.
  let depth = 0;
  const fromSegs = linkFrom.replace(/^\.\/+/, "").split("/");
  for (const s of fromSegs.slice(0, -1)) if (s && s !== ".") depth += 1;
  for (const s of target.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      depth -= 1;
      if (depth < 0) {
        throw new Error(`unsafe link (escapes archive root) in ${archivePath}: ${linkFrom} -> ${target}`);
      }
    } else {
      depth += 1;
    }
  }
}

/**
 * Audit a tar archive BEFORE extraction: reject any symlink/hardlink member,
 * absolute path, or `..` traversal. `flags` carries the compression selector
 * (`"z"` for .tar.gz, `"J"` for .txz) so the listing matches the later extract.
 * A read-only two-pass listing (`-t` for clean names, `-tv` for member types).
 */
export async function assertSafeTar(
  spawner: Spawner,
  tarPath: string,
  flags: string,
): Promise<void> {
  const tar = resolveBin("tar");

  // Pass 1: clean member names (one per line) for the path-escape checks.
  const names = await capture(spawner, [tar, `-t${flags}f`, tarPath]);
  let memberCount = 0;
  for (const line of names.split("\n")) {
    const name = line.trim();
    if (name.length === 0) continue;
    assertSafeMemberPath(name, tarPath);
    memberCount += 1;
  }
  // Fail CLOSED on an empty listing: zero members means the audit inspected
  // nothing, so extracting would be unaudited. A legitimate archive always lists
  // at least one member (and an empty stdout is how a mis-behaving spawner would
  // silently defeat the guard), so reject rather than fall through.
  if (memberCount === 0) {
    throw new Error(`refusing to extract ${tarPath}: archive listing is empty (unaudited)`);
  }

  // Pass 2: verbose listing for type detection. The first character of each line
  // is the member's type across GNU and BSD tar. Device/FIFO/socket members are
  // never part of a code artifact — reject them. Symlinks (`<name> -> <target>`)
  // and hardlinks (`<name> link to <target>`) are allowed ONLY when the target
  // stays inside the tree (real bundles ship relative `.so` version symlinks);
  // an absolute or escaping target is rejected.
  const verbose = await capture(spawner, [tar, `-tv${flags}f`, tarPath]);
  for (const line of verbose.split("\n")) {
    if (line.trim().length === 0) continue;
    const type = line[0];
    if (type === "b" || type === "c" || type === "p" || type === "s") {
      throw new Error(`unsafe tar member (device/fifo/socket) in ${tarPath}: ${line.trim()}`);
    }
    const arrow = line.indexOf(" -> ");
    if (arrow !== -1) {
      const name = (line.slice(0, arrow).trim().split(/\s+/).pop() ?? "");
      assertSafeLinkTarget(name, line.slice(arrow + 4).trim(), tarPath);
      continue;
    }
    const link = line.indexOf(" link to ");
    if (link !== -1) {
      assertSafeMemberPath(line.slice(link + 9).trim(), tarPath); // hardlink target is root-relative
      continue;
    }
    // A link type with no parseable target line — fail closed (can't validate it).
    if (type === "l" || type === "h") {
      throw new Error(`unsafe tar member (unparseable link) in ${tarPath}: ${line.trim()}`);
    }
  }
}

/**
 * Audit a ZIP archive (the OUTER zonky jar) BEFORE extraction, the zip analogue
 * of `assertSafeTar`: reject any member with an absolute path, a `..` traversal,
 * or a symlink. `unzip` extracts such members faithfully, so — like the inner
 * `.txz` — we LIST the jar first and refuse to extract if any member is unsafe.
 *   • `unzip -Z1` → bare member names (no header/footer) for the path-escape checks.
 *   • `unzip -Z`  → zipinfo verbose; the first char of each entry line flags a
 *     symlink (`l`), the ` -> ` marker is a backstop. (Zip can't carry device/FIFO
 *     nodes, so only symlinks need the type check.)
 * Fail-closed on an empty listing (audited nothing).
 */
export async function assertSafeZip(spawner: Spawner, zipPath: string): Promise<void> {
  const unzip = resolveBin("unzip");

  // Pass 1: clean member names (one per line) for the path-escape checks.
  const names = await capture(spawner, [unzip, "-Z1", zipPath]);
  let memberCount = 0;
  for (const line of names.split("\n")) {
    const name = line.trim();
    if (name.length === 0) continue;
    assertSafeMemberPath(name, zipPath);
    memberCount += 1;
  }
  if (memberCount === 0) {
    throw new Error(`refusing to extract ${zipPath}: archive listing is empty (unaudited)`);
  }

  // Pass 2: verbose zipinfo — the first char of an entry line is `l` for a symlink.
  // Header/footer lines ("Archive:", "Zip file size:", the entry-count trailer)
  // never start with `l` and carry no ` -> `. A symlink (`<name> -> <target>`) is
  // allowed only when its target stays inside the tree; absolute/escaping → reject.
  const verbose = await capture(spawner, [unzip, "-Z", zipPath]);
  for (const line of verbose.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const arrow = line.indexOf(" -> ");
    if (arrow !== -1) {
      const name = (line.slice(0, arrow).trim().split(/\s+/).pop() ?? "");
      assertSafeLinkTarget(name, line.slice(arrow + 4).trim(), zipPath);
      continue;
    }
    if (trimmed[0] === "l") {
      throw new Error(`unsafe zip member (unparseable symlink) in ${zipPath}: ${trimmed}`);
    }
  }
}
