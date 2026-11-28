// What another module of HX Fortress may ask of the Databases module: a
// connection by its name, and one job of the data runner on it.
//
// The caller here stands for such a module. It passes its own context and the
// connection's name, and nothing of a server or a login.

import { afterEach, describe, expect, test } from "bun:test";

import { ID_PATTERN } from "../../../src/host/shape";
import { readOutput, STORE_JOB_MAX_MS } from "../../../src/modules/databases/data-runner";
import type { CallingContext, ModuleJob } from "../../../src/modules/databases/for-modules";
import { ask, spoolRecords, spoolText } from "../../host/_module-rig";
import {
  act,
  addConnection,
  BILLING,
  deferred,
  makeDatabasesRig,
  PERMITS,
  testConnection,
  type DatabasesRig,
} from "./_rig";
import { PERMITS_PASSWORD } from "./standin-data-runner";

let rig: DatabasesRig | null = null;
afterEach(async () => {
  await rig?.cleanup();
  rig = null;
});

const STORE = {
  gatewayUrl: "http://127.0.0.1:8791/v1",
  storeId: "store_permits",
  jobId: "sj_0001",
  key: "store-job-key-0f3a9b-not-to-be-kept",
};
const PULL: ModuleJob = { kind: "pull", store: STORE };
/** The Stores module's own context, for the own organization of this HX Fortress. */
const STORES: CallingContext = { organization: { id: "not-read-for-the-own-organization", own: true }, moduleId: "stores" };

/** A rig with one connection that passed its test, and one that was never
 *  tested. What the test left in the rig's lists is emptied. */
async function ready(options: Parameters<typeof makeDatabasesRig>[0] = {}): Promise<DatabasesRig> {
  const made = await makeDatabasesRig(options);
  await addConnection(made);
  await addConnection(made, BILLING);
  await testConnection(made);
  made.jobs.length = 0;
  made.runs.length = 0;
  return made;
}

async function jobRecords(of: DatabasesRig): Promise<{ action: string; params: Record<string, unknown> }[]> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  return (await spoolRecords(of.paths))
    .filter((record) => record.action.startsWith("module.databases.connection.job"))
    .map((record) => ({ action: record.action, params: record.params ?? {} }));
}

/** Both places for other modules are free again: two jobs can be held at once. */
async function bothPlacesFree(of: DatabasesRig): Promise<void> {
  await of.module.idle();
  expect(await of.module.forModules.run(STORES, PERMITS.name, PULL)).toMatchObject({ ok: true });
}

/**
 * Wait until something is so. A test that waits a fixed time for another task
 * to get somewhere fails on a busy machine.
 */
async function until(what: () => boolean): Promise<void> {
  const end = Date.now() + 10_000;
  while (!what()) {
    if (Date.now() > end) throw new Error("what the test waits for did not happen");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The id another module knows a connection by. */
async function idOf(of: DatabasesRig, name: string = PERMITS.name): Promise<string> {
  const view = await of.module.forModules.connection(STORES, name);
  if (!view) throw new Error(`no connection is named ${name}`);
  return view.id;
}

describe("a connection, as another module sees it", () => {
  test("by its name, with where it stands, and nothing of its server or its login", async () => {
    rig = await ready();
    const { forModules } = rig.module;
    const id = expect.stringMatching(/^c[0-9a-f]{16}\.1$/) as unknown as string;
    expect(await forModules.connection(STORES, "northstar PERMITS")).toEqual({
      id,
      name: "Northstar permits",
      engine: "sqlserver",
      state: "ready",
      runnable: true,
    });
    const all = await forModules.connections(STORES);
    expect(all).toEqual([
      { id, name: "Northstar permits", engine: "sqlserver", state: "ready", runnable: true },
      { id, name: "Northstar billing", engine: "postgres", state: "not_tested", runnable: false },
    ]);
    expect(await forModules.connection(STORES, "No such connection")).toBeNull();
    expect(await forModules.connection(STORES, 7 as unknown as string)).toBeNull();
    const seen = JSON.stringify(all);
    for (const hidden of [PERMITS.host, PERMITS.user, PERMITS.keyName, "1433"]) expect(seen).not.toContain(hidden);
  });

  test("a connection whose login can change the database is not one a job runs on", async () => {
    rig = await ready();
    await testConnection(rig, BILLING.name);
    expect(await rig.module.forModules.connection(STORES, BILLING.name)).toMatchObject({
      state: "ready",
      runnable: false,
    });
    expect(await rig.module.forModules.run(STORES, BILLING.name, PULL)).toEqual({ ok: false, code: "login_can_write" });
  });
});

describe("the id another module knows a connection by", () => {
  test("is one token that an ask can carry, and each connection has its own", async () => {
    rig = await ready();
    const permits = await idOf(rig);
    const billing = await idOf(rig, BILLING.name);
    expect(permits).not.toBe(billing);
    for (const id of [permits, billing]) {
      expect(id).toMatch(/^c[0-9a-f]{16}\.1$/);
      expect(ID_PATTERN.test(id)).toBe(true);
    }
    // It is the same at every reading.
    expect(await idOf(rig)).toBe(permits);
    expect((await rig.module.forModules.connections(STORES)).map((view) => view.id)).toEqual([permits, billing]);
  });

  test("stays through a change that names the same database", async () => {
    rig = await ready();
    const before = await idOf(rig);
    // Another login, another way to encrypt, a certificate's name, and the
    // server's name in another case.
    const changes = [
      { user: "permits_reader_2" },
      { keyName: "permits-reader-2" },
      { encryption: "require" },
      { serverName: "sql.northstar.example" },
      { host: "SQL01.northstar.example" },
    ];
    for (const change of changes) {
      expect([change, (await act(rig, "connection.change", { ...PERMITS, ...change })).ok]).toEqual([change, true]);
      expect([change, await idOf(rig)]).toEqual([change, before]);
    }
    // And through write settings being set and taken away.
    const writes = { name: PERMITS.name, user: "permits_writer", keyName: "permits-writer" };
    expect((await act(rig, "connection.writes.set", writes)).ok).toBe(true);
    expect(await idOf(rig)).toBe(before);
    expect((await act(rig, "connection.writes.remove", { name: PERMITS.name })).ok).toBe(true);
    expect(await idOf(rig)).toBe(before);
  });

  test("stays through all of that also once the connection has named a second database, and through a start of the daemon", async () => {
    rig = await ready();
    const first = await idOf(rig);
    // The second database. From here on a count that was lost would read as
    // the first database's again.
    const second = { ...PERMITS, database: "Permits2" };
    expect((await act(rig, "connection.change", second)).ok).toBe(true);
    const id = first.replace(/\.1$/, ".2");
    expect(await idOf(rig)).toBe(id);
    const changes = [
      { user: "permits_reader_2" },
      { keyName: "permits-reader-2" },
      { encryption: "require" },
      { serverName: "sql.northstar.example" },
      { host: "SQL01.northstar.example" },
    ];
    for (const change of changes) {
      expect([change, (await act(rig, "connection.change", { ...second, ...change })).ok]).toEqual([change, true]);
      expect([change, await idOf(rig)]).toEqual([change, id]);
    }
    const writes = { name: PERMITS.name, user: "permits_writer", keyName: "permits-writer" };
    expect((await act(rig, "connection.writes.set", writes)).ok).toBe(true);
    expect(await idOf(rig)).toBe(id);
    expect((await act(rig, "connection.writes.set", { ...writes, tables: [{ schema: "dbo", name: "permits" }] })).ok).toBe(true);
    expect(await idOf(rig)).toBe(id);
    expect((await act(rig, "connection.writes.remove", { name: PERMITS.name })).ok).toBe(true);
    expect(await idOf(rig)).toBe(id);
    // A test of the connection writes its record twice more.
    await testConnection(rig);
    expect(await idOf(rig)).toBe(id);
    // And the count is kept on the disk: a new daemon over the same folder reads it.
    const next = await makeDatabasesRig({ restartOf: rig });
    try {
      expect(await idOf(next)).toBe(id);
      expect(await idOf(next, BILLING.name)).toMatch(/\.1$/);
    } finally {
      await next.cleanup();
    }
  });

  test.each([
    ["another engine", { engine: "postgres" }],
    ["another server", { host: "sql02.northstar.example" }],
    ["another port", { port: 1434 }],
    ["another database", { database: "Permits2" }],
    ["a database whose name differs only by case", { database: "permits" }],
  ])("is another after a change to %s", async (_what, change) => {
    rig = await ready();
    const before = await idOf(rig);
    const other = await idOf(rig, BILLING.name);
    expect((await act(rig, "connection.change", { ...PERMITS, ...change })).ok).toBe(true);
    const after = await idOf(rig);
    expect(after).toBe(before.replace(/\.1$/, ".2"));
    expect(after).not.toBe(before);
    // No other connection's id moved.
    expect(await idOf(rig, BILLING.name)).toBe(other);
  });

  test("is never an id it was before, also when the connection names its first database again", async () => {
    rig = await ready();
    const first = await idOf(rig);
    expect((await act(rig, "connection.change", { ...PERMITS, database: "Permits2" })).ok).toBe(true);
    const second = await idOf(rig);
    expect((await act(rig, "connection.change", PERMITS)).ok).toBe(true);
    const third = await idOf(rig);
    expect(new Set([first, second, third]).size).toBe(3);
    expect(third).toBe(first.replace(/\.1$/, ".3"));
  });

  test("every database a connection names gets an id of its own, however many it names", async () => {
    rig = await ready();
    const ids = [await idOf(rig)];
    for (const database of ["Permits2", "Permits3", "Permits4", "Permits5", "Permits6"]) {
      expect((await act(rig, "connection.change", { ...PERMITS, database })).ok).toBe(true);
      ids.push(await idOf(rig));
    }
    expect(ids).toEqual([1, 2, 3, 4, 5, 6].map((count) => (ids[0] as string).replace(/\.1$/, `.${count}`)));
  });

  test("is another for a connection that was removed and added again under the same name", async () => {
    rig = await ready();
    const before = await idOf(rig);
    expect((await act(rig, "connection.remove", { name: PERMITS.name })).ok).toBe(true);
    await addConnection(rig);
    const after = await idOf(rig);
    expect(after).toMatch(/^c[0-9a-f]{16}\.1$/);
    expect(after).not.toBe(before);
  });

  test("a change that could not be saved leaves the id as it was", async () => {
    rig = await ready();
    const before = await idOf(rig);
    // The record takes no write that holds the new database's name. Any other
    // write of the record is taken: a count that was saved apart from the
    // change, before it or after it failed, would stay.
    const write = rig.ctx.state.write.bind(rig.ctx.state);
    let refused = 0;
    rig.ctx.state.write = async <T>(key: string, value: T): Promise<void> => {
      if (key === "connections" && JSON.stringify(value).includes('"Permits2"')) {
        refused += 1;
        throw Object.assign(new Error("the disk is full"), { code: "ENOSPC" });
      }
      return write(key, value);
    };
    expect((await act(rig, "connection.change", { ...PERMITS, database: "Permits2" })).ok).toBe(false);
    rig.ctx.state.write = write;
    expect(refused).toBe(1);
    expect(await idOf(rig)).toBe(before);
    expect(await rig.ctx.state.read<unknown>("connections")).toMatchObject({
      connections: [{ database: "Permits", databaseCount: 1 }, { databaseCount: 1 }],
    });
    // The change that then works counts on from where the connection stood.
    expect((await act(rig, "connection.change", { ...PERMITS, database: "Permits2" })).ok).toBe(true);
    expect(await idOf(rig)).toBe(before.replace(/\.1$/, ".2"));
  });

  test.each<[string, (of: DatabasesRig, fault: (() => void) | undefined) => void, Record<string, unknown>]>([
    [
      "the list of hosts does not take the new server",
      (of, fault) => {
        of.faults.reachAdd = fault;
      },
      { host: "sql02.northstar.example" },
    ],
    [
      "the list of secret names does not take the new secret",
      (of, fault) => {
        of.faults.secretNameAdd = fault;
      },
      { database: "Permits2", keyName: "permits-reader-2" },
    ],
  ])("a change to another database that fails because %s leaves the id as it was", async (_what, setFault, change) => {
    rig = await ready();
    const before = await idOf(rig);
    let calls = 0;
    // The first call fails. The one that puts the old entry back is taken.
    setFault(rig, (): void => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("the disk is full"), { code: "ENOSPC" });
    });
    expect((await act(rig, "connection.change", { ...PERMITS, ...change })).ok).toBe(false);
    setFault(rig, undefined);
    expect(calls).toBeGreaterThan(0);
    expect(await idOf(rig)).toBe(before);
  });

  test("a record of a connection with no count reads as its first database, and counts on from there", async () => {
    rig = await ready();
    const before = await idOf(rig);
    // The record as a build wrote it that kept no count.
    const book = (await rig.ctx.state.read("connections")) as { connections: Record<string, unknown>[] };
    for (const connection of book.connections) delete connection.databaseCount;
    await rig.ctx.state.write("connections", book);
    expect(await idOf(rig)).toBe(before);
    expect((await act(rig, "connection.change", { ...PERMITS, port: 1434 })).ok).toBe(true);
    expect(await idOf(rig)).toBe(before.replace(/\.1$/, ".2"));
  });

  test("a job names the id the connection has now, also after it has named other databases", async () => {
    rig = await ready();
    const first = await idOf(rig);
    // Away to a second database and back to the first: its third id.
    expect((await act(rig, "connection.change", { ...PERMITS, database: "Permits2" })).ok).toBe(true);
    expect((await act(rig, "connection.change", PERMITS)).ok).toBe(true);
    await testConnection(rig);
    const id = first.replace(/\.1$/, ".3");
    const connection = { id, name: "Northstar permits", engine: "sqlserver" };
    expect(await rig.module.forModules.run(STORES, PERMITS.name, PULL)).toMatchObject({ ok: true, kind: "pull", connection });
    expect(await rig.module.forModules.run(STORES, PERMITS.name, { kind: "compare", store: STORE })).toMatchObject({
      ok: true,
      kind: "compare",
      connection,
    });
  });

  test("a job that read the record before a change was saved names the database it ran on, and not the one the connection names by its end", async () => {
    rig = await ready();
    const before = await idOf(rig);
    // A pull reads the record, and its reading is held: it holds the record as
    // it is before the change.
    const read = rig.ctx.state.read.bind(rig.ctx.state);
    const held = deferred();
    let first = true;
    let reading = false;
    rig.ctx.state.read = async <T>(key: string): Promise<T | null> => {
      const value = await read<T>(key);
      if (key === "connections" && first) {
        first = false;
        reading = true;
        await held.promise;
      }
      return value;
    };
    const pull = rig.module.forModules.run(STORES, PERMITS.name, PULL);
    await until(() => reading);
    // An operator's change to another database, made and saved while the pull
    // is between its reading and its start. The change stops what runs on the
    // connection, and the pull does not run yet.
    expect((await act(rig, "connection.change", { ...PERMITS, database: "Permits2" })).ok).toBe(true);
    rig.ctx.state.read = read;
    expect(await idOf(rig)).toBe(before.replace(/\.1$/, ".2"));
    // The pull goes on with what it read. It is handed the first database, and
    // that is the one it names.
    held.resolve();
    expect(await pull).toMatchObject({
      ok: true,
      kind: "pull",
      connection: { id: before, name: "Northstar permits", engine: "sqlserver" },
    });
    expect(rig.jobs[0]).toMatchObject({ kind: "pull", database: "Permits" });
  });

  test("a job that starts while a change is being saved is stopped when the change is saved", async () => {
    const never = deferred();
    let holding: Promise<void> = Promise.resolve();
    rig = await ready({ hold: () => holding });
    // An operator's change to another database, held at its save.
    const saved = deferred();
    const write = rig.ctx.state.write.bind(rig.ctx.state);
    let gate: Promise<void> | null = saved.promise;
    let atItsSave = false;
    rig.ctx.state.write = async <T>(key: string, value: T): Promise<void> => {
      if (key === "connections" && gate !== null) {
        const wait = gate;
        gate = null;
        atItsSave = true;
        await wait;
      }
      return write(key, value);
    };
    const change = act(rig, "connection.change", { ...PERMITS, database: "Permits2" });
    await until(() => atItsSave);
    // A pull starts now. It reads the record as it still is, and its program is held.
    holding = never.promise;
    const pull = rig.module.forModules.run(STORES, PERMITS.name, PULL);
    await until(() => rig?.runs.length === 1);
    expect(rig.runs[0]?.signal?.aborted).toBe(false);
    // The change is saved, and stops what runs on the connection as it was.
    saved.resolve();
    expect((await change).ok).toBe(true);
    rig.ctx.state.write = write;
    expect(await pull).toEqual({ ok: false, code: "connection_changed", jobId: expect.stringMatching(/^job_/) as unknown as string });
    never.resolve();
  });

  test("a job that ended well names the connection it ran on", async () => {
    rig = await ready();
    const connection = { id: await idOf(rig), name: "Northstar permits", engine: "sqlserver" };
    expect(await rig.module.forModules.run(STORES, "NORTHSTAR permits", PULL)).toMatchObject({ ok: true, kind: "pull", connection });
    expect(await rig.module.forModules.run(STORES, PERMITS.name, { kind: "compare", store: STORE })).toMatchObject({
      ok: true,
      kind: "compare",
      connection,
    });
    // A job that did not end well names none: it is told why in one word.
    const stop = new AbortController();
    stop.abort();
    const refused = await rig.module.forModules.run(STORES, PERMITS.name, PULL, { signal: stop.signal });
    expect(refused).toEqual({ ok: false, code: "interrupted" });
  });
});

describe("a job for another module", () => {
  test("a pull runs with the connection's read login and answers counts", async () => {
    rig = await ready();
    const outcome = await rig.module.forModules.run(STORES, PERMITS.name, PULL);
    expect(outcome).toMatchObject({ ok: true, kind: "pull" });
    const { jobId, tables } = outcome as { jobId: string; tables: unknown[] };
    expect(tables[0]).toEqual({
      source: "dbo.permits",
      into: "permits",
      mode: "new",
      read: 5,
      sent: 5,
      removed: 0,
      pages: 1,
      cut: 0,
    });
    // What the program was handed: the store job as it was given, the read
    // login, the address from the list of hosts, and just under half an hour.
    expect(rig.jobs).toHaveLength(1);
    expect(rig.jobs[0]).toMatchObject({
      id: jobId,
      kind: "pull",
      store: STORE,
      login: { kind: "read", user: PERMITS.user, password: PERMITS_PASSWORD },
      reach: { kind: "direct", host: PERMITS.host, port: PERMITS.port },
      deadline: new Date(rig.now.value.getTime() + STORE_JOB_MAX_MS).toISOString(),
    });
    expect(rig.runs[0]?.timeoutMs).toBe(30 * 60_000);
    // Two lines in the audit trail, with the module that asked and the store job.
    const line = { target: "Northstar permits", kind: "pull", by: "stores", job: jobId, store: "store_permits", storeJob: "sj_0001" };
    expect(await jobRecords(rig)).toEqual([
      { action: "module.databases.connection.job", params: line },
      { action: "module.databases.connection.job.done", params: { ...line, tables: 3, read: 5, sent: 5 } },
    ]);
    // The store job's key was handed to the program and kept nowhere.
    const kept = [
      await spoolText(rig.paths),
      JSON.stringify(rig.logs),
      JSON.stringify(await rig.ctx.state.read("connections")),
    ].join("\n");
    expect(kept).not.toContain(STORE.key);
  });

  test("a compare answers its counts", async () => {
    rig = await ready();
    expect(await rig.module.forModules.run(STORES, PERMITS.name, { kind: "compare", store: STORE })).toEqual({
      ok: true,
      kind: "compare",
      jobId: expect.stringMatching(/^job_/) as unknown as string,
      connection: { id: await idOf(rig), name: "Northstar permits", engine: "sqlserver" },
      job: "compare",
      read: 5,
      targetRows: 5,
      sent: 5,
      same: 4,
      otherRows: 1,
    });
  });

  const withStore = (change: Record<string, unknown>): unknown => ({ kind: "pull", store: { ...STORE, ...change } });

  test.each<[string, CallingContext, unknown, unknown, unknown, string]>([
    ["a connection that does not exist", STORES, "No such connection", PULL, {}, "connection_unknown"],
    ["a connection that passed no test", STORES, BILLING.name, PULL, {}, "not_tested"],
    ["a job that writes", STORES, PERMITS.name, { kind: "push", store: STORE }, {}, "job_invalid"],
    ["a job with no store", STORES, PERMITS.name, { kind: "pull", store: null }, {}, "job_invalid"],
    ["no job at all", STORES, PERMITS.name, null, null, "job_invalid"],
    ["a store's id that is a path", STORES, PERMITS.name, withStore({ storeId: "../../admin" }), {}, "job_invalid"],
    ["a store job's id with a space", STORES, PERMITS.name, withStore({ jobId: "sj 0001" }), {}, "job_invalid"],
    ["a key with a line end", STORES, PERMITS.name, withStore({ key: "key\r\nX-Other: 1" }), {}, "job_invalid"],
    ["a key that is empty", STORES, PERMITS.name, withStore({ key: "" }), {}, "job_invalid"],
    ["a signal that is not one", STORES, PERMITS.name, PULL, { signal: {} }, "job_invalid"],
    ["a caller that is not a module", { ...STORES, moduleId: "Stores Module" }, PERMITS.name, PULL, {}, "job_invalid"],
    ["a connection's name that is not text", STORES, 7, PULL, {}, "job_invalid"],
    ["no caller", undefined as unknown as CallingContext, PERMITS.name, PULL, {}, "databases_off"],
    // The store's gateway has one form. Whatever another parser could read as
    // another host is refused, and so is every other spelling of this machine.
    ...[
      "https://stores.control.example/v1",
      "http://10.0.0.5:8791/v1",
      "http://127.0.0.1/v1",
      "http://127.0.0.1:0/v1",
      "http://127.0.0.1:65536/v1",
      "http://a:b@127.0.0.1:8791/v1",
      "http://127.0.0.1:8791\\@stores.example/v1",
      "http://127.0.0.1:8791#@stores.example",
      "http://127.0.0.1:8791/v1?x=1",
      "http://127.0.0.1:8791/../x",
      "http://2130706433:8791/v1",
      "http://127.1:8791/v1",
      "http://localhost:8791/v1",
      "HTTP://127.0.0.1:8791/v1",
      " http://127.0.0.1:8791/v1\n",
      "http:127.0.0.1:8791",
    ].map((gatewayUrl): [string, CallingContext, unknown, unknown, unknown, string] => [
      `the gateway ${JSON.stringify(gatewayUrl)}`,
      STORES,
      PERMITS.name,
      withStore({ gatewayUrl }),
      {},
      "gateway_not_local",
    ]),
  ])("is refused with one word, and nothing is started: %s", async (_what, caller, name, job, options, code) => {
    rig = await ready();
    const outcome = await rig.module.forModules.run(caller, name as string, job as ModuleJob, options as object);
    expect(outcome as unknown).toEqual({ ok: false, code });
    expect(rig.runs).toEqual([]);
    // No place was taken and kept: both are free.
    await bothPlacesFree(rig);
  });

  test.each(["http://127.0.0.1:8791", "http://127.0.0.1:80/", "http://[::1]:8791/stores/v1"])(
    "the program is handed the gateway's address as it was given: %s",
    async (gatewayUrl) => {
      rig = await ready();
      expect(await rig.module.forModules.run(STORES, PERMITS.name, { kind: "pull", store: { ...STORE, gatewayUrl } })).toMatchObject({
        ok: true,
      });
      expect((rig.jobs[0] as { store: { gatewayUrl: string } }).store.gatewayUrl).toBe(gatewayUrl);
    },
  );

  test("an organization the module is not on for has no connections and runs no job", async () => {
    rig = await ready();
    const other: CallingContext = { organization: { id: "alder-dental", own: false }, moduleId: "stores" };
    expect(await rig.module.forModules.connections(other)).toEqual([]);
    expect(await rig.module.forModules.connection(other, PERMITS.name)).toBeNull();
    expect(await rig.module.forModules.run(other, PERMITS.name, PULL)).toEqual({ ok: false, code: "databases_off" });
    expect(rig.runs).toEqual([]);
  });

  test("the data runner's word about the store reaches the caller, with the job's id", async () => {
    rig = await ready();
    const full: ModuleJob = { kind: "pull", store: { ...STORE, storeId: "store_full" } };
    const outcome = await rig.module.forModules.run(STORES, PERMITS.name, full);
    expect(outcome).toMatchObject({ ok: false, code: "store_limit" });
    const records = await jobRecords(rig);
    expect(records[records.length - 1]).toMatchObject({
      action: "module.databases.connection.job.failed",
      params: { kind: "pull", by: "stores", code: "store_limit", job: (outcome as { jobId: string }).jobId },
    });
  });

  test("after a database refused the login, nothing signs in with it again until a person's test passes", async () => {
    rig = await ready();
    rig.keyStore.values["permits-reader"] = "a-password-that-is-no-longer-right";
    expect(await rig.module.forModules.run(STORES, PERMITS.name, PULL)).toMatchObject({ ok: false, code: "login" });
    expect(rig.jobs).toHaveLength(1);
    // The Stores module tries again, on a schedule. Nothing signs in.
    for (let i = 0; i < 3; i += 1) {
      expect(await rig.module.forModules.run(STORES, PERMITS.name, PULL)).toEqual({ ok: false, code: "login_refused" });
    }
    expect(rig.jobs).toHaveLength(1);
    expect(await rig.module.forModules.connection(STORES, PERMITS.name)).toMatchObject({ runnable: false });
    // Nor on the control plane's ask, an hour later.
    rig.now.value = new Date(rig.now.value.getTime() + 3_600_000);
    await ask(rig, "databases", "test.start", { connection: PERMITS.name });
    await rig.module.idle();
    expect(rig.jobs).toHaveLength(1);
    // An operator puts the right password into the key store and tests.
    rig.keyStore.values["permits-reader"] = PERMITS_PASSWORD;
    await testConnection(rig);
    expect(await rig.module.forModules.run(STORES, PERMITS.name, PULL)).toMatchObject({ ok: true });
  });

  test("at most two run at once, and a person's test still finds a place", async () => {
    const held = deferred();
    let holding: Promise<void> = Promise.resolve();
    rig = await ready({ hold: () => holding });
    holding = held.promise;
    const first = rig.module.forModules.run(STORES, PERMITS.name, PULL);
    const second = rig.module.forModules.run(STORES, PERMITS.name, PULL);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await rig.module.forModules.run(STORES, PERMITS.name, PULL)).toEqual({ ok: false, code: "busy" });
    // Two of the four places are still free for a person.
    expect((await act(rig, "connection.test", { name: BILLING.name })).ok).toBe(true);
    held.resolve();
    expect(await first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: true });
    await bothPlacesFree(rig);
  });

  test.each([
    ["changes", (of: DatabasesRig) => act(of, "connection.change", { ...PERMITS, database: "Permits2" })],
    ["removes", (of: DatabasesRig) => act(of, "connection.remove", { name: PERMITS.name })],
  ])("when an operator %s the connection, the pull on it is stopped and its caller told why", async (_what, change) => {
    const never = deferred();
    let holding: Promise<void> = Promise.resolve();
    rig = await ready({ hold: () => holding });
    holding = never.promise;
    const pull = rig.module.forModules.run(STORES, PERMITS.name, PULL);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await change(rig)).ok).toBe(true);
    const outcome = await pull;
    expect(outcome).toMatchObject({ ok: false, code: "connection_changed" });
    expect(rig.runs[0]?.signal?.aborted).toBe(true);
    const records = await jobRecords(rig);
    expect(records[records.length - 1]).toMatchObject({
      action: "module.databases.connection.job.failed",
      params: { code: "connection_changed", job: (outcome as { jobId: string }).jobId },
    });
  });

  test("the caller's signal stops the job, and the place is given back", async () => {
    const never = deferred();
    let holding: Promise<void> = Promise.resolve();
    rig = await ready({ hold: () => holding });
    holding = never.promise;
    const stop = new AbortController();
    const running = rig.module.forModules.run(STORES, PERMITS.name, PULL, { signal: stop.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop.abort();
    expect(await running).toMatchObject({ ok: false, code: "interrupted" });
    expect(rig.runs[0]?.signal?.aborted).toBe(true);
    holding = Promise.resolve();
    await bothPlacesFree(rig);
  });

  test("a caller that has already given up is handed nothing", async () => {
    rig = await ready();
    const stop = new AbortController();
    stop.abort();
    expect(await rig.module.forModules.run(STORES, PERMITS.name, PULL, { signal: stop.signal })).toEqual({
      ok: false,
      code: "interrupted",
    });
    expect(rig.runs).toEqual([]);
    expect(await jobRecords(rig)).toEqual([]);
  });

  test.each<[unknown, number]>([
    [undefined, STORE_JOB_MAX_MS],
    [Number.NaN, STORE_JOB_MAX_MS],
    [Number.POSITIVE_INFINITY, STORE_JOB_MAX_MS],
    ["60000", STORE_JOB_MAX_MS],
    [0, 1_000],
    [-5, 1_000],
    [1500.5, 1_501],
    [3_600_000, STORE_JOB_MAX_MS],
  ])("a job's time is held between one second and just under half an hour: %p", async (asked, held) => {
    rig = await ready();
    const outcome = await rig.module.forModules.run(STORES, PERMITS.name, PULL, { deadlineMs: asked as number });
    expect(outcome).toMatchObject({ ok: true });
    expect(rig.runs[0]?.timeoutMs).toBe(held + 20_000);
  });

  test("a module that was started and then stopped answers nobody", async () => {
    rig = await ready();
    await rig.module.stop?.();
    expect(await rig.module.forModules.connections(STORES)).toEqual([]);
    expect(await rig.module.forModules.connection(STORES, PERMITS.name)).toBeNull();
    expect(await rig.module.forModules.run(STORES, PERMITS.name, PULL)).toEqual({ ok: false, code: "databases_off" });
    expect(rig.runs).toEqual([]);
  });

  test("a module that was never switched on answers nobody", async () => {
    rig = await makeDatabasesRig({ enabled: ["session_vault", "probe"] });
    expect(await rig.module.forModules.connections(STORES)).toEqual([]);
    expect(await rig.module.forModules.run(STORES, PERMITS.name, PULL)).toEqual({ ok: false, code: "databases_off" });
  });
});

describe("a pull's output, as the module reads it", () => {
  const output = (table: Record<string, unknown>): unknown => ({
    v: 1,
    id: "job_1",
    ok: true,
    where: null,
    result: {
      kind: "pull",
      tables: [{ source: "dbo.permits", into: "permits", mode: "new", read: 1, sent: 1, removed: 0, pages: 1, cut: 0, ...table }],
    },
    ms: 1,
  });
  const read = (table: Record<string, unknown>): unknown => readOutput(output(table), { id: "job_1", kind: "pull" });

  test("holds counts and the tables' names, and drops anything else", () => {
    expect(read({ rows: [["BP-2026-0412", "18 Mill Road"]], ms: 7 })).toEqual({
      ok: true,
      findings: {
        kind: "pull",
        tables: [{ source: "dbo.permits", into: "permits", mode: "new", read: 1, sent: 1, removed: 0, pages: 1, cut: 0 }],
      },
    });
  });

  test.each([
    { source: "dbo.permits\n18 Mill Road" },
    { into: "permits\u0000" },
    { source: "" },
    { mode: "replace" },
    { read: -1 },
    { sent: 1.5 },
  ])("is refused whole when a table's part is not what it must be: %j", (table) => {
    expect(read(table)).toEqual({ ok: false, code: "output_invalid", message: "" });
  });
});
