import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull, sql as dsql } from "drizzle-orm";

import { createHxDb, type HxDb } from "../src/host/postgres/db";
import { runMigrations } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";
import { makeMigrationExec } from "../src/host/postgres/sql-exec";
import { ingestCommit, type IngestAttribution } from "../src/ingest/ingest";
import {
  countStaleIntents,
  recordChunkIntent,
  staleIntentSessions,
} from "../src/ingest/intents";
import { reconcileOrphans } from "../src/ingest/reconciler";
import { hxChunkIntents } from "../src/host/postgres/schema/analysis";
import { hxSessions } from "../src/host/postgres/schema/sessions";
import { hxTurns } from "../src/host/postgres/schema/transcript";
import { hxUsers } from "../src/host/postgres/schema/dimensions";
import type { SessionKey, SessionStore } from "../src/modules/session-vault/store/types";

// The dropped-write hole: the fortress composes a chunk into the canonical, acks,
// and hands the Postgres write to an in-memory queue. If that write is lost — PG
// unavailable, a throw, or the process restarting — the bytes are durable and
// NOTHING records that the chunk existed. The next chunk then stamps the full
// byte watermark and continues `seq` from max+1, so the lane ends up
// byte-covering AND seq-dense: invisible to the orphan scan, the staleness gate
// and the gap scan alike.
//
// Observed once in production (session 95b9f361, 2026-08-07 18:04Z, a
// workbench-chat mirror): 2,806 bytes indexed of a 5,796-byte canonical, second
// index write never arrived.
const DSN = process.env.FORTRESS_DATABASE_URL;

const TS = "2026-07-01T10:00:00Z";
const ATTR: IngestAttribution = {
  orgExternalId: null,
  projectExternalId: null,
  repoSlug: null,
  deviceId: null,
};

describe.skipIf(!DSN)("chunk intents", () => {
  const dsn = DSN as string;
  let db: HxDb;
  beforeAll(async () => {
    await runMigrations(makeMigrationExec(dsn), migrations);
    db = createHxDb(dsn);
  });

  const rec = (t: string) =>
    JSON.stringify({
      type: "user",
      uuid: crypto.randomUUID(),
      timestamp: TS,
      message: { content: [{ type: "text", text: t }] },
    }) + "\n";
  const mk = (tag: string): SessionKey => ({
    userId: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    family: "claude-cli",
    sessionId: crypto.randomUUID(),
  });
  const openIntents = async (k: SessionKey) =>
    db
      .select({ id: hxChunkIntents.id })
      .from(hxChunkIntents)
      .where(
        and(
          eq(hxChunkIntents.userExternalId, k.userId),
          eq(hxChunkIntents.sessionId, k.sessionId),
          isNull(hxChunkIntents.clearedAt),
        ),
      );

  /** Age every open intent past any grace window.
   *
   *  These assertions used to depend on a 1 ms grace beating the round trip to
   *  Postgres, which is a race the test loses whenever the database is fast — it
   *  failed once in a full-suite run and passed three times alone. Staleness is a
   *  property of the CLOCK, so the fixture sets the clock instead of hoping. */
  const ageIntents = async () => {
    await db.execute(dsql`update hx.chunk_intents set created_at = now() - interval '1 hour'`);
  };

  test("a successful ingest clears its own intent", async () => {
    const k = mk("clear");
    const text = rec("a") + rec("b");
    await recordChunkIntent(db, {
      userExternalId: k.userId, family: k.family, sessionId: k.sessionId,
      chunkId: "c1", totalBytes: Buffer.byteLength(text),
    });
    expect((await openIntents(k)).length).toBe(1);

    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key: k, chunkId: "c1", replace: false, chunkText: text,
      totalBytes: Buffer.byteLength(text), componentCount: 1, meta: null, attribution: ATTR,
    });
    // Cleared inside the same transaction as the turns, so "open" means exactly
    // "bytes composed, turns not indexed".
    expect((await openIntents(k)).length).toBe(0);
  });

  /** How many whole-canonical repair writes this session has received. */
  const repairWrites = async (k: SessionKey): Promise<number> => {
    const rows = (await db.execute(dsql`
      select count(*)::int as n
      from hx.ingest_events e
      join hx.sessions s on s.id = e.session_id
      join hx.users u on u.id = s.user_id
      where u.external_id = ${k.userId} and s.session_id = ${k.sessionId}
        and e.chunk_id like 'reconcile%'
    `)) as unknown as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0);
  };

  test("recording the same chunk twice does not error or duplicate", async () => {
    const k = mk("dupe");
    for (let i = 0; i < 2; i++) {
      await recordChunkIntent(db, {
        userExternalId: k.userId, family: k.family, sessionId: k.sessionId,
        chunkId: "same", totalBytes: 10,
      });
    }
    expect((await openIntents(k)).length).toBe(1);
  });

  test("a dropped write leaves an OPEN intent and the guarantor repairs it", async () => {
    const k = mk("dropped");
    const first = rec("one");
    const whole = first + rec("two") + rec("three");

    // Chunk 1 indexes normally.
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key: k, chunkId: "d1", replace: false, chunkText: first,
      totalBytes: Buffer.byteLength(first), componentCount: 1, meta: null, attribution: ATTR,
    });
    // Chunk 2's bytes reach the canonical — the intent is recorded — and its index
    // write is then DROPPED (we simply never call ingestCommit for it). This is
    // the production sequence.
    await recordChunkIntent(db, {
      userExternalId: k.userId, family: k.family, sessionId: k.sessionId,
      chunkId: "d2", totalBytes: Buffer.byteLength(whole),
    });

    const rowOf = async () => {
      const [r] = await db
        .select({ id: hxSessions.id, bytes: hxSessions.bytesUploaded })
        .from(hxSessions)
        .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
        .where(and(eq(hxUsers.externalId, k.userId), eq(hxSessions.sessionId, k.sessionId)))
        .limit(1);
      const turns = await db
        .select({ seq: hxTurns.seq })
        .from(hxTurns)
        .where(and(eq(hxTurns.sessionId, r!.id), isNull(hxTurns.agentId)));
      return { bytes: Number(r!.bytes), turns: turns.length };
    };

    // The damage signature: only 1 of 3 records indexed, and the row is seq-dense.
    expect((await rowOf()).turns).toBe(1);
    expect((await openIntents(k)).length).toBe(1);

    // The store holds the whole canonical, and reports a size the row already
    // covers — so the byte gate can see nothing wrong.
    const store = {
      listAllCanonicalKeys: async () => [{ ...k, bytes: Buffer.byteLength(first) }],
      readCanonicalText: async (x: SessionKey) => {
        if (x.sessionId !== k.sessionId) throw new Error("not this test's session");
        return whole;
      },
      statCanonical: async () => Buffer.byteLength(whole),
    } as unknown as SessionStore;

    await ageIntents();
    const res = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false, deepVerifyPerPass: 0,
      intentGraceMs: 60_000, // the fixture aged them an hour, so this is unambiguous
    });

    expect(res.staleIntents).toBeGreaterThanOrEqual(1);
    // …and the session was actually made whole from its canonical.
    expect((await rowOf()).turns).toBe(3);
  });

  test("a repaired intent is CLEARED, so the session is not rebuilt every pass forever", async () => {
    // The defect: clearChunkIntent matches on chunk_id, and every repair invents its
    // own (reconcile-full:/reconcile-tail:/reconcile-count:). So the repair cleared an
    // intent that never existed and left the CLIENT's intent open — the one that
    // selected the session. Nothing else pruned the table, and forced repairs are
    // exempt from FORTRESS_GUARANTOR_REPAIR_STALE, so this was an unstoppable hourly
    // whole-canonical rebuild + full re-embed of a session that was already correct.
    const k = mk("reforce");
    const whole = rec("one") + rec("two") + rec("three");
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key: k, chunkId: "r1", replace: false, chunkText: whole,
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR,
    });
    // An intent left open by a dropped write, for bytes the canonical already holds.
    await recordChunkIntent(db, {
      userExternalId: k.userId, family: k.family, sessionId: k.sessionId,
      chunkId: "r2", totalBytes: Buffer.byteLength(whole),
    });
    expect((await openIntents(k)).length).toBe(1);

    const store = {
      listAllCanonicalKeys: async () => [{ ...k, bytes: Buffer.byteLength(whole) }],
      readCanonicalText: async () => whole,
      statCanonical: async () => Buffer.byteLength(whole),
    } as unknown as SessionStore;

    await ageIntents();
    const pass1 = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false, deepVerifyPerPass: 0,
      intentGraceMs: 60_000,
    });
    expect(pass1.staleIntents).toBeGreaterThanOrEqual(1);
    const repairsAfterPass1 = await repairWrites(k);
    expect(repairsAfterPass1).toBeGreaterThanOrEqual(1); // it WAS repaired once
    // …and the repair subsumed the intent's bytes, so it must be closed.
    expect((await openIntents(k)).length).toBe(0);

    await ageIntents();
    const pass2 = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false, deepVerifyPerPass: 0,
      intentGraceMs: 60_000,
    });
    // Second pass: nothing to do FOR THIS SESSION. staleIntents/restored are
    // corpus-wide counters and other tests in this file leave intents behind, so the
    // assertion has to name the session — count its own repair writes.
    void pass2;
    const repairsAfter = await repairWrites(k);
    expect(repairsAfter).toBe(repairsAfterPass1);
    expect((await openIntents(k)).length).toBe(0);
  });

  test("an intent for bytes NOT yet indexed stays open across a repair", async () => {
    // The bound matters: a chunk composed AFTER the guarantor read the canonical is
    // genuinely not in what was just indexed, so clearing it would erase the only
    // signal that catches a dropped write.
    const k = mk("notsubsumed");
    const whole = rec("one") + rec("two");
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key: k, chunkId: "n1", replace: false, chunkText: whole,
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR,
    });
    // Its totalBytes is LARGER than anything indexed so far.
    await recordChunkIntent(db, {
      userExternalId: k.userId, family: k.family, sessionId: k.sessionId,
      chunkId: "n2-later", totalBytes: Buffer.byteLength(whole) * 10,
    });
    const store = {
      listAllCanonicalKeys: async () => [{ ...k, bytes: Buffer.byteLength(whole) }],
      readCanonicalText: async () => whole,
      statCanonical: async () => Buffer.byteLength(whole),
    } as unknown as SessionStore;
    await ageIntents();
    await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false, deepVerifyPerPass: 0,
      intentGraceMs: 60_000,
    });
    expect((await openIntents(k)).length).toBe(1);
  });

  test("an intent inside the grace period is NOT acted on", async () => {
    const k = mk("grace");
    await recordChunkIntent(db, {
      userExternalId: k.userId, family: k.family, sessionId: k.sessionId,
      chunkId: "g1", totalBytes: 99,
    });
    // The index write is deferred BY DESIGN, so a fresh intent is normal traffic.
    // Treating it as loss would make every in-flight chunk look like damage.
    // countStaleIntents is CORPUS-WIDE, and earlier tests in this file leave aged
    // intents behind, so this assertion only means anything on a clean table.
    await db.execute(dsql`delete from hx.chunk_intents`);
    await recordChunkIntent(db, {
      userExternalId: k.userId, family: k.family, sessionId: k.sessionId,
      chunkId: "g1-clean", totalBytes: 99,
    });
    // Fresh: inside any sane grace, so NOT stale — the deferred index write is
    // normal traffic and treating it as loss would flag every in-flight chunk.
    expect(await countStaleIntents(db, 10 * 60 * 1000)).toBe(0);
    await ageIntents();
    expect(await countStaleIntents(db, 60_000)).toBeGreaterThanOrEqual(1);
  });

  test("a lane intent forces the LANE, not just its parent", async () => {
    const k = mk("laneintent");
    await recordChunkIntent(db, {
      userExternalId: k.userId, family: k.family, sessionId: k.sessionId,
      agentExternalId: "agent-x", chunkId: "l1", totalBytes: 500,
    });
    await ageIntents();
    const stale = await staleIntentSessions(db, 60_000, 500);
    const mine = stale.find(
      (x) => x.sessionId === k.sessionId && x.userExternalId === k.userId,
    );
    // Without the agent id the guarantor would repair the parent and leave the
    // lane — a separate canonical with its own turns — still short.
    expect(mine?.agentExternalId).toBe("agent-x");
  });
});
