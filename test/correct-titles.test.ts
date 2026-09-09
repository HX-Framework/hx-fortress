import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createHxDb, type HxDb } from "../src/host/postgres/db";
import { runMigrations } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";
import { makeMigrationExec } from "../src/host/postgres/sql-exec";
import { ingestCommit, type IngestAttribution } from "../src/ingest/ingest";
import { correctTitles } from "../src/ingest/correct-titles";
import type { SessionKey, SessionStore } from "../src/modules/session-vault/store/types";

// Guarantor corrective title pass (LETAIR-462). Restores real titles the write
// path stranded on a fallback, is bounded to Claude families, and corrects a
// mislabelled source when the title text already matches. Real Postgres when
// FORTRESS_DATABASE_URL is set; skipped otherwise so a plain `bun test` stays green.
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

const canonicalWith = (kind: "ai-title" | "custom-title", title: string, firstLine: string): string =>
  [
    JSON.stringify({ type: "user", timestamp: TS, message: { content: [{ type: "text", text: firstLine }] } }),
    JSON.stringify(kind === "ai-title" ? { type: "ai-title", aiTitle: title } : { type: "custom-title", customTitle: title }),
  ].join("\n");

describe.if(!!DSN)("correctTitles guarantor pass", () => {
  const dsn = DSN as string;
  const sql = makeMigrationExec(dsn);
  let db: HxDb;

  const ids: string[] = [];
  const key = (tag: string, family: string) => {
    const sessionId = `sess-ct-${tag}-${SUFFIX}`;
    ids.push(sessionId);
    return { userId: `user-ct-${SUFFIX}`, family, sessionId };
  };
  const commit = (k: { userId: string; family: string; sessionId: string }, chunkText: string, meta: Record<string, unknown> | null) =>
    ingestCommit(db, {
      ingestChannel: "tunnel",
      attribution: ATTR,
      key: k,
      chunkId: "c1",
      replace: false,
      chunkText,
      totalBytes: chunkText.length,
      componentCount: 1,
      meta,
    });
  const titleOf = async (sessionId: string) =>
    (await sql.query<{ title: string | null; title_source: string | null }>(
      `SELECT title, title_source FROM hx.sessions WHERE session_id = '${sessionId}'`,
    ))[0];

  // Fake store: return the canonical we register per sessionId.
  const canonicals = new Map<string, string>();
  const store = {
    readCanonicalText: async (k: SessionKey) => {
      const t = canonicals.get(k.sessionId);
      if (t == null) throw new Error(`no canonical for ${k.sessionId}`);
      return t;
    },
  } as unknown as SessionStore;

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

  test("upgrades a claude-cli fallback to the real ai-title in its canonical", async () => {
    const k = key("upgrade", "claude-cli");
    await commit(k, userChunk("first line becomes the floor"), { cwd: "/home/u/let-forge" });
    expect((await titleOf(k.sessionId)).title_source).toBe("fallback");
    canonicals.set(k.sessionId, canonicalWith("ai-title", "Real Generated Title", "first line becomes the floor"));

    const res = await correctTitles(db, store, { batchDelayMs: 0 });
    expect(res.corrected).toBeGreaterThanOrEqual(1);
    const row = await titleOf(k.sessionId);
    expect(row.title).toBe("Real Generated Title");
    expect(row.title_source).toBe("ai");
  });

  test("corrects a mislabelled source when the title text already matches (no text change)", async () => {
    const k = key("mislabel", "claude-desktop");
    await commit(k, userChunk("Design the new wallpaper"), null); // fallback == first line
    expect((await titleOf(k.sessionId)).title_source).toBe("fallback");
    // canonical's custom-title is the SAME text — only the source is wrong.
    canonicals.set(k.sessionId, canonicalWith("custom-title", "Design the new wallpaper", "Design the new wallpaper"));

    await correctTitles(db, store, { batchDelayMs: 0 });
    const row = await titleOf(k.sessionId);
    expect(row.title).toBe("Design the new wallpaper");
    expect(row.title_source).toBe("user"); // source healed; row leaves the candidate set
  });

  test("does NOT read/correct non-Claude families (codex fallback is legitimate)", async () => {
    const k = key("codex", "claude-cli");
    await commit(k, userChunk("codex-style opener"), { cwd: "/home/u/let-forge" });
    // Flip to a codex family AFTER ingest to simulate a codex fallback row.
    await sql.exec(`UPDATE hx.sessions SET family = 'codex-cli' WHERE session_id = '${k.sessionId}'`);
    // Register a canonical that WOULD yield a title — proving it is never read.
    canonicals.set(k.sessionId, canonicalWith("ai-title", "Should Not Be Applied", "codex-style opener"));

    await correctTitles(db, store, { batchDelayMs: 0 });
    const row = await titleOf(k.sessionId);
    expect(row.title).toBe("codex-style opener"); // untouched
    expect(row.title_source).toBe("fallback");
  });
});
