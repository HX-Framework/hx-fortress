// The engine's program for a Store's process, and the word that starts it.

import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { zipSync } from "fflate";
import * as XLSX from "xlsx";

import { runCli } from "../../../../src/cli";
import { CONTROL_PLANE_ACTOR as HOST_CONTROL_PLANE_ACTOR } from "../../../../src/host/module-audit";
import { isName } from "../../../../src/host/shape";
import type { JobHandler } from "../../../../src/modules/stores/engine/store-object/src/jobs/types.js";
import type { StoreCaller, StoreResult } from "../../../../src/modules/stores/engine/store-object/src/types.js";
import { WRITE_LIMIT_DEFAULT as ENGINE_WRITE_LIMIT_DEFAULT } from "../../../../src/modules/stores/engine/store-object/src/write-limit.js";
import { runStoreEngine } from "../../../../src/modules/stores/engine-main";
import {
  CONSOLE_ACTOR,
  CONTROL_PLANE_ACTOR,
  engineOnStore,
  engineProgram,
  programOn,
  type EngineOnStore,
} from "../../../../src/modules/stores/engine-program";
import { diskFiles } from "../../../../src/modules/stores/host/disk-files";
import { FileStorage } from "../../../../src/modules/stores/host/file-storage";
import { STORE_PROCESS_VERB } from "../../../../src/modules/stores/host/process-protocol";
import { readRestore, readWriteLimit, storeFolder, type StoreFolder } from "../../../../src/modules/stores/host/store-folder";
import {
  NO_PARENT_EXIT,
  type StoreProgram,
  type StoreProgramContext,
} from "../../../../src/modules/stores/host/store-process-main";
import { DEFAULT_WRITE_LIMIT_CEILING } from "../../../../src/modules/stores/module";
import {
  ENGINE_CODES,
  STORE_CALLS,
  STORE_ID_SETTING,
  WRITE_LIMIT_DEFAULT,
  WRITE_LIMIT_MAX,
  WRITE_LIMIT_MIN,
} from "../../../../src/modules/stores/store-calls";
import { cleanFolders, newStoreFolder, tempFolder } from "../_rig";

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
  /** How often the program asked to be started anew. */
  anew: { asked: number };
  context: StoreProgramContext;
}

/** A Store's file, opened as a Store's process opens it, with a clock a test
 *  holds. `storeId` is the id the process is told. */
function open(
  folder: StoreFolder = newStoreFolder("engine"),
  storeId: string | null = "store-1",
  /** How many snapshots the Store keeps, and how large its file may be to
   *  keep any, where a test says. */
  snapshots?: { kept?: number; storeMaxBytes?: number },
): Opened {
  const storage = new FileStorage({ folder, ...(snapshots ? { snapshots } : {}) });
  storages.push(storage);
  const clock = { value: Date.parse("2026-11-07T10:00:00.000Z") };
  const anew = { asked: 0 };
  return {
    folder,
    storage,
    clock,
    anew,
    context: {
      storage,
      folder,
      settings: storeId === null ? {} : { [STORE_ID_SETTING]: storeId },
      now: () => clock.value,
      abort: () => undefined,
      startAnew: () => {
        anew.asked += 1;
      },
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

/** A run of a program, as the engine names one: what submits a job. */
const RUN: StoreCaller = { storeId: "store-1", actor: "run:mrn-1" };

/** A sample file of the engine's own folder: the ones that are text. */
function sample(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(ENGINE_SOURCE, "..", "..", "store-readers", "fixtures", name)));
}

/**
 * Put a file into the Store as a person's page does, with the engine's own
 * calls: the Store makes the file's record and says where its one part goes,
 * the part is put there, and the Store is told that it arrived. The part is
 * put by another hand than the engine's, as a door in front of the Store will.
 */
async function upload(opened: Opened, engine: EngineOnStore, name: string, bytes: Uint8Array): Promise<{ id: string; name: string }> {
  const { handler } = engine;
  const created = value(await handler.fileCreate(LENA, { name, size: bytes.byteLength, contentType: "application/octet-stream" }));
  const target = value(await handler.filePartTarget(LENA, created.file.id, 1));
  const part = await diskFiles(opened.folder.files).resumeMultipartUpload(target.key, target.uploadId).uploadPart(1, bytes);
  value(await handler.fileComplete(LENA, created.file.id, { parts: [{ n: 1, etag: part.etag }] }));
  return { id: created.file.id, name: created.file.name };
}

/** Wake the Store at each time it asks for, up to a minute from now, the way
 *  a Store's process does: the alarm is taken when it fires, and the program
 *  sets the next one. */
async function wakeWhileDue(opened: Opened, run: StoreProgram): Promise<void> {
  for (let turns = 0; turns < 200; turns += 1) {
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
}

/** Submit a job as a run does, wake the Store until the job has ended, and
 *  answer the job as the engine itself tells it. */
async function runJob(
  opened: Opened,
  engine: EngineOnStore,
  run: StoreProgram,
  body: { kind: string; params: unknown; requestKey: string },
): Promise<{ state: string; error?: string | null; result?: unknown }> {
  const { job } = value(await engine.handler.jobSubmit(RUN, body));
  await wakeWhileDue(opened, run);
  return value(await engine.handler.job(RUN, job.id)).job;
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
    for (const name of ["query", "exec", "rows", "destroy", "restart", "structure", "events", "__proto__", "constructor", "toString"]) {
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

describe("a Store's history, and the moments the Store can be taken back to", () => {
  type Told = { events: { id: string; at: string; note: string; restorePoint?: string }[]; restorableFrom?: string };
  const told = async (run: StoreProgram): Promise<Told> => value((await run.call("history", [])) as StoreResult<Told>);
  const line = (history: Told, migration: string): Told["events"][number] => {
    const found = history.events.find((event) => event.note.startsWith(`Migration ${migration}:`));
    if (!found) throw new Error(`the history has no line of the migration ${migration}`);
    return found;
  };

  /** A Store with two migrations, a second apart. */
  async function twoMigrations(): Promise<Opened & { engine: EngineOnStore; run: StoreProgram }> {
    const opened = open();
    const engine = engineOnStore(opened.context);
    const run = programOn(engine, opened.context);
    await permitsTable(engine);
    opened.clock.value += 1_000;
    value(await engine.handler.migrate(LENA, { id: "0002_owners", sql: "CREATE TABLE owners (id integer PRIMARY KEY, name text);" }));
    return { ...opened, engine, run };
  }

  test("a line can take the Store back while the Store holds its snapshot, and the Store goes back as far as the oldest such line", async () => {
    const { folder, run } = await twoMigrations();
    const whole = await told(run);
    const first = line(whole, "0001_permits");
    const second = line(whole, "0002_owners");
    // The engine took a bookmark before each migration, and the storage kept a
    // snapshot under it.
    expect(typeof first.restorePoint).toBe("string");
    expect(typeof second.restorePoint).toBe("string");
    expect(first.restorePoint).not.toBe(second.restorePoint);
    expect(readdirSync(folder.snapshots).sort()).toEqual([`${first.restorePoint}.sqlite`, `${second.restorePoint}.sqlite`].sort());
    expect(whole.restorableFrom).toBe(first.at);

    // The older snapshot goes, as when the Store has taken more than it keeps.
    rmSync(path.join(folder.snapshots, `${first.restorePoint}.sqlite`));
    const later = await told(run);
    expect(Object.hasOwn(line(later, "0001_permits"), "restorePoint")).toBe(false);
    expect(line(later, "0002_owners").restorePoint).toBe(second.restorePoint as string);
    expect(later.restorableFrom).toBe(second.at);
    // Every line is still told: only the way back is gone.
    expect(later.events.map((event) => event.id)).toEqual(whole.events.map((event) => event.id));

    // With no snapshot left, the answer says nothing of a restore.
    rmSync(path.join(folder.snapshots, `${second.restorePoint}.sqlite`));
    const none = await told(run);
    expect(Object.hasOwn(none, "restorableFrom")).toBe(false);
    expect(none.events.every((event) => !Object.hasOwn(event, "restorePoint"))).toBe(true);
  });

  test("a line older than the engine itself goes back is no way back, whatever the Store holds", async () => {
    const { clock, engine, run } = await twoMigrations();
    expect(typeof (await told(run)).restorableFrom).toBe("string");
    // Thirty-one days on. The snapshots are still there.
    clock.value += 31 * 24 * 3_600_000;
    const own = value(await engine.handler.history(LENA));
    expect(own.events.some((event) => event.restorePoint !== undefined)).toBe(true);
    const late = await told(run);
    expect(Object.hasOwn(late, "restorableFrom")).toBe(false);
    expect(late.events.every((event) => !Object.hasOwn(event, "restorePoint"))).toBe(true);
  });

  test("on a storage that keeps no moment, the answer says nothing of a restore", async () => {
    const { storage, engine, run } = await twoMigrations();
    // The engine itself says how far back, from the calendar alone.
    const own = value(await engine.handler.history(LENA));
    expect(typeof own.restorableFrom).toBe("string");
    storage.pointInTime = false;
    const none = await told(run);
    expect(Object.hasOwn(none, "restorableFrom")).toBe(false);
    expect(none.events.every((event) => !Object.hasOwn(event, "restorePoint"))).toBe(true);
    expect(none.events.map((event) => event.id)).toEqual(own.events.map((event) => event.id));
  });
});

describe("a restore, readied by the Store's program", () => {
  type Line = { id: string; at: string; kind: string; by: string; note: string; restorePoint?: string };
  type Told = { events: Line[]; restorableFrom?: string };
  const told = async (run: StoreProgram): Promise<Told> => value((await run.call("history", [])) as StoreResult<Told>);
  const lineOf = (history: Told, migration: string): Line => {
    const found = history.events.find((event) => event.note.startsWith(`Migration ${migration}:`));
    if (!found) throw new Error(`the history has no line of the migration ${migration}`);
    return found;
  };
  /** Which of the two tables of these tests the Store's file holds. */
  const tables = (storage: FileStorage): string[] =>
    storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('permits', 'owners') ORDER BY name")
      .toArray()
      .map((row) => String(row.name));
  const marked = (storage: FileStorage): number =>
    Number(storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM _meta WHERE key = 'restoring'").one().n);

  type OnStore = Opened & { engine: EngineOnStore; run: StoreProgram };

  /** A Store with a table and a row in it, and then a second table: two
   *  migrations, with a change of the Store between them. */
  async function filled(snapshots?: { kept?: number; storeMaxBytes?: number }): Promise<OnStore> {
    const opened = open(undefined, "store-1", snapshots);
    const engine = engineOnStore(opened.context);
    const run = programOn(engine, opened.context);
    await permitsTable(engine);
    opened.clock.value += 1_000;
    value(await engine.handler.exec(LENA, { sql: "INSERT INTO permits VALUES ('BP-2026-0412', '18 Mill Road')" }));
    opened.clock.value += 1_000;
    value(await engine.handler.migrate(LENA, { id: "0002_owners", sql: "CREATE TABLE owners (id integer PRIMARY KEY, name text);" }));
    opened.clock.value += 1_000;
    return { ...opened, engine, run };
  }

  /** The Store's next process: its file closed and opened again, and the
   *  engine's program on it, a second later. */
  function next(before: Opened, snapshots?: { kept?: number; storeMaxBytes?: number }): OnStore {
    before.storage.close();
    const opened = open(before.folder, "store-1", snapshots);
    opened.clock.value = before.clock.value + 1_000;
    const engine = engineOnStore(opened.context);
    return { ...opened, engine, run: programOn(engine, opened.context) };
  }

  test("the call names a line of the history, and the Store goes back to the moment before it when it is next opened", async () => {
    const first = await filled();
    const owners = lineOf(await told(first.run), "0002_owners");
    // The answer is the time of that moment, and nothing else: no bookmark.
    expect(await first.run.call("restore", [owners.id])).toEqual({ ok: true, value: { to: owners.at } });
    // Readied, not done: this process still holds the Store as it was, and
    // the storage was told which snapshot to go back to.
    expect(tables(first.storage)).toEqual(["owners", "permits"]);
    expect(readRestore(first.folder)).toBe(owners.restorePoint as string);
    // The program asked to be started anew, once.
    expect(first.anew.asked).toBe(1);

    const back = next(first);
    const after = await told(back.run);
    // The second table is gone. The first is there, with its row.
    expect(tables(back.storage)).toEqual(["permits"]);
    expect(back.storage.sql.exec("SELECT address FROM permits").toArray()).toEqual([{ address: "18 Mill Road" }]);
    expect(readRestore(back.folder)).toBeNull();
    expect(marked(back.storage)).toBe(0);
    expect(back.anew.asked).toBe(0);
    // The history still tells what happened since that moment, and has the
    // restore's own line: by the console, never by a person's login.
    expect(after.events.some((event) => event.id === owners.id)).toBe(true);
    const restores = after.events.filter((event) => event.kind === "restore");
    expect(restores).toHaveLength(1);
    const restore = restores.at(0) as Line;
    expect(restore.by).toBe(CONSOLE_ACTOR);
    expect(isName(CONSOLE_ACTOR)).toBe(true);
    expect(CONSOLE_ACTOR).not.toBe(CONTROL_PLANE_ACTOR);

    // The restore's own line is a way back too, to the moment just before
    // it: that undoes the restore.
    expect(typeof restore.restorePoint).toBe("string");
    expect(await back.run.call("restore", [restore.id])).toMatchObject({ ok: true });
    expect(back.anew.asked).toBe(1);
    const undone = next(back);
    expect(await told(undone.run)).toMatchObject({ events: expect.any(Array) as unknown });
    expect(tables(undone.storage)).toEqual(["owners", "permits"]);
  });

  test("a line that is no way back is refused, and nothing is readied", async () => {
    const first = await filled();
    const history = await told(first.run);
    const permits = lineOf(history, "0001_permits");
    const refusedAs = async (line: unknown): Promise<string> => {
      const answered = (await first.run.call("restore", [line])) as { ok: boolean; code?: string };
      return answered.ok ? "taken" : String(answered.code);
    };
    // Not a line's id at all, and an id the history does not have.
    for (const line of [undefined, null, 7, "", ["his_1"], "his_none"]) expect(await refusedAs(line)).toBe("bad_request");
    // A bookmark is not taken in a line's place.
    expect(await refusedAs(permits.restorePoint)).toBe("bad_request");
    // A line whose snapshot the Store no longer holds.
    rmSync(path.join(first.folder.snapshots, `${permits.restorePoint as string}.sqlite`));
    expect(await refusedAs(permits.id)).toBe("bad_request");
    // A storage that keeps no moment has no line that is a way back.
    first.storage.pointInTime = false;
    expect(await refusedAs(lineOf(history, "0002_owners").id)).toBe("bad_request");
    first.storage.pointInTime = true;

    expect(readRestore(first.folder)).toBeNull();
    expect(marked(first.storage)).toBe(0);
    expect(first.anew.asked).toBe(0);
    // The Store goes on as it was.
    expect(tables(next(first).storage)).toEqual(["owners", "permits"]);
  });

  test("the line's snapshot is kept while the restore is readied, also in a Store that keeps one snapshot", async () => {
    const first = await filled({ kept: 1 });
    // The Store changed since its newest snapshot. So the engine's own
    // bookmark of "now", which it takes before it asks for the restore, is one
    // more snapshot: with one kept, it would push out the one to go back to.
    value(await first.engine.handler.exec(LENA, { sql: "INSERT INTO owners VALUES (1, 'Lena Hart')" }));
    const owners = lineOf(await told(first.run), "0002_owners");
    expect(readdirSync(first.folder.snapshots)).toEqual([`${owners.restorePoint as string}.sqlite`]);
    expect(await first.run.call("restore", [owners.id])).toEqual({ ok: true, value: { to: owners.at } });
    expect(readRestore(first.folder)).toBe(owners.restorePoint as string);
    const back = next(first, { kept: 1 });
    expect(await told(back.run)).toMatchObject({ events: expect.any(Array) as unknown });
    expect(tables(back.storage)).toEqual(["permits"]);
  });

  test("what a restore carries across is written only once the Store has kept its mark of the restore", async () => {
    const first = await filled();
    const owners = lineOf(await told(first.run), "0002_owners");
    // The engine marks the restore in the Store, then writes what the restore
    // carries across into the Store's files, then tells the storage which
    // snapshot to go back to. A copy of the Store's whole folder, taken at
    // that last step, is the disk as a process leaves it that is ended right
    // after the file was written.
    const image = storeFolder(path.join(tempFolder("ended"), "store"));
    const tell = first.storage.onNextSessionRestoreBookmark.bind(first.storage);
    first.storage.onNextSessionRestoreBookmark = (bookmark: string): Promise<string> => {
      cpSync(first.folder.root, image.root, { recursive: true });
      return tell(bookmark);
    };
    expect(await first.run.call("restore", [owners.id])).toMatchObject({ ok: true });
    // What the restore carries across was on the disk by then, and no
    // restore waited yet.
    expect(readdirSync(path.join(image.files, "objects")).length).toBeGreaterThan(0);
    expect(existsSync(image.restore)).toBe(false);

    // The Store as that process's next one opens it. It did not go back: both
    // tables are there. And its history does not say that it did: the engine
    // found its own mark of the restore in the Store, kept there before the
    // file was written, and dropped what the restore would have carried.
    const ended = open(image);
    const after = await told(programOn(engineOnStore(ended.context), ended.context));
    expect(tables(ended.storage)).toEqual(["owners", "permits"]);
    expect(after.events.filter((event) => event.kind === "restore")).toEqual([]);
    expect(marked(ended.storage)).toBe(0);
  });

  test("a Store that grew past what it may be and still keep snapshots has no way back: not in its history, and not by a restore", async () => {
    const first = await filled({ storeMaxBytes: 600_000 });
    const before = await told(first.run);
    const owners = lineOf(before, "0002_owners");
    expect(typeof owners.restorePoint).toBe("string");
    expect(typeof before.restorableFrom).toBe("string");
    // It grows past the bound. Its snapshots are still in its folder.
    const rows = JSON.stringify(Array.from({ length: 300 }, (_, at) => ({ no: `BP-${at}`, address: "x".repeat(3_000) })));
    value(
      await first.engine.handler.exec(LENA, {
        sql: "INSERT INTO permits (permit_no, address) SELECT value ->> 'no', value ->> 'address' FROM json_each(?)",
        params: [rows],
      }),
    );
    first.storage.flush();
    expect(statSync(first.folder.database).size).toBeGreaterThan(600_000);
    expect(readdirSync(first.folder.snapshots).length).toBeGreaterThan(0);
    // No line is a way back any more, and the answer says nothing of how far.
    const grown = await told(first.run);
    expect(grown.events.every((event) => !Object.hasOwn(event, "restorePoint"))).toBe(true);
    expect(Object.hasOwn(grown, "restorableFrom")).toBe(false);
    // So a restore to a line that was one is refused before anything is
    // readied: no person is asked to approve what cannot be done.
    expect(await first.run.call("restore", [owners.id])).toMatchObject({ ok: false, code: "bad_request" });
    expect(readRestore(first.folder)).toBeNull();
    expect(first.anew.asked).toBe(0);
  });

  test("a restore that was not readied lets the line's snapshot go again", async () => {
    const first = await filled({ kept: 1 });
    value(await first.engine.handler.exec(LENA, { sql: "INSERT INTO owners VALUES (1, 'Lena Hart')" }));
    const owners = lineOf(await told(first.run), "0002_owners");
    const point = owners.restorePoint as string;
    // The storage cannot be told which snapshot to go back to: the engine
    // gives the restore up, and its call fails.
    first.storage.onNextSessionRestoreBookmark = (): Promise<string> => Promise.reject(new Error("the disk is full"));
    expect(await first.run.call("restore", [owners.id])).toMatchObject({ ok: false });
    expect(readRestore(first.folder)).toBeNull();
    expect(first.anew.asked).toBe(0);
    // The snapshot was kept past the count while the restore was tried. It is
    // one like any other again: the next one takes its place.
    value(await first.engine.handler.exec(LENA, { sql: "INSERT INTO owners VALUES (2, 'Ruth Bell')" }));
    await first.storage.getCurrentBookmark();
    expect(first.storage.holdsBookmark(point)).toBe(false);
  });

  test("a second restore while one waits is refused by the engine's own word, and the process is asked to be started anew again", async () => {
    const first = await filled();
    const history = await told(first.run);
    expect(await first.run.call("restore", [lineOf(history, "0002_owners").id])).toMatchObject({ ok: true });
    // HX Fortress closes the process after the first answer. Should a call
    // reach it all the same, the Store still goes back to the first moment.
    expect(await first.run.call("restore", [lineOf(history, "0001_permits").id])).toMatchObject({
      ok: false,
      code: "store_restoring",
    });
    expect(first.anew.asked).toBe(2);
    expect(readRestore(first.folder)).toBe(lineOf(history, "0002_owners").restorePoint as string);
    expect(tables(next(first).storage)).toEqual(["permits"]);
  });
});

describe("a Store's files, in the Store's own folder", () => {
  test("a draft that a process left in the middle of a write is gone once the next process has the Store", () => {
    const opened = open();
    const objects = path.join(opened.folder.files, "objects");
    mkdirSync(objects, { recursive: true });
    const draft = path.join(objects, `${"a".repeat(64)}.json.${"b".repeat(32)}.tmp`);
    writeFileSync(draft, "half a record");
    engineOnStore(opened.context);
    expect(existsSync(draft)).toBe(false);
  });

  test("a file a person uploads is kept in the Store's folder, and a load makes a table of its rows", async () => {
    const opened = open();
    const engine = engineOnStore(opened.context);
    const run = programOn(engine, opened.context);
    const csv = await upload(opened, engine, "permits-utf8.csv", sample("permits-utf8.csv"));
    // Its bytes are in the Store's own folder for files, under names that are
    // none of the file's own.
    const kept = readdirSync(opened.folder.files, { recursive: true }) as string[];
    expect(kept.some((name) => name.endsWith(".bin"))).toBe(true);
    expect(kept.join("\n")).not.toContain("permits");
    expect(value((await run.call("stats", [])) as StoreResult<{ files: number; fileBytes: number }>)).toMatchObject({
      files: 1,
      fileBytes: sample("permits-utf8.csv").byteLength,
    });

    const job = await runJob(opened, engine, run, {
      kind: "load",
      params: { files: [csv], madeBy: { runId: "mrn-1", step: "s1" } },
      requestKey: "store_load:mrn-1:s1@",
    });
    expect([job.state, job.error ?? ""]).toEqual(["done", ""]);
    // The rows of the file, read by the engine's own reader under this runtime.
    expect(
      opened.storage.sql
        .exec('SELECT "_row", "Owner", "Fee" FROM permits_utf8 ORDER BY "_row"')
        .toArray()
        .map((row) => ({ ...row })),
    ).toEqual([
      { _row: 2, Owner: "Rosa Delgado", Fee: "150.00" },
      { _row: 3, Owner: "Peña Holdings LLC", Fee: "2250.50" },
      { _row: 5, Owner: "Désirée Okafor", Fee: null },
      { _row: 6, Owner: "Tomás Brennan", Fee: "75.25" },
    ]);
    // The module's own call lists the table a load made, as a program's.
    const catalog = value((await run.call("catalog", [0, 500])) as StoreResult<{ tables: { name: string; kind: string; count: number }[] }>);
    expect(catalog.tables.find((table) => table.name === "permits_utf8")).toMatchObject({ kind: "program", count: 4 });
  });

  test("every text sample of the engine's folder loads, and so do a spreadsheet and a zip made here", async () => {
    const opened = open();
    const engine = engineOnStore(opened.context);
    const run = programOn(engine, opened.context);
    const files = [];
    for (const name of ["parcels.geojson", "inspections.jsonl", "permits-access.xml", "parcels-pipe.txt"]) {
      files.push(await upload(opened, engine, name, sample(name)));
    }
    // The folder holds no sample that is not text. A spreadsheet and a zip are
    // made here, with the same two packages the engine's readers read them
    // with, so that those readers run under this runtime on real files.
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ["permit_no", "address", "fee"],
        ["BP-2026-0412", "18 Mill Road", 120.5],
        ["BP-2026-0413", "7 Alder Court", 80],
      ]),
      "Permits",
    );
    files.push(await upload(opened, engine, "made-here.xlsx", new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer)));
    files.push(
      await upload(
        opened,
        engine,
        "made-here.zip",
        zipSync({ "owners.csv": new TextEncoder().encode("id,name\n1,Lena Hart\n2,Omar Reyes\n") }),
      ),
    );

    const job = await runJob(opened, engine, run, {
      kind: "load",
      params: { files, madeBy: { runId: "mrn-1", step: "s2" } },
      requestKey: "store_load:mrn-1:s2@",
    });
    expect([job.state, job.error ?? ""]).toEqual(["done", ""]);
    const result = job.result as { tables: { table: string; rows: number; file: string }[]; skipped: unknown[] };
    expect(result.skipped).toEqual([]);
    const made = new Map(result.tables.map((table) => [table.file, table]));
    // One table at least for each file, and each holds rows.
    for (const file of files) expect([file.name, (made.get(file.name)?.rows ?? 0) > 0]).toEqual([file.name, true]);
    const rows = (table: string): Record<string, unknown>[] =>
      opened.storage.sql
        .exec(`SELECT * FROM "${table}" ORDER BY "_row"`)
        .toArray()
        .map((row) => ({ ...row }));
    expect(rows(made.get("made-here.xlsx")?.table as string)).toEqual([
      expect.objectContaining({ permit_no: "BP-2026-0412", address: "18 Mill Road", fee: "120.5" }),
      expect.objectContaining({ permit_no: "BP-2026-0413", address: "7 Alder Court", fee: "80" }),
    ]);
    expect(rows(made.get("made-here.zip")?.table as string)).toEqual([
      expect.objectContaining({ id: "1", name: "Lena Hart" }),
      expect.objectContaining({ id: "2", name: "Omar Reyes" }),
    ]);
  });

  test("the next process of the Store finds its files", async () => {
    const first = open();
    const engine = engineOnStore(first.context);
    const csv = await upload(first, engine, "permits-utf8.csv", sample("permits-utf8.csv"));
    await programOn(engine, first.context).close?.();
    first.storage.close();

    const second = open(first.folder);
    const again = engineOnStore(second.context);
    const run = programOn(again, second.context);
    const job = await runJob(second, again, run, {
      kind: "load",
      params: { files: [csv], madeBy: { runId: "mrn-2", step: "s1" } },
      requestKey: "store_load:mrn-2:s1@",
    });
    expect([job.state, job.error ?? ""]).toEqual(["done", ""]);
    expect(Number(second.storage.sql.exec("SELECT count(*) AS n FROM permits_utf8").one().n)).toBe(4);
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

  test("an upload nobody finished leaves the Store's folder with its record, a week on", async () => {
    const opened = open();
    const engine = engineOnStore(opened.context);
    const run = programOn(engine, opened.context);
    const created = value(await engine.handler.fileCreate(LENA, { name: "half.csv", size: 10, contentType: "text/csv" }));
    const target = value(await engine.handler.filePartTarget(LENA, created.file.id, 1));
    await diskFiles(opened.folder.files).resumeMultipartUpload(target.key, target.uploadId).uploadPart(1, "half ");
    const uploads = path.join(opened.folder.files, "uploads");
    expect(readdirSync(uploads)).toEqual([target.uploadId]);
    // Nobody says that it arrived. Eight days on, the Store's own alarm drops it.
    opened.clock.value += 8 * 24 * 3_600_000;
    await wakeWhileDue(opened, run);
    expect(opened.storage.sql.exec("SELECT count(*) AS n FROM _files").one().n).toBe(0);
    expect(readdirSync(uploads)).toEqual([]);
    expect(readdirSync(path.join(opened.folder.files, "objects"))).toEqual([]);
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
