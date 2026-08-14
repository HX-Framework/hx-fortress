import type { PostgresPhase, PostgresProvider, ScopedLogger } from "../types";
import { sanitizeDbError } from "./sanitize";

export interface EmbeddedDeps {
  /** Download/extract the binaries; resolves to the `bin/` directory. */
  acquire: () => Promise<string>;
  /** Run `initdb` if the data directory is fresh. */
  ensureCluster: (binDir: string) => Promise<void>;
  /** Start the server and block until it accepts connections (`pg_ctl -w`). */
  startServer: (binDir: string) => Promise<void>;
  /** Stop the server (`pg_ctl -m fast stop`). */
  stopServer: (binDir: string) => Promise<void>;
  /**
   * Idempotent in-place auth hardening (de-superuser): set the fortress password
   * and rewrite pg_hba.conf to loopback-only scram, converting a legacy
   * `--auth=trust` cluster with zero re-init. Runs after `startServer`, before
   * `ensureDbSchema`. Receives the binDir so it can `pg_ctl reload`.
   */
  ensureAuth?: (binDir: string) => Promise<void>;
  /** Create the hx-db database and hx schema over a live connection. */
  ensureDbSchema: () => Promise<void>;
  /**
   * Best-effort inject of pgvector into the embedded bundle before migrate, so
   * the gated embeddings migrations can apply. Optional + never fatal.
   */
  ensureVector?: () => Promise<void>;
  /** Apply the hx schema migrations over a live connection. */
  migrate: () => Promise<void>;
  /**
   * Idempotently provision the least-privilege login roles (hx_app_ro/hx_app_rw)
   * over a live connection. Runs after `migrate` so the blanket schema grants
   * cover every table this boot created.
   */
  ensureAppRoles?: () => Promise<void>;
  /** Role-aware connection string builder handed to modules once ready. Default
   *  (and `"rw"`) resolves the DML role; `"ro"` the SELECT-only role. */
  dsn: (role?: "ro" | "rw") => string;
  /** Where the failure goes. Without it a boot that dies here is SILENT: the
   *  phase and reason land in status.json and nothing is ever written to the
   *  log, so an operator watching `hx-fortress logs` sees the binaries install
   *  and then nothing, while every ingest is refused with `postgres_not_ready`. */
  logger?: ScopedLogger;
  /** Last lines of the Postgres server's own log, read on failure. The cause is
   *  routinely THERE and nowhere else — a backend killed by a signal, a bad
   *  extension, a corrupt cluster — while the error this code catches is only
   *  the driver noticing the socket went away. */
  serverLogTail?: () => Promise<string | null>;
}

export function createEmbeddedPostgres(deps: EmbeddedDeps): PostgresProvider {
  let phase: PostgresPhase = "acquiring";
  let reason: string | null = null;
  let binDir: string | null = null;

  return {
    async start() {
      let step = "acquiring the Postgres binaries";
      try {
        phase = "acquiring";
        binDir = await deps.acquire();
        step = "creating the cluster";
        phase = "initializing";
        await deps.ensureCluster(binDir);
        step = "starting the server";
        await deps.startServer(binDir);
        step = "hardening authentication";
        // De-superuser hardening: set the fortress password + rewrite pg_hba to
        // scram BEFORE any schema work, converting a legacy trust cluster in
        // place. Must precede ensureDbSchema so every later connection is scram.
        if (deps.ensureAuth) await deps.ensureAuth(binDir);
        step = "creating the database and schema";
        await deps.ensureDbSchema();
        step = "installing pgvector";
        // Inject pgvector before migrate so the embeddings migrations can apply
        // this boot. Mandatory: if the inject throws, it propagates and fails
        // the start (phase = "failed") — semantic search is core, so we refuse
        // to boot half-working rather than silently degrade.
        if (deps.ensureVector) await deps.ensureVector();
        step = "applying migrations";
        await deps.migrate();
        step = "provisioning the least-privilege roles";
        // Provision the least-privilege app roles after migrate, so the blanket
        // GRANT ON ALL TABLES covers everything this boot created.
        if (deps.ensureAppRoles) await deps.ensureAppRoles();
        phase = "ready";
        reason = null;
      } catch (error) {
        phase = "failed";
        // WHICH STEP, not just the driver's last words. "Connection closed" is
        // what the client saw; "applying migrations" is what was happening, and
        // it is the difference between a five-minute diagnosis and an hour.
        const detail = sanitizeDbError(error);
        const tail = await deps.serverLogTail?.().catch(() => null);
        reason = tail ? `${step}: ${detail} — ${tail}` : `${step}: ${detail}`;
        deps.logger?.error("postgres failed to start", {
          step,
          error: detail,
          ...(tail ? { serverLog: tail } : {}),
        });
      }
    },
    async stop() {
      if (binDir) {
        try {
          await deps.stopServer(binDir);
        } catch {
          // best-effort shutdown; nothing else to do on the way down
        }
      }
      binDir = null;
    },
    status() {
      return { phase, reason };
    },
    isReady() {
      return phase === "ready";
    },
    dsn(role) {
      return phase === "ready" ? deps.dsn(role) : null;
    },
  };
}

export interface ExternalPostgresOptions {
  logger?: ScopedLogger;
  /** Background re-probe cadence (ms) after a failed attempt. Default 15 s,
   *  with capped backoff (15 → 30 → 60 s). */
  retryMs?: number;
  maxRetryMs?: number;
  /** Outer deadline for one WHOLE migrate attempt (probe already succeeded):
   *  the per-batch SET LOCAL bounds each statement server-side; this bounds a
   *  hang the batches can't see (a black-holed connect mid-run, a never-settling
   *  extension probe). Default: the migration statement timeout + 60 s margin.
   *  Per-migration journaling makes successive attempts converge incrementally,
   *  so a legitimately long multi-migration run finishes across attempts. */
  migrateDeadlineMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** External-PG provider (component 3 of the PG-layer resilience design).
 *
 *  The old shape ran ONE boot probe, swallowed its failure into phase "failed"
 *  and left `dsn()` null forever — a fortress that raced its database's boot
 *  (or hit one transient DNS blip) stayed PG-less until a human redeployed.
 *  Now: `start()` returns after the FIRST attempt so the tunnel opens either
 *  way, and an INFINITE background loop (each attempt time-bounded — a finite
 *  attempt cap would recreate the dsn-null-forever incident) re-probes until
 *  probe + migrations succeed. Phase is "retrying" between attempts and flips
 *  to "ready" ONLY after migrate; `dsn()` is non-null from ready. */
export function createExternalPostgres(
  url: string,
  probeReady: () => Promise<void>,
  migrate: () => Promise<void>,
  options: ExternalPostgresOptions = {},
): PostgresProvider {
  const logger = options.logger;
  const retryMs = options.retryMs ?? 15_000;
  const maxRetryMs = options.maxRetryMs ?? 60_000;
  const migrateDeadlineMs = options.migrateDeadlineMs ?? 360_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let phase: PostgresPhase = "initializing";
  let reason: string | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attemptBusy = false;
  let attempts = 0;
  let listener: ((snapshot: { phase: PostgresPhase; reason: string | null }) => void) | null = null;

  const setPhase = (p: PostgresPhase, r: string | null): void => {
    phase = p;
    reason = r;
    // stop() suppresses emissions so a late background flip can't write status
    // after the runtime's final "stopped" snapshot.
    if (!stopped) listener?.({ phase, reason });
  };

  /** One bounded migrate attempt. The loser of the outer race keeps running
   *  detached with a PURE-SWALLOW observer: it never mutates phase/reason and
   *  never re-fires the ready path — its work is safe to complete server-side
   *  (per-batch advisory lock serializes it against the retry; the journal's
   *  same-batch PRIMARY KEY makes a late duplicate apply roll back atomically). */
  const raceMigrate = async (): Promise<void> => {
    const attempt = migrate();
    attempt.catch(() => {}); // observer — Bun exits on unhandled rejections
    let timedOut = false;
    const won = await Promise.race([
      attempt.then(
        () => true,
        () => false,
      ),
      sleep(migrateDeadlineMs).then(() => {
        timedOut = true;
        return false;
      }),
    ]);
    if (won) return;
    if (timedOut) throw new Error(`migrate attempt exceeded ${migrateDeadlineMs}ms`);
    // The attempt itself rejected — surface its (sanitized) reason.
    return attempt;
  };

  const runAttempt = async (): Promise<boolean> => {
    if (attemptBusy) return false; // single-flight per attempt
    attemptBusy = true;
    attempts += 1;
    try {
      await probeReady();
      await raceMigrate();
      setPhase("ready", null);
      logger?.info("external postgres ready", { attempts });
      return true;
    } catch (error) {
      const message = sanitizeDbError(error);
      setPhase("retrying", message);
      logger?.error("external postgres attempt failed — will retry", {
        attempt: attempts,
        error: message,
      });
      return false;
    } finally {
      attemptBusy = false;
    }
  };

  const backoff = (): number => Math.min(retryMs * 2 ** Math.min(attempts - 1, 2), maxRetryMs);

  const scheduleRetry = (): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void runAttempt().then((ok) => {
        if (!ok) scheduleRetry();
      });
    }, backoff());
    (timer as { unref?: () => void }).unref?.();
  };

  return {
    async start() {
      // Returns after the FIRST attempt either way — the tunnel must open even
      // while the database is still down (the loop keeps retrying behind it).
      const ok = await runAttempt();
      if (!ok) scheduleRetry();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    status() {
      return { phase, reason };
    },
    isReady() {
      return phase === "ready";
    },
    // External Postgres: role-split is embedded-only, so both roles resolve to
    // the operator's single URL. Least-privilege there is the operator's job.
    dsn() {
      return phase === "ready" ? url : null;
    },
    onPhaseChange(l) {
      listener = l;
    },
  };
}
