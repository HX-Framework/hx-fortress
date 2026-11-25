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
// WHAT WAITS FOR A PERSON. A delete, and a restore. The control plane can ask
// for either, and the ask only notes that it was asked. A person of this
// organization decides it (`decideDelete`, `decideRestore`).
//
// An approved delete is kept on the list first, with who approved it, and
// recorded. Only then is the Store's process ended and its folder removed,
// and its record last. A delete that was cut short is finished when the
// module next starts.
//
// A restore takes a Store back to the moment before a line of its history.
// The decision takes the request off the list before anything is done, so an
// approval is used once. The Store's own program then readies the restore,
// its process is closed, and the Store's file goes back as its next process
// opens it. The module opens it at once, and answers `restored` only when the
// Store's history has the line of the restore.
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
  ProcessRefused,
  type FortressModule,
  type ModuleContextV2,
  type ModuleStartContext,
  type Person,
  type ProcessRule,
} from "../../host/module-contract";
import { organizationMark } from "../../host/organization-id";
import type { MsgReply } from "../../protocol";
import {
  catalogAnswer,
  historyAnswer,
  jobAnswer,
  restoreAnswer,
  reviewAnswer,
  statsAnswer,
  writeLimitAnswer,
  type HistoryAnswer,
  type HistoryLine,
} from "./answers";
import { STORE_PROCESS_VERB } from "./host/process-protocol";
import { folderBytes, makeStoreFolder, SCRATCH_FOLDER, storeFolder } from "./host/store-folder";
import { StartRefused, StoreCallFailed, StoreStopped, type StartRefusal } from "./host/store-process";
import { CATALOG_PAGE_TABLES, STORES_MANIFEST, STORES_MODULE_ID } from "./manifest";
import {
  OpenStores,
  type OpenStoresOptions,
  type OpenStoresPort,
  type StoreOpener,
  type StorePlace,
} from "./open-stores";
import { recordedLogin, StoreRegistry, storeState, Turns, type StoreRecord } from "./registry";
import { readStoreAnswer, STORE_ID_SETTING, WRITE_LIMIT_DEFAULT, type StoreCallName } from "./store-calls";

/** The most rows a Store may be set to write in a day, until this
 *  organization sets a ceiling of its own. It is the limit every Store has. */
export const DEFAULT_WRITE_LIMIT_CEILING = WRITE_LIMIT_DEFAULT;

/** The level of the module's folder that holds the Stores' folders. */
const STORES_FOLDER = "stores";
/** The key of the module's own settings in its state. */
const SETTINGS_KEY = "settings";
/** How many Stores' folders `list` sizes at a time. */
const LIST_SIZED_AT_ONCE = 16;

/**
 * Why the module host started no process for a Store, as a Store's process
 * is told it (host/store-process.ts).
 *
 * The host starts none for a module whose own start has not ended, for one
 * that is stopping, and past the count of processes a module may run. Each of
 * these passes: the start can be asked for again soon. Every other rule is one
 * that the same start meets again: the word is not this module's, the names of
 * the folder are refused, the organization is not held any more, or this
 * program could not be started again. An ask is told such a rule by the
 * host's own word for it (`open-stores.ts`).
 */
export function startRefusal(rule: ProcessRule): StartRefusal {
  switch (rule) {
    case "module_not_running":
    case "processes_unavailable":
      return "later";
    case "folder_missing":
      return "folder_missing";
    default:
      return "unavailable";
  }
}

export interface StoresModuleDeps {
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
  /**
   * A person of this organization decides the restore that the control plane
   * asked for. The decision names the line of the Store's history that it is
   * for: when another line waits by now, nothing is decided
   * (`restore_changed`).
   *
   * Refused, the Store is as it was (`kept`). Approved, the Store goes back to
   * the moment before that line, and `to` is that moment's time. `restored`:
   * it went back, and its history has the line of the restore. `restoring`:
   * the restore is readied and the Store could not be opened again just now.
   * It goes back when it next is opened, and `history.read` then has the
   * line.
   *
   * THE STORE'S HISTORY SAYS WHETHER IT WENT BACK, not the answer of the call
   * that asked it to. The Store's program can ready a restore and then fail
   * its call, or lose its answer: the Store's process is closed all the same,
   * and the Store goes back as it is next opened. So the history is read
   * after EVERY outcome of that call, and a Store that has a new line of a
   * restore is told and recorded as `restored`, whatever the call said. `to`
   * is then the time of the line that was asked for.
   *
   * AN APPROVAL IS USED ONCE. The request leaves the list as the approval is
   * recorded, before the Store is touched. Where the restore then fails, the
   * failure is told and recorded, and the control plane has to ask again. So
   * no approval can take a Store back twice. A line that is no way back any
   * more (the Store keeps its newest snapshots only) fails this way too, as
   * `line_not_restorable`. What is left: the call failed AND the Store could
   * not be opened again to read its history. The failure is told then, and
   * `history.read` says later whether the Store went back.
   *
   * For an act of a person at this HX Fortress's console, as `decideDelete`.
   */
  decideRestore(
    ctx: ModuleContextV2,
    person: Person,
    store: string,
    line: string,
    approve: boolean,
  ): Promise<{ state: "kept" } | { state: "restored" | "restoring"; to: string }>;
}

/** The lines of restores in a history's answer, by id. */
function restoresIn(history: HistoryAnswer): Set<string> {
  return new Set(history.lines.filter((line) => line.kind === "restore").map((line) => line.id));
}

/** The line that `id` names in a history's answer, when the Store can be
 *  taken back to the moment before it. The one rule for "a way back", for the
 *  ask and for the decision. */
function wayBack(history: HistoryAnswer, id: string): HistoryLine | undefined {
  return history.lines.find((line) => line.id === id && line.restorable);
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

  /**
   * Where a Store is kept, and how its process is started: by the module
   * host, for the context's organization. The process is this same program,
   * started again with one word. The folder it is given is the Store's place
   * for SQLite's temporary files, named level by level, and the host makes
   * nothing on the disk for a start.
   */
  const placeOf = (ctx: ModuleContextV2, base: string, record: StoreRecord): StorePlace => ({
    root: path.join(base, record.folder),
    launcher: {
      start: async ({ onMessage }) => {
        try {
          return await ctx.processes.start(STORE_PROCESS_VERB, {
            folder: [STORES_FOLDER, record.folder, SCRATCH_FOLDER],
            onMessage,
          });
        } catch (thrown) {
          if (!(thrown instanceof ProcessRefused)) throw thrown;
          // The rule is one of the host's own fixed words. It goes with the
          // reason: a start that the same rule refuses again is told by the
          // host's word, as the host itself tells a call it refused.
          const why = startRefusal(thrown.rule);
          if (why !== "later") ctx.logger.warn("no process was started for a Store", { rule: thrown.rule });
          throw new StartRefused(why, thrown.rule);
        }
      },
    },
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
   *
   * With `later`, no alarm is read here: the reading of each Store's alarm is
   * put on that list, for the caller to do. The module's own start does so
   * (`init`), because an alarm that is due asks for a process at once.
   */
  async function watch(mine: Run, ctx: ModuleContextV2, later?: (() => void)[]): Promise<void> {
    const key = organizationKey(ctx);
    if (mine.watched.has(key)) return;
    mine.watched.add(key);
    try {
      for (const record of await turn(ctx, () => registryOf(ctx).deleting())) {
        await finishDelete(ctx, record);
      }
      await turn(ctx, async () => {
        const records = (await registryOf(ctx).list()).filter((record) => !record.deleting);
        if (records.length === 0) return;
        const base = await baseOf(ctx);
        for (const record of records) {
          const read = (): void =>
            mine.stores.watch(storeKey(ctx, record.id), path.join(base, record.folder), openerOf(ctx, record.id));
          if (later) later.push(read);
          else read();
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
        // The word the process gave for why it could not open the Store is
        // one of its own fixed words, or the host's: no value is in it.
        ctx.logger.warn("a Store's process stopped during a call", {
          call: name,
          why: thrown.why,
          ...(thrown.code !== null ? { code: thrown.code } : {}),
        });
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
    // meanwhile takes no bytes. A few folders are sized at a time: each
    // sizing reads the disk, and none depends on another.
    const bytes: number[] = [];
    for (let from = 0; from < records.length; from += LIST_SIZED_AT_ONCE) {
      const some = records.slice(from, from + LIST_SIZED_AT_ONCE);
      bytes.push(
        ...(await Promise.all(
          some.map((record) => (base === null ? 0 : folderBytes(path.join(base, record.folder)))),
        )),
      );
    }
    const stores = records.map((record, at) => ({
      store: record.id,
      ...(record.name === undefined ? {} : { name: record.name }),
      state: storeState(record),
      bytes: bytes.at(at) ?? 0,
      createdAt: record.createdAt,
      ...(record.restoreAsked === undefined ? {} : { restoreAsked: record.restoreAsked }),
    }));
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
    // The Store first: an ask that names a Store which is not there says so,
    // whatever else it holds.
    await turn(ctx, () => registryOf(ctx).need(args.store));
    if (args.rows > (await writeLimitCeiling(ctx))) throw new AskFailure("above_ceiling");
    const answer = writeLimitAnswer(await storeCall(mine, ctx, args.store, "setWriteLimit", [args.rows]));
    ctx.audit.record("store.write_limit.set", { target: args.store, rows: args.rows });
    return answer;
  }

  /**
   * Note that the control plane asked to take a Store back. The line has to be
   * one the Store can be taken back to now, as `history.read` answers it: a
   * request for any other could never be carried out, and a person would be
   * shown it all the same.
   */
  async function askRestore(
    mine: Run,
    ctx: ModuleContextV2,
    args: { store: string; line: string },
  ): Promise<unknown> {
    const told = historyAnswer(await storeCall(mine, ctx, args.store, "history"));
    if (!wayBack(told, args.line)) throw new AskFailure("line_not_restorable");
    const { record, asked, first } = await turn(ctx, () =>
      registryOf(ctx).askRestore(args.store, args.line, clock()),
    );
    if (first) ctx.audit.record("store.restore.asked", { target: record.id, line: asked.line });
    return { store: record.id, line: asked.line, askedAt: asked.at };
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
          // The key is an organization's id and a Store's id, and `why` is
          // one word for how the last try failed: no row's value.
          onAlarmLost: (key, why) =>
            context.logger.error(
              "a Store could not be woken for its alarm after every try. It is woken again when " +
                "a call changes its alarm, or when HX Fortress starts again.",
              { store: key, why },
            ),
        }),
        watched: new Set(),
      };
      run = mine;
      // Work that no ask started, for every organization the module is on for.
      //
      // THE ALARMS ARE READ LAST, with no wait after them. An alarm that is
      // due asks for a process at once, and the module host starts none for a
      // module whose own start has not ended: it refuses, and records that it
      // did. Read while the next organization is still looked over, a due
      // alarm of the first would meet exactly that. Read here, its timer
      // fires only after this start has returned.
      const alarms: (() => void)[] = [];
      for (const ctx of await context.organizations()) await watch(mine, ctx, alarms);
      for (const read of alarms) read();
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
        case "restore":
          return askRestore(mine, ctx, args as { store: string; line: string });
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

    async decideRestore(ctx, person, storeId, line, approve) {
      if (person.role !== "operator") throw new AskFailure("not_allowed");
      const by = recordedLogin(person.login);
      /** Take the request off the list, and record the decision at once. */
      const decide = (action: string): Promise<void> =>
        turn(ctx, async () => {
          const taken = await registryOf(ctx).takeRestore(storeId, line);
          ctx.audit.record(action, { target: taken.record.id, line, by });
        });
      if (!approve) {
        await decide("store.restore.refused");
        return { state: "kept" };
      }
      // A restore needs the Store's process, so one is approved only while
      // the module runs.
      const mine = run;
      if (!mine) throw new AskFailure("stores_stopping");
      // Before the decision is kept: the Store's history as it is now. A Store
      // that cannot answer this (no room for its process, a file that does not
      // open) keeps its request, and can be decided later.
      const told = historyAnswer(await storeCall(mine, ctx, storeId, "history"));
      const before = restoresIn(told);
      await decide("store.restore.approved");
      const failed = (code: string): void =>
        ctx.audit.record("store.restore.failed", { target: storeId, line, by, code });
      // The line was a way back when it was asked for. The Store keeps its
      // newest snapshots only, so it may be none by now.
      const asked = wayBack(told, line);
      if (!asked) {
        failed("line_not_restorable");
        throw new AskFailure("line_not_restorable");
      }
      // What the Store's program answered: the time of the moment the Store
      // goes back to, or why the call failed.
      let answered: string | null = null;
      let refused: unknown = null;
      try {
        answered = restoreAnswer(await storeCall(mine, ctx, storeId, "restore", [line])).to;
      } catch (thrown) {
        refused = thrown;
      }
      // The moment before the line: the line's own time, where the program's
      // answer is not there to say it.
      const to = answered ?? asked.at;
      // Whatever the call answered, the Store's history says whether the
      // Store went back. Where a restore was readied, the Store's process was
      // closed with the call's answer: this call starts the next one, and the
      // Store's file goes back as that process opens it.
      let after: HistoryAnswer | null = null;
      try {
        after = historyAnswer(await storeCall(mine, ctx, storeId, "history"));
      } catch (thrown) {
        ctx.logger.warn("a Store could not be opened again after a restore was asked of it", failureForLog(thrown));
      }
      // The engine writes the line of a restore only into a Store that went
      // back.
      if (after !== null && [...restoresIn(after)].some((id) => !before.has(id))) {
        ctx.audit.record("store.restored", { target: storeId, line, by, to });
        return { state: "restored", to };
      }
      if (refused !== null) {
        failed(refused instanceof AskFailure ? refused.code : "internal");
        throw refused;
      }
      if (after === null) {
        ctx.audit.record("store.restore.readied", { target: storeId, line, by, to });
        return { state: "restoring", to };
      }
      // Readied, and the Store opened without it: the copy and the snapshot
      // were gone or damaged, and the Store is as it was.
      failed("restore_not_done");
      throw new AskFailure("restore_not_done");
    },
  };
}
