// Which secret provider this fortress uses, and how one is built.
//
// The choice is a setting like any other. It is read from the environment
// first and from the `secrets` block of config.json second, and with neither
// it is `env`:
//
//   environment                      config.json "secrets"   provider it belongs to
//   FORTRESS_SECRETS_PROVIDER        provider                (env | file | azure-key-vault)
//   FORTRESS_SECRETS_DIR             dir                     file
//   FORTRESS_KEY_VAULT_URL           vaultUrl                azure-key-vault
//   FORTRESS_KEY_VAULT_CLIENT_ID     clientId                azure-key-vault
//   FORTRESS_SECRETS_CACHE_SECONDS   cacheSeconds            azure-key-vault
//
//   config.json:  "secrets": { "provider": "file", "dir": "/run/secrets" }
//
// A service unit carries no environment of its own, so a host install sets the
// block in config.json. A container sets the variables.
//
// Anything this build does not understand is refused by name: an unknown
// provider, an unknown key in the block, an unknown FORTRESS_SECRETS_* or
// FORTRESS_KEY_VAULT_* variable, and a setting given for a provider that is
// not the one in use. Falling back to `env` instead would make a fortress that
// was configured for one store read its secrets from another without saying so.
//
// One limit to know: the host rewrites config.json when it enrolls, and it
// keeps the `secrets` block only when the rest of the file is a config it
// accepts. Add the block to a fortress that has already enrolled.

import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  AzureKeyVaultSecretProvider,
  keepOffProxy,
  MANAGED_IDENTITY_CLIENT_ID,
  MAX_SECRET_CACHE_TTL_MS,
  parseKeyVaultUrl,
  resolveManagedIdentity,
  type KeyVaultTarget,
} from "./azure-key-vault";
import { EnvSecretProvider, SECRET_ENV_PREFIX } from "./env";
import { FileSecretProvider } from "./file";
import {
  isSecretProviderKind,
  SECRET_PROVIDER_KINDS,
  type SecretProvider,
  type SecretProviderKind,
} from "./types";

export type SecretsConfig =
  | { provider: "env" }
  | { provider: "file"; dir: string }
  | {
      provider: "azure-key-vault";
      vault: KeyVaultTarget;
      /** Picks one user-assigned managed identity. Absent means the
       *  system-assigned one. */
      clientId?: string;
      /** How long a value read from the vault is kept in memory. Absent means
       *  the provider's default. */
      cacheTtlMs?: number;
    };

/** Every setting that belongs to one provider: its key in the `secrets` block
 *  and its environment variable. */
const PROVIDER_SETTINGS = {
  dir: { provider: "file", env: "FORTRESS_SECRETS_DIR" },
  vaultUrl: { provider: "azure-key-vault", env: "FORTRESS_KEY_VAULT_URL" },
  clientId: { provider: "azure-key-vault", env: "FORTRESS_KEY_VAULT_CLIENT_ID" },
  cacheSeconds: { provider: "azure-key-vault", env: "FORTRESS_SECRETS_CACHE_SECONDS" },
} as const satisfies Record<string, { provider: SecretProviderKind; env: string }>;

type ProviderSettingKey = keyof typeof PROVIDER_SETTINGS;
const PROVIDER_SETTING_KEYS = Object.keys(PROVIDER_SETTINGS) as ProviderSettingKey[];

/** The keys the `secrets` block of config.json may hold. */
const BLOCK_KEYS: readonly string[] = ["provider", ...PROVIDER_SETTING_KEYS];
type BlockKey = "provider" | ProviderSettingKey;

/** The variables this build reads. Any other variable with one of the two
 *  prefixes below is refused, so a mistyped setting is not ignored. */
const PROVIDER_ENV = "FORTRESS_SECRETS_PROVIDER";
const KNOWN_ENV: ReadonlySet<string> = new Set([
  PROVIDER_ENV,
  ...Object.values(PROVIDER_SETTINGS).map((setting) => setting.env),
]);
const SETTING_ENV_PREFIXES = ["FORTRESS_SECRETS_", "FORTRESS_KEY_VAULT_"] as const;

export interface ResolveSecretsConfigArgs {
  env: Record<string, string | undefined>;
  /** config.json as parsed JSON, or null when the file does not exist yet.
   *  Only its `secrets` key is read. */
  config: unknown;
  /** The fortress root. The `file` provider reads `<root>/secrets` unless a
   *  directory is configured. */
  root: string;
}

function invalid(reason: string): Error {
  return new Error(`Invalid secrets config: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `secrets` block with every key checked, whether or not the environment
 *  overrides it. A key this build does not know and a value of the wrong type
 *  are mistakes to report, never things to skip. */
function readBlock(config: unknown): Partial<Record<BlockKey, string>> {
  if (config === null || config === undefined) return {};
  if (!isRecord(config)) throw invalid("config.json must hold a JSON object");
  if (config.secrets === undefined) return {};
  if (!isRecord(config.secrets)) throw invalid("secrets must be an object");

  const block: Partial<Record<BlockKey, string>> = {};
  for (const [key, value] of Object.entries(config.secrets)) {
    if (!BLOCK_KEYS.includes(key)) {
      // A key is repeated only when it looks like a key. Whatever else was
      // written there stays out of the message.
      const shown = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(key) ? `secrets.${key}` : "a key in secrets";
      throw invalid(`${shown} is not a setting this build knows (it knows ${BLOCK_KEYS.join(", ")})`);
    }
    // A number of seconds may be written as a JSON number.
    if (key === "cacheSeconds" && typeof value === "number") {
      block.cacheSeconds = String(value);
      continue;
    }
    if (typeof value !== "string") throw invalid(`secrets.${key} must be a string`);
    const trimmed = value.trim();
    if (trimmed) block[key as BlockKey] = trimmed;
  }
  return block;
}

/**
 * Refuse a variable that looks like a secrets setting and is not one.
 *
 * FORTRESS_SECRETS_DIRECTORY, FORTRESS_KEY_VAULT_URI and the like would be
 * ignored without a word, and the fortress would read its secrets from the
 * default place.
 *
 * FORTRESS_SECRET_PROVIDER and FORTRESS_SECRET_DIR are one letter short of two
 * settings, and both are also valid variables for secrets named `provider` and
 * `dir`. A provider name or a directory path in one of them is the setting,
 * mistyped.
 */
function refuseMistypedSettings(env: Record<string, string | undefined>): void {
  for (const name of Object.keys(env)) {
    if (KNOWN_ENV.has(name) || !SETTING_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    // eslint-disable-next-line security/detect-object-injection
    if (!env[name]?.trim()) continue;
    const shown = /^[A-Z0-9_]{1,64}$/.test(name) ? name : `a ${SETTING_ENV_PREFIXES.join("* or ")}* variable`;
    throw invalid(`${shown} is not a setting this build knows (it knows ${[...KNOWN_ENV].join(", ")})`);
  }
  const provider = env[`${SECRET_ENV_PREFIX}PROVIDER`]?.trim();
  if (isSecretProviderKind(provider) && !env.FORTRESS_SECRETS_PROVIDER?.trim()) {
    throw invalid(`${SECRET_ENV_PREFIX}PROVIDER holds a provider name. The setting is ${PROVIDER_ENV}`);
  }
  const dir = env[`${SECRET_ENV_PREFIX}DIR`]?.trim();
  if (dir && path.isAbsolute(dir) && !env.FORTRESS_SECRETS_DIR?.trim()) {
    throw invalid(`${SECRET_ENV_PREFIX}DIR holds a directory path. The setting is FORTRESS_SECRETS_DIR`);
  }
}

export function resolveSecretsConfig(args: ResolveSecretsConfigArgs): SecretsConfig {
  const block = readBlock(args.config);
  refuseMistypedSettings(args.env);
  const envProvider = args.env.FORTRESS_SECRETS_PROVIDER?.trim() || undefined;

  const provider = envProvider ?? block.provider ?? "env";
  if (!isSecretProviderKind(provider)) {
    // The value is not repeated: a line pasted into the wrong setting can be
    // a credential. Saying where it is set is enough to find it.
    const where = envProvider ? PROVIDER_ENV : "secrets.provider in config.json";
    throw invalid(`${where} must be one of ${SECRET_PROVIDER_KINDS.join(", ")}`);
  }

  /**
   * One setting of the provider in use: its value and where it was set. A
   * setting of another provider is refused. It is half a choice: whoever wrote
   * it meant that provider, and this one would look somewhere else.
   *
   * One case is not a mistake: the environment picks another provider over a
   * block that is complete for its own.
   */
  const setting = (key: ProviderSettingKey): { value: string; where: string } | null => {
    // `key` is one of the literal keys of PROVIDER_SETTINGS.
    // eslint-disable-next-line security/detect-object-injection
    const owner = PROVIDER_SETTINGS[key];
    const fromEnv = args.env[owner.env]?.trim() || undefined;
    // eslint-disable-next-line security/detect-object-injection
    const fromBlock = block[key];
    if (owner.provider !== provider) {
      if (fromEnv) {
        throw invalid(
          `${owner.env} is set, but the provider is ${provider}. It is a setting of the ` +
            `${owner.provider} provider: set ${PROVIDER_ENV}=${owner.provider}, or remove it`,
        );
      }
      if (fromBlock && block.provider !== owner.provider) {
        throw invalid(
          block.provider === undefined
            ? `secrets.${key} is set in config.json with no secrets.provider. It is a setting of the ` +
                `${owner.provider} provider: add "provider": "${owner.provider}"`
            : `secrets.${key} is set in config.json, but secrets.provider is ${block.provider}. ` +
                `It is a setting of the ${owner.provider} provider`,
        );
      }
      return null;
    }
    if (fromEnv) return { value: fromEnv, where: owner.env };
    if (fromBlock) return { value: fromBlock, where: `secrets.${key} in config.json` };
    return null;
  };
  // Every setting is looked at, so one that belongs to another provider is
  // refused whichever provider is in use.
  const dir = setting("dir");
  const vaultUrl = setting("vaultUrl");
  const clientId = setting("clientId");
  const cacheSeconds = setting("cacheSeconds");

  switch (provider) {
    case "env":
      return { provider: "env" };
    case "file": {
      if (dir && !path.isAbsolute(dir.value)) throw invalid(`${dir.where} must be an absolute path`);
      // The default follows the root, which may itself be given as a relative
      // path.
      return { provider: "file", dir: dir?.value ?? path.resolve(args.root, "secrets") };
    }
    case "azure-key-vault": {
      if (!vaultUrl) {
        throw invalid(
          "the azure-key-vault provider needs the vault's address: set " +
            `${PROVIDER_SETTINGS.vaultUrl.env}, or secrets.vaultUrl in config.json`,
        );
      }
      let vault: KeyVaultTarget;
      try {
        vault = parseKeyVaultUrl(vaultUrl.value);
      } catch (error) {
        // The parser's messages name the rule that was broken and never repeat
        // what was written.
        throw invalid(`${vaultUrl.where}: ${error instanceof Error ? error.message : "it is not usable"}`);
      }
      if (clientId && !MANAGED_IDENTITY_CLIENT_ID.test(clientId.value)) {
        throw invalid(`${clientId.where} must be the client id (a GUID) of a user-assigned managed identity`);
      }
      let cacheTtlMs: number | undefined;
      if (cacheSeconds) {
        const seconds = Number(cacheSeconds.value);
        const most = MAX_SECRET_CACHE_TTL_MS / 1000;
        if (!/^\d{1,6}$/.test(cacheSeconds.value) || seconds > most) {
          throw invalid(`${cacheSeconds.where} must be a whole number of seconds from 0 to ${most}`);
        }
        cacheTtlMs = seconds * 1000;
      }
      return {
        provider: "azure-key-vault",
        vault,
        ...(clientId ? { clientId: clientId.value.toLowerCase() } : {}),
        ...(cacheTtlMs !== undefined ? { cacheTtlMs } : {}),
      };
    }
  }
}

export function createSecretProvider(
  config: SecretsConfig,
  deps: { env?: Record<string, string | undefined> } = {},
): SecretProvider {
  switch (config.provider) {
    case "env":
      return new EnvSecretProvider(deps.env);
    case "file":
      return new FileSecretProvider(config.dir);
    case "azure-key-vault": {
      let identity;
      try {
        // Reads IDENTITY_ENDPOINT and IDENTITY_HEADER, which Azure sets. No
        // request is made until a secret is asked for.
        identity = resolveManagedIdentity(deps.env ?? process.env, config.clientId);
      } catch (error) {
        throw invalid(error instanceof Error ? error.message : "the managed identity could not be resolved");
      }
      // The token request must not go through a proxy named in the
      // environment. In a running fortress `deps.env` is the process's own
      // environment, which is where the runtime looks when it makes a request.
      keepOffProxy(deps.env ?? process.env, identity);
      return new AzureKeyVaultSecretProvider({
        vault: config.vault,
        identity,
        ...(config.cacheTtlMs !== undefined ? { cacheTtlMs: config.cacheTtlMs } : {}),
      });
    }
    default:
      // Unreachable through the types. Reached by a config built by hand, and
      // returning nothing there would fail later and far from the cause.
      throw invalid("no provider can be built for this config");
  }
}

/** What a status line or a log may say about the choice. It names where the
 *  secrets are, and never anything read from there. */
export function describeSecretsConfig(config: SecretsConfig): string {
  switch (config.provider) {
    case "env":
      return `env (${SECRET_ENV_PREFIX}* variables)`;
    case "file":
      return `file (${config.dir})`;
    case "azure-key-vault":
      return `azure-key-vault (${config.vault.origin})`;
    default:
      return "unknown";
  }
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
 * Check the secret settings when a process starts, before any secret is needed.
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
): Promise<void> {
  let config: unknown = null;
  try {
    // The fortress's own config.json, never a path a caller supplies.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const parsed: unknown = JSON.parse(await readFile(paths.config, "utf8"));
    if (isRecord(parsed)) config = parsed;
  } catch {
    config = null;
  }
  createSecretProvider(resolveSecretsConfig({ env, config, root: paths.root }), { env });
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
