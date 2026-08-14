// Moving a fortress's object storage to another bucket, without losing a write.
//
// The hard part is not the copy. It is the CUT: the moment credentials.json
// stops naming the old bucket and starts naming the new one, while clients are
// uploading. Everything below exists to make that moment provably quiet, and to
// keep it short enough that a paused fortress is a hiccup rather than an outage.
//
// The order, and why each step is where it is:
//
//   COPY, THEN DELTA, WHILE INGEST RUNS. The bulk copy takes as long as it
//   takes; nothing is held during it. Repeated delta passes then narrow the set
//   of objects that changed since, so the amount of work left to do inside the
//   pause approaches zero before anything is armed.
//
//   THE DRAIN PHASE COMES BEFORE THE PAUSE. A presigned PUT lands in the bucket
//   directly, invisible to this process — so a pause cannot stop it and a
//   counter cannot see it. The drain engages the short-TTL floor for NEW
//   signatures and then keeps running delta passes until every long-lived
//   signature minted before it has expired. Only then is a pause armed, which
//   is what bounds arm→swap to seconds rather than to the staging TTL. Ingest
//   keeps running throughout: the drain costs latency on nobody.
//
//   THE BARRIER PROVES QUIET; THE FENCE PROVES IT IS STILL TRUE. The barrier
//   waits for in-flight work AND outstanding signatures. The fence re-checks the
//   pause deadline immediately before the swap, because a barrier that took
//   longer than expected can hand back a "quiet" that the gate has already
//   stopped enforcing.
//
//   THE SOURCE IS NEVER DELETED. Not at the end, not on success, not as
//   cleanup. The old bucket IS the rollback, and a migration that removed it
//   would be a migration nobody can undo. There is no delete call against the
//   source anywhere in this file, and a test asserts the absence rather than
//   trusting the sentence.

import { createHash } from "node:crypto";

import { awaitQuiesced, type IngestQuiesce } from "./pause-gate";

import type { SessionKey, SessionStore } from "../modules/session-vault/store/types";

/** What a run is allowed to do. `plan` writes nothing at all; `copy` moves the
 *  objects and stops before the cut; `switch` goes all the way. */
export type MigrationMode = "plan" | "copy" | "switch";

export type MigrationPhase =
  | "planning"
  | "provisioning"
  | "copying"
  | "delta"
  | "draining"
  | "quiescing"
  | "switching"
  | "verifying"
  | "done"
  | "aborted";

/** The whole budget the cut may hold writes off for, across every heartbeat.
 *  Deliberately far inside the daemon's own pause cap: this is a barrier plus a
 *  final delta, not a maintenance window. */
export const SWAP_PAUSE_MS = 5 * 60_000;

/** The most ONE pause episode is armed for. The window is held in heartbeats
 *  rather than asked for in one piece: a run that dies mid-swap costs the
 *  fortress a minute of refused uploads instead of the whole budget, and the
 *  clamp that bounds an episode is anchored on a column only an INSERT can
 *  stamp — so an extension is a NEW episode row, which costs a live daemon and
 *  is exactly the thing a Postgres-only adversary cannot produce. */
export const PAUSE_HEARTBEAT_MS = 60_000;

/** How long to wait for the daemon's own write gate to report a pause in force.
 *  Generous next to the heartbeat the gate refreshes on: the point is to prove
 *  writes are actually being refused, not to race the daemon. */
export const GATE_CONFIRM_MS = 30_000;

/** How long the barrier may wait for quiet before the run gives up and resumes
 *  without swapping. */
export const BARRIER_MS = 2 * 60_000;

/** The margin the pre-swap fence demands. A swap that begins with less pause
 *  left than this can finish after writes have reopened. */
export const FENCE_MARGIN_MS = 30_000;

/** Delta passes before the engine stops narrowing and moves on. A source under
 *  constant write never converges to zero, and the drain plus the pause are what
 *  close the remaining gap. */
export const MAX_DELTA_PASSES = 8;

/** Objects/versions removed per `deleteSession` call. Both stores cap at 800 so
 *  a call fits the tunnel RPC window; naming it here keeps the loop's bound and
 *  the store's default from drifting apart in silence. */
const DELETE_BATCH_LIMIT = 800;

/** A tombstone replay that has not converged after this many passes is either
 *  640,000 objects deep or something is re-creating them. Either way the cut
 *  stops: leaving content a customer permanently deleted in their new bucket is
 *  the one outcome this appliance cannot ship. */
const MAX_DELETE_PASSES = 800;

export interface MigrationEvent {
  phase: MigrationPhase;
  message: string;
  copied?: number;
  total?: number;
  bytes?: number;
}

export interface CopiedObject {
  key: SessionKey;
  checksum: string;
  bytes: number;
}

export interface MigrationResult {
  mode: MigrationMode;
  phase: MigrationPhase;
  sessionsTotal: number;
  sessionsCopied: number;
  bytesCopied: number;
  deltaPasses: number;
  switched: boolean;
  /** The credentials version the swap wrote, when it swapped. */
  version: number | null;
  aborted: string | null;
  /** Set when the pause could not be released. Reported rather than swallowed:
   *  the gate stays shut until the deadline the daemon is enforcing lapses on
   *  its own, and an operator who is not told reads a finished migration while
   *  uploads are still being refused. */
  resumeFailed: string | null;
}

/** What the daemon's write gate is enforcing RIGHT NOW — never what was asked
 *  for. The gate consults a cached view of the pause row, and the deadline it
 *  honours is the clamped one, so a run that fenced against its own request
 *  would be measuring a number nothing enforces. */
export interface PauseGateState {
  /** The deadline writes are refused until, or null when writes are open. */
  pausedUntil: Date | null;
  /** The daemon cut the request down to its own cap. */
  capped: boolean;
}

export interface MigrationDeps {
  mode: MigrationMode;
  /** The LIVE store — pause-gated, and the one clients are writing to. */
  source: SessionStore;
  /** The candidate, built directly from the new credentials. Deliberately NOT
   *  pause-gated: its self-test writes a probe object, and the source's pause is
   *  no reason to refuse a write to a bucket nobody is reading yet. */
  target: SessionStore;
  /** Sessions this fortress has permanently deleted. Replayed against the
   *  target, because a copy made before a delete would otherwise resurrect it. */
  tombstones: () => Promise<SessionKey[]>;
  quiesce: IngestQuiesce;
  /** Engage (or release) the short-TTL floor for new staging signatures. */
  armDrain: (on: boolean) => void;
  /** Arm (or extend) the ingest pause; returns the episode id it created. */
  armPause: (until: Date, reason: string) => Promise<string>;
  resumeIngest: (episodeId: string) => Promise<void>;
  /** What the daemon's write gate is enforcing, read after `refreshGate`. */
  gate: () => PauseGateState;
  /** Make the gate re-read the pause row NOW rather than at its next tick. The
   *  engine proves the pause is in force by asking the thing that refuses
   *  writes, and a stale answer would prove the previous episode instead. */
  refreshGate: () => Promise<void>;
  /** Write the new storage block into credentials.json through the single CAS
   *  door, and return the version it advanced to. */
  swapCredentials: () => Promise<number>;
  /** Re-bind the live store onto the swapped credentials. The SAME factory
   *  init() uses — a bare backend here would be a store with no pause gate, no
   *  deadlines and no rebuild policy, from the cut onward. */
  rebindStore: () => Promise<void>;
  /** Record one copied session, so a resume can skip it. */
  recordCopied?: (object: CopiedObject) => Promise<void>;
  /** Sessions a previous run already proved. Skipped unless the target
   *  disagrees. */
  alreadyCopied?: () => Promise<ReadonlySet<string>>;
  onEvent?: (event: MigrationEvent) => void;
  clock?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  swapPauseMs?: number;
  pauseHeartbeatMs?: number;
  gateConfirmMs?: number;
  barrierMs?: number;
  maxDeltaPasses?: number;
}

export function sessionRef(key: SessionKey): string {
  return [key.userId, key.family, key.sessionId].join("/");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Copy one session, and prove it landed.
 *
 * The checksum is taken from what the TARGET returns, not from what was sent: a
 * write that silently truncated, or a bucket that accepted and stored something
 * else, is exactly the failure a migration must not carry forward. A mismatch
 * throws, and the run aborts rather than continuing over a target it can no
 * longer trust.
 *
 * THE SIDECARS ARE ENUMERATED, never listed by name. `workflow-<runId>.json` is
 * an unbounded class of reachable writes, so any fixed list of names is a list
 * that silently leaves objects in the bucket this fortress is moving away from.
 * A read that fails after the listing offered the name is an ERROR rather than
 * an absence — dropping it is the loss this whole function exists to prevent.
 */
export async function copySession(
  source: SessionStore,
  target: SessionStore,
  key: SessionKey,
  /** Called between objects. The final delta runs INSIDE the armed pause and a
   *  session with many sidecars costs three round trips each, so without a beat
   *  here one copy can outlast an episode — and the fence then refuses a cut
   *  that had most of its budget left. */
  beat: () => Promise<void> = async (): Promise<void> => undefined,
): Promise<CopiedObject> {
  const text = await source.readCanonicalText(key);
  await target.writeCanonicalText(key, text);
  const landed = await target.readCanonicalText(key);
  const checksum = sha256(text);
  if (sha256(landed) !== checksum) {
    throw new Error(
      `checksum mismatch after copying ${sessionRef(key)} — the target holds different bytes`,
    );
  }
  for (const name of await source.listSessionArtifacts(key)) {
    await beat();
    const artifact = await source.readArtifactText(key, name);
    // Null only where a delete landed between the listing and the read; there is
    // nothing left to carry, and the tombstone replay is what agrees with it.
    if (artifact === null) continue;
    await target.writeArtifact(key, name, artifact);
    // Read back, like the canonical two blocks up. Verification after the cut
    // can only check a sidecar's PRESENCE — the target is live by then and a
    // rewrite is legitimately shorter — so copy time is the only moment where
    // a corrupted sidecar is still detectable. Silent corruption was otherwise
    // recoverable only because the source is retained, which nobody would know
    // to do.
    const arrived = await target.readArtifactText(key, name);
    if (arrived === null || sha256(arrived) !== sha256(artifact)) {
      throw new Error(
        `checksum mismatch after copying ${sessionRef(key)}/${name} — the target holds different bytes`,
      );
    }
  }
  return { key, checksum, bytes: Buffer.byteLength(text) };
}

/**
 * Run one storage migration.
 *
 * Idempotent by construction: every phase re-derives its work from the two
 * stores rather than from where the last run stopped, so a resumed run copies
 * what is missing and skips what is already proven.
 */
export async function runStorageMigration(deps: MigrationDeps): Promise<MigrationResult> {
  const clock = deps.clock ?? ((): Date => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const emit = (event: MigrationEvent): void => deps.onEvent?.(event);

  const result: MigrationResult = {
    mode: deps.mode,
    phase: "planning",
    sessionsTotal: 0,
    sessionsCopied: 0,
    bytesCopied: 0,
    deltaPasses: 0,
    switched: false,
    version: null,
    aborted: null,
    resumeFailed: null,
  };

  const plan = await deps.source.listAllCanonicalKeys();
  result.sessionsTotal = plan.length;
  emit({ phase: "planning", message: `${plan.length} session(s) to move`, total: plan.length });
  if (deps.mode === "plan") {
    result.phase = "done";
    return result;
  }

  // The target's OWN self-test, before anything is copied into it. Exempt from
  // the source's pause gate by construction — this store is not that store.
  result.phase = "provisioning";
  emit({ phase: "provisioning", message: "proving the target bucket accepts a write" });
  await deps.target.selfTest();

  const done = new Set(await (deps.alreadyCopied?.() ?? Promise.resolve(new Set<string>())));

  /**
   * Set only while the final delta and the tombstone replay are running, which
   * is the work that happens INSIDE the armed pause. Both walk every session and
   * read every object, so either can outlast one 60 s episode; without a beat
   * from inside their loops the window lapses, writes reopen behind them, and
   * the fence below sees only the fresh episode it just armed.
   */
  let inPauseBeat: (() => Promise<void>) | null = null;
  const beat = async (): Promise<void> => {
    if (inPauseBeat) await inPauseBeat();
  };

  /**
   * Whether the target holds this session's canonical as the source has it NOW.
   *
   * CONTENT, not existence — which is the whole reason the delta passes exist. A
   * session appended to after its bulk copy is PRESENT in the target and short,
   * so an existence test narrows it out of every pass and the run finishes over
   * a truncated object while calling the source the way back. Byte length is
   * what both stores already answer with, and an append cannot leave it equal.
   *
   * `null` is compared explicitly rather than for truthiness: a zero-byte
   * canonical is an object that EXISTS, and a falsy test would re-copy it on
   * every pass until the passes ran out.
   */
  const targetIsCurrent = async (key: SessionKey, alsoSidecars = false): Promise<boolean> => {
    const wanted = await deps.source.statCanonical(key);
    // Gone from the source under the run — a delete that landed mid-copy. There
    // is nothing left to carry, and the tombstone replay is what agrees with the
    // target about it.
    if (wanted === null) return true;
    if ((await deps.target.statCanonical(key)) !== wanted) return false;
    if (!alsoSidecars) return true;
    // SIDECARS TOO, in the final pass only.
    //
    // Canonical length cannot express a sidecar rewrite, and more than one
    // writer produces one without appending a canonical — the parked-artifact
    // replay is merely the one this engine can suppress. The `writeArtifact`
    // tunnel RPC is caller-driven and ungated during the copy phase, and the
    // gateway defers its own post-commit sidecar write. Any of them lands on the
    // source after that session was copied, and nothing later notices: the delta
    // measures the canonical and verification checks presence.
    //
    // Sound HERE and nowhere later, which is why it is not the general rule:
    // this pass runs inside the pause and before the cut, so the source is
    // frozen and the target is not yet live. After the cut the target IS live
    // and a sidecar is rewritten whole on every commit, so the same comparison
    // reports an intact session as a partial loss.
    // HASHED, not measured. A sidecar is rewritten whole, so its length is not
    // a function of its content the way an append-only canonical's is: the
    // gateway's per-commit `session.json` rewrite moves fixed-width ISO stamps
    // and integer counts, which changes the bytes and routinely leaves the
    // length identical. Measuring it here would skip exactly the sessions this
    // pass exists to catch. Both texts are already fully in hand.
    const held = new Map<string, string>();
    for (const name of await deps.source.listSessionArtifacts(key)) {
      // Per OBJECT, not per session: this loop reads every sidecar's full text
      // from both buckets, so one busy session can outlast an episode on its own.
      await beat();
      const text = await deps.source.readArtifactText(key, name);
      if (text !== null) held.set(name, sha256(text));
    }
    for (const [name, digest] of held) {
      await beat();
      const arrived = await deps.target.readArtifactText(key, name);
      if (arrived === null || sha256(arrived) !== digest) return false;
    }
    return true;
  };

  const copyMissing = async (keys: readonly SessionKey[], phase: MigrationPhase): Promise<number> => {
    let copied = 0;
    for (const key of keys) {
      await beat();
      const ref = sessionRef(key);
      // Proven by a previous run — but only while the target still agrees. A
      // record without an object is a record about a bucket somebody emptied,
      // and a record over a SHORTER object is one about a session that has been
      // appended to since.
      if (done.has(ref) && (await targetIsCurrent(key))) continue;
      const object = await copySession(deps.source, deps.target, key, beat);
      done.add(ref);
      copied += 1;
      result.sessionsCopied += 1;
      result.bytesCopied += object.bytes;
      await deps.recordCopied?.(object);
      emit({
        phase,
        message: `copied ${ref}`,
        copied: result.sessionsCopied,
        total: result.sessionsTotal,
        bytes: result.bytesCopied,
      });
    }
    return copied;
  };

  result.phase = "copying";
  await copyMissing(plan, "copying");

  /** One narrowing pass: whatever the target does not hold as the source holds
   *  it NOW — the objects that are absent, and the ones that have moved on. */
  const deltaPass = async (phase: MigrationPhase, alsoSidecars = false): Promise<number> => {
    result.deltaPasses += 1;
    const keys = await deps.source.listAllCanonicalKeys();
    result.sessionsTotal = Math.max(result.sessionsTotal, keys.length);
    const behind: SessionKey[] = [];
    for (const key of keys) {
      await beat();
      if (await targetIsCurrent(key, alsoSidecars)) continue;
      behind.push(key);
    }
    if (behind.length > 0) {
      // Re-copied because the target does not hold what the source does,
      // whatever a previous run recorded.
      for (const key of behind) done.delete(sessionRef(key));
      await copyMissing(behind, phase);
    }
    return behind.length;
  };

  result.phase = "delta";
  const maxPasses = deps.maxDeltaPasses ?? MAX_DELTA_PASSES;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    emit({ phase: "delta", message: `delta pass ${pass + 1}` });
    if ((await deltaPass("delta")) === 0) break;
  }

  if (deps.mode === "copy") {
    result.phase = "done";
    emit({ phase: "done", message: "objects copied; credentials still name the source bucket" });
    return result;
  }

  // ── The drain: run off every signature the bucket will still honour ────────
  result.phase = "draining";
  deps.armDrain(true);
  try {
    // Read AFTER arming, so a signature minted in the same instant is included.
    const runOff = deps.quiesce.signatureFloor.getTime();
    emit({
      phase: "draining",
      message:
        runOff > clock().getTime()
          ? `waiting out signatures valid until ${new Date(runOff).toISOString()}`
          : "no long-lived signature outstanding",
    });
    // Deltas keep running through the run-off, so the work left inside the pause
    // stays small. Ingest is untouched: nothing is armed yet.
    while (clock().getTime() < runOff) {
      await deltaPass("draining");
      await sleep(1_000);
    }

    // ── The pause, the barrier and the fence ────────────────────────────────
    result.phase = "quiescing";
    const budgetMs = deps.swapPauseMs ?? SWAP_PAUSE_MS;
    const heartbeatMs = Math.min(deps.pauseHeartbeatMs ?? PAUSE_HEARTBEAT_MS, budgetMs);
    const gateConfirmMs = deps.gateConfirmMs ?? GATE_CONFIRM_MS;
    const budgetEnds = clock().getTime() + budgetMs;
    let armedUntil = new Date(0);
    // The episode the resume has to name. Re-assigned by every heartbeat, so the
    // release below clears the one actually in force.
    let episode = "";

    /** Arm, or EXTEND. Every extension is a NEW episode row rather than a moved
     *  deadline: the clamp is anchored on a column only an INSERT can stamp, so
     *  moving a deadline in place asks the gate to hold past a bound it has
     *  already computed. */
    const armPause = async (): Promise<string> => {
      armedUntil = new Date(Math.min(budgetEnds, clock().getTime() + heartbeatMs));
      return await deps.armPause(armedUntil, "storage migration swap");
    };
    /** Has the armed window ever been observed already spent? Re-arming makes
     *  the gate agree again but cannot undo the writes admitted in between, and
     *  the fence proves only that SOME episode is in force — it has no way to
     *  see that the previous one expired under the work it is fencing. */
    let pauseLapsed = false;
    /** The armed window is already spent — writes are being admitted again. */
    const pauseSpent = (): boolean => armedUntil.getTime() <= clock().getTime();
    /** Extend only when the episode in force is close to lapsing — a heartbeat
     *  on every poll would be a row every quarter-second. */
    const heartbeat = async (): Promise<void> => {
      const now = clock().getTime();
      if (pauseSpent()) pauseLapsed = true;
      if (now >= budgetEnds) return;
      if (armedUntil.getTime() - now > heartbeatMs / 2) return;
      episode = await armPause();
    };
    /** The pause is IN FORCE when the daemon's own gate says so.
     *
     *  Arming writes a row; the thing that refuses a write is the daemon's
     *  cached view of it, and until that view has caught up the store is still
     *  admitting commits. A barrier measured before then reports quiet about a
     *  moment that has not started yet, and the delta, the tombstone replay and
     *  the cut all run with writes landing behind them. */
    const awaitInForce = async (): Promise<PauseGateState> => {
      const deadline = clock().getTime() + gateConfirmMs;
      for (;;) {
        await deps.refreshGate();
        const state = deps.gate();
        // A clamped episode is returned as it is: every margin below would be
        // computed from a deadline the gate does not honour, and the caller
        // stops rather than cutting against it.
        if (state.capped) return state;
        if (state.pausedUntil && state.pausedUntil.getTime() >= armedUntil.getTime()) return state;
        if (clock().getTime() >= deadline) return { pausedUntil: null, capped: state.capped };
        await sleep(250);
      }
    };

    episode = await armPause();
    try {
      const inForce = await awaitInForce();
      if (inForce.capped) {
        result.phase = "aborted";
        result.aborted =
          "the daemon clamped this pause to its own cap, so the window is not the one that was armed — nothing was switched";
        return result;
      }
      if (!inForce.pausedUntil) {
        result.phase = "aborted";
        result.aborted =
          "the daemon's write gate never reported the pause in force, so writes were never proven held — nothing was switched";
        return result;
      }

      const barrierDeadline = new Date(
        Math.min(budgetEnds, clock().getTime() + (deps.barrierMs ?? BARRIER_MS)),
      );
      emit({ phase: "quiescing", message: "waiting for in-flight writes and signatures" });
      const quiet = await awaitQuiesced({
        quiesce: deps.quiesce,
        deadline: barrierDeadline,
        clock,
        sleep,
        // The barrier can outlast one heartbeat, and a pause that lapsed under
        // it would reopen writes while this was still measuring quiet.
        heartbeat,
      });
      if (!quiet) {
        result.phase = "aborted";
        result.aborted =
          "the store did not go quiet before the barrier deadline — nothing was switched";
        return result;
      }

      // The final delta and the tombstone replay run INSIDE the pause, where the
      // source cannot change under them.
      // The final pass compares sidecars as well — see targetIsCurrent for why
      // this is the one pass where that comparison is sound.
      inPauseBeat = heartbeat;
      try {
        await deltaPass("quiescing", true);
        await replayTombstones(deps, emit, heartbeat);
      } finally {
        inPauseBeat = null;
      }

      // A lapse is not recoverable by re-arming. Deletes are gated only while
      // the pause is IN FORCE, so a window that expired under the replay is one
      // where a permanent delete could land in the source with the tombstone
      // list already read — the source loses it, the target keeps it, and
      // verification walks the source so it never notices. Refuse the cut.
      // `pauseSpent()` as well as the flag: the last unit of work has no beat
      // after it, so a window that expired during it is only visible here.
      if (pauseLapsed || pauseSpent()) {
        result.phase = "aborted";
        result.aborted =
          "the pause expired while the final delta and the tombstone replay were still running, so writes " +
          "reopened behind them — nothing was switched";
        return result;
      }

      // The fence. Between the barrier and here, time passed — so the window is
      // re-armed and then re-PROVEN, and the margin is measured against what the
      // gate says it is enforcing rather than against what this run asked for. A
      // fence that compared the request would sail a clamped episode through and
      // begin a cut after writes had already reopened.
      episode = await armPause();
      const fence = await awaitInForce();
      const remaining = fence.pausedUntil ? fence.pausedUntil.getTime() - clock().getTime() : 0;
      if (fence.capped || remaining < FENCE_MARGIN_MS) {
        result.phase = "aborted";
        result.aborted =
          "the pause the gate is enforcing was nearly spent before the swap could start — nothing was switched";
        return result;
      }

      // ── The cut ────────────────────────────────────────────────────────────
      result.phase = "switching";
      emit({ phase: "switching", message: "pointing this fortress at the target bucket" });
      result.version = await deps.swapCredentials();
      try {
        await deps.rebindStore();
      } catch (err) {
        // `rebindStore` throws on any self-test failure, and it throws AFTER the
        // credentials file already names the target. That leaves the worst of
        // the three states: the file says target, the running process still
        // serves the source, the operator is told the swap failed, and the next
        // restart silently serves the target — with nothing written in between
        // recorded anywhere. So say the true thing rather than the tidy one.
        result.phase = "aborted";
        result.switched = true;
        result.aborted =
          `the credentials now name the target but this daemon could not bind to it (${
            err instanceof Error ? err.message : String(err)
          }). Nothing is lost — the source still holds everything — but this process is still writing to the ` +
          "source, and a restart will switch it. Fix the target's access, then restart the daemon.";
        return result;
      }
      result.switched = true;

      result.phase = "verifying";
      let missing: string[];
      try {
        missing = await verifyTarget(deps);
      } catch (err) {
        // The cut ALREADY HAPPENED. Letting this throw discarded the whole
        // result, so the run recorded "failed at switching" while the
        // credentials named the target and the daemon served it — telling the
        // operator to retry a swap that is done. The rebind path three blocks up
        // has exactly this guard; verification lacked it.
        result.phase = "done";
        result.aborted =
          `the switch completed, but this run could not verify the new bucket (${
            err instanceof Error ? err.message : String(err)
          }). Nothing is lost — the source still holds everything — but the move is unverified; re-run the audit.`;
        return result;
      }
      result.phase = "done";
      if (missing.length > 0) {
        // The swap already happened, so this is a report and not a rollback: the
        // source is untouched and still holds everything, which is what makes
        // going back a credentials change rather than a recovery. The event says
        // so too — a "done" that read like a clean cut is how a partial move
        // reaches an operator as a success.
        result.aborted = `${missing.length} object(s) did not arrive whole in the new bucket: ${missing
          .slice(0, 5)
          .join(", ")}`;
        emit({
          phase: "done",
          message: `the fortress is serving from the target bucket, and ${missing.length} object(s) did not come with it`,
        });
        return result;
      }
      emit({ phase: "done", message: "the fortress is serving from the target bucket" });
      return result;
    } finally {
      // NOT swallowed. A pause this run could not release holds every upload off
      // the fortress until the deadline the daemon is enforcing lapses on its
      // own, and a migration that reported success over that would send the
      // operator looking at their clients.
      try {
        await deps.resumeIngest(episode);
      } catch (error) {
        result.resumeFailed = error instanceof Error ? error.message : String(error);
        emit({
          phase: result.phase,
          message: `ingest could not be resumed (episode ${episode}): ${result.resumeFailed}`,
        });
      }
    }
  } finally {
    deps.armDrain(false);
  }
}

/**
 * Replay permanent deletes against the target.
 *
 * A session deleted after its copy was made is present in the target and absent
 * from the source, which is a resurrection: the delete happened, and the cut
 * would undo it. Run AFTER the final delta and inside the pause — the delta is
 * what can re-copy a session, so replaying the deletes after it is what makes
 * the target agree; running first would let the delta put back what this had
 * just removed.
 */
async function replayTombstones(
  deps: MigrationDeps,
  emit: (event: MigrationEvent) => void,
  heartbeat: () => Promise<void> = async (): Promise<void> => undefined,
): Promise<number> {
  // Beat around the read itself. It joins this run's copy records — tens of
  // milliseconds on a large run, more on a loaded box — and it runs inside the
  // armed pause BEFORE the loop's first beat, so a window that lapsed under it
  // would only be discovered at the fence.
  await heartbeat();
  const tombstones = await deps.tombstones();
  await heartbeat();
  let removed = 0;
  for (const key of tombstones) {
    // One beat per session, and one per delete pass below: a single permanently
    // deleted session can take hundreds of round trips, which on its own can
    // outlast the armed window.
    await heartbeat();
    // NO `statCanonical` gate. It resolves only `${prefix}/log.jsonl`, so a
    // session whose objects live entirely under its `:a:<agentId>` lanes — the
    // turn-less parent stub this codebase names in 0023 — looked absent and was
    // skipped, leaving its lane objects copied into the target and never
    // deleted. `deleteSession` is already an idempotent no-op on a session that
    // is not there, so the gate bought nothing and cost that class.
    //
    // And it LOOPS. The contract is explicit — "the caller re-invokes until
    // `complete`" — because both backends stop at a batch limit (800) so a call
    // always fits the tunnel RPC window. Calling once removed the first 800
    // objects of a permanently-deleted session and moved on; the rest were
    // copied into the new bucket and stayed there. `verifyTarget` cannot see it,
    // because it walks the SOURCE listing. On a versioned bucket 800 is not a
    // large session: it covers the canonical, every staging chunk, every lane
    // and every noncurrent version.
    let complete = false;
    for (let pass = 0; !complete; pass += 1) {
      if (pass >= MAX_DELETE_PASSES) {
        throw new Error(
          `replaying the permanent delete of ${sessionRef(key)} onto the target did not converge after ` +
            `${MAX_DELETE_PASSES} passes; the cut is refused rather than leaving deleted content in the new bucket`,
        );
      }
      await heartbeat();
      const result = await deps.target.deleteSession(key, { batchLimit: DELETE_BATCH_LIMIT });
      complete = result.complete;
    }
    removed += 1;
    emit({ phase: "quiescing", message: `replayed a permanent delete onto the target: ${sessionRef(key)}` });
  }
  return removed;
}

/**
 * Every OBJECT the source holds that the new bucket does not.
 *
 * SCOPE, STATED: the canonical log and every sidecar `listSessionArtifacts`
 * reports. `.staging/` chunks are NOT carried and are not verified — they are
 * the uncommitted halves of an upload in flight, addressed by the client that is
 * still writing them, and a run only reaches this point after the ingest pause
 * has held and the store has gone quiet, so there is nothing legitimate left in
 * flight to carry. An abandoned chunk stays in the old bucket, which is the same
 * place its `deleteSession` sweep would look for it. Anything committed is in
 * the canonical, and the canonical is compared byte for byte.
 *
 * Re-listed rather than taken from the run's own counters: the question is what
 * the fortress can serve now, and only the bucket can answer it. Object SETS
 * rather than canonicals — a verification that compared one object per session
 * would report a clean switch over a target missing every sidecar, which is the
 * shape the loss took when the copy walked three fixed names.
 *
 * The two object classes are checked differently, and the reason is that this
 * runs AFTER the cut, when the target is the live bucket and the source is
 * frozen:
 *
 *   CANONICAL — by size, shorter-than. It is append-only, so a target shorter
 *   than the source is a partial copy however the two buckets are being written.
 *   One that has GROWN is a new write landing where it should.
 *
 *   SIDECARS — by presence only. A sidecar is rewritten whole on every commit,
 *   not appended to, and a live rewrite is routinely shorter than the copy taken
 *   before the cut (a first-message-derived title replaced by the real one).
 *   Comparing their bytes here reports an intact session as a partial loss on
 *   the one surface an auditor reads; no measurement fixes that, because the
 *   comparison itself is unsound across a live cut.
 *
 * Sidecar STALENESS is therefore kept out BEFORE the cut, by two belts that can
 * both afford to be exact: the final in-pause delta compares every sidecar by
 * SHA-256 (`targetIsCurrent(key, true)`) while the source is frozen and the
 * target is not yet live, and the daemon does not replay parked artifacts while
 * a run is between its copy and its cut. Clearing a copy record matters only to
 * a run RESUMED under the same id, where `copyMissing` reads it.
 */
async function verifyTarget(deps: MigrationDeps): Promise<string[]> {
  const keys = await deps.source.listAllCanonicalKeys();
  const missing: string[] = [];
  for (const key of keys) {
    const ref = sessionRef(key);
    const wanted = await deps.source.statCanonical(key);
    const landedBytes = await deps.target.statCanonical(key);
    if (landedBytes === null) {
      // The session itself is gone; naming each of its sidecars as well would
      // say the same thing several times.
      missing.push(ref);
      continue;
    }
    if (wanted !== null && landedBytes < wanted) {
      missing.push(`${ref} (${landedBytes} of ${wanted} bytes)`);
    }
    // Sidecars are checked for PRESENCE, and deliberately not for content.
    //
    // By the time this runs the cut has happened, so the target is the live
    // bucket while the source is frozen — and a sidecar is rewritten whole on
    // every commit, not appended to. A live rewrite that is SHORTER than the
    // copy taken before the cut is ordinary (a first-message-derived title
    // replaced by the real one), so comparing the two sizes reports a session
    // that is perfectly intact as "did not arrive whole", on the one surface an
    // auditor reads. There is no measurement that fixes it; the comparison
    // itself is unsound across a live cut.
    //
    // The canonical above is different and still compared: it is append-only, so
    // a target shorter than the source is a real loss whatever else is writing.
    // Sidecar staleness is handled before the cut — see the header for how, and
    // for why canonical length alone cannot express it.
    //
    // It is also what makes this affordable: two listings per session rather
    // than a full GET of every artifact from both buckets, serially.
    const landed = new Set(await deps.target.listSessionArtifacts(key));
    for (const name of await deps.source.listSessionArtifacts(key)) {
      if (!landed.has(name)) missing.push(`${ref}/${name}`);
    }
  }
  return missing;
}

