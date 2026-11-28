// Questions for a store's Guests, in the store's object (questions.ts), on the stand-ins for its
// storage: a question saved before it is sent, the rows a send copies, a Guest's answers in
// `_answers` and in the map's Answers table, what the store refuses, and a CLASSIFY on the same
// column that keeps the Guest's answers as a person's.

import { describe, it, host, stateOf, filesOf } from "../testing/suite/host.js";
import { countingHex, FakeClock } from "../testing/suite/stand-ins.js";
import assert from "node:assert/strict";

import { ANSWERS_GROUP, answersKey, type ClassifyResult, type SavedAnswers } from "../../store-readers/src/jobs.js";
import type { StoreDeps } from "./core.js";
import { StoreHandler } from "./handler.js";
import { classifyHandler } from "./jobs/classify.js";
import { ANSWER_COLUMNS } from "./jobs/classify.js";
import { shapeHandler } from "./jobs/shape.js";
import type { JobHandler } from "./jobs/types.js";
import { QUESTION_TABLES, type MapRowIn, type QuestionDraft } from "./questions.js";
import { SYSTEM_TABLES } from "./sql.js";
import type { StoreCaller, StoreResult } from "./types.js";

const STORE = "sto_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MEMBER: StoreCaller = { storeId: STORE, actor: "user:u-dana" };
const GUEST: StoreCaller = { storeId: STORE, actor: "guest:alice.moreno@county.example" };
const RUN: StoreCaller = { storeId: STORE, actor: "run:mrn-1" };
const madeBy = { runId: "mrn-1", step: "s1" };
const Q = "gqn_0123456789abcdef0123456789abcdef";

function setup() {
  const clock = new FakeClock();
  const storage = host().storage();
  storage.now = clock.now;
  const handlers = [shapeHandler, classifyHandler] as unknown as JobHandler[];
  const deps: StoreDeps = { now: clock.now, randomHex: countingHex, jobs: new Map(handlers.map((h) => [h.kind, h])) };
  const store = new StoreHandler(stateOf(storage) as never, { FILES: filesOf().asBucket() }, deps);
  return { clock, storage, store };
}
type S = ReturnType<typeof setup>;

function value<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
}

function refusal<T>(result: StoreResult<T>): { status: number; code: string } {
  assert.equal(result.ok, false, "the store took it");
  return result.ok ? { status: 0, code: "" } : { status: result.status, code: result.code };
}

const rows = (s: S, sql: string, ...params: unknown[]) => s.storage.sql.exec(sql, ...params).toArray().map((r) => ({ ...r }));

let keys = 0;
async function runJob<R>(s: S, kind: string, params: unknown): Promise<R> {
  const job = value(await s.store.jobSubmit(RUN, { kind, params, requestKey: `${kind}:${++keys}` })).job;
  let ended = job;
  for (let i = 0; i < 200 && (ended.state === "queued" || ended.state === "running"); i++) {
    await s.store.alarm();
    s.clock.advance(5_000);
    ended = value(await s.store.job(RUN, job.id)).job;
  }
  assert.equal(ended.state, "done", ended.error ?? "");
  return ended.result as R;
}

const CHOICES = ["Submitted", "Issued", "Inspections Underway", "Closed", "Expired", "Voided", "Withdrawn"];

const draft = (over: Partial<QuestionDraft> = {}): QuestionDraft => ({
  id: Q,
  kind: "map",
  title: "What each permit status means",
  source: { table: "permits", column: "Status" },
  choices: CHOICES,
  answers: "answers_permit_status",
  upload: "upv_1",
  ...over,
});

/** The county's statuses as the map shows them: the most written spelling, the others, and their rows. */
const MAP_ROWS: MapRowIn[] = [
  { value: "Finaled", also: ["finaled", "FINALED"], rows: 4525 },
  { value: "Issued", also: ["ISSUED"], rows: 1324 },
  { value: "Void", also: [], rows: 97 },
  { value: "Expired", also: [], rows: 92 },
];

describe("a question for a store's Guests", () => {
  it("is saved before it is sent, in tables the store makes on first use and keeps as its own", async () => {
    const s = setup();
    assert.equal(rows(s, "SELECT name FROM sqlite_master WHERE name = '_questions'").length, 0, "no table before the first question");
    const saved = value(await s.store.questionPut(MEMBER, { question: draft() }));
    assert.deepEqual(saved, { question: Q, rows: 0, sentAt: null, answers: null });
    const q = rows(s, "SELECT kind, title, source, choices, answers, upload, made_by, sent_at FROM _questions")[0]!;
    assert.deepEqual(q, {
      kind: "map",
      title: "What each permit status means",
      source: JSON.stringify({ table: "permits", column: "Status" }),
      choices: JSON.stringify(CHOICES),
      answers: "answers_permit_status",
      upload: "upv_1",
      made_by: "user:u-dana",
      sent_at: null,
    });
    // The store's own: listed with its own tables, never as a table of data.
    for (const table of QUESTION_TABLES) assert.ok((SYSTEM_TABLES as readonly string[]).includes(table), table);
    const listed = value(await s.store.catalog(MEMBER)).tables.filter((t) => (QUESTION_TABLES as readonly string[]).includes(t.name));
    assert.ok(listed.every((t) => t.kind === "system"), JSON.stringify(listed));
    // Nothing answers it before it is sent.
    assert.equal(refusal(await s.store.questionAnswer(GUEST, { question: Q, item: "void", answer: "Voided", note: null, name: "Alice Moreno" })).code, "question_not_sent");
  });

  it("sends its rows keyed as an Answers table keys a value, and makes the map's Answers table", async () => {
    const s = setup();
    value(await s.store.questionPut(MEMBER, { question: draft() }));
    const sent = value(await s.store.questionPut(MEMBER, { question: draft(), rows: MAP_ROWS }));
    assert.equal(sent.rows, 4);
    assert.equal(sent.answers, "answers_permit_status");
    assert.ok(sent.sentAt);
    assert.deepEqual(
      rows(s, "SELECT item, position, cells FROM _question_rows WHERE question = ? ORDER BY position", Q).map((r) => [r.item, r.position, JSON.parse(String(r.cells)).rows]),
      [
        ["finaled", 0, 4525],
        ["issued", 1, 1324],
        ["void", 2, 97],
        ["expired", 3, 92],
      ],
    );
    // CLASSIFY's table: its columns (as the store records them, so no host's PRAGMA is asked), in
    // the Answers group, with the map's choices as its list.
    assert.deepEqual(
      rows(s, "SELECT name FROM _columns WHERE tbl = 'answers_permit_status' ORDER BY name").map((r) => r.name),
      ANSWER_COLUMNS.map((c) => c.name).sort(),
    );
    assert.deepEqual(rows(s, "SELECT kind, grp, rows FROM _tables WHERE name = 'answers_permit_status'"), [{ kind: "program", grp: ANSWERS_GROUP, rows: 0 }]);
    const savedAnswers = JSON.parse(String(rows(s, "SELECT value FROM _meta WHERE key = ?", answersKey("answers_permit_status"))[0]!.value)) as SavedAnswers;
    assert.deepEqual(savedAnswers, { kind: "classify", table: "permits", column: "Status", into: "permit_status", classes: CHOICES, sure: 1 });
    // Once sent, where its rows come from stays; its title may change.
    assert.equal(refusal(await s.store.questionPut(MEMBER, { question: draft({ source: { table: "permits", column: "Type" } }) })).code, "question_sent");
    value(await s.store.questionPut(MEMBER, { question: draft({ title: "What each of your statuses means" }) }));
    assert.equal(rows(s, "SELECT title FROM _questions")[0]!.title, "What each of your statuses means");
  });

  it("keeps every answer a Guest gives, and the newest in the map's Answers table, as a person's", async () => {
    const s = setup();
    value(await s.store.questionPut(MEMBER, { question: draft(), rows: MAP_ROWS }));
    const first = value(await s.store.questionAnswer(GUEST, { question: Q, item: "finaled", answer: "closed", note: null, name: "Alice Moreno", upload: "upv_1" }));
    assert.deepEqual(
      { answer: first.answer, answered: first.answered, total: first.total },
      { answer: "Closed", answered: 1, total: 4 },
      "a choice is matched without regard to case, and kept as the question spells it",
    );
    value(await s.store.questionAnswer(GUEST, { question: Q, item: "issued", answer: "Issued", note: null, name: "Alice Moreno" }));
    // A changed answer is a new row; the Answers table holds the newest.
    value(await s.store.questionAnswer(GUEST, { question: Q, item: "finaled", answer: "Closed", note: "Finaled is our word for closed out.", name: "Alice Moreno" }));
    // A note alone answers a row, and waits for a person in the Answers table.
    const noted = value(await s.store.questionAnswer(GUEST, { question: Q, item: "void", answer: null, note: "We void a permit keyed twice.", name: "Alice Moreno" }));
    assert.deepEqual({ answered: noted.answered, total: noted.total }, { answered: 3, total: 4 });
    assert.deepEqual(
      rows(s, "SELECT item, answer, note, by, by_name, upload FROM _answers ORDER BY id"),
      [
        { item: "finaled", answer: "Closed", note: null, by: GUEST.actor, by_name: "Alice Moreno", upload: "upv_1" },
        { item: "issued", answer: "Issued", note: null, by: GUEST.actor, by_name: "Alice Moreno", upload: null },
        { item: "finaled", answer: "Closed", note: "Finaled is our word for closed out.", by: GUEST.actor, by_name: "Alice Moreno", upload: null },
        { item: "void", answer: null, note: "We void a permit keyed twice.", by: GUEST.actor, by_name: "Alice Moreno", upload: null },
      ],
    );
    assert.deepEqual(rows(s, "SELECT key, value, answer, sure, review, answered_by, note, rows FROM answers_permit_status ORDER BY rows DESC"), [
      { key: "finaled", value: "Finaled", answer: "Closed", sure: 1, review: 0, answered_by: GUEST.actor, note: "Finaled is our word for closed out.", rows: 4525 },
      { key: "issued", value: "Issued", answer: "Issued", sure: 1, review: 0, answered_by: GUEST.actor, note: null, rows: 1324 },
      { key: "void", value: "Void", answer: null, sure: 1, review: 1, answered_by: GUEST.actor, note: "We void a permit keyed twice.", rows: 97 },
    ]);
    assert.equal(rows(s, "SELECT rows FROM _tables WHERE name = 'answers_permit_status'")[0]!.rows, 3);
  });

  it("refuses an answer that is not one of the choices, names no row, or says nothing", async () => {
    const s = setup();
    value(await s.store.questionPut(MEMBER, { question: draft(), rows: MAP_ROWS }));
    assert.equal(refusal(await s.store.questionAnswer(GUEST, { question: Q, item: "void", answer: "Cancelled", note: null, name: null })).code, "not_a_choice");
    assert.equal(refusal(await s.store.questionAnswer(GUEST, { question: Q, item: "pending", answer: "Issued", note: null, name: null })).code, "question_row_gone");
    assert.equal(refusal(await s.store.questionAnswer(GUEST, { question: Q, item: "void", answer: null, note: "   ", name: null })).code, "bad_request");
    const gone = refusal(await s.store.questionAnswer(GUEST, { question: "gqn_ffffffffffffffffffffffffffffffff", item: "void", answer: "Voided", note: null, name: null }));
    assert.deepEqual(gone, { status: 404, code: "question_gone" });
    assert.equal(rows(s, "SELECT count(*) AS n FROM _answers")[0]!.n, 0);
  });

  it("refuses an Answers table name that another kind of table holds", async () => {
    const s = setup();
    value(await s.store.exec(MEMBER, { sql: "CREATE TABLE answers_taken (a TEXT)" }));
    const taken = refusal(await s.store.questionPut(MEMBER, { question: draft({ answers: "answers_taken" }), rows: MAP_ROWS }));
    assert.deepEqual(taken, { status: 400, code: "bad_request" });
    // The send was one transaction: nothing of it stays, the tables it made on first use included.
    assert.equal(rows(s, "SELECT count(*) AS n FROM sqlite_master WHERE name = '_questions'")[0]!.n, 0);
  });

  it("holds its Guest's answers through a CLASSIFY of the same column, which answers only what is left", async () => {
    const s = setup();
    value(
      await s.store.exec(MEMBER, {
        sql: `CREATE TABLE src (permit_no TEXT, Status TEXT);
          INSERT INTO src VALUES ('BP-1', 'Finaled'), ('BP-2', 'FINALED'), ('BP-3', 'Issued'), ('BP-4', 'Void'), ('BP-5', 'Expired');`,
      }),
    );
    await runJob(s, "shape", { into: "permits", sql: "SELECT permit_no, Status FROM src", goal: null, sources: "[]", madeBy });
    value(await s.store.questionPut(MEMBER, { question: draft(), rows: MAP_ROWS }));
    value(await s.store.questionAnswer(GUEST, { question: Q, item: "finaled", answer: "Closed", note: null, name: "Alice Moreno" }));
    value(await s.store.questionAnswer(GUEST, { question: Q, item: "void", answer: "Voided", note: null, name: "Alice Moreno" }));
    // A model's answers for every value: only the two nobody answered are kept.
    const classified = await runJob<ClassifyResult>(s, "classify", {
      table: "permits",
      column: "Status",
      into: "permit_status",
      answers: "answers_permit_status",
      classes: CHOICES,
      sure: 0.9,
      add: [
        { value: "Finaled", answer: "Withdrawn", sure: 0.99 },
        { value: "Void", answer: "Withdrawn", sure: 0.99 },
        { value: "Issued", answer: "Issued", sure: 0.97 },
        { value: "Expired", answer: "Expired", sure: 0.96 },
      ],
      by: "model:test",
      madeBy,
    });
    assert.equal(classified.added, 2);
    assert.deepEqual(rows(s, "SELECT key, answer, answered_by FROM answers_permit_status ORDER BY key"), [
      { key: "expired", answer: "Expired", answered_by: "model:test" },
      { key: "finaled", answer: "Closed", answered_by: GUEST.actor },
      { key: "issued", answer: "Issued", answered_by: "model:test" },
      { key: "void", answer: "Voided", answered_by: GUEST.actor },
    ]);
    assert.deepEqual(rows(s, "SELECT permit_no, permit_status FROM permits ORDER BY permit_no").map((r) => r.permit_status), ["Closed", "Closed", "Issued", "Voided", "Expired"]);
  });
});
