// READ: a big workbook or database read beside the store (D8). store_load (the api's
// agent/tools/store-steps.ts) submits it for each .xls workbook or Access database larger than a
// store reads whole (store-readers open.ts WHOLE_FILE_CAPS), and starts the file reader
// (apps/file-reader) with the job's key. `store-readers/jobs` has the wire.
//
//   • A READ is a job like any other (one at a time per store), but like a pull it does no work on its
//     own alarms: its first chunk notes the files no longer in the store, and then it waits
//     (`{ wait }`) while each call of the reader does its own work. The last file's end wakes it to
//     end; a reader's failure, or its time running out, wakes it to fail.
//   • The reader asks where the job stands (`readStateOf`), downloads each file it still has to read
//     through the job's own route (`readFileTarget`: the gateway streams the bytes), opens it with the
//     store's own reader, and sends the file's tables (`readBegin`), then its rows as pages
//     (`readPage`), then its end (`readEnd`). A file it cannot read either is skipped with its words
//     (`readSkip`), which LOAD then gives.
//   • Each page is one part of the file's read-out in the store's bucket, gzipped JSON Lines under
//     `stores/<store>/read-outs/<file>/<job>/<n>/`, n counting the readers that began the file. The
//     file's end writes the job's manifest, `stores/<store>/read-outs/<file>/<job>/manifest.json`
//     (`ReadOut`), and only then: a read-out is whole or it is not there.
//   • Each READ reads for one LOAD, which names it (`LoadFile.readOut`) and drops its read-out when
//     it ends (`dropReadOutOf`). So two runs loading one file never share a read-out, and every LOAD
//     of a big file has it read by the readers of its day.
//   • A page sent again is answered as taken. A reader that stopped is followed by one that begins
//     the file again: the same build of the reader goes on after the pages the store holds, another
//     build reads the file anew.
//   • LOAD opens the read-out where it would have opened the file (`readOutFor`), and a deleted
//     file's read-out goes when its bytes do (files.ts `purgeDeletedFiles`, `dropReadOut`).

import { openReadOut, type OpenedFile, type SourceTable } from "../../../store-readers/src/index.js";
import {
  checkedReadOut,
  READ_LIMITS,
  READ_OUT_VERSION,
  readBeginOf,
  readEndOf,
  readFailOf,
  type ReadBeginAnswer,
  type ReadEndAnswer,
  type ReadFormat,
  type ReadOut,
  type ReadOutTable,
  type ReadPageAnswer,
  readPageOf,
  type ReadParams,
  readParamsOf,
  type ReadResult,
  type ReadRow,
  readRowLine,
  ReadShapeError,
  readSkipOf,
  type ReadState,
} from "../../../store-readers/src/jobs.js";
import { sha256Hex, StoreError, type StoreCore } from "../core.js";
import { downloadTarget } from "../files.js";
import type { StoreFiles } from "../store-files.js";
import type { JobProgress } from "../types.js";
import { type KeyedJobRow, keyedJob } from "./pull.js";
import { type JobHandler, JobParamsError } from "./types.js";

/** How long a READ waits for its reader's key; a key names its own time. */
export const READ_WAITS_MS = 45 * 60_000;

/** Where a file stands in a READ. */
interface ReadFileRun {
  /** The reader's build that began it, and where its parts go; null before it began. */
  reader: string | null;
  prefix: string | null;
  /** How many times a reader began it anew: the parts of each go under a prefix of their own. */
  attempt: number;
  /** Each table's columns, as its beginning named them: what a page of it is checked against. */
  widths: number[];
  /** The last page taken, and its table. */
  page: number;
  table: number;
  /** Each table's parts. */
  parts: ReadOutTable[];
  rows: number;
  ended: boolean;
  /** Why the reader could not read it, or why it was not there to read. */
  unread: string | null;
}

export interface ReadJobState {
  /** taking: the reader's calls come in. failing: the job fails with `failure`. */
  phase: "taking" | "failing";
  failure: string | null;
  files: ReadFileRun[];
}

const READ_KINDS: ReadonlySet<string> = new Set(["read"]);

const blankRun = (): ReadFileRun => ({ reader: null, prefix: null, attempt: 0, widths: [], page: 0, table: 0, parts: [], rows: 0, ended: false, unread: null });

/** The folder of a file's read-outs, and the manifest that names the one LOAD opens. */
export const readOutFolder = (storeId: string, fileId: string): string => `stores/${storeId}/read-outs/${fileId}/`;
/** A READ's read-out of a file: its manifest, and the parts of each time a reader began the file. */
const jobFolder = (storeId: string, fileId: string, jobId: string): string => `${readOutFolder(storeId, fileId)}${jobId}/`;
const manifestKey = (storeId: string, fileId: string, jobId: string): string => `${jobFolder(storeId, fileId, jobId)}manifest.json`;
const partKey = (prefix: string, page: number): string => `${prefix}part-${String(page).padStart(6, "0")}.jsonl.gz`;
const headKey = (prefix: string): string => `${prefix}head.json`;

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: ArrayBuffer): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/** A read of the bucket that failed while LOAD read a read-out: LOAD tries its chunk again, as for a file's own bytes. */
export class ReadOutUnreachable extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "ReadOutUnreachable";
  }
}

/** The lines of a read-out's part: its rows, one JSON array a line; null when the part is gone. */
async function readPart(bucket: StoreFiles, prefix: string, page: number): Promise<string[] | null> {
  let bytes: ArrayBuffer;
  try {
    const object = await bucket.get(partKey(prefix, page));
    if (!object) return null;
    bytes = await object.arrayBuffer();
  } catch (error) {
    throw new ReadOutUnreachable(error);
  }
  return (await gunzip(bytes)).split("\n").filter((line) => line.length > 0);
}

/** Every object under `prefix` but those `keep` says to keep. */
async function dropUnder(bucket: StoreFiles, prefix: string, keep: (key: string) => boolean = () => false): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    const gone = page.objects.map((o) => o.key).filter((key) => !keep(key));
    if (gone.length) await bucket.delete(gone);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/**
 * One READ's read-out of a file, once the LOAD it read for ended: its manifest first, so a drop that
 * stops part way leaves parts no manifest names, never a manifest whose parts are gone.
 */
export async function dropReadOutOf(bucket: StoreFiles, storeId: string, fileId: string, readJob: string): Promise<void> {
  await bucket.delete(manifestKey(storeId, fileId, readJob));
  await dropUnder(bucket, jobFolder(storeId, fileId, readJob));
}

/** A file's read-outs, every one: its bytes were purged (files.ts `purgeDeletedFiles`). */
export async function dropReadOut(bucket: StoreFiles, storeId: string, fileId: string): Promise<void> {
  await dropUnder(bucket, readOutFolder(storeId, fileId));
}

/** The read-out the store holds of a file, when it is one of this version for this file; null otherwise. */
async function heldReadOut(bucket: StoreFiles, storeId: string, file: { id: string; size: number }, readJob: string): Promise<ReadOut | null> {
  const object = await bucket.get(manifestKey(storeId, file.id, readJob));
  if (!object) return null;
  // A read of the bucket that fails is thrown, and tried again; a manifest that is not one is none.
  const text = new TextDecoder().decode(await object.arrayBuffer());
  try {
    return checkedReadOut(JSON.parse(text), file);
  } catch {
    return null;
  }
}

/**
 * A big workbook or database opened from the read-out the store holds of it, as LOAD opens a file
 * (store-readers open.ts `readOut`); null when it holds none. A read-out of a file the reader could
 * not read throws that file's words, as the file itself would have.
 */
export async function readOutFor(bucket: StoreFiles, storeId: string, file: { id: string; size: number }, readJob: string): Promise<OpenedFile | null> {
  const out = await heldReadOut(bucket, storeId, file, readJob).catch((error: unknown) => {
    throw new ReadOutUnreachable(error);
  });
  if (!out) return null;
  const prefix = "prefix" in out.read ? out.read.prefix : "";
  return openReadOut(out, (n) => readPart(bucket, prefix, n));
}

function shaped<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (error instanceof ReadShapeError) throw new StoreError(400, "bad_request", error.message);
    throw error;
  }
}

const paramsOf = (row: KeyedJobRow): ReadParams => JSON.parse(row.params) as ReadParams;
const stateOf = (row: KeyedJobRow): ReadJobState | null => (row.run_state === null ? null : (JSON.parse(row.run_state) as ReadJobState));

/** The job, refused when this store has none of that id, or it is no READ. */
const readJob = (core: StoreCore, jobId: string): KeyedJobRow => keyedJob(core, jobId, READ_KINDS, "That job reads no files beside the store.");

/** The job, for a call that carries the key whose hash is `hash`: refused unless it is the key given last. */
function admitted(core: StoreCore, jobId: string, hash: string): KeyedJobRow {
  const row = readJob(core, jobId);
  if (row.key_hash !== hash) throw new StoreError(403, "job_key_refused", "This key is not the one this READ takes pages with: a newer reader holds it.");
  return row;
}

/** The job as a call of the reader may use it: running, taking pages, with its state. */
function taking(core: StoreCore, jobId: string, hash: string): { row: KeyedJobRow; params: ReadParams; state: ReadJobState } {
  const row = admitted(core, jobId, hash);
  const state = stateOf(row);
  if (row.state !== "running" || !state) throw new StoreError(409, "job_not_taking", "The store has not started this READ yet: another job is running.");
  if (state.phase !== "taking") throw new StoreError(409, "job_not_taking", "This READ takes no more pages: it failed.");
  return { row, params: paramsOf(row), state };
}

function progressOf(params: ReadParams, state: ReadJobState): JobProgress {
  const ended = state.files.filter((f) => f.ended).length;
  const reading = state.files.findIndex((f) => !f.ended && f.prefix);
  return { done: ended, total: params.files.length, ...(ended < params.files.length ? { note: reading >= 0 ? `Reading ${params.files[reading]!.name}` : "Waiting for the file reader" } : {}) };
}

/** The job's state and its progress, saved by a reader's call: the call is the reader's last (`touched`). */
function saveState(core: StoreCore, jobId: string, params: ReadParams, state: ReadJobState): void {
  const now = core.nowIso();
  core.sql.exec("UPDATE _jobs SET run_state = ?, progress = ?, updated_at = ? WHERE id = ?", JSON.stringify(state), JSON.stringify({ ...progressOf(params, state), readerAt: now }), now, jobId);
}

/**
 * A reader's call, kept on the job (`progress.readerAt`): while its reader calls, a job reads as one a
 * reader holds, so an api of any instance leaves it to that reader. Only a reader's calls write it:
 * the runner's own runs of the job keep its `updatedAt`, never this.
 */
function touched(core: StoreCore, jobId: string): void {
  core.sql.exec("UPDATE _jobs SET progress = json_set(coalesce(progress, '{}'), '$.readerAt', ?) WHERE id = ?", core.nowIso(), jobId);
}

/** The store's id, which every call of a job's store has named by now. */
function storeIdOf(core: StoreCore): string {
  const id = core.storeId;
  if (!id) throw new StoreError(500, "internal", "This store does not know its own id.");
  return id;
}

/** File `id`'s name and size as the store holds it; null once it was deleted. */
function storedFile(core: StoreCore, id: string): { name: string; size: number } | null {
  try {
    const target = downloadTarget(core, id);
    return { name: target.name, size: target.size };
  } catch (error) {
    if (error instanceof StoreError && (error.status === 404 || error.status === 409)) return null;
    throw error;
  }
}

/** `GET …/read`: where the job stands, and which files the reader still reads. */
export async function readStateOf(core: StoreCore, jobId: string, key: string): Promise<ReadState> {
  const row = admitted(core, jobId, await sha256Hex(key));
  touched(core, jobId);
  const params = paramsOf(row);
  const state = stateOf(row);
  const status = (): ReadState["state"] => {
    if (row.state === "done") return "done";
    if (row.state === "failed") return "failed";
    if (row.state === "queued" || !state) return "waiting";
    return state.phase === "taking" ? "taking" : "failed";
  };
  return {
    state: status(),
    error: row.error ?? state?.failure ?? null,
    files: params.files.map((f, i) => ({ id: f.id, name: f.name, size: storedFile(core, f.id)?.size ?? 0, ended: state?.files[i]?.ended ?? false })),
    limits: READ_LIMITS,
  };
}

/**
 * Where file `n`'s bytes are (its route counts from 1; a call's `file` is its index, from 0), for the
 * gateway to stream to the reader: only a file this READ still reads.
 */
export async function readFileTarget(core: StoreCore, jobId: string, key: string, n: number): Promise<{ key: string; name: string; contentType: string; size: number }> {
  const { params, state } = taking(core, jobId, await sha256Hex(key));
  touched(core, jobId);
  const file = Number.isInteger(n) && n >= 1 ? params.files[n - 1] : undefined;
  if (!file) throw new StoreError(404, "not_found", "This READ reads no such file.");
  if (state.files[n - 1]!.ended) throw new StoreError(409, "read_file_ended", `${file.name} has ended in this READ.`);
  return downloadTarget(core, file.id);
}

/** A file's tables, before its rows: answers the pages of it the store holds, which the reader sends no more. */
export async function readBegin(core: StoreCore, jobId: string, key: string, body: unknown): Promise<ReadBeginAnswer> {
  const hash = await sha256Hex(key);
  const { params, state } = taking(core, jobId, hash);
  const begin = shaped(() => readBeginOf(body, params.files.length));
  const run = state.files[begin.file]!;
  const file = params.files[begin.file]!;
  if (run.ended) throw new StoreError(409, "read_file_ended", `${file.name} has ended in this READ.`);
  // The same build of the reader goes on after the pages the store holds; another build reads it anew.
  if (run.prefix && run.reader === begin.reader) return { page: run.page };
  const prefix = `${jobFolder(storeIdOf(core), file.id, jobId)}${run.attempt + 1}/`;
  const head: { format: ReadFormat; tables: SourceTable[]; notes: string[] } = { format: begin.format, tables: begin.tables, notes: begin.notes };
  await core.env.FILES.put(headKey(prefix), JSON.stringify(head), { httpMetadata: { contentType: "application/json" } });
  const page = core.transaction(() => {
    const now = taking(core, jobId, hash);
    const r = now.state.files[begin.file]!;
    if (r.ended) throw new StoreError(409, "read_file_ended", `${file.name} has ended in this READ.`);
    // Another call began it while this one wrote: the first to record it holds it.
    if (r.prefix && r.attempt > run.attempt) return r.reader === begin.reader ? r.page : null;
    Object.assign(r, { reader: begin.reader, prefix, attempt: run.attempt + 1, widths: begin.tables.map((t) => t.columns.length), page: 0, table: 0, parts: begin.tables.map(() => ({ first: 0, parts: 0, rows: 0 })), rows: 0 });
    saveState(core, jobId, now.params, now.state);
    return 0;
  });
  if (page === null) throw new StoreError(409, "read_restarted", `Another reader began ${file.name} again in this READ.`);
  return { page };
}

/** Writes a page as part `page` of the read-out under `prefix`. Writing it again writes the same object. */
async function putPart(bucket: StoreFiles, prefix: string, page: number, rows: readonly ReadRow[], table: number): Promise<void> {
  const bytes = await gzip(`${rows.map(readRowLine).join("\n")}\n`);
  await bucket.put(partKey(prefix, page), bytes, {
    httpMetadata: { contentType: "application/gzip" },
    customMetadata: { table: String(table), rows: String(rows.length) },
  });
}

/** A page: one part of the file's read-out, its rows in file order. A page sent again is answered as taken. */
export async function readPage(core: StoreCore, jobId: string, key: string, body: unknown): Promise<ReadPageAnswer> {
  const hash = await sha256Hex(key);
  const { params, state } = taking(core, jobId, hash);
  const page = shaped(() => readPageOf(body, params.files.length, (f, t) => (state.files[f]?.prefix ? (state.files[f]!.widths[t] ?? null) : null)));
  const run = state.files[page.file]!;
  if (!run.prefix) throw new StoreError(409, "read_not_begun", "This file has not begun: its tables come before its rows.");
  if (run.ended || page.page <= run.page) return { page: run.page };
  if (page.page !== run.page + 1) throw new StoreError(409, "read_page_order", `The store holds ${run.page} pages of this file: page ${run.page + 1} comes next.`);
  if (page.table < run.table) throw new StoreError(409, "read_table_order", "A file's tables come in order, and this page's table came before the last one's.");
  await putPart(core.env.FILES, run.prefix, page.page, page.rows, page.table);
  const taken = core.transaction(() => {
    const now = taking(core, jobId, hash);
    const r = now.state.files[page.file]!;
    if (r.prefix !== run.prefix) throw new StoreError(409, "read_restarted", "Another reader began this file again: this page is not one of its pages.");
    if (r.ended || page.page <= r.page) return r.page;
    if (page.page !== r.page + 1) throw new StoreError(409, "read_page_order", `The store holds ${r.page} pages of this file: page ${r.page + 1} comes next.`);
    const t = r.parts[page.table]!;
    if (!t.parts) t.first = page.page;
    t.parts += 1;
    t.rows += page.rows.length;
    r.page = page.page;
    r.table = page.table;
    r.rows += page.rows.length;
    saveState(core, jobId, now.params, now.state);
    return r.page;
  });
  return { page: taken };
}

/** Ends file `file` in the job's state, with why it was not read when it was not; answers whether every file has ended. */
function endFile(core: StoreCore, jobId: string, hash: string, file: number, unread: string | null, prefix: string | null): boolean {
  return core.transaction(() => {
    const now = taking(core, jobId, hash);
    const r = now.state.files[file]!;
    if (!r.ended && r.prefix === prefix) {
      r.ended = true;
      r.unread = unread;
      saveState(core, jobId, now.params, now.state);
    }
    return now.state.files.every((f) => f.ended);
  });
}

/** A file deleted while it was read: it ends unread, with no read-out, and what was read of it goes. */
async function goneFile(core: StoreCore, jobId: string, hash: string, file: number, name: string, prefix: string | null): Promise<ReadEndAnswer> {
  const finishing = endFile(core, jobId, hash, file, `${name} is no longer in this store.`, prefix);
  if (prefix) await dropUnder(core.env.FILES, prefix).catch(() => undefined);
  if (finishing) await core.wakeAt(core.deps.now());
  return { finishing };
}

/** A file's end: its manifest is written beside its parts, and an earlier read-out of it goes. */
export async function readEnd(core: StoreCore, jobId: string, key: string, body: unknown): Promise<ReadEndAnswer> {
  const hash = await sha256Hex(key);
  // The answer to the last file's end can be lost: sent again once the job ended and its key went, it answers the same.
  if (readJob(core, jobId).state === "done") return { finishing: true };
  const { params, state } = taking(core, jobId, hash);
  const end = shaped(() => readEndOf(body, params.files.length));
  const run = state.files[end.file]!;
  if (run.ended) return { finishing: state.files.every((f) => f.ended) };
  if (!run.prefix || !run.reader) throw new StoreError(409, "read_not_begun", "This file has not begun: its tables come before its end.");
  if (end.rows !== run.rows) throw new StoreError(409, "read_rows_differ", `The store took ${run.rows} rows of this file, and the reader read ${end.rows}.`);
  if (end.stopped && end.stopped.table >= run.parts.length) throw new StoreError(400, "bad_request", "stopped names a table the file's beginning did not.");
  const storeId = storeIdOf(core);
  const target = storedFile(core, params.files[end.file]!.id);
  if (!target) return goneFile(core, jobId, hash, end.file, params.files[end.file]!.name, run.prefix);
  const head = await core.env.FILES.get(headKey(run.prefix));
  if (!head) throw new StoreError(409, "read_not_begun", "The tables this file began with are gone from the store: begin it again.");
  const { format, tables, notes } = (await head.json()) as { format: ReadFormat; tables: SourceTable[]; notes: string[] };
  const out: ReadOut = {
    v: READ_OUT_VERSION,
    file: { id: params.files[end.file]!.id, name: target.name, size: target.size },
    at: core.nowIso(),
    reader: run.reader,
    read: {
      format,
      tables,
      notes,
      prefix: run.prefix,
      parts: run.parts.map((t, i) => (end.stopped?.table === i ? { ...t, stopped: { reason: end.stopped.reason, message: end.stopped.message } } : t)),
      rows: run.rows,
    },
  };
  const manifest = manifestKey(storeId, out.file.id, jobId);
  await core.env.FILES.put(manifest, JSON.stringify(out), { httpMetadata: { contentType: "application/json" } });
  const finishing = endFile(core, jobId, hash, end.file, null, run.prefix);
  // What an earlier reader of this job left of the file: nothing names it now. Other READs'
  // read-outs stay: each serves its own LOAD.
  const kept = run.prefix;
  await dropUnder(core.env.FILES, jobFolder(storeId, out.file.id, jobId), (k) => k === manifest || k.startsWith(kept)).catch(() => undefined);
  if (finishing) await core.wakeAt(core.deps.now());
  return { finishing };
}

/**
 * A file the reader could not read either: its read-out says why, in the reader's words, and LOAD
 * gives them when it comes to the file. Sent again for a file that ended, it answers the same.
 */
export async function readSkip(core: StoreCore, jobId: string, key: string, body: unknown): Promise<ReadEndAnswer> {
  const hash = await sha256Hex(key);
  if (readJob(core, jobId).state === "done") return { finishing: true };
  const { params, state } = taking(core, jobId, hash);
  const skip = shaped(() => readSkipOf(body, params.files.length));
  const run = state.files[skip.file]!;
  if (run.ended) return { finishing: state.files.every((f) => f.ended) };
  const target = storedFile(core, params.files[skip.file]!.id);
  if (!target) return goneFile(core, jobId, hash, skip.file, params.files[skip.file]!.name, run.prefix);
  const out: ReadOut = {
    v: READ_OUT_VERSION,
    file: { id: params.files[skip.file]!.id, name: target.name, size: target.size },
    at: core.nowIso(),
    reader: run.reader ?? "",
    read: { unread: { reason: skip.reason, message: skip.message } },
  };
  const manifest = manifestKey(storeIdOf(core), out.file.id, jobId);
  await core.env.FILES.put(manifest, JSON.stringify(out), { httpMetadata: { contentType: "application/json" } });
  const finishing = endFile(core, jobId, hash, skip.file, skip.message, run.prefix);
  await dropUnder(core.env.FILES, jobFolder(storeIdOf(core), out.file.id, jobId), (k) => k === manifest).catch(() => undefined);
  if (finishing) await core.wakeAt(core.deps.now());
  return { finishing };
}

/** The reader could not go on: the job fails with its words, once. */
export async function readFail(core: StoreCore, jobId: string, key: string, body: unknown): Promise<null> {
  const row = admitted(core, jobId, await sha256Hex(key));
  const fail = shaped(() => readFailOf(body));
  const state = stateOf(row);
  if (row.state === "queued" || (row.state === "running" && !state)) {
    // Its reader is gone before the job began: its first chunk says so.
    core.sql.exec("UPDATE _jobs SET error = ?, updated_at = ? WHERE id = ?", fail.message, core.nowIso(), jobId);
    if (row.state === "running") await core.wakeAt(core.deps.now());
    return null;
  }
  if (row.state !== "running" || state?.phase !== "taking") return null;
  core.transaction(() => {
    state.phase = "failing";
    state.failure = fail.message;
    saveState(core, jobId, paramsOf(row), state);
  });
  await core.wakeAt(core.deps.now());
  return null;
}

function resultOf(params: ReadParams, state: ReadJobState): ReadResult {
  return {
    files: params.files.map((f, i) => {
      const run = state.files[i]!;
      return { id: f.id, name: f.name, tables: run.unread ? 0 : run.parts.length, rows: run.rows, ...(run.unread ? { unread: run.unread } : {}) };
    }),
  };
}

export const readHandler: JobHandler<ReadParams, ReadJobState, ReadResult> = {
  kind: "read",
  // Its pages write the store's bucket and the job's own record, never a row of a table.
  pastLimit: true,
  sameWork: (params) => params.files.map((f) => f.id),

  parse(params) {
    try {
      return readParamsOf(params);
    } catch (error) {
      if (error instanceof ReadShapeError) throw new JobParamsError(error.message);
      throw error;
    }
  },

  async run(ctx) {
    const until = () => {
      const row = ctx.sql.exec<{ key_until: string | null; created_at: string }>("SELECT key_until, created_at FROM _jobs WHERE id = ?", ctx.job.id).one();
      return row.key_until ? Date.parse(row.key_until) : Date.parse(row.created_at) + READ_WAITS_MS;
    };
    if (ctx.state === null) {
      // Its reader stopped while it waited its turn: nothing will send its pages.
      const stopped = ctx.sql.exec<{ error: string | null }>("SELECT error FROM _jobs WHERE id = ?", ctx.job.id).one().error;
      if (stopped) throw new StoreError(502, "read_failed", stopped);
      // Each READ reads its files for its own LOAD. Nothing here awaits before the commit, so a
      // reader's failure that came while this chunk ran is the error read above, never lost.
      const files: ReadFileRun[] = ctx.params.files.map((f) =>
        ctx.files.get(f.id) ? blankRun() : { ...blankRun(), ended: true, unread: `${f.name} is no longer in this store, or its upload has not finished.` },
      );
      const state: ReadJobState = { phase: "taking", failure: null, files };
      if (files.every((f) => f.ended)) return { result: resultOf(ctx.params, state) };
      // A reader that called while the job waited its turn keeps its call (`touched`).
      const readerAt = ctx.sql.exec<{ at: string | null }>("SELECT json_extract(progress, '$.readerAt') AS at FROM _jobs WHERE id = ?", ctx.job.id).one().at;
      ctx.commit({ state, progress: { ...progressOf(ctx.params, state), ...(readerAt ? { readerAt } : {}) } });
      return { wait: until() };
    }
    const state = ctx.state;
    if (state.phase === "failing") throw new StoreError(502, "read_failed", state.failure ?? "The file reader could not finish.");
    if (state.files.every((f) => f.ended)) return { result: resultOf(ctx.params, state) };
    const end = until();
    if (ctx.now() < end) return { wait: end };
    throw new StoreError(408, "read_timed_out", "The file reader stopped before it read every file, and its time is up.");
  },

  async failed(ctx) {
    // The parts of a file no manifest names: nothing reads them. A file's end writes its manifest
    // before the job marks it ended, so a job that failed in between keeps the parts it names.
    for (const [i, run] of (ctx.state?.files ?? []).entries()) {
      if (run.ended || !run.prefix) continue;
      const named = await ctx.bucket
        .get(manifestKey(ctx.job.storeId, ctx.params.files[i]!.id, ctx.job.id))
        .then(async (o) => (o ? (JSON.parse(new TextDecoder().decode(await o.arrayBuffer())) as { read?: { prefix?: string } }).read?.prefix : undefined))
        .catch(() => run.prefix);
      if (named !== run.prefix) await dropUnder(ctx.bucket, run.prefix).catch(() => undefined);
    }
  },
};
