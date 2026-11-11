// Which secret provider this fortress uses, and how one is built.
//
// The choice is a setting like any other. It is read from the environment
// first and from the `secrets` block of config.json second, and with neither
// it is the first provider of the list:
//
//   environment                      config.json "secrets"
//   FORTRESS_SECRETS_PROVIDER        provider
//
// Each provider brings its own settings, and each setting has a variable and a
// key in the block. `providers.ts` lists the providers, and each provider's
// own file lists its settings. The code in this file names no provider: it
// reads that list.
//
//   config.json, for example:  "secrets": { "provider": "file", "dir": "/run/secrets" }
//
// A service unit carries no environment of its own, so a host install sets the
// block in config.json. A container sets the variables.
//
// Anything this build does not understand is refused by name: an unknown
// provider, an unknown key in the block, an unknown variable with a settings
// prefix, and a setting given for a provider that is not the one in use.
// Falling back to `env` instead would make a fortress that was configured for
// one store read its secrets from another without saying so.
//
// The block may be written before the first enrollment, in a config.json that
// holds nothing else. The host keeps it when it writes the rest of the file.

import { readFile } from "node:fs/promises";

import { invalidSecretsConfig as invalid, type GivenSetting, type SecretProviderSetting } from "./definition";
import { SECRET_ENV_PREFIX } from "./env";
import {
  DEFAULT_SECRET_PROVIDER_KIND,
  isSecretProviderKind,
  SECRET_PROVIDER_KINDS,
  SECRET_PROVIDERS,
  secretProviderDefinition,
  type SecretsConfig,
} from "./providers";
import type { SecretProvider } from "./types";

export type { SecretsConfig } from "./providers";

/** One setting, with every listed provider that has it. Two providers may share
 *  a setting, and then it has one variable and one meaning for both. */
interface OwnedSetting extends SecretProviderSetting {
  readonly owners: readonly string[];
}

/** Every setting of every listed provider, in the order of the list. */
const PROVIDER_SETTINGS: readonly OwnedSetting[] = (() => {
  const byKey = new Map<string, { setting: SecretProviderSetting; owners: string[] }>();
  for (const provider of SECRET_PROVIDERS) {
    for (const setting of provider.settings) {
      const known = byKey.get(setting.key);
      if (!known) {
        byKey.set(setting.key, { setting, owners: [provider.kind] });
        continue;
      }
      // A key that means one variable for one provider and another variable
      // for the next would make config.json and the environment disagree.
      if (known.setting.env !== setting.env) {
        throw new Error(`secret providers disagree about the variable of the setting ${setting.key}`);
      }
      known.owners.push(provider.kind);
    }
  }
  return [...byKey.values()].map(({ setting, owners }) => ({ ...setting, owners }));
})();

/** The keys the `secrets` block of config.json may hold. */
const BLOCK_KEYS: readonly string[] = ["provider", ...PROVIDER_SETTINGS.map((setting) => setting.key)];
const NUMERIC_KEYS: ReadonlySet<string> = new Set(
  PROVIDER_SETTINGS.filter((setting) => setting.numeric).map((setting) => setting.key),
);

/** The variables this build reads. Every one starts with the common prefix,
 *  a provider's own settings included. Any other variable with that prefix, or
 *  with a prefix a provider asks to have guarded, is refused, so a mistyped
 *  setting is not ignored. */
const COMMON_ENV_PREFIX = "FORTRESS_SECRETS_";
const PROVIDER_ENV = `${COMMON_ENV_PREFIX}PROVIDER`;
const KNOWN_ENV: ReadonlySet<string> = new Set([PROVIDER_ENV, ...PROVIDER_SETTINGS.map((setting) => setting.env)]);
for (const name of KNOWN_ENV) {
  // A setting outside the common prefix could be mistyped without a word.
  if (!name.startsWith(COMMON_ENV_PREFIX)) {
    throw new Error(`the secrets setting ${name} does not start with ${COMMON_ENV_PREFIX}`);
  }
}
const SETTING_ENV_PREFIXES: readonly string[] = [
  ...new Set([COMMON_ENV_PREFIX, ...SECRET_PROVIDERS.flatMap((provider) => provider.guardedEnvPrefixes ?? [])]),
];

export interface ResolveSecretsConfigArgs {
  env: Record<string, string | undefined>;
  /** config.json as parsed JSON, or null when the file does not exist yet.
   *  Only its `secrets` key is read. */
  config: unknown;
  /** The fortress root, for a provider whose default place is under it. */
  root: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** "the file provider", or "the a and b providers" for a shared setting. */
function providersNamed(kinds: readonly string[]): string {
  return kinds.length === 1 ? `the ${kinds[0]} provider` : `the ${kinds.join(" and ")} providers`;
}

/** The `secrets` block with every key checked, whether or not the environment
 *  overrides it. A key this build does not know and a value of the wrong type
 *  are mistakes to report, never things to skip. */
function readBlock(config: unknown): Map<string, string> {
  const block = new Map<string, string>();
  if (config === null || config === undefined) return block;
  if (!isRecord(config)) throw invalid("config.json must hold a JSON object");
  if (config.secrets === undefined) return block;
  if (!isRecord(config.secrets)) throw invalid("secrets must be an object");

  for (const [key, value] of Object.entries(config.secrets)) {
    if (!BLOCK_KEYS.includes(key)) {
      // A key is repeated only when it looks like a key. Whatever else was
      // written there stays out of the message.
      const shown = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(key) ? `secrets.${key}` : "a key in secrets";
      throw invalid(`${shown} is not a setting this build knows (it knows ${BLOCK_KEYS.join(", ")})`);
    }
    // A setting that is a number may be written as a JSON number.
    if (NUMERIC_KEYS.has(key) && typeof value === "number") {
      block.set(key, String(value));
      continue;
    }
    if (typeof value !== "string") throw invalid(`secrets.${key} must be a string`);
    const trimmed = value.trim();
    if (trimmed) block.set(key, trimmed);
  }
  return block;
}

/**
 * Refuse a variable that looks like a secrets setting and is not one.
 *
 * FORTRESS_SECRETS_DIRECTORY, FORTRESS_SECRETS_AZURE_VAULT_URI and the like
 * would be ignored without a word, and the fortress would read its secrets
 * from the default place.
 *
 * FORTRESS_SECRET_PROVIDER and FORTRESS_SECRET_DIR are one letter short of two
 * settings, and both are also valid variables for secrets named `provider` and
 * `dir`. A provider name or a directory path in one of them is the setting,
 * mistyped. The same holds for every setting that says how to tell itself
 * (`oneLetterShort` in its definition).
 */
function refuseMistypedSettings(env: Record<string, string | undefined>): void {
  for (const name of Object.keys(env)) {
    if (KNOWN_ENV.has(name) || !SETTING_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    // eslint-disable-next-line security/detect-object-injection
    if (!env[name]?.trim()) continue;
    const shown = /^[A-Z0-9_]{1,64}$/.test(name) ? name : `a ${SETTING_ENV_PREFIXES.join("* or ")}* variable`;
    throw invalid(`${shown} is not a setting this build knows (it knows ${[...KNOWN_ENV].join(", ")})`);
  }
  /** The variable one letter short of a setting's own, and what it holds. */
  const short = (settingEnv: string): { name: string; value: string | undefined } => {
    const name = `${SECRET_ENV_PREFIX}${settingEnv.slice(COMMON_ENV_PREFIX.length)}`;
    // The name is built from a setting's own name and a fixed prefix.
    // eslint-disable-next-line security/detect-object-injection
    return { name, value: env[name]?.trim() || undefined };
  };
  const given = (settingEnv: string): boolean =>
    // eslint-disable-next-line security/detect-object-injection
    Boolean(env[settingEnv]?.trim());

  const provider = short(PROVIDER_ENV);
  if (isSecretProviderKind(provider.value) && !given(PROVIDER_ENV)) {
    throw invalid(`${provider.name} holds a provider name. The setting is ${PROVIDER_ENV}`);
  }
  for (const setting of PROVIDER_SETTINGS) {
    if (!setting.oneLetterShort || !setting.env.startsWith(COMMON_ENV_PREFIX)) continue;
    const found = short(setting.env);
    if (found.value !== undefined && setting.oneLetterShort.when(found.value) && !given(setting.env)) {
      throw invalid(`${found.name} holds ${setting.oneLetterShort.holds}. The setting is ${setting.env}`);
    }
  }
}

export function resolveSecretsConfig(args: ResolveSecretsConfigArgs): SecretsConfig {
  const block = readBlock(args.config);
  refuseMistypedSettings(args.env);
  const envProvider = args.env.FORTRESS_SECRETS_PROVIDER?.trim() || undefined;
  const blockProvider = block.get("provider");

  const provider = envProvider ?? blockProvider ?? DEFAULT_SECRET_PROVIDER_KIND;
  const definition = secretProviderDefinition(provider);
  if (!definition) {
    // The value is not repeated: a line pasted into the wrong setting can be
    // a credential. Saying where it is set is enough to find it.
    const where = envProvider ? PROVIDER_ENV : "secrets.provider in config.json";
    throw invalid(`${where} must be one of ${SECRET_PROVIDER_KINDS.join(", ")}`);
  }

  /**
   * One setting, as given for the provider in use: its value and where it was
   * set. A setting of another provider is refused. It is half a choice:
   * whoever wrote it meant that provider, and this one would look somewhere
   * else.
   *
   * One case is not a mistake: the environment picks another provider over a
   * block that is complete for its own.
   */
  const given = (setting: OwnedSetting): GivenSetting | null => {
    const fromEnv = args.env[setting.env]?.trim() || undefined;
    const fromBlock = block.get(setting.key);
    if (!setting.owners.includes(provider)) {
      const first = setting.owners[0] ?? "";
      if (fromEnv) {
        throw invalid(
          `${setting.env} is set, but the provider is ${provider}. It is a setting of ` +
            `${providersNamed(setting.owners)}: set ${PROVIDER_ENV}=${first}, or remove it`,
        );
      }
      if (fromBlock && (blockProvider === undefined || !setting.owners.includes(blockProvider))) {
        throw invalid(
          blockProvider === undefined
            ? `secrets.${setting.key} is set in config.json with no secrets.provider. It is a setting of ` +
                `${providersNamed(setting.owners)}: add "provider": "${first}"`
            : `secrets.${setting.key} is set in config.json, but secrets.provider is ${blockProvider}. ` +
                `It is a setting of ${providersNamed(setting.owners)}`,
        );
      }
      return null;
    }
    if (fromEnv) return { value: fromEnv, where: setting.env };
    if (fromBlock) return { value: fromBlock, where: `secrets.${setting.key} in config.json` };
    return null;
  };
  // Every setting is looked at, so one that belongs to another provider is
  // refused whichever provider is in use.
  const settings = new Map<string, GivenSetting | null>();
  for (const setting of PROVIDER_SETTINGS) settings.set(setting.key, given(setting));

  // The definition is one of the listed ones, so what it returns is one of the
  // listed configs.
  return definition.resolve({
    setting: (key) => settings.get(key) ?? null,
    root: args.root,
  }) as SecretsConfig;
}

export function createSecretProvider(
  config: SecretsConfig,
  deps: { env?: Record<string, string | undefined> } = {},
): SecretProvider {
  const definition = secretProviderDefinition((config as { provider?: unknown } | null)?.provider);
  // Unreachable through the types. Reached by a config built by hand, and
  // returning nothing there would fail later and far from the cause.
  if (!definition) throw invalid("no provider can be built for this config");
  return definition.create(config, deps);
}

/** What a status line or a log may say about the choice. It names where the
 *  secrets are, and never anything read from there. */
export function describeSecretsConfig(config: SecretsConfig): string {
  const definition = secretProviderDefinition((config as { provider?: unknown } | null)?.provider);
  return definition ? definition.describe(config) : "unknown";
}

/**
 * Read config.json and resolve the provider it names.
 *
 * A missing config.json means the defaults: a fortress that has not enrolled
 * yet has no file. A config.json that exists and cannot be read as a JSON
 * object is refused, because the provider it would have named is unknown.
 */
export async function loadSecretsConfig(
  paths: { root: string; config: string },
  env: Record<string, string | undefined> = process.env,
): Promise<SecretsConfig> {
  let text: string | null;
  try {
    // The path is the fortress's own config.json, never something a caller
    // or a request supplies.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    text = await readFile(paths.config, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
      throw invalid("config.json could not be read");
    }
    text = null;
  }

  let config: unknown = null;
  if (text !== null) {
    try {
      config = JSON.parse(text);
    } catch {
      throw invalid("config.json is not valid JSON");
    }
    // `null` is valid JSON and is not a config.
    if (!isRecord(config)) throw invalid("config.json must hold a JSON object");
  }

  return resolveSecretsConfig({ env, config, root: paths.root });
}

/**
 * Check the secret settings when a process starts, before any secret is needed,
 * and return what they resolve to.
 *
 * Without this, a mistyped provider or a setting that belongs to another
 * provider would go unnoticed until the day a secret is first read. The
 * provider is built and nothing is asked of it, so no request leaves this host.
 *
 * A config.json that is missing, or that cannot be read as a JSON object, is
 * not judged here: a fortress that has not enrolled has none, and what a
 * damaged one means for the start is decided by the code that owns that file.
 * The settings in the environment are checked either way. A secret is never
 * read on the strength of such a file: `loadSecretsConfig` refuses it.
 */
export async function checkSecretSettings(
  paths: { root: string; config: string },
  env: Record<string, string | undefined> = process.env,
): Promise<SecretsConfig> {
  let config: unknown = null;
  try {
    // The fortress's own config.json, never a path a caller supplies.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const parsed: unknown = JSON.parse(await readFile(paths.config, "utf8"));
    if (isRecord(parsed)) config = parsed;
  } catch {
    config = null;
  }
  const resolved = resolveSecretsConfig({ env, config, root: paths.root });
  createSecretProvider(resolved, { env });
  return resolved;
}

/**
 * What the provider in use needs from this host, as one line for the log at
 * start. Null for a provider that needs nothing.
 *
 * A provider with a need cannot work on every host. Its settings can be valid
 * on a host that cannot give it what it needs, and then the first read fails.
 * Saying so when the fortress starts puts the reason next to that failure.
 */
export function secretProviderNeedLine(config: SecretsConfig): string | null {
  const definition = secretProviderDefinition((config as { provider?: unknown } | null)?.provider);
  if (!definition?.needs) return null;
  return `secrets are read by the ${definition.describe(config)} provider. It needs: ${definition.needs}`;
}

/** Read config.json and build the provider it names. */
export async function loadSecretProvider(
  paths: { root: string; config: string },
  env: Record<string, string | undefined> = process.env,
): Promise<SecretProvider> {
  return createSecretProvider(await loadSecretsConfig(paths, env), { env });
}

/**
 * One provider for a whole process, built the first time it is asked for.
 *
 * A process that reads secrets in several places calls this once and passes
 * the returned function around, so every place shares one provider. Nothing is
 * read until the first call. A build that fails is tried again on the next
 * call, so a config.json that was fixed is picked up with no restart.
 */
export function lazySecretProvider(
  paths: { root: string; config: string },
  env: Record<string, string | undefined> = process.env,
): () => Promise<SecretProvider> {
  let pending: Promise<SecretProvider> | null = null;
  return () => {
    pending ??= loadSecretProvider(paths, env).catch((error: unknown) => {
      pending = null;
      throw error;
    });
    return pending;
  };
}
