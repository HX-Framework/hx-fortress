import { downloadBaseFromCloudUrl } from "../../update";
import { assertHttpsDownloadUrl } from "../config";
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
   * Download base for the per-platform pgvector artifact. Defaults to the same
   * workbench hx-gateway proxy the binary installer/self-update use (derived
   * from cloud.url); "" when the fortress has no cloud URL yet (pre-enrollment),
   * in which case the inject step self-skips.
   */
  pgvectorUrl: string;
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
  const pgvectorUrl = pick(
    env.FORTRESS_PGVECTOR_URL,
    persisted.pgvectorUrl,
    defaultPgvectorUrl(config.cloud?.url),
  );
  // M-12: re-validate the RESOLVED (env-sourced) download bases — parsePostgresConfig
  // only covers persisted values, not FORTRESS_PG_BINARIES_URL / FORTRESS_PGVECTOR_URL.
  // pgvectorUrl is "" pre-enrollment (the inject self-skips), so skip the empty case.
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

// The pgvector artifact ships as a release asset next to the fortress binaries,
// so it downloads through the same workbench hx-gateway proxy the installer and
// `hx-fortress update` use. Derive that base from the cloud URL; "" when there
// is no cloud URL yet (the inject step then self-skips, best-effort).
function defaultPgvectorUrl(cloudUrl: string | undefined): string {
  const trimmed = cloudUrl?.trim();
  return trimmed ? downloadBaseFromCloudUrl(trimmed) : "";
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
