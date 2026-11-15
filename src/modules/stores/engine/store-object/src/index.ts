// `store-object`: a store, everything but its workerd shell. The `Store` Durable Object class
// itself is `store-object/object` (it imports `cloudflare:workers`, which only workerd loads);
// this entry holds what runs anywhere: the handler behind every call, the shapes of its answers, and
// the SQL helpers a deployer shares with it. `store-object/sql` is the splitter alone, for a
// caller that wants nothing else.
//
// The package imports nothing from its deployer (boundary.test.ts): a gateway in front runs it behind
// its tokens, audit and stats, and an app on its owner's own Cloudflare account deploys the same
// class with its data and users.

export type { StoreApi } from "./api.js";
export { SESSION_DAYS_MAX } from "./app-users.js";
export { randomHex, sha256Hex, StoreCore, StoreError, type StoreDeps, type StoreEnv, type StoreState, type StoreStorage } from "./core.js";
export { archiveName, exportArchive, exportDatabase } from "./archive.js";
export {
  COPY_SAMPLE_ROWS,
  COPY_WHOLE_UNDER_BYTES,
  EXPORT_ID_RE,
  EXPORT_KEEP_MS,
  readManifest,
  type ExportFile,
  type ExportManifest,
  type ExportResult,
} from "./export.js";
export { OWN_COLUMNS } from "./data.js";
export { STRUCTURE_MIGRATIONS_MAX, STRUCTURE_SQL_MAX } from "./structure.js";
export { FILE_KEEP_DELETED_MS, FILE_MAX_BYTES, fileKey, UPLOAD_ABANDONED_MS } from "./files.js";
export type { ImportResult } from "./import.js";
export { StoreHandler, type StoreStatsNow } from "./handler.js";
export { DELETES_SETTLE_MS, EVENT_FILES_MAX, EVENTS_LOOKBACK_MS, EVENTS_MAX, FILES_SETTLE_MS, FIXES_SETTLE_MS, storeEvents, UPLOAD_HOLD_MS } from "./events.js";
export type { FolderRefusalCode } from "./folders.js";
export { HISTORY_SHOWN, RESTORE_WINDOW_MS } from "./history.js";
export { SqliteFileReader, type BTreeCursor, type BTreeRow } from "./sqlite-file/reader.js";
export { finishFile, IndexTree, PageOut, TableTree, type SchemaEntry } from "./sqlite-file/writer.js";
export { JOB_HANDLERS } from "./jobs/index.js";
export { JOB_REFUSALS, JOB_SUMMARY_KINDS, JOB_SUMMARY_SHAPES, jobSummary, jobSummaryShape, type JobSummaryKind, type JobSummaryShape } from "./jobs/summary.js";
export { JOB_CHUNK_MS, JobParamsError, type JobContext, type JobHandler, type JobOutcome } from "./jobs/types.js";
export {
  LIVE_EVERY_MS,
  LIVE_HEADER,
  LIVE_ROWS,
  LIVE_RUN_ID_RE,
  LIVE_TOKEN_ENDED,
  LiveRuns,
  liveCallerOf,
  runFrame,
  type LiveCaller,
  type LiveFrame,
  type LiveJob,
  type LiveSocket,
  type LiveTable,
} from "./live.js";
export { SYSTEM_DDL } from "./schema.js";
export { KIND_ESTIMATES } from "./jobs/estimates.js";
export type { JobEstimateView } from "./jobs/types.js";
export { DOLLARS_PER_MILLION_ROWS_WRITTEN, WRITE_LIMIT_DEFAULT, writeLimitWords } from "./write-limit.js";
export { isReservedName, migrationStatements, splitStatements, StoreSqlRefusal, SYSTEM_TABLES, type SqlLike, type StoreSqlCursor, type StoreSqlValue } from "./sql.js";
export type { StoreFileBody, StoreFileList, StoreFileObject, StoreFileOptions, StoreFilePart, StoreFiles, StoreFileUpload } from "./store-files.js";
export * from "./types.js";
