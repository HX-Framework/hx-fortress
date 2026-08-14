import type {
  FortressQueryPayload,
  FortressQueryResultPayload,
  MsgData,
  MsgReply,
} from "../protocol";

export interface MessageDispatcher {
  dispatch(data: MsgData): Promise<MsgReply | undefined>;
}

export interface FortressPostgresConfig {
  version?: string;
  binariesUrl?: string;
  dataDir?: string;
  port?: number;
  externalUrl?: string;
  /** Override the download base for the per-platform pgvector artifact. */
  pgvectorUrl?: string;
}

export interface FortressRosterConfig {
  /** How long a departed member's roster row is kept before the daily sweep
   *  removes it. The workbench tells members the same number. */
  inactivePurgeDays: number;
}

export interface FortressConfig {
  schemaVersion: 1;
  cloud: {
    url: string;
  };
  gateway: {
    publicUrl: string;
  };
  modules: {
    enabled: string[];
  };
  postgres?: FortressPostgresConfig;
  roster?: FortressRosterConfig;
}

export interface ConfigStore {
  load(): Promise<FortressConfig>;
}

export type ConnectionState = "offline" | "connecting" | "connected" | "closing";

export interface ConnectionStatusSnapshot {
  state: ConnectionState;
  reason: string | null;
  message: string | null;
}

export type ModuleState = "stopped" | "starting" | "running" | "stopping" | "failed";

export interface ModuleRuntimeStatus {
  id: string;
  state: ModuleState;
  error: string | null;
}

export type HostState = "stopped" | "starting" | "running" | "draining" | "failed";

export interface HostStatusSnapshot {
  schemaVersion: 1;
  host: {
    state: HostState;
    pid: number;
    startedAt: string | null;
    updatedAt: string;
    error: string | null;
    /** When this snapshot was WRITTEN — refreshed by the heartbeat as well as by
     *  every transition, so a reader can tell "nothing has changed" from "the
     *  daemon stopped writing". Absent on a file written by a pre-heartbeat
     *  binary; readers must treat that as age-unknown, never as stale. */
    writtenAt?: string;
    /** The daemon's RESOLVED fortress root. The console compares it against its
     *  own by file identity, so a second daemon on a different root is visible
     *  as a mismatch instead of silently serving the wrong install. Absent on a
     *  pre-console file. */
    root?: string;
  };
  connection: {
    state: ConnectionState;
    reason: string | null;
    message: string | null;
  };
  postgres: {
    phase: PostgresPhase;
    reason: string | null;
  };
  modules: ModuleRuntimeStatus[];
  /** Optional secret-free view of the session_vault storage config (store, bucket,
   *  region, identity label). Absent when no vault credentials are configured;
   *  NEVER contains private keys or S3 secrets (see redactCredentials). */
  vault?: Record<string, unknown>;
}

export interface StatusStore {
  write(snapshot: HostStatusSnapshot): Promise<void>;
}

export type ModuleStartResult =
  | { id: string; ok: true }
  | { id: string; ok: false; error: string };

export type ModuleStopResult =
  | { id: string; ok: true }
  | { id: string; ok: false; error: string };

/** Payload for the fortress→cloud realtime invalidation (MC-2415), carried up
 *  the tunnel after an hx ingest so the cloud can refresh the user's live
 *  "my sessions" queries. */
export interface HxIngestNotification {
  /** Cloud user id (hx_users.external_id) whose sessions changed. */
  userExternalId: string;
  /** Org the session is attributed to (cloud id), or null for personal. */
  orgExternalId: string | null;
}

export interface CloudConnection {
  state(): ConnectionState;
  status(): ConnectionStatusSnapshot;
  open(config: FortressConfig): Promise<void>;
  close(): Promise<void>;
  /** Best-effort push of an hx ingest notification to the cloud. No-op when the
   *  tunnel isn't currently open. */
  notifyIngest(evt: HxIngestNotification): void;
  /** Ask the hub a bounded question. OPTIONAL because a transport that cannot
   *  ask is a real state (a test double, a fortress with no tunnel) and the
   *  callers must degrade to "unavailable" rather than assume an answer. Rejects
   *  with FortressQueryUnavailable; never hangs, never invents a value. */
  request?(
    query: FortressQueryPayload,
    timeoutMs?: number,
  ): Promise<FortressQueryResultPayload>;
}

export interface ModuleSupervisor {
  startAll(moduleIds: readonly string[]): Promise<readonly ModuleStartResult[]>;
  stopAll(): Promise<readonly ModuleStopResult[]>;
  snapshot(): readonly ModuleRuntimeStatus[];
}

export interface HostLogger {
  error(message: string, error?: unknown): void;
}

export type Clock = () => Date;

export interface LogRecord {
  ts: string;
  module: string;
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  fields?: Record<string, unknown>;
}

export interface LogSink {
  write(record: LogRecord): void;
}

export interface ScopedLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** The enrolled Fortress identity handed down to modules after the cloud
 *  connection authenticates. Contains the org/fortress binding issued by the
 *  hub at enrollment time. */
export interface EnrolledIdentity {
  orgId: string;
  fortressId: string;
  credential: string;
}

export interface ModuleContext {
  readonly moduleId: string;
  readonly logger: ScopedLogger;
  /** Populated once the Fortress cloud connection has authenticated. Null if
   *  the host is not yet enrolled or identity could not be loaded. */
  readonly fortressIdentity: EnrolledIdentity | null;
}

export interface Module {
  readonly id: string;
  init?(context: ModuleContext): Promise<void> | void;
  start?(): Promise<void> | void;
  stop?(): Promise<void> | void;
  update?(): Promise<void> | void;
  uninstall?(): Promise<void> | void;
  onMessage(data: MsgData): Promise<MsgReply | void> | MsgReply | void;
}

export interface LoadableRegistry {
  register(module: Module): void;
  has(id: string): boolean;
  get(id: string): Module | undefined;
  startOne(id: string): Promise<ModuleStartResult>;
  stopOne(id: string): Promise<ModuleStopResult>;
  unregister(id: string): void;
}

export interface ModuleInstallParams {
  moduleId: string;
  version: string;
  artifactUrl: string;
  /** Hub-supplied integrity hash. Recorded for inventory bookkeeping ONLY — it
   *  is NOT an authenticity root (a compromised hub could serve a matching hash
   *  for a trojaned artifact). Authenticity is the detached `signature`. */
  checksum: string;
  /** Detached Ed25519 signature sidecar JSON (from moduleAdvertise.signature),
   *  verified against the baked trust anchors. Absent → allowed only when
   *  signature enforcement is off (verify-if-present). */
  signature?: string;
}

export interface ModuleLifecycleHandler {
  install(params: ModuleInstallParams): Promise<void>;
  uninstall(moduleId: string): Promise<void>;
}

export type PostgresPhase = "acquiring" | "initializing" | "retrying" | "ready" | "failed";

export interface PostgresStatusSnapshot {
  phase: PostgresPhase;
  reason: string | null;
}

export interface PostgresProvider {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): PostgresStatusSnapshot;
  isReady(): boolean;
  /** Role-aware DSN, or null before the cluster is ready. Default (and `"rw"`)
   *  is the DML role; `"ro"` the SELECT-only role. External Postgres returns the
   *  operator's single URL for both. */
  dsn(role?: "ro" | "rw"): string | null;
  /** Background phase transitions (the external provider's re-probe loop flips
   *  retrying → ready long after start() returned). The runtime subscribes so
   *  status.json is rewritten — otherwise a recovered fortress would report
   *  "retrying" until its next lifecycle write. The embedded provider never
   *  fires it (its phases all change inside start()/stop()). */
  onPhaseChange?(listener: (snapshot: PostgresStatusSnapshot) => void): void;
}
