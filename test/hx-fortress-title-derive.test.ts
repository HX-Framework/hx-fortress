import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createHxDb, type HxDb } from "../src/host/postgres/db";
import { runMigrations } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";
import { makeMigrationExec } from "../src/host/postgres/sql-exec";
import { ingestCommit, type IngestAttribution } from "../src/ingest/ingest";
import sql0014BackfillTitles from "../src/host/postgres/migrations/0014_backfill_session_titles.sql" with { type: "text" };

// Fortress-side fallback-title derivation (the fix for post-MC-2606 title-less
// sessions). Runs against a real Postgres when FORTRESS_DATABASE_URL is set;
// skipped (no failure) otherwise so a plain `bun test` stays green.
//   FORTRESS_DATABASE_URL=postgres://forge:forge@localhost:5499/hx-db bun test test/hx-fortress-title-derive.test.ts
const DSN = process.env.FORTRESS_DATABASE_URL;

const ATTR: IngestAttribution = { orgExternalId: null, projectExternalId: null, repoSlug: null, deviceId: null };
const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TS = "2026-07-28T10:00:00Z";

const userChunk = (firstLine: string): string =>
  [
    JSON.stringify({ type: "user", timestamp: TS, message: { content: [{ type: "text", text: firstLine }] } }),
    JSON.stringify({
      type: "assistant",
      timestamp: TS,
      message: { model: "claude-opus-4-8", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } },
    }),
  ].join("\n");

const assistantOnlyChunk = (): string =>
  JSON.stringify({
    type: "assistant",
    timestamp: TS,
    message: { model: "claude-opus-4-8", content: [{ type: "text", text: "no user turn here" }], usage: { input_tokens: 1, output_tokens: 1 } },
  });

describe.if(!!DSN)("hx-fortress fallback-title derivation on ingest", () => {
  const dsn = DSN as string;
  const sql = makeMigrationExec(dsn);
  let db: HxDb;

  const ids: string[] = [];
  const key = (tag: string) => {
    const sessionId = `sess-title-${tag}-${SUFFIX}`;
    ids.push(sessionId);
    return { userId: `user-title-${SUFFIX}`, family: "claude-cli", sessionId };
  };
  const commit = (k: ReturnType<typeof key>, chunkId: string, chunkText: string, meta: Record<string, unknown> | null) =>
    ingestCommit(db, { ingestChannel: "tunnel", attribution: ATTR, key: k, chunkId, replace: false, chunkText, totalBytes: chunkText.length, componentCount: 1, meta });
  const titleOf = async (sessionId: string) =>
    (await sql.query<{ title: string | null; title_source: string | null }>(
      `SELECT title, title_source FROM hx.sessions WHERE session_id = '${sessionId}'`,
    ))[0];

  beforeAll(async () => {
    await runMigrations(sql, migrations);
    db = createHxDb(dsn);
  }, 60_000);

  afterAll(async () => {
    if (!DSN) return;
    for (const id of ids) {
      await sql.exec(`DELETE FROM hx.ingest_events WHERE session_id_ext = '${id}'`);
      await sql.exec(`DELETE FROM hx.sessions WHERE session_id = '${id}'`);
    }
  });

  test("title-less commit → title derived from the first user turn (source=fallback)", async () => {
    const k = key("derived");
    await commit(k, "c1", userChunk("investigate the flaky login test"), { cwd: "/home/u/let-forge" });
    const row = await titleOf(k.sessionId);
    expect(row.title).toBe("investigate the flaky login test");
    expect(row.title_source).toBe("fallback");
  });

  test("explicit meta.title is used verbatim, never overwritten by the derive", async () => {
    const k = key("explicit");
    await commit(k, "c1", userChunk("some opening message"), { title: "Real AI Title", titleSource: "ai" });
    const row = await titleOf(k.sessionId);
    expect(row.title).toBe("Real AI Title");
    expect(row.title_source).toBe("ai");
  });

  test("no user turn → derives from cwd basename", async () => {
    const k = key("cwdonly");
    await commit(k, "c1", assistantOnlyChunk(), { cwd: "/home/u/projects/widget-svc" });
    const row = await titleOf(k.sessionId);
    expect(row.title).toBe("widget-svc");
    expect(row.title_source).toBe("fallback");
  });

  test("a later title-less append keeps the derived title; a real title later overrides it", async () => {
    const k = key("resume");
    await commit(k, "c1", userChunk("first message that becomes the fallback"), null);
    expect((await titleOf(k.sessionId)).title).toBe("first message that becomes the fallback");

    // resume/append with no title → must not null the derived title
    await commit(k, "c2", userChunk("a later message"), null);
    let row = await titleOf(k.sessionId);
    expect(row.title).toBe("first message that becomes the fallback");
    expect(row.title_source).toBe("fallback");

    // a real user/AI title later still wins over the fallback
    await commit(k, "c3", userChunk("yet another"), { title: "User Named It", titleSource: "user" });
    row = await titleOf(k.sessionId);
    expect(row.title).toBe("User Named It");
    expect(row.title_source).toBe("user");
  });

  // The 0014 backfill migration (the fix for existing pre-fix rows). Simulate a
  // pre-fix session by NULL-ing the title ingest-derive set, then run the EXACT
  // SQL the migration ships (idempotent — it fills only title IS NULL). Also
  // proves the pg_temp derivation matches the JS helper on a real Postgres.
  test("0014 migration fills null titles from the first user turn, never clobbering real ones", async () => {
    const nullK = key("bf-null");
    const realK = key("bf-real");
    await commit(nullK, "c1", userChunk("name me from my first line"), null);
    await commit(realK, "c1", userChunk("irrelevant opener"), { title: "Human Title", titleSource: "user" });
    // simulate the pre-fix state on the first session only
    await sql.exec(`UPDATE hx.sessions SET title = NULL, title_source = NULL WHERE session_id = '${nullK.sessionId}'`);
    expect((await titleOf(nullK.sessionId)).title).toBeNull();

    await sql.exec(sql0014BackfillTitles);

    const filledRow = await titleOf(nullK.sessionId);
    expect(filledRow.title).toBe("name me from my first line");
    expect(filledRow.title_source).toBe("fallback");

    // a real title is never overwritten
    const realRow = await titleOf(realK.sessionId);
    expect(realRow.title).toBe("Human Title");
    expect(realRow.title_source).toBe("user");
  });
});
