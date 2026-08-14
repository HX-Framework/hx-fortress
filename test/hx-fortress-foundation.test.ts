import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createHxDb, type HxDb } from "../src/host/postgres/db";
import { runMigrations } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";
import { makeMigrationExec } from "../src/host/postgres/sql-exec";
import { ingestCommit, type IngestAttribution } from "../src/ingest/ingest";

// Foundation slice (§13-A2: kind + tool-text rows). Runs against a real pgvector
// Postgres when FORTRESS_DATABASE_URL is set; skipped (no failure) otherwise so a
// plain `bun test` stays green. Run with:
//   FORTRESS_DATABASE_URL=postgres://forge:forge@localhost:5499/hx-db bun test test/hx-fortress-foundation.test.ts
const DSN = process.env.FORTRESS_DATABASE_URL;

const ATTR: IngestAttribution = {
  orgExternalId: null,
  projectExternalId: null,
  repoSlug: null,
  deviceId: null,
};

// Unique per run so the persistent DB is repeatable (no dedupe-key collisions /
// cross-run accumulation); assertions scope to this session id.
const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SESSION_ID = `sess-foundation-${SUFFIX}`;
const KEY = { userId: `user-foundation-${SUFFIX}`, family: "claude-cli", sessionId: SESSION_ID };
const TS = "2026-06-30T10:00:00Z";

// 1 user turn (text) · 1 assistant turn (a text block + a tool_use block) ·
// 1 tool_result carrying a distinctive literal in its output.
function mockChunk(): string {
  return [
    JSON.stringify({
      type: "user",
      timestamp: TS,
      message: { content: [{ type: "text", text: "please list the directory" }] },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: TS,
      message: {
        model: "claude-opus-4-8",
        content: [
          { type: "text", text: "Sure, running it now." },
          { type: "tool_use", id: "tu_zz", name: "Bash", input: { command: "ls -la" } },
        ],
        usage: { input_tokens: 12, output_tokens: 7 },
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: TS,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_zz",
            content: "total 4\nZZQX_MARKER drwxr-xr-x 2 user user 4096 .",
            is_error: false,
          },
        ],
      },
    }),
  ].join("\n");
}

describe.if(!!DSN)("hx-fortress foundation — kind + tool-text rows (A2)", () => {
  const dsn = DSN as string;
  const sql = makeMigrationExec(dsn);
  let db: HxDb;

  const scoped = (predicate: string): string =>
    `FROM hx.turns WHERE session_id IN (SELECT id FROM hx.sessions WHERE session_id = '${SESSION_ID}')${predicate}`;

  beforeAll(async () => {
    await runMigrations(sql, migrations);
    db = createHxDb(dsn);
    await ingestCommit(db, {
      ingestChannel: "tunnel",
      attribution: ATTR,
      key: KEY,
      chunkId: "c1",
      replace: false,
      chunkText: mockChunk(),
      totalBytes: 256,
      componentCount: 1,
      meta: { title: "Foundation smoke" },
    });
  }, 60_000);

  afterAll(async () => {
    if (!DSN) return;
    // Cascade FK drops this session's turns + tool_calls; clear the audit row too.
    await sql.exec(`DELETE FROM hx.ingest_events WHERE session_id_ext = '${SESSION_ID}'`);
    await sql.exec(`DELETE FROM hx.sessions WHERE session_id = '${SESSION_ID}'`);
  });

  test("(a) every content block becomes a turn with the right kind + role", async () => {
    const rows = await sql.query<{ kind: string; role: string }>(
      `SELECT kind, role ${scoped("")} ORDER BY seq`,
    );
    expect(rows.map((r) => r.kind)).toEqual(["user_text", "assistant_text", "tool_use", "tool_result"]);
    const role = Object.fromEntries(rows.map((r) => [r.kind, r.role]));
    expect(role.user_text).toBe("user");
    expect(role.assistant_text).toBe("assistant");
    // Non-conversational rows are role='system' (kind is the real discriminator).
    expect(role.tool_use).toBe("system");
    expect(role.tool_result).toBe("system");
  });

  test("(b) keyword search reaches into tool output (ZZQX_MARKER lives in a tool_result)", async () => {
    const rows = await sql.query<{ kind: string }>(
      `SELECT kind ${scoped(" AND to_tsvector('english', text) @@ plainto_tsquery('ZZQX_MARKER')")}`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("tool_result");
  });

  test("(c) exactly the user_text + assistant_text rows are indexable (the embed gate)", async () => {
    const [{ n: indexable }] = await sql.query<{ n: number }>(
      `SELECT count(*)::int n ${scoped(" AND kind IN ('user_text','assistant_text')")}`,
    );
    const [{ n: total }] = await sql.query<{ n: number }>(`SELECT count(*)::int n ${scoped("")}`);
    expect(Number(indexable)).toBe(2);
    expect(Number(total)).toBe(4);
  });
});
