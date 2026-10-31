import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { createHxDb, type HxDb } from "../src/host/postgres/db";
import { runMigrations } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";
import { makeMigrationExec } from "../src/host/postgres/sql-exec";
import { ingestCommit, type IngestAttribution } from "../src/ingest/ingest";
import { allowParallelWorkers, withWideReadBound } from "../src/query/read-bound";
import { hxTextOccurrences, literalCountStatement } from "../src/query/text-occurrences";

// hx_text_occurrences counts with one regexp_count per turn, on parallel
// workers, with its trigram pattern hidden from the planner's estimate (a word
// the column statistics happened to miss once made production read the text of
// every kind: 170 s). These tests pin the three numbers that statement returns
// and the two shapes its pattern takes.
//
//   FORTRESS_DATABASE_URL=postgres://forge:forge@localhost:5499/hx-db \
//     bun test test/hx-fortress-text-count.test.ts
const DSN = process.env.FORTRESS_DATABASE_URL;

const ATTR: IngestAttribution = { orgExternalId: null, projectExternalId: null, repoSlug: null, deviceId: null };
const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const USER = `user-textcount-${SUFFIX}`;
const OTHER = `user-textcount-other-${SUFFIX}`;
const SID = `textcount-${SUFFIX}`;
const SID_OTHER = `textcount-other-${SUFFIX}`;
const FAMILY = "claude-cli";
const TS = "2026-06-30T10:00:00Z";
const SAID = ["user_text", "assistant_text"];

const SCOPE = { identities: [{ userExternalId: USER, family: FAMILY, sessionId: SID }] };

function userText(text: string): string {
  return JSON.stringify({ type: "user", timestamp: TS, message: { content: [{ type: "text", text }] } });
}

function assistantText(text: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: TS,
    message: { model: "claude-opus-4-8", content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } },
  });
}

function toolResult(text: string): string {
  return JSON.stringify({
    type: "user",
    timestamp: TS,
    message: { content: [{ type: "tool_result", tool_use_id: "tu_count", content: text, is_error: false }] },
  });
}

describe.if(!!DSN)("hx_text_occurrences counts with one regexp_count per turn", () => {
  const dsn = DSN as string;
  const sqlx = makeMigrationExec(dsn);
  let db: HxDb;

  const cleanup = async (): Promise<void> => {
    for (const sid of [SID, SID_OTHER]) {
      await sqlx.exec(`DELETE FROM hx.ingest_events WHERE session_id_ext = '${sid}'`);
      await sqlx.exec(`DELETE FROM hx.sessions WHERE session_id = '${sid}'`);
    }
  };

  beforeAll(async () => {
    await runMigrations(sqlx, migrations);
    await cleanup();
    db = createHxDb(dsn);
    const commit = (userId: string, sessionId: string, chunkText: string) =>
      ingestCommit(db, {
        ingestChannel: "tunnel",
        attribution: ATTR,
        key: { userId, family: FAMILY, sessionId },
        chunkId: "c1",
        chunkText,
        totalBytes: chunkText.length,
        componentCount: 1,
        replace: false,
        meta: null,
      });
    await commit(
      USER,
      SID,
      [
        userText("Please release the release branch"),
        // Passes the '%release%' prefilter, holds no whole word "release".
        assistantText("We released it yesterday"),
        toolResult("release notes: release v1"),
        userText("open the PR, then go"),
      ].join("\n"),
    );
    await commit(OTHER, SID_OTHER, userText("release release release, out of scope"));
  }, 120_000);

  afterAll(async () => {
    await cleanup();
  });

  test("a word in what was said: repeats counted, a prefilter-only turn and other kinds left out", async () => {
    const out = await hxTextOccurrences(db, { scope: SCOPE, query: "release", kinds: SAID });
    expect(out.occurrences).toBe(2);
    expect(out.matchingTurns).toBe(1);
    expect(out.matchingSessions).toBe(1);
  });

  test("the same word in every kind reaches tool output", async () => {
    const out = await hxTextOccurrences(db, { scope: SCOPE, query: "release" });
    expect(out.occurrences).toBe(4);
    expect(out.matchingTurns).toBe(2);
    expect(out.matchingSessions).toBe(1);
  });

  test("a substring also counts the word inside a larger one", async () => {
    const out = await hxTextOccurrences(db, { scope: SCOPE, query: "release", kinds: SAID, matchMode: "literal_substring" });
    expect(out.occurrences).toBe(3);
    expect(out.matchingTurns).toBe(2);
  });

  test("a term with no trigram is counted on the plain pattern", async () => {
    const out = await hxTextOccurrences(db, { scope: SCOPE, query: "PR", kinds: SAID });
    expect(out.occurrences).toBe(1);
    expect(out.matchingTurns).toBe(1);
  });

  test("a word nobody said counts zero", async () => {
    const out = await hxTextOccurrences(db, { scope: SCOPE, query: "zebrafish", kinds: SAID });
    expect(out).toMatchObject({ occurrences: 0, matchingTurns: 0, matchingSessions: 0 });
  });

  test("lexeme mode still counts turns of related word forms, with no occurrence count", async () => {
    const out = await hxTextOccurrences(db, { scope: SCOPE, query: "release", kinds: SAID, matchMode: "lexeme" });
    expect(out.occurrences).toBeNull();
    expect(out.matchingTurns).toBe(2);
  });

  test("the pattern reaches the planner through a one-row subquery only when it has a trigram", () => {
    const shape = (query: string) =>
      new PgDialect().sqlToQuery(literalCountStatement([sql`true`], query, "literal_word")).sql;
    expect(shape("release")).toMatch(/ILIKE \(SELECT \$\d+::text\)/);
    expect(shape("PR")).toMatch(/ILIKE \$\d+\)/);
    expect(shape("PR")).not.toContain("(SELECT");
  });

  test("parallel workers are allowed inside the wide read only", async () => {
    const inside = await withWideReadBound(db, async (bdb) => {
      await allowParallelWorkers(bdb);
      const rows = (await bdb.execute(
        sql`SELECT current_setting('max_parallel_workers_per_gather') AS workers, current_setting('parallel_setup_cost') AS setup, current_setting('parallel_tuple_cost') AS tuple, current_setting('min_parallel_table_scan_size') AS min_scan`,
      )) as unknown as Array<{ workers: string; setup: string; tuple: string; min_scan: string }>;
      return rows[0];
    });
    expect(inside).toEqual({ workers: "4", setup: "0", tuple: "0", min_scan: "0" });

    const after = (await db.execute(
      sql`SELECT current_setting('max_parallel_workers_per_gather') AS workers`,
    )) as unknown as Array<{ workers: string }>;
    expect(after[0].workers).not.toBe("4");
  });
});
