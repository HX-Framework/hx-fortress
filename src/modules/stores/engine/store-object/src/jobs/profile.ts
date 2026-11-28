// PROFILE: what each column of a store's table holds, over every row (Stores, Part A, slice E).
// store_profile (the api's agent/tools/store-cleanup.ts) submits it. It runs the one profile (the
// readers' profile.ts) over every row of the table, a few columns a chunk, and keeps it as a program
// table `<table>_profile` (group "Profiles"), one row per column: how many rows hold a value, how
// many distinct values, what most values read as and in which formats, the smallest and largest,
// the longest, the most common values with their rows, the values that read as something else, the
// table it points at counted in rows, the one fact about it that matters most, and the whole
// column's profile as JSON for code that reads it. A column of a person's numbers is counted, and
// its values are kept back. The store's catalog takes the exact fill and distinct count of each
// column, so the column heads show the whole table's numbers until the table's next version. A
// store keeps one profile of a table: a run's rows replace the last run's, whose copy is dropped.
// Its params and its answer are `store-readers/jobs`.
//
// A program's table that has not changed since its last profile is not read again: the store keeps
// under `profile:<table>` which version and change that profile read.
//
// A page's profile of the same table (profile.ts) reads the same statements up to its first
// 200,000 rows; this one reads every row.

import { madeByOf, MAX_TABLE_NAME, PROFILE_GROUP, type ProfiledColumn, type ProfileParams, type ProfileResult, type ProfileType } from "../../../store-readers/src/jobs.js";
import { factWords, profileTable, profileTypeOf, type ColumnProfile } from "../../../store-readers/src/profile.js";
import { StoreError } from "../core.js";
import { catalogOf } from "../data.js";
import { getMeta, setMeta } from "../schema.js";
import { isReservedName, type StoreSqlValue } from "../sql.js";
import { columnsOf, committedBy, dataTable, handleOf, ident, tableRecord, turn } from "./cleanup-sql.js";
import { type JobContext, type JobHandler, JobParamsError } from "./types.js";

/** Columns one chunk reads. */
export const PROFILE_AT_ONCE = 4;

export interface ProfileState {
  /** The next column to read. */
  at: number;
  /** `<into>__new` is made. */
  begun: boolean;
}

const NAME = new RegExp(`^[a-z][a-z0-9_]{0,${MAX_TABLE_NAME - 1}}$`);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const PROFILE_DDL = (table: string) =>
  `CREATE TABLE ${ident(table)} (column_name TEXT NOT NULL, position INTEGER NOT NULL, filled INTEGER NOT NULL, filled_share REAL NOT NULL, distinct_values INTEGER NOT NULL, type TEXT NOT NULL, type_share REAL NOT NULL, min TEXT, max TEXT, longest INTEGER, examples TEXT, odd TEXT, reads TEXT, formats TEXT, fact TEXT, points_at TEXT, personal TEXT, profile TEXT)`;

const PROFILE_COLUMNS = [
  { name: "column_name", comment: "The column of the table profiled." },
  { name: "position", comment: "Where the column stands in the table, from 1." },
  { name: "filled", comment: "Rows with a value: not empty, and not only spaces." },
  { name: "filled_share", comment: "The share of rows with a value, 0 to 1." },
  { name: "distinct_values", comment: "Distinct values, without spaces at either end." },
  { name: "type", comment: "What most values read as: whole number, number, date, yes/no, text or empty." },
  { name: "type_share", comment: "The share of values that read as the type, 0 to 1." },
  { name: "min", comment: "The smallest value, as the type compares them. Empty for a column of a person's numbers." },
  { name: "max", comment: "The largest value, as the type compares them. Empty for a column of a person's numbers." },
  { name: "longest", comment: "The longest value's length." },
  { name: "examples", comment: "The most common values and the rows that hold each, as JSON." },
  { name: "odd", comment: "A few values that do not read as the type, as JSON." },
  { name: "reads", comment: "What most values read as, in more words: money and a date with a time apart." },
  { name: "formats", comment: "The formats the values are written in, with the rows of each, as JSON." },
  { name: "fact", comment: "The one fact about the column that matters most before it is cleaned." },
  { name: "points_at", comment: "The table and column it points at, with the rows that find their row and the rows that do not, as JSON." },
  { name: "personal", comment: "Why its values are kept back: a tax id, a birth date, a secret. Empty for any other column." },
  { name: "profile", comment: "The column's whole profile, as JSON." },
];

/** The profile table's form: its columns as PROFILE_COLUMNS lists them. Raise it with them. */
const PROFILE_FORM = 2;

/** Whether a table holds a column of that name; false for a table that is not there. */
function hasColumn(sql: JobContext<ProfileParams, ProfileState>["sql"], table: string, column: string): boolean {
  return sql.exec<{ name: string }>("SELECT name FROM pragma_table_info(?)", table).toArray().some((c) => c.name === column);
}

/** A column's smallest and largest as its PROFILE row keeps them: a range for numbers and days, else its text's. */
function boundsOf(c: ColumnProfile): [string | null, string | null] {
  if (c.personal) return [null, null];
  if (c.range && c.range.low !== "") return [String(c.range.low), String(c.range.high)];
  return [c.first ?? null, c.last ?? null];
}

/** The profile's rows as a run's step gives them, read back from the table it made. */
function profiledColumns(ctx: JobContext<ProfileParams, ProfileState>, into: string, rows: number): ProfiledColumn[] {
  return ctx.sql
    .exec<Record<string, StoreSqlValue>>(`SELECT column_name, filled, distinct_values, type, type_share, fact FROM ${ident(into)} ORDER BY position`)
    .toArray()
    .map((r) => ({
      column: String(r.column_name),
      filled: rows ? Math.round((Number(r.filled) / rows) * 10_000) / 10_000 : 0,
      distinct: Number(r.distinct_values),
      type: String(r.type) as ProfileType,
      typeShare: Number(r.type_share),
      ...(r.fact ? { fact: String(r.fact) } : {}),
    }));
}

export const profileHandler: JobHandler<ProfileParams, ProfileState, ProfileResult> = {
  kind: "profile",

  // What it read when it made its profile: Undo This Run writes it back with the profile it puts
  // back, so the next run profiles the table again rather than keep the profile from before the run.
  memoryKeys: (params) => [`profile:${params.table}`],

  parse(params) {
    if (!isRecord(params)) throw new JobParamsError("PROFILE takes the table to profile and the profile table to make.");
    const { table, into } = params;
    if (typeof table !== "string" || !table || table.length > 200) throw new JobParamsError("PROFILE takes the name of the table to profile.");
    if (typeof into !== "string" || !NAME.test(into) || /__(?:v\d+|new)$/.test(into) || isReservedName(into)) {
      throw new JobParamsError(`"${String(into)}" cannot name a table: use lowercase words joined by underscores.`);
    }
    if (into === table) throw new JobParamsError("A profile is a table of its own: give it another name than the table it profiles.");
    const madeBy = madeByOf(params.madeBy);
    if (!madeBy) throw new JobParamsError("madeBy names the run and the step, or nothing.");
    return { table, into, madeBy };
  },

  async run(ctx) {
    const { table, into } = ctx.params;
    const sql = ctx.sql;
    const state: ProfileState = ctx.state ? { ...ctx.state } : { at: 0, begun: false };
    // A job begun before the profile table had its present columns starts its table again.
    if (state.begun && !hasColumn(sql, `${into}__new`, "profile")) {
      state.at = 0;
      state.begun = false;
    }
    dataTable(sql, table);
    const own = tableRecord(sql, into);
    if (own && own.grp !== PROFILE_GROUP) throw new StoreError(400, "bad_request", `${into} is a table of another kind. Give the profile another name.`);
    // Which change of the table this profile reads: a managed table changes with no record of it.
    const change = sql.exec<{ kind: string; version: number; updated_at: string }>("SELECT kind, version, updated_at FROM _tables WHERE name = ?", table).toArray()[0];
    // The profile's own form is part of what it read: a profile made in an older form, with fewer
    // columns, is never read back as this one.
    const read = change?.kind === "program" ? JSON.stringify([into, Number(change.version), String(change.updated_at), PROFILE_FORM]) : null;
    const unchanged = !ctx.state && own !== null && read !== null && getMeta(sql, `profile:${table}`) === read;
    if (!unchanged && !committedBy(sql, ctx.job.id, into)) {
      const columns = columnsOf(sql, table);
      const rows = Number(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${ident(table)}`).one().n);
      const progress = (done: number) => ({ done, total: columns.length, note: `Profiling ${table}` });
      if (!state.begun) {
        const fresh = ctx.tables.begin(into);
        state.begun = true;
        ctx.commit({ state, progress: progress(0) }, () => void sql.exec(PROFILE_DDL(fresh)));
      }
      // The store's tables as its catalog says them: the one profiled, and those its columns may point at.
      const catalog = catalogOf(sql, () => ctx.now(), () => ctx.databaseSize());
      const of = catalog.tables.find((t) => t.name === table) ?? { name: table, count: rows, columns: columns.map((name) => ({ name })) };
      while (state.at < columns.length) {
        await turn();
        if (ctx.now() >= ctx.deadline) return { more: true };
        const part = columns.slice(state.at, state.at + PROFILE_AT_ONCE);
        const profile = await profileTable(async (statement, limit) => sql.exec<Record<string, StoreSqlValue>>(statement).toArray().slice(0, limit), of, {
          columns: part,
          rows: null,
          tables: catalog.tables,
          textBounds: true,
          between: turn,
        });
        const from = state.at;
        state.at += part.length;
        ctx.commit({ state, progress: progress(state.at) }, () => {
          profile.columns.forEach((c, i) => {
            const [min, max] = boundsOf(c);
            sql.exec(
              `INSERT INTO ${ident(`${into}__new`)} (column_name, position, filled, filled_share, distinct_values, type, type_share, min, max, longest, examples, odd, reads, formats, fact, points_at, personal, profile) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              c.name,
              from + i + 1,
              c.filled,
              rows ? Math.round((c.filled / rows) * 10_000) / 10_000 : 0,
              c.distinct,
              profileTypeOf(c.reads),
              c.readsShare,
              min,
              max,
              c.filled ? c.longest : null,
              JSON.stringify(c.common),
              JSON.stringify(c.odd?.examples ?? []),
              c.reads,
              JSON.stringify(c.formats ?? []),
              factWords(c.fact),
              c.link ? JSON.stringify(c.link) : null,
              c.personal?.why ?? null,
              JSON.stringify(c),
            );
          });
        });
      }
      await ctx.tables.commit(into, {
        group: PROFILE_GROUP,
        madeBy: ctx.params.madeBy,
        columns: PROFILE_COLUMNS,
        comment: `Each column of ${table}: how full it is, how many values it has, and what they read as.`,
        dropOld: true,
      });
      // The catalog's column heads take the whole table's numbers, until the table's next version.
      ctx.commit({ state, progress: progress(columns.length) }, () => {
        for (const r of sql.exec<{ column_name: string; filled_share: number; distinct_values: number }>(`SELECT column_name, filled_share, distinct_values FROM ${ident(into)}`).toArray()) {
          sql.exec(
            "INSERT INTO _columns (tbl, name, filled, distinct_n) VALUES (?, ?, ?, ?) ON CONFLICT (tbl, name) DO UPDATE SET filled = excluded.filled, distinct_n = excluded.distinct_n WHERE _columns.filled IS NOT excluded.filled OR _columns.distinct_n IS NOT excluded.distinct_n",
            table,
            String(r.column_name),
            Number(r.filled_share),
            Number(r.distinct_values),
          );
        }
        if (read) setMeta(sql, `profile:${table}`, read);
      });
    }
    const made = handleOf(sql, into);
    const of = unchanged ? handleOf(sql, table) : { table, version: tableRecord(sql, table)?.version ?? 1, rows: Number(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${ident(table)}`).one().n) };
    return { result: { ...made, of, columns: profiledColumns(ctx, into, of.rows) } };
  },
};
