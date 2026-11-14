// A catalog as the module keeps it: each type as one word, names that fit an
// answer, and pages small enough to be one answer each.

import { afterEach, describe, expect, test } from "bun:test";

import { conform, type Shape } from "../../../src/host/shape";
import { columnTypeOf, readCatalog } from "../../../src/modules/databases/catalog";
import type { RunnerTable } from "../../../src/modules/databases/data-runner";
import { DATABASES_MANIFEST, type Engine } from "../../../src/modules/databases/manifest";
import { ask } from "../../host/_module-rig";
import {
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
    expect(await rig.ctx.state.read(`${await catalogKey(rig)}-0`)).not.toBeNull();
    expect(await rig.ctx.state.read(`${await catalogKey(rig)}-1`)).toBeNull();
    expect(await rig.ctx.state.read(`${await catalogKey(rig)}-2`)).toBeNull();
  });

  test("a page of a reading that was replaced while it was being read is refused, not mixed", async () => {
    rig = await makeDatabasesRig({
      servers: () => serversWith(Array.from({ length: 230 }, (_, i) => standInTable(`table_${i}`, 12))),
    });
    await addConnection(rig);
    await testConnection(rig);
    // A newer reading's page, written before the document that names the
    // reading: what a reader sees in the middle of a second test.
    const key = `${await catalogKey(rig)}-1`;
    const stored = (await rig.ctx.state.read<{ reading: string; items: unknown[] }>(key)) as {
      reading: string;
      items: unknown[];
    };
    await rig.ctx.state.write(key, { ...stored, reading: "job_of_a_newer_test" });
    expect(await ask(rig, "databases", "catalog.read", { connection: PERMITS.name, page: 1 })).toEqual({
      ok: false,
      error: "failed:catalog_changed",
    });
    expect((await ask(rig, "databases", "catalog.read", { connection: PERMITS.name, page: 0 }))?.ok).toBe(true);
  });
});
