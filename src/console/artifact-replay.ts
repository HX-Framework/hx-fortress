// The durable park for post-commit artifact writes refused by the pause gate.
//
// A commit accepted one second before a pause has already answered the device;
// its deferred session-metadata write then meets a closed gate. Dropping it
// would silently lose the metadata the commit promised, and re-enqueueing it
// would stall the post-commit chain the quiesce barrier is waiting on — so the
// entry PARKS here (0600, append-only) and its chain entry RESOLVES. The park
// is drained after resume.

import { appendFile, mkdir, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import type { SessionKey } from "../modules/session-vault/store/types";

export interface ParkedArtifact {
  key: SessionKey;
  name: string;
  text: string;
  parkedAt: string;
  /** Whether the commit this sidecar belongs to was a REPLACE. A replace is
   *  authoritative — its totals may legitimately be smaller than what is in the
   *  bucket — so the replay must take them verbatim rather than merging them
   *  forward. Absent on entries parked by an older build, which are appends. */
  replace?: boolean;
}

export async function parkArtifact(filePath: string, entry: ParkedArtifact): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await appendFile(filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

export async function readParkedArtifacts(filePath: string): Promise<ParkedArtifact[]> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const out: ParkedArtifact[] = [];
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ParkedArtifact);
    } catch {
      // A torn final line from a crash mid-append; the write it described was
      // never acknowledged as parked, so there is nothing to replay.
    }
  }
  return out;
}

export interface ReplayResult {
  replayed: number;
  failed: number;
  /** Entries deliberately NOT written — a sidecar for a session that has since
   *  been permanently deleted. Kept apart from `replayed` because the daemon's
   *  audit record reports that count, and a compliance surface must not say a
   *  write happened when it did not. */
  dropped: number;
  /** Sessions whose sidecars this drain rewrote. A replay is the one writer that
   *  changes a sidecar without appending the canonical, so a storage migration
   *  cannot see it by measuring canonical length — it has to be told. */
  rewrote: SessionKey[];
}

/** One drain per park path at a time. The rename used to provide this for free:
 *  a second drain found no file and returned. Reading the orphaned `.draining`
 *  before the rename — which is what recovers a drain that died — removed that,
 *  and two overlapping drains would replay every entry twice. Both callers do
 *  overlap: the 5s pause refresh and a migration's quarter-second gate refresh
 *  drive the same function. */
const draining = new Map<string, Promise<ReplayResult>>();

/**
 * Replay every parked write, then truncate.
 *
 * The park file is rotated aside FIRST, so a write that arrives during the
 * replay lands in a fresh file instead of being truncated away with the ones
 * just drained. Entries that fail again are appended back — a failed replay
 * must not be lost either.
 */
export async function drainParkedArtifacts(
  filePath: string,
  /** Resolve `false` for an entry deliberately NOT written — see drainOnce. */
  write: (entry: ParkedArtifact) => Promise<boolean | void>,
): Promise<ReplayResult> {
  const inFlight = draining.get(filePath);
  if (inFlight) return await inFlight;
  const run = drainOnce(filePath, write).finally(() => draining.delete(filePath));
  draining.set(filePath, run);
  return await run;
}

async function drainOnce(
  filePath: string,
  /** Resolves `false` for an entry deliberately NOT written — a sidecar for a
   *  session that has since been permanently deleted. Counting that as replayed
   *  put it in the daemon's audit record, which is a compliance surface, and
   *  fed a session that no longer exists into the copy-record sweep. */
  write: (entry: ParkedArtifact) => Promise<boolean | void>,
): Promise<ReplayResult> {
  const drainingPath = `${filePath}.draining`;

  // Anything already sitting in `.draining` is a previous drain that died between
  // the rename and the finish — its entries are commits already acknowledged to a
  // device, and nothing else in the process ever looks at this path.
  //
  // It is RETURNED TO THE PARK FILE, not merely read into memory. `rename`
  // overwrites its destination, so reading the orphan and then renaming over it
  // left those entries alive only in this function's local array: a crash during
  // the replay — which walks the object store, so it is real wall-clock time —
  // and they existed nowhere on disk at all. Written back first, the worst case
  // is that an entry appears in both files and is replayed twice, and a replay
  // is the same bytes to the same key.
  const orphaned = await readParkedArtifacts(drainingPath);
  if (orphaned.length > 0) {
    for (const entry of orphaned) await parkArtifact(filePath, entry);
    await unlink(drainingPath).catch(() => {});
  }

  let renamed = true;
  try {
    await rename(filePath, drainingPath);
  } catch {
    renamed = false;
  }
  // ORDERED BY WHEN THEY WERE PARKED. The write-back above appends the recovered
  // orphans to the END of the park file, so replaying in file order would have
  // an OLDER sidecar land after a newer one — and the replay writes the parked
  // text verbatim, bypassing the monotonic-on-append rule the gateway applies
  // when it builds these. `lastActivityAt`, the counts and the title would
  // regress in the customer's only copy. `parkedAt` is written by every producer
  // and was read by nothing.
  const entries = (renamed ? await readParkedArtifacts(drainingPath) : orphaned)
    .map((entry, at) => ({ entry, at }))
    .sort((a, b) => {
      const byTime = Date.parse(a.entry.parkedAt) - Date.parse(b.entry.parkedAt);
      // A missing or equal stamp keeps file order, which is arrival order within
      // one file — never an arbitrary shuffle.
      return Number.isFinite(byTime) && byTime !== 0 ? byTime : a.at - b.at;
    })
    .map((held) => held.entry);
  if (entries.length === 0) {
    await unlink(drainingPath).catch(() => {});
    return { replayed: 0, failed: 0, dropped: 0, rewrote: [] };
  }
  let replayed = 0;
  let dropped = 0;
  const rewrote: SessionKey[] = [];
  const stillFailing: ParkedArtifact[] = [];
  for (const entry of entries) {
    try {
      const wrote = await write(entry);
      if (wrote === false) {
        dropped += 1;
        continue;
      }
      replayed += 1;
      rewrote.push(entry.key);
    } catch {
      stillFailing.push(entry);
    }
  }
  for (const entry of stillFailing) await parkArtifact(filePath, entry);
  // Unlinked, not truncated: an empty file and a finished drain must not look the
  // same to the recovery above, or a crash mid-drain reads as nothing to recover.
  await unlink(drainingPath).catch(() => {});
  return { replayed, failed: stillFailing.length, dropped, rewrote };
}

/**
 * When the park is owed a drain.
 *
 * A LATCH, not a paused→open edge. An edge can only be observed when a pause
 * ends by an explicit resume: the daemon's cached pause answers against the
 * clock, so a pause that lapses on its own deadline is already open the next
 * time anything looks — the edge test reads false at exactly the expiry it
 * exists to catch, and the parked write is stranded with no surface that would
 * ever mention it again. The entries are metadata for commits already
 * acknowledged to a device, so "stranded" means the fortress permanently holds
 * less than it told the device it had.
 *
 * Starts OWED, because a daemon restarted mid-pause has no edge to observe
 * either, and clears only on a drain that left nothing behind.
 */
export class ParkReplayLatch {
  private owed = true;

  /** Whether a drain is owed right now, given what the gate is doing. */
  due(paused: boolean): boolean {
    if (paused) {
      this.owed = true;
      return false;
    }
    return this.owed;
  }

  /** Record what a drain left behind. Anything still failing stays owed, so the
   *  next pass retries it rather than forgetting it. */
  settle(failed: number): void {
    if (failed === 0) this.owed = false;
  }
}
