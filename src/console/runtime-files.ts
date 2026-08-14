// The 0600 files under <root>/runtime/ that carry state a Postgres-role
// adversary must not be able to write.
//
// Two of them are security anchors rather than caches:
//   • the in-flight command file decides which running rows may be re-driven
//     after a crash — the filesystem is the medium the SQL adversary cannot
//     reach, which is exactly why no id-string predicate replaces it;
//   • the first-observed-pause file bounds how long a pause can hold the
//     store-write gate closed, and is the SOLE such bound on an external
//     Postgres, where no role split exists to grant against.

import { readFile, unlink } from "node:fs/promises";

import { writePrivateJson } from "../host/private-json";
import type { SessionKey } from "../modules/session-vault/store/types";

/**
 * One update at a time per FILE.
 *
 * Every writer here is a read-modify-write — read the set, add an id, write the
 * set — so two overlapping calls do not merely race on the temporary file, they
 * lose an entry: the second read happens before the first write lands, and the
 * id it was supposed to add is gone from what it writes back. Overlap is
 * reachable on both files: the command poll can run alongside itself if a pass
 * outlives its interval, and the pause anchor is driven by the 5s status
 * refresh and a migration's quarter-second gate refresh at once.
 *
 * In-process only, which is all that is needed: these files have exactly one
 * writing process by design, and the pid+random temporary name below is what
 * keeps a second one from clobbering a partial write.
 */
const updates = new Map<string, Promise<unknown>>();

function serialized<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const previous = updates.get(filePath) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  updates.set(filePath, settled);
  void settled.then(() => {
    if (updates.get(filePath) === settled) updates.delete(filePath);
  });
  return next;
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

// ── In-flight commands ──────────────────────────────────────────────────────

/**
 * Command ids this daemon claimed and has not yet driven to a terminal state.
 * Written AT CLAIM TIME, before execution starts, and removed on the terminal
 * transition — so after a crash the file is precisely the set of rows this
 * process was actually working on.
 *
 * There is deliberately no "own instance id" alternative: a per-boot id makes
 * the daemon's own crashed rows unrecognizable, and a persisted one is readable
 * through SELECT by the very role the fence defends against, who could then
 * stamp it onto a planted row. `claimed_by` stays observability-only for the
 * same reason.
 */
export async function readInFlight(filePath: string): Promise<Set<string>> {
  const parsed = await readJson<unknown>(filePath);
  if (!Array.isArray(parsed)) return new Set();
  return new Set(parsed.filter((v): v is string => typeof v === "string"));
}

export async function addInFlight(filePath: string, id: string): Promise<void> {
  await serialized(filePath, async () => {
    const ids = await readInFlight(filePath);
    if (ids.has(id)) return;
    ids.add(id);
    await writePrivateJson(filePath, [...ids]);
  });
}

export async function removeInFlight(filePath: string, id: string): Promise<void> {
  await serialized(filePath, async () => {
    const ids = await readInFlight(filePath);
    if (!ids.delete(id)) return;
    await writePrivateJson(filePath, [...ids]);
  });
}

// ── Pause anchor ────────────────────────────────────────────────────────────

export interface PauseAnchor {
  /** The episode this anchor belongs to. */
  episodeId: string;
  /** When this daemon FIRST observed that episode (ISO 8601). */
  firstObservedAt: string;
}

export async function readPauseAnchor(filePath: string): Promise<PauseAnchor | null> {
  const parsed = await readJson<Partial<PauseAnchor>>(filePath);
  return typeof parsed?.firstObservedAt === "string" && typeof parsed.episodeId === "string"
    ? { episodeId: parsed.episodeId, firstObservedAt: parsed.firstObservedAt }
    : null;
}

/**
 * Stamp the anchor for one EPISODE; keep it while that episode is the one in
 * force.
 *
 * Keyed by episode id rather than by presence, because presence alone gets both
 * halves wrong. A pause that is merely still running must not keep pushing its
 * own bound forward — but an episode that EXPIRED without ever being resumed
 * used to keep its anchor too, and the next migration then anchored to a moment
 * already past the cap: min() resolved to "expired" the instant the pause was
 * armed, and the barrier a swap depends on became a silent no-op.
 */
export async function stampPauseAnchor(
  filePath: string,
  episodeId: string,
  at: Date,
): Promise<PauseAnchor> {
  return await serialized(filePath, async () => {
    const existing = await readPauseAnchor(filePath);
    if (existing?.episodeId === episodeId) return existing;
    const anchor: PauseAnchor = { episodeId, firstObservedAt: at.toISOString() };
    await writePrivateJson(filePath, anchor);
    return anchor;
  });
}

/** Cleared once no episode is in force, so nothing later anchors to an earlier
 *  one. Belt to the episode key above rather than the only strap. */
export async function clearPauseAnchor(filePath: string): Promise<void> {
  await unlink(filePath).catch(() => {});
}

/**
 * Sessions whose copy records still have to be forgotten.
 *
 * A parked-artifact replay rewrites sidecars into the bucket a resumed storage
 * migration would otherwise skip, so the replay clears those sessions' copy
 * records. The park file is unlinked before that DELETE runs, so a failure would
 * leave the list nowhere — these two keep it on disk until the delete lands.
 */
export async function readForgetPending(filePath: string): Promise<SessionKey[]> {
  const parsed = await readJson<SessionKey[]>(filePath);
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Add these to the pending set and return the whole of it, as one serialized
 * read-modify-write.
 *
 * Two callers reach here at once by construction — a slow drain and the 5s pause
 * refresh that starts the next one — and the park holds one entry per COMMIT, so
 * the same session arrives many times over. Unserialized this both loses entries
 * (the loss this file exists to prevent) and grows without bound. Deduped by
 * session key, because the set is what has to be forgotten, not how often.
 */
export async function addForgetPending(
  filePath: string,
  keys: readonly SessionKey[],
): Promise<SessionKey[]> {
  return await serialized(filePath, async () => {
    const merged = new Map<string, SessionKey>();
    for (const key of [...(await readForgetPending(filePath)), ...keys]) {
      merged.set(`${key.userId}/${key.family}/${key.sessionId}`, key);
    }
    const all = [...merged.values()];
    if (all.length > 0) await writePrivateJson(filePath, all);
    return all;
  });
}

/**
 * Drop exactly these keys from the pending set, leaving anything added since.
 *
 * Clearing the file wholesale after a successful DELETE discards entries a
 * SECOND drain appended while the first was still awaiting its statement — and
 * those were never cleared, so a resumed run skips their sessions and carries
 * stale sidecars over the cut. That is the loss this file exists to prevent.
 */
export async function removeForgetPending(
  filePath: string,
  keys: readonly SessionKey[],
): Promise<void> {
  const drop = new Set(keys.map((k) => `${k.userId}/${k.family}/${k.sessionId}`));
  await serialized(filePath, async () => {
    const left = (await readForgetPending(filePath)).filter(
      (k) => !drop.has(`${k.userId}/${k.family}/${k.sessionId}`),
    );
    if (left.length === 0) {
      await unlink(filePath).catch(() => {});
      return;
    }
    await writePrivateJson(filePath, left);
  });
}
