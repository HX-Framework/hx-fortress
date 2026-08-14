import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildPostgresProvider } from "../../src/host/postgres";
import { makeMigrationExec } from "../../src/host/postgres/sql-exec";
import { fortressPaths } from "../../src/host/paths";
import type { FortressConfig } from "../../src/host/types";

export { makeMigrationExec };

const config: FortressConfig = {
  schemaVersion: 1,
  cloud: { url: "wss://x/tunnel" },
  gateway: { publicUrl: "https://x" },
  modules: { enabled: [] },
};

export interface Cluster {
  /** Superuser (fortress) DSN — full privilege, for migrations/DDL/seed rows. */
  dsn: string;
  /** hx_app_rw DSN — DML only (SELECT/INSERT/UPDATE/DELETE), no DDL. */
  rwDsn: string;
  /** hx_app_ro DSN — SELECT only (via hx_readonly). */
  roDsn: string;
  stop: () => Promise<void>;
}

/** Boot a throwaway embedded Postgres in a temp root and return its role DSNs.
 *  Acquires/extracts the zonky binaries on first use (slow); reused by the
 *  schema e2e suites. Caller must `stop()` to shut down and remove the root. */
export async function startCluster(): Promise<Cluster> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hx-pg-e2e-"));
  const paths = fortressPaths(root);
  // Bind a per-run port (not the fixed 54329 default) so a leaked cluster from
  // an aborted run can't block the next one, and parallel suites don't collide.
  const port = String(49152 + (process.pid % 16000));
  const provider = buildPostgresProvider({ env: { FORTRESS_PG_PORT: port }, config, paths });
  await provider.start();
  const status = provider.status();
  if (status.phase !== "ready") {
    await provider.stop();
    await rm(root, { recursive: true, force: true });
    throw new Error(`cluster not ready: ${status.reason ?? "unknown"}`);
  }
  const rwDsn = provider.dsn("rw");
  const roDsn = provider.dsn("ro");
  if (!rwDsn || !roDsn) throw new Error("cluster ready but no dsn");
  // Build the privileged superuser DSN from the generated secret so the schema/
  // seed steps (which run migrations, DDL, and inserts) connect as fortress.
  const secrets = JSON.parse(await readFile(paths.pgRoles, "utf8")) as { super: string };
  const dsn = `postgresql://fortress:${secrets.super}@127.0.0.1:${port}/hx-db`;
  return {
    dsn,
    rwDsn,
    roDsn,
    stop: async () => {
      await provider.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}
