import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { readAlarm } from "../../../src/modules/stores/host/store-folder";
import type { FromStore, ToStore } from "../../../src/modules/stores/host/process-protocol";
import {
  StoreCallFailed,
  StoreProcess,
  StoreStopped,
  type StopReason,
  type StoreChild,
  type StoreLauncher,
} from "../../../src/modules/stores/host/store-process";
import {
  cleanFolders,
  commandLauncher,
  endProcesses,
  newStoreFolder,
  PROBE,
  probeLauncher,
  probeStore,
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

  test("is started with nothing of this program's environment, in the Store's own folder", async () => {
    process.env.HX_FORTRESS_TEST_SECRET = "must not be inherited";
    const store = probeStore();
    const seen = (await store.process.call("environment")) as { names: string[]; umask: number; cwd: string };
    delete process.env.HX_FORTRESS_TEST_SECRET;
    expect(seen.names).toEqual(["SQLITE_TMPDIR"]);
    // Whatever it makes is for its owner alone.
    expect(seen.umask).toBe(0o077);
    expect(seen.cwd).toBe(store.folder.scratch);
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
    const store = probeStore({ limitMs: 400 });
    await store.exec("CREATE TABLE t (a)");
    const pid = (await store.process.call("pid")) as number;

    // This program's own loop: a tick every 10 ms. A statement on this thread
    // would hold it for good.
    let ticks = 0;
    const ticker = setInterval(() => (ticks += 1), 10);
    const started = Date.now();
    const stopped = (await failure(store.exec(ENDLESS))) as StoreStopped;
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
    const store = probeStore({ limitMs: 400 });
    await store.exec("CREATE TABLE notes (body TEXT)");
    await store.exec("INSERT INTO notes VALUES ('kept before')");
    const before = (await store.process.call("pid")) as number;
    await failure(store.exec(ENDLESS));
    expect((await store.exec("SELECT body FROM notes")).rows).toEqual([["kept before"]]);
    const after = (await store.process.call("pid")) as number;
    expect(after).not.toBe(before);
  });

  test("what the stopped call had written is not kept", async () => {
    const store = probeStore({ limitMs: 400 });
    await store.exec("CREATE TABLE notes (body TEXT)");
    const stopped = (await failure(store.process.call("write_then_spin", ["half a call"]))) as StoreStopped;
    expect(stopped.why).toBe("limit");
    expect((await store.exec("SELECT count(*) FROM notes")).rows).toEqual([[0]]);
  });

  test("the calls that waited behind it are not lost", async () => {
    const store = probeStore({ limitMs: 400 });
    await store.exec("CREATE TABLE t (n INTEGER)");
    const results = await Promise.allSettled([
      store.exec(ENDLESS),
      store.exec("INSERT INTO t VALUES (1)"),
      store.exec("INSERT INTO t VALUES (2)"),
      store.exec("SELECT count(*) FROM t"),
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled", "fulfilled", "fulfilled"]);
    expect((results.at(3) as PromiseFulfilledResult<{ rows: unknown[][] }>).value.rows).toEqual([[2]]);
  });

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
    const store = probeStore({ limitMs: 400 });
    await store.exec("CREATE TABLE notes (body TEXT)");
    const stopped = (await failure(store.process.call("transaction_then_spin", ["a try"]))) as StoreStopped;
    expect(stopped.why).toBe("limit");
    expect((await store.exec("SELECT body FROM notes")).rows).toEqual([["a try"]]);
  });

  test("what was written before the program waited is kept, and what came after it is not", async () => {
    const store = probeStore({ limitMs: 500 });
    await store.exec("CREATE TABLE notes (body TEXT)");
    const stopped = (await failure(store.process.call("write_wait_write_spin", ["before", "after"]))) as StoreStopped;
    expect(stopped.why).toBe("limit");
    expect((await store.exec("SELECT body FROM notes")).rows).toEqual([["before"]]);
  });

  test("a Store that was emptied in a call that is then stopped is empty, not half made again", async () => {
    const store = probeStore({ limitMs: 500 });
    await store.exec("CREATE TABLE notes (body TEXT)");
    await store.exec("INSERT INTO notes VALUES ('old')");
    const stopped = (await failure(store.process.call("empty_write_spin"))) as StoreStopped;
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
    const store = probeStore({ limitMs: 500 });
    await store.exec("CREATE TABLE notes (body TEXT)");
    await store.exec("INSERT INTO notes VALUES ('wake:spin')");
    await store.process.call("set_alarm", [1_000]);
    const stopped = (await failure(store.process.wake())) as StoreStopped;
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
      limitMs: 400,
      onAlarm: () => {
        throw new Error("a listener's own failure");
      },
      onGone: () => {
        throw new Error("a listener's own failure");
      },
    });
    await store.exec("CREATE TABLE t (n INTEGER)");
    await store.process.call("set_alarm", [5_000]);
    const results = await Promise.allSettled([store.exec(ENDLESS), store.exec("INSERT INTO t VALUES (1)")]);
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
    const real = probeLauncher();
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
      scratch: folder.scratch,
      launcher: commandLauncher([path.join(folder.root, "no-such-program")]),
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
      scratch: folder.scratch,
      // A program that runs and says nothing.
      launcher: commandLauncher([process.execPath, "-e", "setInterval(() => {}, 1000)"]),
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

describe("a process that was ended and is not gone yet", () => {
  test("is sent nothing more: the call that waits gets a new process", async () => {
    // The first call's answer arrives a moment after its limit ended the
    // process, and the process is gone a moment after that.
    const log: string[] = [];
    let started = 0;
    const launcher: StoreLauncher = {
      start({ onMessage }): StoreChild {
        started += 1;
        const number = started;
        let killed = false;
        let gone: () => void = () => undefined;
        const exited = new Promise<void>((resolve) => (gone = resolve));
        return {
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
        };
      },
    };
    const folder = newStoreFolder();
    const store = new StoreProcess({
      folder: folder.root,
      scratch: folder.scratch,
      launcher,
      limitMs: 90,
      idleMs: 0,
    });
    const results = await Promise.allSettled([store.call("a"), store.call("b"), store.call("c")]);
    await store.dispose();
    // The late answer is the first call's. The other two ran on a new process.
    expect(results.map((result) => (result.status === "fulfilled" ? result.value : "refused"))).toEqual([1, 2, 2]);
    expect(log.filter((line) => line.includes("(ended)"))).toEqual([]);
    expect(store.stopped).toBe(0);
  });
});

describe("a process that is ended and does not go away", () => {
  /** A launcher whose process answers the open and nothing else, and never
   *  ends, whatever it is told. No process is started. */
  function stuckLauncher(): { launcher: StoreLauncher; kills: () => number; sent: ToStore[] } {
    let kills = 0;
    const sent: ToStore[] = [];
    return {
      kills: () => kills,
      sent,
      launcher: {
        start({ onMessage }): StoreChild {
          return {
            send(message: ToStore): void {
              sent.push(message);
              if (message.t === "open") {
                const opened: FromStore = { t: "opened", alarm: null };
                queueMicrotask(() => onMessage(opened));
              }
            },
            kill(): void {
              kills += 1;
            },
            exited: new Promise<never>(() => {}),
          };
        },
      },
    };
  }

  function stuckStore(): { process: StoreProcess; kills: () => number; sent: ToStore[] } {
    const { launcher, kills, sent } = stuckLauncher();
    const folder = newStoreFolder();
    const made = new StoreProcess({
      folder: folder.root,
      scratch: folder.scratch,
      launcher,
      limitMs: 100,
      goneLimitMs: 150,
      idleMs: 0,
    });
    return { process: made, kills, sent };
  }

  test("a call past its limit is refused in time, and the next call gets a new process", async () => {
    const { process: store, kills, sent } = stuckStore();
    const started = Date.now();
    const stopped = (await failure(store.call("exec", ["SELECT 1"]))) as StoreStopped;
    expect(stopped).toBeInstanceOf(StoreStopped);
    expect(stopped.why).toBe("limit");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(kills()).toBe(1);
    expect(store.isOpen).toBe(false);
    // The next call opens the Store anew.
    void store.call("exec", ["SELECT 2"]).catch(() => undefined);
    await Bun.sleep(30);
    expect(sent.filter((message) => message.t === "open")).toHaveLength(2);
    await store.dispose();
  });

  test("closing it and disposing of it end in time", async () => {
    const { process: store } = stuckStore();
    void store.call("exec", ["SELECT 1"]).catch(() => undefined);
    await Bun.sleep(20);
    let started = Date.now();
    await store.close({ withinMs: 50 });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(store.isOpen).toBe(false);

    void store.call("exec", ["SELECT 2"]).catch(() => undefined);
    await Bun.sleep(20);
    started = Date.now();
    await store.dispose();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(store.isOpen).toBe(false);
  }, 15_000);
});

