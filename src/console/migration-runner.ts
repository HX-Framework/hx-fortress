// Wiring one storage migration to a live fortress: its two buckets, its pause
// plane, its credentials file and its run record.
//
// Kept apart from the engine for the reason the audit runner is: the engine's
// ORDER — copy, delta, drain, barrier, fence, cut — is the part that has to be
// provable, and it stays testable without a bucket, a database or a credential.
//
// Three commands, one lifecycle:
//
//   ARM copies, then engages the short-TTL floor. It is where the long work
//   happens and where nothing is held: ingest runs at full speed throughout, and
//   the floor engages only at the END, so the signatures minted at the old TTL
//   run off while the operator reads the result rather than inside the swap.
//
//   SWAP is the cut, and it is short by construction because ARM already paid
//   for the run-off. It refuses rather than cuts whenever the store did not go
//   quiet or the pause was nearly spent.
//
//   RESUME is the way back out: it releases the floor and clears the pause
//   episode, whether or not anything was switched. Resuming an interrupted COPY
//   is not this — that is ARM again, which re-derives its work from the two
//   buckets and skips what the target already holds.
//
// THE FLOOR HAS ONE OWNER. The engine may raise it and never lowers it: a swap
// that refused is a swap the operator will retry, and lowering the floor would
// charge that retry the whole staging TTL a second time. It is lowered here, on
// a completed cut and on resume. It also lives in memory, so a daemon restart
// clears it — which is the bound on an arm nobody ever followed up.

import { sql } from "drizzle-orm";

import { armPause, readCurrentEpisode, resumeIngest } from "./ingest-control-db";
import {
  copiedSessions,
  findResumableRun,
  noteMigrationPhase,
  recordCopiedObject,
  saveMigrationRun,
  startMigrationRun,
} from "./migration-store";
import { MIGRATION_PHASES } from "./command-params";
import {
  runStorageMigration,
  type MigrationDeps,
  type MigrationResult,
  type PauseGateState,
} from "./migration";
import { envManagedRefusal } from "./rotation";
import {
  readVaultCredentials,
  updateVaultCredentials,
  type VaultCredentials,
} from "../modules/session-vault/credentials";
import type { IngestQuiesce } from "./pause-gate";
import type { HxDb } from "../host/postgres/db";
import type { ScopedLogger } from "../host/types";
import type { SessionKey, SessionStore } from "../modules/session-vault/store/types";

/** The three commands a console can send. Not the engine's PHASES, which name
 *  where one run got to — these name what the operator asked for. The list is
 *  the validator's, aliased rather than restated: two copies of one enum drift,
 *  and the drift would be a row that validates and then has nothing to run it. */
export const MIGRATION_COMMANDS = MIGRATION_PHASES;
export type MigrationCommand = (typeof MIGRATION_COMMANDS)[number];

/** One migration at a time on this fortress.
 *
 *  Two commands are two rows and the poll claims each as it finds one, so an arm
 *  still copying and a swap submitted behind it would drive the same two
 *  buckets, the same pause plane and the same credentials file at once — and the
 *  arm's tail would raise the short-TTL floor again after the swap had lowered
 *  it, pinning every staging signature at a minute until the daemon restarted. */
let migrationInFlight = false;

/** Held from the moment a migration command begins its PREAMBLE, before any
 *  await. `migrationInFlight` is only set once the runner is entered, which is
 *  after the preamble has already awaited a drain and a sequential-scan DELETE —
 *  a window in which the replay's guard still reads false and a fresh drain can
 *  start writing sidecars into the bucket the run is about to walk. */
let migrationHold = 0;

export function holdMigration(): () => void {
  migrationHold += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    migrationHold -= 1;
  };
}

export const MIGRATION_BUSY_REFUSAL =
  "a storage migration is already running on this fortress — wait for its answer. The run that " +
  "holds the pause is the one that releases it.";

/** Whether a storage-migration command is running in THIS process right now.
 *
 *  The pause row cannot answer this. An arm copies for as long as the bucket
 *  takes and arms no pause at all — the pause belongs to the swap — so anything
 *  gating on the row alone is unguarded for the whole expensive phase. */
export function migrationIsRunning(): boolean {
  return migrationInFlight || migrationHold > 0;
}

export function isMigrationCommand(value: unknown): value is MigrationCommand {
  return typeof value === "string" && (MIGRATION_COMMANDS as readonly string[]).includes(value);
}

export interface MigrationRunnerDeps {
  db: () => HxDb | null;
  /** The LIVE binding — pause-gated, and the one clients are writing to. */
  store: () => SessionStore | null;
  /** Build the candidate from the target credentials. The DIRECT backend, not
   *  the serving one: this store is written by the migration alone, and a
   *  wedge-escalating candidate could exit the daemon over a bucket nothing is
   *  serving from yet. */
  buildTarget: (credentials: VaultCredentials) => SessionStore;
  /** The counter and the signature floor the pre-swap barrier waits on. */
  quiesce: IngestQuiesce;
  /** What the daemon's write gate is enforcing — the deadline that actually
   *  refuses uploads, which is not the one a run asked for. */
  gate: () => PauseGateState;
  /** Make that gate re-read the pause row now, rather than at its next tick. */
  refreshGate: () => Promise<void>;
  /** Engage or release the short-TTL floor for NEW staging signatures. */
  setDrain: (on: boolean) => void;
  /** Swap the live store binding onto the swapped credentials — the SAME
   *  factory init() uses, so the gate, the deadlines and the rebuild policy
   *  survive the cut. */
  rebindStore: () => Promise<void>;
  /** The target's storage block, from the command's single-use file. Null when
   *  the reference was already consumed, expired or unreadable. */
  targetCredentials: () => Promise<VaultCredentials | null>;
  /** The process environment, for the env-managed refusal. */
  env: Record<string, string | undefined>;
  logger: ScopedLogger;
}

export interface MigrationCommandArgs {
  command: MigrationCommand;
  /** The target bucket the operator NAMED, as it reached the row. Checked
   *  against the credential file so the run record and the audit trail carry a
   *  bucket the secret actually points at. */
  target: string | null;
}

/** Sessions this fortress has permanently deleted. Replayed onto the target,
 *  because a copy taken before a delete would otherwise resurrect it: the
 *  tombstone refuses a re-UPLOAD and says nothing about an object a migration
 *  put there. */
export async function migrationTombstones(db: HxDb, runId: string): Promise<SessionKey[]> {
  // BOUNDED BY WHAT THIS RUN COULD HAVE CARRIED, on two arms, because either one
  // alone is wrong.
  //
  // Replaying the WHOLE history cost two bucket listings per tombstone inside
  // the ≤5-minute armed window, so an install with a few thousand historical
  // deletes could never finish a migration.
  //
  // But `deleted_at >= started_at` alone is not safe either. A tombstone is
  // stamped when the purge BEGINS, and a purge is multi-call — the bucket half
  // deletes in batches, and on a versioned bucket a busy session's `.staging/`
  // versions sort ahead of its canonical, so the canonical can still be there
  // for several calls. A migration armed in that window copies it, the source
  // then finishes purging, and `targetIsCurrent` defers to this replay for
  // exactly that case — while `verifyTarget` walks the SOURCE and so can never
  // see the extra objects. `now()` is also transaction-start time, and the
  // tombstone's transaction takes an advisory lock first, so its stamp can
  // precede a run row inserted after that transaction began.
  //
  // So the second arm asks the question directly: did THIS run copy it? A
  // resumed run keeps its original `started_at` and its own copy records, which
  // are the right anchors for both arms. `migration_objects.session_id` can be
  // the `sid:a:agent` composite while a tombstone is always the base id, so the
  // join is on the base.
  //
  // UNION, not `OR EXISTS`. The copy-record side is not indexable — the PK is
  // (run_id, user_id, family, session_id) and this reads a FUNCTION of the
  // trailing column — so past ~50k copied objects the planner abandons the
  // hashed subplan and probes once per tombstone, each non-match paying a full
  // (run_id, user_id) prefix walk before it can answer "no". Measured on the
  // engine this appliance ships (PG 18.4) at 500k objects / 10k tombstones:
  // 11-16 SECONDS as a correlated subplan against 65-124 ms as this union,
  // which hash-joins the two sides once. The wider figure of each pair is the
  // real condition — stats still stale from the copy records this run inserted
  // moments earlier. It matters here and nowhere else: this runs inside the
  // armed pause, whose whole episode is 60s, so a query that outlasts it fails
  // the cut at the fence, after the copy, the drain and the barrier have all
  // been paid for. Which is the exact failure the first arm's bound was added
  // to prevent, on the same class of install.
  const result = await db.execute(
    sql`SELECT d.user_external_id AS "userId", d.family, d.session_id AS "sessionId"
          FROM hx.deleted_sessions d
          JOIN hx.migration_runs r ON r.id = ${runId}::uuid
         WHERE d.deleted_at >= r.started_at
        UNION
        SELECT d.user_external_id AS "userId", d.family, d.session_id AS "sessionId"
          FROM hx.deleted_sessions d
          JOIN hx.migration_objects o
            ON o.user_id = d.user_external_id
           AND split_part(o.session_id, ':', 1) = d.session_id
         WHERE o.run_id = ${runId}::uuid`,
  );
  const raw: unknown = Array.isArray(result) ? result : (result as { rows?: unknown[] })?.rows;
  const list = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
  return list.map((row) => ({
    userId: String(row.userId ?? ""),
    family: String(row.family ?? ""),
    sessionId: String(row.sessionId ?? ""),
  }));
}

/** What the operator reads back. Identifiers and counts only — a bucket name is
 *  a fact somebody needs; a key never is. */
export function describeMigration(result: MigrationResult, targetBucket: string): string {
  const moved =
    `${result.sessionsCopied} of ${result.sessionsTotal} session(s) copied to ${targetBucket}, ` +
    `${Math.round(result.bytesCopied / 1024)} KiB over ${result.deltaPasses} delta pass(es)`;
  // A pause nobody released is the first thing an operator needs to read: until
  // its deadline lapses this fortress refuses every upload, and no other line
  // here would explain why.
  const stuck = result.resumeFailed
    ? ` — INGEST IS STILL PAUSED: the pause could not be released (${result.resumeFailed}). ` +
      "It lifts by itself when its deadline passes; `resume` is the way to lift it now"
    : "";
  if (!result.switched) {
    return result.aborted ? `${moved} — nothing was switched: ${result.aborted}${stuck}` : `${moved}${stuck}`;
  }
  const version = `credentials.json is at version ${result.version ?? 0}`;
  return result.aborted
    ? `switched to ${targetBucket} (${version}), but the new bucket did not verify: ${result.aborted}${stuck}`
    : `switched to ${targetBucket}; ${version}; the source bucket is untouched and is the way back${stuck}`;
}

/**
 * Run one storage-migration command against this fortress.
 *
 * Returns the sentence the console renders as the outcome, and throws with the
 * one it renders as the failure. Neither is invented by the console.
 */
export async function runMigrationCommand(
  deps: MigrationRunnerDeps,
  args: MigrationCommandArgs,
): Promise<string> {
  if (migrationInFlight) throw new Error(MIGRATION_BUSY_REFUSAL);
  migrationInFlight = true;
  try {
    return await driveMigrationCommand(deps, args);
  } finally {
    migrationInFlight = false;
  }
}

async function driveMigrationCommand(
  deps: MigrationRunnerDeps,
  args: MigrationCommandArgs,
): Promise<string> {
  const db = deps.db();
  if (!db) {
    throw new Error("the fortress database is not available, so a migration cannot be recorded");
  }

  if (args.command === "resume") {
    deps.setDrain(false);
    const episode = await readCurrentEpisode(db);
    if (!episode || episode.resumedAt !== null) {
      return "staging signatures are back to their normal lifetime; no pause was armed";
    }
    await resumeIngest(db, episode.id);
    return `ingest resumed (episode ${episode.id}); staging signatures are back to their normal lifetime`;
  }

  // An env-managed fortress rebuilds credentials.json from the environment on
  // every boot, so the cut would be discarded by the next restart while the
  // objects sat in the new bucket. Refused BEFORE anything is copied: the point
  // is not to spend hours on a move that cannot land.
  if (deps.env.FORTRESS_STORAGE_BUCKET?.trim()) throw new Error(envManagedRefusal("storage"));

  const source = await readVaultCredentials();
  if (!source) {
    throw new Error("this fortress has no storage credentials yet — run the enroll wizard first");
  }
  const target = await deps.targetCredentials();
  if (!target) {
    throw new Error(
      "the migration target's credentials were already consumed, expired or unreadable — re-issue them",
    );
  }
  if (args.target && args.target !== target.bucket) {
    // The row names a bucket and the credential file names a bucket. A run whose
    // record disagrees with what it actually wrote is a record nobody can audit.
    throw new Error(
      `the requested target bucket (${args.target}) is not the one these credentials name`,
    );
  }
  if (target.store === source.store && target.bucket === source.bucket) {
    throw new Error("the target names the bucket this fortress already serves from");
  }
  const live = deps.store();
  if (!live) throw new Error("the object store is not initialized on this fortress");

  // One run per bucket PAIR, continued rather than restarted: what the arm
  // already proved is what the swap gets to skip.
  const runId =
    (await findResumableRun(db, { sourceBucket: source.bucket, targetBucket: target.bucket })) ??
    (await startMigrationRun(db, {
      mode: args.command,
      sourceBucket: source.bucket,
      targetBucket: target.bucket,
    }));

  let lastPhase = "";
  const engine: MigrationDeps = {
    // ARM stops before the cut by construction rather than by a flag checked
    // late: `copy` returns after the delta passes and never reaches the drain.
    mode: args.command === "arm" ? "copy" : "switch",
    source: live,
    target: deps.buildTarget(target),
    tombstones: () => migrationTombstones(db, runId),
    quiesce: deps.quiesce,
    // Raise-only: see the latch note at the top of this file.
    armDrain: (on) => {
      if (on) deps.setDrain(true);
    },
    armPause: (until, reason) => armPause(db, { until, reason, armedBy: "storage migration" }),
    resumeIngest: (episodeId) => resumeIngest(db, episodeId),
    gate: deps.gate,
    refreshGate: deps.refreshGate,
    swapCredentials: async () => {
      // THE single door for credentials.json: the O_EXCL lock, the version CAS
      // and the version BUMP the console's live reader watches for. A direct
      // write here would race the rotation executor and the headless bootstrap,
      // and would leave the console signing with a key nobody honours any more.
      const written = await updateVaultCredentials((existing) => ({
        ...target,
        // The embedding key lives in the same file and belongs to neither
        // bucket. A whole-file write is exactly what would drop it.
        ...(existing?.openaiApiKey ? { openaiApiKey: existing.openaiApiKey } : {}),
      }));
      return written.version;
    },
    rebindStore: deps.rebindStore,
    recordCopied: (object) => recordCopiedObject(db, runId, object),
    alreadyCopied: () => copiedSessions(db, runId),
    onEvent: (event) => {
      if (event.phase !== lastPhase) {
        lastPhase = event.phase;
        // Best-effort and unawaited: the run's phase is how the console follows
        // along, and a database hiccup must not abort a migration mid-copy.
        void noteMigrationPhase(db, runId, event.phase).catch(() => {});
      }
      deps.logger.info("storage migration", {
        run: runId,
        phase: event.phase,
        message: event.message,
      });
    },
  };

  let result: MigrationResult;
  try {
    result = await runStorageMigration(engine);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The run stays OPEN: the objects already in the target are the expensive
    // part, and the next command has to be able to find them.
    await saveMigrationRun(db, runId, { result: null, error: message, finished: false }).catch(
      () => {},
    );
    throw error;
  }

  if (args.command === "arm") {
    // The floor engages HERE, after the copy rather than before it: the bulk
    // move runs at the normal signature lifetime, and the run-off it costs is
    // spent while the operator decides instead of inside the swap.
    deps.setDrain(true);
  } else if (result.switched) {
    // Cut over — there is nothing left for a barrier to wait out.
    deps.setDrain(false);
  }

  await saveMigrationRun(db, runId, {
    result,
    error: null,
    // Only a completed cut ends the run. A copy and a refused swap both leave it
    // open for the command that comes next.
    finished: result.switched,
  });
  const outcome = describeMigration(result, target.bucket);
  return args.command === "arm"
    ? `${outcome}; new staging signatures are short-lived — swap when ready`
    : outcome;
}
