// What every secret provider that reads over a network shares.
//
// Such a provider does two things per secret: it gets a credential from the
// platform this host runs on (a token of the host's own identity), and it asks
// the store for the value with that credential. Everything around those two
// requests is the same for every store, and lives here once:
//
//   - A value is held in memory only, for `cacheTtlMs` at most, and is dropped
//     when that time is up, not only when somebody next asks.
//   - One read per name at a time. Callers that arrive while it is out wait for
//     the same answer.
//   - The credential is kept until shortly before it expires, and one request
//     for a new one is shared by every secret that is waiting for it.
//   - A request that may work on a second try is tried again, a few times, with
//     a growing wait. A store that refuses the credential gets a new one, once.
//   - No redirect is followed: it would carry the credential to another host.
//     An answer that is a redirect is refused here, before a provider sees it.
//   - A request of a provider that throws is reported as a secret that could
//     not be read. What it threw is dropped: it can repeat text of a response.
//   - A clock that is set back keeps nothing alive: a value or a credential
//     that was stored "in the future" is dropped.
//
// A provider holds one `NetworkSecretReader` in a `#` field and hands it the
// two requests and a few words (`NetworkSecretSource`). The provider's own file
// decides what a response means, and builds every reason from fixed words and a
// status. Nothing here repeats a response.
//
// Values, the credential and the two requests are reachable through `#` fields
// only, here and in each provider. So logging or serializing a provider prints
// only its kind, and code that holds a provider can call `get`, `has` and
// `forget` and nothing else: it cannot ask for the credential, or for a value
// before the rule every provider shares has been applied to it.

import { invalidSecretsConfig, type GivenSetting, type SecretProviderSetting } from "./definition";
import { secretValueFrom } from "./provider-base";
import { assertSecretName, SecretMissing, SecretUnavailable } from "./types";

/** How long a value read from a store is kept before it is read again. Short
 *  on purpose: it bounds how long a value stays in this process after its last
 *  use, and how long a rotated secret keeps being served. */
export const DEFAULT_SECRET_CACHE_TTL_MS = 60_000;

/** The longest a value may be kept, whatever the setting says. */
export const MAX_SECRET_CACHE_TTL_MS = 15 * 60_000;

/** A credential is fetched again this long before it expires, so a request
 *  never goes out with one that dies on the way. A credential that lives less
 *  than twice this long is fetched again at half its life instead. */
const CREDENTIAL_REFRESH_MARGIN_MS = 5 * 60_000;

/** No platform hands a host a credential of its own identity for longer than
 *  a day. An answer that claims more, or gives the time in another unit, is
 *  trusted for this long and no longer. */
export const MAX_CREDENTIAL_LIFETIME_MS = 24 * 60 * 60_000;

/**
 * When to stop using a credential that lives `lifetimeMs` from `now`.
 *
 * A lifetime that is not a finite number is a lifetime nobody stated: such a
 * credential is not kept, and the next read asks for another. A JSON answer
 * can hold a number too large to be one, which reads as infinite.
 */
export function refreshTimeFor(now: number, lifetimeMs: number): number {
  if (!Number.isFinite(lifetimeMs)) return now;
  const lifetime = Math.min(lifetimeMs, MAX_CREDENTIAL_LIFETIME_MS);
  const useFor = lifetime > 2 * CREDENTIAL_REFRESH_MARGIN_MS ? lifetime - CREDENTIAL_REFRESH_MARGIN_MS : lifetime / 2;
  return now + Math.max(0, useFor);
}

/** What one HTTP attempt came to. `retry` says whether the request is tried
 *  again now. `transient` says whether a caller may find it working later with
 *  nothing changed on this host. */
export type Attempt<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      retry: boolean;
      transient: boolean;
      reason: string;
      /** The store answered, and it holds no value to use under this name. */
      missing?: boolean;
      /** The store did not accept the credential. A new one is asked for, once. */
      unauthorized?: boolean;
      retryAfterMs?: number;
    };

/** A credential and when to stop using it. */
export interface TimedCredential<Credential> {
  credential: Credential;
  refreshAt: number;
}

/** What the reader gives a provider's two requests. */
export interface NetworkSecretIo {
  /** The clock the reader runs on. */
  now(): number;
  /**
   * One request, with a time limit, that follows no redirect. It rejects when
   * no response came, and when the response is a redirect: `noResponse` turns
   * either into what the attempt came to. A provider catches that rejection
   * and returns `noResponse(...)`. One that lets it through is reported as a
   * request that could not be made, which is not tried again.
   *
   * `timeoutMs` shortens the time limit for this one request: a platform's
   * endpoint on this host answers at once or not at all. It never lengthens
   * the reader's own limit.
   */
  request(
    url: string,
    init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; timeoutMs?: number },
  ): Promise<Response>;
}

/** What a provider gives the reader: its two requests and a few words. */
export interface NetworkSecretSource<Credential> {
  /** Where this provider looks for `name`, for this host's own log. */
  sourceOf(name: string): string;
  /** What the credential is called in a reason: "no <credential>: <why>", and
   *  what asking for it is called: "<credentialRequest> could not be made". */
  readonly words: { readonly credential: string; readonly credentialRequest: string };
  /** Ask the platform for a credential, once. The reader tries again as the
   *  answer says, and keeps the credential until `refreshAt`. */
  requestCredential(io: NetworkSecretIo): Promise<Attempt<TimedCredential<Credential>>>;
  /** Ask the store for the value under `name`, once, as it is stored. The
   *  reader applies the rule every provider shares to what comes back. */
  requestSecret(name: string, credential: Credential, io: NetworkSecretIo): Promise<Attempt<string>>;
}

export interface NetworkSecretReaderOptions {
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

interface CachedValue {
  value: string;
  /** Both on the reader's clock. A value is served from `storedAt` until
   *  `expiresAt`. A clock that reads earlier than `storedAt` was set back, and
   *  the value is dropped: it would otherwise be served for its cache time
   *  plus however far the clock went back. */
  storedAt: number;
  expiresAt: number;
}

function isFresh(cached: CachedValue, now: number): boolean {
  return cached.storedAt <= now && now < cached.expiresAt;
}

function clampTtl(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SECRET_CACHE_TTL_MS;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.trunc(value), MAX_SECRET_CACHE_TTL_MS);
}

/** How long a store asked this host to wait, capped so one answer cannot hold
 *  a start for long. */
export function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 5_000) : undefined;
}

/** Why a request got no response. A fixed phrase, never the error's own text:
 *  a fetch error can repeat the URL it was given. */
export function networkReason(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") return "timed out";
  return "network error";
}

/** The statuses that send a client to another address. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** What `io.request` rejects with when the answer is a redirect. It holds
 *  nothing of the answer: not the status, and not where it pointed. */
class RedirectRefused extends Error {
  constructor() {
    super("the answer was a redirect");
    this.name = "RedirectRefused";
  }
}

function isRefusedRedirect(error: unknown): boolean {
  if (error instanceof RedirectRefused) return true;
  // What the runtime itself throws when it is told to fail on a redirect.
  return (error as { code?: unknown } | null)?.code === "UnexpectedRedirect";
}

/**
 * What an attempt came to when `io.request` rejected. `who` names the other
 * end in the reason: "the vault", "the identity endpoint".
 *
 * A redirect is not tried again and will not work later: something between
 * this host and the other end sends requests elsewhere, and the credential
 * does not follow. Everything else is a request that got no answer, which may
 * work on the next try.
 */
export function noResponse(error: unknown, who: string): Attempt<never> {
  if (isRefusedRedirect(error)) {
    return {
      ok: false,
      retry: false,
      transient: false,
      reason: `${who} answered with a redirect, which is not followed`,
    };
  }
  return { ok: false, retry: true, transient: true, reason: `${who} did not answer (${networkReason(error)})` };
}

export class NetworkSecretReader<Credential> {
  // `#` fields throughout. A TypeScript `private` field is an ordinary
  // property at run time, and this object holds secret values and a credential.
  readonly #source: NetworkSecretSource<Credential>;
  readonly #io: NetworkSecretIo;
  readonly #cacheTtlMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #requestTimeoutMs: number;
  readonly #attempts: number;

  /** The credential, when to stop using it, and when it was stored. As with a
   *  value, a clock that reads earlier than `storedAt` ends its use. */
  #credential: (TimedCredential<Credential> & { storedAt: number }) | null = null;
  /** Resolves to the credential or to why there is none. It never rejects, so
   *  a failure can be shared by every secret that is waiting for the
   *  credential, and each of them reports it under its own name. */
  #credentialInFlight: Promise<Attempt<Credential>> | null = null;
  readonly #values = new Map<string, CachedValue>();
  readonly #inFlight = new Map<string, Promise<string>>();
  #purgeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Raised by forget(). An answer that was on its way when forget() ran is
   *  returned to its caller and not kept. */
  #generation = 0;

  constructor(options: NetworkSecretReaderOptions, source: NetworkSecretSource<Credential>) {
    this.#source = source;
    this.#cacheTtlMs = clampTtl(options.cacheTtlMs);
    // Kept in a local, and called as a plain function: called as a method of
    // this object, an injected fetch would be handed the object as `this`.
    // Its name is the one test/console-read-api.test.ts finds outbound calls by.
    const fetchImpl = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 8_000;
    this.#attempts = Math.max(1, options.attempts ?? 3);
    this.#io = {
      now: () => this.#now(),
      request: async (url, init) => {
        const limit =
          init.timeoutMs !== undefined && init.timeoutMs > 0
            ? Math.min(init.timeoutMs, this.#requestTimeoutMs)
            : this.#requestTimeoutMs;
        const refused = new AbortController();
        const response = await fetchImpl(url, {
          method: init.method,
          headers: init.headers,
          ...(init.body !== undefined ? { body: init.body } : {}),
          // A redirect would carry the credential to another host. The
          // runtime hands the redirect back as it came, and it is refused
          // here, so that no provider has to remember to.
          redirect: "manual",
          signal: AbortSignal.any([AbortSignal.timeout(limit), refused.signal]),
        });
        if (REDIRECT_STATUSES.has(response.status)) {
          // Ending the request closes its connection now. Dropping the body
          // alone leaves it open until the time limit, for as long as the
          // other end keeps sending.
          refused.abort();
          await response.body?.cancel().catch(() => {});
          throw new RedirectRefused();
        }
        return response;
      },
    };
  }

  // -- what a provider passes on to its callers -------------------------------------

  /** The value under `name`, as the contract in types.ts says. */
  async get(name: string): Promise<string> {
    assertSecretName(name);
    const cached = this.#values.get(name);
    if (cached) {
      if (isFresh(cached, this.#now())) return cached.value;
      this.#values.delete(name);
    }
    // One request per name at a time. Callers that arrive while it is out wait
    // for the same answer.
    const pending = this.#inFlight.get(name);
    if (pending) return pending;
    const request = this.#read(name).finally(() => {
      // Only this request's own entry: forget() may have made room for a newer one.
      if (this.#inFlight.get(name) === request) this.#inFlight.delete(name);
    });
    this.#inFlight.set(name, request);
    return request;
  }

  /** Drop every value and the credential now. For shutdown, and for a caller
   *  that knows a secret was just rotated. A read that is on its way still
   *  answers whoever asked for it. A caller that asks after this starts a new
   *  read, so it never gets what the store held before. */
  forget(): void {
    this.#generation += 1;
    this.#values.clear();
    this.#credential = null;
    this.#inFlight.clear();
    this.#credentialInFlight = null;
    if (this.#purgeTimer) clearTimeout(this.#purgeTimer);
    this.#purgeTimer = null;
  }

  /** How many values are held in memory right now. A count, never a value. */
  get heldValues(): number {
    return this.#values.size;
  }

  // -- reading a value ---------------------------------------------------------------

  async #read(name: string): Promise<string> {
    const source = this.#source.sourceOf(name);
    const generation = this.#generation;
    let last: Attempt<string> = {
      ok: false,
      retry: false,
      transient: false,
      reason: "no attempt was made",
    };
    let renewedCredential = false;
    for (let attempt = 1; attempt <= this.#attempts; attempt += 1) {
      const credential = await this.#currentCredential();
      if (!credential.ok) {
        // The credential request made its own attempts. Reported under this
        // secret's name, whoever started the request.
        throw new SecretUnavailable(name, `no ${this.#source.words.credential}: ${credential.reason}`, {
          transient: credential.transient,
          source,
        });
      }
      try {
        last = await this.#source.requestSecret(name, credential.value, this.#io);
      } catch {
        // A provider reports what happened as an attempt, and does not throw.
        // If one throws anyway, what it threw is dropped: an error raised
        // while a response was read can repeat a piece of that response.
        last = {
          ok: false,
          retry: false,
          transient: false,
          reason: "the request for the secret could not be made",
        };
      }
      if (last.ok && typeof last.value !== "string") {
        // A provider's mistake: what it calls a value is not text. Nothing of
        // it is passed on.
        last = { ok: false, retry: false, transient: false, reason: "the request for the secret could not be made" };
      }
      if (last.ok) {
        // The same rule as every other provider: one final line ending is
        // removed, a blank value is a missing secret, an oversized one is
        // refused.
        const value = secretValueFrom(name, last.value, source);
        if (generation === this.#generation) this.#remember(name, value);
        return value;
      }
      if (last.missing) throw new SecretMissing(name, source);
      if (last.unauthorized && !renewedCredential) {
        // The store did not accept the credential. Ask for a new one, once,
        // without spending one of the attempts. Only the credential that was
        // refused is dropped: another read may have replaced it already, and
        // the store never refused that newer one.
        renewedCredential = true;
        if (this.#credential?.credential === credential.value) this.#credential = null;
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

  #remember(name: string, value: string): void {
    if (this.#cacheTtlMs === 0) return;
    const now = this.#now();
    this.#values.set(name, { value, storedAt: now, expiresAt: now + this.#cacheTtlMs });
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
          if (!isFresh(cached, now)) this.#values.delete(name);
        }
        this.#schedulePurge();
      },
      Math.max(1, earliest - this.#now()),
    );
    // Housekeeping must not keep the process alive.
    (this.#purgeTimer as { unref?: () => void }).unref?.();
  }

  // -- the credential ------------------------------------------------------------------

  #currentCredential(): Promise<Attempt<Credential>> {
    if (this.#credential) {
      const now = this.#now();
      if (this.#credential.storedAt <= now && now < this.#credential.refreshAt) {
        return Promise.resolve({ ok: true, value: this.#credential.credential });
      }
    }
    if (!this.#credentialInFlight) {
      const request = this.#fetchCredential()
        .catch(
          (): Attempt<Credential> => ({
            ok: false,
            retry: false,
            transient: false,
            reason: `${this.#source.words.credentialRequest} could not be made`,
          }),
        )
        .finally(() => {
          if (this.#credentialInFlight === request) this.#credentialInFlight = null;
        });
      this.#credentialInFlight = request;
    }
    return this.#credentialInFlight;
  }

  async #fetchCredential(): Promise<Attempt<Credential>> {
    const generation = this.#generation;
    let last: Attempt<TimedCredential<Credential>> = {
      ok: false,
      retry: false,
      transient: false,
      reason: "no attempt was made",
    };
    for (let attempt = 1; attempt <= this.#attempts; attempt += 1) {
      // Read before the request, and so before the provider reads the clock to
      // work out `refreshAt`. A clock that is set back while the request is
      // out then reads earlier than this, and the credential is not kept.
      const storedAt = this.#now();
      last = await this.#source.requestCredential(this.#io);
      if (last.ok) {
        if (generation === this.#generation) this.#credential = { ...last.value, storedAt };
        return { ok: true, value: last.value.credential };
      }
      if (!last.retry || attempt === this.#attempts) break;
      await this.#sleep(last.retryAfterMs ?? 200 * 2 ** (attempt - 1));
    }
    return last.ok ? { ok: false, retry: false, transient: false, reason: "no answer" } : last;
  }
}

// ── Keeping a credential request off a proxy ─────────────────────────────────

/** Variables that name a proxy for outbound requests. */
const PROXY_VARIABLES = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"];

/**
 * Keep requests to one endpoint away from a proxy named in the environment.
 *
 * A platform's identity endpoint is on this host, or on its link-local
 * network, and is spoken to in clear text. A proxy that carried that request
 * would see the credential that comes back. The runtime sends every request
 * through a proxy named in HTTP_PROXY, requests to this host included, unless
 * the host is listed in NO_PROXY, and it reads NO_PROXY when a request is
 * made. So the endpoint's host is added there.
 *
 * `env` is the environment the requests will be made under: the process's own
 * in a running HX Fortress. Both spellings of the variable are set to the same
 * list, so the one the runtime reads cannot hide what the other one held.
 * Nothing is changed when no proxy is named, or when the host is already
 * listed.
 *
 * An IPv6 address is listed twice: in brackets, which is the only form the
 * runtime matches, and bare, which is what other tools that read the list
 * expect.
 */
export function keepEndpointOffProxy(env: Record<string, string | undefined>, endpoint: string): void {
  // The names are the literals above.
  // eslint-disable-next-line security/detect-object-injection
  if (!PROXY_VARIABLES.some((name) => env[name]?.trim())) return;
  // The URL parser gives an IPv6 address in brackets.
  const host = new URL(endpoint).hostname.toLowerCase();
  const wanted = host.startsWith("[") ? [host, host.slice(1, -1)] : [host];
  const listed = [env.NO_PROXY, env.no_proxy]
    .flatMap((value) => (value ?? "").split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const entries = [...new Set(listed)];
  if (entries.includes("*")) return;
  for (const form of wanted) {
    if (!entries.some((entry) => entry.toLowerCase() === form)) entries.push(form);
  }
  env.NO_PROXY = entries.join(",");
  env.no_proxy = entries.join(",");
}

// ── The setting these providers share ────────────────────────────────────────

/** How long a value is kept in memory. One setting, with one variable, for
 *  every provider that keeps values. */
export const CACHE_SECONDS_SETTING: SecretProviderSetting = {
  key: "cacheSeconds",
  env: "FORTRESS_SECRETS_CACHE_SECONDS",
  meaning: "How long a value is kept in memory, from `0` to `900`. Default `60`.",
  numeric: true,
  oneLetterShort: { holds: "a number of seconds", when: (value) => /^\d+$/.test(value) },
};

/** The cache time a `cacheSeconds` setting asks for, in milliseconds, or
 *  nothing when it is not set. A value that is not a whole number of seconds
 *  in range is refused. */
export function cacheTtlFromSetting(setting: GivenSetting | null): number | undefined {
  if (!setting) return undefined;
  const seconds = Number(setting.value);
  const most = MAX_SECRET_CACHE_TTL_MS / 1000;
  if (!/^\d{1,6}$/.test(setting.value) || seconds > most) {
    throw invalidSecretsConfig(`${setting.where} must be a whole number of seconds from 0 to ${most}`);
  }
  return seconds * 1000;
}
