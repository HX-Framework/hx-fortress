import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { HxDb } from "../src/host/postgres/db";
import { computeCollectionStats } from "../src/query/collection-stats";

const dialect = new PgDialect();
const render = (q: SQL): string => dialect.sqlToQuery(q).sql;

/** A db whose execute records each statement and answers it from `answer`. */
function fakeDb(answer: (text: string) => unknown[]): { db: HxDb; statements: string[] } {
  const statements: string[] = [];
  const db = {
    execute: async (q: SQL) => {
      const text = render(q);
      statements.push(text);
      return answer(text);
    },
  } as unknown as HxDb;
  return { db, statements };
}

describe("computeCollectionStats", () => {
  test("turns and embeddings come from the planner's estimate, never a count(*) of the table", async () => {
    const { db, statements } = fakeDb((text) => {
      if (text.includes("to_regclass")) return [{ rel: "hx.embeddings" }];
      if (text.includes("hx.sessions")) return [{ n: "12" }];
      if (text.includes("'hx.turns'::regclass")) return [{ n: "3400000" }];
      if (text.includes("'hx.embeddings'::regclass")) return [{ n: "910000" }];
      return [];
    });

    expect(await computeCollectionStats(db)).toEqual({ sessions: 12, turns: 3_400_000, embeddings: 910_000 });
    expect(statements.filter((s) => /count\(\*\)/i.test(s) && /hx\.(turns|embeddings)\b/.test(s))).toEqual([]);
    expect(statements.filter((s) => s.includes("pg_class"))).toHaveLength(2);
  });

  test("embeddings stays null on a fortress without the embeddings table", async () => {
    const { db, statements } = fakeDb((text) => {
      if (text.includes("to_regclass")) return [{ rel: null }];
      if (text.includes("hx.sessions")) return [{ n: 3 }];
      if (text.includes("'hx.turns'::regclass")) return [{ n: 40 }];
      return [];
    });

    expect(await computeCollectionStats(db)).toEqual({ sessions: 3, turns: 40, embeddings: null });
    expect(statements.some((s) => s.includes("'hx.embeddings'::regclass"))).toBe(false);
  });
});
