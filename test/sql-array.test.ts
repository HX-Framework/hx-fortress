import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { createHxDb, type HxDb } from "../src/host/postgres/db";
import { withReadBound } from "../src/query/read-bound";
import { textArray, textArrayLiteral, uuidArray } from "../src/query/sql-array";

// An array is bound as ONE parameter however many elements it holds, and every
// text element reads back as exactly itself.
//
//   FORTRESS_DATABASE_URL=postgres://forge:forge@localhost:5499/hx-db \
//     bun test test/sql-array.test.ts
const DSN = process.env.FORTRESS_DATABASE_URL;

// Values the array-literal syntax gives a meaning to: separators, braces, quotes,
// the escape character, surrounding space and the NULL keyword.
const AWKWARD = [
  "plain",
  "a,b",
  "{braced}",
  'say "hi"',
  "back\\slash",
  "trailing\\",
  "  padded  ",
  "NULL",
  "null",
  "ü ✓ 漢字",
  "'single'",
  "tab\there",
];

describe("textArrayLiteral", () => {
  test("double-quotes every element and escapes quote and backslash", () => {
    expect(textArrayLiteral(["a", 'b"c', "d\\e"])).toBe('{"a","b\\"c","d\\\\e"}');
    expect(textArrayLiteral([])).toBe("{}");
  });
});

describe("one bind parameter per array", () => {
  const dialect = new PgDialect();
  test("100,000 elements still compile to a single parameter", () => {
    const values = Array.from({ length: 100_000 }, (_v, i) => `v${i}`);
    expect(dialect.sqlToQuery(sql`SELECT ${textArray(values)}`).params).toHaveLength(1);
    const ids = Array.from({ length: 100_000 }, () => crypto.randomUUID());
    expect(dialect.sqlToQuery(sql`SELECT ${uuidArray(ids)}`).params).toHaveLength(1);
  });
});

describe.if(!!DSN)("textArray round trip through Postgres", () => {
  let db: HxDb;
  beforeAll(() => {
    db = createHxDb(DSN as string);
  });

  test("every awkward value reads back unchanged and in order", async () => {
    const rows = (await db.execute(
      sql`SELECT v, n FROM unnest(${textArray(AWKWARD)}) WITH ORDINALITY AS t(v, n) ORDER BY n`,
    )) as unknown as Array<{ v: string | null }>;
    expect(rows.map((r) => r.v)).toEqual(AWKWARD);
  });

  test("an empty array is an empty set, not an error", async () => {
    const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM unnest(${textArray([])})`)) as unknown as Array<{
      n: number;
    }>;
    expect(rows[0]?.n).toBe(0);
  });

  // The array's statement text is the same for every size, so a reused prepared
  // statement must not fall back to a generic plan that guesses ten elements.
  test("a read transaction plans each statement for its own parameters, and only that transaction", async () => {
    const inside = await withReadBound(db, async (tx) => {
      const rows = (await tx.execute(sql`SELECT current_setting('plan_cache_mode') AS mode`)) as unknown as Array<{
        mode: string;
      }>;
      return rows[0]?.mode;
    });
    expect(inside).toBe("force_custom_plan");
    const after = await db.transaction(async (tx) => {
      const rows = (await tx.execute(sql`SELECT current_setting('plan_cache_mode') AS mode`)) as unknown as Array<{
        mode: string;
      }>;
      return rows[0]?.mode;
    });
    expect(after).toBe("auto");
  });

  test("uuidArray reads back the ids it was given", async () => {
    const ids = Array.from({ length: 3 }, () => crypto.randomUUID());
    const rows = (await db.execute(
      sql`SELECT id::text AS id FROM unnest(${uuidArray(ids)}) WITH ORDINALITY AS t(id, n) ORDER BY n`,
    )) as unknown as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(ids);
  });
});
