// The `aws-secrets-manager` provider: a secret named `db-url` is the current
// version of the secret `db-url` in AWS Secrets Manager, in one region, read
// with the role of the task or machine this HX Fortress runs on.
//
// Plain HTTP requests, and no AWS SDK:
//
//   1. Temporary credentials of the host's own role, from the platform:
//      - an Amazon ECS task, AWS Fargate included, publishes a path in
//        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI, and answers at
//        http://169.254.170.2 under it;
//      - an Amazon EC2 instance has the instance metadata service at
//        169.254.169.254. Version 2 of it is asked: a PUT for a session
//        token, then the role's name, then the role's credentials.
//   2. POST https://secretsmanager.{region}.amazonaws.com/ with the header
//      `X-Amz-Target: secretsmanager.GetSecretValue`, signed with those
//      credentials (aws-sigv4.ts).
//
// What this file keeps true:
//
//   - A value is held in memory only, for `cacheTtlMs` at most, and then
//     dropped. Nothing here writes to disk.
//   - No error holds a value, a credential or a response body. An error says
//     the secret's name, a fixed phrase, and a status. The name of an error
//     from a response is repeated only when it is one of AWS's own, from a
//     fixed list. The message of a response is never read.
//   - Values and the credentials are held in `#` fields, and the requests are
//     `#` methods. So logging or serializing the provider prints only its
//     kind, and code that holds it cannot ask it for credentials.
//   - The secret key of the credentials is never sent. Each request to
//     Secrets Manager carries a signature made with it, for that host and
//     that body. A redirect is refused and is not tried again.
//   - The requests for credentials are made in clear text to an address on
//     this host's link-local network. They must not go through a proxy named
//     in the environment: `create` keeps them off one.
//
// What it does not read: a secret in another account (those are named by an
// address, not by a name), and the regions of China and of the isolated
// partitions, whose hosts end differently.
//
// What it does not use: an access key in the environment or in a file, and an
// address or a token for the credentials that the environment names
// (AWS_CONTAINER_CREDENTIALS_FULL_URI, AWS_CONTAINER_AUTHORIZATION_TOKEN). An
// Amazon ECS task needs neither. A role given through a web identity token
// (AWS_WEB_IDENTITY_TOKEN_FILE), which is how Amazon EKS gives a pod its role,
// is not read either. A host with one of the two is refused by name, and is
// not asked for the machine's role instead.

import { readBoundedJson } from "../bounded-json";
import { signAwsRequest, type AwsCredential } from "./aws-sigv4";
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

// ── The region ──────────────────────────────────────────────────────────────

/**
 * True for a region whose Secrets Manager this build can ask.
 *
 * A region's name is two letters, one to three words and a number, with a
 * hyphen between: `us-east-1`, `eu-central-1`, `us-gov-west-1`. It is written
 * into the host of the request, so it holds nothing but lowercase letters,
 * digits and hyphens. The regions of China (`cn-`) and of the isolated
 * partitions (`-iso`) are refused: their hosts do not end in `amazonaws.com`.
 */
export function isAwsRegion(value: string): boolean {
  if (value.length > 32) return false;
  const parts = value.split("-");
  if (parts.length < 3 || parts.length > 5) return false;
  const letters = parts[0] ?? "";
  const number = parts[parts.length - 1] ?? "";
  const words = parts.slice(1, -1);
  if (!/^[a-z]{2}$/.test(letters) || !/^[0-9]{1,2}$/.test(number)) return false;
  if (!words.every((word) => /^[a-z]+$/.test(word))) return false;
  return letters !== "cn" && !words.some((word) => word.startsWith("iso"));
}

/** Secrets Manager's address in one region. */
export function awsSecretsManagerOrigin(region: string): string {
  return `https://secretsmanager.${region}.amazonaws.com`;
}

// ── Where the credentials come from ─────────────────────────────────────────

/** Where an Amazon ECS task asks for the credentials of its task role. */
const CONTAINER_CREDENTIALS_ORIGIN = "http://169.254.170.2";

/** The instance metadata service of an Amazon EC2 instance. The address is
 *  the same on every instance and is not routable from outside it. */
const INSTANCE_METADATA_ORIGIN = "http://169.254.169.254";

export type AwsCredentialSource =
  | {
      /** An Amazon ECS task, AWS Fargate included. */
      kind: "container";
      /** The whole address: the fixed origin and the task's own path. */
      url: string;
    }
  | {
      /** An Amazon EC2 instance. */
      kind: "instance-metadata";
      origin: string;
    };

/**
 * Where the credentials come from on this host.
 *
 * AWS_CONTAINER_CREDENTIALS_RELATIVE_URI means an ECS task: its path is
 * appended to one fixed address. With it absent, the instance metadata
 * service is asked.
 *
 * Two hosts are refused by name, because the instance metadata service would
 * answer there with the machine's role in place of the one the host was given:
 *
 *   - a host that was given its role through a web identity token
 *     (AWS_WEB_IDENTITY_TOKEN_FILE), which is what Amazon EKS does for a pod.
 *     This build does not ask for such a role's credentials. It is refused
 *     first: AWS's own tools take that role before a task's;
 *   - a host that publishes a whole address of its own
 *     (AWS_CONTAINER_CREDENTIALS_FULL_URI). This build does not ask an
 *     address that the environment chooses.
 */
export function resolveAwsCredentialSource(env: Record<string, string | undefined>): AwsCredentialSource {
  if (env.AWS_WEB_IDENTITY_TOKEN_FILE?.trim()) {
    throw new Error(
      "this host was given its role through a web identity token (AWS_WEB_IDENTITY_TOKEN_FILE), which this build cannot use",
    );
  }
  const relative = env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI?.trim();
  if (relative) {
    let url: URL | null = null;
    if (/^\/[\x21-\x7e]{0,2047}$/.test(relative)) {
      try {
        url = new URL(`${CONTAINER_CREDENTIALS_ORIGIN}${relative}`);
      } catch {
        url = null;
      }
    }
    if (!url || url.origin !== CONTAINER_CREDENTIALS_ORIGIN || url.username || url.password) {
      throw new Error("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI is not a path");
    }
    return { kind: "container", url: url.toString() };
  }
  if (env.AWS_CONTAINER_CREDENTIALS_FULL_URI?.trim()) {
    throw new Error(
      "this host publishes its credentials at an address of its own (AWS_CONTAINER_CREDENTIALS_FULL_URI), " +
        "which this build cannot use",
    );
  }
  return { kind: "instance-metadata", origin: INSTANCE_METADATA_ORIGIN };
}

/** The address a credential source is asked at, for keeping it off a proxy. */
function endpointOf(source: AwsCredentialSource): string {
  return source.kind === "container" ? source.url : source.origin;
}

export interface AwsSecretsManagerOptions extends NetworkSecretReaderOptions {
  region: string;
  credentials: AwsCredentialSource;
  /** Injected in tests: Secrets Manager's address, in place of AWS's own. */
  secretsManagerOrigin?: string;
}

// ── What a response may put into an error ───────────────────────────────────

/**
 * Error names of Secrets Manager and of AWS's request layer. A name on this
 * list is repeated in an error, because it tells an operator what to fix.
 * Nothing else from a response is repeated: an error goes to the log and to
 * the console, and text from a response is not something to put there.
 */
const KNOWN_ERRORS: ReadonlySet<string> = new Set([
  "AccessDeniedException",
  "DecryptionFailure",
  "ExpiredTokenException",
  "IncompleteSignature",
  "InternalFailure",
  "InternalServiceError",
  "InvalidClientTokenId",
  "InvalidParameterException",
  "InvalidRequestException",
  "InvalidSignatureException",
  "MissingAuthenticationToken",
  "NotAuthorized",
  "OptInRequired",
  "RequestExpired",
  "RequestLimitExceeded",
  "ResourceNotFoundException",
  "ServiceUnavailable",
  "SignatureDoesNotMatch",
  "Throttling",
  "ThrottlingException",
  "TooManyRequestsException",
  "UnrecognizedClientException",
  "ValidationException",
]);

/** Names that mean: these credentials are not accepted. New ones are asked for, once. */
const CREDENTIAL_REFUSED: ReadonlySet<string> = new Set([
  "ExpiredTokenException",
  "InvalidClientTokenId",
  "UnrecognizedClientException",
]);

/** Names that mean: too many requests, ask again in a moment. */
const THROTTLED: ReadonlySet<string> = new Set([
  "RequestLimitExceeded",
  "Throttling",
  "ThrottlingException",
  "TooManyRequestsException",
]);

/** Names that mean: the role may not read this secret. */
const NO_ACCESS: ReadonlySet<string> = new Set(["AccessDeniedException", "NotAuthorized"]);

/** Names AWS answers with a status of 500 or more. Every other name on the
 *  list comes with a status from 400 to 499. */
const SERVER_ERRORS: ReadonlySet<string> = new Set(["InternalFailure", "InternalServiceError", "ServiceUnavailable"]);

/** Names AWS answers when it has judged the time a request carries, or the
 *  time its credentials end. */
const TIME_JUDGED: ReadonlySet<string> = new Set(["ExpiredTokenException", "InvalidSignatureException", "RequestExpired"]);

/** The status of AWS's answer for a secret it does not hold. */
const NOT_FOUND_STATUS = 400;

/** The name a `__type` or the header beside it carries:
 *  `com.amazonaws.secretsmanager#ResourceNotFoundException:http://...` holds
 *  it between the last `#` and the first `:` after it. Null when there is no
 *  text to read a name from. */
function nameIn(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Too long to be a name of AWS's: it is a name, and not one on the list.
  if (raw.length > 256) return "";
  return (raw.split("#").pop() ?? "").split(":")[0]?.trim() ?? "";
}

/**
 * The error's name, when the answer carries one of AWS's own. The body's
 * `__type` and the header AWS sends beside it are both read. The body's
 * message is never read.
 *
 * An answer that does not say one thing has no name, and is read by its
 * status alone: one whose body and header name different errors, and one
 * whose name does not go with its status. Something on the way to AWS can
 * answer in AWS's place, and a name it carries is not AWS's word on a secret.
 */
function awsErrorName(body: unknown, response: Response): string | null {
  const inBody = body && typeof body === "object" && !Array.isArray(body) ? nameIn((body as { __type?: unknown }).__type) : null;
  const inHeader = nameIn(response.headers.get("x-amzn-errortype"));
  if (inBody !== null && inHeader !== null && inBody !== inHeader) return null;
  const name = inBody ?? inHeader;
  if (name === null || !KNOWN_ERRORS.has(name)) return null;
  const goesWithStatus = SERVER_ERRORS.has(name) ? response.status >= 500 : response.status >= 400 && response.status < 500;
  return goesWithStatus ? name : null;
}

/** AWS takes a request whose time is within five minutes of its own. */
const CLOCK_ALLOWANCE_MS = 5 * 60_000;

/**
 * What to say about this host's clock, from the time an answer carries in its
 * `Date` header. Empty when the answer names no time, or when the two clocks
 * are within what AWS allows.
 */
function clockHint(response: Response, now: number): string {
  const theirs = Date.parse(response.headers.get("date") ?? "");
  if (!Number.isFinite(theirs)) return "";
  const off = Math.abs(now - theirs);
  if (off <= CLOCK_ALLOWANCE_MS) return "";
  const minutes = Math.round(off / 60_000);
  return `. Check the clock of this host: it is ${minutes > 120 ? "more than two hours" : `${minutes} minutes`} from AWS's own`;
}

// ── Reading an answer ───────────────────────────────────────────────────────

/** Room for the value plus the JSON around it. A JSON string can take up to
 *  six bytes for one byte of value. */
const SECRET_RESPONSE_LIMIT_BYTES = MAX_SECRET_BYTES * 6 + 16 * 1024;
const CREDENTIALS_RESPONSE_LIMIT_BYTES = 64 * 1024;
const ERROR_RESPONSE_LIMIT_BYTES = 64 * 1024;

/** A short answer as text: a session token, a role's name. `cut` when it did
 *  not arrive whole, which the next one may. `long` when it is longer than
 *  `limitBytes`, which the next one would be too. */
type ShortText = { state: "text"; text: string } | { state: "cut" } | { state: "long" };

async function readShortText(response: Response, limitBytes: number): Promise<ShortText> {
  const reader = response.body?.getReader();
  if (!reader) return { state: "text", text: "" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limitBytes) return { state: "long" };
      chunks.push(value);
    }
  } catch {
    // The connection ended, or the time for this request ran out.
    return { state: "cut" };
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { state: "text", text: Buffer.concat(chunks).toString("utf8") };
}

/** What an access key id, a secret key and a session token may be made of:
 *  what a header can carry. AWS states no longest session token, so this one
 *  has room: the tokens of today are well under two thousand characters. */
const KEY_ID = /^[A-Z0-9]{16,128}$/;
const KEY_TEXT = /^[\x21-\x7e]{1,4096}$/;
const SESSION_TOKEN_TEXT = /^[\x21-\x7e]{1,16384}$/;

/** The credentials in an answer, or null when it holds none that can be used. */
function credentialsIn(body: unknown, now: number): TimedCredential<AwsCredential> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const fields = body as {
    Code?: unknown;
    AccessKeyId?: unknown;
    SecretAccessKey?: unknown;
    Token?: unknown;
    Expiration?: unknown;
  };
  // The instance metadata service says "Success" beside credentials it gives.
  if (fields.Code !== undefined && fields.Code !== "Success") return null;
  const { AccessKeyId: id, SecretAccessKey: secret, Token: token } = fields;
  if (typeof id !== "string" || !KEY_ID.test(id)) return null;
  if (typeof secret !== "string" || !KEY_TEXT.test(secret)) return null;
  if (typeof token !== "string" || !SESSION_TOKEN_TEXT.test(token)) return null;
  // `Expiration` is a time such as 2021-01-16T00:51:53Z. One that cannot be
  // read is a lifetime nobody stated: such credentials are not kept.
  const expires = typeof fields.Expiration === "string" ? Date.parse(fields.Expiration) : Number.NaN;
  return {
    credential: { accessKeyId: id, secretAccessKey: secret, sessionToken: token },
    refreshAt: refreshTimeFor(now, expires - now),
  };
}

// ── The provider ────────────────────────────────────────────────────────────

/** How long the session with the instance metadata service is asked for, in
 *  seconds. It is used for the two requests that follow, and dropped. */
const METADATA_SESSION_SECONDS = "60";

/** The instance metadata service answers at once or not at all. */
const METADATA_TIMEOUT_MS = 2_000;

/** A role's name, as the instance metadata service lists it. */
const ROLE_NAME = /^[\w+=,.@-]{1,64}$/;

const WORDS = { credential: "credentials of this host's role", credentialRequest: "the request for credentials" } as const;

export class AwsSecretsManagerSecretProvider extends SecretProviderBase {
  readonly kind = "aws-secrets-manager" as const;

  // `#` fields and `#` methods. A TypeScript `private` member is an ordinary
  // property at run time, and this object can ask for credentials.
  readonly #region: string;
  readonly #origin: string;
  readonly #source: AwsCredentialSource;
  /** Keeps the values and the credentials, and makes the requests below. */
  readonly #reader: NetworkSecretReader<AwsCredential>;

  constructor(options: AwsSecretsManagerOptions) {
    super();
    if (!isAwsRegion(options.region)) {
      // Never reached through the settings, which check it first. Reached by a
      // caller that builds the provider by hand, and the region goes into the
      // host of the request.
      throw new Error("the AWS region must be a region's name, such as us-east-1");
    }
    this.#region = options.region;
    this.#origin = options.secretsManagerOrigin ?? awsSecretsManagerOrigin(options.region);
    this.#source = options.credentials;
    this.#reader = new NetworkSecretReader<AwsCredential>(options, {
      words: WORDS,
      sourceOf: (name) => `AWS Secrets Manager secret ${name} in ${this.#region}`,
      requestCredential: (io) =>
        this.#source.kind === "container" ? this.#fromContainer(this.#source.url, io) : this.#fromInstance(this.#source.origin, io),
      requestSecret: (name, credential, io) => this.#requestSecret(name, credential, io),
    });
  }

  get(name: string): Promise<string> {
    return this.#reader.get(name);
  }

  /** Drop every value and the credentials now. For shutdown, and for a caller
   *  that knows a secret was just rotated. A read that is on its way still
   *  answers whoever asked for it. A caller that asks after this starts a new
   *  read, so it never gets what Secrets Manager held before. */
  forget(): void {
    this.#reader.forget();
  }

  /** How many values are held in memory right now. A count, never a value. */
  get heldValues(): number {
    return this.#reader.heldValues;
  }

  // -- Secrets Manager --------------------------------------------------------------

  async #requestSecret(name: string, credential: AwsCredential, io: NetworkSecretIo): Promise<Attempt<string>> {
    // With no version named, Secrets Manager answers with the current one.
    const body = JSON.stringify({ SecretId: name });
    const signed = signAwsRequest(
      {
        method: "POST",
        host: new URL(this.#origin).host,
        path: "/",
        headers: {
          "content-type": "application/x-amz-json-1.1",
          "x-amz-target": "secretsmanager.GetSecretValue",
        },
        body,
        region: this.#region,
        service: "secretsmanager",
        now: io.now(),
      },
      credential,
    );
    // The runtime writes the Host header itself, from the address. It is the
    // host that was signed, so it is not sent a second time.
    const headers = Object.fromEntries(Object.entries(signed).filter(([header]) => header !== "host"));
    let response: Response;
    try {
      response = await io.request(`${this.#origin}/`, {
        method: "POST",
        headers: { ...headers, accept: "application/json" },
        body,
      });
    } catch (error) {
      return noResponse(error, "Secrets Manager");
    }

    if (response.status === 200) {
      const read = await readBoundedJson(response, SECRET_RESPONSE_LIMIT_BYTES);
      if (read.state === "cut") {
        return { ok: false, retry: true, transient: true, reason: "Secrets Manager's answer was cut off" };
      }
      const noValue: Attempt<string> = {
        ok: false,
        retry: false,
        transient: false,
        reason: "Secrets Manager's answer did not hold a secret value",
      };
      const answer = read.state === "json" && read.value && typeof read.value === "object" ? read.value : null;
      if (!answer || Array.isArray(answer)) return noValue;
      const { SecretString: text, SecretBinary: binary } = answer as { SecretString?: unknown; SecretBinary?: unknown };
      if (typeof text === "string") return { ok: true, value: text };
      // A value stored as bytes arrives in base64. It is a secret here only
      // when the bytes are text.
      if (typeof binary !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(binary) || binary.replace(/=+$/, "").length % 4 === 1) {
        return noValue;
      }
      try {
        return { ok: true, value: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(binary, "base64")) };
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
      return { ok: false, retry: true, transient: true, reason: "Secrets Manager's answer was cut off" };
    }
    const name_ = awsErrorName(errorBody.state === "json" ? errorBody.value : null, response);
    const label = name_ ? `${response.status} ${name_}` : String(response.status);
    const answered = `Secrets Manager answered ${label}`;
    const failed = (extra: Partial<Extract<Attempt<string>, { ok: false }>> & { reason?: string }): Attempt<string> => ({
      ok: false,
      retry: false,
      transient: false,
      reason: answered,
      ...extra,
    });

    // AWS's own answer for a secret it does not hold: this name, with this
    // status. The name with another status is not called a missing secret.
    if (name_ === "ResourceNotFoundException" && response.status === NOT_FOUND_STATUS) return failed({ missing: true });
    // A clock that is wrong makes AWS refuse a request for its time, and
    // credentials for theirs. The answer's own date says when that is so.
    const clock = name_ !== null && TIME_JUDGED.has(name_) ? clockHint(response, io.now()) : "";
    if (response.status === 407) {
      return failed({ reason: "a proxy between this host and Secrets Manager asked for credentials (407)" });
    }
    if (name_ !== null && CREDENTIAL_REFUSED.has(name_)) {
      return failed({ unauthorized: true, reason: `Secrets Manager refused the credentials (${label})${clock}` });
    }
    if ((name_ !== null && THROTTLED.has(name_)) || response.status === 429 || response.status >= 500) {
      const wait = retryAfterMs(response);
      return failed({ retry: true, transient: true, ...(wait !== undefined ? { retryAfterMs: wait } : {}) });
    }
    if ((name_ !== null && NO_ACCESS.has(name_)) || (name_ === null && (response.status === 401 || response.status === 403))) {
      return failed({
        // A permission granted a moment ago is refused for a while before it
        // takes effect, so a caller may ask again later.
        transient: true,
        // AWS's own answer that this role may not read this secret. A 401 or
        // a 403 with no name of AWS's came from something on the way.
        refused: name_ !== null,
        reason:
          `Secrets Manager refused the request (${label}). The role this host runs as needs ` +
          "secretsmanager:GetSecretValue on this secret, and kms:Decrypt on its key when the key is the organization's own",
      });
    }
    if (name_ === "DecryptionFailure") {
      return failed({ reason: `${answered}. Secrets Manager could not decrypt this secret with its key` });
    }
    if (name_ === "InvalidRequestException") {
      // The secret is there and cannot be read as it stands. That is not
      // called a missing secret: a caller that takes "missing" as "not
      // configured" would go on without it.
      return failed({ reason: `${answered}, which it answers for a secret that is scheduled for deletion` });
    }
    if (name_ === "RequestExpired") {
      // AWS takes a request only when the time it carries is close to its own.
      return failed({ reason: `${answered}${clock || ". Check the clock of this host: it is too far from AWS's own"}` });
    }
    return failed({ reason: `${answered}${clock}` });
  }

  // -- the credentials: an Amazon ECS task -------------------------------------------

  async #fromContainer(url: string, io: NetworkSecretIo): Promise<Attempt<TimedCredential<AwsCredential>>> {
    let response: Response;
    try {
      response = await io.request(url, { method: "GET", headers: { accept: "application/json" } });
    } catch (error) {
      return noResponse(error, "the task's credentials endpoint");
    }
    return this.#credentialsFrom(response, "the task's credentials endpoint", io);
  }

  // -- the credentials: an Amazon EC2 instance ---------------------------------------

  async #fromInstance(origin: string, io: NetworkSecretIo): Promise<Attempt<TimedCredential<AwsCredential>>> {
    const who = "the instance metadata service";
    const answered = (status: number, hint = ""): Attempt<never> => {
      // 401 is its answer to a session token it does not take: the whole
      // request is made again, with a new session.
      const retry = status === 401 || status === 429 || status >= 500;
      return { ok: false, retry, transient: retry, reason: `${who} answered ${status}${hint}` };
    };

    // 1 · A session with the service. Its token is used for the two requests
    // below and is kept nowhere.
    let response: Response;
    try {
      response = await io.request(`${origin}/latest/api/token`, {
        method: "PUT",
        headers: { "X-aws-ec2-metadata-token-ttl-seconds": METADATA_SESSION_SECONDS },
        timeoutMs: METADATA_TIMEOUT_MS,
      });
    } catch (error) {
      const failed = noResponse(error, who);
      // A redirect is named as it is. No answer at all is what a host that is
      // neither kind gets, and what a container on an instance gets when the
      // instance lets its metadata travel one hop only.
      if (failed.ok || !failed.retry) return failed;
      return {
        ...failed,
        reason:
          `${failed.reason}. This host must be an Amazon ECS task or an Amazon EC2 instance with a role. ` +
          "In a container on an instance, the instance's metadata hop limit must be 2",
      };
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      return answered(response.status, response.status === 403 ? ", which it answers when it is switched off for this instance" : "");
    }
    const cutOff: Attempt<never> = { ok: false, retry: true, transient: true, reason: `${who}'s answer was cut off` };
    const sessionText = await readShortText(response, 4096);
    if (sessionText.state === "cut") return cutOff;
    const session = sessionText.state === "text" ? sessionText.text.trim() : "";
    if (!KEY_TEXT.test(session)) {
      return { ok: false, retry: false, transient: false, reason: `${who}'s answer did not hold a session token` };
    }
    const headers = { "X-aws-ec2-metadata-token": session };

    // 2 · The name of the role this instance has.
    const roles = `${origin}/latest/meta-data/iam/security-credentials/`;
    try {
      response = await io.request(roles, { method: "GET", headers, timeoutMs: METADATA_TIMEOUT_MS });
    } catch (error) {
      return noResponse(error, who);
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      return answered(response.status, response.status === 404 ? ". This instance has no role" : "");
    }
    const roleText = await readShortText(response, 4096);
    if (roleText.state === "cut") return cutOff;
    const role = roleText.state === "text" ? (roleText.text.split("\n")[0]?.trim() ?? "") : "";
    if (!ROLE_NAME.test(role)) {
      return { ok: false, retry: false, transient: false, reason: `${who}'s answer did not name a role` };
    }

    // 3 · That role's credentials.
    try {
      response = await io.request(`${roles}${role}`, { method: "GET", headers, timeoutMs: METADATA_TIMEOUT_MS });
    } catch (error) {
      return noResponse(error, who);
    }
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {});
      return answered(401);
    }
    return this.#credentialsFrom(response, who, io);
  }

  /** The credentials in the answer of either endpoint. */
  async #credentialsFrom(
    response: Response,
    who: string,
    io: NetworkSecretIo,
  ): Promise<Attempt<TimedCredential<AwsCredential>>> {
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      const retry = response.status === 429 || response.status >= 500;
      const wait = retryAfterMs(response);
      return {
        ok: false,
        retry,
        transient: retry,
        reason: `${who} answered ${response.status}`,
        ...(wait !== undefined ? { retryAfterMs: wait } : {}),
      };
    }
    const read = await readBoundedJson(response, CREDENTIALS_RESPONSE_LIMIT_BYTES);
    if (read.state === "cut") {
      return { ok: false, retry: true, transient: true, reason: `${who}'s answer was cut off` };
    }
    const found = read.state === "json" ? credentialsIn(read.value, io.now()) : null;
    if (!found) {
      return { ok: false, retry: false, transient: false, reason: `${who}'s answer did not hold credentials` };
    }
    return { ok: true, value: found };
  }
}

// ── The provider, as providers.ts lists it ──────────────────────────────────

export interface AwsSecretsManagerSecretsConfig {
  provider: "aws-secrets-manager";
  region: string;
  /** How long a value read from Secrets Manager is kept in memory. Absent
   *  means the provider's default. */
  cacheTtlMs?: number;
}

const REGION_ENV = "FORTRESS_SECRETS_AWS_REGION";

export const AWS_SECRETS_MANAGER_SECRET_PROVIDER = {
  kind: "aws-secrets-manager",
  cloud: "AWS",
  summary:
    "The current version of the secret `db-url` in AWS Secrets Manager, in one region, read with the role " +
    "of the task or machine. There is no access key in the settings and no AWS SDK. A value is kept in " +
    "memory for one minute by default.",
  needs:
    "A role. HX Fortress must run where AWS gives it one: an Amazon ECS task with a task role, AWS " +
    "Fargate included, or an Amazon EC2 instance with an instance profile.",
  settings: [
    {
      key: "region",
      env: REGION_ENV,
      meaning: "Required. The region whose Secrets Manager holds the secrets, such as `us-east-1`.",
    },
    CACHE_SECONDS_SETTING,
  ],
  resolve({ setting }) {
    const region = setting("region");
    const cacheSeconds = setting("cacheSeconds");
    if (!region) {
      throw invalidSecretsConfig(
        `the aws-secrets-manager provider needs the region: set ${REGION_ENV}, or secrets.region in config.json`,
      );
    }
    if (!isAwsRegion(region.value)) {
      // What was written is not repeated: a line pasted into the wrong
      // setting can be a credential.
      throw invalidSecretsConfig(
        `${region.where} must be a region's name, such as us-east-1. ` +
          "The regions of China and of the isolated partitions are not read by this build",
      );
    }
    const cacheTtlMs = cacheTtlFromSetting(cacheSeconds);
    return {
      provider: "aws-secrets-manager",
      region: region.value,
      ...(cacheTtlMs !== undefined ? { cacheTtlMs } : {}),
    };
  },
  create(config, deps) {
    let credentials: AwsCredentialSource;
    try {
      // Reads AWS_CONTAINER_CREDENTIALS_RELATIVE_URI, which Amazon ECS sets.
      // No request is made until a secret is asked for.
      credentials = resolveAwsCredentialSource(deps.env ?? process.env);
    } catch (error) {
      throw invalidSecretsConfig(error instanceof Error ? error.message : "the credentials' source could not be resolved");
    }
    // The requests for credentials must not go through a proxy named in the
    // environment. In a running HX Fortress `deps.env` is the process's own
    // environment, which is where the runtime looks when it makes a request.
    keepEndpointOffProxy(deps.env ?? process.env, endpointOf(credentials));
    return new AwsSecretsManagerSecretProvider({
      region: config.region,
      credentials,
      ...(config.cacheTtlMs !== undefined ? { cacheTtlMs: config.cacheTtlMs } : {}),
    });
  },
  describe: (config) => `aws-secrets-manager (${config.region})`,
  path: (config) => ({
    leavesHost: true,
    peer:
      `${awsSecretsManagerOrigin(config.region)}, with temporary credentials of this host's role ` +
      "from the platform's own endpoint",
    carries:
      "the name of each secret this HX Fortress reads goes out, with a signature made with those " +
      "credentials; the secret's value comes back",
    gate: "the role this host runs as, which needs secretsmanager:GetSecretValue on each secret it reads",
    notes: [
      "The control plane is not on this path. The account and the role are the organization's own.",
      "A value is kept in memory for a short time and is written to no file. The secret key of the " +
        "credentials is never sent: each request carries a signature made with it. A redirect is refused.",
    ],
  }),
} satisfies SecretProviderDefinition<"aws-secrets-manager", AwsSecretsManagerSecretsConfig>;
