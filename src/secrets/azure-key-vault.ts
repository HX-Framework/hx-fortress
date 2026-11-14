// The `azure-key-vault` provider: a secret named `db-url` is the secret
// `db-url` in one Azure Key Vault, read with the managed identity of the
// machine or container this HX Fortress runs on.
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
//     secret's name, a fixed phrase, and a status. An error code from the
//     response is repeated only when it is one of Azure's own, from a fixed
//     list.
//   - Values, the token and the identity header are held in `#` fields, and
//     the two requests are `#` methods. So logging or serializing the provider
//     prints only its kind, and code that holds it cannot ask it for a token.
//   - The token is sent to the configured vault and nowhere else. A redirect
//     is refused on both calls and is not tried again, and the vault's host
//     must be a Key Vault host of a known Azure cloud.
//   - The token request is made in clear text to an endpoint on this host or
//     on its link-local network. It must not go through a proxy named in the
//     environment: see `keepOffProxy`.

import { readBoundedJson } from "../bounded-json";
import { invalidSecretsConfig, type SecretProviderDefinition } from "./definition";
import {
  CACHE_SECONDS_SETTING,
  cacheTtlFromSetting,
  keepEndpointOffProxy,
  NetworkSecretReader,
  noResponse,
  refreshTimeFor,
  retryAfterMs,
  type Attempt,
  type NetworkSecretIo,
  type NetworkSecretReaderOptions,
  type TimedCredential,
} from "./network-reader";
import { SecretProviderBase } from "./provider-base";
import { MAX_SECRET_BYTES } from "./types";

export { DEFAULT_SECRET_CACHE_TTL_MS, MAX_SECRET_CACHE_TTL_MS } from "./network-reader";

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
  const cloud = KEY_VAULT_CLOUDS.find((c) => {
    if (!host.endsWith(c.suffix)) return false;
    // A vault's name: 3 to 24 letters, digits and hyphens. It starts with a
    // letter, ends with a letter or a digit, and has no two hyphens in a row.
    const name = host.slice(0, -c.suffix.length);
    return /^[a-z][a-z0-9-]{1,22}[a-z0-9]$/.test(name) && !name.includes("--");
  });
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
    // An Azure Arc machine publishes IDENTITY_ENDPOINT with IMDS_ENDPOINT and
    // no header. It proves a request with a file on the machine, which is a
    // different protocol.
    if (endpoint && env.IMDS_ENDPOINT?.trim()) {
      throw new Error(
        "this host publishes an Azure Arc managed identity endpoint, which this build cannot use",
      );
    }
    throw new Error(
      "IDENTITY_ENDPOINT and IDENTITY_HEADER must both be set: this host published one without the other",
    );
  }
  return { kind: "imds", endpoint: IMDS_TOKEN_URL, ...(id ? { clientId: id } : {}) };
}

/**
 * Keep the token request away from a proxy named in the environment.
 *
 * The managed identity endpoint is on this host, or on its link-local network,
 * and is spoken to in clear text. A proxy that carried that request would see
 * the identity header and the token that comes back. See
 * `keepEndpointOffProxy` for how it is kept away.
 */
export function keepOffProxy(env: Record<string, string | undefined>, identity: ManagedIdentitySource): void {
  keepEndpointOffProxy(env, identity.endpoint);
}

// ── The provider ────────────────────────────────────────────────────────────

/** Used when the identity endpoint does not say when the token expires. */
const TOKEN_FALLBACK_LIFETIME_MS = 5 * 60_000;

const KEY_VAULT_API_VERSION = "7.4";

export interface AzureKeyVaultOptions extends NetworkSecretReaderOptions {
  vault: KeyVaultTarget;
  identity: ManagedIdentitySource;
}

/**
 * Error codes of Azure Key Vault and of the managed identity endpoints. A code
 * on this list is repeated in an error, because it tells an operator what to
 * fix. Nothing else from a response body is repeated: an error goes to the log
 * and to the console, and text from a response is not something to put there.
 */
const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set([
  // Key Vault
  "AccessDenied",
  "BadParameter",
  "Forbidden",
  "ForbiddenByConnection",
  "ForbiddenByFirewall",
  "ForbiddenByPolicy",
  "ForbiddenByRbac",
  "SecretDisabled",
  "SecretNotFound",
  "Throttled",
  "TooManyRequests",
  "Unauthorized",
  // The managed identity endpoints
  "access_denied",
  "bad_request_100",
  "bad_request_102",
  "invalid_client",
  "invalid_request",
  "invalid_resource",
  "invalid_scope",
  "server_error",
  "service_unavailable",
  "unauthorized_client",
  "unknown_source",
  "unsupported_response_type",
]);

/** An Azure error code, when the body carries one from the list above. The
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
  return typeof value === "string" && KNOWN_ERROR_CODES.has(value) ? value : null;
}

/** Room for the value plus the JSON around it (id, attributes, tags). A JSON
 *  string can take up to six bytes for one byte of value. */
const SECRET_RESPONSE_LIMIT_BYTES = MAX_SECRET_BYTES * 6 + 16 * 1024;
const ERROR_RESPONSE_LIMIT_BYTES = 64 * 1024;

const WORDS = { credential: "managed identity token", credentialRequest: "the token request" } as const;

export class AzureKeyVaultSecretProvider extends SecretProviderBase {
  readonly kind = "azure-key-vault" as const;

  // `#` fields and `#` methods. A TypeScript `private` member is an ordinary
  // property at run time, and this object holds the identity header and can
  // ask for a token.
  readonly #vault: KeyVaultTarget;
  readonly #identity: ManagedIdentitySource;
  /** Keeps the values and the token, and makes the two requests below. */
  readonly #reader: NetworkSecretReader<string>;

  constructor(options: AzureKeyVaultOptions) {
    super();
    this.#vault = options.vault;
    this.#identity = options.identity;
    this.#reader = new NetworkSecretReader<string>(options, {
      words: WORDS,
      sourceOf: (name) => `Azure Key Vault secret ${name} in ${this.#vault.origin}`,
      requestCredential: (io) => this.#requestToken(io),
      requestSecret: (name, token, io) => this.#requestSecret(name, token, io),
    });
  }

  get(name: string): Promise<string> {
    return this.#reader.get(name);
  }

  /** Drop every value and the token now. For shutdown, and for a caller that
   *  knows a secret was just rotated. A read that is on its way still answers
   *  whoever asked for it. A caller that asks after this starts a new read,
   *  so it never gets what the vault held before. */
  forget(): void {
    this.#reader.forget();
  }

  /** How many values are held in memory right now. A count, never a value. */
  get heldValues(): number {
    return this.#reader.heldValues;
  }

  // -- the vault ---------------------------------------------------------------

  async #requestSecret(name: string, token: string, io: NetworkSecretIo): Promise<Attempt<string>> {
    const url = `${this.#vault.origin}/secrets/${name}?api-version=${KEY_VAULT_API_VERSION}`;
    let response: Response;
    try {
      response = await io.request(url, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
    } catch (error) {
      return noResponse(error, "the vault");
    }

    if (response.status === 200) {
      const body = await readBoundedJson(response, SECRET_RESPONSE_LIMIT_BYTES);
      if (body.state === "cut") {
        return { ok: false, retry: true, transient: true, reason: "the vault's answer was cut off" };
      }
      const value = body.state === "json" ? (body.value as { value?: unknown } | null)?.value : undefined;
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

    const errorBody = await readBoundedJson(response, ERROR_RESPONSE_LIMIT_BYTES);
    const code = errorBody.state === "json" ? azureErrorCode(errorBody.value) : null;
    const label = code ? `${response.status} ${code}` : String(response.status);
    const answered = `the vault answered ${label}`;
    if (response.status === 404) {
      // Key Vault says SecretNotFound for a secret that is not there. A 404
      // without that code came from something else on the way, and is not an
      // answer about the secret.
      return code === "SecretNotFound"
        ? { ok: false, retry: false, transient: false, missing: true, reason: answered }
        : {
            ok: false,
            retry: false,
            transient: false,
            reason: `${answered}, which is not what Key Vault answers for a secret that is not there`,
          };
    }
    if (response.status === 407) {
      return {
        ok: false,
        retry: false,
        transient: false,
        reason: "a proxy between this host and the vault asked for credentials (407)",
      };
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

  // -- the token ---------------------------------------------------------------

  async #requestToken(io: NetworkSecretIo): Promise<Attempt<TimedCredential<string>>> {
    const identity = this.#identity;
    const url = new URL(identity.endpoint);
    url.searchParams.set("resource", this.#vault.resource);
    url.searchParams.set("api-version", identity.kind === "identity-endpoint" ? "2019-08-01" : "2018-02-01");
    if (identity.clientId) url.searchParams.set("client_id", identity.clientId);
    const headers: Record<string, string> =
      identity.kind === "identity-endpoint" ? { "x-identity-header": identity.header } : { metadata: "true" };

    let response: Response;
    try {
      response = await io.request(url.toString(), {
        method: "GET",
        headers: { ...headers, accept: "application/json" },
      });
    } catch (error) {
      return noResponse(error, "the identity endpoint");
    }
    const read = await readBoundedJson(response, ERROR_RESPONSE_LIMIT_BYTES);
    const body = read.state === "json" ? read.value : null;
    if (response.status === 200 && read.state === "cut") {
      return {
        ok: false,
        retry: true,
        transient: true,
        reason: "the identity endpoint's answer was cut off",
      };
    }
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
    // A managed identity token lives a day at most, and `refreshTimeFor`
    // trusts no answer for longer than that.
    const now = io.now();
    const lifetime = tokenExpiry(fields.expires_on, fields.expires_in, now) - now;
    return { ok: true, value: { credential: fields.access_token, refreshAt: refreshTimeFor(now, lifetime) } };
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

// ── The provider, as providers.ts lists it ──────────────────────────────────

export interface AzureKeyVaultSecretsConfig {
  provider: "azure-key-vault";
  vault: KeyVaultTarget;
  /** Picks one user-assigned managed identity. Absent means the
   *  system-assigned one. */
  clientId?: string;
  /** How long a value read from the vault is kept in memory. Absent means
   *  the provider's default. */
  cacheTtlMs?: number;
}

const VAULT_URL_ENV = "FORTRESS_SECRETS_AZURE_VAULT_URL";

export const AZURE_KEY_VAULT_SECRET_PROVIDER = {
  kind: "azure-key-vault",
  cloud: "Azure",
  summary:
    "The secret `db-url` in one Azure Key Vault, read with the managed identity of the machine or " +
    "container. There is no client secret and no Azure SDK. A value is kept in memory for one minute by " +
    "default.",
  needs:
    "A managed identity. HX Fortress must run on an Azure service that gives it one, such as Azure " +
    "Container Apps, App Service or a virtual machine.",
  settings: [
    {
      key: "vaultUrl",
      env: VAULT_URL_ENV,
      meaning:
        "Required. `https://<name>.vault.azure.net`. The host must be a Key Vault host of a known Azure " +
        "cloud, because the identity's token is sent there.",
      oneLetterShort: { holds: "an address", when: (value) => /^https?:\/\//i.test(value) },
    },
    {
      key: "clientId",
      env: "FORTRESS_SECRETS_AZURE_CLIENT_ID",
      meaning:
        "The client id of a user-assigned managed identity. Leave it out to use the system-assigned one.",
      oneLetterShort: { holds: "a client id", when: (value) => MANAGED_IDENTITY_CLIENT_ID.test(value) },
    },
    CACHE_SECONDS_SETTING,
  ],
  // The prefix the vault's address and the client id had before they were
  // renamed. Those names are not read. A variable that still starts with it is
  // refused by name, so a host that carries an old name does not start on
  // another vault, or with another identity, than the one its operator set.
  guardedEnvPrefixes: ["FORTRESS_KEY_VAULT_"],
  resolve({ setting }) {
    const vaultUrl = setting("vaultUrl");
    const clientId = setting("clientId");
    const cacheSeconds = setting("cacheSeconds");
    if (!vaultUrl) {
      throw invalidSecretsConfig(
        "the azure-key-vault provider needs the vault's address: set " +
          `${VAULT_URL_ENV}, or secrets.vaultUrl in config.json`,
      );
    }
    let vault: KeyVaultTarget;
    try {
      vault = parseKeyVaultUrl(vaultUrl.value);
    } catch (error) {
      // The parser's messages name the rule that was broken and never repeat
      // what was written.
      throw invalidSecretsConfig(
        `${vaultUrl.where}: ${error instanceof Error ? error.message : "it is not usable"}`,
      );
    }
    if (clientId && !MANAGED_IDENTITY_CLIENT_ID.test(clientId.value)) {
      throw invalidSecretsConfig(
        `${clientId.where} must be the client id (a GUID) of a user-assigned managed identity`,
      );
    }
    const cacheTtlMs = cacheTtlFromSetting(cacheSeconds);
    return {
      provider: "azure-key-vault",
      vault,
      ...(clientId ? { clientId: clientId.value.toLowerCase() } : {}),
      ...(cacheTtlMs !== undefined ? { cacheTtlMs } : {}),
    };
  },
  create(config, deps) {
    let identity;
    try {
      // Reads IDENTITY_ENDPOINT and IDENTITY_HEADER, which Azure sets. No
      // request is made until a secret is asked for.
      identity = resolveManagedIdentity(deps.env ?? process.env, config.clientId);
    } catch (error) {
      throw invalidSecretsConfig(
        error instanceof Error ? error.message : "the managed identity could not be resolved",
      );
    }
    // The token request must not go through a proxy named in the
    // environment. In a running HX Fortress `deps.env` is the process's own
    // environment, which is where the runtime looks when it makes a request.
    keepOffProxy(deps.env ?? process.env, identity);
    return new AzureKeyVaultSecretProvider({
      vault: config.vault,
      identity,
      ...(config.cacheTtlMs !== undefined ? { cacheTtlMs: config.cacheTtlMs } : {}),
    });
  },
  describe: (config) => `azure-key-vault (${config.vault.origin})`,
  path: (config) => ({
    leavesHost: true,
    peer: `${config.vault.origin}, with a token from the platform's managed identity endpoint`,
    carries:
      "the name of each secret this HX Fortress reads goes out with the token; the secret's value comes back",
    gate: "this host's managed identity, which needs the Key Vault Secrets User role on that vault",
    notes: [
      "The control plane is not on this path. The vault and the identity are the organization's own.",
      "A value is kept in memory for a short time and is written to no file. The token is sent to " +
        "that vault and nowhere else: a redirect is refused.",
    ],
  }),
} satisfies SecretProviderDefinition<"azure-key-vault", AzureKeyVaultSecretsConfig>;
