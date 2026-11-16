// What a signed-in person does to an organization's connections: read them,
// add one, change one, remove one, test one. Each act goes through the module
// host's own gate: a role that may, arguments that fit the act's shape, and a
// reply that fits. The list of hosts and the list of secret names it adds to
// are the host's own too.
//
// Every change, and every test, leaves a line in the audit trail.

import { afterEach, describe, expect, test } from "bun:test";

import { manifestDefect, type ModuleActContext } from "../../../src/host/module-contract";
import { shapeDefect } from "../../../src/host/shape";
import { DATABASES_ACTS, DATABASES_ISLANDS, DATABASES_PROGRAMS } from "../../../src/modules/databases/manifest";
import { ask, spoolRecords, spoolText } from "../../host/_module-rig";
import {
  act,
  addConnection,
  BILLING,
  deferred,
  makeDatabasesRig,
  MARTA,
  PERMITS,
  RUTH,
  testConnection,
  type DatabasesRig,
} from "./_rig";
import { PERMITS_PASSWORD, ROW_VALUES } from "./standin-data-runner";

let rig: DatabasesRig | null = null;
afterEach(async () => {
  await rig?.cleanup();
  rig = null;
});

const failed = (code: string): { ok: false; error: string } => ({ ok: false, error: `failed:${code}` });

/** The hosts this module may reach for the own organization: the host's own list. */
const reaches = (of: DatabasesRig): ReturnType<DatabasesRig["ctx"]["reach"]["list"]> => of.ctx.reach.list();
/** The names of secrets a person added to this module: the host's own list. */
const secretNames = (of: DatabasesRig): ReturnType<DatabasesRig["ctx"]["secretNames"]["list"]> =>
  of.ctx.secretNames.list();

/** The module's own audit records, as `<action> <params>`. */
async function moduleRecords(of: DatabasesRig): Promise<{ action: string; params: Record<string, unknown> }[]> {
  // `ctx.audit.record` does not wait for the spool. One turn of the event loop
  // lets the appends land.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return (await spoolRecords(of.paths))
    .filter((record) => record.action.startsWith("module.databases."))
    .map((record) => ({ action: record.action, params: record.params ?? {} }));
}

describe("the acts", () => {
  test("each act's arguments and reply are shapes the host can hold a value to", () => {
    expect(DATABASES_ACTS.map((spec) => `${spec.name} (${spec.role})`)).toEqual([
      "connections.read (readonly)",
      "connection.add (operator)",
      "connection.change (operator)",
      "connection.remove (operator)",
      "connection.test (operator)",
      "job.read (readonly)",
    ]);
    for (const spec of DATABASES_ACTS) {
      expect(shapeDefect(spec.args)).toBeNull();
      expect(spec.args.kind).toBe("record");
      expect(shapeDefect(spec.reply)).toBeNull();
    }
    // An act's list has the form of an ask's list, so the same check reads it.
    expect(
      manifestDefect({
        id: "databases",
        asks: DATABASES_ACTS.map(({ name, args, reply }) => ({ name, args, reply })),
        egress: [],
        secrets: [],
      }),
    ).toBeNull();
  });

  test("the module names one program with fixed arguments, and two kinds of Secure Data Island", () => {
    expect(DATABASES_PROGRAMS).toEqual([{ id: "data-runner", args: ["run", "--job-stdin"] }]);
    expect(DATABASES_ISLANDS).toEqual([{ kind: "rows" }, { kind: "table" }]);
  });
});

describe("adding a connection", () => {
  test("an operator adds one, and reads it back with its server and the NAME of its login's secret", async () => {
    rig = await makeDatabasesRig();
    expect(await act(rig, "connection.add", PERMITS)).toEqual({
      ok: true,
      payload: { name: "Northstar permits" },
    });
    expect(await act(rig, "connections.read", {}, RUTH)).toEqual({
      ok: true,
      payload: {
        connections: [
          {
            name: "Northstar permits",
            engine: "sqlserver",
            reach: "direct",
            host: "sql01.northstar.example",
            port: 1433,
            database: "Permits",
            encryption: "verify",
            minTls: "1.2",
            user: "permits_reader",
            keyName: "permits-reader",
            state: "not_tested",
            addedAt: rig.now.value.toISOString(),
            addedBy: "marta",
          },
        ],
      },
    });
  });

  test("leaves a line with what it points at, and no secret's value anywhere", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    expect(await moduleRecords(rig)).toEqual([
      {
        action: "module.databases.connection.add",
        params: {
          target: "Northstar permits",
          engine: "sqlserver",
          host: "sql01.northstar.example",
          port: 1433,
          database: "Permits",
          encryption: "verify",
          minTls: "1.2",
          user: "permits_reader",
          keyName: "permits-reader",
          by: "marta",
        },
      },
    ]);
    // Adding a connection reads no secret.
    expect(rig.keyStore.reads).toEqual([]);
    expect(await spoolText(rig.paths)).not.toContain(PERMITS_PASSWORD);
  });

  test("adds the server to the list of hosts and the secret's name to the list of names", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    const reach = await reaches(rig);
    expect(reach).toEqual([
      {
        // Not the connection's name: its own id and a count, so that a name is
        // never used for a second address.
        name: expect.stringMatching(/^c[0-9]{16}-1$/) as unknown as string,
        host: "sql01.northstar.example",
        port: 1433,
        addedBy: "marta",
        addedAt: rig.now.value.toISOString(),
      },
    ]);
    expect(await secretNames(rig)).toEqual(["permits-reader"]);
  });

  test("a person who may only read cannot add, change, remove or test", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    for (const [name, args] of [
      ["connection.add", BILLING],
      ["connection.change", { ...PERMITS, port: 1434 }],
      ["connection.remove", { name: PERMITS.name }],
      ["connection.test", { name: PERMITS.name }],
    ] as const) {
      expect(await act(rig, name, args, RUTH)).toEqual({ ok: false, error: "not_allowed" });
    }
    // The module holds the same line itself, were a gate ever to forget it.
    // It looks at the role before it touches the context it was handed, so
    // the organization's own context stands in for an act's here.
    const handed = rig.ctx as unknown as ModuleActContext;
    await expect(rig.module.onAct("connection.add", BILLING, handed, RUTH)).rejects.toMatchObject({
      code: "not_allowed",
    });
    expect(await reaches(rig)).toMatchObject([{ host: PERMITS.host }]);
    expect(await act(rig, "connection.add", BILLING, null)).toEqual({ ok: false, error: "signed_out" });
    expect((await act(rig, "connections.read", {}, RUTH)).ok).toBe(true);
  });

  test("an act that is not on the list, or whose arguments do not fit, never reaches the module", async () => {
    rig = await makeDatabasesRig();
    expect(await act(rig, "connection.rename", { name: "a", to: "b" })).toEqual({
      ok: false,
      error: "act_unknown",
    });
    for (const bad of [
      { ...PERMITS, port: "1433" },
      { ...PERMITS, engine: "db2" },
      { ...PERMITS, password: "a value typed where a name belongs" },
      { ...PERMITS, name: "permits; DROP TABLE permits" },
      { ...PERMITS, keyName: undefined },
    ]) {
      expect(await act(rig, "connection.add", bad)).toEqual({ ok: false, error: "args_invalid" });
    }
  });

  test.each([
    [{ name: " permits" }, "name_invalid"],
    [{ name: "permits  two" }, "name_invalid"],
    [{ name: "-permits" }, "name_invalid"],
    [{ name: "p".repeat(65) }, "name_invalid"],
    [{ host: "sql01 northstar" }, "host_invalid"],
    [{ host: "sql01..example" }, "host_invalid"],
    [{ host: "-sql01.example" }, "host_invalid"],
    [{ port: 0 }, "port_invalid"],
    [{ database: " Permits" }, "database_invalid"],
    [{ user: "" }, "user_invalid"],
    [{ keyName: "Permits_Reader" }, "key_name_invalid"],
    [{ keyName: "permits reader" }, "key_name_invalid"],
    [{ serverName: "not a host" }, "server_name_invalid"],
    // Colons and dots are not an address by themselves.
    [{ serverName: ":::::" }, "server_name_invalid"],
    [{ host: "1.2:3" }, "host_invalid"],
    // An address takes no dot at its end, and no zero in front of a number.
    [{ host: "fd00::1." }, "host_invalid"],
    [{ host: "010.0.0.1" }, "host_invalid"],
    // No field holds a second address inside it.
    [{ user: "reader:x" }, "user_invalid"],
    [{ user: "reader/x" }, "user_invalid"],
    [{ database: "Permits/x" }, "database_invalid"],
    [{ database: "Permits@sql02" }, "database_invalid"],
    // TDS 8 is one engine's.
    [{ engine: "postgres", encryption: "strict" }, "encryption_not_for_engine"],
  ])("a field that breaks a rule is refused with the word for it: %j", async (change, word) => {
    rig = await makeDatabasesRig();
    expect(await act(rig, "connection.add", { ...PERMITS, ...change })).toEqual(failed(word));
    expect(await act(rig, "connections.read")).toEqual({ ok: true, payload: { connections: [] } });
  });

  test("a name is taken once, whatever its case", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    expect(await act(rig, "connection.add", { ...BILLING, name: "NORTHSTAR PERMITS" })).toEqual(
      failed("name_taken"),
    );
  });

  test("the list of hosts refuses this machine, a link-local address and a multicast one", async () => {
    rig = await makeDatabasesRig();
    for (const host of ["127.0.0.1", "localhost", "169.254.169.254", "0.0.0.0", "::1", "fe80::1", "224.0.0.1"]) {
      expect(await act(rig, "connection.add", { ...PERMITS, host })).toEqual(failed("reach_address_refused"));
    }
    // A refused host leaves nothing behind: no connection, no host, no name.
    expect(await act(rig, "connections.read")).toEqual({ ok: true, payload: { connections: [] } });
    expect(await reaches(rig)).toEqual([]);
    expect(await secretNames(rig)).toEqual([]);
    // A private address is where a database usually is.
    expect((await act(rig, "connection.add", { ...PERMITS, host: "10.20.0.14" })).ok).toBe(true);
  });

  test("an organization keeps at most 64 connections", async () => {
    rig = await makeDatabasesRig();
    for (let i = 0; i < 64; i += 1) {
      await addConnection(rig, { ...PERMITS, name: `Northstar permits ${i}`, port: 1433 + i });
    }
    expect(await act(rig, "connection.add", { ...PERMITS, name: "One too many" })).toEqual(
      failed("connections_full"),
    );
  });
});

describe("changing and removing a connection", () => {
  test("a change keeps the name, forgets the last test and its catalog, and leaves a line", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await testConnection(rig);
    expect((await ask(rig, "databases", "catalog.read", { connection: PERMITS.name, page: 0 }))?.ok).toBe(true);

    rig.now.value = new Date(rig.now.value.getTime() + 60_000);
    expect(
      await act(rig, "connection.change", { ...PERMITS, name: "northstar PERMITS", port: 1434, minTls: "1.3" }),
    ).toEqual({ ok: true, payload: { name: "Northstar permits" } });

    const read = await act(rig, "connections.read");
    expect(read).toMatchObject({
      ok: true,
      payload: {
        connections: [
          {
            name: "Northstar permits",
            port: 1434,
            minTls: "1.3",
            state: "not_tested",
            changedAt: rig.now.value.toISOString(),
            changedBy: "marta",
          },
        ],
      },
    });
    expect(JSON.stringify(read)).not.toContain('"test"');
    // What the last test read was of the server the connection named before.
    expect(await ask(rig, "databases", "catalog.read", { connection: PERMITS.name, page: 0 })).toEqual({
      ok: false,
      error: "failed:catalog_not_read",
    });
    // The old entry is gone from the list of hosts, and the new address has an
    // entry under a new name.
    expect(await reaches(rig)).toEqual([
      expect.objectContaining({
        name: expect.stringMatching(/^c[0-9]{16}-2$/) as unknown as string,
        host: "sql01.northstar.example",
        port: 1434,
      }),
    ]);
    const records = await moduleRecords(rig);
    expect(records[records.length - 1]).toMatchObject({
      action: "module.databases.connection.change",
      params: { target: "Northstar permits", port: 1434, changed: "port minTls", by: "marta" },
    });
  });

  test("a change that changes nothing leaves no line", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    expect((await act(rig, "connection.change", PERMITS)).ok).toBe(true);
    expect((await moduleRecords(rig)).map((record) => record.action)).toEqual([
      "module.databases.connection.add",
    ]);
  });

  test("a new login's secret name replaces the old one on the list, unless another connection uses it", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await addConnection(rig, { ...BILLING, keyName: "permits-reader" });
    await act(rig, "connection.change", { ...PERMITS, keyName: "permits-reader-2" });
    expect(await secretNames(rig)).toEqual([
      "permits-reader",
      "permits-reader-2",
    ]);
    await act(rig, "connection.change", { ...BILLING, keyName: "billing-reader" });
    expect(await secretNames(rig)).toEqual([
      "permits-reader-2",
      "billing-reader",
    ]);
  });

  test("a host the list refuses leaves the connection as it was", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    expect(await act(rig, "connection.change", { ...PERMITS, host: "169.254.169.254" })).toEqual(
      failed("reach_address_refused"),
    );
    expect(await act(rig, "connections.read")).toMatchObject({
      payload: { connections: [{ host: "sql01.northstar.example" }] },
    });
    expect(await reaches(rig)).toMatchObject([
      { host: "sql01.northstar.example", port: 1433 },
    ]);
    // And it can still be tested: the entry it points at is back.
    const job = await testConnection(rig);
    expect(await act(rig, "job.read", { job })).toMatchObject({ payload: { state: "done" } });
  });

  test("removing one takes its server off the list of hosts, and its catalog and its name with it", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await addConnection(rig, BILLING);
    await testConnection(rig);
    expect(await act(rig, "connection.remove", { name: PERMITS.name })).toEqual({ ok: true, payload: {} });
    expect(await act(rig, "connections.read")).toMatchObject({
      payload: { connections: [{ name: "Northstar billing" }] },
    });
    expect(await reaches(rig)).toMatchObject([{ host: BILLING.host }]);
    expect(await secretNames(rig)).toEqual(["billing-reader"]);
    expect(await ask(rig, "databases", "catalog.read", { connection: PERMITS.name, page: 0 })).toEqual({
      ok: false,
      error: "failed:connection_unknown",
    });
    const records = await moduleRecords(rig);
    expect(records[records.length - 1]).toMatchObject({
      action: "module.databases.connection.remove",
      params: { target: "Northstar permits", by: "marta" },
    });
    // The name is free again.
    expect((await act(rig, "connection.add", PERMITS)).ok).toBe(true);
  });

  test("a connection that does not exist cannot be changed, removed or tested", async () => {
    rig = await makeDatabasesRig();
    expect(await act(rig, "connection.change", PERMITS)).toEqual(failed("connection_unknown"));
    expect(await act(rig, "connection.remove", { name: PERMITS.name })).toEqual(failed("connection_unknown"));
    expect(await act(rig, "connection.test", { name: PERMITS.name })).toEqual(failed("connection_unknown"));
  });

  test("while a test runs, the connection is not changed or removed under it", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    rig = await makeDatabasesRig({ hold: () => held });
    await addConnection(rig);
    expect((await act(rig, "connection.test", { name: PERMITS.name })).ok).toBe(true);
    expect(await act(rig, "connection.change", { ...PERMITS, port: 1434 })).toEqual(failed("connection_busy"));
    expect(await act(rig, "connection.remove", { name: PERMITS.name })).toEqual(failed("connection_busy"));
    release();
    await rig.module.idle();
    expect((await act(rig, "connection.remove", { name: PERMITS.name })).ok).toBe(true);
  });
});

describe("what a failed write leaves behind", () => {
  /** What a write to a disk that is full throws. Its words hold a value, which
   *  must reach no log. */
  const diskFull = (): never => {
    throw Object.assign(new Error(`could not write ${ROW_VALUES[0]}`), { code: "ENOSPC" });
  };

  /** Make every write of one state key fail until the returned function is called. */
  function failWrites(of: DatabasesRig, key: string): () => void {
    const write = of.ctx.state.write.bind(of.ctx.state);
    of.ctx.state.write = async <T>(name: string, value: T): Promise<void> => {
      if (name === key) diskFull();
      return write(name, value);
    };
    return () => {
      of.ctx.state.write = write;
    };
  }

  test("a test whose end cannot be written does not leave its connection testing for ever", async () => {
    const held = deferred();
    rig = await makeDatabasesRig({ hold: () => held.promise });
    await addConnection(rig);
    const started = await act(rig, "connection.test", { name: PERMITS.name });
    const job = (started as { payload: { job: string } }).payload.job;
    // The disk fills while the test runs. Its end cannot be written.
    const mend = failWrites(rig, "connections");
    held.resolve();
    await rig.module.idle();
    mend();

    // The stored record still calls the job running. Nothing runs, so it is
    // shown as interrupted, to a person and to the control plane.
    expect(await act(rig, "connections.read")).toMatchObject({
      payload: { connections: [{ state: "failed", test: { job, state: "failed", code: "interrupted" } }] },
    });
    expect(await ask(rig, "databases", "job.read", { job })).toMatchObject({
      payload: { state: "failed", code: "interrupted" },
    });
    // And the connection can be tested again, changed and removed.
    const again = await act(rig, "connection.test", { name: PERMITS.name });
    expect(again).toMatchObject({ ok: true });
    expect((again as { payload: { job: string } }).payload.job).not.toBe(job);
    held.resolve();
    await rig.module.idle();
    expect((await act(rig, "connection.change", { ...PERMITS, minTls: "1.3" })).ok).toBe(true);
    expect((await act(rig, "connection.remove", { name: PERMITS.name })).ok).toBe(true);
    // The interrupted test has its line.
    expect(await moduleRecords(rig)).toContainEqual({
      action: "module.databases.connection.test.failed",
      params: { target: PERMITS.name, job, code: "interrupted" },
    });
    // The log says what failed by its kind and its number, never by its message.
    const said = rig.logs.find((record) => record.msg === "how a test ended could not be written");
    expect(said?.fields).toMatchObject({ job, code: "internal", errno: "ENOSPC" });
    expect(JSON.stringify(rig.logs)).not.toContain(ROW_VALUES[0] as string);
  });

  test("a connection that could not be saved leaves no host on the list, and its name stays free", async () => {
    rig = await makeDatabasesRig();
    const mend = failWrites(rig, "connections");
    expect(await act(rig, "connection.add", PERMITS)).toEqual({ ok: false, error: "failed:internal" });
    mend();
    expect(await reaches(rig)).toEqual([]);
    expect(await secretNames(rig)).toEqual([]);
    expect((await act(rig, "connection.add", PERMITS)).ok).toBe(true);
  });

  test("an entry that a failed write did leave on a list is taken off by the next act", async () => {
    rig = await makeDatabasesRig();
    // The connection cannot be saved, and the host and the secret's name that
    // were added for it cannot be taken off again either: both stay behind.
    const mendBook = failWrites(rig, "connections");
    rig.faults.reachRemove = diskFull;
    rig.faults.secretNameRemove = diskFull;
    expect((await act(rig, "connection.add", PERMITS)).ok).toBe(false);
    mendBook();
    rig.faults.reachRemove = undefined;
    rig.faults.secretNameRemove = undefined;
    expect(await act(rig, "connections.read")).toEqual({ ok: true, payload: { connections: [] } });
    expect(await reaches(rig)).toMatchObject([{ host: PERMITS.host }]);
    expect(await secretNames(rig)).toEqual(["permits-reader"]);
    // The next act that changes something takes both off.
    await addConnection(rig, BILLING);
    expect(await reaches(rig)).toMatchObject([{ host: BILLING.host }]);
    expect(await secretNames(rig)).toEqual(["billing-reader"]);
  });

  test("a host that cannot be taken off the list keeps its connection, which can be removed again", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    rig.faults.reachRemove = diskFull;
    expect(await act(rig, "connection.remove", { name: PERMITS.name })).toEqual({
      ok: false,
      error: "failed:internal",
    });
    rig.faults.reachRemove = undefined;
    // Nothing was removed: no host stays reachable with no connection to show for it.
    expect(await act(rig, "connections.read")).toMatchObject({ payload: { connections: [{ name: PERMITS.name }] } });
    expect((await act(rig, "connection.remove", { name: PERMITS.name })).ok).toBe(true);
    expect(await reaches(rig)).toEqual([]);
  });

  test("a change that could not be saved leaves the connection, its test and its catalog as they were", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await testConnection(rig);
    const mend = failWrites(rig, "connections");
    expect(await act(rig, "connection.change", { ...PERMITS, port: 1434 })).toEqual({
      ok: false,
      error: "failed:internal",
    });
    mend();
    expect(await act(rig, "connections.read")).toMatchObject({
      payload: { connections: [{ port: 1433, state: "ready" }] },
    });
    expect(await reaches(rig)).toMatchObject([{ port: 1433 }]);
    expect((await ask(rig, "databases", "catalog.read", { connection: PERMITS.name, page: 0 }))?.ok).toBe(true);
  });

  test("with every place on the list of secret names taken, a login's secret can still be changed", async () => {
    rig = await makeDatabasesRig();
    for (let i = 0; i < 64; i += 1) {
      await addConnection(rig, { ...PERMITS, name: `Northstar permits ${i}`, keyName: `reader-${i}` });
    }
    expect(
      await act(rig, "connection.change", { ...PERMITS, name: "Northstar permits 0", keyName: "reader-new" }),
    ).toMatchObject({ ok: true });
    const names = await secretNames(rig);
    expect(names).toHaveLength(64);
    expect(names).toContain("reader-new");
    expect(names).not.toContain("reader-0");
  });
});

describe("testing a connection", () => {
  test("a person's test leaves two lines: that it started, and how it ended", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    const job = await testConnection(rig);
    expect((await moduleRecords(rig)).slice(1)).toEqual([
      {
        action: "module.databases.connection.test",
        params: { target: "Northstar permits", job, origin: "person", by: "marta" },
      },
      {
        action: "module.databases.connection.tested",
        params: { target: "Northstar permits", job, tables: 4, columns: 14, canWrite: false },
      },
    ]);
  });

  test("the person sees what the test found, and the control plane sees less", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig, BILLING);
    const job = await testConnection(rig, BILLING.name);
    expect(await act(rig, "connections.read")).toMatchObject({
      ok: true,
      payload: {
        connections: [
          {
            name: "Northstar billing",
            state: "ready",
            test: {
              job,
              state: "done",
              step: "catalog",
              origin: "person",
              by: "marta",
              // The server's certificate is one it made itself, and the
              // connection asks for encryption without a check of it.
              encryption: "not_verified",
              // This login can change rows in two tables: it is not a login
              // that can only read.
              canWrite: true,
              writableTables: 2,
              tables: 1,
              columns: 4,
              leftOutTables: 0,
              leftOutColumns: 0,
              truncated: false,
            },
          },
        ],
      },
    });
    expect(await act(rig, "job.read", { job }, RUTH)).toMatchObject({
      ok: true,
      payload: { connection: "Northstar billing", state: "done", canWrite: true },
    });
    expect(await ask(rig, "databases", "connections.list")).toEqual({
      ok: true,
      payload: {
        connections: [
          {
            name: "Northstar billing",
            engine: "postgres",
            reach: "direct",
            state: "ready",
            testedAt: rig.now.value.toISOString(),
            canWrite: true,
          },
        ],
      },
    });
  });

  test.each([
    [{ host: "sql09.northstar.example" }, "unreachable", "reach"],
    [{ ...BILLING, name: PERMITS.name, encryption: "verify" }, "tls", "encryption"],
    [{ user: "somebody_else" }, "login", "sign_in"],
    [{ database: "Licences" }, "database", "catalog"],
    [{ keyName: "not-in-the-key-store" }, "secret_missing", "start"],
  ])("a test that fails says where and why, as two words: %j", async (change, code, step) => {
    rig = await makeDatabasesRig();
    await addConnection(rig, { ...PERMITS, ...change });
    const job = await testConnection(rig);
    expect(await act(rig, "job.read", { job })).toMatchObject({
      ok: true,
      payload: { state: "failed", code, step },
    });
    // A failed test's line is named as one, so that a reader of the audit
    // trail does not take it for a test that passed.
    const records = await moduleRecords(rig);
    expect(records[records.length - 1]).toEqual({
      action: "module.databases.connection.test.failed",
      params: { target: "Northstar permits", job, code },
    });
  });

  test("a person may test again at once", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    const first = await testConnection(rig);
    const second = await testConnection(rig);
    expect(second).not.toBe(first);
    expect(rig.jobs).toHaveLength(2);
  });

  test("a connection keeps its last test however many tests of other connections follow", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await addConnection(rig, BILLING);
    const first = await testConnection(rig, PERMITS.name);
    for (let i = 0; i < 105; i += 1) await testConnection(rig, BILLING.name);
    expect(await act(rig, "connections.read")).toMatchObject({
      payload: { connections: [{ name: PERMITS.name, state: "ready", test: { job: first, tables: 4 } }, {}] },
    });
    expect(await act(rig, "job.read", { job: first })).toMatchObject({ ok: true, payload: { state: "done" } });
    // The oldest of the other connection's tests are no longer kept: its newest,
    // the 100 before it, and the one test of the first connection are.
    const book = await rig.ctx.state.read<{ jobs: { id: string }[] }>("connections");
    expect(book?.jobs).toHaveLength(102);
  });

  test("a test that was running when HX Fortress stopped is said to be interrupted when it starts again", async () => {
    const never = new Promise<void>(() => {});
    rig = await makeDatabasesRig({ hold: () => never });
    await addConnection(rig);
    const started = await act(rig, "connection.test", { name: PERMITS.name });
    const job = (started as { payload: { job: string } }).payload.job;
    // The process ends here, with the test under way: nothing of the module's
    // own is called. A new daemon starts over the same folder.
    const next = await makeDatabasesRig({ restartOf: rig });
    try {
      expect(await act(next, "job.read", { job })).toMatchObject({
        ok: true,
        payload: { state: "failed", code: "interrupted" },
      });
      expect(await act(next, "connections.read")).toMatchObject({
        payload: { connections: [{ state: "failed" }] },
      });
      // The two daemons write to two files of the spool, so the line is looked
      // for, not expected to be the last.
      expect(await moduleRecords(next)).toContainEqual({
        action: "module.databases.connection.test.failed",
        params: { target: "Northstar permits", job, code: "interrupted" },
      });
    } finally {
      await next.module.stop?.();
      await next.host.stop();
    }
  });

  test("a test that was still starting when the module stopped does not start after it", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    // The start waits for the record of the connections.
    const gate = deferred();
    const read = rig.ctx.state.read.bind(rig.ctx.state);
    rig.ctx.state.read = async <T>(key: string): Promise<T | null> => {
      if (key === "connections") await gate.promise;
      return read<T>(key);
    };
    const starting = act(rig, "connection.test", { name: PERMITS.name });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The module is stopped. Nothing runs yet, so there is nothing to end.
    await rig.module.stop?.();
    rig.ctx.state.read = read;
    gate.resolve();
    expect(await starting).toEqual({ ok: false, error: "failed:busy" });
    expect(rig.runs).toEqual([]);
    expect((await rig.ctx.state.read<{ jobs: unknown[] }>("connections"))?.jobs).toEqual([]);
  });
});

describe("a connection's name holds no address with a login", () => {
  test("a pasted connection string is refused as a name, and a plain name with the same marks is taken", async () => {
    const rig = await makeDatabasesRig();
    try {
      // A name with a scheme and a login in it never reaches the module: the
      // module host's gate turns it away, as a text that reads as a
      // credential. The two with no scheme pass the gate, and the module
      // refuses them. The module refuses all three when it is asked itself.
      const handed = rig.ctx as unknown as ModuleActContext;
      for (const [name, word] of [
        ["postgres://permits_reader:made-up@sql01.northstar.example/Permits", "args_invalid"],
        ["permits_reader:made-up@sql01.northstar.example:1433", "failed:name_holds_login"],
        ["permits_reader/made-up@sql01.northstar.example", "failed:name_holds_login"],
      ] as const) {
        expect([name, await act(rig, "connection.add", { ...PERMITS, name })]).toEqual([
          name,
          { ok: false, error: word },
        ]);
        await expect(rig.module.onAct("connection.add", { ...PERMITS, name }, handed, MARTA)).rejects.toMatchObject({
          code: "name_holds_login",
        });
      }
      // Nothing of a refused name was kept or recorded.
      expect(await act(rig, "connections.read")).toMatchObject({ ok: true, payload: { connections: [] } });
      for (const name of ["permits@sql01", "sql01:1433/Permits"]) {
        expect([name, (await act(rig, "connection.add", { ...PERMITS, name })).ok]).toEqual([name, true]);
        expect((await act(rig, "connection.remove", { name })).ok).toBe(true);
      }
    } finally {
      await rig.cleanup();
    }
  });
});
