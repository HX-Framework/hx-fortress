// Secrets that the host and its modules read by name.
//
// A secret has a name and a value. The name is what config files and the
// control plane hold. The value lives in the customer's own store and is read
// on this host only. `providers.ts` lists the stores this build can read.
//
// The rule every provider keeps: a value is returned to the caller and goes
// nowhere else. It is never part of an error, a log line or an audit record,
// and a provider never writes one to disk.

export interface SecretProvider {
  /**
   * The provider's name, such as "env" or "file".
   *
   * It is a name, not one of a fixed list. Each provider brings its own, so
   * code that is handed a kind must not assume it knows every one. The names
   * this build has are SECRET_PROVIDER_KINDS in providers.ts.
   */
  readonly kind: string;
  /**
   * The value stored under `name`, with one final line ending removed.
   *
   * Throws SecretMissing(name) when the store holds no value under that name,
   * SecretUnavailable when the store could not answer, and SecretNameInvalid
   * for a name that breaks the rule below. No message ever holds a value.
   *
   * A provider that reads over the network may answer from memory for up to a
   * minute, so a value changed in the store can take that long to show.
   */
  get(name: string): Promise<string>;
  /** False when `get` would throw SecretMissing. Everything else `get` throws,
   *  this throws too: a store that cannot answer has not said "no". */
  has(name: string): Promise<boolean>;
}

/** A provider's name. */
export type SecretProviderKind = string;

/** The shape of a provider's name: a lowercase letter, then up to 31 more of
 *  a-z, 0-9 and "-". A name is shown in a status report and written in config
 *  files, so it holds nothing else. */
export const SECRET_PROVIDER_KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** True for a string with the shape of a provider's name. It does not say that
 *  this build has such a provider: `isSecretProviderKind` in providers.ts does. */
export function isSecretProviderKindName(value: unknown): value is SecretProviderKind {
  return typeof value === "string" && SECRET_PROVIDER_KIND_PATTERN.test(value);
}

// ── Names ───────────────────────────────────────────────────────────────────

/** 1 to 64 characters of a-z, 0-9 and "-". A name holds nothing that changes
 *  a file path, a URL or an environment variable name. */
export const SECRET_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;

/** The longest value a provider returns, in bytes of UTF-8. Azure Key Vault
 *  caps a secret at 25 KB; anything far past that is not a secret someone
 *  meant to store. */
export const MAX_SECRET_BYTES = 64 * 1024;

export function isSecretName(name: unknown): boolean {
  return typeof name === "string" && SECRET_NAME_PATTERN.test(name);
}

/** Every provider calls this first, so a name can never reach a path, a URL or
 *  an environment lookup unchecked. */
export function assertSecretName(name: string): void {
  if (!isSecretName(name)) throw new SecretNameInvalid();
}

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * The name does not match the rule.
 *
 * The message does not repeat what was passed. A caller that passes a value
 * where a name belongs has made a mistake, and repeating the input would put
 * that value into whatever prints the error.
 */
export class SecretNameInvalid extends Error {
  constructor() {
    super('a secret name is 1 to 64 characters of a-z, 0-9 and "-"');
    this.name = "SecretNameInvalid";
  }
}

/**
 * What the two "could not give you the value" errors share.
 *
 * `source` says where the provider looked ("environment variable
 * FORTRESS_SECRET_DB_URL", "file /run/secrets/db-url"). It is for this host's
 * own log. It is kept out of the message, and out of what JSON.stringify
 * shows, because both may travel further than this host and a local path is
 * not something to send along. Use `secretErrorForLog` to print it.
 */
abstract class SecretReadError extends Error {
  readonly secretName: string;
  declare readonly source: string | null;

  constructor(message: string, name: string, source: string | null) {
    super(message);
    this.secretName = isSecretName(name) ? name : "";
    Object.defineProperty(this, "source", { value: source, enumerable: false });
  }
}

/**
 * The store answered, and it holds no usable value under this name.
 */
export class SecretMissing extends SecretReadError {
  constructor(name: string, source: string | null = null) {
    // A provider checks the name before it looks anything up, so `name` is
    // always a valid one here. The check below covers a caller that builds
    // this error by hand with something else.
    super(isSecretName(name) ? `secret "${name}" is not set` : "secret is not set", name, source);
    this.name = "SecretMissing";
  }
}

/**
 * The provider could not tell whether the secret exists: the store did not
 * answer, refused the request, or returned something that is not a secret.
 *
 * `reason` is written by the provider from a fixed set of words plus a status
 * or error code. It is never taken from a response body or a file's contents.
 *
 * `transient` is true when asking again later may work with nothing changed
 * on this host: a timeout, a busy store, or an access role that was granted a
 * moment ago and has not taken effect yet.
 */
export class SecretUnavailable extends SecretReadError {
  readonly reason: string;
  readonly transient: boolean;

  constructor(
    name: string,
    reason: string,
    options: { transient?: boolean; source?: string | null } = {},
  ) {
    super(
      isSecretName(name)
        ? `secret "${name}" could not be read: ${reason}`
        : `a secret could not be read: ${reason}`,
      name,
      options.source ?? null,
    );
    this.name = "SecretUnavailable";
    this.reason = reason;
    this.transient = options.transient === true;
  }
}

/** One line for this host's own log: the message, and where the provider
 *  looked when it knows. Never send this line off the host. */
export function secretErrorForLog(error: unknown): string {
  if (error instanceof SecretReadError && error.source) return `${error.message} (${error.source})`;
  return error instanceof Error ? error.message : String(error);
}
