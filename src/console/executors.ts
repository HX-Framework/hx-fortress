// What the daemon actually does when the console asks.
//
// One executor per command kind, and the Record is exhaustive over the FINAL
// allowlist — a kind cannot be added to the plane without something here to run
// it. The executors return the sentence the console renders as the outcome, and
// throw with the sentence it renders as the failure; neither is invented by the
// console, which is what makes a reported outcome comparable against the
// daemon's own audit record.
//
// Nothing here is reached without the row already having been claimed through
// the SECURITY DEFINER state machine, and every kind's parameters have already
// been validated against the per-kind shape.

import { consumeCredentialRef } from "./cmd-creds";
import { failingFindings, type AuditRunResult } from "./audit-engine";
import { finishAuditRun, recordFindings, startAuditRun } from "./audit-store";
import type { RollUpCounts } from "./audit-verdicts";
import { runCheckup, summarizeCheckup, type CheckupDeps } from "./checkup";
import { readCurrentEpisode } from "./ingest-control-db";
import { isMigrationCommand, migrationIsRunning, type MigrationCommand } from "./migration-runner";
import {
  applyRotation,
  describeRotation,
  envManagedRefusal,
  isRotationPayload,
  MIGRATION_COPYING_REFERENCE,
  migrationInProgressRefusal,
} from "./rotation";
import { consoleUpdateGate } from "../host/trust/verify";
import {
  readVaultCredentials,
  updateVaultCredentials,
} from "../modules/session-vault/credentials";
import { buildDirectStore } from "../modules/session-vault/store";
import { runFortressUpdate } from "../update";
import type { CommandExecutors } from "./commands";
import type { SessionStore } from "../modules/session-vault/store/types";
import type { HostStatusSnapshot, ScopedLogger } from "../host/types";
import type { HxDb } from "../host/postgres/db";
import type { CloudCredential } from "../cloud/credentials";
import type { ServiceManager } from "../service";

export interface ExecutorDeps {
  logger: ScopedLogger;
  /** The live store binding. Lazy: a rotation swaps what this returns. */
  store: () => SessionStore | null;
  /** The update origin, derived from this fortress's cloud URL. */
  downloadBaseUrl: () => Promise<string | null>;
  /** The daemon's own unit — the swap target is read from it. */
  service: ServiceManager;
  /** 0600 single-use credential files, by reference id. */
  cmdCredsDir: string;
  /** The process environment, for the env-managed refusal. */
  env: Record<string, string | undefined>;
  /** The fortress database, for the pause row and the checkup's probe. */
  db: () => HxDb | null;
  /** Swap the live store binding onto rotated credentials. */
  rebindStore: () => Promise<void>;
  /** Replace the fortress's own cloud credential. */
  setCloudCredential: (credential: string) => Promise<CloudCredential>;
  status: () => Promise<HostStatusSnapshot | null>;
  embeddingEndpoint: () => string | null;
  /** One residency audit pass, already wired to this fortress's store, its
   *  witness and its acknowledgements. */
  runAudit: () => Promise<AuditRunResult>;
  /** One storage-migration command, already wired to this fortress's two
   *  buckets, its pause plane and its credentials file. */
  runMigration: (args: {
    command: MigrationCommand;
    target: string | null;
    credentialRef: string | null;
  }) => Promise<string>;
  /** Flip the egress toggle through the fenced routine. */
  setCloudWitness: (enabled: boolean) => Promise<void>;
  /** Write one acknowledgement through the fenced routine. */
  acknowledgeFinding: (args: { org: string; sessionId: string; reason: string | null }) => Promise<void>;
  /** Called once a new binary is in place. The restart it schedules must happen
   *  AFTER the outcome record is durable, so it is a signal rather than an act:
   *  a daemon that restarted itself here would die before the record it is
   *  about to write, leaving a swap nobody can prove happened. */
  onBinarySwapped: () => void;
}

const EMPTY_COUNTS: RollUpCounts = {
  sessionsChecked: 0,
  confirmed: 0,
  alsoAtLetai: 0,
  alsoAtLetaiAcknowledged: 0,
  notDeliveredHere: 0,
  noRecord: 0,
  missingHere: 0,
    lanesHoldIt: 0,
  residencyUnchecked: 0,
    residencyUnwitnessable: 0,
  unknownProvenance: 0,
  notApplicable: 0,
  copyUnchecked: 0,
};

/** A storage migration is under way — either running in this process, or
 *  holding the write gate through an armed pause. Refusing here, by name, keeps
 *  a gated self-test from being reported as a broken credential.
 *
 *  BOTH terms are needed. The pause belongs to the SWAP, so an arm copies for
 *  however long the bucket takes with no row for anything to find: a rotation
 *  submitted during the copy passes a row check and rewrites credentials.json
 *  under a run that is about to name the target bucket, and live ingest then
 *  lands in a third bucket the swap orphans. The row covers what the latch
 *  cannot — a pause armed before this process started, or by anything other
 *  than the engine. */
async function assertNotMigrating(deps: ExecutorDeps): Promise<void> {
  if (migrationIsRunning()) throw new Error(migrationInProgressRefusal(MIGRATION_COPYING_REFERENCE));
  const db = deps.db();
  if (!db) return;
  const row = await readCurrentEpisode(db).catch(() => null);
  if (!row || row.resumedAt !== null) return;
  if (row.pausedUntil.getTime() <= Date.now()) return;
  throw new Error(migrationInProgressRefusal(row.id));
}

function checkupDeps(deps: ExecutorDeps): CheckupDeps {
  return {
    service: deps.service,
    status: deps.status,
    db: deps.db,
    store: deps.store,
    embeddingEndpoint: deps.embeddingEndpoint,
  };
}

export function createCommandExecutors(deps: ExecutorDeps): CommandExecutors {
  return {
    update_apply: async () => {
      const base = await deps.downloadBaseUrl();
      if (!base) {
        throw new Error("this fortress has no update origin — it is not enrolled");
      }
      // The swap target comes from the UNIT, not from this process: a daemon
      // started by hand from a second copy would otherwise replace the copy
      // nothing starts and leave the unit's binary untouched.
      const unit = await deps.service.unit();
      const binPath = unit.executablePath ?? process.execPath;
      // The console path takes the strictest verification this build can do,
      // and says so in the outcome when that is not a signature.
      const gate = consoleUpdateGate();
      const result = await runFortressUpdate({
        downloadBaseUrl: base,
        binPath,
        enforceSignature: gate.enforce,
        log: (message) => deps.logger.info(message),
      });
      if (result.alreadyLatest) {
        return `already on ${result.localVersion}`;
      }
      deps.onBinarySwapped();
      const version = result.remoteVersion ?? "the newest build";
      return gate.warning
        ? `installed ${version} at ${result.installedPath} — ${gate.warning}`
        : `installed ${version} at ${result.installedPath}`;
    },

    self_test: async () => {
      // Refused BY NAME while a migration holds the write gate. The probe is a
      // real bucket WRITE, so the gate answers it with its wire literal —
      // `vault_offline:ingest_paused:<deadline>`, which is addressed to a retrying
      // client and reads to an operator as a broken bucket.
      await assertNotMigrating(deps);
      const store = deps.store();
      if (!store) throw new Error("the object store is not initialized on this fortress");
      await store.selfTest();
      return "storage write path healthy";
    },

    /**
     * The daemon is the single writer of credentials.json, so a rotation is a
     * request the console makes and this answers.
     *
     * Ordering, and why: the env check first (a rotation the next boot would
     * discard must not be attempted at all), the migration check second (a
     * paused fortress refuses the SELF-TEST, and reporting that as broken
     * credentials sends an operator re-issuing keys mid-migration), then a
     * self-test of the CANDIDATE before the file is touched, then the write,
     * then the rebind — which proves the new binding before adopting it.
     */
    rotate_credentials: async (ctx) => {
      if (!ctx.credentialRef) {
        throw new Error("this rotation carries no credential reference");
      }
      // BEFORE the credential is consumed. The reference is single-use, so a
      // refusal that fires after it has been read forces the operator to re-mint
      // material this console had no intention of using — and "a migration is in
      // flight" is by far the most likely refusal, since that is precisely when
      // somebody reaches for the credentials. Nothing below this point can send
      // them back to the start.
      await assertNotMigrating(deps);
      const payload = await consumeCredentialRef<unknown>(deps.cmdCredsDir, ctx.credentialRef);
      if (!payload || !isRotationPayload(payload)) {
        throw new Error(
          "the rotation material was already consumed, expired or unreadable — re-issue it",
        );
      }
      if (payload.target !== "cloud" && deps.env.FORTRESS_STORAGE_BUCKET?.trim()) {
        // The OpenAI key lives in the same file, so it is refused for the same
        // reason: the next boot rebuilds that file from the environment.
        throw new Error(envManagedRefusal(payload.target));
      }
      if (payload.target === "cloud") {
        await deps.setCloudCredential(payload.credential);
        return describeRotation(payload, null);
      }
      const current = await readVaultCredentials();
      const candidate = applyRotation(current, payload);
      // The candidate store carries no gate and no wedge escalation on purpose:
      // this is a probe of credentials, not of the serving path, and it must
      // not be able to exit the process.
      await buildDirectStore(candidate).selfTest();
      const written = await updateVaultCredentials((existing) => applyRotation(existing, payload));
      await deps.rebindStore();
      return describeRotation(payload, written.credentials);
    },
    /**
     * Moving the fortress's objects to another bucket, in the three steps an
     * operator drives it in.
     *
     * The daemon runs it for the same reason it runs a rotation: the cut is a
     * write to credentials.json, and the console holds neither that file's lock
     * nor a store handle to prove the new bucket with. The engine's own order —
     * copy, delta, drain, barrier, fence — is what keeps the arm→swap window
     * measured in seconds; this only names which part of it was asked for.
     */
    run_migration: async (ctx) => {
      const command = ctx.params.phase;
      // The narrowing from a row's parameter to a command. The validator already
      // guarantees it, in another file — so this is what makes the guarantee a
      // type rather than a convention, and it names the row's fault instead of
      // implying the build is too old to know the word.
      if (!isMigrationCommand(command)) {
        throw new Error(`unknown storage-migration phase: ${String(command)}`);
      }
      return await deps.runMigration({
        command,
        target: typeof ctx.params.target === "string" ? ctx.params.target : null,
        credentialRef: ctx.credentialRef,
      });
    },
    run_checkup: async () => {
      await assertNotMigrating(deps);
      return summarizeCheckup(await runCheckup(checkupDeps(deps)));
    },
    run_audit: async (ctx) => {
      const db = deps.db();
      if (!db) throw new Error("the fortress database is not available, so an audit cannot be recorded");
      const run = await startAuditRun(db, {
        trigger: typeof ctx.params.scope === "string" ? ctx.params.scope : "console",
        requestedBy: null,
      });
      try {
        const result = await deps.runAudit();
        await recordFindings(db, run.id, result.findings);
        await finishAuditRun(db, run.id, {
          counts: result.counts,
          qualification: result.qualification,
          error: null,
        });
        const failing = failingFindings(result.findings).length;
        return (
          `${result.verdict}: ${result.qualification} ` +
          `(${result.counts.sessionsChecked} checked, ${failing} failing` +
          `${result.truncated ? ", stopped at this run's budget" : ""})`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await finishAuditRun(db, run.id, {
          counts: EMPTY_COUNTS,
          qualification: "the run did not finish",
          error: message,
        }).catch(() => {});
        throw error;
      }
    },

    witness_toggle: async (ctx) => {
      await deps.setCloudWitness(ctx.params.enabled === true);
      return ctx.params.enabled === true
        ? "let.ai is asked about eligible sessions again"
        : "let.ai is no longer asked; every eligible session reports the witness as unavailable";
    },

    acknowledge_finding: async (ctx) => {
      const org = String(ctx.params.org);
      const sessionId = String(ctx.params.sessionId);
      const reason = typeof ctx.params.reason === "string" ? ctx.params.reason : null;
      await deps.acknowledgeFinding({ org, sessionId, reason });
      // Acknowledging says WHY a copy exists elsewhere. It never says a missing
      // object is present, which is why only the weaker finding can be cleared.
      return `acknowledged for ${sessionId}; later runs inherit it`;
    },
  };
}
