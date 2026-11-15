// A store's object, everything but the platform shell (object.ts): what each call does, so a test
// can drive it with stand-ins for the storage and the bucket.
//
// Every call names its caller (`StoreCaller`): the store id the caller's own checks verified, and
// who acts. The object knows nothing of how they were verified. It keeps its own store id from the
// first call it ever takes, and refuses any later call that names another, so a routing bug in
// front of it cannot cross stores. A destroyed store refuses everything.

import { runAppBatch, runAppStatement } from "./app.js";
import { endAppSession, findAppUser, inviteAppUser, listAppUsers, readAppSession, readAppTokenUser, signInAppUser, signOutAppUser, updateAppUser } from "./app-users.js";
import { ORG_KEY, StoreCore, StoreError, type StoreDeps, type StoreEnv, type StoreState } from "./core.js";
import { catalog, locate, rows, usedBy } from "./data.js";
import { structure } from "./structure.js";
import { completeFile, createFile, deleteFile, downloadTarget, dropAbandonedUploads, fileTotals, listFiles, partTarget, purgeDeletedFiles } from "./files.js";
import { changeFolder, deleteFolder, fileUnfiled, listFolders, makeFolder, moveFiles, topFolders } from "./folders.js";
import { applyRestoreCarry, heldBy, readHistory, refuseWhileHeld, refuseWhileRestoring, restoreStore, RESTORING_KEY } from "./history.js";
import { reviewFix, reviewRows, reviewTables } from "./review.js";
import { EXPORT_KIND, readManifest, sweepExports, type ExportManifest } from "./export.js";
import { IMPORT_KIND, notEmpty } from "./import.js";
import { makeJobKey, pullBegin, pullEnd, pullFail, pullHashes, pullPage, pullStateOf } from "./jobs/pull.js";
import { rowsBegin, rowsEnd, rowsFail, rowsRead, rowsSend, rowsStateOf } from "./jobs/push.js";
import { jobsOpen, jobsWaitUntil, readJob, readJobSummary, runJobChunk, runOfParams, stopRunJobs, submitJob, submitSystemJob } from "./jobs/runner.js";
import { LiveRuns, type LiveCaller, type LiveSocket } from "./live.js";
import { isParked, parkDue, purgeParked } from "./park.js";
import { ensureSystemTables, getMeta, setMeta } from "./schema.js";
import type { PullBeginAnswer, PullEndAnswer, PullHashesAnswer, PullPageAnswer, PullState } from "../../store-readers/src/pull.js";
import type { RowsBeginAnswer, RowsEndAnswer, RowsReadAnswer, RowsSendAnswer, RowsState } from "../../store-readers/src/push.js";
import { readBySecondName } from "./front-door.js";
import { namesIn, StoreSqlRefusal } from "./sql.js";
import { STATS_TABLE_NAMES } from "./types.js";
import { storeEvents } from "./events.js";
import { countStaleTables, listMigrations, runExec, runMigrate, runQuery } from "./statements.js";
import { BUDGET_ASK_EVERY_MS, forgetWrites, keepSoon, keepWriteCount, refusePastWriteLimit, startWrites, tellBudget, WRITE_KEEP_WITHIN_MS, writesToday } from "./write-limit.js";
import type {
  AppSessionResult,
  AppSignInBody,
  AppSignInResult,
  AppStatementResult,
  AppTokenUserResult,
  AppUser,
  AppUserInviteBody,
  AppUserSignOutResult,
  AppUserUpdateBody,
  Catalog,
  ExecResult,
  History,
  Job,
  JobSummary,
  Locate,
  LocateBody,
  Structure,
  StructureBody,
  MigrateResult,
  Migration,
  QueryResult,
  Review,
  ReviewFixBody,
  ReviewFixResult,
  ReviewRows,
  ReviewRowsBody,
  Rows,
  RowsBody,
  Stats,
  StoreCaller,
  StoreEvents,
  StoredFile,
  StoredFolder,
  StoreResult,
  UsedBy,
  UsedByBody,
} from "./types.js";

const CALLER_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
/** An organization's id as a caller's token names it. */
const ORG_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

/**
 * The words for a statement that named a parked table (SQLite says "no such table: <name>"):
 * where its rows are. Null when the table is not parked. The caller says how to bring it back in
 * its own words (code `table_parked`).
 */
function parkedIn(core: StoreCore, message: string): string | null {
  const m = /no such table: (?:main\.)?["`[]?([A-Za-z0-9_]+)/i.exec(message);
  if (!m || !isParked(core.sql, m[1]!)) return null;
  return `${m[1]} is parked: its rows are in the store's files, not its database. Bring it back to read it.`;
}

/** A store's numbers, and whether it is still busy (a job is open, so they will change again). */
export interface StoreStatsNow extends Stats {
  /** A job is open and runs: the numbers change again within a minute or so. */
  busy: boolean;
  /**
   * While every open job waits for the daily write limit: when they go on by themselves (the next
   * 00:00 UTC, in epoch ms). Until then only a call changes the numbers. Null otherwise.
   */
  waitsUntil: number | null;
}

export class StoreHandler {
  readonly core: StoreCore;
  /** The runs' live sockets (live.ts): the job runner tells them of each commit. */
  readonly liveRuns: LiveRuns;
  private ready: Promise<void>;
  /**
   * When each table (lowercase) was last read through rows or a query: a table someone reads is
   * not parked under them (park.ts `parkDue`). This object's own memory, gone when it restarts; a
   * store is one object, so no other copy reads the table.
   */
  private readonly lastRead = new Map<string, number>();

  constructor(state: StoreState, env: StoreEnv, deps: StoreDeps) {
    this.core = new StoreCore(state, env, deps);
    this.liveRuns = new LiveRuns(this.core);
    this.ready = state.blockConcurrencyWhile(async () => {
      ensureSystemTables(this.core.sql);
      await applyRestoreCarry(this.core);
      // Every file is in a folder before any call reads one: a file this store kept before it had
      // folders, or one whose folder went in a restore or an import, goes into Uploads.
      this.core.transaction(() => fileUnfiled(this.core));
      // A job left open (by a restore, or a start between its chunks) goes on.
      if (jobsOpen(this.core)) await this.core.wakeAt(this.core.deps.now());
      keepWriteCount(this.core);
    });
  }

  /**
   * Runs a call for a caller this store takes, and answers its value or its refusal. A call that
   * writes waits out a restore under way: the restore would drop what it wrote. It waits for an
   * export or an import holding the store too, unless it says what it writes needs neither to end
   * (`held: false`) or no export's file depends on it (`held: "export passes"`). A call that writes
   * is refused once today's writes reach the daily limit (write-limit.ts), unless it says why it
   * may write past it (`limit: false`: it checks the limit itself, or it writes a few rows a person
   * waits on). A new write call is held to the limit without asking. Whatever a call wrote joins
   * today's count when it ends. A store that counts toward its organization's budget asks the budget
   * before its first write since it woke, and tells it what it wrote once 1,000 rows wait.
   */
  private async call<T>(caller: StoreCaller, work: () => T | Promise<T>, opts: { writes?: boolean; limit?: false; held?: false | "export passes" } = {}): Promise<StoreResult<T>> {
    try {
      await this.ready;
      this.admit(caller);
      // A new UTC day keeps yesterday's count first, so today's writes count on today.
      startWrites(this.core);
      if (opts.writes && opts.held === false) refuseWhileRestoring(this.core);
      else if (opts.writes) refuseWhileHeld(this.core, { exportMayPass: opts.held === "export passes" });
      if (opts.writes && opts.limit !== false) {
        // The organization's count and limit, before its first write since the object woke.
        await tellBudget(this.core);
        refusePastWriteLimit(this.core);
      }
      return { ok: true, value: await work() };
    } catch (error) {
      if (error instanceof StoreError) return { ok: false, status: error.status, code: error.code, error: error.message };
      if (error instanceof StoreSqlRefusal) {
        const parked = parkedIn(this.core, error.message);
        if (parked) return { ok: false, status: 409, code: "table_parked", error: parked };
        return { ok: false, status: error.code === "migration_conflict" ? 409 : 400, code: error.code, error: error.message };
      }
      const message = error instanceof Error ? error.message : String(error);
      // A table parked in the store's files: say how to read it.
      const parked = parkedIn(this.core, message);
      if (parked) return { ok: false, status: 409, code: "table_parked", error: parked };
      // SQLite's own words for a statement it could not run.
      if (/SQLITE_|no such (table|column)|syntax error|constraint failed|datatype mismatch/i.test(message)) {
        return { ok: false, status: 400, code: "sql_error", error: message.replace(/: SQLITE_\w+$/, "") };
      }
      console.error(JSON.stringify({ at: "store", error: message }));
      return { ok: false, status: 500, code: "internal", error: "The store could not do that." };
    } finally {
      keepWriteCount(this.core);
      // 1,000 rows the organization's budget has not heard are told now; fewer, by the alarm below.
      await tellBudget(this.core);
      // What still waits in memory is kept by an alarm within seconds, before an idle object sleeps.
      await keepSoon(this.core);
    }
  }

  /**
   * The store id check: the first caller names this store for good; any other is refused. The first
   * caller whose token names an organization names the store's organization for good, too: its writes
   * count toward that organization's budget from then on (write-limit.ts).
   */
  private admit(caller: StoreCaller): void {
    if (!caller || typeof caller.storeId !== "string" || !CALLER_ID_RE.test(caller.storeId) || typeof caller.actor !== "string" || !caller.actor) {
      throw new StoreError(400, "bad_request", "A call names its store and who acts.");
    }
    const sql = this.core.sql;
    if (getMeta(sql, "destroyed_at")) throw new StoreError(410, "store_destroyed", "This store was deleted.");
    const own = getMeta(sql, "store_id");
    if (own !== null && own !== caller.storeId) throw new StoreError(403, "token_wrong_store", "This call is for another store.");
    const org = typeof caller.org === "string" && ORG_ID_RE.test(caller.org) && getMeta(sql, ORG_KEY) === null ? caller.org : null;
    if (own !== null && org === null) return;
    this.core.transaction(() => {
      if (own === null) {
        setMeta(sql, "store_id", caller.storeId);
        setMeta(sql, "created_at", this.core.nowIso());
      }
      if (org !== null) setMeta(sql, ORG_KEY, org);
    });
  }

  catalog(caller: StoreCaller): Promise<StoreResult<Catalog>> {
    return this.call(caller, () => catalog(this.core));
  }

  rows(caller: StoreCaller, body: RowsBody): Promise<StoreResult<Rows>> {
    if (typeof body?.table === "string") this.noteRead([body.table]);
    return this.call(caller, () => rows(this.core, body));
  }

  usedBy(caller: StoreCaller, body: UsedByBody): Promise<StoreResult<UsedBy>> {
    return this.call(caller, () => usedBy(this.core, body));
  }

  locate(caller: StoreCaller, body: LocateBody): Promise<StoreResult<Locate>> {
    return this.call(caller, () => locate(this.core, body));
  }

  structure(caller: StoreCaller, body: StructureBody): Promise<StoreResult<Structure>> {
    return this.call(caller, () => structure(this.core, body));
  }

  query(caller: StoreCaller, body: { sql?: unknown; params?: unknown; limit?: unknown }): Promise<StoreResult<QueryResult>> {
    const text = typeof body?.sql === "string" && body.sql.length <= 100_000 ? body.sql : null;
    if (text !== null) this.noteRead(namesIn(text));
    return this.call(caller, () => {
      // A table read by its second name (front-door.ts) is read too.
      if (text !== null) this.noteRead(readBySecondName(this.core.sql, text));
      return runQuery(this.core, body);
    });
  }

  private noteRead(names: Iterable<string>): void {
    const now = this.core.deps.now();
    for (const name of names) this.lastRead.set(name.toLowerCase(), now);
    // Only names read within a park's wait matter; the rest are forgotten.
    if (this.lastRead.size > 1_000) {
      const keep = now - 60 * 60_000;
      for (const [name, at] of this.lastRead) if (at < keep) this.lastRead.delete(name);
    }
  }

  exec(caller: StoreCaller, body: { sql?: unknown; params?: unknown }): Promise<StoreResult<ExecResult>> {
    return this.call(caller, () => runExec(this.core, body), { writes: true });
  }

  migrations(caller: StoreCaller): Promise<StoreResult<{ migrations: Migration[] }>> {
    return this.call(caller, () => ({ migrations: listMigrations(this.core) }));
  }

  migrate(caller: StoreCaller, body: { id?: unknown; sql?: unknown; when?: unknown }): Promise<StoreResult<MigrateResult>> {
    // runMigrate checks the limit and the hold itself, after it finds a replay of a migration already applied.
    return this.call(caller, () => runMigrate(this.core, caller.actor, body), { writes: true, limit: false, held: false });
  }

  files(caller: StoreCaller): Promise<StoreResult<{ files: StoredFile[] }>> {
    return this.call(caller, () => ({ files: listFiles(this.core) }));
  }

  fileCreate(caller: StoreCaller, body: Record<string, unknown>): Promise<StoreResult<{ file: StoredFile; partBytes: number }>> {
    // An upload's records are a few rows a person waits on; past the limit they are still taken. An
    // upload in progress is in no export's file.
    return this.call(caller, () => createFile(this.core, caller.storeId, caller, body ?? {}), { writes: true, limit: false, held: "export passes" });
  }

  /** Where the caller puts part `n` of an upload in progress: its R2 key and upload id. */
  filePartTarget(caller: StoreCaller, fileId: string, n: number): Promise<StoreResult<{ key: string; uploadId: string }>> {
    return this.call(caller, () => partTarget(this.core, caller, fileId, n), { writes: true, limit: false, held: "export passes" });
  }

  fileComplete(caller: StoreCaller, fileId: string, body: Record<string, unknown>): Promise<StoreResult<{ file: StoredFile }>> {
    return this.call(caller, async () => ({ file: await completeFile(this.core, caller, fileId, body ?? {}) }), { writes: true, limit: false });
  }

  // ── Folders (folders.ts): every file is in one. A few rows a person waits on, so past the daily
  // write limit they are still taken; an export holds them, since its file lists each file's folder.

  folders(caller: StoreCaller): Promise<StoreResult<{ folders: StoredFolder[] }>> {
    return this.call(caller, () => ({ folders: listFolders(this.core) }));
  }

  folderCreate(caller: StoreCaller, body: Record<string, unknown>): Promise<StoreResult<{ folder: StoredFolder; made: boolean }>> {
    return this.call(caller, () => makeFolder(this.core, caller, body ?? {}), { writes: true, limit: false });
  }

  folderUpdate(caller: StoreCaller, folderId: string, body: Record<string, unknown>): Promise<StoreResult<{ folder: StoredFolder }>> {
    return this.call(caller, () => changeFolder(this.core, caller, folderId, body ?? {}), { writes: true, limit: false });
  }

  folderDelete(caller: StoreCaller, folderId: string, body: Record<string, unknown>): Promise<StoreResult<{ deleted: string[]; moved: number; into: string | null }>> {
    return this.call(caller, () => deleteFolder(this.core, caller, folderId, body ?? {}), { writes: true, limit: false });
  }

  filesMove(caller: StoreCaller, body: Record<string, unknown>): Promise<StoreResult<{ fileIds: string[]; folderId: string }>> {
    return this.call(caller, () => moveFiles(this.core, caller, body ?? {}), { writes: true, limit: false });
  }

  /** What the caller streams for a download: the file's R2 key, name, type and size. */
  fileTarget(caller: StoreCaller, fileId: string): Promise<StoreResult<{ key: string; name: string; contentType: string; size: number }>> {
    return this.call(caller, () => downloadTarget(this.core, fileId));
  }

  fileDelete(caller: StoreCaller, fileId: string): Promise<StoreResult<null>> {
    return this.call(
      caller,
      async () => {
        await deleteFile(this.core, caller.actor, fileId);
        return null;
      },
      { writes: true, limit: false },
    );
  }

  jobSubmit(caller: StoreCaller, body: Record<string, unknown>): Promise<StoreResult<{ job: Job }>> {
    // submitJob checks the limit itself: a replay answers the job it made, a new job is refused. A
    // new job waits its turn behind the export or the import that holds the store.
    return this.call(
      caller,
      async () => {
        const job = await submitJob(this.core, caller.actor, body ?? {});
        // A page already on the run hears of its job at once, even one waiting behind another's.
        const runId = runOfParams((body as { params?: unknown } | null)?.params);
        if (runId) this.liveRuns.changed(runId);
        return { job };
      },
      { writes: true, limit: false, held: false },
    );
  }

  job(caller: StoreCaller, jobId: string): Promise<StoreResult<{ job: Job }>> {
    return this.call(caller, () => ({ job: readJob(this.core, jobId) }));
  }

  /**
   * A job's summary: its state, the step it is in, its times, its counts and its tables' names
   * (jobs/summary.ts). For a caller that may hold no value of a row, where `job` would hand it
   * the job's `result`: a MATCH's lists the values it could not match.
   */
  jobSummary(caller: StoreCaller, jobId: string): Promise<StoreResult<{ summary: JobSummary }>> {
    return this.call(caller, () => ({ summary: readJobSummary(this.core, jobId) }));
  }

  // ── A pull's pages (jobs/pull.ts): the DB IO job's own calls, each with the job's key ──────────

  /** A new key for a pull's, a preview's, a write's, an undo's or a compare's DB IO job; the key given before it stops working. */
  jobKey(caller: StoreCaller, jobId: string, body: { until?: unknown; key?: unknown }): Promise<StoreResult<{ key: string; until: string }>> {
    // As a submit: a pull made while an export holds the store waits its turn, so it needs its key now.
    return this.call(caller, () => makeJobKey(this.core, jobId, body ?? {}), { writes: true, limit: false, held: false });
  }

  pullState(caller: StoreCaller, jobId: string, key: string): Promise<StoreResult<PullState>> {
    return this.call(caller, () => pullStateOf(this.core, jobId, key));
  }

  pullBegin(caller: StoreCaller, jobId: string, key: string, body: unknown): Promise<StoreResult<PullBeginAnswer>> {
    return this.call(caller, () => pullBegin(this.core, jobId, key, body), { writes: true });
  }

  pullHashes(caller: StoreCaller, jobId: string, key: string, body: unknown): Promise<StoreResult<PullHashesAnswer>> {
    return this.call(caller, () => pullHashes(this.core, jobId, key, body));
  }

  pullPage(caller: StoreCaller, jobId: string, key: string, body: unknown): Promise<StoreResult<PullPageAnswer>> {
    return this.call(caller, () => pullPage(this.core, jobId, key, body), { writes: true });
  }

  pullEnd(caller: StoreCaller, jobId: string, key: string, body: unknown): Promise<StoreResult<PullEndAnswer>> {
    // Past the day's limit a pull that sent all it had still ends, and its tables become visible.
    return this.call(caller, () => pullEnd(this.core, jobId, key, body), { writes: true, limit: false });
  }

  pullFail(caller: StoreCaller, jobId: string, key: string, body: unknown): Promise<StoreResult<null>> {
    return this.call(caller, () => pullFail(this.core, jobId, key, body), { writes: true, limit: false });
  }

  // ── A preview's, a write's, an undo's and a compare's rows (jobs/push.ts): the DB IO job's calls, with the job's key ──

  rowsState(caller: StoreCaller, jobId: string, key: string): Promise<StoreResult<RowsState>> {
    return this.call(caller, () => rowsStateOf(this.core, jobId, key));
  }

  rowsBegin(caller: StoreCaller, jobId: string, key: string, body: unknown): Promise<StoreResult<RowsBeginAnswer>> {
    return this.call(caller, () => rowsBegin(this.core, jobId, key, body), { writes: true });
  }

  rowsRead(caller: StoreCaller, jobId: string, key: string, body: unknown): Promise<StoreResult<RowsReadAnswer>> {
    return this.call(caller, () => rowsRead(this.core, jobId, key, body));
  }

  rowsSend(caller: StoreCaller, jobId: string, key: string, body: unknown): Promise<StoreResult<RowsSendAnswer>> {
    // A write's page of one preview records a batch the database already committed, so it is taken
    // past the day's limit; every other page meets it (jobs/push.ts `rowsSend`): a preview's and a
    // compare's, and a one-transaction write's and an undo's, pending until their committed end.
    return this.call(caller, () => rowsSend(this.core, jobId, key, body), { writes: true, limit: false });
  }

  rowsEnd(caller: StoreCaller, jobId: string, key: string, body: unknown): Promise<StoreResult<RowsEndAnswer>> {
    // Past the day's limit a job whose DB IO job sent all it had still ends, and its table becomes visible.
    return this.call(caller, () => rowsEnd(this.core, jobId, key, body), { writes: true, limit: false });
  }

  rowsFail(caller: StoreCaller, jobId: string, key: string, body: unknown): Promise<StoreResult<null>> {
    return this.call(caller, () => rowsFail(this.core, jobId, key, body), { writes: true, limit: false });
  }

  /**
   * Stops the open jobs a run started (jobs/runner.ts `stopRunJobs`). It takes a stop past the day's
   * limit, and while an export or an import holds the store: it is how a person ends what is
   * writing. A restore under way would drop the record of it, so the call waits that out.
   */
  jobsStop(caller: StoreCaller, body: Record<string, unknown>): Promise<StoreResult<{ stopped: number }>> {
    return this.call(caller, () => stopRunJobs(this.core, caller.actor, body ?? {}), { writes: true, limit: false, held: false });
  }

  history(caller: StoreCaller): Promise<StoreResult<History>> {
    return this.call(caller, () => readHistory(this.core));
  }

  // ── Export, import, copy (export.ts, import.ts) ─────────────────────────────

  /**
   * Starts an export: for a download (the whole store, as it is), or for a copy another store
   * loads (a preview's: whole under 100 MB, or each table's newest rows; personal values replaced).
   * The same request key answers the same export.
   */
  exportStart(caller: StoreCaller, body: Record<string, unknown>): Promise<StoreResult<{ job: Job; exportId: string }>> {
    return this.call(
      caller,
      async () => {
        const requestKey = typeof body?.requestKey === "string" ? body.requestKey.trim() : "";
        const purpose = body?.purpose === undefined || body.purpose === "download" ? "download" : body.purpose === "copy" ? "copy" : null;
        if (!purpose) throw new StoreError(400, "bad_request", "An export is for a download or a copy.");
        const mode = purpose === "download" ? "whole" : (body.mode ?? "auto");
        if (mode !== "auto" && mode !== "whole" && mode !== "sample") throw new StoreError(400, "bad_request", "A copy is auto, whole or sample.");
        const personal = purpose === "download" ? "keep" : (body.personal ?? "replace");
        if (personal !== "keep" && personal !== "replace") throw new StoreError(400, "bad_request", "A copy keeps or replaces personal values.");
        // A retry answers its own job, whatever the store is doing; a new export waits its turn.
        if (!this.jobMade(requestKey)) refuseWhileRestoring(this.core);
        const params = { exportId: `exp_${this.core.deps.randomHex(12)}`, purpose, mode, personal };
        const job = await submitSystemJob(this.core, caller.actor, EXPORT_KIND, params, requestKey);
        const made = this.core.sql.exec<{ params: string }>("SELECT params FROM _jobs WHERE id = ?", job.id).one();
        return { job, exportId: String((JSON.parse(String(made.params)) as { exportId: string }).exportId) };
      },
      // A store past the day's write limit can still be exported: an export writes almost nothing.
      { limit: false },
    );
  }

  /** A finished export's manifest: how its pieces make the file, and its files. */
  exportManifest(caller: StoreCaller, exportId: string): Promise<StoreResult<{ manifest: ExportManifest }>> {
    return this.call(caller, async () => {
      const manifest = await readManifest(this.core.env.FILES, caller.storeId, exportId, this.core.deps.now());
      if (!manifest) throw new StoreError(404, "export_not_found", "This export is gone, or it has not finished.");
      return { manifest };
    });
  }

  /** Whether a job with this request key was made already: a retry then answers it. */
  private jobMade(requestKey: string): boolean {
    return this.core.sql.exec("SELECT 1 FROM _jobs WHERE request_key = ?", requestKey).toArray().length > 0;
  }

  /**
   * Whether this store could take an import now: empty, and not held, or already holding the job
   * this request key made, so a retry goes on to answer that job. Refuses with the reason when not.
   */
  importCheck(caller: StoreCaller, requestKey: string, replace = false): Promise<StoreResult<null>> {
    return this.call(
      caller,
      () => {
        if (this.jobMade(requestKey)) return null;
        refuseWhileHeld(this.core);
        refusePastWriteLimit(this.core);
        const why = replace ? null : notEmpty(this.core.sql, null);
        if (why) throw new StoreError(409, "store_not_empty", `An import loads into an empty store, and ${why}.`);
        return null;
      },
      { limit: false },
    );
  }

  /**
   * Starts an import into this store, which must be empty: a file it holds (Export's .tar, or its
   * .sqlite), or another store's export made for a copy. The same request key answers the same job.
   */
  importStart(caller: StoreCaller, body: Record<string, unknown>): Promise<StoreResult<{ job: Job }>> {
    return this.call(
      caller,
      async () => {
        const requestKey = typeof body?.requestKey === "string" ? body.requestKey.trim() : "";
        // A retry answers its own job, even after that job finished and its archive is gone.
        if (this.jobMade(requestKey)) return { job: await submitSystemJob(this.core, caller.actor, IMPORT_KIND, null, requestKey) };
        const from = body?.from as { storeId?: unknown; exportId?: unknown } | undefined;
        let source: { kind: "file"; fileId: string } | { kind: "export"; storeId: string; exportId: string };
        let label: string;
        if (typeof body?.fileId === "string") {
          const row = this.core.sql.exec<{ name: string }>("SELECT name FROM _files WHERE id = ? AND state = 'ready' AND deleted_at IS NULL", body.fileId).toArray()[0];
          if (!row) throw new StoreError(404, "file_not_found", "This store has no such file to import.");
          source = { kind: "file", fileId: body.fileId };
          label = String(row.name);
        } else if (from && typeof from.storeId === "string" && typeof from.exportId === "string") {
          source = { kind: "export", storeId: from.storeId, exportId: from.exportId };
          label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 200) : `store ${from.storeId}`;
        } else {
          throw new StoreError(400, "bad_request", "An import names a file of this store's (`fileId`), or another store's export (`from`).");
        }
        const replace = body?.replace === true && source.kind === "export";
        // Before the job and its hold exist: a store restored to this moment has neither to go on with.
        const restorePoint = replace ? await this.core.bookmark() : null;
        const restorePointAt = this.core.nowIso();
        refuseWhileHeld(this.core);
        refusePastWriteLimit(this.core);
        const why = replace ? null : notEmpty(this.core.sql, source.kind === "file" ? source.fileId : null);
        if (why) throw new StoreError(409, "store_not_empty", `An import loads into an empty store, and ${why}.`);
        // The hold starts with the job, so nothing lands in the store while it waits its first chunk.
        return { job: await submitSystemJob(this.core, caller.actor, IMPORT_KIND, { source, label, ...(replace ? { replace: true, restorePoint, restorePointAt } : {}) }, requestKey, { holdFor: "import" }) };
      },
      { limit: false },
    );
  }

  /** Readies a restore; the caller then calls `restart`, and the platform restores as the object starts. */
  restore(caller: StoreCaller, body: Record<string, unknown>): Promise<StoreResult<{ restoredTo: string; to: string; kept: string[] }>> {
    // A restore is how a person recovers: it is never refused for the day's writes, nor for an
    // export or an import under way, which the restore ends.
    return this.call(caller, () => restoreStore(this.core, caller.storeId, caller.actor, body ?? {}), { writes: true, limit: false, held: false });
  }

  /** Restarts the object, which applies a restore readied by `restore`. */
  restart(): void {
    this.core.state.abort("restore");
  }

  stats(caller: StoreCaller): Promise<StoreResult<StoreStatsNow>> {
    return this.call(caller, () => {
      const sql = this.core.sql;
      // The row counts writes left unknown; the ledger reads stats at most once a minute.
      countStaleTables(this.core);
      const t = sql.exec<{ n: number; rows: number | null }>("SELECT count(*) AS n, sum(rows) AS rows FROM _tables").one();
      // The first names by name: the Stores list names a store's tables from the report.
      const names = sql.exec<{ name: string }>("SELECT name FROM _tables ORDER BY name COLLATE NOCASE, name LIMIT ?", STATS_TABLE_NAMES).toArray();
      // Jobs that wait for the daily write limit change nothing until they go on.
      const waitsUntil = jobsWaitUntil(this.core);
      return {
        bytes: sql.databaseSize,
        tables: Number(t.n),
        tableNames: names.map((r) => r.name),
        rows: Number(t.rows ?? 0),
        ...fileTotals(this.core),
        // The folders at the top: the Stores list names a store's folders from the report.
        folders: topFolders(this.core),
        writes: writesToday(this.core),
        busy: waitsUntil === null && jobsOpen(this.core),
        waitsUntil,
      };
    });
  }

  /** What settled since the reader's times (events.ts): pure reads, so a store being restored still answers. */
  events(caller: StoreCaller, body: { since?: unknown }): Promise<StoreResult<StoreEvents>> {
    return this.call(caller, () => storeEvents(this.core, body ?? {}));
  }

  // ── The rows a person reviews on the Tables tab (review.ts) ─────────────────

  review(caller: StoreCaller): Promise<StoreResult<Review>> {
    return this.call(caller, () => ({ tables: reviewTables(this.core) }));
  }

  reviewRows(caller: StoreCaller, body: ReviewRowsBody): Promise<StoreResult<ReviewRows>> {
    return this.call(caller, () => reviewRows(this.core, body ?? ({} as ReviewRowsBody)));
  }

  /** A person's fix: written while no restore is under way, like every other write. */
  reviewFix(caller: StoreCaller, body: ReviewFixBody): Promise<StoreResult<ReviewFixResult>> {
    return this.call(caller, () => reviewFix(this.core, caller.actor, body ?? ({} as ReviewFixBody)), { writes: true });
  }



  // ── A Modern App's own statements and people (app.ts, app-users.ts) ─────────

  /** One statement of an app's, in a transaction of its own. Whether it writes is the statement's own answer. */
  appQuery(caller: StoreCaller, statement: unknown): Promise<StoreResult<AppStatementResult>> {
    return this.call(caller, () => runAppStatement(this.core, statement));
  }

  /** An app's batch: every statement in one transaction. */
  appBatch(caller: StoreCaller, statements: unknown): Promise<StoreResult<AppStatementResult[]>> {
    return this.call(caller, () => runAppBatch(this.core, statements));
  }

  appUsers(caller: StoreCaller): Promise<StoreResult<{ users: AppUser[] }>> {
    return this.call(caller, () => ({ users: listAppUsers(this.core) }));
  }

  appUserFind(caller: StoreCaller, by: { issuer?: unknown; sub?: unknown; email?: unknown }): Promise<StoreResult<{ user: AppUser | null }>> {
    return this.call(caller, () => ({ user: findAppUser(this.core, by) }));
  }

  appUserInvite(caller: StoreCaller, body: AppUserInviteBody): Promise<StoreResult<{ user: AppUser }>> {
    // A Modern App's people: a few rows a person waits on, taken past the limit.
    return this.call(caller, () => ({ user: inviteAppUser(this.core, caller.actor, body) }), { writes: true, limit: false });
  }

  appUserUpdate(caller: StoreCaller, userId: string, body: AppUserUpdateBody): Promise<StoreResult<{ user: AppUser }>> {
    // These change no indexed column of `_users`, so an export's file holds the row before or after.
    return this.call(caller, () => ({ user: updateAppUser(this.core, userId, body) }), { writes: true, limit: false, held: "export passes" });
  }

  appUserSignOut(caller: StoreCaller, userId: string): Promise<StoreResult<AppUserSignOutResult>> {
    return this.call(caller, () => signOutAppUser(this.core, userId), { writes: true, limit: false, held: "export passes" });
  }

  /** Signs a person in to the stage this store belongs to, or says why not. */
  appSignIn(caller: StoreCaller, body: AppSignInBody): Promise<StoreResult<AppSignInResult>> {
    // Past an export's hold a sign-in may only start a session (signInAppUser).
    return this.call(caller, () => signInAppUser(this.core, body), { writes: true, limit: false, held: "export passes" });
  }

  /** A request's session: its person, and whether they may open the stage. */
  appSession(caller: StoreCaller, body: { id?: unknown; whoOpens?: unknown }): Promise<StoreResult<AppSessionResult>> {
    return this.call(caller, () => readAppSession(this.core, body));
  }

  appSessionEnd(caller: StoreCaller, body: { id?: unknown }): Promise<StoreResult<{ ended: boolean }>> {
    return this.call(caller, () => endAppSession(this.core, body), { writes: true, limit: false, held: "export passes" });
  }

  /** The person a native client's token names, and whether they may open the stage. */
  appTokenUser(caller: StoreCaller, body: { issuer?: unknown; sub?: unknown; whoOpens?: unknown }): Promise<StoreResult<AppTokenUserResult>> {
    return this.call(caller, () => readAppTokenUser(this.core, body));
  }

  /**
   * Drops everything: the files under the store's prefix, uploads in progress, and all of the
   * object's storage. Keeps one mark, so a later call (a token minted before the delete) finds a
   * destroyed store instead of making a new, empty one.
   */
  destroy(caller: StoreCaller): Promise<StoreResult<null>> {
    return this.call(caller, async () => {
      const core = this.core;
      const uploads = core.sql.exec<{ r2_key: string; upload_id: string }>("SELECT r2_key, upload_id FROM _files WHERE state = 'uploading' AND upload_id IS NOT NULL").toArray();
      for (const u of uploads) await core.env.FILES.resumeMultipartUpload(String(u.r2_key), String(u.upload_id)).abort().catch(() => undefined);
      const prefix = `stores/${caller.storeId}/`;
      let cursor: string | undefined;
      do {
        const page = await core.env.FILES.list({ prefix, cursor });
        if (page.objects.length > 0) await core.env.FILES.delete(page.objects.map((o) => o.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      this.liveRuns.closeAll();
      await core.storage.deleteAlarm();
      await core.storage.deleteAll();
      ensureSystemTables(core.sql);
      core.transaction(() => {
        setMeta(core.sql, "store_id", caller.storeId);
        setMeta(core.sql, "destroyed_at", core.nowIso());
      });
      // The count waiting in memory was the wiped store's.
      forgetWrites(core);
      return null;
    });
  }

  /** Takes a run's live socket (live.ts) for a caller this store takes, and sends it the run's frame. */
  watchRun(caller: LiveCaller, socket: LiveSocket): Promise<StoreResult<null>> {
    return this.call(caller, () => {
      this.liveRuns.accept(caller, socket);
      return null;
    });
  }

  /**
   * Runs a chunk of the open job and drops abandoned uploads; wakes again when there is more (at
   * 00:00 UTC for a job that waits for the daily write limit, or within a minute when the limit is its
   * organization's, which may be raised at any time). The next wake merges with any a call
   * set meanwhile (`wakeAt` keeps the sooner one): a job submitted while this alarm waited on R2 is
   * not pushed back to the next upload's expiry.
   */
  async alarm(): Promise<void> {
    await this.ready;
    if (getMeta(this.core.sql, "destroyed_at")) return;
    // This may be the alarm a call set to keep the count (write-limit.ts `keepSoon`).
    this.core.meter.keepBy = null;
    startWrites(this.core);
    // The organization's count and limit, at most a minute old, before a job's chunk is held to them.
    await tellBudget(this.core, { all: true, askOlderThan: BUDGET_ASK_EVERY_MS });
    let next: number | null = null;
    try {
      // A restore under way would drop a chunk's work: the job waits, looking again each second,
      // until the restore applies (the store starts again) or is abandoned (its mark goes).
      const restoring = getMeta(this.core.sql, RESTORING_KEY) !== null;
      const nextJob = restoring ? (jobsOpen(this.core) ? this.core.deps.now() + 1_000 : null) : await runJobChunk(this.core, this.liveRuns);
      // While an export or an import holds the store, its file list stays as that job reads it: the
      // cleanups wait a minute.
      const held = heldBy(this.core.sql) !== null;
      // A LOAD's table a SHAPE read is parked once its time comes and no other job is open (an export
      // or an import holds the store only while its job is open).
      const nextPark = restoring ? null : await parkDue(this.core, jobsOpen(this.core), this.lastRead);
      const nextUpload = held ? this.core.deps.now() + 60_000 : await dropAbandonedUploads(this.core);
      const nextPurge = held ? null : await purgeDeletedFiles(this.core);
      const nextParkedPurge = held ? null : await purgeParked(this.core);
      const storeId = this.core.storeId;
      const nextSweep = held || !storeId ? null : await sweepExports(this.core.sql, this.core.env.FILES, storeId, this.core.deps.now());
      const due = [nextJob, nextPark, nextUpload, nextPurge, nextParkedPurge, nextSweep].filter((t): t is number => t !== null);
      if (due.length > 0) {
        next = Math.min(...due);
        await this.core.wakeAt(next);
      }
    } finally {
      // What the chunk wrote joins today's count, so the next chunk is checked against it. With no
      // alarm due within seconds, all that waits in memory is kept now: an idle object sleeps and
      // forgets it.
      keepWriteCount(this.core, { force: next === null || next > this.core.deps.now() + WRITE_KEEP_WITHIN_MS });
      // What it kept, the organization's budget hears now: the object may sleep before the next alarm.
      await tellBudget(this.core, { all: true });
    }
  }
}
