// What a person reviews and fixes on a store's Tables tab (Stores, Part A, slice E): the rows a
// CHECK flagged, and the answers a CLASSIFY or a MATCH was not sure of.
//
//   reviewTables  which tables have rows to review, and how many: each checked table (its rules are
//                 in `_meta` under `checkKey`) and each Answers table with answers that wait.
//   reviewRows    a page of one table's rows to review, each with what is wrong with it. `since`
//                 (the `at` of the review's first page) keeps what a person settled after it on the
//                 list, so a row keeps its place while they work. `filters` and `search` narrow the
//                 list as they narrow a page of the table's rows (data.ts's `whereOf`).
//   reviewFix     one cell fixed, or an unsure answer taken as it is (`accept`), in one transaction:
//                 - in a checked table, the cell is written when it still holds what the person saw
//                   (`was`), the fix is kept in `_fixes`, and the row's rules that read the column are
//                   tested again: a flag the row keeps now is closed, a rule it breaks now is flagged.
//                   A rule reads the columns its `when` names too, so a fix of an ISSUED permit's
//                   status tests its "has an issue date" again, and the other columns its bounds
//                   name, so a fix of a permit's issued_on tests "finaled_on is before issued_on"
//                   again, though the flag is on finaled_on. A unique rule tests again the rows
//                   that shared the old value or share the new one. A bound that counts from today
//                   is today on the clock the check ran on (`SavedCheck.zone`).
//                 - in an Answers table, the answer becomes the person's (`review` 0), which every later
//                   run keeps, and the rows of the table it answers take it at once.
//   applyFixes    a person's fixes written again after a step remade or changed the table, where the
//                 row still holds what the fix replaced: the town's data did not change under it.
//
// A table a LOAD made keeps the town's rows as they came, and a migration's table changes only by
// migrations: neither is fixed here.

import { ANSWERS_GROUP, answersKey, checkDayIn, type CheckRule, KEY_COLUMN, LOADED_GROUP, type SavedAnswers, type SavedCheck } from "../../store-readers/src/jobs.js";
import { StoreError, type StoreCore } from "./core.js";
import { CELL_MAX, filterColumns, whereOf } from "./data.js";
import { recordDelta } from "./deltas.js";
import { allFilled, brokenSql, identityOf, problemSql, retestRule, ruleColumn, ruleColumns, rowKeySql, savedCheck, uniqueKey } from "./jobs/check.js";
import { CHANGE_KEYS_MAX, changes, columnsOf, hasValue, ident, keyOf, keysWritten, literal, tableRecord } from "./jobs/cleanup-sql.js";
import { savedJson } from "./schema.js";
import type { ReviewFixBody, ReviewFixResult, ReviewFlag, ReviewRow, ReviewRows, ReviewRowsBody, ReviewTable } from "./types.js";
import type { StoreSqlValue } from "./sql.js";

/** The most rows one page of a review holds. */
export const REVIEW_PAGE_MAX = 200;
/** The most rows a unique rule tests again after one fix. */
const UNIQUE_RECHECK_MAX = 1000;
/** The most other rows one fix answers with: a unique rule's changed flags, for the page to show. */
const OTHERS_MAX = 50;
/** Columns one read of a row takes: workerd answers at most 100, and the row's id is one of them. */
const CELLS_AT_ONCE = 99;

const tableExists = (core: StoreCore, name: string): boolean =>
  core.sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;

/** An Answers table's column a person answers in: `matched` for a MATCH's, `answer` for a CLASSIFY's. */
function answerColumn(saved: SavedAnswers | null, columns: readonly string[]): string {
  return saved?.kind === "match" || (!saved && columns.includes("matched")) ? "matched" : "answer";
}

/** A table as the review reads it: an Answers table with its saved facts, or a checked table with its check. */
type Reviewed =
  | { kind: "answers"; table: string; columns: string[]; take: string; saved: SavedAnswers | null }
  | { kind: "flags"; table: string; columns: string[]; check: SavedCheck; identity: string[] | null; editable: string[] };

function reviewed(core: StoreCore, table: string): Reviewed {
  if (typeof table !== "string" || !table || !tableExists(core, table)) throw new StoreError(404, "not_found", `This store has no table "${String(table)}".`);
  const rec = tableRecord(core.sql, table);
  const columns = columnsOf(core.sql, table);
  if (rec?.kind === "program" && rec.grp === ANSWERS_GROUP && columns.includes("review")) {
    const saved = savedJson<SavedAnswers>(core.sql, answersKey(table));
    return { kind: "answers", table, columns, take: answerColumn(saved, columns), saved };
  }
  const check = savedCheck(core.sql, table);
  if (!check || !tableExists(core, check.flags)) throw new StoreError(404, "not_found", `${table} has no rows to review: no check has flagged it.`);
  if ((rec?.version ?? 1) !== check.version) {
    throw new StoreError(409, "review_stale", `${table} has a newer version than the check that flagged it. Run the check again to review it.`);
  }
  // A person fixes any column of the town's: a rule may flag the very column a program names rows by.
  const editable = columns.filter((c) => !c.startsWith("_"));
  return { kind: "flags", table, columns, check, identity: identityOf(columns, check.key), editable };
}

export function reviewTables(core: StoreCore): ReviewTable[] {
  const sql = core.sql;
  const out: ReviewTable[] = [];
  for (const row of sql.exec<{ name: string }>("SELECT name FROM _tables WHERE kind = 'program' AND grp = ? ORDER BY name", ANSWERS_GROUP).toArray()) {
    const name = String(row.name);
    if (!tableExists(core, name) || !columnsOf(sql, name).includes("review")) continue;
    const open = Number(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${ident(name)} WHERE review = 1`).one().n);
    out.push({ table: name, kind: "answers", flags: null, open, stale: false });
  }
  for (const row of sql.exec<{ key: string; value: string }>("SELECT key, value FROM _meta WHERE key LIKE 'check:%' ORDER BY key").toArray()) {
    const table = String(row.key).slice("check:".length);
    let check: SavedCheck;
    try {
      check = JSON.parse(String(row.value)) as SavedCheck;
    } catch {
      continue;
    }
    if (!tableExists(core, table) || !tableExists(core, check.flags)) continue;
    const open = Number(sql.exec<{ n: number }>(`SELECT count(DISTINCT row_id) AS n FROM ${ident(check.flags)} WHERE state = 'open'`).one().n);
    out.push({ table, kind: "flags", flags: check.flags, open, stale: (tableRecord(sql, table)?.version ?? 1) !== check.version });
  }
  return out;
}

/** A cell as a page reads it, like the table's own pages: a BLOB as its length, text cut at CELL_MAX characters (one more is read, to know it was cut). */
const cellSql = (expr: string): string => `CASE WHEN typeof(${expr}) = 'blob' THEN length(${expr}) ELSE substr(CAST(${expr} AS TEXT), 1, ${CELL_MAX + 1}) END`;

/** The SQL of an Answers row's cells. */
const cellsSql = (columns: readonly string[], alias: string): string => columns.map((c, i) => `${cellSql(`${alias}.${ident(c)}`)} AS c${i}`).join(", ");

/** Some rows of a table by rowid, with their cells, read CELLS_AT_ONCE columns at a time. A row that is gone is left out. */
function readCells(core: StoreCore, table: string, columns: readonly string[], ids: readonly number[]): Map<number, Record<string, StoreSqlValue>> {
  const out = new Map<number, Record<string, StoreSqlValue>>();
  if (!ids.length) return out;
  for (let from = 0; from < columns.length; from += CELLS_AT_ONCE) {
    const part = columns.slice(from, from + CELLS_AT_ONCE);
    const select = part.map((c, i) => `${cellSql(`t.${ident(c)}`)} AS c${from + i}`).join(", ");
    for (const r of core.sql.exec<Record<string, StoreSqlValue>>(`SELECT t.rowid AS __id, ${select} FROM ${ident(table)} t WHERE t.rowid IN (SELECT value FROM json_each(?))`, JSON.stringify(ids)).toArray()) {
      const id = Number(r.__id);
      if (from === 0) out.set(id, { ...r });
      else if (out.has(id)) Object.assign(out.get(id)!, r);
    }
  }
  return out;
}

function rowOf(columns: readonly string[], r: Record<string, StoreSqlValue>, flags: ReviewFlag[]): ReviewRow {
  const cut: number[] = [];
  const cells = columns.map((_, i) => {
    const v = r[`c${i}`];
    if (v === null || v === undefined) return null;
    let s = String(v);
    if (s.length > CELL_MAX) {
      s = s.slice(0, CELL_MAX);
      cut.push(i);
    }
    return s;
  });
  return { id: Number(r.__id), cells, ...(cut.length ? { cut } : {}), flags };
}

/** An unsure answer's flag: the answer to take or change, how sure, and why. */
function unsureFlag(take: string, r: Record<string, StoreSqlValue>): ReviewFlag {
  const answer = r.__take === null || r.__take === undefined ? null : String(r.__take);
  return { column: take, problem: r.__note === null || r.__note === undefined ? "" : String(r.__note), rule: null, kind: "unsure", suggestion: answer, sure: r.__sure === null || r.__sure === undefined ? null : Number(r.__sure) };
}

/** The open flags of some rows of a checked table, by rowid. */
function openFlags(core: StoreCore, flags: string, ids: readonly number[]): Map<number, ReviewFlag[]> {
  const out = new Map<number, ReviewFlag[]>();
  if (!ids.length) return out;
  for (const f of core.sql
    .exec<{ row_id: number; rule: number; problem: string; column_name: string | null }>(
      `SELECT row_id, rule, problem, column_name FROM ${ident(flags)} WHERE state = 'open' AND row_id IN (SELECT value FROM json_each(?)) ORDER BY id`,
      JSON.stringify(ids),
    )
    .toArray()) {
    const id = Number(f.row_id);
    (out.get(id) ?? out.set(id, []).get(id)!).push({ column: f.column_name === null ? null : String(f.column_name), problem: String(f.problem), rule: Number(f.rule), kind: "rule", suggestion: null, sure: null });
  }
  return out;
}

const openRows = (core: StoreCore, t: Reviewed): number =>
  t.kind === "answers"
    ? Number(core.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${ident(t.table)} WHERE review = 1`).one().n)
    : Number(core.sql.exec<{ n: number }>(`SELECT count(DISTINCT row_id) AS n FROM ${ident(t.check.flags)} WHERE state = 'open'`).one().n);

export function reviewRows(core: StoreCore, body: ReviewRowsBody): ReviewRows {
  const started = core.deps.now();
  const offset = Number(body?.offset ?? 0);
  const limit = Number(body?.limit ?? 100);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > REVIEW_PAGE_MAX) {
    throw new StoreError(400, "bad_request", `A page of rows to review starts at 0 or later and holds 1 to ${REVIEW_PAGE_MAX} rows.`);
  }
  const at = core.nowIso();
  const since = typeof body?.since === "string" && body.since ? body.since : null;
  const t = reviewed(core, body.table);
  const sql = core.sql;
  let rows: ReviewRow[];
  let editable: string[];
  let total: number;
  if (t.kind === "answers") {
    editable = [t.take];
    const listed = since ? "a.review = 1 OR (a.answered_at >= ? AND a.answered_by NOT LIKE 'model:%' AND a.answered_by NOT LIKE 'rule:%')" : "a.review = 1";
    const narrowed = whereOf("a", filterColumns(sql, t.table), body);
    const within = `(${listed})${narrowed.sql ? ` AND ${narrowed.sql}` : ""}`;
    const listedBy = [...(since ? [since] : []), ...narrowed.params];
    rows = sql
      .exec<Record<string, StoreSqlValue>>(
        `SELECT a.rowid AS __id, ${cellsSql(t.columns, "a")}, a.${ident(t.take)} AS __take, a.sure AS __sure, a.note AS __note, a.review AS __review FROM ${ident(t.table)} a WHERE ${within} ORDER BY a.rows DESC, a.key LIMIT ? OFFSET ?`,
        ...listedBy,
        limit,
        offset,
      )
      .toArray()
      .map((r) => rowOf(t.columns, r, Number(r.__review) === 1 ? [unsureFlag(t.take, r)] : []));
    total = Number(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${ident(t.table)} a WHERE ${within}`, ...listedBy).one().n);
  } else {
    editable = t.editable;
    const flagsTable = ident(t.check.flags);
    const listed = since ? "state = 'open' OR (state = 'fixed' AND fixed_at >= ?)" : "state = 'open'";
    // A filter or a search keeps the flagged rows of the table that pass it.
    const narrowed = whereOf(ident(t.table), filterColumns(sql, t.table), body);
    const within = `(${listed})${narrowed.sql ? ` AND row_id IN (SELECT rowid FROM ${ident(t.table)} WHERE ${narrowed.sql})` : ""}`;
    const listedBy = [...(since ? [since] : []), ...narrowed.params];
    const ids = sql
      .exec<{ row_id: number }>(`SELECT row_id, min(id) AS first FROM ${flagsTable} WHERE ${within} GROUP BY row_id ORDER BY first LIMIT ? OFFSET ?`, ...listedBy, limit, offset)
      .toArray()
      .map((r) => Number(r.row_id));
    const cells = readCells(core, t.table, t.columns, ids);
    const flags = openFlags(core, t.check.flags, ids);
    rows = ids.flatMap((id) => {
      const r = cells.get(id);
      return r ? [rowOf(t.columns, r, flags.get(id) ?? [])] : [];
    });
    total = Number(sql.exec<{ n: number }>(`SELECT count(DISTINCT row_id) AS n FROM ${flagsTable} WHERE ${within}`, ...listedBy).one().n);
  }
  return {
    table: t.table,
    version: tableRecord(sql, t.table)?.version ?? 1,
    kind: t.kind,
    columns: t.columns,
    editable,
    rows,
    total,
    open: openRows(core, t),
    at,
    ms: core.deps.now() - started,
  };
}

/** One row of a reviewed table as the review shows it, with its flags as they stand now. */
function readRow(core: StoreCore, t: Reviewed, id: number): ReviewRow {
  if (t.kind === "answers") {
    const r = core.sql
      .exec<Record<string, StoreSqlValue>>(`SELECT a.rowid AS __id, ${cellsSql(t.columns, "a")}, a.${ident(t.take)} AS __take, a.sure AS __sure, a.note AS __note, a.review AS __review FROM ${ident(t.table)} a WHERE a.rowid = ?`, id)
      .toArray()[0];
    if (!r) throw new StoreError(404, "row_gone", "This row is gone from the table.");
    return rowOf(t.columns, r, Number(r.__review) === 1 ? [unsureFlag(t.take, r)] : []);
  }
  const r = readCells(core, t.table, t.columns, [id]).get(id);
  if (!r) throw new StoreError(404, "row_gone", "This row is gone from the table.");
  return rowOf(t.columns, r, openFlags(core, t.check.flags, [id]).get(id) ?? []);
}

const asText = (v: StoreSqlValue | undefined): string | null => (v === null || v === undefined ? null : String(v));

export function reviewFix(core: StoreCore, actor: string, body: ReviewFixBody): ReviewFixResult {
  const id = Number(body?.id);
  if (!Number.isInteger(id)) throw new StoreError(400, "bad_request", "A fix names its row by its id.");
  if (typeof body.column !== "string" || !body.column) throw new StoreError(400, "bad_request", "A fix names its column.");
  const value = body.value === undefined || body.value === null ? null : String(body.value);
  if (value !== null && value.length > 100_000) throw new StoreError(400, "bad_request", "A value is at most 100,000 characters.");
  return core.transaction(() => {
    const t = reviewed(core, body.table);
    const others = t.kind === "answers" ? (fixAnswer(core, actor, t, id, body, value), []) : fixCell(core, actor, t, id, body, value);
    return { row: readRow(core, t, id), open: openRows(core, t), others: others.slice(0, OTHERS_MAX).map((other) => readRow(core, t, other)) };
  });
}

/** The person's answer for one value, which wins on every later run; the rows that hold the value take it at once. */
function fixAnswer(core: StoreCore, actor: string, t: Extract<Reviewed, { kind: "answers" }>, id: number, body: ReviewFixBody, typed: string | null): void {
  const sql = core.sql;
  if (body.column !== t.take) throw new StoreError(400, "bad_request", `In ${t.table}, a person answers in ${t.take}.`);
  const row = sql.exec<Record<string, StoreSqlValue>>(`SELECT key, value, ${ident(t.take)} AS answer FROM ${ident(t.table)} WHERE rowid = ?`, id).toArray()[0];
  if (!row) throw new StoreError(404, "row_gone", "This row is gone from the table.");
  const current = asText(row.answer);
  if (body.was !== undefined && current !== (body.was === null ? null : String(body.was))) {
    throw new StoreError(409, "changed", "This answer changed since you opened it. Look at it again.");
  }
  if (body.accept && current === null) throw new StoreError(400, "bad_request", "This row has no answer to take: type one.");
  let answer = body.accept ? current : typed;
  let reference: string | null = null;
  const saved = t.saved;
  if (!body.accept && answer !== null) {
    if (saved?.kind === "classify" && saved.classes?.length) {
      const own = saved.classes.find((c) => c === answer) ?? saved.classes.find((c) => c.toLowerCase() === answer!.trim().toLowerCase());
      if (!own) throw new StoreError(400, "not_a_class", `"${answer}" is not on the list: ${saved.classes.slice(0, 12).join(", ")}${saved.classes.length > 12 ? " …" : ""}.`);
      answer = own;
    }
    if (saved?.kind === "match" && saved.to && saved.take && saved.toColumn && tableExists(core, saved.to)) {
      const ref = sql
        .exec<{ text: string | null }>(`SELECT CAST(r.${ident(saved.toColumn)} AS TEXT) AS text FROM ${ident(saved.to)} r WHERE CAST(r.${ident(saved.take)} AS TEXT) = ? LIMIT 1`, answer.trim())
        .toArray()[0];
      if (!ref) throw new StoreError(400, "not_a_reference", `"${answer}" is no ${saved.take} of ${saved.to}.`);
      answer = answer.trim();
      reference = asText(ref.text);
    }
  }
  if (body.accept && saved?.kind === "match" && answer !== null) {
    reference = asText(sql.exec<{ reference: string | null }>(`SELECT reference FROM ${ident(t.table)} WHERE rowid = ?`, id).toArray()[0]?.reference);
  }
  const now = core.nowIso();
  const isMatch = t.take === "matched";
  sql.exec(
    `UPDATE ${ident(t.table)} SET ${ident(t.take)} = ?, review = 0, sure = 1, answered_by = ?, answered_at = ?, note = NULL${isMatch ? ", method = 'person', reference = ?" : ""} WHERE rowid = ?`,
    ...[answer, actor, now, ...(isMatch ? [reference] : []), id],
  );
  core.sql.exec("UPDATE _tables SET updated_at = ? WHERE name = ?", now, t.table);
  // The rows that hold the value take the answer now, as the next run would.
  if (saved && tableExists(core, saved.table)) {
    const cols = columnsOf(sql, saved.table);
    if (cols.includes(saved.column) && cols.includes(saved.into)) {
      const named = cols.includes(KEY_COLUMN);
      const cursor = sql.exec<{ k: string }>(
        `UPDATE ${ident(saved.table)} SET ${ident(saved.into)} = ? WHERE ${keyOf(ident(saved.column))} = ? AND ${ident(saved.into)} IS NOT ?${named ? ` RETURNING ${ident(KEY_COLUMN)} AS k` : ""}`,
        answer,
        String(row.key),
        answer,
      );
      const wrote = named ? keysWritten(cursor) : { written: changes(sql), keys: [] };
      if (wrote.written > 0) recordPersonsChange(core, actor, saved.table, named && wrote.written <= CHANGE_KEYS_MAX ? wrote.keys : null);
      applyFixes(core, saved.table);
      retestAnswered(core, actor, now, saved, cols, String(row.key));
      sql.exec("UPDATE _tables SET updated_at = ? WHERE name = ?", now, saved.table);
    }
  }
  core.history({ kind: "table", by: actor, note: `${t.table}: ${answer === null ? "no answer" : `"${answer}"`} for "${String(row.value)}"` });
}

/**
 * A person's fix changes rows as a step does, so the steps after it read those rows. No keys: every
 * row. The change names the person, as no job does (events.ts reads it as their fix).
 */
function recordPersonsChange(core: StoreCore, actor: string, table: string, keys: string[] | null): void {
  const version = tableRecord(core.sql, table)?.version ?? 1;
  if (keys) recordDelta(core, table, { version, job: null, by: actor, keys: { changed: keys } });
  else recordDelta(core, table, { version, job: null, by: actor, whole: true });
}

/** A checked table's flags on the rows that hold `key`, tested again now a person's answer wrote their column. */
function retestAnswered(core: StoreCore, actor: string, now: string, saved: SavedAnswers, columns: readonly string[], key: string): void {
  const check = savedCheck(core.sql, saved.table);
  if (!check || !tableExists(core, check.flags) || (tableRecord(core.sql, saved.table)?.version ?? 1) !== check.version) return;
  const scope = { where: `${keyOf(`t.${ident(saved.column)}`)} = ?`, params: [key] };
  const today = todayOf(core, check);
  let tested = false;
  check.rules.forEach((rule, at) => {
    if (!ruleColumns(rule).includes(saved.into)) return;
    tested = true;
    retestRule(core.sql, { table: saved.table, flags: check.flags, rule, at, identity: identityOf(columns, check.key), scope, closing: { by: actor, at: now }, today });
  });
  if (tested) core.sql.exec("UPDATE _tables SET updated_at = ? WHERE name = ?", now, check.flags);
}

/** The day a check's bounds that count from today mean now: today on the clock the check ran on. */
const todayOf = (core: StoreCore, check: SavedCheck): string => checkDayIn(core.deps.now(), check.zone ?? null);

/**
 * The rows that share a row's key under a unique rule, itself included: rows the rule holds on
 * (its `when`) only. None when the key is not filled, or the rule does not hold on the row.
 */
function sharingKey(core: StoreCore, table: string, rule: Extract<CheckRule, { rule: "unique" }>, id: number, today: string): number[] {
  return core.sql
    .exec<{ id: number }>(
      `SELECT u.rowid AS id FROM ${ident(table)} u, ${ident(table)} t WHERE t.rowid = ? AND ${allFilled(rule, "t", today)} AND ${allFilled(rule, "u", today)} AND ${uniqueKey(rule, "u")} = ${uniqueKey(rule, "t")} LIMIT ${UNIQUE_RECHECK_MAX}`,
      id,
    )
    .toArray()
    .map((r) => Number(r.id));
}

/** A row's flag for a rule, made to say what the rule says of the row now. */
function setFlag(core: StoreCore, actor: string, t: Extract<Reviewed, { kind: "flags" }>, rule: CheckRule, at: number, id: number, broken: boolean): void {
  const sql = core.sql;
  const flags = ident(t.check.flags);
  const column = ruleColumn(rule);
  const value = column ? `CAST(t.${ident(column)} AS TEXT)` : "NULL";
  if (!broken) {
    sql.exec(`UPDATE ${flags} SET state = 'fixed', fixed_by = ?, fixed_at = ? WHERE row_id = ? AND rule = ? AND state = 'open'`, actor, core.nowIso(), id, at);
    return;
  }
  const open = sql.exec(`SELECT 1 AS x FROM ${flags} WHERE row_id = ? AND rule = ? AND state = 'open'`, id, at).toArray().length > 0;
  if (open) {
    sql.exec(`UPDATE ${flags} SET value = (SELECT ${value} FROM ${ident(t.table)} t WHERE t.rowid = ?) WHERE row_id = ? AND rule = ? AND state = 'open'`, id, id, at);
  } else {
    sql.exec(
      `INSERT INTO ${flags} (row_id, row_key, rule, problem, column_name, value, state) SELECT t.rowid, ${rowKeySql(t.identity)}, ?, ${problemSql(rule, "t")}, ?, ${value}, 'open' FROM ${ident(t.table)} t WHERE t.rowid = ?`,
      at,
      column,
      id,
    );
  }
}

/**
 * What names a row across runs for a fix of one column: the program's key when it names only this
 * row and the fix leaves it alone, else the row's file and row, or its rowid when it has neither.
 * Named by a key two rows share, one fix would land on both when the step writes it again.
 */
function fixIdentity(core: StoreCore, t: Extract<Reviewed, { kind: "flags" }>, id: number, column: string): string[] | null {
  const key = t.check.key;
  const fallback = identityOf(t.columns, null);
  if (!key?.length || key.includes(column)) return fallback;
  const filled = key.map((k) => hasValue(`t.${ident(k)}`)).join(" AND ");
  const same = key.map((k) => `u.${ident(k)} IS t.${ident(k)}`).join(" AND ");
  const row = core.sql.exec<{ filled: number; n: number }>(`SELECT ${filled} AS filled, (SELECT count(*) FROM ${ident(t.table)} u WHERE ${same}) AS n FROM ${ident(t.table)} t WHERE t.rowid = ?`, id).toArray()[0];
  return row && Number(row.filled) === 1 && Number(row.n) === 1 ? key : fallback;
}

/** A person's fix of one cell of a checked table: written, kept, and its row's rules tested again. Answers the other rows whose flags it changed. */
function fixCell(core: StoreCore, actor: string, t: Extract<Reviewed, { kind: "flags" }>, id: number, body: ReviewFixBody, value: string | null): number[] {
  const sql = core.sql;
  if (body.accept) throw new StoreError(400, "bad_request", "A checked table's flag has no answer to take: type the value.");
  const rec = tableRecord(sql, t.table);
  if (!rec || rec.kind !== "program") throw new StoreError(400, "not_fixable", `${t.table} is a migration's table, which changes only by migrations or store_exec.`);
  if (rec.grp === LOADED_GROUP) throw new StoreError(400, "not_fixable", `${t.table} keeps its file's rows as they came. Fix the cleaned table made from it.`);
  const column = body.column;
  if (!t.editable.includes(column)) throw new StoreError(400, "not_fixable", `${column} is not a column a person fixes here: the store keeps it.`);
  const before = sql.exec<{ v: string | null }>(`SELECT CAST(${ident(column)} AS TEXT) AS v FROM ${ident(t.table)} WHERE rowid = ?`, id).toArray()[0];
  if (!before) throw new StoreError(404, "row_gone", "This row is gone from the table.");
  const was = asText(before.v);
  if (body.was !== undefined && was !== (body.was === null ? null : String(body.was))) {
    throw new StoreError(409, "changed", "This cell changed since you opened it. Look at it again.");
  }
  const rules = t.check.rules.map((rule, at) => ({ rule, at })).filter(({ rule }) => ruleColumns(rule).includes(column));
  const today = todayOf(core, t.check);
  // The rows a unique rule tests again: the ones that shared the old value, read before the write, and below the ones that share the new one.
  const sharedBefore = new Map<number, Set<number>>();
  for (const { rule, at } of rules) if (rule.rule === "unique") sharedBefore.set(at, new Set(sharingKey(core, t.table, rule, id, today)));
  sql.exec(`UPDATE ${ident(t.table)} SET ${ident(column)} = ? WHERE rowid = ?`, value, id);
  const key = columnsOf(sql, t.table).includes(KEY_COLUMN) ? sql.exec<{ k: string }>(`SELECT ${ident(KEY_COLUMN)} AS k FROM ${ident(t.table)} WHERE rowid = ?`, id).toArray()[0] : undefined;
  recordPersonsChange(core, actor, t.table, key ? [String(key.k)] : null);
  // Kept, so every later version of the table, and every step's change to it, writes it again.
  const identity = fixIdentity(core, t, id, column);
  const keyColumns = identity ?? ["rowid"];
  const rowKey = String(sql.exec<{ k: string }>(`SELECT ${rowKeySql(identity)} AS k FROM ${ident(t.table)} t WHERE t.rowid = ?`, id).one().k);
  const kept = sql.exec<{ was: string | null }>("SELECT was FROM _fixes WHERE tbl = ? AND row_key = ? AND column_name = ?", t.table, rowKey, column).toArray()[0];
  const original = kept ? asText(kept.was) : was;
  const now = core.nowIso();
  if (original === value) {
    sql.exec("DELETE FROM _fixes WHERE tbl = ? AND row_key = ? AND column_name = ?", t.table, rowKey, column);
  } else {
    sql.exec(
      `INSERT INTO _fixes (id, tbl, key_columns, row_key, column_name, was, value, version, by_sub, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tbl, row_key, column_name) DO UPDATE SET value = excluded.value, version = excluded.version, by_sub = excluded.by_sub, at = excluded.at`,
      core.newId("fix"),
      t.table,
      JSON.stringify(keyColumns),
      rowKey,
      column,
      original,
      value,
      rec.version,
      actor,
      now,
    );
  }
  const others = new Set<number>();
  for (const { rule, at } of rules) {
    if (rule.rule !== "unique") {
      const broken = Number(sql.exec<{ b: number }>(`SELECT (${brokenSql(rule, t.table, today)}) AS b FROM ${ident(t.table)} t WHERE t.rowid = ?`, id).toArray()[0]?.b ?? 0) === 1;
      setFlag(core, actor, t, rule, at, id, broken);
      continue;
    }
    const before = sharedBefore.get(at) ?? new Set<number>();
    const shared = new Set(sharingKey(core, t.table, rule, id, today));
    for (const row of before) {
      if (row === id || shared.has(row)) continue;
      // The rows left with the old value still break the rule when more than one is left.
      setFlag(core, actor, t, rule, at, row, before.size - 1 > 1);
      others.add(row);
    }
    for (const row of shared) {
      setFlag(core, actor, t, rule, at, row, shared.size > 1);
      if (row !== id) others.add(row);
    }
    if (!shared.has(id)) setFlag(core, actor, t, rule, at, id, false);
  }
  sql.exec("UPDATE _tables SET updated_at = ? WHERE name IN (?, ?)", now, t.table, t.check.flags);
  core.history({ kind: "table", by: actor, note: `${t.table}: ${column} of one row fixed` });
  return [...others];
}

/** A JSON path to a key of a row's key object, quoted so any column name reads. */
const keyPath = (column: string): string => literal(`$."${column.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);

/**
 * Writes a table's kept fixes again where each row still holds what its fix replaced: after a step
 * made a new version of the table or changed its rows. A fix named by a rowid holds only in the
 * version it was made in.
 */
export function applyFixes(core: StoreCore, table: string): void {
  const sql = core.sql;
  const groups = sql.exec<{ key_columns: string; column_name: string }>("SELECT DISTINCT key_columns, column_name FROM _fixes WHERE tbl = ?", table).toArray();
  if (!groups.length) return;
  const columns = new Set(columnsOf(sql, table));
  const version = tableRecord(sql, table)?.version ?? 1;
  for (const g of groups) {
    const column = String(g.column_name);
    let keys: string[];
    try {
      keys = JSON.parse(String(g.key_columns)) as string[];
    } catch {
      continue;
    }
    if (!columns.has(column)) continue;
    const byRowid = keys.length === 1 && keys[0] === "rowid";
    if (!byRowid && keys.some((k) => !columns.has(k))) continue;
    const picks = keys.map((k, i) => `CAST(json_extract(row_key, ${keyPath(k)}) AS TEXT) AS k${i}`).join(", ");
    const same = byRowid ? "CAST(t.rowid AS TEXT) = f.k0" : keys.map((k, i) => `CAST(t.${ident(k)} AS TEXT) = f.k${i}`).join(" AND ");
    sql.exec(
      `UPDATE ${ident(table)} AS t SET ${ident(column)} = f.value
       FROM (SELECT ${picks}, value, was FROM _fixes WHERE tbl = ? AND key_columns = ? AND column_name = ?${byRowid ? " AND version = ?" : ""}) AS f
       WHERE ${same} AND CAST(t.${ident(column)} AS TEXT) IS f.was`,
      ...[table, String(g.key_columns), column, ...(byRowid ? [version] : [])],
    );
  }
}
