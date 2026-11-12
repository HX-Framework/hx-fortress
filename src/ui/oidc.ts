// Console sign-in through the organization's own identity provider: the
// OpenID Connect authorization code flow with PKCE.
//
// The provider is the organization's (Microsoft Entra ID, or any standard issuer).
// It is never a control plane's, and nothing a control plane sends takes part in this flow: the
// settings are written by a terminal verb on this host, and the session that
// results is checked on this host against those settings.
//
// The shape of one sign-in:
//
//   1. The sign-in page asks this console to start a flow. The console answers
//      with the provider's authorization URL and a PKCE verifier. It keeps no
//      record: everything it needs later travels in a `state` value it signs.
//   2. The browser goes to the provider and comes back with a code.
//   3. The page posts the code, the state and the verifier. The console redeems
//      the code at the provider's token endpoint, verifies the ID token, maps
//      the person's groups to a role, and answers with a console session.
//
// What this file keeps true:
//
//   - FAIL CLOSED. A token that does not verify, a claim that is missing, a
//     person in no mapped group: each is a refusal with a named reason. Nothing
//     is accepted because a check could not be made.
//   - The ID token never reaches the browser. The console's own session token
//     does, in a JSON body, exactly as a password sign-in returns it.
//   - The flow is bound to the browser tab that started it: the PKCE verifier
//     is held by that tab alone, and the console checks it against the signed
//     state before it asks the provider anything.
//   - No error holds a token, a code, a client secret or a provider's response
//     body. A reason is a fixed word, plus a status or an error code.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

import { readBoundedJson } from "../bounded-json";
import { isLoopbackHost } from "../host/config";
import type { SecretProvider } from "../secrets/types";
import type { UiOidcConfig } from "./oidc-config";
import type { UiRole } from "./users";

// ── Why a sign-in was refused ───────────────────────────────────────────────

/** A closed list. Each value is recorded with the refusal and is safe to show
 *  an operator; none of them is taken from anything the provider or the
 *  browser sent. */
export type OidcRefusal =
  | "state_invalid"
  | "state_expired"
  | "state_used"
  | "verifier_mismatch"
  | "provider_unreachable"
  | "provider_metadata_invalid"
  | "provider_refused"
  | "client_secret_unavailable"
  | "token_invalid"
  | "groups_missing"
  | "groups_overage"
  | "no_matching_group"
  | "login_invalid";

export type OidcResult<T> = { ok: true; value: T } | { ok: false; refusal: OidcRefusal; detail?: string };

function refuse<T>(refusal: OidcRefusal, detail?: string): OidcResult<T> {
  return detail === undefined ? { ok: false, refusal } : { ok: false, refusal, detail };
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A status or an error code that is safe to repeat. A provider's own sentence
 *  (`error_description`) never is. */
function safeCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : null;
}

// ── The flow: signed state and PKCE ─────────────────────────────────────────

/** How long a person has to finish signing in at the provider. */
export const OIDC_FLOW_TTL_MS = 10 * 60 * 1000;

export interface OidcFlowStart {
  state: string;
  nonce: string;
  /** Returned to the tab that started the flow, and held by nothing else. */
  verifier: string;
  challenge: string;
}

export interface OidcFlowRecord {
  id: string;
  nonce: string;
  redirectUri: string;
  expiresAt: number;
}

interface StatePayload {
  /** Flow id, for single use. */
  i: string;
  /** The nonce the ID token must carry. */
  n: string;
  /** The redirect URI the flow was started with. */
  r: string;
  /** The PKCE challenge the verifier must hash to. */
  c: string;
  /** Started at, milliseconds. */
  t: number;
  /** The settings epoch the flow was started under. */
  e: number;
}

/**
 * Starts and finishes flows without keeping one in memory.
 *
 * Everything a finish needs is inside `state`, signed with a key that exists
 * only in this process. A flood of starts therefore costs no memory, and a
 * restart ends every flow in progress, the same as it ends every session.
 *
 * What is kept is small and bounded by what really happened: the flows that
 * are being finished right now, and the flows that produced a session, until
 * they would have expired anyway. An attempt that fails leaves nothing behind,
 * so a caller with no session cannot make this console hold memory by starting
 * flows and finishing them with a code that is worth nothing.
 */
export class OidcFlows {
  readonly #key = randomBytes(32);
  /** Flow ids that produced a session, kept until they would have expired. */
  readonly #finished = new Map<string, number>();
  /** Flow ids between `finish` and `settle`: a request is working on them. */
  readonly #inProgress = new Set<string>();

  start(args: { redirectUri: string; epoch: number; now: number }): OidcFlowStart {
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const nonce = base64url(randomBytes(24));
    const payload: StatePayload = {
      i: base64url(randomBytes(12)),
      n: nonce,
      r: args.redirectUri,
      c: challenge,
      t: args.now,
      e: args.epoch,
    };
    const body = base64url(Buffer.from(JSON.stringify(payload)));
    return { state: `${body}.${this.#mac(body)}`, nonce, verifier, challenge };
  }

  /**
   * Check a returning flow, and take it.
   *
   * The order is the security argument: the signature first, because nothing
   * in an unsigned state means anything; then the settings it was started
   * under, its age, single use, and the verifier.
   *
   * A flow that passes is in progress from here until the caller calls
   * `settle`. A second request that carries the same flow in that time is
   * refused, so two requests cannot both redeem it, and one flow yields one
   * session at most. The caller MUST call `settle`, whatever happens next.
   */
  finish(args: { state: string; verifier: string; epoch: number; now: number }): OidcResult<OidcFlowRecord> {
    const [body, mac, ...rest] = args.state.split(".");
    if (!body || !mac || rest.length > 0 || args.state.length > 4096) return refuse("state_invalid");
    if (!sameText(mac, this.#mac(body))) return refuse("state_invalid");

    let payload: StatePayload;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
    } catch {
      return refuse("state_invalid");
    }
    if (
      typeof payload.i !== "string" ||
      typeof payload.n !== "string" ||
      typeof payload.r !== "string" ||
      typeof payload.c !== "string" ||
      typeof payload.t !== "number" ||
      typeof payload.e !== "number"
    ) {
      return refuse("state_invalid");
    }
    // The settings changed after this flow started. Whatever it would have
    // been allowed is no longer what the settings say.
    if (payload.e !== args.epoch) return refuse("state_expired");
    const expiresAt = payload.t + OIDC_FLOW_TTL_MS;
    if (args.now >= expiresAt || payload.t > args.now + 60_000) return refuse("state_expired");
    this.#sweep(args.now);
    if (this.#finished.has(payload.i) || this.#inProgress.has(payload.i)) return refuse("state_used");
    // The tab that started the flow is the only holder of the verifier. This
    // check does not depend on the provider enforcing PKCE.
    const challenge = base64url(createHash("sha256").update(args.verifier).digest());
    if (!sameText(challenge, payload.c)) return refuse("verifier_mismatch");

    this.#inProgress.add(payload.i);
    return { ok: true, value: { id: payload.i, nonce: payload.n, redirectUri: payload.r, expiresAt } };
  }

  /**
   * End the work on a flow that `finish` handed out.
   *
   * A flow that produced a session is finished for good: its id is kept until
   * the flow would have expired, and it is refused from now on. A flow that
   * produced none is released. The person can try it again, and the provider
   * decides whether its code is still worth anything.
   */
  settle(record: OidcFlowRecord, issued: boolean): void {
    this.#inProgress.delete(record.id);
    if (issued) this.#finished.set(record.id, record.expiresAt);
  }

  /** How many flow ids are held right now. A count, for tests and for nothing else. */
  get held(): number {
    return this.#finished.size + this.#inProgress.size;
  }

  #mac(body: string): string {
    return base64url(createHmac("sha256", this.#key).update(body).digest());
  }

  #sweep(now: number): void {
    for (const [id, expiresAt] of this.#finished) {
      if (expiresAt <= now) this.#finished.delete(id);
    }
  }
}

// ── The provider ────────────────────────────────────────────────────────────

export interface OidcProviderMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  /** Signing algorithms this console will accept from this provider. */
  idTokenAlgs: string[];
  /** How the token endpoint authenticates a confidential client. */
  tokenAuthMethod: "client_secret_post" | "client_secret_basic";
  /** Whether the code may come back in the URL fragment. */
  fragmentResponse: boolean;
}

/** Asymmetric algorithms only. `none` and the HMAC family are never accepted:
 *  an ID token signed with a key this console also holds proves nothing. */
const ACCEPTED_ID_TOKEN_ALGS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
] as const;

const METADATA_TTL_MS = 60 * 60 * 1000;
/** How long a failed read of the discovery document is remembered. Starting a
 *  sign-in needs no session, so without this anybody who can reach the console
 *  could make it ask a provider that is down as fast as they can ask the
 *  console. */
export const METADATA_FAILURE_TTL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_LIMIT_BYTES = 256 * 1024;

/** How far this host's clock may differ from the provider's. */
export const OIDC_CLOCK_TOLERANCE_SECONDS = 60;

/** https, or http to this host itself. Every endpoint the console calls, and
 *  the one it sends the browser to, passes this. */
function safeEndpoint(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url.toString();
  return null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : null;
}

export interface OidcClientDeps {
  /** The fortress's secret provider, for a confidential client's secret. */
  secrets: () => Promise<SecretProvider>;
  /** Injected in tests. */
  fetch?: typeof fetch;
  now?: () => number;
}

export interface OidcIdentity {
  /** The provider's stable id for the person. */
  subject: string;
  /** What the console shows and records as the person's login. */
  login: string;
  role: UiRole;
}

export class OidcClient {
  readonly #secrets: () => Promise<SecretProvider>;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #metadata: { issuer: string; value: OidcProviderMetadata; fetchedAt: number } | null = null;
  #metadataFailure: { issuer: string; result: OidcResult<OidcProviderMetadata>; at: number } | null = null;
  #metadataInFlight: { issuer: string; result: Promise<OidcResult<OidcProviderMetadata>> } | null = null;
  readonly #jwks = new Map<string, JWTVerifyGetKey>();

  constructor(deps: OidcClientDeps) {
    this.#secrets = deps.secrets;
    this.#fetch = deps.fetch ?? fetch;
    this.#now = deps.now ?? Date.now;
  }

  /**
   * The provider's discovery document, checked.
   *
   * The document must say it describes the configured issuer, character for
   * character. That is what ties the endpoints below to the issuer an operator
   * wrote down: a document that names another issuer is somebody else's.
   */
  async metadata(issuer: string): Promise<OidcResult<OidcProviderMetadata>> {
    const cached = this.#metadata;
    if (cached && cached.issuer === issuer && this.#now() - cached.fetchedAt < METADATA_TTL_MS) {
      return { ok: true, value: cached.value };
    }
    const failed = this.#metadataFailure;
    if (failed && failed.issuer === issuer && this.#now() - failed.at < METADATA_FAILURE_TTL_MS) {
      return failed.result;
    }
    // One request at a time: callers that arrive while it is out share its answer.
    const inFlight = this.#metadataInFlight;
    if (inFlight && inFlight.issuer === issuer) return inFlight.result;
    const result = this.#fetchMetadata(issuer).then((outcome) => {
      if (outcome.ok) {
        this.#metadata = { issuer, value: outcome.value, fetchedAt: this.#now() };
        this.#metadataFailure = null;
      } else {
        this.#metadataFailure = { issuer, result: outcome, at: this.#now() };
      }
      return outcome;
    });
    const entry = { issuer, result };
    this.#metadataInFlight = entry;
    try {
      return await result;
    } finally {
      if (this.#metadataInFlight === entry) this.#metadataInFlight = null;
    }
  }

  async #fetchMetadata(issuer: string): Promise<OidcResult<OidcProviderMetadata>> {
    const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return refuse("provider_unreachable", "the discovery document could not be fetched");
    }
    if (response.status !== 200) {
      return refuse("provider_unreachable", `the discovery document answered ${response.status}`);
    }
    const read = await readBoundedJson(response, RESPONSE_LIMIT_BYTES);
    if (read.state === "cut") {
      // The provider was reached and did not finish its answer. That is a
      // provider that cannot be reached, not a document that is wrong.
      return refuse("provider_unreachable", "the discovery document was cut off before it was whole");
    }
    const doc = read.state === "json" ? (read.value as Record<string, unknown> | null) : null;
    if (!doc || typeof doc !== "object") {
      return refuse("provider_metadata_invalid", "the discovery document is not JSON");
    }
    if (doc.issuer !== issuer) {
      return refuse(
        "provider_metadata_invalid",
        "the discovery document names a different issuer. Set issuer to exactly the value the provider publishes",
      );
    }
    const authorizationEndpoint = safeEndpoint(doc.authorization_endpoint);
    const tokenEndpoint = safeEndpoint(doc.token_endpoint);
    const jwksUri = safeEndpoint(doc.jwks_uri);
    if (!authorizationEndpoint || !tokenEndpoint || !jwksUri) {
      return refuse(
        "provider_metadata_invalid",
        "the discovery document lacks an https authorization, token or key endpoint",
      );
    }
    const offered = stringArray(doc.id_token_signing_alg_values_supported) ?? ["RS256"];
    const idTokenAlgs = ACCEPTED_ID_TOKEN_ALGS.filter((alg) => offered.includes(alg));
    if (idTokenAlgs.length === 0) {
      return refuse("provider_metadata_invalid", "the provider signs ID tokens with no algorithm this console accepts");
    }
    // The default when a provider lists none is HTTP Basic (OpenID Connect
    // Discovery, section 3).
    const authMethods = stringArray(doc.token_endpoint_auth_methods_supported) ?? ["client_secret_basic"];
    const tokenAuthMethod = authMethods.includes("client_secret_post")
      ? "client_secret_post"
      : "client_secret_basic";
    // The default when a provider lists none is query and fragment.
    const responseModes = stringArray(doc.response_modes_supported);
    const value: OidcProviderMetadata = {
      issuer,
      authorizationEndpoint,
      tokenEndpoint,
      jwksUri,
      idTokenAlgs: [...idTokenAlgs],
      tokenAuthMethod,
      fragmentResponse: responseModes === null || responseModes.includes("fragment"),
    };
    return { ok: true, value };
  }

  /** Where the browser is sent. The code comes back in the URL fragment when
   *  the provider can do that, so it never reaches a request line or a proxy
   *  log on its way to this console. */
  authorizationUrl(
    config: UiOidcConfig & { clientId: string },
    metadata: OidcProviderMetadata,
    flow: { redirectUri: string; state: string; nonce: string; challenge: string },
  ): string {
    const url = new URL(metadata.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", flow.redirectUri);
    url.searchParams.set("scope", config.scopes.join(" "));
    url.searchParams.set("state", flow.state);
    url.searchParams.set("nonce", flow.nonce);
    url.searchParams.set("code_challenge", flow.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (metadata.fragmentResponse) url.searchParams.set("response_mode", "fragment");
    return url.toString();
  }

  /** Redeem the code for an ID token at the provider's token endpoint. */
  async redeem(
    config: UiOidcConfig & { clientId: string },
    metadata: OidcProviderMetadata,
    args: { code: string; redirectUri: string; verifier: string },
  ): Promise<OidcResult<string>> {
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: args.redirectUri,
      client_id: config.clientId,
      code_verifier: args.verifier,
    });
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    };
    if (config.clientSecretName) {
      let secret: string;
      try {
        secret = await (await this.#secrets()).get(config.clientSecretName);
      } catch {
        // The provider's own error is not passed on: where a secret was looked
        // for is this host's business. The name is in the settings.
        return refuse("client_secret_unavailable", `the secret ${config.clientSecretName} could not be read`);
      }
      if (metadata.tokenAuthMethod === "client_secret_post") {
        form.set("client_secret", secret);
      } else {
        // RFC 6749, section 2.3.1: both parts are form-encoded before Base64.
        const pair = `${formEncode(config.clientId)}:${formEncode(secret)}`;
        headers.authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
      }
    }

    let response: Response;
    try {
      response = await this.#fetch(metadata.tokenEndpoint, {
        method: "POST",
        headers,
        body: form.toString(),
        // A redirect would carry the code and the client secret to another host.
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return refuse("provider_unreachable", "the token endpoint did not answer");
    }
    const read = await readBoundedJson(response, RESPONSE_LIMIT_BYTES);
    if (read.state === "cut") {
      return refuse("provider_unreachable", "the token endpoint's answer was cut off before it was whole");
    }
    const body = read.state === "json" ? (read.value as Record<string, unknown> | null) : null;
    if (response.status !== 200) {
      const code = safeCode(body?.error);
      return refuse(
        "provider_refused",
        code ? `the token endpoint answered ${response.status} ${code}` : `the token endpoint answered ${response.status}`,
      );
    }
    const idToken = body?.id_token;
    if (typeof idToken !== "string" || idToken === "") {
      return refuse("provider_refused", "the token endpoint's answer held no ID token");
    }
    return { ok: true, value: idToken };
  }

  /**
   * Verify an ID token and return its claims.
   *
   * Signature against the provider's published keys, then issuer, audience,
   * expiry and age, then the nonce of this flow. A token for another client,
   * from another issuer, or from another sign-in fails here.
   */
  async verify(
    config: UiOidcConfig & { clientId: string },
    metadata: OidcProviderMetadata,
    idToken: string,
    nonce: string,
  ): Promise<OidcResult<JWTPayload>> {
    let keys = this.#jwks.get(metadata.jwksUri);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(metadata.jwksUri), {
        timeoutDuration: REQUEST_TIMEOUT_MS,
        cooldownDuration: 30_000,
        cacheMaxAge: 10 * 60_000,
        // The same fetch as every other request to the provider. A redirect is
        // not followed here either.
        [customFetch]: (url, options) => this.#fetch(url, { ...options, redirect: "error" }),
      });
      this.#jwks.set(metadata.jwksUri, keys);
    }
    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(idToken, keys, {
        issuer: metadata.issuer,
        audience: config.clientId,
        algorithms: metadata.idTokenAlgs,
        clockTolerance: OIDC_CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ["sub", "exp", "iat"],
        maxTokenAge: OIDC_FLOW_TTL_MS / 1000,
        currentDate: new Date(this.#now()),
      });
      payload = verified.payload;
    } catch (error) {
      return refuse("token_invalid", joseReason(error));
    }
    // A token that says which client asked for it must name this one, and a
    // token for several audiences must say it.
    const severalAudiences = Array.isArray(payload.aud) && payload.aud.length > 1;
    if ((severalAudiences || payload.azp !== undefined) && payload.azp !== config.clientId) {
      return refuse("token_invalid", "the token was issued to another client");
    }
    if (typeof payload.nonce !== "string" || !sameText(payload.nonce, nonce)) {
      return refuse("token_invalid", "the token does not belong to this sign-in");
    }
    return { ok: true, value: payload };
  }
}

function formEncode(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+").replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** jose names each failure with a code. The code is repeated; the message,
 *  which can quote a claim, is not. */
function joseReason(error: unknown): string {
  const code = safeCode((error as { code?: unknown } | null)?.code);
  switch (code) {
    case "ERR_JWT_EXPIRED":
      return "the token has expired";
    case "ERR_JWT_CLAIM_VALIDATION_FAILED": {
      const claim = safeCode((error as { claim?: unknown }).claim);
      return claim ? `the token's ${claim} claim is not what this console expects` : "a claim is not what this console expects";
    }
    case "ERR_JWS_SIGNATURE_VERIFICATION_FAILED":
      return "the token's signature does not verify";
    case "ERR_JWKS_NO_MATCHING_KEY":
      return "the provider publishes no key for this token";
    case "ERR_JOSE_ALG_NOT_ALLOWED":
      return "the token is signed with an algorithm this console does not accept";
    case "ERR_JWKS_TIMEOUT":
      return "the provider's keys could not be fetched in time";
    default:
      return code ? `the token did not verify (${code})` : "the token did not verify";
  }
}

// ── From claims to a console identity ───────────────────────────────────────

/**
 * The two kinds of login this file makes, and why they cannot be confused.
 *
 *   - An address: the `email` claim (or the configured one), lower-cased. It
 *     holds an "@" and no ":".
 *   - `sub:<subject>`: the provider's own id for the person, exactly as sent.
 *     It is used when the token has no usable address.
 *
 * A local account's login holds no "@" and no ":", so neither kind can be
 * mistaken for a local account, in a session or in the audit trail. And an
 * address can never read as somebody else's `sub:` login, because it holds no
 * ":" at all.
 */
const EMAIL_LIKE = /^[^\s@:<>"'\\]{1,64}@[^\s@:<>"'\\]{1,190}$/;
/** Printable ASCII with no space. A login is shown on pages, printed in a
 *  terminal and written to the audit trail, so it holds no control character
 *  and no character that only looks like another one. */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
/** The audit trail keeps 128 characters of an actor. A login is never longer,
 *  so two people can never be cut down to the same recorded name. */
export const OIDC_LOGIN_MAX_CHARS = 128;
/**
 * The provider's id for a person: printable ASCII with no space, as OpenID
 * Connect requires, and short enough that `sub:` followed by it fits in a
 * login. The specification allows 255 characters. The ids of the providers in
 * use are far shorter, and one that does not fit is refused, never cut.
 */
export const OIDC_SUBJECT_MAX_CHARS = OIDC_LOGIN_MAX_CHARS - "sub:".length;

/** The provider's id for the person, when it is safe to store and to print.
 *  Null otherwise, and then it is written nowhere. */
export function usableSubject(claims: JWTPayload): string | null {
  const subject = claims.sub;
  return typeof subject === "string" && subject.length <= OIDC_SUBJECT_MAX_CHARS && PRINTABLE_ASCII.test(subject)
    ? subject
    : null;
}

/**
 * The claim as an address a login can be, lower-cased, or null.
 *
 * The rule is applied to the claim exactly as the provider sent it. Trimming
 * or lower-casing first would let through a value that only becomes plain
 * ASCII by that step: white space from another script at either end, or the
 * Kelvin sign, which lower-cases to "k". Such a value would then be shown as
 * somebody else's address.
 */
function addressFrom(claims: JWTPayload, name: string): string | null {
  // `name` is a claim name an operator configured, checked when it was set.
  // eslint-disable-next-line security/detect-object-injection
  const sent = (claims as Record<string, unknown>)[name];
  if (typeof sent !== "string" || sent.length > OIDC_LOGIN_MAX_CHARS || !PRINTABLE_ASCII.test(sent)) return null;
  const address = sent.toLowerCase();
  return EMAIL_LIKE.test(address) ? address : null;
}

/**
 * The address a person typed at the provider that nobody checked is theirs,
 * or null when the provider does not say so.
 *
 * `email_verified` is the provider's own word. Present and anything other than
 * true means not verified. Absent means the provider does not use the claim
 * (Microsoft Entra ID does not send it), and its addresses are taken as given.
 */
function unverifiedAddress(claims: JWTPayload): string | null {
  const marked = claims.email_verified;
  if (marked === undefined || marked === true || marked === "true") return null;
  return claimText(claims, "email")?.toLowerCase() ?? null;
}

function claimText(claims: JWTPayload, name: string): string | null {
  // `name` is a claim name an operator configured, checked when it was set.
  // eslint-disable-next-line security/detect-object-injection
  const value = (claims as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Decide who signed in and what they may do.
 *
 * A person in an operator group is an operator. A person in a read-only group
 * and no operator group is read-only. Anybody else is refused: being known to
 * the identity provider is not a reason to see this console.
 */
export function identityFromClaims(config: UiOidcConfig, claims: JWTPayload): OidcResult<OidcIdentity> {
  const subject = usableSubject(claims);
  if (subject === null) return refuse("login_invalid", "the token's sub claim is not usable");

  // An address is shown as the login. Anything else, a display name or a value
  // that only looks like a `sub:` login, is not: the person is then named by
  // the provider's own id for them, which they cannot choose.
  //
  // An address the provider marks as not verified is not shown either,
  // whichever claim carries it. Some providers repeat it as the user name.
  const notTheirs = unverifiedAddress(claims);
  const candidate = (name: string): string | null => {
    const address = addressFrom(claims, name);
    return address !== null && address === notTheirs ? null : address;
  };
  let login: string;
  if (config.loginClaim === "sub") {
    // Asked for by name: everybody is named by the provider's id, and never by
    // an address, even when the id happens to look like one.
    login = `sub:${subject}`;
  } else if (config.loginClaim) {
    if (!claimText(claims, config.loginClaim)) {
      return refuse("login_invalid", `the token has no ${config.loginClaim} claim`);
    }
    login = candidate(config.loginClaim) ?? `sub:${subject}`;
  } else {
    login = candidate("email") ?? candidate("preferred_username") ?? `sub:${subject}`;
  }

  // `groupsClaim` is a claim name an operator configured, checked when it was set.
  const raw = (claims as Record<string, unknown>)[config.groupsClaim];
  let groups: string[];
  if (Array.isArray(raw)) {
    groups = raw.filter((g): g is string => typeof g === "string").slice(0, 2_000);
  } else if (typeof raw === "string" && raw !== "") {
    groups = [raw];
  } else {
    // Microsoft Entra ID leaves the groups out of a token for a person in more
    // than 200 of them and says so in `_claim_names`. The fix is on the
    // provider's side; it is named so an operator can find it.
    const names = (claims as Record<string, unknown>)._claim_names;
    const overage =
      names !== null &&
      typeof names === "object" &&
      Object.hasOwn(names as Record<string, unknown>, config.groupsClaim);
    return overage
      ? refuse(
          "groups_overage",
          "the provider left the groups out because the person is in too many. Emit only the groups assigned " +
            "to the application, or map application roles and set groupsClaim to roles",
        )
      : refuse("groups_missing", `the token has no ${config.groupsClaim} claim`);
  }

  // The groups claim may be the address itself: `groupsClaim` set to `email`
  // gives a role to named people at a provider that sends no groups. An address
  // the provider marks as not verified is nobody's, so it is never a group,
  // whichever claim carries it. Without this, such a provider would let a
  // person type somebody else's address and get that person's role.
  const member = new Set(notTheirs === null ? groups : groups.filter((g) => g.toLowerCase() !== notTheirs));
  const role: UiRole | null = config.operatorGroups.some((g) => member.has(g))
    ? "operator"
    : config.readonlyGroups.some((g) => member.has(g))
      ? "readonly"
      : null;
  if (!role) return refuse("no_matching_group");
  return { ok: true, value: { subject, login, role } };
}
