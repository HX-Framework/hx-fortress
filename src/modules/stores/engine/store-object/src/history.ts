// A store's history and "Restore to Here".
//
// Every migration, table version, restore, job and file batch is an event in `_history`. A
// restore returns the store's database to an earlier moment with the object's point-in-time
// recovery (30 days): it names a bookmark for the moment, asks the platform to restore it when
// the object next starts, and the caller restarts the object.
//
// What a restore keeps: the history is a record of what happened, not data, so the events after
// the moment are carried across the restore, with the restore's own event, through a note in R2
// the object reads when it starts (`applyRestoreCarry`). Files are what arrived, so a restore
// keeps them as they are now: `_files` is rebuilt from the files' R2 objects, each of which
// carries its row in its metadata. Whether a file is deleted is the restored moment's answer: a
// file the moment knew keeps the mark it had then, so one deleted since comes back (its bytes stay
// 30 days, as far as a restore reaches, and the rows the restore brings back may name it). A file
// the moment did not know arrived after it, and stays as it is now. A Modern App's people are who
// may come in, not data: the user list and the sessions (`_users`, `_sessions`) cross a restore as
// they are now, so a restore never lets a removed person back in or wakes a session that ended.
// The rows written each day (write-limit.ts) are what the store spent, not data: they cross too,
// so a restore never gives a store back the writes it already made today. So does the note of when exports are next due to go: the exports
// stay in the bucket whatever moment the store returns to. A store's folders hold its files, so they
// cross as they are now too, with each file in the folder it is in now (folders.ts).

import { StoreError, type StoreCore } from "./core.js";
import type { History, HistoryEvent } from "./types.js";
import { deletedMarks } from "./files.js";
import { fileFoldersNow, folderRowsNow, restoreFolders } from "./folders.js";
import { adoptParkedFiles } from "./park.js";
import { getMeta, setMeta } from "./schema.js";
import type { SqlLike, StoreSqlValue } from "./sql.js";
import { isWriteKey, keepWriteCount, WRITE_COUNT_END, WRITE_COUNT_PREFIX } from "./write-limit.js";

/** The `_meta` key of when the store next looks for exports past their time (export.ts). */
export const EXPORTS_SWEEP_KEY = "exports_sweep_at";

/** How far back point-in-time recovery reaches. */
export const RESTORE_WINDOW_MS = 30 * 24 * 60 * 60_000;
/** The most events a history read answers. */
export const HISTORY_SHOWN = 500;

function eventOf(row: Record<string, unknown>): HistoryEvent {
  return {
    id: String(row.id),
    at: String(row.at),
    kind: String(row.kind) as HistoryEvent["kind"],
    by: String(row.by_sub),
    note: String(row.note),
    ...(row.restore_point ? { restorePoint: String(row.restore_point) } : {}),
  };
}

export function restorableFrom(core: StoreCore): string {
  const created = getMeta(core.sql, "created_at");
  const floor = core.deps.now() - RESTORE_WINDOW_MS;
  const createdMs = created ? Date.parse(created) : floor;
  return new Date(Math.max(floor, createdMs)).toISOString();
}

export function readHistory(core: StoreCore): History {
  const events = core.sql
    .exec<Record<string, StoreSqlValue>>(`SELECT * FROM _history ORDER BY at DESC, id DESC LIMIT ${HISTORY_SHOWN}`)
    .toArray()
    .map((r) => eventOf(r));
  return { events, restorableFrom: restorableFrom(core) };
}

/** What crosses a restore: the history after the moment, and the restore's own event. */
interface RestoreCarry {
  storeId: string;
  /** Names this restore: the store's mark holds it while the restore is under way. */
  token?: string;
  bookmark: string;
  history: Record<string, unknown>[];
  /** Every file deleted but kept now: the mark of each file the restored moment did not know. */
  deleted?: { id: string; deletedAt: string; deletedBy: string | null }[];
  /** A Modern App's user list and sessions as they were when the restore was asked for. */
  people?: { users: Record<string, unknown>[]; sessions: Record<string, unknown>[] };
  /** The daily write counts and the store's own write limit, as `_meta` held them then. */
  writes?: { key: string; value: string }[];
  /** When the store next looks for exports past their time, as `_meta` held it then. */
  exportsSweepAt?: string | null;
  /** The store's folders, live and deleted, as they were when the restore was asked for. */
  folders?: Record<string, unknown>[];
  /** Each file's folder then. */
  fileFolders?: { id: string; folderId: string }[];
}

/** Refuses a write while a restore is under way: the restore would drop it. */
export function refuseWhileRestoring(core: StoreCore): void {
  if (getMeta(core.sql, RESTORING_KEY) !== null) throw new StoreError(409, "store_restoring", "This store is returning to an earlier time. Try again in a moment.");
}

/**
 * Refuses a write of the store's data while a restore is under way, or while an export or an import
 * holds the store: an export's file would miss it, and an import would mix it into what it loads.
 * `exportMayPass` lets through a write no export's file depends on.
 */
export function refuseWhileHeld(core: StoreCore, opts: { exportMayPass?: boolean } = {}): void {
  refuseWhileRestoring(core);
  const held = heldBy(core.sql);
  if (held === "import") throw new StoreError(409, "store_busy", "This store is loading an import. Try again in a moment.");
  if (held === "export" && !opts.exportMayPass) throw new StoreError(409, "store_busy", "This store is writing its export. Try again in a moment.");
}

/**
 * The `_meta` key that marks an export or an import holding the store's writes: `{ job, what }`,
 * and `loading` once an import has begun to fill the store. It holds only while that job is open,
 * so a job that ended for any reason holds nothing.
 */
export const HOLD_KEY = "held";

interface Hold {
  job: string;
  what: "export" | "import";
  loading: boolean;
}

/** Takes the hold for a job. */
export function holdStore(sql: SqlLike, job: string, what: Hold["what"], loading = false): void {
  sql.exec("INSERT INTO _meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", HOLD_KEY, JSON.stringify({ job, what, loading } satisfies Hold));
}

function holdOf(sql: SqlLike): Hold | null {
  const text = getMeta(sql, HOLD_KEY);
  if (!text) return null;
  try {
    const hold = JSON.parse(text) as Partial<Hold>;
    return typeof hold.job === "string" && (hold.what === "export" || hold.what === "import") ? { job: hold.job, what: hold.what, loading: hold.loading === true } : null;
  } catch {
    return null;
  }
}

/** Whether this job is an import that had begun to fill the store: only then is there anything to undo. */
export function isLoading(sql: SqlLike, job: string): boolean {
  const hold = holdOf(sql);
  return hold?.job === job && hold.loading;
}

/** Lets go of the hold, if it is this job's. */
export function releaseHold(sql: SqlLike, job: string): void {
  if (holdOf(sql)?.job === job) sql.exec("DELETE FROM _meta WHERE key = ?", HOLD_KEY);
}

/** What holds the store's writes now: a restore, or an export or an import that is running. */
export function heldBy(sql: SqlLike): "restoring" | "export" | "import" | null {
  if (getMeta(sql, RESTORING_KEY) !== null) return "restoring";
  const hold = holdOf(sql);
  if (!hold) return null;
  const open = sql.exec("SELECT 1 FROM _jobs WHERE id = ? AND state IN ('queued', 'running')", hold.job).toArray().length > 0;
  return open ? hold.what : null;
}

/** The people tables a restore keeps as they are now. */
const PEOPLE_TABLES = ["_users", "_sessions"] as const;

/** Where a restore's carry waits for the object's next start: one key, read with one get. */
function carryKey(storeId: string): string {
  return `stores/${storeId}/restore.json`;
}

/**
 * The `_meta` key that marks a restore under way, holding its token. While it is set the store
 * takes no writes and runs no job (handler.ts): the restore would drop them. It lives only in the
 * database the restore leaves behind, so the restored database never has it.
 */
export const RESTORING_KEY = "restoring";

async function putCarry(core: StoreCore, storeId: string, carry: RestoreCarry): Promise<void> {
  await core.env.FILES.put(carryKey(storeId), JSON.stringify(carry), { httpMetadata: { contentType: "application/json" } });
}

const UNAVAILABLE = "This store's platform keeps no earlier moments to return to here.";

/** The platform's own words for having no point-in-time recovery (workerd under `wrangler dev`). */
function noPointInTime(error: unknown): boolean {
  return /point-in-time|not implement|not supported/i.test(error instanceof Error ? error.message : String(error));
}

/** Refuses a restore where the platform keeps no earlier moments; any other failure is the platform's own. */
async function requirePointInTime(core: StoreCore): Promise<void> {
  let mark: string;
  try {
    mark = await core.storage.getCurrentBookmark();
  } catch (error) {
    if (noPointInTime(error)) throw new StoreError(501, "restore_unavailable", UNAVAILABLE);
    throw error;
  }
  if (!mark || /^[0-]+$/.test(mark)) throw new StoreError(501, "restore_unavailable", UNAVAILABLE);
}

/**
 * A restore that was not set: its carry goes, then its mark, so no later start applies it. Should
 * the carry not go, the mark stays and the object starts again, so the next start drops both.
 */
async function abandonRestore(core: StoreCore, storeId: string): Promise<void> {
  try {
    await core.env.FILES.delete(carryKey(storeId));
  } catch {
    core.state.abort("restore abandoned");
    return;
  }
  core.sql.exec("DELETE FROM _meta WHERE key = ?", RESTORING_KEY);
}

/**
 * Restores the store's database to `at`: an ISO time within the window, or a restore point from
 * the history. Answers the bookmark it returns to. The caller restarts the object once it has
 * the answer (`restart`), which is when the platform restores.
 */
export async function restoreStore(core: StoreCore, storeId: string, actor: string, body: Record<string, unknown>): Promise<{ restoredTo: string; to: string; kept: string[] }> {
  const at = typeof body.at === "string" ? body.at.trim() : "";
  if (!at) throw new StoreError(400, "bad_request", "Name a time (ISO) or a restore point from the store's history.");
  // A restore always keeps the people tables as they are now; `keep` may say so, and nothing more.
  if (body.keep !== undefined && (!Array.isArray(body.keep) || body.keep.some((t) => !(PEOPLE_TABLES as readonly unknown[]).includes(t)))) {
    throw new StoreError(400, "bad_request", "A restore keeps _users and _sessions as they are now, and nothing else.");
  }
  // Without point-in-time recovery (workerd under `wrangler dev`) there is no earlier moment.
  await requirePointInTime(core);
  const from = Date.parse(restorableFrom(core));
  let bookmark: string;
  let since: string;
  const asTime = Date.parse(at);
  if (!Number.isNaN(asTime) && /^\d{4}-\d{2}-\d{2}T/.test(at)) {
    if (asTime < from || asTime > core.deps.now()) throw new StoreError(400, "bad_request", `A store can return to a moment from ${new Date(from).toISOString()} to now.`);
    since = new Date(asTime).toISOString();
    try {
      bookmark = await core.storage.getBookmarkForTime(asTime);
    } catch (error) {
      if (noPointInTime(error)) throw new StoreError(501, "restore_unavailable", UNAVAILABLE);
      throw new StoreError(400, "bad_request", `The store cannot return to ${since}: ${error instanceof Error ? error.message : "the platform has no moment there"}.`);
    }
  } else {
    const event = core.sql.exec<{ at: string }>("SELECT at FROM _history WHERE restore_point = ? ORDER BY at LIMIT 1", at).toArray()[0];
    if (!event) throw new StoreError(400, "bad_request", "That restore point is not in this store's history.");
    if (Date.parse(String(event.at)) < from) throw new StoreError(400, "bad_request", "That restore point is older than the store keeps.");
    bookmark = at;
    since = String(event.at);
  }
  const history: Record<string, unknown>[] = core.sql.exec<Record<string, StoreSqlValue>>("SELECT * FROM _history WHERE at >= ?", since).toArray();
  // Every file's mark goes along: the restored moment decides for the files it knew (rebuildFiles).
  // A file there at the moment and deleted since comes back; this counts those for the event.
  const marks = deletedMarks(core);
  const back = marks.filter((m) => m.deletedAt >= since && m.receivedAt < since).length;
  const note = `Restored to ${since}${back > 0 ? `; ${back} file${back === 1 ? "" : "s"} deleted since came back` : ""}`;
  const event: Record<string, unknown> = { id: core.newId("his"), at: core.nowIso(), kind: "restore", by_sub: actor, note, restore_point: null, ref: bookmark };
  // In this order, so a stop at any point leaves a store that is right: the mark, then the carry,
  // then the restore itself. At the next start a carry is applied only when its restore's mark is
  // not there, which is when the restore happened (applyRestoreCarry).
  const token = core.deps.randomHex(12);
  setMeta(core.sql, RESTORING_KEY, token);
  const people = {
    users: core.sql.exec<Record<string, StoreSqlValue>>("SELECT * FROM _users").toArray(),
    sessions: core.sql.exec<Record<string, StoreSqlValue>>("SELECT * FROM _sessions").toArray(),
  };
  const carry: RestoreCarry = {
    storeId,
    token,
    bookmark,
    history: [...history, event],
    deleted: marks,
    people,
    writes: carriedWrites(core),
    exportsSweepAt: getMeta(core.sql, EXPORTS_SWEEP_KEY),
    folders: folderRowsNow(core),
    fileFolders: fileFoldersNow(core),
  };
  try {
    await putCarry(core, storeId, carry);
    // The restore's own event can be undone: its restore point is the moment just before it.
    event.restore_point = await core.storage.onNextSessionRestoreBookmark(bookmark);
  } catch (error) {
    await abandonRestore(core, storeId);
    if (noPointInTime(error)) throw new StoreError(501, "restore_unavailable", UNAVAILABLE);
    throw error;
  }
  // Without this second write the restore still happens; its event only loses its undo point. Its
  // counts are read again, so rows a job wrote while this call waited are carried too.
  carry.writes = carriedWrites(core);
  await putCarry(core, storeId, carry).catch(() => undefined);
  return { restoredTo: bookmark, to: since, kept: [...PEOPLE_TABLES] };
}

/**
 * After a restart: brings across what a restore keeps, then rebuilds the file list from R2. Runs
 * before any call reaches the object (blockConcurrencyWhile).
 */
export async function applyRestoreCarry(core: StoreCore): Promise<void> {
  const storeId = core.storeId;
  const marked = getMeta(core.sql, RESTORING_KEY);
  if (storeId) await bringAcross(core, storeId, marked);
  // Last, once the carry is settled: a mark at start is never a restore under way any more.
  if (marked !== null) core.sql.exec("DELETE FROM _meta WHERE key = ?", RESTORING_KEY);
}

/** The carry of a restore that happened, applied; one whose restore did not happen, dropped. */
async function bringAcross(core: StoreCore, storeId: string, marked: string | null): Promise<void> {
  // An app on its own account may bind no bucket: with none, no restore can have been readied.
  if (!core.env.FILES) return;
  // A failure here ends the start, and the mark stays for the next one to decide again.
  const body = await core.env.FILES.get(carryKey(storeId));
  if (!body) return;
  const carry = (await body.json()) as RestoreCarry;
  // The mark of this very restore is still here: the database was not restored, so the history
  // it would bring across is already in it, and the restore's event would be untrue.
  if (marked === null || marked !== (carry.token ?? carry.bookmark)) {
    core.transaction(() => {
      for (const row of carry.history) {
        core.sql.exec(
          "INSERT INTO _history (id, at, kind, by_sub, note, restore_point, ref) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
          row.id,
          row.at,
          row.kind,
          row.by_sub,
          row.note,
          row.restore_point ?? null,
          row.ref ?? null,
        );
      }
      if (carry.people) restorePeople(core, carry.people);
      if (carry.writes) restoreWrites(core, carry.writes);
      if (carry.exportsSweepAt) core.sql.exec("INSERT INTO _meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = min(value, excluded.value)", EXPORTS_SWEEP_KEY, carry.exportsSweepAt);
    });
    await rebuildFiles(core, storeId, carry.deleted ?? []);
    // The folders as they are now, and each file in the folder it is in now. A file nobody can
    // place goes into Uploads at the start that follows (handler.ts, `fileUnfiled`).
    core.transaction(() => restoreFolders(core, carry.folders ?? [], carry.fileFolders ?? []));
    // Parked tables' files the restored database does not name go after the restore window.
    await adoptParkedFiles(core, storeId);
    if (carry.exportsSweepAt) await core.wakeAt(Date.parse(carry.exportsSweepAt));
  }
  await core.env.FILES.delete(carryKey(storeId));
}

/** The day counts as `_meta` holds them now, every count kept first. */
function carriedWrites(core: StoreCore): { key: string; value: string }[] {
  keepWriteCount(core, { force: true });
  return core.sql
    .exec<{ key: string; value: string }>("SELECT key, value FROM _meta WHERE key >= ? AND key < ?", WRITE_COUNT_PREFIX, WRITE_COUNT_END)
    .toArray()
    .map((r) => ({ key: String(r.key), value: String(r.value) }));
}

/** The write counts as they were when the restore was asked for: a day's count only grows. */
function restoreWrites(core: StoreCore, writes: NonNullable<RestoreCarry["writes"]>): void {
  for (const { key, value } of writes) {
    if (!isWriteKey(key)) continue;
    core.sql.exec(
      "INSERT INTO _meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = CAST(max(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)",
      key,
      value,
    );
  }
}

/** The user list and sessions as they were before the restore: rows of the columns each table has now. */
function restorePeople(core: StoreCore, people: NonNullable<RestoreCarry["people"]>): void {
  for (const table of PEOPLE_TABLES) {
    const rows = table === "_users" ? people.users : people.sessions;
    const columns = core.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info(?)", table).toArray().map((c) => String(c.name));
    core.sql.exec(`DELETE FROM ${table}`);
    for (const row of rows) {
      const names = columns.filter((c) => c in row);
      if (names.length === 0) continue;
      core.sql.exec(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`, ...names.map((c) => row[c] ?? null));
    }
  }
}

/**
 * `_files` from the files' own R2 objects: what is there now, whatever the restored rows said. A
 * file the restored rows name keeps the mark they gave it (so undoing a restore finds a file
 * deleted again as it was); a file they do not name arrived after the moment and keeps today's.
 */
async function rebuildFiles(core: StoreCore, storeId: string, deleted: { id: string; deletedAt: string; deletedBy: string | null }[]): Promise<void> {
  const prefix = `stores/${storeId}/files/`;
  const found: { key: string; meta: Record<string, string>; size: number; type: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await core.env.FILES.list({ prefix, cursor, include: ["customMetadata", "httpMetadata"] });
    for (const o of page.objects) found.push({ key: o.key, meta: o.customMetadata ?? {}, size: o.size, type: o.httpMetadata?.contentType ?? "application/octet-stream" });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  core.transaction(() => {
    const restored = new Map(
      core.sql
        .exec<{ id: string; deleted_at: string | null; deleted_by: string | null; folder_id: string | null }>("SELECT id, deleted_at, deleted_by, folder_id FROM _files WHERE state = 'ready'")
        .toArray()
        .map((r) => [
          String(r.id),
          { deletedAt: r.deleted_at === null ? null : String(r.deleted_at), deletedBy: r.deleted_by === null ? null : String(r.deleted_by), folderId: r.folder_id === null ? null : String(r.folder_id) },
        ]),
    );
    const today = new Map(deleted.map((m) => [m.id, m]));
    // Uploads in progress keep their rows; every ready file is what R2 holds.
    core.sql.exec("DELETE FROM _files WHERE state = 'ready'");
    for (const f of found) {
      const id = f.meta.fileId;
      if (!id) continue;
      // Its folder: the restored moment's, else the one it arrived in; the carry then puts it where it is now.
      core.sql.exec(
        // Its arrival as its record knows it: a file that arrived just before the restore, and that
        // the store had not answered as arrived yet (events.ts), is answered after it.
        `INSERT INTO _files (id, name, size, content_type, sha256, state, received_at, received_by, via, batch, r2_key, upload_id, folder_id, ready_at)
         VALUES (?, ?, ?, ?, NULL, 'ready', ?, ?, ?, ?, ?, NULL, ?, ?5)
         ON CONFLICT (id) DO UPDATE SET state = 'ready', size = excluded.size, upload_id = NULL`,
        id,
        f.meta.name ?? f.key.split("/").pop() ?? id,
        f.size,
        f.type,
        f.meta.receivedAt ?? core.nowIso(),
        f.meta.receivedBy ?? "user:unknown",
        f.meta.via ?? "api",
        f.meta.batch ?? null,
        f.key,
        restored.get(id)?.folderId ?? f.meta.folderId ?? null,
      );
      const mark = restored.get(id) ?? today.get(id) ?? null;
      if (mark?.deletedAt) core.sql.exec("UPDATE _files SET deleted_at = ?, deleted_by = ? WHERE id = ?", mark.deletedAt, mark.deletedBy, id);
    }
  });
}
