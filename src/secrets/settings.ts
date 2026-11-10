// A setting whose value is given as the NAME of a secret.
//
// A setting that holds a credential can be given two ways. Taking the database
// URL as the example:
//
//   FORTRESS_DATABASE_URL          the value itself
//   FORTRESS_DATABASE_URL_SECRET   the name of a secret that holds the value
//
// With the second form the value is read from the secret provider when the
// process starts and is held in memory only. It is not in the process
// environment, and the code that receives it must not write it to a file.

import { isSecretName, SecretUnavailable, type SecretProvider } from "./types";

/**
 * The secret name given for `variable`, or null when the setting is not given
 * by name.
 *
 * Giving both forms is refused: one of them would be ignored, and which one is
 * not something to leave to a reader's guess.
 */
export function secretNameForSetting(
  env: Record<string, string | undefined>,
  variable: string,
): string | null {
  const exact = `${variable}_SECRET`;
  // A variable that only looks like the setting, such as ..._SECRET_NAME or
  // ..._SECRETS, would be ignored without a word, and the setting would then
  // take its default. For the database URL that default is another database.
  const lookalike = Object.keys(env).find(
    (key) =>
      key !== exact &&
      key.toUpperCase().startsWith(exact) &&
      // `key` is one of the object's own keys.
      // eslint-disable-next-line security/detect-object-injection
      (env[key] ?? "").trim() !== "",
  );
  if (lookalike) {
    throw new Error(`${lookalike} is not a setting. The name of the secret goes in ${exact}`);
  }
  // `variable` is a literal at every call site.
  // eslint-disable-next-line security/detect-object-injection
  const value = env[variable]?.trim();
  // eslint-disable-next-line security/detect-object-injection
  const given = env[exact];
  if (given === undefined) return null;
  const name = given.trim();
  if (name === "") {
    // Set and empty is a template that was not filled in. Treating it as "not
    // set" would start the fortress on the setting's default.
    throw new Error(`${exact} is set and empty. Give it the name of the secret, or remove it`);
  }
  if (value) {
    throw new Error(`${variable} and ${variable}_SECRET are both set. Set one of them`);
  }
  if (!isSecretName(name)) {
    throw new Error(
      `${variable}_SECRET must be the name of a secret: 1 to 64 characters of a-z, 0-9 and "-"`,
    );
  }
  return name;
}

export interface ReadAtStartOptions {
  /** How many times the read is tried when the store cannot answer. */
  attempts?: number;
  /** The wait between two tries. */
  delayMs?: number;
  /** Told before each wait, so the log shows why start is slow. */
  onRetry?: (info: { name: string; reason: string; attempt: number; attempts: number }) => void;
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Read a secret the process cannot start without.
 *
 * A store that may answer later is asked again for about a minute. The common
 * case is a first deployment: a new managed identity is refused by Azure Key
 * Vault for the first minutes, until its role assignment takes effect. A
 * secret that is missing, and a failure that waiting cannot change (a file
 * that is not text, a directory that does not exist), are not asked for again.
 */
export async function readSecretAtStart(
  provider: SecretProvider,
  name: string,
  options: ReadAtStartOptions = {},
): Promise<string> {
  const attempts = Math.max(1, options.attempts ?? 6);
  const delayMs = options.delayMs ?? 10_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await provider.get(name);
    } catch (error) {
      if (!(error instanceof SecretUnavailable) || !error.transient || attempt >= attempts) throw error;
      options.onRetry?.({ name, reason: error.reason, attempt, attempts });
      await sleep(delayMs);
    }
  }
}

/**
 * Refuse a database URL secret whose value is not a postgres:// URL, and do
 * not repeat the value.
 *
 * The database driver quotes a connection string it cannot parse in its own
 * error. That error is logged and written to the status file, and the code
 * that cleans it knows the shape of a URL only. A value in another form
 * (keyword=value pairs, JSON, a bare password) would reach both in full. So a
 * value is checked here, before any driver sees it.
 */
export function assertDatabaseUrlSecret(name: string, value: string): void {
  const refuse = (reason: string): never => {
    throw new SecretUnavailable(name, reason, { transient: false });
  };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refuse("its value is not a postgres:// connection URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    refuse("its value is not a postgres:// connection URL");
  }
  try {
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
  } catch {
    refuse("the user name or the password in its value is not valid percent-encoding");
  }
}

export interface DatabaseUrlSetting {
  /** The environment to hand to the Postgres provider. When the URL was read
   *  from a secret, this is a copy that holds it; `process.env` is untouched,
   *  so no child process inherits the value. */
  env: Record<string, string | undefined>;
  /** The name of the secret the URL came from, or null when it was not given
   *  by name. Whoever writes the console's coordinates writes this name in
   *  place of the URL. */
  secretName: string | null;
}

/**
 * The database URL, when FORTRESS_DATABASE_URL_SECRET names a secret.
 *
 * `provider` is a function so that a fortress that does not use the setting
 * never builds a provider for it.
 */
export async function resolveDatabaseUrlSetting(args: {
  env: Record<string, string | undefined>;
  provider: () => SecretProvider | Promise<SecretProvider>;
  onRetry?: ReadAtStartOptions["onRetry"];
  sleep?: ReadAtStartOptions["sleep"];
}): Promise<DatabaseUrlSetting> {
  const secretName = secretNameForSetting(args.env, "FORTRESS_DATABASE_URL");
  if (!secretName) return { env: args.env, secretName: null };
  const value = await readSecretAtStart(await args.provider(), secretName, {
    ...(args.onRetry ? { onRetry: args.onRetry } : {}),
    ...(args.sleep ? { sleep: args.sleep } : {}),
  });
  assertDatabaseUrlSecret(secretName, value);
  return { env: { ...args.env, FORTRESS_DATABASE_URL: value }, secretName };
}
