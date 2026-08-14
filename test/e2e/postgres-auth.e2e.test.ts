import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildPostgresProvider } from "../../src/host/postgres";
import { fortressPaths } from "../../src/host/paths";
import type { FortressConfig } from "../../src/host/types";

// Gated like the other embedded-cluster e2e: opt in with FORTRESS_PG_E2E=1
// (first run downloads + extracts the zonky binaries).
const RUN = process.env.FORTRESS_PG_E2E === "1";
const config: FortressConfig = {
  schemaVersion: 1,
  cloud: { url: "wss://x/tunnel" },
  gateway: { publicUrl: "https://x" },
  modules: { enabled: [] },
};

describe.if(RUN)("postgres de-superuser conversion (trust → scram, in place)", () => {
  let root = "";
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  test(
    "an existing trust data dir converges to loopback-only scram with data intact",
    async () => {
      root = await mkdtemp(path.join(os.tmpdir(), "hx-pg-auth-e2e-"));
      const paths = fortressPaths(root);
      const port = String(50000 + (process.pid % 15000));
      const dataDir = paths.defaultPgData;

      // ── Boot #1: a fresh cluster (already scram). Seed a marker row. ──────────
      const first = buildPostgresProvider({ env: { FORTRESS_PG_PORT: port }, config, paths });
      await first.start();
      expect(first.status().phase).toBe("ready");
      const s1 = JSON.parse(await readFile(paths.pgRoles, "utf8")) as { super: string };
      const superDsn1 = `postgresql://fortress:${s1.super}@127.0.0.1:${port}/hx-db`;
      {
        const c = new Bun.SQL(superDsn1);
        try {
          await c.unsafe(
            "INSERT INTO hx.users (id, external_id) VALUES ('33333333-3333-7333-8333-333333333333','marker-user')",
          );
        } finally {
          await c.end();
        }
      }
      await first.stop();

      // ── Simulate a legacy pre-hardening state on the SAME data dir: an
      //    --auth=trust HBA + no managed secrets. (fortress keeping an old
      //    password is invisible under trust and is overwritten by ensureAuth.) ──
      await writeFile(
        path.join(dataDir, "pg_hba.conf"),
        ["local all all trust", "host all all 127.0.0.1/32 trust", "host all all ::1/128 trust", ""].join("\n"),
      );
      await rm(paths.pgRoles, { force: true });
      expect(existsSync(paths.pgRoles)).toBe(false);

      // ── Boot #2: same data dir. ensureCluster must SKIP initdb (data intact),
      //    ensureAuth converts trust→scram, ensureAppRoles mints the app roles. ──
      const second = buildPostgresProvider({ env: { FORTRESS_PG_PORT: port }, config, paths });
      await second.start();
      expect(second.status().phase).toBe("ready");

      // roles.json regenerated.
      expect(existsSync(paths.pgRoles)).toBe(true);
      const s2 = JSON.parse(await readFile(paths.pgRoles, "utf8")) as { super: string };
      const superDsn2 = `postgresql://fortress:${s2.super}@127.0.0.1:${port}/hx-db`;

      {
        const c = new Bun.SQL(superDsn2);
        try {
          // The seeded row survived — no re-initdb happened.
          const rows = (await c.unsafe(
            "SELECT count(*)::int AS n FROM hx.users WHERE external_id='marker-user'",
          )) as Array<{ n: number }>;
          expect(rows[0].n).toBe(1);
          // The least-privilege login roles now exist.
          const roles = (await c.unsafe(
            "SELECT rolname FROM pg_roles WHERE rolname IN ('hx_app_ro','hx_app_rw')",
          )) as Array<{ rolname: string }>;
          expect(roles.map((r) => r.rolname).sort()).toEqual(["hx_app_ro", "hx_app_rw"]);
        } finally {
          await c.end();
        }
      }

      // pg_hba.conf converged to the managed scram + reject ruleset (no trust).
      const hba = await readFile(path.join(dataDir, "pg_hba.conf"), "utf8");
      expect(hba).toContain("scram-sha-256");
      expect(hba).toContain("reject");
      expect(hba).not.toContain("trust");

      // scram is enforced: a password-less fortress connection is rejected.
      let rejected = false;
      const noPw = new Bun.SQL(`postgresql://fortress@127.0.0.1:${port}/hx-db`);
      try {
        await noPw.unsafe("SELECT 1");
      } catch {
        rejected = true;
      } finally {
        await noPw.end().catch(() => {});
      }
      expect(rejected).toBe(true);

      // The RW role authenticates + reads under scram.
      const rw = new Bun.SQL(second.dsn("rw") as string);
      try {
        const rows = (await rw.unsafe("SELECT count(*)::int AS n FROM hx.users")) as Array<{ n: number }>;
        expect(rows[0].n).toBeGreaterThanOrEqual(1);
      } finally {
        await rw.end();
      }

      await second.stop();
    },
    180_000,
  );
});
