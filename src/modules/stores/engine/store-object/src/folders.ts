// A store's folders. Every file of a store is in exactly one folder: no file is kept at the store's
// root (Denis, 2026-11-18), because a folder is what a permission attaches to. The first one is
// here: a caller's token may name a folder (`StoreCaller.folder`), and its uploads, its moves and
// its changes to folders then reach that folder and the folders inside it, and nothing else.
//
//   _folders  a folder: its name, the folder it is in (none at the top), and what it was made for
//             (`ref`): "uploads", the store's own, or what its maker names ("sender:<id>",
//             "link:<id>", "sample:<id>"). A ref finds the folder again after a person renames it.
//   _files    `folder_id`, the folder a file is in. Once the store has started it is never null and
//             never a deleted folder: `fileUnfiled` puts such a file into Uploads, at every start,
//             after a restore and after an import, and an upload that names no folder goes there.
//
// A folder holds names only. Moving a file or a folder changes rows: no byte in the bucket moves,
// and a file's key keeps its id. Deleting a folder never deletes a file: a folder that holds files
// goes only with a folder named for them, and the folders inside it go with it.

import { StoreError, type StoreCore } from "./core.js";
import { getMeta } from "./schema.js";
import type { SqlLike } from "./sql.js";
import {
  FOLDER_DEPTH_MAX,
  FOLDER_MOVE_MAX,
  FOLDER_NAME_MAX,
  FOLDERS_MAX,
  STATS_FOLDERS,
  UPLOADS_NAME,
  UPLOADS_REF,
  type StatsFolder,
  type StoreCaller,
  type StoredFolder,
} from "./types.js";

/** A folder's id as the store makes it. */
export const FOLDER_ID_RE = /^fld_[0-9a-f]{24}$/;
/** A file's id as the store makes it. */
const FILE_ID_RE = /^fil_[0-9a-f]{24}$/;
/** What a folder was made for: a word, then `:` and its maker's id for it. */
const REF_RE = /^[a-z][a-z0-9-]{0,31}(?::[A-Za-z0-9_.:-]{1,160})?$/;

/** Who files what nobody filed: the store itself, at a start, a restore or an import. */
export const FILING_ACTOR = "store:folders";

/**
 * What filing files needs: the store's SQL, the time and new ids. A store's core is one; an
 * import's job makes one from its context, since it files what it brought in its own commit.
 */
export interface FolderSql {
  readonly sql: SqlLike;
  nowIso(): string;
  newId(prefix: "fld" | "his"): string;
}

export type FolderRefusalCode = "bad_request" | "folder_not_found" | "folder_name_taken" | "folder_place" | "folder_not_empty" | "folder_outside" | "folders_full";

export class StoreFolderError extends StoreError {
  constructor(status: number, code: FolderRefusalCode, message: string) {
    super(status, code, message);
    this.name = "StoreFolderError";
  }
}

interface FolderRow {
  id: string;
  name: string;
  parent_id: string | null;
  ref: string | null;
  created_at: string;
  created_by: string;
}

/** The live folders, by id, as the rules read them. */
type Tree = Map<string, FolderRow>;

function liveTree(core: FolderSql): Tree {
  const rows = core.sql
    .exec<Record<string, string | null>>("SELECT id, name, parent_id, ref, created_at, created_by FROM _folders WHERE deleted_at IS NULL")
    .toArray()
    .map((r) => ({
      id: String(r.id),
      name: String(r.name),
      parent_id: r.parent_id === null ? null : String(r.parent_id),
      ref: r.ref === null ? null : String(r.ref),
      created_at: String(r.created_at),
      created_by: String(r.created_by),
    }));
  return new Map(rows.map((r) => [r.id, r]));
}

/** The chain from a folder up to the top, the folder first. A loop (only a hand-made row could
 *  make one) ends the chain where it repeats. Pure. */
function chainOf(tree: Tree, id: string): FolderRow[] {
  const out: FolderRow[] = [];
  const seen = new Set<string>();
  let at = tree.get(id);
  while (at && !seen.has(at.id)) {
    out.push(at);
    seen.add(at.id);
    at = at.parent_id === null ? undefined : tree.get(at.parent_id);
  }
  return out;
}

/** A folder's level: 1 at the top. Pure. */
export function depthOf(tree: Tree, id: string): number {
  return chainOf(tree, id).length;
}

/** Whether `id` is `scope` or a folder inside it. Pure. */
export function within(tree: Tree, id: string, scope: string): boolean {
  return chainOf(tree, id).some((f) => f.id === scope);
}

/** A folder and every folder inside it. Pure. */
export function subtreeOf(tree: Tree, id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) {
    for (const f of tree.values()) if (f.parent_id === out[i] && !out.includes(f.id)) out.push(f.id);
  }
  return out;
}

/** How many levels a folder and the folders inside it take: 1 for a folder with none. Pure. */
function heightOf(tree: Tree, id: string, seen: Set<string> = new Set()): number {
  seen.add(id);
  let most = 1;
  for (const f of tree.values()) if (f.parent_id === id && !seen.has(f.id)) most = Math.max(most, 1 + heightOf(tree, f.id, seen));
  return most;
}

const sameName = (a: string, b: string): boolean => a.toLocaleLowerCase("en-US") === b.toLocaleLowerCase("en-US");

/** The folder beside `parentId` named `name` in any case, other than `except`. Pure. */
function sibling(tree: Tree, parentId: string | null, name: string, except: string | null): FolderRow | undefined {
  for (const f of tree.values()) if (f.id !== except && f.parent_id === parentId && sameName(f.name, name)) return f;
  return undefined;
}

/** A folder's name as the store keeps it: one line, no control characters, 1 to FOLDER_NAME_MAX characters. */
export function cleanFolderName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  if (!name || name === "." || name === "..") throw new StoreFolderError(400, "bad_request", "A folder needs a name.");
  if (name.length > FOLDER_NAME_MAX) throw new StoreFolderError(400, "bad_request", `A folder's name is at most ${FOLDER_NAME_MAX} characters.`);
  return name;
}

function folderIdOf(raw: unknown, what: string): string {
  if (typeof raw !== "string" || !FOLDER_ID_RE.test(raw)) throw new StoreFolderError(400, "bad_request", `${what} is a folder's id (fld_ and 24 hex digits).`);
  return raw;
}

function liveFolder(tree: Tree, id: string): FolderRow {
  const folder = tree.get(id);
  if (!folder) throw new StoreFolderError(404, "folder_not_found", "This store has no such folder.");
  return folder;
}

/**
 * The folder a caller's token holds it to, or null for a caller held to none. A token whose folder
 * was deleted reaches nothing: its holder asks for a token again, and gets the folder made again.
 */
function scopeOf(tree: Tree, caller: StoreCaller): string | null {
  if (caller.folder === undefined || caller.folder === null) return null;
  if (!tree.has(caller.folder)) throw new StoreFolderError(403, "folder_outside", "The folder this token was for is gone.");
  return caller.folder;
}

/** Refuses a folder outside the caller's own. `root` says whether the caller's own folder itself is allowed. */
function requireWithin(tree: Tree, scope: string | null, id: string | null, root: boolean): void {
  if (scope === null) return;
  if (id === null) throw new StoreFolderError(403, "folder_outside", "This token reaches only its own folder and the folders inside it.");
  if (!within(tree, id, scope) || (!root && id === scope)) {
    throw new StoreFolderError(403, "folder_outside", root ? "This token reaches only its own folder and the folders inside it." : "This token may change only the folders inside its own folder.");
  }
}

/** The name beside `parentId` that no folder has yet: `name`, else `name (2)`, `name (3)`... Pure. */
function freeName(tree: Tree, parentId: string | null, name: string): string {
  if (!sibling(tree, parentId, name, null)) return name;
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const candidate = `${name.slice(0, FOLDER_NAME_MAX - suffix.length)}${suffix}`;
    if (!sibling(tree, parentId, candidate, null)) return candidate;
  }
}

function insertFolder(core: FolderSql, row: { name: string; parentId: string | null; ref: string | null; by: string }): string {
  const id = core.newId("fld");
  const at = core.nowIso();
  core.sql.exec(
    "INSERT INTO _folders (id, name, parent_id, ref, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    id,
    row.name,
    row.parentId,
    row.ref,
    at,
    row.by,
    at,
  );
  return id;
}

/** The live folders with their counts, by name. */
export function listFolders(core: StoreCore): StoredFolder[] {
  return core.sql
    .exec<Record<string, string | number | null>>(
      `SELECT f.id, f.name, f.parent_id, f.ref, f.created_at, f.created_by, coalesce(c.n, 0) AS files, coalesce(c.bytes, 0) AS bytes
       FROM _folders f
       LEFT JOIN (SELECT folder_id, count(*) AS n, sum(size) AS bytes FROM _files WHERE state = 'ready' AND deleted_at IS NULL GROUP BY folder_id) c ON c.folder_id = f.id
       WHERE f.deleted_at IS NULL
       ORDER BY lower(f.name), f.id`,
    )
    .toArray()
    .map((r) => ({
      id: String(r.id),
      name: String(r.name),
      parentId: r.parent_id === null ? null : String(r.parent_id),
      ref: r.ref === null ? null : String(r.ref),
      createdAt: String(r.created_at),
      createdBy: String(r.created_by),
      files: Number(r.files),
      bytes: Number(r.bytes),
    }));
}

/** The folders at the top, by name, each with the files in it and in the folders inside it: what a store's stats carry. */
export function topFolders(core: StoreCore): StatsFolder[] {
  const folders = listFolders(core);
  const parentOf = new Map(folders.map((f) => [f.id, f.parentId]));
  const topOf = (id: string): string => {
    const seen = new Set<string>();
    let at = id;
    for (let up = parentOf.get(at); up !== null && up !== undefined && !seen.has(up); up = parentOf.get(at)) {
      seen.add(at);
      at = up;
    }
    return at;
  };
  const totals = new Map<string, { files: number; bytes: number }>();
  for (const f of folders) {
    const top = topOf(f.id);
    const t = totals.get(top) ?? { files: 0, bytes: 0 };
    t.files += f.files;
    t.bytes += f.bytes;
    totals.set(top, t);
  }
  return folders
    .filter((f) => f.parentId === null || !parentOf.has(f.parentId))
    .slice(0, STATS_FOLDERS)
    .map((f) => ({ id: f.id, name: f.name, files: totals.get(f.id)?.files ?? 0, bytes: totals.get(f.id)?.bytes ?? 0 }));
}

function wireOf(core: StoreCore, id: string): StoredFolder {
  const folder = listFolders(core).find((f) => f.id === id);
  if (!folder) throw new StoreFolderError(404, "folder_not_found", "This store has no such folder.");
  return folder;
}

/**
 * The store's Uploads folder, made when there is none: the live folder whose ref is "uploads", else
 * a folder at the top named Uploads that was made for nothing (it becomes the store's), else a new
 * one. Runs inside the caller's transaction.
 */
export function uploadsFolder(core: FolderSql, by: string): string {
  const tree = liveTree(core);
  for (const f of tree.values()) if (f.ref === UPLOADS_REF) return f.id;
  const named = sibling(tree, null, UPLOADS_NAME, null);
  if (named && named.ref === null) {
    core.sql.exec("UPDATE _folders SET ref = ?, updated_at = ? WHERE id = ?", UPLOADS_REF, core.nowIso(), named.id);
    return named.id;
  }
  return insertFolder(core, { name: freeName(tree, null, UPLOADS_NAME), parentId: null, ref: UPLOADS_REF, by });
}

/**
 * The folder an upload goes into: the one it names, which must be within the caller's own; else
 * the caller's own; else the store's Uploads.
 */
export function uploadFolderFor(core: StoreCore, caller: StoreCaller, asked: unknown): string {
  const tree = liveTree(core);
  const scope = scopeOf(tree, caller);
  if (asked !== undefined && asked !== null) {
    const id = folderIdOf(asked, "An upload's folder");
    liveFolder(tree, id);
    requireWithin(tree, scope, id, true);
    return id;
  }
  return scope ?? uploadsFolder(core, caller.actor);
}

function historyNote(core: FolderSql, by: string, note: string, ref: string | null): void {
  core.sql.exec("INSERT INTO _history (id, at, kind, by_sub, note, restore_point, ref) VALUES (?, ?, 'files', ?, ?, NULL, ?)", core.newId("his"), core.nowIso(), by, note, ref);
}

/**
 * Puts every file in no folder, or in a folder that is gone, into Uploads, in one statement, and
 * says so once in the history. Cheap when there is none: one indexed look. The caller holds the
 * transaction. Answers how many it filed.
 */
export function fileUnfiled(core: FolderSql): number {
  if (getMeta(core.sql, "destroyed_at")) return 0;
  const loose = "deleted_at IS NULL AND (folder_id IS NULL OR folder_id NOT IN (SELECT id FROM _folders WHERE deleted_at IS NULL))";
  const n = Number(core.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM _files WHERE ${loose}`).one().n);
  if (n === 0) return 0;
  const uploads = uploadsFolder(core, FILING_ACTOR);
  core.sql.exec(`UPDATE _files SET folder_id = ? WHERE ${loose}`, uploads);
  const name = String(core.sql.exec<{ name: string }>("SELECT name FROM _folders WHERE id = ?", uploads).one().name);
  historyNote(core, FILING_ACTOR, `Put ${n} file${n === 1 ? "" : "s"} that ${n === 1 ? "was" : "were"} in no folder into ${name}`, uploads);
  return n;
}

/**
 * After an import: one folder for each ref (the store's Uploads, made for the archive it was sent,
 * and the one the import brought), the others' files and folders moved into the one that holds the
 * most files; every file in a folder; and an Uploads that holds nothing goes, to be made again
 * when an upload needs it. The caller holds the transaction.
 */
export function settleFolders(core: FolderSql): void {
  const at = core.nowIso();
  const twice = core.sql
    .exec<{ ref: string }>("SELECT ref FROM _folders WHERE deleted_at IS NULL AND ref IS NOT NULL GROUP BY ref HAVING count(*) > 1")
    .toArray()
    .map((r) => String(r.ref));
  for (const ref of twice) {
    const ranked = core.sql
      .exec<{ id: string }>(
        `SELECT f.id FROM _folders f WHERE f.deleted_at IS NULL AND f.ref = ?
         ORDER BY (SELECT count(*) FROM _files x WHERE x.folder_id = f.id AND x.deleted_at IS NULL) DESC, f.created_at, f.id`,
        ref,
      )
      .toArray()
      .map((r) => String(r.id));
    const [kept, ...others] = ranked;
    for (const other of others) {
      core.sql.exec("UPDATE _files SET folder_id = ? WHERE folder_id = ? AND deleted_at IS NULL", kept!, other);
      core.sql.exec("UPDATE _folders SET parent_id = ?, updated_at = ? WHERE parent_id = ? AND deleted_at IS NULL", kept!, at, other);
      core.sql.exec("UPDATE _folders SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ?", at, FILING_ACTOR, at, other);
    }
  }
  fileUnfiled(core);
  core.sql.exec(
    `UPDATE _folders SET deleted_at = ?, deleted_by = ?, updated_at = ?
     WHERE deleted_at IS NULL AND ref = ?
       AND NOT EXISTS (SELECT 1 FROM _files x WHERE x.folder_id = _folders.id AND x.deleted_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM _folders c WHERE c.parent_id = _folders.id AND c.deleted_at IS NULL)`,
    at,
    FILING_ACTOR,
    at,
    UPLOADS_REF,
  );
}

/**
 * A new folder: `name`, at the top or in `parentId`. A caller held to a folder makes folders only
 * inside it. With `ref`, a folder already made for it answers instead (`made: false`), and a name
 * taken beside it gets " (2)": only a caller held to no folder gives a ref.
 */
export function makeFolder(core: StoreCore, caller: StoreCaller, body: Record<string, unknown>): { folder: StoredFolder; made: boolean } {
  const name = cleanFolderName(body.name);
  const parentId = body.parentId === undefined || body.parentId === null ? null : folderIdOf(body.parentId, "A folder's place");
  const ref = body.ref === undefined || body.ref === null ? null : body.ref;
  if (ref !== null && (typeof ref !== "string" || !REF_RE.test(ref))) throw new StoreFolderError(400, "bad_request", "A folder's ref is a word, then : and an id.");
  return core.transaction(() => {
    const tree = liveTree(core);
    const scope = scopeOf(tree, caller);
    if (ref !== null) {
      if (scope !== null) throw new StoreFolderError(403, "folder_outside", "This token may not make a folder for something.");
      for (const f of tree.values()) if (f.ref === ref) return { folder: wireOf(core, f.id), made: false };
    }
    if (parentId !== null) liveFolder(tree, parentId);
    requireWithin(tree, scope, parentId, true);
    if (tree.size >= FOLDERS_MAX) throw new StoreFolderError(409, "folders_full", `This store has ${FOLDERS_MAX} folders, the most it keeps. Delete one first.`);
    if (parentId !== null && depthOf(tree, parentId) >= FOLDER_DEPTH_MAX) {
      throw new StoreFolderError(400, "folder_place", `Folders go ${FOLDER_DEPTH_MAX} levels deep, and this one would be deeper.`);
    }
    let kept = name;
    const clash = sibling(tree, parentId, name, null);
    if (clash) {
      if (ref === null) throw new StoreFolderError(409, "folder_name_taken", `There is a folder named ${clash.name} there already.`);
      kept = freeName(tree, parentId, name);
    }
    const id = insertFolder(core, { name: kept, parentId, ref, by: caller.actor });
    core.history({ kind: "files", by: caller.actor, note: `Made the folder ${kept}`, ref: id });
    return { folder: wireOf(core, id), made: true };
  });
}

/** A folder's new name, its new place, or both. A caller held to a folder changes only the folders inside it. */
export function changeFolder(core: StoreCore, caller: StoreCaller, folderId: string, body: Record<string, unknown>): { folder: StoredFolder } {
  const id = folderIdOf(folderId, "The folder");
  const name = body.name === undefined ? undefined : cleanFolderName(body.name);
  const moves = body.parentId !== undefined;
  const parentId = !moves || body.parentId === null ? null : folderIdOf(body.parentId, "A folder's place");
  if (name === undefined && !moves) throw new StoreFolderError(400, "bad_request", "Give the folder a new name, a new place, or both.");
  return core.transaction(() => {
    const tree = liveTree(core);
    const scope = scopeOf(tree, caller);
    const was = liveFolder(tree, id);
    requireWithin(tree, scope, id, false);
    const place = moves ? parentId : was.parent_id;
    if (moves && place !== was.parent_id) {
      if (place !== null) {
        liveFolder(tree, place);
        if (subtreeOf(tree, id).includes(place)) throw new StoreFolderError(400, "folder_place", "A folder cannot go into itself or a folder inside it.");
        if (depthOf(tree, place) + heightOf(tree, id) > FOLDER_DEPTH_MAX) {
          throw new StoreFolderError(400, "folder_place", `Folders go ${FOLDER_DEPTH_MAX} levels deep, and these would be deeper.`);
        }
      }
      requireWithin(tree, scope, place, true);
    }
    const kept = name ?? was.name;
    const clash = sibling(tree, place, kept, id);
    if (clash) throw new StoreFolderError(409, "folder_name_taken", `There is a folder named ${clash.name} there already.`);
    if (kept === was.name && place === was.parent_id) return { folder: wireOf(core, id) };
    core.sql.exec("UPDATE _folders SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?", kept, place, core.nowIso(), id);
    const where = place === null ? "the top" : (tree.get(place)?.name ?? "a folder");
    const note =
      kept !== was.name && place !== was.parent_id
        ? `Renamed the folder ${was.name} to ${kept} and moved it to ${where}`
        : kept !== was.name
          ? `Renamed the folder ${was.name} to ${kept}`
          : `Moved the folder ${kept} to ${where}`;
    core.history({ kind: "files", by: caller.actor, note, ref: id });
    return { folder: wireOf(core, id) };
  });
}

/**
 * Deletes a folder and the folders inside it. Their files, if any, go into `into`, a live folder
 * outside the ones that go: a folder that holds files is never deleted without a place for them.
 * Answers the folders deleted and how many files moved.
 */
export function deleteFolder(core: StoreCore, caller: StoreCaller, folderId: string, body: Record<string, unknown>): { deleted: string[]; moved: number; into: string | null } {
  const id = folderIdOf(folderId, "The folder");
  const into = body.into === undefined || body.into === null ? null : folderIdOf(body.into, "Where its files go");
  return core.transaction(() => {
    const tree = liveTree(core);
    const scope = scopeOf(tree, caller);
    const folder = liveFolder(tree, id);
    requireWithin(tree, scope, id, false);
    const going = subtreeOf(tree, id);
    const holders = going.map(() => "?").join(", ");
    const held = Number(core.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM _files WHERE deleted_at IS NULL AND folder_id IN (${holders})`, ...going).one().n);
    if (held > 0) {
      if (into === null) throw new StoreFolderError(409, "folder_not_empty", `${folder.name} holds ${held} file${held === 1 ? "" : "s"}. Name the folder they go to.`);
      liveFolder(tree, into);
      if (going.includes(into)) throw new StoreFolderError(400, "folder_place", "Its files cannot go into a folder that goes with it.");
      requireWithin(tree, scope, into, true);
      core.sql.exec(`UPDATE _files SET folder_id = ? WHERE deleted_at IS NULL AND folder_id IN (${holders})`, into, ...going);
    }
    const at = core.nowIso();
    core.sql.exec(`UPDATE _folders SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE deleted_at IS NULL AND id IN (${holders})`, at, caller.actor, at, ...going);
    const inside = going.length - 1;
    const parts = [`Deleted the folder ${folder.name}`];
    if (inside > 0) parts.push(`and the ${inside} folder${inside === 1 ? "" : "s"} inside it`);
    const moved = held > 0 && into !== null ? `; ${held} file${held === 1 ? "" : "s"} went to ${tree.get(into)!.name}` : "";
    core.history({ kind: "files", by: caller.actor, note: `${parts.join(" ")}${moved}`, ref: id });
    return { deleted: going, moved: held, into: held > 0 ? into : null };
  });
}

/**
 * Moves files into a folder. A caller held to a folder moves only files within it, into a folder
 * within it. A file that is deleted, or another's, is left alone without an error. Answers the
 * files that moved.
 */
export function moveFiles(core: StoreCore, caller: StoreCaller, body: Record<string, unknown>): { fileIds: string[]; folderId: string } {
  const folderId = folderIdOf(body.folderId, "Where the files go");
  const ids = body.fileIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > FOLDER_MOVE_MAX || ids.some((f) => typeof f !== "string" || !FILE_ID_RE.test(f))) {
    throw new StoreFolderError(400, "bad_request", `Name 1 to ${FOLDER_MOVE_MAX} files by their ids (fil_ and 24 hex digits).`);
  }
  const fileIds = [...new Set(ids as string[])];
  return core.transaction(() => {
    const tree = liveTree(core);
    const scope = scopeOf(tree, caller);
    const target = liveFolder(tree, folderId);
    requireWithin(tree, scope, folderId, true);
    const holders = fileIds.map(() => "?").join(", ");
    const found = core.sql
      .exec<{ id: string; folder_id: string | null }>(`SELECT id, folder_id FROM _files WHERE deleted_at IS NULL AND id IN (${holders})`, ...fileIds)
      .toArray()
      .filter((f) => String(f.folder_id ?? "") !== folderId && (scope === null || (f.folder_id !== null && within(tree, String(f.folder_id), scope))))
      .map((f) => String(f.id));
    if (found.length === 0) return { fileIds: [], folderId };
    core.sql.exec(`UPDATE _files SET folder_id = ? WHERE id IN (${found.map(() => "?").join(", ")})`, folderId, ...found);
    core.history({ kind: "files", by: caller.actor, note: `Moved ${found.length} file${found.length === 1 ? "" : "s"} to ${target.name}`, ref: folderId });
    return { fileIds: found, folderId };
  });
}

/**
 * Refuses a caller held to a folder a file outside it: its parts and its completion are the upload's
 * own, and an upload is held to the token's folder as its first call was.
 */
export function requireFileWithin(core: StoreCore, caller: StoreCaller, folderId: string | null): void {
  if (caller.folder === undefined || caller.folder === null) return;
  const tree = liveTree(core);
  const scope = scopeOf(tree, caller);
  if (folderId === null || scope === null || !within(tree, folderId, scope)) {
    throw new StoreFolderError(403, "folder_outside", "This token reaches only its own folder and the folders inside it.");
  }
}

/** Today's folders, live and deleted, for a restore's carry (history.ts). */
export function folderRowsNow(core: StoreCore): Record<string, string | null>[] {
  return core.sql.exec<Record<string, string | null>>("SELECT * FROM _folders").toArray();
}

/** Each file's folder now, for a restore's carry: a restore keeps files where they are now. */
export function fileFoldersNow(core: StoreCore): { id: string; folderId: string }[] {
  return core.sql
    .exec<{ id: string; folder_id: string }>("SELECT id, folder_id FROM _files WHERE folder_id IS NOT NULL")
    .toArray()
    .map((r) => ({ id: String(r.id), folderId: String(r.folder_id) }));
}

/**
 * After a restore: today's folders over the restored ones (a folder the restored moment did not
 * know comes back, and one it knew takes today's name, place and mark), then each file in the
 * folder it is in today. A file today's carry does not name keeps the restored moment's folder.
 */
export function restoreFolders(core: StoreCore, rows: readonly Record<string, unknown>[], files: readonly { id: string; folderId: string }[]): void {
  const columns = new Set(core.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('_folders')").toArray().map((c) => String(c.name)));
  for (const row of rows) {
    const names = Object.keys(row).filter((c) => columns.has(c));
    if (!names.includes("id")) continue;
    core.sql.exec(`INSERT OR REPLACE INTO _folders (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`, ...names.map((c) => (row[c] ?? null) as string | null));
  }
  for (const f of files) core.sql.exec("UPDATE _files SET folder_id = ? WHERE id = ? AND folder_id IS NOT ?", f.folderId, f.id, f.folderId);
}
