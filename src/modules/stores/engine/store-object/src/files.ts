// A store's files: everything that arrived, kept in R2 under `stores/<storeId>/files/<fileId>/<name>`
// with who sent it and how, before any program reads it. Every file is in one of the store's
// folders (folders.ts): the one its upload names, else the caller's token's own, else Uploads. An upload goes up in parts
// (FILE_PART_BYTES each but the last) as an R2 multipart upload: the store makes the upload
// and its row, the gateway streams each part straight into R2, and the store completes it. A file
// is served only through the gateway, never by a public address.
//
// Each file's R2 object carries its row in its custom metadata, so a restore of the store's
// tables to an earlier time keeps its files as they are now (restore.ts rebuilds `_files`).
//
// A store keeps a file of any kind, whether or not LOAD reads it. The one kind it refuses is a
// program from a guest (store-readers programs.ts): someone outside the organization uploads it,
// and whoever downloads it later could run it by opening it. A zip from a guest is read once its
// bytes arrive: one with a program in it goes, because the program in it is the trouble, and the
// words say so.

import { isProgramFile, isZipFile, programsInZip } from "../../store-readers/src/programs.js";
import type { ByteSource } from "../../store-readers/src/source.js";
import { zipEntries } from "../../store-readers/src/zip.js";
import { StoreError, type StoreCore } from "./core.js";
import { requireFileWithin, uploadFolderFor } from "./folders.js";
import { dropReadOut } from "./jobs/read.js";
import { FILE_NAME_MAX, FILE_PART_BYTES, FILE_PARTS_MAX, type FileVia, type StoreCaller, type StoredFile } from "./types.js";
import type { StoreSqlValue } from "./sql.js";
import type { StoreFileObject } from "./store-files.js";

/** An upload that never completed is dropped after this long. */
export const UPLOAD_ABANDONED_MS = 7 * 24 * 60 * 60_000;
/** A deleted file's bytes stay this long, its record marked deleted, before they go for good. */
export const FILE_KEEP_DELETED_MS = 30 * 24 * 60 * 60_000;
/** The largest file a store takes: its most parts, each a full part. */
export const FILE_MAX_BYTES = FILE_PART_BYTES * FILE_PARTS_MAX;

export class StoreFileError extends StoreError {
  constructor(status: number, code: "bad_request" | "file_not_found" | "file_not_ready" | "too_large", message: string) {
    super(status, code, message);
    this.name = "StoreFileError";
  }
}

const VIA: readonly FileVia[] = ["page", "link", "run", "api"];

/** A file's name as the store keeps it: no folders, no control characters, at most 255 characters. */
export function cleanFileName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\\/]+/g, "_").trim() : "";
  if (!name || name === "." || name === "..") throw new StoreFileError(400, "bad_request", "A file needs a name.");
  return name.slice(0, FILE_NAME_MAX);
}

/** How a file arrives, as the caller allows: a guest uploads (`link`, the word upload links left), a run as itself. Nothing
 *  arrives by email: an email may only carry a link to the page. */
function viaFor(actor: string, asked: unknown): FileVia {
  const kind = actor.split(":")[0];
  const allowed: readonly FileVia[] = kind === "guest" ? ["link"] : kind === "run" ? ["run"] : ["page", "api"];
  if (asked === undefined || asked === null) return allowed[0]!;
  if (typeof asked !== "string" || !VIA.includes(asked as FileVia) || !allowed.includes(asked as FileVia)) {
    throw new StoreFileError(400, "bad_request", `A file from ${kind === "guest" ? "a guest" : kind === "run" ? "a run" : "a person"} arrives by ${allowed.join(" or ")}.`);
  }
  return asked as FileVia;
}

/** Refuses a program a guest names: a file an operating system runs or installs when it is opened. The page a guest uploads on refuses it first; this holds for a request that page never made. */
function refuseGuestProgram(actor: string, name: string): void {
  if (actor.split(":")[0] === "guest" && isProgramFile(name)) throw new StoreFileError(400, "bad_request", `${name} is a program, and a guest's upload takes no programs. It takes any other kind of file.`);
}

/** The most of a zip's list of files the store reads to look for a program in it: about 80,000 files. A longer list is not read, and the zip stays. */
export const ZIP_LIST_MAX_BYTES = 8 << 20;

/** A file's bytes in the bucket, read by range. */
function bucketBytes(core: StoreCore, key: string, size: number): ByteSource {
  return {
    size,
    async read(at, length) {
      const end = Math.min(size, at + length);
      if (at >= end) return new Uint8Array(0);
      const object = await core.env.FILES.get(key, { range: { offset: at, length: end - at } });
      return object ? new Uint8Array(await object.arrayBuffer()) : new Uint8Array(0);
    },
  };
}

/**
 * Refuses a zip a guest uploaded that has a program in it (`programsInZip`), once its bytes are in:
 * the bytes and the row go, and the words say the program in it is the trouble, not the zip. The
 * page refuses such a zip before it uploads; this holds for a request it never made. A file that is
 * no zip, or whose list is damaged or longer than ZIP_LIST_MAX_BYTES, stays as it came.
 */
async function refuseGuestZipProgram(core: StoreCore, actor: string, row: FileRow): Promise<void> {
  if (actor.split(":")[0] !== "guest" || !isZipFile(row.name)) return;
  let names: string[];
  try {
    names = [...(await zipEntries(bucketBytes(core, row.r2_key, Number(row.size)), "This zip file", ZIP_LIST_MAX_BYTES)).keys()];
  } catch {
    return;
  }
  const inside = programsInZip(names);
  if (inside.length === 0) return;
  await core.env.FILES.delete(row.r2_key).catch(() => undefined);
  core.sql.exec("DELETE FROM _files WHERE id = ?", row.id);
  const listed = inside.length > 3 ? `${inside.slice(0, 3).join(", ")} and ${inside.length - 3} more` : inside.join(", ");
  const one = inside.length === 1;
  throw new StoreFileError(
    400,
    "bad_request",
    `${row.name} has ${one ? "a program" : "programs"} in it (${listed}), and a zip a guest uploads can't have a program in it. The zip itself is fine: take ${one ? "the program" : "the programs"} out and upload the zip again.`,
  );
}

interface FileRow {
  id: string;
  name: string;
  size: number;
  content_type: string;
  sha256: string | null;
  state: "uploading" | "ready";
  received_at: string;
  received_by: string;
  via: FileVia;
  batch: string | null;
  r2_key: string;
  upload_id: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  folder_id: string | null;
}

export function fileWire(row: FileRow): StoredFile {
  return {
    id: row.id,
    name: row.name,
    size: Number(row.size),
    contentType: row.content_type,
    sha256: row.sha256,
    state: row.state,
    receivedAt: row.received_at,
    receivedBy: row.received_by,
    via: row.via,
    batch: row.batch,
    // Never empty once the store has started (folders.ts `fileUnfiled`).
    folderId: row.folder_id ?? "",
  };
}

function fileRow(core: StoreCore, fileId: string): FileRow | null {
  return (core.sql.exec<Record<string, StoreSqlValue>>("SELECT * FROM _files WHERE id = ? AND deleted_at IS NULL", fileId).toArray()[0] as unknown as FileRow | undefined) ?? null;
}

export function listFiles(core: StoreCore): StoredFile[] {
  return core.sql
    .exec<Record<string, StoreSqlValue>>("SELECT * FROM _files WHERE deleted_at IS NULL ORDER BY received_at DESC, id")
    .toArray()
    .map((r) => fileWire(r as unknown as FileRow));
}

/** A media type as a header carries it: `type/subtype`, with parameters. Anything else is kept as bytes. */
const CONTENT_TYPE_RE = /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,64}(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]{1,64}=(?:[A-Za-z0-9!#$&^_.+-]{1,64}|"[^"\\\x00-\x1f\x7f]{0,64}"))*$/;

/** The type a download is served with: one a response header can carry, or plain bytes. */
export function cleanContentType(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length <= 200 && CONTENT_TYPE_RE.test(text) ? text : "application/octet-stream";
}

export function fileKey(storeId: string, fileId: string, name: string): string {
  return `stores/${storeId}/files/${fileId}/${name}`;
}

export async function createFile(core: StoreCore, storeId: string, caller: StoreCaller, body: Record<string, unknown>): Promise<{ file: StoredFile; partBytes: number }> {
  const actor = caller.actor;
  const name = cleanFileName(body.name);
  const size = body.size;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) throw new StoreFileError(400, "bad_request", "A file's size is a whole number of bytes.");
  if (size > FILE_MAX_BYTES) throw new StoreFileError(413, "too_large", `A file in a store is at most ${Math.floor(FILE_MAX_BYTES / 1024 ** 3)} GB.`);
  const contentType = cleanContentType(body.contentType);
  const batch = body.batch === undefined || body.batch === null ? null : typeof body.batch === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(body.batch) ? body.batch : undefined;
  if (batch === undefined) throw new StoreFileError(400, "bad_request", "A batch is 1 to 64 letters, digits, dashes or underscores.");
  const via = viaFor(actor, body.via);
  refuseGuestProgram(actor, name);
  const folderId = uploadFolderFor(core, caller, body.folderId);
  const id = core.newId("fil");
  const key = fileKey(storeId, id, name);
  const receivedAt = core.nowIso();
  const upload = await core.env.FILES.createMultipartUpload(key, {
    httpMetadata: { contentType },
    customMetadata: { fileId: id, name, size: String(size), receivedAt, receivedBy: actor, via, folderId, ...(batch ? { batch } : {}) },
  });
  core.sql.exec(
    "INSERT INTO _files (id, name, size, content_type, sha256, state, received_at, received_by, via, batch, r2_key, upload_id, folder_id) VALUES (?, ?, ?, ?, NULL, 'uploading', ?, ?, ?, ?, ?, ?, ?)",
    id,
    name,
    size,
    contentType,
    receivedAt,
    actor,
    via,
    batch,
    key,
    upload.uploadId,
    folderId,
  );
  // An upload nobody completes is dropped a week later.
  await core.wakeAt(Date.parse(receivedAt) + UPLOAD_ABANDONED_MS);
  return { file: fileWire(fileRow(core, id)!), partBytes: FILE_PART_BYTES };
}

/** Where the gateway puts a part of an upload in progress. */
export function partTarget(core: StoreCore, caller: StoreCaller, fileId: string, n: number): { key: string; uploadId: string } {
  const row = fileRow(core, fileId);
  if (!row) throw new StoreFileError(404, "file_not_found", "This store has no such file.");
  requireFileWithin(core, caller, row.folder_id);
  if (row.state !== "uploading" || !row.upload_id) throw new StoreFileError(409, "file_not_ready", "This file is not taking parts: its upload is complete.");
  const parts = Math.max(1, Math.ceil(Number(row.size) / FILE_PART_BYTES));
  if (!Number.isInteger(n) || n < 1 || n > Math.min(parts, FILE_PARTS_MAX)) throw new StoreFileError(400, "bad_request", `This file takes parts 1 to ${parts}.`);
  return { key: row.r2_key, uploadId: row.upload_id };
}

export async function completeFile(core: StoreCore, caller: StoreCaller, fileId: string, body: Record<string, unknown>): Promise<StoredFile> {
  const actor = caller.actor;
  const row = fileRow(core, fileId);
  if (!row) throw new StoreFileError(404, "file_not_found", "This store has no such file.");
  requireFileWithin(core, caller, row.folder_id);
  if (row.state === "ready") return fileWire(row);
  const parts = Array.isArray(body.parts) ? body.parts : null;
  const expected = Math.max(1, Math.ceil(Number(row.size) / FILE_PART_BYTES));
  if (!parts || parts.length !== expected) throw new StoreFileError(400, "bad_request", `Name all ${expected} part${expected === 1 ? "" : "s"} of this file, each with its etag.`);
  const list = parts.map((p) => {
    const part = p as { n?: unknown; etag?: unknown };
    if (!Number.isInteger(part.n) || typeof part.etag !== "string" || !part.etag) throw new StoreFileError(400, "bad_request", "Each part is { n, etag }.");
    return { partNumber: part.n as number, etag: part.etag };
  });
  list.sort((a, b) => a.partNumber - b.partNumber);
  if (list.some((p, i) => p.partNumber !== i + 1)) throw new StoreFileError(400, "bad_request", `Name parts 1 to ${expected}, each once.`);
  const upload = core.env.FILES.resumeMultipartUpload(row.r2_key, row.upload_id!);
  let object: StoreFileObject;
  try {
    object = await upload.complete(list);
  } catch (error) {
    throw new StoreFileError(400, "bad_request", `The parts do not make the file: ${error instanceof Error ? error.message : "the store's bucket refused them"}.`);
  }
  if (object.size !== Number(row.size)) {
    await core.env.FILES.delete(row.r2_key).catch(() => undefined);
    core.sql.exec("DELETE FROM _files WHERE id = ?", fileId);
    throw new StoreFileError(400, "bad_request", `The parts hold ${object.size} bytes, and the file was to be ${row.size}. Send it again.`);
  }
  await refuseGuestZipProgram(core, actor, row);
  // The file may have been deleted while R2 put its parts together.
  const done = core.transaction(() => {
    if (!fileRow(core, fileId)) return null;
    core.sql.exec("UPDATE _files SET state = 'ready', upload_id = NULL, ready_at = ? WHERE id = ?", core.nowIso(), fileId);
    noteFilesArrived(core, actor, row);
    return fileRow(core, fileId);
  });
  if (!done) {
    await core.env.FILES.delete(row.r2_key).catch(() => undefined);
    throw new StoreFileError(404, "file_not_found", "This file was deleted while it arrived.");
  }
  return fileWire(done);
}

/** One event per batch of files (or per file without one), counting what arrived. */
function noteFilesArrived(core: StoreCore, actor: string, row: FileRow): void {
  if (!row.batch) {
    core.history({ kind: "files", by: actor, note: `Received ${row.name}`, ref: row.id });
    return;
  }
  const ready = core.sql
    .exec<{ name: string }>("SELECT name FROM _files WHERE batch = ? AND state = 'ready' AND deleted_at IS NULL ORDER BY received_at, id", row.batch)
    .toArray()
    .map((r) => String(r.name));
  const shown = ready.slice(0, 3).join(", ") + (ready.length > 3 ? `, and ${ready.length - 3} more` : "");
  const note = `Received ${ready.length} file${ready.length === 1 ? "" : "s"}: ${shown}`;
  const id = `his_batch_${row.batch}`;
  core.sql.exec(
    "INSERT INTO _history (id, at, kind, by_sub, note, restore_point, ref) VALUES (?, ?, 'files', ?, ?, NULL, ?) ON CONFLICT (id) DO UPDATE SET at = excluded.at, note = excluded.note",
    id,
    core.nowIso(),
    actor,
    note,
    row.batch,
  );
}

/** What the gateway streams for a download. */
export function downloadTarget(core: StoreCore, fileId: string): { key: string; name: string; contentType: string; size: number } {
  const row = fileRow(core, fileId);
  if (!row) throw new StoreFileError(404, "file_not_found", "This store has no such file.");
  if (row.state !== "ready") throw new StoreFileError(409, "file_not_ready", "This file is still arriving.");
  return { key: row.r2_key, name: row.name, contentType: row.content_type, size: Number(row.size) };
}

/** A ready file's bytes in the bucket, read by range: what a reader in the store's object opens (file-tables.ts). */
export function fileBytes(core: StoreCore, fileId: string): ByteSource {
  const target = downloadTarget(core, fileId);
  return bucketBytes(core, target.key, target.size);
}

/**
 * Deletes a file. A file that arrived is marked deleted and leaves every list and read, and its
 * bytes stay FILE_KEEP_DELETED_MS before `purgeDeletedFiles` takes them; an upload still arriving
 * has no bytes to keep, so it is dropped at once.
 */
export async function deleteFile(core: StoreCore, actor: string, fileId: string): Promise<void> {
  const row = fileRow(core, fileId);
  if (!row) throw new StoreFileError(404, "file_not_found", "This store has no such file.");
  if (row.state === "uploading") {
    if (row.upload_id) await core.env.FILES.resumeMultipartUpload(row.r2_key, row.upload_id).abort().catch(() => undefined);
    core.transaction(() => {
      core.sql.exec("DELETE FROM _files WHERE id = ? AND state = 'uploading'", fileId);
      core.history({ kind: "files", by: actor, note: `Stopped the upload of ${row.name}`, ref: fileId });
    });
    return;
  }
  const at = core.nowIso();
  core.transaction(() => {
    core.sql.exec("UPDATE _files SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL", at, actor, fileId);
    core.history({ kind: "files", by: actor, note: `Deleted ${row.name}`, ref: fileId });
  });
  await core.wakeAt(Date.parse(at) + FILE_KEEP_DELETED_MS);
}

/** Takes the bytes and records of files deleted FILE_KEEP_DELETED_MS ago; answers when the next one is due. */
export async function purgeDeletedFiles(core: StoreCore): Promise<number | null> {
  const cutoff = new Date(core.deps.now() - FILE_KEEP_DELETED_MS).toISOString();
  const due = core.sql.exec<{ id: string; r2_key: string }>("SELECT id, r2_key FROM _files WHERE deleted_at IS NOT NULL AND deleted_at < ?", cutoff).toArray();
  for (const row of due) {
    await core.env.FILES.delete(String(row.r2_key));
    // What the file reader read of a big workbook or database: its rows go with the file (jobs/read.ts).
    if (core.storeId) await dropReadOut(core.env.FILES, core.storeId, String(row.id));
    core.sql.exec("DELETE FROM _files WHERE id = ? AND deleted_at IS NOT NULL", String(row.id));
  }
  const next = core.sql.exec<{ at: string | null }>("SELECT min(deleted_at) AS at FROM _files WHERE deleted_at IS NOT NULL").one().at;
  return next ? Date.parse(String(next)) + FILE_KEEP_DELETED_MS : null;
}

/** The marks of files deleted but kept: they outlast a restore, as the files themselves do. */
export function deletedMarks(core: StoreCore): { id: string; deletedAt: string; deletedBy: string | null; receivedAt: string }[] {
  return core.sql
    .exec<{ id: string; deleted_at: string; deleted_by: string | null; received_at: string }>("SELECT id, deleted_at, deleted_by, received_at FROM _files WHERE deleted_at IS NOT NULL")
    .toArray()
    .map((r) => ({ id: String(r.id), deletedAt: String(r.deleted_at), deletedBy: r.deleted_by === null ? null : String(r.deleted_by), receivedAt: String(r.received_at) }));
}

/** Drops uploads that never completed; answers when the oldest one left would be dropped. */
export async function dropAbandonedUploads(core: StoreCore): Promise<number | null> {
  const cutoff = new Date(core.deps.now() - UPLOAD_ABANDONED_MS).toISOString();
  const stale = core.sql
    .exec<Record<string, StoreSqlValue>>("SELECT * FROM _files WHERE state = 'uploading' AND received_at < ?", cutoff)
    .toArray() as unknown as FileRow[];
  for (const row of stale) {
    if (row.upload_id) await core.env.FILES.resumeMultipartUpload(row.r2_key, row.upload_id).abort().catch(() => undefined);
    core.sql.exec("DELETE FROM _files WHERE id = ? AND state = 'uploading'", row.id);
  }
  const next = core.sql.exec<{ at: string | null }>("SELECT min(received_at) AS at FROM _files WHERE state = 'uploading'").one().at;
  return next ? Date.parse(String(next)) + UPLOAD_ABANDONED_MS : null;
}

/** The files' count and bytes, for stats. */
export function fileTotals(core: StoreCore): { files: number; fileBytes: number } {
  const row = core.sql.exec<{ n: number; bytes: number | null }>("SELECT count(*) AS n, sum(size) AS bytes FROM _files WHERE state = 'ready' AND deleted_at IS NULL").one();
  return { files: Number(row.n), fileBytes: Number(row.bytes ?? 0) };
}
