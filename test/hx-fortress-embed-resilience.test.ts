import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createHxDb, type HxDb } from "../src/host/postgres/db";
import { runMigrations } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";
import { makeMigrationExec } from "../src/host/postgres/sql-exec";
import { ingestCommit, type IngestAttribution } from "../src/ingest/ingest";
import {
  createEmbedWorker,
  createOpenAIEmbedder,
  EmbedAccountError,
  type Embedder,
} from "../src/modules/embed-worker";

// FORTRESS EMBED RESILIENCE (§13-A3) — the poison-input + drain + dead-letter
// guarantees that keep one bad turn from permanently halting all embedding.
//
//   • openai.ts isolation (always-on, no DB, no OpenAI): an injected fetch proves
//     a length-400 on one input never throws the batch — it splits/shrinks to
//     isolate the offender and maps a truly-unembeddable input to null, while an
//     account-level error (quota/auth) DOES throw (pass-fatal).
//   • worker drain + dead-letter (gated on FORTRESS_DATABASE_URL, fake embedder,
//     ZERO OpenAI spend): a backlog larger than one pass drains to completion,
//     and a persistently-failing turn is dead-lettered so the rest still index.

const DSN = process.env.FORTRESS_DATABASE_URL;

// ── openai.ts input isolation (always runnable) ──────────────────────────────

const DIMS = 8;
function okBody(inputs: string[]): Response {
  const data = inputs.map((_, i) => ({ index: i, embedding: new Array(DIMS).fill(0.1) }));
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
}
function errBody(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), { status });
}

/** A fake OpenAI endpoint: 400s a request whose batch contains an input matching
 *  `is400`, else 200 with one vector per input. Tracks the request count. */
function fakeFetch(is400: (input: string) => boolean): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as { input: string[] };
    const bad = body.input.some(is400);
    return bad
      ? errBody(400, "This model's maximum context length is 8192 tokens, however you requested too many tokens")
      : okBody(body.input);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

describe("hx-fortress embed — openai input isolation (A3 poison pill)", () => {
  test("one over-length input is isolated; the rest of the batch still embeds", async () => {
    // 400 any request carrying an input longer than 6000 chars.
    const { fetchImpl } = fakeFetch((s) => s.length > 6000);
    const embedder = createOpenAIEmbedder({ apiKey: "test", dimensions: DIMS, maxChars: 24_000, fetchImpl });
    const big = "a".repeat(20_000); // shrinks 20k→10k→5k (<6000) and then embeds
    const out = await embedder.embed(["short one", big, "short two"]);
    expect(out.length).toBe(3);
    expect(out[0]).not.toBeNull();
    expect(out[1]).not.toBeNull(); // recovered via shrink, NOT dropped
    expect(out[2]).not.toBeNull();
    expect(out.every((v) => v !== null && v!.length === DIMS)).toBe(true);
  });

  test("a truly unembeddable input maps to null (dead-letter), neighbours unaffected", async () => {
    // 400 forever for any input still containing the poison marker (front-anchored
    // so shrinking can't remove it) — proves the floor → null path.
    const { fetchImpl } = fakeFetch((s) => s.includes("POISONPILL"));
    const embedder = createOpenAIEmbedder({ apiKey: "test", dimensions: DIMS, maxChars: 24_000, fetchImpl });
    const poison = "POISONPILL" + "x".repeat(2000);
    const out = await embedder.embed(["good a", poison, "good b"]);
    expect(out.length).toBe(3);
    expect(out[0]).not.toBeNull();
    expect(out[1]).toBeNull(); // isolated + dead-lettered
    expect(out[2]).not.toBeNull();
  });

  test("insufficient_quota (429) THROWS EmbedAccountError — pass-fatal, not a per-input drop", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: "You exceeded your current quota", code: "insufficient_quota" } }), { status: 429 })) as unknown as typeof fetch;
    const embedder = createOpenAIEmbedder({ apiKey: "test", dimensions: DIMS, fetchImpl, maxRetries: 0 });
    await expect(embedder.embed(["anything"])).rejects.toBeInstanceOf(EmbedAccountError);
  });

  test("a bad key (401) THROWS EmbedAccountError", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: "Incorrect API key" } }), { status: 401 })) as unknown as typeof fetch;
    const embedder = createOpenAIEmbedder({ apiKey: "bad", dimensions: DIMS, fetchImpl });
    await expect(embedder.embed(["anything"])).rejects.toBeInstanceOf(EmbedAccountError);
  });

  test("a transient 503 (after retries) THROWS — pass aborts + retries, NOT a per-input dead-letter", async () => {
    // A 5xx is transient/global, not input-specific: it must reject so the worker
    // retries the whole pass next time, never silently drop good turns as poison.
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: "service unavailable" } }), { status: 503 })) as unknown as typeof fetch;
    const embedder = createOpenAIEmbedder({ apiKey: "test", dimensions: DIMS, fetchImpl, maxRetries: 0 });
    await expect(embedder.embed(["a", "b", "c"])).rejects.toThrow();
  });

  test("a 404 (bad base url / model) THROWS — global config error, not per-input dead-letter", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 404 })) as unknown as typeof fetch;
    const embedder = createOpenAIEmbedder({ apiKey: "test", dimensions: DIMS, fetchImpl });
    await expect(embedder.embed(["x"])).rejects.toThrow();
  });
});

// ── MC-2517 · query-path per-attempt timeout (no DB, no OpenAI) ───────────────
// The root cause of MC-2517: a query-time embed hung on a stalled OpenAI socket
// until the workbench killed it at 30s. The QUERY-path embedder now sets a
// per-attempt timeout so a hung request fails fast (typed) after a bounded retry,
// while the background worker (no timeoutMs) keeps its prior unbounded behavior.

/** A fake OpenAI endpoint that HANGS until its per-attempt AbortSignal fires —
 *  unless `succeedFromAttempt` is set and this call is at/after it (then 200). */
function hangingFetch(opts: { succeedFromAttempt?: number } = {}): {
  fetchImpl: typeof fetch;
  calls: () => number;
} {
  let calls = 0;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    if (opts.succeedFromAttempt && calls >= opts.succeedFromAttempt) {
      return okBody((JSON.parse(String(init?.body ?? "{}")) as { input: string[] }).input);
    }
    const signal = init?.signal;
    // Never resolve on its own — only the caller's AbortSignal.timeout ends it,
    // exactly like a stalled OpenAI connection (TCP open, no bytes).
    return await new Promise<Response>((_resolve, reject) => {
      const abort = (): void =>
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

describe("hx-fortress embed — MC-2517 query-path timeout (A3)", () => {
  test("a bounded embedder times out a hung request, retries, then throws a timeout error", async () => {
    const { fetchImpl, calls } = hangingFetch(); // never succeeds → always aborts
    const embedder = createOpenAIEmbedder({ apiKey: "test", dimensions: DIMS, fetchImpl, timeoutMs: 20, maxRetries: 1 });
    await expect(embedder.embed(["where is my search session"])).rejects.toThrow(/timed out/i);
    expect(calls()).toBe(2); // 1 initial attempt + 1 retry, then throw (bounded)
  }, 10_000);

  test("a bounded embedder recovers when a transient hang clears on retry", async () => {
    const { fetchImpl, calls } = hangingFetch({ succeedFromAttempt: 2 }); // attempt 1 hangs, 2 ok
    const embedder = createOpenAIEmbedder({ apiKey: "test", dimensions: DIMS, fetchImpl, timeoutMs: 20, maxRetries: 2 });
    const out = await embedder.embed(["where is my search session"]);
    expect(out[0]).not.toBeNull();
    expect(out[0]!.length).toBe(DIMS);
    expect(calls()).toBe(2); // hung once, succeeded on the retry
  }, 10_000);

  test("the UNBOUNDED worker embedder attaches no timeout signal; the bounded query path does", async () => {
    // A mutable holder (not a `let`) so TS keeps the boolean type at the assertion
    // rather than narrowing it to the initial value across the fetch callback.
    const saw: { signal?: boolean } = {};
    const recordingFetch = (async (_u: string | URL | Request, init?: RequestInit) => {
      saw.signal = init?.signal != null;
      return okBody((JSON.parse(String(init?.body ?? "{}")) as { input: string[] }).input);
    }) as unknown as typeof fetch;

    await createOpenAIEmbedder({ apiKey: "test", dimensions: DIMS, fetchImpl: recordingFetch }).embed(["x"]);
    expect(saw.signal).toBe(false); // worker path: no AbortSignal (behavior preserved)

    await createOpenAIEmbedder({ apiKey: "test", dimensions: DIMS, fetchImpl: recordingFetch, timeoutMs: 5_000 }).embed(["x"]);
    expect(saw.signal).toBe(true); // query path: bounded by an AbortSignal
  });
});

// ── worker drain + dead-letter (DB, no OpenAI) ───────────────────────────────

const ATTR: IngestAttribution = { orgExternalId: null, projectExternalId: null, repoSlug: null, deviceId: null };
const FAMILY = "claude-cli";
const TS = "2026-06-30T10:00:00Z";
function userTurn(text: string): string {
  return JSON.stringify({ type: "user", timestamp: TS, message: { content: [{ type: "text", text }] } });
}
function asstTurn(text: string): string {
  return JSON.stringify({ type: "assistant", timestamp: TS, message: { model: "claude-opus-4-8", content: [{ type: "text", text }], usage: { input_tokens: 5, output_tokens: 5 } } });
}
function oneHot(texts: string[]): (number[] | null)[] {
  return texts.map((t) => {
    if (t.includes("POISONPILL")) return null; // simulate an unembeddable input
    const v = new Array<number>(1024).fill(0); // must match the vector(1024) column
    v[0] = 1;
    return v;
  });
}

describe.if(!!DSN)("hx-fortress embed — worker drain + dead-letter (A3)", () => {
  const dsn = DSN as string;
  const sqlx = makeMigrationExec(dsn);
  const suffix = `resilience-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const USER = `user-${suffix}`;
  const SID_DRAIN = `${suffix}-drain`;
  const SID_DL = `${suffix}-deadletter`;
  let db: HxDb;

  const fakeEmbedder: Embedder = { model: `fake-resilience-${suffix}`, dimensions: 1024, async embed(texts) { return oneHot(texts); } };

  const turnsOf = (sid: string) =>
    `(SELECT id FROM hx.turns WHERE session_id IN (SELECT id FROM hx.sessions WHERE session_id = '${sid}'))`;
  const embedCount = async (sid: string): Promise<number> => {
    const [{ n }] = await sqlx.query<{ n: number }>(
      `SELECT count(*)::int n FROM hx.embeddings WHERE owner_kind = 'turn' AND owner_id IN ${turnsOf(sid)}`,
    );
    return Number(n);
  };
  const cleanup = async (): Promise<void> => {
    for (const sid of [SID_DRAIN, SID_DL]) {
      await sqlx.exec(`DELETE FROM hx.embeddings WHERE owner_id IN ${turnsOf(sid)}`);
      await sqlx.exec(`DELETE FROM hx.ingest_events WHERE session_id_ext = '${sid}'`);
      await sqlx.exec(`DELETE FROM hx.sessions WHERE session_id = '${sid}'`);
    }
  };

  beforeAll(async () => {
    await runMigrations(sqlx, migrations);
    await cleanup();
    db = createHxDb(dsn);
    const base = { attribution: ATTR, totalBytes: 256, componentCount: 1, replace: false as const, chunkId: "c1" };
    // 12 conversational turns in one session — more than the small maxPerPass below.
    const drainTurns: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      drainTurns.push(userTurn(`drain question number ${i} about indexing`));
      drainTurns.push(asstTurn(`drain answer number ${i} add an index`));
    }
    await ingestCommit(db, { ingestChannel: "tunnel", ...base, key: { userId: USER, family: FAMILY, sessionId: SID_DRAIN }, chunkText: drainTurns.join("\n"), meta: { title: "Drain" } });
    // 1 poison + 2 good turns.
    await ingestCommit(db, {
      ingestChannel: "tunnel",
      ...base,
      key: { userId: USER, family: FAMILY, sessionId: SID_DL },
      chunkText: [userTurn("POISONPILL this turn cannot be embedded"), asstTurn("a good answer one"), userTurn("a good question two")].join("\n"),
      meta: { title: "DeadLetter" },
    });
  }, 120_000);

  afterAll(async () => {
    if (!DSN) return;
    await cleanup();
  });

  test("a backlog larger than one pass drains to completion (C: re-arm on full claim)", async () => {
    const total = await sqlx.query<{ n: number }>(`SELECT count(*)::int n FROM hx.turns WHERE session_id IN (SELECT id FROM hx.sessions WHERE session_id = '${SID_DRAIN}') AND kind IN ('user_text','assistant_text')`).then((r) => Number(r[0].n));
    expect(total).toBe(12);
    // maxPerPass:5 ⇒ a single pass embeds only 5; auto-drain must fire ≥3 passes.
    const worker = createEmbedWorker({ dsn, embedder: fakeEmbedder, maxPerPass: 5, debounceMs: 10, maxWaitMs: 2_000 });
    worker.start();
    let embedded = 0;
    // The worker is GLOBAL: it claims from the whole corpus, so with maxPerPass:5 a
    // sibling suite's pending turns consume passes this test used to assume were its
    // own. The wait therefore has to be generous rather than exactly-enough — 4 s was
    // sized for a database this test had to itself, which is not a property a suite
    // can rely on (CI gives one database per file, `bun test` does not).
    for (let i = 0; i < 400 && embedded < 12; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      embedded = await embedCount(SID_DRAIN);
    }
    await worker.stop();
    expect(embedded).toBe(12); // all drained, not just the first 5
  }, 30_000);

  test("a persistently-failing turn is dead-lettered; the rest still index (H1 backstop)", async () => {
    const worker = createEmbedWorker({ dsn, embedder: fakeEmbedder, maxPerPass: 100, deadLetterThreshold: 3 });
    const [{ id: poisonId }] = await sqlx.query<{ id: string }>(
      `SELECT id FROM hx.turns WHERE session_id IN (SELECT id FROM hx.sessions WHERE session_id = '${SID_DL}') AND text LIKE '%POISONPILL%' LIMIT 1`,
    );
    // Pass 1: 2 good embed, poison fails. Passes 2-3: poison keeps failing → dead-lettered.
    let sawPoisonFail = false;
    let poisonStillClaimed = true;
    for (let i = 0; i < 5; i += 1) {
      const r = await worker.runOnce();
      if (r.failedIds.includes(poisonId)) sawPoisonFail = true;
      poisonStillClaimed = r.failedIds.includes(poisonId);
    }
    await worker.stop();
    expect(await embedCount(SID_DL)).toBe(2); // the 2 good turns indexed
    // Dead-lettering is in-memory, so the observable is that the poison turn stops
    // being CLAIMED. Assert that about the turn itself: `claimed === 0` asserted
    // global quiescence, which a sibling suite's backlog makes false without saying
    // anything about this poison turn.
    expect(sawPoisonFail).toBe(true); // it did fail, repeatedly…
    expect(poisonStillClaimed).toBe(false); // …and is now excluded from the claim
  }, 30_000);

  test("stops the pass once today's OpenAI token budget is spent (M-9e)", async () => {
    // Record a spend that already exceeds a tiny budget for the current UTC day —
    // key on the SAME UTC-date expression the worker reads/upserts on.
    await sqlx.exec(
      `INSERT INTO hx.embed_budget (day, tokens) VALUES ((now() at time zone 'utc')::date, 1000000)
       ON CONFLICT (day) DO UPDATE SET tokens = 1000000`,
    );
    try {
      const worker = createEmbedWorker({ dsn, embedder: fakeEmbedder, maxPerPass: 100, dailyTokenBudget: 500_000 });
      const r = await worker.runOnce();
      await worker.stop();
      // The gate fires BEFORE the claim, so nothing is claimed (⇒ nothing
      // dead-lettered) and OpenAI is never called.
      expect(r.budgetExceeded).toBe(true);
      expect(r.claimed).toBe(0);
      expect(r.openaiTexts).toBe(0);
    } finally {
      await sqlx.exec(`DELETE FROM hx.embed_budget WHERE day = (now() at time zone 'utc')::date`);
    }
  }, 30_000);
});
