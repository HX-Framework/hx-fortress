// CHECK: rules a program states, tested on the rows of a store's table (Stores, Part A, slice E).
// store_check (the api's agent/tools/store-cleanup.ts) submits the rules: the program's
// own, or the ones a model wrote from its words. Each rule is one SQL test SQLite runs over the
// table; each row that breaks it has a flag in `<table>_flags` (group "To review"): the row's rowid
// in the table checked, what names the row on later runs (its `_file` and `_row`, or the columns the
// program names), the rule, the problem in words, the column and what the town wrote there. CHECK
// never deletes or changes a row of the table it checks.
//
// The flags table is made by the first run and changed in place after it: a run closes the open
// flags whose row keeps the rule now, flags the rows that break it and have no open flag for it, and
// writes nothing else. It tests only the rows that changed since its last run, by the store's record
// (deltas.ts), or the rows `changed` names. A unique rule always reads every row, since a row that
// did not change can be the other half of a repeat, and so does a reference rule whose table changed.
// When the rules, the row's key or the table's version changed since the last run (a new version
// has other rowids), it clears the flags and tests every row. The store keeps the rules under `checkKey(table)`, with
// the table's version the flags were made for, so a person's fix on the Tables tab is checked
// against the same rules (store/review.ts).
//
// The rules: required (a value), unique (no two rows alike), format (a date, a number, a whole
// number, an email address, a phone number, a ZIP code, or a GLOB pattern), range (numbers or
// dates), one of (a fixed list), and reference (a value of another table's column). Any rule may
// hold only on the rows that meet conditions on other columns (`when`: "an ISSUED permit has an
// issue date"), and a range of days may count from the day the check runs ("today", "today-30"),
// worked out on the clock of the person it runs for (`zone`). Such a rule reads every row on the
// first run of a new day, since a row that did not change can break it now, or keep it now; on
// the same day it reads only what changed, as the other rules do. A range's bound, or a
// condition's, may be another column of the same row ("no permit is finaled before it is
// issued": `{ column: "issued_on" }`, maybe moved by some days), read as the range reads its own
// value; with only such bounds, a day is compared with a day and a number with a number, and a
// flag says its row's words, "before" for days and "below" for numbers.

import {
  type CheckBound,
  boundOn,
  boundsKind,
  type ChangedRows,
  changedRowsOf,
  checkDayIn,
  checkRuleColumns,
  checkRulesOf,
  type CheckParams,
  type CheckResult,
  type CheckRule,
  type CheckWhen,
  checkKey,
  isColumnBound,
  madeByOf,
  MAX_TABLE_NAME,
  REVIEW_GROUP,
  type RowReads,
  ruleNamesToday,
  ruleWordPieces,
  ruleWords,
  type SavedCheck,
  uncheckedOf,
  zoneOf,
} from "../../../store-readers/src/jobs.js";
import { StoreError } from "../core.js";
import { lastChange } from "../deltas.js";
import { savedJson, setMeta } from "../schema.js";
import { isReservedName, type SqlLike } from "../sql.js";
import { asLastRead, changes, columnIn, columnsOf, committedBy, dataTable, emailSql, handleOf, hasValue, ident, inChanged, isoDateSql, keyOf, literal, numberOf, numberSql, phoneSql, tableRecord, trimmed, turn, wholeSql, zipSql, rowsSinceLastRun, type StepRows, EVERY_ROW } from "./cleanup-sql.js";
import { type JobHandler, JobParamsError, type ProgramTableColumn } from "./types.js";

/** The most rows one rule flags: past it, the rule is too wide to review row by row. */
export const FLAGS_PER_RULE_MAX = 50_000;

export interface CheckState {
  /** The next rule to run. */
  at: number;
  begun: boolean;
  /** This run makes the flags table: no run made it before. */
  first: boolean | null;
  /** This run cleared the flags before it: the rules, the row's key or the table's version changed. */
  reset: boolean;
  /** Rules that hold FLAGS_PER_RULE_MAX open flags, and stopped there. */
  capped: number[];
  /** Flags this run opened and closed. */
  opened: number;
  closed: number;
  /** The day "today" is for this run, on the zone's clock: worked out once, so a run that goes past midnight reads one day. */
  today?: string;
  /** The rules that count from today read every row: this is the first run on this day, or on this zone. */
  newDay?: boolean;
}

const NAME = new RegExp(`^[a-z][a-z0-9_]{0,${MAX_TABLE_NAME - 1}}$`);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export const FLAG_COLUMNS: ProgramTableColumn[] = [
  { name: "id", comment: "The flag's own number." },
  { name: "row_id", comment: "The row's rowid in the table checked, in the version the check read." },
  { name: "row_key", comment: "What names the row on later runs, as JSON: its file and row, or the columns the program named." },
  { name: "rule", comment: "Which rule it broke: its place in the check's rules, from 0." },
  { name: "problem", comment: "What is wrong, in words." },
  { name: "column_name", comment: "The column the problem is in." },
  { name: "value", comment: "What the cell held." },
  { name: "state", comment: "open, or fixed once a person's fix keeps the rule." },
  { name: "fixed_by", comment: "Who fixed it." },
  { name: "fixed_at", comment: "When it was fixed." },
];

const FLAGS_DDL = (table: string) =>
  `CREATE TABLE ${ident(table)} (id INTEGER PRIMARY KEY, row_id INTEGER NOT NULL, row_key TEXT NOT NULL, rule INTEGER NOT NULL, problem TEXT NOT NULL, column_name TEXT, value TEXT, state TEXT NOT NULL DEFAULT 'open', fixed_by TEXT, fixed_at TEXT)`;

/** The column a rule's flag is about: the rule's one column, or a unique rule's first. */
export const ruleColumn = (rule: CheckRule): string | null => ("column" in rule ? rule.column : (rule.columns[0] ?? null));

/** The columns a rule reads of the row: its own, and those its `when` names. */
export const ruleColumns = checkRuleColumns;

const given = (b: CheckBound | null | undefined): b is CheckBound => b !== undefined && b !== null;

/** A day moved by some days, as SQLite's `date()` takes it: "+180 days", "-30 days". */
const daysModifier = (days: number): string => literal(`${days > 0 ? "+" : ""}${days} days`);

/**
 * The SQL of a bound as a row of alias `a` compares it, read as `reads`, on `today` for a day that
 * counts from it. Another column is its trimmed value as a day (moved by its days) or as a number,
 * and NULL on a row where it holds none: SQL then says neither that a value lies within the bound
 * nor that it lies past it.
 */
function boundSql(b: CheckBound, a: string, reads: RowReads, today: string): string {
  if (isColumnBound(b)) {
    const other = trimmed(`${a}.${ident(b.column)}`);
    if (reads === "numbers") return `(CASE WHEN ${numberSql(other)} THEN ${numberOf(other)} END)`;
    return b.days ? `date(${isoDateSql(other)}, ${daysModifier(b.days)})` : isoDateSql(other);
  }
  return reads === "days" ? literal(String(boundOn(b, today))) : String(Number(b));
}

/**
 * The SQL of the value in `column` of a row of alias `a` against a range's bounds, on `today` for a
 * bound that counts from it: `inside` is true when it has a value that reads as the bounds' kind (a
 * number or a day) and lies within them, `outside` when it reads as that kind and lies past one. A
 * range whose bounds are only other columns (`BoundsKind` "row") reads both kinds, a day against a
 * day and a number against a number. A value that reads as neither is in neither, and so is one
 * whose other column holds no value of that kind, unless it lies past a bound that has one: SQL's
 * NULL is neither true nor false. Both are 0 or 1, never NULL.
 *
 * Each value is written once (`BETWEEN` reads its left side once), since a day's test is long and
 * a store runs statements of at most 100 KB. A day's test is NULL for what is no day, so it needs
 * no test of its own; a number's needs `numberSql`, since `numberOf` reads any text as a number.
 */
function rangeSql(a: string, column: string, min: CheckBound | null | undefined, max: CheckBound | null | undefined, today: string): { inside: string; outside: string } {
  const col = `${a}.${ident(column)}`;
  const v = trimmed(col);
  const kind = boundsKind(min, max);
  const readings = (kind === "row" ? ["days", "numbers"] : [kind]) as RowReads[];
  const sides = readings.map((reads) => {
    const x = reads === "days" ? isoDateSql(v) : numberOf(v);
    const lo = given(min) ? boundSql(min, a, reads, today) : null;
    const hi = given(max) ? boundSql(max, a, reads, today) : null;
    const within = lo && hi ? `${x} BETWEEN ${lo} AND ${hi}` : lo ? `${x} >= ${lo}` : `${x} <= ${hi}`;
    const isIt = reads === "numbers" ? `${numberSql(v)} AND ` : "";
    return { inside: `(${isIt}(${within}))`, outside: `(${isIt}NOT (${within}))` };
  });
  const either = (side: "inside" | "outside") => sides.map((s) => s[side]).join(" OR ");
  return { inside: `coalesce(${hasValue(col)} AND (${either("inside")}), 0)`, outside: `coalesce(${hasValue(col)} AND (${either("outside")}), 0)` };
}

/** The SQL that is true for a row of alias `a` that meets a condition of a rule's `when`: 0 or 1, never NULL. */
export function conditionSql(c: CheckWhen, a: string, today: string): string {
  const col = `${a}.${ident(c.column)}`;
  const isOneOf = (values: readonly string[]) => `coalesce(${hasValue(col)} AND ${keyOf(col)} IN (SELECT ${keyOf("e.value")} FROM json_each(${literal(JSON.stringify(values))}) e), 0)`;
  if ("values" in c) return isOneOf(c.values);
  if ("not" in c) return `(NOT ${isOneOf(c.not)})`;
  if ("filled" in c) return c.filled ? hasValue(col) : `(NOT ${hasValue(col)})`;
  return rangeSql(a, c.column, c.min, c.max, today).inside;
}

/**
 * The SQL of a flag's words for a row of alias `a` that breaks the rule: its words, where a range
 * compared row by row says those of what the row's value in its column reads as, days' or numbers'.
 * Such a row's value reads as one of the two, so the shorter test, a number's, tells them apart.
 */
export function problemSql(rule: CheckRule, a: string): string {
  const pieces = ruleWordPieces(rule).map((p) =>
    typeof p === "string" ? literal(p) : `(CASE WHEN ${numberSql(trimmed(`${a}.${ident(p.column)}`))} THEN ${literal(p.numbers)} ELSE ${literal(p.days)} END)`,
  );
  return pieces.join(" || ");
}

/** Whether a rule's words depend on what a row's values read as: it holds a range compared row by row. */
export const wordsByRow = (rule: CheckRule): boolean => ruleWordPieces(rule).some((p) => typeof p !== "string");

/** The SQL that is true for a row of alias `a` that a rule holds on: every condition of its `when`; null for a rule with none. */
export function whenSql(rule: CheckRule, a: string, today: string): string | null {
  return rule.when?.length ? `(${rule.when.map((c) => conditionSql(c, a, today)).join(" AND ")})` : null;
}

/** A value's test for a format, over trimmed text `v`. */
function formatSql(rule: Extract<CheckRule, { rule: "format" }>, v: string): string {
  switch (rule.format) {
    case "date":
      return `(${isoDateSql(v)} IS NOT NULL)`;
    case "number":
      return numberSql(v);
    case "whole number":
      return wholeSql(v);
    case "email":
      return emailSql(v);
    case "phone":
      return phoneSql(v);
    case "zip":
      return zipSql(v);
    case "pattern":
      return `(${v} GLOB ${literal(rule.pattern ?? "*")})`;
  }
}

/** A unique rule's key over a row of alias `a`: its columns' answer keys, one after another. */
export const uniqueKey = (rule: Extract<CheckRule, { rule: "unique" }>, a: string): string => rule.columns.map((c) => keyOf(`${a}.${ident(c)}`)).join(` || char(31) || `);

/** Whether a row of alias `a` counts for a unique rule: every column filled, and the rule's `when` met. */
export function allFilled(rule: Extract<CheckRule, { rule: "unique" }>, a: string, today: string): string {
  const filled = rule.columns.map((c) => hasValue(`${a}.${ident(c)}`)).join(" AND ");
  const when = whenSql(rule, a, today);
  return when ? `${filled} AND ${when}` : filled;
}

/**
 * The SQL that is true for a row (alias `t`) of `table` that breaks the rule, on `today` (YYYY-MM-DD)
 * for a bound that counts from it. A rule with `when` is broken only by a row that meets it; a
 * unique rule's repeats are counted among those rows alone.
 */
export function brokenSql(rule: CheckRule, table: string, today: string): string {
  const col = (c: string) => `t.${ident(c)}`;
  if (rule.rule === "unique") {
    return `(${allFilled(rule, "t", today)} AND ${uniqueKey(rule, "t")} IN (SELECT k FROM (SELECT ${uniqueKey(rule, "u")} AS k, count(*) AS n FROM ${ident(table)} u WHERE ${allFilled(rule, "u", today)} GROUP BY 1) WHERE n > 1))`;
  }
  const own = ((): string => {
    switch (rule.rule) {
      case "required":
        return `(${rule.columns.map((c) => `NOT ${hasValue(col(c))}`).join(" OR ")})`;
      case "format":
        return `(${hasValue(col(rule.column))} AND NOT ${formatSql(rule, trimmed(col(rule.column)))})`;
      case "range":
        return rangeSql("t", rule.column, rule.min, rule.max, today).outside;
      case "one_of":
        return `(${hasValue(col(rule.column))} AND ${keyOf(col(rule.column))} NOT IN (SELECT ${keyOf("e.value")} FROM json_each(${literal(JSON.stringify(rule.values))}) e))`;
      case "reference":
        return `(${hasValue(col(rule.column))} AND ${keyOf(col(rule.column))} NOT IN (SELECT ${keyOf(`r.${ident(rule.to)}`)} FROM ${ident(rule.table)} r WHERE ${hasValue(`r.${ident(rule.to)}`)}))`;
    }
  })();
  const when = whenSql(rule, "t", today);
  return when ? `(${when} AND ${own})` : own;
}

/** The columns that name a row across runs: the program's, else `_file` and `_row` when the table has them. */
export function identityOf(columns: readonly string[], key: string[] | null): string[] | null {
  if (key?.length) return key;
  return columns.includes("_file") && columns.includes("_row") ? ["_file", "_row"] : null;
}

/** The SQL of a row's identity as JSON: its key columns, or its rowid when it has none. */
export const rowKeySql = (identity: string[] | null): string =>
  identity ? `json_object(${identity.map((c) => `${literal(c)}, t.${ident(c)}`).join(", ")})` : "json_object('rowid', t.rowid)";

/** Checks every name a rule reads: its columns in the table, and a reference's table and column. */
function checkRuleNames(sql: SqlLike, table: string, columns: readonly string[], rule: CheckRule): void {
  for (const c of ruleColumns(rule)) columnIn(columns, table, c);
  if (rule.rule === "reference") {
    dataTable(sql, rule.table);
    columnIn(columnsOf(sql, rule.table), rule.table, rule.to);
  }
}

/** The rows one rule is tested on, when the store's record says which rows changed. */
function ruleRows(sql: SqlLike, rule: CheckRule, reader: string, rows: StepRows): StepRows {
  if (rows.whole) return rows;
  // A row can break a unique rule because of another row, whose own value did not change.
  if (rule.rule === "unique") return rows.none ? rows : EVERY_ROW;
  if (rule.rule === "reference" && !asLastRead(sql, reader, rule.table)) return EVERY_ROW;
  return rows;
}

/** The rules the last CHECK of a table ran with, as the store keeps them; null when none did. */
export const savedCheck = (sql: SqlLike, table: string): SavedCheck | null => savedJson<SavedCheck>(sql, checkKey(table));

/**
 * Tests one rule over the rows `scope` names and changes only what differs: an open flag whose row
 * keeps the rule now ends as `closing` says (dropped by a run, fixed by a person's answer, or left
 * when a run starts the flags afresh), an open flag's value follows its row, and a row that breaks
 * the rule with no open flag for it gets one. It answers what it opened and closed, and whether the
 * rule holds as many open flags as it may.
 */
export function retestRule(
  sql: SqlLike,
  o: { table: string; flags: string; rule: CheckRule; at: number; identity: string[] | null; scope: { where: string; params: unknown[] }; closing: "none" | "delete" | { by: string; at: string }; today: string },
): { opened: number; closed: number; capped: boolean } {
  const table = ident(o.table);
  const flags = ident(o.flags);
  const column = ruleColumn(o.rule);
  const value = column ? `CAST(t.${ident(column)} AS TEXT)` : "NULL";
  // Over the whole table no rowid list is needed: `WHERE 1` would make SQLite scan the table for one.
  const inScope = o.scope.where === "1" ? "" : ` AND row_id IN (SELECT t.rowid FROM ${table} t WHERE ${o.scope.where})`;
  const scopeParams = inScope ? o.scope.params : [];
  let closed = 0;
  if (o.closing !== "none") {
    const keepsIt = `rule = ? AND state = 'open'${inScope} AND row_id NOT IN (SELECT t.rowid FROM ${table} t WHERE ${o.scope.where} AND ${brokenSql(o.rule, o.table, o.today)})`;
    if (o.closing === "delete") sql.exec(`DELETE FROM ${flags} WHERE ${keepsIt}`, o.at, ...scopeParams, ...o.scope.params);
    else sql.exec(`UPDATE ${flags} SET state = 'fixed', fixed_by = ?, fixed_at = ? WHERE ${keepsIt}`, o.closing.by, o.closing.at, o.at, ...scopeParams, ...o.scope.params);
    closed = changes(sql);
    if (column) {
      sql.exec(
        `UPDATE ${flags} SET value = (SELECT ${value} FROM ${table} t WHERE t.rowid = ${flags}.row_id)
         WHERE rule = ? AND state = 'open'${inScope} AND value IS NOT (SELECT ${value} FROM ${table} t WHERE t.rowid = ${flags}.row_id)`,
        o.at,
        ...scopeParams,
      );
    }
  }
  const openNow = (): number => Number(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${flags} WHERE rule = ? AND state = 'open'`, o.at).one().n);
  const room = FLAGS_PER_RULE_MAX - openNow();
  let opened = 0;
  if (room > 0) {
    sql.exec(
      `INSERT INTO ${flags} (row_id, row_key, rule, problem, column_name, value, state)
       SELECT t.rowid, ${rowKeySql(o.identity)}, ?, ${problemSql(o.rule, "t")}, ?, ${value}, 'open'
       FROM ${table} t WHERE ${o.scope.where} AND ${brokenSql(o.rule, o.table, o.today)} AND t.rowid NOT IN (SELECT row_id FROM ${flags} WHERE rule = ? AND state = 'open') LIMIT ${room}`,
      o.at,
      column,
      ...o.scope.params,
      o.at,
    );
    opened = changes(sql);
  }
  return { opened, closed, capped: openNow() >= FLAGS_PER_RULE_MAX };
}

export const checkHandler: JobHandler<CheckParams, CheckState, CheckResult> = {
  kind: "check",

  parse(params) {
    if (!isRecord(params)) throw new JobParamsError("CHECK takes the table to check, its rules and the flags table to make.");
    const { table, into } = params;
    if (typeof table !== "string" || !table || table.length > 200) throw new JobParamsError("CHECK takes the name of the table to check.");
    if (typeof into !== "string" || !NAME.test(into) || /__(?:v\d+|new)$/.test(into) || isReservedName(into)) {
      throw new JobParamsError(`"${String(into)}" cannot name a table: use lowercase words joined by underscores.`);
    }
    if (into === table) throw new JobParamsError("The flags are a table of their own: give it another name than the table checked.");
    let rules: CheckRule[];
    try {
      rules = checkRulesOf(params.rules);
    } catch (error) {
      throw new JobParamsError(error instanceof Error ? error.message : String(error));
    }
    const key = params.key === null || params.key === undefined ? null : Array.isArray(params.key) ? params.key.map(String) : [String(params.key)];
    if (key && (key.length > 5 || key.some((k) => !k.trim()))) throw new JobParamsError("A row's key is one to five of its columns.");
    let changed: ChangedRows | null;
    try {
      changed = changedRowsOf(params.changed);
    } catch (error) {
      throw new JobParamsError(error instanceof Error ? error.message : String(error));
    }
    const madeBy = madeByOf(params.madeBy);
    if (!madeBy) throw new JobParamsError("madeBy names the run and the step, or nothing.");
    const wordsBy = params.wordsBy === undefined || params.wordsBy === null ? null : madeByOf(params.wordsBy);
    return {
      table,
      into,
      rules,
      key,
      changed,
      words: typeof params.words === "string" && params.words.trim() ? params.words.trim().slice(0, 4000) : null,
      signature: typeof params.signature === "string" ? params.signature : "[]",
      madeBy,
      zone: zoneOf(params.zone),
      unchecked: uncheckedOf(params.unchecked),
      wordsBy,
    };
  },

  async run(ctx) {
    const p = ctx.params;
    const sql = ctx.sql;
    const state: CheckState = ctx.state
      ? { ...ctx.state, capped: [...ctx.state.capped] }
      : { at: 0, begun: false, first: null, reset: false, capped: [], opened: 0, closed: 0 };
    // One day for the whole run, worked out on its first chunk.
    state.today ??= checkDayIn(ctx.now(), p.zone ?? null);
    const today = state.today;
    // `state` itself, not a copy: the commit reads it after `write`, which adds this rule's counts.
    const save = (write?: () => void) => ctx.commit({ state, progress: { done: state.at, total: p.rules.length, note: `Checking ${p.table}` } }, write);
    if (!committedBy(sql, ctx.job.id, p.into)) {
      dataTable(sql, p.table);
      try {
        sql.exec(`SELECT rowid FROM ${ident(p.table)} LIMIT 1`).toArray();
      } catch {
        throw new StoreError(400, "bad_request", `${p.table} has no rowids, and CHECK flags rows by them. Check a table a program made.`);
      }
      const own = tableRecord(sql, p.into);
      if (own && own.grp !== REVIEW_GROUP) throw new StoreError(400, "bad_request", `${p.into} is a table of another kind. Give the flags another name.`);
      const columns = columnsOf(sql, p.table);
      if (columns.some((c) => c.toLowerCase() === "rowid")) {
        throw new StoreError(400, "bad_request", `${p.table} has a column named rowid, which hides the id CHECK names each row by. Give that column another name in the step that makes the table.`);
      }
      for (const rule of p.rules) checkRuleNames(sql, p.table, columns, rule);
      for (const k of p.key ?? []) columnIn(columns, p.table, k);
      for (const k of p.changed?.key ?? []) columnIn(columns, p.table, k);
      const identity = identityOf(columns, p.key);
      const version = tableRecord(sql, p.table)?.version ?? 1;
      // `day`: the day the rules that count from today read every row, null until this run has.
      const savedNow = (day: string | null): SavedCheck => ({
        rules: p.rules,
        key: p.key,
        words: p.words,
        signature: p.signature,
        flags: p.into,
        version,
        madeAt: new Date(ctx.now()).toISOString(),
        madeBy: ctx.job.by,
        zone: p.zone ?? null,
        day,
        unchecked: p.unchecked ?? [],
        wordsBy: p.wordsBy ?? null,
      });
      if (state.first === null) state.first = own === null;
      if (!state.begun) {
        state.begun = true;
        if (state.first) {
          state.newDay = true;
          const fresh = ctx.tables.begin(p.into);
          save(() => void sql.exec(FLAGS_DDL(fresh)));
        } else {
          const saved = savedCheck(sql, p.table);
          const same =
            !!saved &&
            saved.flags === p.into &&
            saved.version === version &&
            JSON.stringify(saved.rules) === JSON.stringify(p.rules) &&
            JSON.stringify(saved.key ?? null) === JSON.stringify(p.key ?? null);
          state.reset = !same;
          // A rule that counts from today can break, or keep, on a row that did not change once the day is another.
          state.newDay = !saved?.day || saved.day !== today || (saved.zone ?? null) !== (p.zone ?? null);
          save(() => {
            // New rules, a new key or a new version of the table: the flags start again. Else the
            // flags of rows that are gone go with them.
            if (state.reset) sql.exec(`DELETE FROM ${ident(p.into)}`);
            else sql.exec(`DELETE FROM ${ident(p.into)} WHERE row_id NOT IN (SELECT rowid FROM ${ident(p.table)})`);
            state.closed += changes(sql);
            // With the flags gone, the rules in force are the new ones, should the job stop here.
            if (state.reset) setMeta(sql, checkKey(p.table), JSON.stringify(savedNow(null)));
          });
        }
      }
      const target = state.first ? `${p.into}__new` : p.into;
      const reader = `check:${p.into}`;
      const everyRow = state.first === true || state.reset;
      const rows: StepRows = everyRow ? EVERY_ROW : p.changed ? { ...inChanged("t", p.changed), whole: false, none: false } : rowsSinceLastRun(sql, "t", p.table, reader);
      while (state.at < p.rules.length) {
        await turn();
        if (ctx.now() >= ctx.deadline) return { more: true };
        const at = state.at;
        const rule = p.rules[at]!;
        state.at++;
        // Keys a program named are its word for the rows; the store's own record is read rule by rule.
        // A rule that counts from today reads every row on a new day, whatever changed.
        const scope = state.newDay !== false && ruleNamesToday(rule) ? EVERY_ROW : p.changed ? rows : ruleRows(sql, rule, reader, rows);
        if (scope.none) continue;
        save(() => {
          const done = retestRule(sql, { table: p.table, flags: target, rule, at, identity, scope, closing: state.first || state.reset ? "none" : "delete", today });
          state.opened += done.opened;
          state.closed += done.closed;
          if (done.capped && !state.capped.includes(at)) state.capped.push(at);
        });
      }
      if (state.first) {
        await ctx.tables.commit(p.into, {
          group: REVIEW_GROUP,
          madeBy: p.madeBy,
          columns: FLAG_COLUMNS,
          comment: `The rows of ${p.table} that broke a rule of its check, one row a problem. A fix on the Tables tab clears its flag.`,
          dropOld: true,
        });
      } else if (state.opened || state.closed) {
        await ctx.tables.changed(p.into, { madeBy: p.madeBy, note: `${state.opened} flagged, ${state.closed} cleared` }, () => {});
      }
      save(() => {
        setMeta(sql, checkKey(p.table), JSON.stringify(savedNow(today)));
        // Read up to now, the tables its rules look up included. Keys a program named say nothing of the rest.
        if (p.changed) return;
        ctx.tables.markRead(reader, p.table, lastChange(sql, p.table));
        for (const rule of p.rules) if (rule.rule === "reference") ctx.tables.markRead(reader, rule.table, lastChange(sql, rule.table));
      });
    }
    const flags = handleOf(sql, p.into);
    const rows = Number(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${ident(p.table)}`).one().n);
    const flagged = Number(sql.exec<{ n: number }>(`SELECT count(DISTINCT row_id) AS n FROM ${ident(p.into)} WHERE state = 'open'`).one().n);
    // A row has one open flag a rule, so a rule's rows are the sum over the words its flags say.
    const byRule = new Map<number, number>();
    const said = new Map<number, { problem: string; n: number }>();
    for (const r of sql.exec<{ rule: number; problem: string; n: number }>(`SELECT rule, problem, count(DISTINCT row_id) AS n FROM ${ident(p.into)} WHERE state = 'open' GROUP BY rule, problem`).toArray()) {
      const at = Number(r.rule);
      const n = Number(r.n);
      byRule.set(at, (byRule.get(at) ?? 0) + n);
      if (n > (said.get(at)?.n ?? 0)) said.set(at, { problem: String(r.problem), n });
    }
    // A rule whose words follow what each row reads as (days or numbers) is named as most of its flags say it.
    const nameOf = (rule: CheckRule, at: number): string => (wordsByRow(rule) ? said.get(at)?.problem : undefined) ?? ruleWords(rule);
    return {
      result: {
        flags,
        checked: { table: p.table, version: tableRecord(sql, p.table)?.version ?? 1, rows },
        flagged,
        opened: state.opened,
        closed: state.closed,
        rules: p.rules.map((rule, i) => ({ name: `${nameOf(rule, i)}${state.capped.includes(i) ? ` (the first ${FLAGS_PER_RULE_MAX.toLocaleString("en-US")} rows)` : ""}`, rows: byRule.get(i) ?? 0 })),
        ...(p.rules.some(ruleNamesToday) ? { today } : {}),
      },
    };
  },
};
