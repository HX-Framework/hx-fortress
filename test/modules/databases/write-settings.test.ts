// A connection's write settings: its write login, and the tables a write may
// reach.
//
// A connection has one login that reads. Before anything can write through
// it, an operator names a second login for it: a user, and the name of the
// secret that holds its password in the organization's key store. Beside it
// stand the tables a write may reach. Both are set with an act of their own,
// apart from the connection's fields.
//
// These tests hold what an operator can set, what is kept and shown, what the
// host's list of secret names holds afterwards, what the audit trail says,
// and that the limits fit the host's. Nothing here starts a job with a write
// login: no job signs in with one yet.

import { afterEach, describe, expect, test } from "bun:test";

import { MODULE_STATE_MAX_BYTES } from "../../../src/host/module-context";
import {
  CONNECTION_NAME_MAX_CHARS,
  CONNECTIONS_MAX,
  WRITE_TABLES_MAX,
  WRITE_TABLES_MAX_IN_ALL,
} from "../../../src/modules/databases/manifest";
import type { CallingContext, ModuleJob } from "../../../src/modules/databases/for-modules";
import type { Person } from "../../../src/modules/databases/host-ports";
import { ask, spoolRecords, spoolText } from "../../host/_module-rig";
import {
  act,
  addConnection,
  BILLING,
  deferred,
  makeDatabasesRig,
  PERMITS,
  RUTH,
  testConnection,
  type DatabasesRig,
} from "./_rig";
import { BILLING_PASSWORD, PERMITS_PASSWORD } from "./standin-data-runner";

let rig: DatabasesRig | null = null;
afterEach(async () => {
  await rig?.cleanup();
  rig = null;
});

const failed = (code: string): { ok: false; error: string } => ({ ok: false, error: `failed:${code}` });

/** A second operator of the made-up company. */
const OMAR: Person = { login: "omar", email: "omar.haddad@northstar.example", role: "operator" };

/** A pull that another module has run, as the Stores module would. */
const STORES: CallingContext = { organization: { id: "not-read-for-the-own-organization", own: true }, moduleId: "stores" };
const PULL: ModuleJob = {
  kind: "pull",
  store: { gatewayUrl: "http://127.0.0.1:8791/v1", storeId: "store_permits", jobId: "sj_0001", key: "a-store-job-key-that-is-kept-nowhere" },
};

/** The names of secrets a person added to this module: the host's own list,
 *  sorted, because the order of that list is the host's own business. */
const secretNames = async (of: DatabasesRig): Promise<string[]> => [...(await of.ctx.secretNames.list())].sort();

/** The module's own audit records, as `<action> <params>`. */
async function moduleRecords(of: DatabasesRig): Promise<{ action: string; params: Record<string, unknown> }[]> {
  // `ctx.audit.record` does not wait for the spool. One turn of the event loop
  // lets the appends land.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return (await spoolRecords(of.paths))
    .filter((record) => record.action.startsWith("module.databases."))
    .map((record) => ({ action: record.action, params: record.params ?? {} }));
}

/** The records about write settings and their tables, as `[what, ...values]`. */
async function writesRecords(of: DatabasesRig): Promise<unknown[][]> {
  const lines: unknown[][] = [];
  for (const { action, params } of await moduleRecords(of)) {
    const what = action.slice("module.databases.connection.".length);
    if (what === "writes.set") lines.push(["set", params.user, params.keyName, params.tables]);
    if (what === "writes.remove") lines.push(params.why === undefined ? ["remove"] : ["remove", params.why]);
    if (what === "writes.table.add") lines.push(["open", params.schema, params.table]);
    if (what === "writes.table.remove") lines.push(["close", params.schema, params.table]);
  }
  return lines;
}

/** One connection as a signed-in person reads it. */
async function connectionOf(of: DatabasesRig, name: string = PERMITS.name): Promise<Record<string, unknown>> {
  const reply = await act(of, "connections.read");
  if (!reply.ok) throw new Error(`the connections were not read: ${reply.error}`);
  const found = (reply.payload as { connections: Record<string, unknown>[] }).connections.find(
    (connection) => connection.name === name,
  );
  if (!found) throw new Error(`no connection is named ${name}`);
  return found;
}

/** One connection's write settings with its tables, as a signed-in person
 *  reads them, or undefined for a connection that has none. */
async function writesOf(of: DatabasesRig, name: string = PERMITS.name): Promise<unknown> {
  const reply = await act(of, "connection.writes.read", { name });
  if (!reply.ok) throw new Error(`the write settings were not read: ${reply.error}`);
  return (reply.payload as { writes?: unknown }).writes;
}

/** A login that writes two tables of the permits database. The tables are not
 *  in their sorted order, as a person may type them. */
const WRITES = {
  name: PERMITS.name,
  user: "permits_writer",
  keyName: "permits-writer",
  tables: [
    { schema: "dbo", name: "permits" },
    { schema: "dbo", name: "fees" },
  ],
};
const SORTED = [
  { schema: "dbo", name: "fees" },
  { schema: "dbo", name: "permits" },
];

/** Set write settings and expect them to be taken. */
async function setWrites(of: DatabasesRig, settings: Record<string, unknown> = WRITES): Promise<void> {
  const reply = await act(of, "connection.writes.set", settings);
  if (!reply.ok) throw new Error(`the write settings were not taken: ${reply.error}`);
}

/** `count` tables of one schema, named so that their sorted order is their order here. */
const manyTables = (count: number): { schema: string; name: string }[] =>
  Array.from({ length: count }, (_, at) => ({ schema: "dbo", name: `table_${String(at).padStart(3, "0")}` }));

describe("a connection's write settings", () => {
  test("a connection that was only added has none", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    expect(await connectionOf(rig)).not.toHaveProperty("writes");
    expect(await secretNames(rig)).toEqual(["permits-reader"]);
  });

  test("an operator sets a write login with its tables, and reads them back in one order", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    expect(await act(rig, "connection.writes.set", WRITES)).toEqual({ ok: true, payload: { name: PERMITS.name } });
    // The list of connections says who writes and how many tables. One
    // connection's own answer names them.
    expect(await connectionOf(rig)).toMatchObject({
      user: "permits_reader",
      keyName: "permits-reader",
      writes: { user: "permits_writer", keyName: "permits-writer", tables: 2 },
    });
    expect(await act(rig, "connection.writes.read", { name: PERMITS.name })).toEqual({
      ok: true,
      payload: { name: PERMITS.name, writes: { user: "permits_writer", keyName: "permits-writer", tables: SORTED } },
    });
  });

  test("a person who may only read reads them, and a connection with none answers its name alone", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    expect(await act(rig, "connection.writes.read", { name: "northstar PERMITS" }, RUTH)).toEqual({
      ok: true,
      payload: { name: PERMITS.name },
    });
    await setWrites(rig);
    expect(await act(rig, "connection.writes.read", { name: PERMITS.name }, RUTH)).toEqual({
      ok: true,
      payload: { name: PERMITS.name, writes: { user: "permits_writer", keyName: "permits-writer", tables: SORTED } },
    });
    expect(await act(rig, "connection.writes.read", { name: BILLING.name }, RUTH)).toEqual(failed("connection_unknown"));
  });

  test("the connection is named as it was added, whatever case the act names it in", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    expect(await act(rig, "connection.writes.set", { ...WRITES, name: "NORTHSTAR PERMITS" })).toEqual({
      ok: true,
      payload: { name: "Northstar permits" },
    });
  });

  test("a write login with no table is kept", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await setWrites(rig, { name: WRITES.name, user: WRITES.user, keyName: WRITES.keyName });
    expect(await writesOf(rig)).toEqual({ user: "permits_writer", keyName: "permits-writer", tables: [] });
    expect((await connectionOf(rig)).writes).toEqual({ user: "permits_writer", keyName: "permits-writer", tables: 0 });
  });

  test("both secrets' names are on the host's list, and no secret is read", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await setWrites(rig);
    expect(await secretNames(rig)).toEqual(["permits-reader", "permits-writer"]);
    // Neither through the module's own context nor by the program's launcher.
    expect(rig.secrets.reads).toEqual([]);
    expect(rig.keyStore.reads).toEqual([]);
    const text = await spoolText(rig.paths);
    expect(text).not.toContain(PERMITS_PASSWORD);
    expect(text).not.toContain(BILLING_PASSWORD);
  });

  test("setting them again replaces them whole", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await setWrites(rig);
    await setWrites(rig, { name: PERMITS.name, user: "permits_loader", keyName: "permits-loader" });
    expect(await writesOf(rig)).toEqual({ user: "permits_loader", keyName: "permits-loader", tables: [] });
    expect(await secretNames(rig)).toEqual(["permits-loader", "permits-reader"]);
  });

  test("an operator takes them away, and the write login's name leaves the list", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await setWrites(rig);
    expect(await act(rig, "connection.writes.remove", { name: PERMITS.name })).toEqual({
      ok: true,
      payload: { name: PERMITS.name },
    });
    expect(await connectionOf(rig)).not.toHaveProperty("writes");
    expect(await writesOf(rig)).toBeUndefined();
    expect(await secretNames(rig)).toEqual(["permits-reader"]);
    // Taking away what is not there is no failure, and no change.
    expect((await act(rig, "connection.writes.remove", { name: PERMITS.name })).ok).toBe(true);
  });

  test("a person who may only read can set and remove nothing", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    expect(await act(rig, "connection.writes.set", WRITES, RUTH)).toEqual({ ok: false, error: "not_allowed" });
    await setWrites(rig);
    expect(await act(rig, "connection.writes.remove", { name: PERMITS.name }, RUTH)).toEqual({
      ok: false,
      error: "not_allowed",
    });
    expect((await connectionOf(rig)).writes).toMatchObject({ user: "permits_writer" });
  });

  test("a connection that does not exist takes none", async () => {
    rig = await makeDatabasesRig();
    expect(await act(rig, "connection.writes.set", WRITES)).toEqual(failed("connection_unknown"));
    expect(await act(rig, "connection.writes.remove", { name: PERMITS.name })).toEqual(failed("connection_unknown"));
    expect(await secretNames(rig)).toEqual([]);
  });

  test.each([
    ["the read login's own user", { user: "permits_reader" }, "write_user_is_read_user"],
    ["the read login's user in another case", { user: "PERMITS_Reader" }, "write_user_is_read_user"],
    ["a user with a colon", { user: "a:b" }, "write_user_invalid"],
    ["a user with a slash", { user: "a/b" }, "write_user_invalid"],
    ["a user with a space in front", { user: " permits_writer" }, "write_user_invalid"],
    ["an empty user", { user: "" }, "write_user_invalid"],
    ["a name no key store takes", { keyName: "permits/writer" }, "write_key_name_invalid"],
    ["an empty secret's name", { keyName: "" }, "write_key_name_invalid"],
    ["a table that is there twice", { tables: [SORTED[0], SORTED[0]] }, "write_tables_invalid"],
    ["a table with no name", { tables: [{ schema: "dbo", name: "" }] }, "write_tables_invalid"],
    ["a table with no schema", { tables: [{ schema: "", name: "permits" }] }, "write_tables_invalid"],
    ["a table's name with a space in front", { tables: [{ schema: "dbo", name: " permits" }] }, "write_tables_invalid"],
    ["a table's name with two spaces in a row", { tables: [{ schema: "dbo", name: "building  permits" }] }, "write_tables_invalid"],
  ])("refuses %s, and keeps what stood before", async (_what, fields, word) => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await setWrites(rig);
    expect(await act(rig, "connection.writes.set", { ...WRITES, ...fields })).toEqual(failed(word));
    expect(await writesOf(rig)).toEqual({ user: "permits_writer", keyName: "permits-writer", tables: SORTED });
    expect(await secretNames(rig)).toEqual(["permits-reader", "permits-writer"]);
  });

  test("the host's gate turns away settings that do not fit the act's shape", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    const invalid = { ok: false as const, error: "args_invalid" };
    // Half a login is none.
    expect(await act(rig, "connection.writes.set", { name: PERMITS.name, user: "permits_writer" })).toEqual(invalid);
    expect(await act(rig, "connection.writes.set", { name: PERMITS.name, keyName: "permits-writer" })).toEqual(invalid);
    // One table more than a connection may name.
    expect(await act(rig, "connection.writes.set", { ...WRITES, tables: manyTables(WRITE_TABLES_MAX + 1) })).toEqual(invalid);
    // An entry that is more than a schema and a name is no table.
    expect(
      await act(rig, "connection.writes.set", { ...WRITES, tables: [{ schema: "dbo", name: "permits", owner: "dbo" }] }),
    ).toEqual(invalid);
    expect(await connectionOf(rig)).not.toHaveProperty("writes");
  });

  test("takes as many tables as the limit says", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    const tables = manyTables(WRITE_TABLES_MAX);
    await setWrites(rig, { ...WRITES, tables });
    expect((await connectionOf(rig)).writes).toMatchObject({ tables: WRITE_TABLES_MAX });
    expect(await writesOf(rig)).toMatchObject({ tables });
  });

  test("names that differ only by case are two tables, and a dot inside a name is part of the name", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    const tables = [
      { schema: "dbo", name: "Permits" },
      { schema: "dbo", name: "permits" },
      { schema: "dbo", name: "permits.archive" },
    ];
    await setWrites(rig, { ...WRITES, tables });
    expect(await writesOf(rig)).toMatchObject({ tables });
  });
});

describe("write settings and the connection's own fields", () => {
  test("setting them keeps the connection's last test", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    const job = await testConnection(rig);
    await setWrites(rig);
    expect(await connectionOf(rig)).toMatchObject({ state: "ready", test: { job, state: "done" } });
    expect((await act(rig, "connection.writes.remove", { name: PERMITS.name })).ok).toBe(true);
    expect(await connectionOf(rig)).toMatchObject({ state: "ready", test: { job, state: "done" } });
  });

  test("a change that names the same database keeps them, and forgets the test as before", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await testConnection(rig);
    await setWrites(rig);
    // Another read login, another way to encrypt, and the server's name in
    // another case: the database is the one it was.
    const changed = { ...PERMITS, host: "SQL01.northstar.example", encryption: "require", user: "permits_reader_2" };
    expect((await act(rig, "connection.change", changed)).ok).toBe(true);
    expect(await connectionOf(rig)).toMatchObject({
      host: "SQL01.northstar.example",
      user: "permits_reader_2",
      state: "not_tested",
      writes: { user: "permits_writer", keyName: "permits-writer", tables: 2 },
    });
    expect(await writesOf(rig)).toEqual({ user: "permits_writer", keyName: "permits-writer", tables: SORTED });
    expect(await secretNames(rig)).toEqual(["permits-reader", "permits-writer"]);
  });

  test.each([
    ["another engine", { engine: "postgres" }],
    ["another server", { host: "sql02.northstar.example" }],
    ["another port", { port: 1434 }],
    ["another database", { database: "Permits2" }],
    ["a database whose name differs only by case", { database: "permits" }],
  ])("a change to %s takes them away, and the trail says so", async (_what, fields) => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await addConnection(rig, BILLING);
    await setWrites(rig);
    // Another operator makes the change than the one who set them.
    expect((await act(rig, "connection.change", { ...PERMITS, ...fields }, OMAR)).ok).toBe(true);
    // The tables an operator opened to writes were tables of the database the
    // connection named before.
    expect(await connectionOf(rig)).not.toHaveProperty("writes");
    expect(await writesOf(rig)).toBeUndefined();
    expect(await secretNames(rig)).toEqual(["billing-reader", "permits-reader"]);
    expect(await writesRecords(rig)).toEqual([
      ["set", "permits_writer", "permits-writer", 2],
      ["open", "dbo", "fees"],
      ["open", "dbo", "permits"],
      ["remove", "connection_changed"],
      ["close", "dbo", "fees"],
      ["close", "dbo", "permits"],
    ]);
    // Each line names the connection that changed and the person who changed
    // it, and they follow the line of the change itself.
    const lines = (await moduleRecords(rig)).filter((record) => !record.action.endsWith(".connection.add"));
    expect(lines.slice(3).map((record) => [record.action.slice("module.databases.".length), record.params])).toEqual([
      ["connection.change", expect.objectContaining({ target: "Northstar permits", by: "omar" })],
      ["connection.writes.remove", { target: "Northstar permits", why: "connection_changed", by: "omar" }],
      ["connection.writes.table.remove", { target: "Northstar permits", schema: "dbo", table: "fees", by: "omar" }],
      ["connection.writes.table.remove", { target: "Northstar permits", schema: "dbo", table: "permits", by: "omar" }],
    ]);
  });

  test("a change to another database keeps on the list a write login's name that another connection uses", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await addConnection(rig, BILLING);
    await setWrites(rig);
    await setWrites(rig, { name: BILLING.name, user: "billing_writer", keyName: "permits-writer" });
    expect((await act(rig, "connection.change", { ...PERMITS, database: "Permits2" })).ok).toBe(true);
    expect(await secretNames(rig)).toEqual(["billing-reader", "permits-reader", "permits-writer"]);
    expect(await writesOf(rig, BILLING.name)).toMatchObject({ user: "billing_writer" });
  });

  test("a change to another database that cannot be saved keeps the write settings and both names", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await setWrites(rig);
    const write = rig.ctx.state.write.bind(rig.ctx.state);
    rig.ctx.state.write = async <T>(key: string, value: T): Promise<void> => {
      if (key === "connections") throw Object.assign(new Error("the disk is full"), { code: "ENOSPC" });
      return write(key, value);
    };
    expect(await act(rig, "connection.change", { ...PERMITS, database: "Permits2" })).toEqual(failed("internal"));
    rig.ctx.state.write = write;
    expect(await connectionOf(rig)).toMatchObject({ database: "Permits", writes: { tables: 2 } });
    expect(await secretNames(rig)).toEqual(["permits-reader", "permits-writer"]);
    expect((await writesRecords(rig)).map((line) => line[0])).toEqual(["set", "open", "open"]);
  });

  test("a change that is refused for the write login's name changes no list and stops no job", async () => {
    const never = deferred();
    let holding: Promise<void> = Promise.resolve();
    rig = await makeDatabasesRig({ hold: () => holding });
    await addConnection(rig);
    await testConnection(rig);
    await setWrites(rig);
    rig.runs.length = 0;
    // A pull of another module runs on the connection.
    holding = never.promise;
    const pull = rig.module.forModules.run(STORES, PERMITS.name, PULL);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rig.runs).toHaveLength(1);
    // The change names the write login's user, and a new secret for the read login.
    const change = { ...PERMITS, user: "permits_writer", keyName: "permits-reader-2" };
    expect(await act(rig, "connection.change", change)).toEqual(failed("user_is_write_user"));
    expect(await secretNames(rig)).toEqual(["permits-reader", "permits-writer"]);
    expect(rig.runs[0]?.signal?.aborted).toBe(false);
    holding = Promise.resolve();
    never.resolve();
    expect(await pull).toMatchObject({ ok: true, kind: "pull" });
  });

  test("the read login cannot become the write login", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    const job = await testConnection(rig);
    await setWrites(rig);
    expect(await act(rig, "connection.change", { ...PERMITS, user: "permits_writer" })).toEqual(
      failed("user_is_write_user"),
    );
    // Nor in another case: SQL Server and Oracle read such names as one login.
    expect(await act(rig, "connection.change", { ...PERMITS, user: "Permits_Writer" })).toEqual(
      failed("user_is_write_user"),
    );
    // Nothing changed: the connection, its test and its write settings stand.
    expect(await connectionOf(rig)).toMatchObject({
      user: "permits_reader",
      state: "ready",
      test: { job },
      writes: { user: "permits_writer" },
    });
    // With the write settings gone, the name is a user name like any other:
    // here the same change also names another database, which takes them away.
    expect((await act(rig, "connection.change", { ...PERMITS, user: "permits_writer", database: "Permits2" })).ok).toBe(true);
    expect(await connectionOf(rig)).toMatchObject({ user: "permits_writer", database: "Permits2" });
    expect(await connectionOf(rig)).not.toHaveProperty("writes");
  });

  test("the module's own asks say nothing of them", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await setWrites(rig);
    const answer = await ask(rig, "databases", "connections.list", {});
    expect(answer?.ok).toBe(true);
    const text = JSON.stringify(answer);
    expect(text).toContain("Northstar permits");
    expect(text).not.toContain("permits_writer");
    expect(text).not.toContain("permits-writer");
    expect(text).not.toContain("fees");
  });
});

describe("the host's list of secret names, with two logins", () => {
  test("a new write login's name replaces the old one, unless another connection uses it", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await addConnection(rig, BILLING);
    await setWrites(rig);
    await setWrites(rig, { name: BILLING.name, user: "billing_writer", keyName: "permits-writer" });
    expect(await secretNames(rig)).toEqual(["billing-reader", "permits-reader", "permits-writer"]);

    // The billing connection still uses the old name, so it stays.
    await setWrites(rig, { ...WRITES, keyName: "permits-writer-2" });
    expect(await secretNames(rig)).toEqual(["billing-reader", "permits-reader", "permits-writer", "permits-writer-2"]);

    // Now nothing uses it.
    expect((await act(rig, "connection.writes.remove", { name: BILLING.name })).ok).toBe(true);
    expect(await secretNames(rig)).toEqual(["billing-reader", "permits-reader", "permits-writer-2"]);
  });

  test("two logins kept under one name are one entry, which stays while either uses it", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await setWrites(rig, { ...WRITES, keyName: "permits-reader" });
    expect(await secretNames(rig)).toEqual(["permits-reader"]);
    // The read login moves to another name. The write login still uses the first.
    expect((await act(rig, "connection.change", { ...PERMITS, keyName: "permits-reader-2" })).ok).toBe(true);
    expect(await secretNames(rig)).toEqual(["permits-reader", "permits-reader-2"]);
    // The read login moves back, and the second name is free again.
    expect((await act(rig, "connection.change", PERMITS)).ok).toBe(true);
    expect(await secretNames(rig)).toEqual(["permits-reader"]);
    // The write login is taken away, and the name stays: the read login uses it.
    expect((await act(rig, "connection.writes.remove", { name: PERMITS.name })).ok).toBe(true);
    expect(await secretNames(rig)).toEqual(["permits-reader"]);
  });

  test("the read login's new name can be the write login's", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await setWrites(rig);
    expect((await act(rig, "connection.change", { ...PERMITS, keyName: "permits-writer" })).ok).toBe(true);
    expect(await secretNames(rig)).toEqual(["permits-writer"]);
  });

  test("removing the connection takes both names off the list, and leaves a name another connection uses", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await addConnection(rig, BILLING);
    await setWrites(rig);
    await setWrites(rig, { name: BILLING.name, user: "billing_writer", keyName: "permits-writer" });
    expect((await act(rig, "connection.remove", { name: PERMITS.name })).ok).toBe(true);
    expect(await secretNames(rig)).toEqual(["billing-reader", "permits-writer"]);
    expect((await act(rig, "connection.remove", { name: BILLING.name })).ok).toBe(true);
    expect(await secretNames(rig)).toEqual([]);
  });

  test("a name the list does not take leaves the settings and the list as they were", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await setWrites(rig);
    // The list gives up the old name, then does not take the new one. The
    // module then puts the old name back, and that add is taken.
    let adds = 0;
    rig.faults.secretNameAdd = (): void => {
      adds += 1;
      if (adds === 1) throw Object.assign(new Error("the disk is full"), { code: "ENOSPC" });
    };
    expect(await act(rig, "connection.writes.set", { ...WRITES, keyName: "permits-writer-2" })).toEqual(failed("internal"));
    rig.faults.secretNameAdd = undefined;
    expect(adds).toBe(2);
    expect((await connectionOf(rig)).writes).toMatchObject({ keyName: "permits-writer" });
    expect(await secretNames(rig)).toEqual(["permits-reader", "permits-writer"]);
  });

  test("settings that could not be saved leave the connection and the list as they were", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await setWrites(rig);
    // The module's own record of its connections takes no write.
    const write = rig.ctx.state.write.bind(rig.ctx.state);
    rig.ctx.state.write = async <T>(key: string, value: T): Promise<void> => {
      if (key === "connections") throw Object.assign(new Error("the disk is full"), { code: "ENOSPC" });
      return write(key, value);
    };
    expect(await act(rig, "connection.writes.set", { ...WRITES, keyName: "permits-writer-2" })).toEqual(failed("internal"));
    expect(await act(rig, "connection.writes.remove", { name: PERMITS.name })).toEqual(failed("internal"));
    rig.ctx.state.write = write;
    expect(await writesOf(rig)).toEqual({ user: "permits_writer", keyName: "permits-writer", tables: SORTED });
    // The new name is off the list again, and the old one is back on it.
    expect(await secretNames(rig)).toEqual(["permits-reader", "permits-writer"]);
    expect(await writesRecords(rig)).toEqual([
      ["set", "permits_writer", "permits-writer", 2],
      ["open", "dbo", "fees"],
      ["open", "dbo", "permits"],
    ]);
  });

  test("a first write login whose name the list does not take leaves the connection with none", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    rig.faults.secretNameAdd = (): never => {
      throw Object.assign(new Error("the disk is full"), { code: "ENOSPC" });
    };
    expect(await act(rig, "connection.writes.set", WRITES)).toEqual(failed("internal"));
    rig.faults.secretNameAdd = undefined;
    expect(await connectionOf(rig)).not.toHaveProperty("writes");
    expect(await secretNames(rig)).toEqual(["permits-reader"]);
    expect(await writesRecords(rig)).toEqual([]);
  });
});

describe("the audit trail of write settings", () => {
  test("one line names the login and counts the tables, and each table has a line of its own", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await setWrites(rig);
    const records = (await moduleRecords(rig)).filter((record) => record.action.includes(".connection.writes."));
    expect(records).toEqual([
      {
        action: "module.databases.connection.writes.set",
        params: { target: "Northstar permits", user: "permits_writer", keyName: "permits-writer", tables: 2, by: "marta" },
      },
      {
        action: "module.databases.connection.writes.table.add",
        params: { target: "Northstar permits", schema: "dbo", table: "fees", by: "marta" },
      },
      {
        action: "module.databases.connection.writes.table.add",
        params: { target: "Northstar permits", schema: "dbo", table: "permits", by: "marta" },
      },
    ]);
  });

  test("a change leaves a line for each table it opened and each it closed, and none for a table that stayed", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await setWrites(rig);
    await setWrites(rig, {
      ...WRITES,
      tables: [
        { schema: "dbo", name: "permits" },
        { schema: "dbo", name: "inspections" },
      ],
    });
    expect(await writesRecords(rig)).toEqual([
      ["set", "permits_writer", "permits-writer", 2],
      ["open", "dbo", "fees"],
      ["open", "dbo", "permits"],
      ["set", "permits_writer", "permits-writer", 2],
      ["open", "dbo", "inspections"],
      ["close", "dbo", "fees"],
    ]);
  });

  test("another user with the same secret and the same tables is a change", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await setWrites(rig);
    await setWrites(rig, { ...WRITES, user: "permits_loader" });
    expect(await writesOf(rig)).toEqual({ user: "permits_loader", keyName: "permits-writer", tables: SORTED });
    expect(await writesRecords(rig)).toEqual([
      ["set", "permits_writer", "permits-writer", 2],
      ["open", "dbo", "fees"],
      ["open", "dbo", "permits"],
      ["set", "permits_loader", "permits-writer", 2],
    ]);
  });

  test("one more table that sorts after the others is a change, and is kept", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await setWrites(rig);
    const zoning = { schema: "dbo", name: "zoning" };
    await setWrites(rig, { ...WRITES, tables: [...WRITES.tables, zoning] });
    expect(await writesOf(rig)).toMatchObject({ tables: [...SORTED, zoning] });
    // And one fewer at the end is a change too.
    await setWrites(rig, { ...WRITES, tables: [SORTED[0]] });
    expect(await writesOf(rig)).toMatchObject({ tables: [SORTED[0]] });
    expect((await writesRecords(rig)).slice(3)).toEqual([
      ["set", "permits_writer", "permits-writer", 3],
      ["open", "dbo", "zoning"],
      ["set", "permits_writer", "permits-writer", 1],
      ["close", "dbo", "permits"],
      ["close", "dbo", "zoning"],
    ]);
  });

  test("the lines of a taking away and of a removal name the connection, the table and the person", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await addConnection(rig, BILLING);
    await setWrites(rig);
    await setWrites(rig, {
      name: BILLING.name,
      user: "billing_writer",
      keyName: "billing-writer",
      tables: [{ schema: "public", name: "invoices" }],
    });
    expect((await act(rig, "connection.writes.remove", { name: PERMITS.name })).ok).toBe(true);
    expect((await act(rig, "connection.remove", { name: BILLING.name })).ok).toBe(true);
    const closing = (await moduleRecords(rig)).filter((record) =>
      /\.connection\.writes\.(?:remove|table\.remove)$/.test(record.action),
    );
    expect(closing).toEqual([
      { action: "module.databases.connection.writes.remove", params: { target: "Northstar permits", by: "marta" } },
      {
        action: "module.databases.connection.writes.table.remove",
        params: { target: "Northstar permits", schema: "dbo", table: "fees", by: "marta" },
      },
      {
        action: "module.databases.connection.writes.table.remove",
        params: { target: "Northstar permits", schema: "dbo", table: "permits", by: "marta" },
      },
      {
        action: "module.databases.connection.writes.table.remove",
        params: { target: "Northstar billing", schema: "public", table: "invoices", by: "marta" },
      },
    ]);
  });

  test("the same settings again, with the tables in another order, leave no line", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await setWrites(rig);
    const before = await writesRecords(rig);
    await setWrites(rig, { ...WRITES, tables: [...WRITES.tables].reverse() });
    expect(await writesRecords(rig)).toEqual(before);
  });

  test("taking the settings away closes every table, and so does removing the connection", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await addConnection(rig, BILLING);
    await setWrites(rig);
    await setWrites(rig, { name: BILLING.name, user: "billing_writer", keyName: "billing-writer", tables: [{ schema: "public", name: "invoices" }] });
    expect((await act(rig, "connection.writes.remove", { name: PERMITS.name })).ok).toBe(true);
    expect((await act(rig, "connection.remove", { name: BILLING.name })).ok).toBe(true);
    expect(await writesRecords(rig)).toEqual([
      ["set", "permits_writer", "permits-writer", 2],
      ["open", "dbo", "fees"],
      ["open", "dbo", "permits"],
      ["set", "billing_writer", "billing-writer", 1],
      ["open", "public", "invoices"],
      ["remove"],
      ["close", "dbo", "fees"],
      ["close", "dbo", "permits"],
      ["close", "public", "invoices"],
    ]);
  });

  test("a change that names the same database leaves no line about its write settings", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await setWrites(rig);
    const before = await writesRecords(rig);
    expect((await act(rig, "connection.change", { ...PERMITS, user: "permits_reader_2" })).ok).toBe(true);
    expect(await writesRecords(rig)).toEqual(before);
  });

  test("every table of the longest list is named once, when it is set and when it is taken away", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    const tables = manyTables(WRITE_TABLES_MAX);
    await setWrites(rig, { ...WRITES, tables });
    expect((await act(rig, "connection.writes.remove", { name: PERMITS.name })).ok).toBe(true);
    expect(await writesRecords(rig)).toEqual([
      ["set", "permits_writer", "permits-writer", WRITE_TABLES_MAX],
      ...tables.map((table) => ["open", table.schema, table.name]),
      ["remove"],
      ...tables.map((table) => ["close", table.schema, table.name]),
    ]);
  });
});

describe("the host's list of secret names, after a change that failed", () => {
  test("a name the list did not take back is put back by the next act that changes something", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await setWrites(rig);
    // The list gives up the old name, does not take the new one, and then
    // does not take the old one back either.
    let adds = 0;
    rig.faults.secretNameAdd = (): void => {
      adds += 1;
      if (adds <= 2) throw Object.assign(new Error("the disk is full"), { code: "ENOSPC" });
    };
    expect(await act(rig, "connection.writes.set", { ...WRITES, keyName: "permits-writer-2" })).toEqual(failed("internal"));
    // The connection still names the old secret, and the list has lost it.
    expect(await writesOf(rig)).toMatchObject({ keyName: "permits-writer" });
    expect(await secretNames(rig)).toEqual(["permits-reader"]);
    // The same settings again are no change of the connection. The act still
    // brings the list in line with the connections first.
    const before = await writesRecords(rig);
    await setWrites(rig);
    expect(adds).toBe(3);
    expect(await secretNames(rig)).toEqual(["permits-reader", "permits-writer"]);
    expect(await writesRecords(rig)).toEqual(before);
  });

  /** Have the write login's secret change fail, with the old name not taken
   *  back either: the connection names `permits-writer`, and the list lacks it. */
  async function loseTheWriteName(of: DatabasesRig): Promise<void> {
    let adds = 0;
    of.faults.secretNameAdd = (): void => {
      adds += 1;
      if (adds <= 2) throw Object.assign(new Error("the disk is full"), { code: "ENOSPC" });
    };
    expect(await act(of, "connection.writes.set", { ...WRITES, keyName: "permits-writer-2" })).toEqual(failed("internal"));
    of.faults.secretNameAdd = undefined;
    expect(await secretNames(of)).not.toContain("permits-writer");
  }

  test.each<[string, (of: DatabasesRig) => Promise<{ ok: boolean }>, string[]]>([
    [
      "a change of the connection",
      (of) => act(of, "connection.change", { ...PERMITS, encryption: "require" }),
      ["billing-reader", "permits-reader", "permits-writer"],
    ],
    [
      "a change of another connection",
      (of) => act(of, "connection.change", { ...BILLING, encryption: "verify" }),
      ["billing-reader", "permits-reader", "permits-writer"],
    ],
    [
      "the removal of another connection",
      (of) => act(of, "connection.remove", { name: BILLING.name }),
      ["permits-reader", "permits-writer"],
    ],
    [
      "a new connection",
      (of) => act(of, "connection.add", { ...PERMITS, name: "Northstar archive", port: 1434, keyName: "archive-reader" }),
      ["archive-reader", "billing-reader", "permits-reader", "permits-writer"],
    ],
    [
      "write settings taken away from another connection that has none",
      (of) => act(of, "connection.writes.remove", { name: BILLING.name }),
      ["billing-reader", "permits-reader", "permits-writer"],
    ],
  ])("%s puts the lost name back", async (_what, next, names) => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await addConnection(rig, BILLING);
    await setWrites(rig);
    await loseTheWriteName(rig);
    expect((await next(rig)).ok).toBe(true);
    expect(await secretNames(rig)).toEqual(names);
  });

  test("the read login's lost name comes back with a change that changes nothing", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    let adds = 0;
    rig.faults.secretNameAdd = (): void => {
      adds += 1;
      if (adds <= 2) throw Object.assign(new Error("the disk is full"), { code: "ENOSPC" });
    };
    expect(await act(rig, "connection.change", { ...PERMITS, keyName: "permits-reader-2" })).toEqual(failed("internal"));
    rig.faults.secretNameAdd = undefined;
    expect(await secretNames(rig)).toEqual([]);
    // The same fields again are no change of the connection, and leave no line.
    expect((await act(rig, "connection.change", PERMITS)).ok).toBe(true);
    expect(await secretNames(rig)).toEqual(["permits-reader"]);
    expect((await moduleRecords(rig)).map((record) => record.action)).toEqual(["module.databases.connection.add"]);
  });

  test("a name the list does not take back leaves the other lost names to be put back", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await setWrites(rig);
    // Both names are lost: the write login's first, then the read login's,
    // with every add failing meanwhile.
    rig.faults.secretNameAdd = (): never => {
      throw Object.assign(new Error("the disk is full"), { code: "ENOSPC" });
    };
    expect(await act(rig, "connection.writes.set", { ...WRITES, keyName: "permits-writer-2" })).toEqual(failed("internal"));
    expect(await act(rig, "connection.change", { ...PERMITS, keyName: "permits-reader-2" })).toEqual(failed("internal"));
    expect(await secretNames(rig)).toEqual([]);
    // At the next act the list refuses the first name it is asked to take
    // back, and takes the second.
    let adds = 0;
    rig.faults.secretNameAdd = (): void => {
      adds += 1;
      if (adds === 1) throw Object.assign(new Error("the disk is full"), { code: "ENOSPC" });
    };
    await setWrites(rig);
    expect(adds).toBe(2);
    expect((await secretNames(rig)).length).toBe(1);
    // And the act after that puts back the one that was refused.
    rig.faults.secretNameAdd = undefined;
    await setWrites(rig);
    expect(await secretNames(rig)).toEqual(["permits-reader", "permits-writer"]);
  });

  test("the lost name is put back also when an unused entry could not be taken off first", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await setWrites(rig);
    // A connection that could not be saved, and whose host could not be taken
    // off the list of hosts again: an entry that nothing uses.
    rig.faults.reachRemove = (): never => {
      throw Object.assign(new Error("the disk is full"), { code: "ENOSPC" });
    };
    const write = rig.ctx.state.write.bind(rig.ctx.state);
    rig.ctx.state.write = async <T>(key: string, value: T): Promise<void> => {
      if (key === "connections") throw Object.assign(new Error("the disk is full"), { code: "ENOSPC" });
      return write(key, value);
    };
    expect(await act(rig, "connection.add", BILLING)).toEqual(failed("internal"));
    rig.ctx.state.write = write;
    expect((await rig.ctx.reach.list()).length).toBe(2);
    await loseTheWriteName(rig);
    // The unused host still cannot be taken off. The name is put back all the same.
    await setWrites(rig);
    expect(await secretNames(rig)).toEqual(["permits-reader", "permits-writer"]);
    expect((await rig.ctx.reach.list()).length).toBe(2);
    // Once the list of hosts takes a removal again, the unused host goes too.
    rig.faults.reachRemove = undefined;
    await setWrites(rig, { ...WRITES, tables: [] });
    expect((await rig.ctx.reach.list()).length).toBe(1);
  });

  test("on a full list, the unused name is taken off before the lost one is put back", async () => {
    rig = await makeDatabasesRig();
    const name = (at: number): string => `Northstar permits ${at}`;
    // 63 connections, each with a secret of its own, and one write login: 64 names.
    for (let at = 0; at < 63; at += 1) {
      await addConnection(rig, { ...PERMITS, name: name(at), port: 1433 + at, keyName: `permits-reader-${at}` });
    }
    const writes = { name: name(0), user: "permits_writer", keyName: "permits-writer" };
    await setWrites(rig, writes);
    expect((await secretNames(rig)).length).toBe(64);
    // The write login's name is lost: 63 names, and the connection still names it.
    let adds = 0;
    rig.faults.secretNameAdd = (): void => {
      adds += 1;
      if (adds <= 2) throw Object.assign(new Error("the disk is full"), { code: "ENOSPC" });
    };
    expect(await act(rig, "connection.writes.set", { ...writes, keyName: "permits-writer-2" })).toEqual(failed("internal"));
    expect((await secretNames(rig)).length).toBe(63);
    // A connection that could not be saved leaves its secret's name behind:
    // the list is full again, with a name that nothing uses. The put-back of
    // the lost name fails once more during that act.
    adds = 0;
    rig.faults.secretNameAdd = (): void => {
      adds += 1;
      if (adds === 1) throw Object.assign(new Error("the disk is full"), { code: "ENOSPC" });
    };
    rig.faults.secretNameRemove = (): never => {
      throw Object.assign(new Error("the disk is full"), { code: "ENOSPC" });
    };
    const write = rig.ctx.state.write.bind(rig.ctx.state);
    rig.ctx.state.write = async <T>(key: string, value: T): Promise<void> => {
      if (key === "connections") throw Object.assign(new Error("the disk is full"), { code: "ENOSPC" });
      return write(key, value);
    };
    const unused = { ...PERMITS, name: "Northstar archive", port: 1500, keyName: "archive-reader" };
    expect(await act(rig, "connection.add", unused)).toEqual(failed("internal"));
    rig.ctx.state.write = write;
    rig.faults.secretNameAdd = undefined;
    rig.faults.secretNameRemove = undefined;
    const full = await secretNames(rig);
    expect(full.length).toBe(64);
    expect(full).toContain("archive-reader");
    expect(full).not.toContain("permits-writer");
    // The next act makes room first, and then puts the lost name back.
    await setWrites(rig, writes);
    const mended = await secretNames(rig);
    expect(mended.length).toBe(64);
    expect(mended).toContain("permits-writer");
    expect(mended).not.toContain("archive-reader");
  });

  test("a test of the connection puts nothing back, and fails for the name that is not on the list", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    // The read login's own name is lost: a change to another name fails, and
    // the first name is not taken back.
    let adds = 0;
    rig.faults.secretNameAdd = (): void => {
      adds += 1;
      if (adds <= 2) throw Object.assign(new Error("the disk is full"), { code: "ENOSPC" });
    };
    expect(await act(rig, "connection.change", { ...PERMITS, keyName: "permits-reader-2" })).toEqual(failed("internal"));
    rig.faults.secretNameAdd = undefined;
    expect(await secretNames(rig)).toEqual([]);
    await testConnection(rig);
    expect(await connectionOf(rig)).toMatchObject({ test: { state: "failed", code: "secret_not_added" } });
    expect(await secretNames(rig)).toEqual([]);
    // An act that changes something puts it back, and the test passes.
    await setWrites(rig);
    expect(await secretNames(rig)).toEqual(["permits-reader", "permits-writer"]);
    await testConnection(rig);
    expect(await connectionOf(rig)).toMatchObject({ test: { state: "done" } });
  });

  test("an act that reads puts nothing back: only an operator's act changes the list", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await setWrites(rig);
    let adds = 0;
    rig.faults.secretNameAdd = (): void => {
      adds += 1;
      if (adds <= 2) throw Object.assign(new Error("the disk is full"), { code: "ENOSPC" });
    };
    expect(await act(rig, "connection.writes.set", { ...WRITES, keyName: "permits-writer-2" })).toEqual(failed("internal"));
    expect((await act(rig, "connections.read", {}, RUTH)).ok).toBe(true);
    expect((await act(rig, "connection.writes.read", { name: PERMITS.name }, RUTH)).ok).toBe(true);
    expect(adds).toBe(2);
    expect(await secretNames(rig)).toEqual(["permits-reader"]);
  });

  test("a change that could not be saved leaves on the list a name that another connection uses", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await addConnection(rig, BILLING);
    await setWrites(rig);
    await setWrites(rig, { name: BILLING.name, user: "billing_writer", keyName: "billing-writer" });
    const write = rig.ctx.state.write.bind(rig.ctx.state);
    rig.ctx.state.write = async <T>(key: string, value: T): Promise<void> => {
      if (key === "connections") throw Object.assign(new Error("the disk is full"), { code: "ENOSPC" });
      return write(key, value);
    };
    // The permits connection is to write with the billing connection's
    // secret. The list has that name already, and the save fails.
    expect(await act(rig, "connection.writes.set", { ...WRITES, keyName: "billing-writer" })).toEqual(failed("internal"));
    rig.ctx.state.write = write;
    // Taking the change back takes off nothing that the billing connection uses.
    expect(await secretNames(rig)).toEqual(["billing-reader", "billing-writer", "permits-reader", "permits-writer"]);
    expect(await writesOf(rig)).toMatchObject({ keyName: "permits-writer" });
    expect(await writesOf(rig, BILLING.name)).toMatchObject({ keyName: "billing-writer" });
  });
});

describe("the host's list of secret names is 64 names long", () => {
  test("a write login's own secret is one of them, so the list can be full at 32 connections", async () => {
    rig = await makeDatabasesRig();
    const name = (at: number): string => `Northstar permits ${at}`;
    // 32 connections, each with a read secret and a write secret of its own.
    for (let at = 0; at < 32; at += 1) {
      await addConnection(rig, { ...PERMITS, name: name(at), port: 1433 + at, keyName: `permits-reader-${at}` });
      await setWrites(rig, { name: name(at), user: "permits_writer", keyName: `permits-writer-${at}` });
    }
    expect((await secretNames(rig)).length).toBe(64);
    // A connection with a secret of its own no longer fits.
    const next = { ...PERMITS, name: name(32), port: 1500 };
    expect(await act(rig, "connection.add", { ...next, keyName: "permits-reader-32" })).toEqual(
      failed("secret_names_full"),
    );
    // One whose login is kept under a name the list has does, and so does a
    // write login under such a name.
    await addConnection(rig, { ...next, keyName: "permits-reader-0" });
    expect(
      await act(rig, "connection.writes.set", { name: name(32), user: "permits_writer", keyName: "permits-writer-32" }),
    ).toEqual(failed("secret_names_full"));
    await setWrites(rig, { name: name(32), user: "permits_writer", keyName: "permits-writer-0" });
    // A full list still has room for a change that gives one name up and takes another.
    await setWrites(rig, { name: name(1), user: "permits_writer", keyName: "permits-writer-new" });
    const names = await secretNames(rig);
    expect(names.length).toBe(64);
    expect(names).toContain("permits-writer-new");
    expect(names).not.toContain("permits-writer-1");
  });
});

describe("the limits of write settings fit the host's", () => {
  /** A text of exactly `chars` characters that starts as `start` does. */
  const long = (start: string, chars: number): string => start.padEnd(chars, "x");
  /** The gate takes 120 recorded acts a minute, and this rig's clock stands still. */
  const nextMinute = (of: DatabasesRig): void => {
    of.now.value = new Date(of.now.value.getTime() + 61_000);
  };

  test("all connections together name as many tables as the limit says, and no more", async () => {
    rig = await makeDatabasesRig();
    const full = WRITE_TABLES_MAX_IN_ALL / WRITE_TABLES_MAX;
    expect(Number.isInteger(full)).toBe(true);
    for (let at = 0; at <= full; at += 1) {
      await addConnection(rig, { ...PERMITS, name: `Northstar permits ${at}`, port: 1433 + at });
    }
    const settings = (at: number, tables: unknown[]): Record<string, unknown> => ({
      name: `Northstar permits ${at}`,
      user: "permits_writer",
      keyName: "permits-writer",
      tables,
    });
    for (let at = 0; at < full; at += 1) await setWrites(rig, settings(at, manyTables(WRITE_TABLES_MAX)));
    // One more table, on any connection, is one too many. The refusal comes
    // before the write login's secret is named to the host.
    const names = await secretNames(rig);
    expect(
      await act(rig, "connection.writes.set", { ...settings(full, manyTables(1)), keyName: "permits-writer-new" }),
    ).toEqual(failed("write_tables_full"));
    expect(await secretNames(rig)).toEqual(names);
    expect(await writesOf(rig, `Northstar permits ${full}`)).toBeUndefined();
    // A write login with no table still fits.
    await setWrites(rig, settings(full, []));
    // A connection's own tables are not counted twice: it can replace its whole list.
    await setWrites(rig, settings(0, manyTables(WRITE_TABLES_MAX).map((table) => ({ ...table, schema: "audit" }))));
    // Once a connection gives one table up, another connection can take one.
    await setWrites(rig, settings(1, manyTables(WRITE_TABLES_MAX - 1)));
    await setWrites(rig, settings(full, manyTables(1)));
    expect(await act(rig, "connection.writes.set", settings(full, manyTables(2)))).toEqual(failed("write_tables_full"));
    expect(await writesOf(rig, `Northstar permits ${full}`)).toMatchObject({ tables: manyTables(1) });
    // Each table that was opened or closed has its line. Reading them waits for the last one.
    const lines = await writesRecords(rig);
    expect(lines.filter((line) => line[0] === "open").length).toBe(WRITE_TABLES_MAX_IN_ALL + WRITE_TABLES_MAX + 1);
    expect(lines.filter((line) => line[0] === "close").length).toBe(WRITE_TABLES_MAX + 1);
  }, 30_000);

  test(
    "with every limit of the lists reached and names at their longest, the list and one connection's tables are still read",
    async () => {
      rig = await makeDatabasesRig();
      const name = (at: number): string =>
        long(`Northstar permits ${String(at).padStart(2, "0")} `, CONNECTION_NAME_MAX_CHARS);
      // A host's name is at most 128 characters here, and each of its labels 63.
      const host = `${"h".repeat(63)}.${"o".repeat(60)}.x`;
      for (let at = 0; at < CONNECTIONS_MAX; at += 1) {
        await addConnection(rig, {
          name: name(at),
          engine: "sqlserver",
          host,
          port: 1433 + at,
          database: long("Permits_", 128),
          encryption: "verify",
          minTls: "1.2",
          serverName: host,
          user: long("permits_reader_", 128),
          keyName: long("permits-reader-", 64),
        });
      }
      // Every connection has a write login. The first five name two hundred
      // tables each, which is as many as all connections may name together.
      const tablesOf = (at: number): { schema: string; name: string }[] =>
        Array.from({ length: WRITE_TABLES_MAX }, (_, table) => ({
          schema: long(`schema_${at}_`, 128),
          name: long(`table_${String(table).padStart(3, "0")}_`, 128),
        }));
      nextMinute(rig);
      for (let at = 0; at < CONNECTIONS_MAX; at += 1) {
        await setWrites(rig, {
          name: name(at),
          user: long("permits_writer_", 128),
          keyName: long("permits-writer-", 64),
          tables: at < WRITE_TABLES_MAX_IN_ALL / WRITE_TABLES_MAX ? tablesOf(at) : [],
        });
      }
      nextMinute(rig);

      // The host turns away an answer of more than 20,000 values or 256 KiB.
      const list = await act(rig, "connections.read");
      if (!list.ok) throw new Error(`the connections were not read: ${list.error}`);
      const connections = (list.payload as { connections: { writes: { tables: number } }[] }).connections;
      expect(connections.length).toBe(CONNECTIONS_MAX);
      expect(connections.reduce((count, connection) => count + connection.writes.tables, 0)).toBe(WRITE_TABLES_MAX_IN_ALL);
      expect(await writesOf(rig, name(0))).toMatchObject({ tables: tablesOf(0) });

      // What the module keeps is one record, which the host holds to 1 MiB.
      // With every table's name as long as it may be, it is under half of
      // that. This test has one job and short logins of persons: the most
      // jobs and the longest logins add under 100 KiB.
      const kept = JSON.stringify(await rig.ctx.state.read("connections")).length;
      expect(kept).toBeGreaterThan(WRITE_TABLES_MAX_IN_ALL * 2 * 128);
      expect(kept).toBeLessThan(MODULE_STATE_MAX_BYTES / 2);

      // A test still starts, and its end is written: each writes that record
      // again. The made-up company's key store has no secret of this name, so
      // the test ends with the host's word for that. A test whose end could
      // not be written would read as interrupted.
      await testConnection(rig, name(0));
      expect(await connectionOf(rig, name(0))).toMatchObject({ test: { state: "failed", code: "secret_missing" } });
      // The lines of the trail have landed before the rig is taken down.
      expect((await writesRecords(rig)).filter((line) => line[0] === "open").length).toBe(WRITE_TABLES_MAX_IN_ALL);
    },
    60_000,
  );
});
