import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertModuleId, type fortressPaths } from "./paths";
import { HX_EMBEDDING_DIM } from "./postgres/schema/embeddings";
import { DEFAULT_ROSTER_INACTIVE_PURGE_DAYS } from "../console/roster";
import { isSecretName } from "../secrets/types";
import { writePrivateJson } from "./private-json";
import type {
  ConfigStore,
  FortressConfig,
  FortressConnectionConfig,
  FortressModelConfig,
  FortressNetworkConfig,
  FortressOrganizationConfig,
  FortressPostgresConfig,
  FortressRecordsConfig,
  FortressRosterConfig,
  FortressUpdatesConfig,
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
    const cloud = parseCloudConfig(value.cloud);

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
    const connection = parseConnectionConfig(value);
    const organization = parseOrganizationConfig(value.organization);
    const model = parseModelConfig(value.model);
    const network = parseNetworkConfig(value.network);
    const records = parseRecordsConfig(value.records);
    const updates = parseUpdatesConfig(value.updates);

    return {
      schemaVersion: 1,
      ...(cloud ? { cloud } : {}),
      gateway: { publicUrl: gatewayPublicUrl },
      modules: { enabled: [...enabled] },
      ...(postgres ? { postgres } : {}),
      ...(roster ? { roster } : {}),
      ...(connection ? { connection } : {}),
      ...(organization ? { organization } : {}),
      ...(model ? { model } : {}),
      ...(network ? { network } : {}),
      ...(records ? { records } : {}),
      ...(updates ? { updates } : {}),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid HX Fortress config:")) {
      throw error;
    }
    throw invalidConfig(errorMessage(error));
  }
}

/**
 * The control plane, or undefined when this Fortress has none.
 *
 * An absent `cloud` key is a Fortress that runs on its own. A key that is
 * there and is not a usable address is still refused: a mistyped address must
 * not start a Fortress that then connects to nothing without a word.
 */
function parseCloudConfig(value: unknown): FortressConfig["cloud"] {
  if (typeof value === "undefined") return undefined;
  if (!isRecord(value)) throw new Error("cloud must be an object");
  if (typeof value.url !== "string") {
    throw new Error("cloud.url must be a string");
  }
  assertCloudUrl(value.url);
  return { url: value.url };
}

/** An option's id in the setup's list: lower-case words joined by "-". */
const OPTION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
function optionId(value: unknown, field: string): string {
  if (typeof value !== "string" || !OPTION_ID_PATTERN.test(value)) {
    throw new Error(`${field} must be the id of an option`);
  }
  return value;
}

function keyName(value: unknown, field: string): string {
  // The value is not repeated: a key pasted where its name belongs would
  // otherwise travel with the error.
  if (!isSecretName(value)) {
    throw new Error(`${field} must be the name of a key: 1 to 64 characters of a-z, 0-9 and "-"`);
  }
  return value as string;
}

function parseOrganizationConfig(value: unknown): FortressOrganizationConfig | undefined {
  if (typeof value === "undefined") return undefined;
  if (!isRecord(value)) throw new Error("organization must be an object");
  if (typeof value.name !== "string" || !isOrganizationName(value.name)) {
    throw new Error("organization.name must be 1 to 80 characters, with no control character");
  }
  return { name: value.name };
}

/** 1 to 80 characters, none of them a control character. */
export function isOrganizationName(name: string): boolean {
  if (name.length < 1 || name.length > 80 || name !== name.trim()) return false;
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function parseModelConfig(value: unknown): FortressModelConfig | undefined {
  if (typeof value === "undefined") return undefined;
  if (!isRecord(value)) throw new Error("model must be an object");
  const model: FortressModelConfig = { provider: optionId(value.provider, "model.provider") };
  if (typeof value.address !== "undefined") {
    if (typeof value.address !== "string") throw new Error("model.address must be a string");
    // Text of the organization is sent to this address, so it is held to the
    // same rule as every other outside call: https, or this host itself.
    assertHttpsDownloadUrl(value.address, "model.address");
    model.address = value.address;
  }
  if (typeof value.key !== "undefined") model.key = keyName(value.key, "model.key");
  if (typeof value.name !== "undefined") {
    if (typeof value.name !== "string" || !/^[\x21-\x7e]{1,128}$/.test(value.name)) {
      throw new Error("model.name must be 1 to 128 printable characters with no spaces");
    }
    model.name = value.name;
  }
  return model;
}

function parseNetworkConfig(value: unknown): FortressNetworkConfig | undefined {
  if (typeof value === "undefined") return undefined;
  if (!isRecord(value)) throw new Error("network must be an object");
  if (typeof value.proxy === "undefined") return {};
  if (typeof value.proxy !== "string") throw new Error("network.proxy must be a string");
  let url: URL;
  try {
    url = new URL(value.proxy);
  } catch {
    throw new Error("network.proxy must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("network.proxy must use http: or https:");
  }
  return { proxy: value.proxy };
}

function parseRecordsConfig(value: unknown): FortressRecordsConfig | undefined {
  if (typeof value === "undefined") return undefined;
  if (!isRecord(value)) throw new Error("records must be an object");
  const records: FortressRecordsConfig = { keepFor: optionId(value.keepFor, "records.keepFor") };
  if (typeof value.copyTo !== "undefined") {
    if (!isRecord(value.copyTo)) throw new Error("records.copyTo must be an object");
    records.copyTo = { to: optionId(value.copyTo.to, "records.copyTo.to") };
    if (typeof value.copyTo.address !== "undefined") {
      if (typeof value.copyTo.address !== "string" || value.copyTo.address.length > 1024) {
        throw new Error("records.copyTo.address must be a string");
      }
      records.copyTo.address = value.copyTo.address;
    }
  }
  return records;
}

function parseUpdatesConfig(value: unknown): FortressUpdatesConfig | undefined {
  if (typeof value === "undefined") return undefined;
  if (!isRecord(value)) throw new Error("updates must be an object");
  const updates: FortressUpdatesConfig = {
    from: optionId(value.from, "updates.from"),
    install: optionId(value.install, "updates.install"),
  };
  if (typeof value.address !== "undefined") {
    if (typeof value.address !== "string" || value.address.length > 1024) {
      throw new Error("updates.address must be a string");
    }
    updates.address = value.address;
  }
  return updates;
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

/** The keys a `connection` block may hold. */
const CONNECTION_KEYS: ReadonlySet<string> = new Set(["sessionContent"]);

/** The setting's name in a file's text, with any of the marks a hand puts
 *  between its two words: `session_content`, `session-content`,
 *  `session.content`, `sessionContent`. */
const SESSION_CONTENT_LIKE = /session[\s_.-]*content/i;

/** The letters of a key, in lower case. Two spellings of one name have the
 *  same letters: `sessionContent`, `session_content`, `SESSION-CONTENT`. */
const lettersOf = (key: string): string => key.toLowerCase().replace(/[^a-z]/g, "");
const SETTING_LETTERS = "sessioncontent";
const BLOCK_LETTERS: ReadonlySet<string> = new Set(["connection", "connections"]);

/** How far into the file the setting is looked for. A config.json is a few
 *  levels deep and holds a few dozen keys. Past these the look stops: it is a
 *  help against a slip of the hand, and no file is refused for its size. */
const LOOK_MAX_DEPTH = 8;
const LOOK_MAX_KEYS = 5_000;

/** A key of the operator's own file, short enough to say back. */
const said = (key: string): string => JSON.stringify(key.length > 40 ? `${key.slice(0, 40)}...` : key);

/**
 * Where a config.json holds the setting's name outside `connection`: the
 * keys that lead there, or null when it holds it nowhere else.
 *
 * Looked for at every depth, in the letters of each key, so another spelling
 * and another place are both found. The one key that is not looked into is
 * the file's own `connection`, which has a rule of its own.
 */
function settingElsewhere(root: Record<string, unknown>): string[] | null {
  let keys = 0;
  const look = (value: unknown, at: string[], depth: number): string[] | null => {
    if (depth >= LOOK_MAX_DEPTH || typeof value !== "object" || value === null) return null;
    const list = Array.isArray(value);
    for (const [key, inside] of Object.entries(value)) {
      keys += 1;
      if (keys > LOOK_MAX_KEYS) return null;
      if (depth === 0 && key === "connection") continue;
      // An index of a list is not a name a person wrote.
      const here = list ? at : [...at, key];
      if (!list && lettersOf(key).includes(SETTING_LETTERS)) return here;
      const found = look(inside, here, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return look(root, [], 0);
}

/**
 * What a raw config.json says about session content, or why that cannot be
 * read. This is the one place the rule is written.
 *
 * `connection.sessionContent` is `on` or `off`, or it is not there. Anything
 * else is refused, and this HX Fortress does not start: a choice that is written
 * wrongly must not be read as "nobody chose", because an HX Fortress where nobody
 * chose still serves session calls. So each of these is refused too:
 *
 *   - a `connection` block with a key this build does not know, which is how
 *     a misspelled `sessionContent` inside it would otherwise be ignored;
 *   - a block at the top of the file that is `connection` in another spelling:
 *     `Connection`, `connections`;
 *   - the setting's name anywhere else in the file, at any depth and in any
 *     spelling that keeps its letters: `session_content`, `sessionContent`
 *     under `cloud`.
 *
 * WHAT THIS DOES NOT SEE: a name that is misspelled in its letters AND is in
 * the wrong place, such as `sesionContent` at the top of the file. No rule can
 * tell that from a key this build does not know, and such keys are kept as
 * they are. `hx-fortress status` prints what the running daemon goes by, which
 * is how a person checks that a choice reached it.
 */
function readSessionContent(
  raw: Record<string, unknown>,
): { ok: true; sessionContent: "on" | "off" | null } | { ok: false; reason: string } {
  const misspelled = Object.keys(raw).find((key) => key !== "connection" && BLOCK_LETTERS.has(lettersOf(key)));
  if (misspelled !== undefined) {
    return {
      ok: false,
      reason: `the block that holds the choice about session content is named connection, and this file has ${said(misspelled)}`,
    };
  }
  const elsewhere = settingElsewhere(raw);
  if (elsewhere) {
    return {
      ok: false,
      reason:
        "the choice about session content is read only from connection.sessionContent, and this file has it under " +
        said(elsewhere.join(".")),
    };
  }
  const { connection } = raw;
  if (typeof connection === "undefined") return { ok: true, sessionContent: null };
  if (!isRecord(connection)) return { ok: false, reason: "connection must be an object" };
  const unknown = Object.keys(connection).find((key) => !CONNECTION_KEYS.has(key));
  if (unknown !== undefined) {
    return {
      ok: false,
      reason: `connection has a key this build does not know, ${said(unknown)}; its one key is sessionContent`,
    };
  }
  const { sessionContent } = connection;
  if (typeof sessionContent === "undefined") return { ok: true, sessionContent: null };
  if (sessionContent !== "on" && sessionContent !== "off") {
    return { ok: false, reason: 'connection.sessionContent must be "on" or "off"' };
  }
  return { ok: true, sessionContent };
}

function parseConnectionConfig(raw: Record<string, unknown>): FortressConnectionConfig | undefined {
  const read = readSessionContent(raw);
  if (!read.ok) throw new Error(read.reason);
  return read.sessionContent ? { sessionContent: read.sessionContent } : undefined;
}

/** The variable that says whether session content may travel on the connection. */
export const SESSION_CONTENT_ENV = "FORTRESS_CONNECTION_SESSION_CONTENT";

/**
 * FORTRESS_CONNECTION_SESSION_CONTENT=on|off says whether session content may
 * travel on the connection, for this start and every start with it set. It
 * wins over config.json. Not set means config.json decides.
 *
 * A value that is neither word stops the start, as a wrong FORTRESS_SESSIONS
 * does. So does a variable that is set and empty: a template whose value was
 * left blank must not start an HX Fortress that serves session calls.
 */
export function sessionContentFromEnv(env: Record<string, string | undefined>): "on" | "off" | null {
  // A variable that only looks like the setting would be ignored without a
  // word, and this HX Fortress would then serve session calls. One counts as a
  // look-alike when it is meant for this program (its name starts with
  // FORTRESS_ or HX_FORTRESS_, in any case), holds a value, and has the
  // setting's letters in its name: FORTRESS_SESSION_CONTENT,
  // FORTRESS_CONNECTION_SESSION_CONTENTS, the right name in lower case.
  const lookalike = Object.keys(env).find(
    (name) =>
      name !== SESSION_CONTENT_ENV &&
      /^(hx_?)?fortress_/i.test(name) &&
      lettersOf(name).includes(SETTING_LETTERS) &&
      // `name` is one of the object's own keys.
      // eslint-disable-next-line security/detect-object-injection
      (env[name] ?? "").trim() !== "",
  );
  if (lookalike !== undefined) {
    const shown = /^[A-Za-z0-9_]{1,64}$/.test(lookalike) ? lookalike : "A variable of this HX Fortress";
    throw new Error(
      `${shown} is not a setting. Whether session content may travel on the connection is ${SESSION_CONTENT_ENV}`,
    );
  }
  const given = env.FORTRESS_CONNECTION_SESSION_CONTENT;
  if (given === undefined) return null;
  const word = given.trim().toLowerCase();
  if (word === "on") return "on";
  if (word === "off") return "off";
  throw new Error(
    word === ""
      ? "FORTRESS_CONNECTION_SESSION_CONTENT is set and empty: it must be on or off"
      : "FORTRESS_CONNECTION_SESSION_CONTENT must be on or off",
  );
}

/** What a start does about session content: the variable first, then
 *  config.json, and `null` when neither says. `fromEnv` is what
 *  `sessionContentFromEnv` gave. */
export function resolveSessionContent(
  fromEnv: "on" | "off" | null,
  config: Pick<FortressConfig, "connection"> | null,
): "on" | "off" | null {
  return fromEnv ?? config?.connection?.sessionContent ?? null;
}

/**
 * A config store for the runtime, which connects with the config it loads.
 *
 * A start decides about session content once, from a read of config.json that
 * comes before this one. If that read failed for a moment, or the file was
 * changed in between, this load could give a config that says `off` to a start
 * that decided "nobody chose". So the config loaded here must say what was
 * decided, or the load fails and this HX Fortress does not connect.
 */
export function configStoreAgreeingOnSessionContent(
  store: ConfigStore,
  fromEnv: "on" | "off" | null,
  decided: () => "on" | "off" | null,
): ConfigStore {
  return {
    load: async () => {
      const config = await store.load();
      if (resolveSessionContent(fromEnv, config) !== decided()) {
        throw invalidConfig("what config.json says about session content changed while this HX Fortress was starting");
      }
      return config;
    },
  };
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
  if (typeof value.urlSecret !== "undefined") {
    result.urlSecret = keyName(value.urlSecret, "postgres.urlSecret");
    // One of them would be ignored, and which one is not something to leave
    // to a reader's guess.
    if (result.externalUrl) {
      throw new Error("postgres.externalUrl and postgres.urlSecret are both set. Set one of them");
    }
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
  return new Error(`Invalid HX Fortress config: ${reason}`);
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
   *  to the user) instead of hanging the search until the control plane kills it. The
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

/** Where the embedding requests go when no address is set. */
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

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
  // A model that runs on this host itself is not an outside call, so cleartext
  // to a loopback address is allowed. Anywhere else stays https.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error("FORTRESS_OPENAI_BASE_URL must use https: (http: is allowed only to this host itself)");
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
  /** The `model` block of config.json, as the setup wrote it: the address and
   *  the model's own name. The environment wins over both, as it does over the
   *  key. */
  model?: Pick<FortressModelConfig, "address" | "name"> | null,
): EmbedConfig {
  // Env overrides the persisted key (ops flexibility); otherwise use the key
  // read by name from the key store, or the one an earlier setup wrote to
  // credentials.json (MC-2465).
  const apiKey = env.FORTRESS_OPENAI_API_KEY?.trim() || configKey?.trim() || "";
  return {
    enabled: apiKey.length > 0,
    apiKey,
    model: env.FORTRESS_EMBED_MODEL?.trim() || model?.name?.trim() || "text-embedding-3-large",
    dimensions: resolveEmbedDimensions(env.FORTRESS_EMBED_DIMENSIONS),
    baseUrl: resolveOpenAiBaseUrl(env.FORTRESS_OPENAI_BASE_URL?.trim() || model?.address),
    dbMax: intEnv(env.FORTRESS_EMBED_DB_MAX, 4),
    concurrency: intEnv(env.FORTRESS_EMBED_CONCURRENCY, 2),
    batchSize: intEnv(env.FORTRESS_EMBED_BATCH, 96),
    maxPerPass: intEnv(env.FORTRESS_EMBED_MAX_PER_PASS, 500),
    debounceMs: intEnv(env.FORTRESS_EMBED_DEBOUNCE_MS, 5_000),
    maxWaitMs: intEnv(env.FORTRESS_EMBED_MAX_WAIT_MS, 30 * 60_000),
    dailyTokenBudget: intEnvAllowingZero(env.FORTRESS_EMBED_DAILY_TOKEN_BUDGET, 5_000_000),
    // MC-2517 · the query-embed budget nests UNDER the control plane's 60s MCP ceiling:
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

/** The Sessions module: AI session transcripts in the organization's bucket. */
export const SESSIONS_MODULE_ID = "session_vault";

/** Modules that are always on. There are none: a fortress can run without the
 *  Sessions module. A module command refuses to switch off an id listed here. */
export const CORE_MODULE_IDS: readonly string[] = [];

/**
 * Modules that are on by default. Sessions is on by default, as it was when it
 * could not be switched off.
 */
export const DEFAULT_MODULE_IDS: readonly string[] = [SESSIONS_MODULE_ID];

/**
 * The key in config.json that says the default modules were applied and the
 * list is now the operator's own.
 *
 * Without it, a start adds the default modules that are missing from
 * `modules.enabled`, as every version before this one did. With it, nothing is
 * added back, so a module that was switched off stays off.
 *
 * It is written only together with a change to the list. A config.json that
 * already lists the defaults is left exactly as it is, so one that cannot be
 * replaced (a read-only or single-file mount) does not stop the start.
 *
 * It is a top-level key of the raw file. The typed config does not carry it.
 */
export const MODULE_DEFAULTS_KEY = "moduleDefaultsApplied";

/** `on` or `off` from FORTRESS_SESSIONS, or null when it is not set. */
export type SessionsSetting = "on" | "off" | null;

/**
 * What stands in the way of writing a new config.json over the one on disk
 * without losing a choice about session content, or null when nothing does.
 *
 * An enrollment writes a fresh file when the one on disk does not pass its
 * check. That must never drop the choice: an HX Fortress where nobody chose serves
 * session calls. So the enrollment is refused, and the file is left as the
 * operator wrote it, when:
 *
 *   - the file is there and could not be read;
 *   - the file is not JSON and its text mentions the setting, as a file with a
 *     comment or a trailing comma does;
 *   - the file is JSON and what it says about the setting cannot be read.
 */
async function sessionContentInTheWay(paths: FortressPaths): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(paths.config, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? null
      : "config.json is there and could not be read, so what it says about session content is not known";
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return SESSION_CONTENT_LIKE.test(text)
      ? "config.json is not valid JSON and it mentions session content; fix the file, and the choice in it is kept"
      : null;
  }
  if (!isRecord(value)) return null;
  const read = readSessionContent(value);
  return read.ok ? null : read.reason;
}

/** `connection.sessionContent` of a raw config.json, when it is one of the two
 *  words. Null when it is not there. */
function sessionContentIn(raw: Record<string, unknown> | null): "on" | "off" | null {
  const read = raw ? readSessionContent(raw) : null;
  return read?.ok ? read.sessionContent : null;
}

/**
 * FORTRESS_SESSIONS=on|off switches the Sessions module at every boot, the way
 * a container's other settings are applied from its environment. Unset means
 * config.json decides. A value that is neither is refused: a mistyped "off"
 * must not start a fortress that stores sessions.
 */
export function sessionsSettingFromEnv(env: Record<string, string | undefined>): SessionsSetting {
  const raw = env.FORTRESS_SESSIONS?.trim().toLowerCase();
  if (!raw) return null;
  // Two words and no others. The README says a value that is neither stops
  // the start, and an operator may rely on that to catch a mistake.
  if (raw === "on") return "on";
  if (raw === "off") return "off";
  throw new Error("FORTRESS_SESSIONS must be on or off");
}

/** Whether a config has the Sessions module on. A fortress with no config yet
 *  counts as on, which is the default it will be given. */
export function sessionsEnabledIn(config: Pick<FortressConfig, "modules"> | null): boolean {
  return config ? config.modules.enabled.includes(SESSIONS_MODULE_ID) : true;
}

/** True for something the config check accepts as one module id. */
function isUsableModuleId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  try {
    assertModuleId(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * The module list a raw config.json states, or null when it states none that
 * can be used: no file, no list, or a list the config check itself refuses (an
 * entry that is not a module id, or an id twice).
 *
 * The rule is the config check's own. A list that is carried over from a file
 * that did not pass the check must never be the reason the next file does not
 * pass it either: a mistyped id would then survive every re-enrollment, and
 * the fortress could not start.
 */
function enabledModulesIn(raw: Record<string, unknown> | null): string[] | null {
  const modules = raw?.modules;
  if (!isRecord(modules) || !Array.isArray(modules.enabled)) return null;
  const enabled: unknown[] = modules.enabled;
  if (!enabled.every(isUsableModuleId)) return null;
  return new Set(enabled).size === enabled.length ? [...enabled] : null;
}

function defaultsApplied(raw: Record<string, unknown> | null): boolean {
  // `MODULE_DEFAULTS_KEY` is a constant of this file.
  // eslint-disable-next-line security/detect-object-injection
  return raw?.[MODULE_DEFAULTS_KEY] === 1;
}

/**
 * What config.json on disk says the next start will do about Sessions: on,
 * off, or null when it says nothing that can be used (no file, no list).
 *
 * It applies the same rule a start applies. A list that leaves the module out
 * means off only when the file also says the defaults were applied. Without
 * that key the next start adds the module, so the answer is on.
 *
 * A file that does not pass the whole check may still state its list clearly,
 * and then the list is used: one bad field elsewhere must not switch Sessions
 * back on for an operator who switched it off.
 */
export async function sessionsStatedOnDisk(paths: FortressPaths): Promise<boolean | null> {
  const raw = await readRawConfig(paths);
  const config = await new FileConfigStore(paths).load().catch(() => null);
  const listed = config ? config.modules.enabled : enabledModulesIn(raw);
  if (!listed) return null;
  return listed.includes(SESSIONS_MODULE_ID) || !defaultsApplied(raw);
}

/** The same, with the default for a fortress that has no usable config yet: on. */
export async function sessionsChosenOnDisk(paths: FortressPaths): Promise<boolean> {
  return (await sessionsStatedOnDisk(paths)) ?? true;
}

/**
 * Bring `modules.enabled` to what it should be at boot.
 *
 * - The default modules that are missing are added to a config that never had
 *   them applied (see MODULE_DEFAULTS_KEY).
 * - `sessions` switches the Sessions module on or off, when it is given.
 *
 * The file is written only when the list changes, or when a list that leaves
 * a default out has to be marked as the operator's own.
 *
 * No-op when config.json does not exist yet or cannot be read.
 */
export async function ensureCoreModulesEnabled(
  paths: FortressPaths,
  options: { sessions?: SessionsSetting } = {},
): Promise<void> {
  let config: FortressConfig;
  try {
    config = await new FileConfigStore(paths).load();
  } catch {
    return;
  }

  const raw = await readRawConfig(paths);
  const applied = defaultsApplied(raw);
  let enabled = [...config.modules.enabled];
  const add = (id: string): void => {
    if (!enabled.includes(id)) enabled.push(id);
  };
  if (!applied) DEFAULT_MODULE_IDS.forEach(add);
  CORE_MODULE_IDS.forEach(add);
  if (options.sessions === "on") add(SESSIONS_MODULE_ID);
  if (options.sessions === "off") enabled = enabled.filter((id) => id !== SESSIONS_MODULE_ID);

  const unchanged =
    enabled.length === config.modules.enabled.length &&
    enabled.every((id, index) => id === config.modules.enabled[index]);
  // A list that leaves a default out stays that way only with the key. A list
  // that holds every default needs no key, and the file is left alone.
  const needsKey = !applied && !DEFAULT_MODULE_IDS.every((id) => enabled.includes(id));
  if (unchanged && !needsKey) return;

  await writeConfig(
    paths,
    { ...config, modules: { enabled } },
    { ...(raw ?? {}), [MODULE_DEFAULTS_KEY]: 1 },
  );
}

/**
 * Switch the Sessions module on or off in config.json. The setup paths call
 * this with the operator's answer. The daemon reads it when it starts.
 *
 * It throws when the answer cannot be saved, because config.json is missing
 * or does not pass its check. A caller must not tell the operator that
 * Sessions is off when nothing was written.
 */
export async function setSessionsEnabled(paths: FortressPaths, on: boolean): Promise<void> {
  try {
    await new FileConfigStore(paths).load();
  } catch (error) {
    throw new Error(
      `the Sessions choice was not saved, because ${paths.config} could not be read: ` +
        (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }
  await ensureCoreModulesEnabled(paths, { sessions: on ? "on" : "off" });
}

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
    modules: { enabled: [...DEFAULT_MODULE_IDS] },
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

  // A choice about session content that cannot be read stops the enrollment.
  // Writing a fresh file over it would drop the choice, and an HX Fortress where
  // nobody chose serves session calls. A mistyped "off" must not end there.
  const inTheWay = await sessionContentInTheWay(paths);
  if (inTheWay) throw invalidConfig(inTheWay);

  const existing = await new FileConfigStore(paths).load().catch(() => null);
  const raw = await readRawConfig(paths);

  const config: FortressConfig = {
    schemaVersion: 1,
    cloud: { url: cloudUrl },
    gateway: { publicUrl: gatewayPublicUrl ?? existing?.gateway.publicUrl ?? DEFAULT_GATEWAY_PUBLIC_URL },
    // The module list is the operator's choice, and it is kept even from a
    // file that did not pass the whole check, as long as the list itself
    // passes. Replacing it with the defaults would switch Sessions back on for
    // an operator who switched it off, because of a bad field elsewhere. A
    // list that does not pass states no choice, and gets the defaults.
    modules: existing?.modules ?? { enabled: enabledModulesIn(raw) ?? [...DEFAULT_MODULE_IDS] },
    // Carried EXPLICITLY: re-enrolling used to drop the whole postgres block,
    // which silently moved a fortress configured against an external database
    // onto a fresh embedded cluster — its data still there, invisible.
    ...(existing?.postgres ? { postgres: existing.postgres } : {}),
    // Same reason: a retention the operator shortened must not spring back to
    // the default because the fortress was re-enrolled.
    ...(existing?.roster ? { roster: existing.roster } : {}),
    // And an HX Fortress that was told to keep session content off its connection
    // stays told when it enrolls again.
    ...(existing?.connection ? { connection: existing.connection } : {}),
  };

  // Only preserve the raw object when the config actually parsed: merging over
  // an unparseable file would carry its invalid keys forward.
  //
  // One block is carried from a file that did not parse: `secrets`. It says
  // where this fortress reads its secrets from, and an operator may write it
  // before the first enrollment, when the rest of the file does not exist yet.
  // Dropping it would make the fortress read its secrets from the default
  // place without a word. The block is checked when it is used, and a block
  // that is wrong is refused there by name.
  //
  // The key that marks the module list as the operator's own is carried with
  // the list, for the same reason: without it the next start would add the
  // default modules back to a list that was kept on purpose.
  const carried = existing
    ? raw
    : raw
      ? {
          ...(isRecord(raw.secrets) ? { secrets: raw.secrets } : {}),
          ...(defaultsApplied(raw) && enabledModulesIn(raw) ? { [MODULE_DEFAULTS_KEY]: 1 } : {}),
          // The choice about session content is kept from a file whose other
          // fields did not pass, when the choice itself is readable. Dropping
          // it would turn "off" into "nobody chose", which serves session calls.
          ...(sessionContentIn(raw) ? { connection: { sessionContent: sessionContentIn(raw) } } : {}),
        }
      : null;
  await writeConfig(paths, config, carried);
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

// ── The setup's writer ──────────────────────────────────────────────────────

/** Whether this Fortress has a config.json at all. A Fortress without one has
 *  never been set up. */
export async function configExists(paths: FortressPaths): Promise<boolean> {
  return access(paths.config).then(
    () => true,
    () => false,
  );
}

/**
 * config.json as the raw object it holds, or null when there is no file.
 *
 * A file that is there and cannot be read as a JSON object throws: the setup
 * must not write over a file it could not read, because what it could not
 * read may hold settings.
 */
export async function readConfigObject(paths: FortressPaths): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readFile(paths.config, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
    throw invalidConfig("config.json could not be read");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidConfig("malformed JSON");
  }
  if (!isRecord(parsed)) throw invalidConfig("root must be an object");
  return parsed;
}

/**
 * Change top-level keys of config.json, as the setup does when it ends.
 *
 * `patch` holds the keys to set. A key whose value is `undefined` is REMOVED,
 * which is how a control plane is disconnected: `{ cloud: undefined }`. Every
 * other key the file holds stays as it is.
 *
 * The result is checked with the same parser the host starts with, before
 * anything is written. A patch that would leave a config the host refuses is
 * refused here, and the file is not touched.
 *
 * A LOCAL GESTURE, like the module switch below: the callers are the setup a
 * person runs on this host. Nothing that arrives from a control plane reaches
 * it.
 */
export async function patchConfig(
  paths: FortressPaths,
  patch: Record<string, unknown>,
): Promise<FortressConfig> {
  const { next, checked } = mergeConfigPatch(await readConfigObject(paths), patch);
  await writePrivateJson(paths.config, next, { pretty: true });
  return checked;
}

/**
 * What config.json holds once `patch` is applied to what it holds now, and
 * that result as the host reads it. Throws when the host would refuse it.
 *
 * `current` is the raw file, or null when there is none. The three keys every
 * config.json has are filled in underneath it, so a file that holds only a
 * block somebody wrote ahead of the setup (the key store's, for example)
 * becomes a whole config.json, and is not refused for what it lacks.
 *
 * The setup calls this twice with the same patch: once before it writes
 * anything, to learn whether the result would be refused, and once, through
 * `patchConfig`, to write it. One function, so the two cannot disagree.
 */
export function mergeConfigPatch(
  current: Record<string, unknown> | null,
  patch: Record<string, unknown>,
): { next: Record<string, unknown>; checked: FortressConfig } {
  const next: Record<string, unknown> = {
    schemaVersion: 1,
    gateway: { publicUrl: DEFAULT_GATEWAY_PUBLIC_URL },
    modules: { enabled: [] },
    ...current,
  };
  for (const [key, value] of Object.entries(patch)) {
    // A key of the patch a caller wrote, never one that arrived from outside.
    // eslint-disable-next-line security/detect-object-injection
    if (value === undefined) delete next[key];
    // eslint-disable-next-line security/detect-object-injection
    else next[key] = value;
  }
  return { next, checked: parseFortressConfig(next) };
}

// ── The module switch ───────────────────────────────────────────────────────

/** Why a module's switch was not changed. */
export class ModuleSwitchRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModuleSwitchRefused";
  }
}

/**
 * Switch one module on or off: add its id to, or remove it from, config.json's
 * `modules.enabled`.
 *
 * This list IS the switch. The runtime starts exactly these modules at boot, and
 * the ask gate reads it live, so removing an id refuses the very next ask to
 * that module whether or not the daemon has been told yet.
 *
 * A LOCAL GESTURE, and only that: the one caller is a verb somebody types on
 * this host (or, later, a signed-in console account acting here). Nothing that
 * arrives over the tunnel can reach it.
 *
 * Returns whether the file changed. Refuses to switch off a module in
 * `CORE_MODULE_IDS`, which every boot would switch back on. That list is empty
 * in this build.
 */
export async function setModuleEnabled(
  paths: FortressPaths,
  moduleId: string,
  on: boolean,
): Promise<{ changed: boolean; enabled: string[] }> {
  assertModuleId(moduleId);
  // The modules a build switches on by default are added to a config once, the
  // first time anything looks. Done here first, so a switch made before the
  // daemon has ever started on this build is not undone when it does.
  await ensureCoreModulesEnabled(paths);
  let config: FortressConfig;
  try {
    config = await new FileConfigStore(paths).load();
  } catch {
    // Two different things, and the person at the terminal can act on each:
    // there is no file yet, or there is one and it cannot be read.
    const exists = await access(paths.config).then(
      () => true,
      () => false,
    );
    throw new ModuleSwitchRefused(
      exists
        ? "config.json cannot be read, so nothing was saved. Fix the file, then run this again."
        : "this fortress has no config.json yet. Run `hx-fortress setup` first.",
    );
  }
  const enabled = config.modules.enabled;
  if (on === enabled.includes(moduleId)) return { changed: false, enabled: [...enabled] };
  if (!on && CORE_MODULE_IDS.includes(moduleId)) {
    throw new ModuleSwitchRefused(
      `${moduleId} is a core module of this build and cannot be switched off.`,
    );
  }
  if (moduleId === SESSIONS_MODULE_ID) {
    // The Sessions switch has one writer, `setSessionsEnabled`, which the setup
    // paths use too. It writes the list together with the key that says the
    // default modules were applied, so the next start does not switch Sessions
    // back on. What it wrote is read back: a switch that did not reach the file
    // is not reported as made.
    await setSessionsEnabled(paths, on);
    const written = await readEnabledModules(paths);
    if (!written || written.includes(SESSIONS_MODULE_ID) !== on) {
      throw new ModuleSwitchRefused("config.json could not be changed, so nothing was saved.");
    }
    return { changed: true, enabled: written };
  }
  const next = on ? [...enabled, moduleId] : enabled.filter((id) => id !== moduleId);
  await writeConfig(
    paths,
    { ...config, modules: { enabled: next } },
    await readRawConfig(paths),
  );
  return { changed: true, enabled: next };
}

/**
 * The ids switched on, read from config.json as it stands now. Null when the
 * file is missing, cannot be read or does not validate.
 *
 * Null is not the empty list, and a caller must not treat it as one where that
 * would stop something. A switch that cannot be read lets nothing new through:
 * an ask is refused. It does not mean somebody switched every module off, so a
 * running module keeps running until the file can be read again.
 */
export async function readEnabledModules(paths: FortressPaths): Promise<string[] | null> {
  try {
    return [...(await new FileConfigStore(paths).load()).modules.enabled];
  } catch {
    return null;
  }
}
