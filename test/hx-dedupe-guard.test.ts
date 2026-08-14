import { beforeAll, describe, expect, test } from "bun:test";
import { sql as dsql } from "drizzle-orm";

import { createHxDb, type HxDb } from "../src/host/postgres/db";
import { runMigrations } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";
import { makeMigrationExec } from "../src/host/postgres/sql-exec";
import {
  chunkRecordUuids,
  countCanonicalHeldDuplicateRecords,
  judgeAppend,
} from "../src/ingest/dedupe-guard";
import { ingestAgentCommit, ingestCommit, type IngestAttribution } from "../src/ingest/ingest";
import { handleVaultRpc } from "../src/modules/session-vault/store/rpc";
import type { SessionStore } from "../src/modules/session-vault/store/types";

// Write-path duplicate prevention (§7c). The contract under test, end to end:
// a chunk whose EVERY record is already indexed is answered as a no-op on BOTH
// RPCs (compose skips, ingest skips AND clears its own chunk intent); a chunk
// with any new record passes whole (loss outranks duplication) with the
// overlap recorded; anything unjudgeable passes (fail open). Refusal does not
// exist on this path — that is the point.
const DSN = process.env.FORTRESS_DATABASE_URL;
const TS = "2026-07-01T10:00:00Z";
const ATTR: IngestAttribution = {
  orgExternalId: null,
  projectExternalId: null,
  repoSlug: null,
  deviceId: null,
};

const rec = (uuid: string, t: string) =>
  JSON.stringify({ type: "user", uuid, timestamp: TS, message: { content: [{ type: "text", text: t }] } });
const chunkOf = (...lines: string[]) => `${lines.join("\n")}\n`;

describe("chunkRecordUuids (pure)", () => {
  test("collects every record uuid in order", () => {
    const u1 = crypto.randomUUID();
    const u2 = crypto.randomUUID();
    expect(chunkRecordUuids(chunkOf(rec(u1, "a"), rec(u2, "b")))).toEqual([u1, u2]);
  });

  test("stands aside (null) on: empty, uuid-less record, unparseable line, oversized", () => {
    expect(chunkRecordUuids("")).toBeNull();
    expect(chunkRecordUuids(chunkOf(JSON.stringify({ type: "user", timestamp: TS })))).toBeNull();
    expect(chunkRecordUuids(chunkOf(rec(crypto.randomUUID(), "a"), "not json"))).toBeNull();
    const big = { type: "user", uuid: crypto.randomUUID(), pad: "x".repeat(33 * 1024 * 1024) };
    expect(chunkRecordUuids(chunkOf(JSON.stringify(big)))).toBeNull();
  });

  test("a chunk that is ONLY blank lines is unjudgeable, not empty-and-skippable", () => {
    expect(chunkRecordUuids("\n\n")).toBeNull();
  });
});

describe("countCanonicalHeldDuplicateRecords (pure)", () => {
  const turn = (uuid: string | null) => ({ rawEvent: uuid ? { type: "user", uuid } : { type: "user" } });

  test("contiguous blocks of one record are ONE run — no false positive", () => {
    const a = crypto.randomUUID();
    expect(countCanonicalHeldDuplicateRecords([turn(a), turn(a), turn(crypto.randomUUID())])).toBe(0);
  });

  test("a record re-appearing after other records counts once per uuid", () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    expect(countCanonicalHeldDuplicateRecords([turn(a), turn(b), turn(a)])).toBe(1);
    expect(countCanonicalHeldDuplicateRecords([turn(a), turn(b), turn(a), turn(crypto.randomUUID()), turn(b)])).toBe(2);
  });

  test("KNOWN LOWER BOUND: an immediately-adjacent identical re-send merges into one run", () => {
    const a = crypto.randomUUID();
    // [A][A] — a tail re-send appended right after the original is invisible
    // to run-counting. Documented; the instrument is a floor, not an exact count.
    expect(countCanonicalHeldDuplicateRecords([turn(a), turn(a)])).toBe(0);
  });

  test("uuid-less turns never count", () => {
    expect(countCanonicalHeldDuplicateRecords([turn(null), turn(null)])).toBe(0);
    expect(countCanonicalHeldDuplicateRecords([])).toBe(0);
  });
});

describe.skipIf(!DSN)("dedupe guard against a real index", () => {
  const dsn = DSN as string;
  let db: HxDb;
  beforeAll(async () => {
    await runMigrations(makeMigrationExec(dsn), migrations);
    db = createHxDb(dsn);
  });

  const key = (tag: string) => ({
    userId: `dedupe-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    family: "claude-cli",
    sessionId: crypto.randomUUID(),
  });

  const turnsOf = async (sessionId: string): Promise<number> => {
    const rows = (await db.execute(dsql`
      select count(*) as n from hx.turns t
      join hx.sessions s on s.id = t.session_id
      where s.session_id = ${sessionId}
    `)) as unknown as Array<{ n: string | number }>;
    return Number(rows[0]?.n ?? 0);
  };

  const findingsOf = async (sessionId: string, kind: string) => {
    const rows = (await db.execute(dsql`
      select kind, agent_external_id, detail from hx.integrity_findings
      where session_id = ${sessionId} and kind = ${kind}
    `)) as unknown as Array<{ kind: string; agent_external_id: string | null; detail: unknown }>;
    return Array.isArray(rows) ? rows : [];
  };

  const intentsOf = async (sessionId: string) => {
    const rows = (await db.execute(dsql`
      select chunk_id, (cleared_at is not null) as cleared from hx.chunk_intents
      where session_id = ${sessionId} order by chunk_id
    `)) as unknown as Array<{ chunk_id: string; cleared: boolean }>;
    return Array.isArray(rows) ? rows : [];
  };

  test("judgeAppend: fresh lane passes; full re-send skips; overlap passes with the count; lane-scoped", async () => {
    const k = key("judge");
    const u1 = crypto.randomUUID();
    const u2 = crypto.randomUUID();
    const text = chunkOf(rec(u1, "one"), rec(u2, "two"));
    const lane = { userExternalId: k.userId, family: k.family, sessionId: k.sessionId, agentExternalId: null };

    expect(await judgeAppend(db, lane, text)).toEqual({ verdict: "pass", overlap: 0 });

    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key: k, chunkId: "g1", replace: false, chunkText: text,
      totalBytes: Buffer.byteLength(text), componentCount: 1, meta: null, attribution: ATTR,
    });

    expect(await judgeAppend(db, lane, text)).toEqual({ verdict: "skip_duplicate", records: 2 });
    const half = chunkOf(rec(u1, "one"), rec(crypto.randomUUID(), "new"));
    expect(await judgeAppend(db, lane, half)).toEqual({ verdict: "pass", overlap: 1 });
    // The SAME records judged against an agent lane of the session are absent there.
    expect(
      await judgeAppend(db, { ...lane, agentExternalId: "agent-x" }, text),
    ).toEqual({ verdict: "pass", overlap: 0 });
  });

  test("a lane past the turn ceiling is not probed — fail open, never slow", async () => {
    const k = key("cap");
    const text = chunkOf(rec(crypto.randomUUID(), "one"), rec(crypto.randomUUID(), "two"));
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key: k, chunkId: "g1", replace: false, chunkText: text,
      totalBytes: Buffer.byteLength(text), componentCount: 1, meta: null, attribution: ATTR,
    });
    const lane = { userExternalId: k.userId, family: k.family, sessionId: k.sessionId, agentExternalId: null };
    // Under the default ceiling this is a clear skip…
    expect((await judgeAppend(db, lane, text)).verdict).toBe("skip_duplicate");
    // …but a lane larger than the ceiling is never probed (the probe pays a
    // per-row raw_event unwrap inside the advisory lock — the ceiling is the
    // hot-path protection, and fail open is the only safe direction).
    expect(await judgeAppend(db, lane, text, { maxLaneTurns: 1 })).toEqual({ verdict: "pass", overlap: 0 });
  });

  test("kill switch: FORTRESS_DEDUPE_GUARD_DISABLED=1 makes every verdict a pass", async () => {
    const k = key("kill");
    const text = chunkOf(rec(crypto.randomUUID(), "one"));
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key: k, chunkId: "g1", replace: false, chunkText: text,
      totalBytes: Buffer.byteLength(text), componentCount: 1, meta: null, attribution: ATTR,
    });
    const lane = { userExternalId: k.userId, family: k.family, sessionId: k.sessionId, agentExternalId: null };
    expect((await judgeAppend(db, lane, text)).verdict).toBe("skip_duplicate");
    process.env.FORTRESS_DEDUPE_GUARD_DISABLED = "1";
    try {
      expect((await judgeAppend(db, lane, text)).verdict).toBe("pass");
    } finally {
      delete process.env.FORTRESS_DEDUPE_GUARD_DISABLED;
    }
  });

  test("ingest skips a full re-send under a NEW chunk id — and clears that chunk's intent", async () => {
    const k = key("ingest");
    const text = chunkOf(rec(crypto.randomUUID(), "one"), rec(crypto.randomUUID(), "two"));
    const store = {
      writeCanonicalText: async () => {},
      statCanonical: async () => Buffer.byteLength(text),
    } as unknown as SessionStore;

    const send = (chunkId: string) =>
      handleVaultRpc(
        store,
        {
          method: "ingestCommit",
          key: k, chunkId, replace: false, chunkText: text,
          totalBytes: Buffer.byteLength(text), componentCount: 1, meta: null, attribution: ATTR,
        } as never,
        () => db,
      );

    await send("c1");
    expect(await turnsOf(k.sessionId)).toBe(2);

    // The historical mechanism: same content re-sent under a NEW chunk id —
    // chunk-id dedupe is blind to it, only the record guard can see it. The
    // tunnel result deliberately does not carry the outcome (the cloud does
    // not branch on it); the contract IS the database effect.
    await send("c2");
    expect(await turnsOf(k.sessionId)).toBe(2);

    // The intent the RPC recorded for c2 must be CLEARED by the skip: its
    // promise (these bytes are indexed) is already kept. A stranded intent
    // would force a pointless whole-canonical rebuild at the next sweep.
    const intents = await intentsOf(k.sessionId);
    expect(intents.map((i) => i.chunk_id).sort()).toEqual(["c1", "c2"]);
    expect(intents.every((i) => i.cleared)).toBe(true);
  });

  test("a partial overlap passes whole and is recorded as a finding — never blocked", async () => {
    const k = key("overlap");
    const u1 = crypto.randomUUID();
    const text = chunkOf(rec(u1, "one"));
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key: k, chunkId: "c1", replace: false, chunkText: text,
      totalBytes: Buffer.byteLength(text), componentCount: 1, meta: null, attribution: ATTR,
    });
    const mixed = chunkOf(rec(u1, "one"), rec(crypto.randomUUID(), "brand new"));
    const out = await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key: k, chunkId: "c2", replace: false, chunkText: mixed,
      totalBytes: Buffer.byteLength(text) + Buffer.byteLength(mixed), componentCount: 2, meta: null, attribution: ATTR,
    });
    expect(out.applied).toBe(true);
    // The new record landed (loss outranks duplication)…
    expect(await turnsOf(k.sessionId)).toBe(3);
    // …and the anomaly is durable evidence, not a rolling log line.
    const found = await findingsOf(k.sessionId, "append_overlap");
    expect(found.length).toBe(1);
  });

  test("replace bypasses the guard (a from-zero re-upload is the healing path)", async () => {
    const k = key("replace");
    const text = chunkOf(rec(crypto.randomUUID(), "one"), rec(crypto.randomUUID(), "two"));
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key: k, chunkId: "c1", replace: false, chunkText: text,
      totalBytes: Buffer.byteLength(text), componentCount: 1, meta: null, attribution: ATTR,
    });
    const out = await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key: k, chunkId: "c2", replace: true, chunkText: text,
      totalBytes: Buffer.byteLength(text), componentCount: 1, meta: null, attribution: ATTR,
    });
    expect(out.applied).toBe(true);
    expect(await turnsOf(k.sessionId)).toBe(2);
  });

  test("agent-lane ingest skips a lane re-send without touching the parent", async () => {
    const k = key("lane");
    const parentText = chunkOf(rec(crypto.randomUUID(), "parent"));
    const laneText = chunkOf(rec(crypto.randomUUID(), "lane one"), rec(crypto.randomUUID(), "lane two"));
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key: k, chunkId: "p1", replace: false, chunkText: parentText,
      totalBytes: Buffer.byteLength(parentText), componentCount: 1, meta: null, attribution: ATTR,
    });
    await ingestAgentCommit(db, {
      ingestChannel: "tunnel" as const,
      key: k, agentId: "agent-7", chunkId: "a1", replace: false, chunkText: laneText,
      totalBytes: Buffer.byteLength(laneText), componentCount: 1, meta: null, attribution: ATTR,
    });
    expect(await turnsOf(k.sessionId)).toBe(3);
    const out = await ingestAgentCommit(db, {
      ingestChannel: "tunnel" as const,
      key: k, agentId: "agent-7", chunkId: "a2", replace: false, chunkText: laneText,
      totalBytes: Buffer.byteLength(laneText), componentCount: 1, meta: null, attribution: ATTR,
    });
    expect(out.applied).toBe(false);
    expect(out.applied === false && out.reason).toBe("duplicate_records");
    expect(await turnsOf(k.sessionId)).toBe(3);
  });

  test("compose RPC answers a full re-send with the canonical's REAL size and never composes", async () => {
    const k = key("compose");
    const text = chunkOf(rec(crypto.randomUUID(), "one"));
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key: k, chunkId: "c1", replace: false, chunkText: text,
      totalBytes: Buffer.byteLength(text), componentCount: 1, meta: null, attribution: ATTR,
    });
    let composed = 0;
    const store = {
      readChunkText: async () => text,
      statCanonical: async () => 4242,
      appendChunkToCanonical: async () => {
        composed += 1;
        return { totalBytes: 9999, componentCount: 3 };
      },
    } as unknown as SessionStore;
    const res = (await handleVaultRpc(
      store,
      { method: "appendChunkToCanonical", key: k, chunkId: "c2", replace: false } as never,
      () => db,
    )) as { value: { totalBytes: number } };
    expect(res.value.totalBytes).toBe(4242);
    expect(composed).toBe(0);

    // Lane composite key routes the judgement to the LANE's (empty) index → composes.
    const laneKey = { ...k, sessionId: `${k.sessionId}:a:agent-7` };
    const laneRes = (await handleVaultRpc(
      store,
      { method: "appendChunkToCanonical", key: laneKey, chunkId: "c3", replace: false } as never,
      () => db,
    )) as { value: { totalBytes: number } };
    expect(laneRes.value.totalBytes).toBe(9999);
    expect(composed).toBe(1);
  });

  test("compose RPC fails OPEN: a failed stat falls through to a real compose", async () => {
    const k = key("failopen");
    const text = chunkOf(rec(crypto.randomUUID(), "one"));
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key: k, chunkId: "c1", replace: false, chunkText: text,
      totalBytes: Buffer.byteLength(text), componentCount: 1, meta: null, attribution: ATTR,
    });
    let composed = 0;
    const store = {
      readChunkText: async () => text,
      statCanonical: async () => {
        throw new Error("stat down");
      },
      appendChunkToCanonical: async () => {
        composed += 1;
        return { totalBytes: 7, componentCount: 1 };
      },
    } as unknown as SessionStore;
    const res = (await handleVaultRpc(
      store,
      { method: "appendChunkToCanonical", key: k, chunkId: "c2", replace: false } as never,
      () => db,
    )) as { value: { totalBytes: number } };
    expect(res.value.totalBytes).toBe(7);
    expect(composed).toBe(1);
  });
});
