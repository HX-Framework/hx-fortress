// The job handlers a store runs, by kind. LOAD (`load`), SHAPE (`shape`), PULL (`pull`) and PUSH's
// four (`push_preview`, `push`, `push_undo`, `compare`) register here from their own files beside this one
// (store/jobs/load*.ts, store/jobs/shape*.ts, store/jobs/push.ts), and parking's two (`park`,
// `bring_back`) from store/park.ts. A submit of a kind with no handler is refused.

import { bringBackHandler, parkHandler } from "../park.js";
import { checkHandler } from "./check.js";
import { classifyHandler } from "./classify.js";
import { loadHandler } from "./load.js";
import { matchHandler } from "./match.js";
import { profileHandler } from "./profile.js";
import { pullHandler } from "./pull.js";
import { compareHandler, pushHandler, pushPreviewHandler, pushUndoHandler } from "./push.js";
import { shapeHandler } from "./shape.js";
import type { JobHandler } from "./types.js";

export const JOB_HANDLERS: ReadonlyMap<string, JobHandler> = new Map<string, JobHandler>([
  [loadHandler.kind, loadHandler as unknown as JobHandler],
  [shapeHandler.kind, shapeHandler as unknown as JobHandler],
  [parkHandler.kind, parkHandler as unknown as JobHandler],
  [bringBackHandler.kind, bringBackHandler as unknown as JobHandler],
  [profileHandler.kind, profileHandler as unknown as JobHandler],
  [classifyHandler.kind, classifyHandler as unknown as JobHandler],
  [matchHandler.kind, matchHandler as unknown as JobHandler],
  [checkHandler.kind, checkHandler as unknown as JobHandler],
  [pullHandler.kind, pullHandler as unknown as JobHandler],
  [pushPreviewHandler.kind, pushPreviewHandler as unknown as JobHandler],
  [pushHandler.kind, pushHandler as unknown as JobHandler],
  [pushUndoHandler.kind, pushUndoHandler as unknown as JobHandler],
  [compareHandler.kind, compareHandler as unknown as JobHandler],
]);
