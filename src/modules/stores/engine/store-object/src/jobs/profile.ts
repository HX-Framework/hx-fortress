// PROFILE: what each column of a store's table holds, over every row (Stores, Part A, slice E).
// store_profile (the api's agent/tools/store-cleanup.ts) submits it. Per column: how
// many rows hold a value, how many distinct values, what most values read as (a whole number, a
// number, a date, yes or no, text) and how many do, the smallest and largest, the longest, the most
// common values with their rows, and a few that do not read as the rest. The answer is a program
// table `<table>_profile` (group "Profiles"), one row per column, and the store's catalog takes the
// exact fill and distinct count of each column, so the column heads show the whole table's numbers
// until the table's next version. A store keeps one profile of a table: a run's rows replace the
// last run's, whose copy is dropped. Its params and its answer are `store-readers/jobs`.
//
// A program's table that has not changed since its last profile is not read again: the store keeps
// under `profile:<table>` which version and change that profile read.
//
// A chunk reads PROFILE_AT_ONCE columns' counts in one pass over the table (each column
// costs 13 of the at most 100 columns a result holds), then each of them once more for its
// distinct values and the most common ones, and commits their rows with its place.

import { madeByOf, MAX_TABLE_NAME, PROFILE_GROUP, type ProfiledColumn, type ProfileParams, type ProfileResult, type ProfileType } from "../../../store-readers/src/jobs.js";
import { StoreError } from "../core.js";
import { getMeta, setMeta } from "../schema.js";
import { isReservedName, type StoreSqlValue } from "../sql.js";
import { columnsOf, committedBy, dataTable, dateSql, handleOf, ident, isoDateSql, numberOf, numberSql, tableRecord, trimmed, turn, wholeSql, yesNoSql } from "./cleanup-sql.js";
import { type JobContext, type JobHandler, JobParamsError } from "./types.js";

/** Columns one pass reads: 1 + 13 a column stays under workerd's 100 result columns. */
export const PROFILE_AT_ONCE = 7;
/** The most common values a profile row keeps, and the odd ones. */
const EXAMPLES = 5;
/** The longest value a profile row quotes. */
const QUOTE_MAX = 120;

export interface ProfileState {
  /** The next column to read. */
  at: number;
  /** `<into>__new` is made. */
  begun: boolean;
}

const NAME = new RegExp(`^[a-z][a-z0-9_]{0,${MAX_TABLE_NAME - 1}}$`);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const quote = (text: string | null): string | null => (text === null ? null : text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX)}…` : text);

/** What most of a column's values read as, and the share that do. */
export function profileType(c: { filled: number; whole: number; number: number; date: number; yesNo: number }): { type: ProfileType; share: number } {
  if (c.filled === 0) return { type: "empty", share: 0 };
  const share = (n: number) => n / c.filled;
  const options: { type: ProfileType; share: number }[] = [
    { type: "date", share: share(c.date) },
    { type: c.whole === c.number ? "whole number" : "number", share: share(c.number) },
    { type: "yes/no", share: share(c.yesNo) },
  ];
  options.sort((a, b) => b.share - a.share);
  const best = options[0]!;
  if (best.share >= 0.5) return best;
  return { type: "text", share: 1 - best.share };
}

/** The expression a value of `type` passes, over trimmed text `v`; null for text and empty. */
function typeTest(type: ProfileType, v: string): string | null {
  switch (type) {
    case "whole number":
      return wholeSql(v);
    case "number":
      return numberSql(v);
    case "date":
      return dateSql(v);
    case "yes/no":
      return yesNoSql(v);
    default:
      return null;
  }
}

const PROFILE_DDL = (table: string) =>
  `CREATE TABLE ${ident(table)} (column_name TEXT NOT NULL, position INTEGER NOT NULL, filled INTEGER NOT NULL, filled_share REAL NOT NULL, distinct_values INTEGER NOT NULL, type TEXT NOT NULL, type_share REAL NOT NULL, min TEXT, max TEXT, longest INTEGER, examples TEXT, odd TEXT)`;

const PROFILE_COLUMNS = [
  { name: "column_name", comment: "The column of the table profiled." },
  { name: "position", comment: "Where the column stands in the table, from 1." },
  { name: "filled", comment: "Rows with a value: not empty, and not only spaces." },
  { name: "filled_share", comment: "The share of rows with a value, 0 to 1." },
  { name: "distinct_values", comment: "Distinct values, without spaces at either end." },
  { name: "type", comment: "What most values read as: whole number, number, date, yes/no, text or empty." },
  { name: "type_share", comment: "The share of values that read as the type, 0 to 1." },
  { name: "min", comment: "The smallest value, as the type compares them." },
  { name: "max", comment: "The largest value, as the type compares them." },
  { name: "longest", comment: "The longest value's length." },
  { name: "examples", comment: "The most common values and the rows that hold each, as JSON." },
  { name: "odd", comment: "A few values that do not read as the type, as JSON." },
];

interface ColumnFacts {
  column: string;
  position: number;
  filled: number;
  distinct: number;
  type: ProfileType;
  share: number;
  min: string | null;
  max: string | null;
  longest: number | null;
  examples: { value: string; rows: number }[];
  odd: string[];
}

/** One pass over the table for a few columns' counts, then each column's distinct and odd values. */
function readColumns(ctx: JobContext<ProfileParams, ProfileState>, table: string, part: string[], from: number): ColumnFacts[] {
  const sql = ctx.sql;
  const t = ident(table);
  const inner = part.map((c, i) => `${trimmed(ident(c))} AS v${i}`).join(", ");
  const outer = ["count(*) AS n"];
  part.forEach((_, i) => {
    const v = `v${i}`;
    const filled = `${v} <> ''`;
    outer.push(
      `sum(CASE WHEN ${filled} THEN 1 ELSE 0 END) AS f${i}`,
      `sum(CASE WHEN ${filled} AND ${wholeSql(v)} THEN 1 ELSE 0 END) AS w${i}`,
      `sum(CASE WHEN ${filled} AND ${numberSql(v)} THEN 1 ELSE 0 END) AS u${i}`,
      `sum(CASE WHEN ${filled} AND ${dateSql(v)} THEN 1 ELSE 0 END) AS t${i}`,
      `sum(CASE WHEN ${filled} AND ${yesNoSql(v)} THEN 1 ELSE 0 END) AS b${i}`,
      `max(length(${v})) AS l${i}`,
      `min(CASE WHEN ${filled} AND ${numberSql(v)} THEN ${numberOf(v)} END) AS nmin${i}`,
      `max(CASE WHEN ${filled} AND ${numberSql(v)} THEN ${numberOf(v)} END) AS nmax${i}`,
      `min(CASE WHEN ${filled} THEN ${isoDateSql(v)} END) AS dmin${i}`,
      `max(CASE WHEN ${filled} THEN ${isoDateSql(v)} END) AS dmax${i}`,
      `min(CASE WHEN ${filled} THEN ${v} END) AS smin${i}`,
      `max(CASE WHEN ${filled} THEN ${v} END) AS smax${i}`,
    );
  });
  const counts = sql.exec<Record<string, StoreSqlValue>>(`SELECT ${outer.join(", ")} FROM (SELECT ${inner} FROM ${t})`).one();
  return part.map((column, i) => {
    const n = (key: string) => Number(counts[`${key}${i}`] ?? 0);
    const text = (key: string) => {
      const value = counts[`${key}${i}`];
      return value === null || value === undefined ? null : String(value);
    };
    const filled = n("f");
    const { type, share } = profileType({ filled, whole: n("w"), number: n("u"), date: n("t"), yesNo: n("b") });
    const [min, max] = type === "whole number" || type === "number" ? [text("nmin"), text("nmax")] : type === "date" ? [text("dmin"), text("dmax")] : [text("smin"), text("smax")];
    const values = `(SELECT ${trimmed(ident(column))} AS v FROM ${t})`;
    // The column's values counted once: their number, and the most common of them.
    const common = sql
      .exec<{ v: string; n: number; d: number }>(
        `WITH g AS MATERIALIZED (SELECT v, count(*) AS n FROM ${values} WHERE v <> '' GROUP BY v) SELECT v, n, (SELECT count(*) FROM g) AS d FROM g ORDER BY n DESC, v LIMIT ${EXAMPLES}`,
      )
      .toArray();
    const test = typeTest(type, "v");
    const odd =
      test && share < 1
        ? sql
            .exec<{ v: string }>(`SELECT DISTINCT v FROM ${values} WHERE v <> '' AND NOT ${test} LIMIT ${EXAMPLES}`)
            .toArray()
            .map((r) => quote(String(r.v))!)
        : [];
    return {
      column,
      position: from + i + 1,
      filled,
      distinct: common.length ? Number(common[0]!.d) : 0,
      type,
      share: Math.round(share * 10_000) / 10_000,
      min: quote(min),
      max: quote(max),
      longest: filled ? n("l") : null,
      examples: common.map((r) => ({ value: quote(String(r.v))!, rows: Number(r.n) })),
      odd,
    } satisfies ColumnFacts;
  });
}

/** The profile's rows as a run's step gives them, read back from the table it made. */
function profiledColumns(ctx: JobContext<ProfileParams, ProfileState>, into: string, rows: number): ProfiledColumn[] {
  return ctx.sql
    .exec<Record<string, StoreSqlValue>>(`SELECT column_name, filled, distinct_values, type, type_share FROM ${ident(into)} ORDER BY position`)
    .toArray()
    .map((r) => ({
      column: String(r.column_name),
      filled: rows ? Math.round((Number(r.filled) / rows) * 10_000) / 10_000 : 0,
      distinct: Number(r.distinct_values),
      type: String(r.type) as ProfileType,
      typeShare: Number(r.type_share),
    }));
}

export const profileHandler: JobHandler<ProfileParams, ProfileState, ProfileResult> = {
  kind: "profile",

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
    dataTable(sql, table);
    const own = tableRecord(sql, into);
    if (own && own.grp !== PROFILE_GROUP) throw new StoreError(400, "bad_request", `${into} is a table of another kind. Give the profile another name.`);
    // Which change of the table this profile reads: a managed table changes with no record of it.
    const change = sql.exec<{ kind: string; version: number; updated_at: string }>("SELECT kind, version, updated_at FROM _tables WHERE name = ?", table).toArray()[0];
    const read = change?.kind === "program" ? JSON.stringify([into, Number(change.version), String(change.updated_at)]) : null;
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
      while (state.at < columns.length) {
        await turn();
        if (ctx.now() >= ctx.deadline) return { more: true };
        const part = columns.slice(state.at, state.at + PROFILE_AT_ONCE);
        const facts = readColumns(ctx, table, part, state.at);
        state.at += part.length;
        ctx.commit({ state, progress: progress(state.at) }, () => {
          for (const f of facts) {
            sql.exec(
              `INSERT INTO ${ident(`${into}__new`)} (column_name, position, filled, filled_share, distinct_values, type, type_share, min, max, longest, examples, odd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              f.column,
              f.position,
              f.filled,
              rows ? Math.round((f.filled / rows) * 10_000) / 10_000 : 0,
              f.distinct,
              f.type,
              f.share,
              f.min,
              f.max,
              f.longest,
              JSON.stringify(f.examples),
              JSON.stringify(f.odd),
            );
          }
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
