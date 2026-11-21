// A job's summary: what a job did, for a reader that may hold no value of a row.
//
// A job's `result` is whatever its kind answers, and some kinds answer values: a MATCH's
// candidates pass lists the values it could not match beside the reference rows most like them,
// and a LOAD's notes and a failed job's error are words about the rows. A summary is made only of
// what cannot be a value: the job's state, the step it is in, its times, its numbers, a code for
// why it stopped, and the names of the tables it made. Its shape is the same for every kind, and
// `JOB_SUMMARY_SHAPES` lists, for each kind, every word `step` may hold and every name `counts`
// may hold, so a caller can check a summary against a shape before it passes it on.
//
// Nothing here writes, and nothing here changes what `result` holds: a caller that may read rows
// goes on reading it.
//
// How a value is kept out, by construction rather than by a list of fields to drop:
//   - a count is copied only when it is a finite number (or true or false, as 1 or 0);
//   - a table's name is copied only from a place its kind's result keeps a table's handle, and only
//     when it reads as a program table's name (letters, digits and underscores, 63 at most);
//   - a step is copied only when it is one of the kind's own words;
//   - a refusal is one of five codes, never the job's error.

import type { Job, JobRefusal, JobSummary, JobSummaryTable } from "../types.js";

/** Every kind of job a store runs: a program's steps, parking's two, and the store's own export and import. */
export const JOB_SUMMARY_KINDS = ["load", "shape", "park", "bring_back", "profile", "classify", "match", "check", "pull", "push_preview", "push", "push_undo", "compare", "export", "import"] as const;
export type JobSummaryKind = (typeof JOB_SUMMARY_KINDS)[number];

/** Why a job waits or failed, as a code: every code `refusal` may hold. */
export const JOB_REFUSALS: readonly JobRefusal[] = [
  /** It is open and waits for the store's daily write limit. */
  "write_limit_reached",
  /** Its run was stopped. */
  "stopped",
  /** The store no longer runs jobs of its kind. */
  "job_kind_unknown",
  /** A chunk of it stopped the store three times in a row. */
  "chunk_failed",
  /** It failed, and the job kept only words for why. */
  "failed",
];

/** What one kind's summaries may hold beside what every summary holds. */
export interface JobSummaryShape {
  /** The words `step` may hold. */
  steps: readonly string[];
  /** The names `counts` may hold. */
  counts: readonly string[];
  /** The words a table's `step` may hold. */
  tableSteps: readonly string[];
  /** The names a table's `counts` may hold. */
  tableCounts: readonly string[];
}

/** The steps of a job that takes its rows in pages from a DB IO job: a pull, a preview, a write, an undo, a compare. */
const PAGED_STEPS = ["taking", "finishing", "failing"] as const;

export const JOB_SUMMARY_SHAPES: Readonly<Record<JobSummaryKind, JobSummaryShape>> = {
  load: { steps: [], counts: ["tables", "rows", "skipped", "unread"], tableSteps: [], tableCounts: ["added", "changed", "removed", "notes", "packed"] },
  shape: { steps: ["bring", "make", "end"], counts: ["broughtBack"], tableSteps: ["whole", "changed", "unchanged", "view"], tableCounts: ["added", "changed", "removed"] },
  park: { steps: [], counts: ["parked"], tableSteps: [], tableCounts: [] },
  bring_back: { steps: [], counts: ["parked"], tableSteps: [], tableCounts: [] },
  profile: { steps: [], counts: ["columns", "profiledRows"], tableSteps: [], tableCounts: [] },
  classify: { steps: [], counts: ["added", "written", "unsure", "unanswered"], tableSteps: ["answers"], tableCounts: [] },
  match: {
    steps: ["candidates", "apply"],
    counts: ["exact", "normalized", "known", "unmatched", "leftovers", "more", "added", "written", "unsure"],
    tableSteps: ["answers"],
    tableCounts: [],
  },
  check: { steps: [], counts: ["flagged", "opened", "closed", "rules"], tableSteps: ["flags"], tableCounts: [] },
  pull: {
    steps: PAGED_STEPS,
    counts: ["tables", "rows", "read", "added", "changed", "removed", "cut"],
    tableSteps: ["new", "change"],
    tableCounts: ["read", "added", "changed", "removed", "cut", "page", "ended"],
  },
  push_preview: { steps: PAGED_STEPS, counts: ["inserts", "updates", "deletes", "held", "unchanged", "targetRows", "columns", "ignored", "links", "first"], tableSteps: [], tableCounts: [] },
  push: { steps: PAGED_STEPS, counts: ["inserted", "updated", "deleted", "held", "heldSince", "batches", "parts", "rehearsed", "restored"], tableSteps: ["held", "manifest"], tableCounts: [] },
  push_undo: { steps: PAGED_STEPS, counts: ["removed", "putBack", "reinserted", "held", "parts"], tableSteps: ["held"], tableCounts: [] },
  compare: { steps: PAGED_STEPS, counts: ["storeRows", "databaseRows", "matching", "onlyInStore", "onlyInDatabase", "differing", "otherRows", "unlisted", "columns"], tableSteps: [], tableCounts: [] },
  export: { steps: ["sample", "trees"], counts: ["bytes", "pages", "tables", "rows", "files", "fileBytes", "replaced", "filesLeftOut", "parkedLeftOut"], tableSteps: [], tableCounts: [] },
  import: { steps: ["wait", "tables", "rows", "pending", "objects", "files", "system", "finish"], counts: ["tables", "rows", "files", "fileBytes", "migrations", "users"], tableSteps: [], tableCounts: [] },
};

/** A kind the store has no shape for (a deployment's own handler): its summary holds what every summary holds, and nothing of its result. */
const NO_SHAPE: JobSummaryShape = { steps: [], counts: [], tableSteps: [], tableCounts: [] };

/** The shape of a kind's summaries. */
export function jobSummaryShape(kind: string): JobSummaryShape {
  return (JOB_SUMMARY_SHAPES as Record<string, JobSummaryShape>)[kind] ?? NO_SHAPE;
}

/** A table's name as a job's handle may carry it: a program table's name, and nothing else. */
const TABLE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;

// ── Reading a result that may hold anything ──────────────────────────────────

type Counts = Record<string, number>;

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** A number as a count: finite numbers, and true and false as 1 and 0. Anything else is no count. */
function count(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value ? 1 : 0;
  return undefined;
}

/** The counts of `from` under `names`, each kept only when it is a count. */
function counts(from: unknown, names: readonly string[]): Counts {
  const source = record(from);
  const out: Counts = {};
  for (const name of names) {
    const n = count(source[name]);
    if (n !== undefined) out[name] = n;
  }
  return out;
}

/** How many entries a list holds; undefined when it is no list. */
const length = (value: unknown): number | undefined => (Array.isArray(value) ? value.length : undefined);

/** `counts` with `name` set, when `value` is a count. */
function withCount(into: Counts, name: string, value: number | undefined): Counts {
  if (value !== undefined) into[name] = value;
  return into;
}

/** The sum of a count over a list's entries. */
const sum = (entries: unknown[], name: string): number => entries.reduce<number>((n, entry) => n + (count(record(entry)[name]) ?? 0), 0);

/** A word, when it is one of `words`; null otherwise. */
const word = (value: unknown, words: readonly string[]): string | null => (typeof value === "string" && words.includes(value) ? value : null);

/**
 * A table of a summary, from a place that holds a table's handle (`{ table, version, rows }`).
 * Null when it holds none, or a name that does not read as a table's.
 */
function table(handle: unknown, step: string | null = null, own: Counts = {}): JobSummaryTable | null {
  const h = record(handle);
  if (typeof h.table !== "string" || !TABLE_NAME_RE.test(h.table)) return null;
  return { table: h.table, version: count(h.version) ?? null, rows: count(h.rows) ?? null, step, counts: own };
}

const present = (tables: Array<JobSummaryTable | null>): JobSummaryTable[] => tables.filter((t): t is JobSummaryTable => t !== null);

// ── Each kind ────────────────────────────────────────────────────────────────

interface Read {
  step?: string | null;
  counts: Counts;
  tables: JobSummaryTable[];
}

/** What a job kept besides its result: its parameters, and its state between chunks while it is open. */
interface Kept {
  params: unknown;
  state: unknown;
}

const READERS: Record<JobSummaryKind, (result: unknown, kept: Kept, shape: JobSummaryShape) => Read> = {
  load(result, kept) {
    // While it runs, what it made so far is in its state.
    const made = result === null ? list(record(kept.state).made) : list(record(result).tables);
    const tables = made.map((entry) => {
      const t = record(entry);
      const own = counts(t.changes, ["added", "changed", "removed"]);
      withCount(own, "notes", length(t.notes));
      withCount(own, "packed", length(t.packed));
      return table(t, null, own);
    });
    const out: Counts = { tables: present(tables).length, rows: result === null ? (count(record(kept.state).rows) ?? 0) : sum(made, "rows") };
    withCount(out, "skipped", length(record(result ?? kept.state).skipped));
    // A file it could not read is listed with no table.
    withCount(out, "unread", made.length - present(tables).length);
    return { counts: out, tables: present(tables) };
  },
  shape(result, _kept, shape) {
    const r = record(result);
    return {
      counts: withCount({}, "broughtBack", length(r.broughtBack)),
      tables: present([table(r, word(r.mode, shape.tableSteps), counts(r, shape.tableCounts))]),
    };
  },
  park: (result) => ({ counts: counts(result, ["parked"]), tables: present([table(result)]) }),
  bring_back: (result) => ({ counts: counts(result, ["parked"]), tables: present([table(result)]) }),
  profile(result) {
    const r = record(result);
    const out = withCount({}, "columns", length(r.columns));
    withCount(out, "profiledRows", count(record(r.of).rows));
    return { counts: out, tables: present([table(r)]) };
  },
  classify(result, _kept, shape) {
    const r = record(result);
    return { counts: counts(r, shape.counts), tables: present([table(r.table), table(r.answers, "answers")]) };
  },
  match(result, kept, shape) {
    const r = record(result);
    const out = counts(r, ["exact", "normalized", "known", "unmatched", "more", "added", "written", "unsure"]);
    // A candidates pass lists each value it could not match: only how many crosses.
    withCount(out, "leftovers", length(r.leftovers));
    return {
      step: word(r.pass, shape.steps) ?? word(record(kept.params).pass, shape.steps),
      counts: out,
      tables: present([table(r.table), table(r.answers, "answers")]),
    };
  },
  check(result) {
    const r = record(result);
    const out = counts(r, ["flagged", "opened", "closed"]);
    // A rule's name is its words: only how many rules crosses.
    withCount(out, "rules", length(r.rules));
    return { counts: out, tables: present([table(r.checked), table(r.flags, "flags")]) };
  },
  pull(result, kept, shape) {
    const per = ["read", "added", "changed", "removed", "cut"];
    if (result !== null) {
      const made = list(record(result).tables);
      const tables = present(made.map((t) => table(t, word(record(t).mode, shape.tableSteps), counts(t, per))));
      const out: Counts = { tables: tables.length, rows: sum(made, "rows") };
      for (const name of per) out[name] = sum(made, name);
      return { counts: out, tables };
    }
    // While it takes pages: each table of its parameters, with what its pages brought so far.
    const runs = list(record(kept.state).tables);
    const asked = list(record(kept.params).tables);
    const tables = present(
      asked.map((entry, i) => {
        const run = record(runs[i]);
        return table({ table: record(entry).into }, word(run.mode, shape.tableSteps), counts(run, [...per, "page", "ended"]));
      }),
    );
    const out: Counts = { tables: tables.length };
    for (const name of per) out[name] = sum(runs, name);
    return { counts: out, tables };
  },
  push_preview(result) {
    const r = record(result);
    const out = counts(r, ["inserts", "updates", "deletes", "held", "unchanged", "targetRows", "first"]);
    withCount(out, "columns", length(r.columns));
    withCount(out, "ignored", length(r.ignored));
    withCount(out, "links", length(r.links));
    return { counts: out, tables: present([table(r)]) };
  },
  push(result) {
    const r = record(result);
    const out = counts(r, ["inserted", "updated", "deleted", "held", "heldSince", "batches", "rehearsed", "restored"]);
    withCount(out, "parts", length(r.parts));
    return { counts: out, tables: present([table(r.heldTable, "held"), ...list(r.manifest).map((m) => table(m, "manifest"))]) };
  },
  push_undo(result) {
    const r = record(result);
    const out = counts(r, ["removed", "putBack", "reinserted", "held"]);
    withCount(out, "parts", length(r.parts));
    return { counts: out, tables: present([table(r.heldTable, "held")]) };
  },
  compare(result) {
    const r = record(result);
    const out = counts(r, ["storeRows", "databaseRows", "matching", "onlyInStore", "onlyInDatabase", "differing", "otherRows", "unlisted"]);
    withCount(out, "columns", length(r.columns));
    return { counts: out, tables: present([table(r)]) };
  },
  export(result) {
    const r = record(result);
    const out = counts(r, ["bytes", "pages", "tables", "rows", "files", "fileBytes", "replaced", "filesLeftOut"]);
    withCount(out, "parkedLeftOut", length(r.parkedLeftOut));
    return { counts: out, tables: [] };
  },
  import: (result, _kept, shape) => ({ counts: counts(result, shape.counts), tables: [] }),
};

const isKind = (kind: string): kind is JobSummaryKind => (JOB_SUMMARY_KINDS as readonly string[]).includes(kind);

/**
 * The summary of a job, from the job as its callers read it and what its row keeps besides.
 * `refusal` is the code of a failed job when the store knows more than the job's words say
 * (jobs/runner.ts `readJobSummary`); left out, a failed job's code is `failed`.
 */
export function jobSummary(job: Job, kept: Kept, refusal: JobRefusal | null = null): JobSummary {
  const shape = jobSummaryShape(job.kind);
  const open = job.state === "queued" || job.state === "running";
  const read: Read = isKind(job.kind) ? READERS[job.kind](job.result ?? null, kept, shape) : { counts: {}, tables: [] };
  // An open job's step is the phase its state names; a kind that says its own (MATCH's pass) keeps it once it ends too.
  const step = read.step !== undefined ? read.step : open ? word(record(kept.state).phase, shape.steps) : null;
  const waiting = open ? (job.waiting ?? null) : null;
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    step,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    waitsUntil: waiting ? waiting.until : null,
    refusal: waiting ? "write_limit_reached" : job.state === "failed" ? (refusal ?? "failed") : null,
    rowsWritten: count(job.rowsWritten) ?? 0,
    estimatedRows: count(record(job.estimate).rows) ?? null,
    progress: job.progress ? { done: count(job.progress.done) ?? 0, total: count(job.progress.total) ?? null } : null,
    counts: read.counts,
    tables: read.tables,
  };
}
