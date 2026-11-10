// Which secret provider this fortress uses, and how one is built.
//
// The choice is a setting like any other. It is read from the environment
// first and from the `secrets` block of config.json second, and with neither
// it is `env`:
//
//   FORTRESS_SECRETS_PROVIDER   env | file
//   FORTRESS_SECRETS_DIR        the directory the `file` provider reads
//
//   config.json:  "secrets": { "provider": "file", "dir": "/run/secrets" }
//
// A service unit carries no environment of its own, so a host install sets the
// block in config.json. A container sets the variables.
//
// Anything this build does not understand is refused by name: an unknown
// provider, an unknown key in the block, a directory given with no provider
// that reads one. Falling back to `env` instead would make a fortress that was
// configured for one store read its secrets from another without saying so.
//
// One limit to know: the host rewrites config.json when it enrolls, and it
// keeps the `secrets` block only when the rest of the file is a config it
// accepts. Add the block to a fortress that has already enrolled.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { EnvSecretProvider, SECRET_ENV_PREFIX } from "./env";
import { FileSecretProvider } from "./file";
import { isSecretProviderKind, SECRET_PROVIDER_KINDS, type SecretProvider } from "./types";

export type SecretsConfig = { provider: "env" } | { provider: "file"; dir: string };

/** The keys the `secrets` block of config.json may hold. */
const BLOCK_KEYS = ["provider", "dir"] as const;
type BlockKey = (typeof BLOCK_KEYS)[number];

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
 *  overrides it. A key this build does not know and a value that is not a
 *  string are mistakes to report, never things to skip. */
function readBlock(config: unknown): Partial<Record<BlockKey, string>> {
  if (config === null || config === undefined) return {};
  if (!isRecord(config)) throw invalid("config.json must hold a JSON object");
  if (config.secrets === undefined) return {};
  if (!isRecord(config.secrets)) throw invalid("secrets must be an object");

  const block: Partial<Record<BlockKey, string>> = {};
  for (const [key, value] of Object.entries(config.secrets)) {
    if (!(BLOCK_KEYS as readonly string[]).includes(key)) {
      // A key is repeated only when it looks like a key. Whatever else was
      // written there stays out of the message.
      const shown = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(key) ? `secrets.${key}` : "a key in secrets";
      throw invalid(`${shown} is not a setting this build knows (it knows ${BLOCK_KEYS.join(", ")})`);
    }
    if (typeof value !== "string") throw invalid(`secrets.${key} must be a string`);
    const trimmed = value.trim();
    if (trimmed) block[key as BlockKey] = trimmed;
  }
  return block;
}

/**
 * FORTRESS_SECRET_PROVIDER and FORTRESS_SECRET_DIR are one letter away from
 * the two settings, and both are also valid variables for secrets named
 * `provider` and `dir`. A provider name or a directory path in one of them is
 * the setting, mistyped, and it would otherwise be ignored without a word.
 */
function refuseMistypedSettings(env: Record<string, string | undefined>): void {
  const provider = env[`${SECRET_ENV_PREFIX}PROVIDER`]?.trim();
  if (isSecretProviderKind(provider) && !env.FORTRESS_SECRETS_PROVIDER?.trim()) {
    throw invalid(
      `${SECRET_ENV_PREFIX}PROVIDER holds a provider name. The setting is FORTRESS_SECRETS_PROVIDER`,
    );
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
  const envDir = args.env.FORTRESS_SECRETS_DIR?.trim() || undefined;

  const provider = envProvider ?? block.provider ?? "env";
  if (!isSecretProviderKind(provider)) {
    // The value is not repeated: a line pasted into the wrong setting can be
    // a credential. Saying where it is set is enough to find it.
    const where = envProvider ? "FORTRESS_SECRETS_PROVIDER" : "secrets.provider in config.json";
    throw invalid(`${where} must be one of ${SECRET_PROVIDER_KINDS.join(", ")}`);
  }

  switch (provider) {
    case "env":
      // A directory with nothing that reads it is half a choice. The reader
      // meant `file`, and `env` would look in a different place.
      if (envDir) {
        throw invalid(
          "FORTRESS_SECRETS_DIR is set, but the provider is env. " +
            "Set FORTRESS_SECRETS_PROVIDER=file to read secrets from that directory",
        );
      }
      if (block.dir && !block.provider) {
        throw invalid(
          'secrets.dir is set in config.json with no secrets.provider. Add "provider": "file" ' +
            "to read secrets from that directory",
        );
      }
      return { provider: "env" };
    case "file": {
      const configured = envDir ?? block.dir;
      if (configured !== undefined && !path.isAbsolute(configured)) {
        const where = envDir ? "FORTRESS_SECRETS_DIR" : "secrets.dir in config.json";
        throw invalid(`${where} must be an absolute path`);
      }
      // The default follows the root, which may itself be given as a relative
      // path.
      return { provider: "file", dir: configured ?? path.resolve(args.root, "secrets") };
    }
    case "azure-key-vault":
      throw invalid("the azure-key-vault provider is not part of this build");
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
