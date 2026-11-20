// The engine's program for a Store's process, and the word that starts it.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { runCli } from "../../../../src/cli";
import { CONTROL_PLANE_ACTOR as HOST_CONTROL_PLANE_ACTOR } from "../../../../src/host/module-audit";
import type { JobHandler } from "../../../../src/modules/stores/engine/store-object/src/jobs/types.js";
import type { StoreCaller, StoreResult } from "../../../../src/modules/stores/engine/store-object/src/types.js";
import { WRITE_LIMIT_DEFAULT as ENGINE_WRITE_LIMIT_DEFAULT } from "../../../../src/modules/stores/engine/store-object/src/write-limit.js";
import { runStoreEngine } from "../../../../src/modules/stores/engine-main";
import {
  CONTROL_PLANE_ACTOR,
  engineOnStore,
  engineProgram,
  NO_FILES,
  programOn,
  type EngineOnStore,
} from "../../../../src/modules/stores/engine-program";
import { FileStorage } from "../../../../src/modules/stores/host/file-storage";
import { STORE_PROCESS_VERB } from "../../../../src/modules/stores/host/process-protocol";
import { readWriteLimit, type StoreFolder } from "../../../../src/modules/stores/host/store-folder";
import { NO_PARENT_EXIT, type StoreProgram } from "../../../../src/modules/stores/host/store-process-main";
import { DEFAULT_WRITE_LIMIT_CEILING } from "../../../../src/modules/stores/module";
import {
  ENGINE_CODES,
  STORE_CALLS,
  STORE_ID_SETTING,
  WRITE_LIMIT_DEFAULT,
  WRITE_LIMIT_MAX,
  WRITE_LIMIT_MIN,
} from "../../../../src/modules/stores/store-calls";
import { cleanFolders, newStoreFolder } from "../_rig";

const ENGINE_SOURCE = path.join(import.meta.dir, "..", "..", "..", "..", "src", "modules", "stores", "engine", "store-object", "src");

/** A person of the organization, as the engine names one. */
const LENA: StoreCaller = { storeId: "store-1", actor: "user:lena" };

const storages: FileStorage[] = [];
afterEach(() => {
  for (const storage of storages.splice(0)) {
    try {
      storage.close();
    } catch {
      // A test closed it already.
    }
  }
  cleanFolders();
});

interface Opened {
  folder: StoreFolder;
  storage: FileStorage;
  /** The clock the engine reads. A test moves it. */
  clock: { value: number };
  context: Parameters<typeof engineOnStore>[0];
}

/** A Store's file, opened as a Store's process opens it, with a clock a test
 *  holds. `storeId` is the id the process is told. */
function open(folder: StoreFolder = newStoreFolder("engine"), storeId: string | null = "store-1"): Opened {
  const storage = new FileStorage({ folder });
  storages.push(storage);
  const clock = { value: Date.parse("2026-11-07T10:00:00.000Z") };
  return {
    folder,
    storage,
    clock,
    context: {
      storage,
      folder,
      settings: storeId === null ? {} : { [STORE_ID_SETTING]: storeId },
      now: () => clock.value,
      abort: () => undefined,
    },
  };
}

/** The engine's program on a new Store. */
async function program(folder?: StoreFolder): Promise<Opened & { run: StoreProgram }> {
  const opened = open(folder);
  return { ...opened, run: await engineProgram({ ...opened.context }) };
}

type Writes = { day: string; rows: number; limit: number; shared: boolean; own: boolean };

async function writesOf(run: StoreProgram): Promise<Writes> {
  const stats = (await run.call("stats", [])) as StoreResult<{ writes: Writes }>;
  if (!stats.ok) throw new Error(`the Store's numbers were refused: ${stats.code}`);
  return stats.value.writes;
}

function value<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(`refused: ${result.code}`);
  return result.value;
}

/** A table of a person's, made with the engine's own calls. */
async function permitsTable(engine: EngineOnStore): Promise<void> {
  value(
    await engine.handler.migrate(LENA, {
      id: "0001_permits",
      sql: "CREATE TABLE permits (permit_no text PRIMARY KEY, address text);",
    }),
  );
}

describe("the engine's program", () => {
  test("opens no Store it was not told the id of", () => {
    const without: Record<string, string>[] = [{}, { [STORE_ID_SETTING]: "" }, { other: "store-1" }];
    for (const settings of without) {
      const opened = open();
      expect(() => engineProgram({ ...opened.context, settings })).toThrow("was not told its Store's id");
    }
  });

  test("takes the module's calls, and no other", async () => {
    const { run } = await program();
    for (const name of STORE_CALLS) {
      const answer = (await run.call(name, name === "catalog" ? [0, 40] : name === "jobSummary" ? ["job_x"] : [5_000])) as {
        ok: boolean;
        code?: string;
      };
      // Answered or refused by the engine, in its own form. Never thrown.
      expect(typeof answer.ok).toBe("boolean");
      if (!answer.ok) expect(ENGINE_CODES as readonly string[]).toContain(answer.code as string);
    }
    for (const name of ["query", "exec", "rows", "destroy", "restore", "structure", "events", "__proto__", "constructor", "toString"]) {
      expect(await run.call(name, [])).toMatchObject({ ok: false, code: "bad_request" });
    }
  });

  test("a page of the catalog is the tables that were asked for, and the count of all", async () => {
    const { run } = await program();
    const all = (await run.call("catalog", [0, 500])) as { ok: true; value: { tables: { name: string }[]; total: number } };
    expect(all.ok).toBe(true);
    const total = all.value.total;
    expect(all.value.tables).toHaveLength(total);
    expect(total).toBeGreaterThan(1);
    const one = (await run.call("catalog", [1, 1])) as typeof all;
    expect(one.value.tables.map((table) => table.name)).toEqual([all.value.tables.at(1)?.name as string]);
    expect(one.value.total).toBe(total);
    expect(((await run.call("catalog", [total, 40])) as typeof all).value.tables).toEqual([]);
    for (const args of [[], [0], [-1, 40], [0, 501], [0.5, 40], ["0", "40"], [0, null]]) {
      expect(await run.call("catalog", args)).toMatchObject({ ok: false, code: "bad_request" });
    }
  });

  test("every call is made for the control plane, by the name HX Fortress's audit trail has for it", async () => {
    const opened = open();
    const engine = engineOnStore(opened.context);
    // The one caller every call of the program is made with.
    expect(engine.caller).toEqual({ storeId: "store-1", actor: HOST_CONTROL_PLANE_ACTOR });
    expect(CONTROL_PLANE_ACTOR).toBe(HOST_CONTROL_PLANE_ACTOR);
    // The engine names a Store by the id of its first call, for good.
    const run = programOn(engine, opened.context);
    expect(await run.call("stats", [])).toMatchObject({ ok: true });
    expect(opened.storage.sql.exec("SELECT value FROM _meta WHERE key = 'store_id'").one().value).toBe("store-1");
  });
});

describe("the engine's own start", () => {
  test("where it fails, the Store's process is asked to end, so that the next call gets a new one", async () => {
    const opened = open();
    // The first statement of the engine's start fails once, as on a disk that
    // is full for a moment.
    const sql = opened.storage.sql as unknown as { exec: (...args: unknown[]) => unknown };
    const exec = sql.exec.bind(sql);
    let failed = 0;
    sql.exec = (...args: unknown[]): unknown => {
      if (failed === 0) {
        failed += 1;
        throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
      }
      return exec(...args);
    };
    const ended: (string | undefined)[] = [];
    const engine = engineOnStore({ ...opened.context, abort: (reason) => void ended.push(reason) });
    const run = programOn(engine, opened.context);
    // The engine that did not start fails every call, though the disk is fine
    // again: this one, and the next.
    for (let call = 0; call < 2; call += 1) expect(await run.call("stats", [])).toMatchObject({ ok: false });
    expect(failed).toBe(1);
    // So the process was asked to end, once, by a reason that holds no value.
    expect(ended).toEqual(["the engine's start failed"]);

    // The next process starts the engine anew on the same file, and it answers.
    opened.storage.close();
    const again = open(opened.folder);
    const asked: (string | undefined)[] = [];
    const next = programOn(engineOnStore({ ...again.context, abort: (reason) => void asked.push(reason) }), again.context);
    expect(await next.call("stats", [])).toMatchObject({ ok: true });
    expect(asked).toEqual([]);
  });
});

describe("a Store's process that is closed", () => {
  test("keeps the day's count of the rows it wrote, so the next process counts on from it", async () => {
    const opened = open();
    const engine = engineOnStore(opened.context);
    const run = programOn(engine, opened.context);
    await permitsTable(engine);
    // Fewer rows than the engine keeps its count at by itself.
    const rows = JSON.stringify(Array.from({ length: 900 }, (_, at) => `BP-${at}`));
    value(await engine.handler.exec(LENA, { sql: "INSERT INTO permits (permit_no) SELECT value FROM json_each(?)", params: [rows] }));
    const counted = (await writesOf(run)).rows;
    expect(counted).toBeGreaterThanOrEqual(900);

    // Closed as HX Fortress closes a Store's process: the program first, then
    // the file. No alarm of the engine came in between.
    await run.close?.();
    opened.storage.close();
    const next = await program(opened.folder);
    expect((await writesOf(next.run)).rows).toBeGreaterThanOrEqual(counted);
  });
});

describe("a Store's own daily write limit", () => {
  test("a new Store has the limit every Store has, and its numbers say that it is not its own", async () => {
    const { run, folder } = await program();
    expect(await writesOf(run)).toEqual({ day: "2026-11-07", rows: expect.any(Number), limit: 2_000_000, shared: false, own: false });
    expect(readWriteLimit(folder)).toBeNull();
  });

  test("the limit every Store has is this host's own number, handed to the engine each time a Store is opened", () => {
    const opened = open();
    const engine = engineOnStore(opened.context);
    // Handed over, and not left to the engine's own default.
    expect(engine.handler.core.env.STORE_DAILY_WRITE_LIMIT).toBe(String(WRITE_LIMIT_DEFAULT));
    expect(engine.ownLimit()).toBeNull();
    // The ceiling an organization starts with is the same number.
    expect(DEFAULT_WRITE_LIMIT_CEILING).toBe(WRITE_LIMIT_DEFAULT);
    // And it is the engine's own default today. A folder of the engine that is
    // written again with another default fails here: no Store's limit on this
    // host moves with it, and a person decides whether this host's number follows.
    expect(WRITE_LIMIT_DEFAULT).toBe(ENGINE_WRITE_LIMIT_DEFAULT);
  });

  test("set, it is the limit the engine holds the Store to, and it is kept in the Store's folder", async () => {
    const { run, folder } = await program();
    expect(await run.call("setWriteLimit", [5_000])).toEqual({
      ok: true,
      value: { day: "2026-11-07", rows: expect.any(Number), limit: 5_000, shared: false, own: true },
    });
    expect(await writesOf(run)).toMatchObject({ limit: 5_000, own: true });
    expect(readWriteLimit(folder)).toBe(5_000);
    // A small file of its own, for the owner alone, with the number and nothing else.
    expect(statSync(folder.writeLimit).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(folder.writeLimit, "utf8"))).toEqual({ rows: 5_000 });
    // Set again, the new number takes the old one's place.
    expect(await run.call("setWriteLimit", [WRITE_LIMIT_MAX])).toMatchObject({ ok: true, value: { limit: WRITE_LIMIT_MAX, own: true } });
    expect(readWriteLimit(folder)).toBe(WRITE_LIMIT_MAX);
  });

  test("past it, the engine takes no more of a person's writes that day", async () => {
    const opened = open();
    const engine = engineOnStore(opened.context);
    const run = programOn(engine, opened.context);
    await permitsTable(engine);
    expect(await run.call("setWriteLimit", [WRITE_LIMIT_MIN])).toMatchObject({ ok: true, value: { limit: WRITE_LIMIT_MIN } });
    // One statement that writes more rows than the day's limit. It began
    // under the limit, so it ends.
    const rows = JSON.stringify(Array.from({ length: WRITE_LIMIT_MIN + 200 }, (_, at) => `BP-${at}`));
    value(await engine.handler.exec(LENA, { sql: "INSERT INTO permits (permit_no) SELECT value FROM json_each(?)", params: [rows] }));
    expect((await writesOf(run)).rows).toBeGreaterThanOrEqual(WRITE_LIMIT_MIN);
    // The next one is refused, by the engine's own word.
    expect(await engine.handler.exec(LENA, { sql: "INSERT INTO permits (permit_no) VALUES ('one-more')" })).toMatchObject({
      ok: false,
      code: "write_limit_reached",
    });
    // Raised, the Store takes writes again.
    expect(await run.call("setWriteLimit", [50_000])).toMatchObject({ ok: true });
    value(await engine.handler.exec(LENA, { sql: "INSERT INTO permits (permit_no) VALUES ('one-more')" }));
  });

  test("the Store's next process holds it too", async () => {
    const first = await program();
    expect(await first.run.call("setWriteLimit", [7_500])).toMatchObject({ ok: true });
    first.storage.close();
    const second = await program(first.folder);
    expect(await writesOf(second.run)).toMatchObject({ limit: 7_500, own: true });
  });

  test("a number that is no limit is refused, and nothing is kept", async () => {
    const { run, folder } = await program();
    for (const rows of [WRITE_LIMIT_MIN - 1, WRITE_LIMIT_MAX + 1, 0, -5_000, 5_000.5, "5000", null, undefined, Number.NaN]) {
      expect(await run.call("setWriteLimit", [rows])).toMatchObject({ ok: false, code: "bad_request" });
    }
    expect(readWriteLimit(folder)).toBeNull();
    expect(await writesOf(run)).toMatchObject({ limit: 2_000_000, own: false });
  });

  test("a limit that was kept under other bounds is taken as it is: the Store opens, and can be set again", async () => {
    // The bounds a limit is set within can move from one release to the next.
    for (const kept of [WRITE_LIMIT_MIN - 1, WRITE_LIMIT_MAX + 1, 0]) {
      const opened = open();
      writeFileSync(opened.folder.writeLimit, JSON.stringify({ rows: kept }));
      const run = programOn(engineOnStore(opened.context), opened.context);
      expect([kept, await writesOf(run)]).toEqual([kept, expect.objectContaining({ limit: kept, own: true })]);
      // Set again, it is held to today's bounds.
      expect(await run.call("setWriteLimit", [kept])).toMatchObject({ ok: false, code: "bad_request" });
      expect(await run.call("setWriteLimit", [5_000])).toMatchObject({ ok: true, value: { limit: 5_000, own: true } });
      expect(readWriteLimit(opened.folder)).toBe(5_000);
    }
  });

  test("a limit that cannot be read: the Store is not opened, and is held to no other limit in its place", () => {
    for (const text of ["", "not json", "{}", '{"rows":"5000"}', '{"rows":-1}', '{"rows":1.5}', "[5000]", "null"]) {
      const opened = open();
      writeFileSync(opened.folder.writeLimit, text);
      let thrown: { code?: unknown } | null = null;
      try {
        engineOnStore(opened.context);
      } catch (error) {
        thrown = error as { code?: unknown };
      }
      expect([text, thrown?.code]).toEqual([text, "write_limit_unreadable"]);
    }
  });

  test("a limit that the engine does not come to hold is not kept: the call fails, and the old limit stands", async () => {
    const opened = open();
    const engine = engineOnStore(opened.context);
    const run = programOn(engine, opened.context);
    expect(await run.call("setWriteLimit", [7_500])).toMatchObject({ ok: true });
    // The engine's second answer in a call is a failure, as when a statement
    // of it fails, or one that names another limit than it was handed.
    const handler = engine.handler as unknown as { stats: (...args: unknown[]) => Promise<unknown> };
    const stats = handler.stats.bind(handler);
    for (const second of [
      { ok: false, status: 500, code: "sql_error", error: "the disk is full" },
      { ok: true, value: { waitsUntil: null, writes: { day: "2026-11-07", rows: 0, limit: 123, shared: false } } },
    ]) {
      let calls = 0;
      handler.stats = (...args: unknown[]): Promise<unknown> => {
        calls += 1;
        return calls === 2 ? Promise.resolve(second) : stats(...args);
      };
      expect(await run.call("setWriteLimit", [50_000])).toMatchObject({ ok: false, code: second.ok ? "internal" : "sql_error" });
      expect(calls).toBe(2);
      handler.stats = stats;
      // Nothing of the new limit holds: not on the disk, and not in the engine.
      expect(readWriteLimit(opened.folder)).toBe(7_500);
      expect(engine.ownLimit()).toBe(7_500);
      expect(await writesOf(run)).toMatchObject({ limit: 7_500, own: true });
    }
  });

  test("what the call wrote in the Store is kept before the limit is: where that fails, no limit is on the disk", async () => {
    const opened = open();
    const engine = engineOnStore(opened.context);
    const run = programOn(engine, opened.context);
    await permitsTable(engine);
    value(await engine.handler.exec(LENA, { sql: "INSERT INTO permits (permit_no) VALUES ('BP-1')" }));
    opened.storage.flush();
    // A disk that would take the limit's small file and refuses the Store's
    // own keeping.
    const sql = opened.storage.sql as unknown as { commit: () => void };
    const commit = sql.commit.bind(sql);
    let refused = 0;
    sql.commit = (): void => {
      refused += 1;
      throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
    };
    // As a Store's process runs a call: the program, and then the keeping of
    // what the call wrote. Either failing fails the ask.
    let asked = "answered";
    try {
      await run.call("setWriteLimit", [5_000]);
      opened.storage.flush();
    } catch {
      asked = "failed";
    } finally {
      sql.commit = commit;
    }
    expect([asked, refused > 0]).toEqual(["failed", true]);
    // So the Store's next process must find no limit, and this one holds none.
    expect(readWriteLimit(opened.folder)).toBeNull();
    expect(engine.ownLimit()).toBeNull();
    expect(await writesOf(run)).toMatchObject({ limit: WRITE_LIMIT_DEFAULT, own: false });
  });

  test("a limit that cannot be kept on the disk is not held either: the call fails, and the old limit stands", async () => {
    const opened = open();
    const engine = engineOnStore(opened.context);
    const run = programOn(engine, opened.context);
    // Where the limit's file is to go is a folder that holds something: the
    // new file cannot take its place.
    mkdirSync(opened.folder.writeLimit);
    writeFileSync(path.join(opened.folder.writeLimit, "in-the-way"), "");
    await expect(Promise.resolve(run.call("setWriteLimit", [5_000]))).rejects.toThrow();
    expect(engine.ownLimit()).toBeNull();
    expect(await writesOf(run)).toMatchObject({ limit: WRITE_LIMIT_DEFAULT, own: false });
    // With the way free, the same call sets it.
    rmSync(opened.folder.writeLimit, { recursive: true });
    expect(await run.call("setWriteLimit", [5_000])).toMatchObject({ ok: true, value: { limit: 5_000, own: true } });
    expect(readWriteLimit(opened.folder)).toBe(5_000);
  });

  test("the engine's own checks come first: for a file that was another Store's, nothing is set", async () => {
    // The file was first used under another id.
    const before = open(newStoreFolder("engine"), "another-store");
    expect(await (await engineProgram({ ...before.context })).call("stats", [])).toMatchObject({ ok: true });
    before.storage.close();
    const { run, folder } = await program(before.folder);
    expect(await run.call("setWriteLimit", [5_000])).toMatchObject({ ok: false, code: "token_wrong_store" });
    expect(readWriteLimit(folder)).toBeNull();
  });

  test("jobs that wait for the day's limit go on when it is raised above the day's writes", async () => {
    // A job of some chunks, each of which writes 400 rows.
    const filler: JobHandler<{ chunks: number }, { at: number }> = {
      kind: "fill",
      parse: (params) => params as { chunks: number },
      async run(ctx) {
        const at = (ctx.state?.at ?? 0) + 1;
        ctx.commit({ state: { at }, progress: { done: at, total: ctx.params.chunks } }, () => {
          ctx.sql.exec("CREATE TABLE IF NOT EXISTS filled (n INTEGER)");
          ctx.sql.exec("INSERT INTO filled SELECT value FROM json_each(?)", JSON.stringify(Array.from({ length: 400 }, (_, n) => n)));
        });
        return at >= ctx.params.chunks ? { result: { at } } : { more: true };
      },
    };
    const opened = open();
    const engine = engineOnStore(opened.context, new Map([[filler.kind, filler as JobHandler]]));
    const run = programOn(engine, opened.context);
    /** Wake the Store at each time it asks for, up to a minute from now, the
     *  way a Store's process does: the alarm is taken when it fires, and the
     *  program sets the next one. */
    const wakeWhileDue = async (): Promise<void> => {
      for (let turns = 0; turns < 50; turns += 1) {
        const due = opened.storage.alarm;
        if (due === null || due > opened.clock.value + 60_000) return;
        opened.clock.value = Math.max(opened.clock.value, due);
        opened.storage.takeAlarm();
        let dealtWith = false;
        try {
          await run.wake?.();
          dealtWith = true;
        } finally {
          opened.storage.settleAlarm(due, dealtWith);
        }
      }
      throw new Error("the Store went on asking to be woken");
    };
    const filled = (): number => Number(opened.storage.sql.exec("SELECT count(*) AS n FROM filled").one().n);
    const waitsUntil = async (): Promise<number | null> =>
      value((await run.call("stats", [])) as StoreResult<{ waitsUntil: number | null }>).waitsUntil;

    expect(await run.call("setWriteLimit", [WRITE_LIMIT_MIN])).toMatchObject({ ok: true });
    value(await engine.handler.jobSubmit(LENA, { kind: "fill", params: { chunks: 6 }, requestKey: "run-1:s1" }));
    await wakeWhileDue();
    // Three chunks took the day past its limit. The job waits where it stopped,
    // and the Store asks to be woken when the next day begins.
    expect(filled()).toBe(1_200);
    const nextDay = Date.parse("2026-11-08T00:00:00.000Z");
    expect(opened.storage.alarm).toBe(nextDay);
    expect(await waitsUntil()).toBe(nextDay);

    // A limit that is still under the day's writes does not wake the Store
    // now. (Any call leaves a wake a few seconds on, to keep the day's count.)
    expect(await run.call("setWriteLimit", [WRITE_LIMIT_MIN + 100])).toMatchObject({ ok: true });
    expect(opened.storage.alarm).toBeGreaterThan(opened.clock.value);
    expect(filled()).toBe(1_200);

    // Raised above them, the Store is woken now, and the job goes on to its end.
    expect(await run.call("setWriteLimit", [50_000])).toMatchObject({ ok: true });
    expect(opened.storage.alarm).toBeLessThanOrEqual(opened.clock.value);
    await wakeWhileDue();
    expect(filled()).toBe(2_400);
    expect(await waitsUntil()).toBeNull();
  });
});

describe("a Store's history, on a host that keeps no moment to take a Store back to", () => {
  test("says nothing of a restore: not how far back, and not for any line", async () => {
    const opened = open();
    const engine = engineOnStore(opened.context);
    const run = programOn(engine, opened.context);
    await permitsTable(engine);
    // The engine itself says how far back, from the calendar alone.
    const own = value(await engine.handler.history(LENA));
    expect(typeof own.restorableFrom).toBe("string");
    expect(own.events.length).toBeGreaterThan(0);

    expect(opened.storage.pointInTime).toBe(false);
    const told = value((await run.call("history", [])) as StoreResult<{ events: Record<string, unknown>[]; restorableFrom?: string }>);
    expect(Object.hasOwn(told, "restorableFrom")).toBe(false);
    expect(told.events.map((event) => event.id)).toEqual(own.events.map((event) => event.id));
    expect(told.events.every((event) => !Object.hasOwn(event, "restorePoint"))).toBe(true);
    expect(told.events.at(0)).toMatchObject({ kind: "migration", by: "user:lena" });
  });

  test("where the storage keeps such moments, the engine's answer goes back as it is", async () => {
    const opened = open();
    const engine = engineOnStore(opened.context);
    const run = programOn(engine, opened.context);
    await permitsTable(engine);
    opened.storage.pointInTime = true;
    expect(await run.call("history", [])).toEqual(await engine.handler.history(LENA));
  });
});

describe("the place for a Store's files, while this HX Fortress keeps none", () => {
  test("holds nothing, takes nothing, and never throws where the engine expects a promise", async () => {
    expect(await NO_FILES.get("a")).toBeNull();
    expect(await NO_FILES.head("a")).toBeNull();
    expect(await NO_FILES.list({ prefix: "a" })).toEqual({ objects: [], truncated: false });
    await NO_FILES.delete(["a", "b"]);
    await expect(NO_FILES.put("a", "bytes")).rejects.toMatchObject({ code: "files_unavailable" });
    await expect(NO_FILES.createMultipartUpload("a")).rejects.toMatchObject({ code: "files_unavailable" });
    // An upload is answered without a throw: the engine asks for one and then
    // catches what its calls reject with.
    const upload = NO_FILES.resumeMultipartUpload("a", "upload-1");
    expect(upload.uploadId).toBe("upload-1");
    await expect(upload.abort()).rejects.toMatchObject({ code: "files_unavailable" });
    await expect(upload.uploadPart(1, "bytes")).rejects.toMatchObject({ code: "files_unavailable" });
    await expect(upload.complete([])).rejects.toMatchObject({ code: "files_unavailable" });
  });

  test("the Store's alarm drops the record of an upload nobody finished, and goes on", async () => {
    const { run, storage, clock } = await program();
    expect(await run.call("stats", [])).toMatchObject({ ok: true });
    // A record of an upload that began eight days ago, in a file that came
    // from a host with a place for files.
    storage.sql.exec(
      "INSERT INTO _files (id, name, size, content_type, state, received_at, received_by, via, r2_key, upload_id) " +
        "VALUES ('fil_1', 'permits.csv', 10, 'text/csv', 'uploading', ?, 'user:lena', 'page', 'files/fil_1', 'upload-1')",
      new Date(clock.value - 8 * 24 * 3_600_000).toISOString(),
    );
    await run.wake?.();
    expect(storage.sql.exec("SELECT count(*) AS n FROM _files").one().n).toBe(0);
  });
});

describe("the words the engine refuses a call with", () => {
  test("every word on the module's list is one the engine's own source has", async () => {
    // The list in store-calls.ts is closed, and a word the engine no longer
    // uses would only hide that it changed. When the engine's folder is
    // written anew and a word is gone or renamed, this is where it shows.
    const files = (await readdir(ENGINE_SOURCE, { recursive: true })).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".suite.ts"),
    );
    let source = "";
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this repository's own folder
    for (const name of files) source += await readFile(path.join(ENGINE_SOURCE, name), "utf8");
    for (const code of ENGINE_CODES) {
      expect(`${code}: ${source.includes(`"${code}"`) ? "in the engine" : "NOT in the engine"}`).toBe(`${code}: in the engine`);
    }
  });
});

describe("hx-fortress store-engine", () => {
  test("is the word a Store's process is started with", () => {
    expect(STORE_PROCESS_VERB).toBe("store-engine");
  });

  test("run by hand, it says what it is and ends: nobody started it", async () => {
    // This test's own process has no parent that talks to it either.
    const lines: string[] = [];
    expect(await runStoreEngine({ writeLine: (line) => void lines.push(line) })).toBe(NO_PARENT_EXIT);
    expect(lines).toHaveLength(1);
    expect(lines.at(0)).toContain("HX Fortress starts it itself");
  });

  test("the command line knows the word, and hands it to the Store's process", async () => {
    const lines: string[] = [];
    const asked: string[] = [];
    const code = await runCli([STORE_PROCESS_VERB], {
      writeLine: (line) => void lines.push(line),
      runStoreEngine: async () => {
        asked.push("started");
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(asked).toEqual(["started"]);
    // Not the help, which an unknown word gets.
    expect(lines).toEqual([]);
  });

  test("the word is not in the help: no person runs it", async () => {
    const lines: string[] = [];
    await runCli(["help"], { writeLine: (line) => void lines.push(line) });
    expect(lines.join("\n")).not.toContain(STORE_PROCESS_VERB);
  });
});
