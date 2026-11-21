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
// host's list of secret names holds afterwards, and what the audit trail
// says. Nothing here starts a job: no job signs in with a write login yet.

import { afterEach, describe, expect, test } from "bun:test";

import { WRITE_TABLES_MAX } from "../../../src/modules/databases/manifest";
import { ask, spoolRecords, spoolText } from "../../host/_module-rig";
import {
  act,
  addConnection,
  BILLING,
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
    if (what === "writes.remove") lines.push(["remove"]);
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
    expect(await connectionOf(rig)).toMatchObject({
      user: "permits_reader",
      keyName: "permits-reader",
      writes: { user: "permits_writer", keyName: "permits-writer", tables: SORTED },
    });
  });

  test("the connection is named as it was added, whatever case the act names it in", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    expect(await act(rig, "connection.writes.set", { ...WRITES, name: "NORTHSTAR PERMITS" })).toEqual({
      ok: true,
      payload: { name: "Northstar permits" },
    });
  });

  test("a write login with no table is kept, and takes no write", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await setWrites(rig, { name: WRITES.name, user: WRITES.user, keyName: WRITES.keyName });
    expect((await connectionOf(rig)).writes).toEqual({ user: "permits_writer", keyName: "permits-writer", tables: [] });
  });

  test("both secrets' names are on the host's list, and no secret is read", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await setWrites(rig);
    expect(await secretNames(rig)).toEqual(["permits-reader", "permits-writer"]);
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
    expect((await connectionOf(rig)).writes).toEqual({ user: "permits_loader", keyName: "permits-loader", tables: [] });
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
    expect((await connectionOf(rig)).writes).toEqual({ user: "permits_writer", keyName: "permits-writer", tables: SORTED });
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
    await setWrites(rig, { ...WRITES, tables: manyTables(WRITE_TABLES_MAX) });
    expect(((await connectionOf(rig)).writes as { tables: unknown[] }).tables.length).toBe(WRITE_TABLES_MAX);
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
    expect((await connectionOf(rig)).writes).toMatchObject({ tables });
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

  test("a change of the connection's fields keeps them, and forgets the test as before", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await testConnection(rig);
    await setWrites(rig);
    expect((await act(rig, "connection.change", { ...PERMITS, port: 1434 })).ok).toBe(true);
    expect(await connectionOf(rig)).toMatchObject({
      port: 1434,
      state: "not_tested",
      writes: { user: "permits_writer", keyName: "permits-writer", tables: SORTED },
    });
    expect(await secretNames(rig)).toEqual(["permits-reader", "permits-writer"]);
  });

  test("the control plane's asks say nothing of them", async () => {
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
    expect((await connectionOf(rig)).writes).toEqual({ user: "permits_writer", keyName: "permits-writer", tables: SORTED });
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

  test("a change of the connection's fields leaves no line about its write settings", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    await setWrites(rig);
    const before = await writesRecords(rig);
    expect((await act(rig, "connection.change", { ...PERMITS, port: 1434 })).ok).toBe(true);
    expect(await writesRecords(rig)).toEqual(before);
  });

  test("every table of a long list is named once", async () => {
    rig = await makeDatabasesRig();
    await addConnection(rig);
    const tables = manyTables(45);
    await setWrites(rig, { ...WRITES, tables });
    expect(await writesRecords(rig)).toEqual([
      ["set", "permits_writer", "permits-writer", 45],
      ...tables.map((table) => ["open", table.schema, table.name]),
    ]);
  });
});
