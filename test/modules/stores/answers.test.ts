import { describe, expect, test } from "bun:test";

import { AskFailure, manifestDefect, type AskSpec } from "../../../src/host/module-contract";
import { conform } from "../../../src/host/shape";
import { COLUMN_TYPES as DATABASES_COLUMN_TYPES } from "../../../src/modules/databases/manifest";
import {
  catalogAnswer,
  columnType,
  historyAnswer,
  jobAnswer,
  restoreAnswer,
  reviewAnswer,
  statsAnswer,
  writeLimitAnswer,
} from "../../../src/modules/stores/answers";
import {
  CATALOG_PAGE_TABLES,
  COLUMN_TYPES,
  HISTORY_LINES_MAX,
  PULL_TABLES_MAX,
  REVIEW_TABLES_MAX,
  STORES_MANIFEST,
  TABLE_COLUMNS_MAX,
} from "../../../src/modules/stores/manifest";
import { ENGINE_CODES, readStoreAnswer } from "../../../src/modules/stores/store-calls";

/** A row's value that fits no shape: it has a comma, a pipe and brackets. */
const ROW = "18 Mill Road, Elm Falls | Lena Hart <lena@northstar.example>";
/** A row's value that is made only of a name's characters. It must not be
 *  copied from a place where the Store's program keeps words. */
const PLAIN_ROW = "BP-2026-0412 Deck 18 Mill Road";

function ask(name: string): AskSpec {
  const spec = STORES_MANIFEST.asks.find((entry) => entry.name === name);
  if (!spec) throw new Error(`no ask ${name}`);
  return spec;
}

/** The answer as the module host lets it leave: checked against the ask's
 *  declared shape, and rebuilt. */
function leaves(name: string, answer: unknown): unknown {
  const conformed = conform(ask(name).reply, answer);
  if (!conformed.ok) {
    throw new Error(`${name}: ${conformed.issue.rule} at ${conformed.issue.path || "(root)"}`);
  }
  return conformed.value;
}

function holdsNoRow(answer: unknown): void {
  const text = JSON.stringify(answer);
  expect(text).not.toContain("Mill Road");
  expect(text).not.toContain("Lena Hart");
  expect(text).not.toContain("northstar.example");
  expect(text).not.toContain("BP-2026-0412");
}

/** `value`, with a row's value in every place a careless copy would carry:
 *  as one more field of every record, at every depth. */
function poisoned<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => poisoned(entry) as unknown) as unknown as T;
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = poisoned(entry);
    out.note = ROW;
    out.comment = PLAIN_ROW;
    out.error = ROW;
    out.result = { rows: [[ROW, PLAIN_ROW]], sample: PLAIN_ROW };
    out.values = [ROW, PLAIN_ROW];
    return out as T;
  }
  return value;
}

describe("the manifest", () => {
  test("is one the module host can enforce", () => {
    expect(manifestDefect(STORES_MANIFEST)).toBeNull();
    expect(STORES_MANIFEST.egress).toEqual([]);
    expect(STORES_MANIFEST.secrets).toEqual([]);
  });

  test("lists these asks, and no other", () => {
    expect(STORES_MANIFEST.asks.map((spec) => spec.name)).toEqual([
      "create",
      "list",
      "catalog.read",
      "stats.read",
      "history.read",
      "review.read",
      "job.read",
      "write_limit.set",
      "delete",
      "restore",
    ]);
  });

  test("a column's type is one of the words the Databases module uses", () => {
    expect([...COLUMN_TYPES]).toEqual([...DATABASES_COLUMN_TYPES]);
  });
});

describe("a column's type, as one word", () => {
  test.each([
    ["INTEGER", "whole_number"],
    ["bigint", "whole_number"],
    ["TEXT", "characters"],
    ["VARCHAR(20)", "characters"],
    ["nvarchar(max)", "characters"],
    ["REAL", "decimal"],
    ["NUMERIC(10,2)", "decimal"],
    ["DOUBLE PRECISION", "decimal"],
    ["BLOB", "binary"],
    ["DATE", "date"],
    ["TIME", "time"],
    ["DATETIME", "date_time"],
    ["timestamp", "date_time"],
    ["BOOLEAN", "flag"],
    ["", "other"],
    ["geometry", "other"],
  ])("%s is %s", (declared, word) => {
    expect(columnType(declared)).toBe(word as ReturnType<typeof columnType>);
  });

  test("a declared type that is a row's value sends one word, and nothing of itself", () => {
    expect(columnType(ROW)).toBe("other");
    expect(columnType(`TEXT ${ROW}`)).toBe("characters");
    expect(columnType(null)).toBe("other");
    expect(columnType(42)).toBe("other");
  });

  test("only ASCII letters make a type's word, as in SQLite", () => {
    // The language's own upper-casing turns a dotless i into I, and a long s
    // into S. SQLite does not, and neither does this.
    expect(columnType("\u0131nt")).toBe("other");
    expect(columnType("\u017Fmallint")).toBe("whole_number");
    expect(columnType("te\u017Ft")).toBe("other");
    expect(columnType("int")).toBe("whole_number");
  });
});

describe("a call's answer, as the module reads it", () => {
  test("a value is taken as it is, for the answer's own builder to check", () => {
    expect(readStoreAnswer({ ok: true, value: { tables: [] } })).toEqual({ ok: true, value: { tables: [] } });
    expect(readStoreAnswer({ ok: true })).toEqual({ ok: true, value: undefined });
  });

  test("a refusal crosses by a word of a closed list, and its sentence is not read", () => {
    for (const code of ENGINE_CODES) {
      expect(readStoreAnswer({ ok: false, status: 400, code, error: ROW })).toEqual({ ok: false, code });
    }
    expect(ENGINE_CODES).toContain("not_found");
    expect(ENGINE_CODES).toContain("write_limit_reached");
  });

  test("a word that is not on the list is one fixed word, whatever it holds", () => {
    for (const code of [
      "lena_hart_18_mill_road_bp_2026_0412",
      "unknown",
      "stopped",
      "Not_Found",
      "not_found ",
      ROW,
      "",
      7,
      null,
      undefined,
      ["not_found"],
    ]) {
      expect(readStoreAnswer({ ok: false, code, error: ROW })).toEqual({ ok: false, code: "refused" });
    }
  });

  test("anything else is no answer", () => {
    for (const value of [null, undefined, ROW, 7, [], {}, { ok: "true" }, { ok: 1, value: 2 }, { value: 2 }]) {
      expect(readStoreAnswer(value)).toEqual({ ok: null });
    }
  });

  test("every word of the list, with its mark, is a failure's code as the module host takes one", () => {
    for (const code of [...ENGINE_CODES, "refused"]) {
      expect(new AskFailure(`engine_${code}`).code).toBe(`engine_${code}`);
    }
  });
});

describe("catalog.read", () => {
  const permits = {
    database: "store",
    name: "permits",
    count: 1204,
    estimated: false,
    comment: "Building permits of the town",
    source: "dbo.permits",
    key: ["permit_no"],
    label: "address",
    softDelete: false,
    quiet: false,
    kind: "program",
    version: 3,
    group: "From the town's database",
    madeBy: { runId: "run-1", step: "pull", job: "job-1", at: "2026-03-02T09:14:00.000Z" },
    columns: [
      { name: "permit_no", type: "TEXT", nullable: false, quiet: false, values: ["BP-2026-0412"] },
      { name: "address", type: "TEXT", nullable: true, quiet: false, comment: "18 Mill Road" },
      { name: "fee", type: "REAL", nullable: true, quiet: false },
      { name: "issued", type: "DATE", nullable: true, quiet: false },
    ],
  };
  // What the Store's program answers for one page: the page's tables, and
  // how many tables the Store has in all.
  const catalog = { tables: [permits], total: 1 };

  test("answers names, counts and one word for each type", () => {
    expect(leaves("catalog.read", catalogAnswer(catalog, 0))).toEqual({
      page: 0,
      pages: 1,
      tables: 1,
      leftOut: { tables: 0, columns: 0 },
      items: [
        {
          name: "permits",
          kind: "program",
          view: false,
          rows: 1204,
          estimated: false,
          version: 3,
          columnCount: 4,
          columns: [
            { name: "permit_no", type: "characters", key: 1 },
            { name: "address", type: "characters" },
            { name: "fee", type: "decimal" },
            { name: "issued", type: "date" },
          ],
        },
      ],
    });
  });

  test("an answer cannot hold a row's value", () => {
    // The program's own catalog holds two: a column's sample values and its
    // comment. Neither field is read.
    holdsNoRow(leaves("catalog.read", catalogAnswer(catalog, 0)));
    holdsNoRow(leaves("catalog.read", catalogAnswer(poisoned(catalog), 0)));
  });

  test("a name an answer cannot hold is left out and counted, never rewritten", () => {
    const answer = catalogAnswer(
      {
        tables: [
          permits,
          { ...permits, name: ROW },
          { ...permits, name: "owners", columns: [{ name: ROW, type: "TEXT" }, { name: "id", type: "INTEGER" }] },
          { ...permits, name: "" },
          { ...permits, name: "strange", kind: ROW },
        ],
        total: 5,
      },
      0,
    ) as { leftOut: unknown; items: { name: string; columnCount: number; columns: unknown[] }[]; tables: number };
    expect(answer.tables).toBe(5);
    expect(answer.leftOut).toEqual({ tables: 3, columns: 1 });
    expect(answer.items.map((item) => item.name)).toEqual(["permits", "owners"]);
    expect(answer.items.at(1)?.columnCount).toBe(2);
    expect(answer.items.at(1)?.columns).toEqual([{ name: "id", type: "whole_number" }]);
    holdsNoRow(leaves("catalog.read", answer));
  });

  test("pages hold 40 tables, and a page past the last is refused", () => {
    const tables = (from: number, to: number): unknown[] =>
      Array.from({ length: to - from }, (_, i) => ({ ...permits, name: `t${from + i}` }));
    // The Store's program answers one page's tables, and 95 in all.
    const first = catalogAnswer({ tables: tables(0, 40), total: 95 }, 0) as { pages: number; tables: number; items: unknown[] };
    expect(first.pages).toBe(3);
    expect(first.tables).toBe(95);
    expect(first.items).toHaveLength(CATALOG_PAGE_TABLES);
    const last = catalogAnswer({ tables: tables(80, 95), total: 95 }, 2) as { items: { name: string }[] };
    expect(last.items.map((item) => item.name)).toEqual(Array.from({ length: 15 }, (_, i) => `t${80 + i}`));
    leaves("catalog.read", last);
    expect(() => catalogAnswer({ tables: [], total: 95 }, 3)).toThrow("ask failed: page_unknown");
    // A Store with no table has one page, with nothing on it.
    expect(leaves("catalog.read", catalogAnswer({ tables: [], total: 0 }, 0))).toEqual({
      page: 0,
      pages: 1,
      tables: 0,
      leftOut: { tables: 0, columns: 0 },
      items: [],
    });
    expect(() => catalogAnswer({ tables: [], total: 0 }, 1)).toThrow("ask failed: page_unknown");
  });

  test("the widest page fits in one answer, and a table says how many columns it has", () => {
    const column = (i: number): unknown => ({ name: `c${"x".repeat(120)}${i}`.slice(0, 128), type: "TEXT" });
    const wide = {
      tables: Array.from({ length: CATALOG_PAGE_TABLES }, (_, t) => ({
        ...permits,
        name: `table_${t}`,
        key: Array.from({ length: TABLE_COLUMNS_MAX }, (_, i) => `c${"x".repeat(120)}${i}`.slice(0, 128)),
        columns: Array.from({ length: TABLE_COLUMNS_MAX + 5 }, (_, i) => column(i)),
      })),
      total: CATALOG_PAGE_TABLES,
    };
    const answer = catalogAnswer(wide, 0) as {
      leftOut: { columns: number };
      items: { columnCount: number; columns: unknown[] }[];
    };
    expect(answer.items.at(0)?.columns).toHaveLength(TABLE_COLUMNS_MAX);
    // No table of a Store has more than a hundred columns. If one did, its
    // count says so. `leftOut` counts only names that an answer cannot hold.
    expect(answer.items.at(0)?.columnCount).toBe(TABLE_COLUMNS_MAX + 5);
    expect(answer.leftOut.columns).toBe(0);
    leaves("catalog.read", answer);
  });

  test("something that is no page of a catalog fails the ask with one word", () => {
    const many = Array.from({ length: CATALOG_PAGE_TABLES + 1 }, (_, i) => ({ ...permits, name: `t${i}` }));
    for (const value of [
      null,
      undefined,
      "tables",
      7,
      [],
      { tables: "all", total: 1 },
      // No count of all the tables, and no tables.
      { tables: [] },
      { total: 1 },
      { tables: [], total: -1 },
      { tables: [], total: 1.5 },
      // More tables than a page holds: not what was asked for.
      { tables: many, total: many.length },
    ]) {
      expect(() => catalogAnswer(value, 0)).toThrow("ask failed: store_answer_unreadable");
    }
  });
});

describe("stats.read", () => {
  const stats = {
    bytes: 8_192_000,
    tables: 12,
    rows: 48_210,
    files: 3,
    fileBytes: 1_048_576,
    busy: true,
    waitsUntil: Date.parse("2026-03-03T00:00:00.000Z"),
    writes: { day: "2026-03-02", rows: 5000, limit: 2_000_000, own: false },
  };

  test("answers counts, a flag and times", () => {
    expect(leaves("stats.read", statsAnswer(stats))).toEqual({
      bytes: 8_192_000,
      tables: 12,
      rows: 48_210,
      files: 3,
      fileBytes: 1_048_576,
      busy: true,
      waitsUntil: "2026-03-03T00:00:00.000Z",
      writesSince: "2026-03-02T00:00:00.000Z",
      rowsWritten: 5000,
      writeLimit: 2_000_000,
      ownLimit: false,
    });
  });

  test("an answer cannot hold a row's value", () => {
    holdsNoRow(leaves("stats.read", statsAnswer(poisoned(stats))));
    // A day that is words is no day, and the four fields of the writes go together.
    const answer = statsAnswer({ ...stats, waitsUntil: null, writes: { ...stats.writes, day: PLAIN_ROW } });
    expect(Object.keys(answer)).toEqual(["bytes", "tables", "rows", "files", "fileBytes", "busy"]);
    leaves("stats.read", answer);
  });

  test("a number that is no count fails the ask with one word", () => {
    for (const bytes of [-1, 1.5, Number.NaN, "8192", null, undefined, ROW]) {
      expect(() => statsAnswer({ ...stats, bytes })).toThrow("ask failed: store_answer_unreadable");
    }
  });

  test("the write limit as it stands", () => {
    expect(leaves("write_limit.set", writeLimitAnswer({ day: "2026-03-02", rows: 5, limit: 100_000, own: true }))).toEqual({
      writeLimit: 100_000,
      ownLimit: true,
    });
    expect(() => writeLimitAnswer({ limit: ROW, own: true })).toThrow(AskFailure);
    holdsNoRow(writeLimitAnswer(poisoned({ limit: 7, own: false })));
  });
});

describe("history.read", () => {
  const history = {
    events: [
      { id: "ev_3", at: "2026-03-02T09:14:00.000Z", kind: "job", by: "run:run-1", note: "Pulled permits: 1,204 rows", restorePoint: "bm-3" },
      { id: "ev_2", at: "2026-03-01T16:00:00.000Z", kind: "migration", by: "user:lena", note: "ALTER TABLE permits ADD COLUMN fee" },
      { id: "ev_1", at: "2026-03-01T15:00:00.000Z", kind: "table", by: "guest:lena+permits@northstar.example", note: "x" },
    ],
    restorableFrom: "2026-02-01T00:00:00.000Z",
  };

  test("answers when, what kind and who, and none of a line's words", () => {
    expect(leaves("history.read", historyAnswer(history))).toEqual({
      lines: [
        { id: "ev_3", at: "2026-03-02T09:14:00.000Z", kind: "job", by: "run:run-1", restorable: true },
        { id: "ev_2", at: "2026-03-01T16:00:00.000Z", kind: "migration", by: "user:lena", restorable: false },
        // A name with a character an answer cannot hold is replaced whole.
        { id: "ev_1", at: "2026-03-01T15:00:00.000Z", kind: "table", by: "unknown", restorable: false },
      ],
      leftOut: 0,
      more: 0,
      restorableFrom: "2026-02-01T00:00:00.000Z",
    });
  });

  test("an answer cannot hold a row's value, a statement's text or a restore point", () => {
    const answer = leaves("history.read", historyAnswer(poisoned(history)));
    holdsNoRow(answer);
    const text = JSON.stringify(answer);
    expect(text).not.toContain("ALTER TABLE");
    expect(text).not.toContain("1,204");
    expect(text).not.toContain("bm-3");
  });

  test("a line that cannot be told is left out and counted", () => {
    const answer = historyAnswer({
      events: [
        ...history.events,
        { id: ROW, at: "2026-03-01T15:00:00.000Z", kind: "table", by: "user:lena" },
        { id: "ev_0", at: PLAIN_ROW, kind: "table", by: "user:lena" },
        { id: "ev_9", at: "2026-03-01T15:00:00.000Z", kind: PLAIN_ROW, by: "user:lena" },
        ROW,
      ],
    }) as { lines: unknown[]; leftOut: number };
    expect(answer.lines).toHaveLength(3);
    expect(answer.leftOut).toBe(4);
    holdsNoRow(leaves("history.read", answer));
  });

  test("as many lines as the Store's program answers, and lines past that are counted apart", () => {
    const line = (i: number): unknown => ({ id: `ev_${i}`, at: "2026-03-01T15:00:00.000Z", kind: "job", by: "run:r" });
    // The program answers 500 at most, and all of them fit.
    expect(HISTORY_LINES_MAX).toBe(500);
    const full = historyAnswer({ events: Array.from({ length: 500 }, (_, i) => line(i)) });
    expect(full.lines).toHaveLength(500);
    expect(full.leftOut).toBe(0);
    expect(full.more).toBe(0);
    leaves("history.read", full);
    // A program that answered more: what has no room is `more`, and a line
    // that cannot be told is `leftOut`. The two are not one count.
    const events = [ROW, ...Array.from({ length: HISTORY_LINES_MAX + 30 }, (_, i) => line(i))];
    const answer = historyAnswer({ events }) as { lines: unknown[]; leftOut: number; more: number };
    expect(answer.lines).toHaveLength(HISTORY_LINES_MAX);
    expect(answer.leftOut).toBe(1);
    expect(answer.more).toBe(30);
    leaves("history.read", answer);
  });

  test("something that is no history fails the ask with one word", () => {
    for (const value of [null, undefined, ROW, 7, [], {}, { events: "all" }, { restorableFrom: "2026-02-01T00:00:00.000Z" }]) {
      expect(() => historyAnswer(value)).toThrow("ask failed: store_answer_unreadable");
    }
  });
});

describe("review.read", () => {
  const review = {
    tables: [
      { table: "permits", kind: "flags", flags: "permits_flags", open: 14, stale: false },
      { table: "owners_answers", kind: "answers", flags: null, open: 2, stale: true },
    ],
  };

  test("answers tables and counts", () => {
    expect(leaves("review.read", reviewAnswer(review))).toEqual({
      tables: [
        { table: "permits", kind: "flags", flags: "permits_flags", open: 14, stale: false },
        { table: "owners_answers", kind: "answers", open: 2, stale: true },
      ],
      leftOut: 0,
      more: 0,
    });
  });

  test("an answer cannot hold a row's value", () => {
    holdsNoRow(leaves("review.read", reviewAnswer(poisoned(review))));
    const answer = reviewAnswer({
      tables: [
        { table: ROW, kind: "flags", open: 1 },
        { table: "permits", kind: "flags", flags: ROW, open: 1 },
        { table: "permits", kind: ROW, open: 1 },
        { table: "permits", kind: "flags", open: ROW },
      ],
    }) as { tables: unknown[]; leftOut: number };
    expect(answer.tables).toEqual([{ table: "permits", kind: "flags", open: 1, stale: false }]);
    expect(answer.leftOut).toBe(3);
    holdsNoRow(leaves("review.read", answer));
  });

  test("tables past the most an answer holds are counted apart", () => {
    const tables = Array.from({ length: REVIEW_TABLES_MAX + 7 }, (_, i) => ({ table: `t${i}`, kind: "flags", open: 1 }));
    const answer = reviewAnswer({ tables }) as { tables: unknown[]; leftOut: number; more: number };
    expect(answer.tables).toHaveLength(REVIEW_TABLES_MAX);
    expect(answer.leftOut).toBe(0);
    expect(answer.more).toBe(7);
    leaves("review.read", answer);
  });

  test("something that is no review fails the ask with one word", () => {
    for (const value of [null, undefined, ROW, [], {}, { tables: 3 }]) {
      expect(() => reviewAnswer(value)).toThrow("ask failed: store_answer_unreadable");
    }
  });
});

describe("job.read", () => {
  const summary = {
    id: "job_7f3a",
    kind: "pull",
    state: "done",
    step: null,
    createdAt: "2026-03-02T09:14:00.000Z",
    updatedAt: "2026-03-02T09:15:30.000Z",
    waitsUntil: null,
    refusal: null,
    rowsWritten: 2408,
    estimatedRows: 1200,
    progress: { done: 1, total: 1 },
    counts: { tables: 1, rows: 1204, read: 1204, added: 1204, changed: 0, removed: 0, cut: 2 },
    tables: [
      {
        table: "permits",
        version: 1,
        rows: 1204,
        step: "new",
        counts: { read: 1204, added: 1204, changed: 0, removed: 0, cut: 2, page: 1, ended: 1 },
      },
    ],
  };

  test("answers a state, times and counts", () => {
    expect(leaves("job.read", jobAnswer({ summary }))).toEqual({
      job: "job_7f3a",
      kind: "pull",
      state: "done",
      createdAt: "2026-03-02T09:14:00.000Z",
      updatedAt: "2026-03-02T09:15:30.000Z",
      rowsWritten: 2408,
      estimatedRows: 1200,
      done: 1,
      total: 1,
      tables: 1,
      rows: 1204,
      read: 1204,
      added: 1204,
      changed: 0,
      removed: 0,
      cut: 2,
      pulled: [
        { table: "permits", version: 1, rows: 1204, mode: "new", read: 1204, added: 1204, changed: 0, removed: 0, cut: 2 },
      ],
      leftOut: 0,
      more: 0,
    });
  });

  test("an open job that waits says until when and why, as a code", () => {
    const answer = leaves(
      "job.read",
      jobAnswer({
        summary: {
          ...summary,
          state: "running",
          step: "taking",
          waitsUntil: "2026-03-03T00:00:00.000Z",
          refusal: "write_limit_reached",
          progress: { done: 0, total: null },
        },
      }),
    ) as Record<string, unknown>;
    expect(answer.step).toBe("taking");
    expect(answer.waitsUntil).toBe("2026-03-03T00:00:00.000Z");
    expect(answer.refusal).toBe("write_limit_reached");
    expect(answer.done).toBe(0);
    expect("total" in answer).toBe(false);
  });

  test("an answer cannot hold a row's value", () => {
    // The job itself keeps words: its error, and a result that can hold cell
    // values. A summary has neither, and nothing here would read them.
    holdsNoRow(leaves("job.read", jobAnswer(poisoned({ summary }))));
    const answer = jobAnswer({
      // Beside the summary, what the program keeps of a job. Nothing reads it.
      result: { unmatched: [ROW, PLAIN_ROW] },
      error: ROW,
      summary: {
        ...summary,
        state: "failed",
        step: PLAIN_ROW,
        refusal: ROW,
        error: ROW,
        result: { unmatched: [ROW, PLAIN_ROW] },
        counts: { ...summary.counts, rows: PLAIN_ROW, [PLAIN_ROW]: 3 },
        tables: [
          { ...summary.tables[0], table: ROW },
          { ...summary.tables[0], step: PLAIN_ROW, counts: { read: ROW, [PLAIN_ROW]: 1 } },
        ],
      },
    }) as { pulled: unknown[]; leftOut: number };
    expect(answer.pulled).toEqual([{ table: "permits", version: 1, rows: 1204 }]);
    expect(answer.leftOut).toBe(1);
    holdsNoRow(leaves("job.read", answer));
  });

  test("a job of another kind is told by what every job has", () => {
    const answer = leaves(
      "job.read",
      jobAnswer({
        summary: {
          ...summary,
          kind: "match",
          step: "candidates",
          counts: { exact: 3, unmatched: 9 },
          tables: [{ table: "answers", version: 1, rows: 4, step: "answers", counts: {} }],
        },
      }),
    ) as Record<string, unknown>;
    expect(answer).toEqual({
      job: "job_7f3a",
      kind: "other",
      state: "done",
      createdAt: "2026-03-02T09:14:00.000Z",
      updatedAt: "2026-03-02T09:15:30.000Z",
      rowsWritten: 2408,
      estimatedRows: 1200,
      done: 1,
      total: 1,
      leftOut: 0,
      more: 0,
    });
  });

  test("a summary with no id, state or times fails the ask with one word", () => {
    for (const broken of [
      { summary: { ...summary, id: ROW } },
      { summary: { ...summary, state: "finished" } },
      { summary: { ...summary, createdAt: "yesterday" } },
      { summary: { ...summary, updatedAt: null } },
      { summary: null },
      {},
      // The summary's fields a level too high: not the form the program answers in.
      summary,
      null,
      ROW,
    ]) {
      expect(() => jobAnswer(broken)).toThrow("ask failed: store_answer_unreadable");
    }
  });

  test("at most 50 tables", () => {
    const tables = Array.from({ length: PULL_TABLES_MAX + 4 }, (_, i) => ({ ...summary.tables[0], table: `t${i}` }));
    const answer = jobAnswer({ summary: { ...summary, tables } }) as { pulled: unknown[]; leftOut: number; more: number };
    expect(answer.pulled).toHaveLength(PULL_TABLES_MAX);
    expect(answer.leftOut).toBe(0);
    expect(answer.more).toBe(4);
    leaves("job.read", answer);
  });
});

describe("restore", () => {
  const asked = { store: "store-1", line: "his_2", askedAt: "2026-03-02T09:14:00.000Z" };

  test("the ask answers the Store, the line and when it was asked, and nothing of the line's words", () => {
    expect(leaves("restore", asked)).toEqual(asked);
    // The line is named by its id. A row's value is no id, and neither is a
    // sentence made of a name's characters.
    for (const line of [ROW, PLAIN_ROW, ""]) expect(() => leaves("restore", { ...asked, line })).toThrow("restore:");
    // The answer has no field for a note or a bookmark: one that carries
    // either does not leave at all.
    expect(() => leaves("restore", { ...asked, restorePoint: "00000003-aaaaaaaaaaaaaaaaaaaaaaaa" })).toThrow("restore: field_unknown");
    expect(() => leaves("restore", poisoned(asked))).toThrow("restore: field_unknown");
    const args = ask("restore").args;
    expect(conform(args, { store: "store-1", line: "his_2" }).ok).toBe(true);
    expect(conform(args, { store: "store-1", line: PLAIN_ROW }).ok).toBe(false);
    expect(conform(args, { store: "store-1" }).ok).toBe(false);
    // An ask names a line, and never a time.
    expect(conform(args, { store: "store-1", line: "his_2", at: "2026-03-02T09:14:00.000Z" }).ok).toBe(false);
    // The shape cannot tell a bookmark from a line's id: both have an id's
    // form. The Store's program refuses a bookmark (engine-program.test.ts).
    expect(conform(args, { store: "store-1", line: "00000003-aaaaaaaaaaaaaaaaaaaaaaaa" }).ok).toBe(true);
  });

  test("a Store's line of the list tells a restore that waits by its line and its time", () => {
    const store = { store: "store-1", state: "ready", bytes: 4096, createdAt: "2026-03-01T00:00:00.000Z" };
    const waits = { ...store, restoreAsked: { line: "his_2", at: "2026-03-02T09:14:00.000Z" } };
    expect(leaves("list", { stores: [store, waits] })).toEqual({ stores: [store, waits] });
    expect(() => leaves("list", { stores: [{ ...store, restoreAsked: { line: ROW, at: "2026-03-02T09:14:00.000Z" } }] })).toThrow("list:");
    expect(() => leaves("list", { stores: [{ ...store, restoreAsked: { line: "his_2" } }] })).toThrow("list:");
  });

  test("what the Store's program answers a restore with is read as one time, written anew", () => {
    // The program also answers the bookmark and what it kept. Neither is read.
    expect(
      restoreAnswer({ to: "2026-03-02T09:14:00Z", restoredTo: "00000003-aaaaaaaaaaaaaaaaaaaaaaaa", kept: ["_users", "_sessions"], note: ROW }),
    ).toEqual({ to: "2026-03-02T09:14:00.000Z" });
    for (const value of [null, undefined, {}, [], ROW, { to: ROW }, { to: "yesterday" }, { to: null }, { restoredTo: "2026-03-02T09:14:00Z" }]) {
      expect(() => restoreAnswer(value)).toThrow("ask failed: store_answer_unreadable");
    }
  });

  test("the Store program's word for a Store that keeps no earlier moment is on the list", () => {
    expect(ENGINE_CODES as readonly string[]).toContain("restore_unavailable");
    expect(readStoreAnswer({ ok: false, status: 501, code: "restore_unavailable", error: ROW })).toEqual({
      ok: false,
      code: "restore_unavailable",
    });
  });
});

describe("a time is written anew", () => {
  test("the program's own text for a time is never what is sent", () => {
    // An instant with no milliseconds is still an instant. What is sent is how
    // this host writes it.
    const answer = historyAnswer({
      events: [{ id: "e", at: "2026-03-02T09:14:00Z", kind: "job", by: "run:r" }],
    }) as { lines: { at: string }[] };
    expect(answer.lines.at(0)?.at).toBe("2026-03-02T09:14:00.000Z");
    // Milliseconds are an instant too. A number past the year 9999 is none.
    expect((statsAnswer({ bytes: 0, tables: 0, rows: 0, files: 0, fileBytes: 0, waitsUntil: 0 }) as { waitsUntil: string }).waitsUntil).toBe(
      "1970-01-01T00:00:00.000Z",
    );
    expect("waitsUntil" in statsAnswer({ bytes: 0, tables: 0, rows: 0, files: 0, fileBytes: 0, waitsUntil: 1e18 })).toBe(false);
  });
});
