// A table's profile, as a page asks for it: the one profile (the readers' profile.ts), run on the
// store's own SQLite with statements that only read. A store's Tables tab draws it under each
// column's name and in a column's panel; a Notebook's card draws the same. The PROFILE job runs the
// same statements over every row and keeps them as a table (jobs/profile.ts).
//
// A profile reads at most PROFILE_ROWS_MAX rows of a table, as a Notebook's profile does through
// the `query` door, so the two count the same rows. It gives other calls their turn between two
// statements (`turn`), so a page's rows are never held up behind a wide table's profile. A
// program's table changes only with a new version or a change the store records, so its profile is
// kept per version and change, for a few tables at a time; any other table is read each time.
//
// A column of a person's numbers is counted, and its values are kept back. A parked table has no
// rows to read until it is back.

import { PROFILE_COLUMNS_MAX, profileTable, type TableProfile } from "../../store-readers/src/profile.js";
import { StoreError, type StoreCore } from "./core.js";
import { catalog, StoreDataError } from "./data.js";
import { turn } from "./jobs/cleanup-sql.js";
import { parkedWords } from "./park-time.js";
import type { StoreSqlValue } from "./sql.js";
import { DATABASE, type ProfileBody } from "./types.js";

/** Profiles a store keeps in memory: the tables a page has open. */
export const PROFILES_KEPT = 8;

/** The profiles a store keeps, by table and set of columns, with what each was read at. */
export type ProfileMemory = Map<string, { stamp: string; profile: TableProfile }>;

/** The body of a profile's ask, checked. Throws words. */
function askOf(body: unknown): { table: string; columns?: string[] } {
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (o.database !== undefined && o.database !== DATABASE) throw new StoreDataError(404, `This store has one database, "${DATABASE}".`);
  if (typeof o.table !== "string" || !o.table.trim() || o.table.length > 200) throw new StoreDataError(400, "A profile names the table to read.");
  if (o.columns === undefined) return { table: o.table };
  if (!Array.isArray(o.columns) || o.columns.length === 0 || o.columns.length > PROFILE_COLUMNS_MAX || o.columns.some((c) => typeof c !== "string" || !c || c.length > 200)) {
    throw new StoreDataError(400, `A profile names at most ${PROFILE_COLUMNS_MAX} columns, by their names.`);
  }
  return { table: o.table, columns: o.columns as string[] };
}

/** One table's profile: the one profile, read on the store's SQLite. */
export async function profile(core: StoreCore, body: ProfileBody, memory: ProfileMemory): Promise<TableProfile> {
  const ask = askOf(body);
  const tables = catalog(core).tables;
  const table = tables.find((t) => t.name === ask.table) ?? tables.find((t) => t.name.toLowerCase() === ask.table.toLowerCase());
  if (!table || table.kind === "system") throw new StoreDataError(404, `This store has no table "${ask.table}".`);
  if (table.parked) throw new StoreError(409, "table_parked", parkedWords(table.name));
  const columns = ask.columns?.map((name) => {
    const found = table.columns.find((c) => c.name === name) ?? table.packed?.find((c) => c.name === name);
    if (!found) throw new StoreDataError(400, `${table.name} has no column "${name}".`);
    return found.name;
  });
  // A program's table changes with a new version, a recorded change, or a write in place that marks
  // when it was last written (a person's review fix). Its links count rows of the tables they point
  // at, so a change to any other table of data reads the profile again. A view's rows are other
  // tables' rows, and any table that does not record its changes is read each time.
  const around = tables.filter((t) => t.kind !== "system" && t.name !== table.name).map((t) => `${t.name}:${t.version}:${t.change ?? 0}:${t.count}`).join("|");
  const written = table.kind === "program" && !table.view ? core.sql.exec<{ updated_at: string }>("SELECT updated_at FROM _tables WHERE name = ?", table.name).toArray()[0]?.updated_at : undefined;
  const stamp = written !== undefined ? `${table.version}:${table.change ?? 0}:${table.count}:${String(written)}|${around}` : null;
  // Kept per table and per set of columns: a doc's card of one column leaves the page's whole table.
  const key = `${table.name}\u0000${(columns ?? []).join("\u0000")}`;
  const kept = stamp === null ? undefined : memory.get(key);
  if (kept && kept.stamp === stamp) return kept.profile;
  const made = await profileTable(async (sql, limit) => core.sql.exec<Record<string, StoreSqlValue>>(sql).toArray().slice(0, limit), table, {
    ...(columns ? { columns } : {}),
    tables,
    between: turn,
  });
  if (stamp !== null) {
    memory.delete(key);
    memory.set(key, { stamp, profile: made });
    // The oldest goes first.
    while (memory.size > PROFILES_KEPT) memory.delete(memory.keys().next().value!);
  }
  return made;
}
