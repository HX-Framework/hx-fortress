// A catalog as the module keeps it: each type as one word, names that fit an
// answer, and pages small enough to be one answer each.

import { afterEach, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

import { conform, type Shape } from "../../../src/host/shape";
import { columnTypeOf, readCatalog } from "../../../src/modules/databases/catalog";
import type { RunnerTable } from "../../../src/modules/databases/data-runner";
import { DATABASES_MANIFEST, type Engine } from "../../../src/modules/databases/manifest";
import { ask } from "../../host/_module-rig";
import {
  act,
  addConnection,
  makeDatabasesRig,
  PERMITS,
  testConnection,
  type DatabasesRig,
} from "./_rig";
import { NORTHSTAR_SERVERS, type StandInServer, type StandInTable } from "./standin-data-runner";

let rig: DatabasesRig | null = null;
afterEach(async () => {
  await rig?.cleanup();
  rig = null;
});

describe("a column's type, as one word", () => {
  test.each<[Engine, string, unknown]>([
    ["sqlserver", "nvarchar(20)", { type: "characters", length: 20 }],
    ["sqlserver", "varchar(max)", { type: "characters" }],
    ["sqlserver", "uniqueidentifier", { type: "characters" }],
    ["sqlserver", "int", { type: "whole_number" }],
    ["sqlserver", "numeric(18,0)", { type: "whole_number", length: 18 }],
    ["sqlserver", "decimal(12,2)", { type: "decimal", length: 12, scale: 2 }],
    ["sqlserver", "money", { type: "decimal" }],
    ["sqlserver", "float(53)", { type: "decimal" }],
    ["sqlserver", "bit", { type: "flag" }],
    ["sqlserver", "date", { type: "date" }],
    ["sqlserver", "time(7)", { type: "time" }],
    ["sqlserver", "datetime2(7)", { type: "date_time" }],
    ["sqlserver", "datetimeoffset(7)", { type: "date_time" }],
    ["sqlserver", "varbinary(max)", { type: "binary" }],
    ["sqlserver", "binary(16)", { type: "binary", length: 16 }],
    // A row's version on this engine, an instant on the others.
    ["sqlserver", "timestamp", { type: "binary", length: 8 }],
    ["postgres", "timestamp", { type: "date_time" }],
    ["postgres", "timestamp with time zone", { type: "date_time" }],
    ["postgres", "timestamp(6) without time zone", { type: "date_time" }],
    ["postgres", "time without time zone", { type: "time" }],
    ["postgres", "character varying(50)", { type: "characters", length: 50 }],
    ["postgres", "double precision", { type: "decimal" }],
    ["postgres", "boolean", { type: "flag" }],
    ["postgres", "bytea", { type: "binary" }],
    ["postgres", "jsonb", { type: "characters" }],
    ["postgres", "USER-DEFINED", { type: "other" }],
    ["postgres", "ARRAY", { type: "other" }],
    ["postgres", "interval", { type: "other" }],
    ["mysql", "tinyint(1)", { type: "flag" }],
    ["mysql", "tinyint(4)", { type: "whole_number" }],
    ["mysql", "bigint unsigned", { type: "whole_number" }],
    ["mysql", "bit(8)", { type: "binary", length: 8 }],
    // Several bits are bits on every engine. One is a flag.
    ["postgres", "bit(8)", { type: "binary", length: 8 }],
    ["postgres", "bit(1)", { type: "flag" }],
    ["postgres", "bit", { type: "flag" }],
    // How a number is kept is not what it is.
    ["mysql", "int(10) unsigned zerofill", { type: "whole_number" }],
    ["mysql", "decimal(10,2) unsigned", { type: "decimal", length: 10, scale: 2 }],
    // An enum's own value can hold a bracket.
    ["mysql", "enum('a)','b')", { type: "characters" }],
    ["mysql", "datetime", { type: "date_time" }],
    // An enum's own values are text the database chose. None of it is kept.
    ["mysql", "enum('18 Mill Road','7 Alder Court')", { type: "characters" }],
    ["oracle", "NUMBER", { type: "decimal" }],
    ["oracle", "NUMBER(10)", { type: "whole_number", length: 10 }],
    ["oracle", "NUMBER(10,2)", { type: "decimal", length: 10, scale: 2 }],
    ["oracle", "VARCHAR2(50)", { type: "characters", length: 50 }],
    // A date holds a time of day on this engine.
    ["oracle", "DATE", { type: "date_time" }],
    ["oracle", "TIMESTAMP(6) WITH TIME ZONE", { type: "date_time" }],
    ["oracle", "RAW(16)", { type: "binary", length: 16 }],
    ["oracle", "SDO_GEOMETRY", { type: "other" }],
    ["sqlserver", "", { type: "other" }],
    ["sqlserver", "18 Mill Road", { type: "other" }],
  ])("%s %s", (engine, type, view) => {
    expect(columnTypeOf(engine, type)).toEqual(view as ReturnType<typeof columnTypeOf>);
  });
});

const table = (name: string, columns: number, schema = "dbo"): RunnerTable => ({
  schema,
  name,
  kind: "table",
  rows: 10,
  columns: Array.from({ length: columns }, (_, i) => ({
    name: `column_${i}`,
    type: "int",
    nullable: false,
    ...(i === 0 ? { key: 1 } : {}),
  })),
});

describe("a reading, cut into pages", () => {
  test("a database with no tables is a reading with no pages", () => {
    expect(readCatalog("postgres", [], false, "2027-03-14T09:00:00.000Z")).toEqual({
      readAt: "2027-03-14T09:00:00.000Z",
      pages: 0,
      tables: 0,
      columns: 0,
      leftOut: { tables: 0, columns: 0 },
      truncated: false,
      items: [],
    });
  });

  test("a name that an answer cannot hold is left out and counted, never rewritten", () => {
    const reading = readCatalog(
      "sqlserver",
      [
        table("permits", 2),
        table("Gebühren", 3),
        table("fees (old)", 1),
        table("", 1),
        table("permits", 1, "schema;drop"),
        {
          ...table("inspections", 0),
          columns: [
            { name: "id", type: "int", nullable: false },
            { name: "fee (€)", type: "money", nullable: true },
            { name: "", type: "int", nullable: true },
            { name: "n".repeat(129), type: "int", nullable: true },
          ],
        },
      ],
      true,
      "2027-03-14T09:00:00.000Z",
    );
    expect(reading).toMatchObject({ tables: 2, columns: 3, leftOut: { tables: 4, columns: 3 }, truncated: true });
    const kept = reading.items.flat();
    expect(kept.map((item) => item.name)).toEqual(["permits", "inspections"]);
    expect(kept[1]?.columns).toEqual([{ name: "id", type: "whole_number", nullable: false }]);
    const text = JSON.stringify(reading);
    for (const part of ["Geb", "fees", "drop", "fee", "€"]) expect(text).not.toContain(part);
  });

  test("a table with more columns than one item carries goes on over the next items", () => {
    const reading = readCatalog("sqlserver", [table("narrow", 3), table("wide", 950)], false, "2027-03-14T09:00:00.000Z");
    const items = reading.items.flat();
    expect(items.map((item) => [item.name, item.first, item.columns.length, item.columnCount])).toEqual([
      ["narrow", 0, 3, 3],
      ["wide", 0, 400, 950],
      ["wide", 400, 400, 950],
      ["wide", 800, 150, 950],
    ]);
    expect(items[2]?.columns[0]?.name).toBe("column_400");
    expect(reading.columns).toBe(953);
    expect(reading.tables).toBe(2);
  });

  test("every page is a value the catalog.read ask may answer", () => {
    const tables = Array.from({ length: 450 }, (_, i) => table(`table_${i}`, (i % 37) + 1));
    tables.push(table("very_wide", 2_000), { ...table("no_columns", 0), rows: null });
    const reading = readCatalog("mysql", tables, false, "2027-03-14T09:00:00.000Z");
    const shape = DATABASES_MANIFEST.asks.find((spec) => spec.name === "catalog.read")?.reply as Shape;
    expect(reading.pages).toBeGreaterThan(5);
    let tablesSeen = 0;
    let columnsSeen = 0;
    const summary = {
      readAt: reading.readAt,
      pages: reading.pages,
      tables: reading.tables,
      columns: reading.columns,
      leftOut: reading.leftOut,
      truncated: reading.truncated,
    };
    reading.items.forEach((items, page) => {
      const fit = conform(shape, { ...summary, page, items });
      expect(fit).toMatchObject({ ok: true });
      expect(items.length).toBeLessThanOrEqual(100);
      expect(JSON.stringify(items).length).toBeLessThan(128 * 1024);
      tablesSeen += items.filter((item) => item.first === 0).length;
      columnsSeen += items.reduce((sum, item) => sum + item.columns.length, 0);
    });
    expect(tablesSeen).toBe(reading.tables);
    expect(columnsSeen).toBe(reading.columns);
    // A table with no column that can be shown is still a table.
    expect(reading.items.flat().find((item) => item.name === "no_columns")).toMatchObject({
      columnCount: 0,
      columns: [],
    });
  });
});

/** The made-up SQL Server, with other tables in place of its own. */
function serversWith(tables: StandInTable[]): StandInServer[] {
  const [first, ...rest] = NORTHSTAR_SERVERS as StandInServer[];
  return [{ ...(first as StandInServer), tables }, ...rest];
}

const standInTable = (name: string, columns: number): StandInTable => ({
  schema: "dbo",
  name,
  kind: "table",
  estimate: 7,
  columns: Array.from({ length: columns }, (_, i) => ({ name: `column_${i}`, type: "int", nullable: false })),
  rows: [],
});

/** The key the first connection's catalog is kept under in the module's state. */
async function catalogKey(of: DatabasesRig): Promise<string> {
  const book = await of.ctx.state.read<{ connections: { id: string }[] }>("connections");
  return `catalog-${book?.connections[0]?.id ?? "none"}`;
}

/**
 * The files the module's state holds for catalogs: the host keeps one file for
 * each key. Sorted, because a folder's own order differs from one system to
 * the next.
 */
async function catalogFiles(of: DatabasesRig): Promise<string[]> {
  // The folder is the rig's own, under its temporary root.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const names = await readdir(of.host.organizations.stateDir(of.host.organizations.own, "databases"));
  return names.filter((name) => name.startsWith("catalog-")).sort();
}

/**
 * Make the removal of one key of the module's state fail once, as a disk that
 * does not answer would. Call what it returns to put the state back: it
 * answers whether the removal was tried.
 */
function failRemovalOnce(of: DatabasesRig, key: string): () => boolean {
  const remove = of.ctx.state.remove.bind(of.ctx.state);
  let failed = false;
  of.ctx.state.remove = async (name: string): Promise<void> => {
    if (!failed && name === key) {
      failed = true;
      throw new Error("the disk does not answer");
    }
    return remove(name);
  };
  return () => {
    of.ctx.state.remove = remove;
    return failed;
  };
}

/**
 * A connection with a reading of three pages in its first slot and one of one
 * page in its second, which is the one its record names. `tables` is what the
 * stand-in server holds, and a test may change it afterwards.
 */
async function withTwoReadings(tables: { now: StandInTable[] }): Promise<{ rig: DatabasesRig; key: string }> {
  tables.now = Array.from({ length: 230 }, (_, i) => standInTable(`table_${i}`, 12));
  const made = await makeDatabasesRig({ servers: () => serversWith(tables.now) });
  rig = made;
  await addConnection(made);
  await testConnection(made); // three pages, in the first slot
  tables.now = [standInTable("only_one", 2)];
  await testConnection(made); // one page, in the second slot
  const key = await catalogKey(made);
  expect(await catalogFiles(made)).toEqual(
    [`${key}-a.json`, `${key}-a-0.json`, `${key}-a-1.json`, `${key}-a-2.json`, `${key}-a-span.json`]
      .concat([`${key}-b.json`, `${key}-b-0.json`, `${key}-b-span.json`])
      .sort(),
  );
  return { rig: made, key };
}

describe("paging through a catalog with the ask", () => {
  test("every page of a large database is read, and each says how many there are", async () => {
    let servers = serversWith(Array.from({ length: 230 }, (_, i) => standInTable(`table_${i}`, 12)));
    rig = await makeDatabasesRig({ servers: () => servers });
    await addConnection(rig);
    await testConnection(rig);

    const names: string[] = [];
    let pages = 1;
    for (let page = 0; page < pages; page += 1) {
      const reply = await ask(rig, "databases", "catalog.read", { connection: PERMITS.name, page });
      if (!reply?.ok) throw new Error(`page ${page} was refused`);
      const body = reply.payload as { pages: number; tables: number; items: { name: string }[] };
      pages = body.pages;
      expect(body.tables).toBe(230);
      names.push(...body.items.map((item) => item.name));
    }
    expect(pages).toBe(3);
    expect(names).toHaveLength(230);
    expect(new Set(names).size).toBe(230);

    // A second test finds a smaller database. The pages of the first reading
    // that the second does not have are gone.
    servers = serversWith([standInTable("only_one", 2)]);
    await testConnection(rig);
    expect(await ask(rig, "databases", "catalog.read", { connection: PERMITS.name, page: 0 })).toMatchObject({
      ok: true,
      payload: { pages: 1, tables: 1, items: [{ name: "only_one" }] },
    });
    expect(await ask(rig, "databases", "catalog.read", { connection: PERMITS.name, page: 1 })).toEqual({
      ok: false,
      error: "failed:page_unknown",
    });
    // The second reading went to the other slot. The record points at it.
    const key = await catalogKey(rig);
    expect(await rig.ctx.state.read(`${key}-b-0`)).not.toBeNull();
    // Until then the first slot keeps the whole first reading: three pages.
    expect(await catalogFiles(rig)).toEqual(
      [`${key}-a.json`, `${key}-a-0.json`, `${key}-a-1.json`, `${key}-a-2.json`, `${key}-a-span.json`]
        .concat([`${key}-b.json`, `${key}-b-0.json`, `${key}-b-span.json`])
        .sort(),
    );
    // A third reading goes back to the first slot, and what that slot held of
    // the longer first reading is removed: its files are gone from the disk.
    await testConnection(rig);
    expect(await rig.ctx.state.read(`${key}-a-0`)).not.toBeNull();
    expect(await rig.ctx.state.read(`${key}-a-1`)).toBeNull();
    expect(await rig.ctx.state.read(`${key}-a-2`)).toBeNull();
    expect(await catalogFiles(rig)).toEqual(
      [`${key}-a.json`, `${key}-a-0.json`, `${key}-a-span.json`]
        .concat([`${key}-b.json`, `${key}-b-0.json`, `${key}-b-span.json`])
        .sort(),
    );
    expect(await ask(rig, "databases", "catalog.read", { connection: PERMITS.name, page: 0 })).toMatchObject({
      payload: { pages: 1, tables: 1 },
    });
  });

  test("a page that a reading could not remove is removed with the connection, and nothing of its catalog stays", async () => {
    const tables = { now: [] as StandInTable[] };
    const { rig: made, key } = await withTwoReadings(tables);
    // The third reading goes back to the first slot. Removing what the long
    // first reading left there fails once, at its last page.
    const mend = failRemovalOnce(made, `${key}-a-2`);
    await testConnection(made);
    expect(mend()).toBe(true);
    // A page of the first reading is still there, past a page that is gone,
    // and the slot still says that its pages may reach that far.
    expect(await catalogFiles(made)).toEqual(
      [`${key}-a.json`, `${key}-a-0.json`, `${key}-a-2.json`, `${key}-a-span.json`]
        .concat([`${key}-b.json`, `${key}-b-0.json`, `${key}-b-span.json`])
        .sort(),
    );
    expect(await made.ctx.state.read<number>(`${key}-a-span`)).toBe(3);
    // The reading itself is whole: the page that stayed is past its end.
    expect(await ask(made, "databases", "catalog.read", { connection: PERMITS.name, page: 0 })).toMatchObject({
      ok: true,
      payload: { pages: 1, tables: 1 },
    });
    // Removing the connection removes every key of both slots, that page too.
    expect((await act(made, "connection.remove", { name: PERMITS.name })).ok).toBe(true);
    expect(await catalogFiles(made)).toEqual([]);
  });

  test("a connection whose catalog cannot be removed stays, and removing it again leaves nothing", async () => {
    const tables = { now: [] as StandInTable[] };
    const { rig: made, key } = await withTwoReadings(tables);
    // The removal of the second slot's page fails once.
    const mend = failRemovalOnce(made, `${key}-b-0`);
    expect(await act(made, "connection.remove", { name: PERMITS.name })).toEqual({
      ok: false,
      error: "failed:internal",
    });
    expect(mend()).toBe(true);
    // The connection is still there: a catalog goes before its connection
    // does. The first slot was cleared all the same, and the second keeps the
    // page that could not be removed, with the note of where its pages end.
    expect(await act(made, "connections.read")).toMatchObject({
      payload: { connections: [{ name: PERMITS.name }] },
    });
    expect(await catalogFiles(made)).toEqual([`${key}-b-0.json`, `${key}-b-span.json`].sort());
    // Removing it again removes the rest, and then the connection.
    expect((await act(made, "connection.remove", { name: PERMITS.name })).ok).toBe(true);
    expect(await catalogFiles(made)).toEqual([]);
    expect(await act(made, "connections.read")).toEqual({ ok: true, payload: { connections: [] } });
  });

  test("a change whose removal of the old catalog fails half way still succeeds, and the removal is finished later", async () => {
    const tables = { now: [] as StandInTable[] };
    const { rig: made, key } = await withTwoReadings(tables);
    // The connection is changed. Removing what it read before fails once, at
    // the first slot's second page.
    const mend = failRemovalOnce(made, `${key}-a-1`);
    expect((await act(made, "connection.change", { ...PERMITS, minTls: "1.3" })).ok).toBe(true);
    expect(mend()).toBe(true);
    // The first slot lost its summary and its first page. Its other pages
    // stay, WITH the note that says how far they reach: the note is removed
    // last. The second slot was cleared all the same.
    expect(await catalogFiles(made)).toEqual([`${key}-a-1.json`, `${key}-a-2.json`, `${key}-a-span.json`].sort());
    expect(await made.ctx.state.read<number>(`${key}-a-span`)).toBe(3);
    // Nothing reads those pages: the changed connection has no reading.
    expect(await ask(made, "databases", "catalog.read", { connection: PERMITS.name, page: 0 })).toEqual({
      ok: false,
      error: "failed:catalog_not_read",
    });
    // The next reading goes into that slot, finds them by the note and
    // removes them.
    await testConnection(made);
    expect(await catalogFiles(made)).toEqual([`${key}-a.json`, `${key}-a-0.json`, `${key}-a-span.json`].sort());
    expect(await made.ctx.state.read<number>(`${key}-a-span`)).toBe(1);
  });

  test("what a failed change left is removed with the connection too, when no reading comes first", async () => {
    const tables = { now: [] as StandInTable[] };
    const { rig: made, key } = await withTwoReadings(tables);
    const mend = failRemovalOnce(made, `${key}-a-1`);
    expect((await act(made, "connection.change", { ...PERMITS, minTls: "1.3" })).ok).toBe(true);
    expect(mend()).toBe(true);
    expect(await catalogFiles(made)).toEqual([`${key}-a-1.json`, `${key}-a-2.json`, `${key}-a-span.json`].sort());
    expect((await act(made, "connection.remove", { name: PERMITS.name })).ok).toBe(true);
    expect(await catalogFiles(made)).toEqual([]);
  });

  test("a connection that was changed keeps nothing of the catalog read before", async () => {
    rig = await makeDatabasesRig({ servers: () => serversWith([standInTable("only_one", 2)]) });
    await addConnection(rig);
    await testConnection(rig);
    const key = await catalogKey(rig);
    expect(await catalogFiles(rig)).toEqual([`${key}-a.json`, `${key}-a-0.json`, `${key}-a-span.json`].sort());
    // Any change does it, also one that names the same database: what was
    // read is of the connection as it was.
    expect((await act(rig, "connection.change", { ...PERMITS, minTls: "1.3" })).ok).toBe(true);
    expect(await catalogFiles(rig)).toEqual([]);
    expect(await ask(rig, "databases", "catalog.read", { connection: PERMITS.name, page: 0 })).toEqual({
      ok: false,
      error: "failed:catalog_not_read",
    });
  });

  test("a reading of a database with no tables removes every page its slot held, and the note of where they end", async () => {
    const tables = { now: [] as StandInTable[] };
    const { rig: made, key } = await withTwoReadings(tables);
    // The database has no table any more. The third reading goes back to the
    // first slot, which held three pages.
    tables.now = [];
    await testConnection(made);
    // That slot keeps the reading's summary and nothing else.
    expect(await catalogFiles(made)).toEqual(
      [`${key}-a.json`, `${key}-b.json`, `${key}-b-0.json`, `${key}-b-span.json`].sort(),
    );
    expect(await ask(made, "databases", "catalog.read", { connection: PERMITS.name, page: 0 })).toMatchObject({
      ok: true,
      payload: { pages: 0, tables: 0, items: [] },
    });
  });

  test("a process that stops half way through a second reading leaves the first one whole", async () => {
    rig = await makeDatabasesRig({
      servers: () => serversWith(Array.from({ length: 230 }, (_, i) => standInTable(`table_${i}`, 12))),
    });
    await addConnection(rig);
    await testConnection(rig);
    // What a second test had written when the process died: the first page of
    // its reading, in the slot the connection does not point at.
    const key = await catalogKey(rig);
    await rig.ctx.state.write(`${key}-b-0`, { reading: "job_that_died", items: [] });
    for (const page of [0, 1, 2]) {
      expect(await ask(rig, "databases", "catalog.read", { connection: PERMITS.name, page })).toMatchObject({
        ok: true,
        payload: { page, pages: 3, tables: 230 },
      });
    }
  });

  test("a page that is not of the reading the connection names is refused, not mixed in", async () => {
    rig = await makeDatabasesRig({
      servers: () => serversWith(Array.from({ length: 230 }, (_, i) => standInTable(`table_${i}`, 12))),
    });
    await addConnection(rig);
    await testConnection(rig);
    const key = `${await catalogKey(rig)}-a-1`;
    const stored = (await rig.ctx.state.read<{ reading: string; items: unknown[] }>(key)) as {
      reading: string;
      items: unknown[];
    };
    await rig.ctx.state.write(key, { ...stored, reading: "job_of_another_test" });
    expect(await ask(rig, "databases", "catalog.read", { connection: PERMITS.name, page: 1 })).toEqual({
      ok: false,
      error: "failed:catalog_changed",
    });
    expect((await ask(rig, "databases", "catalog.read", { connection: PERMITS.name, page: 0 }))?.ok).toBe(true);
  });

  test("a test that passed and could not keep what it read says so, and the reading before it stays", async () => {
    let tables = [standInTable("first", 2)];
    rig = await makeDatabasesRig({ servers: () => serversWith(tables) });
    await addConnection(rig);
    await testConnection(rig);
    tables = [standInTable("second", 2)];
    const write = rig.ctx.state.write.bind(rig.ctx.state);
    rig.ctx.state.write = async <T>(name: string, value: T): Promise<void> => {
      if (name.startsWith("catalog-")) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return write(name, value);
    };
    const job = await testConnection(rig);
    rig.ctx.state.write = write;
    expect(await ask(rig, "databases", "job.read", { job })).toMatchObject({
      payload: { state: "failed", code: "catalog_not_kept", step: "catalog" },
    });
    expect(await ask(rig, "databases", "catalog.read", { connection: PERMITS.name, page: 0 })).toMatchObject({
      payload: { items: [{ name: "first" }] },
    });
    expect(rig.logs.find((record) => record.msg === "what a test read could not be kept")?.fields).toMatchObject({
      job,
      errno: "ENOSPC",
    });
  });
});
