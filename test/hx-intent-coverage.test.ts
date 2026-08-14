import { beforeAll, describe, expect, test } from "bun:test";
import { sql as dsql } from "drizzle-orm";

import { createHxDb, type HxDb } from "../src/host/postgres/db";
import { runMigrations } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";
import { makeMigrationExec } from "../src/host/postgres/sql-exec";
import { handleVaultRpc } from "../src/modules/session-vault/store/rpc";
import type { SessionStore } from "../src/modules/session-vault/store/types";

// A chunk intent is the ONLY record that a chunk's bytes reached the canonical while
// its turns may not have reached the index. On production it recorded nothing for
// ordinary commits — 178 ingestCommit RPCs, zero "not recorded" warnings, zero rows —
// because the call sat inside the `writeCanonical` mirror branch only, and the
// agent-lane branch had none at all. These pin every commit branch.
const DSN = process.env.FORTRESS_DATABASE_URL;
const TS = "2026-07-01T10:00:00Z";
const ATTR = { orgExternalId: null, projectExternalId: null, repoSlug: null, deviceId: null };
const rec = (t: string) =>
  `${JSON.stringify({ type: "user", uuid: crypto.randomUUID(), timestamp: TS, message: { content: [{ type: "text", text: t }] } })}\n`;

describe.skipIf(!DSN)("chunk intents cover every commit branch", () => {
  const dsn = DSN as string;
  let db: HxDb;
  beforeAll(async () => {
    await runMigrations(makeMigrationExec(dsn), migrations);
    db = createHxDb(dsn);
  });

  const store = {
    writeCanonicalText: async () => {},
    statCanonical: async () => 0,
  } as unknown as SessionStore;

  const intentsFor = async (sessionId: string) => {
    const rows = (await db.execute(dsql`
      select chunk_id, agent_external_id, total_bytes, (cleared_at is not null) as cleared
      from hx.chunk_intents where session_id = ${sessionId} order by chunk_id
    `)) as unknown as Array<{
      chunk_id: string;
      agent_external_id: string | null;
      total_bytes: string | number;
      cleared: boolean;
    }>;
    return Array.isArray(rows) ? rows : [];
  };

  const key = (tag: string) => ({
    userId: `intent-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    family: "claude-cli",
    sessionId: crypto.randomUUID(),
  });

  test("an ORDINARY chunk commit records an intent (it recorded none in production)", async () => {
    const k = key("plain");
    const text = rec("one") + rec("two");
    await handleVaultRpc(
      store,
      {
        method: "ingestCommit",
        key: k,
        chunkId: "c1",
        chunkText: text,
        totalBytes: Buffer.byteLength(text),
        componentCount: 1,
        meta: null,
        attribution: ATTR,
      } as never,
      () => db,
    );
    const rows = await intentsFor(k.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.chunk_id).toBe("c1");
    expect(rows[0]!.agent_external_id).toBeNull();
    expect(Number(rows[0]!.total_bytes)).toBe(Buffer.byteLength(text));
    // The ingest succeeded, so the same transaction closed it. An OPEN intent after a
    // successful commit would mean the clear is broken; a MISSING row means the
    // record is broken. Both matter, so assert the row AND its state.
    expect(rows[0]!.cleared).toBe(true);
  }, 60_000);

  test("an AGENT-LANE commit records an intent, tagged with its lane", async () => {
    const k = key("lane");
    const parent = rec("p1");
    await handleVaultRpc(
      store,
      {
        method: "ingestCommit", key: k, chunkId: "p1",
        chunkText: parent, totalBytes: Buffer.byteLength(parent),
        componentCount: 1, meta: null, attribution: ATTR,
      } as never,
      () => db,
    );
    const laneText = rec("l1");
    await handleVaultRpc(
      store,
      {
        method: "ingestAgentCommit", key: k, agentId: "agent-7", chunkId: "l1",
        chunkText: laneText, totalBytes: Buffer.byteLength(laneText),
        componentCount: 1, meta: null, attribution: ATTR,
      } as never,
      () => db,
    );
    const rows = await intentsFor(k.sessionId);
    // One per branch, and the lane's is attributed to the lane — a lane is a separate
    // canonical with its own turns, so its dropped write is its own loss.
    const lanes = rows.map((r) => r.agent_external_id);
    expect(lanes).toHaveLength(2);
    expect(lanes).toContain(null); // the parent commit
    expect(lanes).toContain("agent-7"); // and the lane, attributed to it
    expect(rows.every((r) => r.cleared)).toBe(true);
  }, 60_000);

  test("a WHOLE-TRANSCRIPT mirror commit still records one (the only branch that used to)", async () => {
    const k = key("mirror");
    const text = rec("m1");
    await handleVaultRpc(
      store,
      {
        method: "ingestCommit", key: k, chunkId: "m1", writeCanonical: true,
        chunkText: text, totalBytes: Buffer.byteLength(text),
        componentCount: 1, meta: null, attribution: ATTR,
      } as never,
      () => db,
    );
    const rows = await intentsFor(k.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.chunk_id).toBe("m1");
  }, 60_000);
});
