import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";

import { AskFailure } from "../../../src/host/module-contract";
import { makeStoreFolder, storeFolder, writeAlarm } from "../../../src/modules/stores/host/store-folder";
import {
  OpenStores,
  type OpenStoresOptions,
  type StoreOpener,
  type StorePlace,
} from "../../../src/modules/stores/open-stores";
import { cleanFolders, madeUpProcess, tempFolder, type MadeUpProcess } from "./_rig";

/** The open Stores, on processes that are none, with a list of Stores that a
 *  test changes as a module's list changes. */
interface Bench {
  stores: OpenStores;
  /** Every process that was started, in order, with its Store. */
  started: { store: string; process: MadeUpProcess }[];
  /** The Stores whose process is there, in the order they were started. */
  alive(): string[];
  /** The Stores that are on the list. An opener answers null for any other. */
  listed: Set<string>;
  /** How often each Store's opener handed out its place. */
  handed: string[];
  root(store: string): string;
  opener(store: string): StoreOpener;
  /** Start a call of `store` and leave it running. */
  begin(store: string): Promise<unknown>;
  /** Run one call of `store` to its answer. */
  run(store: string): Promise<unknown>;
  /** The newest process of `store`. */
  of(store: string): MadeUpProcess;
  /** Alarms that were given up. */
  lost: string[];
}

const benches: Bench[] = [];
afterEach(async () => {
  for (const made of benches.splice(0)) {
    // A process that a test told never to go would hold the stop.
    for (const { process } of made.started) process.go();
    await made.stores.stop();
  }
  cleanFolders();
});

/** Let the messages that are on their way arrive. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Bun.sleep(1);
}

async function until(holds: () => boolean, withinMs = 3_000): Promise<boolean> {
  const end = Date.now() + withinMs;
  while (Date.now() < end) {
    if (holds()) return true;
    await Bun.sleep(5);
  }
  return holds();
}

function bench(
  options: OpenStoresOptions & {
    /** Stores whose process stays after it is asked to close, until `go()`. */
    slowToClose?: readonly string[];
    /** The alarm a Store's process says it has when it opens. */
    alarms?: Readonly<Record<string, number>>;
    /** Stores whose process cannot be started. */
    unstartable?: readonly string[];
    /** No way to start a process at all, as in a daemon whose host gives none. */
    noLauncher?: boolean;
    /** How long every start takes. */
    startAfterMs?: number;
  } = {},
): Bench {
  const { slowToClose = [], alarms = {}, unstartable = [], noLauncher = false, startAfterMs = 0, ...rest } = options;
  const base = tempFolder("open-stores");
  const started: Bench["started"] = [];
  const listed = new Set<string>();
  const handed: string[] = [];
  const lost: string[] = [];
  const root = (store: string): string => path.join(base, store);
  const place = (store: string): StorePlace => ({
    root: root(store),
    launcher: noLauncher
      ? null
      : {
          async start({ onMessage }) {
            if (unstartable.includes(store)) throw new Error("no process for this Store");
            if (startAfterMs > 0) await Bun.sleep(startAfterMs);
            const process = madeUpProcess(onMessage, {
              // eslint-disable-next-line security/detect-object-injection -- a test's own names
              alarm: Object.hasOwn(alarms, store) ? (alarms[store] as number) : null,
              slowToClose: slowToClose.includes(store),
            });
            started.push({ store, process });
            return process.child;
          },
        },
  });
  const opener =
    (store: string): StoreOpener =>
    async (hand) => {
      // As the module does it: a look at the list first, which takes a moment.
      await Promise.resolve();
      if (!listed.has(store)) return null;
      handed.push(store);
      return hand(place(store));
    };
  const stores = new OpenStores({
    idleMs: 0,
    // A call that a test leaves running is not waited for when the test ends.
    stopWithinMs: 20,
    onAlarmLost: (key) => void lost.push(key),
    ...rest,
  });
  const of = (store: string): MadeUpProcess => {
    const found = started.filter((one) => one.store === store).at(-1);
    if (!found) throw new Error(`no process was started for ${store}`);
    return found.process;
  };
  /** A Store that is there: on the list, with its folder made. */
  const there = (store: string): void => {
    if (listed.has(store)) return;
    listed.add(store);
    makeStoreFolder(storeFolder(root(store)));
  };
  const begin = (store: string): Promise<unknown> => {
    there(store);
    const call = stores.call(store, opener(store), "stats");
    call.catch(() => undefined);
    return call;
  };
  const made: Bench = {
    stores,
    started,
    alive: () => started.filter((one) => !one.process.gone()).map((one) => one.store),
    listed,
    handed,
    root,
    opener,
    begin,
    of,
    lost,
    async run(store) {
      const call = begin(store);
      await settle();
      of(store).answer({ ok: true, value: store });
      return call;
    },
  };
  benches.push(made);
  return made;
}

/** Keep `at` as the alarm of `store`, as the Store's process does, and put the
 *  Store on the list. */
function keepAlarm(made: Bench, store: string, at: number): void {
  made.listed.add(store);
  const folder = storeFolder(made.root(store));
  makeStoreFolder(folder);
  writeAlarm(folder, at);
}

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (thrown) {
    return thrown instanceof AskFailure ? thrown.code : `not an AskFailure: ${String(thrown)}`;
  }
  return "answered";
}

describe("the open Stores", () => {
  test("a Store's process is started by its first call, through its opener, and used by the next without it", async () => {
    const made = bench();
    expect(made.stores.openCount).toBe(0);
    expect(await made.run("a")).toEqual({ ok: true, value: "a" });
    expect(await made.run("a")).toEqual({ ok: true, value: "a" });
    expect(made.started).toHaveLength(1);
    expect(made.stores.openCount).toBe(1);
    // The place was asked for once: a Store that has a process needs none.
    expect(made.handed).toEqual(["a"]);
  });

  test("a Store that is not on the list is not opened, and is told as unknown", async () => {
    const made = bench();
    const call = made.stores.call("gone", made.opener("gone"), "stats");
    expect(await refusal(call)).toBe("store_unknown");
    expect(made.started).toHaveLength(0);
    expect(made.stores.openCount).toBe(0);
  });

  test("with no way to start a process, a call is refused with one word and nothing is started", async () => {
    const made = bench({ noLauncher: true });
    expect(await refusal(made.begin("a"))).toBe("store_process_unavailable");
    expect(made.started).toHaveLength(0);
    expect(made.stores.openCount).toBe(0);
  });

  test("a Store whose folder is gone is not opened, and its folder is not made again", async () => {
    const made = bench();
    await made.run("a");
    await made.stores.remove("a");
    rmSync(made.root("a"), { recursive: true });
    // Still on the list, as after somebody removed the folder by hand.
    expect(await refusal(made.begin("a"))).toBe("store_folder_missing");
    expect(existsSync(made.root("a"))).toBe(false);
    expect(made.started).toHaveLength(1);
  });

  test("a Store with no process and no call is not kept: the next call asks its opener again", async () => {
    const made = bench({ idleMs: 30 });
    await made.run("a");
    expect(made.stores.openCount).toBe(1);
    // No call comes, so its process closes.
    expect(await until(() => made.alive().length === 0)).toBe(true);
    await settle();
    expect(made.stores.openCount).toBe(0);
    await made.run("a");
    expect(made.handed).toEqual(["a", "a"]);
    expect(made.started).toHaveLength(2);
  });
});

describe("how many processes run at once", () => {
  test("past the bound, the Store that was used longest ago and is not in use is closed", async () => {
    const made = bench({ maxOpen: 2 });
    await made.run("a");
    await made.run("b");
    // Used again, in the same moment: now `b` is the one used longest ago.
    // The order of use decides, and no clock is asked.
    await made.run("a");
    await made.run("c");
    await settle();
    expect(made.alive().sort()).toEqual(["a", "c"]);
    // It is opened again when it is asked for, and the oldest goes then.
    await made.run("b");
    await settle();
    expect(made.alive().sort()).toEqual(["b", "c"]);
    expect(made.started.map((one) => one.store)).toEqual(["a", "b", "c", "b"]);
  });

  test("a Store with a call running is not closed, and twice the bound is the most that run", async () => {
    const made = bench({ maxOpen: 2 });
    for (const store of ["a", "b", "c", "d"]) void made.begin(store);
    await settle();
    expect(made.alive()).toEqual(["a", "b", "c", "d"]);
    expect(made.stores.openCount).toBe(4);
    // One more Store is refused, and nothing is started for it.
    expect(await refusal(made.begin("e"))).toBe("busy");
    expect(made.started).toHaveLength(4);
    // A Store that has a process is still called: its call waits its turn.
    const again = made.begin("a");
    made.of("a").answer({ ok: true, value: "a" });
    await settle();
    made.of("a").answer({ ok: true, value: "a" });
    expect(await again).toEqual({ ok: true, value: "a" });
    expect(made.started).toHaveLength(4);
  });

  test("a Store whose process was closed is held to the same bound when it is called again", async () => {
    const made = bench({ maxOpen: 1 });
    await made.run("a");
    // `a` is not in use, so it is closed for `b`.
    void made.begin("b");
    await settle();
    void made.begin("c");
    await settle();
    expect(made.alive()).toEqual(["b", "c"]);
    // `a` has no process any more. Calling it would start a third.
    expect(await refusal(made.begin("a"))).toBe("busy");
    expect(made.alive()).toEqual(["b", "c"]);
    expect(made.started).toHaveLength(3);
  });

  test("a process that was asked to close counts until it is gone", async () => {
    const made = bench({ maxOpen: 1, slowToClose: ["a"] });
    await made.run("a");
    void made.begin("b");
    await settle();
    // `a` was asked to close for `b`, and is still there.
    expect(made.of("a").closing()).toBe(true);
    expect(made.alive()).toEqual(["a", "b"]);
    expect(made.stores.openCount).toBe(2);
    // So there is no room for a third, however often it is asked for.
    expect(await refusal(made.begin("c"))).toBe("busy");
    expect(await refusal(made.begin("c"))).toBe("busy");
    expect(made.started).toHaveLength(2);
    // When it is gone, there is.
    made.of("a").go();
    await settle();
    void made.begin("c");
    await settle();
    expect(made.alive()).toEqual(["b", "c"]);
  });

  test("a process that is closing already does not stand in for one that has to close", async () => {
    const made = bench({ maxOpen: 1, slowToClose: ["a"] });
    await made.run("a");
    // `a` is asked to close for `b`, and stays a while. `b` ends its call.
    await made.run("b");
    expect(made.of("a").closing()).toBe(true);
    expect(made.alive()).toEqual(["a", "b"]);
    // No room for `c`. `b` is the one that can make room, and it is asked to.
    expect(await refusal(made.begin("c"))).toBe("busy");
    await settle();
    expect(made.alive()).toEqual(["a"]);
  });

  test("at twice the bound, the Stores that are not in use are asked to close, so a later call finds room", async () => {
    const made = bench({ maxOpen: 1 });
    const first = made.begin("a");
    const second = made.begin("b");
    await settle();
    // Both calls end. Nothing was asked for since, so both processes are there.
    made.of("a").answer();
    made.of("b").answer();
    await Promise.all([first, second]);
    expect(made.alive()).toEqual(["a", "b"]);
    expect(await refusal(made.begin("c"))).toBe("busy");
    await settle();
    expect(made.alive()).toEqual([]);
    void made.begin("c");
    await settle();
    expect(made.alive()).toEqual(["c"]);
  });
});

describe("how many calls wait for one Store", () => {
  test("past the bound a call is refused as busy, and another Store is called as before", async () => {
    const made = bench({ maxWaiting: 2 });
    const calls = [made.begin("a"), made.begin("a"), made.begin("a")];
    await settle();
    // One runs and two wait. A fourth has no place.
    expect(made.of("a").waiting).toHaveLength(1);
    expect(await refusal(made.begin("a"))).toBe("busy");
    expect(await made.run("b")).toEqual({ ok: true, value: "b" });
    // When one is answered, the line is shorter by one.
    made.of("a").answer();
    await calls.at(0);
    const one = made.begin("a");
    await settle();
    expect(made.started).toHaveLength(2);
    for (let i = 0; i < 3; i += 1) {
      made.of("a").answer();
      await settle();
    }
    await Promise.all([...calls, one]);
  });
});

describe("a Store's alarm", () => {
  test("is read from the Store's folder for a Store the module knows of", () => {
    const made = bench();
    const at = Date.now() + 3_600_000;
    keepAlarm(made, "a", at);
    made.listed.add("b");
    makeStoreFolder(storeFolder(made.root("b")));
    made.stores.watch("a", made.root("a"), made.opener("a"));
    made.stores.watch("b", made.root("b"), made.opener("b"));
    expect(made.stores.alarmOf("a")).toBe(at);
    expect(made.stores.alarmOf("b")).toBeNull();
  });

  test("is taken from the Store's process when it opens", async () => {
    const at = Date.now() + 3_600_000;
    const made = bench({ alarms: { a: at } });
    await made.run("a");
    expect(made.stores.alarmOf("a")).toBe(at);
  });

  test("a due alarm starts the Store's process through its opener, and wakes it", async () => {
    const made = bench();
    keepAlarm(made, "a", Date.now() - 1_000);
    made.stores.watch("a", made.root("a"), made.opener("a"));
    expect(await until(() => made.alive().length === 1)).toBe(true);
    await settle();
    expect(made.handed).toEqual(["a"]);
    // The one thing it was sent after the open is the wake.
    expect(made.of("a").sent.map((message) => message.t)).toEqual(["open", "wake"]);
  });

  test("an alarm asks the opener every time, also for a Store that has a process", async () => {
    const made = bench();
    await made.run("a");
    expect(made.handed).toEqual(["a"]);
    made.of("a").say({ t: "alarm", at: Date.now() - 1 });
    expect(await until(() => made.of("a").sent.some((message) => message.t === "wake"))).toBe(true);
    expect(made.handed).toEqual(["a", "a"]);
    expect(made.started).toHaveLength(1);
  });

  test("a Store that left the list is not woken: its process is ended and its alarm forgotten", async () => {
    const made = bench();
    await made.run("a");
    // Off the list, as after a delete, or after its organization left.
    made.listed.delete("a");
    made.of("a").say({ t: "alarm", at: Date.now() - 1 });
    expect(await until(() => made.alive().length === 0)).toBe(true);
    await settle();
    expect(made.of("a").sent.map((message) => message.t)).toEqual(["open", "call"]);
    expect(made.stores.alarmOf("a")).toBeNull();
    expect(made.stores.openCount).toBe(0);
    // And one that was only watched: nothing is started for it, and its
    // folder is not touched.
    keepAlarm(made, "b", Date.now() + 30);
    made.stores.watch("b", made.root("b"), made.opener("b"));
    made.listed.delete("b");
    rmSync(made.root("b"), { recursive: true });
    await Bun.sleep(80);
    expect(made.started).toHaveLength(1);
    expect(existsSync(made.root("b"))).toBe(false);
    expect(made.stores.alarmOf("b")).toBeNull();
    expect(made.lost).toEqual([]);
  });

  test("an alarm that finds no room waits, is not counted as a failure, and is woken when there is room", async () => {
    const made = bench({ maxOpen: 1, alarmRetryBaseMs: 10 });
    void made.begin("a");
    void made.begin("b");
    await settle();
    expect(made.stores.openCount).toBe(2);
    // Due now, with twice the bound in use.
    keepAlarm(made, "c", Date.now() - 1);
    made.stores.watch("c", made.root("c"), made.opener("c"));
    // Far more looks than a failing wake gets tries.
    await Bun.sleep(200);
    expect(made.started.map((one) => one.store)).toEqual(["a", "b"]);
    expect(made.lost).toEqual([]);
    expect(made.stores.alarmOf("c")).not.toBeNull();
    // Room: both calls end, and their Stores are closed for the next.
    made.of("a").answer();
    made.of("b").answer();
    expect(await until(() => made.started.some((one) => one.store === "c"))).toBe(true);
    await settle();
    expect(made.of("c").sent.map((message) => message.t)).toEqual(["open", "wake"]);
    expect(made.lost).toEqual([]);
  });

  test("a Store that cannot be woken is tried again, then given up, and somebody is told", async () => {
    const made = bench({ unstartable: ["a"], alarmRetryBaseMs: 1 });
    keepAlarm(made, "a", Date.now() - 1);
    made.stores.watch("a", made.root("a"), made.opener("a"));
    expect(await until(() => made.lost.length === 1)).toBe(true);
    expect(made.lost).toEqual(["a"]);
    // One try and six more.
    expect(made.handed).toHaveLength(7);
  });
});

describe("a Store that is removed, and a stop", () => {
  test("removing a Store ends its process with its call, and forgets its alarm", async () => {
    const at = Date.now() + 3_600_000;
    const made = bench({ alarms: { a: at } });
    await made.run("a");
    const running = made.begin("a");
    await settle();
    await made.stores.remove("a");
    expect(made.alive()).toEqual([]);
    expect(made.stores.alarmOf("a")).toBeNull();
    await expect(running).rejects.toThrow("the Store's process stopped");
    expect(made.stores.openCount).toBe(0);
  });

  test("a stop refuses the calls that wait first: no process is started after it began", async () => {
    const made = bench({ stopWithinMs: 400 });
    const running = made.begin("a");
    const waiting = made.begin("a");
    await settle();
    const stopping = made.stores.stop();
    await expect(waiting).rejects.toThrow("the Store's process stopped");
    // The one that runs gets the moment a stop gives it, and takes it.
    made.of("a").answer({ ok: true, value: "in time" });
    expect(await running).toEqual({ ok: true, value: "in time" });
    await stopping;
    await Bun.sleep(40);
    expect(made.started).toHaveLength(1);
    expect(made.of("a").sent.map((message) => message.t)).toEqual(["open", "call", "close"]);
  });

  test("after a stop every process is gone, and nothing more is opened or woken", async () => {
    const made = bench({ stopWithinMs: 60 });
    await made.run("a");
    // A call that does not end in the time a stop gives it.
    const running = made.begin("b");
    await settle();
    keepAlarm(made, "c", Date.now() + 150);
    made.stores.watch("c", made.root("c"), made.opener("c"));
    await made.stores.stop();
    expect(made.alive()).toEqual([]);
    await expect(running).rejects.toThrow("the Store's process stopped");
    expect(await refusal(made.begin("a"))).toBe("stores_stopping");
    made.stores.watch("d", made.root("c"), made.opener("d"));
    expect(made.stores.alarmOf("c")).toBeNull();
    // Past the time of the alarm that was kept before the stop.
    await Bun.sleep(200);
    expect(made.started.map((one) => one.store)).toEqual(["a", "b"]);
  });

  test("a start that is on its way for a Store that was removed counts until its process has come", async () => {
    const made = bench({ maxOpen: 1, startAfterMs: 300 });
    void made.begin("a");
    void made.begin("b");
    await settle();
    expect(made.stores.openCount).toBe(2);
    // Both are removed while their processes are still being started. A
    // removal does not wait for a start.
    await made.stores.remove("a");
    await made.stores.remove("b");
    expect(made.started).toHaveLength(0);
    expect(made.stores.openCount).toBe(2);
    // So twice the bound is still taken, and a third Store finds no room.
    expect(await refusal(made.begin("c"))).toBe("busy");
    expect(made.started).toHaveLength(0);
    // The two processes come, and are ended before they are told anything.
    expect(await until(() => made.started.length === 2)).toBe(true);
    await settle();
    expect(made.started.map((one) => one.process.sent.length)).toEqual([0, 0]);
    expect(made.alive()).toEqual([]);
    expect(made.stores.openCount).toBe(0);
    // Now there is room.
    const third = made.begin("c");
    expect(await until(() => made.started.length === 3)).toBe(true);
    await settle();
    made.of("c").answer({ ok: true, value: "c" });
    expect(await third).toEqual({ ok: true, value: "c" });
  });

  test("a Store that is removed while a stop is under way is gone when the removal returns", async () => {
    const made = bench({ stopWithinMs: 400 });
    void made.begin("a");
    await settle();
    const stopping = made.stores.stop();
    // The stop gives the running call a moment. The removal does not return
    // before the process is gone.
    let removed = false;
    const removing = made.stores.remove("a").then(() => (removed = true));
    await Bun.sleep(50);
    expect(removed).toBe(false);
    expect(made.alive()).toEqual(["a"]);
    await removing;
    expect(made.alive()).toEqual([]);
    await stopping;
  });
});
