import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  PAUSE_CAP_MS,
  PauseState,
  effectivePause,
  type IngestControlRow,
} from "../src/console/ingest-control";
import {
  ARMED_PRESIGN_TTL_S,
  IngestPausedError,
  IngestQuiesce,
  PAUSED_WIRE_PREFIX,
  PauseGatedStore,
  awaitQuiesced,
  isGatedStoreMethod,
  isIngestPaused,
  isPauseGated,
  isRetryableIngestError,
} from "../src/console/pause-gate";
import {
  clearPauseAnchor,
  readPauseAnchor,
  stampPauseAnchor,
} from "../src/console/runtime-files";
import type {
  SessionKey,
  SessionMetadata,
  SessionStore,
  SignedUpload,
  StagingUploadOptions,
} from "../src/modules/session-vault/store/types";

const NOW = new Date("2026-07-31T12:00:00.000Z");
const KEY: SessionKey = { userId: "u", family: "f", sessionId: "s" };

function episode(over: Partial<IngestControlRow> = {}): IngestControlRow {
  return {
    id: over.id ?? "e1",
    pausedUntil: over.pausedUntil ?? new Date(NOW.getTime() + 5 * 60_000),
    resumedAt: over.resumedAt ?? null,
    rowWrittenAt: over.rowWrittenAt ?? NOW,
    reason: over.reason ?? "storage migration",
  };
}

describe("the pause clamp", () => {
  test("an open fortress has no deadline", () => {
    expect(effectivePause({ row: null, firstObservedAt: null, now: NOW }).pausedUntil).toBeNull();
  });

  test("a resumed episode reopens the gate immediately", () => {
    const pause = effectivePause({
      row: episode({ resumedAt: NOW }),
      firstObservedAt: NOW,
      now: NOW,
    });
    expect(pause.pausedUntil).toBeNull();
  });

  test("a legitimate pause holds to its own deadline", () => {
    const until = new Date(NOW.getTime() + 5 * 60_000);
    const pause = effectivePause({ row: episode({ pausedUntil: until }), firstObservedAt: NOW, now: NOW });
    expect(pause.pausedUntil?.toISOString()).toBe(until.toISOString());
    expect(pause.capped).toBe(false);
  });

  test("a ten-year pause reopens at the cap, and is reported as capped", () => {
    const row = episode({ pausedUntil: new Date(NOW.getTime() + 10 * 365 * 86_400_000) });
    const pause = effectivePause({ row, firstObservedAt: NOW, now: NOW });
    expect(pause.capped).toBe(true);
    expect(pause.pausedUntil?.getTime()).toBe(NOW.getTime() + PAUSE_CAP_MS);
  });

  test("a FUTURE row_written_at cannot buy extra time — the daemon's own file bounds it", () => {
    // The DB-side anchor is sound only because the write role has no column
    // grant on it; the daemon-side file is what holds when that assumption is
    // not available (an external Postgres has no role split at all).
    const row = episode({
      pausedUntil: new Date(NOW.getTime() + 10 * 365 * 86_400_000),
      rowWrittenAt: new Date(NOW.getTime() + 365 * 86_400_000),
    });
    const pause = effectivePause({ row, firstObservedAt: NOW, now: NOW });
    expect(pause.pausedUntil?.getTime()).toBe(NOW.getTime() + PAUSE_CAP_MS);
  });

  test("an episode whose own anchor has aged past the cap is already expired", () => {
    const row = episode({
      pausedUntil: new Date(NOW.getTime() + 60_000),
      rowWrittenAt: new Date(NOW.getTime() - PAUSE_CAP_MS - 1000),
    });
    const pause = effectivePause({
      row,
      firstObservedAt: new Date(NOW.getTime() - PAUSE_CAP_MS - 1000),
      now: NOW,
    });
    expect(pause.pausedUntil).toBeNull();
  });

  test("a NEW episode on a fortress whose previous row is hours old holds its own deadline", () => {
    // This is why arming INSERTs a row instead of updating a singleton: an
    // in-place update would keep the old anchor and every pause would resolve
    // to "already expired".
    const until = new Date(NOW.getTime() + 10 * 60_000);
    const fresh = episode({ pausedUntil: until, rowWrittenAt: NOW });
    expect(
      effectivePause({ row: fresh, firstObservedAt: NOW, now: NOW }).pausedUntil?.toISOString(),
    ).toBe(until.toISOString());
  });
});

describe("the pause anchor file", () => {
  let root = "";
  let anchorPath = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-pause-"));
    anchorPath = path.join(root, "pause-anchor.json");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("stamps once per episode and is cleared on resume", async () => {
    const first = await stampPauseAnchor(anchorPath, "episode-1", NOW);
    const again = await stampPauseAnchor(anchorPath, "episode-1", new Date(NOW.getTime() + 60_000));
    // A pause that is merely still running must not keep pushing its own bound.
    expect(again.firstObservedAt).toBe(first.firstObservedAt);

    await clearPauseAnchor(anchorPath);
    expect(await readPauseAnchor(anchorPath)).toBeNull();

    const second = await stampPauseAnchor(anchorPath, "episode-2", new Date(NOW.getTime() + 3_600_000));
    expect(second.firstObservedAt).not.toBe(first.firstObservedAt);
  });

  test("a NEW episode re-anchors even when the last one was never resumed", async () => {
    // The defect this closes: an episode that EXPIRED without a resume left its
    // anchor behind, and the next pause inherited a bound already past the cap —
    // so min() resolved to expired the instant it was armed and the barrier a
    // swap waits on became a no-op nothing reported.
    const stale = await stampPauseAnchor(anchorPath, "episode-1", NOW);
    const fresh = await stampPauseAnchor(
      anchorPath,
      "episode-2",
      new Date(NOW.getTime() + 30 * 60_000),
    );
    expect(fresh.episodeId).toBe("episode-2");
    expect(fresh.firstObservedAt).not.toBe(stale.firstObservedAt);
    expect((await readPauseAnchor(anchorPath))?.episodeId).toBe("episode-2");
  });
});

describe("the cached pause state", () => {
  test("losing Postgres keeps the last known deadline and never reopens early", () => {
    const state = new PauseState();
    state.observe({ pausedUntil: new Date(NOW.getTime() + 60_000), capped: false });
    state.observeUnavailable();
    expect(state.isPaused(NOW)).toBe(true);
    expect(state.stale).toBe(true);
    // …and the deadline still expires on its own.
    expect(state.isPaused(new Date(NOW.getTime() + 61_000))).toBe(false);
  });
});

class RecordingStore implements SessionStore {
  calls: string[] = [];
  ttls: (number | undefined)[] = [];
  signStagingUpload(_k: SessionKey, _c: string, opts?: StagingUploadOptions): Promise<SignedUpload> {
    this.calls.push("signStagingUpload");
    this.ttls.push(opts?.ttlSeconds);
    return Promise.resolve({
      url: "https://example/put",
      objectName: "o",
      expiresAt: new Date(NOW.getTime() + (opts?.ttlSeconds ?? 900) * 1000).toISOString(),
    });
  }
  readChunkText(): Promise<string> {
    this.calls.push("readChunkText");
    return Promise.resolve("");
  }
  appendChunkToCanonical(): Promise<{ totalBytes: number; componentCount: number }> {
    this.calls.push("appendChunkToCanonical");
    return Promise.resolve({ totalBytes: 1, componentCount: 1 });
  }
  statCanonical(): Promise<number | null> {
    this.calls.push("statCanonical");
    return Promise.resolve(1);
  }
  signCanonicalDownload(): Promise<{ url: string; expiresAt: string }> {
    this.calls.push("signCanonicalDownload");
    return Promise.resolve({ url: "https://example/get", expiresAt: "x" });
  }
  readCanonicalText(): Promise<string> {
    this.calls.push("readCanonicalText");
    return Promise.resolve("");
  }
  writeCanonicalText(): Promise<void> {
    this.calls.push("writeCanonicalText");
    return Promise.resolve();
  }
  writeArtifact(): Promise<void> {
    this.calls.push("writeArtifact");
    return Promise.resolve();
  }
  readArtifactText(): Promise<string | null> {
    this.calls.push("readArtifactText");
    return Promise.resolve("{}");
  }
  listSessionArtifacts(): Promise<string[]> {
    this.calls.push("listSessionArtifacts");
    return Promise.resolve([]);
  }
  listSessionMetadata(): Promise<SessionMetadata[]> {
    this.calls.push("listSessionMetadata");
    return Promise.resolve([]);
  }
  getBucketVersioning(): Promise<string> {
    this.calls.push("getBucketVersioning");
    return Promise.resolve("Enabled");
  }
  getLifecycle(): Promise<string> {
    this.calls.push("getLifecycle");
    return Promise.resolve("no lifecycle rules");
  }
  listAllCanonicalKeys(): Promise<SessionKey[]> {
    this.calls.push("listAllCanonicalKeys");
    return Promise.resolve([]);
  }
  selfTest(): Promise<void> {
    this.calls.push("selfTest");
    return Promise.resolve();
  }
  deleteSession(): Promise<{ complete: boolean; deleted: number }> {
    this.calls.push("deleteSession");
    return Promise.resolve({ complete: true, deleted: 0 });
  }
}

function pausedGate(inner: SessionStore, until = new Date(NOW.getTime() + 60_000)) {
  const state = new PauseState();
  state.observe({ pausedUntil: until, capped: false });
  return new PauseGatedStore(inner, state, new IngestQuiesce(), { clock: () => NOW });
}

describe("the store-write gate", () => {
  test("refuses every bucket-mutating method, self-test included", async () => {
    const inner = new RecordingStore();
    const gate = pausedGate(inner);
    for (const call of [
      () => gate.signStagingUpload(KEY, "c"),
      () => gate.appendChunkToCanonical(KEY, "c"),
      () => gate.writeCanonicalText(KEY, "t"),
      () => gate.writeArtifact(KEY, "n", "t"),
      () => gate.selfTest(),
      () => gate.deleteSession(KEY),
    ]) {
      await expect(call()).rejects.toThrow(/^vault_offline:ingest_paused:/);
    }
    // Nothing reached the inner store: a refused write consumes no deadline
    // and cannot charge the wedge-escalation streak.
    expect(inner.calls).toEqual([]);
  });

  test("every refusal is counted, so the metric is not a flat zero through a pause", async () => {
    const inner = new RecordingStore();
    const state = new PauseState();
    state.observe({ pausedUntil: new Date(NOW.getTime() + 60_000), capped: false });
    let refused = 0;
    const gate = new PauseGatedStore(inner, state, new IngestQuiesce(), {
      clock: () => NOW,
      onRefused: () => (refused += 1),
    });
    for (const call of [
      () => gate.signStagingUpload(KEY, "c"),
      () => gate.appendChunkToCanonical(KEY, "c"),
      () => gate.writeCanonicalText(KEY, "t"),
      () => gate.deleteSession(KEY),
    ]) {
      await expect(call()).rejects.toThrow(/^vault_offline:ingest_paused:/);
    }
    // The gate is the only thing that knows a write was turned away. Published
    // as a flat zero, the console reads "no writes were refused" for the whole
    // window in which every write was.
    expect(refused).toBe(4);
    // A read is not a refusal.
    await gate.readCanonicalText(KEY);
    expect(refused).toBe(4);
  });

  test("reads stay open throughout", async () => {
    const inner = new RecordingStore();
    const gate = pausedGate(inner);
    await gate.readArtifactText(KEY, "session.json");
    await gate.readCanonicalText(KEY);
    await gate.statCanonical(KEY);
    await gate.listSessionMetadata("u");
    expect(inner.calls).toEqual([
      "readArtifactText",
      "readCanonicalText",
      "statCanonical",
      "listSessionMetadata",
    ]);
  });

  test("the wire literal is exactly the shape the classifier reads", async () => {
    const until = new Date(NOW.getTime() + 60_000);
    const err = new IngestPausedError(until);
    // `vault_offline` first, so a workbench that predates the pause parks the
    // job; the detail suffix is what a newer classifier reads.
    expect(err.message).toBe(`vault_offline:ingest_paused:${until.toISOString()}`);
    expect(err.message).toStartWith(PAUSED_WIRE_PREFIX);
    expect(isIngestPaused(err)).toBe(true);
    expect(isRetryableIngestError(err.message)).toBe(true);
  });

  test("an open gate passes everything through", async () => {
    const inner = new RecordingStore();
    const gate = new PauseGatedStore(inner, new PauseState(), new IngestQuiesce(), {
      clock: () => NOW,
    });
    await gate.writeArtifact(KEY, "n", "t");
    expect(inner.calls).toEqual(["writeArtifact"]);
    expect(isPauseGated(gate)).toBe(true);
    expect(isPauseGated(inner)).toBe(false);
  });

  test("the gated method list matches the bucket-mutating surface", () => {
    for (const m of [
      "signStagingUpload",
      "appendChunkToCanonical",
      "writeCanonicalText",
      "writeArtifact",
      "deleteSession",
      "selfTest",
    ]) {
      expect(isGatedStoreMethod(m)).toBe(true);
    }
    for (const m of ["readArtifactText", "statCanonical", "listAllCanonicalKeys"]) {
      expect(isGatedStoreMethod(m)).toBe(false);
    }
  });

  test("while armed, new staging signatures are cut short", async () => {
    const inner = new RecordingStore();
    const gate = new PauseGatedStore(inner, new PauseState(), new IngestQuiesce(), {
      clock: () => NOW,
      armed: () => true,
    });
    await gate.signStagingUpload(KEY, "c");
    expect(inner.ttls).toEqual([ARMED_PRESIGN_TTL_S]);
  });
});

describe("the quiesce barrier", () => {
  test("waits for in-flight work AND for outstanding signatures", () => {
    const quiesce = new IngestQuiesce();
    expect(quiesce.isQuiesced(NOW)).toBe(true);
    quiesce.enter();
    expect(quiesce.isQuiesced(NOW)).toBe(false);
    quiesce.leave();
    expect(quiesce.isQuiesced(NOW)).toBe(true);
    // A presigned PUT lands in the bucket without passing through us, so the
    // counter alone cannot decide the store is still.
    quiesce.noteSignature(new Date(NOW.getTime() + 30_000));
    expect(quiesce.isQuiesced(NOW)).toBe(false);
    expect(quiesce.isQuiesced(new Date(NOW.getTime() + 31_000))).toBe(true);
  });

  test("counts deferred work from enqueue, not from execution", async () => {
    const quiesce = new IngestQuiesce();
    let release = (): void => {};
    const gate = new Promise<void>((r) => (release = r));
    const work = quiesce.track(() => gate);
    expect(quiesce.pending).toBe(1);
    release();
    await work;
    expect(quiesce.pending).toBe(0);
  });

  test("a lapsed deadline aborts rather than swapping under live writes", async () => {
    const quiesce = new IngestQuiesce();
    quiesce.enter();
    let t = NOW.getTime();
    const ok = await awaitQuiesced({
      quiesce,
      deadline: new Date(NOW.getTime() + 500),
      clock: () => new Date(t),
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(ok).toBe(false);
  });

  test("flushes the deferred post-commit chains before declaring quiet", async () => {
    const quiesce = new IngestQuiesce();
    let flushed = 0;
    const ok = await awaitQuiesced({
      quiesce,
      deadline: new Date(NOW.getTime() + 1000),
      clock: () => NOW,
      flush: async () => {
        flushed += 1;
      },
    });
    expect(ok).toBe(true);
    expect(flushed).toBe(1);
  });
});
