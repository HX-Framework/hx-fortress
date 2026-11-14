import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { fortressPaths } from "../src/host/paths";
import type { HxDb } from "../src/host/postgres/db";
import { createConsoleReadPort, type ConsoleReadPortDeps } from "../src/ui/console-read-port";

// A Fortress that runs with Sessions off and has no pgvector has no embeddings
// table: the migration that makes it waits for the extension. The console's
// Overview reads the embeddings figures on every load, and that read must
// answer "none" there. It used to fail the whole page with the query's text.

const dialect = new PgDialect();
const render = (q: SQL): string => dialect.sqlToQuery(q).sql;

function portOver(answer: (text: string) => unknown[]): { facts: () => Promise<unknown>; statements: string[] } {
  const statements: string[] = [];
  const db = {
    execute: async (q: SQL) => {
      const text = render(q);
      statements.push(text);
      return answer(text);
    },
  } as unknown as HxDb;
  // `facts()` asks the database, the bucket and the store, and nothing else.
  const deps = {
    // A folder that is never read: no method under test opens a file.
    paths: fortressPaths("/nonexistent/hx-fortress-test"),
    universe: { orgExternalId: "" },
    db: () => db,
    bucket: async () => null,
    store: () => null,
  } as unknown as ConsoleReadPortDeps;
  const port = createConsoleReadPort(deps);
  return { facts: () => port.facts(), statements };
}

const POSTGRES_FACTS = { databaseBytes: 8_000_000, sessions: 0, people: 0, tombstones: 0 };

describe("the console's facts, on a database with no embeddings table", () => {
  test("answer that there are no embeddings, and never send the query that would fail", async () => {
    const { facts, statements } = portOver((text) => {
      if (text.includes("to_regclass")) return [{ rel: null }];
      if (text.includes("hx.embeddings")) throw new Error('relation "hx.embeddings" does not exist');
      if (text.includes("pg_database_size")) return [POSTGRES_FACTS];
      return [];
    });
    const answer = (await facts()) as { postgres: unknown; embeddings: unknown };
    expect(answer.embeddings).toBeNull();
    // The rest of the page is answered as before.
    expect(answer.postgres).toEqual(POSTGRES_FACTS);
    expect(statements.filter((s) => /FROM hx\.embeddings/.test(s))).toEqual([]);
  });

  test("where the table exists, its figures are read as before", async () => {
    const figures = { embedded: 12, models: 1, newestAt: "2026-11-01T00:00:00.000Z" };
    const { facts, statements } = portOver((text) => {
      if (text.includes("to_regclass")) return [{ rel: "hx.embeddings" }];
      if (/FROM hx\.embeddings/.test(text)) return [figures];
      if (text.includes("pg_database_size")) return [POSTGRES_FACTS];
      return [];
    });
    expect(((await facts()) as { embeddings: unknown }).embeddings).toEqual(figures);
    expect(statements.filter((s) => /FROM hx\.embeddings/.test(s))).toHaveLength(1);
  });
});
