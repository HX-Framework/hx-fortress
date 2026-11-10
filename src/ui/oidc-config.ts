// <root>/ui/oidc.json — how the console signs people in through the
// organization's own identity provider (OpenID Connect).
//
// It is a file of its own, beside ui.json and users.json, with the same
// protocol: 0600, one writer door (an O_EXCL lock, tmp+rename and a version
// check), and readers that re-read when the file changes. The
// `hx-fortress ui oidc` verbs are its only writers. Nothing a browser sends and
// nothing let.ai sends can change it.
//
// The file holds no secret. A confidential client's secret is read from the
// fortress's secret provider by the name written here.
//
// OFF BY DEFAULT. A fortress with no oidc.json behaves exactly as one built
// before this file existed.

import { stat } from "node:fs/promises";

import { isLoopbackHost } from "../host/config";
import { isSecretName } from "../secrets/types";
import { JsonCasStore, StoreCorruptError, type LockReclaim } from "./store-lock";

export interface UiOidcConfig {
  /** Monotonic write counter — the store's CAS token. */
  version: number;
  enabled: boolean;
  /** The provider's issuer, exactly as its discovery document states it. */
  issuer: string | null;
  clientId: string | null;
  /** The NAME of the secret that holds the client secret. Null for a public
   *  client, which proves itself with PKCE alone. */
  clientSecretName: string | null;
  /** The ID token claim that lists the person's groups (or roles). */
  groupsClaim: string;
  /** The ID token claim shown as the person's login. Null means `email`, then
   *  `preferred_username`. */
  loginClaim: string | null;
  /** Membership of any of these makes the session an operator. */
  operatorGroups: string[];
  /** Membership of any of these, and of no operator group, makes it read-only. */
  readonlyGroups: string[];
  scopes: string[];
  /** What the sign-in button calls the provider. */
  label: string | null;
  /**
   * Raised by every write to this file. A session records the value it was
   * issued under and ends when the two differ, so turning sign-in off, or
   * changing who maps to which role, ends the sessions that the old settings
   * issued.
   */
  epoch: number;
}

export const DEFAULT_OIDC_SCOPES: readonly string[] = ["openid", "profile", "email"];
export const DEFAULT_GROUPS_CLAIM = "groups";

export const OIDC_CONFIG_DEFAULTS: UiOidcConfig = {
  version: 0,
  enabled: false,
  issuer: null,
  clientId: null,
  clientSecretName: null,
  groupsClaim: DEFAULT_GROUPS_CLAIM,
  loginClaim: null,
  operatorGroups: [],
  readonlyGroups: [],
  scopes: [...DEFAULT_OIDC_SCOPES],
  label: null,
  epoch: 0,
};

// ── Value rules ─────────────────────────────────────────────────────────────

export type OidcCheck<T> = { ok: true; value: T } | { ok: false; reason: string };

const MAX_GROUPS = 50;
const MAX_GROUP_CHARS = 256;

/** True when the text holds an ASCII control character. */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * https, or http to this host itself. The console sends the client secret to
 * the token endpoint this issuer names, so a cleartext issuer anywhere else is
 * refused. The value is kept exactly as given: an ID token's `iss` is compared
 * to it character for character.
 */
export function checkOidcIssuer(raw: string): OidcCheck<string> {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "issuer must be a URL, as the provider's discovery document states it" };
  }
  if (url.username || url.password) return { ok: false, reason: "issuer must not hold a user name or a password" };
  if (url.search || url.hash) return { ok: false, reason: "issuer must not hold a query or a fragment" };
  if (url.protocol === "https:") return { ok: true, value };
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return { ok: true, value };
  return { ok: false, reason: "issuer must use https: (http: is allowed only to this host itself)" };
}

export function checkOidcClientId(raw: string): OidcCheck<string> {
  const value = raw.trim();
  if (!/^[\x21-\x7e]{1,256}$/.test(value)) {
    return { ok: false, reason: "clientId must be 1 to 256 printable characters with no spaces" };
  }
  return { ok: true, value };
}

/** A NAME, never the secret. A value pasted here is refused and not repeated. */
export function checkOidcClientSecretName(raw: string): OidcCheck<string | null> {
  const value = raw.trim();
  if (value === "" || value === "none") return { ok: true, value: null };
  if (!isSecretName(value)) {
    return {
      ok: false,
      reason:
        'clientSecretName must be the NAME of a secret (1 to 64 characters of a-z, 0-9 and "-"), ' +
        'or "none" for a public client. The secret itself is never written here',
    };
  }
  return { ok: true, value };
}

export function checkOidcClaimName(key: string, raw: string): OidcCheck<string> {
  const value = raw.trim();
  if (!/^[A-Za-z0-9_.:/-]{1,128}$/.test(value)) {
    return { ok: false, reason: `${key} must be a claim name: 1 to 128 letters, digits and _ . : / -` };
  }
  return { ok: true, value };
}

/** Comma-separated. A group is matched character for character, so an Entra
 *  object id is written as the id and a group name as the name. */
export function checkOidcGroups(key: string, raw: string): OidcCheck<string[]> {
  const groups = [...new Set(raw.split(",").map((g) => g.trim()).filter((g) => g !== ""))];
  if (groups.length > MAX_GROUPS) return { ok: false, reason: `${key} holds more than ${MAX_GROUPS} groups` };
  const bad = groups.find((g) => g.length > MAX_GROUP_CHARS || hasControlCharacter(g));
  if (bad !== undefined) {
    return { ok: false, reason: `${key} holds a group that is longer than ${MAX_GROUP_CHARS} characters or has a control character` };
  }
  return { ok: true, value: groups };
}

/** Space- or comma-separated. `openid` is always asked for. */
export function checkOidcScopes(raw: string): OidcCheck<string[]> {
  const scopes = [...new Set(raw.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s !== ""))];
  if (scopes.some((s) => !/^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/.test(s))) {
    return { ok: false, reason: "scopes must be space-separated scope names" };
  }
  if (scopes.length > 20) return { ok: false, reason: "scopes holds more than 20 names" };
  return { ok: true, value: scopes.includes("openid") ? scopes : ["openid", ...scopes] };
}

export function checkOidcLabel(raw: string): OidcCheck<string | null> {
  const value = raw.trim();
  if (value === "") return { ok: true, value: null };
  if (value.length > 40 || hasControlCharacter(value) || /[<>]/.test(value)) {
    return { ok: false, reason: "label must be 40 characters or fewer, with no control characters" };
  }
  return { ok: true, value };
}

/** What `ui oidc on` needs before it will turn sign-in on. Null when nothing is
 *  missing. */
export function oidcMissing(config: UiOidcConfig): string | null {
  if (!config.issuer) return "issuer is not set";
  if (!config.clientId) return "clientId is not set";
  if (config.operatorGroups.length === 0 && config.readonlyGroups.length === 0) {
    return "no group is mapped to a role: set operatorGroups or readonlyGroups";
  }
  return null;
}

/** Usable right now: switched on, and nothing it needs is missing. */
export function oidcUsable(
  config: UiOidcConfig,
): config is UiOidcConfig & { enabled: true; issuer: string; clientId: string } {
  return config.enabled && oidcMissing(config) === null;
}

// ── Parsing ─────────────────────────────────────────────────────────────────

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((e): e is string => typeof e === "string" && e.trim() !== "").map((e) => e.trim())
    : [];
}

/**
 * Null means the document is CORRUPT: the store refuses to overwrite it and a
 * reader treats sign-in through the provider as off.
 *
 * A value that breaks its rule also makes the document corrupt. This file
 * decides who becomes an operator, so a half-understood one is not used.
 */
export function parseOidcConfig(raw: unknown): UiOidcConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const issuer = stringOrNull(value.issuer);
  const clientId = stringOrNull(value.clientId);
  const clientSecretName = stringOrNull(value.clientSecretName);
  const loginClaim = stringOrNull(value.loginClaim);
  const groupsClaim = stringOrNull(value.groupsClaim) ?? DEFAULT_GROUPS_CLAIM;
  const scopes = stringList(value.scopes);
  const label = stringOrNull(value.label);

  if (issuer !== null && !checkOidcIssuer(issuer).ok) return null;
  if (clientId !== null && !checkOidcClientId(clientId).ok) return null;
  if (clientSecretName !== null && !isSecretName(clientSecretName)) return null;
  if (!checkOidcClaimName("groupsClaim", groupsClaim).ok) return null;
  if (loginClaim !== null && !checkOidcClaimName("loginClaim", loginClaim).ok) return null;
  const operatorGroups = checkOidcGroups("operatorGroups", stringList(value.operatorGroups).join(","));
  const readonlyGroups = checkOidcGroups("readonlyGroups", stringList(value.readonlyGroups).join(","));
  if (!operatorGroups.ok || !readonlyGroups.ok) return null;
  const checkedScopes = checkOidcScopes(scopes.length > 0 ? scopes.join(" ") : DEFAULT_OIDC_SCOPES.join(" "));
  if (!checkedScopes.ok) return null;
  if (label !== null && !checkOidcLabel(label).ok) return null;

  return {
    version: typeof value.version === "number" && Number.isFinite(value.version) ? Math.trunc(value.version) : 0,
    enabled: value.enabled === true,
    issuer,
    clientId,
    clientSecretName,
    groupsClaim,
    loginClaim,
    operatorGroups: operatorGroups.value,
    readonlyGroups: readonlyGroups.value,
    scopes: checkedScopes.value,
    label,
    epoch: typeof value.epoch === "number" && Number.isFinite(value.epoch) ? Math.trunc(value.epoch) : 0,
  };
}

// ── The store ───────────────────────────────────────────────────────────────

/** The single write door. Every write raises `epoch`. */
export class OidcConfigStore {
  private readonly store: JsonCasStore<UiOidcConfig>;

  constructor(file: string, onReclaim?: (reclaim: LockReclaim) => void) {
    this.store = new JsonCasStore<UiOidcConfig>({
      file,
      label: "oidc.json",
      parse: parseOidcConfig,
      onReclaim,
    });
  }

  get file(): string {
    return this.store.file;
  }

  async load(): Promise<UiOidcConfig> {
    const read = await this.store.read();
    if (read.state === "corrupt") throw new StoreCorruptError("oidc.json", this.store.file);
    return read.doc ?? { ...OIDC_CONFIG_DEFAULTS };
  }

  async update(mutate: (current: UiOidcConfig) => UiOidcConfig): Promise<UiOidcConfig> {
    return this.store.update((current) => {
      const base = current ?? { ...OIDC_CONFIG_DEFAULTS };
      return { ...mutate(base), epoch: base.epoch + 1 };
    });
  }
}

/**
 * The serving console's view of the file.
 *
 * It re-reads only when the file's identity or modification time moved, so a
 * check on every request costs a stat, and a change made by a verb in another
 * process lands with no restart.
 *
 * It FAILS CLOSED. A file that is absent means sign-in through the provider is
 * off. A file that does not parse also means off, and says so once: this file
 * decides who gets an operator session, and a stale copy of it is not a safe
 * thing to keep acting on.
 */
export class LiveOidcConfig {
  private cached: UiOidcConfig | null = null;
  private signature: string | null = null;
  private warned = false;
  private readonly store: JsonCasStore<UiOidcConfig>;

  constructor(
    file: string,
    private readonly onWarn: (message: string) => void = () => {},
  ) {
    this.store = new JsonCasStore<UiOidcConfig>({ file, label: "oidc.json", parse: parseOidcConfig });
  }

  async read(): Promise<UiOidcConfig> {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const info = await stat(this.store.file).catch(() => null);
    if (!info) {
      // No file: off. This is every fortress that never ran `ui oidc`, and it
      // costs that fortress one stat a request and nothing else.
      this.cached = null;
      this.signature = null;
      return { ...OIDC_CONFIG_DEFAULTS };
    }
    const signature = `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`;
    if (this.cached && signature === this.signature) return this.cached;

    const read = await this.store.read();
    if (read.state === "ok" && read.doc) {
      this.cached = read.doc;
      this.signature = signature;
      this.warned = false;
      return read.doc;
    }
    if (read.state === "corrupt" && !this.warned) {
      this.warned = true;
      this.onWarn(
        `${this.store.file} does not parse, so sign-in through the identity provider is off until it is fixed`,
      );
    }
    this.cached = null;
    this.signature = null;
    return { ...OIDC_CONFIG_DEFAULTS };
  }
}

// ── Printing and setting ────────────────────────────────────────────────────

export const OIDC_SET_KEYS = [
  "issuer",
  "clientId",
  "clientSecretName",
  "groupsClaim",
  "loginClaim",
  "operatorGroups",
  "readonlyGroups",
  "scopes",
  "label",
] as const;

export type OidcSetKey = (typeof OIDC_SET_KEYS)[number];

export function isOidcSetKey(key: string): key is OidcSetKey {
  return (OIDC_SET_KEYS as readonly string[]).includes(key);
}

/** Check one `ui oidc set <key> <value>` and return the change it makes. */
export function oidcSetting(key: OidcSetKey, raw: string): OidcCheck<Partial<UiOidcConfig>> {
  const wrap = <T>(check: OidcCheck<T>, make: (value: T) => Partial<UiOidcConfig>): OidcCheck<Partial<UiOidcConfig>> =>
    check.ok ? { ok: true, value: make(check.value) } : check;
  switch (key) {
    case "issuer":
      return wrap(checkOidcIssuer(raw), (issuer) => ({ issuer }));
    case "clientId":
      return wrap(checkOidcClientId(raw), (clientId) => ({ clientId }));
    case "clientSecretName":
      return wrap(checkOidcClientSecretName(raw), (clientSecretName) => ({ clientSecretName }));
    case "groupsClaim":
      return wrap(checkOidcClaimName(key, raw), (groupsClaim) => ({ groupsClaim }));
    case "loginClaim":
      return raw.trim() === ""
        ? { ok: true, value: { loginClaim: null } }
        : wrap(checkOidcClaimName(key, raw), (loginClaim) => ({ loginClaim }));
    case "operatorGroups":
      return wrap(checkOidcGroups(key, raw), (operatorGroups) => ({ operatorGroups }));
    case "readonlyGroups":
      return wrap(checkOidcGroups(key, raw), (readonlyGroups) => ({ readonlyGroups }));
    case "scopes":
      return wrap(checkOidcScopes(raw), (scopes) => ({ scopes }));
    case "label":
      return wrap(checkOidcLabel(raw), (label) => ({ label }));
  }
}

/** What `ui oidc` prints. Nothing in this file is a secret, so nothing is
 *  masked: `clientSecretName` is a name. */
export function printableOidcConfig(config: UiOidcConfig): Array<[string, string]> {
  const list = (items: string[]): string => (items.length > 0 ? items.join(", ") : "(none)");
  return [
    ["enabled", String(config.enabled)],
    ["issuer", config.issuer ?? "(unset)"],
    ["clientId", config.clientId ?? "(unset)"],
    ["clientSecretName", config.clientSecretName ?? "(none — a public client, PKCE only)"],
    ["groupsClaim", config.groupsClaim],
    ["loginClaim", config.loginClaim ?? "(email, then preferred_username)"],
    ["operatorGroups", list(config.operatorGroups)],
    ["readonlyGroups", list(config.readonlyGroups)],
    ["scopes", config.scopes.join(" ")],
    ["label", config.label ?? "(unset)"],
  ];
}
