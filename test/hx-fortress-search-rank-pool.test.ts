import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { createHxDb, type HxDb } from "../src/host/postgres/db";
import { runMigrations } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";
import { makeMigrationExec } from "../src/host/postgres/sql-exec";
import { ingestCommit, type IngestAttribution } from "../src/ingest/ingest";
import { withWideReadBound } from "../src/query/read-bound";
import { hxSessionSearch } from "../src/query/search";

// hx_session_search ranks only the newest RANK_POOL matches of a word (ranking
// reads every match's out-of-line tsvector, which a common word turned into a
// 40 s read on production). These tests reach that bound with a pool of 3 on a
// corpus of 5 matches: the best-ranked match is the OLDEST, so a ranking over the
// pool must not return it, and the answer must say how many it never ranked.
//
//   FORTRESS_DATABASE_URL=postgres://forge:forge@localhost:5499/hx-db \
//     bun test test/hx-fortress-search-rank-pool.test.ts
const DSN = process.env.FORTRESS_DATABASE_URL;

const ATTR: IngestAttribution = { orgExternalId: null, projectExternalId: null, repoSlug: null, deviceId: null };
const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const USER = `user-rankpool-${SUFFIX}`;
const OTHER = `user-rankpool-other-${SUFFIX}`;
const SID = `rankpool-${SUFFIX}`;
const SID_OTHER = `rankpool-other-${SUFFIX}`;
const FAMILY = "claude-cli";
const WORD = `zebrafish${SUFFIX.replace(/\W/g, "")}`;

function userTurn(text: string, ts: string): string {
  return JSON.stringify({ type: "user", timestamp: ts, message: { content: [{ type: "text", text }] } });
}

const SCOPE = { identities: [{ userExternalId: USER, family: FAMILY, sessionId: SID }] };

describe.if(!!DSN)("hx_session_search ranks the newest matches of a common word", () => {
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
    // Oldest first. The oldest says the word four times, so it ranks highest.
    await commit(
      USER,
      SID,
      [
        userTurn(`${WORD} ${WORD} ${WORD} ${WORD} the oldest turn`, "2026-06-01T10:00:00Z"),
        userTurn(`the second turn names ${WORD} once`, "2026-06-02T10:00:00Z"),
        userTurn(`the third turn names ${WORD} once`, "2026-06-03T10:00:00Z"),
        userTurn(`the fourth turn names ${WORD} once`, "2026-06-04T10:00:00Z"),
        userTurn(`the newest turn names ${WORD} once`, "2026-06-05T10:00:00Z"),
      ].join("\n"),
    );
    await commit(OTHER, SID_OTHER, userTurn(`${WORD} ${WORD} ${WORD} ${WORD} ${WORD} out of scope`, "2026-06-06T10:00:00Z"));
  }, 120_000);

  afterAll(async () => {
    await cleanup();
  });

  test("a word with fewer matches than the pool is ranked over all of them, unflagged", async () => {
    const out = await hxSessionSearch(db, { scope: SCOPE, query: WORD, k: 2 });
    expect(out.truncated).toBeUndefined();
    expect(out.dropped).toBeUndefined();
    expect(out.hits).toHaveLength(2);
    expect(out.hits[0].snippet).toContain("oldest");
    expect(out.hits.every((h) => h.sessionId === SID)).toBe(true);
  });

  test("more matches than the pool: the best of the newest, and how many were never ranked", async () => {
    const out = await hxSessionSearch(db, { scope: SCOPE, query: WORD, k: 2 }, { rankPool: 3 });
    expect(out.truncated).toBe(true);
    // 5 in scope (the other user's turn is not), 2 returned.
    expect(out.dropped).toBe(3);
    expect(out.hits).toHaveLength(2);
    expect(out.hits.every((h) => h.sessionId === SID)).toBe(true);
    // The oldest turn ranks highest but is not among the newest 3.
    expect(out.hits.some((h) => h.snippet.includes("oldest"))).toBe(false);
    expect(out.hits.every((h) => /third|fourth|newest/.test(h.snippet))).toBe(true);
  });

  test("a date window that leaves no more than the pool is ranked whole again", async () => {
    const out = await hxSessionSearch(
      db,
      { scope: SCOPE, query: WORD, k: 5, fromDate: "2026-06-04", timezone: "UTC" },
      { rankPool: 3 },
    );
    expect(out.truncated).toBeUndefined();
    expect(out.hits.map((h) => h.seq).sort()).toHaveLength(2);
  });

  test("a kind filter that matches nothing answers empty and unflagged", async () => {
    const out = await hxSessionSearch(db, { scope: SCOPE, query: WORD, kinds: ["assistant_text"] }, { rankPool: 3 });
    expect(out).toEqual({ hits: [] });
  });

  test("a wide read runs with an exact-bitmap work_mem, read-ahead and the longer bound, inside its transaction only", async () => {
    const inside = await withWideReadBound(db, async (bdb) => {
      const rows = (await bdb.execute(
        sql`SELECT current_setting('work_mem') AS wm, current_setting('statement_timeout') AS st, current_setting('plan_cache_mode') AS pc, current_setting('effective_io_concurrency') AS eic`,
      )) as unknown as Array<{ wm: string; st: string; pc: string; eic: string }>;
      return rows[0];
    });
    expect(inside.wm).toBe("128MB");
    expect(inside.st).toBe("45s");
    expect(inside.pc).toBe("force_custom_plan");
    // A Postgres without posix_fadvise refuses read-ahead and keeps 0; this one takes it.
    expect(["128", "0"]).toContain(inside.eic);

    const after = (await db.execute(sql`SELECT current_setting('work_mem') AS wm`)) as unknown as Array<{ wm: string }>;
    expect(after[0].wm).not.toBe("128MB");
  });
});
