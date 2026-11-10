// The `azure-key-vault` provider: a secret named `db-url` is the secret
// `db-url` in one Azure Key Vault, read with the managed identity of the
// machine or container this fortress runs on.
//
// Two HTTP calls, and no Azure SDK:
//
//   1. A token for the vault, from the platform's managed identity endpoint.
//      Azure Container Apps and App Service publish it as IDENTITY_ENDPOINT
//      and IDENTITY_HEADER. A virtual machine has the instance metadata
//      service at 169.254.169.254.
//   2. GET {vault}/secrets/{name} with that token.
//
// What this file keeps true:
//
//   - A value is held in memory only, for `cacheTtlMs` at most, and then
//     dropped. Nothing here writes to disk.
//   - No error holds a value, a token or a response body. An error says the
//     secret's name, a fixed phrase, and a status or an error code.
//   - Values, the token and the identity header are held in `#` fields, so
//     logging or serializing the provider prints only its kind.
//   - The token is sent to the configured vault and nowhere else. Redirects
//     are refused on both calls, and the vault's host must be a Key Vault host
//     of a known Azure cloud.

import { secretValueFrom, SecretProviderBase } from "./provider-base";
import { assertSecretName, MAX_SECRET_BYTES, SecretMissing, SecretUnavailable } from "./types";

// ── The vault ───────────────────────────────────────────────────────────────

/** Key Vault hosts, by the DNS suffix of each Azure cloud, with the resource a
 *  token must be issued for. A token for one cloud is not valid in another. */
const KEY_VAULT_CLOUDS: readonly { suffix: string; resource: string }[] = [
  { suffix: ".vault.azure.net", resource: "https://vault.azure.net" },
  { suffix: ".vault.usgovcloudapi.net", resource: "https://vault.usgovcloudapi.net" },
  { suffix: ".vault.azure.cn", resource: "https://vault.azure.cn" },
];

export interface KeyVaultTarget {
  /** `https://<name>.vault.azure.net`, with no path. */
  origin: string;
  /** What the token is requested for. */
  resource: string;
}

/**
 * Check a vault URL and work out which cloud it belongs to.
 *
 * The host is checked against a fixed list because the bearer token goes to
 * whatever host this returns. A URL that points anywhere else is refused, so a
 * mistyped or hostile setting cannot send the token to a server that is not a
 * Key Vault.
 */
export function parseKeyVaultUrl(value: string): KeyVaultTarget {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("the Key Vault URL must be a URL like https://<name>.vault.azure.net");
  }
  if (url.protocol !== "https:") throw new Error("the Key Vault URL must use https:");
  if (url.username || url.password) {
    throw new Error("the Key Vault URL must not hold a user name or a password");
  }
  if (url.port) throw new Error("the Key Vault URL must not name a port");
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("the Key Vault URL must be the vault's address alone, with no path or query");
  }
  const host = url.hostname.toLowerCase();
  const cloud = KEY_VAULT_CLOUDS.find(
    (c) => host.endsWith(c.suffix) && /^[a-z0-9-]{3,24}$/.test(host.slice(0, -c.suffix.length)),
  );
  if (!cloud) {
    throw new Error(
      "the Key Vault URL must be one of " +
        KEY_VAULT_CLOUDS.map((c) => `https://<name>${c.suffix}`).join(", "),
    );
  }
  return { origin: `https://${host}`, resource: cloud.resource };
}

// ── The managed identity ────────────────────────────────────────────────────

/** Azure's instance metadata service. The address is the same on every
 *  virtual machine and is not routable from outside it. */
const IMDS_TOKEN_URL = "http://169.254.169.254/metadata/identity/oauth2/token";

export type ManagedIdentitySource =
  | {
      /** Azure Container Apps, App Service and Functions. */
      kind: "identity-endpoint";
      endpoint: string;
      /** Sent back to the endpoint as X-IDENTITY-HEADER. It proves the request
       *  comes from inside the container. */
      header: string;
      clientId?: string;
    }
  | {
      /** A virtual machine or a scale set. */
      kind: "imds";
      endpoint: string;
      clientId?: string;
    };

/** The client id of a user-assigned managed identity: a GUID. */
export const MANAGED_IDENTITY_CLIENT_ID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Where a token comes from on this host.
 *
 * IDENTITY_ENDPOINT and IDENTITY_HEADER together mean Container Apps or App
 * Service. With neither, the instance metadata service is asked. `clientId`
 * picks one user-assigned identity; without it the platform uses the
 * system-assigned one.
 */
export function resolveManagedIdentity(
  env: Record<string, string | undefined>,
  clientId?: string,
): ManagedIdentitySource {
  const endpoint = env.IDENTITY_ENDPOINT?.trim();
  const header = env.IDENTITY_HEADER?.trim();
  const id = clientId?.trim() || undefined;
  if (id !== undefined && !MANAGED_IDENTITY_CLIENT_ID.test(id)) {
    throw new Error("the managed identity client id must be a GUID");
  }
  if (endpoint && header) {
    // Service Fabric publishes the same two variables with a third, and speaks
    // a different protocol. Saying so is better than a token request that
    // fails for a reason nobody can read.
    if (env.IDENTITY_SERVER_THUMBPRINT?.trim()) {
      throw new Error(
        "this host publishes a Service Fabric managed identity endpoint, which this build cannot use",
      );
    }
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error("IDENTITY_ENDPOINT is not a URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("IDENTITY_ENDPOINT must use http: or https:");
    }
    if (url.username || url.password) {
      throw new Error("IDENTITY_ENDPOINT must not hold a user name or a password");
    }
    return { kind: "identity-endpoint", endpoint: url.toString(), header, ...(id ? { clientId: id } : {}) };
  }
  if (endpoint || header) {
    throw new Error(
      "IDENTITY_ENDPOINT and IDENTITY_HEADER must both be set: this host published one without the other",
    );
  }
  return { kind: "imds", endpoint: IMDS_TOKEN_URL, ...(id ? { clientId: id } : {}) };
}

// ── The provider ────────────────────────────────────────────────────────────

/** How long a value read from the vault is kept before it is read again. Short
 *  on purpose: it bounds how long a value stays in this process after its last
 *  use, and how long a rotated secret keeps being served. */
export const DEFAULT_SECRET_CACHE_TTL_MS = 60_000;

/** The longest a value may be kept, whatever the setting says. */
export const MAX_SECRET_CACHE_TTL_MS = 15 * 60_000;

/** A token is fetched again this long before it expires, so a request never
 *  goes out with one that dies on the way. A token that lives less than twice
 *  this long is fetched again at half its life instead. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

/** Used when the identity endpoint does not say when the token expires. */
const TOKEN_FALLBACK_LIFETIME_MS = 5 * 60_000;

const KEY_VAULT_API_VERSION = "7.4";

export interface AzureKeyVaultOptions {
  vault: KeyVaultTarget;
  identity: ManagedIdentitySource;
  /** 0 keeps nothing between calls. Capped at MAX_SECRET_CACHE_TTL_MS. */
  cacheTtlMs?: number;
  /** Injected in tests. */
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** One request's time limit, and how many times a request is tried. */
  requestTimeoutMs?: number;
  attempts?: number;
}

interface CachedToken {
  token: string;
  /** When to stop using it and ask for a new one. */
  refreshAt: number;
}

interface CachedValue {
  value: string;
  expiresAt: number;
}

/** What one HTTP attempt came to. `retry` says whether this provider tries the
 *  request again now. `transient` says whether a caller may find it working
 *  later with nothing changed on this host. */
type Attempt<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      retry: boolean;
      transient: boolean;
      reason: string;
      missing?: boolean;
      unauthorized?: boolean;
      retryAfterMs?: number;
    };

function clampTtl(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SECRET_CACHE_TTL_MS;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.trunc(value), MAX_SECRET_CACHE_TTL_MS);
}

/** An Azure error code, when the body carries one that is safe to repeat. The
 *  body's message text is never used: it is free text from the service. */
function azureErrorCode(body: unknown): string | null {
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error === "string") return safeCode(error);
  if (!error || typeof error !== "object") return null;
  const outer = (error as { code?: unknown }).code;
  const inner = ((error as { innererror?: unknown }).innererror as { code?: unknown } | null)?.code;
  return safeCode(inner) ?? safeCode(outer);
}

function safeCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : null;
}

function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 5_000) : undefined;
}

/** The response body as JSON, or null. Read with a size limit, so a server
 *  that is not Key Vault cannot make this process hold a large answer. */
async function readJsonBody(response: Response, limitBytes: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limitBytes) return null;
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

/** Room for the value plus the JSON around it (id, attributes, tags). A JSON
 *  string can take up to six bytes for one byte of value. */
const SECRET_RESPONSE_LIMIT_BYTES = MAX_SECRET_BYTES * 6 + 16 * 1024;
const ERROR_RESPONSE_LIMIT_BYTES = 64 * 1024;

export class AzureKeyVaultSecretProvider extends SecretProviderBase {
  readonly kind = "azure-key-vault" as const;

  // `#` fields throughout. A TypeScript `private` field is an ordinary
  // property at run time, and this object holds secret values, a bearer token
  // and the identity header.
  readonly #vault: KeyVaultTarget;
  readonly #identity: ManagedIdentitySource;
  readonly #cacheTtlMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #requestTimeoutMs: number;
  readonly #attempts: number;

  #token: CachedToken | null = null;
  #tokenInFlight: Promise<string> | null = null;
  readonly #values = new Map<string, CachedValue>();
  readonly #inFlight = new Map<string, Promise<string>>();
  #purgeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Raised by forget(). An answer that was on its way when forget() ran is
   *  returned to its caller and not kept. */
  #generation = 0;

  constructor(options: AzureKeyVaultOptions) {
    super();
    this.#vault = options.vault;
    this.#identity = options.identity;
    this.#cacheTtlMs = clampTtl(options.cacheTtlMs);
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 8_000;
    this.#attempts = Math.max(1, options.attempts ?? 3);
  }

  async get(name: string): Promise<string> {
    assertSecretName(name);
    const cached = this.#values.get(name);
    if (cached) {
      if (cached.expiresAt > this.#now()) return cached.value;
      this.#values.delete(name);
    }
    // One request per name at a time. Callers that arrive while it is out wait
    // for the same answer.
    const pending = this.#inFlight.get(name);
    if (pending) return pending;
    const request = this.#read(name).finally(() => this.#inFlight.delete(name));
    this.#inFlight.set(name, request);
    return request;
  }

  /** Drop every value and the token now. For shutdown, and for a caller that
   *  knows a secret was just rotated. */
  forget(): void {
    this.#generation += 1;
    this.#values.clear();
    this.#token = null;
    if (this.#purgeTimer) clearTimeout(this.#purgeTimer);
    this.#purgeTimer = null;
  }

  /** How many values are held in memory right now. A count, never a value. */
  get heldValues(): number {
    return this.#values.size;
  }

  // -- the vault ---------------------------------------------------------------

  async #read(name: string): Promise<string> {
    const source = `Azure Key Vault secret ${name} in ${this.#vault.origin}`;
    const url = `${this.#vault.origin}/secrets/${name}?api-version=${KEY_VAULT_API_VERSION}`;
    const generation = this.#generation;
    let last: Attempt<string> = {
      ok: false,
      retry: false,
      transient: false,
      reason: "no attempt was made",
    };
    let renewedToken = false;
    for (let attempt = 1; attempt <= this.#attempts; attempt += 1) {
      const token = await this.#accessToken(name, source);
      last = await this.#requestSecret(url, token);
      if (last.ok) {
        // The same rule as every other provider: one final line ending is
        // removed, a blank value is a missing secret, an oversized one is
        // refused.
        const value = secretValueFrom(name, last.value, source);
        if (generation === this.#generation) this.#remember(name, value);
        return value;
      }
      if (last.missing) throw new SecretMissing(name, source);
      if (last.unauthorized && !renewedToken) {
        // The vault did not accept the token. Ask for a new one, once, without
        // spending one of the attempts.
        renewedToken = true;
        this.#token = null;
        attempt -= 1;
        continue;
      }
      if (!last.retry || attempt === this.#attempts) break;
      await this.#sleep(last.retryAfterMs ?? 200 * 2 ** (attempt - 1));
    }
    throw new SecretUnavailable(name, last.ok ? "no answer" : last.reason, {
      transient: !last.ok && last.transient,
      source,
    });
  }

  async #requestSecret(url: string, token: string): Promise<Attempt<string>> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        // A redirect would carry the token to another host.
        redirect: "error",
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
    } catch (error) {
      return {
        ok: false,
        retry: true,
        transient: true,
        reason: `the vault did not answer (${networkReason(error)})`,
      };
    }

    if (response.status === 200) {
      const body = await readJsonBody(response, SECRET_RESPONSE_LIMIT_BYTES);
      const value = (body as { value?: unknown } | null)?.value;
      if (typeof value !== "string") {
        return {
          ok: false,
          retry: false,
          transient: false,
          reason: "the vault's answer did not hold a secret value",
        };
      }
      return { ok: true, value };
    }

    const code = azureErrorCode(await readJsonBody(response, ERROR_RESPONSE_LIMIT_BYTES));
    const label = code ? `${response.status} ${code}` : String(response.status);
    const answered = `the vault answered ${label}`;
    if (response.status === 404) {
      return { ok: false, retry: false, transient: false, missing: true, reason: answered };
    }
    if (response.status === 403 && code === "SecretDisabled") {
      // Somebody switched this secret off in the vault. There is no value to use.
      return { ok: false, retry: false, transient: false, missing: true, reason: answered };
    }
    if (response.status === 401) {
      return {
        ok: false,
        retry: false,
        transient: false,
        unauthorized: true,
        reason: `the vault refused the token (${label})`,
      };
    }
    if (response.status === 403) {
      return {
        ok: false,
        retry: false,
        // A role assignment made a moment ago is refused for a few minutes
        // before it takes effect, so a caller may ask again later.
        transient: true,
        reason:
          `the vault refused the request (${label}). The managed identity needs the ` +
          "Key Vault Secrets User role on this vault, and the vault's firewall must admit this host",
      };
    }
    if (response.status === 429 || response.status >= 500) {
      const wait = retryAfterMs(response);
      return {
        ok: false,
        retry: true,
        transient: true,
        reason: answered,
        ...(wait !== undefined ? { retryAfterMs: wait } : {}),
      };
    }
    return { ok: false, retry: false, transient: false, reason: answered };
  }

  #remember(name: string, value: string): void {
    if (this.#cacheTtlMs === 0) return;
    this.#values.set(name, { value, expiresAt: this.#now() + this.#cacheTtlMs });
    this.#schedulePurge();
  }

  /** Values are dropped when they expire, not only when somebody next asks. A
   *  secret read once at boot would otherwise stay in this map for good. The
   *  timer is set for the value that expires first, and set again while any
   *  value is left. */
  #schedulePurge(): void {
    if (this.#purgeTimer || this.#values.size === 0) return;
    let earliest = Infinity;
    for (const cached of this.#values.values()) earliest = Math.min(earliest, cached.expiresAt);
    this.#purgeTimer = setTimeout(
      () => {
        this.#purgeTimer = null;
        const now = this.#now();
        for (const [name, cached] of this.#values) {
          if (cached.expiresAt <= now) this.#values.delete(name);
        }
        this.#schedulePurge();
      },
      Math.max(1, earliest - this.#now()),
    );
    // Housekeeping must not keep the process alive.
    (this.#purgeTimer as { unref?: () => void }).unref?.();
  }

  // -- the token ---------------------------------------------------------------

  #accessToken(name: string, source: string): Promise<string> {
    if (this.#token && this.#token.refreshAt > this.#now()) {
      return Promise.resolve(this.#token.token);
    }
    this.#tokenInFlight ??= this.#fetchToken(name, source).finally(() => {
      this.#tokenInFlight = null;
    });
    return this.#tokenInFlight;
  }

  async #fetchToken(name: string, source: string): Promise<string> {
    const identity = this.#identity;
    const url = new URL(identity.endpoint);
    url.searchParams.set("resource", this.#vault.resource);
    url.searchParams.set("api-version", identity.kind === "identity-endpoint" ? "2019-08-01" : "2018-02-01");
    if (identity.clientId) url.searchParams.set("client_id", identity.clientId);
    const headers: Record<string, string> =
      identity.kind === "identity-endpoint" ? { "x-identity-header": identity.header } : { metadata: "true" };

    const generation = this.#generation;
    let last: Attempt<CachedToken> = {
      ok: false,
      retry: false,
      transient: false,
      reason: "no attempt was made",
    };
    for (let attempt = 1; attempt <= this.#attempts; attempt += 1) {
      last = await this.#requestToken(url.toString(), headers);
      if (last.ok) {
        if (generation === this.#generation) this.#token = last.value;
        return last.value.token;
      }
      if (!last.retry || attempt === this.#attempts) break;
      await this.#sleep(last.retryAfterMs ?? 200 * 2 ** (attempt - 1));
    }
    throw new SecretUnavailable(
      name,
      `no managed identity token: ${last.ok ? "no answer" : last.reason}`,
      { transient: !last.ok && last.transient, source },
    );
  }

  async #requestToken(url: string, headers: Record<string, string>): Promise<Attempt<CachedToken>> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers: { ...headers, accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
    } catch (error) {
      return {
        ok: false,
        retry: true,
        transient: true,
        reason: `the identity endpoint did not answer (${networkReason(error)})`,
      };
    }
    const body = await readJsonBody(response, ERROR_RESPONSE_LIMIT_BYTES);
    if (response.status !== 200) {
      const code = azureErrorCode(body);
      const label = code ? `${response.status} ${code}` : String(response.status);
      // 404, 410 and 429 are what the metadata service answers while it is
      // starting or busy; Azure's own guidance is to try again.
      const retry = [404, 410, 429].includes(response.status) || response.status >= 500;
      const wait = retryAfterMs(response);
      return {
        ok: false,
        retry,
        transient: retry,
        reason:
          response.status === 400
            ? `the identity endpoint answered ${label}. Check that this host has a managed identity`
            : `the identity endpoint answered ${label}`,
        ...(wait !== undefined ? { retryAfterMs: wait } : {}),
      };
    }
    const fields = (body ?? {}) as { access_token?: unknown; expires_on?: unknown; expires_in?: unknown };
    if (typeof fields.access_token !== "string" || fields.access_token === "") {
      return {
        ok: false,
        retry: false,
        transient: false,
        reason: "the identity endpoint's answer did not hold a token",
      };
    }
    const now = this.#now();
    const lifetime = tokenExpiry(fields.expires_on, fields.expires_in, now) - now;
    const useFor =
      lifetime > 2 * TOKEN_REFRESH_MARGIN_MS ? lifetime - TOKEN_REFRESH_MARGIN_MS : lifetime / 2;
    return { ok: true, value: { token: fields.access_token, refreshAt: now + Math.max(0, useFor) } };
  }
}

/** When the token stops working, in milliseconds since 1970. `expires_on` is
 *  seconds since 1970 as a string or a number. Older endpoints sent a date,
 *  and some send only `expires_in`. */
function tokenExpiry(expiresOn: unknown, expiresIn: unknown, now: number): number {
  const on = Number(expiresOn);
  if (expiresOn !== null && expiresOn !== "" && Number.isFinite(on) && on > 0) return on * 1000;
  if (typeof expiresOn === "string") {
    const parsed = Date.parse(expiresOn);
    if (Number.isFinite(parsed)) return parsed;
  }
  const within = Number(expiresIn);
  if (expiresIn !== null && expiresIn !== "" && Number.isFinite(within) && within > 0) {
    return now + within * 1000;
  }
  return now + TOKEN_FALLBACK_LIFETIME_MS;
}

/** Why a request got no response. A fixed phrase, never the error's own text:
 *  a fetch error can repeat the URL it was given. */
function networkReason(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") return "timed out";
  return "network error";
}
