// The calls the module makes to a Store's program, by name.
//
// A Store's program runs in the Store's own process (host/store-process.ts).
// The module asks it one thing at a time, by a name from this list. The list
// is closed on both sides: the module sends no other name, and the program
// answers no other.
//
// These are the calls behind the control plane's asks. Each answers names,
// counts, states and times, and the module builds what it sends on from them
// (answers.ts). The calls that hold rows are not here: they belong to the
// people of this organization, and come with the functions behind them.

/**
 * The calls, what each takes after its name, and what its value is.
 *
 *   catalog        the place of the first table to answer and how many, as two
 *                  numbers. `{ tables, total }`: those tables with their
 *                  columns, and how many tables the Store has in all
 *   stats          nothing. The Store's numbers
 *   history        nothing. `{ events, restorableFrom }`: what happened to the
 *                  Store, newest first
 *   review         nothing. `{ tables }`: how many rows wait for a person's
 *                  review, table by table
 *   jobSummary     a job's id. `{ summary }`: the job's state, step, times,
 *                  counts and the names of its tables. Never its result
 *   setWriteLimit  the most rows the Store writes in a day. The limit as it
 *                  stands afterwards
 */
export const STORE_CALLS = [
  "catalog",
  "stats",
  "history",
  "review",
  "jobSummary",
  "setWriteLimit",
] as const;
export type StoreCallName = (typeof STORE_CALLS)[number];

/**
 * The words a Store's program refuses one of these calls with, and that the
 * control plane is told: as `engine_<word>`, so that none can be taken for a
 * word of the module's own.
 *
 * THE LIST IS CLOSED. A refusal's word is chosen by the program that runs in
 * the Store's process, and a word that is only held to a pattern could carry
 * anything that fits the pattern. A word that is not on this list is told as
 * `engine_refused`.
 *
 *   bad_request          the call's own values were not what the program takes
 *   not_found            no such job
 *   sql_error            SQLite refused a statement of the program's own
 *   store_busy           an export or an import holds the Store
 *   store_destroyed      the Store was deleted
 *   store_restoring      a restore of the Store is under way
 *   table_parked         a table's rows rest in the Store's files
 *   token_wrong_store    the file belongs to a Store with another id
 *   write_limit_reached  the Store wrote its limit for the day
 *   internal             the program failed in a way it has no word for
 */
export const ENGINE_CODES = [
  "bad_request",
  "not_found",
  "sql_error",
  "store_busy",
  "store_destroyed",
  "store_restoring",
  "table_parked",
  "token_wrong_store",
  "write_limit_reached",
  "internal",
] as const;
export type EngineCode = (typeof ENGINE_CODES)[number];

/** What the module reads a call's answer as. */
export type StoreAnswer =
  | { ok: true; value: unknown }
  /** A refusal, by a word of the list, or `refused` for any other word. The
   *  program's own sentence about it is not read: it is for a person who may
   *  read rows. */
  | { ok: false; code: EngineCode | "refused" }
  /** Not an answer at all. */
  | { ok: null };

/**
 * A call's answer, read as one. The program answers `{ ok: true, value }`, or
 * `{ ok: false, code, error }` with its own sentence in `error`.
 */
export function readStoreAnswer(value: unknown): StoreAnswer {
  if (typeof value !== "object" || value === null) return { ok: null };
  const answer = value as { ok?: unknown; value?: unknown; code?: unknown };
  if (answer.ok === true) return { ok: true, value: answer.value };
  if (answer.ok !== false) return { ok: null };
  const listed = (ENGINE_CODES as readonly unknown[]).includes(answer.code);
  return { ok: false, code: listed ? (answer.code as EngineCode) : "refused" };
}
