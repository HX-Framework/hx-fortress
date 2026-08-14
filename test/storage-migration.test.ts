import { isSessionArtifactName, sessionArtifactNames } from "../src/modules/session-vault/store/keys";
// Moving a fortress's objects to another bucket: what the engine does, in what
// order, and what it refuses to do.
//
// The stores here are in memory because the interesting part is never the copy —
// it is the arm→swap window, the barrier, the fence, and the two things a
// migration must never do: lose a write, or delete the bucket it came from.

import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import {
  FENCE_MARGIN_MS,
  copySession,
  runStorageMigration,
  sessionRef,
  type MigrationDeps,
  type MigrationEvent,
  type PauseGateState,
} from "../src/console/migration";
import {
  MIGRATION_BUSY_REFUSAL,
  MIGRATION_COMMANDS,
  describeMigration,
  isMigrationCommand,
  migrationIsRunning,
  runMigrationCommand,
  type MigrationRunnerDeps,
} from "../src/console/migration-runner";
import { mintCredentialRef, writeCredentialRef } from "../src/console/cmd-creds";
import { IngestQuiesce } from "../src/console/pause-gate";
import { MIGRATION_PHASES, validateCommandParams } from "../src/console/command-params";
import { createCommandExecutors } from "../src/console/executors";
import { envManagedRefusal } from "../src/console/rotation";
import { AuditSpool } from "../src/console/audit-spool";
import { ConsoleAudit } from "../src/ui/audit-writer";
import {
  handleMutateRoute,
  MUTATE_PATHS,
  OFFERED_COMMAND_KINDS,
  type ConsoleWritePort,
} from "../src/ui/mutate-routes";
import {
  handleReadRoute,
  READ_PATHS,
  READ_ROUTES,
  type ConsoleReadPort,
} from "../src/ui/read-routes";
import { CONSOLE_TABLES, UI_TABLE_GRANTS } from "../src/host/postgres/console-plane";
import { expectedPrivilegeMatrix } from "../src/host/postgres/privilege-matrix";
import { migrations } from "../src/host/postgres/migrations/manifest";
import {
  credentialsPath,
  readVaultCredentials,
  writeVaultCredentials,
  type VaultCredentials,
} from "../src/modules/session-vault/credentials";
import type { HxDb } from "../src/host/postgres/db";
import type { ScopedLogger } from "../src/host/types";
import type {
  ComposeResult,
  DeleteSessionResult,
  SessionKey,
  SessionMetadata,
  SessionStore,
  SignedDownload,
  SignedUpload,
  StagingUploadOptions,
} from "../src/modules/session-vault/store/types";
import type { ServiceManager } from "../src/service";

const NOW = Date.parse("2026-07-31T12:00:00.000Z");
const LOGGER: ScopedLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const dialect = new PgDialect();

function key(n: number): SessionKey {
  return { userId: "u1", family: "claude-code", sessionId: `s${n}` };
}

// ── an in-memory bucket ──────────────────────────────────────────────────────

class MemoryStore implements SessionStore {
  readonly canonical = new Map<string, string>();
  readonly artifacts = new Map<string, string>();
  /** Every destructive call, so a test can assert the SET is empty. */
  readonly deletes: string[] = [];
  selfTests = 0;
  /** Return different bytes than were written — a bucket that accepted and
   *  stored something else. */
  corrupt: string | null = null;
  /** Throw on the write of this session, once. */
  failOn: string | null = null;

  constructor(readonly name: string) {}

  private ref(k: SessionKey): string {
    return sessionRef(k);
  }
  signStagingUpload(_k: SessionKey, _c: string, opts?: StagingUploadOptions): Promise<SignedUpload> {
    return Promise.resolve({
      url: "https://example/put",
      objectName: "o",
      expiresAt: new Date(NOW + (opts?.ttlSeconds ?? 900) * 1000).toISOString(),
    });
  }
  readChunkText(): Promise<string> {
    return Promise.resolve("");
  }
  appendChunkToCanonical(): Promise<ComposeResult> {
    return Promise.resolve({ totalBytes: 0, componentCount: 0 });
  }
  statCanonical(k: SessionKey): Promise<number | null> {
    const text = this.canonical.get(this.ref(k));
    return Promise.resolve(text === undefined ? null : Buffer.byteLength(text));
  }
  signCanonicalDownload(): Promise<SignedDownload> {
    return Promise.resolve({ url: "https://example/get", expiresAt: "x" });
  }
  readCanonicalText(k: SessionKey): Promise<string> {
    const text = this.canonical.get(this.ref(k));
    if (text === undefined) return Promise.reject(new Error(`no canonical for ${this.ref(k)}`));
    return Promise.resolve(this.corrupt !== null && this.name !== "source" ? this.corrupt : text);
  }
  writeCanonicalText(k: SessionKey, text: string): Promise<void> {
    if (this.failOn === this.ref(k)) {
      this.failOn = null;
      return Promise.reject(new Error(`the target refused ${this.ref(k)}`));
    }
    this.canonical.set(this.ref(k), text);
    return Promise.resolve();
  }
  writeArtifact(k: SessionKey, name: string, text: string): Promise<void> {
    this.artifacts.set(`${this.ref(k)}/${name}`, text);
    return Promise.resolve();
  }
  readArtifactText(k: SessionKey, name: string): Promise<string | null> {
    return Promise.resolve(this.artifacts.get(`${this.ref(k)}/${name}`) ?? null);
  }
  listSessionArtifacts(k: SessionKey): Promise<string[]> {
    const prefix = `${this.ref(k)}/`;
    return Promise.resolve(
      [...this.artifacts.keys()]
        .filter((name) => name.startsWith(prefix))
        .map((name) => name.slice(prefix.length))
        .sort(),
    );
  }
  listSessionMetadata(): Promise<SessionMetadata[]> {
    return Promise.resolve([]);
  }
  listAllCanonicalKeys(): Promise<SessionKey[]> {
    return Promise.resolve(
      [...this.canonical.keys()].map((ref) => {
        const [userId, family, sessionId] = ref.split("/");
        return { userId: userId ?? "", family: family ?? "", sessionId: sessionId ?? "" };
      }),
    );
  }
  getBucketVersioning(): Promise<string> {
    return Promise.resolve("Enabled");
  }
  getLifecycle(): Promise<string> {
    return Promise.resolve("no lifecycle rules");
  }
  selfTest(): Promise<void> {
    this.selfTests += 1;
    return Promise.resolve();
  }
  /** Objects still to remove per session, so a delete takes more than one call.
   *  The real stores stop at a batch limit and the caller re-invokes until
   *  `complete`; a mock that always answers `complete: true` cannot tell whether
   *  the caller does that, which is how an unlooped delete shipped. */
  readonly pendingDeletes = new Map<string, number>();

  deleteSession(k: SessionKey, options?: { batchLimit?: number }): Promise<DeleteSessionResult> {
    const ref = this.ref(k);
    this.deletes.push(ref);
    const limit = options?.batchLimit ?? 800;
    const left = this.pendingDeletes.get(ref) ?? 1;
    const deleted = Math.min(left, limit);
    const remaining = left - deleted;
    this.pendingDeletes.set(ref, remaining);
    if (remaining === 0) this.canonical.delete(ref);
    return Promise.resolve({ complete: remaining === 0, deleted });
  }
}

function seeded(count: number, name = "source"): MemoryStore {
  const store = new MemoryStore(name);
  for (let i = 0; i < count; i += 1) {
    store.canonical.set(sessionRef(key(i)), `${JSON.stringify({ type: "user", text: `s${i}` })}\n`);
    store.artifacts.set(`${sessionRef(key(i))}/session.json`, `{"id":"s${i}"}`);
  }
  return store;
}

/**
 * A stand-in for the daemon's write gate.
 *
 * It learns about an episode only when it is REFRESHED, and it enforces its own
 * cap rather than what was asked for — the two properties a swap has to prove
 * itself against, and the two the engine used to assume.
 */
class FakeGate {
  private armedUntil: Date | null = null;
  private seen: PauseGateState = { pausedUntil: null, capped: false };
  /** When set, the latest instant this gate will admit to enforcing. */
  cap: number | null = null;
  /** When true, the gate never notices anything — a daemon that is not reading. */
  blind = false;

  constructor(private readonly now: () => number) {}

  arm(until: Date): void {
    this.armedUntil = until;
  }
  resume(): void {
    this.armedUntil = null;
  }
  refresh(): void {
    const until = this.armedUntil;
    if (this.blind || !until) {
      this.seen = { pausedUntil: null, capped: false };
      return;
    }
    const capped = this.cap !== null && this.cap < until.getTime();
    const effective = capped ? (this.cap as number) : until.getTime();
    this.seen = { pausedUntil: effective > this.now() ? new Date(effective) : null, capped };
  }
  state(): PauseGateState {
    return this.seen;
  }
}

interface Harness {
  deps: MigrationDeps;
  gate: FakeGate;
  source: MemoryStore;
  target: MemoryStore;
  quiesce: IngestQuiesce;
  /** Every side effect, in the order it happened. */
  trace: string[];
  events: MigrationEvent[];
  now: () => number;
  advance: (ms: number) => void;
  version: number;
  armed: boolean;
}

function harness(over: Partial<MigrationDeps> & { sessions?: number } = {}): Harness {
  const source = (over.source as MemoryStore | undefined) ?? seeded(over.sessions ?? 3);
  const target = (over.target as MemoryStore | undefined) ?? new MemoryStore("target");
  const quiesce = new IngestQuiesce();
  const trace: string[] = [];
  const events: MigrationEvent[] = [];
  let clockMs = NOW;
  const state = { version: 3, armed: false, episodes: 0 };
  const gate = new FakeGate(() => clockMs);
  const deps: MigrationDeps = {
    mode: "switch",
    source,
    target,
    tombstones: async () => [],
    quiesce,
    armDrain: (on) => {
      state.armed = on;
      trace.push(`drain:${on ? "on" : "off"}`);
    },
    armPause: async (until) => {
      trace.push(`pause:${until.toISOString()}`);
      gate.arm(until);
      state.episodes += 1;
      return `episode-${state.episodes}`;
    },
    resumeIngest: async (id) => {
      gate.resume();
      trace.push(`resume:${id}`);
    },
    gate: () => gate.state(),
    refreshGate: async () => gate.refresh(),
    swapCredentials: async () => {
      trace.push("swap");
      state.version += 1;
      return state.version;
    },
    rebindStore: async () => {
      trace.push("rebind");
    },
    onEvent: (event) => events.push(event),
    clock: () => new Date(clockMs),
    sleep: async (ms) => {
      clockMs += ms;
    },
    ...over,
  };
  return {
    deps,
    gate,
    source,
    target,
    quiesce,
    trace,
    events,
    now: () => clockMs,
    advance: (ms) => {
      clockMs += ms;
    },
    get version() {
      return state.version;
    },
    get armed() {
      return state.armed;
    },
  };
}

// ── the engine ───────────────────────────────────────────────────────────────

describe("what a run does, and stops at", () => {
  test("a plan touches neither bucket", async () => {
    const h = harness({ mode: "plan", sessions: 4 });
    const result = await runStorageMigration(h.deps);
    expect(result).toMatchObject({ phase: "done", sessionsTotal: 4, sessionsCopied: 0 });
    expect(h.target.canonical.size).toBe(0);
    expect(h.target.selfTests).toBe(0);
    expect(h.trace).toEqual([]);
  });

  test("a copy moves the objects and their sidecars, and stops before the cut", async () => {
    const h = harness({ mode: "copy", sessions: 3 });
    const result = await runStorageMigration(h.deps);
    expect(result).toMatchObject({ phase: "done", sessionsCopied: 3, switched: false, version: null });
    expect(h.target.canonical.size).toBe(3);
    expect(h.target.artifacts.get(`${sessionRef(key(0))}/session.json`)).toBe('{"id":"s0"}');
    // The candidate proves itself before anything is copied into it…
    expect(h.target.selfTests).toBe(1);
    // …and nothing was armed, paused or switched.
    expect(h.trace).toEqual([]);
  });

  test("a switch copies, cuts, rebinds and verifies", async () => {
    const h = harness({ sessions: 2 });
    const result = await runStorageMigration(h.deps);
    expect(result).toMatchObject({ phase: "done", switched: true, version: 4, aborted: null });
    // The order is the whole point: the credentials move first, and the live
    // binding follows them. The window is armed in heartbeats, and the fence
    // re-arms before it measures — so the episode the resume names is the last
    // one, never the first.
    expect(h.trace).toEqual([
      "drain:on",
      `pause:${new Date(NOW + 60_000).toISOString()}`,
      `pause:${new Date(NOW + 60_000).toISOString()}`,
      "swap",
      "rebind",
      "resume:episode-2",
      "drain:off",
    ]);
  });
});

describe("the gate, not the request", () => {
  test("a pause the daemon never reports in force switches nothing", async () => {
    const h = harness({ sessions: 1, gateConfirmMs: 5_000 });
    // The row is written and the gate never notices it: the store is still
    // admitting commits, so a barrier here would be measuring the wrong moment.
    h.gate.blind = true;
    const result = await runStorageMigration(h.deps);
    expect(result.phase).toBe("aborted");
    expect(result.aborted).toContain("never reported the pause in force");
    expect(h.trace).not.toContain("swap");
    // The episode must not outlive the run that armed it.
    expect(h.trace.some((t) => t.startsWith("resume:"))).toBe(true);
  });

  test("a clamped episode aborts instead of cutting against a window nothing honours", async () => {
    const h = harness({ sessions: 1 });
    // The daemon will hold writes for 10s, not the 60s that was asked for.
    h.gate.cap = NOW + 10_000;
    const result = await runStorageMigration(h.deps);
    expect(result.phase).toBe("aborted");
    expect(result.aborted).toContain("clamped");
    expect(h.trace).not.toContain("swap");
  });

  test("the fence re-PROVES the pause; a gate that stopped reporting it refuses the cut", async () => {
    const h = harness({ sessions: 1, gateConfirmMs: 5_000 });
    let refreshes = 0;
    h.deps.refreshGate = async (): Promise<void> => {
      refreshes += 1;
      // The daemon stops seeing the row once the barrier has been proven. A
      // fence that compared its own arithmetic instead of asking would cut here.
      if (refreshes > 1) h.gate.blind = true;
      h.gate.refresh();
    };
    const result = await runStorageMigration(h.deps);
    expect(result.switched).toBe(false);
    expect(h.trace).not.toContain("swap");
  });

  test("a barrier longer than one heartbeat re-arms rather than lapsing", async () => {
    const h = harness({ sessions: 1, barrierMs: 120_000 });
    // Never goes quiet, so the barrier runs its full two minutes — twice the
    // length of one pause episode.
    h.quiesce.enter();
    const result = await runStorageMigration(h.deps);
    expect(result.phase).toBe("aborted");
    const arms = h.trace.filter((t) => t.startsWith("pause:"));
    expect(arms.length).toBeGreaterThan(1);
    // Each one is its own episode row: the clamp is anchored on a column only an
    // INSERT stamps, so an extension cannot be a moved deadline.
    expect(new Set(arms).size).toBeGreaterThan(1);
  });

  test("a pause that could not be released is reported, not swallowed", async () => {
    const h = harness({
      sessions: 1,
      resumeIngest: async () => {
        throw new Error("the fortress database went away");
      },
    });
    const result = await runStorageMigration(h.deps);
    expect(result.switched).toBe(true);
    expect(result.resumeFailed).toContain("went away");
    expect(describeMigration(result, "b")).toContain("INGEST IS STILL PAUSED");
  });
});

describe("proving the copy landed", () => {
  test("the checksum is taken from what the TARGET returns", async () => {
    const target = new MemoryStore("target");
    target.corrupt = "these are not the bytes that were sent\n";
    const h = harness({ target, sessions: 1 });
    await expect(runStorageMigration(h.deps)).rejects.toThrow(/checksum mismatch/);
    // Nothing was switched over a target the run stopped trusting.
    expect(h.trace).toEqual([]);
  });

  test("a copy interrupted mid-way is finished by the next run, not restarted", async () => {
    const source = seeded(4);
    const target = new MemoryStore("target");
    const recorded = new Set<string>();
    target.failOn = sessionRef(key(2));
    const first = harness({
      mode: "copy",
      source,
      target,
      recordCopied: async (object) => {
        recorded.add(sessionRef(object.key));
      },
      alreadyCopied: async () => recorded,
    });
    await expect(runStorageMigration(first.deps)).rejects.toThrow(/refused/);
    expect(recorded.size).toBe(2);

    const second = harness({
      mode: "copy",
      source,
      target,
      recordCopied: async (object) => {
        recorded.add(sessionRef(object.key));
      },
      alreadyCopied: async () => recorded,
    });
    const result = await runStorageMigration(second.deps);
    // Only what was missing: the two already proven are skipped.
    expect(result.sessionsCopied).toBe(2);
    expect(target.canonical.size).toBe(4);
  });

  test("a session appended to after its copy is carried by the delta, not narrowed out of it", async () => {
    const source = seeded(1);
    const target = new MemoryStore("target");
    const ref = sessionRef(key(0));
    // The bulk copy already happened; the session grew afterwards. The target
    // holds a SHORT canonical and the record says the session is done — which is
    // the state an existence check calls finished and truncates for good.
    target.canonical.set(ref, source.canonical.get(ref) ?? "");
    target.artifacts.set(`${ref}/session.json`, source.artifacts.get(`${ref}/session.json`) ?? "");
    source.canonical.set(ref, `${source.canonical.get(ref) ?? ""}{"type":"user","text":"and then"}\n`);
    const h = harness({ mode: "copy", source, target, alreadyCopied: async () => new Set([ref]) });
    const result = await runStorageMigration(h.deps);
    expect(result.sessionsCopied).toBe(1);
    expect(target.canonical.get(ref)).toBe(source.canonical.get(ref));
  });

  test("a zero-byte canonical is an object, so the delta converges instead of burning every pass", async () => {
    const source = new MemoryStore("source");
    // Written and never appended to: it exists, and it is empty. Read for
    // truthiness it is indistinguishable from absent, and the delta re-copies it
    // until it runs out of passes — inside the pause, on a fortress with any
    // number of them.
    source.canonical.set(sessionRef(key(0)), "");
    const h = harness({ mode: "copy", source, target: new MemoryStore("target") });
    const result = await runStorageMigration(h.deps);
    expect(result.sessionsCopied).toBe(1);
    expect(result.deltaPasses).toBe(1);
  });

  test("a canonical that arrived short fails verification instead of reading as a clean cut", async () => {
    const source = seeded(1);
    const target = new MemoryStore("target");
    const h = harness({ source, target });
    // Present, readable, and not the object the source holds — the shape a
    // name-set or existence comparison reports as a clean move.
    h.deps.rebindStore = async (): Promise<void> => {
      target.canonical.set(sessionRef(key(0)), "");
      h.trace.push("rebind");
    };
    const result = await runStorageMigration(h.deps);
    expect(result.switched).toBe(true);
    expect(result.aborted).toContain("did not arrive whole");
    expect(result.aborted).toContain("0 of");
  });

  test("a sidecar the live target rewrote SHORTER is not a loss, and is not reported as one", async () => {
    const source = seeded(1);
    const target = new MemoryStore("target");
    const h = harness({ source, target });
    // Verification runs after the cut, so the target is the live bucket while the
    // source is frozen. A sidecar is rewritten whole on every commit, and the
    // rewrite is routinely shorter — a first-message-derived title replaced by
    // the real one. Reporting that as "did not arrive whole" would put a
    // fabricated partial-loss on the compliance surface.
    h.deps.rebindStore = async (): Promise<void> => {
      target.artifacts.set(`${sessionRef(key(0))}/session.json`, "{}");
      h.trace.push("rebind");
    };
    const result = await runStorageMigration(h.deps);
    expect(result.switched).toBe(true);
    expect(result.aborted).toBeNull();
  });

  test("a sidecar the target never received IS reported", async () => {
    const source = seeded(1);
    const target = new MemoryStore("target");
    const h = harness({ source, target });
    // Presence is what verification still asserts: an object the source has and
    // the target does not is a loss whatever is writing to the target.
    h.deps.rebindStore = async (): Promise<void> => {
      target.artifacts.delete(`${sessionRef(key(0))}/session.json`);
      h.trace.push("rebind");
    };
    const result = await runStorageMigration(h.deps);
    expect(result.switched).toBe(true);
    expect(result.aborted).toContain("session.json");
  });

  test("a record whose object is gone is re-copied anyway", async () => {
    const source = seeded(2);
    const target = new MemoryStore("target");
    // The record claims both; the bucket holds neither.
    const claimed = new Set([sessionRef(key(0)), sessionRef(key(1))]);
    const h = harness({ mode: "copy", source, target, alreadyCopied: async () => claimed });
    const result = await runStorageMigration(h.deps);
    expect(result.sessionsCopied).toBe(2);
    expect(target.canonical.size).toBe(2);
  });

  test("the verify pass reports what the new binding cannot read", async () => {
    const source = seeded(2);
    const target = new MemoryStore("target");
    const h = harness({ source, target });
    // Something removes it from the target after the copy but before the cut.
    const original = target.statCanonical.bind(target);
    let cut = false;
    target.statCanonical = async (k: SessionKey): Promise<number | null> =>
      cut && sessionRef(k) === sessionRef(key(1)) ? null : original(k);
    h.deps.rebindStore = async (): Promise<void> => {
      cut = true;
      h.trace.push("rebind");
    };
    const result = await runStorageMigration(h.deps);
    // Switched — and honest about what did not come with it. The source still
    // holds everything, which is what makes going back a credentials change.
    expect(result.switched).toBe(true);
    expect(result.aborted).toContain("did not arrive whole in the new bucket");
  });
});

describe("the drain, the barrier and the fence", () => {
  test("outstanding signatures run off BEFORE the pause is armed", async () => {
    const h = harness({ sessions: 1 });
    // A presigned PUT minted before the drain: it lands in the bucket without
    // passing through this process, so a pause cannot stop it.
    h.quiesce.noteSignature(new Date(NOW + 90_000));
    const result = await runStorageMigration(h.deps);
    expect(result.switched).toBe(true);
    const drainAt = h.trace.indexOf("drain:on");
    const pauseAt = h.trace.findIndex((t) => t.startsWith("pause:"));
    expect(drainAt).toBeLessThan(pauseAt);
    // The wait happened outside the pause: the deadline the pause was armed for
    // starts after the signature floor, not before it.
    const armed = Date.parse(h.trace[pauseAt]?.slice("pause:".length) ?? "");
    expect(armed).toBeGreaterThanOrEqual(NOW + 90_000);
  });

  test("a store that never goes quiet aborts, and ingest is resumed anyway", async () => {
    const h = harness({ sessions: 1, barrierMs: 5_000 });
    h.quiesce.enter();
    const result = await runStorageMigration(h.deps);
    expect(result.phase).toBe("aborted");
    expect(result.aborted).toContain("did not go quiet");
    expect(result.switched).toBe(false);
    expect(h.trace).not.toContain("swap");
    // The pause must not outlive the run that armed it.
    expect(h.trace).toContain("resume:episode-1");
    expect(h.trace).toContain("drain:off");
  });

  test("a nearly-spent pause aborts before the cut rather than after it", async () => {
    const h = harness({ sessions: 1, swapPauseMs: FENCE_MARGIN_MS + 1_000 });
    // The barrier itself is instant; the delta inside the pause is what runs
    // long here, which is exactly the case the fence exists for.
    let passes = 0;
    const listAll = h.source.listAllCanonicalKeys.bind(h.source);
    h.source.listAllCanonicalKeys = async (): Promise<SessionKey[]> => {
      passes += 1;
      if (passes > 2) h.advance(FENCE_MARGIN_MS);
      return await listAll();
    };
    const result = await runStorageMigration(h.deps);
    expect(result.phase).toBe("aborted");
    expect(result.aborted).toContain("nearly spent");
    expect(h.trace).not.toContain("swap");
  });

  test("the in-pause work HEARTBEATS, so a long final delta does not lapse the window", async () => {
    // The final delta reads every sidecar from both buckets and the replay makes
    // a round trip per tombstone; either can outlast one episode. Without a beat
    // from inside their loops the window silently expires, writes reopen behind
    // them, and the fence sees only the fresh episode it armed itself.
    // Production timings: a 60 s episode, and the fence needs 30 s of it left.
    const h = harness({ sessions: 4, swapPauseMs: 30 * 60_000 });
    const readText = h.source.readArtifactText.bind(h.source);
    h.source.readArtifactText = async (k, name): Promise<string | null> => {
      // Each sidecar read costs a third of an episode, so the in-pause delta
      // outlives many of them.
      h.advance(20_000);
      return await readText(k, name);
    };
    const result = await runStorageMigration(h.deps);
    expect(result.phase).toBe("done");
    expect(result.switched).toBe(true);
    // Re-armed repeatedly rather than once: every extension is its own episode.
    const episodes = h.trace.filter((t) => t.startsWith("pause:"));
    expect(episodes.length).toBeGreaterThan(3);
  });

  test("a sidecar-heavy COPY inside the pause heartbeats too", async () => {
    // copySession was the one in-pause loop with no beat: three round trips per
    // sidecar, so one session could outlast an episode on its own and the fence
    // then refused a healthy cut with most of the budget unspent.
    const h = harness({ sessions: 1, swapPauseMs: 30 * 60_000 });
    // A sidecar REWRITTEN as the drain arms: the canonical is untouched, so only
    // the final in-pause pass (which hashes sidecars) notices, and it re-copies
    // that session while the window is armed.
    // Six of them, so the copy is a long walk rather than one long call — which
    // is the shape a beat can actually save.
    for (let i = 0; i < 6; i += 1) {
      await h.source.writeArtifact(key(0), `workflow-run${i}.json`, `{"i":${i}}`);
    }
    const armDrain = h.deps.armDrain;
    h.deps.armDrain = (on: boolean): void => {
      if (on) void h.source.writeArtifact(key(0), "session.json", '{"updatedAt":"later"}');
      armDrain(on);
    };
    // Each write costs a third of an episode: no single one outlasts the window,
    // but the seven together outlast three of them.
    const write = h.target.writeArtifact.bind(h.target);
    h.target.writeArtifact = async (k, name, text): Promise<void> => {
      h.advance(20_000);
      await write(k, name, text);
    };
    const result = await runStorageMigration(h.deps);
    expect(result.phase).toBe("done");
    expect(result.switched).toBe(true);
    // …and the re-copy really happened inside the pause.
    expect(await h.target.readArtifactText(key(0), "session.json")).toBe('{"updatedAt":"later"}');
  });

  test("a window that LAPSED under the in-pause work refuses the cut", async () => {
    // Re-arming afterwards makes the gate agree again but cannot undo the writes
    // admitted while it was open — and a permanent delete landing then is read
    // from neither list: the source loses it, the target keeps it, and
    // verification walks the source, so nothing ever notices.
    const h = harness({ sessions: 1, swapPauseMs: 30_000, tombstones: async () => [key(0)] });
    h.target.deleteSession = async (): Promise<DeleteSessionResult> => {
      // One round trip that outlives the whole budget.
      h.advance(90_000);
      return { complete: true, deleted: 1 };
    };
    const result = await runStorageMigration(h.deps);
    expect(result.phase).toBe("aborted");
    expect(result.aborted).toContain("expired");
    expect(result.switched).toBeFalsy();
    expect(h.trace).not.toContain("swap");
  });

  test("the pause window is bounded, not open-ended", async () => {
    const h = harness({ sessions: 1, swapPauseMs: 30_000 });
    await runStorageMigration(h.deps);
    const armed = h.trace.find((t) => t.startsWith("pause:")) ?? "";
    // Armed for exactly what was asked for, from the clock at arm time.
    expect(Date.parse(armed.slice("pause:".length)) - NOW).toBe(30_000);
  });
});

describe("what the source is never asked to do", () => {
  test("no run deletes anything from the source bucket", async () => {
    const h = harness({
      sessions: 3,
      tombstones: async () => [key(0), key(1)],
    });
    const result = await runStorageMigration(h.deps);
    expect(result.switched).toBe(true);
    // The tombstones were replayed onto the TARGET…
    expect(h.target.deletes.sort()).toEqual([sessionRef(key(0)), sessionRef(key(1))].sort());
    // …and the source still holds everything it held, which is the rollback.
    expect(h.source.deletes).toEqual([]);
    expect(h.source.canonical.size).toBe(3);
  });

  test("a tombstoned session is absent from the target after the replay", async () => {
    const source = seeded(2);
    const target = new MemoryStore("target");
    // Copied before the delete: the object is in the target and the session is
    // gone from here. Without the replay, the cut resurrects it.
    target.canonical.set(sessionRef(key(9)), "resurrected\n");
    const h = harness({ source, target, tombstones: async () => [key(9)] });
    await runStorageMigration(h.deps);
    expect(target.canonical.has(sessionRef(key(9)))).toBe(false);
    expect(target.deletes).toEqual([sessionRef(key(9))]);
  });

  test("the engine contains no delete against the source, as source rather than as claim", () => {
    const engine = readFileSync(
      path.join(import.meta.dir, "..", "src", "console", "migration.ts"),
      "utf8",
    );
    expect(engine).not.toMatch(/source\.deleteSession/);
    expect(engine).not.toMatch(/source\.writeCanonicalText/);
    // The only delete in the file is the one aimed at the target.
    const deletes = engine.match(/\w+\.deleteSession\(/g) ?? [];
    expect(deletes).toEqual(["target.deleteSession("]);
  });
});

describe("one session", () => {
  test("carries every sidecar it HAS, enumerated rather than named", async () => {
    const source = seeded(1);
    // `workflow-<runId>.json` is an unbounded class of reachable writes: no fixed
    // list of names can hold it, and a copy loop built on one leaves it behind.
    source.artifacts.set(`${sessionRef(key(0))}/workflow-run-42.json`, '{"run":"42"}');
    source.artifacts.set(`${sessionRef(key(0))}/plan.json`, '{"plan":1}');
    const target = new MemoryStore("target");
    const copied = await copySession(source, target, key(0));
    expect(copied.checksum).toHaveLength(64);
    expect(copied.bytes).toBeGreaterThan(0);
    expect(await target.listSessionArtifacts(key(0))).toEqual([
      "plan.json",
      "session.json",
      "workflow-run-42.json",
    ]);
    // Nothing is invented for a sidecar this session never had.
    expect(await target.readArtifactText(key(0), "tasks.json")).toBeNull();
  });

  test("a sidecar the target lacks fails verification instead of reading as a clean cut", async () => {
    const source = seeded(1);
    source.artifacts.set(`${sessionRef(key(0))}/workflow-run-42.json`, "{}");
    const target = new MemoryStore("target");
    const h = harness({ source, target });
    // Something removes it from the target after the copy but before the cut.
    h.deps.rebindStore = async (): Promise<void> => {
      target.artifacts.delete(`${sessionRef(key(0))}/workflow-run-42.json`);
      h.trace.push("rebind");
    };
    const result = await runStorageMigration(h.deps);
    expect(result.switched).toBe(true);
    expect(result.aborted).toContain("workflow-run-42.json");
  });
});

// ── the runner ───────────────────────────────────────────────────────────────

interface FakeDb {
  db: HxDb;
  statements: string[];
  /** Bound values, parallel to `statements` — a status reaches the row as a
   *  parameter, so the rendered SQL says `$3` where the word is. */
  values: unknown[][];
}

function fakeDb(over: { episode?: boolean; openRun?: string | null } = {}): FakeDb {
  const statements: string[] = [];
  const values: unknown[][] = [];
  const db = {
    execute: async (statement: SQL) => {
      const query = dialect.sqlToQuery(statement);
      const sql = query.sql;
      statements.push(sql);
      values.push(query.params);
      if (sql.includes("FROM hx.ingest_control")) {
        return over.episode
          ? [
              {
                id: "episode-7",
                paused_until: new Date(Date.now() + 60_000),
                resumed_at: null,
                row_written_at: new Date(),
                reason: "storage migration",
              },
            ]
          : [];
      }
      if (sql.includes("INSERT INTO hx.ingest_control")) return [{ id: "episode-9" }];
      if (sql.includes("FROM hx.migration_runs")) {
        return over.openRun === undefined || over.openRun === null ? [] : [{ id: over.openRun }];
      }
      if (sql.includes("INSERT INTO hx.migration_runs")) return [{ id: "run-1" }];
      if (sql.includes("FROM hx.migration_objects")) return [];
      if (sql.includes("FROM hx.deleted_sessions")) return [];
      return [];
    },
  } as unknown as HxDb;
  return { db, statements, values };
}

/** The bound values of the last statement matching `needle`. */
function lastValues(fake: FakeDb, needle: string): unknown[] {
  for (let i = fake.statements.length - 1; i >= 0; i -= 1) {
    if (fake.statements[i]?.includes(needle)) return fake.values[i] ?? [];
  }
  return [];
}

const TARGET_CREDS: VaultCredentials = {
  store: "s3",
  bucket: "hx-fortress-seed-secondary",
  region: "us-east-1",
};

function runnerDeps(over: Partial<MigrationRunnerDeps> = {}): MigrationRunnerDeps {
  const source = seeded(2);
  const target = new MemoryStore("target");
  return {
    db: () => fakeDb().db,
    store: () => source,
    buildTarget: () => target,
    quiesce: new IngestQuiesce(),
    gate: () => ({ pausedUntil: new Date(Date.now() + 60_000), capped: false }),
    refreshGate: async () => {},
    setDrain: () => {},
    rebindStore: async () => {},
    targetCredentials: async () => TARGET_CREDS,
    env: {},
    logger: LOGGER,
    ...over,
  };
}

let home = "";
let previousHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "hx-migrate-"));
  previousHome = process.env.HOME;
  process.env.HOME = home;
  await writeVaultCredentials({
    store: "s3",
    bucket: "hx-fortress-seed-primary",
    region: "us-east-1",
    openaiApiKey: "sk-embedding-key",
    version: 4,
  });
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

describe("what a command refuses before it copies anything", () => {
  test("an env-managed fortress, by naming the variable", async () => {
    await expect(
      runMigrationCommand(runnerDeps({ env: { FORTRESS_STORAGE_BUCKET: "from-env" } }), {
        command: "arm",
        target: null,
      }),
    ).rejects.toThrow(envManagedRefusal("storage"));
  });

  test("a target that is the bucket this fortress already serves", async () => {
    await expect(
      runMigrationCommand(
        runnerDeps({
          targetCredentials: async () => ({ ...TARGET_CREDS, bucket: "hx-fortress-seed-primary" }),
        }),
        { command: "arm", target: null },
      ),
    ).rejects.toThrow(/already serves from/);
  });

  test("a named bucket the credential file does not name", async () => {
    await expect(
      runMigrationCommand(runnerDeps(), { command: "swap", target: "somebody-elses-bucket" }),
    ).rejects.toThrow(/not the one these credentials name/);
  });

  test("a credential reference that was already consumed", async () => {
    await expect(
      runMigrationCommand(runnerDeps({ targetCredentials: async () => null }), {
        command: "arm",
        target: null,
      }),
    ).rejects.toThrow(/already consumed, expired or unreadable/);
  });

  test("a fortress with no database to record the run in", async () => {
    await expect(
      runMigrationCommand(runnerDeps({ db: () => null }), { command: "arm", target: null }),
    ).rejects.toThrow(/database is not available/);
  });
});

describe("arm, swap, resume", () => {
  test("arm copies, leaves the run open, and raises the short-TTL floor", async () => {
    const fake = fakeDb();
    const target = new MemoryStore("target");
    const drain: boolean[] = [];
    const outcome = await runMigrationCommand(
      runnerDeps({
        db: () => fake.db,
        buildTarget: () => target,
        setDrain: (on) => void drain.push(on),
      }),
      { command: "arm", target: TARGET_CREDS.bucket },
    );
    expect(outcome).toContain("copied to hx-fortress-seed-secondary");
    expect(outcome).toContain("swap when ready");
    expect(target.canonical.size).toBe(2);
    expect(drain).toEqual([true]);
    // credentials.json still names the source: an arm is not a cut.
    expect((await readVaultCredentials())?.bucket).toBe("hx-fortress-seed-primary");
    // The run stays resumable — a copy closed early is a resume that starts over.
    const finish = fake.statements.filter((s) => s.includes("UPDATE hx.migration_runs")).at(-1) ?? "";
    expect(finish).toContain("finished_at = finished_at");
  });

  test("the swap writes credentials.json through the one door, and bumps the version", async () => {
    const fake = fakeDb();
    let rebinds = 0;
    const outcome = await runMigrationCommand(
      runnerDeps({ db: () => fake.db, rebindStore: async () => void (rebinds += 1) }),
      { command: "swap", target: TARGET_CREDS.bucket },
    );
    const after = await readVaultCredentials();
    expect(after?.bucket).toBe("hx-fortress-seed-secondary");
    // The version the console's live reader watches for MOVED…
    expect(after?.version).toBe(5);
    // …the embedding key, which belongs to neither bucket, survived…
    expect(after?.openaiApiKey).toBe("sk-embedding-key");
    // …the live binding followed the file…
    expect(rebinds).toBe(1);
    expect(outcome).toContain("credentials.json is at version 5");
    // …and the run is closed, because the cut is terminal.
    const finish = fake.statements.filter((s) => s.includes("UPDATE hx.migration_runs")).at(-1) ?? "";
    expect(finish).toContain("finished_at = now()");
  });

  test("the swap leaves no lock behind for the next writer", async () => {
    await runMigrationCommand(runnerDeps(), { command: "swap", target: TARGET_CREDS.bucket });
    await expect(readFile(`${credentialsPath()}.lock`, "utf8")).rejects.toThrow();
  });

  test("resume clears the episode and lowers the floor", async () => {
    const fake = fakeDb({ episode: true });
    const drain: boolean[] = [];
    const outcome = await runMigrationCommand(
      runnerDeps({ db: () => fake.db, setDrain: (on) => void drain.push(on) }),
      { command: "resume", target: null },
    );
    expect(drain).toEqual([false]);
    expect(outcome).toContain("episode-7");
    expect(fake.statements.some((s) => s.includes("UPDATE hx.ingest_control"))).toBe(true);
  });

  test("a switch that failed its verification is recorded as switched, never aborted", async () => {
    const fake = fakeDb();
    const source = seeded(1);
    const target = new MemoryStore("target");
    const outcome = await runMigrationCommand(
      runnerDeps({
        db: () => fake.db,
        store: () => source,
        buildTarget: () => target,
        // The target loses its objects between the cut and the verification.
        rebindStore: async () => {
          target.canonical.clear();
        },
      }),
      { command: "swap", target: TARGET_CREDS.bucket },
    );
    expect(outcome).toContain("did not verify");
    // `aborted` means nothing was switched, and the same row carries switched_at.
    expect(lastValues(fake, "UPDATE hx.migration_runs")).toContain("switched_unverified");
  });

  test("a second command is refused while one is running, resume included", async () => {
    let release = (): void => {};
    const held = new Promise<void>((r) => (release = r));
    const first = runMigrationCommand(
      runnerDeps({
        targetCredentials: async () => {
          await held;
          return TARGET_CREDS;
        },
      }),
      { command: "arm", target: TARGET_CREDS.bucket },
    );
    // The poll claims each row as it finds one, so two commands genuinely
    // overlap — and the run that holds the pause is the one that releases it.
    await expect(
      runMigrationCommand(runnerDeps(), { command: "resume", target: null }),
    ).rejects.toThrow(MIGRATION_BUSY_REFUSAL);
    release();
    await first;
    // The latch is per-run, not a one-way door.
    await expect(
      runMigrationCommand(runnerDeps(), { command: "resume", target: null }),
    ).resolves.toContain("normal lifetime");
  });

  test("a rotation submitted while the copy runs is refused, though no pause exists yet", async () => {
    let release = (): void => {};
    const held = new Promise<void>((r) => (release = r));
    const copying = runMigrationCommand(
      runnerDeps({
        targetCredentials: async () => {
          await held;
          return TARGET_CREDS;
        },
      }),
      { command: "arm", target: TARGET_CREDS.bucket },
    );
    const cmdCredsDir = path.join(home, "cmd-creds");
    const ref = mintCredentialRef();
    await writeCredentialRef(cmdCredsDir, ref, {
      target: "storage",
      credentials: { store: "s3", bucket: "a-third-bucket", region: "us-east-1" },
    });
    const executors = createCommandExecutors({
      logger: LOGGER,
      store: () => null,
      downloadBaseUrl: async () => null,
      service: {} as unknown as ServiceManager,
      cmdCredsDir,
      env: {},
      // NO database, so nothing here can consult the pause row: the copy phase
      // arms no pause (the pause belongs to the swap), and the latch is the only
      // thing that knows a migration is under way. Without it this rotation
      // rewrites credentials.json under a run about to name the target bucket,
      // and live ingest lands in a third bucket the swap orphans.
      db: () => null,
      rebindStore: async () => {},
      setCloudCredential: async () => {
        throw new Error("not wired");
      },
      status: async () => null,
      embeddingEndpoint: () => null,
      runAudit: async () => {
        throw new Error("not wired");
      },
      runMigration: async () => "moved",
      setCloudWitness: async () => {},
      acknowledgeFinding: async () => {},
      onBinarySwapped: () => {},
    });
    await expect(
      executors.rotate_credentials({ id: "c1", params: {}, credentialRef: ref }),
    ).rejects.toThrow("a storage migration is in progress");
    release();
    await copying;
    // The refusal lasts exactly as long as the run does.
    expect(migrationIsRunning()).toBe(false);
  });

  test("resume on a fortress that was never paused says so instead of failing", async () => {
    const outcome = await runMigrationCommand(runnerDeps({ db: () => fakeDb().db }), {
      command: "resume",
      target: null,
    });
    expect(outcome).toContain("no pause was armed");
  });
});

// ── the plane ────────────────────────────────────────────────────────────────

describe("the command surface", () => {
  test("the console's three phases are the runner's three commands", () => {
    expect([...MIGRATION_PHASES]).toEqual([...MIGRATION_COMMANDS]);
    for (const phase of MIGRATION_PHASES) expect(isMigrationCommand(phase)).toBe(true);
    expect(isMigrationCommand("teleport")).toBe(false);
    expect(validateCommandParams("run_migration", { phase: "arm" }).ok).toBe(true);
    expect(validateCommandParams("run_migration", { phase: "teleport" }).ok).toBe(false);
  });

  test("this build runs the kind, and a row asking for a step it has no name for fails", async () => {
    const calls: unknown[] = [];
    const executors = createCommandExecutors({
      logger: LOGGER,
      store: () => null,
      downloadBaseUrl: async () => null,
      service: {} as unknown as ServiceManager,
      cmdCredsDir: path.join(home, "cmd-creds"),
      env: {},
      db: () => null,
      rebindStore: async () => {},
      setCloudCredential: async () => {
        throw new Error("not wired");
      },
      status: async () => null,
      embeddingEndpoint: () => null,
      runAudit: async () => {
        throw new Error("not wired");
      },
      runMigration: async (args) => {
        calls.push(args);
        return "moved";
      },
      setCloudWitness: async () => {},
      acknowledgeFinding: async () => {},
      onBinarySwapped: () => {},
    });
    await expect(
      executors.run_migration({
        id: "c1",
        params: { phase: "swap", target: "b" },
        credentialRef: "a".repeat(32),
      }),
    ).resolves.toBe("moved");
    expect(calls).toEqual([{ command: "swap", target: "b", credentialRef: "a".repeat(32) }]);
    await expect(
      executors.run_migration({ id: "c2", params: { phase: "teleport" }, credentialRef: null }),
    ).rejects.toThrow(/unknown storage-migration phase: teleport/);
  });

  test("the console offers the kind, so the control it ships can mint the row", () => {
    // Offered and controlled are one decision: a kind missing from this list
    // 404s at the mint, and the whole engine behind it is unreachable code.
    expect(OFFERED_COMMAND_KINDS).toContain("run_migration");
  });

  test("the control mints a row that names the bucket and a reference to its key", async () => {
    const dir = path.join(home, "spool");
    const audit = new ConsoleAudit(new AuditSpool({ dir, writer: "ui" }));
    const minted: unknown[] = [];
    const submitted: Array<Record<string, unknown>> = [];
    const port: ConsoleWritePort = {
      serviceRefusal: () => null,
      service: async () => ({ action: "start", manager: "m", pid: 1, copy: "" }),
      heartbeatAt: async () => new Date().toISOString(),
      offered: () => OFFERED_COMMAND_KINDS,
      async mintCredential(payload) {
        minted.push(payload);
        return "a".repeat(32);
      },
      async submit(_kind, params, _requestedBy, credentialRef) {
        submitted.push({ ...params, credentialRef });
        return { id: "id-1" };
      },
    };
    const secret = { store: "s3", bucket: TARGET_CREDS.bucket, region: "us-east-1" };
    const res = await handleMutateRoute(
      new Request(`http://console.local${MUTATE_PATHS.commands}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "run_migration",
          params: { phase: "arm", target: TARGET_CREDS.bucket },
          secret,
        }),
      }),
      { port, audit, actor: "op", sessionId: "s1" },
    );
    expect(res?.status).toBe(202);
    // The key goes to a 0600 single-use file; the row carries its reference and
    // the bucket NAME, which is what makes the run record auditable at all.
    expect(minted).toEqual([secret]);
    // The bucket NAME is a parameter; the key's reference is the row's own
    // column, which is the only place the daemon reads it from.
    expect(submitted).toEqual([
      { phase: "arm", target: TARGET_CREDS.bucket, credentialRef: "a".repeat(32) },
    ]);
  });

  test("a read route renders the runs, and asks for no write to do it", async () => {
    const run = {
      id: "run-1",
      startedAt: "2026-07-31T12:00:00.000Z",
      finishedAt: null,
      mode: "copy",
      status: "running",
      phase: "copying",
      sourceBucket: "old",
      targetBucket: "new",
      sessionsTotal: 4,
      sessionsCopied: 2,
      bytesCopied: 2048,
      deltaPasses: 1,
      switchedAt: null,
      error: null,
    };
    const res = await handleReadRoute(
      new Request(`http://console.local${READ_PATHS.migrations}`),
      {
        port: { migrations: async () => [run] } as unknown as ConsoleReadPort,
        audit: {
          recordExport: async () => {
            throw new Error("a plain read must not reach the audit spool");
          },
        },
        actor: "op",
        sessionId: "s1",
      },
    );
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ migrations: [run] });
    expect(READ_ROUTES.find((r) => r.path === READ_PATHS.migrations)?.cls).toBe("read");
  });
});

describe("the run record", () => {
  test("0019 creates it, with the cloud-served read roles revoked at creation", () => {
    const runs = migrations.find((m) => m.name === "0023_migration_runs");
    expect(runs).toBeDefined();
    const sql = runs?.sql ?? "";
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "hx"."migration_runs"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "hx"."migration_objects"');
    expect(sql).toContain("REVOKE ALL ON hx.migration_runs FROM hx_readonly");
    expect(sql).toContain("REVOKE ALL ON hx.migration_objects FROM hx_app_ro");
  });

  test("the console reads it and writes neither table", () => {
    const matrix = expectedPrivilegeMatrix();
    for (const table of ["migration_runs", "migration_objects"]) {
      expect(CONSOLE_TABLES).toContain(table as (typeof CONSOLE_TABLES)[number]);
      expect(UI_TABLE_GRANTS.find((g) => g.table === table)?.privileges).toEqual(["SELECT"]);
      expect(matrix[`t:hx_ui:${table}:SELECT`]).toBe(true);
      expect(matrix[`t:hx_ui:${table}:INSERT`]).toBe(false);
      // The daemon runs the move, so it owns the record of it.
      expect(matrix[`t:hx_app_rw:${table}:INSERT`]).toBe(true);
      // A run names buckets and session ids; the cloud-served read roles have no
      // business with either.
      expect(matrix[`t:hx_readonly:${table}:SELECT`]).toBe(false);
      expect(matrix[`t:hx_app_ro:${table}:SELECT`]).toBe(false);
    }
  });
});


describe("replaying a permanent delete onto the target", () => {
  test("re-invokes until the store says complete — one call leaves the rest behind", async () => {
    // Both backends stop at a batch limit so a call fits the tunnel RPC window.
    // Calling once removed the first batch of a permanently-deleted session and
    // moved on; everything past it had already been copied into the new bucket
    // and stayed there, invisible to verification (which walks the SOURCE).
    const source = seeded(1);
    const target = new MemoryStore("target");
    const gone = key(0);
    // Three batches' worth at the engine's own limit.
    target.pendingDeletes.set(sessionRef(gone), 1_700);
    target.canonical.set(sessionRef(gone), "x");

    const h = harness({ source, target });
    h.deps.tombstones = async () => [gone];
    const result = await runStorageMigration(h.deps);

    expect(result.switched).toBe(true);
    const calls = target.deletes.filter((d) => d === sessionRef(gone)).length;
    expect(calls).toBeGreaterThan(1);
    expect(target.pendingDeletes.get(sessionRef(gone))).toBe(0);
  });

  test("a session with no canonical is still deleted — its bytes may be under its lanes", async () => {
    // The old gate was `statCanonical`, which resolves only the parent prefix, so
    // a turn-less parent whose objects live entirely under `:a:<agentId>` looked
    // absent and was skipped — its lanes copied to the target and never removed.
    const source = seeded(1);
    const target = new MemoryStore("target");
    const laneOnly = key(0);
    target.pendingDeletes.set(sessionRef(laneOnly), 1);
    // Deliberately NO canonical for it in the target.

    const h = harness({ source, target });
    h.deps.tombstones = async () => [laneOnly];
    await runStorageMigration(h.deps);

    expect(target.deletes).toContain(sessionRef(laneOnly));
  });
});

describe("which names count as a session's sidecars", () => {
  test("admits the fixed set AND the workflow pattern, and nothing else", () => {
    // The migration's enumeration rests on this predicate: a name it rejects is
    // an object the copy never carries and verification never misses. The suite
    // drove MemoryStore.listSessionArtifacts, which returns every key under the
    // prefix with no filtering, so it passed identically if the real filter
    // dropped a class.
    for (const name of ["session.json", "tasks.json", "plan.json", "workflow-abc123.json"]) {
      expect([name, isSessionArtifactName(name)]).toEqual([name, true]);
    }
    for (const name of [
      "log.jsonl", // the canonical, not a sidecar
      ".staging/chunk-1.json",
      "workflow-.json", // too short for the runId charset
      "workflow-abc/def.json", // a separator has no business in a segment
      "../escape.json",
      "session.json.bak",
      "",
    ]) {
      expect([name, isSessionArtifactName(name)]).toEqual([name, false]);
    }
  });

  test("keeps only the sidecars from a realistic bucket listing", () => {
    // With the trailing slash, exactly as both stores build it.
    const prefix = "u1/claude/s1/";
    const listing = [
      `${prefix}log.jsonl`,
      `${prefix}session.json`,
      `${prefix}tasks.json`,
      `${prefix}workflow-run-9.json`,
      `${prefix}.staging/chunk-1.json`,
      "u1/claude/s1:a:agent-1/log.jsonl",
      "u1/claude/other/session.json",
    ];
    expect(sessionArtifactNames(listing, prefix).sort()).toEqual([
      "session.json",
      "tasks.json",
      "workflow-run-9.json",
    ]);
  });
});
