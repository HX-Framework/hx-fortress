import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "bun:test";

import { createHxDb, type HxDb } from "../src/host/postgres/db";
import { runMigrations } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";
import { makeMigrationExec } from "../src/host/postgres/sql-exec";
import { handleVaultRpc, type VaultRpcRequest } from "../src/modules/session-vault/store/rpc";
import { canonicalObject } from "../src/modules/session-vault/store/keys";
import type { SessionKey, SessionStore } from "../src/modules/session-vault/store/types";
import { hxSessions } from "../src/host/postgres/schema/sessions";
import { hxUsers } from "../src/host/postgres/schema/dimensions";

// LETAIR-300 · bytes-free re-index, exercised end-to-end against a real hx schema:
// the fortress reads its OWN canonical (an in-memory store keyed exactly like
// GCS/S3, via canonicalObject) and indexes it — no chunkText crosses the seam.
// Pins the two facts the guard unit tests cannot: a genuine apply lands the rows
// and reports the object-domain covered end, and an EMPTIED canonical supersedes
// WITHOUT wiping the rows already indexed (the catastrophe a naive replace causes).
const DSN = process.env.FORTRESS_DATABASE_URL;
const TS = "2026-07-01T10:00:00Z";
const ATTR = { orgExternalId: null, projectExternalId: null, repoSlug: null, deviceId: null };

// One valid JSONL user record → one event.
const rec = (t: string) =>
  `${JSON.stringify({
    type: "user",
    uuid: crypto.randomUUID(),
    timestamp: TS,
    message: { content: [{ type: "text", text: t }] },
  })}\n`;

// In-memory store keyed by bucket object name (GCS/S3 layout). Only stat + read
// matter here; a missing object stats null and reads throw NoSuchKey, like the real
// stores — which is exactly what the missing-canonical guard relies on.
function memStore(canon: Map<string, string>): SessionStore {
  return {
    statCanonical: async (k: SessionKey) => {
      const t = canon.get(canonicalObject(k));
      return t === undefined ? null : Buffer.byteLength(t);
    },
    readCanonicalText: async (k: SessionKey) => {
      const t = canon.get(canonicalObject(k));
      if (t === undefined) throw new Error("NoSuchKey");
      return t;
    },
    writeCanonicalText: async () => {},
  } as unknown as SessionStore;
}

describe.skipIf(!DSN)("reindexCanonical — DB apply + no-wipe (LETAIR-300)", () => {
  const dsn = DSN as string;
  let db: HxDb;
  beforeAll(async () => {
    await runMigrations(makeMigrationExec(dsn), migrations);
    db = createHxDb(dsn);
  });

  const key = (tag: string): SessionKey => ({
    userId: `reindex-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    family: "claude-cli",
    sessionId: crypto.randomUUID(),
  });

  const events = async (k: SessionKey) => {
    const [row] = await db
      .select({ n: hxSessions.eventCount })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(eq(hxUsers.externalId, k.userId), eq(hxSessions.sessionId, k.sessionId)))
      .limit(1);
    return Number(row?.n ?? 0);
  };

  const reindex = (k: SessionKey, chunkId: string, store: SessionStore) =>
    handleVaultRpc(
      store,
      {
        method: "reindexCanonical",
        key: k,
        chunkId,
        replace: true,
        componentCount: 1,
        meta: null,
        attribution: ATTR,
      } as VaultRpcRequest,
      () => db,
    );

  test("applies the canonical the fortress read itself; coveredEnd = object bytes", async () => {
    const k = key("apply");
    const text = rec("one") + rec("two");
    const res = await reindex(k, "r1", memStore(new Map([[canonicalObject(k), text]])));
    expect(res).toEqual({
      method: "reindexCanonical",
      value: { outcome: "applied", coveredEnd: Buffer.byteLength(text) },
    });
    expect(await events(k)).toBe(2);
  }, 60_000);

  test("an EMPTIED canonical supersedes — the indexed rows are NOT wiped", async () => {
    const k = key("nowipe");
    const canon = new Map([[canonicalObject(k), rec("keep-a") + rec("keep-b")]]);
    const store = memStore(canon);
    const first = (await reindex(k, "r1", store)) as { value: { outcome: string } };
    expect(first.value.outcome).toBe("applied");
    expect(await events(k)).toBe(2);
    // The canonical is now observed empty (whitespace) but still stats non-null; a
    // replace here would DELETE the two turns. The guard must supersede instead.
    canon.set(canonicalObject(k), "   \n  ");
    const second = await reindex(k, "r2", store);
    expect(second).toEqual({
      method: "reindexCanonical",
      value: { outcome: "superseded", coveredEnd: 0 },
    });
    expect(await events(k)).toBe(2); // still indexed — the lane survived
  }, 60_000);

  test("a same-chunkId replay is deduped (already ingested), completed not re-applied", async () => {
    const k = key("dedupe");
    const store = memStore(new Map([[canonicalObject(k), rec("d1")]]));
    const a = (await reindex(k, "same", store)) as { value: { outcome: string } };
    expect(a.value.outcome).toBe("applied");
    const b = (await reindex(k, "same", store)) as { value: { outcome: string } };
    expect(b.value.outcome).toBe("deduped");
    expect(await events(k)).toBe(1);
  }, 60_000);
});
