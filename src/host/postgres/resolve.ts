import { assertHttpsDownloadUrl } from "../config";
import type { Named } from "../daemon-environment";
import type { FortressConfig } from "../types";

export const DEFAULT_PG_VERSION = "18.4.0";
export const DEFAULT_PG_BINARIES_URL = "https://repo1.maven.org/maven2";
// Non-default port: 5432 frequently collides with a system Postgres. The
// embedded server binds 127.0.0.1 only (loopback), never an external interface.
export const DEFAULT_PG_PORT = 54329;

export interface ResolvedPostgresConfig {
  mode: "embedded" | "external";
  version: string;
  binariesUrl: string;
  dataDir: string;
  port: number;
  externalUrl: string | null;
  /**
   * A download base for the per-platform pgvector artifact that this host
   * names for it alone: FORTRESS_PGVECTOR_URL, or postgres.pgvectorUrl in
   * config.json. "" when it names none. The artifact then comes from the
   * update source, where it is published beside the program: see
   * `ensureVector` in ./index.ts. It never comes from a control plane.
   */
  pgvectorUrl: string;
}

/** The two variables that name a download address for Postgres's own files. */
export const PGVECTOR_URL_ENV = "FORTRESS_PGVECTOR_URL";
export const PG_BINARIES_URL_ENV = "FORTRESS_PG_BINARIES_URL";

/**
 * What an environment names for one of those two variables: nothing, an
 * address a download may start from, or why the value is none. An empty value
 * names nothing, as it does for `resolvePostgresConfig`. The daemon writes
 * this down for the console (../daemon-environment.ts), which may run with
 * another environment.
 */
export function downloadUrlNamedBy(
  env: Record<string, string | undefined>,
  variable: typeof PGVECTOR_URL_ENV | typeof PG_BINARIES_URL_ENV,
): Named<string> {
  // One of this file's two constants names the variable.
  // eslint-disable-next-line security/detect-object-injection
  const given = env[variable]?.trim();
  if (!given) return null;
  try {
    assertHttpsDownloadUrl(given, variable);
    return { value: given };
  } catch (error) {
    return { invalid: error instanceof Error ? error.message : String(error) };
  }
}

export function resolvePostgresConfig(
  env: Record<string, string | undefined>,
  config: FortressConfig,
  defaultDataDir: string,
): ResolvedPostgresConfig {
  const persisted = config.postgres ?? {};
  const externalUrl = pick(env.FORTRESS_DATABASE_URL, persisted.externalUrl, null);
  const binariesUrl = pick(
    env.FORTRESS_PG_BINARIES_URL,
    persisted.binariesUrl,
    DEFAULT_PG_BINARIES_URL,
  );
  const pgvectorUrl = pick(env.FORTRESS_PGVECTOR_URL, persisted.pgvectorUrl, "");
  // M-12: re-validate the RESOLVED (env-sourced) download bases — parsePostgresConfig
  // only covers persisted values, not FORTRESS_PG_BINARIES_URL / FORTRESS_PGVECTOR_URL.
  // pgvectorUrl is "" when this host names none, so skip the empty case.
  assertHttpsDownloadUrl(binariesUrl, "FORTRESS_PG_BINARIES_URL");
  if (pgvectorUrl) assertHttpsDownloadUrl(pgvectorUrl, "FORTRESS_PGVECTOR_URL");
  return {
    mode: externalUrl ? "external" : "embedded",
    version: pick(env.FORTRESS_PG_VERSION, persisted.version, DEFAULT_PG_VERSION),
    binariesUrl,
    dataDir: pick(env.FORTRESS_PG_DATA, persisted.dataDir, defaultDataDir),
    port: pickPort(env.FORTRESS_PG_PORT, persisted.port, DEFAULT_PG_PORT),
    externalUrl,
    pgvectorUrl,
  };
}

function pickPort(
  envValue: string | undefined,
  configValue: number | undefined,
  fallback: number,
): number {
  const fromEnv = Number(envValue?.trim());
  if (envValue?.trim() && Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  if (typeof configValue === "number" && Number.isInteger(configValue) && configValue > 0) {
    return configValue;
  }
  return fallback;
}

function pick<T extends string | null>(
  envValue: string | undefined,
  configValue: string | undefined,
  fallback: T,
): string | T {
  const fromEnv = envValue?.trim();
  if (fromEnv) return fromEnv;
  const fromConfig = configValue?.trim();
  if (fromConfig) return fromConfig;
  return fallback;
}
