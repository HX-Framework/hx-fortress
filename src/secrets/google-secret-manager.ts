// The `google-secret-manager` provider: a secret named `db-url` is the newest
// version of the secret `db-url` in one Google Cloud project, read with the
// service account of the machine or container this HX Fortress runs on.
//
// Two HTTP calls, and no Google SDK:
//
//   1. A token, from the metadata server that Google Cloud gives every
//      machine and container:
//      GET http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token
//      with the header `Metadata-Flavor: Google`.
//   2. GET https://secretmanager.googleapis.com/v1/projects/{project}/secrets/{name}/versions/latest:access
//      with that token. The answer holds the value in base64, and the CRC32C
//      checksum of its bytes.
//
// What this file keeps true:
//
//   - A value is held in memory only, for `cacheTtlMs` at most, and then
//     dropped. Nothing here writes to disk.
//   - No error holds a value, a token or a response body. An error says the
//     secret's name, a fixed phrase, and a status. A status name or an error
//     reason from the response is repeated only when it is one of Google's
//     own, from a fixed list. The message text of a response is never used.
//   - Values and the token are held in `#` fields, and the two requests are
//     `#` methods. So logging or serializing the provider prints only its
//     kind, and code that holds it cannot ask it for a token.
//   - The token is sent to Secret Manager and nowhere else. A redirect is
//     refused on both calls and is not tried again.
//   - The token request is made in clear text to the metadata server, on this
//     host's link-local network. It must not go through a proxy named in the
//     environment: `create` keeps it off one.
//   - A value whose bytes do not match the checksum that came with them is not
//     returned.
//
// What it does not read: a regional secret, which lives at another address
// and under a path with a location in it.

import { readBoundedJson } from "../bounded-json";
import { crc32c } from "./crc32c";
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

// ── The project ─────────────────────────────────────────────────────────────

/** A project's id: 6 to 30 lowercase letters, digits and hyphens. It starts
 *  with a letter and does not end with a hyphen. */
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** A project's number, which Google takes in place of its id. */
const PROJECT_NUMBER = /^[0-9]{6,20}$/;

/**
 * True for a project's id or its number.
 *
 * The project is written into the path of the request that carries the token.
 * Both forms hold nothing that changes a path: no slash, no dot, no percent
 * sign. An id with a domain and a colon in front, which some old projects
 * have, is not accepted here: give such a project by its number.
 */
export function isGoogleProject(value: string): boolean {
  return PROJECT_ID.test(value) || PROJECT_NUMBER.test(value);
}

// ── The two addresses ───────────────────────────────────────────────────────

/** Where a machine or container on Google Cloud gets a token for the service
 *  account it runs as. The name resolves only inside Google Cloud. */
export const GOOGLE_METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

/** Secret Manager's address for secrets that are not regional. */
export const GOOGLE_SECRET_MANAGER_ORIGIN = "https://secretmanager.googleapis.com";

export interface GoogleSecretManagerOptions extends NetworkSecretReaderOptions {
  /** The project that holds the secrets: its id or its number. */
  project: string;
  /** Injected in tests: the two addresses, in place of Google's own. */
  tokenUrl?: string;
  secretManagerOrigin?: string;
}

// ── What a response may put into an error ───────────────────────────────────

/** The status names of Google's APIs (google.rpc.Code). */
const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  "CANCELLED",
  "UNKNOWN",
  "INVALID_ARGUMENT",
  "DEADLINE_EXCEEDED",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "PERMISSION_DENIED",
  "UNAUTHENTICATED",
  "RESOURCE_EXHAUSTED",
  "FAILED_PRECONDITION",
  "ABORTED",
  "OUT_OF_RANGE",
  "UNIMPLEMENTED",
  "INTERNAL",
  "UNAVAILABLE",
  "DATA_LOSS",
]);

/**
 * Error reasons of Google's API infrastructure (google.api.ErrorReason) that
 * tell an operator what to fix. A reason on this list is repeated in an
 * error. Nothing else from a response body is: an error goes to the log and
 * to the console, and text from a response is not something to put there.
 */
const KNOWN_REASONS: ReadonlySet<string> = new Set([
  "ACCESS_TOKEN_EXPIRED",
  "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
  "ACCOUNT_STATE_INVALID",
  "BILLING_DISABLED",
  "CONSUMER_INVALID",
  "CREDENTIALS_MISSING",
  "IAM_PERMISSION_DENIED",
  "RATE_LIMIT_EXCEEDED",
  "RESOURCE_PROJECT_INVALID",
  "RESOURCE_QUOTA_EXCEEDED",
  "SERVICE_DISABLED",
]);

const ERROR_INFO_TYPE = "type.googleapis.com/google.rpc.ErrorInfo";

/** The domains of the reasons above: Google's API infrastructure, and each of
 *  its services under it (`iam.googleapis.com`). A reason under any other
 *  domain is somebody else's word, and is not repeated. */
function isGoogleDomain(domain: unknown): boolean {
  return typeof domain === "string" && /^(?:[a-z0-9-]{1,63}\.)?googleapis\.com$/.test(domain);
}

/** The status name and the reason of an error body, each only when it is on
 *  its list. The body's message is free text from the service and is not read. */
function googleError(body: unknown): { status: string | null; reason: string | null } {
  const error = (body as { error?: unknown } | null)?.error;
  if (!error || typeof error !== "object") return { status: null, reason: null };
  const named = (error as { status?: unknown }).status;
  const status = typeof named === "string" && KNOWN_STATUSES.has(named) ? named : null;
  const details = (error as { details?: unknown }).details;
  let reason: string | null = null;
  if (Array.isArray(details)) {
    for (const detail of details.slice(0, 16) as unknown[]) {
      if (!detail || typeof detail !== "object") continue;
      const info = detail as { "@type"?: unknown; reason?: unknown; domain?: unknown };
      if (info["@type"] !== ERROR_INFO_TYPE || !isGoogleDomain(info.domain)) continue;
      if (typeof info.reason === "string" && KNOWN_REASONS.has(info.reason)) {
        reason = info.reason;
        break;
      }
    }
  }
  return { status, reason };
}

// ── Reading the value out of an answer ──────────────────────────────────────

/** Room for the value in base64, which is a third longer than its bytes, plus
 *  the JSON around it. The limit admits a value up to twice the size a secret
 *  may have, so that a value that is too large is refused as too large, by
 *  the rule every provider shares, and not as an answer that could not be read. */
const SECRET_RESPONSE_LIMIT_BYTES = Math.ceil((MAX_SECRET_BYTES * 2) / 3) * 4 + 16 * 1024;
const TOKEN_RESPONSE_LIMIT_BYTES = 64 * 1024;
const ERROR_RESPONSE_LIMIT_BYTES = 64 * 1024;

/** Base64 as a JSON answer of a Google API may write it: the standard
 *  alphabet or the one for URLs, with or without padding. */
const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;

/** The bytes of a base64 string, or null when it is not base64. */
function bytesFromBase64(text: string): Uint8Array | null {
  if (!BASE64.test(text)) return null;
  const unpadded = text.replace(/=+$/, "");
  // Four characters hold three bytes. One character alone holds no whole byte.
  if (unpadded.length % 4 === 1) return null;
  // The runtime's decoder reads both alphabets. A test holds it to that.
  return new Uint8Array(Buffer.from(unpadded, "base64"));
}

/**
 * Whether `bytes` match the checksum that came with them.
 *
 * `sent` is the CRC32C as a decimal number in a string, which is how a JSON
 * answer writes a 64-bit number, or as a plain number. No checksum at all is
 * not a mismatch: Google stores none for some old versions, and then sends
 * none.
 */
function checksumHolds(bytes: Uint8Array, sent: unknown): boolean {
  if (sent === undefined || sent === null) return true;
  const digits =
    typeof sent === "string" ? sent : typeof sent === "number" && Number.isSafeInteger(sent) ? String(sent) : "";
  if (!/^[0-9]{1,20}$/.test(digits)) return false;
  return BigInt(digits) === BigInt(crc32c(bytes));
}

// ── The provider ────────────────────────────────────────────────────────────

/** What a token may be made of: what an Authorization header can carry. */
const TOKEN = /^[\x21-\x7e]{1,16384}$/;

const WORDS = { credential: "service account token", credentialRequest: "the token request" } as const;

export class GoogleSecretManagerSecretProvider extends SecretProviderBase {
  readonly kind = "google-secret-manager" as const;

  // `#` fields and `#` methods. A TypeScript `private` member is an ordinary
  // property at run time, and this object can ask for a token.
  readonly #project: string;
  readonly #tokenUrl: string;
  readonly #origin: string;
  /** Keeps the values and the token, and makes the two requests below. */
  readonly #reader: NetworkSecretReader<string>;

  constructor(options: GoogleSecretManagerOptions) {
    super();
    if (!isGoogleProject(options.project)) {
      // Never reached through the settings, which check it first. Reached by a
      // caller that builds the provider by hand, and the project goes into the
      // path of the request that carries the token.
      throw new Error("the Google Cloud project must be a project id or a project number");
    }
    this.#project = options.project;
    this.#tokenUrl = options.tokenUrl ?? GOOGLE_METADATA_TOKEN_URL;
    this.#origin = options.secretManagerOrigin ?? GOOGLE_SECRET_MANAGER_ORIGIN;
    this.#reader = new NetworkSecretReader<string>(options, {
      words: WORDS,
      sourceOf: (name) => `Google Secret Manager secret ${name} in project ${this.#project}`,
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
   *  so it never gets what Secret Manager held before. */
  forget(): void {
    this.#reader.forget();
  }

  /** How many values are held in memory right now. A count, never a value. */
  get heldValues(): number {
    return this.#reader.heldValues;
  }

  // -- Secret Manager --------------------------------------------------------------

  async #requestSecret(name: string, token: string, io: NetworkSecretIo): Promise<Attempt<string>> {
    // `latest` is the version that was created last, whatever its state.
    const url = `${this.#origin}/v1/projects/${this.#project}/secrets/${name}/versions/latest:access`;
    let response: Response;
    try {
      response = await io.request(url, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
    } catch (error) {
      return noResponse(error, "Secret Manager");
    }

    if (response.status === 200) {
      const body = await readBoundedJson(response, SECRET_RESPONSE_LIMIT_BYTES);
      if (body.state === "cut") {
        return { ok: false, retry: true, transient: true, reason: "Secret Manager's answer was cut off" };
      }
      const noValue: Attempt<string> = {
        ok: false,
        retry: false,
        transient: false,
        reason: "Secret Manager's answer did not hold a secret value",
      };
      const payload = body.state === "json" ? (body.value as { payload?: unknown } | null)?.payload : undefined;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return noValue;
      const { data, dataCrc32c } = payload as { data?: unknown; dataCrc32c?: unknown };
      // A JSON answer leaves an empty field out, so a payload with no data is
      // a value of no bytes, and the rule every provider shares then calls it
      // a missing secret. "Missing" is the reading a caller may act on, so an
      // answer with no bytes is taken as one only when it carries the
      // checksum of no bytes. Without it the answer says nothing.
      if (data !== undefined && typeof data !== "string") return noValue;
      const bytes = bytesFromBase64(data ?? "");
      if (!bytes) return noValue;
      if (bytes.byteLength === 0 && (dataCrc32c === undefined || dataCrc32c === null)) return noValue;
      if (!checksumHolds(bytes, dataCrc32c)) {
        // The bytes changed between Secret Manager's store and this process.
        // The next answer may be whole.
        return {
          ok: false,
          retry: true,
          transient: true,
          reason: "the value in Secret Manager's answer did not match its checksum",
        };
      }
      try {
        // A byte-order mark at the start is dropped by the decoder. Anything
        // that is not UTF-8 is refused.
        return { ok: true, value: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
      } catch {
        // The decoder's own error is not passed on. This module never
        // forwards anything derived from a value.
        return { ok: false, retry: false, transient: false, reason: "the value is not UTF-8 text" };
      }
    }

    const errorBody = await readBoundedJson(response, ERROR_RESPONSE_LIMIT_BYTES);
    if (errorBody.state === "cut") {
      // The answer did not arrive whole, so what it says about the secret is
      // not known. The next one may be whole.
      return { ok: false, retry: true, transient: true, reason: "Secret Manager's answer was cut off" };
    }
    const { status, reason } = errorBody.state === "json" ? googleError(errorBody.value) : { status: null, reason: null };
    const label = [String(response.status), status, reason].filter(Boolean).join(" ");
    const answered = `Secret Manager answered ${label}`;
    if (response.status === 404) {
      // Secret Manager says NOT_FOUND for a secret that is not there, and for
      // one that has no version yet. A 404 without that status came from
      // something else on the way, and is not an answer about the secret.
      return status === "NOT_FOUND"
        ? { ok: false, retry: false, transient: false, missing: true, reason: answered }
        : {
            ok: false,
            retry: false,
            transient: false,
            reason: `${answered}, which is not what Secret Manager answers for a secret that is not there`,
          };
    }
    if (response.status === 407) {
      return {
        ok: false,
        retry: false,
        transient: false,
        reason: "a proxy between this host and Secret Manager asked for credentials (407)",
      };
    }
    if (response.status === 401) {
      return {
        ok: false,
        retry: false,
        transient: false,
        unauthorized: true,
        reason: `Secret Manager refused the token (${label})`,
      };
    }
    if (response.status === 403) {
      return {
        ok: false,
        retry: false,
        // A role granted a moment ago is refused for a while before it takes
        // effect, so a caller may ask again later. A machine's access scopes
        // are another matter: they change only when the machine is stopped
        // and started, so waiting gains nothing.
        transient: reason !== "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
        // Secret Manager's own answer that this service account may not read
        // this secret. An API that is switched off, a missing access scope or
        // billing is about the whole project, and a 403 without Google's
        // status came from something on the way: neither is this.
        refused: status === "PERMISSION_DENIED" && (reason === null || reason === "IAM_PERMISSION_DENIED"),
        reason: `Secret Manager refused the request (${label}). ${whatToGrant(reason)}`,
      };
    }
    if (status === "FAILED_PRECONDITION") {
      // The newest version exists and cannot be read. Secret Manager answers
      // the same for a version that is switched off or destroyed and for an
      // encryption key it may not use, and only its message text tells them
      // apart. So this is not called a missing secret: a caller that takes
      // "missing" as "not configured" would go on without it.
      return {
        ok: false,
        retry: false,
        transient: false,
        reason:
          `${answered}. The newest version of this secret is disabled or destroyed, ` +
          "or its encryption key cannot be used. Only the newest version is read",
      };
    }
    if (response.status === 408 || response.status === 429 || response.status >= 500 || status === "ABORTED") {
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
    let response: Response;
    try {
      response = await io.request(this.#tokenUrl, {
        method: "GET",
        // The metadata server answers only a request that carries this header.
        headers: { "Metadata-Flavor": "Google", accept: "application/json" },
      });
    } catch (error) {
      return noResponse(error, "the metadata server");
    }
    const read = await readBoundedJson(response, TOKEN_RESPONSE_LIMIT_BYTES);
    if (response.status === 200 && read.state === "cut") {
      return {
        ok: false,
        retry: true,
        transient: true,
        reason: "the metadata server's answer was cut off",
      };
    }
    if (response.status !== 200) {
      // The metadata server answers 429 and 503 as a matter of routine, while
      // it starts and while its host is maintained. Google's guidance is to
      // try again. Its error text is never read.
      const retry = response.status === 429 || response.status >= 500;
      const wait = retryAfterMs(response);
      return {
        ok: false,
        retry,
        transient: retry,
        reason: `the metadata server answered ${response.status}${metadataHint(response.status)}`,
        ...(wait !== undefined ? { retryAfterMs: wait } : {}),
      };
    }
    const fields = (read.state === "json" && read.value && typeof read.value === "object" ? read.value : {}) as {
      access_token?: unknown;
      expires_in?: unknown;
      token_type?: unknown;
    };
    const bearer = fields.token_type === undefined || /^bearer$/i.test(String(fields.token_type));
    if (typeof fields.access_token !== "string" || !TOKEN.test(fields.access_token) || !bearer) {
      return {
        ok: false,
        retry: false,
        transient: false,
        reason: "the metadata server's answer did not hold a token",
      };
    }
    // `expires_in` is a number of seconds: 3,599 in Google's own example. An
    // answer that does not say is a lifetime nobody stated, and such a token
    // is not kept. `refreshTimeFor` trusts no answer for more than a day.
    const stated = fields.expires_in;
    const seconds =
      typeof stated === "number" ? stated : typeof stated === "string" && /^\d{1,9}$/.test(stated) ? Number(stated) : Number.NaN;
    const lifetime = seconds > 0 ? seconds * 1000 : Number.NaN;
    return {
      ok: true,
      value: { credential: fields.access_token, refreshAt: refreshTimeFor(io.now(), lifetime) },
    };
  }
}

/** What to do about a refused request, by the reason Google gave for it. */
function whatToGrant(reason: string | null): string {
  if (reason === "SERVICE_DISABLED") return "The Secret Manager API is switched off in the project";
  if (reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT") {
    return "The machine this host runs on needs the cloud-platform access scope";
  }
  if (reason === "BILLING_DISABLED") return "Billing is switched off for the project";
  return (
    "The service account this host runs as needs the role Secret Manager Secret Accessor " +
    "(roles/secretmanager.secretAccessor) on this secret"
  );
}

/** A few words for a status of the metadata server that has one cause. */
function metadataHint(status: number): string {
  if (status === 404) return ". Check that this host runs with a service account";
  if (status === 401) return ", which it answers when this host's service account is disabled";
  if (status === 403) return ", which it answers when the project or the machine has this endpoint switched off";
  return "";
}

// ── The provider, as providers.ts lists it ──────────────────────────────────

export interface GoogleSecretManagerSecretsConfig {
  provider: "google-secret-manager";
  /** The project that holds the secrets: its id or its number. */
  project: string;
  /** How long a value read from Secret Manager is kept in memory. Absent
   *  means the provider's default. */
  cacheTtlMs?: number;
}

const PROJECT_ENV = "FORTRESS_SECRETS_GOOGLE_PROJECT";

export const GOOGLE_SECRET_MANAGER_SECRET_PROVIDER = {
  kind: "google-secret-manager",
  cloud: "Google Cloud",
  summary:
    "The newest version of the secret `db-url` in one Google Cloud project, read from Secret Manager " +
    "with the service account of the machine or container. There is no key file and no Google SDK. A " +
    "value is kept in memory for one minute by default. A regional secret is not read.",
  needs:
    "A service account. HX Fortress must run on a Google Cloud service that gives it one through the " +
    "metadata server, such as Cloud Run or Compute Engine. On Compute Engine the machine also needs the " +
    "`cloud-platform` access scope.",
  settings: [
    {
      key: "project",
      env: PROJECT_ENV,
      meaning: "Required. The id of the Google Cloud project that holds the secrets, or its number.",
    },
    CACHE_SECONDS_SETTING,
  ],
  resolve({ setting }) {
    const project = setting("project");
    const cacheSeconds = setting("cacheSeconds");
    if (!project) {
      throw invalidSecretsConfig(
        "the google-secret-manager provider needs the project: set " +
          `${PROJECT_ENV}, or secrets.project in config.json`,
      );
    }
    if (!isGoogleProject(project.value)) {
      // What was written is not repeated: a line pasted into the wrong
      // setting can be a credential.
      throw invalidSecretsConfig(
        `${project.where} must be a project id (6 to 30 lowercase letters, digits and hyphens, ` +
          "starting with a letter) or a project number",
      );
    }
    const cacheTtlMs = cacheTtlFromSetting(cacheSeconds);
    return {
      provider: "google-secret-manager",
      project: project.value,
      ...(cacheTtlMs !== undefined ? { cacheTtlMs } : {}),
    };
  },
  create(config, deps) {
    // The token request must not go through a proxy named in the
    // environment. In a running HX Fortress `deps.env` is the process's own
    // environment, which is where the runtime looks when it makes a request.
    keepEndpointOffProxy(deps.env ?? process.env, GOOGLE_METADATA_TOKEN_URL);
    return new GoogleSecretManagerSecretProvider({
      project: config.project,
      ...(config.cacheTtlMs !== undefined ? { cacheTtlMs: config.cacheTtlMs } : {}),
    });
  },
  describe: (config) => `google-secret-manager (project ${config.project})`,
  path: (config) => ({
    leavesHost: true,
    peer:
      `${GOOGLE_SECRET_MANAGER_ORIGIN}, for the project ${config.project}, ` +
      "with a token from the metadata server of the machine or container",
    carries:
      "the project and the name of each secret this HX Fortress reads go out with the token; " +
      "the secret's value comes back",
    gate:
      "the service account this host runs as, which needs the role Secret Manager Secret Accessor " +
      "on each secret it reads",
    notes: [
      "The control plane is not on this path. The project and the service account are the organization's own.",
      "A value is kept in memory for a short time and is written to no file. The token is sent to " +
        "Secret Manager and nowhere else: a redirect is refused.",
    ],
  }),
} satisfies SecretProviderDefinition<"google-secret-manager", GoogleSecretManagerSecretsConfig>;
