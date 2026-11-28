// A store's calls, as its callers see them over RPC. Each names its caller and answers a
// `StoreResult`: the value, or a refusal with a status, a code and plain words.

import type { ExportManifest } from "./export.js";
import type { PullBeginAnswer, PullEndAnswer, PullHashesAnswer, PullPageAnswer, PullState } from "../../store-readers/src/pull.js";
import type { RowsBeginAnswer, RowsEndAnswer, RowsReadAnswer, RowsSendAnswer, RowsState } from "../../store-readers/src/push.js";
import type { ReadBeginAnswer, ReadEndAnswer, ReadPageAnswer, ReadState } from "../../store-readers/src/jobs.js";
import type { TableProfile } from "../../store-readers/src/profile.js";
import type { StoreStatsNow } from "./handler.js";
import type { QuestionAnswerBody, QuestionAnswerResult, QuestionPutBody, QuestionPutResult } from "./questions.js";
import type {
  AppIdentitySignOutBody,
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
  ExecBody,
  ExecResult,
  FileTables,
  FileTablesBody,
  History,
  Job,
  JobSummary,
  Locate,
  LocateBody,
  Structure,
  StructureBody,
  ProfileBody,
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
  StoreCaller,
  StoreEvents,
  StoredFile,
  StoredFolder,
  StoreResult,
  UsedBy,
  UsedByBody,
} from "./types.js";

export interface StoreApi {
  catalog(caller: StoreCaller): Promise<StoreResult<Catalog>>;
  rows(caller: StoreCaller, body: RowsBody): Promise<StoreResult<Rows>>;
  usedBy(caller: StoreCaller, body: UsedByBody): Promise<StoreResult<UsedBy>>;
  locate(caller: StoreCaller, body: LocateBody): Promise<StoreResult<Locate>>;
  structure(caller: StoreCaller, body: StructureBody): Promise<StoreResult<Structure>>;
  /** One table's profile: what each column holds, from the one profile, read only. */
  profile(caller: StoreCaller, body: ProfileBody): Promise<StoreResult<TableProfile>>;
  query(caller: StoreCaller, body: { sql?: unknown; params?: unknown; limit?: unknown }): Promise<StoreResult<QueryResult>>;
  /** A batch; with `trial`, `record` or `undo`, its change tried, kept or undone row by row (changes.ts). */
  exec(caller: StoreCaller, body: ExecBody): Promise<StoreResult<ExecResult>>;
  migrations(caller: StoreCaller): Promise<StoreResult<{ migrations: Migration[] }>>;
  migrate(caller: StoreCaller, body: { id?: unknown; sql?: unknown; when?: unknown }): Promise<StoreResult<MigrateResult>>;
  files(caller: StoreCaller): Promise<StoreResult<{ files: StoredFile[] }>>;
  fileCreate(caller: StoreCaller, body: Record<string, unknown>): Promise<StoreResult<{ file: StoredFile; partBytes: number }>>;
  filePartTarget(caller: StoreCaller, fileId: string, n: number): Promise<StoreResult<{ key: string; uploadId: string }>>;
  fileComplete(caller: StoreCaller, fileId: string, body: Record<string, unknown>): Promise<StoreResult<{ file: StoredFile }>>;
  fileTarget(caller: StoreCaller, fileId: string): Promise<StoreResult<{ key: string; name: string; contentType: string; size: number }>>;
  /** A workbook's, a database's or a Parquet file's tables, and the first rows of one, read in the store's object by LOAD's readers. */
  fileTables(caller: StoreCaller, fileId: string, body: FileTablesBody): Promise<StoreResult<FileTables>>;
  fileDelete(caller: StoreCaller, fileId: string): Promise<StoreResult<null>>;
  /** The store's folders, with the files directly in each (folders.ts). */
  folders(caller: StoreCaller): Promise<StoreResult<{ folders: StoredFolder[] }>>;
  folderCreate(caller: StoreCaller, body: Record<string, unknown>): Promise<StoreResult<{ folder: StoredFolder; made: boolean }>>;
  folderUpdate(caller: StoreCaller, folderId: string, body: Record<string, unknown>): Promise<StoreResult<{ folder: StoredFolder }>>;
  folderDelete(caller: StoreCaller, folderId: string, body: Record<string, unknown>): Promise<StoreResult<{ deleted: string[]; moved: number; into: string | null }>>;
  filesMove(caller: StoreCaller, body: Record<string, unknown>): Promise<StoreResult<{ fileIds: string[]; folderId: string }>>;
  jobSubmit(caller: StoreCaller, body: Record<string, unknown>): Promise<StoreResult<{ job: Job }>>;
  job(caller: StoreCaller, jobId: string): Promise<StoreResult<{ job: Job }>>;
  /** A job's summary (jobs/summary.ts): its state, step, times, counts and its tables' names, and no value of a row. */
  jobSummary(caller: StoreCaller, jobId: string): Promise<StoreResult<{ summary: JobSummary }>>;
  /** A new key for a pull's DB IO job (jobs/pull.ts), or a preview's, a write's, an undo's or a compare's (jobs/push.ts); the key given before it stops working. */
  jobKey(caller: StoreCaller, jobId: string, body: { until?: unknown; key?: unknown }): Promise<StoreResult<{ key: string; until: string }>>;
  pullState(caller: StoreCaller, jobId: string, key: string): Promise<StoreResult<PullState>>;
  pullBegin(caller: StoreCaller, jobId: string, key: string, body: unknown): Promise<StoreResult<PullBeginAnswer>>;
  pullHashes(caller: StoreCaller, jobId: string, key: string, body: unknown): Promise<StoreResult<PullHashesAnswer>>;
  pullPage(caller: StoreCaller, jobId: string, key: string, body: unknown): Promise<StoreResult<PullPageAnswer>>;
  pullEnd(caller: StoreCaller, jobId: string, key: string, body: unknown): Promise<StoreResult<PullEndAnswer>>;
  /** A table the database refused before any of its pages: it ends with nothing made, and the others go on. */
  pullSkip(caller: StoreCaller, jobId: string, key: string, body: unknown): Promise<StoreResult<PullEndAnswer>>;
  pullFail(caller: StoreCaller, jobId: string, key: string, body: unknown): Promise<StoreResult<null>>;
  /** A preview's, a write's, an undo's or a compare's DB IO job's calls (jobs/push.ts), each with the job's key. */
  rowsState(caller: StoreCaller, jobId: string, key: string): Promise<StoreResult<RowsState>>;
  rowsBegin(caller: StoreCaller, jobId: string, key: string, body: unknown): Promise<StoreResult<RowsBeginAnswer>>;
  rowsRead(caller: StoreCaller, jobId: string, key: string, body: unknown): Promise<StoreResult<RowsReadAnswer>>;
  rowsSend(caller: StoreCaller, jobId: string, key: string, body: unknown): Promise<StoreResult<RowsSendAnswer>>;
  rowsEnd(caller: StoreCaller, jobId: string, key: string, body: unknown): Promise<StoreResult<RowsEndAnswer>>;
  rowsFail(caller: StoreCaller, jobId: string, key: string, body: unknown): Promise<StoreResult<null>>;
  /** A READ's calls from the file reader (jobs/read.ts), each with the job's key; `readFileTarget` is where file `n`'s bytes are, for the gateway to stream. */
  readState(caller: StoreCaller, jobId: string, key: string): Promise<StoreResult<ReadState>>;
  readFileTarget(caller: StoreCaller, jobId: string, key: string, n: number): Promise<StoreResult<{ key: string; name: string; contentType: string; size: number }>>;
  readBegin(caller: StoreCaller, jobId: string, key: string, body: unknown): Promise<StoreResult<ReadBeginAnswer>>;
  readPage(caller: StoreCaller, jobId: string, key: string, body: unknown): Promise<StoreResult<ReadPageAnswer>>;
  readEnd(caller: StoreCaller, jobId: string, key: string, body: unknown): Promise<StoreResult<ReadEndAnswer>>;
  readSkip(caller: StoreCaller, jobId: string, key: string, body: unknown): Promise<StoreResult<ReadEndAnswer>>;
  readFail(caller: StoreCaller, jobId: string, key: string, body: unknown): Promise<StoreResult<null>>;
  /** Stops the open jobs a run started (jobs/runner.ts `stopRunJobs`): `{ runId, why }`, answered with how many were open. */
  jobsStop(caller: StoreCaller, body: Record<string, unknown>): Promise<StoreResult<{ stopped: number }>>;
  history(caller: StoreCaller): Promise<StoreResult<History>>;
  restore(caller: StoreCaller, body: Record<string, unknown>): Promise<StoreResult<{ restoredTo: string; to: string; kept: string[] }>>;
  exportStart(caller: StoreCaller, body: Record<string, unknown>): Promise<StoreResult<{ job: Job; exportId: string }>>;
  exportManifest(caller: StoreCaller, exportId: string): Promise<StoreResult<{ manifest: ExportManifest }>>;
  importStart(caller: StoreCaller, body: Record<string, unknown>): Promise<StoreResult<{ job: Job }>>;
  importCheck(caller: StoreCaller, requestKey: string, replace?: boolean): Promise<StoreResult<null>>;
  restart(): Promise<void> | void;
  stats(caller: StoreCaller): Promise<StoreResult<StoreStatsNow>>;
  /** What settled since the reader's times, by stream (events.ts): batches of files, deletes, jobs that ended, a person's fixes. */
  events(caller: StoreCaller, body: { since?: unknown }): Promise<StoreResult<StoreEvents>>;
  destroy(caller: StoreCaller): Promise<StoreResult<null>>;
  // The rows a person reviews on the Tables tab.
  review(caller: StoreCaller): Promise<StoreResult<Review>>;
  reviewRows(caller: StoreCaller, body: ReviewRowsBody): Promise<StoreResult<ReviewRows>>;
  reviewFix(caller: StoreCaller, body: ReviewFixBody): Promise<StoreResult<ReviewFixResult>>;
  // Questions for the store's Guests (questions.ts).
  questionPut(caller: StoreCaller, body: QuestionPutBody): Promise<StoreResult<QuestionPutResult>>;
  questionAnswer(caller: StoreCaller, body: QuestionAnswerBody): Promise<StoreResult<QuestionAnswerResult>>;
  // A Modern App's own statements and people.
  appQuery(caller: StoreCaller, statement: unknown): Promise<StoreResult<AppStatementResult>>;
  appBatch(caller: StoreCaller, statements: unknown): Promise<StoreResult<AppStatementResult[]>>;
  appUsers(caller: StoreCaller): Promise<StoreResult<{ users: AppUser[] }>>;
  appUserFind(caller: StoreCaller, by: { issuer?: unknown; sub?: unknown; email?: unknown }): Promise<StoreResult<{ user: AppUser | null }>>;
  appUserInvite(caller: StoreCaller, body: AppUserInviteBody): Promise<StoreResult<{ user: AppUser }>>;
  appUserUpdate(caller: StoreCaller, userId: string, body: AppUserUpdateBody): Promise<StoreResult<{ user: AppUser }>>;
  appUserSignOut(caller: StoreCaller, userId: string): Promise<StoreResult<AppUserSignOutResult>>;
  appIdentitySignOut(caller: StoreCaller, body: AppIdentitySignOutBody): Promise<StoreResult<AppUserSignOutResult>>;
  appSignIn(caller: StoreCaller, body: AppSignInBody): Promise<StoreResult<AppSignInResult>>;
  appSession(caller: StoreCaller, body: { id?: unknown; whoOpens?: unknown }): Promise<StoreResult<AppSessionResult>>;
  appSessionEnd(caller: StoreCaller, body: { id?: unknown }): Promise<StoreResult<{ ended: boolean }>>;
  appTokenUser(caller: StoreCaller, body: { issuer?: unknown; sub?: unknown; whoOpens?: unknown }): Promise<StoreResult<AppTokenUserResult>>;
  /**
   * A run's live socket (live.ts): a WebSocket upgrade with the caller, the run and when its token
   * ends in the `LIVE_HEADER` header, answered 101 with the socket, or a refusal as JSON.
   */
  fetch(request: Request): Promise<Response>;
}
