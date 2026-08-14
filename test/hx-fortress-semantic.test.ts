import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createHxDb, type HxDb } from "../src/host/postgres/db";
import { runMigrations } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";
import { makeMigrationExec } from "../src/host/postgres/sql-exec";
import { ingestCommit, type IngestAttribution } from "../src/ingest/ingest";
import {
  createEmbedWorker,
  createOpenAIEmbedder,
  type Embedder,
  type EmbedPassResult,
} from "../src/modules/embed-worker";
import { hxSemanticSearch } from "../src/query/semantic-search";

// FORTRESS SEMANTIC slice (§13-A3 embed worker · §13-A7 embeddings mechanics ·
// §13-A4 hx_semantic_search) — proven end-to-end against a real pgvector PG.
//
// Two suites, both driving the SAME real machinery (the anti-join embed pass,
// the HNSW `<=>` query, scope-gating, replace-orphan delete, degrade) — only the
// embedder (an injected dependency) differs:
//
//   • "deterministic" (gated on FORTRESS_DATABASE_URL): a topic-orthogonal fake
//     embedder, so the slice's logic + ranking are proven with ZERO OpenAI spend
//     and no flakiness — this is the always-runnable proof.
//   • "OpenAI live" (gated on FORTRESS_DATABASE_URL + FORTRESS_OPENAI_API_KEY):
//     the real text-embedding-3-large@1024 model, proving the live integration.
//     Bounded spend: 9 tiny turns embedded once + 2 query embeds = 11 texts.
//
//   FORTRESS_DATABASE_URL=postgres://forge:forge@localhost:5499/hx-db \
//   [FORTRESS_OPENAI_API_KEY=…] bun test test/hx-fortress-semantic.test.ts
const DSN = process.env.FORTRESS_DATABASE_URL;
const OPENAI_KEY = process.env.FORTRESS_OPENAI_API_KEY;

const ATTR: IngestAttribution = {
  orgExternalId: null,
  projectExternalId: null,
  repoSlug: null,
  deviceId: null,
};
const FAMILY = "claude-cli";
const TS = "2026-06-30T10:00:00Z";

function userTurn(text: string): string {
  return JSON.stringify({ type: "user", timestamp: TS, message: { content: [{ type: "text", text }] } });
}
function asstTurn(text: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: TS,
    message: { model: "claude-opus-4-8", content: [{ type: "text", text }], usage: { input_tokens: 5, output_tokens: 5 } },
  });
}
// An assistant turn that ALSO emits a tool_use, then its tool_result — both are
// classified turns but NON-conversational, so the embed gate must skip them.
function asstWithToolTurn(text: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: TS,
    message: {
      model: "claude-opus-4-8",
      content: [{ type: "text", text }, { type: "tool_use", id: "tu_e", name: "Bash", input: { command: "echo hi" } }],
      usage: { input_tokens: 5, output_tokens: 5 },
    },
  });
}
function toolResultTurn(): string {
  return JSON.stringify({
    type: "user",
    timestamp: TS,
    message: { content: [{ type: "tool_result", tool_use_id: "tu_e", content: "hi", is_error: false }] },
  });
}

// 3 tiny sessions, distinct topics, ≤15 words/turn. 3 conversational turns each
// (= 9 embeddable) + astronomy carries a tool_use/tool_result pair (not embedded).
const CHUNK_DB = [
  userTurn("How can I speed up a slow PostgreSQL database query?"),
  asstTurn("Add an index on the filtered column and analyze the table."),
  userTurn("Will a composite index help my multi-column WHERE clause?"),
].join("\n");
const CHUNK_COOK = [
  userTurn("What is the secret to a crispy sourdough bread crust?"),
  asstTurn("Bake with steam early then high oven heat to finish."),
  userTurn("Should I score the dough before baking it?"),
].join("\n");
const CHUNK_ASTRO = [
  userTurn("What happens to light near a black hole in space?"),
  asstWithToolTurn("Let me check the gravity near the event horizon."),
  toolResultTurn(),
  userTurn("Can anything escape past the event horizon of a black hole?"),
].join("\n");

const DB_QUERY = "optimize a slow sql query performance";
const COOK_QUERY = "tips for baking crusty bread at home";

// Deterministic, topic-orthogonal embedder: one-hot on a topic axis so cosine
// distance is 0 within a topic and 1 across — proves ranking without OpenAI.
function topicAxis(text: string): number {
  const s = text.toLowerCase();
  if (/\b(database|query|queries|index|indexes|postgres|postgresql|sql|column|table|where)\b/.test(s)) return 0;
  if (/\b(bread|sourdough|bake|baking|dough|crust|crispy|crusty|oven|flour)\b/.test(s)) return 1;
  if (/(black hole|\blight\b|\bspace\b|horizon|escape|gravity|spacetime|\bstar\b)/.test(s)) return 2;
  return 3;
}
function oneHot(texts: string[]): number[][] {
  return texts.map((t) => {
    const v = new Array<number>(1024).fill(0);
    v[topicAxis(t)] = 1;
    return v;
  });
}
const fakeEmbedder: Embedder = { model: "fake-topic-1hot", dimensions: 1024, async embed(texts) { return oneHot(texts); } };
// A distinct-model embedder used ONLY to pre-embed pre-existing residue, so the
// metered pass embeds exactly our corpus on a shared dev DB (the worker's
// anti-join is intentionally GLOBAL). Its rows are deleted by model tag in
// afterAll — they never collide with a suite's real corpus embeddings.
const DRAIN_MODEL = "test-residue-drain";
const drainEmbedder: Embedder = { model: DRAIN_MODEL, dimensions: 1024, async embed(texts) { return oneHot(texts); } };

interface SuiteOptions {
  label: string;
  enabled: boolean;
  base: Embedder;
}

function defineSemanticSuite({ label, enabled, base }: SuiteOptions): void {
  describe.if(enabled)(label, () => {
    const dsn = DSN as string;
    const sqlx = makeMigrationExec(dsn);
    const suffix = `${label.replace(/\W+/g, "")}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const USER = `user-${suffix}`;
    const SID_DB = `${suffix}-databases`;
    const SID_COOK = `${suffix}-cooking`;
    const SID_ASTRO = `${suffix}-astronomy`;
    const FULL_SCOPE = {
      identities: [SID_DB, SID_COOK, SID_ASTRO].map((sessionId) => ({ userExternalId: USER, family: FAMILY, sessionId })),
    };
    const CORPUS = new Set([SID_DB, SID_COOK, SID_ASTRO]);

    // Count exactly how many texts hit the embedder (= OpenAI spend in the live suite).
    let embedTexts = 0;
    const embedder: Embedder = {
      model: base.model,
      dimensions: base.dimensions,
      async embed(texts) {
        embedTexts += texts.length;
        return base.embed(texts);
      },
    };
    const worker = createEmbedWorker({ dsn, embedder });
    let db: HxDb;
    let pass1: EmbedPassResult;

    const ARR = `ARRAY['${SID_DB}','${SID_COOK}','${SID_ASTRO}']`;
    const corpusTurns = `(SELECT id FROM hx.turns WHERE session_id IN (SELECT id FROM hx.sessions WHERE session_id = ANY(${ARR})))`;

    const cleanup = async (): Promise<void> => {
      for (const sid of CORPUS) {
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
      // Spend guard: pre-embed any residue (the worker's anti-join is global) so
      // the metered pass below embeds ONLY our corpus — keeps OpenAI spend at
      // exactly 9 turns regardless of what this shared dev DB already holds.
      const drain = createEmbedWorker({ dsn, embedder: drainEmbedder, maxPerPass: 1_000_000 });
      await drain.runOnce();
      await drain.stop();

      const baseInput = { attribution: ATTR, totalBytes: 256, componentCount: 1, replace: false as const, chunkId: "c1" };
      await ingestCommit(db, { ingestChannel: "tunnel", ...baseInput, key: { userId: USER, family: FAMILY, sessionId: SID_DB }, chunkText: CHUNK_DB, meta: { title: "DB" } });
      await ingestCommit(db, { ingestChannel: "tunnel", ...baseInput, key: { userId: USER, family: FAMILY, sessionId: SID_COOK }, chunkText: CHUNK_COOK, meta: { title: "Cook" } });
      await ingestCommit(db, { ingestChannel: "tunnel", ...baseInput, key: { userId: USER, family: FAMILY, sessionId: SID_ASTRO }, chunkText: CHUNK_ASTRO, meta: { title: "Astro" } });
      pass1 = await worker.runOnce(); // run the embed worker exactly once
    }, 120_000);

    afterAll(async () => {
      await worker.stop();
      if (!DSN) return;
      await cleanup();
      await sqlx.exec(`DELETE FROM hx.embeddings WHERE model = '${DRAIN_MODEL}'`);
    });

    test("(a) one embedding per conversational turn, ZERO for tool_use/tool_result", async () => {
      expect(pass1.claimed).toBe(9);
      expect(pass1.openaiTexts).toBe(9);
      expect(pass1.written).toBe(9);

      const [{ n: total }] = await sqlx.query<{ n: number }>(
        `SELECT count(*)::int n FROM hx.embeddings WHERE owner_kind = 'turn' AND owner_id IN ${corpusTurns}`,
      );
      expect(Number(total)).toBe(9);

      const [{ n: nonConv }] = await sqlx.query<{ n: number }>(
        `SELECT count(*)::int n FROM hx.embeddings e JOIN hx.turns t ON t.id = e.owner_id WHERE t.session_id IN (SELECT id FROM hx.sessions WHERE session_id = ANY(${ARR})) AND t.kind NOT IN ('user_text','assistant_text')`,
      );
      expect(Number(nonConv)).toBe(0);

      // Stored at the column width (1024) — proves the Matryoshka `dimensions` param.
      const [{ d: dims }] = await sqlx.query<{ d: number }>(
        `SELECT vector_dims(embedding) d FROM hx.embeddings e JOIN hx.turns t ON t.id = e.owner_id WHERE t.session_id IN (SELECT id FROM hx.sessions WHERE session_id = '${SID_DB}') LIMIT 1`,
      );
      expect(Number(dims)).toBe(1024);
    });

    test("(b) semantic search ranks the topically-matching session first, scope-gated", async () => {
      const q1 = await hxSemanticSearch(db, embedder, { scope: FULL_SCOPE, queryText: DB_QUERY, k: 10 });
      expect(q1.unavailable).toBeUndefined();
      expect(q1.hits.length).toBeGreaterThan(0);
      expect(q1.hits.every((h) => CORPUS.has(h.sessionId))).toBe(true); // no leak
      expect(q1.hits[0].sessionId).toBe(SID_DB);

      const q2 = await hxSemanticSearch(db, embedder, { scope: FULL_SCOPE, queryText: COOK_QUERY, k: 10 });
      expect(q2.hits[0].sessionId).toBe(SID_COOK);
      expect(q2.hits[0].sessionId).not.toBe(q1.hits[0].sessionId);
    });

    test("(c) re-running the worker embeds nothing new (anti-join / content_hash idempotency)", async () => {
      const before = embedTexts;
      const pass2 = await worker.runOnce();
      expect(pass2.claimed).toBe(0);
      expect(pass2.openaiTexts).toBe(0);
      expect(embedTexts).toBe(before); // no extra embed calls

      const [{ n }] = await sqlx.query<{ n: number }>(
        `SELECT count(*)::int n FROM hx.embeddings WHERE owner_kind = 'turn' AND owner_id IN ${corpusTurns}`,
      );
      expect(Number(n)).toBe(9);
    });

    test("(d) a replace re-ingest leaves no orphaned embeddings (A7 in-txn delete)", async () => {
      await ingestCommit(db, {
        ingestChannel: "tunnel",
        attribution: ATTR,
        key: { userId: USER, family: FAMILY, sessionId: SID_DB },
        chunkId: "c2",
        replace: true,
        chunkText: CHUNK_DB,
        totalBytes: 256,
        componentCount: 1,
        meta: { title: "DB v2" },
      });
      const [{ n: orphan }] = await sqlx.query<{ n: number }>(
        `SELECT count(*)::int n FROM hx.embeddings e LEFT JOIN hx.turns t ON t.id = e.owner_id WHERE e.owner_kind = 'turn' AND t.id IS NULL`,
      );
      expect(Number(orphan)).toBe(0);
      const [{ n: left }] = await sqlx.query<{ n: number }>(
        `SELECT count(*)::int n FROM hx.embeddings WHERE owner_id IN (SELECT id FROM hx.turns WHERE session_id IN (SELECT id FROM hx.sessions WHERE session_id = '${SID_DB}'))`,
      );
      expect(Number(left)).toBe(0); // old vectors hard-deleted, awaiting re-embed
    });

    test("(e) fail-fast: no embedder ⇒ unavailable(openai_credential_missing), NO silent keyword", async () => {
      const noKey = await hxSemanticSearch(db, null, { scope: FULL_SCOPE, queryText: "PostgreSQL index", k: 10 });
      expect(noKey.unavailable?.reason).toBe("openai_credential_missing");
      expect(noKey.hits.length).toBe(0);
      expect((noKey as { degraded?: unknown }).degraded).toBeUndefined(); // no silent keyword swap
    });

    test("(f) embedding spend stayed bounded: 9 turns + 2 queries = 11 texts", () => {
      expect(embedTexts).toBe(11);
    });
  });
}

// Always-runnable deterministic proof (no OpenAI).
defineSemanticSuite({ label: "hx-fortress semantic — deterministic (A3/A4/A7)", enabled: !!DSN, base: fakeEmbedder });

// Live OpenAI integration proof (text-embedding-3-large@1024).
defineSemanticSuite({
  label: "hx-fortress semantic — OpenAI live (A3/A4/A7)",
  enabled: !!DSN && !!OPENAI_KEY,
  base: OPENAI_KEY
    ? createOpenAIEmbedder({ apiKey: OPENAI_KEY, model: "text-embedding-3-large", dimensions: 1024 })
    : fakeEmbedder,
});
