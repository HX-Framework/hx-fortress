// A job's summary (summary.ts): the same shape for every kind of job, made only of states, steps,
// times, codes, numbers and the names of tables. Each kind's result is filled here with marked
// cell values wherever its type holds text, and no summary may hold one. The real jobs of a pull,
// a MATCH and a stopped run are summarized in their own suites (pull.suite.ts, cleanup.suite.ts,
// stop.suite.ts).

import assert from "node:assert/strict";

import type { CheckResult, ClassifyResult, LoadResult, MatchApplyResult, MatchCandidatesResult, ParkResult, ProfileResult, ShapeResult } from "../../../store-readers/src/jobs.js";
import type { PullResult } from "../../../store-readers/src/pull.js";
import type { CompareResult, PushPreviewResult, PushResult, PushUndoResult } from "../../../store-readers/src/push.js";

import { describe, it } from "../../testing/suite/host.js";
import type { ExportResult } from "../export.js";
import type { ImportResult } from "../import.js";
import type { Job, JobSummary, JobSummaryTable } from "../types.js";
import { JOB_HANDLERS } from "./index.js";
import { JOB_REFUSALS, JOB_SUMMARY_KINDS, JOB_SUMMARY_SHAPES, jobSummary, jobSummaryShape, type JobSummaryKind } from "./summary.js";
import { SYSTEM_JOB_HANDLERS } from "./system.js";

/** A value of a row, as a result may hold it: no summary may hold one. */
const MARK = "CELL-VALUE";
let cells = 0;
const cell = (words = "18 Mill Road"): string => `${MARK}-${++cells} ${words}`;

const T0 = "2026-11-14T09:14:02.000Z";
const T1 = "2026-11-14T09:14:09.000Z";

function job(kind: string, over: Partial<Job> = {}): Job {
  return { id: "job_00000000000000000000aaaa", kind, requestKey: cell("a request key"), state: "done", progress: null, result: null, error: null, createdAt: T0, updatedAt: T1, estimate: null, rowsWritten: 0, waiting: null, ...over };
}

/** A summary of `kind` with everything a finished job with no result has; `over` says what differs. */
function summaryOf(kind: string, over: Partial<JobSummary> = {}): JobSummary {
  return { id: "job_00000000000000000000aaaa", kind, state: "done", step: null, createdAt: T0, updatedAt: T1, waitsUntil: null, refusal: null, rowsWritten: 0, estimatedRows: null, progress: null, counts: {}, tables: [], ...over };
}

const made = (table: string, version: number | null, rows: number | null, step: string | null = null, counts: Record<string, number> = {}): JobSummaryTable => ({ table, version, rows, step, counts });

/** The words of a result that are no value: a table's name where a handle holds one, and a kind's own words. */
const NAMED = new Set(["table", "pass", "mode", "purpose", "type"]);

/** Every text in `value` that the fixture did not mark, with where it is: the fixtures mark all but names and a kind's own words. */
function unmarked(value: unknown, path = "result"): string[] {
  if (typeof value === "string") return value.startsWith(MARK) ? [] : [`${path} = ${value}`];
  if (Array.isArray(value)) return value.flatMap((v, i) => unmarked(v, `${path}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, v]) => (NAMED.has(key) && typeof v === "string" ? [] : unmarked(v, `${path}.${key}`)));
  }
  return [];
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const FIELDS = ["id", "kind", "state", "step", "createdAt", "updatedAt", "waitsUntil", "refusal", "rowsWritten", "estimatedRows", "progress", "counts", "tables"];

/** Holds a summary to its shape: these fields and no other, and in each only what its kind's shape lists. */
function assertShape(summary: JobSummary): void {
  const shape = jobSummaryShape(summary.kind);
  const counted = (counts: Record<string, number>, names: readonly string[], where: string) => {
    for (const [name, n] of Object.entries(counts)) {
      assert.ok(names.includes(name), `${where} holds a count the shape does not list: ${name}`);
      assert.ok(typeof n === "number" && Number.isFinite(n), `${where}.${name} is no number`);
    }
  };
  assert.deepEqual(Object.keys(summary).sort(), [...FIELDS].sort());
  assert.match(summary.id, /^job_[0-9a-f]{24}$/);
  assert.ok(["queued", "running", "done", "failed"].includes(summary.state));
  assert.ok(summary.step === null || shape.steps.includes(summary.step), `step ${summary.step}`);
  assert.match(summary.createdAt, ISO);
  assert.match(summary.updatedAt, ISO);
  assert.ok(summary.waitsUntil === null || ISO.test(summary.waitsUntil));
  assert.ok(summary.refusal === null || JOB_REFUSALS.includes(summary.refusal));
  assert.ok(Number.isFinite(summary.rowsWritten));
  assert.ok(summary.estimatedRows === null || Number.isFinite(summary.estimatedRows));
  if (summary.progress !== null) {
    assert.deepEqual(Object.keys(summary.progress).sort(), ["done", "total"]);
    assert.ok(Number.isFinite(summary.progress.done) && (summary.progress.total === null || Number.isFinite(summary.progress.total)));
  }
  counted(summary.counts, shape.counts, "counts");
  for (const t of summary.tables) {
    assert.deepEqual(Object.keys(t).sort(), ["counts", "rows", "step", "table", "version"]);
    assert.match(t.table, /^[A-Za-z][A-Za-z0-9_]{0,62}$/);
    assert.ok(t.version === null || Number.isFinite(t.version));
    assert.ok(t.rows === null || Number.isFinite(t.rows));
    assert.ok(t.step === null || shape.tableSteps.includes(t.step), `a table's step ${t.step}`);
    counted(t.counts, shape.tableCounts, `the table ${t.table}`);
  }
}

/** One kind's finished job: its result as its type has it, with every text marked, and the summary it makes. */
interface Case {
  kind: JobSummaryKind;
  what: string;
  result: unknown;
  params?: unknown;
  summary: Partial<JobSummary>;
}

const permits = { table: "permits", version: 2, rows: 1204 };

const CASES: Case[] = [
  {
    kind: "load",
    what: "a file's table, a file it could not read and a file it skipped",
    result: {
      tables: [
        { table: "permits", version: 2, rows: 1204, file: cell("permits-2026.xlsx"), sheet: cell("Sheet1"), notes: [cell("row 40 repeats the header"), cell("3 dates read as text")], changes: { added: 3, changed: 1, removed: 0 }, fullName: cell("a long name"), packed: [cell("a column")] },
        { table: null as unknown as string, version: 0, rows: 0, file: cell("broken.xls"), sheet: null, notes: [cell("the file is no workbook")] },
      ],
      skipped: [{ file: cell("deleted.csv"), why: cell("it was deleted while it loaded") }],
    } satisfies LoadResult,
    summary: { counts: { tables: 1, rows: 1204, skipped: 1, unread: 1 }, tables: [made("permits", 2, 1204, null, { added: 3, changed: 1, removed: 0, notes: 2, packed: 1 })] },
  },
  {
    kind: "shape",
    what: "a table whose changed rows it wrote",
    result: { table: "permits_clean", version: 3, rows: 1200, mode: "changed", added: 2, changed: 5, removed: 1, why: cell("its SQL changed"), broughtBack: [cell("permits_2019")] } satisfies ShapeResult,
    summary: { counts: { broughtBack: 1 }, tables: [made("permits_clean", 3, 1200, "changed", { added: 2, changed: 5, removed: 1 })] },
  },
  { kind: "park", what: "a table it parked", result: { ...permits, parked: true } satisfies ParkResult, summary: { counts: { parked: 1 }, tables: [made("permits", 2, 1204)] } },
  { kind: "bring_back", what: "a table it brought back", result: { ...permits, parked: false } satisfies ParkResult, summary: { counts: { parked: 0 }, tables: [made("permits", 2, 1204)] } },
  {
    kind: "profile",
    what: "a profile of two columns",
    result: {
      table: "permits_profile",
      version: 1,
      rows: 2,
      of: permits,
      columns: [
        { column: cell("address"), filled: 0.98, distinct: 1180, type: "text", typeShare: 1 },
        { column: cell("issued"), filled: 1, distinct: 300, type: "date", typeShare: 0.99 },
      ],
    } satisfies ProfileResult,
    summary: { counts: { columns: 2, profiledRows: 1204 }, tables: [made("permits_profile", 1, 2)] },
  },
  {
    kind: "classify",
    what: "a column it classified",
    result: { table: permits, answers: { table: "answers_permit_type", version: 1, rows: 4 }, added: 4, written: 6, unsure: 1, unanswered: 0 } satisfies ClassifyResult,
    summary: { counts: { added: 4, written: 6, unsure: 1, unanswered: 0 }, tables: [made("permits", 2, 1204), made("answers_permit_type", 1, 4, "answers")] },
  },
  {
    kind: "match",
    what: "a candidates pass, whose result lists the values it could not match",
    result: {
      pass: "candidates",
      exact: 1180,
      normalized: 14,
      known: 6,
      unmatched: 1,
      leftovers: [
        { value: cell("18 Mill Rd"), rows: 3, candidates: [{ reference: cell("18 Mill Road"), take: cell("P-0412"), score: 0.93 }, { reference: cell("18 Mill Row"), take: cell("P-0977"), score: 0.71 }] },
        { value: cell("7 Alder Ct"), rows: 1, candidates: [{ reference: cell("7 Alder Court"), take: cell("P-0413"), score: 0.9 }] },
      ],
      more: 0,
    } satisfies MatchCandidatesResult,
    summary: { step: "candidates", counts: { exact: 1180, normalized: 14, known: 6, unmatched: 1, more: 0, leftovers: 2 } },
  },
  {
    kind: "match",
    what: "an apply pass",
    result: { pass: "apply", exact: 1180, normalized: 14, known: 8, unmatched: 1, table: permits, answers: { table: "matches_parcel_id", version: 1, rows: 5 }, added: 2, written: 5, unsure: 1 } satisfies MatchApplyResult,
    summary: { step: "apply", counts: { exact: 1180, normalized: 14, known: 8, unmatched: 1, added: 2, written: 5, unsure: 1 }, tables: [made("permits", 2, 1204), made("matches_parcel_id", 1, 5, "answers")] },
  },
  {
    kind: "check",
    what: "a check with two rules, whose names are their words",
    result: { flags: { table: "permits_flags", version: 1, rows: 7 }, checked: permits, flagged: 7, opened: 3, closed: 1, rules: [{ name: cell("status is Issued or Final"), rows: 4 }, { name: cell("fee is a number"), rows: 3 }] } satisfies CheckResult,
    summary: { counts: { flagged: 7, opened: 3, closed: 1, rules: 2 }, tables: [made("permits", 2, 1204), made("permits_flags", 1, 7, "flags")] },
  },
  {
    kind: "pull",
    what: "a pull of two tables",
    result: {
      tables: [
        { table: "permits", version: 1, rows: 1204, source: cell("public.permits"), mode: "new", read: 1204, added: 1204, changed: 0, removed: 0, cut: 2 },
        { table: "inspections", version: 4, rows: 310, source: cell("public.inspections"), mode: "change", read: 310, added: 1, changed: 2, removed: 1, cut: 0 },
      ],
    } satisfies PullResult,
    summary: {
      counts: { tables: 2, rows: 1514, read: 1514, added: 1205, changed: 2, removed: 1, cut: 2 },
      tables: [made("permits", 1, 1204, "new", { read: 1204, added: 1204, changed: 0, removed: 0, cut: 2 }), made("inspections", 4, 310, "change", { read: 310, added: 1, changed: 2, removed: 1, cut: 0 })],
    },
  },
  {
    kind: "push_preview",
    what: "a preview of a write",
    result: {
      table: "permits_preview",
      version: 1,
      rows: 12,
      source: cell("permits_clean"),
      target: cell("dbo.Permits"),
      key: [cell("permit_no")],
      columns: [cell("status"), cell("fee")],
      inserts: 5,
      updates: 6,
      deletes: 1,
      held: 0,
      unchanged: 1192,
      targetRows: 1200,
      share: 0.01,
      first: true,
      ignored: [cell("notes")],
      links: [{ column: cell("parcel_id"), to: cell("dbo.Parcels.id"), linked: 5, unlinked: 0, empty: 1 }],
    } satisfies PushPreviewResult,
    summary: { counts: { inserts: 5, updates: 6, deletes: 1, held: 0, unchanged: 1192, targetRows: 1200, first: 1, columns: 2, ignored: 1, links: 1 }, tables: [made("permits_preview", 1, 12)] },
  },
  {
    kind: "push",
    what: "a write that held two rows",
    result: {
      write: cell("job_1"),
      rehearsed: false,
      restored: null,
      manifest: [],
      parts: [{ preview: { table: "permits_preview", version: 1 }, target: cell("dbo.Permits"), inserted: 5, updated: 6, deleted: 1, held: 2, heldTable: { table: "permits_held", version: 1, rows: 2 } }],
      preview: { table: "permits_preview", version: 1 },
      target: cell("dbo.Permits"),
      inserted: 5,
      updated: 6,
      deleted: 1,
      held: 2,
      heldSince: 1,
      batches: 3,
      heldTable: { table: "permits_held", version: 1, rows: 2 },
    } satisfies PushResult,
    summary: { counts: { inserted: 5, updated: 6, deleted: 1, held: 2, heldSince: 1, batches: 3, rehearsed: 0, parts: 1 }, tables: [made("permits_held", 1, 2, "held")] },
  },
  {
    kind: "push",
    what: "a rehearsal, with its manifest",
    result: {
      write: cell("job_2"),
      rehearsed: true,
      restored: 12,
      manifest: [{ table: "permits_manifest", version: 1, rows: 12 }],
      parts: [],
      preview: { table: "permits_preview", version: 1 },
      target: cell("dbo.Permits"),
      inserted: 5,
      updated: 6,
      deleted: 1,
      held: 0,
      heldSince: 0,
      batches: 1,
      heldTable: null,
    } satisfies PushResult,
    summary: { counts: { inserted: 5, updated: 6, deleted: 1, held: 0, heldSince: 0, batches: 1, rehearsed: 1, restored: 12, parts: 0 }, tables: [made("permits_manifest", 1, 12, "manifest")] },
  },
  {
    kind: "push_undo",
    what: "an undo",
    result: {
      write: cell("job_1"),
      target: cell("dbo.Permits"),
      removed: 5,
      putBack: 6,
      reinserted: 1,
      held: 0,
      heldTable: null,
      parts: [{ target: cell("dbo.Permits"), removed: 5, putBack: 6, reinserted: 1, held: 0, heldTable: null }],
    } satisfies PushUndoResult,
    summary: { counts: { removed: 5, putBack: 6, reinserted: 1, held: 0, parts: 1 } },
  },
  {
    kind: "compare",
    what: "a compare",
    result: {
      table: "permits_compare",
      version: 1,
      rows: 9,
      source: cell("permits_clean"),
      target: cell("dbo.Permits"),
      key: [cell("permit_no")],
      columns: [cell("status"), cell("fee"), cell("issued")],
      storeRows: 1204,
      databaseRows: 1210,
      matching: 1195,
      onlyInStore: 3,
      onlyInDatabase: 2,
      differing: 4,
      otherRows: 6,
      unlisted: 0,
    } satisfies CompareResult,
    summary: { counts: { storeRows: 1204, databaseRows: 1210, matching: 1195, onlyInStore: 3, onlyInDatabase: 2, differing: 4, otherRows: 6, unlisted: 0, columns: 3 }, tables: [made("permits_compare", 1, 9)] },
  },
  {
    kind: "export",
    what: "an export",
    result: { exportId: cell("exp_1"), purpose: "download", mode: "whole", bytes: 4_096_000, pages: 1000, tables: 6, rows: 20_000, files: 2, fileBytes: 9000, replaced: 0, filesLeftOut: 0, parkedLeftOut: [cell("permits_2019")] } satisfies ExportResult,
    summary: { counts: { bytes: 4_096_000, pages: 1000, tables: 6, rows: 20_000, files: 2, fileBytes: 9000, replaced: 0, filesLeftOut: 0, parkedLeftOut: 1 } },
  },
  { kind: "import", what: "an import", result: { tables: 6, rows: 20_000, files: 2, fileBytes: 9000, migrations: 3, users: 4 } satisfies ImportResult, summary: { counts: { tables: 6, rows: 20_000, files: 2, fileBytes: 9000, migrations: 3, users: 4 } } },
];

describe("a job's summary", () => {
  it("has a shape for every kind of job a store runs, and for no other", () => {
    assert.deepEqual([...JOB_SUMMARY_KINDS].sort(), [...JOB_HANDLERS.keys(), ...SYSTEM_JOB_HANDLERS.keys()].sort());
    assert.deepEqual(Object.keys(JOB_SUMMARY_SHAPES).sort(), [...JOB_SUMMARY_KINDS].sort());
    assert.deepEqual([...new Set(CASES.map((c) => c.kind))].sort(), [...JOB_SUMMARY_KINDS].sort(), "a case here for every kind");
  });

  for (const c of CASES) {
    it(`of a ${c.kind}: ${c.what}`, () => {
      assert.deepEqual(unmarked(c.result), [], "the case marks every text of the result that is no name");
      const summary = jobSummary(job(c.kind, { result: c.result, rowsWritten: 42, estimate: { rows: 1300, basis: cell("the file's size") } }), { params: c.params ?? null, state: null });
      assert.deepEqual(summary, summaryOf(c.kind, { rowsWritten: 42, estimatedRows: 1300, ...c.summary }));
      assertShape(summary);
      assert.ok(!JSON.stringify(summary).includes(MARK), "the summary holds a value");
    });
  }

  it("of an open pull: the step it is in, and each table's counts so far, from what the job keeps between its pages", () => {
    const params = {
      tables: [
        { source: { schema: cell("public"), name: cell("permits") }, into: "permits" },
        { source: { schema: cell("public"), name: cell("inspections") }, into: "inspections" },
      ],
      connection: { id: cell("dbc_1"), name: cell("Elm Falls permits"), engine: cell("sqlserver") },
      madeBy: { runId: cell("mrn-1"), step: cell("s1") },
      pick: cell("the permit tables"),
    };
    const state = {
      phase: "taking",
      failure: null,
      tables: [
        { mode: "new", kept: [cell("status")], packed: [], key: [cell("permit_no")], restorePoint: null, change: null, page: 3, added: 600, changed: 0, removed: 0, read: 600, cut: 1, ended: false },
        { mode: null, kept: [], packed: [], key: [], restorePoint: null, change: null, page: 0, added: 0, changed: 0, removed: 0, read: 0, cut: 0, ended: false },
      ],
      made: [],
    };
    const summary = jobSummary(job("pull", { state: "running", progress: { done: 600, total: null, note: cell("permits: page 3") }, rowsWritten: 1200 }), { params, state });
    assert.deepEqual(
      summary,
      summaryOf("pull", {
        state: "running",
        step: "taking",
        rowsWritten: 1200,
        progress: { done: 600, total: null },
        counts: { tables: 2, read: 600, added: 600, changed: 0, removed: 0, cut: 1 },
        tables: [made("permits", null, null, "new", { read: 600, added: 600, changed: 0, removed: 0, cut: 1, page: 3, ended: 0 }), made("inspections", null, null, null, { read: 0, added: 0, changed: 0, removed: 0, cut: 0, page: 0, ended: 0 })],
      }),
    );
    assertShape(summary);
    assert.ok(!JSON.stringify(summary).includes(MARK));
  });

  it("of an open load: the tables it made so far and the rows it loaded, from its state", () => {
    const state = { file: 1, tables: null, table: 0, current: null, made: [{ table: "permits", version: 1, rows: 500, file: cell("permits.csv"), sheet: null, notes: [] }], skipped: [], rows: 730 };
    const summary = jobSummary(job("load", { state: "running" }), { params: { files: [{ id: cell("fil_1"), name: cell("permits.csv") }] }, state });
    assert.deepEqual(summary, summaryOf("load", { state: "running", counts: { tables: 1, rows: 730, skipped: 0, unread: 0 }, tables: [made("permits", 1, 500, null, { notes: 0 })] }));
    assertShape(summary);
  });

  it("names why a job waits or failed by a code, and never by the job's own words", () => {
    const until = "2026-11-15T00:00:00.000Z";
    const waiting = jobSummary(job("load", { state: "running", waiting: { code: "write_limit_reached", error: cell("This store wrote 2,000,000 rows today"), until } }), { params: null, state: null });
    assert.deepEqual([waiting.refusal, waiting.waitsUntil], ["write_limit_reached", until]);
    const failed = jobSummary(job("shape", { state: "failed", error: cell("no such column: issued_on, near '18 Mill Road'") }), { params: null, state: null });
    assert.deepEqual([failed.refusal, failed.waitsUntil, failed.step], ["failed", null, null]);
    // The store knows more than the job's words say for a run that was stopped (runner.ts `readJobSummary`).
    assert.equal(jobSummary(job("shape", { state: "failed", error: cell("Run 3 was stopped") }), { params: null, state: null }, "stopped").refusal, "stopped");
    // A finished job waits for nothing and failed at nothing, whatever it carries.
    assert.equal(jobSummary(job("shape", { state: "done", error: cell("left over"), waiting: { code: "write_limit_reached", error: cell(), until } }), { params: null, state: null }, "stopped").refusal, null);
    for (const summary of [waiting, failed]) {
      assertShape(summary);
      assert.ok(!JSON.stringify(summary).includes(MARK));
    }
  });

  it("keeps a MATCH's pass as its step while it is open and once it failed, from its parameters", () => {
    const params = { pass: "apply", table: "permits", add: [{ value: cell("9 Mill Rd"), take: cell("08-004-002"), sure: 0.7 }] };
    for (const state of ["queued", "running", "failed"] as const) {
      const summary = jobSummary(job("match", { state }), { params, state: null });
      assert.equal(summary.step, "apply");
      assertShape(summary);
      assert.ok(!JSON.stringify(summary).includes(MARK));
    }
  });

  it("takes nothing of a result that is not what its kind answers", () => {
    const sentence = cell("a whole sentence, where a table's name goes");
    const odd: Array<[JobSummaryKind, unknown]> = [
      // A value where a table's name goes, a name too long to be one, and numbers that are text.
      ["shape", { table: sentence, version: "3", rows: cell("1200"), mode: cell("changed"), added: "2", changed: Number.NaN, removed: Number.POSITIVE_INFINITY }],
      ["shape", { table: "t".repeat(64), version: 1, rows: 1, mode: "whole" }],
      ["classify", { table: { table: sentence }, answers: [permits], added: { n: 4 }, written: [6] }],
      ["match", { pass: cell("candidates"), leftovers: cell("9 Mill Rd"), exact: cell("1180") }],
      ["pull", { tables: [cell("permits"), null, 7, { table: sentence, rows: 3 }, [permits]] }],
      ["load", cell("the whole result is a text")],
      ["check", [permits]],
      ["export", null],
    ];
    for (const [kind, result] of odd) {
      const summary = jobSummary(job(kind, { result }), { params: cell("no parameters"), state: [cell("no state")] });
      assertShape(summary);
      assert.ok(!JSON.stringify(summary).includes(MARK), `${kind}: ${JSON.stringify(summary)}`);
      assert.deepEqual(summary.tables, [], kind);
    }
  });

  it("gives a kind it has no shape for what every summary holds, and nothing of its result", () => {
    const summary = jobSummary(job("fill", { result: { table: "permits", rows: 3, note: cell() }, progress: { done: 3, total: 9, note: cell("permits: 3 of 9") } }), { params: { table: "permits" }, state: { phase: "taking" } });
    assert.deepEqual(summary, summaryOf("fill", { progress: { done: 3, total: 9 } }));
    assertShape(summary);
  });
});
