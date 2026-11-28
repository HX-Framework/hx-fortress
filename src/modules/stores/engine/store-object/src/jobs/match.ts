// MATCH: each distinct value of a column matched to a row of a reference table, such as each
// permit's address to a parcel (Stores, Part A, slice E). store_match
// (the api's agent/tools/store-cleanup.ts) runs it as two jobs around the model:
//
//   candidates  reads only. Over the column's distinct values, the rules: the same text as one
//               reference row (`exact`), else the same words once both are read alike
//               (`normalized`: capitals, no punctuation, an address's street words in USPS form,
//               store-readers match-words.ts). A value answered before by a person, or by a
//               model when no rule matches it now, is `known` and asked about no more; one kept with
//               no answer because no model was asked (`askUnasked`) is asked about again. For the rest,
//               the reference rows most like each (sharing the most telling words), at most `ask`
//               values, which the api shows the model.
//   apply       the same rules again and the model's new answers, into the Answers table
//               `matches_<into>` (group "Answers"), made by the first run and changed in place after
//               it; then each row's matched value into the table's `<into>` column, in place (added
//               by the first run; after it only rows whose value changes are written).
//
// A rule's answer is worked out again on every run, so a reference table that grew is read anew:
// it replaces a model's answer, never a person's, and a rule's answer no rule gives now is dropped.
// A model's answer less sure than the program's bar, or "none of them", waits for a person
// (`review` 1). Both passes read only the values of the rows that changed since its last whole run,
// by the store's record (deltas.ts), or of the rows `changed` names; every value when the reference
// table changed, since any answer can change then. Its params and its answers are
// `store-readers/jobs`.

import { candidatesFor, matchIndex, type MatchIndex, ruleMatch } from "../../../store-readers/src/index.js";
import {
  ANSWERS_GROUP,
  answersKey,
  type ChangedRows,
  changedRowsOf,
  madeByOf,
  MATCH_ASK_MAX,
  MATCH_CANDIDATES,
  type MatchAnswer,
  type MatchCounts,
  type MatchKind,
  type MatchLeftover,
  type MatchParams,
  type MatchResult,
  MAX_TABLE_NAME,
  type SavedAnswers,
  trimmedText,
} from "../../../store-readers/src/jobs.js";
import { StoreError } from "../core.js";
import { lastChange } from "../deltas.js";
import { setMeta } from "../schema.js";
import { isReservedName, type SqlLike } from "../sql.js";
import { answerBatches, answerIntoTable, answersTableFree, changedColumns, cleanedTable, intoFree, recountAnswers } from "./classify.js";
import { asLastRead, changes, columnIn, columnsOf, committedBy, dataTable, EVERY_ROW, handleOf, hasValue, ident, inChanged, keyOf, rowsSinceLastRun, tableRecord, trimmed, turn } from "./cleanup-sql.js";
import { type JobContext, type JobHandler, JobParamsError, type ProgramTableColumn } from "./types.js";

/** The most distinct values one MATCH reads, and the most reference rows. */
// What a MATCH holds in memory: about 0.6 KB a value or row, and a store's object has 128 MB.
export const MATCH_VALUES_MAX = 50_000;
export const MATCH_REFS_MAX = 50_000;
/** How sure a rule's answer is. */
const RULE_SURE = { exact: 1, normalized: 0.95 } as const;

export interface MatchState {
  /** Where the pass stands among the column's distinct values, in their key's order. */
  at: number;
  counts: MatchCounts;
  /** candidates: the leftovers with their candidates so far, and how many more had some. */
  leftovers: MatchLeftover[];
  more: number;
  /** apply: the answers table is made (or was there); the answers are kept; model answers kept. */
  begun: boolean;
  answered: boolean;
  added: number;
  /** apply: whether this job wrote any answer, and the rows of the table whose `into` it wrote. */
  touched: boolean;
  written: number;
}

const NAME = new RegExp(`^[a-z][a-z0-9_]{0,${MAX_TABLE_NAME - 1}}$`);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Who answered a value kept with no answer because no model was asked (store_match, a store whose values a model may not read). */
const UNASKED = "model:none";
const zero = (): MatchCounts => ({ exact: 0, normalized: 0, known: 0, unmatched: 0 });

export const MATCH_COLUMNS: ProgramTableColumn[] = [
  { name: "key", comment: "The value in lowercase, without spaces at either end: values that differ only so have one answer." },
  { name: "value", comment: "The value as its table had it." },
  { name: "matched", comment: "The value taken from the reference row it is; empty when no row is." },
  { name: "reference", comment: "The reference row's text it matched." },
  { name: "method", comment: "How: exact (the same text), normalized (the same words), model, or person." },
  { name: "sure", comment: "How sure the answer is, 0 to 1." },
  { name: "review", comment: "1 while the answer waits for a person: a model's answer less sure than the program asks, or none." },
  { name: "answered_by", comment: "Who answered: a rule (rule:exact, rule:normalized), a model (model:<id>) or a person (user:<id>)." },
  { name: "answered_at", comment: "When it was answered." },
  { name: "run_id", comment: "The run that asked." },
  { name: "step", comment: "The step of the run that asked." },
  { name: "note", comment: "Why, in the answerer's words." },
  { name: "rows", comment: "Rows of the table that hold the value." },
];

const MATCH_DDL = (table: string) =>
  `CREATE TABLE ${ident(table)} (key TEXT PRIMARY KEY, value TEXT NOT NULL, matched TEXT, reference TEXT, method TEXT NOT NULL, sure REAL, review INTEGER NOT NULL DEFAULT 0, answered_by TEXT NOT NULL, answered_at TEXT NOT NULL, run_id TEXT, step TEXT, note TEXT, rows INTEGER NOT NULL DEFAULT 0)`;

interface Reference {
  text: string;
  take: string;
}

interface Reading {
  values: { key: string; value: string; rows: number }[];
  refs: Reference[];
  index: MatchIndex;
  /** Values answered before, by key, and how: a person's answer is never changed, a model's stands
   *  unless a rule matches now, and a rule's is worked out again. */
  known: Map<string, "person" | "model" | "rule">;
}

/** How a MATCH of this answers table marks how far it read. */
const readerOf = (p: MatchParams): string => `match:${p.answers}`;

/** The rows whose values this run reads: those `changed` names, else what changed since its last run, or every row once the reference table changed. */
function rowsToMatch(sql: SqlLike, p: MatchParams): { where: string; params: unknown[] } {
  if (p.changed) return inChanged("t", p.changed);
  return asLastRead(sql, readerOf(p), p.to) ? rowsSinceLastRun(sql, "t", p.table, readerOf(p)) : EVERY_ROW;
}

/** The column's distinct values in their key's order (those of the rows `rowsToMatch` names), the
 *  reference rows, and the answers kept before. */
function read(sql: SqlLike, p: MatchParams): Reading {
  const c = `t.${ident(p.column)}`;
  const scope = rowsToMatch(sql, p);
  const values = sql
    .exec<{ key: string; value: string; rows: number }>(
      `SELECT ${keyOf(c)} AS key, min(${trimmed(c)}) AS value, count(*) AS rows FROM ${ident(p.table)} t WHERE ${hasValue(c)} AND ${scope.where} GROUP BY 1 ORDER BY 1 LIMIT ${MATCH_VALUES_MAX + 1}`,
      ...scope.params,
    )
    .toArray()
    .map((r) => ({ key: String(r.key), value: String(r.value), rows: Number(r.rows) }));
  if (values.length > MATCH_VALUES_MAX) throw new StoreError(400, "bad_request", `${p.table}.${p.column} has more than ${MATCH_VALUES_MAX.toLocaleString("en-US")} distinct values, more than one MATCH reads.`);
  const r = `r.${ident(p.toColumn)}`;
  const refs = sql
    .exec<{ text: string; take: string | null }>(`SELECT ${trimmed(r)} AS text, CAST(r.${ident(p.take)} AS TEXT) AS take FROM ${ident(p.to)} r WHERE ${hasValue(r)} LIMIT ${MATCH_REFS_MAX + 1}`)
    .toArray()
    .filter((x) => x.take !== null && x.take !== "")
    .map((x) => ({ text: String(x.text), take: String(x.take) }));
  if (refs.length > MATCH_REFS_MAX) throw new StoreError(400, "bad_request", `${p.to} has more than ${MATCH_REFS_MAX.toLocaleString("en-US")} rows, more than one MATCH reads.`);
  const known = new Map<string, "person" | "model" | "rule">();
  if (tableRecord(sql, p.answers)) {
    for (const row of sql.exec<{ key: string; method: string; answered_by: string; matched: string | null }>(`SELECT key, method, answered_by, matched FROM ${ident(p.answers)}`).toArray()) {
      // Kept with no answer because no model was asked: asked about again once the store shows its values.
      if (p.askUnasked && row.method === "model" && row.answered_by === UNASKED && row.matched === null) continue;
      known.set(String(row.key), row.method === "person" ? "person" : row.method === "model" ? "model" : "rule");
    }
  }
  return { values, refs, index: matchIndex(refs.map((x) => x.text), p.kind), known };
}

type Ruled = { method: "exact" | "normalized"; ref: Reference } | { ambiguous: number[] } | null;

/** What the rules say of a value: one reference row's value, several rows that disagree, or nothing. */
function ruled(reading: Reading, value: string): Ruled {
  const m = ruleMatch(reading.index, value);
  if (!m) return null;
  const takes = new Set(m.at.map((at) => reading.refs[at]!.take));
  if (takes.size === 1) return { method: m.method, ref: reading.refs[m.at[0]!]! };
  return { ambiguous: m.at.slice(0, 50) };
}

/** A leftover's candidates: the rows the rules found but disagree on, or the rows most like it. */
function candidatesOf(reading: Reading, value: string, rule: Ruled): MatchLeftover["candidates"] {
  const found = rule && "ambiguous" in rule ? rule.ambiguous.map((at) => ({ at, score: 1 })) : candidatesFor(reading.index, value, MATCH_CANDIDATES * 3);
  const out: MatchLeftover["candidates"] = [];
  const seen = new Set<string>();
  for (const { at, score } of found) {
    const ref = reading.refs[at]!;
    const id = `${ref.take}\u0000${ref.text}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ reference: ref.text, take: ref.take, score });
    if (out.length >= MATCH_CANDIDATES) break;
  }
  return out;
}

/** Checks the tables and columns a MATCH names. */
function checkNames(sql: SqlLike, p: MatchParams): { columns: string[]; group: string | null; comment: string | null } {
  const target = cleanedTable(sql, p.table, "MATCH");
  columnIn(target.columns, p.table, p.column);
  changedColumns(target.columns, p.table, p.changed);
  dataTable(sql, p.to);
  const refColumns = columnsOf(sql, p.to);
  columnIn(refColumns, p.to, p.toColumn);
  columnIn(refColumns, p.to, p.take);
  if (p.to === p.table) throw new StoreError(400, "bad_request", "MATCH matches a table to another one: the reference table cannot be the table itself.");
  answersTableFree(sql, p.answers, p.table);
  intoFree(sql, p.table, target.columns, p.into, p.answers);
  return target;
}

async function candidatesPass(ctx: JobContext<MatchParams, MatchState>, state: MatchState): Promise<{ more: true } | { result: MatchResult }> {
  const p = ctx.params;
  checkNames(ctx.sql, p);
  const reading = read(ctx.sql, p);
  while (state.at < reading.values.length) {
    if (state.at % 256 === 0) await turn();
    if (ctx.now() >= ctx.deadline) {
      ctx.commit({ state, progress: { done: state.at, total: reading.values.length, note: `Matching ${p.table}.${p.column}` } });
      return { more: true };
    }
    const v = reading.values[state.at]!;
    state.at++;
    const known = reading.known.get(v.key);
    const rule = ruled(reading, v.value);
    if (rule && !("ambiguous" in rule)) {
      if (known === "person") state.counts.known++;
      else state.counts[rule.method]++;
      continue;
    }
    if (known === "person" || known === "model") {
      state.counts.known++;
      continue;
    }
    // Past what a run asks about, scoring buys nothing: the value waits for a later run.
    if (state.leftovers.length >= p.ask) {
      state.more++;
      continue;
    }
    const candidates = candidatesOf(reading, v.value, rule);
    if (!candidates.length) state.counts.unmatched++;
    else state.leftovers.push({ value: v.value, rows: v.rows, candidates });
  }
  return { result: { pass: "candidates", ...state.counts, leftovers: state.leftovers, more: state.more } };
}

/** The answers kept for the rules' matches of a page of values, as one statement's rows. */
interface RuleRow {
  value: string;
  take: string;
  reference: string;
  method: "exact" | "normalized";
  sure: number;
}

/**
 * Writes a page of rule answers: a new value's, or one that changed. A person's answer is never
 * touched, and an answer that says the same is not written again.
 */
function writeRuleAnswers(sql: SqlLike, answers: string, rows: readonly RuleRow[], at: string, madeBy: MatchParams["madeBy"]): number {
  let written = 0;
  for (const batch of answerBatches(rows)) {
    sql.exec(
      `INSERT INTO ${ident(answers)} (key, value, matched, reference, method, sure, review, answered_by, answered_at, run_id, step, note, rows)
       SELECT ${keyOf("j.value")}, ${trimmed("j.value")}, j.take, j.reference, j.method, j.sure, 0, 'rule:' || j.method, ?, ?, ?, NULL, 0
       FROM (SELECT json_extract(e.value, '$.value') AS value, json_extract(e.value, '$.take') AS take, json_extract(e.value, '$.reference') AS reference, json_extract(e.value, '$.method') AS method, json_extract(e.value, '$.sure') AS sure FROM json_each(?) e) j
       WHERE ${keyOf("j.value")} <> ''
       ON CONFLICT (key) DO UPDATE SET matched = excluded.matched, reference = excluded.reference, method = excluded.method, sure = excluded.sure, review = 0,
         answered_by = excluded.answered_by, answered_at = excluded.answered_at, run_id = excluded.run_id, step = excluded.step, note = NULL
       WHERE method <> 'person' AND (matched IS NOT excluded.matched OR reference IS NOT excluded.reference OR method IS NOT excluded.method)`,
      at,
      madeBy.runId,
      madeBy.step,
      batch,
    );
    written += changes(sql);
  }
  return written;
}

async function applyPass(ctx: JobContext<MatchParams, MatchState>, state: MatchState): Promise<{ more: true } | { result: MatchResult }> {
  const p = ctx.params;
  const sql = ctx.sql;
  if (!committedBy(sql, ctx.job.id, p.table)) {
    checkNames(sql, p);
    if (!state.answered && !committedBy(sql, ctx.job.id, p.answers)) {
      const reading = read(sql, p);
      const first = tableRecord(sql, p.answers) === null;
      // The first run fills a new table, swapped in at the end; a later run changes the one there.
      const target = first ? `${p.answers}__new` : p.answers;
      const at = new Date(ctx.now()).toISOString();
      if (!state.begun) {
        state.begun = true;
        if (first) {
          const fresh = ctx.tables.begin(p.answers);
          ctx.commit({ state, progress: { done: 0, total: reading.values.length, note: `Matching ${p.table}.${p.column}` } }, () => sql.exec(MATCH_DDL(fresh)));
        }
      }
      while (state.at < reading.values.length) {
        await turn();
        if (ctx.now() >= ctx.deadline) return { more: true };
        const page: RuleRow[] = [];
        const dropped: string[] = [];
        while (state.at < reading.values.length && page.length < 2000) {
          const v = reading.values[state.at]!;
          state.at++;
          const known = reading.known.get(v.key);
          if (known === "person") {
            state.counts.known++;
            continue;
          }
          const rule = ruled(reading, v.value);
          if (rule && !("ambiguous" in rule)) {
            state.counts[rule.method]++;
            page.push({ value: v.value, take: rule.ref.take, reference: rule.ref.text, method: rule.method, sure: RULE_SURE[rule.method] });
          } else if (known === "model") state.counts.known++;
          // A rule's answer that no rule gives now: the reference table changed under it.
          else if (known === "rule") dropped.push(v.key);
        }
        ctx.commit({ state, progress: { done: state.at, total: reading.values.length, note: `Matching ${p.table}.${p.column}` } }, () => {
          // In a run, the answers it changes in place are kept from here on, for Undo This Run.
          if (!first) ctx.tables.keepRows(p.answers);
          if (writeRuleAnswers(sql, target, page, at, p.madeBy) > 0) state.touched = true;
          if (dropped.length) {
            sql.exec(`DELETE FROM ${ident(target)} WHERE key IN (SELECT value FROM json_each(?)) AND method IN ('exact', 'normalized')`, JSON.stringify(dropped));
            if (changes(sql) > 0) state.touched = true;
          }
        });
      }
      // The model's answers, for values no rule matched; a value it answered with a row's value it
      // was never shown is kept as no answer, for a person.
      const byTake = new Map(reading.refs.map((r) => [r.take, r.text]));
      const add = p.add.map((a) => {
        const reference = a.take === null ? null : (byTake.get(a.take) ?? null);
        return { value: a.value, take: reference === null ? null : a.take, reference, sure: a.sure, note: a.note ?? (a.take !== null && reference === null ? `"${a.take}" is no row of ${p.to}.` : null) };
      });
      const keep = () => {
        const count = (where: string): number => Number(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${ident(target)} WHERE ${where}`).one().n);
        const before = count("method = 'model'");
        const unaskedBefore = count(`answered_by = '${UNASKED}' AND matched IS NULL`);
        for (const batch of answerBatches(add)) {
          // A value kept with no answer because no model was asked takes the model's answer now; any other answer stays.
          sql.exec(
            `INSERT INTO ${ident(target)} (key, value, matched, reference, method, sure, review, answered_by, answered_at, run_id, step, note, rows)
             SELECT ${keyOf("j.value")}, ${trimmed("j.value")}, j.take, j.reference, 'model', j.sure, CASE WHEN j.take IS NULL OR j.sure < ? THEN 1 ELSE 0 END, ?, ?, ?, ?, j.note, 0
             FROM (SELECT json_extract(e.value, '$.value') AS value, json_extract(e.value, '$.take') AS take, json_extract(e.value, '$.reference') AS reference, json_extract(e.value, '$.sure') AS sure, json_extract(e.value, '$.note') AS note FROM json_each(?) e) j
             WHERE ${keyOf("j.value")} <> ''
             ON CONFLICT (key) DO UPDATE SET matched = excluded.matched, reference = excluded.reference, sure = excluded.sure, review = excluded.review, answered_by = excluded.answered_by, answered_at = excluded.answered_at, run_id = excluded.run_id, step = excluded.step, note = excluded.note
             WHERE method = 'model' AND answered_by = '${UNASKED}' AND matched IS NULL`,
            p.sure,
            p.by,
            at,
            p.madeBy.runId,
            p.madeBy.step,
            batch,
          );
        }
        state.added = count("method = 'model'") - before + Math.max(0, unaskedBefore - count(`answered_by = '${UNASKED}' AND matched IS NULL`));
        recountAnswers(sql, target, p.table, p.column);
      };
      if (target !== p.answers) {
        ctx.commit({ state, progress: { done: state.at, total: reading.values.length, note: `Keeping the answers for ${p.table}.${p.column}` } }, keep);
        await ctx.tables.commit(p.answers, {
          group: ANSWERS_GROUP,
          madeBy: p.madeBy,
          columns: MATCH_COLUMNS,
          comment: `Which row of ${p.to} each value of ${p.table}.${p.column} is, by ${p.toColumn}. A person's answer wins, and every later run keeps it.`,
          dropOld: true,
        });
      } else if (state.touched || add.length) {
        await ctx.tables.changed(p.answers, { madeBy: p.madeBy, note: `matched ${p.table}.${p.column}` }, () => {
          keep();
          return state.touched || state.added > 0;
        });
      } else {
        ctx.commit({ state, progress: { done: state.at, total: reading.values.length, note: `Counting ${p.table}.${p.column}` } }, () => recountAnswers(sql, p.answers, p.table, p.column));
      }
    }
    state.answered = true;
    const saved: SavedAnswers = { kind: "match", table: p.table, column: p.column, into: p.into, to: p.to, toColumn: p.toColumn, take: p.take, sure: p.sure };
    ctx.commit({ state, progress: { done: state.at, total: null, note: `Matching ${p.table}.${p.column}` } }, () => {
      setMeta(sql, answersKey(p.answers), JSON.stringify(saved));
    });
    state.written = await answerIntoTable(ctx as JobContext<unknown, unknown>, {
      table: p.table,
      column: p.column,
      into: p.into,
      answers: p.answers,
      take: "matched",
      changed: p.changed,
      madeBy: p.madeBy,
      intoComment: `${p.to}.${p.take} of the row ${p.column} matched, from ${p.answers}.`,
    });
    // Read up to its own write. With values left for a later run, that run reads them again.
    if (!p.changed && p.complete) {
      ctx.commit({ state, progress: { done: state.at, total: null, note: `Matched ${p.table}.${p.column}` } }, () => {
        ctx.tables.markRead(readerOf(p), p.table, lastChange(sql, p.table));
        ctx.tables.markRead(readerOf(p), p.to, lastChange(sql, p.to));
      });
    }
  }
  const unsure = Number(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${ident(p.answers)} WHERE review = 1`).one().n);
  const c = `t.${ident(p.column)}`;
  const unmatched = Number(
    sql
      .exec<{ n: number }>(
        `SELECT count(*) AS n FROM (SELECT ${keyOf(c)} AS k FROM ${ident(p.table)} t WHERE ${hasValue(c)} GROUP BY 1) g WHERE NOT EXISTS (SELECT 1 FROM ${ident(p.answers)} a WHERE a.key = g.k AND a.matched IS NOT NULL)`,
      )
      .one().n,
  );
  return {
    result: { pass: "apply", ...state.counts, unmatched, table: handleOf(sql, p.table), answers: handleOf(sql, p.answers), added: state.added, written: state.written, unsure },
  };
}

export const matchHandler: JobHandler<MatchParams, MatchState, MatchResult> = {
  kind: "match",

  // Undo This Run took back its answers or its column: its next run reads every row.
  undone(params, _table, memory) {
    memory.forgetReader(readerOf(params));
  },

  // What the Answers table answers: Undo This Run writes it back with the table.
  memoryKeys: (params) => [answersKey(params.answers)],

  parse(params) {
    if (!isRecord(params)) throw new JobParamsError("MATCH takes the table and column to match, the reference table, and what to take from it.");
    const pass = params.pass;
    if (pass !== "candidates" && pass !== "apply") throw new JobParamsError('A MATCH pass is "candidates" or "apply".');
    const names = ["table", "column", "to", "toColumn", "take"] as const;
    for (const n of names) {
      const v = params[n];
      if (typeof v !== "string" || !v || v.length > 200) throw new JobParamsError(`MATCH takes ${n} by its name.`);
    }
    for (const [what, name] of [["into", params.into], ["answers", params.answers]] as const) {
      if (typeof name !== "string" || !NAME.test(name) || /__(?:v\d+|new)$/.test(name) || isReservedName(name)) {
        throw new JobParamsError(`"${String(name)}" cannot name ${what === "into" ? "a column" : "a table"}: use lowercase words joined by underscores.`);
      }
    }
    if (params.into === params.column) throw new JobParamsError(`The matched value goes into a column of its own: give it another name than ${String(params.column)}.`);
    const kind: MatchKind = params.kind === "address" ? "address" : "text";
    const sure = Number(params.sure);
    if (!Number.isFinite(sure) || sure < 0 || sure > 1) throw new JobParamsError("sure is a share, 0 to 1.");
    const ask = Math.max(0, Math.min(MATCH_ASK_MAX, Math.floor(Number(params.ask ?? MATCH_ASK_MAX))));
    const rawAdd = params.add ?? [];
    if (!Array.isArray(rawAdd) || rawAdd.length > MATCH_ASK_MAX) throw new JobParamsError(`MATCH keeps at most ${MATCH_ASK_MAX} new answers at once.`);
    const add: MatchAnswer[] = rawAdd.map((a) => {
      if (!isRecord(a) || typeof a.value !== "string" || !trimmedText(a.value) || a.value.length > 2000) throw new JobParamsError("Each answer names its value, at most 2,000 characters.");
      const take = a.take === null || a.take === undefined ? null : String(a.take);
      const s = Number(a.sure);
      if (!Number.isFinite(s) || s < 0 || s > 1) throw new JobParamsError("Each answer's sure is a share, 0 to 1.");
      const note = typeof a.note === "string" && a.note.trim() ? a.note.trim().slice(0, 1000) : null;
      return { value: a.value, take, sure: s, note };
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
    return {
      pass,
      table: String(params.table),
      column: String(params.column),
      to: String(params.to),
      toColumn: String(params.toColumn),
      take: String(params.take),
      into: String(params.into),
      answers: String(params.answers),
      kind,
      sure,
      ask,
      add,
      by: params.by,
      changed,
      ...(params.complete === true ? { complete: true } : {}),
      ...(params.askUnasked === true ? { askUnasked: true } : {}),
      madeBy,
    };
  },

  async run(ctx) {
    const state: MatchState = ctx.state
      ? structuredClone(ctx.state)
      : { at: 0, counts: zero(), leftovers: [], more: 0, begun: false, answered: false, added: 0, touched: false, written: 0 };
    return ctx.params.pass === "candidates" ? candidatesPass(ctx, state) : applyPass(ctx, state);
  },
};
