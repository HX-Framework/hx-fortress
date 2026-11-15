// The Stores module: working copies of tables, each in one SQLite file on
// this HX Fortress's disk.
//
// What the control plane can do here is the list of asks in manifest.ts, and
// nothing else. Each ask is for one organization, and is answered from that
// organization's own list of Stores and its own folder: the module host hands
// both to the module for the organization an ask is for, and the module has no
// call that takes an organization's id.
//
// WHERE A STORE'S ROWS ARE. In the Store's file, and in the Store's own
// process while a call runs. The module in this process asks that process a
// closed list of questions (store-calls.ts) and builds every answer from
// checked values (answers.ts). No row is read into this process for an ask.
//
// WHAT WAITS FOR A PERSON. A delete. The control plane can ask for one, and
// the ask only notes that it was asked. A person of this organization decides
// it (`decideDelete`). An approved delete is kept on the list first, with who
// approved it, and recorded. Only then is the Store's process ended and its
// folder removed, and its record last. A delete that was cut short is
// finished when the module next starts.
//
// ONE THING AT A TIME FOR AN ORGANIZATION'S LIST. A change to the list, and
// every look at it that goes on to start a Store's process or to make a
// folder, takes the organization's turn (`Turns`). So a delete never comes
// between finding a Store on the list and opening it. A call's own run is not
// part of the turn: calls of different Stores run side by side, and a Store
// that has a process is called without a look at the list.
//
// WHO MAKES A STORE'S FOLDER. `create`, once, and it has to be new. Nothing
// else makes it: not an ask for a Store that is there, not an alarm, and not
// the start of a Store's process. So a Store that is off the list has no
// folder made for it again. Opening a Store puts back only a level under its
// folder that held nothing and is missing, as after a copy of the disk that
// left empty folders out. A Store whose folder or file is gone is not opened.
//
// FROM A START TO A STOP. The module host starts this module, and stops it
// when somebody switches it off, and may start the same object again. What is
// open belongs to one start (`Run`). After a stop nothing is opened until the
// next start, also not by an ask that was let in just before the stop.

import { rm } from "node:fs/promises";
import path from "node:path";

import {
  AskFailure,
  failureForLog,
  FolderRefused,
  type FortressModule,
  type ModuleContextV2,
  type ModuleStartContext,
  type Person,
} from "../../host/module-contract";
import { organizationMark } from "../../host/organization-id";
import type { MsgReply } from "../../protocol";
import {
  catalogAnswer,
  historyAnswer,
  jobAnswer,
  reviewAnswer,
  statsAnswer,
  writeLimitAnswer,
} from "./answers";
import { STORE_PROCESS_VERB } from "./host/process-protocol";
import { folderBytes, makeStoreFolder, SCRATCH_FOLDER, storeFolder } from "./host/store-folder";
import { StoreCallFailed, StoreStopped, type StoreChild } from "./host/store-process";
import { CATALOG_PAGE_TABLES, STORES_MANIFEST, STORES_MODULE_ID } from "./manifest";
import {
  OpenStores,
  type OpenStoresOptions,
  type OpenStoresPort,
  type StoreOpener,
  type StorePlace,
} from "./open-stores";
import { recordedLogin, StoreRegistry, storeState, Turns, type StoreRecord } from "./registry";
import { readStoreAnswer, type StoreCallName } from "./store-calls";

/** The most rows a Store may be set to write in a day, until this
 *  organization sets a ceiling of its own. It is the limit every Store has. */
export const DEFAULT_WRITE_LIMIT_CEILING = 2_000_000;

/** The level of the module's folder that holds the Stores' folders. */
const STORES_FOLDER = "stores";
/** The key of the module's own settings in its state. */
const SETTINGS_KEY = "settings";
/** The name a Store's id is told to its process by, when it is opened. */
export const STORE_ID_SETTING = "store";

/**
 * How the module host starts a process for a module: this same program,
 * started again with one word, in a folder of the context's organization that
 * the module names level by level.
 *
 * IT MAKES NOTHING ON THE DISK. The folder is there already, made by the
 * module. A start whose folder is not there is refused.
 *
 * The host is to give this on every context. Until it does, the module is
 * handed it apart from the context: by a test's stand-in today, and by nothing
 * in the daemon.
 */
export interface ModuleProcesses {
  start(
    ctx: ModuleContextV2,
    verb: string,
    options: { folder: readonly string[]; onMessage(message: unknown): void },
  ): Promise<StoreChild>;
}

export interface StoresModuleDeps {
  /** How a Store's process is started: the module host's to give. Left out,
   *  no Store is opened, and an ask that needs one fails with one word. */
  processes?: ModuleProcesses;
  /** Makes the open Stores for one start of the module. Left out, the module
   *  makes its own. A test gives one. */
  open?: (options: OpenStoresOptions) => OpenStoresPort;
  /** How many Stores are open at once before the one used longest ago is
   *  closed. Left out, eight. */
  maxOpen?: number;
  clock?: () => Date;
}

export interface StoresModule extends FortressModule {
  /**
   * A person of this organization decides a delete that the control plane
   * asked for. Refused, the Store is as it was (`kept`). Approved, the Store
   * takes no call from then on, its process is ended, its folder is removed
   * and it leaves the list (`deleted`). Where the folder could not be removed,
   * the Store stays on the list as `deleting`, and the next start of the
   * module, or the same decision again, goes on with it.
   *
   * For an act of a person at this HX Fortress's console. No ask reaches it,
   * and the manifest lists no act yet, so nothing in the daemon calls it.
   */
  decideDelete(
    ctx: ModuleContextV2,
    person: Person,
    store: string,
    approve: boolean,
  ): Promise<{ state: "deleted" | "kept" | "deleting" }>;
}

/** What is open, from one start of the module to its stop. */
interface Run {
  stores: OpenStoresPort;
  /** The organizations whose Stores were looked over since this start. */
  watched: Set<string>;
}

/** The organization's part of a Store's key. The own organization's id is not
 *  read for it: reading it makes one, and nothing here needs it. No id is
 *  empty, so the own organization's part is the empty word. */
function organizationKey(ctx: ModuleContextV2): string {
  return organizationMark(ctx.organization) ?? "";
}

/** A Store's key among the open Stores: its organization, and the control
 *  plane's id for it. Neither holds a slash. */
function storeKey(ctx: ModuleContextV2, id: string): string {
  return `${organizationKey(ctx)}/${id}`;
}

export function createStoresModule(deps: StoresModuleDeps = {}): StoresModule {
  const clock = deps.clock ?? ((): Date => new Date());
  const turns = new Turns();
  const { processes } = deps;
  const makeOpen = deps.open ?? ((options: OpenStoresOptions): OpenStoresPort => new OpenStores(options));
  /** Null before the first start, and between a stop and the next start. */
  let run: Run | null = null;
  /** Settles when every stop that was begun has ended. A stop takes a moment:
   *  a call that is running is given time to end. Until this settles, a
   *  process of a start that was stopped may still run. */
  let stopped: Promise<void> = Promise.resolve();

  const registryOf = (ctx: ModuleContextV2): StoreRegistry =>
    new StoreRegistry(ctx.state, (thrown) =>
      ctx.logger.warn(
        "an organization's list of Stores cannot be used",
        thrown === undefined ? { code: "not_a_list" } : failureForLog(thrown),
      ),
    );
  /** One thing at a time for the context's organization. */
  const turn = <T>(ctx: ModuleContextV2, work: () => Promise<T>): Promise<T> =>
    turns.run(organizationKey(ctx), work);
  /** The folder that holds the folders of the organization's Stores. The
   *  module host makes it when it is not there. A Store's own folder is a
   *  level under it, and only `create` makes that. */
  const baseOf = (ctx: ModuleContextV2): Promise<string> => ctx.folder(STORES_FOLDER);

  /** Where a Store is kept, and how its process is started. */
  const placeOf = (ctx: ModuleContextV2, base: string, record: StoreRecord): StorePlace => ({
    root: path.join(base, record.folder),
    launcher: processes
      ? {
          start: ({ onMessage }) =>
            processes.start(ctx, STORE_PROCESS_VERB, {
              folder: [STORES_FOLDER, record.folder, SCRATCH_FOLDER],
              onMessage,
            }),
        }
      : null,
    // The Store's program is told the Store's id, and takes calls for no other.
    settings: { [STORE_ID_SETTING]: record.id },
  });

  /**
   * The way to one Store, for a call and for the Store's alarm: the look at
   * the list and the hand-over, in the organization's turn. The context is
   * kept with it: an alarm starts the Store's process when no ask is running,
   * for the same organization. It answers null for a Store that takes no call
   * any more, and for an organization this HX Fortress no longer holds.
   */
  const openerOf =
    (ctx: ModuleContextV2, id: string): StoreOpener =>
    (hand) =>
      turn(ctx, async () => {
        let record: StoreRecord;
        try {
          record = await registryOf(ctx).need(id);
        } catch (thrown) {
          if (thrown instanceof AskFailure && thrown.code === "store_unknown") return null;
          throw thrown;
        }
        let base: string;
        try {
          base = await baseOf(ctx);
        } catch (thrown) {
          // The host gives an organization it no longer holds no folder.
          if (thrown instanceof FolderRefused) return null;
          throw thrown;
        }
        return hand(placeOf(ctx, base, record));
      });

  /**
   * Go on with a delete that a person approved: end the Store's process,
   * remove its folder, and take its record off the list last. Where the folder
   * cannot be removed, the record stays, and this is done again later.
   *
   * Two of these may run for one Store: a person decides again, or the module
   * starts while a decision is being carried out. Each one checks the list
   * first, so the one that comes late touches nothing: by then the Store's id
   * may name a new Store.
   */
  async function finishDelete(ctx: ModuleContextV2, record: StoreRecord): Promise<"deleted" | "deleting"> {
    const ending = await turn(ctx, async () => {
      const waiting = await registryOf(ctx).deleting();
      if (!waiting.some((one) => one.id === record.id && one.folder === record.folder)) return null;
      // The Store takes no call since its record says so, and nothing opens it
      // again. So a process of it belongs to the start that is running now, or
      // to one whose stop is still under way. Both are waited for.
      const gone = Promise.all([run?.stores.remove(storeKey(ctx, record.id)), stopped]);
      // Awaited below, once the turn has ended.
      gone.catch(() => undefined);
      return { gone };
    });
    // Another one finished this delete.
    if (ending === null) return "deleted";
    // No process of the Store runs when this has returned.
    await ending.gone;
    try {
      const base = await baseOf(ctx);
      await rm(path.join(base, record.folder), { recursive: true, force: true });
    } catch (thrown) {
      ctx.logger.error("a deleted Store's folder could not be removed", {
        folder: record.folder,
        ...failureForLog(thrown),
      });
      return "deleting";
    }
    const forgotten = await turn(ctx, () => registryOf(ctx).forget(record.id, record.folder));
    // Recorded once, by the one that took the Store off the list.
    if (forgotten) {
      ctx.audit.record("store.deleted", {
        target: record.id,
        by: record.deleting?.by ?? "unknown",
      });
    }
    return "deleted";
  }

  /**
   * Look over the Stores of the context's organization, once for each start:
   * a delete that was cut short is finished, and each Store's alarm is read.
   */
  async function watch(mine: Run, ctx: ModuleContextV2): Promise<void> {
    const key = organizationKey(ctx);
    if (mine.watched.has(key)) return;
    mine.watched.add(key);
    try {
      for (const record of await turn(ctx, () => registryOf(ctx).deleting())) {
        await finishDelete(ctx, record);
      }
      // With no way to start a process, no Store could be woken.
      if (!processes) return;
      await turn(ctx, async () => {
        const records = (await registryOf(ctx).list()).filter((record) => !record.deleting);
        if (records.length === 0) return;
        const base = await baseOf(ctx);
        for (const record of records) {
          mine.stores.watch(
            storeKey(ctx, record.id),
            path.join(base, record.folder),
            openerOf(ctx, record.id),
          );
        }
      });
    } catch (thrown) {
      mine.watched.delete(key);
      // The ask that needs the list says so itself.
      ctx.logger.warn("an organization's Stores could not be looked over", failureForLog(thrown));
    }
  }

  /**
   * Ask the program of one Store one thing, and answer its value.
   *
   * Every failure leaves here as one word. The program's own sentence about a
   * refusal, and the message of whatever it threw, stay behind: either can
   * hold a table's name or a value.
   */
  async function storeCall(
    mine: Run,
    ctx: ModuleContextV2,
    storeId: string,
    name: StoreCallName,
    args: readonly unknown[] = [],
  ): Promise<unknown> {
    let raw: unknown;
    try {
      raw = await mine.stores.call(storeKey(ctx, storeId), openerOf(ctx, storeId), name, args);
    } catch (thrown) {
      if (thrown instanceof AskFailure) throw thrown;
      if (thrown instanceof StoreStopped) {
        ctx.logger.warn("a Store's process stopped during a call", { call: name, why: thrown.why });
        throw new AskFailure(thrown.why === "limit" ? "store_timeout" : "store_stopped");
      }
      if (thrown instanceof StoreCallFailed) {
        ctx.logger.warn("a Store's call failed", { call: name, code: thrown.code });
        throw new AskFailure("store_failed");
      }
      throw thrown;
    }
    const answer = readStoreAnswer(raw);
    if (answer.ok === true) return answer.value;
    if (answer.ok === null) throw new AskFailure("store_answer_unreadable");
    // The program's own word for its refusal, from a closed list, marked as
    // the program's.
    throw new AskFailure(`engine_${answer.code}`);
  }

  function create(ctx: ModuleContextV2, args: { store: string; name?: string }): Promise<unknown> {
    return turn(ctx, async () => {
      const base = await baseOf(ctx);
      const made = await registryOf(ctx).create(args.store, args.name, clock(), (folder) => {
        const root = path.join(base, folder);
        // New, or not at all: a folder that is there holds another Store's file.
        if (!makeStoreFolder(storeFolder(root))) return false;
        // The way back, for this folder alone, when the list cannot be written.
        return { remove: () => rm(root, { recursive: true, force: true }) };
      });
      if (made.created) ctx.audit.record("store.create", { target: made.record.id });
      return { store: made.record.id, state: storeState(made.record), created: made.created };
    });
  }

  async function list(ctx: ModuleContextV2): Promise<unknown> {
    const { records, base } = await turn(ctx, async () => {
      const found = await registryOf(ctx).list();
      return { records: found, base: found.length === 0 ? null : await baseOf(ctx) };
    });
    // Sized after the turn, so that an organization's other asks do not wait
    // for the disk. Nothing here makes a folder: a Store that was removed
    // meanwhile takes no bytes.
    const stores = [];
    for (const record of records) {
      stores.push({
        store: record.id,
        ...(record.name === undefined ? {} : { name: record.name }),
        state: storeState(record),
        bytes: base === null ? 0 : await folderBytes(path.join(base, record.folder)),
        createdAt: record.createdAt,
      });
    }
    return { stores };
  }

  async function writeLimitCeiling(ctx: ModuleContextV2): Promise<number> {
    const settings = await ctx.state.read<{ writeLimitCeiling?: unknown } | null>(SETTINGS_KEY);
    const own = settings?.writeLimitCeiling;
    return typeof own === "number" && Number.isSafeInteger(own) && own >= 0
      ? own
      : DEFAULT_WRITE_LIMIT_CEILING;
  }

  async function setWriteLimit(
    mine: Run,
    ctx: ModuleContextV2,
    args: { store: string; rows: number },
  ): Promise<unknown> {
    if (args.rows > (await writeLimitCeiling(ctx))) throw new AskFailure("above_ceiling");
    const answer = writeLimitAnswer(await storeCall(mine, ctx, args.store, "setWriteLimit", [args.rows]));
    ctx.audit.record("store.write_limit.set", { target: args.store, rows: args.rows });
    return answer;
  }

  async function askDelete(ctx: ModuleContextV2, args: { store: string }): Promise<unknown> {
    const { record, first } = await turn(ctx, () => registryOf(ctx).askDelete(args.store, clock()));
    if (first) ctx.audit.record("store.delete.asked", { target: record.id });
    return { store: record.id, state: storeState(record) };
  }

  return {
    id: STORES_MODULE_ID,
    manifest: STORES_MANIFEST,

    async init(context: ModuleStartContext): Promise<void> {
      const mine: Run = {
        stores: makeOpen({
          ...(deps.maxOpen !== undefined ? { maxOpen: deps.maxOpen } : {}),
          // The key is an organization's id and a Store's id: no row's value.
          onAlarmLost: (key) =>
            context.logger.error(
              "a Store could not be woken for its alarm after every try. It is woken again when " +
                "a call changes its alarm, or when HX Fortress starts again.",
              { store: key },
            ),
        }),
        watched: new Set(),
      };
      run = mine;
      // Work that no ask started, for every organization the module is on for.
      for (const ctx of await context.organizations()) await watch(mine, ctx);
    },

    async stop(): Promise<void> {
      // Nothing is opened from here on, until the next start. An ask that was
      // let in just before this finds no run, or one that opens nothing more.
      const ending = run;
      run = null;
      if (ending) {
        const ended = ending.stores.stop();
        // A delete that is decided meanwhile waits for this.
        stopped = Promise.all([stopped, ended.catch(() => undefined)]).then(() => undefined);
        await ended;
      }
      await stopped;
    },

    // The control plane reaches a module through `onAsk`, behind the gate, and
    // through nothing else.
    onMessage(): MsgReply {
      return { ok: false, error: "ask_unknown" };
    },

    async onAsk(ask: string, args: unknown, ctx: ModuleContextV2): Promise<unknown> {
      // Read once, before the first wait: this ask belongs to the start it
      // came in.
      const mine = run;
      if (!mine) throw new AskFailure("stores_stopping");
      await watch(mine, ctx);
      const store = (args as { store: string }).store;
      switch (ask) {
        case "create":
          return create(ctx, args as { store: string; name?: string });
        case "list":
          return list(ctx);
        case "catalog.read": {
          const { page } = args as { page: number };
          // The Store's program answers the page's tables, and how many the
          // Store has in all.
          const answered = await storeCall(mine, ctx, store, "catalog", [
            page * CATALOG_PAGE_TABLES,
            CATALOG_PAGE_TABLES,
          ]);
          return catalogAnswer(answered, page);
        }
        case "stats.read":
          return statsAnswer(await storeCall(mine, ctx, store, "stats"));
        case "history.read":
          return historyAnswer(await storeCall(mine, ctx, store, "history"));
        case "review.read":
          return reviewAnswer(await storeCall(mine, ctx, store, "review"));
        case "job.read":
          return jobAnswer(
            await storeCall(mine, ctx, store, "jobSummary", [(args as { job: string }).job]),
          );
        case "write_limit.set":
          return setWriteLimit(mine, ctx, args as { store: string; rows: number });
        case "delete":
          return askDelete(ctx, args as { store: string });
        default:
          // The gate refuses an ask the manifest does not list before it gets
          // here. This is the same answer for a manifest and a switch that
          // have drifted apart.
          throw new AskFailure("ask_not_implemented");
      }
    },

    async decideDelete(ctx, person, storeId, approve) {
      if (person.role !== "operator") throw new AskFailure("not_allowed");
      const decided = await turn(ctx, async () => {
        const made = await registryOf(ctx).decide(storeId, approve, person.login, clock());
        // Recorded as soon as the decision is kept, before anything is removed.
        if (made.first) {
          ctx.audit.record(made.outcome === "kept" ? "store.delete.refused" : "store.delete.approved", {
            target: made.record.id,
            by: recordedLogin(person.login),
          });
        }
        return made;
      });
      if (decided.outcome === "kept") return { state: "kept" };
      return { state: await finishDelete(ctx, decided.record) };
    },
  };
}
