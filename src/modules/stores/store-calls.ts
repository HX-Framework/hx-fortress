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
 *   stats          nothing. The Store's numbers. In them `writes`: the day,
 *                  the rows written on it, the day's limit, and `own`, whether
 *                  that limit is this Store's own
 *   history        nothing. `{ events, restorableFrom }`: what happened to the
 *                  Store, newest first. How far back the Store can be taken,
 *                  and the moment a line can take it back to, are answered
 *                  only where this host keeps such moments
 *   review         nothing. `{ tables }`: how many rows wait for a person's
 *                  review, table by table
 *   jobSummary     a job's id. `{ summary }`: the job's state, step, times,
 *                  counts and the names of its tables. Never its result
 *   setWriteLimit  the most rows the Store writes in a day. The day's writes
 *                  as they stand afterwards, as in `stats`
 *   restore        the id of a line of the Store's history. `{ to }`: the time
 *                  of the moment the Store goes back to, which is the moment
 *                  before that line. The restore is readied by this call and
 *                  carried out when the Store is next opened, so the Store's
 *                  process is closed once the call is answered
 */
export const STORE_CALLS = [
  "catalog",
  "stats",
  "history",
  "review",
  "jobSummary",
  "setWriteLimit",
  "restore",
] as const;
export type StoreCallName = (typeof STORE_CALLS)[number];

/** The name a Store's id is told to its process by, in the settings the
 *  process is opened with. The program takes calls for that Store and no other. */
export const STORE_ID_SETTING = "store";

/**
 * The most rows a Store writes in a day on this HX Fortress, until it is
 * given a limit of its own. This host's own number: the Store's program hands
 * it to the engine each time a Store is opened, so a folder of the engine
 * that is written again with another default changes no Store's limit here.
 * A test holds it to the engine's own default, for a person to decide
 * whether this host follows a change of that one.
 */
export const WRITE_LIMIT_DEFAULT = 2_000_000;
/** The fewest rows a Store's own daily write limit may be set to. */
export const WRITE_LIMIT_MIN = 1_000;
/** The most rows a Store's own daily write limit may be set to. */
export const WRITE_LIMIT_MAX = 100_000_000;

/** A limit a Store may be SET to, when a value is one: a whole number of rows
 *  from the fewest to the most. A limit that is kept already is not held to
 *  these bounds when a Store is opened: they may have moved since it was set. */
export function isWriteLimit(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= WRITE_LIMIT_MIN &&
    value <= WRITE_LIMIT_MAX
  );
}

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
 *   restore_unavailable  the Store keeps no earlier moment to go back to
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
  "restore_unavailable",
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
