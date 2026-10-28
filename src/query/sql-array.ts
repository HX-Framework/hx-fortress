// Arrays bound as ONE parameter each, however many elements they hold.
//
// A statement carries at most 65,535 bind parameters, and Bun.SQL would expand a
// JS array into a CSV literal. So an array is written as a Postgres array
// literal, bound as one text parameter and cast on the server: the statement
// text and its parameter count stay the same for 1 element or 100,000.
//
// Because the text stays the same, Bun.SQL's named prepared statement is reused
// across calls, and after five executions Postgres may switch it to a generic
// plan. A generic plan cannot see how many elements the array holds and guesses
// about ten. Statements that filter by a large array therefore run with
// `plan_cache_mode = force_custom_plan` (read-bound.ts).

import { sql, type SQL } from "drizzle-orm";

/** One bound `uuid[]` parameter. Every id passed here was read from a uuid
 *  column, so the array literal needs no quoting. */
export function uuidArray(ids: readonly string[]): SQL {
  return sql`${`{${ids.join(",")}}`}::uuid[]`;
}

/** One bound `text[]` parameter. Every element is double-quoted, with `"` and
 *  `\` escaped, so a value holding a comma, brace, quote, backslash, space or
 *  the word NULL reads back as exactly itself. */
export function textArray(values: readonly string[]): SQL {
  return sql`${textArrayLiteral(values)}::text[]`;
}

/** The array literal `textArray` binds. Exported for its round-trip test. */
export function textArrayLiteral(values: readonly string[]): string {
  return `{${values.map((v) => `"${v.replace(/[\\"]/g, "\\$&")}"`).join(",")}}`;
}

/** An integer LIMIT written into the statement text rather than bound. A bound
 *  LIMIT leaves a generic plan guessing the row count, and a scan that must keep
 *  its index plan for every N (semantic search's HNSW candidates, keyword
 *  search's ranking pool) cannot afford the guess. */
export function limitOf(n: number): SQL {
  return sql.raw(String(Math.max(1, Math.floor(n))));
}
