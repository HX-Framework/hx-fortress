// Assembling the read surface the console serves from.
//
// The handlers and the port were built to be testable without any of this: the
// port is an interface, and every dependency below is a function the port calls
// when it needs an answer. This module is the one place where those functions
// are the REAL ones — a live Postgres handle, the daemon's runtime files, the
// resolved configuration and the vault's own credential file.
//
// Two properties are deliberate and worth stating.
//
// NOTHING HERE THROWS ON A BROKEN FORTRESS. Every resolver answers with null,
// with an empty value or with a named degraded state, because the console's
// whole job on a broken fortress is to say what is broken. A mount that refused
// to build without Postgres would give an operator a blank page at exactly the
// moment they needed a diagnosis.
//
// THE DATABASE HANDLE IS LAZY AND RE-RESOLVED. The daemon writes pg.json on its
// first console-capable boot and provisions the console's role on every boot,
// so a console started first must pick both up without a restart — and a
// connection that fails is classified into the three distinct facts an operator
// can act on rather than one "database unavailable".

import { readFile } from "node:fs/promises";

import { FileCredentialStore, type CloudCredential } from "../cloud/credentials";
import { redactedMessage } from "./redact";
import {
  LiveCredentialsReader,
  storeCredentialsForConsole,
  type VaultCredentials,
} from "../modules/session-vault/credentials";
import { buildDirectStore } from "../modules/session-vault/store";
import type { SessionStore } from "../modules/session-vault/store/types";
import { AuditSpool } from "../console/audit-spool";
import { AuditDrain } from "./audit-drain";
import { ConsoleAudit } from "./audit-writer";
import { parseFortressConfig, rosterInactivePurgeDays, sessionsEnabledIn } from "../host/config";
import type { FortressConfig } from "../host/types";
import type { fortressPaths } from "../host/paths";
import { createHxDb, type HxDb } from "../host/postgres/db";
import { namesDatabaseSecret, readPgJson, type PgJson } from "../host/postgres/pg-json";
import { DEFAULT_PG_BINARIES_URL } from "../host/postgres/resolve";
import { lazySecretProvider, loadSecretsConfig } from "../secrets/config";
import { secretNameForSetting } from "../secrets/settings";
import { getServiceManager } from "../service";
import { FileStatusReader } from "../status-reader";
import { downloadBaseFromCloudUrl } from "../update";
import {
  classifyConnectError,
  resolveConsoleDb,
  SecretDatabaseUrl,
  type ConsoleDbState,
} from "./console-db";
import { createConsoleReadPort } from "./console-read-port";
import { createConsoleWritePort } from "./console-write-port";
import { OFFERED_COMMAND_KINDS, type ConsoleWritePort } from "./mutate-routes";
import type { UiConfig } from "./config";
import type { EgressInputs } from "./egress";
import { createLogEventProducer } from "./log-events";
import type { ConsoleReadPort } from "./read-routes";
import type { UiRuntime } from "./runtime";

/** How long one read-class store operation may take before it is a failure the
 *  page reports. */
const STORE_OP_TIMEOUT_MS = 10_000;


/**
 * The names of the secrets this fortress reads, as far as this console can
 * tell. The daemon writes the database secret's name to pg.json once its
 * database answers. Until then the setting itself says it, when this console
 * runs with the daemon's environment.
 */
function secretNamesInUse(pgJson: PgJson | null, env: Record<string, string | undefined>): string[] {
  const names = new Set<string>();
  if (pgJson && namesDatabaseSecret(pgJson)) names.add(pgJson.databaseUrlSecret);
  try {
    const fromSetting = secretNameForSetting(env, "FORTRESS_DATABASE_URL");
    if (fromSetting) names.add(fromSetting);
  } catch {
    // A setting the daemon refuses. The daemon says so; this page lists what is read.
  }
  return [...names];
}

export interface ConsoleMountOptions {
  paths: ReturnType<typeof fortressPaths>;
  runtime: UiRuntime;
  /** The port actually bound, which may differ from the configured one. */
  boundPort: number;
  /** The lifecycle owner, resolved once by the caller: a host service manager,
   *  or the orchestrator that supervises this container. */
  serviceManager: string;
  env?: Record<string, string | undefined>;
  /** Where a spool or drain failure is reported. Neither ever throws at a
   *  request: a console that refused to serve because it could not record would
   *  take the fortress's only diagnosis surface down with it. */
  onWarn?: (message: string) => void;
}

export interface ConsoleMount {
  port: ConsoleReadPort;
  /** The write surface. Separate from the read port on purpose: the read class
   *  is defined by an interface that cannot express a write. */
  write: ConsoleWritePort;
  /** The console's own spool writer: exports, sign-ins, and the two records the
   *  drain raises about the trail itself. */
  audit: ConsoleAudit;
  /** Spool into Postgres at boot, at the first recovery, and on a timer. */
  drain: AuditDrain;
  /** Resolves once the facts that are read from disk are in hand. Awaited before
   *  the console binds, so the FIRST page a browser gets is answered with the
   *  same truth as the tenth — an enrolled fortress must never render "not
   *  enrolled" for one poll because a file read had not finished. */
  ready: Promise<void>;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function createConsoleMount(options: ConsoleMountOptions): ConsoleMount {
  const { paths, runtime } = options;
  const env = options.env ?? process.env;
  // This process's own spool file. An open collapsed failure window is closed
  // before the file is retired, so its record lands in the file that covers the
  // window rather than the next one.
  const spool: AuditSpool = new AuditSpool({
    dir: paths.auditSpool,
    writer: "ui",
    beforeRotate: (): Promise<void> => audit.flushFailures(true).then(() => undefined),
  });
  const audit: ConsoleAudit = new ConsoleAudit(spool, {
    onError: (error) => options.onWarn?.(redactedMessage(error)),
  });
  const status = new FileStatusReader(paths.status);
  const service = getServiceManager();
  /** Is there a unit to ask about at all? `container` is the image's own
   *  supervisor; `unsupported` is a platform with no manager to drive. */
  const askSupervisor =
    options.serviceManager !== "container" && options.serviceManager !== "unsupported";
  const credentialStore = new FileCredentialStore(paths.credentials);

  let handle: { db: HxDb; dsn: string } | null = null;
  let databaseState: ConsoleDbState = { kind: "not-configured" };
  let resolving: Promise<void> | null = null;
  const drain = new AuditDrain({
    dir: paths.auditSpool,
    db: () => handle?.db ?? null,
    audit,
    currentFileId: () => spool.currentFileId,
    onWarn: (message, fields) => options.onWarn?.(`${message}: ${JSON.stringify(fields)}`),
  });

  /** The fortress's secret provider: one for this console, built on first use. */
  const secrets = lazySecretProvider(paths, env);
  const secretDatabaseUrl = new SecretDatabaseUrl(secrets, (reason) =>
    options.onWarn?.(
      `the database URL secret could not be read again, so the value read before is still in use: ${reason}`,
    ),
  );

  /** The external DSN when pg.json names a secret in place of it, and nothing
   *  when it does not. See SecretDatabaseUrl for what a failed read means. */
  const namedDatabaseUrl = async (
    pgJson: PgJson | null,
  ): Promise<{ url: string | null; problem: string | null }> =>
    pgJson && namesDatabaseSecret(pgJson)
      ? secretDatabaseUrl.read(pgJson.databaseUrlSecret)
      : { url: null, problem: null };

  /** Resolve coordinates and open a handle, at most once at a time. A failure
   *  leaves the classified state behind and lets the next call try again. */
  const ensureDb = async (): Promise<void> => {
    const pgJson = await readPgJson(paths.pgJson).catch(() => null);
    const config = await runtime.readConfig().catch(() => null);
    // An explicit console DSN in ui.json wins, so the secret is not read for it.
    const named = config?.databaseUrl ? { url: null, problem: null } : await namedDatabaseUrl(pgJson);
    const state: ConsoleDbState = named.problem
      ? { kind: "unavailable", detail: named.problem }
      : resolveConsoleDb({
          pgJson,
          uiDatabaseUrl: config?.databaseUrl ?? null,
          secretDatabaseUrl: named.url,
        });
    if (state.kind !== "ready") {
      handle = null;
      databaseState = state;
      return;
    }
    if (handle?.dsn === state.dsn) {
      databaseState = state;
      return;
    }
    try {
      const db = createHxDb(state.dsn);
      // A handle is not a connection: prove it before a page renders as though
      // the database answered.
      await db.execute("SELECT 1" as never);
      const recovered = handle === null;
      handle = { db, dsn: state.dsn };
      databaseState = state;
      // FIRST RECOVERY is its own drain trigger: everything spooled while
      // Postgres was down belongs in the table as soon as it comes back, not up
      // to 30 seconds later.
      if (recovered) void drain.run();
    } catch (err) {
      handle = null;
      databaseState = classifyConnectError(err);
    }
  };

  const refresh = (): Promise<void> => {
    resolving ??= ensureDb().finally(() => {
      resolving = null;
    });
    return resolving;
  };

  /** Widened once the credential resolves: until then the console's universe is
   *  the unattributed sessions alone, which is exactly what an unenrolled host
   *  holds. Mutated in place so the predicate follows an enrollment that
   *  completes while the console is already serving. */
  const universe = { orgExternalId: "" };
  let vaultCredentials: VaultCredentials | null = null;
  let directStore: SessionStore | null = null;
  let vaultBucket: { provider: string; name: string; region: string | null } | null = null;
  let downloadBase: string | null = null;

  /**
   * credentials.json as it is NOW, not as it was when this console started.
   *
   * The daemon is the file's single writer and it rewrites it twice in this
   * appliance's life: a rotation, and the cut at the end of a storage migration.
   * Read once at boot, the console goes on signing with a key the provider has
   * already revoked, and — worse for a compliance surface — goes on naming the
   * bucket this fortress has stopped storing anything in. That is a false
   * statement about where the data lives, on the one product whose deliverable
   * is that statement.
   *
   * The reader hands back the SAME object while the file's identity and mtime
   * are unchanged, so reference equality is the whole invalidation rule.
   */
  const liveCredentials = new LiveCredentialsReader();
  let lastCredentials: VaultCredentials | null = null;
  const syncVaultCredentials = async (): Promise<void> => {
    const fresh = await liveCredentials.read().catch(() => null);
    if (fresh === lastCredentials) return;
    lastCredentials = fresh;
    // The console holds the STORAGE block and nothing else. The embedding key
    // lives in the same file, belongs to the daemon's worker, and has no signing
    // use here — so it never enters this process's memory.
    vaultCredentials = fresh ? storeCredentialsForConsole(fresh) : null;
    vaultBucket = fresh
      ? { provider: fresh.store, name: fresh.bucket, region: fresh.region ?? null }
      : null;
    // Rebuilt lazily against whatever the file now names: a store bound to the
    // old credential is a client for a bucket this appliance no longer serves.
    directStore = null;
  };

  const bucket = async (): Promise<{ provider: string; name: string; region: string | null } | null> => {
    await syncVaultCredentials();
    return vaultBucket;
  };

  /** One object's size, for the per-session residency proof. Bounded here rather
   *  than by the store: a bucket that stops answering must cost this request a
   *  named failure, never the console's availability. */
  const canonicalBytes = async (key: {
    family: string;
    sessionId: string;
    userId: string;
  }): Promise<number | null> => {
    await syncVaultCredentials();
    if (!vaultCredentials) throw new Error("this fortress has no object-store credential");
    directStore ??= buildDirectStore(vaultCredentials);
    const store = directStore;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        store.statCanonical(key),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("the object store did not answer in time")), STORE_OP_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  /** The daemon's own config.json, when it parses. The console reads it rather
   *  than keeping a second copy of settings the daemon owns. */
  const daemonConfig = async (): Promise<FortressConfig | null> => {
    const raw = await readJson<unknown>(paths.config);
    if (!raw) return null;
    try {
      return parseFortressConfig(raw);
    } catch {
      return null;
    }
  };

  /** Whether the Sessions module is on, as the daemon's config.json says now.
   *  Null when the file cannot be read: unknown is not "off". */
  const sessionsOn = async (): Promise<boolean | null> => {
    const config = await daemonConfig();
    return config ? sessionsEnabledIn(config) : null;
  };

  const egress = async (): Promise<EgressInputs> => {
    const config: UiConfig = await runtime.readConfig();
    const pgJson = await readPgJson(paths.pgJson).catch(() => null);
    const fortress = await daemonConfig();
    const cloud = fortress?.cloud.url ?? null;
    // Where the external database is comes from its DSN. When pg.json names a
    // secret, the DSN is read to describe the destination, and a secret that
    // cannot be read is reported as unknown rather than guessed.
    const externalUrl =
      pgJson === null || pgJson.mode === "embedded"
        ? null
        : namesDatabaseSecret(pgJson)
          ? (await namedDatabaseUrl(pgJson)).url
          : pgJson.databaseUrl;
    const postgres: EgressInputs["postgres"] =
      pgJson === null
        ? { mode: "unknown" }
        : pgJson.mode === "embedded"
          ? { mode: "embedded", host: pgJson.host, port: pgJson.port, database: pgJson.database }
          : externalUrl === null
            ? { mode: "unknown" }
            : {
                mode: "external",
                host: hostOf(externalUrl),
                database: databaseOf(externalUrl),
                tls: /sslmode=(require|verify)/.test(externalUrl),
              };
    return {
      ui: config,
      boundPort: options.boundPort,
      postgres,
      cloudUrl: cloud,
      downloadBase: cloud ? downloadBaseFromCloudUrl(cloud) : null,
      postgresBinariesUrl: env.FORTRESS_PG_BINARIES_URL ?? DEFAULT_PG_BINARIES_URL,
      bucket: await bucket(),
      rosterRetentionDays: rosterInactivePurgeDays(fortress),
      // The console never holds the embedding key, so the row is present only
      // when the daemon's own configuration names an endpoint.
      embeddingEndpoint: env.FORTRESS_OPENAI_BASE_URL ?? null,
      ssoAdvertised: config.sso,
      // Settings that cannot be read are reported as such, never guessed.
      secrets: await loadSecretsConfig(paths, env).catch(() => null),
      secretNames: secretNamesInUse(pgJson, env),
    };
  };

  const port = createConsoleReadPort({
    paths,
    universe,
    // The registry has always taken this belt and nothing passed one, so a
    // revoked or disabled operator kept receiving the live daemon log until the
    // idle sweep fired — up to an hour. Re-read per check rather than captured:
    // the point is that it changes under an open stream. Keyed on the SESSION,
    // not the login, so the same epoch predicates the request path applies reach
    // the stream — a `reset` (the console's standing lockout remedy) bumps only
    // the epochs, and an eligibility-only belt was blind to it.
    sessionStillValid: async (sessionId: string): Promise<boolean> =>
      runtime.sessions.revocationCheck(sessionId, await runtime.users.load()),
    // Settle the handle rather than racing it — see the read port's `query()`.
    awaitDb: () => refresh(),
    db: () => {
      void refresh();
      return handle?.db ?? null;
    },
    // Same lazy re-read `db()` does, for the same reason. This memo is the only
    // thing the Overview's database tile reads, and it was resolved once at
    // mount: a console started BEFORE Postgres came ready then reported
    // "not configured" until the operator happened to open some other view that
    // touched the database. `refresh()` de-dupes and short-circuits on an
    // unchanged DSN, so a 10s poll costs two file reads.
    database: () => {
      void refresh();
      return databaseState;
    },
    status: () => status.read().catch(() => null),
    // Ask the supervisor only where there IS one. Under an orchestrator, or on
    // a platform this build cannot drive, its "no pid" is the absence of an
    // answer rather than an answer — and taken as one it reported a healthy
    // daemon as stopped and disabled every operational action on this console.
    // The write port already refuses for the same reason (below).
    service: () => (askSupervisor ? service.state().catch(() => ({ loaded: false, pid: null })) : Promise.resolve(null)),
    credentials: () => credentialStore.load().catch(() => null),
    sessionsOn,
    egress,
    // The console process does not build a store: it would need the same
    // bucket-write-capable credential the daemon holds, for facts it can report
    // honestly as unreadable instead.
    store: () => null,
    canonicalBytes,
    bucket,
    streams: runtime.streams,
    producer: createLogEventProducer({ logPath: paths.log, env }),
    downloadBase: () => downloadBase,
    serviceManager: () => options.serviceManager,
    env,
  });

  const write = createConsoleWritePort({
    // Under an orchestrator there is no unit to drive, and the route says so
    // rather than calling a manager that would answer for the wrong lifecycle.
    service: options.serviceManager === "container" ? null : service,
    serviceLogPath: paths.serviceLog,

    db: () => {
      void refresh();
      return handle?.db ?? null;
    },
    // The heartbeat, not updatedAt: a transition-only timestamp says nothing
    // about whether anyone is still polling.
    heartbeatAt: async () => (await status.read().catch(() => null))?.host.writtenAt ?? null,
    offered: OFFERED_COMMAND_KINDS,
    cmdCredsDir: paths.cmdCreds,
    sessionsOn,
  });

  const ready = Promise.all([
    refresh(),
    credentialStore
      .load()
      .then((credential: CloudCredential | null) => {
        if (credential?.orgId) universe.orgExternalId = credential.orgId;
      })
      .catch(() => {}),
    // First read only; every later one is driven by whoever needs the answer.
    // No vault credential at all is a state the storage panel already renders.
    syncVaultCredentials(),
    daemonConfig().then((config) => {
      const url = config?.cloud.url ?? null;
      downloadBase = url ? downloadBaseFromCloudUrl(url) : null;
    }),
  ]).then(() => undefined);

  return { port, write, audit, drain, ready };
}

function hostOf(dsn: string): string {
  try {
    return new URL(dsn).host;
  } catch {
    return "unparseable";
  }
}

function databaseOf(dsn: string): string {
  try {
    return new URL(dsn).pathname.replace(/^\//, "") || "unnamed";
  } catch {
    return "unparseable";
  }
}
