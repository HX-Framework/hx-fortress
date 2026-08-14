// <root>/ui/ui.json — the console's own configuration, and the only place the
// console's identity on the network is written down.
//
// Every writer goes through ONE door (UiConfigStore, on the users.json protocol:
// O_EXCL lock + tmp+rename + version CAS) because three components read the file
// LIVE and from different processes: the ui server on every request (the
// Host/Origin allowlist and every publicUrl-derived check), the container
// supervisor on every tick, and the daemon on every connection attempt. Mode is
// 0600 — the file holds an external Postgres DSN, password included.
//
// The READ rules are asymmetric on purpose, and the asymmetry is the whole design:
//
//   • ABSENT at the FIRST read ⇒ enabled:false. ui.json exists on none of the
//     already-deployed fleet, so treating absence as anything else would spawn a
//     console on every fortress that opted into nothing.
//   • ABSENT, torn or unparseable at a RE-READ ⇒ the last good snapshot, logged
//     ONCE. A writer holds the file unlinked for microseconds during a rename; a
//     console that read `enabled:false` out of that window would self-exit
//     mid-upgrade, and a supervisor would stop respawning it.
//   • UNPARSEABLE at a COLD START ⇒ a named refusal. There is no last good value
//     to fall back to, and the one available fallback — pg.json's DSN — is the
//     wrong one twice over: it would connect the browser-facing console as the
//     table-OWNING operator role on external Postgres, and it would silently lose
//     trustedProxies (every rate/lockout key collapses onto one peer) and
//     publicUrl (the Host allowlist narrows and the console stops answering).

import { stat } from "node:fs/promises";

import { detectContainer, type ContainerVerdict } from "./container";
import { DEFAULT_UI_PORT, LOOPBACK_BIND, parsePublicUrl, resolveUiBind } from "./bind";
import { remoteKeySourceLine } from "./remote-key";
import { JsonCasStore, StoreCorruptError, type LockReclaim } from "./store-lock";

export interface UiConfig {
  /** Monotonic write counter — the CAS token. */
  version: number;
  enabled: boolean;
  port: number;
  bind: string;
  /** A bare https origin, or null. Validated on the way in, never on the way out. */
  publicUrl: string | null;
  /** IP-or-CIDR entries whose XFF header is honored. EMPTY means XFF is ignored. */
  trustedProxies: string[];
  sso: boolean;
  sessionTtlHours: number;
  sessionIdleMinutes: number;
  /** An explicit console DSN, overriding pg.json in both modes. Never printed. */
  databaseUrl: string | null;
  /** The operator's standing acceptance of a non-loopback bind, recorded by
   *  `ui --install-service --allow-insecure-bind`. A unit carries no
   *  FORTRESS_UI_* environment and cannot be handed a flag by whoever set the
   *  value, so this file is where that gesture has to live. */
  allowInsecureBind: boolean;
  /** Operator-set banner phrase. Non-org-identifying by contract — it renders to
   *  token-bearing arrivals only, never on a plain pre-auth sign-in. */
  marker: string | null;
}

export const DEFAULT_SESSION_TTL_HOURS = 12;
export const DEFAULT_SESSION_IDLE_MINUTES = 60;

export const UI_CONFIG_DEFAULTS: UiConfig = {
  version: 0,
  enabled: false,
  port: DEFAULT_UI_PORT,
  bind: LOOPBACK_BIND,
  publicUrl: null,
  trustedProxies: [],
  sso: false,
  sessionTtlHours: DEFAULT_SESSION_TTL_HOURS,
  sessionIdleMinutes: DEFAULT_SESSION_IDLE_MINUTES,
  databaseUrl: null,
  allowInsecureBind: false,
  marker: null,
};

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Null ⇒ the document is CORRUPT (the store refuses), never "reset to defaults".
 *  Only the top-level shape is rejected here; individual keys fall back to their
 *  default so a file written by a newer build stays readable. */
export function parseUiConfig(raw: unknown): UiConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const proxies = Array.isArray(value.trustedProxies)
    ? value.trustedProxies.filter((e): e is string => typeof e === "string" && e.trim() !== "")
    : [];
  return {
    version: asInt(value.version, 0),
    enabled: asBool(value.enabled, false),
    port: asInt(value.port, DEFAULT_UI_PORT),
    bind: asStringOrNull(value.bind) ?? LOOPBACK_BIND,
    publicUrl: asStringOrNull(value.publicUrl),
    trustedProxies: proxies.map((e) => e.trim()),
    sso: asBool(value.sso, false),
    sessionTtlHours: asInt(value.sessionTtlHours, DEFAULT_SESSION_TTL_HOURS),
    sessionIdleMinutes: asInt(value.sessionIdleMinutes, DEFAULT_SESSION_IDLE_MINUTES),
    databaseUrl: asStringOrNull(value.databaseUrl),
    allowInsecureBind: asBool(value.allowInsecureBind, false),
    marker: asStringOrNull(value.marker),
  };
}

export class UiConfigColdStartError extends Error {
  constructor(file: string) {
    super(
      `refusing to start: ${file} exists but does not parse. ` +
        `The console will not guess its own configuration — losing publicUrl narrows the Host allowlist and ` +
        `losing trustedProxies collapses every rate-limit key onto one peer. ` +
        `Fix or remove the file, then start again.`,
    );
    this.name = "UiConfigColdStartError";
  }
}

/** The single write door. Readers use LiveUiConfig; nothing else writes the file. */
export class UiConfigStore {
  private readonly store: JsonCasStore<UiConfig>;

  constructor(file: string, onReclaim?: (reclaim: LockReclaim) => void) {
    this.store = new JsonCasStore<UiConfig>({
      file,
      label: "ui.json",
      parse: parseUiConfig,
      onReclaim,
    });
  }

  get file(): string {
    return this.store.file;
  }

  /** The stored config, or defaults when the file is absent. Throws
   *  StoreCorruptError for a file a writer must not overwrite. */
  async load(): Promise<UiConfig> {
    const read = await this.store.read();
    if (read.state === "corrupt") throw new StoreCorruptError("ui.json", this.store.file);
    return read.doc ?? { ...UI_CONFIG_DEFAULTS };
  }

  async update(mutate: (current: UiConfig) => UiConfig): Promise<UiConfig> {
    return this.store.update((current) => mutate(current ?? { ...UI_CONFIG_DEFAULTS }));
  }
}

/**
 * A live reader honoring the asymmetry documented at the top of this file.
 *
 * Re-reads only when the file's identity or mtime moved, so a per-request call is
 * a stat; boot-time-only caching is forbidden, because `ui config set publicUrl`
 * has to land on a running unit with no restart.
 */
export class LiveUiConfig {
  private lastGood: UiConfig | null = null;
  private signature: string | null = null;
  private degraded = false;
  private readonly store: JsonCasStore<UiConfig>;

  constructor(
    file: string,
    private readonly onWarn: (message: string) => void = () => {},
  ) {
    this.store = new JsonCasStore<UiConfig>({ file, label: "ui.json", parse: parseUiConfig });
  }

  /** Throws UiConfigColdStartError only for an unparseable file on the FIRST read. */
  async read(): Promise<UiConfig> {
    const info = await stat(this.store.file).catch(() => null);
    if (info && this.lastGood && this.signature === `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`) {
      return this.lastGood;
    }
    const read = await this.store.read();
    if (read.state === "ok" && read.doc) {
      this.lastGood = read.doc;
      this.signature = info ? `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}` : null;
      this.degraded = false;
      return read.doc;
    }
    if (this.lastGood) {
      // A rename window or a torn write. Hold the last good value and say so
      // once — repeating it per request would bury the line that matters.
      if (!this.degraded) {
        this.degraded = true;
        this.onWarn(
          read.state === "absent"
            ? `${this.store.file} vanished — holding the last good configuration`
            : `${this.store.file} did not parse — holding the last good configuration`,
        );
      }
      this.signature = null;
      return this.lastGood;
    }
    if (read.state === "corrupt") throw new UiConfigColdStartError(this.store.file);
    const defaults = { ...UI_CONFIG_DEFAULTS };
    this.lastGood = defaults;
    this.signature = null;
    return defaults;
  }
}

/**
 * The effective enablement predicate, everywhere: the env var OR the file.
 *
 * `ui disable` cannot flip an env-sourced true, which is why it refuses with a
 * named remediation instead of writing a value the supervisor would ignore.
 */
export function uiEnabledFromEnv(env: Record<string, string | undefined>): boolean {
  const raw = env.FORTRESS_UI_ENABLE?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

export function effectiveUiEnabled(
  config: Pick<UiConfig, "enabled">,
  env: Record<string, string | undefined>,
): boolean {
  return uiEnabledFromEnv(env) || config.enabled;
}

// ── The `ui config set` key set ─────────────────────────────────────────────

/** The enumerated keys, in the order the refusal lists them. `databaseUrl` is a
 *  member so its refusal can be SPECIFIC (use --stdin) rather than the generic
 *  unknown-key message; it is the only one with no positional form. */
export const UI_CONFIG_SET_KEYS = [
  "publicUrl",
  "trustedProxies",
  "port",
  "bind",
  "sessionTtlHours",
  "sessionIdleMinutes",
  "databaseUrl",
] as const;

export type UiConfigSetKey = (typeof UI_CONFIG_SET_KEYS)[number];

/** Never accepted positionally: argv is visible in /proc/<pid>/cmdline, in `ps`
 *  and in shell history, and this value carries a database password. */
export const STDIN_ONLY_KEYS = ["databaseUrl"] as const;

export type StdinOnlyKey = (typeof STDIN_ONLY_KEYS)[number];

export function isStdinOnlyKey(key: string): key is StdinOnlyKey {
  return (STDIN_ONLY_KEYS as readonly string[]).includes(key);
}

export function isUiConfigSetKey(key: string): key is UiConfigSetKey {
  return (UI_CONFIG_SET_KEYS as readonly string[]).includes(key);
}

export function unknownKeyMessage(key: string): string {
  return `unknown config key '${key}' — settable keys are ${UI_CONFIG_SET_KEYS.join(", ")}`;
}

export function stdinOnlyMessage(key: string): string {
  return (
    `refusing to read ${key} from the command line — it carries a password, and argv is visible ` +
    `in /proc/<pid>/cmdline, in \`ps\` and in shell history. ` +
    `Pipe it instead: hx-fortress ui config set ${key} --stdin`
  );
}

export type ValueCheck<T> = { ok: true; value: T } | { ok: false; reason: string };

const PORT_RANGE = "1-65535";

export function checkPort(raw: string): ValueCheck<number> {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, reason: `port must be an integer in ${PORT_RANGE} (got ${raw})` };
  }
  return { ok: true, value: port };
}

/**
 * https, and a BARE origin. The pathname rule is enforced here as well as at the
 * workbench because the operator who can fix it only ever sees this diagnostic:
 * a console URL with a path is accepted and advertised by the fortress, then
 * refused at approval on the other side, where nobody can act on it.
 */
export function checkPublicUrl(raw: string): ValueCheck<string> {
  const parsed = parsePublicUrl(raw.trim());
  if (!parsed.ok) {
    return {
      ok: false,
      reason:
        parsed.kind === "not-an-origin"
          ? `${parsed.reason} — the console app is root-absolute, so a URL with a path advertises a console that answers on no route it names`
          : parsed.reason,
    };
  }
  return { ok: true, value: parsed.origin };
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIpv4(value: string): boolean {
  const m = IPV4.exec(value);
  return m !== null && m.slice(1).every((o) => Number(o) <= 255 && String(Number(o)) === o);
}

function isIpv6(value: string): boolean {
  // Bracket-free, and permissive about the compressed forms; the walk only ever
  // compares normalized values, so a shape this accepts and the parser cannot
  // normalize simply never matches a peer.
  return /^[0-9a-fA-F:]+$/.test(value) && value.includes(":");
}

export function isIpOrCidr(entry: string): boolean {
  const [address, prefix, ...rest] = entry.split("/");
  if (rest.length > 0 || !address) return false;
  if (prefix !== undefined) {
    const bits = Number(prefix);
    if (!Number.isInteger(bits) || bits < 0) return false;
    if (isIpv4(address) ? bits > 32 : bits > 128) return false;
  }
  return isIpv4(address) || isIpv6(address);
}

export function checkTrustedProxies(raw: string): ValueCheck<string[]> {
  const entries = raw
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e !== "");
  const bad = entries.filter((e) => !isIpOrCidr(e));
  if (bad.length > 0) {
    return {
      ok: false,
      reason: `trustedProxies entries must be an IP or CIDR — rejected: ${bad.join(", ")}`,
    };
  }
  return { ok: true, value: entries };
}

export function checkSessionTtlHours(raw: string): ValueCheck<number> {
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 7) {
    return { ok: false, reason: `sessionTtlHours must be a positive number of hours ≤ 168 (got ${raw})` };
  }
  return { ok: true, value: hours };
}

export function checkSessionIdleMinutes(raw: string): ValueCheck<number> {
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) {
    return { ok: false, reason: `sessionIdleMinutes must be a positive number of minutes ≤ 1440 (got ${raw})` };
  }
  return { ok: true, value: minutes };
}

export interface BindCheckContext {
  publicUrl: string | null;
  port: number;
  env: Record<string, string | undefined>;
  platform?: string;
  container?: ContainerVerdict;
  /** The persisted `--install-service --allow-insecure-bind` gesture. */
  allowInsecureBind?: boolean;
}

/**
 * Validated AT SET TIME against the same three-clause rule the server applies at
 * start. Persisting a bind the console will later refuse is a lockout the unit
 * cannot escape: units carry no FORTRESS_UI_* environment and no --allow-insecure-bind,
 * so the console would refuse to start and the only remaining lever is the file
 * the operator just broke.
 */
export function checkBind(raw: string, ctx: BindCheckContext): ValueCheck<string> {
  const bind = raw.trim();
  if (!bind) return { ok: false, reason: "bind must be an address" };
  const resolution = resolveUiBind({
    bind,
    port: ctx.port,
    publicUrl: ctx.publicUrl,
    uiEnable: uiEnabledFromEnv(ctx.env),
    containerBind: ctx.env.FORTRESS_UI_CONTAINER_BIND === "1",
    allowInsecureBind: ctx.allowInsecureBind === true,
    container: ctx.container ?? detectContainer({ env: ctx.env, platform: ctx.platform }),
  });
  if (!resolution.ok) {
    return {
      ok: false,
      reason:
        `${resolution.reason}. Set an https publicUrl first ` +
        `(hx-fortress ui config set publicUrl https://…), or start the console with --allow-insecure-bind — ` +
        `a unit cannot pass that flag, so it is persisted by \`ui --install-service\`, not by this key.`,
    };
  }
  return { ok: true, value: bind };
}

// ── Printing ────────────────────────────────────────────────────────────────

/** Scheme + host + database. Never the user, never the password — the only form
 *  of this value that may reach stdout, a log or a rendered page. */
export function maskDatabaseUrl(dsn: string): string {
  try {
    const url = new URL(dsn);
    const database = url.pathname.replace(/^\//, "");
    return `${url.protocol}//${url.host}/${database}`;
  } catch {
    return "(unparseable connection string — redacted)";
  }
}

/** What `ui config` prints. Assembled here so no caller can invent a field or
 *  forget the mask. */
export function printableUiConfig(config: UiConfig): Array<[string, string]> {
  return [
    ["enabled", String(config.enabled)],
    ["bind", config.bind],
    ["port", String(config.port)],
    ["publicUrl", config.publicUrl ?? "(unset)"],
    ["trustedProxies", config.trustedProxies.length ? config.trustedProxies.join(", ") : "(none)"],
    // The same sentence the data-paths inventory renders: whether XFF is honored
    // is the difference between per-principal rate limits and one shared bucket,
    // and its default is a silent failure behind any proxy.
    ["remote-key source", remoteKeySourceLine(config.trustedProxies)],
    ["sso", String(config.sso)],
    ["allowInsecureBind", String(config.allowInsecureBind)],
    ["sessionTtlHours", String(config.sessionTtlHours)],
    ["sessionIdleMinutes", String(config.sessionIdleMinutes)],
    ["databaseUrl", config.databaseUrl ? maskDatabaseUrl(config.databaseUrl) : "(from pg.json)"],
    ["marker", config.marker ?? "(unset)"],
  ];
}
