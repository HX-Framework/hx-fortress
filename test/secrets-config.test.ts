import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createSecretProvider,
  describeSecretsConfig,
  lazySecretProvider,
  loadSecretProvider,
  loadSecretsConfig,
  resolveSecretsConfig,
  type SecretsConfig,
} from "../src/secrets";
import { fortressPaths } from "../src/host/paths";
import {
  ensureCoreModulesEnabled,
  ensureEnrollmentConfig,
  ensureGatewayPublicUrlConfigured,
} from "../src/host/config";

const ROOT = "/var/lib/fortress";

const resolve = (env: Record<string, string | undefined>, config: unknown = null): SecretsConfig =>
  resolveSecretsConfig({ env, config, root: ROOT });

describe("which secret provider a fortress uses", () => {
  test("with nothing configured it is env", () => {
    expect(resolve({})).toEqual({ provider: "env" });
    expect(resolve({}, { schemaVersion: 1 })).toEqual({ provider: "env" });
    expect(resolve({ FORTRESS_SECRETS_PROVIDER: "  " }, {})).toEqual({ provider: "env" });
    expect(resolve({}, { secrets: {} })).toEqual({ provider: "env" });
  });

  test("the secrets block of config.json picks the provider", () => {
    expect(resolve({}, { secrets: { provider: "file" } })).toEqual({
      provider: "file",
      dir: path.join(ROOT, "secrets"),
    });
    expect(resolve({}, { secrets: { provider: "file", dir: "/run/secrets" } })).toEqual({
      provider: "file",
      dir: "/run/secrets",
    });
  });

  test("the environment wins over config.json, setting by setting", () => {
    const config = { secrets: { provider: "file", dir: "/run/secrets" } };
    expect(resolve({ FORTRESS_SECRETS_PROVIDER: "env" }, config)).toEqual({ provider: "env" });
    expect(resolve({ FORTRESS_SECRETS_DIR: "/mnt/keys" }, config)).toEqual({
      provider: "file",
      dir: "/mnt/keys",
    });
    expect(resolve({ FORTRESS_SECRETS_PROVIDER: "file" }, { secrets: { provider: "env" } })).toEqual({
      provider: "file",
      dir: path.join(ROOT, "secrets"),
    });
  });

  test("the default directory follows the root, also when the root is a relative path", () => {
    expect(
      resolveSecretsConfig({ env: { FORTRESS_SECRETS_PROVIDER: "file" }, config: null, root: "dev-root" }),
    ).toEqual({ provider: "file", dir: path.resolve("dev-root", "secrets") });
  });

  test("a provider this build does not know is refused, and the value is not repeated", () => {
    expect(() => resolve({ FORTRESS_SECRETS_PROVIDER: "vault" })).toThrow(
      "Invalid secrets config: FORTRESS_SECRETS_PROVIDER must be one of env, file, azure-key-vault",
    );
    expect(() => resolve({}, { secrets: { provider: "ENV" } })).toThrow(
      "Invalid secrets config: secrets.provider in config.json must be one of env, file, azure-key-vault",
    );
    // A line pasted into the wrong setting can be a credential.
    for (const pasted of ["postgresql://someone:a-password@db.example.com/app", "0123456789abcdef0123456789abcdef"]) {
      let message = "";
      try {
        resolve({ FORTRESS_SECRETS_PROVIDER: pasted });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("FORTRESS_SECRETS_PROVIDER must be one of");
      expect(message).not.toContain(pasted);
    }
  });

  test("azure-key-vault is a known kind that this build cannot use yet", () => {
    expect(() => resolve({ FORTRESS_SECRETS_PROVIDER: "azure-key-vault" })).toThrow(
      "Invalid secrets config: the azure-key-vault provider is not part of this build",
    );
  });

  test("a malformed secrets block is refused", () => {
    for (const secrets of ["file", 7, ["file"], null]) {
      expect(() => resolve({}, { secrets })).toThrow("Invalid secrets config: secrets must be an object");
    }
    expect(() => resolve({}, { secrets: { provider: 7 } })).toThrow(
      "Invalid secrets config: secrets.provider must be a string",
    );
    expect(() => resolve({}, { secrets: { provider: "file", dir: 7 } })).toThrow(
      "Invalid secrets config: secrets.dir must be a string",
    );
    for (const config of [[], "file", 7, true]) {
      expect(() => resolve({}, config)).toThrow("Invalid secrets config: config.json must hold a JSON object");
    }
  });

  test("the block is checked even when the environment overrides it", () => {
    expect(() => resolve({ FORTRESS_SECRETS_PROVIDER: "env" }, { secrets: { provider: 7 } })).toThrow(
      "secrets.provider must be a string",
    );
    expect(() =>
      resolve({ FORTRESS_SECRETS_DIR: "/mnt/keys" }, { secrets: { provider: "file", dir: 7 } }),
    ).toThrow("secrets.dir must be a string");
  });

  test("a key the block does not have is refused, so a misspelt one is not ignored", () => {
    expect(() => resolve({}, { secrets: { providr: "file", dir: "/run/secrets" } })).toThrow(
      "Invalid secrets config: secrets.providr is not a setting this build knows (it knows provider, dir)",
    );
    expect(() => resolve({}, { secrets: { provider: "file", directory: "/run/secrets" } })).toThrow(
      "secrets.directory is not a setting this build knows",
    );
    expect(() => resolve({}, { secrets: { "a key with spaces": 1 } })).toThrow(
      "a key in secrets is not a setting this build knows",
    );
  });

  test("a directory with no provider that reads it is refused", () => {
    expect(() => resolve({ FORTRESS_SECRETS_DIR: "/run/secrets" })).toThrow(
      "FORTRESS_SECRETS_DIR is set, but the provider is env",
    );
    expect(() => resolve({}, { secrets: { dir: "/run/secrets" } })).toThrow(
      "secrets.dir is set in config.json with no secrets.provider",
    );
    // The environment choosing env over a complete block is a choice, not a mistake.
    expect(
      resolve({ FORTRESS_SECRETS_PROVIDER: "env" }, { secrets: { provider: "file", dir: "/run/secrets" } }),
    ).toEqual({ provider: "env" });
  });

  test("a setting written one letter short is refused instead of read as a secret", () => {
    expect(() => resolve({ FORTRESS_SECRET_PROVIDER: "file" })).toThrow(
      "FORTRESS_SECRET_PROVIDER holds a provider name. The setting is FORTRESS_SECRETS_PROVIDER",
    );
    expect(() => resolve({ FORTRESS_SECRET_DIR: "/run/secrets" })).toThrow(
      "FORTRESS_SECRET_DIR holds a directory path. The setting is FORTRESS_SECRETS_DIR",
    );
    // A secret that really is named `provider` or `dir` is left alone.
    expect(resolve({ FORTRESS_SECRET_PROVIDER: "some other text", FORTRESS_SECRET_DIR: "not a path" })).toEqual({
      provider: "env",
    });
    expect(
      resolve({ FORTRESS_SECRET_PROVIDER: "file", FORTRESS_SECRETS_PROVIDER: "env" }),
    ).toEqual({ provider: "env" });
  });

  test("the file provider's directory must be absolute, and the refusal says where it was set", () => {
    expect(() =>
      resolve({ FORTRESS_SECRETS_PROVIDER: "file", FORTRESS_SECRETS_DIR: "secrets" }),
    ).toThrow("Invalid secrets config: FORTRESS_SECRETS_DIR must be an absolute path");
    expect(() => resolve({}, { secrets: { provider: "file", dir: "secrets" } })).toThrow(
      "Invalid secrets config: secrets.dir in config.json must be an absolute path",
    );
  });

  test("the description names where the secrets are and nothing read from there", () => {
    expect(describeSecretsConfig({ provider: "env" })).toBe("env (FORTRESS_SECRET_* variables)");
    expect(describeSecretsConfig({ provider: "file", dir: "/run/secrets" })).toBe("file (/run/secrets)");
  });

  test("the provider is built with the kind that was resolved", () => {
    expect(createSecretProvider({ provider: "env" }, { env: {} }).kind).toBe("env");
    expect(createSecretProvider({ provider: "file", dir: "/run/secrets" }).kind).toBe("file");
    // A config built by hand with a kind this build cannot construct.
    expect(() => createSecretProvider({ provider: "azure-key-vault" } as unknown as SecretsConfig)).toThrow(
      "Invalid secrets config: no provider can be built for this config",
    );
  });
});

describe("loading the provider from a fortress root", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "hx-fortress-secrets-config-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const validConfig = (secrets: unknown): string =>
    JSON.stringify({
      schemaVersion: 1,
      cloud: { url: "wss://hub.example.com/tunnel" },
      modules: { enabled: [] },
      secrets,
    });

  test("no config.json yet means env", async () => {
    const paths = fortressPaths(root);
    const provider = await loadSecretProvider(paths, { FORTRESS_SECRET_DB_URL: "from the environment" });
    expect(provider.kind).toBe("env");
    expect(await provider.get("db-url")).toBe("from the environment");
  });

  test("config.json's secrets block decides where a secret is read from", async () => {
    const paths = fortressPaths(root);
    const dir = path.join(root, "keys");
    await mkdir(dir);
    await writeFile(path.join(dir, "db-url"), "from the directory\n");
    await writeFile(paths.config, validConfig({ provider: "file", dir }));

    expect(await loadSecretsConfig(paths, {})).toEqual({ provider: "file", dir });
    const provider = await loadSecretProvider(paths, { FORTRESS_SECRET_DB_URL: "from the environment" });
    expect(provider.kind).toBe("file");
    expect(await provider.get("db-url")).toBe("from the directory");
  });

  test("a config.json that is not a JSON object is refused", async () => {
    const paths = fortressPaths(root);
    await writeFile(paths.config, "{ not json");
    await expect(loadSecretProvider(paths, {})).rejects.toThrow(
      "Invalid secrets config: config.json is not valid JSON",
    );
    for (const body of ["null", "[]", '"file"', "7"]) {
      await writeFile(paths.config, body);
      await expect(loadSecretProvider(paths, {})).rejects.toThrow(
        "Invalid secrets config: config.json must hold a JSON object",
      );
    }
  });

  test("the block survives the host's boot rewrites of a config.json the host accepts", async () => {
    const paths = fortressPaths(root);
    await writeFile(paths.config, validConfig({ provider: "file", dir: "/run/secrets" }));
    await ensureEnrollmentConfig(paths, "wss://hub.example.com/tunnel");
    await ensureGatewayPublicUrlConfigured(paths);
    await ensureCoreModulesEnabled(paths);
    expect(await loadSecretsConfig(paths, {})).toEqual({ provider: "file", dir: "/run/secrets" });
  });

  test("a shared provider is built on the first call, and every call gets the same one", async () => {
    const paths = fortressPaths(root);
    // Not valid yet. Making the function reads nothing, so this is not an error.
    await writeFile(paths.config, "{ not json");
    const secrets = lazySecretProvider(paths, {});

    const dir = path.join(root, "keys");
    await mkdir(dir);
    await writeFile(path.join(dir, "db-url"), "from the directory\n");
    await writeFile(paths.config, validConfig({ provider: "file", dir }));

    const [first, second] = await Promise.all([secrets(), secrets()]);
    expect(first).toBe(second);
    expect(await secrets()).toBe(first);
    expect(await first.get("db-url")).toBe("from the directory");

    // The choice was made at the first call. A later edit to config.json does
    // not swap the provider under the code that holds it.
    await writeFile(paths.config, validConfig({ provider: "env" }));
    expect((await secrets()).kind).toBe("file");
  });

  test("a shared provider that could not be built is built again on the next call", async () => {
    const paths = fortressPaths(root);
    await writeFile(paths.config, validConfig({ provider: "no-such-provider" }));
    const secrets = lazySecretProvider(paths, {});
    await expect(secrets()).rejects.toThrow("Invalid secrets config: secrets.provider in config.json must be one of");
    await expect(secrets()).rejects.toThrow("Invalid secrets config:");

    await writeFile(paths.config, validConfig({ provider: "env" }));
    expect((await secrets()).kind).toBe("env");
  });
});
