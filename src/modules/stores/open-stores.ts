// The open Stores of this HX Fortress.
//
// A Store is opened by its first call: a process of its own is started for it
// (host/store-process.ts), and that process is closed again when no call has
// come for a while. This file keeps the processes that are open now, for every
// organization, and the one alarm of each Store.
//
// A KEY names a Store here. The module makes it (module.ts) and nothing else
// reads it.
//
// A STORE IS OPENED ONLY THROUGH ITS OPENER. Starting a process for a Store
// needs the Store's place: its folder, and the way the module host starts its
// process. The module hands that over inside the turn of the Store's
// organization, after it has found the Store on its list (`StoreOpener`). So a
// Store that left the list, or whose organization left this HX Fortress, is
// never opened again: not by an ask, and not by its own alarm, which asks the
// same way each time it is due. This file remembers no place.
//
// HOW MANY PROCESSES RUN AT ONCE IS BOUNDED, because a Store's process takes
// memory, and the number of them must not be the caller's to choose.
//
//   • Past the bound, the Store that was used longest ago and has no call
//     running is closed, and so on until the bound holds.
//   • A Store with a call running is never closed for this. So the bound can
//     be passed while calls run, up to twice the bound. There, a call that
//     would start one more process is refused as busy, and every Store that
//     is not in use is asked to close, so that a later call finds room. A
//     process that was asked to close counts until it is gone, and so does a
//     start that is on its way.
//   • An alarm that is due and finds no room is not refused: it waits, and
//     looks again.
//   • A start that is still on its way for a Store that was removed meanwhile
//     counts until the module host has answered it. Its process, if one comes,
//     is ended before it is told of any Store.
//
// HOW MANY CALLS WAIT FOR ONE STORE IS BOUNDED TOO. A Store runs one call at a
// time. Each call that waits holds one of the places the module host has for
// asks, for every module together, so one Store that answers slowly must not
// take them all. Past the bound a call is refused as busy.
//
// THIS FILE STARTS NO PROCESS. With each Store it is handed the way the module
// host starts that Store's process. Handed none, it opens no Store, and says
// so with one word.
//
// ONE OF THESE IS USED FROM A MODULE'S START TO ITS STOP. After `stop` it
// opens nothing more. A module that is started again makes a new one.

import { AskFailure } from "../../host/module-contract";
import { StoreAlarms, WakeLater } from "./host/alarms";
import { mendStoreFolder, readAlarm, storeFolder } from "./host/store-folder";
import { StoreCallFailed, StoreProcess, StoreStopped, type StoreLauncher } from "./host/store-process";

/** How many Stores are open at once before the one used longest ago is closed. */
export const MAX_OPEN_STORES = 8;
/** How many calls may wait behind the one that runs, for one Store. */
export const MAX_WAITING_CALLS = 8;
/** How long a call that is running when everything stops is given to end. */
export const STOP_WITHIN_MS = 3_000;
/**
 * The longest a call may take from its hand-over to its answer. It is under
 * the 25 seconds the module host gives an ask, so that an ask whose call is
 * too slow is told so by this module, and its place at the host is free again
 * when the host has answered.
 */
export const CALL_LIMIT_MS = 20_000;
/** The longest a Store's process may take to start and open the Store. */
export const START_LIMIT_MS = 10_000;

/** Where a Store is kept, and how its process is started. */
export interface StorePlace {
  /** The Store's folder. Only the making of a Store makes it: one that is
   *  gone is not opened, and not made again. */
  root: string;
  /** How the Store's process is started: the module host's to give, for the
   *  Store's organization. Null while it gives none. */
  launcher: StoreLauncher | null;
  /** What the Store's program is opened with. */
  settings?: Readonly<Record<string, string>>;
}

/**
 * The way to a Store, asked each time a process is to be started for it.
 *
 * It looks the Store up, and runs `hand` with the Store's place if the Store
 * is still there: in the turn of the Store's organization, so that nothing
 * can remove the Store between the look and the hand-over. It answers what
 * `hand` answered. It answers null, and does not run `hand`, when the Store is
 * not there any more.
 */
export type StoreOpener = <T extends object>(hand: (place: StorePlace) => T) => Promise<T | null>;

/** What the module needs of the open Stores. A test gives its own. */
export interface OpenStoresPort {
  /**
   * Run one call of the Store's program. The Store's process is started when
   * it has none, through `opener`.
   *
   * Rejects with `AskFailure`: `store_unknown` when the Store is not there,
   * `busy` when there is no room, `store_process_unavailable`,
   * `store_folder_missing`, `stores_stopping`. Rejects with what the Store's
   * process rejects with otherwise (host/store-process.ts).
   */
  call<T = unknown>(
    key: string,
    opener: StoreOpener,
    name: string,
    args?: readonly unknown[],
  ): Promise<T>;
  /** A Store the module knows of: its alarm is read from its folder, and kept. */
  watch(key: string, root: string, opener: StoreOpener): void;
  /** A Store was removed: its process is ended now, and its alarm forgotten.
   *  When this has returned, no process of the Store runs. */
  remove(key: string): Promise<void>;
  /** End every process, and open nothing more. Never rejects. */
  stop(): Promise<void>;
}

export interface OpenStoresOptions {
  /** How many Stores are open at once before the one used longest ago is
   *  closed. Twice as many is the most that ever run. */
  maxOpen?: number;
  /** How many calls may wait for one Store. */
  maxWaiting?: number;
  /** The longest one call may take, from its hand-over, in milliseconds. */
  limitMs?: number;
  /** The longest a Store's process may take to start and open the Store. */
  startLimitMs?: number;
  /** A Store's process is closed when no call came for this long. */
  idleMs?: number;
  /** How long a call that is running when everything stops is given to end. */
  stopWithinMs?: number;
  /** Told when a Store could not be woken for its alarm, after every try,
   *  with the one word for why the last try failed. */
  onAlarmLost?: (key: string, why: string) => void;
  /** The wait before a wake is tried again, for a test that cannot wait. */
  alarmRetryBaseMs?: number;
}

/** The one word a wake that failed is told by. Never the failure's message:
 *  that can hold a value. */
function failureWord(thrown: unknown): string {
  if (thrown instanceof StoreStopped) return thrown.code ?? thrown.why;
  if (thrown instanceof StoreCallFailed || thrown instanceof AskFailure) return thrown.code;
  return "internal";
}

/** A process runs for the Store, or a call of the Store waits for one. */
function isLive(process: StoreProcess): boolean {
  return process.isOpen || process.isBusy;
}

/** The Store's process is not on its way out: it was not asked to close, or a
 *  call waits that will start it again. */
function stays(process: StoreProcess): boolean {
  return process.isBusy || (process.isOpen && !process.isClosing);
}

export class OpenStores implements OpenStoresPort {
  private readonly options: OpenStoresOptions;
  /**
   * The Stores that have a process, or a call that waits for one, each with
   * its process. In the order of their last use: a Store that is used is put
   * at the end, so the first one is the one used longest ago.
   */
  private readonly open = new Map<string, StoreProcess>();
  /** How many starts are still on their way for Stores that were removed. */
  private leaving = 0;
  /** The opener of every Store that has a process or an alarm. */
  private readonly openers = new Map<string, StoreOpener>();
  /** Why the last wake of a Store failed, until one goes well or its alarm
   *  is given up. */
  private readonly wakeFailed = new Map<string, string>();
  private readonly alarms: StoreAlarms;
  /** Set once `stop` was called. Settles when every process is gone. */
  private stopping: Promise<void> | null = null;

  constructor(options: OpenStoresOptions = {}) {
    this.options = options;
    this.alarms = new StoreAlarms({
      wake: (key) => this.wake(key),
      onGiveUp: (key) => {
        const why = this.wakeFailed.get(key) ?? "internal";
        this.wakeFailed.delete(key);
        options.onAlarmLost?.(key, why);
      },
      ...(options.alarmRetryBaseMs !== undefined ? { retryBaseMs: options.alarmRetryBaseMs } : {}),
    });
  }

  private get maxOpen(): number {
    return this.options.maxOpen ?? MAX_OPEN_STORES;
  }

  /** How many Stores have a process now, or a call that waits for one, and
   *  how many starts are still on their way for Stores that were removed. */
  get openCount(): number {
    let count = this.leaving;
    for (const process of this.open.values()) if (isLive(process)) count += 1;
    return count;
  }

  /** When the Store named `key` is woken next, or null. */
  alarmOf(key: string): number | null {
    return this.alarms.at(key);
  }

  async call<T = unknown>(
    key: string,
    opener: StoreOpener,
    name: string,
    args: readonly unknown[] = [],
  ): Promise<T> {
    if (this.stopping) throw new AskFailure("stores_stopping");
    // A Store that has a process is called at once: its place is not needed.
    const live = this.open.get(key);
    if (live && isLive(live)) return this.take(key, live).call<T>(name, args);
    const handed = await opener((place) => {
      const answer = this.use(key, place, opener).call<T>(name, args);
      // Awaited below, once the opener's turn has ended. Until then its
      // failure is not one that nobody handles.
      answer.catch(() => undefined);
      return { answer };
    });
    if (handed === null) throw new AskFailure("store_unknown");
    return handed.answer;
  }

  watch(key: string, root: string, opener: StoreOpener): void {
    if (this.stopping) return;
    const at = readAlarm(storeFolder(root));
    if (at === null) return;
    this.openers.set(key, opener);
    this.alarms.set(key, at);
  }

  /**
   * The Store's process, for one call that the caller makes at once. A process
   * is made for a Store that has none. Run inside the opener's turn.
   * THROWS when the call cannot be taken.
   */
  private use(key: string, place: StorePlace, opener: StoreOpener): StoreProcess {
    if (this.stopping) throw new AskFailure("stores_stopping");
    const { launcher } = place;
    if (launcher === null) throw new AskFailure("store_process_unavailable");
    let process = this.open.get(key);
    // This call starts one more process, unless the Store has one or a call of
    // it waits for one already. Twice the bound is the most that ever run.
    const live = process !== undefined && isLive(process);
    if (!live && this.openCount >= this.maxOpen * 2) {
      this.trim(key);
      throw new AskFailure("busy");
    }
    if (!process) {
      const folder = storeFolder(place.root);
      // The folder is made when the Store is made, and by nothing else. One
      // that is gone, or whose file is gone, is not made again here. Only a
      // level under it that held nothing is put back.
      if (!mendStoreFolder(folder)) throw new AskFailure("store_folder_missing");
      const made = new StoreProcess({
        folder: folder.root,
        launcher,
        limitMs: this.options.limitMs ?? CALL_LIMIT_MS,
        startLimitMs: this.options.startLimitMs ?? START_LIMIT_MS,
        ...(place.settings ? { settings: place.settings } : {}),
        ...(this.options.idleMs !== undefined ? { idleMs: this.options.idleMs } : {}),
        onAlarm: (at) => {
          if (this.stopping) return;
          this.alarms.set(key, at);
          this.tidy(key);
        },
        // A Store with no process and no call is not kept here.
        onGone: () => {
          if (this.open.get(key) === made && !isLive(made)) {
            this.open.delete(key);
            this.tidy(key);
          }
        },
      });
      process = made;
      this.open.set(key, made);
      this.openers.set(key, opener);
    }
    return this.take(key, process);
  }

  /** One more call for a Store that is open. THROWS `busy` when too many wait
   *  for it already: one call runs, and at most `maxWaiting` wait behind it. */
  private take(key: string, process: StoreProcess): StoreProcess {
    if (process.pending > (this.options.maxWaiting ?? MAX_WAITING_CALLS)) {
      throw new AskFailure("busy");
    }
    // Used now: last in the order of use.
    this.open.delete(key);
    this.open.set(key, process);
    this.trim(key);
    return process;
  }

  /** Close Stores that are not in use until the bound holds, the one used
   *  longest ago first. `keep` is the one that is about to be called. */
  private trim(keep: string): void {
    // The one about to be called stays, whatever its process does now.
    let staying = 1;
    for (const [key, process] of this.open) {
      if (key !== keep && stays(process)) staying += 1;
    }
    for (const [key, process] of this.open) {
      if (staying <= this.maxOpen) return;
      // In use, or asked to close already.
      if (key === keep || !process.isOpen || process.isBusy || process.isClosing) continue;
      void process.close();
      staying -= 1;
    }
  }

  /** Forget the opener of a Store that has no process and no alarm. */
  private tidy(key: string): void {
    if (!this.open.has(key) && this.alarms.at(key) === null) {
      this.openers.delete(key);
      this.wakeFailed.delete(key);
    }
  }

  /**
   * The Store's alarm is due. Answers what the Store says its alarm is
   * afterwards, or null for a Store that is not there any more. Rejects with
   * `WakeLater` when there is no room for its process just now, and with
   * whatever else went wrong when the Store could not be woken: the alarm
   * stands then.
   */
  private async wake(key: string): Promise<number | null | void> {
    const opener = this.openers.get(key);
    if (!opener || this.stopping) return undefined;
    try {
      // Through the opener every time, also for a Store that has a process:
      // an alarm has no ask in front of it that was checked.
      const handed = await opener((place) => {
        const answer = this.use(key, place, opener).wake();
        answer.catch(() => undefined);
        return { answer };
      });
      if (handed === null) {
        // Removed, or its organization left. Its alarm is nobody's now.
        void this.remove(key);
        return null;
      }
      const alarm = await handed.answer;
      this.wakeFailed.delete(key);
      return alarm;
    } catch (thrown) {
      const code = thrown instanceof AskFailure ? thrown.code : null;
      if (code === "busy" || code === "stores_stopping") throw new WakeLater();
      // Kept for whoever is told, should every later try fail too.
      this.wakeFailed.set(key, failureWord(thrown));
      throw thrown;
    } finally {
      // After the alarms have taken the answer.
      setTimeout(() => this.tidy(key), 0);
    }
  }

  async remove(key: string): Promise<void> {
    // A stop that is under way is ending this Store's process too.
    if (this.stopping) {
      await this.stopping;
      return;
    }
    this.alarms.forget(key);
    this.openers.delete(key);
    // Its alarm is forgotten, so nobody is told of it any more.
    this.wakeFailed.delete(key);
    const process = this.open.get(key);
    this.open.delete(key);
    if (!process) return;
    // A start that is still on its way is not waited for: it makes nothing on
    // the disk, and the process it brings is ended as it comes. Until the
    // module host has answered, it counts as a process that runs.
    const start = process.startOnItsWay;
    if (start) {
      this.leaving += 1;
      void start.then(() => {
        this.leaving -= 1;
      });
    }
    await process.dispose();
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.alarms.stop();
    const withinMs = this.options.stopWithinMs ?? STOP_WITHIN_MS;
    // Each process refuses the calls that wait for it first, so none is
    // started again after this. A call that is running gets a moment to end.
    // If it does not, its process is ended, and the Store's file is as the
    // last keeping left it.
    this.stopping = Promise.all(
      [...this.open.values()].map((process) => process.dispose({ withinMs }).catch(() => {})),
    ).then(() => {
      this.open.clear();
      this.openers.clear();
      this.wakeFailed.clear();
    });
    return this.stopping;
  }
}
