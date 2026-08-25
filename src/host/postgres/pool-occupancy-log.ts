// LETAIR-301 (degradation observability): a passive, periodic snapshot of the
// fortress's own Postgres connections BY POOL (application_name), emitted as one
// structured log line so a week of it is a greppable TIME-SERIES. Bun.SQL
// exposes no pool stats, so the source is pg_stat_activity; the sampler runs on
// its OWN short-lived max:1 connection (labeled `hx-occupancy`, never an
// rw/ro/bg pool slot), so it can never perturb the ro pool it measures.
//
// The question this answers: does effective ro capacity drift down over uptime?
// A flat roTotal/roActive floor across the week ⇒ episodic contention (no leak);
// a monotonically rising floor of held ro connections ⇒ a real leak.
// roIdleInTx / roOldestActiveS localize the hold (idle-in-transaction zombies vs
// long-running abandoned reads).

import type { ScopedLogger } from "../types";
import { sanitizeDbError } from "./sanitize";

const DEFAULT_OCCUPANCY_LOG_MS = 60_000;
const OCCUPANCY_CONNECT_TIMEOUT_S = 10;
const OCCUPANCY_STATEMENT_TIMEOUT_MS = 5_000;

/** Sampling interval (ms): set-but-empty ⇒ default 60s; explicit 0 disables. */
export function occupancyLogIntervalMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.FORTRESS_DB_OCCUPANCY_LOG_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_OCCUPANCY_LOG_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : DEFAULT_OCCUPANCY_LOG_MS;
}

export interface OccupancyRow {
  app: string;
  state: string | null;
  n: number;
  oldest_query_s: number;
  oldest_state_s: number;
}

export interface PoolOccupancyLogDeps {
  dsn: (role?: "ro" | "rw") => string | null;
  logger: ScopedLogger;
  intervalMs?: number;
  /** Test seam: stands in for the live pg_stat_activity read. */
  sample?: () => Promise<OccupancyRow[] | null>;
}

export interface PoolOccupancyLog {
  start(): void;
  stop(): Promise<void>;
  /** One sample now (tests / manual). */
  tick(): Promise<void>;
}

/** Pools the fortress labels itself — everything else is `otherTotal`. */
const FORTRESS_APPS = new Set(["hx-ro", "hx-rw", "hx-bg", "hx-occupancy"]);

/** Reduce the grouped rows to one flat, greppable summary. Pure — unit-tested. */
export function summarize(rows: OccupancyRow[]): Record<string, number> {
  const where = (app: string, state?: string): OccupancyRow[] =>
    rows.filter((r) => r.app === app && (state === undefined || r.state === state));
  const sum = (rs: OccupancyRow[]): number => rs.reduce((a, r) => a + r.n, 0);
  const maxOf = (rs: OccupancyRow[], sel: (r: OccupancyRow) => number): number =>
    rs.reduce((a, r) => Math.max(a, sel(r)), 0);
  return {
    roTotal: sum(where("hx-ro")),
    roActive: sum(where("hx-ro", "active")),
    roIdle: sum(where("hx-ro", "idle")),
    roIdleInTx: sum(where("hx-ro", "idle in transaction")),
    roOldestActiveS: maxOf(where("hx-ro", "active"), (r) => r.oldest_query_s),
    roOldestIdleTxS: maxOf(where("hx-ro", "idle in transaction"), (r) => r.oldest_state_s),
    rwTotal: sum(where("hx-rw")),
    bgTotal: sum(where("hx-bg")),
    otherTotal: sum(rows.filter((r) => !FORTRESS_APPS.has(r.app))),
    backends: sum(rows),
  };
}

const OCCUPANCY_SQL = `
  SELECT
    coalesce(nullif(application_name, ''), '(other)') AS app,
    state,
    count(*)::int AS n,
    coalesce(max(extract(epoch from (clock_timestamp() - query_start)))::int, 0) AS oldest_query_s,
    coalesce(max(extract(epoch from (clock_timestamp() - state_change)))::int, 0) AS oldest_state_s
  FROM pg_stat_activity
  WHERE pid <> pg_backend_pid()
  GROUP BY 1, 2
`;

export function createPoolOccupancyLog(deps: PoolOccupancyLogDeps): PoolOccupancyLog {
  const intervalMs = deps.intervalMs ?? occupancyLogIntervalMs();
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let busy = false;

  const liveSample = async (): Promise<OccupancyRow[] | null> => {
    const dsn = deps.dsn("rw");
    if (!dsn) return null; // provider not ready yet — nothing to sample
    const client = new Bun.SQL(dsn, {
      max: 1,
      connectionTimeout: OCCUPANCY_CONNECT_TIMEOUT_S,
      connection: {
        application_name: "hx-occupancy",
        statement_timeout: OCCUPANCY_STATEMENT_TIMEOUT_MS,
      },
    });
    try {
      const rows = (await client.unsafe(OCCUPANCY_SQL)) as unknown as OccupancyRow[];
      return Array.isArray(rows) ? rows : [];
    } finally {
      // Detached, bounded close — a hung teardown must never stall the interval
      // (mirrors the health probe's decoupled teardown).
      void client.close({ timeout: 1 }).catch(() => {});
    }
  };
  const sample = deps.sample ?? liveSample;

  const tick = async (): Promise<void> => {
    if (stopped || busy) return;
    busy = true;
    try {
      const rows = await sample();
      if (rows === null) return; // provider not ready — skip this tick, no log
      deps.logger.info("hx-db pool occupancy", summarize(rows));
    } catch (err) {
      deps.logger.warn("hx-db pool occupancy sample failed", { error: sanitizeDbError(err) });
    } finally {
      busy = false;
    }
  };

  return {
    start(): void {
      stopped = false;
      if (intervalMs <= 0) {
        deps.logger.warn("hx-db pool occupancy log disabled (FORTRESS_DB_OCCUPANCY_LOG_MS=0)");
        return;
      }
      timer = setInterval(() => void tick(), intervalMs);
      (timer as { unref?: () => void }).unref?.();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
  };
}
