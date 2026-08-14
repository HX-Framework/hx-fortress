import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql as dsql } from "drizzle-orm";

import { createHxDb, type HxDb } from "../src/host/postgres/db";
import { runMigrations } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";
import { makeMigrationExec } from "../src/host/postgres/sql-exec";
import { ingestAgentCommit, ingestCommit, type IngestAttribution } from "../src/ingest/ingest";
import {
  countUnjudgeableBySize,
  detectUncompactedCanonicals,
  detectByteGaps,
  detectCrossCommitDuplicates,
} from "../src/ingest/health";
import { hxSessions } from "../src/host/postgres/schema/sessions";
import { hxUsers } from "../src/host/postgres/schema/dimensions";
import type { SessionKey } from "../src/modules/session-vault/store/types";

// These detectors exist because the guarantor's own gates cannot see the damage
// they look for. Every assertion below pins a trap that a hand-written version of
// the same query fell into during a real incident — the phantom-gap traps are the
// load-bearing ones, because a detector that cries wolf gets switched off.
const DSN = process.env.FORTRESS_DATABASE_URL;

const TS = "2026-07-01T10:00:00Z";
const ATTR: IngestAttribution = {
  orgExternalId: null,
  projectExternalId: null,
  repoSlug: null,
  deviceId: null,
};

describe.skipIf(!DSN)("corpus health detectors", () => {
  const dsn = DSN as string;
  let db: HxDb;
  beforeAll(async () => {
    await runMigrations(makeMigrationExec(dsn), migrations);
    db = createHxDb(dsn);
  });

  const rec = (t: string, uuid: string) =>
    JSON.stringify({
      type: "user",
      uuid,
      timestamp: TS,
      message: { content: [{ type: "text", text: t }] },
    }) + "\n";
  const key = (tag: string): SessionKey => ({
    userId: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    family: "claude-cli",
    sessionId: crypto.randomUUID(),
  });

  /** The detectors report hx.sessions.id, NOT the client's external session id —
   *  the external id is not unique and its duplicate pairs span orgs (trap 5). */
  const rowId = async (k: SessionKey): Promise<string> => {
    const [r] = await db
      .select({ id: hxSessions.id })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(
        and(
          eq(hxUsers.externalId, k.userId),
          eq(hxSessions.sessionId, k.sessionId),
          // FAMILY IS PART OF IDENTITY. Without it this resolver hits the very trap
          // the detector was fixed for: two rows share (user, session_id) and
          // .limit(1) picks whichever one Postgres feels like.
          eq(hxSessions.family, k.family),
        ),
      )
      .limit(1);
    return r!.id;
  };

  test("TRAP 1: an agent lane must not fabricate a byte gap on its parent", async () => {
    // A lane's totalBytes is ITS canonical's size. Aggregating parent and lane
    // events together compares a parent's watermark against a different object —
    // on production that invented an 8.2 GB gap, more than the whole corpus.
    const k = key("trap1");
    const parent = rec("p1", crypto.randomUUID()) + rec("p2", crypto.randomUUID());
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key: k, chunkId: "t1-p", replace: false, chunkText: parent,
      totalBytes: Buffer.byteLength(parent), componentCount: 1, meta: null, attribution: ATTR,
    });
    // The lane's LATEST chunk: a small delta on a canonical that is already far
    // larger than the parent's. This is the shape that matters — a big
    // `totalBytes` with a small `byteCount`. (A lane whose byteCount is large
    // makes the unscoped sum OVERSHOOT, which reads as "blind" and would let a
    // broken detector pass this test.)
    const laneDelta = rec("l-last", crypto.randomUUID());
    await ingestAgentCommit(db, {
      ingestChannel: "tunnel" as const,
      key: k, agentId: "agent-trap1", chunkId: "t1-a", replace: false, chunkText: laneDelta,
      totalBytes: Buffer.byteLength(parent) * 50, // lane canonical dwarfs the parent
      componentCount: 40, meta: null, attribution: ATTR,
    });

    const report = await detectByteGaps(db, 500);
    // The trap is attributing the LANE's bytes to the PARENT, so the assertion
    // has to name the parent. Matching on sessionId alone cannot express it: a
    // lane row carries its parent's session id and is distinguished by agentId.
    const mineId = await rowId(k);
    const parentRows = report.rows.filter((r) => r.sessionId === mineId && r.agentId === null);
    expect(parentRows).toHaveLength(0);
    // …and the lane's own deficit IS reported, against the lane. The old
    // parents-only detector could not see this at all — six such lanes on
    // production hold real unindexed bytes that nothing else detects.
    const laneRow = report.rows.find(
      (r) => r.sessionId === mineId && r.agentId === "agent-trap1",
    );
    expect(laneRow).toBeDefined();
    expect(laneRow!.unindexedBytes).toBe(
      Buffer.byteLength(parent) * 50 - Buffer.byteLength(laneDelta),
    );
  });

  test("TRAP 5: two sessions sharing an external id are judged SEPARATELY", async () => {
    // Session identity is (user, family, session_id). On production 7 external ids
    // are shared by two rows each and SIX of those pairs span two different ORGS.
    // Grouping on the external id merges their byte accounting across an org
    // boundary — and the merge does not just muddle a number, it MASKS real damage:
    // the clean session's bytes push the pair's sum above the gapped session's
    // claim, so the pair reads "blind" and the gap disappears.
    const shared = crypto.randomUUID();
    const user = `trap5-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const gapped: SessionKey = { userId: user, family: "claude-cli", sessionId: shared };
    const clean: SessionKey = { userId: user, family: "claude-desktop", sessionId: shared };

    const head = rec("h1", crypto.randomUUID());
    const whole = head + rec("h2", crypto.randomUUID()) + rec("h3", crypto.randomUUID());
    // Gapped: indexed only the head but stamped the whole canonical's size.
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key: gapped, chunkId: "t5-gap", replace: false, chunkText: head,
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR,
    });
    // Clean, and LARGER — this is what swallows the gap when the two are merged.
    const big = whole + whole + whole;
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key: clean, chunkId: "t5-clean", replace: false, chunkText: big,
      totalBytes: Buffer.byteLength(big), componentCount: 1, meta: null, attribution: ATTR,
    });

    const report = await detectByteGaps(db, 500);
    const gappedId = await rowId(gapped);
    const cleanId = await rowId(clean);
    const mine = report.rows.find((r) => r.sessionId === gappedId);
    expect(mine).toBeDefined();
    expect(mine!.unindexedBytes).toBe(Buffer.byteLength(whole) - Buffer.byteLength(head));
    expect(report.rows.map((r) => r.sessionId)).not.toContain(cleanId);
  });

  test("TRAP 2: a session the guarantor already repaired must not read as gapped", async () => {
    // A repair is `replace: true` over the WHOLE canonical, so its byteCount IS
    // the closed gap. Filtering `reconcile%` out of the sum re-opens on paper
    // every gap already fixed — 97% of a production finding was this.
    const k = key("trap2");
    const head = rec("h1", crypto.randomUUID());
    const whole = head + rec("h2", crypto.randomUUID()) + rec("h3", crypto.randomUUID());
    // Live chunk indexes only the head but declares the full canonical size:
    // exactly the dropped-write signature this detector is FOR.
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key: k, chunkId: "t2-live", replace: false, chunkText: head,
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR,
    });
    const before = await detectByteGaps(db, 500);
    expect(before.rows.map((r) => r.sessionId)).toContain(await rowId(k));

    // Now the guarantor repairs it, exactly as reconcileOrphans does.
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key: k, chunkId: `reconcile-full:${crypto.randomUUID()}`, replace: true, chunkText: whole,
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR,
      recovered: true, rebuild: true,
    });
    const after = await detectByteGaps(db, 500);
    expect(after.rows.map((r) => r.sessionId)).not.toContain(await rowId(k));
  });

  test("a real dropped write IS reported, with the right byte count", async () => {
    const k = key("gap");
    const head = rec("g1", crypto.randomUUID());
    const whole = head + rec("g2", crypto.randomUUID());
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key: k, chunkId: "gap-1", replace: false, chunkText: head,
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR,
    });
    const report = await detectByteGaps(db, 500);
    const gapId = await rowId(k);
    const mine = report.rows.find((r) => r.sessionId === gapId);
    expect(mine).toBeDefined();
    expect(mine!.unindexedBytes).toBe(Buffer.byteLength(whole) - Buffer.byteLength(head));
  });

  test("TRAP 4: a whole-transcript re-uploader is JUDGED, not written off as blind", async () => {
    // Every commit here writes the WHOLE canonical, so every commit is an epoch
    // boundary and the sum restarts at the last one: claimed == indexed, clean
    // and provable. Summing across those boundaries instead is what made 34.7% of
    // the production corpus unjudgeable — and it got worse with every repair,
    // because a repair IS a whole-canonical write.
    const k = key("epoch");
    // A judged row is proven by the BLIND count not moving. "No gap row" alone
    // cannot express it — a blind row produces no gap row either, so that
    // assertion passes just as well when the scoping is broken.
    const before = (await detectByteGaps(db, 500)).blindSessions;
    const whole = rec("b1", crypto.randomUUID()) + rec("b2", crypto.randomUUID());
    for (const id of ["b-1", "b-2"]) {
      await ingestCommit(db, {
        ingestChannel: "tunnel" as const,
        key: k, chunkId: id, replace: id === "b-1", chunkText: whole,
        totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR,
      });
    }
    const report = await detectByteGaps(db, 500);
    const cleanId = await rowId(k);
    expect(report.rows.filter((r) => r.sessionId === cleanId)).toHaveLength(0); // clean
    expect(report.blindSessions).toBe(before); // and JUDGED, not written off
  });

  test("an OVERLAPPING re-send is still reported BLIND, never clean", async () => {
    // What epoch-scoping does NOT fix, and must not pretend to: a client that
    // re-sends a range it already sent, under a fresh chunk id. The bytes land in
    // the canonical twice while the client's own totalBytes does not move, so the
    // sum overshoots INSIDE one epoch and a gap can never surface. 68 rows on
    // production. Reporting these as healthy would be claiming coverage we lack.
    const k = key("overlap");
    const beforeBlind = (await detectByteGaps(db, 500)).blindSessions;
    const a = rec("o1", crypto.randomUUID());
    const b = rec("o2", crypto.randomUUID());
    // The dedupe guard now REFUSES to index a re-sent record, so this damage
    // can no longer be created through the front door — but production history
    // holds 68 such rows, and the detector must keep finding them. Build the
    // fixture with the guard off: this is a record of the PRE-guard world.
    process.env.FORTRESS_DEDUPE_GUARD_DISABLED = "1";
    try {
      await ingestCommit(db, {
        ingestChannel: "tunnel" as const,
        key: k, chunkId: "o-1", replace: false, chunkText: a,
        totalBytes: Buffer.byteLength(a), componentCount: 1, meta: null, attribution: ATTR,
      });
      for (const id of ["o-2", "o-3"]) {
        await ingestCommit(db, {
          ingestChannel: "tunnel" as const,
          key: k, chunkId: id, replace: false, chunkText: b,
          totalBytes: Buffer.byteLength(a) + Buffer.byteLength(b),
          componentCount: 1, meta: null, attribution: ATTR,
        });
      }
    } finally {
      delete process.env.FORTRESS_DEDUPE_GUARD_DISABLED;
    }
    const report = await detectByteGaps(db, 500);
    expect(report.blindSessions).toBe(beforeBlind + 1); // exactly this session
    expect(report.rows.map((r) => r.sessionId)).not.toContain(await rowId(k));
  });

  test("a canonical that never compacted is reported, never left silent", async () => {
    // GcsStore rewrites in place at 800 components so the counter resets. Six lanes
    // on production reached 2,938 — strictly +1 per append, no reset in the whole
    // life of the object — and nothing reported it for weeks. Byte-intact, so this
    // is a ceiling and cost risk rather than damage; silence is the defect.
    const k = key("uncompacted");
    const t = rec("u1", crypto.randomUUID());
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key: k, chunkId: "u-1", replace: false, chunkText: t,
      totalBytes: Buffer.byteLength(t), componentCount: 1700, meta: null, attribution: ATTR,
    });
    const mineU = await rowId(k);
    const mine = (await detectUncompactedCanonicals(db, 1600)).find(
      (r) => r.sessionId === mineU,
    );
    expect(mine).toBeDefined();
    expect(mine!.componentCount).toBe(1700);
    expect(mine!.agentId).toBeNull();
    // …and a threshold above it reports nothing, so this cannot fire on healthy objects.
    expect(
      (await detectUncompactedCanonicals(db, 5000)).find((r) => r.sessionId === mineU),
    ).toBeUndefined();
  });

  test("cross-commit duplication is caught; same-commit repeats are NOT", async () => {
    // Two commits indexing the SAME source record = a lost replace. One commit
    // carrying a record twice = the canonical's own content, faithfully indexed.
    const dup = key("dup");
    const u = crypto.randomUUID();
    const text = rec("same", u);
    // Same reasoning as the overlap fixture above: the dedupe guard now skips
    // a re-sent record, so the cross-commit shape is built with the guard off —
    // the detector exists precisely for the historical instances.
    process.env.FORTRESS_DEDUPE_GUARD_DISABLED = "1";
    try {
      await ingestCommit(db, {
        ingestChannel: "tunnel" as const,
        key: dup, chunkId: "d-1", replace: false, chunkText: text,
        totalBytes: Buffer.byteLength(text), componentCount: 1, meta: null, attribution: ATTR,
      });
      await ingestCommit(db, {
        ingestChannel: "tunnel" as const,
        key: dup, chunkId: "d-2", replace: false, chunkText: text,
        totalBytes: Buffer.byteLength(text) * 2, componentCount: 2, meta: null, attribution: ATTR,
      });
    } finally {
      delete process.env.FORTRESS_DEDUPE_GUARD_DISABLED;
    }

    const same = key("samecommit");
    // ONE record with TWO content blocks. `classify` gives every block of a
    // record the same `raw`, so both turns carry the SAME uuid from ONE commit —
    // this is the legitimate shape the detector must not flag, and it is why
    // identity alone is insufficient without the `commits > 1` clause.
    //
    // (Two identical text RECORDS would not work: `classify`'s cross-record text
    // dedup collapses them to a single turn, so the fixture would prove nothing.)
    const twice =
      JSON.stringify({
        type: "user",
        uuid: crypto.randomUUID(),
        timestamp: TS,
        message: {
          content: [
            { type: "text", text: "block-one" },
            { type: "text", text: "block-two" },
          ],
        },
      }) + "\n";
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key: same, chunkId: "s-1", replace: false, chunkText: twice,
      totalBytes: Buffer.byteLength(twice), componentCount: 1, meta: null, attribution: ATTR,
    });

    const rows = await detectCrossCommitDuplicates(db, 500);
    const ids = new Set(rows.map((r) => r.sessionId));
    const rowIdOf = async (k: SessionKey) => {
      const [r] = await db
        .select({ id: hxSessions.id })
        .from(hxSessions)
        .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
        .where(and(eq(hxUsers.externalId, k.userId), eq(hxSessions.sessionId, k.sessionId)))
        .limit(1);
      return r!.id;
    };
    expect(ids.has(await rowIdOf(dup))).toBe(true);
    expect(ids.has(await rowIdOf(same))).toBe(false);
  });

  test("over-cap sessions are counted, so a stalled backlog has a visible cause", async () => {
    const k = key("big");
    const t = rec("x", crypto.randomUUID());
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key: k, chunkId: "big-1", replace: false, chunkText: t,
      totalBytes: 5_000_000, componentCount: 1, meta: null, attribution: ATTR,
    });
    expect(await countUnjudgeableBySize(db, 1_000_000)).toBeGreaterThanOrEqual(1);
    expect(await countUnjudgeableBySize(db, 10_000_000_000)).toBe(0);
  });

  test("jsonb columns are string scalars — pinned so a change is deliberate", async () => {
    // If this ever fails, the driver's jsonb encoding changed. That is fine — but
    // every query in health.ts unwraps with #>> '{}' and would then need updating,
    // so it must be a decision, not a surprise.
    const [r] = (await db.execute(dsql`
      select jsonb_typeof(payload) as t from hx.ingest_events limit 1
    `)) as unknown as Array<{ t: string }>;
    expect(r?.t).toBe("string");
  });
});
