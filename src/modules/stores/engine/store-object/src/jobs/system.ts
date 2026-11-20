// The store's own jobs: an export and an import. They run like a program's steps, a chunk per
// alarm, but only the store's own calls make them (`exportStart`, `importStart`, `copyFrom`): the
// jobs route, which takes a `write` token, takes none of their kinds.

import { exportHandler } from "../export.js";
import { importHandler } from "../import.js";
import type { JobHandler } from "./types.js";

export const SYSTEM_JOB_HANDLERS: ReadonlyMap<string, JobHandler> = new Map<string, JobHandler>([
  [exportHandler.kind, exportHandler as unknown as JobHandler],
  [importHandler.kind, importHandler as unknown as JobHandler],
]);
