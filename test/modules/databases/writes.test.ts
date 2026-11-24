// A write into a database, started by the control plane's ask.
//
// The control plane asks `write.start` or `write.undo`, through the ask gate,
// with a grant for exactly the ask's arguments. The module asks the Stores
// module what the write holds, checks it, has the store job opened, and has
// the host run the program with the connection's WRITE login.
//
// The Stores module here is a stand-in the test scripts: it holds two saved
// previews, answers the four calls, and keeps every call it was made. The
// program is the stand-in the other tests use. It reads nothing from a store
// and writes nothing: it answers the counts a small write would.

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { CallingContext, StoreJobTarget } from "../../../src/modules/databases/for-modules";
import {
  STORE_JOB_WORDS,
  type StoreAnswer,
  type StoreJobState,
  type StoresForWrites,
  type WritePart,
  type WriteRequest,
} from "../../../src/modules/databases/stores-port";
import { WRITE_JOBS_KEPT } from "../../../src/modules/databases/writes";
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
  type RigOptions,
} from "./_rig";
import { NORTHSTAR_SERVERS, PERMITS_PASSWORD, PERMITS_WRITER_PASSWORD, type StandInServer } from "./standin-data-runner";

let rig: DatabasesRig | null = null;
afterEach(async () => {
  await rig?.cleanup();
  rig = null;
});

const failed = (code: string): { ok: false; error: string } => ({ ok: false, error: `failed:${code}` });

/** The Store's checksum of a saved preview: any 64 hex characters do here. */
const checksumOf = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

// ── The stand-in for the Stores module ───────────────────────────────────────

interface SavedPreview {
  version: number;
  checksum: string;
  target: { schema: string; name: string };
}

interface FakeStores extends StoresForWrites {
  /** Every call, as `[name, storeId, what]`. */
  calls: [string, string, unknown][];
  /** Who called, as the module passed it. */
  callers: CallingContext[];
  /** The saved previews, by the Store's table. */
  previews: Map<string, SavedPreview>;
  /** The Store's record of writes, by store job. */
  written: Map<string, { connection: string; parts: WritePart[]; rehearsal: boolean; undone: boolean }>;
  opened: string[];
  ended: string[];
  /** How a store job that was not ended by `endWrite` stands when asked. */
  endsAs: { state: StoreJobState; word?: string } | null;
  /** An answer put in front of the next call of that name, once. */
  next: { writeParts?: unknown; openWrite?: unknown; jobState?: unknown };
  /** Held before the next call of that name answers. */
  hold: { writeParts?: Promise<void>; openWrite?: Promise<void> };
  /** How long a call of that name takes, in milliseconds, from when it is made. */
  takes: { writeParts?: number; openWrite?: number };
  /** Thrown by the next call of that name, once. */
  throws: { writeParts?: boolean; openWrite?: boolean; jobState?: boolean; endWrite?: boolean };
}

function fakeStores(): FakeStores {
  let count = 0;
  // Each is taken once: the entry of that name goes, the others stay.
  const take = (name: keyof FakeStores["next"]): unknown => {
    const all = new Map<string, unknown>(Object.entries(stores.next));
    stores.next = Object.fromEntries([...all].filter(([key]) => key !== name));
    return all.get(name);
  };
  const boom = (name: keyof FakeStores["throws"]): void => {
    const all = new Map<string, boolean>(Object.entries(stores.throws));
    if (!all.get(name)) return;
    stores.throws = Object.fromEntries([...all].filter(([key]) => key !== name));
    throw new Error("the Stores module broke");
  };
  /** What a write holds, read from the Store's own records. */
  const partsOf = (storeId: string, request: WriteRequest): StoreAnswer<{ parts: WritePart[] }> => {
    if (storeId === "store_missing") return { ok: false, code: "store_unknown" };
    if (request.kind === "push_undo") {
      const write = stores.written.get(request.write);
      if (!write) return { ok: false, code: "write_not_found" };
      if (write.rehearsal) return { ok: false, code: "write_rehearsed" };
      if (write.undone) return { ok: false, code: "write_undone" };
      if (write.connection !== request.connection.id) return { ok: false, code: "write_elsewhere" };
      return { ok: true, parts: write.parts.map(({ table, version, target }) => ({ table, version, target })) };
    }
    const parts: WritePart[] = [];
    for (const { table, version } of request.previews) {
      const saved = stores.previews.get(table);
      if (!saved || saved.version !== version) return { ok: false, code: "preview_replaced" };
      parts.push({ table, version, checksum: saved.checksum, target: saved.target });
    }
    return { ok: true, parts };
  };
  const stores: FakeStores = {
    calls: [],
    callers: [],
    previews: new Map(),
    written: new Map(),
    opened: [],
    ended: [],
    endsAs: { state: "done" },
    next: {},
    hold: {},
    takes: {},
    throws: {},
    async writeParts(caller, storeId, request) {
      stores.calls.push(["writeParts", storeId, request]);
      stores.callers.push(caller);
      await stores.hold.writeParts;
      if (stores.takes.writeParts !== undefined) await new Promise((resolve) => setTimeout(resolve, stores.takes.writeParts));
      boom("writeParts");
      const scripted = take("writeParts");
      return scripted === undefined ? partsOf(storeId, request) : (scripted as StoreAnswer<{ parts: WritePart[] }>);
    },
    async openWrite(caller, storeId, request) {
      stores.calls.push(["openWrite", storeId, request]);
      stores.callers.push(caller);
      await stores.hold.openWrite;
      if (stores.takes.openWrite !== undefined) await new Promise((resolve) => setTimeout(resolve, stores.takes.openWrite));
      boom("openWrite");
      const scripted = take("openWrite");
      if (scripted !== undefined) return scripted as StoreAnswer<{ job: StoreJobTarget; parts: WritePart[] }>;
      const read = partsOf(storeId, request);
      if (!read.ok) return read;
      count += 1;
      const jobId = `sj_${String(count).padStart(4, "0")}`;
      stores.opened.push(jobId);
      if (request.kind === "push") {
        stores.written.set(jobId, {
          connection: request.connection.id,
          parts: read.parts,
          rehearsal: request.rehearse,
          undone: false,
        });
      } else {
        const write = stores.written.get(request.write);
        if (write) write.undone = true;
      }
      return { ok: true, job: targetOf(storeId, jobId), parts: read.parts };
    },
    async endWrite(_caller, storeId, jobId) {
      stores.calls.push(["endWrite", storeId, jobId]);
      boom("endWrite");
      stores.ended.push(jobId);
    },
    async jobState(_caller, storeId, jobId) {
      stores.calls.push(["jobState", storeId, jobId]);
      boom("jobState");
      const scripted = take("jobState");
      if (scripted !== undefined) return scripted as { state: StoreJobState; word?: string } | null;
      if (stores.ended.includes(jobId)) return { state: "failed", word: "stopped" };
      return stores.endsAs;
    },
  };
  return stores;
}

/** The store job as the Stores module hands it over, for the program. */
const targetOf = (storeId: string, jobId: string): StoreJobTarget => ({
  gatewayUrl: "http://127.0.0.1:8791/local/stores",
  storeId,
  jobId,
  key: `a-store-job-key-for-${jobId}-that-is-kept-nowhere`,
});

// ── A rig with a connection that can be written ──────────────────────────────

const WRITES = {
  name: PERMITS.name,
  user: "permits_writer",
  keyName: "permits-writer",
  tables: [
    { schema: "dbo", name: "permits" },
    { schema: "dbo", name: "fees" },
  ],
};

interface Ready {
  rig: DatabasesRig;
  stores: FakeStores;
}

/**
 * A connection that passed its test and has write settings, and a Store that
 * holds two previews for its two tables.
 */
async function ready(options: RigOptions & { noStores?: boolean } = {}): Promise<Ready> {
  const stores = fakeStores();
  const made = await makeDatabasesRig({ ...options, stores: () => (options.noStores ? null : stores) });
  rig = made;
  await addConnection(made);
  await testConnection(made);
  const set = await act(made, "connection.writes.set", WRITES);
  if (!set.ok) throw new Error(`the write settings were not taken: ${set.error}`);
  made.jobs.length = 0;
  made.runs.length = 0;
  stores.previews.set("permits_preview", { version: 3, checksum: checksumOf("permits"), target: { schema: "dbo", name: "permits" } });
  stores.previews.set("fees_preview", { version: 1, checksum: checksumOf("fees"), target: { schema: "dbo", name: "fees" } });
  return { rig: made, stores };
}

const PREVIEWS = [
  { table: "permits_preview", version: 3, checksum: checksumOf("permits") },
  { table: "fees_preview", version: 1, checksum: checksumOf("fees") },
];

/** What the control plane asks, for a write that a person approved. */
const START = {
  request: "approval_0001",
  connection: PERMITS.name,
  store: "store_permits",
  previews: PREVIEWS,
  rehearse: false,
  writer: "program:permit-sync@4",
  approvedBy: { id: "person_marta", email: "marta.lindqvist@northstar.example" },
};

type Started = { job: string; storeJob: string };

/** Start a write and expect the two ids. */
async function start(of: DatabasesRig, args: Record<string, unknown> = START): Promise<Started> {
  const reply = await ask(of, "databases", "write.start", args);
  if (!reply?.ok) throw new Error(`the write was not started: ${reply?.ok === false ? reply.error : "no reply"}`);
  return reply.payload as Started;
}

/** A job as the control plane reads it. */
async function jobOf(of: DatabasesRig, job: string): Promise<Record<string, unknown>> {
  const reply = await ask(of, "databases", "job.read", { job });
  if (!reply?.ok) throw new Error(`the job was not read: ${reply?.ok === false ? reply.error : "no reply"}`);
  return reply.payload as Record<string, unknown>;
}

/** A record without some of its fields. */
function without<T>(from: Record<string, T>, ...fields: string[]): Record<string, T> {
  return Object.fromEntries(Object.entries(from).filter(([field]) => !fields.includes(field)));
}

/**
 * Wait until something is so. A test that waits a fixed time for another task
 * to get somewhere fails on a busy machine.
 */
async function until(what: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 10_000;
  while (!(await what())) {
    if (Date.now() > end) throw new Error("what the test waits for did not happen");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Whether the Stores module was asked that call by now. */
const called = (stores: FakeStores, name: string): boolean => stores.calls.some(([call]) => call === name);

/**
 * The module's audit records about writes, as `[action, params]`. A module's
 * record is written without being waited for, so this reads until two
 * readings in a row find the same number of them.
 */
async function writeRecords(of: DatabasesRig): Promise<[string, Record<string, unknown>][]> {
  const read = async (): Promise<[string, Record<string, unknown>][]> =>
    (await spoolRecords(of.paths))
      .filter((record) => /^module\.databases\.connection\.write(?:\.|$)/.test(record.action))
      .map((record) => [record.action.slice("module.databases.".length), record.params ?? {}]);
  let before = -1;
  for (let turn = 0; turn < 100; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const now = await read();
    if (now.length === before) return now;
    before = now.length;
  }
  return read();
}

/**
 * Test a connection as a person and wait for that test alone to end.
 * `testConnection` waits until no job of the module runs, which never comes
 * while a write is held.
 */
async function testWhileAWriteIsHeld(of: DatabasesRig, name: string = PERMITS.name): Promise<void> {
  const started = await act(of, "connection.test", { name });
  if (!started.ok) throw new Error(`the test was not started: ${started.error}`);
  await until(async () => {
    const list = await act(of, "connections.read");
    if (!list.ok) throw new Error(`the connections were not read: ${list.error}`);
    const found = (list.payload as { connections: { name: string; test?: { state: string } }[] }).connections.find(
      (connection) => connection.name === name,
    );
    return found?.test !== undefined && found.test.state !== "running";
  });
}

/** Nothing was opened, nothing ran, and a write can still start. */
async function nothingStarted(of: DatabasesRig, stores: FakeStores): Promise<void> {
  await of.module.idle();
  expect(stores.opened).toEqual([]);
  expect(of.jobs).toEqual([]);
  expect((await writeRecords(of)).map(([action]) => action)).toEqual([]);
}

// ── A write ──────────────────────────────────────────────────────────────────

describe("a write that a person approved", () => {
  test("answers its two ids at once, and runs with the connection's write login", async () => {
    const { rig, stores } = await ready();
    const reply = await ask(rig, "databases", "write.start", START);
    expect(reply).toEqual({ ok: true, payload: { job: expect.stringMatching(/^job_/) as unknown as string, storeJob: "sj_0001" } });
    const { job } = (reply as { payload: Started }).payload;
    await rig.module.idle();

    // What the Stores module was asked, and by whom.
    const request = {
      kind: "push",
      connection: { id: expect.stringMatching(/^c[0-9a-f]{16}\.1$/) as unknown as string, name: "Northstar permits", engine: "sqlserver" },
      previews: [
        { table: "permits_preview", version: 3 },
        { table: "fees_preview", version: 1 },
      ],
      rehearse: false,
      writer: "program:permit-sync@4",
      by: "user:person_marta",
    };
    expect(stores.calls).toEqual([
      ["writeParts", "store_permits", request],
      ["openWrite", "store_permits", request],
      ["jobState", "store_permits", "sj_0001"],
    ]);
    expect(stores.callers[0]).toMatchObject({ moduleId: "databases", organization: { own: true } });
    expect(stores.ended).toEqual([]);

    // What the program was handed: the store job as the Stores module made it,
    // the WRITE login, and the address from the list of hosts.
    expect(rig.jobs).toHaveLength(1);
    expect(rig.jobs[0]).toMatchObject({
      id: job,
      kind: "push",
      store: targetOf("store_permits", "sj_0001"),
      login: { kind: "write", user: "permits_writer", password: PERMITS_WRITER_PASSWORD },
      reach: { kind: "direct", host: PERMITS.host, port: PERMITS.port },
      engine: "sqlserver",
      database: "Permits",
    });
    // The module named the write login's secret, and held no value of it.
    expect(rig.runs.map((run) => run.secrets)).toEqual([{ password: "permits-writer" }]);
    expect(rig.secrets.reads).toEqual([]);
  });

  test("`job.read` says how it went, with what the program counted", async () => {
    const { rig } = await ready();
    const { job } = await start(rig);
    await rig.module.idle();
    const view = {
      connection: "Northstar permits",
      state: "done",
      startedAt: rig.now.value.toISOString(),
      finishedAt: rig.now.value.toISOString(),
      kind: "write",
      store: "store_permits",
      storeJob: "sj_0001",
      // How the Store's own job stood when this one ended.
      storeState: "done",
      batches: 2,
      inserted: 3,
      updated: 1,
      deleted: 0,
      held: 1,
    };
    expect(await jobOf(rig, job)).toEqual(view);
    // A person signed in to the console reads the same.
    expect(await act(rig, "job.read", { job })).toEqual({ ok: true, payload: view });
  });

  test("while it runs, `job.read` says so", async () => {
    const never = deferred();
    let holding: Promise<void> = Promise.resolve();
    const { rig } = await ready({ hold: () => holding });
    holding = never.promise;
    const { job } = await start(rig);
    expect(await jobOf(rig, job)).toEqual({
      connection: "Northstar permits",
      state: "running",
      startedAt: rig.now.value.toISOString(),
      kind: "write",
      store: "store_permits",
      storeJob: "sj_0001",
    });
    holding = Promise.resolve();
    never.resolve();
    await rig.module.idle();
    expect(await jobOf(rig, job)).toMatchObject({ state: "done" });
  });

  test("a rehearsal is a job of its own kind", async () => {
    const { rig, stores } = await ready();
    const { job } = await start(rig, { ...START, rehearse: true });
    await rig.module.idle();
    expect(await jobOf(rig, job)).toMatchObject({ kind: "rehearsal", state: "done" });
    expect(stores.calls[1]?.[2]).toMatchObject({ kind: "push", rehearse: true });
  });

  test("the audit trail names who approved what, and how it ended", async () => {
    const { rig } = await ready();
    const { job } = await start(rig);
    await rig.module.idle();
    const line = { target: "Northstar permits", kind: "write", job, request: "approval_0001", store: "store_permits", storeJob: "sj_0001" };
    const who = { writer: "program:permit-sync@4", approver: "person_marta", email: "marta.lindqvist@northstar.example" };
    // One line for each part names the table of the database that is written,
    // and the Store's table that holds what is written there.
    const part = { target: "Northstar permits", job, schema: "dbo" };
    expect(await writeRecords(rig)).toEqual([
      ["connection.write", { ...line, ...who, parts: 2 }],
      ["connection.write.part", { ...part, table: "permits", preview: "permits_preview", version: 3, checksum: checksumOf("permits") }],
      ["connection.write.part", { ...part, table: "fees", preview: "fees_preview", version: 1, checksum: checksumOf("fees") }],
      ["connection.write.done", { ...line, ...who, storeState: "done", batches: 2, inserted: 3, updated: 1, deleted: 0, held: 1 }],
    ]);
  });

  test("an approver's email with a plus sign and an apostrophe is taken, and the trail keeps it", async () => {
    const { rig } = await ready();
    const email = "ada+ops.o'neil@northstar.example";
    const { job } = await start(rig, { ...START, approvedBy: { id: "person_ada", email } });
    await rig.module.idle();
    expect(await jobOf(rig, job)).toMatchObject({ state: "done" });
    const records = await writeRecords(rig);
    expect(records[0]).toEqual(["connection.write", expect.objectContaining({ job, approver: "person_ada", email })]);
    expect(records[records.length - 1]).toEqual(["connection.write.done", expect.objectContaining({ job, email })]);
  });

  test("a writer of the audit trail that throws does not keep a job from running, or its place from being given back", async () => {
    const { rig } = await ready();
    const record = rig.ctx.audit.record.bind(rig.ctx.audit);
    rig.ctx.audit.record = (action, detail): void => {
      if (action.startsWith("connection.write")) throw new Error("the trail's writer is gone");
      record(action, detail);
    };
    try {
      const { job } = await start(rig);
      await rig.module.idle();
      expect(await jobOf(rig, job)).toMatchObject({ state: "done", inserted: 3 });
      // The connection takes its next write: the place was given back.
      const next = await start(rig, { ...START, request: "approval_0002" });
      await rig.module.idle();
      expect(await jobOf(rig, next.job)).toMatchObject({ state: "done" });
    } finally {
      rig.ctx.audit.record = record;
    }
  });

  test("the module keeps ids and counts of a write, and nothing else", async () => {
    const { rig } = await ready();
    const { job } = await start(rig);
    await rig.module.idle();
    const kept = JSON.stringify(await rig.ctx.state.read("writes"));
    expect(kept).toContain(job);
    for (const absent of ["marta", "permit-sync", "permits_preview", checksumOf("permits"), "permits_writer", "kept-nowhere"]) {
      expect([absent, kept.includes(absent)]).toEqual([absent, false]);
    }
    // Neither login's password, and no store job's key, is in the trail, the
    // log or the module's state.
    const everything = [
      await spoolText(rig.paths),
      JSON.stringify(rig.logs),
      kept,
      JSON.stringify(await rig.ctx.state.read("connections")),
    ].join("\n");
    for (const secret of [PERMITS_PASSWORD, PERMITS_WRITER_PASSWORD, "kept-nowhere"]) {
      expect([secret, everything.includes(secret)]).toEqual([secret, false]);
    }
  });
});

describe("the same request again", () => {
  test("answers the job it started, and starts nothing", async () => {
    const { rig, stores } = await ready();
    const first = await start(rig);
    // While it runs, and after it ended.
    expect(await start(rig)).toEqual(first);
    await rig.module.idle();
    expect(await start(rig)).toEqual(first);
    expect(stores.opened).toEqual(["sj_0001"]);
    expect(rig.jobs).toHaveLength(1);
    expect((await writeRecords(rig)).filter(([action]) => action === "connection.write")).toHaveLength(1);
  });

  test("two asks at once with one request start one job", async () => {
    const { rig, stores } = await ready();
    const gate = deferred();
    stores.hold.writeParts = gate.promise;
    const both = Promise.all([start(rig), start(rig)]);
    await until(() => called(stores, "writeParts"));
    gate.resolve();
    const [first, second] = await both;
    expect(second).toEqual(first);
    await rig.module.idle();
    expect(stores.opened).toEqual(["sj_0001"]);
    expect(rig.jobs).toHaveLength(1);
  });

  test.each<[string, Record<string, unknown>]>([
    ["another checksum", { previews: [{ ...PREVIEWS[0], checksum: checksumOf("other") }, PREVIEWS[1]] }],
    ["another version", { previews: [{ ...PREVIEWS[0], version: 4 }, PREVIEWS[1]] }],
    ["the previews in another order", { previews: [PREVIEWS[1], PREVIEWS[0]] }],
    ["a rehearsal", { rehearse: true }],
    ["another writer", { writer: "program:permit-sync@5" }],
    ["another person", { approvedBy: { id: "person_omar", email: "omar.haddad@northstar.example" } }],
    ["another email of the same person", { approvedBy: { id: "person_marta", email: "marta@northstar.example" } }],
    ["another store", { store: "store_other" }],
    ["another connection", { connection: BILLING.name }],
  ])("with %s it is another ask, and is refused", async (_what, change) => {
    const { rig, stores } = await ready();
    const first = await start(rig);
    await rig.module.idle();
    expect(await ask(rig, "databases", "write.start", { ...START, ...change })).toEqual(failed("request_reused"));
    expect(stores.opened).toEqual(["sj_0001"]);
    expect(rig.jobs).toHaveLength(1);
    // The first one's answer stands.
    expect(await start(rig)).toEqual(first);
  });

  test("an undo with the request of a write is another ask", async () => {
    const { rig } = await ready();
    const { storeJob } = await start(rig);
    await rig.module.idle();
    const rest = without(START, "previews", "rehearse");
    expect(await ask(rig, "databases", "write.undo", { ...rest, write: storeJob })).toEqual(failed("request_reused"));
  });

  test("while the first ask is still being worked on, other arguments are refused at once", async () => {
    const { rig, stores } = await ready();
    const gate = deferred();
    stores.hold.writeParts = gate.promise;
    const first = start(rig);
    await until(() => called(stores, "writeParts"));
    expect(await ask(rig, "databases", "write.start", { ...START, rehearse: true })).toEqual(failed("request_reused"));
    gate.resolve();
    expect(await first).toMatchObject({ storeJob: "sj_0001" });
  });
});

// ── What refuses a write ─────────────────────────────────────────────────────

describe("what is refused before the Stores module is asked", () => {
  test.each<[string, Record<string, unknown>, string]>([
    ["a writer that is no program and no person", { writer: "permit-sync" }, "writer_invalid"],
    ["a program with no version", { writer: "program:permit-sync" }, "writer_invalid"],
    ["a person with no id", { writer: "user:" }, "writer_invalid"],
    ["a writer with a space in it", { writer: "user:marta lindqvist" }, "writer_invalid"],
    ["a writer with two marks", { writer: "program:a@b@c" }, "writer_invalid"],
    ["no preview", { previews: [] }, "previews_invalid"],
    ["one preview named twice", { previews: [PREVIEWS[0], { ...PREVIEWS[0], version: 4 }] }, "previews_invalid"],
    ["a checksum that is no checksum", { previews: [{ ...PREVIEWS[0], checksum: "abc" }] }, "previews_invalid"],
    ["a checksum in capital letters", { previews: [{ ...PREVIEWS[0], checksum: checksumOf("permits").toUpperCase() }] }, "previews_invalid"],
    ["a connection that is not there", { connection: "Northstar archive" }, "connection_unknown"],
  ])("%s", async (_what, change, word) => {
    const { rig, stores } = await ready();
    expect(await ask(rig, "databases", "write.start", { ...START, ...change })).toEqual(failed(word));
    expect(stores.calls).toEqual([]);
    await nothingStarted(rig, stores);
  });

  test("the gate turns away arguments that do not fit the ask's shape", async () => {
    const { rig, stores } = await ready();
    const invalid = { ok: false as const, error: "args_invalid" };
    const nine = Array.from({ length: 9 }, (_, at) => ({ table: `preview_${at}`, version: 1, checksum: checksumOf(String(at)) }));
    expect(await ask(rig, "databases", "write.start", { ...START, previews: nine })).toEqual(invalid);
    const noApprover = without(START, "approvedBy");
    expect(await ask(rig, "databases", "write.start", noApprover)).toEqual(invalid);
    expect(await ask(rig, "databases", "write.start", { ...START, approvedBy: { id: "person_marta" } })).toEqual(invalid);
    // An approver's email is held to the module host's shape for one.
    for (const email of ["Marta@northstar.example", "marta.northstar.example", "marta @northstar.example", "marta@northstar"]) {
      expect(await ask(rig, "databases", "write.start", { ...START, approvedBy: { id: "person_marta", email } })).toEqual(invalid);
    }
    expect(await ask(rig, "databases", "write.start", { ...START, statement: "DELETE FROM permits" })).toEqual(invalid);
    expect(stores.calls).toEqual([]);
    await nothingStarted(rig, stores);
  });

  test("a connection that passed no test since it was added takes no write", async () => {
    const { rig, stores } = await ready();
    await addConnection(rig, BILLING);
    expect((await act(rig, "connection.writes.set", { name: BILLING.name, user: "billing_writer", keyName: "billing-writer" })).ok).toBe(true);
    expect(await ask(rig, "databases", "write.start", { ...START, connection: BILLING.name })).toEqual(failed("not_tested"));
    expect(stores.calls).toEqual([]);
  });

  test("a connection with no write settings takes no write", async () => {
    const { rig, stores } = await ready();
    expect((await act(rig, "connection.writes.remove", { name: PERMITS.name })).ok).toBe(true);
    expect(await ask(rig, "databases", "write.start", START)).toEqual(failed("write_login_missing"));
    expect(stores.calls).toEqual([]);
  });

  test("with no Stores module to ask, a write is refused", async () => {
    const { rig, stores } = await ready({ noStores: true });
    expect(await ask(rig, "databases", "write.start", START)).toEqual(failed("stores_off"));
    await nothingStarted(rig, stores);
  });
});

describe("what is refused for what the Store holds, before anything is opened", () => {
  test.each<[string, (stores: FakeStores) => void, Record<string, unknown>, string]>([
    ["a Store that is not there", () => {}, { store: "store_missing" }, "store_unknown"],
    ["a preview the Store has replaced", (stores) => void (stores.previews.get("permits_preview")!.version = 4), {}, "preview_replaced"],
    ["a preview the Store no longer holds", (stores) => void stores.previews.delete("fees_preview"), {}, "preview_replaced"],
    [
      "a checksum that is not the Store's",
      (stores) => void (stores.previews.get("permits_preview")!.checksum = checksumOf("changed")),
      {},
      "preview_changed",
    ],
    [
      "parts in another order than the ask's previews",
      (stores) => {
        const parts = [...stores.previews].map(([table, saved]) => ({ table, ...saved })).reverse();
        stores.next.writeParts = { ok: true, parts };
      },
      {},
      "preview_changed",
    ],
    [
      "one part fewer than the ask's previews",
      (stores) => {
        const [table, saved] = [...stores.previews][0]!;
        stores.next.writeParts = { ok: true, parts: [{ table, ...saved }] };
      },
      {},
      "preview_changed",
    ],
    [
      "a part of another version than the ask names, with the checksum the ask names",
      (stores) => {
        const parts = [...stores.previews].map(([table, saved]) => ({ table, ...saved }));
        parts[0] = { ...parts[0]!, version: 4 };
        stores.next.writeParts = { ok: true, parts };
      },
      {},
      "preview_changed",
    ],
    [
      "a part for another table of the Store, with the version and the checksum the ask names",
      (stores) => {
        const parts = [...stores.previews].map(([table, saved]) => ({ table, ...saved }));
        parts[1] = { ...parts[1]!, table: "another_preview" };
        stores.next.writeParts = { ok: true, parts };
      },
      {},
      "preview_changed",
    ],
    [
      "one part more than the ask's previews, for a table the connection may write",
      (stores) => {
        const parts = [...stores.previews].map(([table, saved]) => ({ table, ...saved }));
        parts.push({ table: "more_preview", version: 1, checksum: checksumOf("more"), target: { schema: "dbo", name: "fees" } });
        stores.next.writeParts = { ok: true, parts };
      },
      {},
      "preview_changed",
    ],
    [
      "a part with no checksum",
      (stores) => {
        const parts = [...stores.previews].map(([table, { version, target }]) => ({ table, version, target }));
        stores.next.writeParts = { ok: true, parts };
      },
      {},
      "preview_changed",
    ],
    [
      "a preview for a table the connection may not write",
      (stores) => void (stores.previews.get("fees_preview")!.target = { schema: "dbo", name: "inspections" }),
      {},
      "table_not_listed",
    ],
    [
      "a table of the same name in another schema",
      (stores) => void (stores.previews.get("fees_preview")!.target = { schema: "audit", name: "fees" }),
      {},
      "table_not_listed",
    ],
    [
      "a table whose name differs by case",
      (stores) => void (stores.previews.get("fees_preview")!.target = { schema: "dbo", name: "Fees" }),
      {},
      "table_not_listed",
    ],
    ["a word the Stores module has for it", (stores) => void (stores.next.writeParts = { ok: false, code: "write_limit_reached" }), {}, "write_limit_reached"],
    ["a word that is not one of the Stores module's", (stores) => void (stores.next.writeParts = { ok: false, code: "DROP TABLE" }), {}, "store_refused"],
    ["an answer that is none", (stores) => void (stores.next.writeParts = null), {}, "store_refused"],
    ["parts that are no parts", (stores) => void (stores.next.writeParts = { ok: true, parts: [{ table: 7 }] }), {}, "store_refused"],
    ["no parts at all", (stores) => void (stores.next.writeParts = { ok: true, parts: [] }), {}, "store_refused"],
    ["a Stores module that throws", (stores) => void (stores.throws.writeParts = true), {}, "store_refused"],
  ])("%s", async (_what, arrange, change, word) => {
    const { rig, stores } = await ready();
    arrange(stores);
    expect(await ask(rig, "databases", "write.start", { ...START, ...change })).toEqual(failed(word));
    expect(stores.calls.map(([name]) => name)).toEqual(["writeParts"]);
    await nothingStarted(rig, stores);
    // Whatever was refused, the next write that is in order starts.
    stores.next = {};
    stores.previews.set("permits_preview", { version: 3, checksum: checksumOf("permits"), target: { schema: "dbo", name: "permits" } });
    stores.previews.set("fees_preview", { version: 1, checksum: checksumOf("fees"), target: { schema: "dbo", name: "fees" } });
    expect(await start(rig, { ...START, request: "approval_0002" })).toMatchObject({ storeJob: "sj_0001" });
  });

  test("a Stores module that does not answer in time is a refusal, and nothing is held", async () => {
    const { rig, stores } = await ready({ storeCallMs: 50 });
    const never = deferred();
    stores.hold.writeParts = never.promise;
    expect(await ask(rig, "databases", "write.start", START)).toEqual(failed("timeout"));
    never.resolve();
    stores.hold = {};
    await nothingStarted(rig, stores);
  });
});

describe("the time the Stores module has for one ask", () => {
  test("its two calls share one time, and a store job that is opened after the ask gave up is failed again", async () => {
    // Each call alone is within the time. Together they are not.
    const { rig, stores } = await ready({ storeCallMs: 2_000 });
    stores.takes = { writeParts: 1_200, openWrite: 1_200 };
    expect(await ask(rig, "databases", "write.start", START)).toEqual(failed("timeout"));
    expect(stores.calls.map(([name]) => name)).toEqual(["writeParts", "openWrite"]);
    // The Stores module opens the job all the same, later. No program is
    // coming for it, so it is failed again as soon as it is there.
    await until(() => stores.ended.length === 1);
    expect(stores.opened).toEqual(["sj_0001"]);
    expect(stores.ended).toEqual(["sj_0001"]);
    await rig.module.idle();
    expect(rig.jobs).toEqual([]);
    expect((await writeRecords(rig)).map(([action]) => action)).toEqual([]);
    // Nothing was kept of the request: the same ask again starts the write.
    stores.takes = {};
    expect(await start(rig)).toMatchObject({ storeJob: "sj_0002" });
  }, 30_000);

  test("a call that answers late with a refusal leaves nothing to end", async () => {
    const { rig, stores } = await ready({ storeCallMs: 300 });
    stores.takes = { openWrite: 900 };
    stores.next.openWrite = { ok: false, code: "busy" };
    expect(await ask(rig, "databases", "write.start", START)).toEqual(failed("timeout"));
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(stores.ended).toEqual([]);
    stores.takes = {};
    expect(await start(rig)).toMatchObject({ storeJob: "sj_0001" });
  }, 30_000);
});

describe("what is refused after the store job was opened", () => {
  /** The store job that was opened is failed again, no program ran, and the
   *  next write starts. */
  async function openedAndEnded(of: DatabasesRig, stores: FakeStores, storeJob = "sj_0001"): Promise<void> {
    await of.module.idle();
    expect(stores.ended).toEqual([storeJob]);
    expect(of.jobs).toEqual([]);
    expect((await writeRecords(of)).map(([action]) => action)).toEqual([]);
    expect(await start(of, { ...START, request: "approval_0002" })).toMatchObject({ job: expect.stringMatching(/^job_/) as unknown as string });
  }

  test("the opened job holds other parts than were read before it", async () => {
    const { rig, stores } = await ready();
    const gate = deferred();
    stores.hold.openWrite = gate.promise;
    const asked = ask(rig, "databases", "write.start", START);
    await until(() => called(stores, "openWrite"));
    // Between the two calls the Store's preview gets another checksum.
    stores.previews.get("permits_preview")!.checksum = checksumOf("changed in between");
    gate.resolve();
    stores.hold = {};
    expect(await asked).toEqual(failed("preview_changed"));
    stores.previews.get("permits_preview")!.checksum = checksumOf("permits");
    await openedAndEnded(rig, stores);
  });

  test.each<[string, (job: StoreJobTarget) => unknown]>([
    ["of another Store", (job) => ({ ...job, storeId: "store_other" })],
    ["whose gateway is not on this machine", (job) => ({ ...job, gatewayUrl: "https://stores.example.test/v1" })],
    ["whose gateway is this machine by another name", (job) => ({ ...job, gatewayUrl: "http://localhost:8791/local/stores" })],
    ["whose gateway's path steps out of its folder", (job) => ({ ...job, gatewayUrl: "http://127.0.0.1:8791/local/../acts" })],
    ["whose gateway names no port a program can dial", (job) => ({ ...job, gatewayUrl: "http://127.0.0.1:0/local/stores" })],
    ["with no key", (job) => ({ ...job, key: "" })],
  ])("the opened job is one %s", async (_what, change) => {
    const { rig, stores } = await ready();
    const parts = PREVIEWS.map(({ table, version, checksum }) => ({ table, version, checksum, target: stores.previews.get(table)!.target }));
    stores.next.openWrite = { ok: true, job: change(targetOf("store_permits", "sj_0009")), parts };
    expect(await ask(rig, "databases", "write.start", START)).toEqual(failed("store_refused"));
    await rig.module.idle();
    expect(stores.ended).toEqual(["sj_0009"]);
    expect(rig.jobs).toEqual([]);
  });

  test("the Stores module refuses to open it", async () => {
    const { rig, stores } = await ready();
    stores.next.openWrite = { ok: false, code: "busy" };
    expect(await ask(rig, "databases", "write.start", START)).toEqual(failed("busy"));
    expect(stores.ended).toEqual([]);
    await nothingStarted(rig, stores);
  });

  test.each<[string, (of: DatabasesRig) => Promise<{ ok: boolean }>]>([
    ["names another database", (of) => act(of, "connection.change", { ...PERMITS, database: "Permits2" })],
    ["is encrypted another way", (of) => act(of, "connection.change", { ...PERMITS, encryption: "require" })],
    ["may write other tables", (of) => act(of, "connection.writes.set", { ...WRITES, tables: [WRITES.tables[0]] })],
    ["has another write login", (of) => act(of, "connection.writes.set", { ...WRITES, user: "permits_loader" })],
    ["has no write settings", (of) => act(of, "connection.writes.remove", { name: PERMITS.name })],
    ["is gone", (of) => act(of, "connection.remove", { name: PERMITS.name })],
    [
      // It reads as it did when it was checked. The change stopped what was
      // being started on it all the same.
      "was changed, changed back and tested again",
      async (of) => {
        expect((await act(of, "connection.change", { ...PERMITS, encryption: "require" })).ok).toBe(true);
        expect((await act(of, "connection.change", PERMITS)).ok).toBe(true);
        await testWhileAWriteIsHeld(of);
        of.jobs.length = 0;
        return { ok: true };
      },
    ],
  ])("by then the connection %s", async (_what, change) => {
    const { rig, stores } = await ready();
    const gate = deferred();
    stores.hold.openWrite = gate.promise;
    const asked = ask(rig, "databases", "write.start", START);
    await until(() => called(stores, "openWrite"));
    expect((await change(rig)).ok).toBe(true);
    gate.resolve();
    stores.hold = {};
    expect(await asked).toEqual(failed("connection_changed"));
    await rig.module.idle();
    expect(stores.ended).toEqual(["sj_0001"]);
    expect(rig.jobs).toEqual([]);
    expect((await writeRecords(rig)).map(([action]) => action)).toEqual([]);
  });

  /** The key the module's record has for the permits connection's write login. */
  const WRITER_LOGIN = `${PERMITS.host} ${PERMITS.port} permits_writer`;

  test.each<[string, (of: DatabasesRig) => Promise<void>]>([
    [
      "was encrypted another way",
      async (of) => {
        expect((await act(of, "connection.change", { ...PERMITS, encryption: "require" })).ok).toBe(true);
      },
    ],
    [
      "was changed and changed back, and passed no test since",
      async (of) => {
        expect((await act(of, "connection.change", { ...PERMITS, encryption: "require" })).ok).toBe(true);
        expect((await act(of, "connection.change", PERMITS)).ok).toBe(true);
      },
    ],
    [
      "was changed and then tested again",
      async (of) => {
        expect((await act(of, "connection.change", { ...PERMITS, user: "permits_reader" , minTls: "1.3" })).ok).toBe(true);
        await testConnection(of);
      },
    ],
    [
      "may write other tables",
      async (of) => {
        expect((await act(of, "connection.writes.set", { ...WRITES, tables: [...WRITES.tables, { schema: "dbo", name: "inspections" }] })).ok).toBe(true);
      },
    ],
    [
      "named another database and then the first one again, was tested, and got the same write settings",
      async (of) => {
        expect((await act(of, "connection.change", { ...PERMITS, database: "Permits2" })).ok).toBe(true);
        expect((await act(of, "connection.change", PERMITS)).ok).toBe(true);
        await testConnection(of);
        expect((await act(of, "connection.writes.set", WRITES)).ok).toBe(true);
      },
    ],
    [
      "was removed and added again, tested, with the same write settings",
      async (of) => {
        expect((await act(of, "connection.remove", { name: PERMITS.name })).ok).toBe(true);
        await addConnection(of);
        await testConnection(of);
        expect((await act(of, "connection.writes.set", WRITES)).ok).toBe(true);
      },
    ],
    [
      "has a write login that a database refused meanwhile",
      async (of) => {
        const book = (await of.ctx.state.read("connections")) as { refusedLogins?: string[] };
        await of.ctx.state.write("connections", { ...book, refusedLogins: [...(book.refusedLogins ?? []), WRITER_LOGIN] });
      },
    ],
  ])("while the Store was read, the connection %s", async (_what, change) => {
    const { rig, stores } = await ready();
    const gate = deferred();
    stores.hold.writeParts = gate.promise;
    const asked = ask(rig, "databases", "write.start", START);
    await until(() => called(stores, "writeParts"));
    expect(stores.calls.map(([name]) => name)).toEqual(["writeParts"]);
    await change(rig);
    rig.jobs.length = 0;
    gate.resolve();
    stores.hold = {};
    expect(await asked).toEqual(failed("connection_changed"));
    await rig.module.idle();
    // The store job was opened by then, and is failed again. No program ran.
    expect(stores.opened).toEqual(["sj_0001"]);
    expect(stores.ended).toEqual(["sj_0001"]);
    expect(rig.jobs).toEqual([]);
    expect((await writeRecords(rig)).map(([action]) => action)).toEqual([]);
  });

  test("the module stops while the Stores module opens the job: nothing starts, and the store job is failed again", async () => {
    const { rig, stores } = await ready();
    const gate = deferred();
    stores.hold.openWrite = gate.promise;
    const asked = ask(rig, "databases", "write.start", START);
    await until(() => called(stores, "openWrite"));
    expect(stores.calls.map(([name]) => name)).toEqual(["writeParts", "openWrite"]);
    const stopped = rig.module.stop?.();
    gate.resolve();
    stores.hold = {};
    // The connection did not change. The control plane asks again.
    expect(await asked).toEqual(failed("busy"));
    await stopped;
    expect(stores.ended).toEqual(["sj_0001"]);
    expect(rig.jobs).toEqual([]);
    expect(await rig.ctx.state.read<unknown>("writes")).toBeNull();
  });

  test("while the Store was read, the connection's server was renamed and named back, and it was tested again: the write runs on the record as it is now", async () => {
    const { rig, stores } = await ready();
    const gate = deferred();
    stores.hold.writeParts = gate.promise;
    const asked = ask(rig, "databases", "write.start", START);
    await until(() => called(stores, "writeParts"));
    // The server's name in another case is the same server, and each change
    // gives the connection a new entry in the list of hosts.
    const reachBefore = (await rig.ctx.reach.list()).map((entry) => entry.name);
    expect((await act(rig, "connection.change", { ...PERMITS, host: "SQL01.northstar.example" })).ok).toBe(true);
    expect((await act(rig, "connection.change", PERMITS)).ok).toBe(true);
    const reachNow = (await rig.ctx.reach.list()).map((entry) => entry.name);
    expect(reachNow).not.toEqual(reachBefore);
    await testConnection(rig);
    rig.jobs.length = 0;
    rig.runs.length = 0;
    gate.resolve();
    stores.hold = {};
    const reply = await asked;
    expect(reply).toMatchObject({ ok: true, payload: { storeJob: "sj_0001" } });
    await rig.module.idle();
    // The program was handed the entry the connection has now.
    expect(rig.runs.map((run) => run.reach)).toEqual(reachNow);
    expect(await jobOf(rig, (reply as { payload: Started }).payload.job)).toMatchObject({ state: "done" });
    expect(stores.ended).toEqual([]);
  });

  test("while the Store was read, the connection passed another test: the write starts", async () => {
    const { rig, stores } = await ready();
    const gate = deferred();
    stores.hold.writeParts = gate.promise;
    const asked = ask(rig, "databases", "write.start", START);
    await until(() => called(stores, "writeParts"));
    await testConnection(rig);
    gate.resolve();
    stores.hold = {};
    expect(await asked).toMatchObject({ ok: true, payload: { storeJob: "sj_0001" } });
    await rig.module.idle();
    expect(stores.ended).toEqual([]);
  });

  test("the job's record cannot be written", async () => {
    const { rig, stores } = await ready();
    const write = rig.ctx.state.write.bind(rig.ctx.state);
    rig.ctx.state.write = async <T>(key: string, value: T): Promise<void> => {
      if (key === "writes") throw Object.assign(new Error("the disk is full"), { code: "ENOSPC" });
      return write(key, value);
    };
    expect(await ask(rig, "databases", "write.start", START)).toEqual(failed("internal"));
    rig.ctx.state.write = write;
    await openedAndEnded(rig, stores);
  });
});

// ── How a write ends ─────────────────────────────────────────────────────────

describe("a write that does not end well", () => {
  test("the database refuses the write login: no write signs in with it again until an operator sets it again", async () => {
    const { rig, stores } = await ready();
    rig.keyStore.values = { ...rig.keyStore.values, "permits-writer": "not-the-password" };
    const { job } = await start(rig);
    await rig.module.idle();
    expect(await jobOf(rig, job)).toMatchObject({ state: "failed", code: "login", kind: "write" });
    // The program ran, so the Store hears of the end from the program.
    expect(stores.ended).toEqual([]);

    // The next approved write does not try the login again.
    expect(await ask(rig, "databases", "write.start", { ...START, request: "approval_0002" })).toEqual(failed("write_login_refused"));
    expect(rig.jobs).toHaveLength(1);
    // A test of the connection, which signs in with the read login, changes nothing of that.
    await testConnection(rig);
    expect(await ask(rig, "databases", "write.start", { ...START, request: "approval_0003" })).toEqual(failed("write_login_refused"));

    // The operator mends the secret and sets the same write settings again.
    rig.keyStore.values = { ...rig.keyStore.values, "permits-writer": PERMITS_WRITER_PASSWORD };
    expect((await act(rig, "connection.writes.set", WRITES)).ok).toBe(true);
    const again = await start(rig, { ...START, request: "approval_0004" });
    await rig.module.idle();
    expect(await jobOf(rig, again.job)).toMatchObject({ state: "done" });
  });

  test("the write login's secret is not in the key store: no program started, and the store job is failed here", async () => {
    const { rig, stores } = await ready();
    rig.keyStore.values = without(rig.keyStore.values, "permits-writer");
    const { job } = await start(rig);
    await rig.module.idle();
    expect(await jobOf(rig, job)).toEqual({
      connection: "Northstar permits",
      state: "failed",
      startedAt: rig.now.value.toISOString(),
      finishedAt: rig.now.value.toISOString(),
      code: "secret_missing",
      kind: "write",
      store: "store_permits",
      storeJob: "sj_0001",
      storeState: "failed",
      refusal: "stopped",
    });
    expect(stores.ended).toEqual(["sj_0001"]);
    // That is no refusal of the login by a database.
    expect((await start(rig, { ...START, request: "approval_0002" })).storeJob).toBe("sj_0002");
  });

  test.each<[string, string, { state: StoreJobState; word?: string } | null, Record<string, unknown>]>([
    [
      "the Store's gateway refuses the program",
      "store_refuses",
      { state: "failed", word: "preview_stale" },
      { code: "store", storeState: "failed", refusal: "preview_stale" },
    ],
    [
      "the Store reached its limit of writes",
      "store_full",
      { state: "failed", word: "write_limit_reached" },
      { code: "store_limit", storeState: "failed", refusal: "write_limit_reached" },
    ],
    [
      "the Store's word is not one of its list",
      "store_refuses",
      { state: "failed", word: "something else" },
      { code: "store", storeState: "failed", refusal: "failed" },
    ],
    ["the Store's job has no word", "store_refuses", { state: "failed" }, { code: "store", storeState: "failed", refusal: "failed" }],
    ["the Store's job is still running", "store_refuses", { state: "running" }, { code: "store", storeState: "running" }],
    // A word is the Store's word for a job that failed. A job that waits has none here.
    [
      "the Store's job still waits, with a word",
      "store_refuses",
      { state: "queued", word: "write_limit_reached" },
      { code: "store", storeState: "queued" },
    ],
    ["the Store's job stands in a way this build does not know", "store_refuses", { state: "paused" as StoreJobState }, { code: "store" }],
    ["the Store no longer has the job", "store_refuses", null, { code: "store" }],
  ])("%s", async (_what, store, endsAs, expected) => {
    const { rig, stores } = await ready();
    stores.endsAs = endsAs;
    const { job } = await start(rig, { ...START, store });
    await rig.module.idle();
    const view = await jobOf(rig, job);
    expect(view).toMatchObject({ state: "failed", ...expected });
    if (!("refusal" in expected)) expect(view).not.toHaveProperty("refusal");
    if (!("storeState" in expected)) expect(view).not.toHaveProperty("storeState");
    expect(view).not.toHaveProperty("batches");
    // The program ran: the Store's job is the program's and the Store's to end.
    expect(stores.ended).toEqual([]);
    const records = await writeRecords(rig);
    expect(records[records.length - 1]).toEqual([
      "connection.write.failed",
      expect.objectContaining({ job, storeJob: "sj_0001", approver: "person_marta", ...expected }),
    ]);
  });

  test("every word of the Store's list is one `job.read` can answer", async () => {
    const { rig, stores } = await ready();
    for (const [at, word] of STORE_JOB_WORDS.entries()) {
      // The connection is free again after each write, and a minute passes: a
      // grant is taken once, and the gate counts asks.
      rig.now.value = new Date(rig.now.value.getTime() + 61_000);
      stores.endsAs = { state: "failed", word };
      const { job } = await start(rig, { ...START, request: `approval_${at}`, store: "store_refuses" });
      await rig.module.idle();
      expect([word, (await jobOf(rig, job)).refusal]).toEqual([word, word]);
    }
  });

  test("the program ended well and the Store's own job did not: the job is done, with the Store's word", async () => {
    const { rig, stores } = await ready();
    stores.endsAs = { state: "failed", word: "push_link" };
    const { job } = await start(rig);
    await rig.module.idle();
    expect(await jobOf(rig, job)).toMatchObject({ state: "done", refusal: "push_link", batches: 2 });
  });

  test("the Store's word cannot be read: the job still ends", async () => {
    const { rig, stores } = await ready();
    stores.throws.jobState = true;
    const { job } = await start(rig);
    await rig.module.idle();
    expect(await jobOf(rig, job)).toMatchObject({ state: "done", batches: 2 });
    expect((await start(rig, { ...START, request: "approval_0002" })).storeJob).toBe("sj_0002");
  });

  test("how it ended cannot be written: it is answered as it ended all the same, and written with the next write", async () => {
    const { rig } = await ready();
    const write = rig.ctx.state.write.bind(rig.ctx.state);
    // The record takes the start of the job and not its end.
    let writes = 0;
    rig.ctx.state.write = async <T>(key: string, value: T): Promise<void> => {
      if (key === "writes") {
        writes += 1;
        if (writes === 2) throw Object.assign(new Error("the disk is full"), { code: "ENOSPC" });
      }
      return write(key, value);
    };
    const first = await start(rig);
    await rig.module.idle();
    rig.ctx.state.write = write;
    const record = (): Promise<unknown> => rig.ctx.state.read("writes");
    expect(await record()).toMatchObject({ jobs: [{ id: first.job, state: "running" }] });
    // The write happened, and `job.read` says so: it is not answered as interrupted.
    expect(await jobOf(rig, first.job)).toMatchObject({ state: "done", batches: 2 });
    // The next write of the record writes the end too, and adds no line.
    const second = await start(rig, { ...START, request: "approval_0002" });
    await rig.module.idle();
    expect(await record()).toMatchObject({ jobs: [{ id: second.job, state: "done" }, { id: first.job, state: "done", batches: 2 }] });
    expect((await writeRecords(rig)).filter(([, params]) => params.job === first.job).map(([action]) => action)).toEqual([
      "connection.write",
      "connection.write.part",
      "connection.write.part",
      "connection.write.done",
    ]);
  });
});

/** A second connection to the permits database, with the same write login. */
const SECOND = { ...PERMITS, name: "Northstar permits two" };

/** Add the second connection, test it and give it the first one's write settings. */
async function addSecond(of: DatabasesRig): Promise<void> {
  await addConnection(of, SECOND);
  await testConnection(of, SECOND.name);
  const set = await act(of, "connection.writes.set", { ...WRITES, name: SECOND.name });
  if (!set.ok) throw new Error(`the write settings were not taken: ${set.error}`);
  of.jobs.length = 0;
  of.runs.length = 0;
}

describe("what stops a write that runs", () => {
  /** A write that the program holds, until the test lets it go. */
  async function running(
    options: RigOptions = {},
  ): Promise<Ready & { job: string; release: () => void; letOthersRun: () => void }> {
    const never = deferred();
    let holding: Promise<void> = Promise.resolve();
    const made = await ready({ ...options, hold: () => holding });
    holding = never.promise;
    const { job } = await start(made.rig);
    await until(() => made.rig.runs.length === 1);
    return {
      ...made,
      job,
      /** Let the write go on to its end. */
      release: () => {
        holding = Promise.resolve();
        never.resolve();
      },
      /** A job that starts from now on is not held. The write still is. */
      letOthersRun: () => {
        holding = Promise.resolve();
      },
    };
  }

  test.each<[string, (of: DatabasesRig) => Promise<{ ok: boolean }>, string]>([
    ["changes the connection", (of) => act(of, "connection.change", { ...PERMITS, encryption: "require" }), "connection_changed"],
    ["removes the connection", (of) => act(of, "connection.remove", { name: PERMITS.name }), "connection_changed"],
    ["takes its write settings away", (of) => act(of, "connection.writes.remove", { name: PERMITS.name }), "write_settings_changed"],
    ["closes one of its tables to writes", (of) => act(of, "connection.writes.set", { ...WRITES, tables: [WRITES.tables[0]] }), "write_settings_changed"],
    ["gives it another write login", (of) => act(of, "connection.writes.set", { ...WRITES, user: "permits_loader" }), "write_settings_changed"],
  ])("an operator who %s stops it", async (_what, change, code) => {
    const { rig, stores, job } = await running();
    expect((await change(rig)).ok).toBe(true);
    await rig.module.idle();
    expect(rig.runs[0]?.signal?.aborted).toBe(true);
    // The job says how the program ended. How the Store's own job stood then
    // is beside it: this stand-in Store says `done`, as a Store does that was
    // told of the write before the program was stopped.
    expect(await jobOf(rig, job)).toMatchObject({ state: "failed", code, kind: "write", storeState: "done" });
    // The program had started: the Store's job is not failed from here.
    expect(stores.ended).toEqual([]);
    const records = await writeRecords(rig);
    expect(records[records.length - 1]).toEqual(["connection.write.failed", expect.objectContaining({ job, code })]);
  });

  test("a test that finds the read login can change the database does not stop a write", async () => {
    // A write signs in with the write login. What a test finds about the read
    // login stops the jobs that sign in with that one.
    let servers: readonly StandInServer[] = NORTHSTAR_SERVERS;
    const { rig, job, release, letOthersRun } = await running({ servers: () => servers });
    servers = NORTHSTAR_SERVERS.map((server) => ({
      ...server,
      logins: server.logins.map((login) => (login.user === "permits_reader" ? { ...login, writable: ["dbo.permits"] } : login)),
    }));
    // The test is not held. The write still is.
    letOthersRun();
    await testWhileAWriteIsHeld(rig);
    expect(await act(rig, "connections.read")).toMatchObject({ payload: { connections: [{ test: { state: "done", canWrite: true } }] } });
    // The write is still running, and was not told to stop.
    expect(await jobOf(rig, job)).toMatchObject({ state: "running" });
    expect(rig.runs[0]?.signal?.aborted).toBe(false);
    release();
    await rig.module.idle();
    expect(await jobOf(rig, job)).toMatchObject({ state: "done", kind: "write" });
  });

  test("a change of the write settings stops no job that reads", async () => {
    const never = deferred();
    let holding: Promise<void> = Promise.resolve();
    const { rig } = await ready({ hold: () => holding });
    holding = never.promise;
    const caller: CallingContext = { organization: { id: "not-read-for-the-own-organization", own: true }, moduleId: "stores" };
    const pull = rig.module.forModules.run(caller, PERMITS.name, { kind: "pull", store: targetOf("store_permits", "sj_0001") });
    await until(() => rig.runs.length === 1);
    expect((await act(rig, "connection.writes.set", { ...WRITES, tables: [WRITES.tables[0]] })).ok).toBe(true);
    expect((await act(rig, "connection.writes.remove", { name: PERMITS.name })).ok).toBe(true);
    expect(rig.runs[0]?.signal?.aborted).toBe(false);
    holding = Promise.resolve();
    never.resolve();
    expect(await pull).toMatchObject({ ok: true, kind: "pull" });
  });

  test("write settings set again to clear a refused login stop no write that runs", async () => {
    // Two connections sign in to one database with one write login. A write
    // runs on the first. The second one's write is refused by the database.
    const never = deferred();
    let holding: Promise<void> = Promise.resolve();
    const { rig } = await ready({ hold: () => holding });
    await addSecond(rig);
    holding = never.promise;
    const first = await start(rig);
    await until(() => rig.runs.length === 1);
    holding = Promise.resolve();
    rig.keyStore.values = { ...rig.keyStore.values, "permits-writer": "not-the-password" };
    const second = await start(rig, { ...START, request: "approval_0002", connection: SECOND.name });
    await until(async () => (await jobOf(rig, second.job)).state !== "running");
    expect(await jobOf(rig, second.job)).toMatchObject({ state: "failed", code: "login" });
    // The login is refused for both connections: it is one login of one database.
    expect(await ask(rig, "databases", "write.start", { ...START, request: "approval_0003", connection: SECOND.name })).toEqual(
      failed("write_login_refused"),
    );
    // An operator sets the first connection's same write settings again. That
    // clears the refusal, and does not stop the write that runs on it.
    expect((await act(rig, "connection.writes.set", WRITES)).ok).toBe(true);
    expect(rig.runs[0]?.signal?.aborted).toBe(false);
    expect(await jobOf(rig, first.job)).toMatchObject({ state: "running" });
    never.resolve();
    await rig.module.idle();
    expect(await jobOf(rig, first.job)).toMatchObject({ state: "done" });
  });

  test("a write that the program finished in the moment it was stopped is a write that happened", async () => {
    const { rig, job } = await running({ finishesWhenStopped: true });
    expect((await act(rig, "connection.change", { ...PERMITS, encryption: "require" })).ok).toBe(true);
    await rig.module.idle();
    expect(rig.runs[0]?.signal?.aborted).toBe(true);
    // The program printed what it wrote, and that is what the job says.
    expect(await jobOf(rig, job)).toMatchObject({ state: "done", kind: "write", batches: 2, inserted: 3, updated: 1, held: 1 });
    expect(await jobOf(rig, job)).not.toHaveProperty("code");
    const records = await writeRecords(rig);
    expect(records[records.length - 1]).toEqual(["connection.write.done", expect.objectContaining({ job, inserted: 3 })]);
  });

  test("what another module's job read is not kept once that job was stopped, though its program ended well", async () => {
    const never = deferred();
    let holding: Promise<void> = Promise.resolve();
    const { rig } = await ready({ hold: () => holding, finishesWhenStopped: true });
    holding = never.promise;
    const caller: CallingContext = { organization: { id: "not-read-for-the-own-organization", own: true }, moduleId: "stores" };
    const pull = rig.module.forModules.run(caller, PERMITS.name, { kind: "pull", store: targetOf("store_permits", "sj_0001") });
    await until(() => rig.runs.length === 1);
    expect((await act(rig, "connection.change", { ...PERMITS, encryption: "require" })).ok).toBe(true);
    expect(await pull).toEqual({ ok: false, code: "connection_changed", jobId: expect.stringMatching(/^job_/) as unknown as string });
  });

  test("the same write settings set again stop nothing", async () => {
    const { rig, job, release } = await running();
    expect((await act(rig, "connection.writes.set", WRITES)).ok).toBe(true);
    expect(rig.runs[0]?.signal?.aborted).toBe(false);
    release();
    await rig.module.idle();
    expect(await jobOf(rig, job)).toMatchObject({ state: "done" });
  });

  test("a second write on the connection waits its turn: it is refused while the first runs", async () => {
    const { rig, stores, release } = await running();
    expect(await ask(rig, "databases", "write.start", { ...START, request: "approval_0002" })).toEqual(failed("busy"));
    // It was refused before a second store job was opened.
    expect(stores.opened).toEqual(["sj_0001"]);
    release();
    await rig.module.idle();
    expect((await start(rig, { ...START, request: "approval_0002" })).storeJob).toBe("sj_0002");
  });

  test("the module stops: the write is interrupted, and after a start it reads as that", async () => {
    const { rig, job } = await running();
    await rig.module.stop?.();
    const next = await makeDatabasesRig({ restartOf: rig, stores: () => null });
    try {
      expect(await jobOf(next, job)).toMatchObject({ state: "failed", code: "interrupted", kind: "write" });
      const records = await writeRecords(next);
      expect(records.filter(([action]) => action === "connection.write.failed")).toHaveLength(1);
    } finally {
      await next.cleanup();
    }
  });
});

// ── The places ───────────────────────────────────────────────────────────────

describe("the places that jobs of half an hour may take", () => {
  const STORES_MODULE: CallingContext = { organization: { id: "not-read-for-the-own-organization", own: true }, moduleId: "stores" };

  test("with two places, one write runs and a second is refused, and a test still finds a place", async () => {
    const never = deferred();
    let holding: Promise<void> = Promise.resolve();
    const { rig, stores } = await ready({ maxRunning: 2, hold: () => holding });
    await addSecond(rig);
    holding = never.promise;
    const first = await start(rig);
    await until(() => rig.runs.length === 1);
    holding = Promise.resolve();
    // A write on another connection: the one place a long job may take is taken.
    const second = { ...START, request: "approval_0002", connection: SECOND.name };
    expect(await ask(rig, "databases", "write.start", second)).toEqual(failed("busy"));
    expect(stores.opened).toEqual(["sj_0001"]);
    // So is a job of another module.
    expect(await rig.module.forModules.run(STORES_MODULE, SECOND.name, { kind: "pull", store: targetOf("store_permits", "sj_0009") })).toEqual({
      ok: false,
      code: "busy",
    });
    // A test takes two minutes at the most, and has the other place.
    await testWhileAWriteIsHeld(rig, SECOND.name);
    never.resolve();
    await rig.module.idle();
    expect(await jobOf(rig, first.job)).toMatchObject({ state: "done" });
    // With the first write ended, the second starts.
    expect((await start(rig, second)).storeJob).toBe("sj_0002");
  });

  test("with four places, two jobs of another module and one write run, and a fourth long job is refused", async () => {
    const never = deferred();
    let holding: Promise<void> = Promise.resolve();
    const { rig, stores } = await ready({ hold: () => holding });
    await addSecond(rig);
    holding = never.promise;
    const pulls = [1, 2].map((at) =>
      rig.module.forModules.run(STORES_MODULE, PERMITS.name, { kind: "pull", store: targetOf("store_permits", `sj_pull_${at}`) }),
    );
    await until(() => rig.runs.length === 2);
    const first = await start(rig);
    await until(() => rig.runs.length === 3);
    holding = Promise.resolve();
    expect(await ask(rig, "databases", "write.start", { ...START, request: "approval_0002", connection: SECOND.name })).toEqual(
      failed("busy"),
    );
    expect(stores.opened).toEqual(["sj_0001"]);
    await testWhileAWriteIsHeld(rig, SECOND.name);
    never.resolve();
    expect(await Promise.all(pulls)).toMatchObject([{ ok: true }, { ok: true }]);
    await rig.module.idle();
    expect(await jobOf(rig, first.job)).toMatchObject({ state: "done" });
  });

  test("with one place there is nothing to keep free: a write takes it", async () => {
    const { rig } = await ready({ maxRunning: 1 });
    const { job } = await start(rig);
    await rig.module.idle();
    expect(await jobOf(rig, job)).toMatchObject({ state: "done" });
  });
});

// ── Which program wrote ──────────────────────────────────────────────────────

describe("which program wrote, and which HX Fortress started it", () => {
  const COMMIT = "0123456789abcdef0123456789abcdef01234567";
  const NAMED = { version: "2026.11.23", commit: COMMIT };

  test("the program's own name and this HX Fortress's version are in `job.read` and in the line of the write's end", async () => {
    const { rig } = await ready({ namesItself: () => NAMED, version: "1.4.2" });
    const { job } = await start(rig);
    await rig.module.idle();
    expect(await jobOf(rig, job)).toMatchObject({ state: "done", dbIo: NAMED, release: "1.4.2" });
    const records = await writeRecords(rig);
    expect(records[records.length - 1]).toEqual([
      "connection.write.done",
      expect.objectContaining({ job, dbIoVersion: "2026.11.23", dbIoCommit: COMMIT, release: "1.4.2", inserted: 3 }),
    ]);
    // The line of the start has neither: no program had run yet.
    expect(records[0]?.[1]).not.toHaveProperty("dbIoVersion");
    expect(records[0]?.[1]).not.toHaveProperty("release");
  });

  test("a write that the program failed names them too", async () => {
    const { rig, stores } = await ready({ namesItself: () => NAMED, version: "1.4.2" });
    stores.endsAs = { state: "failed", word: "preview_stale" };
    const { job } = await start(rig, { ...START, store: "store_refuses" });
    await rig.module.idle();
    expect(await jobOf(rig, job)).toMatchObject({ state: "failed", code: "store", dbIo: NAMED, release: "1.4.2" });
    const records = await writeRecords(rig);
    expect(records[records.length - 1]).toEqual([
      "connection.write.failed",
      expect.objectContaining({ job, code: "store", dbIoVersion: "2026.11.23", dbIoCommit: COMMIT, release: "1.4.2" }),
    ]);
  });

  test("a program that was never started has no name: the record holds this HX Fortress's version alone", async () => {
    const { rig } = await ready({ namesItself: () => NAMED, version: "1.4.2" });
    rig.keyStore.values = without(rig.keyStore.values, "permits-writer");
    const { job } = await start(rig);
    await rig.module.idle();
    const view = await jobOf(rig, job);
    expect(view).toMatchObject({ state: "failed", code: "secret_missing", release: "1.4.2" });
    expect(view).not.toHaveProperty("dbIo");
  });

  test.each<[string, string]>([
    ["with a plus sign, as a build's own stamp has", "1.4.2+0123abcd"],
    ["that is empty", ""],
    ["longer than a name", "1".repeat(129)],
  ])("a version of HX Fortress %s is left out, and the job is answered all the same", async (_what, version) => {
    const { rig } = await ready({ version });
    const { job } = await start(rig);
    await rig.module.idle();
    const view = await jobOf(rig, job);
    expect(view).toMatchObject({ state: "done", inserted: 3 });
    expect(view).not.toHaveProperty("release");
    const records = await writeRecords(rig);
    expect(records[records.length - 1]?.[0]).toBe("connection.write.done");
    expect(records[records.length - 1]?.[1]).not.toHaveProperty("release");
  });

  test.each<[string, unknown, unknown]>([
    ["a build that was told no commit", { version: "dev", commit: null }, { version: "dev" }],
    ["a commit that is not 40 to 64 hex characters", { version: "2026.11.23", commit: "abc123" }, { version: "2026.11.23" }],
    ["a commit in capital letters", { version: "2026.11.23", commit: COMMIT.toUpperCase() }, { version: "2026.11.23" }],
    ["a commit of 64 hex characters", { version: "2026.11.23", commit: COMMIT + COMMIT.slice(0, 24) }, { version: "2026.11.23", commit: COMMIT + COMMIT.slice(0, 24) }],
    ["a version that an answer cannot hold", { version: "1.0+local", commit: COMMIT }, undefined],
    ["a version of 65 characters", { version: "v".repeat(65), commit: COMMIT }, undefined],
    ["no version", { commit: COMMIT }, undefined],
    ["a text in place of the object", "2026.11.23", undefined],
  ])("%s: what is kept of the program's name", async (_what, says, kept) => {
    const { rig } = await ready({ namesItself: () => says });
    const { job } = await start(rig);
    await rig.module.idle();
    const view = await jobOf(rig, job);
    // The write itself is read as it is, whatever the program says of itself.
    expect(view).toMatchObject({ state: "done", inserted: 3 });
    expect(view.dbIo).toEqual(kept);
    // And a module that was told no version of this HX Fortress keeps none.
    expect(view).not.toHaveProperty("release");
  });
});

describe("in a daemon of this build", () => {
  test("no write starts: the module host starts no program, so no connection passes a test", async () => {
    rig = await makeDatabasesRig({ asInTheDaemon: true });
    await addConnection(rig);
    await testConnection(rig);
    expect((await act(rig, "connection.writes.set", WRITES)).ok).toBe(true);
    expect(await ask(rig, "databases", "write.start", START)).toEqual(failed("not_tested"));
    expect(await rig.ctx.state.read<unknown>("writes")).toBeNull();
  });
});

// ── An undo ──────────────────────────────────────────────────────────────────

describe("an undo of a write", () => {
  const COMMON = without(START, "previews", "rehearse");
  const undo = (write: string, change: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...COMMON,
    request: "approval_undo_1",
    write,
    ...change,
  });

  test("names the write by its store job, and runs with the write login", async () => {
    const { rig, stores } = await ready();
    const written = await start(rig);
    await rig.module.idle();
    const reply = await ask(rig, "databases", "write.undo", undo(written.storeJob));
    expect(reply).toMatchObject({ ok: true, payload: { storeJob: "sj_0002" } });
    await rig.module.idle();
    const { job } = (reply as { payload: Started }).payload;
    expect(await jobOf(rig, job)).toMatchObject({ kind: "undo", state: "done", storeJob: "sj_0002" });
    expect(stores.calls[3]).toEqual([
      "writeParts",
      "store_permits",
      {
        kind: "push_undo",
        connection: { id: expect.stringMatching(/\.1$/) as unknown as string, name: "Northstar permits", engine: "sqlserver" },
        write: "sj_0001",
        writer: "program:permit-sync@4",
        by: "user:person_marta",
      },
    ]);
    expect(rig.jobs[1]).toMatchObject({ kind: "push", login: { kind: "write", user: "permits_writer" }, store: targetOf("store_permits", "sj_0002") });
    // The undo's lines name the tables it takes the write back from. Its parts
    // come from the Store's record of the write, and have no checksum.
    const records = (await writeRecords(rig)).filter(([, params]) => params.job === job);
    expect(records).toEqual([
      ["connection.write", expect.objectContaining({ kind: "undo", parts: 2, approver: "person_marta" })],
      ["connection.write.part", { target: "Northstar permits", job, schema: "dbo", table: "permits", preview: "permits_preview", version: 3 }],
      ["connection.write.part", { target: "Northstar permits", job, schema: "dbo", table: "fees", preview: "fees_preview", version: 1 }],
      ["connection.write.done", expect.objectContaining({ kind: "undo", storeState: "done" })],
    ]);
  });

  test.each<[string, (stores: FakeStores) => void, string]>([
    ["a write the Store has no record of", (stores) => void stores.written.clear(), "write_not_found"],
    ["a rehearsal", (stores) => void (stores.written.get("sj_0001")!.rehearsal = true), "write_rehearsed"],
    ["a write that was undone", (stores) => void (stores.written.get("sj_0001")!.undone = true), "write_undone"],
    ["a write that went through another connection", (stores) => void (stores.written.get("sj_0001")!.connection = "c0000000000000000.1"), "write_elsewhere"],
    ["a write that still runs", (stores) => void (stores.next.writeParts = { ok: false, code: "write_not_ended" }), "write_not_ended"],
  ])("the Store's word for %s is passed on", async (_what, arrange, word) => {
    const { rig, stores } = await ready();
    const written = await start(rig);
    await rig.module.idle();
    arrange(stores);
    expect(await ask(rig, "databases", "write.undo", undo(written.storeJob))).toEqual(failed(word));
    expect(stores.opened).toEqual(["sj_0001"]);
    expect(rig.jobs).toHaveLength(1);
  });

  test("a table that was closed to writes since is not undone", async () => {
    const { rig, stores } = await ready();
    const written = await start(rig);
    await rig.module.idle();
    expect((await act(rig, "connection.writes.set", { ...WRITES, tables: [WRITES.tables[0]] })).ok).toBe(true);
    expect(await ask(rig, "databases", "write.undo", undo(written.storeJob))).toEqual(failed("table_not_listed"));
    expect(stores.opened).toEqual(["sj_0001"]);
  });

  test("after the connection named another database and was set up again, the Store tells the write is elsewhere", async () => {
    const { rig } = await ready();
    const written = await start(rig);
    await rig.module.idle();
    expect((await act(rig, "connection.change", { ...PERMITS, database: "Permits2" })).ok).toBe(true);
    expect((await act(rig, "connection.change", PERMITS)).ok).toBe(true);
    await testConnection(rig);
    expect((await act(rig, "connection.writes.set", WRITES)).ok).toBe(true);
    // The connection's id for other modules is another one now.
    expect(await ask(rig, "databases", "write.undo", undo(written.storeJob))).toEqual(failed("write_elsewhere"));
  });
});

// ── Only these two asks ──────────────────────────────────────────────────────

describe("a job gets a write login only from these two asks", () => {
  const SRC = path.join(import.meta.dir, "..", "..", "..", "src", "modules", "databases");
  // The module's own folder of this repository, and the files found in it.
  /* eslint-disable security/detect-non-literal-fs-filename */
  const sources = (): [string, string][] =>
    readdirSync(SRC)
      .filter((file) => file.endsWith(".ts"))
      .sort()
      .map((file) => [file, readFileSync(path.join(SRC, file), "utf8")]);
  /* eslint-enable security/detect-non-literal-fs-filename */

  test("one function builds a job with a write login, and one file calls it", () => {
    const builds = sources().filter(([, text]) => /kind: "write"/.test(text)).map(([file]) => file);
    expect(builds).toEqual(["data-runner.ts"]);
    const calls = sources()
      .filter(([, text]) => /\bpushJob\(/.test(text.replaceAll(/export function pushJob\(/g, "")))
      .map(([file]) => file);
    expect(calls).toEqual(["writes.ts"]);
    // And the module reaches that file through the two asks alone.
    const module = sources().find(([file]) => file === "module.ts")?.[1] ?? "";
    expect([...module.matchAll(/\bwrites\.start\(/g)]).toHaveLength(1);
    expect(module).toContain('case "write.start":\n        case "write.undo":\n          return writes.start(');
  });

  test("another module cannot have a push run", async () => {
    const { rig, stores } = await ready();
    const caller: CallingContext = { organization: { id: "not-read-for-the-own-organization", own: true }, moduleId: "stores" };
    const job = { kind: "push", store: targetOf("store_permits", "sj_0001") } as unknown as Parameters<typeof rig.module.forModules.run>[2];
    expect(await rig.module.forModules.run(caller, PERMITS.name, job)).toEqual({ ok: false, code: "job_invalid" });
    await nothingStarted(rig, stores);
  });

  test("no act of a person starts a write", async () => {
    const { rig, stores } = await ready();
    expect(await act(rig, "write.start", START)).toEqual({ ok: false, error: "act_unknown" });
    await nothingStarted(rig, stores);
  });

  test("an ask with no grant, or with a grant for other arguments, starts nothing", async () => {
    const { rig, stores } = await ready();
    expect((await ask(rig, "databases", "write.start", START, null))?.ok).toBe(false);
    const other = await rig.key.grant("databases", "write.start", { ...START, rehearse: true });
    expect((await ask(rig, "databases", "write.start", START, other))?.ok).toBe(false);
    await nothingStarted(rig, stores);
  });

  test("every other job of the program signs in with the read login", async () => {
    const { rig } = await ready();
    await testConnection(rig);
    const caller: CallingContext = { organization: { id: "not-read-for-the-own-organization", own: true }, moduleId: "stores" };
    await rig.module.forModules.run(caller, PERMITS.name, { kind: "pull", store: targetOf("store_permits", "sj_0001") });
    await rig.module.forModules.run(caller, PERMITS.name, { kind: "compare", store: targetOf("store_permits", "sj_0001") });
    expect(rig.runs.map((run) => run.secrets)).toEqual([
      { password: "permits-reader" },
      { password: "permits-reader" },
      { password: "permits-reader" },
    ]);
    expect(rig.jobs.map((job) => (job as { login: { kind: string; user: string } }).login.kind)).toEqual(["read", "read", "read"]);
  });
});

// ── The record ───────────────────────────────────────────────────────────────

describe("the module's record of writes", () => {
  test("keeps the newest ended jobs, and a request it no longer keeps starts a new job", async () => {
    const { rig } = await ready();
    const old = Array.from({ length: WRITE_JOBS_KEPT + 5 }, (_, at) => ({
      id: `job_old_${at}`,
      kind: "write",
      request: `old_${at}`,
      asked: checksumOf(String(at)),
      connectionId: "c0000000000000000",
      connection: "Northstar permits",
      store: "store_permits",
      storeJob: `sj_old_${at}`,
      state: "done",
      startedAt: rig.now.value.toISOString(),
      finishedAt: rig.now.value.toISOString(),
    }));
    await rig.ctx.state.write("writes", { v: 1, jobs: old });
    const { job } = await start(rig);
    await rig.module.idle();
    const kept = (await rig.ctx.state.read("writes")) as { jobs: { id: string }[] };
    expect(kept.jobs).toHaveLength(WRITE_JOBS_KEPT);
    expect(kept.jobs[0]?.id).toBe(job);
    expect(kept.jobs[WRITE_JOBS_KEPT - 1]?.id).toBe(`job_old_${WRITE_JOBS_KEPT - 2}`);
    // The oldest are gone, and `job.read` says so.
    expect(await ask(rig, "databases", "job.read", { job: `job_old_${WRITE_JOBS_KEPT + 4}` })).toEqual(failed("job_unknown"));
    expect(await jobOf(rig, "job_old_0")).toMatchObject({ kind: "write", state: "done" });
  });

  test("a job that runs is kept, however many jobs ended after it started", async () => {
    const never = deferred();
    let holding: Promise<void> = Promise.resolve();
    const { rig } = await ready({ hold: () => holding });
    await addSecond(rig);
    holding = never.promise;
    const first = await start(rig);
    await until(() => rig.runs.length === 1);
    // More jobs than are kept have ended since it started.
    const record = (await rig.ctx.state.read("writes")) as { v: 1; jobs: Record<string, unknown>[] };
    const ended = Array.from({ length: WRITE_JOBS_KEPT + 5 }, (_, at) => ({
      ...record.jobs[0],
      id: `job_ended_${at}`,
      request: `ended_${at}`,
      storeJob: `sj_ended_${at}`,
      state: "done",
      finishedAt: rig.now.value.toISOString(),
    }));
    await rig.ctx.state.write("writes", { v: 1, jobs: [...ended, ...record.jobs] });
    // The next write of the record: a write on the second connection.
    holding = Promise.resolve();
    const second = await start(rig, { ...START, request: "approval_0002", connection: SECOND.name });
    const kept = (await rig.ctx.state.read("writes")) as { jobs: { id: string; state: string }[] };
    expect(kept.jobs.map((job) => job.id)).toContain(first.job);
    expect(kept.jobs.map((job) => job.id)).toContain(second.job);
    expect(kept.jobs.filter((job) => job.state !== "running")).toHaveLength(WRITE_JOBS_KEPT);
    never.resolve();
    await rig.module.idle();
    expect(await jobOf(rig, first.job)).toMatchObject({ state: "done" });
  });

  test("a job the record calls running after a start of the process is written as interrupted, with its line", async () => {
    const { rig } = await ready();
    // The record as a process left it that ended while a write ran.
    const lost = {
      id: "job_lost",
      kind: "write",
      request: "approval_lost",
      asked: checksumOf("lost"),
      connectionId: "c0000000000000000",
      connection: "Northstar permits",
      store: "store_permits",
      storeJob: "sj_lost",
      state: "running",
      startedAt: rig.now.value.toISOString(),
    };
    await rig.ctx.state.write("writes", { v: 1, jobs: [lost] });
    await rig.module.stop?.();
    const next = await makeDatabasesRig({ restartOf: rig, stores: () => null });
    try {
      expect(await next.ctx.state.read<unknown>("writes")).toEqual({
        v: 1,
        jobs: [{ ...lost, state: "failed", code: "interrupted", finishedAt: next.now.value.toISOString() }],
      });
      expect(await writeRecords(next)).toEqual([
        [
          "connection.write.failed",
          { target: "Northstar permits", kind: "write", job: "job_lost", request: "approval_lost", store: "store_permits", storeJob: "sj_lost", code: "interrupted" },
        ],
      ]);
    } finally {
      await next.cleanup();
    }
  });

  test("a record that cannot be read refuses a write, and guesses nothing", async () => {
    const { rig, stores } = await ready();
    await rig.ctx.state.write("writes", { v: 2, jobs: "many" });
    expect(await ask(rig, "databases", "write.start", START)).toEqual(failed("state_unreadable"));
    await nothingStarted(rig, stores);
  });

  test("a test's job and a write's job are both read by `job.read`", async () => {
    const { rig } = await ready();
    const test = await testConnection(rig);
    const { job } = await start(rig);
    await rig.module.idle();
    expect(await jobOf(rig, test)).toMatchObject({ state: "done", step: "catalog" });
    expect(await jobOf(rig, test)).not.toHaveProperty("kind");
    expect(await jobOf(rig, job)).not.toHaveProperty("step");
    expect(await ask(rig, "databases", "job.read", { job: "job_none" })).toEqual(failed("job_unknown"));
  });
});
