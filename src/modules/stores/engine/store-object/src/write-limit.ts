// The daily write limit (DB Connect, 2026-11-08; per organization since 2026-11-19). Cloudflare
// bills $1.00 for every million rows SQLite writes for a store, index entries included, so stores
// that wrote without end would run up the bill. Each store counts the rows it writes per UTC day,
// and once the day's count reaches the limit it takes no more writes of its data until the next
// UTC day.
//
// The count is SQLite's own: each statement's cursor says how many rows it wrote (`rowsWritten`,
// the number Cloudflare bills). `MeteredSql` adds them up as statements run, in the object's memory,
// and the limit is checked against that. The sum is kept in one row of `_meta` per day
// (`rows_written:<YYYY-MM-DD>`) once it reaches 1,000 rows, when a new UTC day begins, before a
// restore, and by an alarm 5 seconds after a call that left rows waiting. An idle object sleeps
// about 10 seconds after its last call and forgets what its memory held, so without that alarm a
// store written in bursts under 1,000 rows would never keep a count. One alarm serves every call in
// those seconds, so an app's one-row writes do not double. A job keeps the count in the same
// transaction as each commit of its rows (runner.ts), so a chunk's rows are never on disk without
// their count, and its last chunk keeps the rest. An object the platform stops before that alarm (a
// deploy) forgets at most 999 rows. Counts older than 31 days are dropped.
//
// Whose count, and whose limit. A store whose host keeps its organization's budget
// (`StoreDeps.writeBudget`: a deployment's gateway keeps one per organization) shares one count and one
// limit with every store of that organization. It learns its organization from the first caller
// whose token names one (handler.ts `admit`). It tells the budget the rows it kept, once 1,000 wait
// and at each alarm, and holds itself to the budget's answer: the organization's count as the
// budget last heard it, with this store's rows the budget has not heard yet, against the
// organization's limit. Its first write after it wakes asks first, and an alarm asks again once the
// answer is a minute old. The organization's other stores may write between two answers, so the
// organization can end a day past its limit by what its stores wrote meanwhile. A store with no
// budget, or that knows no organization yet, holds itself alone to the Worker's
// `STORE_DAILY_WRITE_LIMIT` (any whole number of rows; 0 stops every store's writes), else to
// 2,000,000 rows (about $2.00 a day). The budget's keeper has the last word on its limit: until it
// first answers, the store holds itself to the Worker's limit.
//
// The refusal says who may raise the limit in the deployer's own words (`STORE_WRITE_LIMIT_HINT`),
// since this package says nothing of its deployer. Past it, the store refuses what writes its data:
// SQL that changes managed tables, a migration, an app's writes, and a new job. A call that started
// under the limit finishes, so a day can end past it by one call. A job under way waits instead of
// failing (jobs/runner.ts): its chunk stops at its next commit, and no chunk runs until 00:00 UTC,
// or until the limit is raised, when it goes on where it stopped with its tables in progress, so
// nothing it wrote is written again. A job that waits on its organization's budget asks it again
// each minute, so a raised limit lets it go on within a minute. Always taken: an upload's records,
// a file's removal, a restore, and an app's sign-ins, which write a few rows a person waits on.

import { StoreError, type StoreCore } from "./core.js";
import { utcDay } from "./metered-sql.js";
import { getMeta } from "./schema.js";
import type { JobWait, StoreWrites, WriteBudget } from "./types.js";

export { utcDay };

/** The limit a store holds itself to when no budget and no Worker names one. */
export const WRITE_LIMIT_DEFAULT = 2_000_000;
/** What a million rows written costs, in dollars (Durable Objects' SQLite storage, 2026-10). */
export const DOLLARS_PER_MILLION_ROWS_WRITTEN = 1;
/** Days of counts a store keeps. */
export const WRITE_DAYS_KEPT = 31;
/** The count is kept in `_meta` once this many rows wait in memory, and told to the budget once this many wait to be told. */
export const WRITE_KEEP_EVERY = 1_000;
/** How soon after a call an alarm keeps the rows waiting in memory: well before an idle object sleeps (about 10 s). */
export const WRITE_KEEP_WITHIN_MS = 5_000;
/**
 * How old the budget's answer may be before an alarm, or a write past the limit, asks again, and how
 * often a job that waits on it looks.
 */
export const BUDGET_ASK_EVERY_MS = 60_000;
/** While jobs wait on an organization's limit, how soon the ledger reads the store's numbers again. */
export const BUDGET_STATS_EVERY_MS = 10 * 60_000;

/** The day counts' keys, `rows_written:<day>`, sort from the prefix up to (not with) the end. */
export const WRITE_COUNT_PREFIX = "rows_written:";
export const WRITE_COUNT_END = "rows_written;";
const COUNT_PREFIX = WRITE_COUNT_PREFIX;

/** The `_meta` key of a day's count. */
export const writeCountKey = (day: string): string => `${COUNT_PREFIX}${day}`;

/** Whether a `_meta` key is one this file keeps: a day's count. */
export const isWriteKey = (key: string): boolean => key.startsWith(COUNT_PREFIX);

/** The objects that already said their Worker's limit is unreadable: once each. */
const toldUnreadable = new WeakSet<StoreCore>();

/**
 * The deployer's limit for every store (`STORE_DAILY_WRITE_LIMIT`): any whole number of rows, 0
 * included, which stops every store's writes. Unset is null; a value that is not a number of rows
 * is null too, and says so in the log once per object, so a typo is not silently the default.
 */
function workerLimit(core: StoreCore): number | null {
  const value = core.env.STORE_DAILY_WRITE_LIMIT;
  const text = value === undefined || value === null ? "" : String(value).trim();
  if (text === "") return null;
  const n = Number(text);
  if (Number.isSafeInteger(n) && n >= 0) return n;
  if (!toldUnreadable.has(core)) {
    toldUnreadable.add(core);
    const line = {
      at: "store.writes",
      error: `STORE_DAILY_WRITE_LIMIT is not a whole number of rows (${JSON.stringify(text.slice(0, 40))}), so the store holds itself to ${rowsText(WRITE_LIMIT_DEFAULT)} rows a day`,
    };
    if (core.deps.log) core.deps.log(line);
    else console.error(JSON.stringify(line));
  }
  return null;
}

/** The limit a store holds itself to with no budget's answer: the Worker's, else the default. */
function storeLimit(core: StoreCore): number {
  return workerLimit(core) ?? WRITE_LIMIT_DEFAULT;
}

/** The budget this store's writes count toward: its organization's, when its host keeps one and it knows its organization. */
function budgetOf(core: StoreCore): WriteBudget | null {
  if (!core.deps.writeBudget) return null;
  const org = core.org;
  return org ? core.deps.writeBudget(org) : null;
}

/** Whether this store counts toward its organization's budget. */
export function sharesBudget(core: StoreCore): boolean {
  return core.deps.writeBudget !== undefined && core.org !== null;
}

/** Rows kept in `_meta` that the budget has not heard yet. */
function untoldRows(core: StoreCore): number {
  let n = 0;
  for (const rows of core.budget.untold.values()) n += rows;
  return n;
}

/**
 * At the start of a call or an alarm: the UTC day new rows count on is today, and a new day keeps
 * the last day's rows on that day first. The one place the count reads the clock, so a job's
 * commits never do.
 */
export function startWrites(core: StoreCore): void {
  const today = utcDay(core.deps.now());
  if (core.meter.day === today) return;
  // The rows an object wrote as it started count on today; only an earlier day's are kept first.
  if (core.meter.day !== null) keepWriteCount(core, { force: true });
  core.meter.day = today;
}

/**
 * Today's writes, and the limit they are held to. With a budget: the organization's count as the
 * budget last answered for today, and this store's rows it has not heard, against the budget's limit.
 * Without: this store's count kept, what is not kept yet, and the Worker's limit.
 */
export function writesToday(core: StoreCore): StoreWrites {
  const day = core.meter.day ?? utcDay(core.deps.now());
  if (sharesBudget(core)) {
    const answer = core.budget.answer;
    const heard = answer && answer.day === day ? answer.rows : 0;
    const unheard = (core.budget.untold.get(day) ?? 0) + core.meter.unkept;
    return { day, rows: heard + unheard, limit: answer ? answer.limit : storeLimit(core), shared: true };
  }
  const kept = Number(getMeta(core.sql, writeCountKey(day)) ?? 0) || 0;
  return { day, rows: kept + core.meter.unkept, limit: storeLimit(core), shared: false };
}

/**
 * Adds the rows written since the last time to their day's count, one row of `_meta`, once 1,000
 * wait, or when `force` asks (a new day, a restore that takes the count with it, an alarm with no
 * other due soon). The keeping statement's own row waits for the next keep, so the count leaves out
 * at most that row, when the object sleeps first. What it keeps also waits to be told to the
 * organization's budget (`tellBudget`). Never throws: a count that cannot be kept now is kept with
 * the next one.
 */
export function keepWriteCount(core: StoreCore, opts: { force?: boolean } = {}): void {
  const meter = core.meter;
  if (meter.unkept <= 0) return;
  if (!opts.force && meter.unkept < WRITE_KEEP_EVERY) return;
  const day = meter.day ?? utcDay(core.deps.now());
  try {
    // A destroyed store keeps its mark and nothing else.
    if (getMeta(core.sql, "destroyed_at")) {
      forgetWrites(core);
      return;
    }
    const add = meter.unkept;
    meter.unkept = 0;
    // Through the meter: this statement's own rows wait for the next keep, so none is left out.
    core.sql.exec(
      "INSERT INTO _meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT)",
      writeCountKey(day),
      String(add),
      add,
    );
    if (sharesBudget(core)) core.budget.untold.set(day, (core.budget.untold.get(day) ?? 0) + add);
    if (meter.prunedDay !== day) {
      meter.prunedDay = day;
      // Its own rows, if it drops any, are counted the next time.
      const oldest = utcDay(Date.parse(`${day}T00:00:00Z`) - WRITE_DAYS_KEPT * 86_400_000);
      core.sql.exec("DELETE FROM _meta WHERE key > ? AND key < ?", COUNT_PREFIX, writeCountKey(oldest));
    }
  } catch (error) {
    console.error(JSON.stringify({ at: "store.writes", error: error instanceof Error ? error.message : String(error) }));
  }
}

/**
 * Tells the organization's budget the rows it has not heard, and keeps its answer. It tells once
 * 1,000 rows wait, or whatever waits with `all`. It asks with nothing to tell when it has no answer
 * yet, with `askOlderThan` when the answer is that old, and when the store is past the limit by an
 * answer a minute old, so a raise reaches a store that keeps being refused. One report goes at a
 * time. Never throws: rows the budget could not take are told with the next report.
 */
export async function tellBudget(core: StoreCore, opts: { all?: boolean; askOlderThan?: number } = {}): Promise<void> {
  const budget = budgetOf(core);
  if (!budget) return;
  const state = core.budget;
  while (state.telling) await state.telling;
  const untold = untoldRows(core);
  const asked = state.answeredAt;
  const age = asked === null ? Infinity : core.deps.now() - asked;
  const now = writesToday(core);
  const ask = asked === null || (opts.askOlderThan !== undefined && age >= opts.askOlderThan) || (now.rows >= now.limit && age >= BUDGET_ASK_EVERY_MS);
  if (untold < WRITE_KEEP_EVERY && !(opts.all && untold > 0) && !ask) return;
  const today = core.meter.day ?? utcDay(core.deps.now());
  state.telling = (async () => {
    try {
      const days = [...state.untold.entries()].filter(([, rows]) => rows > 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      // The last report is today's, so the answer kept is today's count.
      if (!days.some(([day]) => day === today)) days.push([today, 0]);
      for (const [day, rows] of days) {
        // Taken before the call: rows kept while it is out are told with the next report.
        if (rows > 0) state.untold.set(day, (state.untold.get(day) ?? 0) - rows);
        let answer;
        try {
          answer = await budget.wrote(day, rows);
        } catch (error) {
          if (rows > 0) state.untold.set(day, (state.untold.get(day) ?? 0) + rows);
          throw error;
        }
        if ((state.untold.get(day) ?? 0) <= 0) state.untold.delete(day);
        if (day === today && answer && answer.day === day && Number.isFinite(answer.rows) && Number.isFinite(answer.limit)) {
          state.answer = { day: answer.day, rows: Math.max(0, answer.rows), limit: Math.max(0, answer.limit) };
          state.answeredAt = core.deps.now();
        }
      }
    } catch (error) {
      console.error(JSON.stringify({ at: "store.writes", event: "budget_unreachable", store: core.storeId, error: error instanceof Error ? error.message : String(error) }));
    } finally {
      state.telling = null;
    }
  })();
  await state.telling;
}

/**
 * At the end of a call that leaves rows waiting in memory, or rows the budget has not heard: an
 * alarm keeps and tells them within 5 seconds, unless one is set sooner (a job's next chunk keeps
 * them with its own rows). One alarm serves every call in those seconds, where a keep at each
 * call's end would add a row to each. Never throws.
 */
export async function keepSoon(core: StoreCore): Promise<void> {
  const meter = core.meter;
  if (meter.unkept <= 0 && untoldRows(core) <= 0) return;
  const now = core.deps.now();
  if (meter.keepBy !== null && meter.keepBy > now) return;
  const at = now + WRITE_KEEP_WITHIN_MS;
  try {
    await core.wakeAt(at);
    meter.keepBy = at;
  } catch (error) {
    console.error(JSON.stringify({ at: "store.writes", error: error instanceof Error ? error.message : String(error) }));
  }
}

/** Drops what the meter holds and has not kept, and what the budget answered: the store it counted for was wiped. */
export function forgetWrites(core: StoreCore): void {
  core.meter.unkept = 0;
  core.meter.day = null;
  core.meter.prunedDay = null;
  core.meter.keepBy = null;
  core.budget.untold.clear();
  core.budget.answer = null;
  core.budget.answeredAt = null;
}

/** A count of rows with its thousands marked: 2,000,000. */
export function rowsText(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * The refusal past the limit, in words a program's run and its Runs list show; `hint` says who may
 * raise the limit, in the deployer's words (`STORE_WRITE_LIMIT_HINT`). It says rows, the limit and
 * when it resets, never a dollar amount: an agent could repeat these words in a chat.
 */
export function writeLimitWords(writes: Pick<StoreWrites, "rows" | "limit" | "shared">, hint?: string | null): string {
  const words = writes.shared
    ? `This organization's stores have written ${rowsText(writes.rows)} rows today (UTC), and their limit is ${rowsText(writes.limit)} rows a day. ` +
      `They take more writes after 00:00 UTC, or once the organization's daily write limit is raised.`
    : `This store has written ${rowsText(writes.rows)} rows today (UTC), and its limit is ${rowsText(writes.limit)} rows a day. ` +
      `It takes more writes after 00:00 UTC, or once its daily write limit is raised.`;
  const more = typeof hint === "string" ? hint.trim().slice(0, 300) : "";
  return more ? `${words} ${more}` : words;
}

/** The refusal past the limit for this store, with its deployer's hint. */
export function storeWriteLimitWords(core: StoreCore, writes: StoreWrites): string {
  return writeLimitWords(writes, core.env.STORE_WRITE_LIMIT_HINT);
}

/** Refuses a write of the store's data once today's count has reached the limit. */
export function refusePastWriteLimit(core: StoreCore): void {
  const writes = writesToday(core);
  if (writes.rows >= writes.limit) throw new StoreError(429, "write_limit_reached", storeWriteLimitWords(core, writes));
}

/** When a UTC day (YYYY-MM-DD) ends, in epoch ms: the next day's count begins at its 00:00 UTC. */
export function dayEndsAt(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) + 86_400_000;
}

/**
 * What an open job waits for while today's writes are at the limit: the store's words, and the next
 * 00:00 UTC, the latest it goes on. Null while the store is under its limit.
 */
export function writeLimitWait(core: StoreCore, writes: StoreWrites = writesToday(core)): JobWait | null {
  if (writes.rows < writes.limit) return null;
  return { code: "write_limit_reached", error: storeWriteLimitWords(core, writes), until: new Date(dayEndsAt(writes.day)).toISOString() };
}

/**
 * When a job that waits for the limit looks again: at 00:00 UTC, or within a minute when the limit
 * is its organization's, which may be raised at any time.
 */
export function writeLimitLooksAgainAt(core: StoreCore, writes: StoreWrites): number {
  const until = dayEndsAt(writes.day);
  return writes.shared ? Math.min(until, core.deps.now() + BUDGET_ASK_EVERY_MS) : until;
}
