// session-vault Fortress module — implements the Module interface so the
// Fortress host routes MsgData payloads here. The store (S3/GCS) is built
// from credentials.json on init. Transport and identity are owned by Fortress.

import { handleVaultRpc, type VaultAuthz, type VaultRpcRequest } from "./store/rpc.js";
import type { SessionStore } from "./store/types.js";
import { readVaultCredentials, type VaultCredentials } from "./credentials.js";
import { buildDirectStore, buildStore, type StorePauseHooks } from "./store.js";
import { isIngestPaused } from "../../console/pause-gate.js";
import type { HxDb } from "../../host/postgres/db.js";
import { sanitizeDbError } from "../../host/postgres/sanitize.js";
import type {
  HxIngestNotification,
  Module,
  ModuleContext,
  ScopedLogger,
} from "../../host/types.js";

/** The session_vault module plus a getter for its live store, so the ingest
 *  gateway can presign against the same store the tunnel RPCs already use. */
export interface SessionVaultModule extends Module {
  getStore(): SessionStore | null;
  /**
   * Re-read credentials.json and swap the live store binding.
   *
   * The ONLY way a rotation reaches the running daemon. Stopping and restarting
   * the module instead would answer every tunnel vault RPC with "Module not
   * running: session_vault" for the duration — an error class the cloud does not
   * classify as retryable, so purge jobs would consume attempts and dead-letter
   * — and a throwing init() would leave the module dead until a daemon restart
   * while the HTTP gateway kept ingesting on the old key.
   *
   * The new credentials are PROVEN before anything is bound to them. A failure
   * keeps the old store, leaves the module running, and fails the rotation that
   * asked for it: a rotation reported as done over a store that cannot write is
   * the outcome this ordering exists to prevent.
   */
  rebindStore(): Promise<void>;
}

export interface SessionVaultDeps {
  /** Resolves the RW (DML) hx-db handle so tunnel-relayed commits can be mirrored
   *  into the fortress Postgres. Null until Postgres is ready. */
  db?: () => HxDb | null;
  /** Resolves the SELECT-only RO hx-db handle for the "my sessions" metadata read
   *  (least-privilege). Falls back to `db` when omitted. Null until Postgres ready. */
  dbRead?: () => HxDb | null;
  /** Push a realtime invalidation to the cloud after a tunnel-relayed ingest
   *  (MC-2415). Best-effort; omitted in tests. */
  notify?: (evt: HxIngestNotification) => void;
  /** Stop the embedded Postgres before a wedge-escalation exit — launchd has
   *  no cgroup kill, so a hard exit would orphan the daemonized postmaster and
   *  the restarted fortress boots Postgres-less. Bounded by the caller. */
  stopEmbeddedPostgres?: () => Promise<void>;
  /** Compose the store-write pause gate around the store. Omitted in tests and
   *  wherever no pause plane exists. */
  pause?: StorePauseHooks;
  /** Resolves the RW DSN for deleteSession's DEDICATED purge client (built
   *  param-free per invocation — no statement_timeout / maxLifetime — so an
   *  oversized purge keeps its zombie-convergence). Null until Postgres is
   *  ready ⇒ the RPC fails typed and the cloud PARKS the purge job. */
  purgeDsn?: () => string | null;
}

/** RPC methods that mutate the store — always log completion + duration. The
 *  2026-07-30 wedge was invisible precisely because a hung write handler and a
 *  healthy-but-quiet one produced identical (empty) logs. */
const WRITE_RPC_METHODS = new Set([
  "ingestCommit",
  "ingestAgentCommit",
  "appendChunkToCanonical",
  "writeArtifact",
  "deleteSession",
]);
/** Any RPC slower than this logs its duration, read or write. */
const SLOW_RPC_LOG_MS = 5_000;
/** Write-path self-test cadence (ms); FORTRESS_STORE_PROBE_INTERVAL_MS
 *  overrides, 0 disables. */
const PROBE_INTERVAL_MS = (() => {
  const raw = process.env.FORTRESS_STORE_PROBE_INTERVAL_MS;
  // Set-but-EMPTY means "default", never 0: only an explicit "0" may disable
  // the incident's core detection mechanism.
  if (raw === undefined || raw.trim() === "") return 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
})();

export default function createModule(deps: SessionVaultDeps = {}): SessionVaultModule {
  let store: SessionStore | null = null;
  let logger: ScopedLogger | null = null;

  /**
   * The one factory both init() and rebindStore() go through.
   *
   * buildStore is what INSTALLS the pause gate, the per-call deadlines and the
   * poisoned-pool rebuild, and all three are per-instance wrappers. A rebind
   * that constructed a backend directly would return a bare store, and every
   * ingest route, artifact write, deleteSession and self-test would bypass
   * ingest_control from that moment on.
   */
  const bindStore = (creds: VaultCredentials): SessionStore =>
    buildStore(creds, logger ?? undefined, {
      ...(deps.stopEmbeddedPostgres ? { beforeExit: deps.stopEmbeddedPostgres } : {}),
      ...(deps.pause ? { pause: deps.pause } : {}),
    });

  let probeTimer: ReturnType<typeof setInterval> | null = null;
  let probeBusy = false;
  let probeFailing = false;
  // Per-EPISODE pause logging state: one summary line per deadline, then debug.
  let pauseSummaryAt = 0;
  let pausedRefusals = 0;

  return {
    id: "session_vault",

    getStore(): SessionStore | null {
      return store;
    },

    async rebindStore(): Promise<void> {
      const creds = await readVaultCredentials();
      if (!creds) {
        throw new Error("session-vault: no credentials.json to rebind to");
      }
      // Proven against the real bucket before anything points at it — through
      // the UNGATED backend, which is the only store that can answer while a
      // pause is armed.
      //
      // The one caller that rebinds under a pause is the storage-migration
      // swap, and it arms that pause itself: probing through the serving store
      // asks the write gate to admit the very write it was armed to refuse, so
      // the cut threw `vault_offline:ingest_paused` with credentials.json
      // already naming the new bucket. The daemon kept writing the old one, the
      // operator was told the swap failed, and the next restart silently served
      // the target — without everything written in between. This is the probe
      // the rotation executor already takes, for the same reason: it proves
      // CREDENTIALS, not the serving path.
      await buildDirectStore(creds).selfTest();
      store = bindStore(creds);
      logger?.info("store rebound onto rotated credentials", {
        kind: creds.store,
        bucket: creds.bucket,
        version: creds.version ?? 0,
      });
    },

    async init(context: ModuleContext): Promise<void> {
      logger = context.logger;
      const creds = await readVaultCredentials();
      if (!creds) {
        throw new Error("session-vault: no credentials.json — run the enroll wizard first");
      }
      store = bindStore(creds);

      const { fortressIdentity } = context;
      if (fortressIdentity) {
        context.logger.info("store initialized", {
          kind: creds.store,
          bucket: creds.bucket,
          orgId: fortressIdentity.orgId,
          fortressId: fortressIdentity.fortressId,
        });
      } else {
        context.logger.warn("store initialized without Fortress identity — not yet enrolled", {
          kind: creds.store,
          bucket: creds.bucket,
        });
      }

      // Write-path self-test. Process liveness kept a wedged storage pool
      // "healthy" for three hours on 2026-07-30: Postgres-backed reads stayed
      // green while every bucket write hung silently. Probe the real bucket on
      // an interval — a failure is loud here, and a hang counts as a deadline
      // breach inside GuardedStore, feeding its client rebuild.
      if (PROBE_INTERVAL_MS > 0) {
        probeTimer = setInterval(() => {
          if (probeBusy || !store) return;
          // NOT while the gate is shut. The probe is a real bucket WRITE, so a
          // pause refuses it — and the refusal was logged at ERROR as "store
          // write-path self-test failed" every minute for the whole pause. That
          // is the exact line an operator watches for a wedged bucket, printed
          // for a fortress that is deliberately holding writes, during the one
          // operation that arms a pause.
          if (deps.pause?.state.isPaused()) return;
          probeBusy = true;
          void store
            .selfTest()
            .then(() => {
              if (probeFailing) logger?.info("store write path recovered");
              probeFailing = false;
            })
            .catch((err: unknown) => {
              // A pause armed between the check above and the call: still a
              // deliberate refusal, still not a fault.
              if (isIngestPaused(err)) return;
              probeFailing = true;
              logger?.error("store write-path self-test failed", {
                error: err instanceof Error ? err.message : String(err),
              });
            })
            .finally(() => {
              probeBusy = false;
            });
        }, PROBE_INTERVAL_MS);
        (probeTimer as { unref?: () => void }).unref?.();
      }
    },

    async stop(): Promise<void> {
      if (probeTimer) clearInterval(probeTimer);
      probeTimer = null;
    },

    async onMessage(data) {
      if (!store) {
        return { ok: false, error: "session-vault: store not initialized" };
      }
      const req = data.payload as VaultRpcRequest;
      // The connection attaches the verified grant's authz alongside the payload
      // (H-4) — fortress-internal, never on the wire MsgData contract.
      const authz = (data as { authz?: VaultAuthz }).authz;
      const startedAt = Date.now();
      try {
        const result = await handleVaultRpc(
          store,
          req,
          deps.db ?? null,
          authz,
          deps.dbRead ?? null,
          logger ?? undefined,
          deps.purgeDsn ?? null,
        );
        const ms = Date.now() - startedAt;
        if (WRITE_RPC_METHODS.has(req.method) || ms >= SLOW_RPC_LOG_MS) {
          logger?.info("vault RPC ok", { method: req.method, ms });
        }
        // A relayed commit just changed this user's sessions — tell the cloud to
        // refresh their live list (MC-2415). Best-effort, after the write landed.
        if (req.method === "ingestCommit" || req.method === "ingestAgentCommit") {
          deps.notify?.({
            userExternalId: req.key.userId,
            orgExternalId: req.attribution.orgExternalId,
          });
        }
        return { ok: true, payload: result };
      } catch (err) {
        // The error string is logged AND returned to the cloud on the wire, so
        // redact any DSN a Postgres/driver error might have echoed (Low).
        const message = sanitizeDbError(err);
        if (isIngestPaused(err)) {
          // A pause is a deliberate, time-bounded refusal, and a drain can
          // refuse thousands of RPCs. Error-level per request would bury the
          // reason it was armed under its own noise — so one summary per pause
          // episode, and the individual refusals at info.
          if (pauseSummaryAt !== err.pausedUntil.getTime()) {
            pauseSummaryAt = err.pausedUntil.getTime();
            pausedRefusals = 0;
            logger?.info("ingest paused — refusing store writes until the deadline", {
              pausedUntil: err.pausedUntil.toISOString(),
            });
          }
          pausedRefusals += 1;
          logger?.debug("vault RPC refused: ingest paused", {
            method: req.method,
            refusals: pausedRefusals,
          });
          return { ok: false, error: message };
        }
        logger?.error("vault RPC failed", {
          method: req.method,
          error: message,
          ms: Date.now() - startedAt,
        });
        return { ok: false, error: message };
      }
    },
  };
}
