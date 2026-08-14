import { existsSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const MODULE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export function assertModuleId(moduleId: string): void {
  if (!MODULE_ID_PATTERN.test(moduleId)) {
    throw new Error(`Invalid module id: ${moduleId}`);
  }
}

/**
 * One-time silent migration of the home config dir from the pre-rename location
 * (~/.let/fortress) to ~/.let/hx-fortress. Fires only when the new dir is absent
 * and the legacy dir is present, so existing installs carry over their config,
 * credentials and pgdata with no re-enrollment. `home` is injectable for tests.
 */
export function migrateFortressHome(home = os.homedir()): string {
  const current = path.join(home, ".let", "hx-fortress");
  const legacy = path.join(home, ".let", "fortress");
  if (!existsSync(current) && existsSync(legacy)) {
    try {
      renameSync(legacy, current);
    } catch {
      // Cross-device move or permission issue — leave the legacy dir untouched;
      // callers create the new dir and start fresh (a rare one-time re-enroll).
    }
  }
  return current;
}

let homeMigrated = false;

export function defaultFortressRoot(): string {
  // FORTRESS_ROOT lets a container mount all persisted state (config.json,
  // credentials.json, signing-key) on a single volume; otherwise default to the
  // operator's home directory (migrating the pre-rename location on first use).
  const fromEnv = process.env.FORTRESS_ROOT?.trim();
  if (fromEnv) return fromEnv;
  if (!homeMigrated) {
    homeMigrated = true;
    return migrateFortressHome();
  }
  return path.join(os.homedir(), ".let", "hx-fortress");
}

export function fortressPaths(root = defaultFortressRoot()) {
  const modules = path.join(root, "modules");
  const postgres = path.join(root, "postgres");
  // Daemon-only, 0700. The files under it are the medium a Postgres-role
  // adversary cannot reach — which is what makes them usable as security
  // anchors (crash-recovery eligibility, the pause clamp) where a SQL-visible
  // value would be forgeable.
  const runtime = path.join(root, "runtime");
  // Console-owned, 0700. pg.json is written by the daemon for the console to
  // read; ui.json is the console's own configuration.
  const ui = path.join(root, "ui");

  return {
    root,
    config: path.join(root, "config.json"),
    runtimeRoot: runtime,
    uiRoot: ui,
    /** Console DB coordinates (hx_ui credentials only), rewritten every boot. */
    pgJson: path.join(ui, "pg.json"),
    /** Console configuration — read-only to the daemon. */
    uiConfig: path.join(ui, "ui.json"),
    /** Daemon-published counters for the console (10s cadence). */
    metrics: path.join(runtime, "metrics.json"),
    /** Command ids this daemon claimed and has not yet finished. */
    commandsInFlight: path.join(runtime, "commands-inflight.json"),
    /** First-observed timestamp of the CURRENT pause episode; cleared on resume. */
    pauseAnchor: path.join(runtime, "pause-anchor.json"),
    /** 0600 single-use credential files referenced by command params. */
    cmdCreds: path.join(runtime, "cmd-creds"),
    /** Append-only audit spool, drained into Postgres as hx_ui. It sits under
     *  the console's own directory rather than the daemon's: the ui server, the
     *  daemon and every CLI invocation write here, and the drain, the rotation
     *  and the retention floor are all the console's. Same 0700 rule either way
     *  - one owning user, no group, no second uid. */
    auditSpool: path.join(ui, "spool"),
    postgresRoot: postgres,
    postgresCache: path.join(postgres, "cache"),
    postgresSocket: path.join(postgres, "socket"),
    // Per-install generated passwords for the embedded-PG roles (fortress /
    // hx_app_rw / hx_app_ro). Persisted 0600; MUST be preserved with pgdata.
    pgRoles: path.join(postgres, "roles.json"),
    defaultPgData: path.join(root, "pgdata"),
    postgresVersionDir(version: string): string {
      return path.join(postgres, version);
    },
    credentials: path.join(root, "identity", "credentials.json"),
    pendingEnrollment: path.join(root, "identity", "pending-enrollment.json"),
    signingKey: path.join(root, "identity", "signing-key"),
    moduleInventory: path.join(modules, "inventory.json"),
    log: path.join(root, "logs", "fortress.jsonl"),
    serviceLog: path.join(root, "logs", "service.log"),
    status: path.join(root, "runtime", "status.json"),
    moduleConfig(moduleId: string): string {
      assertModuleId(moduleId);
      return path.join(modules, moduleId, "config.json");
    },
    moduleArtifacts(moduleId: string): string {
      assertModuleId(moduleId);
      return path.join(modules, moduleId, "artifacts");
    },
  };
}
