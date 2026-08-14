import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertModuleId, type fortressPaths } from "./paths";
import { HX_EMBEDDING_DIM } from "./postgres/schema/embeddings";
import { DEFAULT_ROSTER_INACTIVE_PURGE_DAYS } from "../console/roster";
import type {
  ConfigStore,
  FortressConfig,
  FortressPostgresConfig,
  FortressRosterConfig,
} from "./types";

type FortressPaths = ReturnType<typeof fortressPaths>;

export class FileConfigStore implements ConfigStore {
  constructor(private readonly paths: FortressPaths) { }

  async load(): Promise<FortressConfig> {
    let contents: string;
    try {
      contents = await readFile(this.paths.config, "utf8");
    } catch {
      throw invalidConfig("unable to read config.json");
    }

    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch {
      throw invalidConfig("malformed JSON");
    }

    return parseFortressConfig(value);
  }
}

export const DEFAULT_GATEWAY_PORT = 8787;
export const DEFAULT_GATEWAY_PUBLIC_URL = `http://localhost:${DEFAULT_GATEWAY_PORT}`;

export function parseFortressConfig(value: unknown): FortressConfig {
  try {
    if (!isRecord(value)) throw new Error("root must be an object");
    if (value.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
    if (!isRecord(value.cloud)) throw new Error("cloud must be an object");
    if (typeof value.cloud.url !== "string") {
      throw new Error("cloud.url must be a string");
    }
    assertCloudUrl(value.cloud.url);

    const gatewayPublicUrl = parseGatewayPublicUrl(value.gateway);

    if (!isRecord(value.modules)) throw new Error("modules must be an object");
    if (!Array.isArray(value.modules.enabled)) {
      throw new Error("modules.enabled must be an array");
    }
    if (!value.modules.enabled.every((moduleId) => typeof moduleId === "string")) {
      throw new Error("modules.enabled must contain module ids");
    }

    const enabled = value.modules.enabled as string[];
    for (const moduleId of enabled) assertModuleId(moduleId);
    if (new Set(enabled).size !== enabled.length) {
      throw new Error("modules.enabled must contain unique module ids");
    }

    const postgres = parsePostgresConfig(value.postgres);
    const roster = parseRosterConfig(value.roster);

    return {
      schemaVersion: 1,
      cloud: { url: value.cloud.url },
      gateway: { publicUrl: gatewayPublicUrl },
      modules: { enabled: [...enabled] },
      ...(postgres ? { postgres } : {}),
      ...(roster ? { roster } : {}),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid Fortress config:")) {
      throw error;
    }
    throw invalidConfig(errorMessage(error));
  }
}

function parseGatewayPublicUrl(value: unknown): string {
  if (typeof value === "undefined") return DEFAULT_GATEWAY_PUBLIC_URL;
  if (!isRecord(value)) throw new Error("gateway must be an object");
  if (typeof value.publicUrl !== "string") {
    throw new Error("gateway.publicUrl must be a string");
  }
  assertGatewayPublicUrl(value.publicUrl);
  return value.publicUrl;
}

/** Absent means the default. A retention that parsed to something absurd is
 *  refused rather than clamped: it decides when people's records disappear, and
 *  silently substituting a number nobody asked for is the wrong kind of
 *  forgiving. */
function parseRosterConfig(value: unknown): FortressRosterConfig | undefined {
  if (typeof value === "undefined") return undefined;
  if (!isRecord(value)) throw new Error("roster must be an object");
  const days = value.inactivePurgeDays;
  if (typeof days === "undefined") return undefined;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > 3650) {
    throw new Error("roster.inactivePurgeDays must be a whole number of days between 0 and 3650");
  }
  return { inactivePurgeDays: days };
}

/** What the sweep and the `roster purge-inactive` verb actually use. */
export function rosterInactivePurgeDays(config: FortressConfig | null): number {
  return config?.roster?.inactivePurgeDays ?? DEFAULT_ROSTER_INACTIVE_PURGE_DAYS;
}

function parsePostgresConfig(value: unknown): FortressPostgresConfig | undefined {
  if (typeof value === "undefined") return undefined;
  if (!isRecord(value)) throw new Error("postgres must be an object");
  const result: FortressPostgresConfig = {};
  for (const key of ["version", "binariesUrl", "dataDir", "externalUrl", "pgvectorUrl"] as const) {
    const field = value[key];
    if (typeof field === "undefined") continue;
    if (typeof field !== "string") throw new Error(`postgres.${key} must be a string`);
    result[key] = field;
  }
  // Artifact download bases must be https (or loopback http for local dev): a
  // cleartext, non-loopback binaries/pgvector origin is a MITM foothold for the
  // native code we then load. externalUrl is a DB DSN, not a download base, so
  // it is not subject to this check.
  if (result.binariesUrl) assertHttpsDownloadUrl(result.binariesUrl, "postgres.binariesUrl");
  if (result.pgvectorUrl) assertHttpsDownloadUrl(result.pgvectorUrl, "postgres.pgvectorUrl");
  if (typeof value.port !== "undefined") {
    if (typeof value.port !== "number" || !Number.isInteger(value.port)) {
      throw new Error("postgres.port must be an integer");
    }
    result.port = value.port;
  }
  return result;
}

/** A loopback host literal (no DNS resolution). Cleartext ws:/http: is only
 *  tolerable to one of these — anything else is a network-reachable cleartext
 *  hub / download origin. */
export function isLoopbackHost(h: string): boolean {
  const host = h.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** Validate an artifact download base (M-12): https everywhere, with cleartext
 *  http tolerated ONLY for a loopback host (local dev). A plaintext, remotely
 *  reachable origin for native binaries we execute/dlopen is rejected
 *  fail-closed. Shared by config parsing (persisted), resolve.ts (env-sourced),
 *  and the self-updater's cloud-URL derivation. */
export function assertHttpsDownloadUrl(value: string, field: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return;
  throw new Error(`${field} must use https: (cleartext http: is only allowed to a loopback host)`);
}

function assertCloudUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("cloud.url must be a valid URL");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("cloud.url must use ws: or wss:");
  }
  // Cleartext ws: to a non-loopback host would carry the enroll token, the saved
  // credential, and every tunneled vault RPC in the clear. Permit it only to a
  // loopback hub (local dev); every real hub must be wss:.
  if (url.protocol === "ws:" && !isLoopbackHost(url.hostname)) {
    throw new Error("cloud.url must use wss: (cleartext ws: is only allowed to a loopback hub)");
  }
}

export function assertGatewayPublicUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("gateway.publicUrl must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("gateway.publicUrl must use http: or https:");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidConfig(reason: string): Error {
  return new Error(`Invalid Fortress config: ${reason}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown validation error";
}

// ── Ingest gateway ──────────────────────────────────────────────────────────

export interface GatewayConfig {
  enabled: boolean;
  gatewayUrl?: string;
  port: number;
}

/** Resolve the direct-ingest ("fortress-direct") gateway settings. MC-2382
 *  retired this path: by default hx uploads relay over the reverse tunnel, so the
 *  fortress advertises no public URL and the local gateway server stays off. A
 *  public URL is advertised ONLY when the operator opts in via FORTRESS_PUBLIC_URL
 *  (the persisted localhost default is local-only, never advertised).
 *  FORTRESS_GATEWAY_PORT overrides the listen port. */
export function resolveGatewayConfig(
  env: Record<string, string | undefined>,
  // _persistedGatewayUrl?: string,
): GatewayConfig {
  const gatewayUrl = env.FORTRESS_PUBLIC_URL?.trim();
  const port = Number(env.FORTRESS_GATEWAY_PORT) || DEFAULT_GATEWAY_PORT;
  return { enabled: Boolean(gatewayUrl), gatewayUrl: gatewayUrl || undefined, port };
}

// ── Embed worker (A3) ─────────────────────────────────────────────────────

export interface EmbedConfig {
  /** True only when FORTRESS_OPENAI_API_KEY is set — otherwise the worker stays
   *  off and hx_semantic_search degrades to keyword. */
  enabled: boolean;
  apiKey: string;
  model: string;
  dimensions: number;
  /** OpenAI endpoint base (override for a zero-retention / DPA endpoint). */
  baseUrl: string;
  /** The worker's OWN Bun.SQL pool cap (the createHxDb handle is uncapped). */
  dbMax: number;
  concurrency: number;
  batchSize: number;
  maxPerPass: number;
  debounceMs: number;
  maxWaitMs: number;
  /** M-9e durable daily OpenAI token budget. 0 ⇒ unlimited (no accounting). */
  dailyTokenBudget: number;
  /** MC-2517 · QUERY-path embed bounds (hx_semantic_search). Each query embed
   *  attempt is capped at `queryTimeoutMs` and retried up to `queryMaxRetries`
   *  times, so a stalled OpenAI call fails fast with a typed `unavailable` (relayed
   *  to the user) instead of hanging the search until the workbench kills it. The
   *  BACKGROUND worker keeps its own unbounded, high-retry behavior. */
  queryTimeoutMs: number;
  queryMaxRetries: number;
}

function intEnv(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Like intEnv but admits 0 (used where 0 is a meaningful "unlimited" sentinel);
 *  a negative or non-numeric value still falls back. */
function intEnvAllowingZero(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/** M-5 · resolve + validate the OpenAI embeddings base URL. Embeddings are
 *  third-party egress of conversational text, so the endpoint must be https
 *  (the default already is); a plaintext or malformed override is rejected
 *  fail-closed rather than silently downgrading the egress. Trailing slash is
 *  stripped so `${base}/embeddings` never doubles up. */
function resolveOpenAiBaseUrl(value: string | undefined): string {
  const raw = value?.trim();
  if (!raw) return DEFAULT_OPENAI_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("FORTRESS_OPENAI_BASE_URL must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("FORTRESS_OPENAI_BASE_URL must use https:");
  }
  return raw.replace(/\/+$/, "");
}

// hx.embeddings.embedding is vector(HX_EMBEDDING_DIM = 1024). text-embedding-3-large
// supports Matryoshka dims 256..3072; a value outside that range is nonsensical for the
// model (OpenAI would 400), so fall back to 1024 rather than crash the embed worker.
// NOTE: the column is fixed at 1024 — ANY non-1024 dimension needs a migration to
// widen/narrow the vector column, so the safest value is 1024 unless the column is migrated.
const EMBED_DIM_MIN = 256;
const EMBED_DIM_MAX = 3072;

/** Range-validate FORTRESS_EMBED_DIMENSIONS, falling back to the column width (1024)
 *  when out of the model's valid Matryoshka range. */
function resolveEmbedDimensions(value: string | undefined): number {
  const dims = intEnv(value, HX_EMBEDDING_DIM);
  return dims >= EMBED_DIM_MIN && dims <= EMBED_DIM_MAX ? dims : HX_EMBEDDING_DIM;
}

/** Resolve the embed worker's settings from FORTRESS_* env. The OpenAI key (the
 *  one HUMAN input, §13-A3) gates the whole feature: absent ⇒ disabled. Model
 *  defaults match the spec — text-embedding-3-large @ 1024 (Matryoshka). */
export function resolveEmbedConfig(
  env: Record<string, string | undefined>,
  configKey?: string,
): EmbedConfig {
  // Env overrides the persisted key (ops flexibility); otherwise use the key the
  // enroll wizard wrote to credentials.json (MC-2465).
  const apiKey = env.FORTRESS_OPENAI_API_KEY?.trim() || configKey?.trim() || "";
  return {
    enabled: apiKey.length > 0,
    apiKey,
    model: env.FORTRESS_EMBED_MODEL?.trim() || "text-embedding-3-large",
    dimensions: resolveEmbedDimensions(env.FORTRESS_EMBED_DIMENSIONS),
    baseUrl: resolveOpenAiBaseUrl(env.FORTRESS_OPENAI_BASE_URL),
    dbMax: intEnv(env.FORTRESS_EMBED_DB_MAX, 4),
    concurrency: intEnv(env.FORTRESS_EMBED_CONCURRENCY, 2),
    batchSize: intEnv(env.FORTRESS_EMBED_BATCH, 96),
    maxPerPass: intEnv(env.FORTRESS_EMBED_MAX_PER_PASS, 500),
    debounceMs: intEnv(env.FORTRESS_EMBED_DEBOUNCE_MS, 5_000),
    maxWaitMs: intEnv(env.FORTRESS_EMBED_MAX_WAIT_MS, 30 * 60_000),
    dailyTokenBudget: intEnvAllowingZero(env.FORTRESS_EMBED_DAILY_TOKEN_BUDGET, 5_000_000),
    // MC-2517 · the query-embed budget nests UNDER the workbench 60s MCP ceiling:
    // ~3 attempts × 10s + capped backoff ≈ 33s worst case, then a typed `unavailable`.
    // Raising these env vars past the ~55s fortress dispatch backstop only degrades
    // the message (generic fortress_unreachable vs typed openai_temporarily_unavailable),
    // never a silent kill — the backstop still returns a typed error before the 60s.
    queryTimeoutMs: intEnv(env.FORTRESS_EMBED_QUERY_TIMEOUT_MS, 10_000),
    queryMaxRetries: intEnvAllowingZero(env.FORTRESS_EMBED_QUERY_MAX_RETRIES, 2),
  };
}

/** The RAW on-disk object.
 *
 *  parseFortressConfig models only the keys the host reads, so writing its
 *  result back is lossy: every `ensure*` migration below rebuilds config.json
 *  from that model, and anything the parser does not know about — a block a
 *  later version adds, a hand-edited key — disappears on the next boot. The
 *  writers merge their result OVER this instead. */
async function readRawConfig(paths: FortressPaths): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(paths.config, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function ensureGatewayPublicUrlConfigured(
  paths: FortressPaths,
  gatewayPublicUrl = DEFAULT_GATEWAY_PUBLIC_URL,
): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(paths.config, "utf8");
  } catch {
    return;
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return;
  }

  if (isRecord(value) && isRecord(value.gateway) && typeof value.gateway.publicUrl === "string") {
    return;
  }

  assertGatewayPublicUrl(gatewayPublicUrl);
  // parseFortressConfig has already validated `value` here, so preserving the
  // rest of it cannot reintroduce something invalid.
  const normalized = parseFortressConfig(value);
  await writeConfig(
    paths,
    { ...normalized, gateway: { publicUrl: gatewayPublicUrl } },
    isRecord(value) ? value : null,
  );
}

/** Migrate an existing config.json to include any core modules not yet listed
 *  in modules.enabled. No-op if config doesn't exist yet or is already up to date. */
export async function ensureCoreModulesEnabled(paths: FortressPaths): Promise<void> {
  let config: FortressConfig;
  try {
    config = await new FileConfigStore(paths).load();
  } catch {
    return;
  }

  const missing = CORE_MODULE_IDS.filter((id) => !config.modules.enabled.includes(id));
  if (missing.length === 0) return;

  const updated: FortressConfig = {
    ...config,
    modules: { enabled: [...config.modules.enabled, ...missing] },
  };
  await writeConfig(paths, updated, await readRawConfig(paths));
}

/** Bundled modules that must always be enabled. Added to new configs by default
 *  and migrated into existing configs by ensureCoreModulesEnabled. */
export const CORE_MODULE_IDS: readonly string[] = ["session_vault"];

/** Creates config.json with a minimal valid config if it does not already exist.
 *  Called by the host on startup when a pending enrollment is present. */
export async function ensureDefaultConfig(
  paths: FortressPaths,
  cloudUrl: string,
  gatewayPublicUrl = DEFAULT_GATEWAY_PUBLIC_URL,
): Promise<void> {
  try {
    await access(paths.config);
    return;
  } catch {
    // file absent — write the default below
  }

  assertGatewayPublicUrl(gatewayPublicUrl);

  const config: FortressConfig = {
    schemaVersion: 1,
    cloud: { url: cloudUrl },
    gateway: { publicUrl: gatewayPublicUrl },
    modules: { enabled: [...CORE_MODULE_IDS] },
  };

  await mkdir(path.dirname(paths.config), { recursive: true, mode: 0o700 });
  await writeConfig(paths, config);
}

/** Creates or updates config.json for an explicit enrollment attempt.
 *  A pending enrollment is the operator's current install intent, so the cloud
 *  URL must point at that enrollment even when an old config already exists. */
export async function ensureEnrollmentConfig(
  paths: FortressPaths,
  cloudUrl: string,
  gatewayPublicUrl?: string,
): Promise<void> {
  if (gatewayPublicUrl) assertGatewayPublicUrl(gatewayPublicUrl);

  const existing = await new FileConfigStore(paths).load().catch(() => null);

  const config: FortressConfig = {
    schemaVersion: 1,
    cloud: { url: cloudUrl },
    gateway: { publicUrl: gatewayPublicUrl ?? existing?.gateway.publicUrl ?? DEFAULT_GATEWAY_PUBLIC_URL },
    modules: existing?.modules ?? { enabled: [...CORE_MODULE_IDS] },
    // Carried EXPLICITLY: re-enrolling used to drop the whole postgres block,
    // which silently moved a fortress configured against an external database
    // onto a fresh embedded cluster — its data still there, invisible.
    ...(existing?.postgres ? { postgres: existing.postgres } : {}),
    // Same reason: a retention the operator shortened must not spring back to
    // the default because the fortress was re-enrolled.
    ...(existing?.roster ? { roster: existing.roster } : {}),
  };

  // Only preserve the raw object when the config actually parsed: merging over
  // an unparseable file would carry its invalid keys forward.
  await writeConfig(paths, config, existing ? await readRawConfig(paths) : null);
}

async function writeConfig(
  paths: FortressPaths,
  config: FortressConfig,
  preserve: Record<string, unknown> | null = null,
): Promise<void> {
  // The validated fields win; everything else the file already carried rides
  // through untouched.
  const merged = preserve ? { ...preserve, ...config } : config;
  // config.json holds the enrolled cloud origin; keep its directory owner-only
  // (0700) and the file owner-only (0600) — belt-and-suspenders chmod after write
  // because the writeFile mode is still masked by the process umask.
  await mkdir(path.dirname(paths.config), { recursive: true, mode: 0o700 });
  const tmp = `${paths.config}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, paths.config);
}
