import { randomUUID } from "node:crypto";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  FileCredentialStore,
  FilePendingEnrollmentStore,
  SUPPORTED_PROTOCOL_VERSION,
  WsCloudConnection,
} from "../cloud";
import type { PendingEnrollment, WsCloudConnectionDeps } from "../cloud";
import { computeCollectionStats } from "../query/collection-stats";
import packageJson from "../../package.json";
import createSessionVaultModule from "../modules/session-vault/module";
import {
  readVaultCredentials,
  redactCredentials,
  writeVaultCredentials,
  type VaultCredentials,
} from "../modules/session-vault/credentials.js";
import { applyHeadlessBootstrap } from "./headless-bootstrap";
import { adoptDaemonHome } from "./daemon-home";
import {
  DEFAULT_GATEWAY_PUBLIC_URL,
  ensureCoreModulesEnabled,
  ensureEnrollmentConfig,
  ensureGatewayPublicUrlConfigured,
  FileConfigStore,
  resolveEmbedConfig,
  resolveGatewayConfig,
  rosterInactivePurgeDays,
} from "./config";
import {
  createEmbedWorker,
  createOpenAIEmbedder,
  setEmbedSignalHandler,
  type Embedder,
  type EmbedWorker,
} from "../modules/embed-worker";
import { FileLogSink } from "./file-log-sink";
import { MultiLogSink, StdoutLogSink } from "./stdout-log-sink";
import { BusHostLogger, LogBus } from "./logging";
import { ModuleRegistry } from "./module-registry";
import { fortressPaths } from "./paths";
import { buildPostgresProvider } from "./postgres";
import { createGuardedDb, type GuardedDb } from "./postgres/guarded-db";
import { createPoolOccupancyLog } from "./postgres/pool-occupancy-log";
import type { HxDb } from "./postgres/db";
import { runHost, type HostLifecycle } from "./run-host";
import { HostRuntime } from "./runtime";
import { FileStatusStore } from "./status";
import { FileStatusReader } from "../status-reader";
import type { CloudConnection, HxIngestNotification } from "./types";
import { FileSigningKeyStore } from "../gateway/signing-key-store";
import { startGatewayServer, type GatewayHandle } from "../gateway/server";
import { verifyGrant, type GrantClaims } from "../gateway/capability-token";
import { createMcpTunnelHandler } from "../mcp/tunnel-handler";
import type { McpTunnelRequest, McpTunnelResult } from "../protocol";
import { parseBooleanEnv } from "../env";
import { createGuarantor, guarantorEnabled, type Guarantor } from "../ingest/guarantor";
import { setReconcileSignalHandler } from "../ingest/reconcile-signal";
import { isSessionDeleted } from "../ingest/delete";
import { drainParkedArtifacts, parkArtifact, ParkReplayLatch } from "../console/artifact-replay";
import { forgetCopiedSessions } from "../console/migration-store";
import { addForgetPending, readForgetPending, removeForgetPending } from "../console/runtime-files";
import { migrationIsRunning } from "../console/migration-runner";
import { createCommandGateway, createUnavailableCommandGateway } from "../console/command-gateway";
import { pollCommands, runBootFence } from "../console/commands";
import { createCommandExecutors } from "../console/executors";
import { getServiceManager } from "../service";
import { getUiServiceControl, restartUiUnitDetached } from "../ui/service-control";
import { downloadBaseFromCloudUrl } from "../update";
import { readConsoleAdvertisement } from "../ui/advertise";
import { runAuditForFortress } from "../console/audit-runner";
import { holdMigration, runMigrationCommand } from "../console/migration-runner";
import { readPgJson } from "./postgres/pg-json";
import { buildDirectStore } from "../modules/session-vault/store";
import {
  mergeReplayedMetadata,
  parseSessionMetadata,
  SESSION_METADATA_ARTIFACT,
} from "../modules/session-vault/store/session-metadata";
import { purgeInactiveRoster, replaceRoster } from "../console/roster";
import {
  clearRosterPurgeIntent,
  publishRosterPurge,
  readRosterPurgeIntent,
} from "../console/roster-signal";
import { createWitnessClient } from "../console/audit-witness";
import {
  postureFreshness,
  POSTURE_REFRESH_MS,
  RoutingPostureCache,
  routingPosturePath,
} from "../cloud/fortress-query";
import { readAcknowledgements, sweepAuditRuns } from "../console/audit-store";
import {
  clearWitnessIntent,
  publishAcks,
  publishAuditSettings,
  readWitnessIntent,
} from "../console/witness-signal";
import { sql as sqlTag } from "drizzle-orm";
import { DaemonAudit } from "../console/daemon-audit";
import { LiveUiConfig, effectiveUiEnabled } from "../ui/config";
import { consumeCredentialRef, sweepCmdCreds } from "../console/cmd-creds";
import { effectivePause, PauseState } from "../console/ingest-control";
import { readCurrentEpisode } from "../console/ingest-control-db";
import { IngestQuiesce } from "../console/pause-gate";
import { MetricsRegistry, startMetricsPublisher } from "../console/metrics";
import { clearPauseAnchor, stampPauseAnchor } from "../console/runtime-files";

export interface HostMainDependencies {
  root?: string;
  version?: string;
  createConnection?: (dependencies: WsCloudConnectionDeps) => CloudConnection;
  run?: (runtime: HostLifecycle) => Promise<void>;
}

export async function resolvePendingEnrollmentForStartup(
  pendingEnrollmentStore: FilePendingEnrollmentStore,
): Promise<PendingEnrollment | null> {
  return pendingEnrollmentStore.load().catch(() => null);
}

/** ws(s) origin (protocol + host + port) of a URL, or null when unparseable. */
export function wsOrigin(u: string): string | null {
  try {
    const url = new URL(u);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/** M-8 · decide whether a pending-enrollment.json should be honored at startup.
 *  A pending enrollment is the operator's fresh (re-)bootstrap intent, but a file
 *  an attacker drops next to an ALREADY-ENROLLED fortress would otherwise re-home
 *  it (its own token + its own cloud origin) to the attacker's org — handing over
 *  the fortress's bucket + data. So once a credential is saved, honor a pending
 *  enrollment only when its cloudUrl shares the enrolled cloud origin, unless
 *  FORTRESS_ALLOW_REENROLL is explicitly set. */
export function isPendingEnrollmentTrusted(args: {
  savedCredentialExists: boolean;
  pendingCloudUrl: string;
  enrolledCloudUrl: string | null;
  allowReenroll: boolean;
}): boolean {
  if (!args.savedCredentialExists) return true; // fresh install — nothing to hijack
  if (args.allowReenroll) return true; // explicit operator opt-in
  const enrolled = args.enrolledCloudUrl ? wsOrigin(args.enrolledCloudUrl) : null;
  const pending = wsOrigin(args.pendingCloudUrl);
  return enrolled !== null && pending !== null && enrolled === pending;
}

export async function runFortressHost(
  dependencies: HostMainDependencies = {},
): Promise<void> {
  const root = dependencies.root;
  const version = dependencies.version ?? packageJson.version;
  const paths = fortressPaths(root);
  // ONCE, and before anything reads or writes a credential — the bootstrap
  // below rebuilds credentials.json, and a home adopted after that write would
  // leave the file the fortress is serving from and the one it just wrote in two
  // different places. Never inside readVaultCredentials: that is a pure read the
  // console's read class reaches, and re-homing a process is an effect.
  const homeResolution = adoptDaemonHome({});
  // On a non-interactive host (the Railway cloud service — no TTY) tee every
  // record to stdout as well, so the platform's log capture actually shows
  // fortress activity + connection errors. File-only leaves logs in
  // logs/service.log inside the container, invisible to Railway (which then
  // shows just "Starting Container"). A local operator install runs in a TTY
  // and keeps file-only so its terminal / TUI stays clean.
  const fileSink = new FileLogSink(paths.log);
  const sink = process.stdout.isTTY
    ? fileSink
    : new MultiLogSink([fileSink, new StdoutLogSink()]);
  const bus = new LogBus(sink);
  const logger = new BusHostLogger(bus);
  const registry = new ModuleRegistry(bus);
  // Lazily built once Postgres is ready (the cluster boots after modules are
  // wired). Two role-scoped handles (de-superuser least-privilege): the RW
  // handle (hx_app_rw) is the ingest write path shared by the tunnel module +
  // the direct gateway; the RO handle (hx_app_ro) is the SELECT-only read path
  // for the MCP tools (HTTP /mcp + the reverse tunnel). Embedded mode splits the
  // two roles; external mode resolves both to the operator's single URL.
  //
  // The memoization now lives inside guarded-db (built below, once the
  // provider exists — same late-binding as the closures that follow): it owns
  // the pools, probes them every 60 s, and rotates them when the probe proves
  // the pool wedged — the Aug-2026 incident class where every PG op hung
  // forever with zero error lines.
  let guardedDb: GuardedDb | null = null;
  const resolveHxDb = (): HxDb | null => guardedDb?.db() ?? null;
  const resolveHxDbRead = (): HxDb | null => guardedDb?.dbRead() ?? null;
  // Background repair runs on its OWN small pool. Sharing the live RW pool is
  // what let one reconcile pass of whole-transcript restores hold the
  // per-session advisory locks that live chunks then queued behind, until the
  // write path had no connections left (2026-08-05).
  const resolveHxDbBackground = (): HxDb | null => guardedDb?.dbBackground() ?? null;
  // Late-bound recovery hooks (the worker/guarantor are built after guarded-db).
  const dbHealth = { onRebuild: (): void => {}, onRecovered: (): void => {} };
  // The store-write pause plane. The state is what the gate consults on every
  // bucket-mutating call; the counter is what a pre-swap quiesce barrier waits
  // on. Both are created before the store so the gate can be composed around
  // it, and refreshed from Postgres on the status-heartbeat cadence.
  const pauseState = new PauseState();
  const quiesce = new IngestQuiesce();
  // The drain latch: while it is up, new staging signatures are cut short so the
  // pre-swap barrier has a bounded floor to wait out. In MEMORY on purpose — a
  // restart clears it, which bounds an armed migration nobody followed up.
  let drainArmed = false;
  const parkedArtifactsPath = path.join(paths.runtimeRoot, "artifact-replay.jsonl");
  const forgetPendingPath = path.join(paths.runtimeRoot, "migration-forget-pending.json");
  const metrics = new MetricsRegistry();
  metrics.declareCounter("ingest.paused_refusals");
  metrics.registerGauge("ingest.pause_seconds_remaining", () => {
    const until = pauseState.pausedUntil();
    return until ? Math.max(0, Math.round((until.getTime() - Date.now()) / 1000)) : 0;
  });
  metrics.registerGauge("store.in_flight_writes", () => quiesce.pending);
  // A gauge that returns null is OMITTED rather than published as 0 — "the
  // direct gateway is off on this fortress" and "the gateway served nothing"
  // read identically as a zero and mean opposite things.
  metrics.registerGauge("gateway.enabled", () => (gateway.enabled ? 1 : null));

  // Fortress→cloud realtime bridge (MC-2415): ingest paths emit invalidations
  // here; the closure is repointed at the live connection once it's built below
  // (the connection is constructed after the module that needs to emit). A
  // no-op until then, so any ingest before the tunnel is up is simply not
  // signalled (the client's own refetch recovers the list).
  const hubNotify: { send: (evt: HxIngestNotification) => void } = { send: () => {} };
  // MC-2430 tunnel-MCP: late-bound like hubNotify — the connection is built
  // before the embedder/store below, so hand it a holder and repoint it once
  // db+store+embedder exist. Replies "not ready" until then.
  const mcpTunnel: { handle: (req: McpTunnelRequest) => Promise<McpTunnelResult> } = {
    handle: async () => ({ method: "callTool", content: JSON.stringify({ error: "mcp_tunnel_not_ready" }), isError: true }),
  };
  const emitIngest = (evt: HxIngestNotification): void => hubNotify.send(evt);
  // The vault RPC dispatch takes both handles: writes (ingest RPCs) run on the RW
  // handle; the "my sessions" metadata read (listSessions) runs on the SELECT-only
  // RO handle (least-privilege — the read branch never needs DML).
  const vaultModule = createSessionVaultModule({
    db: resolveHxDb,
    dbRead: resolveHxDbRead,
    notify: emitIngest,
    // Closure to the provider declared below (same late-binding as resolveHxDb):
    // only invoked at wedge-escalation time, long after startup completes.
    stopEmbeddedPostgres: () => postgres.stop(),
    pause: {
      state: pauseState,
      quiesce,
      armed: () => drainArmed,
      onRefused: () => metrics.increment("ingest.paused_refusals"),
    },
    // deleteSession's dedicated purge client (param-free, per invocation) —
    // built from the RW DSN so an oversized purge keeps zombie-convergence.
    purgeDsn: () => postgres.dsn("rw"),
  });
  registry.register(vaultModule);
  const credentialStore = new FileCredentialStore(paths.credentials);
  const pendingEnrollmentStore = new FilePendingEnrollmentStore(paths.pendingEnrollment);
  const signingKeyStore = new FileSigningKeyStore(paths.signingKey);

  // H-4 · verify a tunnel/reverse-tunnel capability GRANT offline against the
  // PINNED per-org signing key + the enrolled org id. Shared by the cloud
  // connection (vault RPC) and the reverse-tunnel MCP handler. Throws (⇒ the
  // caller rejects the grant) before the key is pinned or the org id is known.
  const verifyGrantFn = async (
    token: string,
    opts: { purpose: "ingest" | "read"; requireScope?: boolean },
  ): Promise<GrantClaims> => {
    const key = await signingKeyStore.pinnedKey();
    if (!key) throw new Error("no pinned signing key");
    const orgId = (await credentialStore.load().catch(() => null))?.orgId ?? null;
    if (!orgId) throw new Error("fortress org id unknown");
    // requireScope is the CALLER's decision (vault-RPC own-object reads pass false;
    // the scope-bound tunnel-MCP read path passes true) — forward it unchanged.
    return verifyGrant(token, key, orgId, opts);
  };

  if (homeResolution.adopted) {
    // Said out loud, with what was looked at: an operator comparing this against
    // the volume they think they mounted is the only way a home that moved
    // between image versions ever gets noticed.
    bus.scopeFor("fortress").info("serving from an adopted fortress home", {
      home: homeResolution.home,
      searched: homeResolution.searched,
    });
  }

  // Cloud-service run mode: materialize storage credentials + a pending
  // enrollment from the environment before reading them off disk, so a fresh
  // container enrolls with zero interaction. No-op when the headless env is
  // absent (e.g. a normal operator install driven by the enroll wizard).
  await applyHeadlessBootstrap({
    env: process.env,
    credentialStore,
    pendingEnrollmentStore,
    writeVaultCredentials,
    readVaultCredentials,
    logger: bus.scopeFor("fortress"),
  });

  let pendingEnrollment = await resolvePendingEnrollmentForStartup(
    pendingEnrollmentStore,
  );

  if (pendingEnrollment) {
    // M-8 · gate a hijack-drop pending enrollment BEFORE its config/token loads:
    // once a credential is saved, only honor a pending enrollment at the same
    // enrolled cloud origin (or under FORTRESS_ALLOW_REENROLL).
    const savedCredential = await credentialStore.load().catch(() => null);
    const enrolledConfig = await new FileConfigStore(paths).load().catch(() => null);
    const trusted = isPendingEnrollmentTrusted({
      savedCredentialExists: savedCredential !== null,
      pendingCloudUrl: pendingEnrollment.cloudUrl,
      enrolledCloudUrl: enrolledConfig?.cloud.url ?? null,
      allowReenroll: parseBooleanEnv(process.env.FORTRESS_ALLOW_REENROLL),
    });
    if (trusted) {
      await ensureEnrollmentConfig(paths, pendingEnrollment.cloudUrl);
    } else {
      bus.scopeFor("fortress").warn(
        "ignoring a pending enrollment for an already-enrolled fortress: its cloudUrl origin " +
          "differs from the enrolled one; set FORTRESS_ALLOW_REENROLL to re-enroll",
        {
          enrolledOrigin: enrolledConfig ? wsOrigin(enrolledConfig.cloud.url) : null,
          pendingOrigin: wsOrigin(pendingEnrollment.cloudUrl),
        },
      );
      // Fall through to `hello` with the saved credential — the hijack token
      // never loads (enrollToken below reads pendingEnrollment?.token).
      pendingEnrollment = null;
    }
  }
  await ensureGatewayPublicUrlConfigured(paths);
  await ensureCoreModulesEnabled(paths);

  // let configuredGatewayUrl: string | undefined;
  // try {
  //   configuredGatewayUrl = (await new FileConfigStore(paths).load()).gateway.publicUrl;
  // } catch {
  //   configuredGatewayUrl = undefined;
  // }
  const gateway = resolveGatewayConfig(process.env,
    //configuredGatewayUrl
  );

  // Read the persisted config (if any) only to pick up postgres overrides;
  // a fresh install has no config.json yet, so fall back to defaults. The
  // runtime reloads and validates the full config itself on start().
  const hostConfig = await new FileConfigStore(paths).load().catch(() => null);
  const postgres = buildPostgresProvider({
    env: process.env,
    config: hostConfig ?? {
      schemaVersion: 1,
      cloud: { url: "" },
      gateway: { publicUrl: DEFAULT_GATEWAY_PUBLIC_URL },
      modules: { enabled: [] },
    },
    paths,
    logger: bus.scopeFor("postgres"),
  });

  guardedDb = createGuardedDb({
    dsn: (role) => postgres.dsn(role),
    logger: bus.scopeFor("hx-db"),
    onRebuild: () => dbHealth.onRebuild(),
    onRecovered: () => dbHealth.onRecovered(),
    stopEmbeddedPostgres: () => postgres.stop(),
  });
  guardedDb.start();

  // LETAIR-301 (degradation observability): passive per-pool connection census
  // to the logs every ~60s, so a week of it is a greppable time-series. Runs on
  // its own isolated connection — never an rw/ro/bg pool slot.
  const poolOccupancyLog = createPoolOccupancyLog({
    dsn: (role) => postgres.dsn(role),
    logger: bus.scopeFor("hx-db"),
  });
  poolOccupancyLog.start();

  const vaultCreds = await readVaultCredentials();

  // MC-2471: fail-fast — the fortress indexes sessions for semantic search by
  // creating OpenAI vector embeddings in its local Postgres DB. Without a key
  // that search can't work, so refuse to start rather than silently degrade to
  // keyword-only search. Set it in the enroll wizard, or FORTRESS_OPENAI_API_KEY.
  if (!resolveEmbedConfig(process.env, vaultCreds?.openaiApiKey).enabled) {
    throw new Error(
      "hx-fortress needs an OpenAI API key to create vector embeddings for semantic " +
        "search of the sessions stored in its local Postgres DB. Add it in the enroll " +
        "wizard (hx-fortress enroll) or set FORTRESS_OPENAI_API_KEY, then start again.",
    );
  }

  const connectionDependencies: WsCloudConnectionDeps = {
    dispatcher: registry,
    credentialStore,
    // Composed at EVERY connection attempt, not once at boot: consoleUrl and
    // runtimeKind are read from ui.json and the environment as they stand now,
    // so `ui sso off` and `ui disable` reach the hub on the next reconnect
    // instead of being overwritten by whatever boot happened to read.
    identity: async () => ({
      version,
      protocolVersion: SUPPORTED_PROTOCOL_VERSION,
      storageKind: vaultCreds?.store ?? undefined,
      bucketRegion: vaultCreds?.region ?? undefined,
      bucket: vaultCreds?.bucket ?? undefined,
      gatewayUrl: gateway.gatewayUrl,
      ...(await readConsoleAdvertisement({
        // Hoisted: constructed per connection, its lastGood cache was always
        // empty, so the class's documented degradation — fall back to the last
        // good snapshot on a torn or unreadable re-read — could never engage.
        config: liveUiConfig,
        env: process.env,
      })),
    }),
    logger,
    signingKeyStore,
    verifyGrant: verifyGrantFn,
    mcp: mcpTunnel,
    // MC-2368: report collection counts on the heartbeat once the DB is ready.
    collectionStats: async () => {
      const db = resolveHxDb();
      return db ? computeCollectionStats(db) : null;
    },
    // The roster arrives unsolicited, on connect and whenever the hub recomputes
    // it. Stored as it lands so the console never has to ask the cloud a
    // question at read time.
    onRoster: async (roster) => {
      const db = postgres.isReady() ? resolveHxDb() : null;
      if (!db) throw new Error("the fortress database is not available");
      const applied = await replaceRoster(db, roster);
      if (applied.stale) {
        // Not an error, and not an application either — saying "applied … 0
        // members" would read as let.ai reporting an empty organization.
        bus.scopeFor("roster").info("ignored a roster older than the one already applied", {
          asOf: roster.asOf,
        });
        return;
      }
      bus.scopeFor("roster").info("applied the roster let.ai sent", {
        members: applied.received,
        departed: applied.deactivated,
      });
    },
    enrollToken: pendingEnrollment?.token,
    async onEnrolled(cred) {
      await pendingEnrollmentStore.clear().catch((err) => {
        logger.error("Failed to clear pending enrollment token", err);
      });
      registry.setFortressIdentity(cred);
    },
  };
  const connection =
    dependencies.createConnection?.(connectionDependencies) ??
    new WsCloudConnection(connectionDependencies);
  // Now that the tunnel connection exists, route ingest notifications to it.
  hubNotify.send = (evt) => connection.notifyIngest(evt);
  const runtime = new HostRuntime({
    configStore: new FileConfigStore(paths),
    connection,
    postgres,
    supervisor: registry,
    statusStore: new FileStatusStore(paths),
    logger,
    // Published so a console can prove by file identity that it is looking at
    // THIS install rather than a second daemon on another root.
    root: paths.root,
    afterPostgres: () => bootConsolePlane(),
    // Low · fold a secret-free vault view into each status snapshot (never keys).
    vaultStatus: () => (vaultCreds ? redactCredentials(vaultCreds) : null),
    async afterConnect() {
      // Load the saved Fortress identity and make it available to modules.
      // Works for both the fresh-enrollment path (onEnrolled already set it)
      // and returning connections (credential already existed on disk).
      const cred = await credentialStore.load().catch(() => null);
      registry.setFortressIdentity(cred);
      // The hub is reachable as of now — ask for its view of this organization
      // immediately instead of waiting out the refresh interval.
      void refreshPosture();
    },
  });

  // Start the direct-ingest gateway alongside the tunnel when the operator has
  // exposed a public URL. It presigns against the same live session_vault store
  // the tunnel RPCs use, and verifies capability tokens with the org public key
  // the hub pushes over the tunnel (cached on disk for offline restarts).
  // The same Bun.serve gateway also serves the hx_* MCP server at POST /mcp
  // (A5) — so the MCP endpoint boots here, with the gateway, whenever a public
  // URL is configured.
  // The fortress's OpenAI embedder (A3) — null when FORTRESS_OPENAI_API_KEY is
  // absent, so the embed worker stays off and hx_semantic_search degrades to
  // keyword. Shared by the gateway's semantic tool and the embed worker.
  const embedConfig = resolveEmbedConfig(process.env, vaultCreds?.openaiApiKey);
  const embedder: Embedder | null = embedConfig.enabled
    ? createOpenAIEmbedder({
        apiKey: embedConfig.apiKey,
        model: embedConfig.model,
        dimensions: embedConfig.dimensions,
        baseUrl: embedConfig.baseUrl,
      })
    : null;
  // MC-2517 · the QUERY-path embedder (hx_semantic_search, served over the tunnel
  // and the HTTP gateway) is BOUNDED — each OpenAI attempt is time-capped and
  // retried a few times (config.queryTimeoutMs / queryMaxRetries). A stalled
  // embeddings call then fails fast with a typed `unavailable` the agent relays,
  // instead of hanging the MCP call until the workbench's 60s ceiling kills it
  // silently. The background embed worker keeps the unbounded `embedder` above (it
  // tolerates slow OpenAI and just retries next pass). Same key/model/dimensions/
  // baseUrl, so vector distances stay comparable across the two.
  const queryEmbedder: Embedder | null = embedConfig.enabled
    ? createOpenAIEmbedder({
        apiKey: embedConfig.apiKey,
        model: embedConfig.model,
        dimensions: embedConfig.dimensions,
        baseUrl: embedConfig.baseUrl,
        timeoutMs: embedConfig.queryTimeoutMs,
        maxRetries: embedConfig.queryMaxRetries,
      })
    : null;
  // H-7 · loud one-time warning when conversational text is embedded against the
  // PUBLIC OpenAI endpoint — it carries no zero-retention/DPA guarantee. Steer the
  // operator at a zero-retention endpoint via FORTRESS_OPENAI_BASE_URL.
  if (embedConfig.enabled && embedConfig.baseUrl === "https://api.openai.com/v1") {
    bus
      .scopeFor("embed-worker")
      .warn(
        "embeddings egress to the public OpenAI endpoint (no zero-retention/DPA guarantee); " +
          "set FORTRESS_OPENAI_BASE_URL to a zero-retention endpoint",
      );
  }

  // Tunnel-MCP now has db+store+embedder — repoint the holder to the real
  // handler so the reverse tunnel serves the same hx_* tools as the HTTP gateway.
  mcpTunnel.handle = createMcpTunnelHandler({
    // Read-only tools → the SELECT-only RO handle (least-privilege).
    db: resolveHxDbRead,
    logger: bus.scopeFor("mcp-tunnel"),
    store: () => vaultModule.getStore(),
    // MC-2517 · the bounded query embedder (fails fast on a stalled OpenAI call).
    embedder: queryEmbedder,
    // H-4 · a tunnel MCP read runs under a verified read grant (scope-bound).
    verifyGrant: verifyGrantFn,
  }).handle;

  let gatewayHandle: GatewayHandle | null = null;
  if (gateway.enabled) {
    gatewayHandle = startGatewayServer({
      port: gateway.port,
      logger: bus.scopeFor("gateway"),
      signingKey: () => signingKeyStore.load(),
      // The fortress's own org id (from the enrolled cloud credential) lets the
      // gateway reject a capability token whose `aud` names a different org —
      // anti cross-org replay. Null before enrollment (no token verifies then).
      ownOrgId: () => credentialStore.load().then((c) => c?.orgId ?? null).catch(() => null),
      store: () => vaultModule.getStore(),
      postgresReady: () => postgres.isReady(),
      postgresSaturated: () => guardedDb?.saturated() ?? false,
      // RW handle for the ingest write path; RO handle for the /mcp read tools.
      db: resolveHxDb,
      dbRead: resolveHxDbRead,
      // MC-2517 · the bounded query embedder (fails fast on a stalled OpenAI call).
      embedder: queryEmbedder,
      notify: emitIngest,
      quiesce,
      parkArtifact: (entry) => parkArtifact(parkedArtifactsPath, entry),
    });
  }

  // Boot the embed worker beside the gateway (A3). It owns its OWN capped
  // Bun.SQL handle (resolved lazily once the cluster's dsn is available — the
  // shared createHxDb handle is uncapped) and drains the anti-join of un-embedded
  // indexable turns; ingest signals it post-commit (debounced + max-wait capped).
  // Runs whenever a key is configured, independent of the public gateway (ingest
  // also arrives over the tunnel).
  let embedWorker: EmbedWorker | null = null;
  if (embedder) {
    embedWorker = createEmbedWorker({
      // The embed worker writes embeddings + budget rows → the RW role.
      dsn: () => postgres.dsn("rw"),
      embedder,
      dbMax: embedConfig.dbMax,
      concurrency: embedConfig.concurrency,
      batchSize: embedConfig.batchSize,
      maxPerPass: embedConfig.maxPerPass,
      debounceMs: embedConfig.debounceMs,
      maxWaitMs: embedConfig.maxWaitMs,
      dailyTokenBudget: embedConfig.dailyTokenBudget,
      logger: bus.scopeFor("embed-worker"),
    });
    setEmbedSignalHandler(() => embedWorker?.signal());
    embedWorker.start();
  }
  // A pool rebuild retires the DSN's sockets — the worker must not keep its own
  // pool pointed at them.
  dbHealth.onRebuild = () => embedWorker?.resetDb();

  // Component G (MC-2606) — the guarantor. Re-indexes any canonical transcript
  // that reached the bucket but has NO hx.sessions row (the row-less state behind
  // the title incident), re-running the FULL ingest so rows, FTS, tool_calls,
  // session_facts, dimensions, embeddings and the real title are all rebuilt. ON
  // by default (FORTRESS_GUARANTOR_DISABLED turns it off). Reads the same lazily-
  // resolved RW db + live vault store the gateway uses, so it's safe to start
  // before either is ready (a pass that finds them down just reschedules).
  //
  // Pacing knobs (optional): a boot-drain of the whole backlog re-ingests every
  // orphan at once, which enqueues all their turns for embedding at the daily
  // budget. Titles/rows appear immediately (written in the ingest txn); only
  // embeddings lag. Unbounded by default (fast restore, accept a short semantic-
  // search lag); FORTRESS_GUARANTOR_MAX_ORPHANS_PER_PASS caps a pass so the
  // backlog drains across the hourly sweeps instead. FORTRESS_CORRECT_TITLES
  // opts into the one-time backfill of pre-existing fallback/empty titles (off by
  // default — it re-reads every such canonical, and restores already get their
  // real title from the cascade).
  // parseBooleanEnv answers "is this truthy", which cannot express "unset means
  // ON" — reading it that way silently defaults the repair OFF. Unset or
  // set-but-empty means ON here; only an explicit falsey value disables it.
  const repairStaleFromEnv = (raw: string | undefined): boolean =>
    raw === undefined || raw.trim() === "" ? true : parseBooleanEnv(raw);

  let guarantor: Guarantor | null = null;
  if (guarantorEnabled()) {
    // A pass repairs at most this many sessions. Previously UNBOUNDED, which was
    // survivable only while the guarantor could repair each session once; lifting
    // that freeze unfreezes every stuck session at once, and a full rebuild costs
    // 40-115 s of IO against a 14 GB GIN-indexed table on a shared Postgres. The
    // backlog drains across passes instead of in one thundering sweep.
    const DEFAULT_MAX_ORPHANS_PER_PASS = 100;
    const maxOrphansRaw = Number(process.env.FORTRESS_GUARANTOR_MAX_ORPHANS_PER_PASS);
    const maxOrphans =
      Number.isFinite(maxOrphansRaw) && maxOrphansRaw > 0
        ? Math.trunc(maxOrphansRaw)
        : DEFAULT_MAX_ORPHANS_PER_PASS;
    // Sessions the COUNT sweep checks per pass. It is the only detector for
    // records lost from the MIDDLE of a canonical — the lane stays seq-dense and
    // byte-covering, so the byte-staleness gate never selects it and nothing
    // else ever re-examines it.
    //
    // Its strength is a LOWER bound, not a proof of wholeness: parseChunk is
    // stateful across the text, so an append-built lane legally holds more turns
    // than parse(whole) yields and that direction is reported, never acted on.
    //
    // It costs one canonical read per session, hence a small per-pass cap and an
    // oldest-verified-first rotation rather than a whole-corpus scan.
    // FORTRESS_GUARANTOR_DEEP_VERIFY_PER_PASS=0 turns it off.
    // Sized so a FIRST full rotation completes in days, not weeks. The corpus
    // is sessions + agent lanes (~14.5k on the reference deployment); at the
    // hourly sweep, 25/pass would take ~24 days to prove everything once, during
    // which "the corpus is whole" would simply be unknown. 100/pass brings that
    // under a week, and the pass yields entirely when live ingest is starved, so
    // the extra reads never come at the live path's expense. `deepVerifyBacklog`
    // in every pass log is how you watch it converge.
    // NOTE the unit: this cap applies to sessions AND, separately, to agent
    // lanes — so a pass reads up to 2x this many canonicals. 100 means ~200
    // object reads per pass, and the rotation is continuous rather than
    // one-shot, so budget that egress (README documents it).
    // Explicit tri-state: unset or blank means the DEFAULT (on), and only a
    // literal false/0 disables. `parseBooleanEnv` returns a boolean and cannot
    // express "unset", which is how an earlier knob silently defaulted to OFF.
    const tailRepairFromEnv = (raw: string | undefined): boolean | undefined => {
      if (raw === undefined || raw.trim() === "") return undefined;
      return !/^(false|0|no|off)$/i.test(raw.trim());
    };
    const DEFAULT_DEEP_VERIFY_PER_PASS = 100;
    // Set-but-EMPTY means the default, never 0. `Number("")` is 0, so the naive
    // read silently disables the only detector for this damage class when a
    // .env template carries a blank line — and every other knob in this codebase
    // treats blank as "use the default" for exactly that reason. Only an
    // explicit 0 turns it off, and that says so in the log.
    const deepVerifyEnv = process.env.FORTRESS_GUARANTOR_DEEP_VERIFY_PER_PASS;
    const deepVerifyRaw =
      deepVerifyEnv === undefined || deepVerifyEnv.trim() === "" ? NaN : Number(deepVerifyEnv);
    const deepVerifyPerPass = Number.isFinite(deepVerifyRaw)
      ? Math.max(0, Math.trunc(deepVerifyRaw))
      : DEFAULT_DEEP_VERIFY_PER_PASS;
    if (deepVerifyPerPass === 0) {
      bus.scopeFor("guarantor").warn(
        "count sweep DISABLED (FORTRESS_GUARANTOR_DEEP_VERIFY_PER_PASS=0) — damage the byte gate cannot see will go undetected",
      );
    }
    const batchDelayRaw = Number(process.env.FORTRESS_GUARANTOR_BATCH_DELAY_MS);
    const batchDelayMs =
      Number.isFinite(batchDelayRaw) && batchDelayRaw >= 0 ? Math.trunc(batchDelayRaw) : undefined;
    guarantor = createGuarantor({
      // The background pool — never the live ingest one.
      db: resolveHxDbBackground,
      store: () => vaultModule.getStore(),
      logger: bus.scopeFor("guarantor"),
      // ON by default (bounded to Claude families, boot-drain only, stands down
      // under live load): restores real titles the write path stranded on a
      // fallback before the tier-A upgrade landed (LETAIR-462). Set
      // FORTRESS_CORRECT_TITLES=false to disable.
      correctExistingTitles:
        process.env.FORTRESS_CORRECT_TITLES == null
          ? true
          : parseBooleanEnv(process.env.FORTRESS_CORRECT_TITLES),
      reconcile: {
        maxOrphans,
        batchDelayMs,
        // ON by default: a half-indexed session is precisely what the guarantor
        // exists to repair. FORTRESS_GUARANTOR_REPAIR_STALE=false leaves the
        // detection (staleIndexes in every pass) but stops it acting.
        repairStaleIndexes: repairStaleFromEnv(process.env.FORTRESS_GUARANTOR_REPAIR_STALE),
        deepVerifyPerPass,
        // FORTRESS_GUARANTOR_TAIL_REPAIR=false disables the incremental tail
        // path, leaving repairs to the (slower, always-correct) full rebuild.
        // The counter that tells you to reach for this is `verifyFallbacks`.
        repairTails: tailRepairFromEnv(process.env.FORTRESS_GUARANTOR_TAIL_REPAIR),
        // Yield to live ingest. Repair has no caller waiting on it, so when the
        // live pool is starved the guarantor stands down for the pass instead of
        // adding its own load to a database already short of connections.
        isSaturated: () => guardedDb?.saturated() ?? false,
      },
    });
    guarantor.start();
    // A known best-effort-mirror failure (PG down / index threw after the
    // canonical was stored) nudges the guarantor to re-index the orphan soon,
    // rather than waiting for the next hourly sweep.
    setReconcileSignalHandler(() => guarantor?.signal());
    // First probe success after a pool rebuild: the outage that forced the
    // rebuild almost certainly stranded row-less canonicals — sweep in
    // ~debounce, ignoring the (remote-pressure) cooldown. Internal-only seam.
    dbHealth.onRecovered = () => guarantor?.signalUrgent();
  } else {
    bus.scopeFor("guarantor").warn("guarantor disabled (FORTRESS_GUARANTOR_DISABLED)");
  }

  // Republished every 10s, and once immediately: an ABSENT metrics.json means
  // "no daemon", so the file has to exist as soon as one does rather than a
  // tick later.
  const metricsPublisher = startMetricsPublisher({
    registry: metrics,
    filePath: paths.metrics,
    onError: (err) =>
      bus.scopeFor("fortress").warn("could not publish metrics", {
        error: err instanceof Error ? err.message : String(err),
      }),
  });
  void metricsPublisher.flush();

  // Refreshes the cached pause deadline on the status-heartbeat cadence. A
  // FAILED read keeps the last known deadline: losing Postgres must never
  // REOPEN the gate under a migration that armed the pause and then lost its
  // database.
  const consoleLog = bus.scopeFor("console");
  // The daemon's spool writer. Its general records are gated on the EFFECTIVE
  // enablement predicate, read live so `ui enable` lands without a restart;
  // command transitions ignore that gate entirely, because a command row
  // existing already implies a console and a rotation performed while the
  // console was down must still be corroborable when it comes back.
  const uiConfigReader = new LiveUiConfig(paths.uiConfig);
  const daemonAudit = new DaemonAudit({
    dir: paths.auditSpool,
    consoleEnabled: async () => effectiveUiEnabled(await uiConfigReader.read(), process.env),
    onError: (error) =>
      consoleLog.warn("an audit record could not be spooled", {
        error: error instanceof Error ? error.message : String(error),
      }),
  });

  const parkLatch = new ParkReplayLatch();
  // The WHOLE replay is the thing a migration has to wait out, not just the
  // drain inside it. `awaitParkDrain` covers `drainOnce` only, and the pending
  // append happens after that promise resolves — so a preamble that waited on
  // the drain still read the pending file before the drain's keys were in it,
  // and the refusal that makes this recoverable never fired.
  let replayInFlight: Promise<void> | null = null;
  const replayParked = (): Promise<void> => {
    replayInFlight ??= replayParkedOnce().finally(() => {
      replayInFlight = null;
    });
    return replayInFlight;
  };
  // A replay that threw AFTER rewriting sidecars is the case the preamble's
  // refusal exists for: the pending append is what would have told the run to
  // re-carry them, and if that is what failed the file says nothing. Swallowing
  // it lets the run start and cut over stale sidecars.
  //
  // State-derived, not a memory flag. A flag is cleared by any later replay that
  // merely RETURNS — including the two early returns and a no-op drain of an
  // empty park — which is precisely what happens after the failure: the entries
  // were already unlinked, so the next drain finds nothing, succeeds, and
  // withdraws the refusal. It also does not survive the restart that an ENOSPC
  // or EIO makes likely. So the marker is a file, written before the sidecars
  // are rewritten and removed only once the pending set is on disk.
  // `.d`, because `replay-incomplete` was a FILE in the previous build and this
  // is now a directory. An upgraded host that carried an outstanding marker would
  // otherwise hit ENOTDIR on the readdir — swallowed, so the refusal silently
  // lifts — and EEXIST on the mkdir, which re-parks every entry forever. A new
  // name cannot collide with either.
  const replayMarkerDir = path.join(paths.runtimeRoot, "replay-incomplete.d");
  const legacyReplayMarker = path.join(paths.runtimeRoot, "replay-incomplete");
  const awaitReplay = async (): Promise<void> => {
    await replayInFlight?.catch(() => {});
    // A DIRECTORY, one file per unfinished drain. A single file is overwritten by
    // the next drain's own marker, so its read-back matches and the unlink
    // succeeds — withdrawing an outstanding refusal that drain never earned.
    const outstanding = await readdir(replayMarkerDir).catch((err: NodeJS.ErrnoException) =>
      // ENOENT is the only "none". Anything else means the path exists and could
      // not be read, which is an outstanding marker we cannot count — refuse.
      err?.code === "ENOENT" ? ([] as string[]) : (["unreadable"] as string[]),
    );
    // A marker left by the previous build, before this became a directory.
    const legacy = await readdir(paths.runtimeRoot)
      .then((names) => names.includes("replay-incomplete"))
      .catch(() => false);
    if (outstanding.length > 0 || legacy) {
      throw new Error(
        `${outstanding.length + (legacy ? 1 : 0)} parked-artifact replay(s) rewrote session sidecars but could not record ` +
          "which sessions, so a migration resumed under the same id could skip them and cut over stale " +
          "ones. Nothing clears this on its own — the entries those drains consumed are already gone, so " +
          "a later replay has nothing to redo. Re-copy the affected sessions with a fresh migration run " +
          `(a new run id re-carries everything), then remove ${replayMarkerDir} (and ${legacyReplayMarker} ` +
          "if a previous build left one) to allow it.",
      );
    }
  };
  const replayParkedOnce = async (): Promise<void> => {
    const store = vaultModule.getStore();
    if (!store) return;
    // NOT while a storage migration is between its copy and its cut.
    //
    // A replay writes a sidecar without appending a canonical, and the delta
    // pass decides what to re-carry by comparing canonical LENGTH — so a sidecar
    // rewritten into the source mid-run is a change no later pass can see, and
    // the new bucket keeps the stale one. Clearing the copy record does not help:
    // `deltaPass` selects from `targetIsCurrent` alone and never reads that
    // table, so the record only matters to a run RESUMED under the same id.
    //
    // Holding the entries costs nothing — they are already durable, and the park
    // exists precisely because writes were refused. Once the run ends the bound
    // store is whichever bucket is now live, so the replay lands in the right
    // one either way: the target after a cut, the source after an abort.
    if (migrationIsRunning()) return;
    // Raised by the FIRST sidecar write of this drain, and carrying a token only
    // this invocation knows.
    //
    // Raising it unconditionally up here repeats the defect it was written to
    // fix: an empty park raises a marker, writes nothing, and clears it — so the
    // 5s retry after a failed drain (the park is already unlinked, so that retry
    // finds nothing) withdraws a refusal it never earned, within one tick. The
    // token is what makes the clear belong to its owner; a later drain that
    // raised no marker of its own must never remove one.
    //
    // And it is NOT best-effort. If the marker cannot be written, the sidecars
    // must not be rewritten either, because the refusal is the only thing
    // standing between an unrecorded rewrite and a migration cutting over it.
    const token = randomUUID();
    const markerPath = path.join(replayMarkerDir, token);
    let raised = false;
    const result = await drainParkedArtifacts(parkedArtifactsPath, async (entry) => {
      if (!raised) {
        await mkdir(replayMarkerDir, { recursive: true, mode: 0o700 });
        // `wx`: never clobber another drain's outstanding marker.
        await writeFile(markerPath, "", { mode: 0o600, flag: "wx" });
        raised = true;
      }
      // NOT INTO A DELETED SESSION. A sidecar can sit parked for hours — the
      // drain waits out both the pause and any migration — and writes are open
      // for most of that window, so a member can permanently delete the session
      // in between. Replaying it then RE-CREATES `session.json` in the bucket,
      // and that object is what both backends scan to build the direct-connect
      // client's session list: the deleted session reappears, titled, with no
      // further delete to remove it. Every other writer here already consults
      // the tombstone; this one did not.
      //
      // A database we cannot ask is not a licence to write: the entry is thrown
      // back to the park, which is durable, and the next drain is five seconds
      // away.
      const tombstoneDb = postgres.isReady() ? resolveHxDb() : null;
      if (!tombstoneDb) {
        throw new Error("cannot check the tombstone for a parked artifact — re-parking it");
      }
      if (await isSessionDeleted(tombstoneDb, entry.key.userId, entry.key.sessionId)) {
        consoleLog.info("dropping a parked artifact for a permanently deleted session", {
          sessionId: entry.key.sessionId,
          name: entry.name,
        });
        // NOT replayed. Reporting it as one put a write that never happened into
        // the daemon's audit record, and fed a session that no longer exists
        // into the copy-record sweep.
        return false;
      }
      // MERGED, not overwritten. The parked text is a whole composition made
      // from the sidecar as it stood before the pause, and reads stay open
      // through a pause — so every commit in one episode composed from the same
      // pre-pause text and a verbatim replay let the last one erase the rest.
      // Only the session sidecar has that shape; anything else is replayed as
      // parked.
      if (entry.name !== SESSION_METADATA_ARTIFACT) {
        await store.writeArtifact(entry.key, entry.name, entry.text);
        return;
      }
      const incoming = parseSessionMetadata(JSON.parse(entry.text) as unknown);
      if (!incoming) {
        await store.writeArtifact(entry.key, entry.name, entry.text);
        return;
      }
      // The PARSE is guarded too, not only the read. A torn `session.json` in
      // the bucket made this throw out of the callback, so the entry was
      // re-parked and retried every five seconds forever — the guard read as
      // covering it and covered only the fetch.
      const current = await store
        .readArtifactText(entry.key, entry.name)
        .then((raw) => parseSessionMetadata(JSON.parse(raw ?? "null") as unknown))
        .catch(() => null);
      await store.writeArtifact(
        entry.key,
        entry.name,
        JSON.stringify(mergeReplayedMetadata(current, incoming, entry.replace === true)),
      );
    });
    // The pending append FIRST, and the latch settled only after it. The append
    // is what tells a resumed run to re-carry these sessions; settling first
    // meant a throw here left `owed` already false, so nothing retried and the
    // record of what was rewritten existed nowhere.
    // A run that is RESUMED under the same id re-copies from its own record
    // (`copyMissing(plan)`), so for that one path the record has to go — a
    // sidecar replayed after the abort would otherwise be skipped on resume.
    // Durable, because the park is already gone by the time this runs: if the
    // DELETE fails the list of rewritten sessions exists nowhere else, and a
    // resumed run would cut over stale sidecars with only a log line to say so.
    // Pending keys are written before the attempt and cleared only on success,
    // so a failure is retried on the next replay rather than lost.
    const pending = await addForgetPending(forgetPendingPath, result.rewrote);
    // Ours alone, by name.
    if (raised) await unlink(markerPath).catch(() => {});
    parkLatch.settle(result.failed);
    if (pending.length > 0) {
      const replayDb = postgres.isReady() ? resolveHxDb() : null;
      if (replayDb) {
        const cleared = await forgetCopiedSessions(replayDb, pending)
          .then(() => true)
          .catch((err: unknown) => {
            consoleLog.warn("could not clear the copy records for replayed sidecars — will retry", {
              entries: pending.length,
              error: err instanceof Error ? err.message : String(err),
            });
            return false;
          });
        // Only what this attempt actually deleted — a concurrent drain may have
        // appended more since the snapshot, and those have not been cleared.
        if (cleared) await removeForgetPending(forgetPendingPath, pending);
      }
    }
    if (result.replayed > 0 || result.failed > 0 || result.dropped > 0) {
      consoleLog.info("replayed parked artifact writes", {
        replayed: result.replayed,
        failed: result.failed,
        dropped: result.dropped,
      });
      await daemonAudit.record("system.artifact_replay", {
        // `count` is what was WRITTEN. A sidecar dropped because its session has
        // since been permanently deleted is reported separately — the audit
        // trail is a compliance surface, and it must not claim a write that did
        // not happen.
        params: { engine: "artifact replay", count: result.replayed, dropped: result.dropped },
      });
    }
  };

  const refreshPause = async (): Promise<void> => {
    const db = resolveHxDb();
    if (!db || !postgres.isReady()) return;
    let row;
    try {
      row = await readCurrentEpisode(db);
    } catch {
      pauseState.observeUnavailable();
      return;
    }
    const now = new Date();
    let firstObservedAt: Date | null = null;
    if (row && row.resumedAt === null) {
      // Keyed by EPISODE. An anchor kept merely because a file was there let an
      // expired-but-unresumed episode hand its own exhausted bound to the next
      // one, which made that pause expired the moment it was armed — the barrier
      // a storage-migration swap waits on would then be a no-op nobody could see.
      firstObservedAt = new Date(
        (await stampPauseAnchor(paths.pauseAnchor, row.id, now)).firstObservedAt,
      );
    } else {
      // Cleared on resume, so a later episode can never anchor to an earlier one.
      await clearPauseAnchor(paths.pauseAnchor);
    }
    const pause = effectivePause({ row, firstObservedAt, now });
    pauseState.observe(pause);
    if (pause.capped) {
      consoleLog.warn("ingest pause deadline exceeds the cap and was clamped", {
        requested: row?.pausedUntil.toISOString() ?? null,
        effective: pause.pausedUntil?.toISOString() ?? null,
      });
    }
    // Writes are open — replay everything the gate refused while they were not.
    //
    // Driven by the LATCH rather than by a paused→open edge. The edge could only
    // ever be seen when a pause ended by an explicit resume: a pause that lapses
    // on its own deadline is ALREADY open by the time this line runs, because the
    // cached state answers against the clock — so the edge test read false at
    // exactly the expiry it existed to catch, and every natural expiry, failed
    // resume and restart left the park stranded with no operator surface that
    // would ever mention it. Commits are acknowledged BEFORE their
    // sidecar is written, so what is parked is metadata the fortress already
    // promised a device it had, with no other surface that would ever mention it
    // again.
    if (parkLatch.due(pauseState.isPaused(now))) await replayParked();
  };

  const pauseTimer = setInterval(() => void refreshPause(), 5_000);
  (pauseTimer as { unref?: () => void }).unref?.();

  // The two questions only the hub can answer, and the one transport there is to
  // ask them over. A connection that cannot ask (no tunnel, a test double) leaves
  // `askHub` undefined, and both callers below degrade to "unavailable" — which
  // the console renders as NOT CHECKED, never as a clean answer.
  const askHub = connection.request?.bind(connection);
  const postureCache = new RoutingPostureCache(routingPosturePath(paths.runtimeRoot));
  const askWitness = createWitnessClient({
    request: askHub,
    onUnavailable: (reason) =>
      consoleLog.info("the residency audit could not ask let.ai about this run", { reason }),
  });
  const refreshPosture = async (): Promise<void> => {
    if (!askHub) return;
    try {
      const result = await askHub({ kind: "routingPosture" });
      const data = result.kind === "routingPosture" ? result.routingPosture : undefined;
      if (!data) {
        await postureCache.recordUnavailable("the hub answered without a routing posture");
        return;
      }
      await postureCache.write({ fetchedAt: new Date().toISOString(), data });
    } catch (err) {
      // Recorded WITH its timestamp rather than left alone: a snapshot that stops
      // being refreshed would otherwise keep reading as current forever.
      await postureCache
        .recordUnavailable(err instanceof Error ? err.message : String(err))
        .catch(() => {});
    }
  };
  const postureTimer = setInterval(() => void refreshPosture(), POSTURE_REFRESH_MS);
  (postureTimer as { unref?: () => void }).unref?.();

  /** Boot order: role provisioning (inside postgres.start) → FENCE → any poll.
   *  Fence-first is unachievable under the embedded apparatus — ensureAppRoles
   *  is what CREATES hx.reject_command, and Postgres resolves the function at
   *  parse time, so the statement errors even against zero rows. */
  /** Rows the boot fence found still ours; only these may be re-claimed. */
  /** One-shot permission to re-claim the rows this daemon was running when it
   *  died. Spent by the poll on use — see RedriveTickets. */
  let redriveIds = new Set<string>();
  /** pid + a boot-unique id. Observability only — never a security predicate. */
  const liveUiConfig = new LiveUiConfig(paths.uiConfig);
  const claimedBy = `${process.pid}:${randomUUID()}`;
  /** Set by the update executor once a new binary is in place; acted on only
   *  after the poll pass that wrote the outcome record has returned. */
  let restartAfterUpdate = false;
  const commandExecutors = createCommandExecutors({
    logger: consoleLog,
    store: () => vaultModule.getStore(),
    cmdCredsDir: paths.cmdCreds,
    env: process.env,
    db: () => (postgres.isReady() ? resolveHxDb() : null),
    // The ONLY way a rotation reaches the running daemon. A module restart
    // would answer tunnel RPCs with an error the cloud does not classify as
    // retryable while it was down.
    rebindStore: () => vaultModule.rebindStore(),
    setCloudCredential: async (credential) => {
      const current = await credentialStore.load();
      if (!current) throw new Error("this fortress is not enrolled, so it holds no cloud credential");
      const updated = { ...current, credential };
      await credentialStore.save(updated);
      registry.setFortressIdentity(updated);
      return updated;
    },
    status: () => new FileStatusReader(paths.status).read().catch(() => null),
    embeddingEndpoint: () => (embedConfig.enabled ? embedConfig.baseUrl : null),
    runAudit: () =>
      runAuditForFortress({
        db: () => (postgres.isReady() ? resolveHxDb() : null),
        store: () => vaultModule.getStore(),
        // The same enrolled org the gateway checks a capability token's `aud`
        // against — the run's universe, and the bound on which ids may be named
        // to let.ai.
        ownOrgId: () => credentialStore.load().then((c) => c?.orgId ?? null).catch(() => null),
        // The fortress asks and the hub answers. A timeout, a dead socket or a
        // hub too old to know the frame all come back as no answer at all, which
        // the run reports as an unasked witness by name.
        askWitness,
        postureFresh: async () =>
          postureFreshness(await postureCache.read(), Date.now()) === "fresh",
        publish: (acks) =>
          publishAcks(
            paths.runtimeRoot,
            acks.map((ack) => ({
              org: ack.org,
              sessionId: ack.sessionId,
              acknowledgedAt: ack.acknowledgedAt,
              acknowledgedBy: ack.acknowledgedBy,
              reason: ack.reason,
            })),
          ),
      }),
    runMigration: async ({ command, target, credentialRef }) => {
      // Taken SYNCHRONOUSLY, before the first await below: `migrationInFlight`
      // is only set once the runner is entered, so without this the preamble
      // itself — a drain await and a sequential-scan DELETE — runs in a window
      // where the replay's guard still reads false and a 5s tick can start a
      // fresh drain into the bucket this run is about to walk.
      const release = holdMigration();
      try {
      // Settle both hazards before the run reads its copy records.
      //
      // A drain already under way writes sidecars into the store this run is
      // about to walk, and the `migrationIsRunning()` guard on the replay is a
      // check rather than a lock — it cannot stop one that started first. So
      // wait for it. Then apply any pending record-clearing, because the run
      // loads `alreadyCopied()` ONCE at its start: a delete that lands after
      // that reaches nothing. If it cannot be applied the run does not start —
      // cutting over an unknown set of stale sidecars is the failure this whole
      // mechanism exists to prevent, and a refusal is recoverable.
      await awaitReplay();
      const stale = await readForgetPending(forgetPendingPath);
      if (stale.length > 0) {
        const db = postgres.isReady() ? resolveHxDb() : null;
        if (!db) throw new Error("sidecar copy records are pending a clear and the database is not reachable");
        await forgetCopiedSessions(db, stale);
        await removeForgetPending(forgetPendingPath, stale);
      }
      return await runMigrationCommand(
        {
          db: () => (postgres.isReady() ? resolveHxDb() : null),
          store: () => vaultModule.getStore(),
          // The DIRECT backend for the candidate: the migration is the only
          // thing writing this bucket, and a guarded store would escalate a
          // wedge by exiting the daemon over a bucket nothing serves from yet.
          buildTarget: (credentials) => buildDirectStore(credentials),
          quiesce,
          // The gate the swap proves itself against is the one that refuses
          // writes — this cached state, and the refresh that fills it — never
          // the deadline the run asked the database for.
          gate: () => ({ pausedUntil: pauseState.pausedUntil(), capped: pauseState.capped }),
          refreshGate: refreshPause,
          setDrain: (on) => {
            drainArmed = on;
          },
          // The ONLY way the swapped credentials reach the running daemon, and
          // the same factory init() uses: a bare backend here would serve every
          // later write with no pause gate, no deadline and no rebuild policy.
          rebindStore: () => vaultModule.rebindStore(),
          targetCredentials: () =>
            credentialRef
              ? consumeCredentialRef<VaultCredentials>(paths.cmdCreds, credentialRef)
              : Promise.resolve(null),
          env: process.env,
          logger: consoleLog,
        },
        { command, target },
      );
      } finally {
        release();
      }
    },
    setCloudWitness: (enabled) => applyCloudWitness(enabled),
    acknowledgeFinding: async ({ org, sessionId, reason }) => {
      const db = postgres.isReady() ? resolveHxDb() : null;
      if (!db) throw new Error("the fortress database is not available");
      // Through the fenced routine, never a direct INSERT: an acknowledgement is
      // not re-derivable, and one INSERT ... SELECT would acknowledge every
      // residency finding this organization has, permanently.
      // Same plane split as `applyCloudWitness`: the fenced routine does not
      // exist on an external database, where the fence would be guarding the
      // operator against themselves anyway. The fence's own rule — only an
      // existing `also_at_letai` finding may be acknowledged — is kept.
      if (await commandPlaneIsInstalled()) {
        await db.execute(
          sqlTag`SELECT hx.acknowledge_finding(${org}, ${sessionId}, ${"console operator"}, ${reason})`,
        );
      } else {
        // RETURNING, so the fence's REFUSAL survives too. The DML keeps the
        // routine's rule — only an existing `also_at_letai` may be acknowledged
        // — but a WHERE that matches nothing is a silent no-op, and the command
        // would have completed `done` reporting "acknowledged; later runs
        // inherit it". On a compliance surface that is worse than the refusal it
        // replaced.
        const acked = await db.execute(
          sqlTag`INSERT INTO hx.audit_acks (org, session_id, acknowledged_by, reason)
                 SELECT ${org}, ${sessionId}, ${"console operator"}, ${reason}
                  WHERE EXISTS (SELECT 1 FROM hx.audit_findings f
                                 WHERE f.org = ${org} AND f.session_id = ${sessionId}
                                   AND f.verdict = 'also_at_letai')
                     ON CONFLICT (org, session_id)
                     DO UPDATE SET acknowledged_at = now(), acknowledged_by = EXCLUDED.acknowledged_by, reason = EXCLUDED.reason
                  RETURNING org`,
        );
        if (rowCountOf(acked) === 0) {
          throw new Error(`no acknowledgeable finding for ${org} / ${sessionId}`);
        }
      }
      await publishAcksFromDb();
    },
    downloadBaseUrl: async () => {
      const loaded = await new FileConfigStore(paths).load().catch(() => null);
      if (!loaded?.cloud.url) return null;
      try {
        return downloadBaseFromCloudUrl(loaded.cloud.url);
      } catch {
        return null;
      }
    },
    service: getServiceManager(),
    onBinarySwapped: () => {
      restartAfterUpdate = true;
    },
  });

  /**
   * One poll pass over the command queue, SINGLE-FLIGHT.
   *
   * The daemon is the only executor: the console can ask, and the write role
   * cannot even ask. A pass that finds nothing costs one indexed SELECT.
   *
   * The timer fires once a second and a pass runs for as long as the work takes
   * — an update download, a full residency audit, a bucket copy. Without the
   * latch those overlap: the same claimable row is picked up by every tick that
   * lands while the first executor is still running, so one row becomes N
   * concurrent executions of the same side effect.
   */
  let pollInFlight: Promise<void> | null = null;
  function pollConsolePlane(): Promise<void> {
    pollInFlight ??= drivePollPass().finally(() => {
      pollInFlight = null;
    });
    return pollInFlight;
  }

  /** Whether the five SECURITY DEFINER routines exist to be called.
   *
   *  `ensureAppRoles` creates them, and it is wired only into the embedded
   *  Postgres path — there is no role split on an operator's own database. The
   *  gateway called them regardless, so on an external DSN every claim raised
   *  42883, every poll pass swallowed it, and a command minted from the console
   *  sat at `requested` until its deadline while the daemon reported healthy.
   *  Read once and cached: pg.json does not change under a running daemon.
   *
   *  A FAILED READ IS NOT AN ANSWER, and it is not cached. `?.mode !== "external"`
   *  reads `undefined !== "external"` as true, so a momentarily unreadable
   *  pg.json on an external-DSN fortress used to pin "installed" for the process
   *  lifetime: every `hx.claim_command` then raised 42883, the poll pass
   *  swallowed it, and commands sat at `requested` until their deadline — the
   *  exact silent failure this predicate was written to remove. Unknown means
   *  unavailable for this pass, and the next pass asks again. */
  /** How many rows a statement returned, across both shapes the driver hands
   *  back (a bare array, or `{ rows }`). Used where a RETURNING clause is the
   *  only thing that distinguishes a refusal from a silent no-op. */
  const rowCountOf = (result: unknown): number => {
    if (Array.isArray(result)) return result.length;
    const wrapped = (result as { rows?: unknown[] } | null)?.rows;
    return Array.isArray(wrapped) ? wrapped.length : 0;
  };

  let commandPlaneInstalledCache: boolean | null = null;
  async function commandPlaneIsInstalled(): Promise<boolean> {
    if (commandPlaneInstalledCache !== null) return commandPlaneInstalledCache;
    const pg = await readPgJson(paths.pgJson).catch(() => null);
    if (pg === null) return false;
    commandPlaneInstalledCache = pg.mode !== "external";
    return commandPlaneInstalledCache;
  }

  async function drivePollPass(): Promise<void> {
    const db = resolveHxDb();
    if (!db || !postgres.isReady()) return;
    try {
      await pollCommands(
        {
          gateway: (await commandPlaneIsInstalled())
            ? createCommandGateway(db)
            : createUnavailableCommandGateway(),
          inFlightPath: paths.commandsInFlight,
          claimedBy,
          logger: consoleLog,
          onTransition: daemonAudit.onTransition,
          executors: commandExecutors,
        },
        redriveIds,
      );
    } catch (err) {
      consoleLog.error("console command poll failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!restartAfterUpdate) return;
    restartAfterUpdate = false;
    // AFTER the outcome record reached disk. The console unit goes first
    // because the daemon's own restart ends this process.
    try {
      // Installed AND still enabled. `installed()` reports the unit FILE, and
      // `ui disable` stops the unit without removing it — so restarting on
      // `installed()` alone brought a console the operator had deliberately
      // switched off back onto the network, from an update they may have
      // triggered from that very console.
      if (await getUiServiceControl().installed()) {
        const cfg = await uiConfigReader.read().catch(() => null);
        if (cfg && effectiveUiEnabled(cfg, process.env)) restartUiUnitDetached({});
      }
      await getServiceManager().restart();
    } catch (err) {
      consoleLog.error("the fortress could not restart onto the new binary", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Flip the egress toggle through the fenced routine, then republish it for
   *  `hx-fortress audit witness show` — which has no database credential and
   *  must not be given one. */
  async function applyCloudWitness(enabled: boolean): Promise<void> {
    const db = postgres.isReady() ? resolveHxDb() : null;
    if (!db) throw new Error("the fortress database is not available");
    // THE ROUTINE ONLY EXISTS ON THE EMBEDDED PLANE. `ensureAppRoles` creates
    // the five SECURITY DEFINER routines and is wired into the embedded branch
    // alone, so on an operator's own Postgres this raised 42883 — and 0022 seeds
    // the witness ON, so an external-DSN fortress came up with outbound
    // session-id disclosure enabled and NO WAY TO TURN IT OFF. There is no role
    // split on an external database (the operator's single DSN owns the tables),
    // so the fence buys nothing there and plain DML is the honest equivalent.
    if (await commandPlaneIsInstalled()) {
      await db.execute(sqlTag`SELECT hx.set_cloud_witness(${enabled})`);
    } else {
      await db.execute(
        sqlTag`UPDATE hx.audit_settings SET cloud_witness = ${enabled}, changed_at = now(), changed_by = session_user`,
      );
      await db.execute(
        sqlTag`INSERT INTO hx.audit_settings (cloud_witness, changed_at, changed_by)
               SELECT ${enabled}, now(), session_user
                WHERE NOT EXISTS (SELECT 1 FROM hx.audit_settings)`,
      );
    }
    await publishAuditSettings(paths.runtimeRoot, enabled);
  }

  async function publishAcksFromDb(): Promise<void> {
    const db = postgres.isReady() ? resolveHxDb() : null;
    if (!db) return;
    const acks = await readAcknowledgements(db).catch(() => []);
    await publishAcks(paths.runtimeRoot, acks);
  }

  /**
   * The terminal's half of `audit witness on|off`, and of the corrective
   * re-confirmation pass.
   *
   * The CLI writes its intent and signals; the daemon is what holds the database
   * and what executes the fenced routine. That split is what keeps hx_ui the
   * console process alone rather than every shell on this host.
   */
  async function applyWitnessIntent(): Promise<void> {
    const intent = await readWitnessIntent(paths.runtimeRoot).catch(() => null);
    if (!intent) return;
    try {
      await daemonAudit.run(
        "system.audit_witness",
        { engine: "audit witness", kind: intent.enabled === undefined ? "reconfirm" : intent.enabled ? "on" : "off" },
        async () => {
          // Only when the writer meant to change it. An omitted `enabled` is a
          // reconcile that carries acknowledgements and nothing else.
          if (intent.enabled !== undefined) await applyCloudWitness(intent.enabled);
          for (const row of intent.reconfirm ?? []) {
            const db = postgres.isReady() ? resolveHxDb() : null;
            // THROW, never break. Breaking fell through to the success return,
            // so a database lost midway recorded the run as done and the intent
            // file was destroyed — half-applying the one rung that exists
            // because acknowledgements went missing, with no error and no way to
            // re-run it.
            if (!db) throw new Error("the fortress database went away mid-reconfirm");
            // Same plane split as the console's own acknowledgement path.
            if (await commandPlaneIsInstalled()) {
              await db.execute(
                sqlTag`SELECT hx.acknowledge_finding(${row.org}, ${row.sessionId}, ${"terminal operator"}, ${row.reason})`,
              );
            } else {
              const acked = await db.execute(
                sqlTag`INSERT INTO hx.audit_acks (org, session_id, acknowledged_by, reason)
                       SELECT ${row.org}, ${row.sessionId}, ${"terminal operator"}, ${row.reason}
                        WHERE EXISTS (SELECT 1 FROM hx.audit_findings f
                                       WHERE f.org = ${row.org} AND f.session_id = ${row.sessionId}
                                         AND f.verdict = 'also_at_letai')
                           ON CONFLICT (org, session_id)
                           DO UPDATE SET acknowledged_at = now(), acknowledged_by = EXCLUDED.acknowledged_by, reason = EXCLUDED.reason
                        RETURNING org`,
              );
              if (rowCountOf(acked) === 0) {
                throw new Error(`no acknowledgeable finding for ${row.org} / ${row.sessionId}`);
              }
            }
          }
          await publishAcksFromDb();
          return { enabled: intent.enabled };
        },
      );
    } catch (err) {
      consoleLog.error("could not apply the audit witness intent", {
        error: err instanceof Error ? err.message : String(err),
      });
      // The intent is CLEARED even on failure. Leaving it made the failure
      // sticky in the worst way: `audit witness show` reads the published
      // mirror, which is only rewritten on success, so an operator who asked to
      // turn the witness OFF and could not kept being told it was still on,
      // every poll, with no way to retry into a different answer. A failed
      // intent is a failed intent; the error above is the record of it.
      await clearWitnessIntent(paths.runtimeRoot).catch(() => {});
      return;
    }
    await clearWitnessIntent(paths.runtimeRoot).catch(() => {});
  }

  /**
   * Roster retention.
   *
   * Departed members are kept for a configurable window and then removed — the
   * one place in this system where people-data ages out on its own. It reads the
   * retention from config.json at every sweep rather than caching it at boot, so
   * shortening it takes effect on the next pass instead of the next restart.
   */
  async function sweepRoster(requestedDays: number | null = null): Promise<void> {
    const db = postgres.isReady() ? resolveHxDb() : null;
    if (!db) return;
    const configured = rosterInactivePurgeDays(
      await new FileConfigStore(paths).load().catch(() => null),
    );
    const days = requestedDays ?? configured;
    try {
      await daemonAudit.run(
        "system.roster_purge",
        { engine: "roster retention", kind: `${days}d` },
        async () => {
          const removed = await purgeInactiveRoster(db, days);
          await publishRosterPurge(paths.runtimeRoot, {
            at: new Date().toISOString(),
            removed,
            days,
          });
          if (removed > 0) {
            consoleLog.info("purged departed roster members", { removed, days });
          }
          return { removed, days };
        },
      );
    } catch (err) {
      consoleLog.error("the roster retention sweep failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** The terminal's half of `roster purge-inactive`: it writes the intent and
   *  signals, because it holds no database credential and must not. */
  async function applyRosterPurgeIntent(): Promise<void> {
    const intent = await readRosterPurgeIntent(paths.runtimeRoot).catch(() => null);
    if (!intent) return;
    await sweepRoster(intent.days);
    await clearRosterPurgeIntent(paths.runtimeRoot).catch(() => {});
  }

  // One signal, every pending intent: the terminal writes a file and nudges, and
  // the daemon applies whichever files are there when it wakes.
  process.on("SIGUSR2", () => {
    void applyWitnessIntent();
    void applyRosterPurgeIntent();
  });

  const rosterTimer = setInterval(() => {
    void sweepRoster();
    void sweepAuditHistory();
  }, 24 * 60 * 60_000);
  (rosterTimer as { unref?: () => void }).unref?.();

  const commandTimer = setInterval(() => void pollConsolePlane(), 1_000);
  (commandTimer as { unref?: () => void }).unref?.();

  /** Residency runs and their findings age out at AUDIT_RETENTION_DAYS. Driven
   *  from the same daily pass as the roster's retention, because a retention
   *  nothing calls is a number in a constant, not a policy — hx.audit_runs grew
   *  for the life of the database. Acknowledgements are NOT swept: a run is
   *  re-derivable by running the audit again, and an acknowledgement is a fact
   *  about an operator's decision nothing else records. */
  async function sweepAuditHistory(): Promise<void> {
    const db = postgres.isReady() ? resolveHxDb() : null;
    if (!db) return;
    try {
      const removed = await sweepAuditRuns(db);
      if (removed > 0) consoleLog.info("swept expired residency audit runs", { removed });
    } catch (err) {
      consoleLog.error("the audit retention sweep failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function bootConsolePlane(): Promise<void> {
    await refreshPause();
    await sweepAuditHistory();
    // A restart is the one way out of a pause that leaves nothing to observe an
    // edge on: the park survives the process, the pause row does not have to.
    // Idempotent, and a no-op on the overwhelming majority of boots where the
    // park file does not exist at all.
    if (parkLatch.due(pauseState.isPaused())) await replayParked();
    // A fortress that is off for a month must not wait another day for the
    // retention it already owes.
    await sweepRoster();
    // Orphaned credential files are secrets on disk for commands that will
    // never run; sweep them as soon as the daemon is up, not only on a timer.
    const swept = await sweepCmdCreds(paths.cmdCreds).catch(() => ({ deleted: [] }));
    if (swept.deleted.length > 0) {
      consoleLog.info("swept expired command credentials", { count: swept.deleted.length });
    }
    const db = resolveHxDb();
    if (!db || !postgres.isReady()) return;
    try {
      await daemonAudit.run("system.command_fence", { engine: "command fence" }, async () => {
        const fence = await runBootFence({
          gateway: (await commandPlaneIsInstalled())
            ? createCommandGateway(db)
            : createUnavailableCommandGateway(),
          inFlightPath: paths.commandsInFlight,
          claimedBy,
          logger: consoleLog,
          onTransition: daemonAudit.onTransition,
        });
        redriveIds = new Set(fence.redriven);
        return fence;
      });
    } catch (err) {
      consoleLog.error("console command boot fence failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    await (dependencies.run ?? runHost)(runtime);
  } finally {
    clearInterval(pauseTimer);
    clearInterval(postureTimer);
    clearInterval(rosterTimer);
    clearInterval(commandTimer);
    metricsPublisher.stop();
    gatewayHandle?.stop();
    setEmbedSignalHandler(() => {});
    setReconcileSignalHandler(() => {});
    await embedWorker?.stop();
    await guarantor?.stop();
    await poolOccupancyLog.stop();
    await guardedDb?.stop();
  }
}
