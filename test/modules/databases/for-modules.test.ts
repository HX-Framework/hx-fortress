// What another module of HX Fortress may ask of the Databases module: a
// connection by its name, and one job of the data runner on it.
//
// The caller here stands for such a module. It passes the organization of its
// own context and the connection's name, and nothing of a server or a login.

import { afterEach, describe, expect, test } from "bun:test";

import type { Organization } from "../../../src/host/organization-id";
import { STORE_JOB_MAX_MS } from "../../../src/modules/databases/data-runner";
import type { ModuleJob } from "../../../src/modules/databases/for-modules";
import { spoolRecords, spoolText } from "../../host/_module-rig";
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
const BY = { by: "stores" };
const OWN: Organization = { id: "not-read-for-the-own-organization", own: true };

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

describe("a connection, as another module sees it", () => {
  test("by its name, with where it stands, and nothing of its server or its login", async () => {
    rig = await ready();
    const { forModules } = rig.module;
    expect(await forModules.connection(OWN, "northstar PERMITS")).toEqual({
      name: "Northstar permits",
      engine: "sqlserver",
      state: "ready",
      runnable: true,
    });
    const all = await forModules.connections(OWN);
    expect(all).toEqual([
      { name: "Northstar permits", engine: "sqlserver", state: "ready", runnable: true },
      { name: "Northstar billing", engine: "postgres", state: "not_tested", runnable: false },
    ]);
    expect(await forModules.connection(OWN, "No such connection")).toBeNull();
    const seen = JSON.stringify(all);
    for (const hidden of [PERMITS.host, PERMITS.user, PERMITS.keyName, "1433"]) expect(seen).not.toContain(hidden);
  });

  test("a connection whose login can change the database is not one a job runs on", async () => {
    rig = await ready();
    await testConnection(rig, BILLING.name);
    expect(await rig.module.forModules.connection(OWN, BILLING.name)).toEqual({
      name: "Northstar billing",
      engine: "postgres",
      state: "ready",
      runnable: false,
    });
  });
});

describe("a job for another module", () => {
  test("a pull runs with the connection's read login and answers counts", async () => {
    rig = await ready();
    const outcome = await rig.module.forModules.run(OWN, PERMITS.name, PULL, BY);
    expect(outcome).toMatchObject({ ok: true, kind: "pull" });
    const tables = (outcome as { tables: unknown[] }).tables;
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
    // What the program was handed: the store job, the read login, the address
    // from the list of hosts, and just under half an hour.
    expect(rig.jobs).toHaveLength(1);
    expect(rig.jobs[0]).toMatchObject({
      kind: "pull",
      store: STORE,
      login: { kind: "read", user: PERMITS.user, password: PERMITS_PASSWORD },
      reach: { kind: "direct", host: PERMITS.host, port: PERMITS.port },
      deadline: new Date(rig.now.value.getTime() + STORE_JOB_MAX_MS).toISOString(),
    });
    expect(rig.runs[0]?.timeoutMs).toBe(30 * 60_000);
    // Two lines in the audit trail, with the module that asked.
    const [started, done] = await jobRecords(rig);
    const job = started?.params.job;
    expect(started).toEqual({
      action: "module.databases.connection.job",
      params: { target: "Northstar permits", kind: "pull", by: "stores", job },
    });
    expect(done).toEqual({
      action: "module.databases.connection.job.done",
      params: { target: "Northstar permits", kind: "pull", by: "stores", job, tables: 3, read: 5, sent: 5 },
    });
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
    expect(await rig.module.forModules.run(OWN, PERMITS.name, { kind: "compare", store: STORE }, BY)).toEqual({
      ok: true,
      kind: "compare",
      job: "compare",
      read: 5,
      targetRows: 5,
      sent: 5,
      same: 4,
      otherRows: 1,
    });
  });

  test.each<[string, string, unknown, Record<string, unknown>, string]>([
    ["a connection that does not exist", "No such connection", PULL, BY, "connection_unknown"],
    ["a connection that passed no test", BILLING.name, PULL, BY, "not_tested"],
    ["a gateway on another machine", PERMITS.name, { kind: "pull", store: { ...STORE, gatewayUrl: "https://stores.control.example/v1" } }, BY, "gateway_not_local"],
    ["a gateway at a private address", PERMITS.name, { kind: "pull", store: { ...STORE, gatewayUrl: "http://10.0.0.5:8791/v1" } }, BY, "gateway_not_local"],
    ["a gateway with no port", PERMITS.name, { kind: "pull", store: { ...STORE, gatewayUrl: "http://127.0.0.1/v1" } }, BY, "gateway_not_local"],
    ["a gateway with a login in its address", PERMITS.name, { kind: "pull", store: { ...STORE, gatewayUrl: "http://a:b@127.0.0.1:8791/v1" } }, BY, "gateway_not_local"],
    ["a job that writes", PERMITS.name, { kind: "push", store: STORE }, BY, "job_invalid"],
    ["a job with no store key", PERMITS.name, { kind: "pull", store: { ...STORE, key: "" } }, BY, "job_invalid"],
    ["a caller that is not a module", PERMITS.name, PULL, { by: "Stores Module" }, "job_invalid"],
  ])("is refused with one word, and nothing is started: %s", async (_what, name, job, options, code) => {
    rig = await ready();
    expect(await rig.module.forModules.run(OWN, name, job as ModuleJob, options as { by: string })).toEqual({
      ok: false,
      code,
    });
    expect(rig.runs).toEqual([]);
  });

  test("it does not run on a connection whose login can change the database", async () => {
    rig = await ready();
    await testConnection(rig, BILLING.name);
    rig.runs.length = 0;
    expect(await rig.module.forModules.run(OWN, BILLING.name, PULL, BY)).toEqual({
      ok: false,
      code: "login_can_write",
    });
    expect(rig.runs).toEqual([]);
  });

  test("an organization the module is not on for has no connections and runs no job", async () => {
    rig = await ready();
    const other: Organization = { id: "alder-dental", own: false };
    expect(await rig.module.forModules.connections(other)).toEqual([]);
    expect(await rig.module.forModules.connection(other, PERMITS.name)).toBeNull();
    expect(await rig.module.forModules.run(other, PERMITS.name, PULL, BY)).toEqual({
      ok: false,
      code: "databases_off",
    });
    expect(rig.runs).toEqual([]);
  });

  test("the data runner's word about the store reaches the caller, and its sentence does not", async () => {
    rig = await ready();
    const full: ModuleJob = { kind: "pull", store: { ...STORE, storeId: "store_full" } };
    expect(await rig.module.forModules.run(OWN, PERMITS.name, full, BY)).toEqual({ ok: false, code: "store_limit" });
    const records = await jobRecords(rig);
    expect(records[records.length - 1]).toMatchObject({
      action: "module.databases.connection.job.failed",
      params: { kind: "pull", by: "stores", code: "store_limit" },
    });
  });

  test("at most two run at once, and a person's test still finds a place", async () => {
    const held = deferred();
    let holding: Promise<void> = Promise.resolve();
    rig = await ready({ hold: () => holding });
    holding = held.promise;
    const first = rig.module.forModules.run(OWN, PERMITS.name, PULL, BY);
    const second = rig.module.forModules.run(OWN, PERMITS.name, PULL, BY);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await rig.module.forModules.run(OWN, PERMITS.name, PULL, BY)).toEqual({ ok: false, code: "busy" });
    // Two of the four places are still free for a person.
    expect((await act(rig, "connection.test", { name: PERMITS.name })).ok).toBe(true);
    held.resolve();
    expect(await first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: true });
    await rig.module.idle();
    expect(await rig.module.forModules.run(OWN, PERMITS.name, PULL, BY)).toMatchObject({ ok: true });
  });

  test("the caller's signal stops the job", async () => {
    const never = deferred();
    let holding: Promise<void> = Promise.resolve();
    rig = await ready({ hold: () => holding });
    holding = never.promise;
    const stop = new AbortController();
    const running = rig.module.forModules.run(OWN, PERMITS.name, PULL, { by: "stores", signal: stop.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop.abort();
    expect(await running).toEqual({ ok: false, code: "interrupted" });
    expect(rig.runs[0]?.signal?.aborted).toBe(true);
    const records = await jobRecords(rig);
    expect(records[records.length - 1]).toMatchObject({
      action: "module.databases.connection.job.failed",
      params: { code: "interrupted" },
    });
  });

  test("a module that is switched off runs nothing for anybody", async () => {
    rig = await makeDatabasesRig({ enabled: ["session_vault", "probe"] });
    expect(await rig.module.forModules.connections(OWN)).toEqual([]);
    expect(await rig.module.forModules.run(OWN, PERMITS.name, PULL, BY)).toEqual({
      ok: false,
      code: "databases_off",
    });
  });
});
