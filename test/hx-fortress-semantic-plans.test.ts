import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { createHxDb, type HxDb } from "../src/host/postgres/db";
import { runMigrations } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";
import { makeMigrationExec } from "../src/host/postgres/sql-exec";
import { ingestCommit, type IngestAttribution } from "../src/ingest/ingest";
import type { Embedder } from "../src/modules/embed-worker";
import {
  hxSemanticSearch,
  nearestCandidatesSql,
  type SemanticPlan,
  type SemanticSearchInput,
  type SemanticSearchResult,
  type SemanticSearchTuning,
} from "../src/query/semantic-search";

// hx_semantic_search's three plans (exact over the scope, exact over a narrow
// window, nearest first) must return the SAME hits for the same question — they
// differ only in what they read to find them. Each test reaches a plan with a
// small tuning and compares it with the others.
//
// The corpus puts out-of-scope turns NEARER the query than every in-scope one,
// so the nearest-first plan only finds the in-scope turns after widening its
// candidate pool, and any scope leak would show up as an out-of-scope hit.
//
//   FORTRESS_DATABASE_URL=postgres://forge:forge@localhost:5499/hx-db \
//     bun test test/hx-fortress-semantic-plans.test.ts
const DSN = process.env.FORTRESS_DATABASE_URL;

const ATTR: IngestAttribution = { orgExternalId: null, projectExternalId: null, repoSlug: null, deviceId: null };
const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const USER_IN = `user-plans-in-${SUFFIX}`;
const USER_OUT = `user-plans-out-${SUFFIX}`;
const IN_A = `plans-in-a-${SUFFIX}`; // claude-cli, 2026-06-30
const IN_B = `plans-in-b-${SUFFIX}`; // codex-cli, 2026-07-02
const OUT_A = `plans-out-a-${SUFFIX}`;
const MODEL = "test-plans-angle";

// A vector at `angle` degrees in a plane of its own (axes 500/501), so the
// one-hot vectors other suites leave in a shared database (axes 0-3) stay at
// distance 1 from every query here and never crowd these candidates out.
// Cosine distance to the query (angle 0) is 1 - cos(angle): smaller angle, nearer.
function angleVector(text: string): number[] {
  const v = new Array<number>(1024).fill(0);
  const m = /angle:(\d+)/.exec(text);
  if (!m) {
    v[502] = 1;
    return v;
  }
  const rad = (Number(m[1]) * Math.PI) / 180;
  v[500] = Math.cos(rad);
  v[501] = Math.sin(rad);
  return v;
}
const embedder: Embedder = {
  model: MODEL,
  dimensions: 1024,
  async embed(texts) {
    return texts.map(angleVector);
  },
};

function userTurn(text: string, ts: string): string {
  return JSON.stringify({ type: "user", timestamp: ts, message: { content: [{ type: "text", text }] } });
}
function asstTurn(text: string, ts: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message: { model: "claude-opus-4-8", content: [{ type: "text", text }], usage: { input_tokens: 5, output_tokens: 5 } },
  });
}

const IN_SCOPE = {
  identities: [
    { userExternalId: USER_IN, family: "claude-cli", sessionId: IN_A },
    { userExternalId: USER_IN, family: "codex-cli", sessionId: IN_B },
  ],
};
const QUERY = "angle:0";

// Small enough that the nearest-first plan has to widen (6 out-of-scope turns
// rank ahead of the first in-scope one), and that the exact plans are reachable.
const NEAREST_FIRST: SemanticSearchTuning = { exactScopeMaxTurns: -1, exactWindowMaxTurns: -1, minCandidates: 2, maxCandidates: 64 };
const EXACT_WINDOW: SemanticSearchTuning = { exactScopeMaxTurns: -1, exactWindowMaxTurns: 10_000 };

async function run(
  db: HxDb,
  input: Partial<SemanticSearchInput>,
  tuning: SemanticSearchTuning = {},
): Promise<{ plan: SemanticPlan | null; result: SemanticSearchResult }> {
  let plan: SemanticPlan | null = null;
  const result = await hxSemanticSearch(db, embedder, { scope: IN_SCOPE, queryText: QUERY, ...input }, tuning, (p) => {
    plan = p;
  });
  return { plan, result };
}

/** What a hit is, minus the float noise the two distance spellings may differ by. */
function shape(result: SemanticSearchResult): Array<{ sessionId: string; snippet: string; distance: string }> {
  return result.hits.map((h) => ({ sessionId: h.sessionId, snippet: h.snippet, distance: Number(h.distance).toFixed(6) }));
}

describe.if(!!DSN)("hx_semantic_search plans — exact, exact window, nearest first", () => {
  const dsn = DSN as string;
  const sqlx = makeMigrationExec(dsn);
  let db: HxDb;

  const cleanup = async (): Promise<void> => {
    for (const sid of [IN_A, IN_B, OUT_A]) {
      // Polymorphic owner ⇒ no FK cascade onto embeddings: delete them first.
      await sqlx.exec(
        `DELETE FROM hx.embeddings WHERE owner_id IN (SELECT id FROM hx.turns WHERE session_id IN (SELECT id FROM hx.sessions WHERE session_id = '${sid}'))`,
      );
      await sqlx.exec(`DELETE FROM hx.ingest_events WHERE session_id_ext = '${sid}'`);
      await sqlx.exec(`DELETE FROM hx.sessions WHERE session_id = '${sid}'`);
    }
  };

  beforeAll(async () => {
    await runMigrations(sqlx, migrations);
    await cleanup();
    db = createHxDb(dsn);
    const commit = (userId: string, family: string, sessionId: string, chunkText: string) =>
      ingestCommit(db, {
        ingestChannel: "tunnel",
        attribution: ATTR,
        key: { userId, family, sessionId },
        chunkId: "c1",
        chunkText,
        totalBytes: chunkText.length,
        componentCount: 1,
        replace: false,
        meta: null,
      });
    await commit(
      USER_IN,
      "claude-cli",
      IN_A,
      [userTurn("angle:10 the first in-scope turn", "2026-06-30T10:00:00Z"), asstTurn("angle:20 the third in-scope turn", "2026-06-30T10:01:00Z")].join("\n"),
    );
    await commit(USER_IN, "codex-cli", IN_B, userTurn("angle:15 the second in-scope turn", "2026-07-02T10:00:00Z"));
    await commit(
      USER_OUT,
      "claude-cli",
      OUT_A,
      [1, 2, 3, 4, 5, 6].map((a) => userTurn(`angle:${a} an out-of-scope turn`, "2026-06-30T09:00:00Z")).join("\n"),
    );
    // Vectors written directly, so no embed worker (whose claim is global) runs
    // over whatever else a shared database holds.
    const turns = await sqlx.query<{ id: string; text: string }>(
      `SELECT t.id, t.text FROM hx.turns t JOIN hx.sessions s ON s.id = t.session_id
       WHERE s.session_id IN ('${IN_A}','${IN_B}','${OUT_A}') AND t.kind IN ('user_text','assistant_text')`,
    );
    expect(turns.length).toBe(9);
    for (const t of turns) {
      await sqlx.exec(
        `INSERT INTO hx.embeddings (owner_kind, owner_id, model, dim, embedding)
         VALUES ('turn', '${t.id}', '${MODEL}', 1024, '[${angleVector(t.text).join(",")}]')`,
      );
    }
  }, 120_000);

  afterAll(async () => {
    await cleanup();
  });

  test("all three plans return the same hits, nearest first, and none out of scope", async () => {
    const exact = await run(db, { k: 3 });
    expect(exact.plan).toBe("exact_scope");
    expect(exact.result.unavailable).toBeUndefined();
    expect(exact.result.hits.map((h) => h.snippet)).toEqual([
      "angle:10 the first in-scope turn",
      "angle:15 the second in-scope turn",
      "angle:20 the third in-scope turn",
    ]);
    expect(exact.result.hits.map((h) => h.sessionId)).toEqual([IN_A, IN_B, IN_A]);

    // The six out-of-scope turns are nearer than every in-scope one, so a pool of
    // 2 holds none of the scope's: the plan has to widen to find the three.
    const nearest = await run(db, { k: 3 }, NEAREST_FIRST);
    expect(nearest.plan).toBe("nearest_first");
    expect(shape(nearest.result)).toEqual(shape(exact.result));

    const window = await run(db, { k: 3, fromDate: "2026-06-29", toDate: "2026-07-03" }, EXACT_WINDOW);
    expect(window.plan).toBe("exact_window");
    expect(shape(window.result)).toEqual(shape(exact.result));
  });

  test("an index with fewer in-scope turns than k returns what it holds", async () => {
    const nearest = await run(db, { k: 10 }, NEAREST_FIRST);
    expect(nearest.plan).toBe("nearest_first");
    expect(nearest.result.hits.map((h) => h.sessionId).sort()).toEqual([IN_A, IN_A, IN_B].sort());
  });

  test("the family filter applies on every plan", async () => {
    for (const tuning of [{}, NEAREST_FIRST]) {
      const { result } = await run(db, { k: 5, family: "codex-cli" }, tuning);
      expect(result.hits.map((h) => h.sessionId)).toEqual([IN_B]);
    }
  });

  test("the date window applies on every plan", async () => {
    for (const tuning of [{}, NEAREST_FIRST, EXACT_WINDOW]) {
      const { result } = await run(db, { k: 5, fromDate: "2026-07-01", timezone: "UTC" }, tuning);
      expect(result.hits.map((h) => h.snippet)).toEqual(["angle:15 the second in-scope turn"]);
    }
  });

  test("an empty scope matches nothing on every plan", async () => {
    for (const tuning of [{}, NEAREST_FIRST]) {
      const result = await hxSemanticSearch(db, embedder, { scope: { identities: [] }, queryText: QUERY, k: 5 }, tuning);
      expect(result.unavailable).toBeUndefined();
      expect(result.hits).toEqual([]);
    }
  });

  test("the HNSW index answers the nearest-first candidate statement", async () => {
    // A table this small is cheaper to read whole, so the planner is told not to;
    // what is checked is that the statement is one the index CAN answer — the
    // shape a rewrite into a scope join would lose.
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
      await tx.execute(sql`SET LOCAL enable_sort = off`);
      return tx.execute(sql`EXPLAIN (FORMAT JSON) ${nearestCandidatesSql(`[${angleVector(QUERY).join(",")}]`, 50)}`);
    });
    expect(JSON.stringify(plan)).toContain("hx_embeddings_hnsw_idx");
  });

  test("a soft-deleted turn is never returned", async () => {
    await sqlx.exec(
      `UPDATE hx.turns SET deleted_at = now() WHERE text = 'angle:10 the first in-scope turn' AND session_id IN (SELECT id FROM hx.sessions WHERE session_id = '${IN_A}')`,
    );
    for (const tuning of [{}, NEAREST_FIRST, EXACT_WINDOW]) {
      const { result } = await run(db, { k: 5, fromDate: "2026-06-29" }, tuning);
      expect(result.hits.map((h) => h.snippet)).toEqual([
        "angle:15 the second in-scope turn",
        "angle:20 the third in-scope turn",
      ]);
    }
  });
});
