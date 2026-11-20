// What happened in a store since a point in time, once it settled: the batches of files that
// arrived, the files deleted, the jobs that ended, and the fixes a person made on the Tables tab.
// A host reads it to tell others what its stores did, such as programs that start when something
// happens in a store. It is made of ids, names, sizes and counts, never a value of a row: a job is
// its summary (jobs/summary.ts).
//
// Each stream has its own time: a reader keeps the `through` an answer gives, and asks from there
// next time, so an event is in one answer only. An event is answered only once it settled, so a
// burst is one event:
//
//   files    a batch (or one file with none) once its newest file arrived FILES_SETTLE_MS ago and
//            none of its files is still arriving; a file arriving holds its batch at most
//            UPLOAD_HOLD_MS, so an upload nobody finished never holds the others back for good
//   deleted  one person's deletes, once DELETES_SETTLE_MS passed after their last
//   jobs     a job, as soon as it ended
//   fixes    a person's fixes of one table, once FIXES_SETTLE_MS passed after the last
//
// While something settles, `through` stays before it, and `settling` asks the reader to come back
// within a minute. A time further back than EVENTS_LOOKBACK_MS is read from there: what happened
// before is nobody's event any more.

import type { StoreCore } from "./core.js";
import { readJobSummary, runOfParams } from "./jobs/runner.js";
import type { StoreSqlValue } from "./sql.js";
import type { FileVia, StoreEvent, StoreEventFile, StoreEvents, StoreEventStream } from "./types.js";

/** The store's folders, read once an answer needs them: each folder's name and the one it is in. */
type FolderMap = Map<string, { name: string; parentId: string | null }>;

function folderMap(core: StoreCore): FolderMap {
  // A folder deleted since still names the files it held: a person may delete its files, then it.
  const rows = core.sql.exec<{ id: string; name: string; parent_id: string | null }>("SELECT id, name, parent_id FROM _folders").toArray();
  return new Map(rows.map((r) => [String(r.id), { name: String(r.name), parentId: r.parent_id === null ? null : String(r.parent_id) }]));
}

/** The names of the folders files are in and of every folder above them, each once, the first file's own folder first. */
function folderNamesOf(folders: FolderMap, ids: readonly string[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    for (let at: string | null = id, depth = 0; at && !seen.has(at) && depth < 64; depth++) {
      seen.add(at);
      const f = folders.get(at);
      if (!f) break;
      names.push(f.name);
      at = f.parentId;
    }
  }
  return names;
}

/** A batch of files settles this long after its newest file arrived. */
export const FILES_SETTLE_MS = 30_000;
/** A file still arriving holds its batch at most this long after it began. */
export const UPLOAD_HOLD_MS = 10 * 60_000;
/** One person's deletes settle this long after their last. */
export const DELETES_SETTLE_MS = 30_000;
/** A person's fixes of a table settle this long after the last: someone reviewing rows reads between fixes. */
export const FIXES_SETTLE_MS = 2 * 60_000;
/** The furthest back an answer reads. */
export const EVENTS_LOOKBACK_MS = 60 * 60_000;
/**
 * The longest a batch or a burst holds its stream's window, from its first time: then it is
 * answered as it stands, so nothing behind it ages past the lookback. What comes after is an event
 * of its own (a batch's key names its newest file; a burst's names its first time).
 */
export const HOLD_MAX_MS = 15 * 60_000;
/** The most events of one stream an answer holds; the next answer goes on from there. */
export const EVENTS_MAX = 100;
/** The most files one event names; `count` says how many there were. */
export const EVENT_FILES_MAX = 200;

const STREAMS: readonly StoreEventStream[] = ["files", "deleted", "jobs", "fixes"];

const iso = (ms: number): string => new Date(ms).toISOString();
const text = (v: StoreSqlValue | undefined): string => (v === null || v === undefined ? "" : String(v));

/** One stream's window: from the reader's time (no further back than the lookback) to the time that settled. */
function windowOf(now: number, since: unknown, settleMs: number): { since: string; through: number } {
  const floor = now - EVENTS_LOOKBACK_MS;
  const asked = typeof since === "string" ? Date.parse(since) : Number.NaN;
  const from = Number.isFinite(asked) ? Math.max(asked, floor) : floor;
  return { since: iso(from), through: Math.max(from, now - settleMs) };
}

interface Kept {
  events: StoreEvent[];
  /** The end of the window, moved before whatever still settles. */
  through: number;
  settling: boolean;
}

/** A burst of rows read from the window: its first and last times, and whether it settled. */
interface Burst {
  from: number;
  at: number;
  settled: boolean;
}

/**
 * The end of a window no burst straddles: every burst answered ends at or before it, and every
 * other one begins after it, so the next read, from that end, still holds all of its rows. A burst
 * that settled but ends after a later one's start waits with it. Never before the window's start,
 * since every burst read begins after it.
 */
function windowEnd(bursts: readonly Burst[], through: number): number {
  let end = through;
  for (let moved = true; moved; ) {
    moved = false;
    for (const b of bursts) {
      if (!(b.settled && b.at <= end) && b.from <= end) {
        end = b.from - 1;
        moved = true;
      }
    }
  }
  return end;
}

/**
 * The events that settled, oldest first, within the window and before any hold. Past EVENTS_MAX
 * the window ends at the last event kept, with every event of that same time.
 */
function keep(found: { at: string; event: StoreEvent }[], through: number, hold: number | null, settling: boolean): Kept {
  let end = hold === null ? through : Math.min(through, hold - 1);
  let events = found.filter((f) => Date.parse(f.at) <= end).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  if (events.length > EVENTS_MAX) {
    const last = events[EVENTS_MAX - 1]!.at;
    events = events.filter((f) => f.at <= last);
    end = Date.parse(last);
    settling = true;
  }
  return { events: events.map((f) => f.event), through: end, settling };
}

interface FileRow {
  id: string;
  name: string;
  size: number;
  folder_id: string | null;
  state: string;
  received_at: string;
  received_by: string;
  via: string;
  batch: string | null;
  ready_at: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
}

const fileOf = (r: FileRow): StoreEventFile => ({ id: r.id, name: r.name, size: Number(r.size), folderId: r.folder_id ?? "" });

/** Batches of files that arrived and settled. */
function settledFiles(core: StoreCore, now: number, since: unknown, folders: () => FolderMap): Kept {
  const w = windowOf(now, since, FILES_SETTLE_MS);
  // Every file of each batch a file arrived in since the window began, those still arriving
  // included, and each file with no batch that arrived since.
  const rows = core.sql
    .exec<Record<string, StoreSqlValue>>(
      `SELECT * FROM _files WHERE deleted_at IS NULL AND batch IN (SELECT DISTINCT batch FROM _files WHERE ready_at > ?1 AND batch IS NOT NULL)
       UNION ALL
       SELECT * FROM _files WHERE deleted_at IS NULL AND batch IS NULL AND ready_at > ?1`,
      w.since,
    )
    .toArray() as unknown as FileRow[];
  const batches = new Map<string, FileRow[]>();
  for (const r of rows) {
    const key = r.batch ?? r.id;
    const list = batches.get(key);
    if (list) list.push(r);
    else batches.set(key, [r]);
  }
  const found: { at: string; event: StoreEvent }[] = [];
  let hold: number | null = null;
  let settling = false;
  const readyAt = (f: FileRow): number => Date.parse(text(f.ready_at ?? f.received_at));
  /** Batches that kept arriving past HOLD_MAX_MS. */
  const capped: { key: string; ready: FileRow[] }[] = [];
  for (const [key, files] of batches) {
    const ready = files.filter((f) => f.state === "ready").sort((a, b) => text(a.ready_at ?? a.received_at).localeCompare(text(b.ready_at ?? b.received_at)));
    if (!ready.length) continue;
    const newest = ready[ready.length - 1]!;
    const at = newest.ready_at ?? newest.received_at;
    if (now - readyAt(ready[0]!) >= HOLD_MAX_MS) {
      // Answered a window at a time once the window's end is known (below).
      capped.push({ key, ready });
      if (files.some((f) => f.state === "uploading") || readyAt(newest) > w.through) settling = true;
      continue;
    }
    const arriving = files.some((f) => f.state === "uploading" && Date.parse(f.received_at) > now - UPLOAD_HOLD_MS);
    if (arriving || Date.parse(at) > w.through) {
      settling = true;
      // A batch that waits for a file keeps the window before its own files, so it is answered whole.
      if (arriving) {
        const first = ready.find((f) => f.ready_at !== null && f.ready_at > w.since);
        if (first) hold = Math.min(hold ?? Number.POSITIVE_INFINITY, Date.parse(first.ready_at!));
      }
      continue;
    }
    found.push({
      at,
      event: {
        kind: "files",
        // A file that joins a batch after the batch was answered makes it a new event, listing all of it.
        key: newest.batch ? `${key}:${newest.id}` : key,
        at,
        by: newest.received_by,
        via: newest.via as FileVia,
        files: ready.slice(0, EVENT_FILES_MAX).map(fileOf),
        count: ready.length,
        folders: folderNamesOf(folders(), [...new Set(ready.map((f) => f.folder_id ?? ""))].filter(Boolean)),
      },
    });
  }
  const kept = keep(found, w.through, hold, settling);
  // A batch that kept arriving past HOLD_MAX_MS is answered a window at a time: the files that became
  // whole within the window as it finally ends, each slice an event of its own, none listed twice.
  for (const c of capped) {
    const slice = c.ready.filter((f) => readyAt(f) > Date.parse(w.since) && readyAt(f) <= kept.through);
    if (!slice.length) continue;
    const last = slice[slice.length - 1]!;
    const at = text(last.ready_at ?? last.received_at);
    kept.events.push({
      kind: "files",
      // The same key a settled batch gets: a file with no batch keeps its own id.
      key: last.batch ? `${c.key}:${last.id}` : c.key,
      at,
      by: last.received_by,
      via: last.via as FileVia,
      files: slice.slice(0, EVENT_FILES_MAX).map(fileOf),
      count: slice.length,
      folders: folderNamesOf(folders(), [...new Set(slice.map((f) => f.folder_id ?? ""))].filter(Boolean)),
    });
  }
  return kept;
}

/** One person's deletes, a burst at a time. */
function settledDeletes(core: StoreCore, now: number, since: unknown, folders: () => FolderMap): Kept {
  const w = windowOf(now, since, DELETES_SETTLE_MS);
  const rows = core.sql
    .exec<Record<string, StoreSqlValue>>("SELECT * FROM _files WHERE deleted_at IS NOT NULL AND deleted_at > ? ORDER BY deleted_at, id", w.since)
    .toArray() as unknown as FileRow[];
  const bursts: FileRow[][] = [];
  const open = new Map<string, FileRow[]>();
  for (const r of rows) {
    const by = text(r.deleted_by);
    const burst = open.get(by);
    const last = burst?.[burst.length - 1];
    if (burst && last && Date.parse(text(r.deleted_at)) - Date.parse(text(last.deleted_at)) < DELETES_SETTLE_MS) burst.push(r);
    else {
      const next = [r];
      bursts.push(next);
      open.set(by, next);
    }
  }
  const spans: Burst[] = bursts.map((b) => ({
    from: Date.parse(text(b[0]!.deleted_at)),
    at: Date.parse(text(b[b.length - 1]!.deleted_at)),
    // A burst that went on longer than HOLD_MAX_MS is answered as it stands.
    settled: Date.parse(text(b[b.length - 1]!.deleted_at)) <= w.through || now - Date.parse(text(b[0]!.deleted_at)) >= HOLD_MAX_MS,
  }));
  const end = windowEnd(spans, w.through);
  const found: { at: string; event: StoreEvent }[] = [];
  let settling = false;
  for (const [i, burst] of bursts.entries()) {
    const first = burst[0]!;
    const last = burst[burst.length - 1]!;
    if (!spans[i]!.settled || spans[i]!.at > end) {
      settling = true;
      continue;
    }
    const at = text(last.deleted_at);
    found.push({
      at,
      event: {
        kind: "deleted",
        // The first file and its time: a file a restore brought back and deleted again is a new event.
        key: `${first.id}@${text(first.deleted_at)}`,
        at,
        by: text(first.deleted_by),
        files: burst.slice(0, EVENT_FILES_MAX).map(fileOf),
        count: burst.length,
        folders: folderNamesOf(folders(), [...new Set(burst.map((f) => f.folder_id ?? ""))].filter(Boolean)),
      },
    });
  }
  return keep(found, end, null, settling);
}

/**
 * Jobs that ended, each with its summary and the run that made it. A job's end is in the store's
 * history (jobs/runner.ts writes a row as it ends a job, done or failed), read by its time's index:
 * `_jobs` keeps every job ever run, and an index on its time would cost a written row on every
 * update of a job's progress.
 */
function endedJobs(core: StoreCore, now: number, since: unknown, _folders: () => FolderMap): Kept {
  const w = windowOf(now, since, 0);
  const rows = core.sql
    .exec<{ id: string; params: string; by_sub: string; ended_at: string }>(
      `SELECT j.id, j.params, j.by_sub, max(h.at) AS ended_at FROM _history h JOIN _jobs j ON j.id = h.ref
       WHERE h.kind = 'job' AND h.at > ? AND h.at <= ? AND j.state IN ('done', 'failed')
       GROUP BY j.id ORDER BY ended_at, j.id LIMIT ?`,
      w.since,
      iso(w.through),
      EVENTS_MAX + 1,
    )
    .toArray();
  const found = rows.map((r) => {
    let runId: string | null = null;
    try {
      runId = runOfParams(JSON.parse(String(r.params)));
    } catch {
      // Parameters that do not read name no run.
    }
    const at = String(r.ended_at);
    return { at, event: { kind: "job", key: String(r.id), at, by: String(r.by_sub), runId, summary: readJobSummary(core, String(r.id)) } as StoreEvent };
  });
  return keep(found, w.through, null, false);
}

/** A person's fixes of one table on the Tables tab, once they settled. */
function settledFixes(core: StoreCore, now: number, since: unknown, _folders: () => FolderMap): Kept {
  const w = windowOf(now, since, FIXES_SETTLE_MS);
  const rows = core.sql
    .exec<{ change: number; tbl: string; version: number; changed: number; whole: number; at: string; by_sub: string | null }>(
      "SELECT change, tbl, version, changed, whole, at, by_sub FROM _deltas WHERE job IS NULL AND at > ? ORDER BY change",
      w.since,
    )
    .toArray();
  // One person's fixes of one table: two people's are two events, each by its person.
  const tables = new Map<string, typeof rows>();
  for (const r of rows) {
    const group = `${String(r.tbl)}\u0000${text(r.by_sub)}`;
    const list = tables.get(group);
    if (list) list.push(r);
    else tables.set(group, [r]);
  }
  const groups = [...tables];
  const spans: Burst[] = groups.map(([, fixes]) => ({
    from: Date.parse(String(fixes[0]!.at)),
    at: Date.parse(String(fixes[fixes.length - 1]!.at)),
    settled: Date.parse(String(fixes[fixes.length - 1]!.at)) <= w.through || now - Date.parse(String(fixes[0]!.at)) >= HOLD_MAX_MS,
  }));
  const end = windowEnd(spans, w.through);
  const found: { at: string; event: StoreEvent }[] = [];
  let settling = false;
  for (const [i, [group, fixes]] of groups.entries()) {
    const table = group.slice(0, group.indexOf("\u0000"));
    const last = fixes[fixes.length - 1]!;
    if (!spans[i]!.settled || spans[i]!.at > end) {
      settling = true;
      continue;
    }
    const rec = core.sql.exec<{ rows: number | null }>("SELECT rows FROM _tables WHERE name = ?", table).toArray()[0];
    const at = String(last.at);
    found.push({
      at,
      event: {
        kind: "fix",
        // The table and the last fix's time: a restore can give a change's number again.
        key: `${table}@${String(last.at)}:${text(last.by_sub)}`,
        at,
        by: text(last.by_sub),
        table,
        version: Number(last.version),
        rows: rec && rec.rows !== null ? Number(rec.rows) : null,
        fixes: fixes.length,
        // A change the store could not name row by row counts as one row.
        changed: fixes.reduce((n, f) => n + (Number(f.whole) === 1 ? 1 : Number(f.changed)), 0),
      },
    });
  }
  return keep(found, end, null, settling);
}

const READ: Readonly<Record<StoreEventStream, (core: StoreCore, now: number, since: unknown, folders: () => FolderMap) => Kept>> = {
  files: settledFiles,
  deleted: settledDeletes,
  jobs: endedJobs,
  fixes: settledFixes,
};

/**
 * What settled in each stream since the reader's times (`since`, by stream; a stream left out is
 * read from EVENTS_LOOKBACK_MS ago), oldest first within each stream. Pure reads.
 */
export function storeEvents(core: StoreCore, body: { since?: unknown }): StoreEvents {
  const now = core.deps.now();
  const since = body.since !== null && typeof body.since === "object" ? (body.since as Record<string, unknown>) : {};
  const events: StoreEvent[] = [];
  const through = {} as Record<StoreEventStream, string>;
  let settling = false;
  let map: FolderMap | null = null;
  const folders = (): FolderMap => (map ??= folderMap(core));
  for (const stream of STREAMS) {
    const kept = READ[stream](core, now, since[stream], folders);
    events.push(...kept.events);
    through[stream] = iso(kept.through);
    settling ||= kept.settling;
  }
  return { events, through, settling };
}
