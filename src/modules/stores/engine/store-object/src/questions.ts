// Questions for a store's Guests, the store's side: a question a member sends the people outside
// the organization who upload into the store, the rows it shows them, and every answer they give.
// Three of the store's own tables, made the first time a question is saved:
//
//   _questions       one row per question: its kind (`map`: each of the Guest's values to one of
//                    the member's choices), its title, where its rows came from, its choices, the
//                    Answers table its answers fill, the upload it is about, and when it was sent
//   _question_rows   the rows a question shows, copied when it is sent: one per item, which for a
//                    map is a value of the column it came from, keyed as an Answers table keys
//                    it (`answerKeySql`), with its cells: the value as written most, how else it is
//                    written, and how many rows hold it
//   _answers         every answer ever given, one row each: a changed answer is a new row. Who
//                    gave it is the caller's actor (`guest:<address>` or `user:<id>`), with the
//                    name they go by
//
// A map's answers also fill its Answers table (`answers_<name>`, group Answers), in the shape
// CLASSIFY keeps (jobs/classify.ts `ANSWER_COLUMNS`): one row per value, answered by whoever gave
// its newest answer. The table is made when the map is sent, unless a CLASSIFY or an earlier map
// made it. CLASSIFY replaces only a model's answer, so a Guest's answer holds as a person's does.
//
// The caller decides whether a question is open: a question here is sent or not, and whoever may
// answer its rows is the caller's to judge. The store checks what it holds: the question, its rows
// and its choices.

import { ANSWERS_GROUP, answersKey, CLASSIFY_CLASSES_MAX, MAX_TABLE_NAME, type SavedAnswers, trimmedText } from "../../store-readers/src/jobs.js";
import type { StoreCore } from "./core.js";
import { StoreError } from "./core.js";
import { ANSWER_COLUMNS } from "./jobs/classify.js";
import { ident, keyOf, tableRecord } from "./jobs/cleanup-sql.js";
import { savedJson, setMeta } from "./schema.js";
import { isReservedName, tableExists, type SqlLike } from "./sql.js";

/** The store's tables of questions, in the order they are made. */
export const QUESTION_TABLES = ["_questions", "_question_rows", "_answers"] as const;

const QUESTION_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS _questions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('map')),
    title TEXT NOT NULL,
    source TEXT NOT NULL,
    choices TEXT NOT NULL,
    answers TEXT NOT NULL,
    upload TEXT,
    made_at TEXT NOT NULL,
    made_by TEXT NOT NULL,
    sent_at TEXT,
    sent_by TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS _question_rows (
    question TEXT NOT NULL,
    item TEXT NOT NULL,
    position INTEGER NOT NULL,
    cells TEXT NOT NULL,
    PRIMARY KEY (question, item)
  )`,
  `CREATE TABLE IF NOT EXISTS _answers (
    id INTEGER PRIMARY KEY,
    question TEXT NOT NULL,
    item TEXT NOT NULL,
    answer TEXT,
    note TEXT,
    by TEXT NOT NULL,
    by_name TEXT,
    at TEXT NOT NULL,
    upload TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS _answers_item ON _answers (question, item, id)`,
];

/** Makes the tables of questions the first time one is saved; nothing after that. */
export function ensureQuestionTables(sql: SqlLike): void {
  for (const ddl of QUESTION_DDL) sql.exec(ddl);
}

/** The most rows one question shows. */
export const QUESTION_ROWS_MAX = 1000;
/** The most characters of a question's title, of a note and of a name. */
export const QUESTION_TITLE_MAX = 300;
export const ANSWER_NOTE_MAX = 1000;
export const ANSWERER_NAME_MAX = 200;

const QUESTION_ID_RE = /^gqn_[0-9a-f]{32}$/;
const ANSWERS_NAME_RE = new RegExp(`^answers_[a-z0-9_]{1,${MAX_TABLE_NAME - 8}}$`);

/** Where a question's rows came from: a column of one of the store's tables, or a column of a
 *  question's answer, whose rows a numeric column of it may count (`count`). */
export type QuestionSource = { table: string; column: string } | { question: string; column: string; count?: string };

/** A question as a member makes it. */
export interface QuestionDraft {
  /** `gqn_` and 32 hex digits, the id its caller keeps for it. */
  id: string;
  kind: "map";
  title: string;
  source: QuestionSource;
  /** What each of a map's values may be: the member's own list, in the order the Guest sees it. */
  choices: string[];
  /** The Answers table a map's answers fill: `answers_<name>`. */
  answers: string;
  /** The upload the question is about; null for none. */
  upload: string | null;
}

/** One row of a map as its member sends it: a value as written most, how else it is written, and how many rows hold it. */
export interface MapRowIn {
  value: string;
  also: string[];
  rows: number;
}

/** `questionPut`: a question to save. With `rows`, it is sent: the rows it shows replace any it had. */
export interface QuestionPutBody {
  question: QuestionDraft;
  rows?: MapRowIn[];
}

export interface QuestionPutResult {
  question: string;
  /** The rows it shows; 0 while it is not sent. */
  rows: number;
  /** When it was sent; null while it is not. */
  sentAt: string | null;
  /** Its Answers table, once it was sent. */
  answers: string | null;
}

/** `questionAnswer`: one answer to one row of a sent question. */
export interface QuestionAnswerBody {
  question: string;
  /** The row's item, as the question's rows name it. */
  item: string;
  /** One of the choices; null for none, with a note. */
  answer: string | null;
  note: string | null;
  /** The name the answerer goes by, as the member reads it. */
  name: string | null;
  /** The upload the answer is about; null for none. */
  upload?: string | null;
}

export interface QuestionAnswerResult {
  question: string;
  item: string;
  /** The answer as kept: the choice as the question spells it. */
  answer: string | null;
  note: string | null;
  at: string;
  /** Rows of the question with an answer, of the rows it shows. */
  answered: number;
  total: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Words, trimmed, at most `max` characters; null for none. */
function wordsOf(value: unknown, max: number, what: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new StoreError(400, "bad_request", `${what} is text.`);
  const text = trimmedText(value);
  if (text.length > max) throw new StoreError(400, "bad_request", `${what} is at most ${max.toLocaleString("en-US")} characters.`);
  return text || null;
}

function draftOf(raw: unknown): QuestionDraft {
  if (!isRecord(raw)) throw new StoreError(400, "bad_request", "A question names its id, kind, title, source, choices and Answers table.");
  const id = typeof raw.id === "string" && QUESTION_ID_RE.test(raw.id) ? raw.id : null;
  if (!id) throw new StoreError(400, "bad_request", "A question's id is gqn_ and 32 hex digits.");
  if (raw.kind !== "map") throw new StoreError(400, "bad_request", "A question's kind is map.");
  const title = wordsOf(raw.title, QUESTION_TITLE_MAX, "A question's title");
  if (!title) throw new StoreError(400, "bad_request", "A question has a title.");
  const s = raw.source;
  const column = isRecord(s) && typeof s.column === "string" && s.column.length > 0 && s.column.length <= 200 ? s.column : null;
  let source: QuestionSource;
  if (isRecord(s) && column && typeof s.table === "string" && s.table.length > 0 && s.table.length <= 200) source = { table: s.table, column };
  else if (isRecord(s) && column && typeof s.question === "string" && s.question.length > 0 && s.question.length <= 200) {
    const count = typeof s.count === "string" && s.count.length > 0 && s.count.length <= 200 ? s.count : null;
    source = count ? { question: s.question, column, count } : { question: s.question, column };
  }
  else throw new StoreError(400, "bad_request", "A question's rows come from a column of a table or of a question's answer.");
  if (!Array.isArray(raw.choices) || raw.choices.length === 0 || raw.choices.length > CLASSIFY_CLASSES_MAX) {
    throw new StoreError(400, "bad_request", `A map has 1 to ${CLASSIFY_CLASSES_MAX} choices.`);
  }
  const choices: string[] = [];
  for (const c of raw.choices) {
    const choice = typeof c === "string" ? trimmedText(c) : "";
    if (!choice || choice.length > 200) throw new StoreError(400, "bad_request", "Each choice is words, at most 200 characters.");
    if (!choices.includes(choice)) choices.push(choice);
  }
  const answers = typeof raw.answers === "string" && ANSWERS_NAME_RE.test(raw.answers) && !/__(?:v\d+|new)$/.test(raw.answers) && !isReservedName(raw.answers) ? raw.answers : null;
  if (!answers) throw new StoreError(400, "bad_request", "A map's answers go into a table named answers_ and lowercase words joined by underscores.");
  const upload = raw.upload === null || raw.upload === undefined ? null : typeof raw.upload === "string" && raw.upload.length <= 200 ? raw.upload : null;
  return { id, kind: "map", title, source, choices, answers, upload };
}

function mapRowsOf(raw: unknown): MapRowIn[] {
  if (!Array.isArray(raw)) throw new StoreError(400, "bad_request", "A question's rows are a list.");
  if (raw.length === 0) throw new StoreError(400, "bad_request", "A question shows at least one row.");
  if (raw.length > QUESTION_ROWS_MAX) throw new StoreError(400, "bad_request", `A question shows at most ${QUESTION_ROWS_MAX.toLocaleString("en-US")} rows.`);
  return raw.map((r) => {
    if (!isRecord(r) || typeof r.value !== "string" || !trimmedText(r.value) || r.value.length > 2000) throw new StoreError(400, "bad_request", "Each row names its value, at most 2,000 characters.");
    const also = Array.isArray(r.also) ? r.also.filter((a): a is string => typeof a === "string" && a.length <= 2000).slice(0, 20) : [];
    const rows = Number(r.rows);
    if (!Number.isInteger(rows) || rows < 0) throw new StoreError(400, "bad_request", "Each row counts the rows that hold its value.");
    return { value: r.value, also, rows };
  });
}

interface QuestionRecord {
  id: string;
  title: string;
  source: QuestionSource;
  choices: string[];
  answers: string;
  sentAt: string | null;
}

function questionRecord(sql: SqlLike, id: string): QuestionRecord | null {
  if (!tableExists(sql, "_questions")) return null;
  const row = sql.exec<Record<string, string | null>>("SELECT id, title, source, choices, answers, sent_at FROM _questions WHERE id = ?", id).toArray()[0];
  if (!row) return null;
  return {
    id: String(row.id),
    title: String(row.title),
    source: JSON.parse(String(row.source)) as QuestionSource,
    choices: JSON.parse(String(row.choices)) as string[],
    answers: String(row.answers),
    sentAt: row.sent_at === null ? null : String(row.sent_at),
  };
}

/** The CREATE of a map's Answers table: CLASSIFY's columns, in its order (jobs/classify.ts). */
const answersDdl = (table: string): string =>
  `CREATE TABLE ${ident(table)} (key TEXT PRIMARY KEY, value TEXT NOT NULL, answer TEXT, sure REAL, review INTEGER NOT NULL DEFAULT 0, answered_by TEXT NOT NULL, answered_at TEXT NOT NULL, run_id TEXT, step TEXT, note TEXT, rows INTEGER NOT NULL DEFAULT 0)`;

/**
 * The map's Answers table, made when it is first sent, unless a CLASSIFY or an earlier map made
 * it. A table of another kind by that name is refused. What it answers is kept as CLASSIFY keeps
 * it, under `answersKey`, so a CLASSIFY on the same column reads the same list: the map's choices,
 * the newest list a person gave.
 */
function mapAnswersTable(core: StoreCore, actor: string, q: QuestionDraft, now: string): void {
  const sql = core.sql;
  const own = tableRecord(sql, q.answers);
  if (own && own.grp !== ANSWERS_GROUP) throw new StoreError(400, "bad_request", `${q.answers} is a table of another kind. Give the answers another name.`);
  if (!own && sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type IN ('table', 'view') AND lower(name) = lower(?)", q.answers).toArray().length > 0) {
    throw new StoreError(400, "bad_request", `${q.answers} is a table of another kind. Give the answers another name.`);
  }
  const saved = savedJson<SavedAnswers>(sql, answersKey(q.answers));
  if (saved && saved.kind !== "classify") throw new StoreError(400, "bad_request", `${q.answers} holds a MATCH's answers. Give the map's answers another name.`);
  if (!own) {
    sql.exec(answersDdl(q.answers));
    const from = "table" in q.source ? `${q.source.table}.${q.source.column}` : q.source.column;
    sql.exec(
      `INSERT INTO _tables (name, kind, version, grp, made_run, made_step, made_job, made_at, rows, comment, created_at, updated_at, key_from, parked, park_at)
       VALUES (?, 'program', 1, ?, NULL, NULL, NULL, ?, 0, ?, ?, ?, NULL, NULL, NULL)`,
      q.answers,
      ANSWERS_GROUP,
      now,
      `What each value of ${from} means, as one of ${q.choices.length} choices. A person's answer wins, and every later run keeps it.`,
      now,
      now,
    );
    for (const column of ANSWER_COLUMNS) {
      sql.exec("INSERT INTO _columns (tbl, name, comment) VALUES (?, ?, ?) ON CONFLICT (tbl, name) DO UPDATE SET comment = excluded.comment", q.answers, column.name, column.comment ?? null);
    }
    core.history({ kind: "table", by: actor, note: `${q.answers}: made for the question "${q.title}"` });
  }
  const table = "table" in q.source ? q.source.table : (saved?.table ?? "");
  const column = "table" in q.source ? q.source.column : (saved?.column ?? q.source.column);
  const next: SavedAnswers = saved
    ? { ...saved, classes: q.choices }
    : { kind: "classify", table, column, into: q.answers.slice("answers_".length), classes: q.choices, sure: 1 };
  setMeta(sql, answersKey(q.answers), JSON.stringify(next));
}

/**
 * Saves a question a member makes, or sends it: with `rows`, its rows replace any it had, it is
 * marked sent, and a map's Answers table is made. A question already sent keeps where its rows came
 * from and its Answers table; its title and choices may change.
 */
export function questionPut(core: StoreCore, actor: string, body: QuestionPutBody): QuestionPutResult {
  if (!isRecord(body)) throw new StoreError(400, "bad_request", "A question to save names the question.");
  const q = draftOf(body.question);
  const rows = body.rows === undefined || body.rows === null ? null : mapRowsOf(body.rows);
  return core.transaction(() => {
    const sql = core.sql;
    ensureQuestionTables(sql);
    const now = core.nowIso();
    const before = questionRecord(sql, q.id);
    if (before?.sentAt && (JSON.stringify(before.source) !== JSON.stringify(q.source) || before.answers !== q.answers)) {
      throw new StoreError(409, "question_sent", "This question was sent: where its rows come from and its Answers table stay as they were.");
    }
    sql.exec(
      `INSERT INTO _questions (id, kind, title, source, choices, answers, upload, made_at, made_by, sent_at, sent_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT (id) DO UPDATE SET title = excluded.title, source = excluded.source, choices = excluded.choices, answers = excluded.answers, upload = excluded.upload`,
      q.id,
      q.kind,
      q.title,
      JSON.stringify(q.source),
      JSON.stringify(q.choices),
      q.answers,
      q.upload,
      now,
      actor,
    );
    if (!rows) {
      const shown = Number(sql.exec<{ n: number }>("SELECT count(*) AS n FROM _question_rows WHERE question = ?", q.id).one().n);
      // A sent map whose choices changed tells its Answers table the new list.
      if (before?.sentAt) mapAnswersTable(core, actor, q, now);
      return { question: q.id, rows: shown, sentAt: before?.sentAt ?? null, answers: before?.sentAt ? q.answers : null };
    }
    // The rows, keyed in SQL as an Answers table keys a value: one row per key, the first given.
    sql.exec("DELETE FROM _question_rows WHERE question = ?", q.id);
    sql.exec(
      `INSERT INTO _question_rows (question, item, position, cells)
       SELECT ?, ${keyOf("json_extract(e.value, '$.value')")}, CAST(e.key AS INTEGER), e.value FROM json_each(?) e
       WHERE ${keyOf("json_extract(e.value, '$.value')")} <> ''
       ON CONFLICT (question, item) DO NOTHING`,
      q.id,
      JSON.stringify(rows),
    );
    const shown = Number(sql.exec<{ n: number }>("SELECT count(*) AS n FROM _question_rows WHERE question = ?", q.id).one().n);
    if (shown === 0) throw new StoreError(400, "bad_request", "A question shows at least one row with a value.");
    sql.exec("UPDATE _questions SET sent_at = ?, sent_by = ? WHERE id = ?", now, actor, q.id);
    mapAnswersTable(core, actor, q, now);
    core.history({ kind: "table", by: actor, note: `_questions: "${q.title}" sent, with ${shown.toLocaleString("en-US")} rows` });
    return { question: q.id, rows: shown, sentAt: now, answers: q.answers };
  });
}

/** How many of a question's rows have an answer: a choice or a note, in their newest answer. */
function answeredCount(sql: SqlLike, question: string): { answered: number; total: number } {
  const row = sql
    .exec<{ total: number; answered: number }>(
      `SELECT count(*) AS total,
              sum(CASE WHEN a.answer IS NOT NULL OR a.note IS NOT NULL THEN 1 ELSE 0 END) AS answered
       FROM _question_rows r
       LEFT JOIN _answers a ON a.id = (SELECT max(x.id) FROM _answers x WHERE x.question = r.question AND x.item = r.item)
       WHERE r.question = ?`,
      question,
    )
    .one();
  return { answered: Number(row.answered ?? 0), total: Number(row.total ?? 0) };
}

/**
 * One answer to one row of a sent question: a new row of `_answers`, and the row of the map's
 * Answers table, answered by the caller as a person (sure, and waiting for nobody unless it holds
 * only a note). A choice is one of the question's, matched without regard to case.
 */
export function questionAnswer(core: StoreCore, actor: string, body: QuestionAnswerBody): QuestionAnswerResult {
  if (!isRecord(body) || typeof body.question !== "string" || !QUESTION_ID_RE.test(body.question)) throw new StoreError(400, "bad_request", "An answer names its question.");
  if (typeof body.item !== "string" || !body.item || body.item.length > 2000) throw new StoreError(400, "bad_request", "An answer names its row.");
  const typed = wordsOf(body.answer, 200, "An answer");
  const note = wordsOf(body.note, ANSWER_NOTE_MAX, "A note");
  const name = wordsOf(body.name, ANSWERER_NAME_MAX, "A name");
  const upload = typeof body.upload === "string" && body.upload.length <= 200 ? body.upload : null;
  if (typed === null && note === null) throw new StoreError(400, "bad_request", "An answer is a choice, a note, or both.");
  return core.transaction(() => {
    const sql = core.sql;
    const q = questionRecord(sql, body.question);
    if (!q) throw new StoreError(404, "question_gone", "This question is gone from the store.");
    if (!q.sentAt) throw new StoreError(409, "question_not_sent", "This question was not sent yet.");
    const row = sql.exec<{ cells: string }>("SELECT cells FROM _question_rows WHERE question = ? AND item = ?", q.id, body.item).toArray()[0];
    if (!row) throw new StoreError(404, "question_row_gone", "This question shows no such row.");
    let answer: string | null = null;
    if (typed !== null) {
      answer = q.choices.find((c) => c === typed) ?? q.choices.find((c) => c.toLowerCase() === typed.toLowerCase()) ?? null;
      if (answer === null) throw new StoreError(400, "not_a_choice", `"${typed}" is not one of the choices: ${q.choices.slice(0, 12).join(", ")}${q.choices.length > 12 ? " …" : ""}.`);
    }
    const cells = JSON.parse(String(row.cells)) as Partial<MapRowIn>;
    const value = typeof cells.value === "string" ? cells.value : body.item;
    const rows = Number.isInteger(cells.rows) ? Number(cells.rows) : 0;
    const now = core.nowIso();
    sql.exec(
      "INSERT INTO _answers (question, item, answer, note, by, by_name, at, upload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      q.id,
      body.item,
      answer,
      note,
      actor,
      name,
      now,
      upload,
    );
    // The map's Answers table: the row of this value, answered by a person. A table someone took
    // away since the map was sent comes back with this answer.
    if (!tableExists(sql, q.answers)) mapAnswersTable(core, actor, { id: q.id, kind: "map", title: q.title, source: q.source, choices: q.choices, answers: q.answers, upload: null }, now);
    sql.exec(
      `INSERT INTO ${ident(q.answers)} (key, value, answer, sure, review, answered_by, answered_at, run_id, step, note, rows)
       VALUES (?, ?, ?, 1, ?, ?, ?, NULL, NULL, ?, ?)
       ON CONFLICT (key) DO UPDATE SET answer = excluded.answer, sure = 1, review = excluded.review, answered_by = excluded.answered_by,
         answered_at = excluded.answered_at, run_id = NULL, step = NULL, note = excluded.note`,
      body.item,
      value,
      answer,
      answer === null ? 1 : 0,
      actor,
      now,
      note,
      rows,
    );
    const total = Number(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${ident(q.answers)}`).one().n);
    sql.exec("UPDATE _tables SET rows = ?, updated_at = ? WHERE name = ?", total, now, q.answers);
    core.history({ kind: "table", by: actor, note: `${q.answers}: ${answer === null ? "a note" : `"${answer}"`} for "${value}", in answer to "${q.title}"` });
    return { question: q.id, item: body.item, answer, note, at: now, ...answeredCount(sql, q.id) };
  });
}
