import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { acquireBinaries } from "./acquire";
import { detectMusl, resolveZonkyClassifier } from "./classifier";
import {
  auditConsolePlane,
  ensureAppRoles,
  ensureAuth,
  ensureCluster,
  ensureDatabaseAndSchema,
  PG_APP_RO_ROLE,
  PG_APP_RW_ROLE,
  PG_DATABASE,
  PG_ROLE,
  type ClusterSql,
} from "./cluster";
import { embeddedPgJson, writePgJson } from "./pg-json";
import { ensureRoleSecrets, type RoleSecrets } from "./roles";
import { makeExtractor, makeTarGzExtractor } from "./extract";
import { runMigrations } from "./migrate";
import { migrations } from "./migrations/manifest";
import { pgMajorOf } from "./pgvector-artifact";
import { ensurePgvectorInstalled } from "./pgvector-install";
import { createEmbeddedPostgres, createExternalPostgres } from "./provider";
import { resolvePostgresConfig } from "./resolve";
import { defaultSpawner, type Spawner } from "./spawn";
import { makeMigrationExec, migrationTimeoutMs } from "./sql-exec";
import type { fortressPaths } from "../paths";
import type { FortressConfig, PostgresProvider, ScopedLogger } from "../types";
import { parseBooleanEnv } from "../../env";
import { withDeadline } from "../with-deadline";

export interface BuildPostgresDeps {
  env: Record<string, string | undefined>;
  config: FortressConfig;
  paths: ReturnType<typeof fortressPaths>;
  platform?: NodeJS.Platform;
  arch?: string;
  spawner?: Spawner;
  logger?: ScopedLogger;
}

export function buildPostgresProvider(deps: BuildPostgresDeps): PostgresProvider {
  const spawner = deps.spawner ?? defaultSpawner;
  const resolved = resolvePostgresConfig(deps.env, deps.config, deps.paths.defaultPgData);

  if (resolved.mode === "external" && resolved.externalUrl) {
    const url = resolved.externalUrl;
    return createExternalPostgres(
      url,
      () => probe(url),
      async () => {
        await runMigrations(makeMigrationExec(url), migrations);
        // No role split exists externally — the operator's single DSN is what the
        // console gets, and the banner reports containment as unavailable.
        await writePgJson(deps.paths.pgJson, { mode: "external", databaseUrl: url });
      },
      {
        logger: deps.logger,
        // Outer whole-attempt bound: the per-batch SET LOCAL covers each
        // statement; this covers hangs the batches can't see. + margin so a
        // single maximal migration still fits one attempt.
        migrateDeadlineMs: migrationTimeoutMs(deps.env) + 60_000,
      },
    );
  }

  const classifier = resolveZonkyClassifier(
    deps.platform ?? process.platform,
    deps.arch ?? process.arch,
    detectMusl(),
  );
  const versionDir = deps.paths.postgresVersionDir(resolved.version);
  const dataDir = resolved.dataDir;
  const socketDir = deps.paths.postgresSocket;
  const port = resolved.port;

  // Per-install role secrets, read (or minted) once and memoized. Awaited by the
  // first boot hook that needs it (ensureCluster) and reused everywhere; the
  // synchronous role-DSN accessor below reads the resolved value (only ever
  // invoked once the cluster is ready, by which point this is populated).
  let secrets: RoleSecrets | null = null;
  const getSecrets = async (): Promise<RoleSecrets> => {
    if (!secrets) secrets = await ensureRoleSecrets(deps.paths.pgRoles);
    return secrets;
  };

  // Loopback only: the server binds 127.0.0.1, never an external interface. The
  // password is URL-safe hex (roles.ts), so it needs no escaping in the DSN.
  const dsnFor = (database: string, password: string, role: string): string =>
    `postgresql://${role}:${password}@127.0.0.1:${port}/${database}`;
  // Bootstrap connections (schema, auth hardening, migrations) run as the
  // fortress superuser.
  const superDsn = (database: string, s: RoleSecrets): string =>
    dsnFor(database, s.super, PG_ROLE);
  // Role-aware DSN handed to modules once ready. Default/"rw" → the DML role;
  // "ro" → the SELECT-only role (least-privilege for the MCP read tools).
  const roleDsn = (role?: "ro" | "rw"): string => {
    if (!secrets) throw new Error("postgres role secrets not initialized");
    return role === "ro"
      ? dsnFor(PG_DATABASE, secrets.appRo, PG_APP_RO_ROLE)
      : dsnFor(PG_DATABASE, secrets.appRw, PG_APP_RW_ROLE);
  };

  const sql: ClusterSql = {
    run: async (database, statement) => {
      const client = new Bun.SQL(superDsn(database, await getSecrets()));
      try {
        await client.unsafe(statement);
      } finally {
        await client.end();
      }
    },
    exists: async (database, query) => {
      const client = new Bun.SQL(superDsn(database, await getSecrets()));
      try {
        const rows = await client.unsafe(query);
        return Array.isArray(rows) && rows.length > 0;
      } finally {
        await client.end();
      }
    },
    query: async <T = Record<string, unknown>>(database: string, statement: string): Promise<T[]> => {
      const client = new Bun.SQL(superDsn(database, await getSecrets()));
      try {
        const rows = await client.unsafe(statement);
        return (Array.isArray(rows) ? rows : []) as T[];
      } finally {
        await client.end();
      }
    },
    // ONE connection, ONE simple-query batch — which Postgres runs as one
    // implicit transaction. `run` is a statement per connection (autocommit),
    // so a role/grant sequence issued through it could be interrupted halfway
    // and leave a half-provisioned privilege state durably in place. Explicit
    // BEGIN/COMMIT is not an option: Bun.SQL rejects them on a pooled
    // connection, which is why the batch path is the atomicity mechanism.
    runMany: async (database, statements) => {
      if (statements.length === 0) return;
      const client = new Bun.SQL(superDsn(database, await getSecrets()));
      try {
        await client.unsafe(statements.map((s) => `${s};`).join("\n")).simple();
      } finally {
        await client.end();
      }
    },
  };

  return createEmbeddedPostgres({
    dsn: roleDsn,
    logger: deps.logger,
    // The Postgres server's own log, which is where the CAUSE lives whenever the
    // server itself is what died — a backend killed by a signal, a failed
    // extension, a corrupt cluster. The error the provider catches is only the
    // driver noticing the socket went away ("Connection closed"), which names
    // nothing an operator can act on. Errors only, newest last, and bounded.
    serverLogTail: async () => {
      const text = await readFile(path.join(dataDir, "pg_ctl-server.log"), "utf8").catch(() => null);
      if (!text) return null;
      const lines = text.split("\n").filter((l) => /(FATAL|PANIC|ERROR|was terminated)/.test(l));
      const tail = lines.slice(-4).join(" | ").trim();
      return tail ? tail.slice(0, 600) : null;
    },
    acquire: () =>
      acquireBinaries({
        fetchImpl: fetch,
        extract: makeExtractor(spawner),
        cacheDir: deps.paths.postgresCache,
        versionDir,
        classifier,
        version: resolved.version,
        binariesUrl: resolved.binariesUrl,
        // M-3: prefer the baked pinned hash; fall back to the network `.sha256`
        // (with a SECURITY warn) unless strict pinning is required.
        requirePinned: parseBooleanEnv(deps.env.FORTRESS_PG_REQUIRE_PINNED),
        allowUnpinned: parseBooleanEnv(deps.env.FORTRESS_PG_ALLOW_UNPINNED),
        log: (msg, fields) => deps.logger?.warn(msg, fields),
      }),
    ensureCluster: async (binDir) => {
      const s = await getSecrets();
      await ensureCluster({ spawner, binDir, dataDir, superPassword: s.super });
    },
    startServer: async (binDir) => {
      await mkdir(socketDir, { recursive: true, mode: 0o700 });
      // `-l <logfile>` is REQUIRED: pg_ctl daemonizes the postmaster, which
      // inherits this process's stdout. defaultSpawner drains child stdout to EOF
      // (for the tar-audit capture), so without `-l` the never-closing daemon pipe
      // hangs `start()` forever — bricking the boot. Redirecting the server's
      // stdout/stderr to a file releases the inherited pipe → EOF → we return.
      const { code, stderr } = await spawner.run([
        path.join(binDir, "pg_ctl"),
        "-D",
        dataDir,
        "-w",
        "-l",
        path.join(dataDir, "pg_ctl-server.log"),
        "-o",
        `-k ${socketDir} -p ${port} -c listen_addresses=127.0.0.1`,
        "start",
      ]);
      if (code !== 0) throw new Error(`pg_ctl start failed: ${stderr.trim()}`);
    },
    stopServer: async (binDir) => {
      await spawner.run([path.join(binDir, "pg_ctl"), "-D", dataDir, "-m", "fast", "stop"]);
    },
    ensureAuth: async (binDir) => {
      const s = await getSecrets();
      await ensureAuth(sql, dataDir, s, async () => {
        const { code, stderr } = await spawner.run([
          path.join(binDir, "pg_ctl"),
          "-D",
          dataDir,
          "reload",
        ]);
        if (code !== 0) throw new Error(`pg_ctl reload failed: ${stderr.trim()}`);
      });
    },
    ensureDbSchema: () => ensureDatabaseAndSchema(sql),
    ensureVector: async () => {
      // pgvector is mandatory. It needs a download base (the cloud proxy); an
      // enrolled fortress always has one (the start sequence only runs once the
      // OpenAI key gate has passed, which implies enrollment). A missing base is
      // a real misconfiguration, so fail rather than silently degrade.
      if (!resolved.pgvectorUrl) {
        throw new Error(
          "pgvector requires a download base but none is configured " +
            "(no cloud URL and no FORTRESS_PGVECTOR_URL)",
        );
      }
      await ensurePgvectorInstalled({
        versionDir,
        classifier,
        pgMajor: pgMajorOf(resolved.version),
        baseUrl: resolved.pgvectorUrl,
        darwin: (deps.platform ?? process.platform) === "darwin",
        fetchImpl: fetch,
        extractTarGz: makeTarGzExtractor(spawner),
        spawn: async (cmd) => {
          const { code, stderr } = await spawner.run(cmd);
          if (code !== 0) throw new Error(`${cmd[0]} failed: ${stderr.trim()}`);
        },
        log: (msg, meta) => deps.logger?.info(msg, meta),
      });
    },
    migrate: async () => {
      await runMigrations(makeMigrationExec(superDsn(PG_DATABASE, await getSecrets())), migrations);
    },
    ensureAppRoles: async () => {
      const s = await getSecrets();
      await ensureAppRoles(sql, s);
      // The console reads its coordinates from here and carries no environment
      // of its own, so an env-sourced port has to be republished every boot.
      await writePgJson(
        deps.paths.pgJson,
        embeddedPgJson({ host: "127.0.0.1", port, database: PG_DATABASE, password: s.ui }),
      );
      const violations = await auditConsolePlane(sql);
      for (const violation of violations) {
        deps.logger?.error("console-plane ownership invariant violated", { violation });
      }
    },
  });
}

/** One bounded external-PG probe attempt. Param-FREE by design (no
 *  statement_timeout startup parameter): a pooler-fronted DSN must be able to
 *  reach ready before the operator discovers the =0 hatch — the guarded-db
 *  probe is the param-carrying canary that then surfaces the misconfiguration.
 *  Bounded on BOTH sides (driver connectionTimeout + a raced SELECT 1) and the
 *  client is closed on every path — the old probe leaked it on failure. */
async function probe(url: string): Promise<void> {
  const client = new Bun.SQL(url, { max: 1, connectionTimeout: 10 });
  try {
    await withDeadline(
      client`SELECT 1`.then(() => undefined),
      10_000,
      "external postgres probe timed out",
    );
  } finally {
    // Detached: close's own promise can hang on a black-holed socket, and the
    // provider loop must never wait on teardown. Observed (Bun exits on
    // unhandled rejections).
    void client.close({ timeout: 1 }).catch(() => {});
  }
}
