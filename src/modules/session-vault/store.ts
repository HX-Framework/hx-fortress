// Build the concrete SessionStore the vault serves, from credentials.json. The
// store reads/writes the ORGANIZATION's bucket with the ORGANIZATION's
// credentials — inline in credentials.json, or (when a block is absent) the
// host's own ADC / instance role. let.ai never sees either.

import { IngestQuiesce, PauseGatedStore } from "../../console/pause-gate.js";
import type { PauseState } from "../../console/ingest-control.js";
import { GcsStore, type GcsStoreConfig } from "./store/gcs-store.js";
import { GuardedStore, type GuardedStoreOptions } from "./store/guarded-store.js";
import { S3Store } from "./store/s3-store.js";
import { assertS3EndpointSafe } from "./store/endpoint-safety.js";
import type { SessionStore } from "./store/types.js";
import type { VaultCredentials } from "./credentials.js";
import type { ScopedLogger } from "../../host/types.js";

/** Per-class deadline overrides for the guarded store (ms). A value above the
 *  cloud tunnel's 30s RPC window only helps direct-gateway callers — tunnel
 *  callers are still abandoned at 30s by the cloud. */
function deadlineEnvOverrides(): Pick<
  GuardedStoreOptions,
  "opTimeoutMs" | "heavyOpTimeoutMs" | "scanTimeoutMs"
> {
  const read = (raw: string | undefined): number | undefined => {
    const n = Number(raw ?? "");
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const out: Pick<GuardedStoreOptions, "opTimeoutMs" | "heavyOpTimeoutMs" | "scanTimeoutMs"> = {};
  const op = read(process.env.FORTRESS_STORE_OP_TIMEOUT_MS);
  if (op) out.opTimeoutMs = op;
  const heavy = read(process.env.FORTRESS_STORE_HEAVY_TIMEOUT_MS);
  if (heavy) out.heavyOpTimeoutMs = heavy;
  const scan = read(process.env.FORTRESS_STORE_SCAN_TIMEOUT_MS);
  if (scan) out.scanTimeoutMs = scan;
  return out;
}

/** True when a supervisor will resurrect this process after exit(1):
 *  systemd (Restart=on-failure in our unit) sets INVOCATION_ID, launchd
 *  (KeepAlive in our plist) sets XPC_SERVICE_NAME, Railway restarts crashed
 *  services by policy. Desktop shells LEAK both INVOCATION_ID (gnome-terminal
 *  runs under a user unit) and XPC_SERVICE_NAME (every macOS terminal), so a
 *  TTY vetoes the heuristic — a supervised daemon never has one, a manual
 *  `hx-fortress host` in a terminal does. FORTRESS_STORE_EXIT_ON_WEDGE
 *  overrides both ways (`on|true|1` / `off|false|0`). Exported for tests. */
export function supervisedRestartAvailable(
  env: Record<string, string | undefined> = process.env,
  // ANY attached terminal vetoes: a bare `> log &` keeps stderr on the tty, a
  // supervised daemon has none of the three.
  isTty: boolean = Boolean(process.stdout.isTTY || process.stderr.isTTY || process.stdin.isTTY),
): boolean {
  const override = (env.FORTRESS_STORE_EXIT_ON_WEDGE ?? "").toLowerCase();
  if (override === "on" || override === "true" || override === "1") return true;
  if (override === "off" || override === "false" || override === "0") return false;
  if (isTty) return false;
  return Boolean(env.INVOCATION_ID || env.XPC_SERVICE_NAME || env.RAILWAY_ENVIRONMENT);
}

/** The effective heavy-op deadline (ms) — for callers outside GuardedStore
 *  that need the same budget (the raw readCanonical fetch). */
export function storeHeavyTimeoutMs(): number {
  return deadlineEnvOverrides().heavyOpTimeoutMs ?? 120_000;
}

/** Escalation policy for a wedged-beyond-recovery write path, extracted so the
 *  gate/branch/order is unit-testable. `beforeExit` (bounded) lets the host
 *  stop the embedded Postgres first: launchd has no cgroup kill, so a hard
 *  exit would orphan the daemonized postmaster and the restarted fortress
 *  boots Postgres-less. Everything else stays a HARD exit — a graceful module
 *  drain could hang on the very wedge being escaped. */
export function createWedgeEscalation(opts: {
  logger?: ScopedLogger;
  beforeExit?: () => Promise<void>;
  beforeExitBoundMs?: number;
  exit?: (code: number) => void;
  supervised?: () => boolean;
  /** What is wedged — names the layer in every escalation log line. The store
   *  keeps the historical default; guarded-db passes "database". */
  subject?: string;
  /** The likely never-worked-since-boot causes for this subject (log hint). */
  neverWorkedHint?: string;
}): (info: { hadCountedSuccess: boolean }) => void {
  const exit = opts.exit ?? ((code: number): void => process.exit(code));
  const supervised = opts.supervised ?? ((): boolean => supervisedRestartAvailable());
  const boundMs = opts.beforeExitBoundMs ?? 5_000;
  const subject = opts.subject ?? "store write path";
  const hint = opts.neverWorkedHint ?? "credentials/bucket/outage";
  return ({ hadCountedSuccess }) => {
    // A process whose write path NEVER worked proves the wedge is not pool
    // state — bad credentials, a deleted bucket, a regional outage — and a
    // restart is known-futile. Exiting anyway would crash-loop Railway into
    // its restart cap and take DOWN the reads that survive a write wedge.
    if (!hadCountedSuccess) {
      opts.logger?.error(
        `${subject} has never succeeded since boot — a restart cannot cure this (${hint}); continuing degraded`,
      );
      return;
    }
    if (!supervised()) {
      opts.logger?.error(
        `${subject} wedged beyond in-process recovery — no supervisor detected, continuing degraded (set FORTRESS_STORE_EXIT_ON_WEDGE=on to opt into exit)`,
      );
      return;
    }
    opts.logger?.error(
      `${subject} wedged beyond in-process recovery — exiting for supervisor restart`,
    );
    void (async (): Promise<void> => {
      try {
        if (opts.beforeExit) {
          // Bounded: stopping the embedded Postgres is loopback pg_ctl
          // (seconds) and must never hold the exit hostage to the wedge.
          await Promise.race([
            opts.beforeExit().catch(() => {}),
            new Promise<void>((resolve) => setTimeout(resolve, boundMs)),
          ]);
        }
      } finally {
        // Unconditional: even a synchronous beforeExit throw must not leave
        // the process running after we committed to restarting it.
        exit(1);
      }
    })();
  };
}

export interface StorePauseHooks {
  state: PauseState;
  quiesce: IngestQuiesce;
  /** True while a drain is armed — new staging signatures are cut short so the
   *  pre-swap barrier has a bounded floor to wait for. */
  armed?: () => boolean;
  /** Called once per refused write, for the metric an operator reads to see the
   *  pause working. */
  onRefused?: () => void;
}

/** The concrete backend, wrapped in GuardedStore: every call gets a hard
 *  deadline and the SDK client is rebuilt after consecutive breaches — a hung
 *  keep-alive pool wedged prod ingest for three hours on 2026-07-30. The
 *  factory hands GuardedStore a way to rebuild the inner store fresh.
 *
 *  The pause gate composes OUTSIDE GuardedStore: gate → guarded → backend. A
 *  write refused because ingest is paused must not consume a deadline or count
 *  toward the rebuild/escalation streak — a quiesced fortress is deliberately
 *  holding writes, not wedged, and charging it as a wedge would restart the
 *  process in the middle of a migration. */
export function buildStore(
  c: VaultCredentials,
  logger?: ScopedLogger,
  hooks?: { beforeExit?: () => Promise<void>; pause?: StorePauseHooks },
): SessionStore {
  let lastInner: SessionStore | null = null;
  const factory = (): SessionStore => {
    // Rebuild-time hygiene: shed what THIS layer can actually reach — SDK and
    // auth state, and the S3 client's own handler. Under Bun the HTTP sockets
    // live in the process-global native-fetch pool no JS layer can evict;
    // when rebuilds prove futile, onWedgedBeyondRecovery escalates instead of
    // pretending. Best-effort: a destroy failure must not break the rebuild.
    if (lastInner && c.store !== "gcs") {
      try {
        (lastInner as S3Store).destroyClient();
      } catch (err) {
        logger?.warn("could not destroy previous S3 client on rebuild", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    lastInner = buildInnerStore(c);
    return lastInner;
  };
  const guarded = new GuardedStore(factory, {
    logger,
    ...deadlineEnvOverrides(),
    onWedgedBeyondRecovery: createWedgeEscalation({ logger, beforeExit: hooks?.beforeExit }),
  });
  const pause = hooks?.pause;
  return pause
    ? new PauseGatedStore(guarded, pause.state, pause.quiesce, {
        ...(pause.armed ? { armed: pause.armed } : {}),
        ...(pause.onRefused ? { onRefused: pause.onRefused } : {}),
      })
    : guarded;
}

/**
 * The backend alone: no retry/rebuild guard, no wedge escalation, no pause gate.
 *
 * The console uses this for the enumerated read-only operations of its read
 * class. It must NOT take the guarded store: that one escalates a wedged bucket
 * by exiting the process under a supervisor, and the console is the surface an
 * operator opens BECAUSE something is wedged. Callers here bound their own calls.
 */
export function buildDirectStore(c: VaultCredentials): SessionStore {
  return buildInnerStore(c);
}

function buildInnerStore(c: VaultCredentials): SessionStore {
  if (c.store === "gcs") {
    if (!c.projectId) {
      throw new Error("gcs storage requires a projectId in credentials.json");
    }
    return new GcsStore({
      projectId: c.projectId,
      bucketName: c.bucket,
      // Inline service-account key; absent → Application Default Credentials.
      credentials: c.gcs as GcsStoreConfig["credentials"],
    });
  }
  if (!c.region) {
    throw new Error("s3 storage requires a region in credentials.json");
  }
  // M-4 · reject an unsafe custom endpoint (plaintext / SSRF-range) before dialing.
  assertS3EndpointSafe(c.endpoint);
  return new S3Store({
    region: c.region,
    bucketName: c.bucket,
    endpoint: c.endpoint,
    forcePathStyle: c.forcePathStyle,
    // Inline access key; absent → AWS default credential chain (env / role).
    credentials: c.s3,
  });
}
