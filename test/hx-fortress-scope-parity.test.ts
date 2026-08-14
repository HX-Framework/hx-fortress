import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray, sql as sqlRaw } from "drizzle-orm";

import { createHxDb, type HxDb } from "../src/host/postgres/db";
import { runMigrations } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";
import { makeMigrationExec } from "../src/host/postgres/sql-exec";
import { ingestCommit, type IngestAttribution } from "../src/ingest/ingest";
import { hxOrgs, hxSessions } from "../src/host/postgres/schema";
import { hxSessionSearch } from "../src/query/search";
import { fitListPayload, MAX_TOOL_OUTPUT_CHARS } from "../src/mcp/output-limit";
import { withReadBound } from "../src/query/read-bound";
import { resolveScopeSessionIds, scopePredicate } from "../src/query/scope";
import { hxSessionsList } from "../src/query/sessions-list";
import type { FortressScope } from "../src/query/scope";

// §13-C PARITY ORACLE (the analogue of the workbench SERVER_PARITY_ORACLE): prove
// the fortress matches the PASSED identities and NEVER its own frozen `org_id`.
//
// The divergence that bites: a session whose fortress `hx.sessions.org_id` is
// frozen at orgA (ingest-stamped, never re-attributed on the fortress) while
// workbench has manually re-attributed it to orgB. The contract (A6) is that the
// fortress evaluates NO org predicate — it admits exactly the enumerated scope
// identities. So:
//   • a scope whose identities INCLUDE the session (as workbench resolves for
//     orgB's board) → returns it, even though its frozen org_id is orgA;
//   • a scope whose identities EXCLUDE it (as orgA's board resolves after the
//     manual re-attribution away) → 0, even though its frozen org_id is STILL
//     orgA (the fortress must not fall back to it).
// A test that only checked the workbench resolver would pass while the fortress
// still leaked via its stale org_id — so this oracle lives in the fortress repo.
//
//   FORTRESS_DATABASE_URL=postgres://forge:forge@localhost:5499/hx-db \
//     bun test test/hx-fortress-scope-parity.test.ts
const DSN = process.env.FORTRESS_DATABASE_URL;

const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const USER_ID = `user-parity-${SUFFIX}`;
const FAMILY = "claude-cli";
const SESSION_X = `sess-parity-x-${SUFFIX}`; // re-attributed orgA → orgB on workbench
const SESSION_Y = `sess-parity-y-${SUFFIX}`; // still on orgA's board
const ORG_A = `org-parity-A-${SUFFIX}`;
const TS = "2026-06-30T10:00:00Z";

const NULL_ATTR: IngestAttribution = {
  orgExternalId: null,
  projectExternalId: null,
  repoSlug: null,
  deviceId: null,
};

// One user turn carrying a word BOTH sessions share, so the keyword query matches
// both and the SCOPE — not the query — is what discriminates the results.
function chunk(): string {
  return JSON.stringify({
    type: "user",
    timestamp: TS,
    message: { content: [{ type: "text", text: "please search the directory now" }] },
  });
}

const idX = { userExternalId: USER_ID, family: FAMILY, sessionId: SESSION_X };
const idY = { userExternalId: USER_ID, family: FAMILY, sessionId: SESSION_Y };

function searchIds(out: { hits: { sessionId: string }[] }): string[] {
  return out.hits.map((h) => h.sessionId);
}
function listIds(out: { sessions: { sessionId: string }[] }): string[] {
  return out.sessions.map((s) => s.sessionId);
}

describe.if(!!DSN)("hx-fortress §13-C scope parity (identities, never the frozen org_id)", () => {
  const dsn = DSN as string;
  const sqlx = makeMigrationExec(dsn);
  let db: HxDb;
  let orgAUuid: string;

  beforeAll(async () => {
    await runMigrations(sqlx, migrations);
    db = createHxDb(dsn);

    for (const sessionId of [SESSION_X, SESSION_Y]) {
      await ingestCommit(db, {
        ingestChannel: "tunnel",
        attribution: NULL_ATTR, // ingest stamps org_id = NULL (Uncategorized)…
        key: { userId: USER_ID, family: FAMILY, sessionId },
        chunkId: "c1",
        replace: false,
        chunkText: chunk(),
        totalBytes: 128,
        componentCount: 1,
        meta: { title: `parity ${sessionId}` },
      });
    }

    // …then FREEZE both sessions' fortress org_id at orgA directly (as ingest from
    // an orgA-attributed upload would have). This is the stale value the fortress
    // must IGNORE — workbench has since re-attributed sX to orgB, but no
    // re-attribution RPC reaches the fortress, so its org_id stays orgA.
    const [orgRow] = await db
      .insert(hxOrgs)
      .values({ externalId: ORG_A, name: "Alpha" })
      .returning({ id: hxOrgs.id });
    orgAUuid = orgRow.id;
    await db
      .update(hxSessions)
      .set({ orgId: orgAUuid })
      .where(inArray(hxSessions.sessionId, [SESSION_X, SESSION_Y]));
  }, 60_000);

  afterAll(async () => {
    if (!DSN) return;
    await sqlx.exec(
      `DELETE FROM hx.ingest_events WHERE session_id_ext IN ('${SESSION_X}', '${SESSION_Y}')`,
    );
    await sqlx.exec(`DELETE FROM hx.sessions WHERE session_id IN ('${SESSION_X}', '${SESSION_Y}')`);
    await sqlx.exec(`DELETE FROM hx.orgs WHERE external_id = '${ORG_A}'`);
  });

  test("(a) the divergence is real: both sessions' fortress org_id is frozen at orgA", async () => {
    const rows = await db
      .select({ sessionId: hxSessions.sessionId, orgId: hxSessions.orgId })
      .from(hxSessions)
      .where(inArray(hxSessions.sessionId, [SESSION_X, SESSION_Y]));
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.orgId).toBe(orgAUuid);
  });

  test("(b) INCLUDE sX (orgB's resolved scope) → returns sX, excludes sY — matched by identity, not org_id", async () => {
    const scope: FortressScope = { identities: [idX] };
    const search = searchIds(await hxSessionSearch(db, { scope, query: "directory" }));
    expect(search).toContain(SESSION_X);
    expect(search).not.toContain(SESSION_Y);

    const list = listIds(await hxSessionsList(db, { scope }));
    expect(list).toEqual([SESSION_X]);
  });

  test("(c) EXCLUDE sX (orgA's board after re-attribution away) → sX never leaks via its frozen org_id", async () => {
    // orgA's board now resolves only sY; sX must NOT come back even though its
    // frozen org_id is STILL orgA (the fortress evaluates no org predicate).
    const scope: FortressScope = { identities: [idY] };
    const search = searchIds(await hxSessionSearch(db, { scope, query: "directory" }));
    expect(search).toContain(SESSION_Y);
    expect(search).not.toContain(SESSION_X);

    const list = listIds(await hxSessionsList(db, { scope }));
    expect(list).toEqual([SESSION_Y]);
  });

  test("(d) me-scope (both identities) → both sessions, regardless of the frozen org_id", async () => {
    const scope: FortressScope = { identities: [idX, idY] };
    const search = searchIds(await hxSessionSearch(db, { scope, query: "directory" }));
    expect(search).toContain(SESSION_X);
    expect(search).toContain(SESSION_Y);

    const list = listIds(await hxSessionsList(db, { scope })).sort();
    expect(list).toEqual([SESSION_X, SESSION_Y].sort());
  });

  test("(e) an empty scope → 0 (fail-closed match-nothing), even with sessions frozen at orgA", async () => {
    const none: FortressScope = { identities: [] };
    expect((await hxSessionSearch(db, { scope: none, query: "directory" })).hits.length).toBe(0);
    expect((await hxSessionsList(db, { scope: none })).sessions.length).toBe(0);

    // …and a FOREIGN identity (a different owner of "the same" session) → 0 too.
    const foreign: FortressScope = {
      identities: [{ userExternalId: "someone-else", family: FAMILY, sessionId: SESSION_X }],
    };
    expect((await hxSessionSearch(db, { scope: foreign, query: "directory" })).hits.length).toBe(0);
    expect((await hxSessionsList(db, { scope: foreign })).sessions.length).toBe(0);
  });
});


// ── LETAIR-176 G1 · fitListPayload is pure — runs with or without a database ──
describe("fitListPayload (output-cap fitting)", () => {
  test("an under-limit payload passes through IDENTICAL (no flags added)", () => {
    const payload = { hits: [{ a: 1 }, { a: 2 }] };
    expect(fitListPayload(payload, "hits")).toBe(payload);
  });

  test("an over-limit payload keeps the ranked PREFIX and says what it dropped", () => {
    const hits = Array.from({ length: 100 }, (_, i) => ({ rankPos: i, s: "x".repeat(400) }));
    const fitted = fitListPayload({ hits }, "hits") as {
      hits: { rankPos: number }[];
      truncated?: true;
      dropped?: number;
    };
    expect(fitted.truncated).toBe(true);
    expect(fitted.hits.length).toBeGreaterThan(0);
    expect(fitted.hits.length).toBeLessThan(100);
    expect(fitted.dropped).toBe(100 - fitted.hits.length);
    // Prefix, not a resample: the survivors are exactly the first N by rank.
    expect(fitted.hits.map((h) => h.rankPos)).toEqual(
      Array.from({ length: fitted.hits.length }, (_, i) => i),
    );
    // The fitted result actually fits — the blunt cap can never fire on it.
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
  });

  test("one pathologically huge entry degrades to an empty flagged list, still valid JSON", () => {
    const fitted = fitListPayload({ hits: [{ s: "x".repeat(40_000) }] }, "hits") as {
      hits: unknown[];
      truncated?: true;
      dropped?: number;
    };
    expect(fitted.truncated).toBe(true);
    expect(fitted.hits).toEqual([]);
    expect(fitted.dropped).toBe(1);
  });
});

// ── LETAIR-175 · the scope resolver must admit EXACTLY the predicate's rows ──
describe.if(!!DSN)("resolveScopeSessionIds parity + read bound + kinds", () => {
  const dsn2 = DSN as string;
  let gdb: HxDb;
  const GUSER = `user-guardq-${SUFFIX}`;
  const GSESSION = `sess-guardq-${SUFFIX}`;
  const gid = { userExternalId: GUSER, family: FAMILY, sessionId: GSESSION };

  beforeAll(async () => {
    await runMigrations(makeMigrationExec(dsn2), migrations);
    gdb = createHxDb(dsn2);
    // One session carrying the marker in BOTH a user turn and a tool_result
    // turn, so `kinds` is what discriminates the hits.
    const lines = [
      JSON.stringify({
        type: "user",
        timestamp: TS,
        message: { content: [{ type: "text", text: "find guardqmarker in the logs" }] },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: TS,
        message: {
          model: "claude-opus-4-8",
          content: [
            { type: "text", text: "Running the scan." },
            { type: "tool_use", id: "tu_gq", name: "Bash", input: { command: "grep guardqmarker" } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: TS,
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu_gq", content: "guardqmarker found in 3 files" },
          ],
        },
      }),
    ].join("\n");
    await ingestCommit(gdb, {
      ingestChannel: "tunnel",
      attribution: NULL_ATTR,
      key: { userId: GUSER, family: FAMILY, sessionId: GSESSION },
      chunkId: "gq1",
      replace: false,
      chunkText: lines,
      totalBytes: Buffer.byteLength(lines),
      componentCount: 1,
      meta: null,
    });
  }, 60_000);

  test("resolver row-set equals scopePredicate row-set (owner gate included)", async () => {
    const scope: FortressScope = {
      identities: [gid, { userExternalId: "no-such-user", family: FAMILY, sessionId: "nope" }],
    };
    const viaResolver = (await resolveScopeSessionIds(gdb, scope)).sort();
    const viaPredicate = (
      await gdb.select({ id: hxSessions.id }).from(hxSessions).where(scopePredicate(scope))
    )
      .map((r) => r.id)
      .sort();
    expect(viaResolver.length).toBe(1);
    expect(viaResolver).toEqual(viaPredicate);

    // Owner gate parity: a gate naming a non-member admits nothing on BOTH
    // shapes; a gate naming the owner admits the same row again.
    const gatedOut: FortressScope = { ...scope, ownerGate: { activeMemberExternalIds: ["someone-else"] } };
    expect(await resolveScopeSessionIds(gdb, gatedOut)).toEqual([]);
    expect(
      await gdb.select({ id: hxSessions.id }).from(hxSessions).where(scopePredicate(gatedOut)),
    ).toEqual([]);
    const gatedIn: FortressScope = { ...scope, ownerGate: { activeMemberExternalIds: [GUSER] } };
    expect((await resolveScopeSessionIds(gdb, gatedIn)).sort()).toEqual(viaPredicate);
  });

  test("empty scope resolves to no ids and search returns no hits", async () => {
    expect(
      await resolveScopeSessionIds(gdb, { identities: [] } as unknown as FortressScope),
    ).toEqual([]);
    const out = await hxSessionSearch(gdb, {
      scope: { identities: [] } as unknown as FortressScope,
      query: "guardqmarker",
    });
    expect(out.hits).toEqual([]);
  });

  test("kinds restricts hits to the named turn kinds; unknown kinds fail open", async () => {
    const scope: FortressScope = { identities: [gid] };
    const all = await hxSessionSearch(gdb, { scope, query: "guardqmarker" });
    expect(all.hits.length).toBeGreaterThanOrEqual(2);
    expect(new Set(all.hits.map((h) => h.kind)).size).toBeGreaterThanOrEqual(2);

    const userOnly = await hxSessionSearch(gdb, { scope, query: "guardqmarker", kinds: ["user_text"] });
    expect(userOnly.hits.length).toBeGreaterThan(0);
    expect(userOnly.hits.every((h) => h.kind === "user_text")).toBe(true);

    const toolOnly = await hxSessionSearch(gdb, { scope, query: "guardqmarker", kinds: ["tool_result"] });
    expect(toolOnly.hits.length).toBeGreaterThan(0);
    expect(toolOnly.hits.every((h) => h.kind === "tool_result")).toBe(true);

    // Every value unknown ⇒ filter ignored (fail open) — hx_text_occurrences'
    // established kinds semantics.
    const junk = await hxSessionSearch(gdb, { scope, query: "guardqmarker", kinds: ["not_a_kind"] });
    expect(junk.hits.length).toBe(all.hits.length);
  });

  test("withReadBound bounds the statement and leaves the pool clean after", async () => {
    let failed = false;
    try {
      await withReadBound(gdb, async (bdb) => bdb.execute(sqlRaw`select pg_sleep(0.5)`), "100ms");
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    // The bound was transaction-local: the next ordinary query is unaffected.
    const rows = (await gdb.execute(sqlRaw`select 1 as one`)) as unknown as Array<{ one: number }>;
    expect(Number(rows[0]?.one)).toBe(1);
    // And the return path works when the query fits the bound.
    const val = await withReadBound(gdb, async () => 42, "5s");
    expect(val).toBe(42);
  });
});
