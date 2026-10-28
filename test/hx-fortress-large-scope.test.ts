import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import { createHxDb, type HxDb } from "../src/host/postgres/db";
import { runMigrations } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";
import { makeMigrationExec } from "../src/host/postgres/sql-exec";
import type { GrantClaims } from "../src/gateway/capability-token";
import { ingestCommit, type IngestAttribution } from "../src/ingest/ingest";
import { checkScopeGrant } from "../src/mcp/tools";
import { createMcpTunnelHandler } from "../src/mcp/tunnel-handler";
import type { Embedder } from "../src/modules/embed-worker";
import { hashFortressScope } from "../src/protocol";
import { hxSessionsAggregate } from "../src/query/aggregate";
import { MAX_SCOPE_IDENTITIES, scopePredicate, type FortressScope, type ScopeIdentity } from "../src/query/scope";
import { hxSessionSearch } from "../src/query/search";
import { hxSemanticSearch, type SemanticPlan } from "../src/query/semantic-search";
import { hxSessionsList } from "../src/query/sessions-list";
import { hxTextOccurrences } from "../src/query/text-occurrences";

// A scope larger than 21,845 identities is read whole. Until 0.36.0 the fortress
// kept the first 10,000 identities of every scope, and it sent each one as a
// VALUES row of three bind parameters, so a statement over more than 21,845 of
// them broke Postgres' 65,535-parameter limit. One person's own scope can hold
// more than 30,000 sessions, newest first, so every read missed the oldest two
// thirds of them.
//
// The scope here is 31,331 identities ordered newest first, as the hub sends
// them. The one session whose turn every read looks for is the OLDEST, last in
// the list, far beyond the newest 10,000.
//
//   FORTRESS_DATABASE_URL=postgres://forge:forge@localhost:5499/hx-db \
//     bun test test/hx-fortress-large-scope.test.ts
const DSN = process.env.FORTRESS_DATABASE_URL;

const SCOPE_SIZE = 31_331;
const ATTR: IngestAttribution = { orgExternalId: null, projectExternalId: null, repoSlug: null, deviceId: null };
const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const USER = `user-large-scope-${SUFFIX}`;
const OTHER_USER = `user-large-scope-other-${SUFFIX}`;
const FAMILY = "claude-cli";
const OLDEST = `large-scope-oldest-${SUFFIX}`;
const NEWEST = `large-scope-newest-${SUFFIX}`;
const FILLER_PREFIX = `large-scope-filler-${SUFFIX}-`;
// A word nothing else in a shared database holds: letters only, so the english
// text search configuration keeps it as one lexeme.
const WORD = `quokkafleet${SUFFIX.replace(/[^a-z]/g, "")}`;

// Vectors in a plane of their own (axes 600/601), at distance 1 from the vectors
// other suites leave in a shared database, so they never crowd these out.
function angleVector(text: string): number[] {
  const v = new Array<number>(1024).fill(0);
  const m = /angle:(\d+)/.exec(text);
  if (!m) {
    v[602] = 1;
    return v;
  }
  const rad = (Number(m[1]) * Math.PI) / 180;
  v[600] = Math.cos(rad);
  v[601] = Math.sin(rad);
  return v;
}
const embedder: Embedder = {
  model: "test-large-scope-angle",
  dimensions: 1024,
  async embed(texts) {
    return texts.map(angleVector);
  },
};

function userTurn(text: string, ts: string): string {
  return JSON.stringify({ type: "user", timestamp: ts, message: { content: [{ type: "text", text }] } });
}

describe.if(!!DSN)("a scope of 31,331 identities is read whole", () => {
  const dsn = DSN as string;
  const sqlx = makeMigrationExec(dsn);
  let db: HxDb;
  let identities: ScopeIdentity[] = [];
  let scope: FortressScope;

  const cleanup = async (): Promise<void> => {
    // Polymorphic owner ⇒ no FK cascade onto embeddings: delete them first.
    await sqlx.exec(
      `DELETE FROM hx.embeddings WHERE owner_id IN (SELECT t.id FROM hx.turns t JOIN hx.sessions s ON s.id = t.session_id JOIN hx.users u ON u.id = s.user_id WHERE u.external_id IN ('${USER}', '${OTHER_USER}'))`,
    );
    await sqlx.exec(`DELETE FROM hx.ingest_events WHERE session_id_ext IN ('${OLDEST}', '${NEWEST}')`);
    await sqlx.exec(`DELETE FROM hx.users WHERE external_id IN ('${USER}', '${OTHER_USER}')`);
  };

  beforeAll(async () => {
    await runMigrations(sqlx, migrations);
    await cleanup();
    db = createHxDb(dsn);
    const commit = (sessionId: string, chunkText: string) =>
      ingestCommit(db, {
        ingestChannel: "tunnel",
        attribution: ATTR,
        key: { userId: USER, family: FAMILY, sessionId },
        chunkId: "c1",
        chunkText,
        totalBytes: chunkText.length,
        componentCount: 1,
        replace: false,
        meta: { title: sessionId },
      });
    await commit(OLDEST, userTurn(`angle:5 the build broke because ${WORD} was missing`, "2025-01-15T10:00:00Z"));
    await commit(NEWEST, userTurn("angle:80 an unrelated question about deploys", new Date().toISOString()));
    // The rest of the scope: sessions with no turns, active between the two.
    await sqlx.exec(`
      INSERT INTO hx.sessions (user_id, family, session_id, first_event_at, last_activity_at)
      SELECT u.id, '${FAMILY}', '${FILLER_PREFIX}' || g,
             now() - (g || ' minutes')::interval, now() - (g || ' minutes')::interval
      FROM hx.users u, generate_series(1, ${SCOPE_SIZE - 2}) g
      WHERE u.external_id = '${USER}'`);
    const turns = await sqlx.query<{ id: string; text: string }>(
      `SELECT t.id, t.text FROM hx.turns t JOIN hx.sessions s ON s.id = t.session_id
       WHERE s.session_id IN ('${OLDEST}', '${NEWEST}') AND t.kind = 'user_text'`,
    );
    expect(turns.length).toBe(2);
    for (const t of turns) {
      await sqlx.exec(
        `INSERT INTO hx.embeddings (owner_kind, owner_id, model, dim, embedding)
         VALUES ('turn', '${t.id}', '${embedder.model}', 1024, '[${angleVector(t.text).join(",")}]')`,
      );
    }
    // Newest first, the order the hub enumerates a scope in.
    const rows = await sqlx.query<{ session_id: string }>(
      `SELECT s.session_id FROM hx.sessions s JOIN hx.users u ON u.id = s.user_id
       WHERE u.external_id = '${USER}' ORDER BY s.last_activity_at DESC, s.session_id`,
    );
    identities = rows.map((r) => ({ userExternalId: USER, family: FAMILY, sessionId: r.session_id }));
    scope = { identities, ownerGate: { activeMemberExternalIds: [USER] } };
  }, 120_000);

  afterAll(async () => {
    await cleanup();
  });

  test("the session the reads look for is the oldest, beyond the newest 10,000", () => {
    expect(identities).toHaveLength(SCOPE_SIZE);
    expect(identities[0]?.sessionId).toBe(NEWEST);
    expect(identities.findIndex((i) => i.sessionId === OLDEST)).toBe(SCOPE_SIZE - 1);
    expect(SCOPE_SIZE).toBeGreaterThan(21_845);
    expect(SCOPE_SIZE).toBeLessThanOrEqual(MAX_SCOPE_IDENTITIES);
  });

  test("the scope compiles to four bind parameters, whatever its size", () => {
    expect(new PgDialect().sqlToQuery(scopePredicate(scope)).params).toHaveLength(4);
  });

  test("keyword search finds the oldest session's turn", async () => {
    const { hits } = await hxSessionSearch(db, { scope, query: WORD });
    expect(hits.map((h) => h.sessionId)).toEqual([OLDEST]);
  });

  test("semantic search finds it on the exact plan and on the nearest-first plan", async () => {
    for (const tuning of [{}, { exactScopeMaxTurns: -1, exactWindowMaxTurns: -1 }]) {
      let plan: SemanticPlan | null = null;
      const result = await hxSemanticSearch(db, embedder, { scope, queryText: "angle:0", k: 1 }, tuning, (p) => {
        plan = p;
      });
      expect(result.unavailable).toBeUndefined();
      expect(result.hits.map((h) => h.sessionId)).toEqual([OLDEST]);
      expect(plan).not.toBeNull();
    }
  });

  test("the text count, the aggregate and the session list reach it too", async () => {
    const counted = await hxTextOccurrences(db, { scope, query: WORD });
    expect(counted.matchingSessions).toBe(1);
    expect(counted.occurrences).toBe(1);

    const aggregate = await hxSessionsAggregate(db, { scope });
    expect(aggregate.totalSessions).toBe(SCOPE_SIZE);

    const listed = await hxSessionsList(db, { scope, search: WORD });
    expect(listed.sessions.map((s) => s.sessionId)).toEqual([OLDEST]);
  });

  test("the owner gate still narrows a large scope", async () => {
    const gated: FortressScope = { identities, ownerGate: { activeMemberExternalIds: [OTHER_USER] } };
    expect((await hxSessionSearch(db, { scope: gated, query: WORD })).hits).toEqual([]);
    expect((await hxSessionsAggregate(db, { scope: gated })).totalSessions).toBe(0);
  });

  // Through the MCP entry, where parseScope applies the cap: with a grant over the
  // whole scope, and with no grant at all (a cap that cut the scope would then
  // narrow it silently instead of refusing it).
  test("over the tunnel, every identity reaches the tools, with or without a grant", async () => {
    const grant: GrantClaims = {
      v: 2,
      purpose: "read",
      org: "org_1",
      aud: "org_1",
      sub: USER,
      scopeHash: hashFortressScope(scope),
    };
    for (const granted of [true, false]) {
      const handler = createMcpTunnelHandler({
        db: () => db,
        store: () => null,
        embedder,
        ...(granted ? { verifyGrant: async () => grant } : {}),
      });
      const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
        const res = await handler.handle({
          method: "callTool",
          name,
          arguments: { scope, ...args },
          userId: USER,
          ...(granted ? { grant: "GRANT" } : {}),
        });
        if (res.method !== "callTool") throw new Error("expected a callTool result");
        expect(res.isError).toBeFalsy();
        return JSON.parse(res.content);
      };
      const search = (await call("hx_session_search", { query: WORD })) as { hits: Array<{ sessionId: string }> };
      expect(search.hits.map((h) => h.sessionId)).toEqual([OLDEST]);
      const semantic = (await call("hx_semantic_search", { queryText: "angle:0", k: 1 })) as {
        hits: Array<{ sessionId: string }>;
      };
      expect(semantic.hits.map((h) => h.sessionId)).toEqual([OLDEST]);
      const aggregate = (await call("hx_sessions_aggregate", {})) as { totalSessions: number };
      expect(aggregate.totalSessions).toBe(SCOPE_SIZE);
    }
  });
});

describe("the read grant commits to the identities the fortress keeps", () => {
  const many = (n: number): FortressScope => ({
    identities: Array.from({ length: n }, (_v, i) => ({ userExternalId: "u1", family: FAMILY, sessionId: `s${i}` })),
  });
  const grantFor = (scope: FortressScope): GrantClaims => ({
    v: 2,
    purpose: "read",
    org: "org_1",
    aud: "org_1",
    sub: "u1",
    scopeHash: hashFortressScope(scope),
  });

  test("a grant over a whole 31,331-identity scope admits it", () => {
    const scope = many(SCOPE_SIZE);
    expect(checkScopeGrant({ scope }, grantFor(scope), true)).toBeNull();
  });

  test("past the cap, only a grant over the first MAX_SCOPE_IDENTITIES admits the scope", () => {
    const scope = many(MAX_SCOPE_IDENTITIES + 1);
    const overAll = checkScopeGrant({ scope }, grantFor(scope), true);
    expect(overAll?.content[0]?.text).toContain("scope_not_granted");
    const capped = { identities: scope.identities.slice(0, MAX_SCOPE_IDENTITIES) };
    expect(checkScopeGrant({ scope }, grantFor(capped), true)).toBeNull();
  });
});
