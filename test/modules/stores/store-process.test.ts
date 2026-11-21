import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { PROCESS_TMPDIR_VARIABLE, PROCESS_WORKING_FOLDER } from "../../../src/host/module-processes";
import { readAlarm } from "../../../src/modules/stores/host/store-folder";
import type { FromStore, ToStore } from "../../../src/modules/stores/host/process-protocol";
import {
  StoreCallFailed,
  StoreProcess,
  StoreStopped,
  type StopReason,
  type StoreChild,
  type StoreLauncher,
  type StoreProcessOptions,
} from "../../../src/modules/stores/host/store-process";
import {
  cleanFolders,
  commandLauncher,
  endProcesses,
  madeUpProcess,
  newStoreFolder,
  PROBE,
  probeLauncher,
  probeStore,
  type MadeUpProcess,
} from "./_rig";

afterEach(async () => {
  await endProcesses();
  cleanFolders();
});

const ENDLESS = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c";
/** A statement that takes a moment, and then ends. */
const SLOW_ROWS = 4_000_000;
const SLOW = `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT ${SLOW_ROWS}) SELECT count(*) FROM c`;

async function failure(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (thrown) {
    return thrown as Error;
  }
  throw new Error("nothing was thrown");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await Bun.sleep(25);
  }
  return !alive(pid);
}

describe("a Store's process", () => {
  test("runs a Store's statements on the Store's own file", async () => {
    const store = probeStore();
    await store.exec("CREATE TABLE permits (permit_no TEXT, address TEXT)");
    const written = await store.exec("INSERT INTO permits VALUES (?, ?), (?, ?)", "BP-1", "18 Mill Road", "BP-2", "7 Alder Court");
    expect(written.written).toBe(2);
    expect(await store.exec("SELECT permit_no, address FROM permits ORDER BY permit_no")).toEqual({
      columns: ["permit_no", "address"],
      rows: [
        ["BP-1", "18 Mill Road"],
        ["BP-2", "7 Alder Court"],
      ],
      written: 0,
    });
    expect(existsSync(store.folder.database)).toBe(true);
    expect(store.process.isOpen).toBe(true);
  });

  test("bytes cross to it and back", async () => {
    const store = probeStore();
    await store.exec("CREATE TABLE f (body BLOB)");
    await store.exec("INSERT INTO f VALUES (?)", new Uint8Array([1, 2, 3, 250]));
    const answer = await store.exec("SELECT body FROM f");
    const body = answer.rows.at(0)?.at(0);
    expect(body).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(body as ArrayBuffer)]).toEqual([1, 2, 3, 250]);
  });

  test("is started with nothing of this program's environment, and not in the Store's folder", async () => {
    process.env.HX_FORTRESS_TEST_SECRET = "must not be inherited";
    const store = probeStore();
    const seen = (await store.process.call("environment")) as {
      names: string[];
      umask: number;
      cwd: string;
      temporary: string | null;
    };
    delete process.env.HX_FORTRESS_TEST_SECRET;
    expect(seen.names).toEqual([PROCESS_TMPDIR_VARIABLE]);
    // Whatever it makes is for its owner alone.
    expect(seen.umask).toBe(0o077);
    // The Store's own folder for SQLite's temporary files reaches it by that
    // one name.
    expect(seen.temporary).toBe(store.folder.scratch);
    // It is not started in the Store's folder: this runtime reads settings
    // and variables from files of the folder a program starts in.
    expect(seen.cwd).toBe(PROCESS_WORKING_FOLDER);
  });

  test("is handed the settings it was opened with", async () => {
    const store = probeStore({ settings: { STORE_DAILY_WRITE_LIMIT: "5000" } });
    expect(await store.process.call<Record<string, string>>("settings")).toEqual({ STORE_DAILY_WRITE_LIMIT: "5000" });
  });

  test("answers one call at a time, in the order they came", async () => {
    const store = probeStore();
    await store.exec("CREATE TABLE t (n INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)");
    await Promise.all(Array.from({ length: 40 }, (_, i) => store.exec("INSERT INTO t (v) VALUES (?)", `v${i}`)));
    const rows = (await store.exec("SELECT v FROM t ORDER BY n")).rows.map((row) => row.at(0));
    expect(rows).toEqual(Array.from({ length: 40 }, (_, i) => `v${i}`));
  });

  test("a call the program fails is told by one word, and its words stay out of the message", async () => {
    const store = probeStore();
    await store.exec("CREATE TABLE notes (body TEXT)");
    const failed = (await failure(store.process.call("write_then_fail", ["first"]))) as StoreCallFailed;
    expect(failed).toBeInstanceOf(StoreCallFailed);
    expect(failed.code).toBe("probe_failed");
    expect(failed.words).toBe("the table notes could not be changed");
    expect(failed.message).toBe("the Store's call failed: probe_failed");
    // What the call wrote before it failed is kept, as on the platform.
    expect((await store.exec("SELECT body FROM notes")).rows).toEqual([["first"]]);
    // A failure of SQLite's is told by SQLite's code.
    const sqlite = (await failure(store.exec("SELECT * FROM nowhere"))) as StoreCallFailed;
    expect(sqlite.code).toBe("sqlite_error");
    expect(sqlite.words).toBe("no such table: nowhere: SQLITE_ERROR");
    // A refusal of the host's by its rule.
    const refused = (await failure(store.exec("ATTACH DATABASE '/tmp/x' AS y"))) as StoreCallFailed;
    expect(refused.code).toBe("refused_attach");
    // A failure with no word of its own.
    const unnamed = (await failure(store.process.call("in_transaction", ["x", "fail"]))) as StoreCallFailed;
    expect(unnamed.code).toBe("internal");
  });

  test("an answer that cannot cross the channel is a failure, not a wait", async () => {
    const store = probeStore();
    const failed = (await failure(store.process.call("unreadable"))) as StoreCallFailed;
    expect(failed.code).toBe("answer_unreadable");
  });
});

describe("a statement that never ends cannot stop the rest", () => {
  test("it is stopped at its limit, and this program kept running meanwhile", async () => {
    const store = probeStore({ limitMs: 10_000 });
    await store.exec("CREATE TABLE t (a)");
    const pid = (await store.process.call("pid")) as number;

    // This program's own loop: a tick every 10 ms. A statement on this thread
    // would hold it for good.
    let ticks = 0;
    const ticker = setInterval(() => (ticks += 1), 10);
    const started = Date.now();
    const stopped = (await failure(store.process.call("exec", [ENDLESS], { limitMs: 400 }))) as StoreStopped;
    const took = Date.now() - started;
    clearInterval(ticker);

    expect(stopped).toBeInstanceOf(StoreStopped);
    expect(stopped.why).toBe("limit");
    expect(took).toBeGreaterThanOrEqual(380);
    expect(took).toBeLessThan(3_000);
    expect(ticks).toBeGreaterThan(15);
    // Stopped, not left running: the process is gone.
    expect(await goneWithin(pid, 2_000)).toBe(true);
    expect(store.process.stopped).toBe(1);
  });

  test("another Store answers while it runs", async () => {
    const stuck = probeStore({ limitMs: 5_000 });
    const other = probeStore();
    await stuck.exec("CREATE TABLE t (a)");
    await other.exec("CREATE TABLE t (a)");
    let settled = false;
    const running = failure(stuck.exec(ENDLESS)).finally(() => (settled = true));
    await Bun.sleep(150);
    for (let i = 0; i < 20; i += 1) await other.exec("INSERT INTO t VALUES (?)", i);
    expect((await other.exec("SELECT count(*) FROM t")).rows).toEqual([[20]]);
    // All of that happened while the first Store's statement was still running.
    expect(settled).toBe(false);
    expect(((await running) as StoreStopped).why).toBe("limit");
  }, 15_000);

  test("the next call starts a new process on the same file, with what was kept", async () => {
    const store = probeStore({ limitMs: 10_000 });
    await store.exec("CREATE TABLE notes (body TEXT)");
    await store.exec("INSERT INTO notes VALUES ('kept before')");
    const before = (await store.process.call("pid")) as number;
    await failure(store.process.call("exec", [ENDLESS], { limitMs: 400 }));
    expect((await store.exec("SELECT body FROM notes")).rows).toEqual([["kept before"]]);
    const after = (await store.process.call("pid")) as number;
    expect(after).not.toBe(before);
  });

  test("what the stopped call had written is not kept", async () => {
    const store = probeStore({ limitMs: 10_000 });
    await store.exec("CREATE TABLE notes (body TEXT)");
    const stopped = (await failure(
      store.process.call("write_then_spin", ["half a call"], { limitMs: 400 }),
    )) as StoreStopped;
    expect(stopped.why).toBe("limit");
    expect((await store.exec("SELECT count(*) FROM notes")).rows).toEqual([[0]]);
  });

  test("the calls that waited behind it are not lost, where their own limit has not passed", async () => {
    const store = probeStore({ limitMs: 10_000 });
    await store.exec("CREATE TABLE t (n INTEGER)");
    const results = await Promise.allSettled([
      store.process.call("exec", [ENDLESS], { limitMs: 400 }),
      store.exec("INSERT INTO t VALUES (1)"),
      store.exec("INSERT INTO t VALUES (2)"),
      store.exec("SELECT count(*) FROM t"),
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled", "fulfilled", "fulfilled"]);
    expect((results.at(3) as PromiseFulfilledResult<{ rows: unknown[][] }>).value.rows).toEqual([[2]]);
  });

  test("a call's limit counts from its hand-over: one that still waits at its limit is refused by itself", async () => {
    const store = probeStore({ limitMs: 10_000 });
    await store.exec("CREATE TABLE t (n INTEGER)");
    const first = await store.process.call<number>("pid");
    const slow = store.exec(SLOW);
    // Handed over now, behind the slow one, with less time than that takes.
    const started = Date.now();
    const waited = (await failure(store.process.call("exec", ["INSERT INTO t VALUES (1)"], { limitMs: 60 }))) as StoreStopped;
    expect(waited).toBeInstanceOf(StoreStopped);
    expect(waited.why).toBe("limit");
    expect(Date.now() - started).toBeLessThan(2_000);
    // It was never sent: nothing of it ran, and the process is the same one.
    expect((await slow).rows).toEqual([[SLOW_ROWS]]);
    expect((await store.exec("SELECT count(*) FROM t")).rows).toEqual([[0]]);
    expect(await store.process.call<number>("pid")).toBe(first);
    expect(store.process.stopped).toBe(0);
  }, 30_000);

  test("a call may be given a limit of its own", async () => {
    const store = probeStore({ limitMs: 30_000 });
    await store.exec("CREATE TABLE t (a)");
    const started = Date.now();
    const stopped = (await failure(store.process.call("exec", [ENDLESS], { limitMs: 300 }))) as StoreStopped;
    expect(stopped.why).toBe("limit");
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("what a call wrote is kept as the Store's program asked", () => {
  test("a transaction of the program's is kept or undone as a whole", async () => {
    const store = probeStore();
    await store.exec("CREATE TABLE notes (body TEXT)");
    expect(await store.process.call<string>("in_transaction", ["one"])).toBe("kept");
    const undone = (await failure(store.process.call("in_transaction", ["two", "fail"]))) as StoreCallFailed;
    expect(undone.words).toBe("undone");
    expect((await store.exec("SELECT body FROM notes")).rows).toEqual([["one"]]);
  });

  test("when the process is ended from outside, the file is as the last keeping left it", async () => {
    const store = probeStore();
    await store.exec("CREATE TABLE notes (body TEXT)");
    await store.exec("INSERT INTO notes VALUES ('finished')");
    const pid = (await store.process.call("pid")) as number;
    const running = failure(store.process.call("write_then_spin", ["unfinished"]));
    await Bun.sleep(200);
    // The machine ends it: out of memory, or an operator.
    process.kill(pid, "SIGKILL");
    const stopped = (await running) as StoreStopped;
    expect(stopped).toBeInstanceOf(StoreStopped);
    expect(stopped.why).toBe("exited");
    expect((await store.exec("SELECT body FROM notes")).rows).toEqual([["finished"]]);
  });

  test("a transaction that ended is kept, also when the call is then stopped", async () => {
    // The engine counts a job's tries this way before it runs the job's work.
    // If the count went with a job that never returns, the job would be
    // tried for ever.
    const store = probeStore({ limitMs: 10_000 });
    await store.exec("CREATE TABLE notes (body TEXT)");
    const stopped = (await failure(
      store.process.call("transaction_then_spin", ["a try"], { limitMs: 400 }),
    )) as StoreStopped;
    expect(stopped.why).toBe("limit");
    expect((await store.exec("SELECT body FROM notes")).rows).toEqual([["a try"]]);
  });

  test("what was written before the program waited is kept, and what came after it is not", async () => {
    const store = probeStore({ limitMs: 10_000 });
    await store.exec("CREATE TABLE notes (body TEXT)");
    const stopped = (await failure(
      store.process.call("write_wait_write_spin", ["before", "after"], { limitMs: 500 }),
    )) as StoreStopped;
    expect(stopped.why).toBe("limit");
    expect((await store.exec("SELECT body FROM notes")).rows).toEqual([["before"]]);
  });

  test("a Store that was emptied in a call that is then stopped is empty, not half made again", async () => {
    const store = probeStore({ limitMs: 10_000 });
    await store.exec("CREATE TABLE notes (body TEXT)");
    await store.exec("INSERT INTO notes VALUES ('old')");
    const stopped = (await failure(store.process.call("empty_write_spin", [], { limitMs: 500 }))) as StoreStopped;
    expect(stopped.why).toBe("limit");
    expect((await store.exec("SELECT name FROM sqlite_master")).rows).toEqual([]);
  });
});

describe("the alarm, across the process", () => {
  test("a time set in a call is on the disk when the call is answered, and HX Fortress is told", async () => {
    const told: (number | null)[] = [];
    const store = probeStore({ onAlarm: (at) => told.push(at) });
    await store.process.call("set_alarm", [1_800_000_000_000]);
    expect(readAlarm(store.folder)).toBe(1_800_000_000_000);
    await store.process.call("set_alarm", [null]);
    expect(readAlarm(store.folder)).toBeNull();
    // Told when the Store was opened (none yet), then each change.
    expect(told).toEqual([null, 1_800_000_000_000, null]);
  });

  test("HX Fortress is told the alarm of a Store it opens", async () => {
    const folder = newStoreFolder();
    const first = probeStore({ folder });
    await first.process.call("set_alarm", [1_800_000_000_000]);
    await first.process.close();
    const told: (number | null)[] = [];
    const again = probeStore({ folder, onAlarm: (at) => told.push(at) });
    expect(await again.process.call<number | null>("alarm")).toBe(1_800_000_000_000);
    expect(told).toEqual([1_800_000_000_000]);
  });

  test("waking the Store spends its alarm, unless the program sets a new one", async () => {
    const store = probeStore();
    await store.exec("CREATE TABLE notes (body TEXT)");
    await store.process.call("set_alarm", [1_000]);
    // The wake answers what the alarm is afterwards.
    expect(await store.process.wake()).toBeNull();
    expect(await store.process.call<number>("woken")).toBe(1);
    expect(await store.process.call<number | null>("alarm")).toBeNull();
    expect(readAlarm(store.folder)).toBeNull();

    await store.exec("INSERT INTO notes VALUES ('wake:again:9000')");
    await store.process.call("set_alarm", [2_000]);
    expect(await store.process.wake()).toBe(9_000);
    expect(await store.process.call<number | null>("alarm")).toBe(9_000);
    expect(readAlarm(store.folder)).toBe(9_000);
  });

  test("a Store whose alarm is not due is not woken, and answers its alarm as it is", async () => {
    // HX Fortress set its timer for a time that a call has moved since.
    const store = probeStore();
    await store.exec("CREATE TABLE notes (body TEXT)");
    const later = Date.now() + 60 * 60 * 1000;
    await store.process.call("set_alarm", [later]);
    expect(await store.process.wake()).toBe(later);
    expect(await store.process.call<number>("woken")).toBe(0);
    expect(readAlarm(store.folder)).toBe(later);
    // And a Store with no alarm at all.
    await store.process.call("set_alarm", [null]);
    expect(await store.process.wake()).toBeNull();
    expect(await store.process.call<number>("woken")).toBe(0);
  });

  test("a Store that sets the time that just fired answers that time", async () => {
    const store = probeStore();
    await store.exec("CREATE TABLE notes (body TEXT)");
    await store.exec("INSERT INTO notes VALUES ('wake:again:1000')");
    await store.process.call("set_alarm", [1_000]);
    expect(await store.process.wake()).toBe(1_000);
    expect(readAlarm(store.folder)).toBe(1_000);
  });

  test("a wake that is stopped at its limit leaves the alarm on the disk, and the next process is woken again", async () => {
    const store = probeStore({ limitMs: 10_000 });
    await store.exec("CREATE TABLE notes (body TEXT)");
    await store.exec("INSERT INTO notes VALUES ('wake:spin')");
    await store.process.call("set_alarm", [1_000]);
    const stopped = (await failure(store.process.wake({ limitMs: 500 }))) as StoreStopped;
    expect(stopped.why).toBe("limit");
    // What the wake wrote before it waited is kept, and so is the alarm.
    expect(readAlarm(store.folder)).toBe(1_000);
    expect((await store.exec("SELECT count(*) FROM notes WHERE body = 'the wake began'")).rows).toEqual([[1]]);
    expect(await store.process.call<number | null>("alarm")).toBe(1_000);
    // The work that never returns is gone: the next wake goes well, and spends the alarm.
    await store.exec("DELETE FROM notes WHERE body = 'wake:spin'");
    expect(await store.process.wake()).toBeNull();
    expect(readAlarm(store.folder)).toBeNull();
  }, 15_000);

  test("when waking fails, the alarm stands", async () => {
    const store = probeStore();
    await store.exec("CREATE TABLE notes (body TEXT)");
    await store.exec("INSERT INTO notes VALUES ('wake:fail')");
    await store.process.call("set_alarm", [3_000]);
    const failed = await failure(store.process.wake());
    expect(failed).toBeInstanceOf(StoreCallFailed);
    expect(await store.process.call<number | null>("alarm")).toBe(3_000);
    expect(readAlarm(store.folder)).toBe(3_000);
  });
});

describe("the end of a Store's process", () => {
  test("closing it lets the running call finish, and the next call starts a new one", async () => {
    const gone: (StopReason | null)[] = [];
    const store = probeStore({ onGone: (why) => gone.push(why) });
    await store.exec("CREATE TABLE t (n INTEGER)");
    const pid = (await store.process.call("pid")) as number;
    // A statement that takes a moment, and then ends.
    const counting = store.exec(SLOW);
    await Bun.sleep(50);
    expect(store.process.isBusy).toBe(true);
    const closing = store.process.close();
    // A call that comes while it closes waits, and gets a new process.
    const later = store.exec("INSERT INTO t VALUES (1)");
    expect((await counting).rows).toEqual([[SLOW_ROWS]]);
    await closing;
    expect(await goneWithin(pid, 2_000)).toBe(true);
    // Closed in good order.
    expect(gone).toEqual([null]);
    await later;
    expect((await store.exec("SELECT n FROM t")).rows).toEqual([[1]]);
    expect(await store.process.call<number>("pid")).not.toBe(pid);
  });

  test("a close while the Store is still being opened waits for it, and the call that waits gets its answer", async () => {
    const gone: (StopReason | null)[] = [];
    const store = probeStore({ settings: { PROBE_OPEN_DELAY_MS: "300" }, onGone: (why) => gone.push(why) });
    const first = store.process.call<number>("pid");
    await Bun.sleep(60);
    await store.process.close();
    // The process that was asked to close ended by itself.
    expect(gone).toEqual([null]);
    expect(await first).toBeGreaterThan(0);
  }, 15_000);

  test("a call whose values cannot be sent is refused by itself, and the process goes on", async () => {
    const store = probeStore();
    await store.exec("CREATE TABLE t (n INTEGER)");
    const pid = await store.process.call<number>("pid");
    const results = await Promise.allSettled([
      store.process.call("exec", ["SELECT ? AS v", () => 1]),
      store.exec("INSERT INTO t VALUES (1)"),
      store.exec("INSERT INTO t VALUES (2)"),
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
    const refused = (results.at(0) as PromiseRejectedResult).reason as StoreCallFailed;
    expect(refused).toBeInstanceOf(StoreCallFailed);
    expect(refused.code).toBe("call_unsendable");
    expect((await store.exec("SELECT count(*) FROM t")).rows).toEqual([[2]]);
    // The same process: nothing was ended for one caller's value.
    expect(await store.process.call<number>("pid")).toBe(pid);
    expect(store.process.stopped).toBe(0);
  });

  test("a listener that throws stops nothing", async () => {
    const store = probeStore({
      limitMs: 10_000,
      onAlarm: () => {
        throw new Error("a listener's own failure");
      },
      onGone: () => {
        throw new Error("a listener's own failure");
      },
    });
    await store.exec("CREATE TABLE t (n INTEGER)");
    await store.process.call("set_alarm", [5_000]);
    const results = await Promise.allSettled([
      store.process.call("exec", [ENDLESS], { limitMs: 400 }),
      store.exec("INSERT INTO t VALUES (1)"),
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
    expect((await store.exec("SELECT count(*) FROM t")).rows).toEqual([[1]]);
  });

  test("a call that was not sent yet when the close began is not lost", async () => {
    const store = probeStore();
    await store.exec("CREATE TABLE t (n INTEGER)");
    const writing = store.exec("INSERT INTO t VALUES (1)");
    // In the same moment, before the call could be sent.
    const closing = store.process.close();
    await Promise.all([writing, closing]);
    expect((await store.exec("SELECT n FROM t")).rows).toEqual([[1]]);
  });

  test("closing does not wait longer than it is told to: the call is stopped, and nothing of it is kept", async () => {
    const store = probeStore({ limitMs: 30_000 });
    await store.exec("CREATE TABLE notes (body TEXT)");
    const running = failure(store.process.call("write_then_spin", ["half a call"]));
    await Bun.sleep(150);
    const started = Date.now();
    await store.process.close({ withinMs: 200 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(((await running) as StoreStopped).why).toBe("exited");
    expect(store.process.isOpen).toBe(false);
    expect((await store.exec("SELECT count(*) FROM notes")).rows).toEqual([[0]]);
  });

  test("it closes by itself when no call came for a while", async () => {
    const store = probeStore({ idleMs: 150 });
    await store.exec("CREATE TABLE t (a)");
    const pid = (await store.process.call("pid")) as number;
    expect(await goneWithin(pid, 3_000)).toBe(true);
    expect(store.process.isOpen).toBe(false);
    // And is started again by the next call.
    expect((await store.exec("SELECT count(*) FROM t")).rows).toEqual([[0]]);
  });

  test("the program may ask for a new process", async () => {
    const store = probeStore();
    await store.exec("CREATE TABLE t (a)");
    const stopped = (await failure(store.process.call("abort"))) as StoreStopped;
    expect(stopped.why).toBe("aborted");
    expect((await store.exec("SELECT count(*) FROM t")).rows).toEqual([[0]]);
  });

  test("a disposed Store's process is ended with its call, and takes no more", async () => {
    const store = probeStore({ limitMs: 30_000 });
    await store.exec("CREATE TABLE t (a)");
    const pid = (await store.process.call("pid")) as number;
    const running = failure(store.exec(ENDLESS));
    const waiting = failure(store.exec("SELECT 1"));
    await Bun.sleep(100);
    await store.process.dispose();
    expect(((await running) as StoreStopped).why).toBe("exited");
    expect(await waiting).toBeInstanceOf(StoreStopped);
    expect(await goneWithin(pid, 2_000)).toBe(true);
    expect(await failure(store.exec("SELECT 1"))).toBeInstanceOf(StoreStopped);
    expect(store.process.isOpen).toBe(false);
  });

  test("a Store that is disposed while it waits for a held file starts no process afterwards", async () => {
    const folder = newStoreFolder();
    const first = probeStore({ folder });
    await first.exec("CREATE TABLE t (a)");
    // A launcher that counts what it starts.
    let starts = 0;
    const real = probeLauncher(folder.scratch);
    const counting: StoreLauncher = {
      start(options) {
        starts += 1;
        return real.start(options);
      },
    };
    const second = probeStore({ folder, launcher: counting });
    const refused = failure(second.exec("SELECT 1"));
    // The second one's first try found the file held, and it waits to try again.
    await Bun.sleep(250);
    expect(starts).toBe(1);
    await second.process.dispose();
    expect(await refused).toBeInstanceOf(StoreStopped);
    // Past the time of two more tries: none was made.
    await Bun.sleep(1_200);
    expect(starts).toBe(1);
    expect(second.process.isOpen).toBe(false);
    expect(await failure(second.exec("SELECT 1"))).toBeInstanceOf(StoreStopped);
    expect(starts).toBe(1);
    // The first is not disturbed.
    expect((await first.exec("SELECT count(*) FROM t")).rows).toEqual([[0]]);
  }, 15_000);

  test("a Store whose one call left the line while it waited for a held file starts no process afterwards", async () => {
    const folder = newStoreFolder();
    const first = probeStore({ folder });
    await first.exec("CREATE TABLE t (a)");
    // A launcher that counts what it starts.
    let starts = 0;
    const real = probeLauncher(folder.scratch);
    const counting: StoreLauncher = {
      start(options) {
        starts += 1;
        return real.start(options);
      },
    };
    // The call's own limit is shorter than the wait between two tries at a
    // file that is held.
    const second = probeStore({ folder, launcher: counting, limitMs: 250 });
    const left = (await failure(second.exec("SELECT 1"))) as StoreStopped;
    expect(left).toBeInstanceOf(StoreStopped);
    expect(left.why).toBe("limit");
    // Past the time of the next tries: nobody waits, so none was made. A
    // process started now would hold the file with nobody knowing of it.
    await Bun.sleep(1_800);
    expect(starts).toBe(1);
    expect(second.process.isOpen).toBe(false);
    expect(second.process.isBusy).toBe(false);
    // The first is not disturbed.
    expect((await first.exec("SELECT count(*) FROM t")).rows).toEqual([[0]]);
  }, 15_000);

  test("two processes cannot hold one Store: the second is refused", async () => {
    const folder = newStoreFolder();
    const first = probeStore({ folder });
    await first.exec("CREATE TABLE t (a)");
    const second = probeStore({ folder, startLimitMs: 5_000 });
    const refused = (await failure(second.exec("SELECT 1"))) as StoreStopped;
    expect(refused).toBeInstanceOf(StoreStopped);
    expect(refused.why).toBe("open_failed");
    expect(refused.code).toBe("sqlite_busy");
    // The first is not disturbed.
    expect((await first.exec("SELECT count(*) FROM t")).rows).toEqual([[0]]);
  }, 15_000);

  test("a process that does not start is told, not waited for", async () => {
    const folder = newStoreFolder();
    const missing = new StoreProcess({
      folder: folder.root,
      launcher: commandLauncher([path.join(folder.root, "no-such-program")], folder.scratch),
      startLimitMs: 2_000,
    });
    const refused = (await failure(missing.call("pid"))) as StoreStopped;
    expect(refused).toBeInstanceOf(StoreStopped);
    expect(refused.why).toBe("open_failed");
  });

  test("a program that never opens the Store is ended at the start limit", async () => {
    const folder = newStoreFolder();
    const silent = new StoreProcess({
      folder: folder.root,
      // A program that runs and says nothing.
      launcher: commandLauncher([process.execPath, "-e", "setInterval(() => {}, 1000)"], folder.scratch),
      startLimitMs: 400,
    });
    const started = Date.now();
    const refused = (await failure(silent.call("pid"))) as StoreStopped;
    expect(refused.why).toBe("open_failed");
    expect(refused.code).toBe("start_limit");
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  test("it ends itself when the program that started it is gone, even inside a statement", async () => {
    // A small program stands in for HX Fortress: it starts a Store's process,
    // sets it on a statement that never ends, prints the process's number and
    // is then ended from outside.
    const folder = newStoreFolder();
    const parent = `
      const child = Bun.spawn([process.execPath, ${JSON.stringify(PROBE)}], {
        stdio: ["ignore", "ignore", "ignore"], env: {}, serialization: "advanced",
        ipc(message) {
          if (message.t === "opened") {
            child.send({ t: "call", id: 1, name: "exec", args: [${JSON.stringify(ENDLESS)}] });
            console.log(child.pid);
          }
        },
      });
      child.send({ t: "open", folder: ${JSON.stringify(folder.root)}, settings: {} });
      setInterval(() => {}, 1000);
    `;
    const program = Bun.spawn([process.execPath, "-e", parent], { stdout: "pipe", stderr: "ignore" });
    let pid = 0;
    try {
      const reader = program.stdout.getReader();
      const first = await Promise.race([
        reader.read(),
        Bun.sleep(8_000).then(() => ({ value: undefined, done: true })),
      ]);
      pid = Number(new TextDecoder().decode(first.value ?? new Uint8Array()).trim());
      expect(pid).toBeGreaterThan(0);
      await Bun.sleep(300);
      expect(alive(pid)).toBe(true);
      program.kill("SIGKILL");
      await program.exited;
      expect(await goneWithin(pid, 3_000)).toBe(true);
    } finally {
      // Whatever a failed check left running is ended here: the stand-in, and
      // a Store's process that did not end itself.
      program.kill("SIGKILL");
      if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
    }
  }, 20_000);

  test("after a close the Store's folder holds its file, an empty journal and an empty scratch folder", async () => {
    const store = probeStore();
    await store.exec("CREATE TABLE permits (address TEXT)");
    await store.exec("INSERT INTO permits VALUES ('18 Mill Road')");
    await store.process.close();
    // SQLite's journal stays beside the Store, empty between changes.
    expect(readdirSync(store.folder.root).sort()).toEqual([
      "files",
      "scratch",
      "snapshots",
      "store.sqlite",
      "store.sqlite-journal",
    ]);
    expect(statSync(`${store.folder.database}-journal`).size).toBe(0);
    expect(readdirSync(store.folder.scratch)).toEqual([]);
    expect(readFileSync(store.folder.database).includes("18 Mill Road")).toBe(true);
  });
});

/** A Store on processes that are none: each start hands out the next one. */
function madeUp(
  options: Partial<StoreProcessOptions> & {
    behaviour?: Parameters<typeof madeUpProcess>[1];
    /** How long the launcher takes to hand out a process, for each start. */
    startAfterMs?: number;
  } = {},
): { store: StoreProcess; started: MadeUpProcess[] } {
  const { behaviour, startAfterMs, ...rest } = options;
  const started: MadeUpProcess[] = [];
  const folder = newStoreFolder();
  const store = new StoreProcess({
    folder: folder.root,
    idleMs: 0,
    launcher: {
      async start({ onMessage }) {
        if (startAfterMs) await Bun.sleep(startAfterMs);
        const made = madeUpProcess(onMessage, behaviour);
        started.push(made);
        return made.child;
      },
    },
    ...rest,
  });
  madeUpStores.push(store);
  return { store, started };
}

const madeUpStores: StoreProcess[] = [];
afterEach(async () => {
  await Promise.all(madeUpStores.splice(0).map((store) => store.dispose()));
});

describe("a process that was ended and is not gone yet", () => {
  test("is sent nothing more: the call that waits gets a new process", async () => {
    // The first call's answer arrives a moment after its limit ended the
    // process, and the process is gone a moment after that.
    const log: string[] = [];
    let count = 0;
    const folder = newStoreFolder();
    const store = new StoreProcess({
      folder: folder.root,
      idleMs: 0,
      limitMs: 5_000,
      launcher: {
        start({ onMessage }): Promise<StoreChild> {
          count += 1;
          const number = count;
          let killed = false;
          let gone: () => void = () => undefined;
          const exited = new Promise<void>((resolve) => (gone = resolve));
          return Promise.resolve({
            send(message: ToStore): void {
              if (message.t === "open") {
                queueMicrotask(() => onMessage({ t: "opened", alarm: null }));
              } else if (message.t === "call") {
                log.push(`process ${number}${killed ? " (ended)" : ""} <- call ${message.id}`);
                const answer: FromStore = { t: "answer", id: message.id, ok: true, value: number };
                // Only the very first call is slow.
                setTimeout(() => onMessage(answer), number === 1 && message.id === 1 ? 100 : 0);
              } else if (message.t === "close") {
                gone();
              }
            },
            kill(): void {
              killed = true;
              log.push(`process ${number} ended`);
              setTimeout(gone, 20);
            },
            exited,
          });
        },
      },
    });
    madeUpStores.push(store);
    const results = await Promise.allSettled([
      store.call("a", [], { limitMs: 90 }),
      store.call("b"),
      store.call("c"),
    ]);
    // The late answer is the first call's. The other two ran on a new process.
    expect(results.map((result) => (result.status === "fulfilled" ? result.value : "refused"))).toEqual([1, 2, 2]);
    expect(log.filter((line) => line.includes("(ended)"))).toEqual([]);
    expect(store.stopped).toBe(0);
  });
});

describe("a process that is ended and does not go away", () => {
  const stuck = (): ReturnType<typeof madeUp> =>
    madeUp({ behaviour: { endsWhenTold: false }, limitMs: 100, goneLimitMs: 150 });

  test("a call past its limit is refused in time, and the next call gets a new process", async () => {
    const { store, started } = stuck();
    const began = Date.now();
    const stopped = (await failure(store.call("exec", ["SELECT 1"]))) as StoreStopped;
    expect(stopped).toBeInstanceOf(StoreStopped);
    expect(stopped.why).toBe("limit");
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(started.at(0)?.kills()).toBe(1);
    expect(store.isOpen).toBe(false);
    // The next call opens the Store anew.
    void store.call("exec", ["SELECT 2"]).catch(() => undefined);
    await Bun.sleep(30);
    expect(started).toHaveLength(2);
    expect(started.at(1)?.sent.map((message) => message.t)).toEqual(["open", "call"]);
  });

  test("closing it and disposing of it end in time", async () => {
    const { store } = stuck();
    void store.call("exec", ["SELECT 1"]).catch(() => undefined);
    await Bun.sleep(20);
    let began = Date.now();
    await store.close({ withinMs: 50 });
    expect(Date.now() - began).toBeLessThan(4_000);
    expect(store.isOpen).toBe(false);

    void store.call("exec", ["SELECT 2"]).catch(() => undefined);
    await Bun.sleep(20);
    began = Date.now();
    await store.dispose();
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(store.isOpen).toBe(false);
  }, 15_000);
});

describe("starting a process is the module host's, and may take time or be refused", () => {
  test("a start the host refuses is told as not started, and the next call tries again", async () => {
    let tries = 0;
    const folder = newStoreFolder();
    const real = probeLauncher(folder.scratch);
    const store = new StoreProcess({
      folder: folder.root,
      idleMs: 0,
      launcher: {
        start(options) {
          tries += 1;
          return tries === 1 ? Promise.reject(new Error("busy")) : real.start(options);
        },
      },
    });
    madeUpStores.push(store);
    const refused = (await failure(store.call("pid"))) as StoreStopped;
    expect(refused).toBeInstanceOf(StoreStopped);
    expect(refused.why).toBe("open_failed");
    expect(refused.code).toBe("not_started");
    expect(store.isOpen).toBe(false);
    expect(typeof (await store.call("pid"))).toBe("number");
  });

  test("whatever a launcher fails with is told by this file's own words, never by the launcher's", async () => {
    for (const thrown of [
      new StoreStopped("limit", "sqlite_busy"),
      new StoreStopped("open_failed", "start_limit"),
      "18 Mill Road",
      null,
    ]) {
      const folder = newStoreFolder();
      let starts = 0;
      const store = new StoreProcess({
        folder: folder.root,
        idleMs: 0,
        launcher: {
          start() {
            starts += 1;
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a launcher may reject with anything
            return Promise.reject(thrown);
          },
        },
      });
      madeUpStores.push(store);
      const refused = (await failure(store.call("pid"))) as StoreStopped;
      expect(refused.why).toBe("open_failed");
      expect(refused.code).toBe("not_started");
      // Told at once: a refusal is not taken for a file that another process
      // holds, which would be tried again.
      expect(starts).toBe(1);
    }
  });

  test("the folder a process is started for is not made by its start: one that is gone is a refusal", async () => {
    const folder = newStoreFolder();
    rmSync(folder.root, { recursive: true });
    const store = new StoreProcess({ folder: folder.root, idleMs: 0, launcher: probeLauncher(folder.scratch) });
    madeUpStores.push(store);
    const refused = (await failure(store.call("pid"))) as StoreStopped;
    expect(refused.why).toBe("open_failed");
    expect(refused.code).toBe("not_started");
    expect(existsSync(folder.root)).toBe(false);
  });

  test("a start that never ends is given up at the start limit, and a process that starts after all is ended", async () => {
    let release: (child: StoreChild) => void = () => undefined;
    let late: MadeUpProcess | null = null;
    const folder = newStoreFolder();
    const store = new StoreProcess({
      folder: folder.root,
      startLimitMs: 150,
      idleMs: 0,
      launcher: {
        start: ({ onMessage }) =>
          new Promise<StoreChild>((resolve) => {
            release = (): void => {
              late = madeUpProcess(onMessage);
              resolve(late.child);
            };
          }),
      },
    });
    madeUpStores.push(store);
    const waiting = failure(store.call("pid"));
    await Bun.sleep(20);
    // A start that is on its way counts as a process: the Store is in use.
    expect(store.isOpen).toBe(true);
    const began = Date.now();
    const refused = (await waiting) as StoreStopped;
    expect(refused.why).toBe("open_failed");
    expect(refused.code).toBe("start_limit");
    expect(Date.now() - began).toBeLessThan(2_000);
    // Given up, and still on its way: it still counts.
    expect(store.isOpen).toBe(true);
    // The host starts the process after all. Nobody waits for it any more.
    release(null as never);
    await Bun.sleep(20);
    expect((late as MadeUpProcess | null)?.kills()).toBe(1);
    expect((late as MadeUpProcess | null)?.sent).toEqual([]);
    expect(store.isOpen).toBe(false);
  });

  test("one start at a time: while one that was given up is on its way, no other is begun", async () => {
    let starts = 0;
    let release: () => void = () => undefined;
    const handed: MadeUpProcess[] = [];
    const folder = newStoreFolder();
    const store = new StoreProcess({
      folder: folder.root,
      startLimitMs: 120,
      idleMs: 0,
      launcher: {
        start({ onMessage }) {
          starts += 1;
          const made = madeUpProcess(onMessage);
          handed.push(made);
          // The first start hangs until the test lets it go.
          if (starts > 1) return Promise.resolve(made.child);
          return new Promise<StoreChild>((resolve) => (release = (): void => resolve(made.child)));
        },
      },
    });
    madeUpStores.push(store);
    expect(((await failure(store.call("a"))) as StoreStopped).code).toBe("start_limit");
    // The next call does not begin a second start beside the first. It waits
    // for it within its own limit, and is told the same.
    expect(((await failure(store.call("b"))) as StoreStopped).code).toBe("start_limit");
    expect(starts).toBe(1);
    // The first start ends at last. Its process is ended unopened, and the
    // next call begins a start of its own.
    const third = store.call("c");
    await Bun.sleep(20);
    release();
    await Bun.sleep(30);
    expect(starts).toBe(2);
    expect(handed.at(0)?.kills()).toBe(1);
    expect(handed.at(0)?.sent).toEqual([]);
    handed.at(1)?.answer("from the second");
    expect(await third).toBe("from the second");
  });

  test("the start and the open share one limit", async () => {
    const { store, started } = madeUp({ behaviour: { opens: false }, startAfterMs: 600, startLimitMs: 800 });
    const began = Date.now();
    const refused = (await failure(store.call("pid"))) as StoreStopped;
    expect(refused.code).toBe("start_limit");
    // The limit once, which is 800 ms. With a limit for each, the start's 600
    // and then the open's 800 would make 1,400.
    expect(Date.now() - began).toBeLessThan(1_250);
    expect(started.at(0)?.kills()).toBe(1);
  });

  test("disposing of a Store does not wait for a start that is on its way, and the process it brings is ended unopened", async () => {
    const { store, started } = madeUp({ startAfterMs: 150 });
    const waiting = failure(store.call("pid"));
    await Bun.sleep(20);
    const began = Date.now();
    await store.dispose();
    // A start makes nothing on the disk, so there is nothing to wait for.
    expect(Date.now() - began).toBeLessThan(100);
    expect(await waiting).toBeInstanceOf(StoreStopped);
    await Bun.sleep(200);
    expect(started).toHaveLength(1);
    expect(started.at(0)?.kills()).toBe(1);
    // It was never told a folder.
    expect(started.at(0)?.sent).toEqual([]);
    expect(store.isOpen).toBe(false);
  });

  test("what a process says before it is the Store's own is not heard", async () => {
    const folder = newStoreFolder();
    let eager: MadeUpProcess | null = null;
    const store = new StoreProcess({
      folder: folder.root,
      startLimitMs: 200,
      idleMs: 0,
      launcher: {
        start({ onMessage }) {
          eager = madeUpProcess(onMessage, { opens: false });
          // It claims to be open before the host has handed it over, and it
          // never answers the open it is then sent.
          onMessage({ t: "opened", alarm: null });
          return Promise.resolve(eager.child);
        },
      },
    });
    madeUpStores.push(store);
    const refused = (await failure(store.call("pid"))) as StoreStopped;
    expect(refused.why).toBe("open_failed");
    expect(refused.code).toBe("start_limit");
    // The open was sent, and no call after it.
    expect((eager as MadeUpProcess | null)?.sent.map((message) => message.t)).toEqual(["open"]);
  });

  test("a value that is no message of a Store's process is dropped", async () => {
    const { store, started } = madeUp();
    const first = store.call("a");
    await Bun.sleep(10);
    const process_ = started.at(0) as MadeUpProcess;
    // The host passes every value through unread. None of these is a message
    // of a Store's process, and none may throw or end anything.
    for (const value of ["opened", null, 7, { t: "answer_all", id: 1 }, { id: 1, ok: true }]) {
      process_.say(value as never);
    }
    expect(store.isOpen).toBe(true);
    process_.answer("a's answer");
    expect(await first).toBe("a's answer");
  });
});

describe("what the channel carries is not trusted", () => {
  test("a failure's code is one word, whatever the process sent", async () => {
    const { store, started } = madeUp();
    const codes: string[] = [];
    for (const code of ["18 Mill Road | Lena Hart", "", 7, null, "x".repeat(49), "Not_A_Word", "sqlite_constraint"]) {
      const call = failure(store.call("exec"));
      await Bun.sleep(5);
      const process_ = started.at(0) as MadeUpProcess;
      const id = process_.waiting.shift() as number;
      process_.say({ t: "answer", id, ok: false, code, words: "the words stay apart" } as never);
      const failed = (await call) as StoreCallFailed;
      expect(failed).toBeInstanceOf(StoreCallFailed);
      expect(failed.message).not.toContain("Mill Road");
      codes.push(failed.code);
    }
    expect(codes).toEqual(["internal", "internal", "internal", "internal", "internal", "internal", "sqlite_constraint"]);
  });

  test("the word a process gives for not opening the Store is one word too", async () => {
    const folder = newStoreFolder();
    const store = new StoreProcess({
      folder: folder.root,
      idleMs: 0,
      launcher: {
        start({ onMessage }) {
          const made = madeUpProcess(onMessage, { opens: false });
          const send = made.child.send.bind(made.child);
          made.child.send = (message): void => {
            send(message);
            if (message.t === "open") {
              onMessage({ t: "open_failed", code: "18 Mill Road" });
              made.go();
            }
          };
          return Promise.resolve(made.child);
        },
      },
    });
    madeUpStores.push(store);
    const refused = (await failure(store.call("pid"))) as StoreStopped;
    expect(refused.why).toBe("open_failed");
    expect(refused.code).toBe("internal");
  });
});

describe("a Store that is disposed of", () => {
  test("with a moment given: the calls that wait are refused first, the running one may end, and no process is started again", async () => {
    const { store, started } = madeUp();
    const running = store.call("a");
    const waiting = failure(store.call("b"));
    await Bun.sleep(10);
    // One runs and one waits.
    expect(store.pending).toBe(2);
    const disposing = store.dispose({ withinMs: 2_000 });
    // The one that waited is refused at once, and never sent.
    expect(await waiting).toBeInstanceOf(StoreStopped);
    // The one that runs gets its answer.
    await Bun.sleep(20);
    started.at(0)?.answer("a's answer");
    expect(await running).toBe("a's answer");
    await disposing;
    // Asked to close, not ended: it had nothing running any more.
    expect(started.at(0)?.sent.map((message) => message.t)).toEqual(["open", "call", "close"]);
    expect(started.at(0)?.kills()).toBe(0);
    await Bun.sleep(30);
    expect(started).toHaveLength(1);
    expect(store.isOpen).toBe(false);
    expect(await failure(store.call("c"))).toBeInstanceOf(StoreStopped);
  });

  test("with a moment given that passes: the running call is refused as stopped, and its process is ended", async () => {
    const { store, started } = madeUp();
    const running = failure(store.call("a"));
    await Bun.sleep(10);
    const began = Date.now();
    await store.dispose({ withinMs: 60 });
    expect(Date.now() - began).toBeGreaterThanOrEqual(50);
    expect(await running).toBeInstanceOf(StoreStopped);
    expect(started.at(0)?.kills()).toBe(1);
    await Bun.sleep(30);
    expect(started).toHaveLength(1);
  });

  test("with no moment given: everything is refused at once", async () => {
    const { store, started } = madeUp();
    const running = failure(store.call("a"));
    const waiting = failure(store.call("b"));
    await Bun.sleep(10);
    const began = Date.now();
    await store.dispose();
    expect(Date.now() - began).toBeLessThan(100);
    expect(await running).toBeInstanceOf(StoreStopped);
    expect(await waiting).toBeInstanceOf(StoreStopped);
    expect(started.at(0)?.kills()).toBe(1);
  });
});

describe("a start is for a call that waits now", () => {
  test("a call that left the line while an ended process was not gone yet gets no process", async () => {
    // A process that is ended and takes its time to go.
    const { store, started } = madeUp({ behaviour: { endsWhenTold: false }, goneLimitMs: 300 });
    const first = store.call("a", [], { limitMs: 50 }).catch(() => undefined);
    const second = failure(store.call("b", [], { limitMs: 150 }));
    // The first call's limit has ended its process. Its answer comes a moment
    // late, so the second call is next, and waits for the process to be gone.
    await Bun.sleep(70);
    expect(started.at(0)?.kills()).toBe(1);
    started.at(0)?.answer("late");
    await first;
    // The second call's own limit passes during that wait.
    expect(((await second) as StoreStopped).why).toBe("limit");
    expect(store.isBusy).toBe(false);
    // The ended process is taken as gone. Nobody waits: nothing is started.
    await Bun.sleep(450);
    expect(started).toHaveLength(1);
    expect(store.isOpen).toBe(false);
    // A call that comes now gets a process of its own.
    const third = store.call("c");
    await Bun.sleep(20);
    expect(started).toHaveLength(2);
    started.at(1)?.answer("c's answer");
    expect(await third).toBe("c's answer");
  });

  test("a call that left the line while an earlier start was still on its way gets no start of its own", async () => {
    // A launcher whose starts the test itself lets go, so that no clock says
    // when the first start ends.
    const started: MadeUpProcess[] = [];
    const letGo: (() => void)[] = [];
    let asked = 0;
    const folder = newStoreFolder();
    const store = new StoreProcess({
      folder: folder.root,
      idleMs: 0,
      limitMs: 10_000,
      startLimitMs: 500,
      launcher: {
        async start({ onMessage }) {
          asked += 1;
          await new Promise<void>((resolve) => letGo.push(resolve));
          const made = madeUpProcess(onMessage);
          started.push(made);
          return made.child;
        },
      },
    });
    madeUpStores.push(store);
    // The first call's start is given up at its limit. The start itself goes on.
    const first = (await failure(store.call("a"))) as StoreStopped;
    expect(first.why).toBe("open_failed");
    expect(first.code).toBe("start_limit");
    expect(asked).toBe(1);
    // The second call waits for that start to end before one of its own is
    // begun, and leaves the line meanwhile, at its limit.
    const second = (await failure(store.call("b", [], { limitMs: 30 }))) as StoreStopped;
    expect(second.why).toBe("limit");
    expect(store.isBusy).toBe(false);
    expect(asked).toBe(1);
    // Now the first start ends: its process comes, and is ended as nobody's.
    letGo.at(0)?.();
    await Bun.sleep(30);
    expect(started).toHaveLength(1);
    expect(started.at(0)?.kills()).toBe(1);
    expect(started.at(0)?.sent).toEqual([]);
    // Nobody waits, so no second start was asked for.
    expect(asked).toBe(1);
    expect(store.isOpen).toBe(false);
    // A call that comes now gets a start of its own.
    const third = store.call("c");
    await Bun.sleep(10);
    expect(asked).toBe(2);
    letGo.at(1)?.();
    await Bun.sleep(10);
    started.at(1)?.answer("c's answer");
    expect(await third).toBe("c's answer");
  });

  test("a call that comes while the Store waits for the ended process gets the next process", async () => {
    const { store, started } = madeUp({ behaviour: { endsWhenTold: false }, goneLimitMs: 200 });
    const first = store.call("a", [], { limitMs: 40 }).catch(() => undefined);
    const second = failure(store.call("b", [], { limitMs: 100 }));
    await Bun.sleep(60);
    started.at(0)?.answer("late");
    await first;
    expect(((await second) as StoreStopped).why).toBe("limit");
    const third = store.call("c", [], { limitMs: 2_000 });
    await Bun.sleep(350);
    expect(started).toHaveLength(2);
    started.at(1)?.answer("c's answer");
    expect(await third).toBe("c's answer");
  });

  test("a call that comes in the very moment nothing was started is not told of a failure", async () => {
    // The moment is a few turns of the runtime's own queue long: between
    // finding that nobody waits and going back to look at the line. A call
    // is put into the line after each number of turns from the moment the
    // ended process is gone, so that some of them fall into it, whatever the
    // runtime's own count is.
    const one = async (turns: number): Promise<unknown> => {
      let third: Promise<unknown> | null = null;
      let armed = false;
      const { store, started } = madeUp({
        behaviour: { endsWhenTold: false },
        goneLimitMs: 5_000,
        onGone: () => {
          if (!armed) return;
          armed = false;
          let wait = Promise.resolve();
          for (let turn = 0; turn < turns; turn += 1) wait = wait.then(() => undefined);
          void wait.then(() => {
            third = store.call("c", [], { limitMs: 2_000 });
            third.catch(() => undefined);
          });
        },
      });
      const first = store.call("a", [], { limitMs: 30 }).catch(() => undefined);
      const second = failure(store.call("b", [], { limitMs: 60 }));
      await Bun.sleep(40);
      started.at(0)?.answer("late");
      await first;
      expect(((await second) as StoreStopped).why).toBe("limit");
      // The ended process goes now, and the third call comes.
      armed = true;
      started.at(0)?.go();
      // It gets a process of its own, and is sent to it.
      for (let i = 0; i < 300 && started.at(1)?.waiting.length !== 1; i += 1) await Bun.sleep(10);
      expect(third).not.toBeNull();
      expect(started).toHaveLength(2);
      started.at(1)?.answer("c's answer");
      const answer = await third;
      // The second process goes too, so the end of the test waits for nothing.
      started.at(1)?.go();
      return answer;
    };
    const answers = await Promise.all(Array.from({ length: 24 }, (_, turns) => one(turns)));
    expect(answers).toEqual(Array.from({ length: 24 }, () => "c's answer"));
  });
});

describe("a process with nothing to do", () => {
  test("one that was opened for a call that left the line at its limit closes like any other", async () => {
    // The start takes longer than the call's own limit. The process is there
    // after 80 ms, and closes 500 ms after that: each look below is 250 ms or
    // more away from both.
    const { store, started } = madeUp({ startAfterMs: 80, idleMs: 500, startLimitMs: 5_000 });
    const left = (await failure(store.call("a", [], { limitMs: 30 }))) as StoreStopped;
    expect(left.why).toBe("limit");
    // The process arrives, opens the Store, and is sent nothing.
    await Bun.sleep(300);
    expect(started).toHaveLength(1);
    expect(started.at(0)?.sent.map((message) => message.t)).toEqual(["open"]);
    expect(store.isOpen).toBe(true);
    // No call comes, so it is closed.
    await Bun.sleep(550);
    expect(started.at(0)?.sent.map((message) => message.t)).toEqual(["open", "close"]);
    expect(store.isOpen).toBe(false);
  });
});
