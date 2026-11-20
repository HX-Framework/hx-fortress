// CLASSIFY: each distinct value of a column mapped to one of a fixed list (Stores, Part A, slice E).
// store_classify (the api's agent/tools/store-cleanup.ts) asks the model about the
// values that have no answer yet, at most CLASSIFY_ASK_MAX a run, and submits this job with the
// answers. The job:
//
//   1. keeps them in the store's Answers table `answers_<into>` (group "Answers"), one row per
//      value: the value as the town wrote it, its answer, how sure, who answered, the run and step,
//      and how many rows hold it. The table is made by the first run and changed in place after it.
//      A value already answered keeps its answer, so a person's correction is never replaced.
//      Values are one answer when they differ only in case or in spaces at their ends (`answerKeySql`).
//   2. writes each row's answer into the table's `<into>` column, in place: the column is added by
//      the first run, and after it only rows whose answer changes are written. With `changed`, only
//      the rows those keys name.
//
// An answer less sure than the program's bar, or none at all, waits for a person (`review` 1): the
// Tables tab shows it to fix, and the run goes on. Its params and its answer are
// `store-readers/jobs`; the store keeps what the table answers under `answersKey`.

import {
  ANSWERS_GROUP,
  answersKey,
  changedRowsOf,
  CLASSIFY_ASK_MAX,
  CLASSIFY_CLASSES_MAX,
  type ClassifyAnswer,
  type ClassifyParams,
  type ClassifyResult,
  type ChangedRows,
  KEY_COLUMN,
  LOADED_GROUP,
  madeByOf,
  type MadeBy,
  MAX_TABLE_NAME,
  type SavedAnswers,
  trimmedText,
} from "../../../store-readers/src/jobs.js";
import { StoreError } from "../core.js";
import { savedJson, setMeta } from "../schema.js";
import { isReservedName, type SqlLike } from "../sql.js";
import { CHANGE_KEYS_MAX, changes, columnIn, columnsOf, committedBy, dataTable, handleOf, hasValue, ident, inChanged, keyOf, keysWritten, tableRecord, trimmed } from "./cleanup-sql.js";
import { type JobContext, type JobHandler, JobParamsError, type ProgramTableColumn } from "./types.js";

export interface ClassifyState {
  /** The answers are kept (or there were none to keep). */
  answered: boolean;
  /** Answers kept by this job. */
  added: number;
  /** Rows of the table whose `into` this job wrote. */
  written: number;
}

const NAME = new RegExp(`^[a-z][a-z0-9_]{0,${MAX_TABLE_NAME - 1}}$`);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** The most JSON text one INSERT … FROM json_each(?) takes, well under the 2 MB a value holds. */
const BATCH_CHARS = 400_000;

/** A CLASSIFY's Answers table's columns. */
export const ANSWER_COLUMNS: ProgramTableColumn[] = [
  { name: "key", comment: "The value in lowercase, without spaces at either end: values that differ only so have one answer." },
  { name: "value", comment: "The value as its table had it." },
  { name: "answer", comment: "What the value means, from the list; empty when nothing on the list fits." },
  { name: "sure", comment: "How sure the answer is, 0 to 1." },
  { name: "review", comment: "1 while the answer waits for a person: less sure than the program asks, or none." },
  { name: "answered_by", comment: "Who answered: a model (model:<id>) or a person (user:<id>)." },
  { name: "answered_at", comment: "When it was answered." },
  { name: "run_id", comment: "The run that asked." },
  { name: "step", comment: "The step of the run that asked." },
  { name: "note", comment: "Why, in the answerer's words." },
  { name: "rows", comment: "Rows of the table that hold the value." },
];

const ANSWERS_DDL = (table: string) =>
  `CREATE TABLE ${ident(table)} (key TEXT PRIMARY KEY, value TEXT NOT NULL, answer TEXT, sure REAL, review INTEGER NOT NULL DEFAULT 0, answered_by TEXT NOT NULL, answered_at TEXT NOT NULL, run_id TEXT, step TEXT, note TEXT, rows INTEGER NOT NULL DEFAULT 0)`;

/** The answers in batches small enough for one statement's value. */
export function answerBatches<T>(answers: readonly T[]): string[] {
  const batches: string[] = [];
  let batch: T[] = [];
  let chars = 0;
  for (const answer of answers) {
    const size = JSON.stringify(answer).length + 1;
    if (batch.length && chars + size > BATCH_CHARS) {
      batches.push(JSON.stringify(batch));
      batch = [];
      chars = 0;
    }
    batch.push(answer);
    chars += size;
  }
  if (batch.length) batches.push(JSON.stringify(batch));
  return batches;
}

/** Each answer's row count, the rows of `table` whose `column` has its key; only counts that changed are written. */
export function recountAnswers(sql: SqlLike, answers: string, table: string, column: string): void {
  const k = keyOf(`t.${ident(column)}`);
  sql.exec(
    `UPDATE ${ident(answers)} SET rows = g.n FROM (SELECT ${k} AS k, count(*) AS n FROM ${ident(table)} t WHERE ${hasValue(`t.${ident(column)}`)} GROUP BY 1) AS g WHERE g.k = ${ident(answers)}.key AND ${ident(answers)}.rows IS NOT g.n`,
  );
  sql.exec(`UPDATE ${ident(answers)} SET rows = 0 WHERE rows <> 0 AND key NOT IN (SELECT ${k} FROM ${ident(table)} t WHERE ${hasValue(`t.${ident(column)}`)})`);
}

/**
 * The table a CLASSIFY or a MATCH writes a column into: a program's table that a LOAD did not
 * make (the town's rows stay as they came), with its columns.
 */
export function cleanedTable(sql: SqlLike, table: string, step: "CLASSIFY" | "MATCH"): { columns: string[]; group: string | null; comment: string | null } {
  dataTable(sql, table);
  const rec = tableRecord(sql, table);
  if (!rec || rec.kind !== "program") {
    throw new StoreError(400, "bad_request", `${table} is not a table a program made: ${step} writes a column into the table it works on. Make a cleaned table with store_shape first.`);
  }
  if (rec.grp === LOADED_GROUP) {
    throw new StoreError(400, "bad_request", `${table} holds rows a LOAD read from the store's files, which ${step} does not change. Make a cleaned table from it with store_shape, and ${step.toLowerCase()} that.`);
  }
  return { columns: columnsOf(sql, table), group: rec.grp, comment: rec.comment };
}

/** An Answers table's name must be free or one of the store's Answers tables. */
export function answersTableFree(sql: SqlLike, answers: string, table: string): void {
  const own = tableRecord(sql, answers);
  if (answers === table || (own && own.grp !== ANSWERS_GROUP)) throw new StoreError(400, "bad_request", `${answers} is a table of another kind. Give the answers another name.`);
  if (!own && sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type IN ('table', 'view') AND lower(name) = lower(?)", answers).toArray().length) {
    throw new StoreError(400, "bad_request", `${answers} is a table of another kind. Give the answers another name.`);
  }
}

/**
 * The column a step writes its answers into is new, or one its own answers wrote before: never a
 * column the table already had, such as the town's own parcel id.
 */
export function intoFree(sql: SqlLike, table: string, columns: readonly string[], into: string, answers: string): void {
  if (!columns.includes(into)) return;
  const saved = savedJson<SavedAnswers>(sql, answersKey(answers));
  if (saved?.table === table && saved.into === into) return;
  throw new StoreError(400, "bad_request", `${table} already has a column ${into}, which these answers did not write. Give the column another name.`);
}

/** The key columns `changed` names must be columns of the table. */
export function changedColumns(columns: readonly string[], table: string, changed: ChangedRows | null): void {
  for (const k of changed?.key ?? []) columnIn(columns, table, k);
}

/**
 * Each row's answer written into `into`, in place: an Answers table's `take` column (`answer` for
 * CLASSIFY, `matched` for MATCH) by the row's `column` key. The column is added the first time;
 * after it only rows whose answer changed are written. A person's fix to a row's `into` holds: the
 * change applies the table's kept fixes again (`tables.changed`).
 */
export async function answerIntoTable(
  ctx: JobContext<unknown, unknown>,
  opts: { table: string; column: string; into: string; answers: string; take: string; changed: ChangedRows | null; madeBy: MadeBy; intoComment: string },
): Promise<number> {
  const { table, column, into, answers, take } = opts;
  const sql = ctx.sql;
  const columns = columnsOf(sql, table);
  const fresh = !columns.includes(into);
  if (fresh && columns.length >= 100) throw new StoreError(400, "bad_request", `${table} has ${columns.length} columns, and a store's table holds at most 100: there is no room for ${into}.`);
  // A new column is every row's to fill, whichever rows changed.
  const scope = fresh ? { where: "1", params: [] as string[] } : inChanged("t", opts.changed);
  const answer = `(SELECT a.${ident(take)} FROM ${ident(answers)} a WHERE a.key = ${keyOf(`t.${ident(column)}`)})`;
  // A row a person fixed keeps their value without being written and written back on every run.
  const fixed = sql.exec("SELECT 1 AS x FROM _fixes WHERE tbl = ? AND column_name = ? LIMIT 1", table, into).toArray().length > 0;
  const notFixed = fixed ? ` AND NOT EXISTS (SELECT 1 FROM _fixes f WHERE f.tbl = ? AND f.column_name = ? AND f.value IS t.${ident(into)} AND f.was IS ${answer})` : "";
  let written = 0;
  await ctx.tables.changed(table, { madeBy: opts.madeBy, note: `${into} written from ${answers}` }, () => {
    if (fresh) sql.exec(`ALTER TABLE ${ident(table)} ADD COLUMN ${ident(into)} TEXT`);
    // Which rows it wrote, by `_key`, so the steps after it read only those. A new column is every row's.
    const named = !fresh && columns.includes(KEY_COLUMN);
    const cursor = sql.exec<{ k: string }>(
      `UPDATE ${ident(table)} AS t SET ${ident(into)} = ${answer} WHERE ${scope.where} AND t.${ident(into)} IS NOT ${answer}${notFixed}${named ? ` RETURNING ${ident(KEY_COLUMN)} AS k` : ""}`,
      ...scope.params,
      ...(fixed ? [table, into] : []),
    );
    const wrote = named ? keysWritten(cursor) : { written: changes(sql), keys: [] };
    written = wrote.written;
    sql.exec(
      "INSERT INTO _columns (tbl, name, comment) VALUES (?, ?, ?) ON CONFLICT (tbl, name) DO UPDATE SET comment = excluded.comment WHERE _columns.comment IS NOT excluded.comment",
      table,
      into,
      opts.intoComment,
    );
    if (fresh || written === 0) return fresh;
    return named && written <= CHANGE_KEYS_MAX ? { changed: wrote.keys } : true;
  });
  return written;
}

export const classifyHandler: JobHandler<ClassifyParams, ClassifyState, ClassifyResult> = {
  kind: "classify",

  parse(params) {
    if (!isRecord(params)) throw new JobParamsError("CLASSIFY takes the table and column to classify, the list, and the answers to keep.");
    const { table, column, into, answers } = params;
    if (typeof table !== "string" || !table || table.length > 200) throw new JobParamsError("CLASSIFY takes the name of the table to classify.");
    if (typeof column !== "string" || !column || column.length > 200) throw new JobParamsError("CLASSIFY takes the name of the column to classify.");
    for (const [what, name] of [["into", into], ["answers", answers]] as const) {
      if (typeof name !== "string" || !NAME.test(name) || /__(?:v\d+|new)$/.test(name) || isReservedName(name)) {
        throw new JobParamsError(`"${String(name)}" cannot name ${what === "into" ? "a column" : "a table"}: use lowercase words joined by underscores.`);
      }
    }
    if (into === column) throw new JobParamsError(`The class goes into a column of its own: give it another name than ${column}.`);
    if (!Array.isArray(params.classes) || !params.classes.length || params.classes.length > CLASSIFY_CLASSES_MAX) {
      throw new JobParamsError(`CLASSIFY takes a list of 1 to ${CLASSIFY_CLASSES_MAX} classes.`);
    }
    const classes = [...new Set(params.classes.map((c) => (typeof c === "string" ? trimmedText(c) : "")))];
    if (classes.some((c) => !c || c.length > 200)) throw new JobParamsError("Each class is words, at most 200 characters.");
    const sure = Number(params.sure);
    if (!Number.isFinite(sure) || sure < 0 || sure > 1) throw new JobParamsError("sure is a share, 0 to 1.");
    if (!Array.isArray(params.add) || params.add.length > CLASSIFY_ASK_MAX) throw new JobParamsError(`CLASSIFY keeps at most ${CLASSIFY_ASK_MAX} new answers at once.`);
    const listed = new Set(classes);
    const add: ClassifyAnswer[] = params.add.map((a) => {
      if (!isRecord(a) || typeof a.value !== "string" || !trimmedText(a.value) || a.value.length > 2000) throw new JobParamsError("Each answer names its value, at most 2,000 characters.");
      const answer = a.answer === null || a.answer === undefined ? null : String(a.answer);
      if (answer !== null && !listed.has(answer)) throw new JobParamsError(`"${answer}" is not one of the classes.`);
      const s = Number(a.sure);
      if (!Number.isFinite(s) || s < 0 || s > 1) throw new JobParamsError("Each answer's sure is a share, 0 to 1.");
      const note = typeof a.note === "string" && a.note.trim() ? a.note.trim().slice(0, 1000) : null;
      return { value: a.value, answer, sure: s, note };
    });
    if (typeof params.by !== "string" || !params.by || params.by.length > 200) throw new JobParamsError("by names who answered.");
    let changed: ChangedRows | null;
    try {
      changed = changedRowsOf(params.changed);
    } catch (error) {
      throw new JobParamsError(error instanceof Error ? error.message : String(error));
    }
    const madeBy = madeByOf(params.madeBy);
    if (!madeBy) throw new JobParamsError("madeBy names the run and the step, or nothing.");
    return { table, column, into: String(into), answers: String(answers), classes, sure, add, by: params.by, changed, madeBy };
  },

  async run(ctx) {
    const p = ctx.params;
    const sql = ctx.sql;
    const state: ClassifyState = ctx.state ? { ...ctx.state } : { answered: false, added: 0, written: 0 };
    const progress = (note: string) => ({ done: state.added, total: p.add.length, note });
    if (!committedBy(sql, ctx.job.id, p.table)) {
      const target = cleanedTable(sql, p.table, "CLASSIFY");
      columnIn(target.columns, p.table, p.column);
      changedColumns(target.columns, p.table, p.changed);
      answersTableFree(sql, p.answers, p.table);
      if (!state.answered) intoFree(sql, p.table, target.columns, p.into, p.answers);
      if (!state.answered) {
        const exists = tableRecord(sql, p.answers) !== null;
        const at = new Date(ctx.now()).toISOString();
        // A model's answer the list no longer holds is answered again; a person's stays.
        const before = exists ? savedJson<SavedAnswers>(sql, answersKey(p.answers)) : null;
        const relisted = before?.kind === "classify" && JSON.stringify(before.classes ?? []) !== JSON.stringify(p.classes);
        const conflict = relisted
          ? `ON CONFLICT (key) DO UPDATE SET value = excluded.value, answer = excluded.answer, sure = excluded.sure, review = excluded.review, answered_by = excluded.answered_by, answered_at = excluded.answered_at, run_id = excluded.run_id, step = excluded.step, note = excluded.note
             WHERE answered_by LIKE 'model:%' AND (answer IS NULL OR answer NOT IN (SELECT value FROM json_each(?)))`
          : "ON CONFLICT (key) DO NOTHING";
        const keep = () => {
          const table = exists ? p.answers : `${p.answers}__new`;
          const before = Number(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${ident(table)}`).one().n);
          for (const batch of answerBatches(p.add)) {
            sql.exec(
              `INSERT INTO ${ident(table)} (key, value, answer, sure, review, answered_by, answered_at, run_id, step, note, rows)
               SELECT ${keyOf("j.value")}, ${trimmed("j.value")}, j.answer, j.sure, CASE WHEN j.answer IS NULL OR j.sure < ? THEN 1 ELSE 0 END, ?, ?, ?, ?, j.note, 0
               FROM (SELECT json_extract(e.value, '$.value') AS value, json_extract(e.value, '$.answer') AS answer, json_extract(e.value, '$.sure') AS sure, json_extract(e.value, '$.note') AS note FROM json_each(?) e) j
               WHERE ${keyOf("j.value")} <> ''
               ${conflict}`,
              p.sure,
              p.by,
              at,
              p.madeBy.runId,
              p.madeBy.step,
              batch,
              ...(relisted ? [JSON.stringify(p.classes)] : []),
            );
          }
          state.added = Number(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${ident(table)}`).one().n) - before;
          recountAnswers(sql, table, p.table, p.column);
        };
        if (!committedBy(sql, ctx.job.id, p.answers)) {
          if (!exists) {
            // The first run makes the table: one working copy from then on.
            const fresh = ctx.tables.begin(p.answers);
            ctx.commit({ state, progress: progress(`Keeping the answers for ${p.table}.${p.column}`) }, () => {
              sql.exec(ANSWERS_DDL(fresh));
              keep();
            });
            await ctx.tables.commit(p.answers, {
              group: ANSWERS_GROUP,
              madeBy: p.madeBy,
              columns: ANSWER_COLUMNS,
              comment: `What each value of ${p.table}.${p.column} means, as one of ${p.classes.length} classes. A person's answer wins, and every later run keeps it.`,
              dropOld: true,
            });
          } else if (p.add.length) {
            await ctx.tables.changed(p.answers, { madeBy: p.madeBy, note: `${p.add.length} answers asked for` }, () => {
              keep();
              return state.added > 0;
            });
          } else {
            // No new answers: only the rows each one covers, where they changed.
            ctx.commit({ state, progress: progress(`Counting ${p.table}.${p.column}`) }, () => recountAnswers(sql, p.answers, p.table, p.column));
          }
        }
        state.answered = true;
        const saved: SavedAnswers = { kind: "classify", table: p.table, column: p.column, into: p.into, classes: p.classes, sure: p.sure };
        ctx.commit({ state, progress: progress(`Classifying ${p.table}.${p.column}`) }, () => {
          setMeta(sql, answersKey(p.answers), JSON.stringify(saved));
        });
      }
      state.written = await answerIntoTable(ctx as JobContext<unknown, unknown>, {
        table: p.table,
        column: p.column,
        into: p.into,
        answers: p.answers,
        take: "answer",
        changed: p.changed,
        madeBy: p.madeBy,
        intoComment: `What ${p.column} means, from ${p.answers}: one of ${p.classes.length} classes.`,
      });
    }
    const unsure = Number(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${ident(p.answers)} WHERE review = 1`).one().n);
    const unanswered = Number(
      sql
        .exec<{ n: number }>(
          `SELECT count(*) AS n FROM (SELECT ${keyOf(`t.${ident(p.column)}`)} AS k FROM ${ident(p.table)} t WHERE ${hasValue(`t.${ident(p.column)}`)} GROUP BY 1) g WHERE NOT EXISTS (SELECT 1 FROM ${ident(p.answers)} a WHERE a.key = g.k)`,
        )
        .one().n,
    );
    return { result: { table: handleOf(sql, p.table), answers: handleOf(sql, p.answers), added: state.added, written: state.written, unsure, unanswered } };
  },
};
