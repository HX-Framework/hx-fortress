// What the control plane may ask HX Fortress about its Stores.
//
// A STORE is a working copy of tables, kept in one SQLite file on this
// HX Fortress's disk. Its rows are read and changed by the organization's own
// people, in their own browsers, and by jobs that run on this machine. The
// control plane is told about a Store, and never what is in it.
//
// Every field of every answer is in this file: ids, names, counts, flags,
// states and times. No ask takes a statement's text, and no answer has a field
// that a row's value, a file's bytes or a sentence could travel in. Where the
// Store's own program answers with words (a note in its history, the reason a
// job failed, a column's comment), the word is left behind and a count, a
// state or a code is sent.
//
// A name that an answer cannot hold (a table's or a column's name with a
// character outside `name`) is LEFT OUT and COUNTED, as `leftOut`. It is never
// rewritten, cut or encoded: an encoding would let a name carry any bytes past
// a shape. What an answer has no room for, because a list of it is full, is
// counted apart, as `more`.
//
// Pure data, with no imports from the daemon: the terminal and the console read
// this same object to show what may be asked.

import type { ModuleManifest } from "../../host/module-contract";
import { S, type Shape } from "../../host/shape";

export const STORES_MODULE_ID = "stores";

// ── The closed lists ─────────────────────────────────────────────────────────

/**
 * Where a Store stands on this HX Fortress.
 *
 *   ready           it takes calls
 *   delete_waiting  the control plane asked to delete it, and a person of this
 *                   organization has not decided yet. It takes calls meanwhile.
 *   deleting        a person approved the delete, and the Store's folder is
 *                   being removed. It takes no call, and it is gone from the
 *                   list when its folder is.
 */
export const STORE_STATES = ["ready", "delete_waiting", "deleting"] as const;
export type StoreState = (typeof STORE_STATES)[number];

/**
 * A column's type, as one word. The type a table declares for a column is text
 * that somebody chose, so it does not cross: the module answers with the word
 * it belongs to. The words are the Databases module's, so that a reader of
 * both sees one list. `characters` is a column of text and `binary` a column
 * of bytes: a list of what an answer can hold must not read as if an answer
 * could hold either.
 */
export const COLUMN_TYPES = [
  "characters",
  "whole_number",
  "decimal",
  "date",
  "time",
  "date_time",
  "flag",
  "binary",
  "other",
] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

/**
 * What a table is to its Store.
 *
 *   program  a job made it: a pull, a load, a step of a program
 *   managed  the organization's own statements made it
 *   system   the Store keeps its own records in it
 */
export const TABLE_KINDS = ["program", "managed", "system"] as const;
export type TableKind = (typeof TABLE_KINDS)[number];

/** The kinds of line a Store's history holds. */
export const HISTORY_KINDS = ["migration", "table", "restore", "job", "files"] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

/** What waits for a person's review in a table: rows a check flagged, or
 *  answers that were not sure. */
export const REVIEW_KINDS = ["flags", "answers"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

/** Every kind of job an answer may name. A pull fills tables of the Store from
 *  a database this HX Fortress reaches. A job of a kind that is not on this
 *  list is answered as `other`, with no counts. */
export const JOB_KINDS = ["pull", "other"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATES = ["queued", "running", "done", "failed"] as const;
export type JobState = (typeof JOB_STATES)[number];

/** The part of its work an open pull is in. */
export const PULL_STEPS = ["taking", "finishing", "failing"] as const;
export type PullStep = (typeof PULL_STEPS)[number];

/** How a pull wrote a table: a new version of it, or its changed rows in place. */
export const PULL_TABLE_MODES = ["new", "change"] as const;
export type PullTableMode = (typeof PULL_TABLE_MODES)[number];

/**
 * Why a job waits or failed, as one word. The job's own sentence about it
 * stays in the Store: it can quote a value.
 *
 * The first five are the Store's program's. The rest are this module's own,
 * for a job that never reached the Store's program or lost its data runner.
 */
export const JOB_REFUSALS = [
  "write_limit_reached",
  "stopped",
  "job_kind_unknown",
  "chunk_failed",
  "failed",

  "connection_unknown",
  "connection_not_ready",
  "databases_off",
  "busy",
  "runner_failed",
  "interrupted",
] as const;
export type JobRefusal = (typeof JOB_REFUSALS)[number];

// ── Limits ───────────────────────────────────────────────────────────────────

/** Most Stores one organization keeps on this HX Fortress. */
export const STORES_MAX = 200;
/** Most tables on one page of a Store's catalog. */
export const CATALOG_PAGE_TABLES = 40;
/** Most columns a table of a Store has. */
export const TABLE_COLUMNS_MAX = 100;
/** The highest page number an ask may name. */
export const CATALOG_PAGE_NUMBER_MAX = 10_000;
/** Most lines one reading of a Store's history answers, newest first. It is
 *  as many as the Store's program itself answers. */
export const HISTORY_LINES_MAX = 500;
/** Most tables one reading of what waits for review answers. */
export const REVIEW_TABLES_MAX = 500;
/** Most tables one pull reads. */
export const PULL_TABLES_MAX = 50;
/** The most rows a Store may write in a day that an ask can ask for: the most
 *  the Store's program takes. The organization sets its own ceiling under
 *  this in the console. The program also has a least number, and refuses a
 *  smaller one with its own word. */
export const WRITE_LIMIT_MAX = 100_000_000;

// ── The shapes ───────────────────────────────────────────────────────────────

/** The control plane's id for a Store. Never a file's name on this disk: the
 *  module gives each Store a folder name of its own. */
const STORE = S.id;

const STORE_VIEW: Shape = S.record(
  {
    store: STORE,
    // The name the control plane gave it, for this organization's own people
    // to know it by on the Stores page.
    name: S.name,
    state: S.state(...STORE_STATES),
    // What the Store's folder takes on the disk: its file, its files and its
    // snapshots.
    bytes: S.count(),
    createdAt: S.time,
  },
  ["name"],
);

const COLUMN_VIEW: Shape = S.record(
  {
    name: S.name,
    type: S.state(...COLUMN_TYPES),
    // Its place in the table's key, from 1. Absent when it has none.
    key: S.count(),
  },
  ["key"],
);

const TABLE_VIEW: Shape = S.record({
  name: S.name,
  kind: S.state(...TABLE_KINDS),
  // A view has no rows of its own.
  view: S.flag,
  rows: S.count(),
  // Whether `rows` is an estimate and not a count.
  estimated: S.flag,
  version: S.count(),
  // How many columns the table has, and how many of them are below. The
  // difference is the columns whose names an answer cannot hold.
  columnCount: S.count(),
  columns: S.list(COLUMN_VIEW, TABLE_COLUMNS_MAX),
});

/** A pull's counts for one table. */
const PULLED_TABLE: Shape = S.record(
  {
    table: S.name,
    version: S.count(),
    rows: S.count(),
    mode: S.state(...PULL_TABLE_MODES),
    // The rows the database's table held when it was read.
    read: S.count(),
    added: S.count(),
    changed: S.count(),
    removed: S.count(),
    // Values that were cut so that their row fits in a Store.
    cut: S.count(),
  },
  ["version", "rows", "mode", "read", "added", "changed", "removed", "cut"],
);

const JOB_VIEW: Shape = S.record(
  {
    job: S.id,
    kind: S.state(...JOB_KINDS),
    state: S.state(...JOB_STATES),
    // The part of its work an open pull is in.
    step: S.state(...PULL_STEPS),
    createdAt: S.time,
    updatedAt: S.time,
    // When a job that waits for the day's write limit goes on by itself.
    waitsUntil: S.time,
    // Why it waits or failed.
    refusal: S.state(...JOB_REFUSALS),
    rowsWritten: S.count(),
    // The rows it was about to write, when its kind could say.
    estimatedRows: S.count(),
    done: S.count(),
    total: S.count(),
    // A pull's counts over all its tables.
    tables: S.count(),
    rows: S.count(),
    read: S.count(),
    added: S.count(),
    changed: S.count(),
    removed: S.count(),
    cut: S.count(),
    // A pull's tables, each with its own counts.
    pulled: S.list(PULLED_TABLE, PULL_TABLES_MAX),
    // Tables of the job whose names an answer cannot hold.
    leftOut: S.count(),
    // Tables of the job past the most an answer holds.
    more: S.count(),
  },
  [
    "step",
    "waitsUntil",
    "refusal",
    "estimatedRows",
    "done",
    "total",
    "tables",
    "rows",
    "read",
    "added",
    "changed",
    "removed",
    "cut",
    "pulled",
  ],
);

export const STORES_MANIFEST: ModuleManifest = {
  id: STORES_MODULE_ID,
  asks: [
    {
      // Make a Store under the control plane's id for it. Asking again for an
      // id that is there changes nothing, and answers what is there.
      name: "create",
      args: S.record({ store: STORE, name: S.name }, ["name"]),
      reply: S.record({ store: STORE, state: S.state(...STORE_STATES), created: S.flag }),
    },
    {
      name: "list",
      args: S.none,
      reply: S.record({ stores: S.list(STORE_VIEW, STORES_MAX) }),
    },
    {
      // The names of a Store's tables and their columns, a page at a time.
      name: "catalog.read",
      args: S.record({ store: STORE, page: S.count(CATALOG_PAGE_NUMBER_MAX) }),
      reply: S.record({
        page: S.count(),
        pages: S.count(),
        // How many tables the Store has, on all pages.
        tables: S.count(),
        // Names an answer cannot hold, on this page. They are left out, never
        // rewritten, and counted here. A table's `columnCount` says how many
        // columns it has, whatever is below.
        leftOut: S.record({ tables: S.count(), columns: S.count() }),
        items: S.list(TABLE_VIEW, CATALOG_PAGE_TABLES),
      }),
    },
    {
      name: "stats.read",
      args: S.record({ store: STORE }),
      reply: S.record(
        {
          bytes: S.count(),
          tables: S.count(),
          rows: S.count(),
          files: S.count(),
          fileBytes: S.count(),
          // A job is open and runs: the numbers change again soon.
          busy: S.flag,
          // While every open job waits for the day's write limit: when they
          // go on by themselves.
          waitsUntil: S.time,
          // The rows the Store wrote since `writesSince`, the start of the
          // day, and the most it writes in a day.
          writesSince: S.time,
          rowsWritten: S.count(),
          writeLimit: S.count(),
          // Whether the limit is this Store's own, or the one every Store has.
          ownLimit: S.flag,
        },
        ["waitsUntil", "writesSince", "rowsWritten", "writeLimit", "ownLimit"],
      ),
    },
    {
      // What happened to a Store, newest first: when, what kind of thing, and
      // who. A line's own words stay in the Store.
      name: "history.read",
      args: S.record({ store: STORE }),
      reply: S.record(
        {
          lines: S.list(
            S.record({
              id: S.id,
              at: S.time,
              kind: S.state(...HISTORY_KINDS),
              // Who did it, as the Store names them: a person, a run, a job.
              by: S.name,
              // The Store can be taken back to the moment before this line.
              restorable: S.flag,
            }),
            HISTORY_LINES_MAX,
          ),
          // Lines that could not be told in these fields.
          leftOut: S.count(),
          // Lines past the most an answer holds.
          more: S.count(),
          // How far back the Store can be taken.
          restorableFrom: S.time,
        },
        ["restorableFrom"],
      ),
    },
    {
      // How many rows wait for a person's review, table by table.
      name: "review.read",
      args: S.record({ store: STORE }),
      reply: S.record({
        tables: S.list(
          S.record(
            {
              table: S.name,
              kind: S.state(...REVIEW_KINDS),
              // A checked table's table of flags.
              flags: S.name,
              open: S.count(),
              // The table has a newer version than its check read.
              stale: S.flag,
            },
            ["flags"],
          ),
          REVIEW_TABLES_MAX,
        ),
        // Tables whose names an answer cannot hold.
        leftOut: S.count(),
        // Tables past the most an answer holds.
        more: S.count(),
      }),
    },
    {
      name: "job.read",
      args: S.record({ store: STORE, job: S.id }),
      reply: JOB_VIEW,
    },
    {
      // Set the most rows a Store writes in a day. The organization's own
      // ceiling, set in the console, holds: a number above it is refused.
      name: "write_limit.set",
      args: S.record({ store: STORE, rows: S.count(WRITE_LIMIT_MAX) }),
      reply: S.record({ writeLimit: S.count(), ownLimit: S.flag }),
    },
    {
      // Ask for a Store to be deleted. Nothing is deleted by this ask: it
      // waits for a person of this organization, in the console.
      name: "delete",
      args: S.record({ store: STORE }),
      reply: S.record({ store: STORE, state: S.state(...STORE_STATES) }),
    },
  ],
  // The module calls no host and reads no secret. A database is reached by the
  // Databases module, which this module hands a job by a connection's name.
  egress: [],
  secrets: [],
};
