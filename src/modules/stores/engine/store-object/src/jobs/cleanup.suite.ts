// The cleanup steps in a store's object (PROFILE, CLASSIFY, MATCH, CHECK) and a person's review of
// what they flagged, through the store's own job runner and calls, on the stand-ins for its storage:
// what each step writes on its first run, that a second run with nothing new writes nothing, that a
// run over changed keys touches only those rows, and that a person's fix holds.

import { describe, it, host, stateOf, filesOf, whereBilled } from "../../testing/suite/host.js";
import { countingHex, FakeClock } from "../../testing/suite/stand-ins.js";
import assert from "node:assert/strict";

import type { StoreDeps } from "../core.js";
import { StoreHandler } from "../handler.js";
import type { StoreCaller, StoreResult } from "../types.js";
import { checkHandler } from "./check.js";
import { classifyHandler } from "./classify.js";
import { matchHandler } from "./match.js";
import { profileHandler } from "./profile.js";
import { shapeHandler } from "./shape.js";
import type { JobHandler } from "./types.js";
import type { CheckResult, ClassifyResult, MatchApplyResult, MatchCandidatesResult, ProfileResult } from "../../../store-readers/src/jobs.js";

const STORE = "sto_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PERSON: StoreCaller = { storeId: STORE, actor: "user:u-1" };
const RUN: StoreCaller = { storeId: STORE, actor: "run:mrn-1" };
const madeBy = { runId: "mrn-1", step: "s1" };

function setup() {
  const clock = new FakeClock();
  const storage = host().storage();
  storage.now = clock.now;
  const handlers = [shapeHandler, profileHandler, classifyHandler, matchHandler, checkHandler] as unknown as JobHandler[];
  const deps: StoreDeps = { now: clock.now, randomHex: countingHex, jobs: new Map(handlers.map((h) => [h.kind, h])) };
  const store = new StoreHandler(stateOf(storage) as never, { FILES: filesOf().asBucket() }, deps);
  return { clock, storage, store };
}
type S = ReturnType<typeof setup>;

function value<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
}

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

async function failJob(s: S, kind: string, params: unknown): Promise<string> {
  const job = value(await s.store.jobSubmit(RUN, { kind, params, requestKey: `${kind}:${++keys}` })).job;
  let ended = job;
  for (let i = 0; i < 50 && (ended.state === "queued" || ended.state === "running"); i++) {
    await s.store.alarm();
    s.clock.advance(5_000);
    ended = value(await s.store.job(RUN, job.id)).job;
  }
  assert.equal(ended.state, "failed");
  return ended.error ?? "";
}

/**
 * What `run` wrote, table by table, for a store's data tables (not the store's own `_` tables): the
 * rows each INSERT, UPDATE and DELETE wrote, which is what the platform bills ($1 a million), index
 * entries included: a new answer is its row and its key's entry.
 */
async function writes<T>(s: S, run: () => Promise<T>): Promise<{ value: T; rows: Record<string, number> }> {
  const sql = s.storage.sql as unknown as { exec: (q: string, ...b: unknown[]) => { rowsWritten: number } };
  const exec = sql.exec;
  const rows: Record<string, number> = {};
  sql.exec = function (this: unknown, q: string, ...b: unknown[]) {
    const cursor = exec.call(this, q, ...b);
    const written = /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+[`"]?(\w+)/i.exec(q)?.[1];
    if (written && !written.startsWith("_") && cursor.rowsWritten > 0) rows[written] = (rows[written] ?? 0) + cursor.rowsWritten;
    return cursor;
  };
  try {
    return { value: await run(), rows };
  } finally {
    delete (sql as { exec?: unknown }).exec;
  }
}

const rows = (s: S, sql: string, ...params: unknown[]) => s.storage.sql.exec(sql, ...params).toArray().map((r) => ({ ...r }));
const tables = (s: S) => rows(s, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => String(r.name));

/** A town's permits as a managed table, and `permits` shaped from it the way store_shape makes it. */
async function seed(s: S) {
  value(
    await s.store.exec(PERSON, {
      sql: `CREATE TABLE src (permit_no TEXT, type TEXT, address TEXT, fee TEXT, issued TEXT, _file TEXT, _row INTEGER);
        INSERT INTO src VALUES ('BP-1', 'BLDG', '12 Elm Street', '150.00', '2019-01-07', 'fil_1', 1);
        INSERT INTO src VALUES ('BP-2', 'Bldg ', '400 Main St.', '2,250.50', '2/14/2019', 'fil_1', 2);
        INSERT INTO src VALUES ('BP-3', 'ELEC', 'Unit 4, 22 Oak Ave', '', '2019-03-01', 'fil_1', 3);
        INSERT INTO src VALUES ('BP-4', 'fence', '9 Mill Pond Road', '-75.25', '2019-02-30', 'fil_1', 4);
        INSERT INTO src VALUES ('BP-4', 'Fence', '77 Nowhere Ln', '10', '2019-04-01', 'fil_1', 5);
        INSERT INTO src VALUES ('', 'DEMO', '9 Mill Rd', '0', '', 'fil_1', 6);
        CREATE TABLE parcels (parcel_id TEXT, address TEXT);
        INSERT INTO parcels VALUES ('07-112-004', '12 Elm St'), ('07-201-019', '400 Main St'), ('07-118-022', '22 Oak Ave'), ('08-004-001', '9 Mill Pond Rd'), ('08-004-002', '9 Mill Rd'), ('08-004-003', '9 Mill Rd');`,
    }),
  );
  await runJob(s, "shape", { into: "permits", sql: "SELECT permit_no, type, address, fee, issued, _file, _row FROM src", goal: null, sources: "[]", madeBy });
}

const CLASSES = ["Building", "Electrical", "Fence", "Demolition"];
const classify = (add: { value: string; answer: string | null; sure: number }[], extra: Record<string, unknown> = {}) => ({
  table: "permits",
  column: "type",
  into: "permit_type",
  answers: "answers_permit_type",
  classes: CLASSES,
  sure: 0.9,
  add,
  by: "model:test",
  madeBy,
  ...extra,
});

describe("PROFILE", () => {
  it("says what each column holds over every row, and keeps one profile of the table", async () => {
    const s = setup();
    await seed(s);
    const { value: made, rows: wrote } = await writes(s, () => runJob<ProfileResult>(s, "profile", { table: "permits", into: "permits_profile", madeBy }));
    assert.deepEqual(wrote, { permits_profile__new: 7 }, "one row a column, and no row of permits");
    assert.equal(made.table, "permits_profile");
    assert.equal(made.of.rows, 6);
    const byName = new Map(made.columns.map((c) => [c.column, c]));
    assert.deepEqual(byName.get("fee"), { column: "fee", filled: 0.8333, distinct: 5, type: "number", typeShare: 1 });
    assert.equal(byName.get("issued")?.type, "date");
    assert.equal(byName.get("_row")?.type, "whole number");
    assert.equal(byName.get("type")?.type, "text");
    const issued = rows(s, "SELECT min, max, odd, examples FROM permits_profile WHERE column_name = 'issued'")[0]!;
    assert.equal(issued.min, "2019-01-07");
    assert.equal(issued.max, "2019-04-01");
    // February 30 is no day.
    assert.deepEqual(JSON.parse(String(issued.odd)), ["2019-02-30"]);
    const permitNo = rows(s, "SELECT examples FROM permits_profile WHERE column_name = 'permit_no'")[0]!;
    assert.deepEqual(JSON.parse(String(permitNo.examples))[0], { value: "BP-4", rows: 2 });
    // The catalog's column heads take the whole table's numbers.
    assert.deepEqual(rows(s, "SELECT filled, distinct_n FROM _columns WHERE tbl = 'permits' AND name = 'fee'")[0], { filled: 0.8333, distinct_n: 5 });
    const { value: again, rows: wroteAgain } = await writes(s, () => runJob<ProfileResult>(s, "profile", { table: "permits", into: "permits_profile", madeBy }));
    assert.deepEqual(wroteAgain, {}, "a table that has not changed is not profiled again");
    assert.equal(again.version, 1);
    assert.equal(again.of.rows, 6);
    s.storage.sql.exec("UPDATE _tables SET updated_at = 'later' WHERE name = 'permits'");
    const { value: third, rows: wroteThird } = await writes(s, () => runJob<ProfileResult>(s, "profile", { table: "permits", into: "permits_profile", madeBy }));
    assert.deepEqual(wroteThird, { permits_profile__new: 7 });
    assert.equal(third.version, 2);
    assert.ok(!tables(s).some((t) => t.startsWith("permits_profile__")), "the last profile's copy is dropped");
  });
});

describe("CLASSIFY", () => {
  it("keeps each value's answer once, writes the class into the table, and a second run asks and writes nothing", async () => {
    const s = setup();
    await seed(s);
    const { value: first, rows: wrote } = await writes(s, () =>
      runJob<ClassifyResult>(s, "classify", classify([
        { value: "BLDG", answer: "Building", sure: 0.98 },
        { value: "ELEC", answer: "Electrical", sure: 0.95 },
        { value: "fence", answer: "Fence", sure: 0.97 },
        { value: "DEMO", answer: "Demolition", sure: 0.6 },
      ])),
    );
    whereBilled(() => assert.deepEqual(wrote, { answers_permit_type__new: 12, permits: 6 }, "four answers with their keys' entries, their row counts, and each row's class"));
    assert.equal(first.added, 4);
    assert.equal(first.written, 6, "every row takes its class");
    assert.equal(first.unsure, 1);
    assert.equal(first.unanswered, 0, "'Bldg ' and 'Fence' are the answers of 'BLDG' and 'fence'");
    assert.equal(first.answers.version, 1);
    assert.deepEqual(rows(s, "SELECT permit_no, permit_type FROM permits ORDER BY _row").map((r) => r.permit_type), ["Building", "Building", "Electrical", "Fence", "Fence", "Demolition"]);
    assert.deepEqual(rows(s, "SELECT key, rows, review FROM answers_permit_type ORDER BY key"), [
      { key: "bldg", rows: 2, review: 0 },
      { key: "demo", rows: 1, review: 1 },
      { key: "elec", rows: 1, review: 0 },
      { key: "fence", rows: 2, review: 0 },
    ]);
    const historyBefore = rows(s, "SELECT count(*) AS n FROM _history")[0]!.n;
    const { value: again, rows: wroteAgain } = await writes(s, () => runJob<ClassifyResult>(s, "classify", classify([])));
    assert.deepEqual(wroteAgain, {}, "a run with nothing new writes no row of data");
    assert.equal(rows(s, "SELECT count(*) AS n FROM _history WHERE note LIKE 'permits: permit_type%'")[0]!.n, 1, "and records no change it did not make");
    assert.ok(Number(rows(s, "SELECT count(*) AS n FROM _history")[0]!.n) - Number(historyBefore) <= 1, "only the job's own end");
    assert.equal(again.added, 0);
    assert.equal(again.written, 0, "nothing changed, so nothing is written");
    assert.equal(again.answers.version, 1, "one working copy of the answers");
    assert.ok(!tables(s).some((t) => /__v\d+$/.test(t) && t.startsWith("answers")), "no old copy of the answers is kept");
  });

  it("never replaces a person's answer, and works only on the rows a set of changed keys names", async () => {
    const s = setup();
    await seed(s);
    await runJob<ClassifyResult>(s, "classify", classify([{ value: "BLDG", answer: "Building", sure: 0.98 }]));
    s.storage.sql.exec("UPDATE answers_permit_type SET answer = 'Fence', answered_by = 'user:u-1' WHERE key = 'bldg'");
    const { value: later, rows: wrote } = await writes(s, () => runJob<ClassifyResult>(s, "classify", classify([{ value: "Bldg", answer: "Building", sure: 0.99 }], { changed: { key: ["permit_no"], values: [["BP-2"]] } })));
    assert.deepEqual(wrote, { permits: 1 }, "one row of the table, and nothing in the answers");
    assert.equal(later.added, 0, "the person's answer stands");
    assert.equal(later.written, 1, "only BP-2 is written");
    assert.deepEqual(rows(s, "SELECT permit_no, permit_type FROM permits WHERE permit_no IN ('BP-1', 'BP-2') ORDER BY _row"), [
      { permit_no: "BP-1", permit_type: "Building" },
      { permit_no: "BP-2", permit_type: "Fence" },
    ]);
  });

  it("refuses a table a LOAD made, and an answer that is not on the list", async () => {
    const s = setup();
    await seed(s);
    s.storage.sql.exec("UPDATE _tables SET grp = 'From the town' WHERE name = 'permits'");
    assert.match(await failJob(s, "classify", classify([])), /holds rows a LOAD read/);
    const refused = await s.store.jobSubmit(RUN, { kind: "classify", params: classify([{ value: "X", answer: "Plumbing", sure: 1 }]), requestKey: "bad" });
    assert.ok(!refused.ok && /not one of the classes/.test(refused.error));
  });
});

describe("MATCH", () => {
  const match = (pass: "candidates" | "apply", add: unknown[] = [], extra: Record<string, unknown> = {}) => ({
    pass,
    table: "permits",
    column: "address",
    to: "parcels",
    toColumn: "address",
    take: "parcel_id",
    into: "parcel_id",
    answers: "matches_parcel_id",
    kind: "address",
    sure: 0.9,
    ask: 300,
    add,
    by: "model:test",
    madeBy,
    ...extra,
  });

  it("matches by the same text, then the same words, and offers candidates for the rest", async () => {
    const s = setup();
    await seed(s);
    const { value: found, rows: wrote } = await writes(s, () => runJob<MatchCandidatesResult>(s, "match", match("candidates")));
    assert.deepEqual(wrote, {}, "the candidates pass only reads");
    assert.deepEqual([found.exact, found.normalized, found.known], [0, 4, 0]);
    // "9 Mill Rd" is two parcels that disagree; "77 Nowhere Ln" is no parcel at all.
    assert.equal(found.unmatched, 1);
    assert.deepEqual(found.leftovers.map((l) => [l.value, l.candidates.map((c) => c.take)]), [["9 Mill Rd", ["08-004-002", "08-004-003"]]]);
    assert.deepEqual(tables(s).filter((t) => t.startsWith("matches")), [], "the candidates pass writes nothing");
    // The job's summary counts the values it could not match, and holds none of them.
    const jobId = String(rows(s, "SELECT id FROM _jobs WHERE kind = 'match' ORDER BY created_at DESC, id DESC LIMIT 1")[0]!.id);
    const summary = value(await s.store.jobSummary(RUN, jobId)).summary;
    assert.deepEqual([summary.state, summary.step, summary.counts, summary.tables], ["done", "candidates", { exact: 0, normalized: 4, known: 0, unmatched: 1, more: found.more, leftovers: 1 }, []]);
    for (const held of ["9 Mill Rd", "08-004-002", "08-004-003"]) assert.ok(!JSON.stringify(summary).includes(held), `the summary holds ${held}`);
  });

  it("keeps the rules' and the model's answers, writes the matched column, and a second run writes nothing", async () => {
    const s = setup();
    await seed(s);
    const { value: applied, rows: wrote } = await writes(s, () => runJob<MatchApplyResult>(s, "match", match("apply", [{ value: "9 Mill Rd", take: "08-004-002", sure: 0.7 }])));
    whereBilled(() => assert.deepEqual(wrote, { matches_parcel_id__new: 15, permits: 5 }, "five answers with their keys' entries, their row counts, and each matched row"));
    assert.equal(applied.added, 1);
    assert.equal(applied.unsure, 1);
    assert.equal(applied.written, 5);
    assert.deepEqual(rows(s, "SELECT address, parcel_id FROM permits ORDER BY _row").map((r) => r.parcel_id), ["07-112-004", "07-201-019", "07-118-022", "08-004-001", null, "08-004-002"]);
    assert.deepEqual(rows(s, "SELECT method, count(*) AS n FROM matches_parcel_id GROUP BY method ORDER BY method"), [
      { method: "model", n: 1 },
      { method: "normalized", n: 4 },
    ]);
    const { value: again, rows: wroteAgain } = await writes(s, () => runJob<MatchApplyResult>(s, "match", match("apply")));
    assert.deepEqual(wroteAgain, {}, "a run with nothing new writes no row of data");
    assert.equal(again.written, 0);
    assert.equal(again.answers.version, 1);
    assert.equal(again.known, 1, "the model's answer is not asked again");
  });

  it("drops a rule's answer the reference no longer gives, and keeps a person's", async () => {
    const s = setup();
    await seed(s);
    await runJob<MatchApplyResult>(s, "match", match("apply"));
    s.storage.sql.exec("UPDATE matches_parcel_id SET matched = '07-201-019', method = 'person' WHERE value = '12 Elm Street'");
    s.storage.sql.exec("DELETE FROM parcels WHERE parcel_id IN ('07-118-022', '07-112-004')");
    const { value: again, rows: wrote } = await writes(s, () => runJob<MatchApplyResult>(s, "match", match("apply")));
    // Row 1 takes the person's parcel and row 3 loses its own; the one rule's answer goes.
    assert.deepEqual(wrote, { matches_parcel_id: 1, permits: 2 });
    assert.equal(again.known, 1);
    assert.deepEqual(rows(s, "SELECT parcel_id FROM permits WHERE _row IN (1, 3) ORDER BY _row").map((r) => r.parcel_id), ["07-201-019", null]);
    assert.equal(rows(s, "SELECT count(*) AS n FROM matches_parcel_id WHERE value = 'Unit 4, 22 Oak Ave'")[0]!.n, 0);
  });
});

describe("a column a step adds", () => {
  it("fills every row the first time, whichever rows changed", async () => {
    const s = setup();
    await seed(s);
    const answers = [{ value: "BLDG", answer: "Building", sure: 0.99 }, { value: "ELEC", answer: "Electrical", sure: 0.99 }];
    const done = await runJob<ClassifyResult>(s, "classify", classify(answers, { changed: { key: ["_row"], values: [[3]] } }));
    assert.equal(done.written, 3, "the two rows of BLDG and the row of ELEC, though only row 3 was named");
  });

  it("asks again about a model's answer the list no longer holds, and keeps a person's", async () => {
    const s = setup();
    await seed(s);
    await runJob<ClassifyResult>(s, "classify", classify([{ value: "BLDG", answer: "Building", sure: 0.99 }, { value: "ELEC", answer: "Electrical", sure: 0.99 }, { value: "DEMO", answer: "Demolition", sure: 0.5 }]));
    const page = value(await s.store.reviewRows(PERSON, { table: "answers_permit_type", offset: 0, limit: 50 }));
    const demo = page.rows.find((r) => r.cells[page.columns.indexOf("key")] === "demo")!;
    value(await s.store.reviewFix(PERSON, { table: "answers_permit_type", id: demo.id, column: "answer", value: "Fence" }));
    const relisted = classify([{ value: "BLDG", answer: "Construction", sure: 0.95 }, { value: "DEMO", answer: "Construction", sure: 0.95 }], { classes: ["Construction", "Electrical", "Fence"] });
    await runJob<ClassifyResult>(s, "classify", relisted);
    const kept = (key: string) => rows(s, "SELECT answer FROM answers_permit_type WHERE key = ?", key)[0]!.answer;
    assert.equal(kept("bldg"), "Construction", "a model's answer the list no longer has");
    assert.equal(kept("elec"), "Electrical", "a model's answer the list still has");
    assert.equal(kept("demo"), "Fence", "a person's answer");
  });
});

describe("CHECK", () => {
  const rules = [
    { rule: "required", columns: ["permit_no", "fee"] },
    { rule: "unique", columns: ["permit_no"] },
    { rule: "range", column: "fee", min: 0 },
    { rule: "format", column: "issued", format: "date" },
    { rule: "reference", column: "address", table: "parcels", to: "address" },
  ];
  const check = (extra: Record<string, unknown> = {}) => ({ table: "permits", into: "permits_flags", rules, key: null, words: null, signature: "[]", madeBy, ...extra });

  it("flags each broken rule on its row and column, and a second run writes nothing", async () => {
    const s = setup();
    await seed(s);
    const { value: first, rows: wrote } = await writes(s, () => runJob<CheckResult>(s, "check", check()));
    assert.deepEqual(wrote, { permits_flags__new: 11 }, "one row a broken rule, and no row of permits");
    assert.deepEqual(
      first.rules.map((r) => [r.name, r.rows]),
      [
        ["permit_no is empty", 1],
        ["fee is empty", 1],
        ["permit_no is on more than one row", 2],
        ["fee is below 0", 1],
        ["issued does not read as a date", 1],
        ["address is not in parcels.address", 5],
      ],
    );
    assert.equal(first.flags.version, 1);
    assert.deepEqual(rows(s, "SELECT row_key, problem, column_name, value FROM permits_flags WHERE rule = 3")[0], {
      row_key: '{"_file":"fil_1","_row":4}',
      problem: "fee is below 0",
      column_name: "fee",
      value: "-75.25",
    });
    const { value: again, rows: wroteAgain } = await writes(s, () => runJob<CheckResult>(s, "check", check()));
    assert.deepEqual(wroteAgain, {}, "a run with nothing new writes no flag");
    assert.deepEqual([again.opened, again.closed], [0, 0]);
    assert.equal(again.flags.version, 1);
  });

  it("refuses a table with a column named rowid, which hides the id it flags rows by", async () => {
    const s = setup();
    await seed(s);
    await runJob(s, "shape", { into: "odd", sql: "SELECT permit_no AS rowid, fee FROM src", goal: null, sources: "[]", madeBy });
    const error = await failJob(s, "check", { table: "odd", into: "odd_flags", rules: [{ rule: "required", columns: ["fee"] }], key: null, words: null, signature: "[]", madeBy });
    assert.match(error, /has a column named rowid/);
  });

  it("keeps the new rules with the flags it cleared, should the run stop there", async () => {
    const s = setup();
    await seed(s);
    await runJob<CheckResult>(s, "check", check());
    const sql = s.storage.sql as unknown as { exec: (q: string, ...b: unknown[]) => unknown };
    const exec = sql.exec;
    sql.exec = function (this: unknown, q: string, ...b: unknown[]) {
      if (/^\s*INSERT INTO `permits_flags/.test(q)) throw new Error("the store went down");
      return exec.call(this, q, ...b);
    };
    try {
      await failJob(s, "check", check({ rules: rules.slice(0, 2) }));
    } finally {
      delete (sql as { exec?: unknown }).exec;
    }
    assert.equal(JSON.parse(String(rows(s, "SELECT value FROM _meta WHERE key = 'check:permits'")[0]!.value)).rules.length, 3, "two rules, the first split in two");
  });

  it("keeps its counts when a chunk ends after each rule", async () => {
    const s = setup();
    await seed(s);
    const sql = s.storage.sql as unknown as { exec: (q: string, ...b: unknown[]) => unknown };
    const exec = sql.exec;
    sql.exec = function (this: unknown, q: string, ...b: unknown[]) {
      if (/^\s*INSERT INTO `permits_flags/.test(q)) s.clock.advance(60_000);
      return exec.call(this, q, ...b);
    };
    try {
      const done = await runJob<CheckResult>(s, "check", check());
      assert.equal(done.opened, 11);
      assert.equal(done.flagged, 6);
    } finally {
      delete (sql as { exec?: unknown }).exec;
    }
  });

  it("reads a date with text after it as no date, and a whole number kept as REAL as whole", async () => {
    const s = setup();
    await seed(s);
    value(await s.store.exec(PERSON, { sql: "CREATE TABLE odd (day TEXT, n REAL); INSERT INTO odd VALUES ('2019-03-15xyz', 12.0), ('2019-03-15 10:00', 3.5), ('2019-03-15', 2.0);" }));
    await runJob(s, "shape", { into: "kept", sql: "SELECT day, n FROM odd", goal: null, sources: "[]", madeBy });
    const done = await runJob<CheckResult>(s, "check", { table: "kept", into: "kept_flags", rules: [{ rule: "format", column: "day", format: "date" }, { rule: "format", column: "n", format: "whole number" }], key: null, words: null, signature: "[]", madeBy });
    assert.deepEqual(done.rules.map((r) => r.rows), [1, 1]);
    assert.deepEqual(rows(s, "SELECT rule, value FROM kept_flags ORDER BY rule"), [{ rule: 0, value: "2019-03-15xyz" }, { rule: 1, value: "3.5" }]);
  });

  it("reads a NULL cell as empty, as it reads a blank one", async () => {
    const s = setup();
    await seed(s);
    s.storage.sql.exec("UPDATE permits SET fee = NULL WHERE _row = 1");
    const { value: result, rows: wrote } = await writes(s, () => runJob<CheckResult>(s, "check", check({ rules: [{ rule: "required", columns: ["fee"] }] })));
    assert.deepEqual(result.rules.map((r) => [r.name, r.rows]), [["fee is empty", 2]]);
    assert.deepEqual(wrote, { permits_flags__new: 2 });
  });

  it("tests only the changed rows, closing what keeps the rule now, and starts again when the rules change", async () => {
    const s = setup();
    await seed(s);
    await runJob<CheckResult>(s, "check", check());
    s.storage.sql.exec("UPDATE permits SET fee = '75.25' WHERE _row = 4");
    s.storage.sql.exec("UPDATE permits SET fee = '-1' WHERE _row = 5");
    const { value: changed, rows: wrote } = await writes(s, () => runJob<CheckResult>(s, "check", check({ changed: { key: ["_row"], values: [[4]] } })));
    assert.deepEqual(wrote, { permits_flags: 1 }, "the one flag row 4 no longer earns");
    assert.deepEqual([changed.opened, changed.closed], [0, 1], "row 5 was not among the changed rows");
    const fewer = await runJob<CheckResult>(s, "check", check({ rules: rules.slice(0, 1) }));
    assert.deepEqual(fewer.rules.map((r) => r.rows), [1, 1]);
    assert.equal(rows(s, "SELECT count(*) AS n FROM permits_flags")[0]!.n, 2);
  });
});

describe("a person's review", () => {
  it("lists what waits, fixes a cell, clears its flag, and keeps the fix for the next version", async () => {
    const s = setup();
    await seed(s);
    await runJob<ClassifyResult>(s, "classify", classify([{ value: "DEMO", answer: "Demolition", sure: 0.6 }]));
    await runJob<CheckResult>(s, "check", { table: "permits", into: "permits_flags", rules: [{ rule: "range", column: "fee", min: 0 }, { rule: "unique", columns: ["permit_no"] }], key: null, words: null, signature: "[]", madeBy });
    const listed = value(await s.store.review(PERSON)).tables;
    assert.deepEqual(listed.map((t) => [t.table, t.kind, t.open]), [
      ["answers_permit_type", "answers", 1],
      ["permits", "flags", 2],
    ]);
    const page = value(await s.store.reviewRows(PERSON, { table: "permits", offset: 0, limit: 50 }));
    assert.deepEqual(page.rows.map((r) => r.flags.map((f) => f.problem)), [["fee is below 0", "permit_no is on more than one row"], ["permit_no is on more than one row"]]);
    assert.ok(page.editable.includes("fee") && !page.editable.includes("_row"));
    const id = page.rows[0]!.id;
    const stale = await s.store.reviewFix(PERSON, { table: "permits", id, column: "fee", was: "12", value: "75.25" });
    assert.ok(!stale.ok && stale.code === "changed");
    const { value: answer, rows: wrote } = await writes(s, () => s.store.reviewFix(PERSON, { table: "permits", id, column: "fee", was: "-75.25", value: "75.25" }));
    assert.deepEqual(wrote, { permits: 1, permits_flags: 1 }, "the cell and its flag, and nothing else of the table");
    const fixed = value(answer);
    assert.deepEqual(fixed.row.flags.map((f) => f.problem), ["permit_no is on more than one row"]);
    // A unique rule tests the other row with the old value again too.
    const { value: renamedAnswer, rows: wroteRenamed } = await writes(s, () => s.store.reviewFix(PERSON, { table: "permits", id, column: "permit_no", was: "BP-4", value: "BP-4A" }));
    assert.deepEqual(wroteRenamed, { permits: 1, permits_flags: 2 }, "the cell, its flag and the flag of the row that shared the number");
    const renamed = value(renamedAnswer);
    assert.deepEqual(renamed.row.flags, []);
    assert.equal(renamed.open, 0);
    assert.deepEqual(rows(s, "SELECT tbl, column_name, was, value FROM _fixes ORDER BY column_name"), [
      { tbl: "permits", column_name: "fee", was: "-75.25", value: "75.25" },
      { tbl: "permits", column_name: "permit_no", was: "BP-4", value: "BP-4A" },
    ]);
    // A new version of the table, made from the town's rows again, holds the person's fixes.
    const { rows: wroteShape } = await writes(s, () => runJob(s, "shape", { into: "permits", sql: "SELECT permit_no, type, address, fee, issued, _file, _row FROM src", goal: null, sources: "[]", madeBy }));
    // The SHAPE's own rows are a CREATE TABLE AS, which the stand-in does not count; the fixes are two cells.
    assert.deepEqual(wroteShape, { permits: 2 });
    assert.deepEqual(rows(s, "SELECT permit_no, fee FROM permits WHERE _row = 4")[0], { permit_no: "BP-4A", fee: "75.25" });
  });

  it("narrows the rows to review by a page's filters and search, and counts what is left", async () => {
    const s = setup();
    await seed(s);
    await runJob<CheckResult>(s, "check", { table: "permits", into: "permits_flags", rules: [{ rule: "required", columns: ["permit_no", "fee"] }, { rule: "unique", columns: ["permit_no"] }], key: null, words: null, signature: "[]", madeBy });
    const listed = async (ask: Record<string, unknown>) => value(await s.store.reviewRows(PERSON, { table: "permits", offset: 0, limit: 50, ...ask }));
    const addresses = (page: Awaited<ReturnType<typeof listed>>) => page.rows.map((r) => r.cells[page.columns.indexOf("address")]).sort();
    const all = await listed({});
    assert.deepEqual([all.total, all.open], [4, 4]);
    const fences = await listed({ filters: [{ column: "type", op: "contains", value: "FEN" }] });
    assert.deepEqual(addresses(fences), ["77 Nowhere Ln", "9 Mill Pond Road"]);
    assert.deepEqual([fences.total, fences.open], [2, 4], "the list narrows; what waits in the table does not");
    assert.deepEqual(addresses(await listed({ search: "mill" })), ["9 Mill Pond Road", "9 Mill Rd"]);
    assert.deepEqual(addresses(await listed({ search: "mill", filters: [{ column: "fee", op: "empty" }] })), [], "a search and a filter together");
    assert.deepEqual(addresses(await listed({ filters: [{ column: "fee", op: "empty" }], since: all.at })), ["Unit 4, 22 Oak Ave"]);
    const refused = await s.store.reviewRows(PERSON, { table: "permits", offset: 0, limit: 50, filters: [{ column: "nope", op: "is", value: "x" }] });
    assert.ok(!refused.ok && refused.status === 400 && refused.error === 'This table has no column "nope".');

    // An Answers table narrows its answers the same way.
    await runJob<ClassifyResult>(s, "classify", classify([{ value: "DEMO", answer: null, sure: 0.2 }, { value: "ELEC", answer: "Electrical", sure: 0.5 }]));
    const answers = async (ask: Record<string, unknown>) => value(await s.store.reviewRows(PERSON, { table: "answers_permit_type", offset: 0, limit: 50, ...ask }));
    const keys = (page: Awaited<ReturnType<typeof answers>>) => page.rows.map((r) => r.cells[page.columns.indexOf("key")]).sort();
    assert.deepEqual(keys(await answers({})), ["demo", "elec"]);
    const elec = await answers({ filters: [{ column: "key", op: "is", value: "elec" }] });
    assert.deepEqual([keys(elec), elec.total, elec.open], [["elec"], 1, 2]);
    assert.deepEqual(keys(await answers({ search: "DEM" })), ["demo"]);
  });

  it("lets a person fix the column a program names rows by, and names a fix so it lands on one row only", async () => {
    const s = setup();
    await seed(s);
    const flagged = { table: "permits", into: "permits_flags", rules: [{ rule: "required", columns: ["permit_no"] }, { rule: "required", columns: ["fee"] }, { rule: "unique", columns: ["permit_no"] }], key: ["permit_no"], words: null, signature: "[]", madeBy };
    await runJob<CheckResult>(s, "check", flagged);
    const page = value(await s.store.reviewRows(PERSON, { table: "permits", offset: 0, limit: 50 }));
    assert.ok(page.editable.includes("permit_no"), "the rules flag this column, so a person can fix it");
    const idOf = (row: number) => page.rows.find((r) => r.cells[page.columns.indexOf("_row")] === String(row))!.id;
    // Row 3's number names only it. Row 5 shares BP-4 with row 4, and a fix of the number changes the key.
    value(await s.store.reviewFix(PERSON, { table: "permits", id: idOf(3), column: "fee", was: "", value: "100" }));
    const open = value(await s.store.reviewFix(PERSON, { table: "permits", id: idOf(5), column: "permit_no", was: "BP-4", value: "BP-5" }));
    assert.deepEqual(open.row.flags, []);
    assert.deepEqual(rows(s, "SELECT column_name, key_columns, row_key FROM _fixes ORDER BY column_name"), [
      { column_name: "fee", key_columns: '["permit_no"]', row_key: '{"permit_no":"BP-3"}' },
      { column_name: "permit_no", key_columns: '["_file","_row"]', row_key: '{"_file":"fil_1","_row":5}' },
    ]);
    await runJob(s, "shape", { into: "permits", sql: "SELECT permit_no, type, address, fee, issued, _file, _row FROM src", goal: null, sources: "[]", madeBy });
    assert.deepEqual(rows(s, "SELECT permit_no FROM permits WHERE _row IN (4, 5) ORDER BY _row").map((r) => r.permit_no), ["BP-4", "BP-5"], "row 4 held the same number, and keeps it");
    assert.equal(rows(s, "SELECT fee FROM permits WHERE _row = 3")[0]!.fee, "100");
  });

  it("keeps every row in its place while a person works, and tells them which other rows a fix settled", async () => {
    const s = setup();
    await seed(s);
    await runJob<CheckResult>(s, "check", { table: "permits", into: "permits_flags", rules: [{ rule: "unique", columns: ["permit_no"] }, { rule: "required", columns: ["fee"] }], key: null, words: null, signature: "[]", madeBy });
    const first = value(await s.store.reviewRows(PERSON, { table: "permits", offset: 0, limit: 50 }));
    assert.equal(first.total, 3);
    assert.equal(first.open, 3);
    const rowNo = first.columns.indexOf("_row");
    const order = first.rows.map((r) => r.cells[rowNo]);
    const four = first.rows.find((r) => r.cells[rowNo] === "4")!;
    const five = first.rows.find((r) => r.cells[rowNo] === "5")!;
    s.clock.advance(1_000);
    const fixed = value(await s.store.reviewFix(PERSON, { table: "permits", id: four.id, column: "permit_no", was: "BP-4", value: "BP-9" }));
    assert.deepEqual(fixed.row.flags, []);
    assert.deepEqual(fixed.others.map((r) => [r.id, r.flags]), [[five.id, []]], "the row that shared the number has nothing wrong now");
    assert.equal(fixed.open, 1);
    // A page read after the fix, under the first page's time, lists the same rows in the same order.
    const later = value(await s.store.reviewRows(PERSON, { table: "permits", offset: 0, limit: 50, since: first.at }));
    assert.deepEqual(later.rows.map((r) => r.cells[rowNo]), order);
    assert.equal(later.total, 3);
    assert.equal(later.open, 1);
    assert.deepEqual(later.rows.find((r) => r.id === five.id)!.flags, []);
    // A fresh look shows only what is left.
    assert.equal(value(await s.store.reviewRows(PERSON, { table: "permits", offset: 0, limit: 50 })).total, 1);
  });

  it("reads a table of 100 columns, and a fix of a number lands again on a later version", async () => {
    const s = setup();
    await seed(s);
    const cells = Array.from({ length: 98 }, (_, i) => `${i === 0 ? "''" : `'v${i}'`} AS c${i}`).join(", ");
    await runJob(s, "shape", { into: "wide", sql: `SELECT ${cells}, _file, _row FROM src`, goal: null, sources: "[]", madeBy });
    await runJob<CheckResult>(s, "check", { table: "wide", into: "wide_flags", rules: [{ rule: "required", columns: ["c0"] }], key: null, words: null, signature: "[]", madeBy });
    const wide = value(await s.store.reviewRows(PERSON, { table: "wide", offset: 0, limit: 2 }));
    assert.equal(wide.rows[0]!.cells.length, 100);
    assert.equal(wide.rows[0]!.cells[99], "1");
    value(await s.store.exec(PERSON, { sql: "CREATE TABLE sums (fee REAL, _file TEXT, _row INTEGER); INSERT INTO sums VALUES (-75.25, 'fil_1', 1);" }));
    const shapeSums = { into: "cleaned", sql: "SELECT CASE WHEN fee IS NOT NULL THEN CAST(fee AS REAL) END AS fee, _file, _row FROM sums", goal: null, sources: "[]", madeBy };
    await runJob(s, "shape", shapeSums);
    await runJob<CheckResult>(s, "check", { table: "cleaned", into: "cleaned_flags", rules: [{ rule: "range", column: "fee", min: 0 }], key: null, words: null, signature: "[]", madeBy });
    const page = value(await s.store.reviewRows(PERSON, { table: "cleaned", offset: 0, limit: 5 }));
    value(await s.store.reviewFix(PERSON, { table: "cleaned", id: page.rows[0]!.id, column: "fee", was: "-75.25", value: "75.25" }));
    await runJob(s, "shape", shapeSums);
    assert.equal(String(rows(s, "SELECT fee FROM cleaned")[0]!.fee), "75.25");
  });

  it("tests a table's flags again when a person's answer fills its rows, and refuses to take an empty answer", async () => {
    const s = setup();
    await seed(s);
    await runJob<ClassifyResult>(s, "classify", classify([{ value: "DEMO", answer: null, sure: 0.2 }]));
    await runJob<CheckResult>(s, "check", { table: "permits", into: "permits_flags", rules: [{ rule: "required", columns: ["permit_type"] }], key: null, words: null, signature: "[]", madeBy });
    const open = () => Number(rows(s, "SELECT count(*) AS n FROM permits_flags WHERE state = 'open' AND row_id IN (SELECT rowid FROM permits WHERE _row = 6)")[0]!.n);
    assert.equal(open(), 1);
    const page = value(await s.store.reviewRows(PERSON, { table: "answers_permit_type", offset: 0, limit: 50 }));
    const demo = page.rows.find((r) => r.cells[page.columns.indexOf("key")] === "demo")!;
    const refused = await s.store.reviewFix(PERSON, { table: "answers_permit_type", id: demo.id, column: "answer", accept: true });
    assert.ok(!refused.ok && refused.code === "bad_request", "no answer to take");
    assert.equal(rows(s, "SELECT review FROM answers_permit_type WHERE key = 'demo'")[0]!.review, 1);
    value(await s.store.reviewFix(PERSON, { table: "answers_permit_type", id: demo.id, column: "answer", value: "Demolition" }));
    assert.equal(open(), 0, "the row holds a class now");
    assert.deepEqual(rows(s, "SELECT state, fixed_by FROM permits_flags WHERE row_id IN (SELECT rowid FROM permits WHERE _row = 6)"), [{ state: "fixed", fixed_by: "user:u-1" }]);
  });

  it("leaves a person's fix of a written column alone on later runs", async () => {
    const s = setup();
    await seed(s);
    const answers = [{ value: "BLDG", answer: "Building", sure: 0.99 }];
    await runJob<ClassifyResult>(s, "classify", classify(answers));
    await runJob<CheckResult>(s, "check", { table: "permits", into: "permits_flags", rules: [{ rule: "required", columns: ["permit_no"] }], key: null, words: null, signature: "[]", madeBy });
    const id = Number(rows(s, "SELECT rowid AS id FROM permits WHERE _row = 1")[0]!.id);
    value(await s.store.reviewFix(PERSON, { table: "permits", id, column: "permit_type", was: "Building", value: "Fence" }));
    const { value: again, rows: wrote } = await writes(s, () => runJob<ClassifyResult>(s, "classify", classify([])));
    assert.equal(again.written, 0);
    assert.deepEqual(wrote, {}, "the person's value stays, with nothing written and written back");
    assert.equal(rows(s, "SELECT permit_type FROM permits WHERE _row = 1")[0]!.permit_type, "Fence");
  });

  it("keeps a value that is only a no-break space as a value", async () => {
    const s = setup();
    await seed(s);
    s.storage.sql.exec("UPDATE permits SET type = char(160) WHERE _row = 1");
    const done = await runJob<ClassifyResult>(s, "classify", classify([{ value: "\u00a0", answer: "Building", sure: 0.99 }]));
    assert.equal(done.added, 1);
    assert.equal(rows(s, "SELECT permit_type FROM permits WHERE _row = 1")[0]!.permit_type, "Building");
  });

  it("takes a person's answer, which the rows that hold the value take at once", async () => {
    const s = setup();
    await seed(s);
    await runJob<ClassifyResult>(s, "classify", classify([{ value: "DEMO", answer: "Demolition", sure: 0.6 }, { value: "BLDG", answer: "Fence", sure: 0.5 }]));
    const page = value(await s.store.reviewRows(PERSON, { table: "answers_permit_type", offset: 0, limit: 50 }));
    assert.deepEqual(page.editable, ["answer"]);
    const bldg = page.rows.find((r) => r.cells[page.columns.indexOf("key")] === "bldg")!;
    assert.equal(bldg.flags[0]?.suggestion, "Fence");
    const refused = await s.store.reviewFix(PERSON, { table: "answers_permit_type", id: bldg.id, column: "answer", value: "Shed" });
    assert.ok(!refused.ok && refused.code === "not_a_class");
    const { value: answer, rows: wrote } = await writes(s, () => s.store.reviewFix(PERSON, { table: "answers_permit_type", id: bldg.id, column: "answer", was: "Fence", value: "building" }));
    assert.deepEqual(wrote, { answers_permit_type: 1, permits: 2 }, "the answer, and the two rows that hold its value");
    const fixed = value(answer);
    assert.deepEqual(fixed.row.flags, []);
    assert.equal(fixed.open, 1);
    assert.deepEqual(rows(s, "SELECT permit_type FROM permits WHERE _row IN (1, 2)").map((r) => r.permit_type), ["Building", "Building"]);
    const demo = page.rows.find((r) => r.cells[page.columns.indexOf("key")] === "demo")!;
    const accepted = value(await s.store.reviewFix(PERSON, { table: "answers_permit_type", id: demo.id, column: "answer", accept: true }));
    assert.equal(accepted.open, 0);
    assert.deepEqual(rows(s, "SELECT answered_by, review FROM answers_permit_type WHERE key = 'demo'")[0], { answered_by: "user:u-1", review: 0 });
    // A later run with a model's answer for the same value keeps the person's.
    const { value: later, rows: wroteLater } = await writes(s, () => runJob<ClassifyResult>(s, "classify", classify([{ value: "BLDG", answer: "Fence", sure: 0.99 }])));
    assert.deepEqual(wroteLater, {}, "the model's answer was not kept, and no row changed");
    assert.equal(later.added, 0);
  });
});

describe("CHECK: rules that hold on some rows, and days counted from today", () => {
  // The rehearsal of 2026-11-11: an operator's four sentences, "Every permit has a
  // permit_number, a status_code, a type_code and a parcel_apn; no two permits share a
  // permit_number; no issued_on is after today; a permit whose status_code is ISSUED or FINALED has
  // an issued_on", as the model writes them now. The fourth became no rule then, and "after today"
  // became 2026-12-31, so the ISSUED permit with no issue date passed.
  const REHEARSAL = [
    { rule: "required", columns: ["permit_number", "status_code", "type_code", "parcel_apn"] },
    { rule: "unique", columns: ["permit_number"] },
    { rule: "range", column: "issued_on", max: "today" },
    { rule: "required", columns: ["issued_on"], when: [{ column: "status_code", values: ["ISSUED", "FINALED"] }] },
  ];
  const LA = "America/Los_Angeles";
  /** Noon on 2026-11-12 in Los Angeles; 8 pm in UTC. */
  const NOON_NOV_12_LA = Date.UTC(2026, 10, 12, 20, 0, 0);
  const check = (extra: Record<string, unknown> = {}) => ({ table: "county_permits", into: "county_permits_flags", rules: REHEARSAL, key: null, words: null, signature: "[]", madeBy, zone: LA, ...extra });

  /** A county's permits, cleaned: an ISSUED permit with no issue date, one issued in 2062, one issued tomorrow, and statuses that do not ask for a date. */
  async function seedCounty(s: S) {
    value(
      await s.store.exec(PERSON, {
        sql: `CREATE TABLE county (permit_number TEXT, status_code TEXT, type_code TEXT, parcel_apn TEXT, issued_on TEXT, _file TEXT, _row INTEGER);
          INSERT INTO county VALUES ('BP-2022-0901', 'ISSUED', 'BLDG', '048-0021-007', '2022-03-14', 'fil_1', 1);
          INSERT INTO county VALUES ('BP-2022-0904', 'ISSUED', 'ELEC', '048-0021-011', '', 'fil_1', 2);
          INSERT INTO county VALUES ('BP-2022-0907', 'APPLIED', 'PLMB', '048-0022-003', NULL, 'fil_1', 3);
          INSERT INTO county VALUES ('BP-2023-0112', 'FINALED', 'BLDG', '048-0022-009', '2062-07-04', 'fil_1', 4);
          INSERT INTO county VALUES ('BP-2023-0118', 'VOID', 'DEMO', '048-0023-001', NULL, 'fil_1', 5);
          INSERT INTO county VALUES ('BP-2026-0002', ' issued', 'BLDG', '048-0023-004', '2026-11-13', 'fil_1', 6);`,
      }),
    );
    await runJob(s, "shape", { into: "county_permits", sql: "SELECT permit_number, status_code, type_code, parcel_apn, issued_on, _file, _row FROM county", goal: null, sources: "[]", madeBy });
  }
  const flagsOf = (s: S, rule: number) => rows(s, `SELECT f.problem, f.column_name, f.value, t._row FROM county_permits_flags f JOIN county_permits t ON t.rowid = f.row_id WHERE f.rule = ? AND f.state = 'open' ORDER BY t._row`, rule);

  it("flags the ISSUED permit with no issue date, and reads 'today' as the day the check runs", async () => {
    const s = setup();
    await seedCounty(s);
    s.clock.t = NOON_NOV_12_LA;
    const done = await runJob<CheckResult>(s, "check", check());
    assert.deepEqual(
      done.rules.map((r) => [r.name, r.rows]),
      [
        ["permit_number is empty", 0],
        ["status_code is empty", 0],
        ["type_code is empty", 0],
        ["parcel_apn is empty", 0],
        ["permit_number is on more than one row", 0],
        ["issued_on is after today", 2],
        ["issued_on is empty while status_code is ISSUED or FINALED", 1],
      ],
    );
    assert.equal(done.today, "2026-11-12");
    assert.deepEqual(flagsOf(s, 6), [{ problem: "issued_on is empty while status_code is ISSUED or FINALED", column_name: "issued_on", value: "", _row: 2 }], "the APPLIED and VOID permits ask for no date");
    assert.deepEqual(flagsOf(s, 5).map((f) => [f._row, f.value]), [[4, "2062-07-04"], [6, "2026-11-13"]]);
    const kept = JSON.parse(String(rows(s, "SELECT value FROM _meta WHERE key = 'check:county_permits'")[0]!.value));
    assert.deepEqual([kept.rules[5], kept.rules[6], kept.zone, kept.day], [{ rule: "range", column: "issued_on", min: null, max: "today" }, REHEARSAL[3], LA, "2026-11-12"]);
  });

  it("reads a rule that counts from today over every row on a new day, and only what changed on the same day", async () => {
    const s = setup();
    await seedCounty(s);
    s.clock.t = NOON_NOV_12_LA;
    await runJob<CheckResult>(s, "check", check());
    const { value: same, rows: wroteSame } = await writes(s, () => runJob<CheckResult>(s, "check", check()));
    assert.deepEqual(wroteSame, {}, "the same day, nothing changed: nothing written");
    assert.deepEqual([same.opened, same.closed], [0, 0]);
    s.clock.t = NOON_NOV_12_LA + 24 * 3600_000;
    const { value: next, rows: wroteNext } = await writes(s, () => runJob<CheckResult>(s, "check", check()));
    assert.equal(next.today, "2026-11-13");
    assert.deepEqual([next.opened, next.closed], [0, 1], "the permit issued on the 13th is no longer after today");
    assert.deepEqual(wroteNext, { county_permits_flags: 1 });
    assert.deepEqual(flagsOf(s, 5).map((f) => f._row), [4]);
    assert.equal(JSON.parse(String(rows(s, "SELECT value FROM _meta WHERE key = 'check:county_permits'")[0]!.value)).day, "2026-11-13");
  });

  it("reads today on the clock of the person it runs for, and reads every row again when that clock changes", async () => {
    const s = setup();
    await seedCounty(s);
    // 5 am on the 13th in UTC is 9 pm on the 12th in Los Angeles.
    s.clock.t = Date.UTC(2026, 10, 13, 5, 0, 0);
    const utc = await runJob<CheckResult>(s, "check", check({ zone: null }));
    assert.equal(utc.today, "2026-11-13");
    assert.deepEqual(flagsOf(s, 5).map((f) => f._row), [4]);
    const la = await runJob<CheckResult>(s, "check", check());
    assert.equal(la.today, "2026-11-12");
    assert.deepEqual([la.opened, la.closed], [1, 0]);
    assert.deepEqual(flagsOf(s, 5).map((f) => f._row), [4, 6]);
  });

  it("tests a rule's condition again when a person fixes the column it names, and a day against today", async () => {
    const s = setup();
    await seedCounty(s);
    s.clock.t = NOON_NOV_12_LA;
    await runJob<CheckResult>(s, "check", check());
    const page = value(await s.store.reviewRows(PERSON, { table: "county_permits", offset: 0, limit: 50 }));
    const rowNo = page.columns.indexOf("_row");
    const idOf = (row: number) => page.rows.find((r) => r.cells[rowNo] === String(row))!.id;
    assert.deepEqual(page.rows.find((r) => r.id === idOf(2))!.flags.map((f) => [f.column, f.problem]), [["issued_on", "issued_on is empty while status_code is ISSUED or FINALED"]]);
    // The county wrote the wrong status: the permit was only applied for, and asks for no date.
    const applied = value(await s.store.reviewFix(PERSON, { table: "county_permits", id: idOf(2), column: "status_code", was: "ISSUED", value: "APPLIED" }));
    assert.deepEqual(applied.row.flags, []);
    const finaled = value(await s.store.reviewFix(PERSON, { table: "county_permits", id: idOf(2), column: "status_code", was: "APPLIED", value: "finaled" }));
    assert.deepEqual(finaled.row.flags.map((f) => f.problem), ["issued_on is empty while status_code is ISSUED or FINALED"], "a status written in any case is the same status");
    const dated = value(await s.store.reviewFix(PERSON, { table: "county_permits", id: idOf(2), column: "issued_on", was: "", value: "2022-05-02" }));
    assert.deepEqual(dated.row.flags, []);
    const typo = value(await s.store.reviewFix(PERSON, { table: "county_permits", id: idOf(4), column: "issued_on", was: "2062-07-04", value: "2026-07-04" }));
    assert.deepEqual(typo.row.flags, []);
    assert.equal(typo.open, 1, "the permit issued tomorrow is still after today");
  });

  it("counts a unique rule's repeats among the rows its condition holds on", async () => {
    const s = setup();
    await seedCounty(s);
    s.storage.sql.exec("INSERT INTO county_permits (permit_number, status_code, type_code, parcel_apn, issued_on, _file, _row) VALUES ('BP-2023-0118', 'APPLIED', 'DEMO', '048-0023-001', NULL, 'fil_1', 7)");
    const unique = [{ rule: "unique", columns: ["permit_number"], when: [{ column: "status_code", not: ["VOID"] }] }];
    const done = await runJob<CheckResult>(s, "check", check({ rules: unique }));
    assert.deepEqual(done.rules.map((r) => [r.name, r.rows]), [["permit_number is on more than one row while status_code is not VOID", 0]], "the voided permit's number is free again");
    const page = value(await s.store.reviewRows(PERSON, { table: "county_permits", offset: 0, limit: 50 }));
    assert.equal(page.total, 0);
    const voided = Number(rows(s, "SELECT rowid AS id FROM county_permits WHERE _row = 5")[0]!.id);
    const repeat = Number(rows(s, "SELECT rowid AS id FROM county_permits WHERE _row = 7")[0]!.id);
    const revived = value(await s.store.reviewFix(PERSON, { table: "county_permits", id: voided, column: "status_code", was: "VOID", value: "ISSUED" }));
    assert.deepEqual(revived.row.flags.map((f) => f.problem), ["permit_number is on more than one row while status_code is not VOID"]);
    assert.deepEqual(revived.others.map((r) => [r.id, r.flags.length]), [[repeat, 1]], "the other row with the number is flagged too");
  });

  it("refuses a condition that names no column of the table, and keeps rules with none as they were", async () => {
    const s = setup();
    await seedCounty(s);
    const error = await failJob(s, "check", check({ rules: [{ rule: "required", columns: ["issued_on"], when: [{ column: "status", values: ["ISSUED"] }] }] }));
    assert.match(error, /status/);
    await runJob<CheckResult>(s, "check", check({ rules: [{ rule: "required", columns: ["issued_on"] }] }));
    assert.deepEqual(JSON.parse(String(rows(s, "SELECT value FROM _meta WHERE key = 'check:county_permits'")[0]!.value)).rules, [{ rule: "required", columns: ["issued_on"] }]);
  });
});

describe("CHECK: two columns of one row", () => {
  // The rehearsal's fifth sentence, "no permit is finaled before it is issued", which no rule could
  // say on 2026-11-15: a range whose bound is the row's own issued_on.
  const FINALED = { rule: "range", column: "finaled_on", min: { column: "issued_on" } };
  const PAID = { rule: "range", column: "paid", max: { column: "fee" } };
  const EXPIRES = { rule: "range", column: "expires_on", max: { column: "issued_on", days: 180 } };
  const check = (rules: unknown[], extra: Record<string, unknown> = {}) => ({ table: "permits", into: "permits_flags", rules, key: null, words: null, signature: "[]", madeBy, ...extra });

  /**
   * A county's permits, cleaned: one finaled before it was issued, an issue date written M/D/YYYY,
   * a fee paid twice over, a permit good for more than 180 days, and rows with a value no rule can
   * compare: no issue date, "N/A", "waived", and February 30.
   */
  async function seedDates(s: S) {
    value(
      await s.store.exec(PERSON, {
        sql: `CREATE TABLE county (permit_number TEXT, status_code TEXT, issued_on TEXT, finaled_on TEXT, expires_on TEXT, fee TEXT, paid TEXT, _file TEXT, _row INTEGER);
          INSERT INTO county VALUES ('BP-2023-0120', 'FINALED', '2023-05-10', '2023-04-01', '2023-11-06', '150.00', '150.00', 'fil_1', 1);
          INSERT INTO county VALUES ('BP-2023-0127', 'FINALED', '06/02/2023', '2023-06-30', '2023-12-29', '200', '250', 'fil_1', 2);
          INSERT INTO county VALUES ('BP-2023-0131', 'FINALED', '2023-07-01', '2023-07-01', '2024-06-01', '$1,200.00', '1200', 'fil_1', 3);
          INSERT INTO county VALUES ('BP-2024-0033', 'ISSUED', '', '2024-01-05', NULL, '75', '', 'fil_1', 4);
          INSERT INTO county VALUES ('BP-2024-0040', 'FINALED', '2024-01-02', 'N/A', '2024-06-30', 'waived', '0', 'fil_1', 5);
          INSERT INTO county VALUES ('BP-2024-0052', 'FINALED', '2024-02-30', '2024-01-15', NULL, '50', '40', 'fil_1', 6);
          INSERT INTO county VALUES ('BP-2024-0061', 'ISSUED', '2024-03-01', '2024-04-15', NULL, '60', '60', 'fil_1', 7);`,
      }),
    );
    await runJob(s, "shape", { into: "permits", sql: "SELECT permit_number, status_code, issued_on, finaled_on, expires_on, fee, paid, _file, _row FROM county", goal: null, sources: "[]", madeBy });
  }
  const flagsOf = (s: S, rule: number) => rows(s, `SELECT f.problem, f.column_name, f.value, t._row FROM permits_flags f JOIN permits t ON t.rowid = f.row_id WHERE f.rule = ? AND f.state = 'open' ORDER BY t._row`, rule);

  it("flags the permit finaled before it was issued, reads both columns as days, and leaves alone a row it cannot compare", async () => {
    const s = setup();
    await seedDates(s);
    const done = await runJob<CheckResult>(s, "check", check([FINALED]));
    assert.deepEqual(done.rules.map((r) => [r.name, r.rows]), [["finaled_on is before issued_on", 1]]);
    assert.deepEqual(flagsOf(s, 0), [{ problem: "finaled_on is before issued_on", column_name: "finaled_on", value: "2023-04-01", _row: 1 }], "06/02/2023 is a day too; no issue date, N/A and February 30 compare with nothing");
    const kept = JSON.parse(String(rows(s, "SELECT value FROM _meta WHERE key = 'check:permits'")[0]!.value));
    assert.deepEqual(kept.rules, [{ rule: "range", column: "finaled_on", min: { column: "issued_on" }, max: null }]);
  });

  it("compares a number with a number, and a day with another column's day moved by the days its bound names", async () => {
    const s = setup();
    await seedDates(s);
    const done = await runJob<CheckResult>(s, "check", check([PAID, EXPIRES]));
    assert.deepEqual(
      done.rules.map((r) => [r.name, r.rows]),
      [
        ["paid is above fee", 1],
        ["expires_on is more than 180 days after issued_on", 2],
      ],
    );
    assert.deepEqual(flagsOf(s, 0).map((f) => [f._row, f.value]), [[2, "250"]], "$1,200.00 is 1200, and a waived fee is no number");
    assert.deepEqual(flagsOf(s, 1).map((f) => [f._row, f.value]), [[2, "2023-12-29"], [3, "2024-06-01"]], "180 days after 2023-05-10 is 2023-11-06, and after 2024-01-02, across February 29, 2024-06-30");
  });

  it("tests the rule again when a person fixes either column, and says its words on a flag the fix opens", async () => {
    const s = setup();
    await seedDates(s);
    await runJob<CheckResult>(s, "check", check([FINALED, EXPIRES]));
    const page = value(await s.store.reviewRows(PERSON, { table: "permits", offset: 0, limit: 50 }));
    const rowNo = page.columns.indexOf("_row");
    const first = page.rows.find((r) => r.cells[rowNo] === "1")!;
    const flagged = (r: { flags: { column: string | null; problem: string }[] }) => r.flags.map((f) => [f.column, f.problem]);
    assert.deepEqual(flagged(first), [["finaled_on", "finaled_on is before issued_on"]]);
    // The county wrote the wrong issue date. Fixed, the final date is after it, and the permit runs past 180 days.
    const issued = value(await s.store.reviewFix(PERSON, { table: "permits", id: first.id, column: "issued_on", was: "2023-05-10", value: "2023-03-10" }));
    assert.deepEqual(flagged(issued.row), [["expires_on", "expires_on is more than 180 days after issued_on"]]);
    const finaled = value(await s.store.reviewFix(PERSON, { table: "permits", id: first.id, column: "finaled_on", was: "2023-04-01", value: "2023-03-01" }));
    assert.deepEqual(flagged(finaled.row), [["expires_on", "expires_on is more than 180 days after issued_on"], ["finaled_on", "finaled_on is before issued_on"]]);
    const expires = value(await s.store.reviewFix(PERSON, { table: "permits", id: first.id, column: "expires_on", was: "2023-11-06", value: "2023-09-06" }));
    assert.deepEqual(flagged(expires.row), [["finaled_on", "finaled_on is before issued_on"]], "180 days after 2023-03-10 is 2023-09-06");
  });

  it("says each flag's words by what its row's values read as, and names the rule as most of its flags say it", async () => {
    const s = setup();
    value(
      await s.store.exec(PERSON, {
        sql: `CREATE TABLE marks (submitted TEXT, due TEXT, _file TEXT, _row INTEGER);
          INSERT INTO marks VALUES ('2024-05-02', '2024-05-01', 'fil_1', 1), ('2024-05-03', '5/1/2024', 'fil_1', 2), ('7', '5', 'fil_1', 3), ('2024-05-01', '5', 'fil_1', 4), ('3', '2024-05-01', 'fil_1', 5), ('4', '4.0', 'fil_1', 6);`,
      }),
    );
    await runJob(s, "shape", { into: "marked", sql: "SELECT submitted, due, _file, _row FROM marks", goal: null, sources: "[]", madeBy });
    const done = await runJob<CheckResult>(s, "check", { table: "marked", into: "marked_flags", rules: [{ rule: "range", column: "submitted", max: { column: "due" } }], key: null, words: null, signature: "[]", madeBy });
    assert.deepEqual(done.rules.map((r) => [r.name, r.rows]), [["submitted is after due", 3]]);
    assert.deepEqual(
      rows(s, "SELECT t._row, f.problem FROM marked_flags f JOIN marked t ON t.rowid = f.row_id ORDER BY t._row").map((r) => [r._row, r.problem]),
      [
        [1, "submitted is after due"],
        [2, "submitted is after due"],
        [3, "submitted is above due"],
      ],
      "a day and a number compare with nothing",
    );
  });

  it("compares a value with each bound that has one: a permit with no issue date is still finaled after today", async () => {
    const s = setup();
    await seedDates(s);
    s.clock.t = Date.UTC(2024, 0, 4, 12, 0, 0);
    const done = await runJob<CheckResult>(s, "check", check([{ rule: "range", column: "finaled_on", min: { column: "issued_on" }, max: "today" }], { zone: null }));
    assert.equal(done.today, "2024-01-04");
    assert.deepEqual(done.rules.map((r) => [r.name, r.rows]), [["finaled_on is outside issued_on to today", 4]]);
    assert.deepEqual(flagsOf(s, 0).map((f) => f._row), [1, 4, 6, 7]);
  });

  it("holds a rule on the rows where one column's day is on or after another's", async () => {
    const s = setup();
    await seedDates(s);
    const done = await runJob<CheckResult>(s, "check", check([{ rule: "one_of", column: "status_code", values: ["FINALED"], when: [{ column: "finaled_on", min: { column: "issued_on" } }] }]));
    assert.deepEqual(done.rules.map((r) => [r.name, r.rows]), [["status_code is not one of FINALED while finaled_on is on or after issued_on", 1]]);
    assert.deepEqual(flagsOf(s, 0).map((f) => [f._row, f.value]), [[7, "ISSUED"]]);
  });

  it("tests the rows that changed, a change of the other column included", async () => {
    const s = setup();
    await seedDates(s);
    await runJob<CheckResult>(s, "check", check([FINALED]));
    s.storage.sql.exec("UPDATE permits SET issued_on = '2023-03-10' WHERE _row = 1");
    s.storage.sql.exec("UPDATE permits SET issued_on = '2023-08-01' WHERE _row = 2");
    const changed = await runJob<CheckResult>(s, "check", check([FINALED], { changed: { key: ["_row"], values: [[1]] } }));
    assert.deepEqual([changed.opened, changed.closed], [0, 1], "row 2 was not among the changed rows");
    const every = await runJob<CheckResult>(s, "check", check([FINALED], { changed: { key: ["_row"], values: [[1], [2]] } }));
    assert.deepEqual([every.opened, every.closed], [1, 0]);
    assert.deepEqual(flagsOf(s, 0).map((f) => f._row), [2]);
  });

  it("runs a unique rule that compares three other columns within a statement a store runs, and a fix that settles its repeats", async () => {
    const s = setup();
    await seedDates(s);
    s.storage.sql.exec("INSERT INTO permits (permit_number, status_code, issued_on, finaled_on, expires_on, fee, paid, _file, _row) VALUES ('BP-2023-0131', 'FINALED', '2023-07-01', '2023-07-02', '2024-01-01', '10', '5', 'fil_1', 8)");
    const when = [
      { column: "finaled_on", min: { column: "issued_on" } },
      { column: "expires_on", min: { column: "issued_on" } },
      { column: "paid", max: { column: "fee" } },
    ];
    const done = await runJob<CheckResult>(s, "check", check([{ rule: "unique", columns: ["permit_number"], when }]));
    assert.deepEqual(done.rules.map((r) => [r.name, r.rows]), [["permit_number is on more than one row while finaled_on is on or after issued_on and expires_on is on or after issued_on and paid is at most fee", 2]]);
    const repeat = Number(rows(s, "SELECT rowid AS id FROM permits WHERE _row = 8")[0]!.id);
    const other = Number(rows(s, "SELECT rowid AS id FROM permits WHERE _row = 3")[0]!.id);
    const fixed = value(await s.store.reviewFix(PERSON, { table: "permits", id: repeat, column: "paid", was: "5", value: "50" }));
    assert.deepEqual(fixed.row.flags, [], "paid 50 is above the fee of 10, so the rule no longer holds on the row");
    assert.deepEqual(fixed.others.map((r) => [r.id, r.flags.length]), [[other, 0]], "and the permit it repeated stands alone");
  });
});
