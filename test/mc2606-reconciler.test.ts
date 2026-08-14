import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNotNull, isNull, sql as dsql } from "drizzle-orm";

import { createHxDb, type HxDb } from "../src/host/postgres/db";
import { runMigrations } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";
import { makeMigrationExec } from "../src/host/postgres/sql-exec";
import {
  IndexAdvancedError,
  LanePrefixMismatchError,
  ingestAgentCommit,
  ingestCommit,
  type IngestAttribution,
} from "../src/ingest/ingest";
import { markSessionDeleted } from "../src/ingest/delete";
import { reconcileOrphans } from "../src/ingest/reconciler";
import { parseChunk } from "../src/ingest/parse";
import { hxSessionAgents, hxSessions } from "../src/host/postgres/schema/sessions";
import { hxTurns } from "../src/host/postgres/schema/transcript";
import { hxUsers } from "../src/host/postgres/schema/dimensions";
import { canonicalObject, parseCanonicalKey } from "../src/modules/session-vault/store/keys";
import type { SessionKey, SessionStore } from "../src/modules/session-vault/store/types";

// Component G full-restore proof (MC-2606). Runs against a real pgvector Postgres
// when FORTRESS_DATABASE_URL is set; skipped (no failure) otherwise. Run with:
//   FORTRESS_DATABASE_URL=postgres://forge:forge@localhost:5499/hx-db bun test test/mc2606-reconciler.test.ts
const DSN = process.env.FORTRESS_DATABASE_URL;

const TS = "2026-07-01T10:00:00Z";
const ATTR: IngestAttribution = {
  orgExternalId: null,
  projectExternalId: null,
  repoSlug: null,
  deviceId: null,
};

/** A Claude canonical with a real ai-title line + one user + one assistant turn. */
function claudeCanonical(aiTitle: string): string {
  return [
    JSON.stringify({ type: "ai-title", aiTitle }),
    JSON.stringify({
      type: "user",
      timestamp: TS,
      message: { content: [{ type: "text", text: "please summarise the readme" }] },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: TS,
      message: {
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "Done." }],
        usage: { input_tokens: 9, output_tokens: 4 },
      },
    }),
  ].join("\n");
}

/** In-memory store keyed by bucket object name (mirrors GCS/S3 layout). Only
 *  listAllCanonicalKeys + readCanonicalText matter to the reconciler; the rest
 *  are inert stubs. A missing canonical throws NoSuchKey, like the real stores. */
function memStore(canonicals: Map<string, string>): SessionStore {
  return {
    signStagingUpload: async () => ({ url: "", objectName: "", expiresAt: "" }),
    getBucketVersioning: async () => "Enabled",
    getLifecycle: async () => "no lifecycle rules",
    readChunkText: async () => "",
    appendChunkToCanonical: async () => ({ totalBytes: 0, componentCount: 1 }),
    statCanonical: async () => null,
    signCanonicalDownload: async () => ({ url: "", expiresAt: "" }),
    readCanonicalText: async (k: SessionKey) => {
      const text = canonicals.get(canonicalObject(k));
      if (text === undefined) throw new Error("NoSuchKey");
      return text;
    },
    writeCanonicalText: async () => {},
    writeArtifact: async () => {},
    readArtifactText: async () => null,
    listSessionArtifacts: async () => [],
    listSessionMetadata: async () => [],
    selfTest: async () => {},
    deleteSession: async () => ({ complete: true, deleted: 0 }),
    listAllCanonicalKeys: async () => {
      const out: SessionKey[] = [];
      for (const name of canonicals.keys()) {
        const k = parseCanonicalKey(name);
        if (k) out.push(k);
      }
      return out;
    },
  };
}

describe.if(!!DSN)("Component G — reconciler full restore (MC-2606)", () => {
  const dsn = DSN as string;
  const sql = makeMigrationExec(dsn);
  let db: HxDb;

  beforeAll(async () => {
    await runMigrations(sql, migrations);
    db = createHxDb(dsn);
  });

  // Unique per run so the persistent DB is repeatable.
  const suffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const store = (m: Map<string, string>) => memStore(m);

  async function sessionRow(key: SessionKey) {
    const [row] = await db
      .select({
        id: hxSessions.id,
        title: hxSessions.title,
        titleSource: hxSessions.titleSource,
        attributionSource: hxSessions.attributionSource,
        orgId: hxSessions.orgId,
      })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
      .limit(1);
    return row ?? null;
  }

  test("re-indexes a row-less canonical: row + turns + real title + recovered attribution", async () => {
    const s = suffix();
    const key: SessionKey = { userId: `u-${s}`, family: "claude-cli", sessionId: `sess-${s}` };
    const canon = new Map([[canonicalObject(key), claudeCanonical("Restore The README")]]);

    const res = await reconcileOrphans(db, store(canon), {
      batchDelayMs: 0,
      correctExistingTitles: false,
    });
    expect(res.restored).toBe(1);
    expect(res.errors).toBe(0);

    const row = await sessionRow(key);
    expect(row).not.toBeNull();
    expect(row!.title).toBe("Restore The README"); // tier-A ai-title, not the floor
    expect(row!.titleSource).toBe("ai");
    expect(row!.attributionSource).toBe("recovered");
    expect(row!.orgId).toBeNull();

    // Turns were rebuilt (full pipeline, not just a title).
    const turns = await db
      .select({ id: hxTurns.id })
      .from(hxTurns)
      .where(eq(hxTurns.sessionId, row!.id));
    expect(turns.length).toBeGreaterThan(0);
  });

  test("skips a canonical that already has a row (no redundant re-ingest)", async () => {
    const s = suffix();
    const key: SessionKey = { userId: `u-${s}`, family: "claude-cli", sessionId: `sess-${s}` };
    const text = claudeCanonical("Already Indexed");
    // Ingest it normally first (authoritative auto write).
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      attribution: ATTR,
      key,
      chunkId: "c1",
      replace: true,
      chunkText: text,
      totalBytes: Buffer.byteLength(text),
      componentCount: 1,
      meta: null,
    });
    const before = await sessionRow(key);
    expect(before!.attributionSource).toBe("auto");

    const res = await reconcileOrphans(db, store(new Map([[canonicalObject(key), text]])), {
      batchDelayMs: 0,
      correctExistingTitles: false,
    });
    expect(res.restored).toBe(0); // already present ⇒ not re-ingested

    // The authoritative row is untouched (still 'auto', not demoted to 'recovered').
    const after = await sessionRow(key);
    expect(after!.attributionSource).toBe("auto");
  });

  test("never resurrects a tombstoned session", async () => {
    const s = suffix();
    const key: SessionKey = { userId: `u-${s}`, family: "claude-cli", sessionId: `sess-${s}` };
    await markSessionDeleted(db, key);

    const res = await reconcileOrphans(db, store(new Map([[canonicalObject(key), claudeCanonical("Nope")]])), {
      batchDelayMs: 0,
      correctExistingTitles: false,
    });
    expect(res.skippedTombstoned).toBeGreaterThanOrEqual(1);
    expect(res.restored).toBe(0);
    expect(await sessionRow(key)).toBeNull();
  });

  test("restores an agent lane under its parent", async () => {
    const s = suffix();
    const base = `sess-${s}`;
    const key: SessionKey = { userId: `u-${s}`, family: "claude-cli", sessionId: base };
    const laneKey: SessionKey = { userId: key.userId, family: key.family, sessionId: `${base}:a:agent-1` };
    const canon = new Map([
      [canonicalObject(key), claudeCanonical("Parent Session")],
      [canonicalObject(laneKey), claudeCanonical("Parent Session")],
    ]);

    const res = await reconcileOrphans(db, store(canon), { batchDelayMs: 0, correctExistingTitles: false });
    expect(res.restored).toBe(2); // parent + lane

    const parent = await sessionRow(key);
    expect(parent).not.toBeNull();
    const [agent] = await db
      .select({ id: hxSessionAgents.id })
      .from(hxSessionAgents)
      .where(
        and(
          eq(hxSessionAgents.sessionId, parent!.id),
          eq(hxSessionAgents.agentExternalId, "agent-1"),
        ),
      )
      .limit(1);
    expect(agent).toBeTruthy();

    // A second pass is a no-op — both parent and lane are now indexed.
    const res2 = await reconcileOrphans(db, store(canon), { batchDelayMs: 0, correctExistingTitles: false });
    expect(res2.restored).toBe(0);
  });

  test("corrective pass flips an existing fallback title to the real ai-title", async () => {
    const s = suffix();
    const key: SessionKey = { userId: `u-${s}`, family: "claude-cli", sessionId: `sess-${s}` };
    // First ingest with NO real title so the cascade stamps the first-message floor.
    const noTitle = [
      JSON.stringify({ type: "user", timestamp: TS, message: { content: [{ type: "text", text: "floor me" }] } }),
    ].join("\n");
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      attribution: ATTR,
      key,
      chunkId: "c1",
      replace: true,
      chunkText: noTitle,
      totalBytes: Buffer.byteLength(noTitle),
      componentCount: 1,
      meta: null,
    });
    const before = await sessionRow(key);
    expect(before!.titleSource).toBe("fallback");

    // Now the canonical the store holds carries a real ai-title. The reconciler's
    // corrective pass (title-only CAS) should upgrade the fallback row.
    const canon = new Map([[canonicalObject(key), claudeCanonical("The Real Title")]]);
    await reconcileOrphans(db, store(canon), { batchDelayMs: 0, correctExistingTitles: true });

    const after = await sessionRow(key);
    expect(after!.title).toBe("The Real Title");
    expect(after!.titleSource).toBe("ai");
  });

  test("a recovered write no-ops on an already-indexed row (no rebuild, no demote)", async () => {
    const s = suffix();
    const key: SessionKey = { userId: `u-${s}`, family: "claude-cli", sessionId: `sess-${s}` };
    const text = claudeCanonical("Live Owned");
    // An authoritative (auto) write creates the row first.
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      attribution: ATTR,
      key,
      chunkId: "c1",
      replace: true,
      chunkText: text,
      totalBytes: Buffer.byteLength(text),
      componentCount: 1,
      meta: null,
    });
    const before = await sessionRow(key);
    const turnsBefore = await db
      .select({ id: hxTurns.id })
      .from(hxTurns)
      .where(eq(hxTurns.sessionId, before!.id));

    // A recovered (G) write racing the same session must NOT rebuild it — else a
    // concurrent live delta double-counts / gets nuked. It must no-op. Use a
    // LARGER canonical for the recovered write so that a rebuild (the bug) would
    // change the turn count — making the no-op assertion actually discriminating.
    const longerText =
      text +
      "\n" +
      JSON.stringify({
        type: "user",
        timestamp: TS,
        message: { content: [{ type: "text", text: "an extra turn a rebuild would add" }] },
      });
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      attribution: { orgExternalId: null, projectExternalId: null, repoSlug: null, deviceId: null },
      key,
      chunkId: "reconcile",
      replace: true,
      chunkText: longerText,
      totalBytes: Buffer.byteLength(longerText),
      componentCount: 1,
      meta: null,
      recovered: true,
    });
    const after = await sessionRow(key);
    const turnsAfter = await db
      .select({ id: hxTurns.id })
      .from(hxTurns)
      .where(eq(hxTurns.sessionId, after!.id));
    expect(turnsAfter.length).toBe(turnsBefore.length); // no rebuild / duplication
    expect(after!.attributionSource).toBe("auto"); // not demoted to 'recovered'
  });

  test("defers an agent lane when its parent re-ingest throws; retries next sweep", async () => {
    const s = suffix();
    const base = `sess-${s}`;
    const key: SessionKey = { userId: `u-${s}`, family: "claude-cli", sessionId: base };
    const laneKey: SessionKey = { userId: key.userId, family: key.family, sessionId: `${base}:a:agent-1` };
    const text = claudeCanonical("Parent Session");
    const canon = new Map([
      [canonicalObject(key), text],
      [canonicalObject(laneKey), text],
    ]);
    // A store that throws on the PARENT canonical read (transient), lane read OK.
    let failParent = true;
    const flaky: SessionStore = {
      ...memStore(canon),
      readCanonicalText: async (k: SessionKey) => {
        if (failParent && k.sessionId === base) throw new Error("transient store error");
        const t = canon.get(canonicalObject(k));
        if (t === undefined) throw new Error("NoSuchKey");
        return t;
      },
    };

    const r1 = await reconcileOrphans(db, flaky, { batchDelayMs: 0, correctExistingTitles: false });
    expect(r1.errors).toBeGreaterThanOrEqual(1); // parent threw
    expect(r1.deferred).toBeGreaterThanOrEqual(1); // lane deferred, not stubbed
    expect(await sessionRow(key)).toBeNull(); // no title-less parent stub created

    // Store heals → next sweep restores the parent (first) then its lane.
    failParent = false;
    const r2 = await reconcileOrphans(db, flaky, { batchDelayMs: 0, correctExistingTitles: false });
    expect(r2.restored).toBe(2);
    const parent = await sessionRow(key);
    expect(parent).not.toBeNull();
    const [agent] = await db
      .select({ id: hxSessionAgents.id })
      .from(hxSessionAgents)
      .where(
        and(eq(hxSessionAgents.sessionId, parent!.id), eq(hxSessionAgents.agentExternalId, "agent-1")),
      )
      .limit(1);
    expect(agent).toBeTruthy();
  });
});


// A session can be indexed FULLY or NOT AT ALL within one chunk (one
// transaction), but nothing makes chunk N+1 atomic with chunk N — so a commit
// that fails after earlier ones landed leaves an index BEHIND its canonical.
// That row has eventCount > 0, so an existence check calls it indexed and no
// sweep would ever find it. These pin the completeness check that does.
describe.if(!!DSN)("Component G — partially indexed sessions (index behind canonical)", () => {
  const dsn = DSN as string;
  let db: HxDb;
  beforeAll(async () => {
    await runMigrations(makeMigrationExec(dsn), migrations);
    db = createHxDb(dsn);
  });

  const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  /** memStore, but reporting each canonical's SIZE the way a real listing does
   *  (GCS File.metadata.size / S3 Contents[].Size). */
  function sizedStore(canonicals: Map<string, string>): SessionStore {
    const base = memStore(canonicals);
    return {
      ...base,
      listAllCanonicalKeys: async () => {
        const out: Array<SessionKey & { bytes?: number }> = [];
        for (const [name, text] of canonicals) {
          const k = parseCanonicalKey(name);
          if (k) out.push({ ...k, bytes: Buffer.byteLength(text) });
        }
        return out;
      },
    } as SessionStore;
  }

  /** Index only the HEAD of a transcript, then present the store with the WHOLE
   *  thing — exactly the state a failed tail-chunk commit leaves behind. */
  async function halfIndexed(user: string, canonicals: Map<string, string>) {
    const key: SessionKey = { userId: user, family: "claude-cli", sessionId: crypto.randomUUID() };
    const head = JSON.stringify({ type: "user", timestamp: TS, message: { content: [{ type: "text", text: "head" }] } });
    const whole = `${head}\n${JSON.stringify({ type: "user", timestamp: TS, message: { content: [{ type: "text", text: "tail" }] } })}`;
    await ingestCommit(db, {
      key, chunkId: "c1", replace: false, chunkText: head,
      totalBytes: Buffer.byteLength(head), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });
    canonicals.set(canonicalObject(key), whole);
    return key;
  }

  const events = async (key: SessionKey) => {
    const [row] = await db
      .select({ n: hxSessions.eventCount })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
      .limit(1);
    return Number(row?.n ?? 0);
  };

  test("counted as staleIndexes, and repaired by DEFAULT", async () => {
    const canonicals = new Map<string, string>();
    const key = await halfIndexed(`stale-default-${uniq()}`, canonicals);
    expect(await events(key)).toBe(1);

    const res = await reconcileOrphans(db, sizedStore(canonicals), {
      batchDelayMs: 0,
      correctExistingTitles: false,
    });
    expect(res.staleIndexes).toBe(1);
    expect(res.restored).toBe(1);
    // Rebuilt from the WHOLE canonical, through the ordinary restore path.
    expect(await events(key)).toBe(2);
  });

  test("repairStaleIndexes:false still DETECTS — turning repair off never blinds the sweep", async () => {
    const canonicals = new Map<string, string>();
    const key = await halfIndexed(`stale-off-${uniq()}`, canonicals);
    const res = await reconcileOrphans(db, sizedStore(canonicals), {
      batchDelayMs: 0,
      correctExistingTitles: false,
      repairStaleIndexes: false,
    });
    expect(res.staleIndexes).toBe(1);
    expect(res.restored).toBe(0);
    expect(await events(key)).toBe(1);
  });

  test("a store that reports no size is never judged stale", async () => {
    const canonicals = new Map<string, string>();
    const key = await halfIndexed(`stale-nosize-${uniq()}`, canonicals);
    // memStore's listing carries no bytes — absent means "cannot judge", never
    // "rebuild it".
    const res = await reconcileOrphans(db, memStore(canonicals), {
      batchDelayMs: 0,
      correctExistingTitles: false,
    });
    expect(res.staleIndexes).toBe(0);
    expect(await events(key)).toBe(1);
  });

  test("the ceiling refuses a MASS mismatch — a regressed comparison must not re-ingest the corpus", async () => {
    const canonicals = new Map<string, string>();
    const user = `stale-mass-${uniq()}`;
    const keys: SessionKey[] = [];
    for (let i = 0; i < 60; i += 1) keys.push(await halfIndexed(user, canonicals));

    const refused = await reconcileOrphans(db, sizedStore(canonicals), {
      batchDelayMs: 0,
      correctExistingTitles: false,
    });
    expect(refused.staleIndexes).toBe(60);
    expect(refused.restored).toBe(0); // 100% stale — the shape of a broken comparison
    expect(await events(keys[0]!)).toBe(1);

    // …and yields when an operator raises the ceiling deliberately.
    const allowed = await reconcileOrphans(db, sizedStore(canonicals), {
      batchDelayMs: 0,
      correctExistingTitles: false,
      staleRepairCeiling: 1,
    });
    expect(allowed.restored).toBe(60);
    expect(await events(keys[0]!)).toBe(2);
  }, 60_000);

  test("a HANDFUL is always repaired — the ceiling must never strand a small fortress", async () => {
    const canonicals = new Map<string, string>();
    const user = `stale-small-${uniq()}`;
    const key = await halfIndexed(user, canonicals);
    // 1 of 1 is 100%, far above the 0.25 ratio: only the absolute-count floor
    // keeps this repairable, which is the case a ratio-only guard got wrong.
    const res = await reconcileOrphans(db, sizedStore(canonicals), {
      batchDelayMs: 0,
      correctExistingTitles: false,
      staleRepairCeiling: 0,
    });
    expect(res.restored).toBe(1);
    expect(await events(key)).toBe(2);
  });
});


// The integrity contract: after the guarantor touches a session it is FULLY
// indexed, or the pass says so out loud. A tail that lands with a hole behind it
// is the one outcome that must be impossible.
describe.if(!!DSN)("Component G — integrity of a repaired session", () => {
  const dsn = DSN as string;
  let db: HxDb;
  beforeAll(async () => {
    await runMigrations(makeMigrationExec(dsn), migrations);
    db = createHxDb(dsn);
  });

  const rec = (t: string) =>
    JSON.stringify({ type: "user", timestamp: TS, message: { content: [{ type: "text", text: t }] } });

  function sized(canonicals: Map<string, string>): SessionStore {
    return {
      ...memStore(canonicals),
      listAllCanonicalKeys: async () => {
        const out: Array<SessionKey & { bytes?: number }> = [];
        for (const [name, text] of canonicals) {
          const k = parseCanonicalKey(name);
          if (k) out.push({ ...k, bytes: Buffer.byteLength(text) });
        }
        return out;
      },
    } as SessionStore;
  }

  /** Index the first `head` records of an `total`-record transcript, then present
   *  the store with the whole thing. */
  async function halfIndexed(head: number, total: number, canonicals: Map<string, string>) {
    const key: SessionKey = {
      userId: `integrity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      family: "claude-cli",
      sessionId: crypto.randomUUID(),
    };
    const lines = Array.from({ length: total }, (_, i) => rec(`turn ${i}`));
    const prefix = `${lines.slice(0, head).join("\n")}\n`;
    const whole = `${lines.join("\n")}\n`;
    await ingestCommit(db, {
      key, chunkId: "c1", replace: false, chunkText: prefix,
      totalBytes: Buffer.byteLength(prefix), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });
    canonicals.set(canonicalObject(key), whole);
    return { key, whole };
  }

  /** Turn count, max seq and whether the lane is dense (no holes). */
  async function lane(key: SessionKey) {
    const [row] = await db
      .select({ id: hxSessions.id, bytes: hxSessions.bytesUploaded })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
      .limit(1);
    const turns = await db
      .select({ seq: hxTurns.seq })
      .from(hxTurns)
      .where(and(eq(hxTurns.sessionId, row!.id), isNull(hxTurns.agentId)));
    const seqs = turns.map((t) => Number(t.seq)).sort((a, b) => a - b);
    return {
      id: row!.id,
      bytes: Number(row!.bytes ?? 0),
      turns: seqs.length,
      dense: seqs.length === (seqs[seqs.length - 1] ?? -1) + 1,
    };
  }

  test("a cleanly-behind index is repaired by APPENDING the tail, and verified dense", async () => {
    const canonicals = new Map<string, string>();
    const { key, whole } = await halfIndexed(3, 10, canonicals);
    const res = await reconcileOrphans(db, sized(canonicals), { batchDelayMs: 0, correctExistingTitles: false });

    expect(res.repairedTail).toBe(1);
    expect(res.integrityFailures).toBe(0);
    const l = await lane(key);
    expect(l.turns).toBe(10);
    expect(l.dense).toBe(true);
    expect(l.bytes).toBe(Buffer.byteLength(whole));
  });

  test("an index ending MID-RECORD is never sliced — it falls back to a full rebuild", async () => {
    const canonicals = new Map<string, string>();
    const { key, whole } = await halfIndexed(3, 10, canonicals);
    // Claim a prefix length that does not land on a newline: slicing there would
    // append half a record, which is the gap this must never create.
    const l0 = await lane(key);
    await db.update(hxSessions).set({ bytesUploaded: l0.bytes - 7 }).where(eq(hxSessions.id, l0.id));

    const res = await reconcileOrphans(db, sized(canonicals), { batchDelayMs: 0, correctExistingTitles: false });
    expect(res.repairedTail).toBe(0);
    expect(res.repairedFull).toBe(1);
    expect(res.integrityFailures).toBe(0);
    const l = await lane(key);
    expect(l.turns).toBe(10);
    expect(l.dense).toBe(true);
    expect(l.bytes).toBe(Buffer.byteLength(whole));
  });

  test("a stale tail slice is REFUSED when a live commit got there first", async () => {
    // The reconciler cuts a tail at the byte count it saw at scan time, minutes
    // before the repair runs. If a live chunk commits in between, appending that
    // slice re-inserts turns the live write already indexed — and the result is
    // still dense and still covers the canonical, so NOTHING downstream can see
    // it. Without the compare-and-swap this leaves 17 turns where 10 belong.
    const canonicals = new Map<string, string>();
    const { key, whole } = await halfIndexed(3, 10, canonicals);
    const sliceFrom = (await lane(key)).bytes;

    // The live client catches up first.
    await ingestCommit(db, {
      key, chunkId: "live-2", replace: false,
      chunkText: Buffer.from(whole).subarray(sliceFrom).toString("utf8"),
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });
    const live = await lane(key);
    expect(live.turns).toBe(10);

    // Now the guarantor's stale slice arrives, carrying the offset it was cut at.
    let caught: unknown = null;
    try {
      await ingestCommit(db, {
        key, chunkId: "reconcile-tail", replace: false,
        chunkText: Buffer.from(whole).subarray(sliceFrom).toString("utf8"),
        totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
        recovered: true, rebuild: true, expectIndexedBytes: sliceFrom,
      });
    } catch (err) { caught = err; }

    expect(caught).toBeInstanceOf(IndexAdvancedError);
    expect((caught as IndexAdvancedError).expected).toBe(sliceFrom);
    expect((caught as IndexAdvancedError).actual).toBe(live.bytes);

    const after = await lane(key);
    expect(after.turns).toBe(10);   // not 17
    expect(after.dense).toBe(true);
  });

  test("a session that grew UNDER the sweep is complete, not damaged", async () => {
    // Production produced exactly this: a live chunk landed between the repair and
    // the verification, leaving the row AHEAD of the canonical size captured when
    // the pass started. Treating "not equal" as damage reported healthy sessions
    // as integrity failures and re-indexed them every sweep.
    const canonicals = new Map<string, string>();
    const { key } = await halfIndexed(10, 10, canonicals);
    const l0 = await lane(key);
    // The row covers MORE than the canonical the store reports.
    await db.update(hxSessions).set({ bytesUploaded: l0.bytes + 5_000 }).where(eq(hxSessions.id, l0.id));

    const res = await reconcileOrphans(db, sized(canonicals), { batchDelayMs: 0, correctExistingTitles: false });
    expect(res.staleIndexes).toBe(0);       // ahead is not behind
    expect(res.repairedTail).toBe(0);
    expect(res.repairedFull).toBe(0);
    expect(res.integrityFailures).toBe(0);  // and it is certainly not a failure
    const l = await lane(key);
    expect(l.turns).toBe(10);               // untouched
    expect(l.dense).toBe(true);
  });

  test("a hole in the MIDDLE is detected by seq density — bytes alone cannot see it", async () => {
    const canonicals = new Map<string, string>();
    const { key } = await halfIndexed(10, 10, canonicals); // fully indexed…
    const l0 = await lane(key);
    expect(l0.dense).toBe(true);
    // …then lose one turn from the middle. bytes_uploaded still matches the
    // canonical exactly, so the byte comparison reports nothing wrong.
    await db.delete(hxTurns).where(and(eq(hxTurns.sessionId, l0.id), isNull(hxTurns.agentId), eq(hxTurns.seq, 4)));
    expect((await lane(key)).dense).toBe(false);

    const res = await reconcileOrphans(db, sized(canonicals), { batchDelayMs: 0, correctExistingTitles: false });
    expect(res.gappedLanes).toBe(1);
    expect(res.staleIndexes).toBe(0); // byte counts agree — density is what caught it
    expect(res.repairedFull).toBe(1); // a hole cannot be appended away
    expect(res.integrityFailures).toBe(0);

    const l = await lane(key);
    expect(l.turns).toBe(10);
    expect(l.dense).toBe(true);
  });
});


// The guarantor's correctness contract. Each of these encodes a defect that
// reached production or was one deploy away from it.
describe.if(!!DSN)("Component G — repair can always run, and can never destroy", () => {
  const dsn = DSN as string;
  let db: HxDb;
  beforeAll(async () => {
    await runMigrations(makeMigrationExec(dsn), migrations);
    db = createHxDb(dsn);
  });

  const rec = (t: string) =>
    JSON.stringify({ type: "user", timestamp: TS, message: { content: [{ type: "text", text: t }] } });
  const body = (n: number) => `${Array.from({ length: n }, (_, i) => rec(`turn ${i}`)).join("\n")}\n`;
  const repairKey = () => `reconcile-full:${crypto.randomUUID()}`;

  async function seed(nHead: number) {
    const key: SessionKey = {
      userId: `contract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      family: "claude-cli",
      sessionId: crypto.randomUUID(),
    };
    const head = body(nHead);
    await ingestCommit(db, {
      key, chunkId: "c1", replace: false, chunkText: head,
      totalBytes: Buffer.byteLength(head), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });
    return { key, headBytes: Buffer.byteLength(head) };
  }
  async function lane(key: SessionKey) {
    const [row] = await db
      .select({ id: hxSessions.id, bytes: hxSessions.bytesUploaded })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
      .limit(1);
    const turns = await db
      .select({ seq: hxTurns.seq })
      .from(hxTurns)
      .where(and(eq(hxTurns.sessionId, row!.id), isNull(hxTurns.agentId)));
    return { bytes: Number(row!.bytes ?? 0), turns: turns.length };
  }

  test("a session can be rebuilt MORE THAN ONCE — the constant repair key froze it forever", async () => {
    const { key } = await seed(5);
    const whole = body(5);
    const opts = {
      replace: true as const, chunkText: whole, totalBytes: Buffer.byteLength(whole),
      componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const, recovered: true as const, rebuild: true as const,
    };
    const first = await ingestCommit(db, { key, chunkId: repairKey(), ...opts });
    const second = await ingestCommit(db, { key, chunkId: repairKey(), ...opts });
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(true);
    expect((await lane(key)).turns).toBe(5);
  });

  test("a commit that does NOTHING says so — a dedupe hit is not success", async () => {
    const { key } = await seed(3);
    const whole = body(3);
    const opts = {
      chunkId: "a-fixed-key", replace: true as const, chunkText: whole,
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null,
      attribution: ATTR, ingestChannel: "tunnel" as const, recovered: true as const, rebuild: true as const,
    };
    expect((await ingestCommit(db, { key, ...opts })).applied).toBe(true);
    const again = await ingestCommit(db, { key, ...opts });
    expect(again.applied).toBe(false);
    expect(again).toMatchObject({ reason: "deduped" });
  });

  test("bytes_uploaded is MONOTONE on append — a replayed chunk cannot regress it", async () => {
    // The regression is what lets a later tail repair slice from an offset the
    // lane has already passed, duplicating turns invisibly.
    const { key, headBytes } = await seed(3);
    const whole = body(10);
    await ingestCommit(db, {
      key, chunkId: "c2", replace: false,
      chunkText: Buffer.from(whole).subarray(headBytes).toString("utf8"),
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });
    const live = await lane(key);
    await ingestCommit(db, {
      key, chunkId: "c1-replay", replace: false, chunkText: "",
      totalBytes: headBytes, componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });
    expect((await lane(key)).bytes).toBe(live.bytes);
  });

  test("a tail sliced from a stale prefix is REFUSED — the byte CAS alone cannot see it", async () => {
    const { key, headBytes } = await seed(3);
    const whole = body(10);
    await ingestCommit(db, {
      key, chunkId: "c2", replace: false,
      chunkText: Buffer.from(whole).subarray(headBytes).toString("utf8"),
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });
    const before = await lane(key);
    let caught: unknown = null;
    try {
      await ingestCommit(db, {
        key, chunkId: `reconcile-tail:${crypto.randomUUID()}`, replace: false,
        chunkText: Buffer.from(whole).subarray(headBytes).toString("utf8"),
        totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
        recovered: true, rebuild: true,
        // Both sides agree — and both are wrong. Only the turn count catches it.
        expectIndexedBytes: before.bytes, expectPriorTurns: 3,
      });
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(LanePrefixMismatchError);
    expect((await lane(key)).turns).toBe(before.turns);
  });

  test("a stale full rebuild cannot WIPE turns a live commit just wrote", async () => {
    const { key, headBytes } = await seed(3);
    const scanBytes = headBytes; // what the sweep observed before reading the canonical
    const whole = body(10);
    await ingestCommit(db, {
      key, chunkId: "live-later", replace: false,
      chunkText: Buffer.from(whole).subarray(headBytes).toString("utf8"),
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });
    const live = await lane(key);
    const stale = body(3);
    let caught: unknown = null;
    try {
      await ingestCommit(db, {
        key, chunkId: `reconcile-full:${crypto.randomUUID()}`, replace: true, chunkText: stale,
        totalBytes: Buffer.byteLength(stale), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
        recovered: true, rebuild: true, expectIndexedBytes: scanBytes,
      });
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(IndexAdvancedError);
    // Without the CAS this lane would be back to 3 turns, permanently.
    expect((await lane(key)).turns).toBe(live.turns);
  });
});


// Agent lanes hold ~a third of all indexed content and were existence-only: a
// half-indexed lane was undetectable, and repairing one was a silent no-op
// because ingestAgentCommit's recovered guard had no rebuild override.
describe.if(!!DSN)("Component G — agent lanes are checked and repaired like parents", () => {
  const dsn = DSN as string;
  let db: HxDb;
  beforeAll(async () => {
    await runMigrations(makeMigrationExec(dsn), migrations);
    db = createHxDb(dsn);
  });

  const rec = (t: string) =>
    JSON.stringify({ type: "user", timestamp: TS, message: { content: [{ type: "text", text: t }] } });
  const body = (n: number) => `${Array.from({ length: n }, (_, i) => rec(`t${i}`)).join("\n")}\n`;
  const AGENT = "agent-1";

  test("lane verification measures the LANE's canonical, not the parent's", async () => {
    // The lane row is found via the parent key, but the object to re-measure is
    // the `sid:a:agentId` composite. Statting the parent instead compares a lane
    // against the wrong file: with a parent BIGGER than the lane it reports a
    // healthy lane as an integrity failure, and with the far commoner tiny parent
    // it passes trivially and verifies nothing at all.
    const key: SessionKey = {
      userId: `lanestat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      family: "claude-cli",
      sessionId: crypto.randomUUID(),
    };
    const parentText = body(20); // deliberately MUCH larger than the lane
    const laneHead = body(2);
    const laneWhole = body(8);
    await ingestCommit(db, {
      key, chunkId: "p1", replace: false, chunkText: parentText,
      totalBytes: Buffer.byteLength(parentText), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });
    await ingestAgentCommit(db, {
      key, agentId: AGENT, chunkId: "a1", replace: false, chunkText: laneHead,
      totalBytes: Buffer.byteLength(laneHead), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });
    const store = {
      listAllCanonicalKeys: async () => [
        { ...key, bytes: Buffer.byteLength(parentText) },
        { ...key, sessionId: `${key.sessionId}:a:${AGENT}`, bytes: Buffer.byteLength(laneWhole) },
      ],
      readCanonicalText: async (k: SessionKey) =>
        k.sessionId.includes(":a:") ? laneWhole : parentText,
      statCanonical: async (k: SessionKey) =>
        Buffer.byteLength(k.sessionId.includes(":a:") ? laneWhole : parentText),
    } as unknown as SessionStore;

    const res = await reconcileOrphans(db, store, { batchDelayMs: 0, correctExistingTitles: false });
    // Statting the parent would make the repaired lane (768 B) look short of the
    // parent canonical (~1.9 kB) and report a false integrity failure.
    expect(res.integrityFailures).toBe(0);
    expect(res.repairedFull).toBeGreaterThanOrEqual(1);
  });

  test("a canonical that parses to NOTHING is restored once, not every pass forever", async () => {
    // Unique repair keys removed an accidental loop-breaker: a zero-event row is
    // excluded by the INDEXED gate, so it looks orphaned again next pass. Under
    // the old constant key iteration 2+ was a free no-op; now every iteration is
    // a real replace txn, a fresh ingest-event row, and a slot of the per-pass
    // repair cap — every hour, indefinitely.
    const key: SessionKey = {
      userId: `empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      family: "claude-cli",
      sessionId: crypto.randomUUID(),
    };
    // Must parse to ZERO events. An unknown record type still counts as one
    // event, so the row keeps event_count > 0 and never enters the loop; a
    // whitespace-only canonical is the real shape (bytes > 0, nothing to index).
    const nothing = "\n\n\n";
    const canonicals = new Map<string, string>([[canonicalObject(key), nothing]]);
    const store = {
      ...memStore(canonicals),
      listAllCanonicalKeys: async () => [{ ...key, bytes: Buffer.byteLength(nothing) }],
      statCanonical: async () => Buffer.byteLength(nothing),
    } as unknown as SessionStore;

    const first = await reconcileOrphans(db, store, { batchDelayMs: 0, correctExistingTitles: false });
    const second = await reconcileOrphans(db, store, { batchDelayMs: 0, correctExistingTitles: false });
    const third = await reconcileOrphans(db, store, { batchDelayMs: 0, correctExistingTitles: false });

    expect(first.restored).toBe(1);
    // …and then it must stop. A loop here silently eats the repair budget.
    expect(second.restored).toBe(0);
    expect(third.restored).toBe(0);
    // It is still EXAMINED each pass (the decision is now made on parsed content,
    // which requires the read) — but it does no work and writes nothing.
    expect(second.emptyCanonicals).toBe(1);
    expect(second.noOpRepairs).toBe(0);
  });

  test("a partially indexed LANE is detected and fully repaired", async () => {
    const key: SessionKey = {
      userId: `lane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      family: "claude-cli",
      sessionId: crypto.randomUUID(),
    };
    const parentText = body(4);
    const laneHead = body(2);
    const laneWhole = body(8);

    await ingestCommit(db, {
      key, chunkId: "p1", replace: false, chunkText: parentText,
      totalBytes: Buffer.byteLength(parentText), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });
    await ingestAgentCommit(db, {
      key, agentId: AGENT, chunkId: "a1", replace: false, chunkText: laneHead,
      totalBytes: Buffer.byteLength(laneHead), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });

    const laneState = async () => {
      const [row] = await db
        .select({ id: hxSessionAgents.id, bytes: hxSessionAgents.bytesUploaded })
        .from(hxSessionAgents)
        .innerJoin(hxSessions, eq(hxSessions.id, hxSessionAgents.sessionId))
        .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
        .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
        .limit(1);
      const turns = await db
        .select({ seq: hxTurns.seq })
        .from(hxTurns)
        .where(eq(hxTurns.agentId, row!.id));
      return { bytes: Number(row!.bytes ?? 0), turns: turns.length };
    };
    const before = await laneState();
    expect(before.turns).toBe(2);

    // The store holds the WHOLE lane transcript; the index holds only its head.
    const store = {
      listAllCanonicalKeys: async () => [
        { ...key, bytes: Buffer.byteLength(parentText) },
        { ...key, sessionId: `${key.sessionId}:a:${AGENT}`, bytes: Buffer.byteLength(laneWhole) },
      ],
      readCanonicalText: async (k: SessionKey) =>
        k.sessionId.includes(":a:") ? laneWhole : parentText,
      statCanonical: async (k: SessionKey) =>
        Buffer.byteLength(k.sessionId.includes(":a:") ? laneWhole : parentText),
    } as unknown as SessionStore;

    const res = await reconcileOrphans(db, store, { batchDelayMs: 0, correctExistingTitles: false });

    expect(res.staleIndexes).toBeGreaterThanOrEqual(1);
    expect(res.noOpRepairs).toBe(0);        // the old recovered guard made this a no-op
    expect(res.integrityFailures).toBe(0);  // …and it is verified now, not assumed

    const after = await laneState();
    expect(after.turns).toBe(8);
    expect(after.bytes).toBe(Buffer.byteLength(laneWhole));
  });
});


// The two directions of the empty-canonical skip. Getting the second one wrong
// trades an hourly wasted write for silent data loss.
describe.if(!!DSN)("Component G — a zero-event row is only ignored when the canonical really is empty", () => {
  const dsn = DSN as string;
  let db: HxDb;
  beforeAll(async () => {
    await runMigrations(makeMigrationExec(dsn), migrations);
    db = createHxDb(dsn);
  });
  const rec = (t: string) =>
    JSON.stringify({ type: "user", timestamp: TS, message: { content: [{ type: "text", text: t }] } });
  const body = (n: number) => `${Array.from({ length: n }, (_, i) => rec(`t${i}`)).join("\n")}\n`;

  async function zeroEventRowOver(canonicalText: string, declaredBytes: number | null) {
    const key: SessionKey = {
      userId: `mask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      family: "claude-cli",
      sessionId: crypto.randomUUID(),
    };
    // A committed chunk that parses to nothing, but claims to cover everything —
    // the shape that makes covering bytes a lie about emptiness.
    await ingestCommit(db, {
      key, chunkId: "c1", replace: false, chunkText: "\n\n",
      totalBytes: Math.max(declaredBytes ?? 0, Buffer.byteLength(canonicalText)),
      componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });
    const canonicals = new Map<string, string>([[canonicalObject(key), canonicalText]]);
    const store = {
      ...memStore(canonicals),
      listAllCanonicalKeys: async () => [
        declaredBytes === null ? { ...key } : { ...key, bytes: declaredBytes },
      ],
      statCanonical: async () => Buffer.byteLength(canonicalText),
    } as unknown as SessionStore;
    const turns = async () => {
      const [row] = await db
        .select({ id: hxSessions.id })
        .from(hxSessions)
        .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
        .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
        .limit(1);
      const t = await db
        .select({ seq: hxTurns.seq })
        .from(hxTurns)
        .where(and(eq(hxTurns.sessionId, row!.id), isNull(hxTurns.agentId)));
      return t.length;
    };
    return { key, store, turns };
  }

  test("REAL CONTENT behind a covering zero-event row is RESTORED, never skipped", async () => {
    const real = body(6);
    const { store, turns } = await zeroEventRowOver(real, Buffer.byteLength(real));
    expect(await turns()).toBe(0); // indexed as nothing, bytes claim full coverage

    const res = await reconcileOrphans(db, store, { batchDelayMs: 0, correctExistingTitles: false });
    // Deciding on bytes alone would skip this forever and lose 6 records.
    expect(res.emptyCanonicals).toBe(0);
    expect(await turns()).toBe(6);
  });

  test("an UNKNOWN canonical size never takes the skip", async () => {
    const real = body(4);
    const { store, turns } = await zeroEventRowOver(real, null);
    const res = await reconcileOrphans(db, store, { batchDelayMs: 0, correctExistingTitles: false });
    expect(res.emptyCanonicals).toBe(0);
    expect(await turns()).toBe(4);
  });
});

// The lane twin of the parent guard. Without the eventCount clause the repair of
// a content-less lane dies at the guard instead of the gates above it.
describe.if(!!DSN)("Component G — a content-less LANE row does not block its own repair", () => {
  const dsn = DSN as string;
  let db: HxDb;
  beforeAll(async () => {
    await runMigrations(makeMigrationExec(dsn), migrations);
    db = createHxDb(dsn);
  });
  const rec = (t: string) =>
    JSON.stringify({ type: "user", timestamp: TS, message: { content: [{ type: "text", text: t }] } });
  const body = (n: number) => `${Array.from({ length: n }, (_, i) => rec(`t${i}`)).join("\n")}\n`;
  const AGENT = "agent-x";

  test("zero-event lane row + content-bearing lane canonical → repaired", async () => {
    const key: SessionKey = {
      userId: `laneguard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      family: "claude-cli",
      sessionId: crypto.randomUUID(),
    };
    const parentText = body(3);
    const laneWhole = body(5);
    await ingestCommit(db, {
      key, chunkId: "p1", replace: false, chunkText: parentText,
      totalBytes: Buffer.byteLength(parentText), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });
    // A lane commit that parses to NOTHING leaves a zero-event lane row.
    await ingestAgentCommit(db, {
      key, agentId: AGENT, chunkId: "a1", replace: false, chunkText: "\n\n",
      totalBytes: 2, componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });

    const laneTurns = async () => {
      const [row] = await db
        .select({ id: hxSessionAgents.id })
        .from(hxSessionAgents)
        .innerJoin(hxSessions, eq(hxSessions.id, hxSessionAgents.sessionId))
        .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
        .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
        .limit(1);
      if (!row) return -1;
      const t = await db.select({ seq: hxTurns.seq }).from(hxTurns).where(eq(hxTurns.agentId, row.id));
      return t.length;
    };
    expect(await laneTurns()).toBe(0);

    const store = {
      listAllCanonicalKeys: async () => [
        { ...key, bytes: Buffer.byteLength(parentText) },
        { ...key, sessionId: `${key.sessionId}:a:${AGENT}`, bytes: Buffer.byteLength(laneWhole) },
      ],
      readCanonicalText: async (k: SessionKey) =>
        k.sessionId.includes(":a:") ? laneWhole : parentText,
      statCanonical: async (k: SessionKey) =>
        Buffer.byteLength(k.sessionId.includes(":a:") ? laneWhole : parentText),
    } as unknown as SessionStore;

    const res = await reconcileOrphans(db, store, { batchDelayMs: 0, correctExistingTitles: false });
    // Without the eventCount clause on the lane guard this is a recovered_skip
    // every pass and the lane stays empty forever.
    expect(res.noOpRepairs).toBe(0);
    expect(await laneTurns()).toBe(5);
  });
});


// The one untested data-safety behaviour left after pass 4: a tail that applies
// and then fails verification must NOT rebuild from text read before the growth
// that caused the failure — that deletes the new content.
describe.if(!!DSN)("Component G — a canonical growing mid-repair defers the rebuild", () => {
  const dsn = DSN as string;
  let db: HxDb;
  beforeAll(async () => {
    await runMigrations(makeMigrationExec(dsn), migrations);
    db = createHxDb(dsn);
  });
  const rec = (t2: string) =>
    JSON.stringify({ type: "user", timestamp: TS, message: { content: [{ type: "text", text: t2 }] } });
  const body = (n: number) => `${Array.from({ length: n }, (_, i) => rec(`t${i}`)).join("\n")}\n`;

  test("the tail lands, the canonical has grown, and the rebuild stands down", async () => {
    const key: SessionKey = {
      userId: `grew-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      family: "claude-cli",
      sessionId: crypto.randomUUID(),
    };
    const head = body(3);
    const atScan = body(8);   // what the pass listed and read
    const grown = body(12);   // what the store holds by verify time
    await ingestCommit(db, {
      key, chunkId: "c1", replace: false, chunkText: head,
      totalBytes: Buffer.byteLength(head), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });

    const store = {
      listAllCanonicalKeys: async () => [{ ...key, bytes: Buffer.byteLength(atScan) }],
      readCanonicalText: async () => atScan,
      // Verification and the escalation guard both re-measure, and by then the
      // canonical is larger than the pass ever saw.
      statCanonical: async () => Buffer.byteLength(grown),
    } as unknown as SessionStore;

    const turns = async () => {
      const [row] = await db
        .select({ id: hxSessions.id })
        .from(hxSessions)
        .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
        .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
        .limit(1);
      const x = await db
        .select({ seq: hxTurns.seq })
        .from(hxTurns)
        .where(and(eq(hxTurns.sessionId, row!.id), isNull(hxTurns.agentId)));
      return x.length;
    };

    const res = await reconcileOrphans(db, store, { batchDelayMs: 0, correctExistingTitles: false });

    // The tail appended and then failed verification against the grown canonical…
    expect(res.verifyFallbacks).toBe(1);
    // …and the rebuild stood down rather than reinstating the pre-growth prefix.
    expect(res.liveRaces).toBe(1);
    expect(res.repairedFull).toBe(0);
    expect(res.integrityFailures).toBe(0);
    // The tail's 8 records are intact — a rebuild from `atScan` would also give 8,
    // so the load-bearing assertion is that nothing was DELETED and no false
    // integrity failure was reported.
    expect(await turns()).toBe(8);
  });

  // The prod shape behind "SESSION STILL INCOMPLETE after a full rebuild" on a
  // session that was in fact whole: the store's stat reports more bytes than its
  // read hands back (a canonical holding non-UTF-8 bytes re-encodes shorter, and
  // a capped/truncated download returns short outright). The rebuild indexes
  // everything it was given, densely — yet a stat-vs-read comparison can never be
  // satisfied, so the old code re-ran a full rebuild every pass, forever, and
  // reported permanent damage. It must be named for what it is instead.
  test("a stat that exceeds the read is a shortRead, not an integrity failure", async () => {
    const key: SessionKey = {
      userId: `short-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      family: "claude-cli",
      sessionId: crypto.randomUUID(),
    };
    const text = body(6);
    const readBytes = Buffer.byteLength(text);
    const STAT = readBytes + 219; // what the object claims; never changes

    const store = {
      listAllCanonicalKeys: async () => [{ ...key, bytes: STAT }],
      readCanonicalText: async () => text,
      statCanonical: async () => STAT,
    } as unknown as SessionStore;

    const res = await reconcileOrphans(db, store, { batchDelayMs: 0, correctExistingTitles: false });

    expect(res.restored).toBe(1);
    expect(res.shortReads).toBe(1);
    // The two counters this must NOT land in: it is neither damage nor a live race.
    expect(res.integrityFailures).toBe(0);
    expect(res.liveRaces).toBe(0);

    // Every record the store actually returned is indexed, densely.
    const [row] = await db
      .select({ id: hxSessions.id, bytes: hxSessions.bytesUploaded })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
      .limit(1);
    const rows = await db
      .select({ seq: hxTurns.seq })
      .from(hxTurns)
      .where(and(eq(hxTurns.sessionId, row!.id), isNull(hxTurns.agentId)));
    expect(rows.length).toBe(6);
    // The watermark records the bytes we really indexed — never the stat we could
    // not read. Inflating it to STAT would be the guarantor lying about coverage.
    expect(Number(row!.bytes)).toBe(readBytes);
  });

  // A tail append must stamp the watermark with the bytes it actually indexed,
  // never with the size the store CLAIMS the object is. Recording the stat while
  // holding only the read marks a partial session complete: the staleness gate
  // stops selecting it, no later pass revisits it, and the shortfall becomes
  // permanently invisible. Partial-and-marked-done is corruption.
  test("a tail append never stamps a watermark it did not index", async () => {
    const key: SessionKey = {
      userId: `wm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      family: "claude-cli",
      sessionId: crypto.randomUUID(),
    };
    const head = body(4);
    const read = body(10);            // everything the store hands back
    const readBytes = Buffer.byteLength(read);
    const STAT = readBytes + 4096;    // what the store CLAIMS it holds

    await ingestCommit(db, {
      key, chunkId: "wm-c1", replace: false, chunkText: head,
      totalBytes: Buffer.byteLength(head), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });

    const store = {
      listAllCanonicalKeys: async () => [{ ...key, bytes: STAT }],
      readCanonicalText: async () => read,
      statCanonical: async () => STAT,
    } as unknown as SessionStore;

    await reconcileOrphans(db, store, { batchDelayMs: 0, correctExistingTitles: false });

    const [row] = await db
      .select({ id: hxSessions.id, bytes: hxSessions.bytesUploaded })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
      .limit(1);

    // The load-bearing assertion: the watermark equals the bytes indexed, NOT the
    // stat. At STAT the row would read as fully covered and never be revisited.
    expect(Number(row!.bytes)).toBe(readBytes);
    expect(Number(row!.bytes)).toBeLessThan(STAT);

    // And the content really is all there.
    const rows = await db
      .select({ seq: hxTurns.seq })
      .from(hxTurns)
      .where(and(eq(hxTurns.sessionId, row!.id), isNull(hxTurns.agentId)));
    expect(rows.length).toBe(10);
  });

  // THE case the byte gate cannot see. A canonical holding 9 records indexed as
  // 6 is seq-dense (0..5, no holes) and its watermark covers the canonical, so
  // the staleness gate never selects it and every detector calls it healthy.
  // Only the canonical's own record count reveals it.
  test("the count sweep finds records missing from a session the byte gate calls healthy", async () => {
    const key: SessionKey = {
      userId: `deep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      family: "claude-cli",
      sessionId: crypto.randomUUID(),
    };
    const whole = body(9);
    const short = body(6);

    // Index only 6 records but stamp the FULL canonical size — the exact shape a
    // lost middle chunk leaves behind: dense, byte-covering, and 3 records light.
    await ingestCommit(db, {
      key, chunkId: "deep-c1", replace: false, chunkText: short,
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });

    // Key-aware: this suite shares one database, so a store that answered for
    // EVERY session would make the sweep judge unrelated rows against this
    // canonical and trip the systematic-bug ceiling.
    const store = {
      listAllCanonicalKeys: async () => [{ ...key, bytes: Buffer.byteLength(whole) }],
      readCanonicalText: async (k: SessionKey) => {
        if (k.sessionId !== key.sessionId) throw new Error("not this test's session");
        return whole;
      },
      statCanonical: async () => Buffer.byteLength(whole),
    } as unknown as SessionStore;

    const rowOf = async () => {
      const [r] = await db
        .select({ id: hxSessions.id })
        .from(hxSessions)
        .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
        .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
        .limit(1);
      const t = await db
        .select({ seq: hxTurns.seq })
        .from(hxTurns)
        .where(and(eq(hxTurns.sessionId, r!.id), isNull(hxTurns.agentId)));
      return t.length;
    };

    // Pre-state: byte-covering and dense, so the ordinary path has nothing to do.
    expect(await rowOf()).toBe(6);
    const blind = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false,
    });
    expect(blind.staleIndexes).toBe(0);   // the byte gate sees nothing wrong…
    expect(await rowOf()).toBe(6);        // …and nothing is repaired

    // With the sweep on, the count is the authority.
    const swept = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false, deepVerifyPerPass: 1000 /* shared DB: exceed the accumulated corpus */,
    });
    expect(swept.deepMismatched).toBeGreaterThanOrEqual(1);
    expect(swept.deepRepaired).toBeGreaterThanOrEqual(1);
    expect(await rowOf()).toBe(9); // the three missing records are now indexed
  });

  // A healthy session must be proven and then LEFT ALONE — the sweep must not
  // rewrite the corpus just because it is looking at it.
  test("the count sweep stamps a matching session and rebuilds nothing", async () => {
    const key: SessionKey = {
      userId: `deepok-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      family: "claude-cli",
      sessionId: crypto.randomUUID(),
    };
    const whole = body(7);
    await ingestCommit(db, {
      key, chunkId: "deepok-c1", replace: false, chunkText: whole,
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });
    const store = {
      listAllCanonicalKeys: async () => [{ ...key, bytes: Buffer.byteLength(whole) }],
      readCanonicalText: async (k: SessionKey) => {
        if (k.sessionId !== key.sessionId) throw new Error("not this test's session");
        return whole;
      },
      statCanonical: async () => Buffer.byteLength(whole),
    } as unknown as SessionStore;

    const [pre] = await db
      .select({ id: hxSessions.id })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
      .limit(1);
    const idsBefore = (
      await db
        .select({ id: hxTurns.id })
        .from(hxTurns)
        .where(and(eq(hxTurns.sessionId, pre!.id), isNull(hxTurns.agentId)))
    )
      .map((r) => r.id)
      .sort();

    const res = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false, deepVerifyPerPass: 1000 /* shared DB: exceed the accumulated corpus */,
    });
    // Counters are corpus-wide and this suite shares one database, so the
    // load-bearing assertions are about THIS session: it stays exactly as it
    // was, and it gets stamped.
    expect(res.deepVerified).toBeGreaterThanOrEqual(1);

    const [me] = await db
      .select({ id: hxSessions.id })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
      .limit(1);
    const mine = await db
      .select({ seq: hxTurns.seq, id: hxTurns.id })
      .from(hxTurns)
      .where(and(eq(hxTurns.sessionId, me!.id), isNull(hxTurns.agentId)));
    expect(mine.length).toBe(7);
    // Turn COUNT alone would survive a bug that rebuilt every matching session,
    // so pin identity and the repair counters too: a replace would mint new ids.
    expect(res.deepRepaired).toBe(0);
    expect(res.deepMismatched).toBe(0);
    expect(mine.map((r) => r.id).sort()).toEqual(idsBefore);

    // Proven means stamped, so the rotation moves on instead of re-reading it.
    const [row] = await db
      .select({ at: hxSessions.deepVerifiedAt })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
      .limit(1);
    expect(row!.at).not.toBeNull();
  });

  // A repair that fails to reach the canonical's count must NOT be stamped —
  // stamping would retire a still-damaged session from the sweep, which is the
  // exact failure the sweep exists to prevent.
  test("the count sweep never stamps a session it could not make whole", async () => {
    const key: SessionKey = {
      userId: `deepfail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      family: "claude-cli",
      sessionId: crypto.randomUUID(),
    };
    const indexed = body(4);
    await ingestCommit(db, {
      key, chunkId: "deepfail-c1", replace: false, chunkText: indexed,
      totalBytes: Buffer.byteLength(indexed), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });
    // An unreadable canonical: the sweep cannot prove anything, so it must
    // record the failure and leave the row unstamped for the next pass.
    const store = {
      listAllCanonicalKeys: async () => [],
      readCanonicalText: async () => { throw new Error("canonical unreadable"); },
      statCanonical: async () => Buffer.byteLength(indexed),
    } as unknown as SessionStore;

    const res = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false, deepVerifyPerPass: 1000 /* shared DB: exceed the accumulated corpus */,
    });
    expect(res.deepErrors).toBeGreaterThanOrEqual(1);

    const [row] = await db
      .select({ at: hxSessions.deepVerifiedAt })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
      .limit(1);
    expect(row!.at).toBeNull();
  });

  // Agent lanes are SEPARATE canonical objects with their own rows and their own
  // turns — rebuilding the parent does not re-derive a byte of them. A sweep
  // that skipped lanes would leave every agent transcript unverifiable.
  test("the count sweep proves agent lanes too, not just parents", async () => {
    const sessionId = crypto.randomUUID();
    const agentId = "agent-sweep-1";
    const key: SessionKey = {
      userId: `lane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      family: "claude-cli",
      sessionId,
    };
    // Store key carries the :a: suffix; the commit key is the bare session id.
    const laneStoreKey: SessionKey = { ...key, sessionId: `${sessionId}:a:${agentId}` };
    const parent = body(3);
    const laneWhole = body(8);
    const laneShort = body(5);

    await ingestCommit(db, {
      key, chunkId: "lane-p1", replace: false, chunkText: parent,
      totalBytes: Buffer.byteLength(parent), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });
    // The lane lands SHORT but stamped with the full canonical size — dense,
    // byte-covering, three records missing. Invisible to every byte check.
    await ingestAgentCommit(db, {
      key, agentId, chunkId: "lane-a1", replace: false, chunkText: laneShort,
      totalBytes: Buffer.byteLength(laneWhole), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });

    const store = {
      listAllCanonicalKeys: async () => [],
      readCanonicalText: async (k: SessionKey) => {
        if (k.sessionId === laneStoreKey.sessionId) return laneWhole;
        if (k.sessionId === sessionId) return parent;
        throw new Error("not this test's session");
      },
      statCanonical: async () => Buffer.byteLength(laneWhole),
    } as unknown as SessionStore;

    const laneTurns = async () => {
      const [srow] = await db
        .select({ id: hxSessions.id })
        .from(hxSessions)
        .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
        .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, sessionId)))
        .limit(1);
      const [lrow] = await db
        .select({ id: hxSessionAgents.id })
        .from(hxSessionAgents)
        .where(
          and(
            eq(hxSessionAgents.sessionId, srow!.id),
            eq(hxSessionAgents.agentExternalId, agentId),
          ),
        )
        .limit(1);
      const t = await db
        .select({ seq: hxTurns.seq })
        .from(hxTurns)
        .where(and(eq(hxTurns.sessionId, srow!.id), eq(hxTurns.agentId, lrow!.id)));
      return t.length;
    };

    expect(await laneTurns()).toBe(5);
    const res = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false,
      deepVerifyPerPass: 1000 /* shared DB: exceed the accumulated corpus */,
    });
    expect(res.deepMismatched).toBeGreaterThanOrEqual(1);
    expect(await laneTurns()).toBe(8); // the lane's missing records are indexed
  });

  // Repair is the lower-priority workload — it must yield to live ingest rather
  // than add load to a pool that is already starved.
  test("a saturated live pool stands the pass down instead of competing", async () => {
    const key: SessionKey = {
      userId: `sat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      family: "claude-cli",
      sessionId: crypto.randomUUID(),
    };
    const whole = body(6);
    const store = {
      listAllCanonicalKeys: async () => [{ ...key, bytes: Buffer.byteLength(whole) }],
      readCanonicalText: async () => whole,
      statCanonical: async () => Buffer.byteLength(whole),
    } as unknown as SessionStore;

    const res = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false,
      deepVerifyPerPass: 1000,
      isSaturated: () => true,
    });

    expect(res.yieldedToLive).toBeGreaterThanOrEqual(1);
    expect(res.restored).toBe(0);      // nothing rebuilt while live is starved
    expect(res.deepVerified).toBe(0);  // and the sweep's extra reads never happen

    // The orphan is still there, untouched, for a healthier pass to pick up.
    const rows = await db
      .select({ id: hxSessions.id })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)));
    expect(rows.length).toBe(0);
  });

  // C1 REGRESSION. parseChunk is stateful across the whole text, so a lane BUILT
  // by appending chunks legally holds MORE turns than parse(whole) yields — a
  // Codex lane appended as 3 turns parses whole to 1. Treating parse(whole) as
  // an equality oracle made the sweep classify every such session as duplicated
  // and rebuild it with replace:true, destroying its embeddings, every rotation,
  // forever. The count is a LOWER BOUND and nothing more.
  test("an append-built lane holding MORE turns than parse(whole) is never rebuilt", async () => {
    const key: SessionKey = {
      userId: `over-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      family: "codex-cli",
      sessionId: crypto.randomUUID(),
    };
    const ri = (t: string, role: string) =>
      JSON.stringify({
        type: "response_item", timestamp: TS,
        payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text: t }] },
      }) + "\n";
    const ev = JSON.stringify({
      type: "event_msg", timestamp: TS, payload: { type: "agent_message", message: "c" },
    }) + "\n";
    const c1 = ri("a", "assistant") + ri("b", "user");
    const c2 = ev;
    const whole = c1 + c2;

    // Ingested as two appends, exactly as live traffic arrives.
    await ingestCommit(db, {
      key, chunkId: "ov-1", replace: false, chunkText: c1,
      totalBytes: Buffer.byteLength(c1), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });
    await ingestCommit(db, {
      key, chunkId: "ov-2", replace: false, chunkText: c2,
      totalBytes: Buffer.byteLength(whole), componentCount: 2, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });

    const rowOf = async () => {
      const [r] = await db
        .select({ id: hxSessions.id })
        .from(hxSessions)
        .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
        .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
        .limit(1);
      return db
        .select({ id: hxTurns.id })
        .from(hxTurns)
        .where(and(eq(hxTurns.sessionId, r!.id), isNull(hxTurns.agentId)));
    };
    const before = (await rowOf()).map((r) => r.id).sort();
    // The premise: appending really does yield more turns than parse(whole).
    expect(before.length).toBeGreaterThan(parseChunk(whole).turns.length);

    const store = {
      listAllCanonicalKeys: async () => [],
      readCanonicalText: async (k: SessionKey) => {
        if (k.sessionId !== key.sessionId) throw new Error("not this test's session");
        return whole;
      },
      statCanonical: async () => Buffer.byteLength(whole),
    } as unknown as SessionStore;

    const res = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false, deepVerifyPerPass: 1000,
    });

    // Reported, never acted on — and the turns are the SAME rows, not reinserted.
    expect(res.deepOvercount).toBeGreaterThanOrEqual(1);
    expect(res.deepMismatched).toBe(0);
    expect(res.deepRepaired).toBe(0);
    expect((await rowOf()).map((r) => r.id).sort()).toEqual(before);
  });

  // A lane whose whole-canonical parse COLLAPSES (Codex: response_item turns are
  // dropped once an event_msg appears) legitimately holds MORE turns than
  // parse(whole) when built by appending. The tail repair must ACCEPT that.
  //
  // Converging it instead — which is what demanding parse(whole) here does —
  // rebuilds a session that is exactly what was asked for, destroys its
  // embeddings, and does it again next pass: for Codex the parse collapses on
  // essentially every assistant turn, so the tail fast path would be dead for
  // the whole family and every stale repair a full rebuild. The divergence is
  // recorded as `laneDrift` rather than acted on.
  test("a collapsing lane's tail is accepted, not rebuilt, and stays stable", async () => {
    const key: SessionKey = {
      userId: `converge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      family: "codex-cli",
      sessionId: crypto.randomUUID(),
    };
    const ri = (t: string, role: string) =>
      JSON.stringify({
        type: "response_item",
        timestamp: TS,
        payload: {
          type: "message",
          role,
          content: [{ type: role === "user" ? "input_text" : "output_text", text: t }],
        },
      }) + "\n";
    const ev = (m: string) =>
      JSON.stringify({ type: "event_msg", timestamp: TS, payload: { type: "agent_message", message: m } }) + "\n";
    const head = ri("a", "assistant") + ri("b", "user");
    const tail = ev("c");
    const whole = head + tail;
    const appended = parseChunk(head).turns.length + parseChunk(tail).turns.length;
    // The premise: appending yields strictly more than a whole parse.
    expect(appended).toBeGreaterThan(parseChunk(whole).turns.length);

    await ingestCommit(db, {
      key, chunkId: "cv-1", replace: false, chunkText: head,
      totalBytes: Buffer.byteLength(head), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });

    const store = {
      listAllCanonicalKeys: async () => [{ ...key, bytes: Buffer.byteLength(whole) }],
      readCanonicalText: async (k: SessionKey) => {
        if (k.sessionId !== key.sessionId) throw new Error("not this test's session");
        return whole;
      },
      statCanonical: async () => Buffer.byteLength(whole),
    } as unknown as SessionStore;

    const turns = async () => {
      const [r] = await db
        .select({ id: hxSessions.id })
        .from(hxSessions)
        .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
        .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
        .limit(1);
      return (
        await db.select({ id: hxTurns.id }).from(hxTurns)
          .where(and(eq(hxTurns.sessionId, r!.id), isNull(hxTurns.agentId)))
      ).map((x) => x.id).sort();
    };

    const res = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false, deepVerifyPerPass: 0,
    });

    // The tail landed on the FAST path — no rebuild, no destroyed embeddings.
    expect(res.repairedTail).toBe(1);
    expect(res.repairedFull).toBe(0);
    expect(res.verifyFallbacks).toBe(0);
    // …and the divergence from the whole parse is recorded, not hidden.
    expect(res.laneDrift).toBe(1);
    const after = await turns();
    expect(after.length).toBe(appended);

    // Stable: a second pass finds nothing to do and rewrites nothing. This is
    // where a permanent rebuild + re-embed loop would show up.
    const again = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false, deepVerifyPerPass: 0,
    });
    expect(again.repairedFull).toBe(0);
    expect(again.staleIndexes).toBe(0);
    expect(await turns()).toEqual(after);
  });

  // The rotation cursor is the thing that stops an unprovable row parking itself
  // at the head of the queue forever. Pin that a FAILED check still advances it
  // while leaving the row unverified.
  test("a row the sweep cannot check still advances the rotation cursor", async () => {
    const key: SessionKey = {
      userId: `cursor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      family: "claude-cli",
      sessionId: crypto.randomUUID(),
    };
    const text = body(4);
    await ingestCommit(db, {
      key, chunkId: "cu-1", replace: false, chunkText: text,
      totalBytes: Buffer.byteLength(text), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });
    const store = {
      listAllCanonicalKeys: async () => [],
      readCanonicalText: async () => { throw new Error("canonical unreadable"); },
      statCanonical: async () => null,
    } as unknown as SessionStore;

    const res = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false, deepVerifyPerPass: 1000,
    });
    expect(res.deepErrors).toBeGreaterThanOrEqual(1);

    const [row] = await db
      .select({ ok: hxSessions.deepVerifiedAt, tried: hxSessions.deepAttemptedAt })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
      .limit(1);
    // Never claimed as checked-clean…
    expect(row!.ok).toBeNull();
    // …but the cursor MOVED, or this row sits at the head of the queue forever
    // and the sweep never reaches another one.
    expect(row!.tried).not.toBeNull();
  });

  // The stand-down must happen before the pass does any work at all — a check
  // after the bulk gate protects nothing, the database has already paid.
  test("a saturated pass issues no queries and lists no canonicals", async () => {
    let listed = 0;
    const store = {
      listAllCanonicalKeys: async () => { listed += 1; return []; },
      readCanonicalText: async () => { throw new Error("must not read"); },
      statCanonical: async () => null,
    } as unknown as SessionStore;

    const res = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false,
      deepVerifyPerPass: 1000, isSaturated: () => true,
    });

    expect(res.yieldedToLive).toBe(1);   // one stand-down is one event
    expect(res.scanned).toBe(0);         // the bulk gate never ran
    expect(listed).toBe(0);              // the bucket was never listed
    expect(res.deepVerifyBacklog).toBeNull();
  });

  // C1-DELTA. Moving the stat BEFORE the read left growth in the stat->read
  // window uncovered: the text in hand is newer than the watermark it is judged
  // against, so a healthy session reads as `actual < expected` and gets rebuilt
  // — deleting live turns, after which the deferred gateway commit lands and
  // duplicates them, all stamped verified. The arm that used to catch this was
  // `statBytes > readBytes`; moving the stat inverted the comparison.
  test("a canonical that grows between the stat and the read is never judged", async () => {
    const key: SessionKey = {
      userId: `statgrow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      family: "claude-cli",
      sessionId: crypto.randomUUID(),
    };
    const indexed = body(4);
    const grown = body(9); // what the READ returns, after a compose lands
    await ingestCommit(db, {
      key, chunkId: "sg-1", replace: false, chunkText: indexed,
      totalBytes: Buffer.byteLength(indexed), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });

    // A canonical that really grew stats SMALL before the compose lands and
    // LARGE afterwards. Modelling it with a constant stat would be untruthful —
    // and would let a "growth" test silently pass through the lossy-decode path
    // instead, which is the opposite verdict.
    let stats = 0;
    const store = {
      listAllCanonicalKeys: async () => [],
      statCanonical: async () => {
        stats += 1;
        return stats === 1 ? Buffer.byteLength(indexed) : Buffer.byteLength(grown);
      },
      readCanonicalText: async (k: SessionKey) => {
        if (k.sessionId !== key.sessionId) throw new Error("not this test's session");
        return grown;
      },
    } as unknown as SessionStore;

    const ids = async () => {
      const [r] = await db
        .select({ id: hxSessions.id })
        .from(hxSessions)
        .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
        .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
        .limit(1);
      return (
        await db.select({ id: hxTurns.id }).from(hxTurns)
          .where(and(eq(hxTurns.sessionId, r!.id), isNull(hxTurns.agentId)))
      ).map((x) => x.id).sort();
    };
    const before = await ids();

    const res = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false, deepVerifyPerPass: 1000,
    });

    // Deferred, not judged: no false damage, no rebuild, same rows.
    expect(res.liveRaces).toBeGreaterThanOrEqual(1);
    // The direct statement of "never judged" — the other two only imply it for
    // this particular fixture.
    expect(res.deepVerified).toBe(0);
    expect(res.deepMismatched).toBe(0);
    expect(res.deepRepaired).toBe(0);
    expect(await ids()).toEqual(before);

    // And not stamped — it is still owed a real check.
    const [row] = await db
      .select({ ok: hxSessions.deepVerifiedAt, tried: hxSessions.deepAttemptedAt })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
      .limit(1);
    expect(row!.ok).toBeNull();
    expect(row!.tried).not.toBeNull();
  });

  // The lane sweep carries a hand-copied twin of the growth guard — different
  // stamp function, different key, different row. Untested, it is exactly what
  // a later round regresses silently.
  test("a LANE canonical that grows between stat and read is never judged", async () => {
    const sessionId = crypto.randomUUID();
    const agentId = "agent-grow-1";
    const key: SessionKey = {
      userId: `lanegrow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      family: "claude-cli",
      sessionId,
    };
    const parent = body(2);
    const laneIndexed = body(4);
    const laneGrown = body(9);

    await ingestCommit(db, {
      key, chunkId: "lg-p", replace: false, chunkText: parent,
      totalBytes: Buffer.byteLength(parent), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });
    await ingestAgentCommit(db, {
      key, agentId, chunkId: "lg-a", replace: false, chunkText: laneIndexed,
      totalBytes: Buffer.byteLength(laneIndexed), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });

    const laneStoreId = `${sessionId}:a:${agentId}`;
    let laneStats = 0;
    const store = {
      listAllCanonicalKeys: async () => [],
      statCanonical: async (k: SessionKey) => {
        if (k.sessionId !== laneStoreId) return Buffer.byteLength(parent);
        laneStats += 1;
        return laneStats === 1 ? Buffer.byteLength(laneIndexed) : Buffer.byteLength(laneGrown);
      },
      readCanonicalText: async (k: SessionKey) => {
        if (k.sessionId === laneStoreId) return laneGrown; // the read sees the growth
        if (k.sessionId === sessionId) return parent;
        throw new Error("not this test's session");
      },
    } as unknown as SessionStore;

    const laneRows = async () => {
      const [srow] = await db
        .select({ id: hxSessions.id })
        .from(hxSessions)
        .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
        .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, sessionId)))
        .limit(1);
      const [lrow] = await db
        .select({ id: hxSessionAgents.id, ok: hxSessionAgents.deepVerifiedAt, tried: hxSessionAgents.deepAttemptedAt })
        .from(hxSessionAgents)
        .where(and(eq(hxSessionAgents.sessionId, srow!.id), eq(hxSessionAgents.agentExternalId, agentId)))
        .limit(1);
      const turns = await db
        .select({ id: hxTurns.id })
        .from(hxTurns)
        .where(and(eq(hxTurns.sessionId, srow!.id), eq(hxTurns.agentId, lrow!.id)));
      return { lrow: lrow!, ids: turns.map((t) => t.id).sort() };
    };
    const before = await laneRows();

    const res = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false, deepVerifyPerPass: 1000,
    });

    expect(res.liveRaces).toBeGreaterThanOrEqual(1);
    expect(res.deepRepaired).toBe(0);
    const after = await laneRows();
    expect(after.ids).toEqual(before.ids);   // the lane was not rebuilt
    expect(after.lrow.ok).toBeNull();        // and not claimed as checked
    expect(after.lrow.tried).not.toBeNull(); // but the rotation advanced
  });

  // A canonical holding non-UTF-8 bytes reads LARGER than its object (U+FFFD is
  // three bytes) — permanently, on every pass. Deferring it as "growth" would
  // retire the session from the only detector that sees a missing middle
  // record, forever, under a counter that says transient. It must be judged:
  // U+FFFD never replaces a newline, so the record count is unaffected.
  test("a canonical that merely decodes larger is judged, not deferred forever", async () => {
    const key: SessionKey = {
      userId: `lossy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      family: "claude-cli",
      sessionId: crypto.randomUUID(),
    };
    const whole = body(9);
    const short = body(4);
    // Byte-covering watermark over a lane holding only part of the records —
    // the sweep's exact target damage.
    await ingestCommit(db, {
      key, chunkId: "lo-1", replace: false, chunkText: short,
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });

    const store = {
      listAllCanonicalKeys: async () => [],
      // The object is SMALLER than what the read returns, and stays that size:
      // a stable lossy decode, not growth.
      statCanonical: async () => Buffer.byteLength(whole) - 2,
      readCanonicalText: async (k: SessionKey) => {
        if (k.sessionId !== key.sessionId) throw new Error("not this test's session");
        return whole;
      },
    } as unknown as SessionStore;

    const res = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false, deepVerifyPerPass: 1000,
    });

    // Judged and repaired — NOT filed away as a live race.
    expect(res.deepVerified).toBeGreaterThanOrEqual(1);
    expect(res.deepMismatched).toBeGreaterThanOrEqual(1);
    expect(res.deepRepaired).toBeGreaterThanOrEqual(1);
  });

  // The sweep must yield MID-FLIGHT, not just at the door. Checking saturation
  // once before it starts still lets it issue a hundred canonical reads and a
  // hundred 40-115s rebuilds however starved live ingest becomes.
  test("the count sweep stops mid-flight when the live pool goes saturated", async () => {
    const made: SessionKey[] = [];
    for (let i = 0; i < 4; i++) {
      const key: SessionKey = {
        userId: `midyield-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
        family: "claude-cli",
        sessionId: crypto.randomUUID(),
      };
      const t = body(3);
      await ingestCommit(db, {
        key, chunkId: `my-${i}`, replace: false, chunkText: t,
        totalBytes: Buffer.byteLength(t), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
      });
      made.push(key);
    }

    // Saturation appears after the first canonical is read.
    let reads = 0;
    let saturated = false;
    const store = {
      listAllCanonicalKeys: async () => [],
      readCanonicalText: async () => {
        reads += 1;
        saturated = true;
        return body(3);
      },
      statCanonical: async () => Buffer.byteLength(body(3)),
    } as unknown as SessionStore;

    const res = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false,
      deepVerifyPerPass: 1000,
      isSaturated: () => saturated,
    });

    // It stopped instead of working through the rest of the corpus.
    expect(reads).toBe(1);
    expect(res.yieldedToLive).toBe(1);
    expect(made.length).toBe(4); // (the corpus really was larger than one row)
  });

  // C1-ROUND-4. The gateway acks a chunk once the canonical is composed and
  // DEFERS the indexing, so there is a real window where the canonical holds
  // records the index has not seen. In that window a count check sees
  // `actual < expected` and cannot distinguish it from missing records — and
  // answering with replace:true deletes a healthy lane and its embeddings, after
  // which the deferred commit lands and re-appends, DUPLICATING it. The sweep
  // only judges byte-COVERING rows; behind-ness belongs to the byte gate.
  test("a session merely behind its canonical is left for the byte gate, not rebuilt", async () => {
    const key: SessionKey = {
      userId: `behind-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      family: "claude-cli",
      sessionId: crypto.randomUUID(),
    };
    const indexed = body(4);
    const whole = body(9); // the canonical is ahead — the commit has not run yet
    await ingestCommit(db, {
      key, chunkId: "bh-1", replace: false, chunkText: indexed,
      totalBytes: Buffer.byteLength(indexed), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });

    const store = {
      // Not listed as an orphan: the byte gate is not part of this test.
      listAllCanonicalKeys: async () => [],
      readCanonicalText: async (k: SessionKey) => {
        if (k.sessionId !== key.sessionId) throw new Error("not this test's session");
        return whole;
      },
      statCanonical: async () => Buffer.byteLength(whole),
    } as unknown as SessionStore;

    const ids = async () => {
      const [r] = await db
        .select({ id: hxSessions.id })
        .from(hxSessions)
        .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
        .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
        .limit(1);
      return (
        await db.select({ id: hxTurns.id }).from(hxTurns)
          .where(and(eq(hxTurns.sessionId, r!.id), isNull(hxTurns.agentId)))
      ).map((x) => x.id).sort();
    };
    const before = await ids();

    const res = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false, deepVerifyPerPass: 1000,
    });

    // No false damage report, no rebuild, and the SAME rows are still there.
    expect(res.deepMismatched).toBe(0);
    expect(res.deepRepaired).toBe(0);
    expect(await ids()).toEqual(before);

    // Not stamped as checked — it is still owed a real check once it catches up.
    const [row] = await db
      .select({ ok: hxSessions.deepVerifiedAt, tried: hxSessions.deepAttemptedAt })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
      .limit(1);
    expect(row!.ok).toBeNull();
    expect(row!.tried).not.toBeNull();
  });

  // Without a stat there is no corroboration, so a truncated read is
  // indistinguishable from a smaller canonical. Stamping such a row "checked" is
  // PERMANENT: the backlog counts only NULL stamps, so a false clean never comes
  // off and the convergence number is wrong forever.
  test("a canonical whose size cannot be stat'd is never stamped as checked", async () => {
    const key: SessionKey = {
      userId: `nostat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      family: "claude-cli",
      sessionId: crypto.randomUUID(),
    };
    const indexed = body(6);
    const real = body(9); // the store really holds more than we can read
    await ingestCommit(db, {
      key, chunkId: "ns-1", replace: false, chunkText: indexed,
      totalBytes: Buffer.byteLength(real), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });
    const store = {
      listAllCanonicalKeys: async () => [],
      readCanonicalText: async (k: SessionKey) => {
        if (k.sessionId !== key.sessionId) throw new Error("not this test's session");
        return indexed; // a SHORT read — undetectable without a stat
      },
      statCanonical: async () => null,
    } as unknown as SessionStore;

    const res = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false, deepVerifyPerPass: 1000,
    });
    expect(res.deepErrors).toBeGreaterThanOrEqual(1);

    const [row] = await db
      .select({ ok: hxSessions.deepVerifiedAt, tried: hxSessions.deepAttemptedAt })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
      .limit(1);
    expect(row!.ok).toBeNull();        // never claimed as checked
    expect(row!.tried).not.toBeNull(); // but the rotation still advanced
  });

  // The documented emergency brake must actually brake the sweep's writes.
  test("REPAIR_STALE=false leaves the count sweep detecting but not writing", async () => {
    const key: SessionKey = {
      userId: `brake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      family: "claude-cli",
      sessionId: crypto.randomUUID(),
    };
    const whole = body(9);
    const short = body(6);
    await ingestCommit(db, {
      key, chunkId: "br-1", replace: false, chunkText: short,
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });
    const store = {
      listAllCanonicalKeys: async () => [],
      readCanonicalText: async (k: SessionKey) => {
        if (k.sessionId !== key.sessionId) throw new Error("not this test's session");
        return whole;
      },
      statCanonical: async () => Buffer.byteLength(whole),
    } as unknown as SessionStore;

    const turns = async () => {
      const [r] = await db
        .select({ id: hxSessions.id })
        .from(hxSessions)
        .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
        .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
        .limit(1);
      return (
        await db.select({ seq: hxTurns.seq }).from(hxTurns)
          .where(and(eq(hxTurns.sessionId, r!.id), isNull(hxTurns.agentId)))
      ).length;
    };

    const res = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false,
      deepVerifyPerPass: 1000, repairStaleIndexes: false,
    });
    expect(res.deepMismatched).toBeGreaterThanOrEqual(1); // detection still runs
    expect(res.deepRepaired).toBe(0);                     // and nothing is written
    expect(await turns()).toBe(6);
  });

  // "Is the corpus whole?" is only answerable if you can see how much of it has
  // never been looked at. A clean pass over a slice proves nothing about the
  // rest, so the backlog is the number that makes convergence observable.
  test("the backlog reports what has never been proven, and falls as the sweep runs", async () => {
    const key: SessionKey = {
      userId: `backlog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      family: "claude-cli",
      sessionId: crypto.randomUUID(),
    };
    const whole = body(5);
    await ingestCommit(db, {
      key, chunkId: "bk-c1", replace: false, chunkText: whole,
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR, ingestChannel: "tunnel" as const,
    });
    const store = {
      listAllCanonicalKeys: async () => [],
      readCanonicalText: async (k: SessionKey) => {
        if (k.sessionId !== key.sessionId) throw new Error("not this test's session");
        return whole;
      },
      statCanonical: async () => Buffer.byteLength(whole),
    } as unknown as SessionStore;

    // A pass that proves NOTHING still reports the backlog, so an operator can
    // never mistake "found nothing" for "everything is verified".
    // Sweep disabled: the backlog was not MEASURED, and "not measured" must be
    // reported as such. Rendering it 0 would be the strongest possible claim
    // made after looking at nothing.
    const idle = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false, deepVerifyPerPass: 0,
    });
    expect(idle.deepVerified).toBe(0);
    expect(idle.deepVerifyBacklog).toBeNull();

    // A pass that stood down for load must report "not measured", NEVER 0 —
    // `0` is the value that means "the corpus is fully proven", and printing it
    // after measuring nothing is the exact misreading this counter exists to
    // prevent.
    const saturated = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false,
      deepVerifyPerPass: 1000, isSaturated: () => true,
    });
    expect(saturated.deepVerifyBacklog).toBeNull();

    // A pass that actually ran the sweep reports a real number.
    const swept = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false,
      deepVerifyPerPass: 1000 /* shared DB: exceed the accumulated corpus */,
    });
    expect(swept.deepVerifyBacklog).not.toBeNull();
    // …and a second sweep, having checked more rows, cannot report a larger one.
    const again = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false, deepVerifyPerPass: 1000,
    });
    expect(again.deepVerifyBacklog as number).toBeLessThanOrEqual(
      swept.deepVerifyBacklog as number,
    );
  });
});


// The count sweep detects correctly and then REFUSES to act. Both halves of the
// 2026-08-10 production starvation: a ceiling whose denominator was the rows
// judged so far (so any contiguous damaged cluster armed it on its tenth row —
// a flat 9 repairs per pass for three days) and counters SHARED with the lane
// sweep that runs after it (so lanes repaired exactly zero, ever).
describe.if(!!DSN)("Component G — the sweep's brakes must not starve repair", () => {
  const dsn = DSN as string;
  let db: HxDb;
  beforeAll(async () => {
    await runMigrations(makeMigrationExec(dsn), migrations);
    db = createHxDb(dsn);
  });

  const rec = (t: string) =>
    JSON.stringify({ type: "user", timestamp: TS, message: { content: [{ type: "text", text: t }] } });
  const body = (n: number) => `${Array.from({ length: n }, (_, i) => rec(`turn ${i}`)).join("\n")}\n`;
  const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const AGENT = "agent-ceiling";

  /** This suite shares ONE database, so every row any earlier test left behind is
   *  a sweep candidate. Park them all: the ceiling is a ratio, and a ratio is
   *  only testable when the denominator is the pass this test actually built. */
  async function parkEverything() {
    const stamp = new Date().toISOString();
    await db.update(hxSessions).set({ deepVerifiedAt: stamp }).where(isNull(hxSessions.deepVerifiedAt));
    await db
      .update(hxSessionAgents)
      .set({ deepVerifiedAt: stamp })
      .where(isNull(hxSessionAgents.deepVerifiedAt));
  }

  async function turnsOf(key: SessionKey, lane: boolean): Promise<number> {
    const [r] = await db
      .select({ id: hxSessions.id })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
      .limit(1);
    const rows = await db
      .select({ seq: hxTurns.seq })
      .from(hxTurns)
      .where(
        lane
          ? and(eq(hxTurns.sessionId, r!.id), isNull(hxTurns.agentId))
          : and(eq(hxTurns.sessionId, r!.id), isNull(hxTurns.agentId)),
      );
    if (!lane) return rows.length;
    const laneRows = await db
      .select({ seq: hxTurns.seq })
      .from(hxTurns)
      .where(eq(hxTurns.sessionId, r!.id));
    return laneRows.length - rows.length;
  }

  /** Indexed 6 of 9 records but stamped the FULL canonical size: dense,
   *  byte-covering, three records light — invisible to every gate but the count. */
  async function damagedParent(user: string, i: number, short: string, whole: string) {
    const key: SessionKey = { userId: user, family: "claude-cli", sessionId: crypto.randomUUID() };
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key, chunkId: `dmg-${i}-${uniq()}`, replace: false, chunkText: short,
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR,
    });
    return key;
  }

  test("a MINORITY of mismatches ALL repair — the denominator is the pass, not the prefix", async () => {
    await parkEverything();
    const user = `deepmin-${uniq()}`;
    const whole = body(9);
    const short = body(6);

    const damaged: SessionKey[] = [];
    for (let i = 0; i < 12; i += 1) damaged.push(await damagedParent(user, i, short, whole));

    const healthy: SessionKey[] = [];
    for (let i = 0; i < 14; i += 1) {
      const key: SessionKey = { userId: user, family: "claude-cli", sessionId: crypto.randomUUID() };
      await ingestCommit(db, {
        ingestChannel: "tunnel" as const,
        key, chunkId: `ok-${i}-${uniq()}`, replace: false, chunkText: whole,
        totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR,
      });
      healthy.push(key);
    }

    // Give the HEALTHY rows a cursor and leave the damaged ones without one:
    // `deep_attempted_at NULLS FIRST` then puts all 12 mismatches at the HEAD of
    // the pass. That contiguity is precisely what armed the old ceiling — with the
    // damage interleaved instead, the prefix ratio never tripped and the bug hid.
    for (const k of healthy) {
      await db
        .update(hxSessions)
        .set({ deepAttemptedAt: new Date(Date.now() - 600_000).toISOString() })
        .where(eq(hxSessions.sessionId, k.sessionId));
    }

    const all = [...damaged, ...healthy];
    const store = {
      listAllCanonicalKeys: async () => all.map((k) => ({ ...k, bytes: Buffer.byteLength(whole) })),
      readCanonicalText: async (k: SessionKey) => {
        if (!all.some((x) => x.sessionId === k.sessionId)) throw new Error("not this test's session");
        return whole;
      },
      statCanonical: async () => Buffer.byteLength(whole),
    } as unknown as SessionStore;

    const res = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false, deepVerifyPerPass: all.length,
    });

    // 12 of 26 is 46%: under the ratio, so every mismatch must be repaired. The
    // prefix denominator made this 9 repaired / 3 refused.
    expect(res.deepMismatched).toBe(12);
    expect(res.deepRepaired).toBe(12);
    expect(res.deepRefused).toBe(0);
    for (const k of damaged) expect(await turnsOf(k, false)).toBe(9);
  }, 180_000);

  test("the lane sweep gets its OWN ceiling — a tripped parent sweep must not refuse every lane", async () => {
    await parkEverything();
    const user = `deeplane-${uniq()}`;
    const whole = body(9);
    const short = body(6);

    // A 100% mismatched parent pass, which SHOULD trip the parent ceiling — that
    // part is correct and is not what this test is about.
    for (let i = 0; i < 12; i += 1) await damagedParent(user, i, short, whole);

    // A healthy parent carrying one damaged lane. The lane is a separate canonical
    // with its own row; rebuilding parents re-derives none of it.
    const laneKey: SessionKey = { userId: user, family: "claude-cli", sessionId: crypto.randomUUID() };
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key: laneKey, chunkId: `lp-${uniq()}`, replace: false, chunkText: whole,
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR,
    });
    await ingestAgentCommit(db, {
      ingestChannel: "tunnel" as const,
      key: laneKey, agentId: AGENT, chunkId: `l1-${uniq()}`, replace: false, chunkText: short,
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR,
    });
    expect(await turnsOf(laneKey, true)).toBe(6);

    const store = {
      listAllCanonicalKeys: async () => [{ ...laneKey, bytes: Buffer.byteLength(whole) }],
      readCanonicalText: async () => whole,
      statCanonical: async () => Buffer.byteLength(whole),
    } as unknown as SessionStore;

    const res = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false, deepVerifyPerPass: 13,
    });

    // The parent sweep stood down partway through — and the lane was still
    // repaired. Sharing `res.deepMismatched`/`res.deepVerified` with the parent
    // loop made the lane loop trip on its very first row, forever.
    expect(res.deepRefused).toBeGreaterThanOrEqual(1);
    expect(await turnsOf(laneKey, true)).toBe(9);
  }, 180_000);

  test("a repair must not DEMOTE attribution it cannot see", async () => {
    // Every repair passes attribution as all-NULL with recovered:true, because the
    // guarantor genuinely does not know the org. If the UPDATE took those NULLs at
    // face value it would erase real attribution and stamp the row `recovered`. On
    // production 2,325 live rows carry attribution_source='recovered' and 214 of them
    // still hold a project or repo — i.e. rows that must have been demoted from
    // `auto`, since no repair supplies either.
    await parkEverything();
    const user = `attr-${uniq()}`;
    const key: SessionKey = { userId: user, family: "claude-cli", sessionId: crypto.randomUUID() };
    const whole = body(3);
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key, chunkId: `a1-${uniq()}`, replace: false, chunkText: whole,
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null,
      attribution: {
        orgExternalId: `org-${user}`,
        projectExternalId: null,
        repoSlug: `${user}/repo`,
        deviceId: null,
      },
    });
    const read = async () => {
      const [r] = await db
        .select({
          orgId: hxSessions.orgId,
          repoId: hxSessions.repoId,
          src: hxSessions.attributionSource,
        })
        .from(hxSessions)
        .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
        .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
        .limit(1);
      return r!;
    };
    const before = await read();
    expect(before.orgId).not.toBeNull();
    expect(before.repoId).not.toBeNull();
    expect(before.src).toBe("auto");

    // Exactly what the count sweep and the orphan restore send.
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key, chunkId: `reconcile-count:${crypto.randomUUID()}`, replace: true, chunkText: whole,
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null,
      attribution: { orgExternalId: null, projectExternalId: null, repoSlug: null, deviceId: null },
      recovered: true,
      rebuild: true,
    });
    const after = await read();
    expect(after.orgId).toBe(before.orgId);
    expect(after.repoId).toBe(before.repoId);
    expect(after.src).toBe("auto"); // NOT demoted to "recovered"
  }, 120_000);

  test("an OVERCOUNT names the session and the numbers, not just a tally", async () => {
    // The bare deepOvercount counter could say how many rows hold more turns than their
    // canonical parses to — never which, nor by how much. That is exactly the number
    // that decides what to do about duplicated sessions: actual > expected means the
    // OBJECT is clean and a rebuild fixes the index; actual == expected means the object
    // itself repeats the record and no rebuild can help. Both were argued during this
    // work and neither could be settled, because the number was never written down.
    await parkEverything();
    const user = `overcount-${uniq()}`;
    const key: SessionKey = { userId: user, family: "claude-cli", sessionId: crypto.randomUUID() };
    const whole = body(3);
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key, chunkId: `oc-${uniq()}`, replace: false, chunkText: whole,
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR,
    });
    // One extra indexed turn the canonical does not contain ⇒ actual > expected.
    const [row] = await db
      .select({ id: hxSessions.id })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
      .limit(1);
    const [orig] = await db
      .select({ role: hxTurns.role, kind: hxTurns.kind, eventTs: hxTurns.eventTs,
                text: hxTurns.text, rawEvent: hxTurns.rawEvent })
      .from(hxTurns)
      .where(and(eq(hxTurns.sessionId, row!.id), eq(hxTurns.seq, 0)))
      .limit(1);
    const later = new Date(Date.now() + 1000).toISOString();
    await db.insert(hxTurns).values({
      sessionId: row!.id, agentId: null, seq: 3,
      role: orig!.role, kind: orig!.kind, eventTs: orig!.eventTs,
      text: orig!.text, rawEvent: orig!.rawEvent, createdAt: later, updatedAt: later,
    });

    const lines: Array<{ msg: string; f: Record<string, unknown> }> = [];
    const store = {
      listAllCanonicalKeys: async () => [{ ...key, bytes: Buffer.byteLength(whole) }],
      readCanonicalText: async () => whole,
      statCanonical: async () => Buffer.byteLength(whole),
    } as unknown as SessionStore;

    const res = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false, deepVerifyPerPass: 5,
      logger: {
        info: (msg: string, f?: Record<string, unknown>) => lines.push({ msg, f: f ?? {} }),
        warn: () => {},
      } as never,
    });

    expect(res.deepOvercount).toBeGreaterThanOrEqual(1);
    const oc = lines.find((l) => l.f.kind === "overcount" && l.f.sessionId === key.sessionId);
    expect(oc).toBeDefined();
    // The three numbers that settle the question, per session.
    expect(oc!.f.indexedTurns).toBe(4);
    expect(oc!.f.canonicalRecords).toBe(3);
    expect(oc!.f.excess).toBe(1);
  }, 120_000);

  test("a canonical past the repair bound is skipped WITHOUT being read", async () => {
    await parkEverything();
    const user = `repaircap-${uniq()}`;
    // An orphan: listed in the store, no row in the database. Normally the pass
    // restores it by reading the whole object — the path that had no bound at all.
    const key: SessionKey = { userId: user, family: "claude-cli", sessionId: crypto.randomUUID() };
    let reads = 0;
    const huge = 300 * 1024 * 1024; // over the 128 MiB default bound
    const store = {
      listAllCanonicalKeys: async () => [{ ...key, bytes: huge }],
      readCanonicalText: async () => {
        reads += 1;
        throw new Error("must not read an object past the repair bound");
      },
      statCanonical: async () => huge,
    } as unknown as SessionStore;

    const res = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false,
    });
    // Refused on the LISTED size, before any download: the bound exists to prevent
    // a multi-GiB spike in the live ingest process, so discovering it after the read
    // would defeat it entirely.
    expect(reads).toBe(0);
    // This canonical has NO row, so the bound means it is never indexed AT ALL —
    // permanently, because the repair path is the only thing that would have indexed
    // it. That is a different fact from "indexed already, just not re-verified", and
    // it gets its own counter so it cannot hide behind the milder one.
    expect(res.oversizedUnindexed).toBeGreaterThanOrEqual(1);
    expect(res.tooLargeToJudge).toBe(0);
    expect(res.restored).toBe(0);
  }, 120_000);

  test("a canonical UNDER the repair bound is still restored", async () => {
    await parkEverything();
    const user = `repairok-${uniq()}`;
    const key: SessionKey = { userId: user, family: "claude-cli", sessionId: crypto.randomUUID() };
    const whole = body(4);
    const store = {
      listAllCanonicalKeys: async () => [{ ...key, bytes: Buffer.byteLength(whole) }],
      readCanonicalText: async () => whole,
      statCanonical: async () => Buffer.byteLength(whole),
    } as unknown as SessionStore;

    const res = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false,
    });
    expect(res.restored).toBe(1);
    expect(await turnsOf(key, false)).toBe(4);
  }, 120_000);

  // The health detectors shipped with tests and NO caller — they ran nowhere, so
  // the damage class they exist to name was never looked for in production. This
  // asserts the wiring, not the SQL: the detector's own suite covers the SQL.
  test("a pass asked for health signals reports them; a pass that was not gets null", async () => {
    await parkEverything();
    const user = `health-${uniq()}`;
    const whole = body(9);
    const short = body(6);
    const key = await damagedParent(user, 0, short, whole);
    const store = {
      listAllCanonicalKeys: async () => [{ ...key, bytes: Buffer.byteLength(whole) }],
      readCanonicalText: async () => whole,
      statCanonical: async () => Buffer.byteLength(whole),
    } as unknown as SessionStore;

    // deepVerifyPerPass 0: the sweep stays off, so the gap is still there to see.
    const off = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false,
    });
    expect(off.byteGapRows).toBeNull();
    expect(off.byteGapBlind).toBeNull();

    const on = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false, healthSignals: true,
    });
    expect(on.byteGapRows).toBeGreaterThanOrEqual(1);
    expect(on.byteGapBytes).toBeGreaterThanOrEqual(
      Buffer.byteLength(whole) - Buffer.byteLength(short),
    );
    expect(on.byteGapBlind).not.toBeNull();
  }, 120_000);
  test("a session holding duplicates is forced into a rebuild and converges", async () => {
    await parkEverything();
    const user = `dupconv-${uniq()}`;
    const key: SessionKey = { userId: user, family: "claude-cli", sessionId: crypto.randomUUID() };
    // Records must carry their own uuid: that is the only identity the duplicate
    // oracle will act on, and the describe-level `rec` helper omits it.
    const recU = (t: string) =>
      JSON.stringify({
        type: "user",
        uuid: crypto.randomUUID(),
        timestamp: TS,
        message: { content: [{ type: "text", text: t }] },
      });
    const whole = `${recU("one")}\n${recU("two")}\n`;
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key, chunkId: `dc-${uniq()}`, replace: false, chunkText: whole,
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR,
    });
    expect(await turnsOf(key, false)).toBe(2);

    // Fixture the damage the way it exists in production: a second commit's copy
    // of a record already indexed. Nothing on the write path refuses a re-send
    // yet (that guard is future work), but writing the row directly keeps the
    // fixture independent of it either way.
    const [row] = await db
      .select({ id: hxSessions.id })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
      .limit(1);
    const [orig] = await db
      .select({
        role: hxTurns.role, kind: hxTurns.kind, eventTs: hxTurns.eventTs,
        text: hxTurns.text, rawEvent: hxTurns.rawEvent,
      })
      .from(hxTurns)
      .where(and(eq(hxTurns.sessionId, row!.id), eq(hxTurns.seq, 0)))
      .limit(1);
    const later = new Date(Date.now() + 1000).toISOString();
    await db.insert(hxTurns).values({
      sessionId: row!.id, agentId: null, seq: 2,
      role: orig!.role, kind: orig!.kind, eventTs: orig!.eventTs,
      text: orig!.text, rawEvent: orig!.rawEvent, createdAt: later, updatedAt: later,
    });
    expect(await turnsOf(key, false)).toBe(3);

    const store = {
      listAllCanonicalKeys: async () => [{ ...key, bytes: Buffer.byteLength(whole) }],
      readCanonicalText: async () => whole,
      statCanonical: async () => Buffer.byteLength(whole),
    } as unknown as SessionStore;

    // Not opted in: nothing touches it. Note the lane is DENSE (3 turns, max seq 2),
    // so the seq-gap scan cannot be what finds this — and the count sweep's oracle
    // reads actual >= expected as healthy. Detected forever, repaired never.
    const off = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false,
    });
    expect(off.duplicatedSessions).toBeNull();
    expect(await turnsOf(key, false)).toBe(3);

    const on = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false, repairDuplicates: true,
    });
    expect(on.duplicatedSessions).toBeGreaterThanOrEqual(1);
    // Converged to parse(whole canonical) — the duplicate is gone and the lane is
    // dense again, which is the state the count sweep agrees with.
    expect(await turnsOf(key, false)).toBe(2);
  }, 180_000);

  test("duplicates held in an agent LANE force that lane's rebuild — not the parent's", async () => {
    await parkEverything();
    const user = `dupconv-lane-${uniq()}`;
    const key: SessionKey = { userId: user, family: "claude-cli", sessionId: crypto.randomUUID() };
    const recU = (t: string) =>
      JSON.stringify({
        type: "user",
        uuid: crypto.randomUUID(),
        timestamp: TS,
        message: { content: [{ type: "text", text: t }] },
      });
    const parentText = `${recU("parent")}\n`;
    const laneWhole = `${recU("lane one")}\n${recU("lane two")}\n`;
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key, chunkId: `dl-${uniq()}`, replace: false, chunkText: parentText,
      totalBytes: Buffer.byteLength(parentText), componentCount: 1, meta: null, attribution: ATTR,
    });
    await ingestAgentCommit(db, {
      ingestChannel: "tunnel" as const,
      key, agentId: AGENT, chunkId: `dl-${uniq()}`, replace: false, chunkText: laneWhole,
      totalBytes: Buffer.byteLength(laneWhole), componentCount: 1, meta: null, attribution: ATTR,
    });
    expect(await turnsOf(key, false)).toBe(1);
    expect(await turnsOf(key, true)).toBe(2);

    // A later commit's copy of a lane record already indexed. The lane stays
    // DENSE (seq 0..2), so the seq-gap scan cannot select it and the count
    // sweep's oracle reads actual >= expected as healthy — only the duplicate
    // oracle can, and it must address the LANE, not the parent: a parent
    // rebuild never touches lane rows.
    const [row] = await db
      .select({ id: hxSessions.id })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
      .limit(1);
    const [orig] = await db
      .select({
        agentId: hxTurns.agentId, role: hxTurns.role, kind: hxTurns.kind,
        eventTs: hxTurns.eventTs, text: hxTurns.text, rawEvent: hxTurns.rawEvent,
      })
      .from(hxTurns)
      .where(and(eq(hxTurns.sessionId, row!.id), isNotNull(hxTurns.agentId), eq(hxTurns.seq, 0)))
      .limit(1);
    const later = new Date(Date.now() + 1000).toISOString();
    await db.insert(hxTurns).values({
      sessionId: row!.id, agentId: orig!.agentId, seq: 2,
      role: orig!.role, kind: orig!.kind, eventTs: orig!.eventTs,
      text: orig!.text, rawEvent: orig!.rawEvent, createdAt: later, updatedAt: later,
    });
    expect(await turnsOf(key, true)).toBe(3);

    const store = {
      listAllCanonicalKeys: async () => [
        { ...key, bytes: Buffer.byteLength(parentText) },
        { ...key, sessionId: `${key.sessionId}:a:${AGENT}`, bytes: Buffer.byteLength(laneWhole) },
      ],
      readCanonicalText: async (k: SessionKey) =>
        k.sessionId.includes(":a:") ? laneWhole : parentText,
      statCanonical: async (k: SessionKey) =>
        Buffer.byteLength(k.sessionId.includes(":a:") ? laneWhole : parentText),
    } as unknown as SessionStore;

    const on = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false, repairDuplicates: true,
    });
    // The oracle addressed the lane: its duplicate is gone, the parent untouched.
    expect(on.duplicatedSessions).toBeGreaterThanOrEqual(1);
    expect(await turnsOf(key, true)).toBe(2);
    expect(await turnsOf(key, false)).toBe(1);
  }, 180_000);

  test("a rebuild MEASURES canonical-held duplicates (§7b) instead of pretending to fix them", async () => {
    await parkEverything();
    const user = `heldup-${uniq()}`;
    const key: SessionKey = { userId: user, family: "claude-cli", sessionId: crypto.randomUUID() };
    const recU = (t: string) =>
      JSON.stringify({
        type: "user",
        uuid: crypto.randomUUID(),
        timestamp: TS,
        message: { content: [{ type: "text", text: t }] },
      });
    const lineA = recU("alpha");
    const lineB = recU("beta");
    // The OBJECT itself repeats record A after B — the double-compose shape.
    const whole = `${lineA}\n${lineB}\n${lineA}\n`;
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key, chunkId: `hd-${uniq()}`, replace: false, chunkText: whole,
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR,
    });
    expect(await turnsOf(key, false)).toBe(3);

    // A cross-commit duplicate on top, so the oracle forces the rebuild.
    const [row] = await db
      .select({ id: hxSessions.id })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
      .limit(1);
    const [orig] = await db
      .select({ role: hxTurns.role, kind: hxTurns.kind, eventTs: hxTurns.eventTs,
                text: hxTurns.text, rawEvent: hxTurns.rawEvent })
      .from(hxTurns)
      .where(and(eq(hxTurns.sessionId, row!.id), eq(hxTurns.seq, 0)))
      .limit(1);
    const later = new Date(Date.now() + 1000).toISOString();
    await db.insert(hxTurns).values({
      sessionId: row!.id, agentId: null, seq: 3,
      role: orig!.role, kind: orig!.kind, eventTs: orig!.eventTs,
      text: orig!.text, rawEvent: orig!.rawEvent, createdAt: later, updatedAt: later,
    });

    const store = {
      listAllCanonicalKeys: async () => [{ ...key, bytes: Buffer.byteLength(whole) }],
      readCanonicalText: async () => whole,
      statCanonical: async () => Buffer.byteLength(whole),
    } as unknown as SessionStore;
    const on = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false, repairDuplicates: true,
    });
    // Converged to parse(whole canonical) — which legitimately CONTAINS the
    // object-held copy. The rebuild must not shrink below the object's truth…
    expect(await turnsOf(key, false)).toBe(3);
    // …and the residue is MEASURED: a counter plus durable evidence, since the
    // cross-commit oracle goes blind to object-held copies after this rebuild.
    expect(on.canonicalHeldDuplicates).toBeGreaterThanOrEqual(1);
    const found = (await db.execute(dsql`
      select detail from hx.integrity_findings
      where session_id = ${key.sessionId} and kind = 'canonical_held_duplicates'
    `)) as unknown as Array<{ detail: { records?: number } }>;
    expect(found.length).toBe(1);
  }, 180_000);

  test("sweep-grade hygiene prunes ORPHANED turn embeddings and spares owned ones", async () => {
    await parkEverything();
    const user = `embprune-${uniq()}`;
    const key: SessionKey = { userId: user, family: "claude-cli", sessionId: crypto.randomUUID() };
    const recU = JSON.stringify({
      type: "user", uuid: crypto.randomUUID(), timestamp: TS,
      message: { content: [{ type: "text", text: "keep me" }] },
    });
    const whole = `${recU}\n`;
    await ingestCommit(db, {
      ingestChannel: "tunnel" as const,
      key, chunkId: `ep-${uniq()}`, replace: false, chunkText: whole,
      totalBytes: Buffer.byteLength(whole), componentCount: 1, meta: null, attribution: ATTR,
    });
    const [row] = await db
      .select({ id: hxSessions.id })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
      .limit(1);
    const [turn] = (await db.execute(dsql`
      select id from hx.turns where session_id = ${row!.id} limit 1
    `)) as unknown as Array<{ id: string }>;
    const orphanId = crypto.randomUUID();
    await db.execute(dsql`
      insert into hx.embeddings (owner_kind, owner_id, model, dim)
      values ('turn', ${turn!.id}, 'test-model', 4), ('turn', ${orphanId}, 'test-model', 4)
    `);

    const store = { listAllCanonicalKeys: async () => [] } as unknown as SessionStore;
    const res = await reconcileOrphans(db, store, {
      batchDelayMs: 0, correctExistingTitles: false, healthSignals: true,
    });
    expect(res.embeddingsPruned).not.toBeNull();
    expect(res.embeddingsPruned!).toBeGreaterThanOrEqual(1);
    const left = (await db.execute(dsql`
      select owner_id from hx.embeddings where owner_id in (${turn!.id}, ${orphanId})
    `)) as unknown as Array<{ owner_id: string }>;
    expect(left.map((r) => r.owner_id)).toEqual([turn!.id]);
  }, 120_000);
});
