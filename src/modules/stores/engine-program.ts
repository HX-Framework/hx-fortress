// The Store's engine, as the program of a Store's process.
//
// A Store's process (host/store-process-main.ts) opens the Store's file and
// runs one program on it. This is that program: the engine, as the repository
// it is developed in wrote it (engine/, and its ENGINE.md), handed this host's
// storage where the platform it was written for hands its own.
//
// WHAT THE ENGINE IS HANDED
//
//   • The Store's file, as `host/file-storage.ts` keeps it: its SQL, its
//     transactions, its alarm.
//   • A way to end this process (`abort`). The engine asks for it after a
//     restore, to start again on the file as it then is. This file asks for it
//     too, when the engine's own start fails: HX Fortress starts a new process
//     for the next call, as the platform starts the engine anew.
//   • A place for a Store's files that holds nothing and takes nothing. A
//     Store's files come later, with a folder of their own.
//   • The Store's daily write limit, under the name the engine reads its
//     limit by: the Store's own when it has one, and else the limit every
//     Store has on this host (`WRITE_LIMIT_DEFAULT` in store-calls.ts). The
//     engine keeps no limit of a Store's own. So this file keeps it, in a
//     small file of the Store's folder (`write-limit.json`), and hands it to
//     the engine each time the Store is opened. The engine counts each Store
//     alone here: this host keeps no count for an organization.
//   • The clock, randomness, and the engine's own job handlers.
//
// WHAT IT IS ASKED. The calls of `store-calls.ts`, and no other. Each one is
// the engine's own call of the same name, but for the write limit, which is
// this file's own: the engine has no call for it. An answer goes back as the
// engine gave it, and the module in HX Fortress builds what the control plane
// is told (answers.ts). Three answers are changed here first:
//
//   • Of the catalog, only the tables that were asked for cross to
//     HX Fortress, with the count of all.
//   • The Store's numbers say whether the day's write limit is the Store's
//     own. Only this file knows: it keeps the limit.
//   • The history says how far back a Store can be taken, and which line can
//     take it back, only where this host keeps such moments. The engine works
//     both out from the calendar, for a platform that always keeps them.
//
// WHO CALLS. Every call here is made for the control plane, and the engine is
// told so with each call, by the name HX Fortress's own audit trail has for
// the control plane. None of these calls keeps who acted. The calls that do
// (a line of a Store's history) come with the functions that hold rows.
//
// WHAT IT PRINTS. The engine writes a failure it has no word for to this
// process's error output, with the failure's own message, which can hold a
// row's value. The module host starts a Store's process with its output
// closed, so nothing reads it.

import { randomHex, StoreError, type StoreEnv, type StoreState } from "./engine/store-object/src/core.js";
import { StoreHandler } from "./engine/store-object/src/handler.js";
import { JOB_HANDLERS } from "./engine/store-object/src/jobs/index.js";
import type { JobHandler } from "./engine/store-object/src/jobs/types.js";
import type { StoreFiles, StoreFileUpload } from "./engine/store-object/src/store-files.js";
import type { Catalog, History, HistoryEvent, StoreCaller, StoreResult, StoreWrites } from "./engine/store-object/src/types.js";
import { keepWriteCount } from "./engine/store-object/src/write-limit.js";
import { readWriteLimit, writeWriteLimit } from "./host/store-folder";
import type { StoreProgram, StoreProgramContext, StoreProgramFactory } from "./host/store-process-main";
import {
  isWriteLimit,
  STORE_ID_SETTING,
  WRITE_LIMIT_DEFAULT,
  WRITE_LIMIT_MAX,
  WRITE_LIMIT_MIN,
  type StoreCallName,
} from "./store-calls";

/** Who acts, for a call the control plane's ask made: the name HX Fortress's
 *  audit trail records for the control plane (`src/host/module-audit.ts`). A
 *  test holds the two to each other. */
export const CONTROL_PLANE_ACTOR = "control plane";

/** The most tables one `catalog` call answers, whatever it is asked for. */
const CATALOG_TABLES_MOST = 500;

function noFiles(): StoreError {
  return new StoreError(501, "files_unavailable", "This HX Fortress keeps no files for a Store yet.");
}

/** An upload that takes nothing. Every call of it rejects, and none throws:
 *  the engine catches what an upload's call rejects with. */
function noUpload(uploadId: string): StoreFileUpload {
  return {
    uploadId,
    uploadPart: () => Promise.reject(noFiles()),
    complete: () => Promise.reject(noFiles()),
    abort: () => Promise.reject(noFiles()),
  };
}

/** A Store's files, until this HX Fortress keeps them: none is there, and
 *  none is taken. */
export const NO_FILES: StoreFiles = {
  get: () => Promise.resolve(null),
  head: () => Promise.resolve(null),
  put: () => Promise.reject(noFiles()),
  delete: () => Promise.resolve(),
  list: () => Promise.resolve({ objects: [], truncated: false }),
  createMultipartUpload: () => Promise.reject(noFiles()),
  // It asks the bucket nothing, so it answers an upload, as on the platform.
  resumeMultipartUpload: (_key, uploadId) => noUpload(uploadId),
};

function badRequest(words: string): StoreResult<never> {
  return { ok: false, status: 400, code: "bad_request", error: words };
}

function place(value: unknown, most: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= most ? value : null;
}

/** The tables that were asked for, and how many there are in all. */
function catalogPage(
  catalog: StoreResult<Catalog>,
  from: unknown,
  count: unknown,
): StoreResult<{ tables: Catalog["tables"]; total: number }> {
  if (!catalog.ok) return catalog;
  const offset = place(from, Number.MAX_SAFE_INTEGER);
  const most = place(count, CATALOG_TABLES_MOST);
  if (offset === null || most === null) return badRequest("A page of the catalog is a place and a count.");
  const { tables } = catalog.value;
  return { ok: true, value: { tables: tables.slice(offset, offset + most), total: tables.length } };
}

/** A Store's history as this host can stand behind it: without the moments a
 *  Store could be taken back to, where the host keeps none. */
function historyHere(
  history: StoreResult<History>,
  keepsMoments: boolean,
): StoreResult<{ events: HistoryEvent[]; restorableFrom?: string }> {
  if (!history.ok || keepsMoments) return history;
  return {
    ok: true,
    value: {
      events: history.value.events.map((event) => {
        const line: HistoryEvent = { ...event };
        delete line.restorePoint;
        return line;
      }),
    },
  };
}

/** The day's writes, and whether the day's limit is the Store's own. */
type WritesHere = StoreWrites & { own: boolean };

/** The engine on a Store that is open: the engine's own handler, and the
 *  Store's own daily write limit. */
export interface EngineOnStore {
  readonly handler: StoreHandler;
  readonly caller: StoreCaller;
  /** The Store's own limit, as the engine is held to it now. Null while the
   *  Store has none and is held to the limit every Store has on this host. */
  ownLimit(): number | null;
  /**
   * Hold the Store to this limit of its own from now on, or with null to the
   * limit every Store has on this host. In this process only: nothing is
   * written, and the Store's next process reads what the disk holds.
   */
  hold(rows: number | null): void;
  /** Keep the Store's own limit on the disk, for every later process of the
   *  Store. THROWS when it cannot be written. */
  keep(rows: number): void;
}

/**
 * Put the engine on a Store that is open.
 *
 * THROWS when the settings do not say which Store this is, or the Store's own
 * write limit cannot be read: the Store is not opened then. A process that
 * does not know which Store it holds would take a call for any, and one that
 * cannot read its Store's limit would hold the Store to another.
 *
 * A limit that is kept is taken as it is, whatever whole number of rows: the
 * bounds hold where a limit is set (`isWriteLimit`). They can move from one
 * release to the next, and a Store whose limit was set under the old ones
 * must still open, or no ask could ever set it again.
 */
export function engineOnStore(
  context: Pick<StoreProgramContext, "storage" | "folder" | "settings" | "now" | "abort">,
  /** A seam for tests: the kinds of job the engine runs. */
  jobs: ReadonlyMap<string, JobHandler> = JOB_HANDLERS,
): EngineOnStore {
  const { storage, folder, settings, now, abort } = context;
  // Its own property, whatever the setting is called.
  const storeId = Object.hasOwn(settings, STORE_ID_SETTING) ? settings[STORE_ID_SETTING as keyof typeof settings] : undefined;
  if (typeof storeId !== "string" || storeId.length === 0) {
    throw Object.assign(new Error("a Store's process was not told its Store's id"), {
      code: "store_id_missing",
    });
  }
  const env: StoreEnv = { FILES: NO_FILES };
  let own: number | null = null;
  // The engine reads its limit by this name each time it looks, so a limit
  // that is handed over holds from the engine's next look on. It is always
  // handed one: with none, the engine would fall back on a default of its own.
  const hold = (rows: number | null): void => {
    env.STORE_DAILY_WRITE_LIMIT = String(rows ?? WRITE_LIMIT_DEFAULT);
    own = rows;
  };
  hold(readWriteLimit(folder));
  const state: StoreState = {
    storage,
    abort: (reason) => abort(reason),
    // This process runs one call at a time already, so the work runs as it
    // is. The engine hands its own start here. Where that fails, the engine
    // stays as it is and fails every call from then on: the platform it was
    // written for starts it anew after such a failure, and the engine counts
    // on that. Here the process is ended, and the next call gets a new one.
    blockConcurrencyWhile: async (work) => {
      try {
        return await work();
      } catch (thrown) {
        abort("the engine's start failed");
        throw thrown;
      }
    },
  };
  const handler = new StoreHandler(state, env, { now, randomHex, jobs });
  return {
    handler,
    caller: { storeId, actor: CONTROL_PLANE_ACTOR },
    ownLimit: () => own,
    hold,
    keep: (rows) => writeWriteLimit(folder, rows),
  };
}

export const engineProgram: StoreProgramFactory = (context): StoreProgram =>
  programOn(engineOnStore(context), context);

/** The program of a Store's process, on an engine that was put on the Store. */
export function programOn(engine: EngineOnStore, context: Pick<StoreProgramContext, "storage" | "now">): StoreProgram {
  const { handler, caller } = engine;

  /** The Store's numbers, with whose limit the day's limit is. */
  const stats = async (): Promise<StoreResult<Record<string, unknown> & { writes?: WritesHere }>> => {
    const answered = await handler.stats(caller);
    if (!answered.ok) return answered;
    const { writes, ...numbers } = answered.value;
    return {
      ok: true,
      value: writes ? { ...numbers, writes: { ...writes, own: engine.ownLimit() !== null } } : numbers,
    };
  };

  /**
   * Set the Store's own daily write limit.
   *
   * The engine's own checks come first, with its call for the Store's
   * numbers: that the call is for this Store, and that the Store is there.
   *
   * THE DISK COMES LAST. The engine is held to the new limit in this process,
   * and asked what it holds the Store to. Only when that is the new limit is
   * it kept on the disk, where it holds every later process of the Store. A
   * step that fails before that puts the old limit back, so a call that is
   * answered as failed has changed no limit.
   *
   * What the call itself wrote in the Store (the engine's counts, a wake) is
   * kept just before the limit is. The Store's process keeps a call's writes
   * only after the call, and ends itself when that keeping fails: with the
   * limit on the disk by then, a failed ask would leave it in force.
   *
   * What is left is the moment after the disk took the limit: a process that
   * is ended there keeps the limit, and its answer is lost. `stats` says the
   * limit that holds.
   */
  const setWriteLimit = async (rows: unknown): Promise<StoreResult<WritesHere>> => {
    if (!isWriteLimit(rows)) {
      return badRequest(`A Store's daily write limit is a whole number of rows from ${WRITE_LIMIT_MIN} to ${WRITE_LIMIT_MAX}.`);
    }
    const before = await handler.stats(caller);
    if (!before.ok) return before;
    const was = engine.ownLimit();
    engine.hold(rows);
    try {
      const after = await stats();
      if (!after.ok) {
        engine.hold(was);
        return after;
      }
      const { writes } = after.value;
      // The engine answers the limit it holds the Store to. It is the one that
      // was just handed over, or the engine no longer reads its limit there.
      if (!writes || writes.limit !== rows) {
        engine.hold(was);
        return { ok: false, status: 500, code: "internal", error: "The Store does not hold itself to the limit it was given." };
      }
      // Jobs that wait for the day's limit go on at the Store's next wake.
      // With the new limit above the day's writes, that wake is now.
      if (before.value.waitsUntil !== null && (before.value.writes?.rows ?? 0) < rows) {
        await handler.core.wakeAt(context.now());
      }
      // It throws when the Store cannot keep what this call wrote.
      context.storage.flush();
      engine.keep(rows);
      return { ok: true, value: writes };
    } catch (thrown) {
      engine.hold(was);
      throw thrown;
    }
  };

  const calls: Record<StoreCallName, (args: readonly unknown[]) => Promise<StoreResult<unknown>>> = {
    catalog: async (args) => catalogPage(await handler.catalog(caller), args.at(0), args.at(1)),
    stats,
    history: async () => historyHere(await handler.history(caller), context.storage.pointInTime),
    review: () => handler.review(caller),
    jobSummary: (args) => {
      const jobId = args.at(0);
      return typeof jobId === "string"
        ? handler.jobSummary(caller, jobId)
        : Promise.resolve(badRequest("A job is named by its id."));
    },
    setWriteLimit: (args) => setWriteLimit(args.at(0)),
  };

  return {
    call(name, args) {
      if (!Object.hasOwn(calls, name)) return badRequest("This Store's program takes no such call.");
      return calls[name as StoreCallName](args);
    },
    wake: () => handler.alarm(),
    // The engine keeps the day's count of written rows once a thousand wait,
    // or by its alarm a few seconds after a call. A process that is closed
    // before either keeps what waits now, so that no row it wrote goes
    // uncounted against the day's limit. It never throws.
    close: () => keepWriteCount(handler.core, { force: true }),
  };
}
