import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AzureKeyVaultSecretProvider,
  createSecretProvider,
  describeSecretsConfig,
  lazySecretProvider,
  loadSecretProvider,
  loadSecretsConfig,
  resolveSecretsConfig,
  type SecretsConfig,
} from "../src/secrets";
import { fortressPaths } from "../src/host/paths";
import { randomLabel, routeHostToFake, startFakeAzure } from "./rig/azure-fakes";
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

  test("a variable that looks like a secrets setting and is not one is refused", () => {
    expect(() => resolve({ FORTRESS_SECRETS_DIRECTORY: "/run/secrets" })).toThrow(
      "Invalid secrets config: FORTRESS_SECRETS_DIRECTORY is not a setting this build knows",
    );
    expect(() => resolve({ FORTRESS_KEY_VAULT_URI: "https://contoso-kv.vault.azure.net" })).toThrow(
      "Invalid secrets config: FORTRESS_KEY_VAULT_URI is not a setting this build knows",
    );
    // An empty one says nothing, and a secret's own variable is not a setting.
    expect(resolve({ FORTRESS_SECRETS_DIRECTORY: " ", FORTRESS_SECRET_S_KEY: "a secret named s-key" })).toEqual({
      provider: "env",
    });
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
      "Invalid secrets config: secrets.providr is not a setting this build knows " +
        "(it knows provider, dir, vaultUrl, clientId, cacheSeconds)",
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
    expect(() => resolve({}, { secrets: { provider: "env", dir: "/run/secrets" } })).toThrow(
      "secrets.dir is set in config.json, but secrets.provider is env. It is a setting of the file provider",
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
    // A config built by hand with a kind that does not exist.
    expect(() => createSecretProvider({ provider: "something-else" } as unknown as SecretsConfig)).toThrow(
      "Invalid secrets config: no provider can be built for this config",
    );
  });
});

describe("the azure-key-vault provider's settings", () => {
  const VAULT = "https://contoso-kv.vault.azure.net";
  const TARGET = { origin: VAULT, resource: "https://vault.azure.net" };
  const CLIENT_ID = "11111111-2222-3333-4444-555555555555";

  test("the environment names the vault", () => {
    expect(
      // The address as Azure prints it, with its final "/".
      resolve({ FORTRESS_SECRETS_PROVIDER: "azure-key-vault", FORTRESS_SECRETS_AZURE_VAULT_URL: `${VAULT}/` }),
    ).toEqual({ provider: "azure-key-vault", vault: TARGET });
  });

  test("config.json names the vault, a user-assigned identity and the cache time", () => {
    expect(
      resolve(
        {},
        {
          secrets: {
            provider: "azure-key-vault",
            vaultUrl: VAULT,
            clientId: CLIENT_ID.toUpperCase(),
            cacheSeconds: 30,
          },
        },
      ),
    ).toEqual({ provider: "azure-key-vault", vault: TARGET, clientId: CLIENT_ID, cacheTtlMs: 30_000 });
    expect(
      resolve(
        { FORTRESS_SECRETS_CACHE_SECONDS: "0", FORTRESS_SECRETS_AZURE_CLIENT_ID: CLIENT_ID },
        { secrets: { provider: "azure-key-vault", vaultUrl: VAULT, cacheSeconds: "30" } },
      ),
    ).toEqual({ provider: "azure-key-vault", vault: TARGET, clientId: CLIENT_ID, cacheTtlMs: 0 });
  });

  test("the vault's address is required", () => {
    expect(() => resolve({ FORTRESS_SECRETS_PROVIDER: "azure-key-vault" })).toThrow(
      "Invalid secrets config: the azure-key-vault provider needs the vault's address: " +
        "set FORTRESS_SECRETS_AZURE_VAULT_URL, or secrets.vaultUrl in config.json",
    );
  });

  test("the names the two Azure settings had before are not read: each stops the start, by name", () => {
    const known = "FORTRESS_SECRETS_AZURE_VAULT_URL, FORTRESS_SECRETS_AZURE_CLIENT_ID";
    // The vault's address under its old name, with nothing under the new one.
    expect(() => resolve({ FORTRESS_SECRETS_PROVIDER: "azure-key-vault", FORTRESS_KEY_VAULT_URL: VAULT })).toThrow(
      "Invalid secrets config: FORTRESS_KEY_VAULT_URL is not a setting this build knows",
    );
    // The address renamed and the client id forgotten. Read without a word,
    // this fortress would ask for a token as another identity than the one its
    // operator chose.
    const half = {
      FORTRESS_SECRETS_PROVIDER: "azure-key-vault",
      FORTRESS_SECRETS_AZURE_VAULT_URL: VAULT,
      FORTRESS_KEY_VAULT_CLIENT_ID: CLIENT_ID,
    };
    expect(() => resolve(half)).toThrow(
      "Invalid secrets config: FORTRESS_KEY_VAULT_CLIENT_ID is not a setting this build knows",
    );
    // The refusal lists the settings there are, the two new names among them.
    expect(() => resolve(half)).toThrow(known);
    // Whichever provider is in use, and whatever else carries that prefix.
    expect(() => resolve({ FORTRESS_KEY_VAULT_URL: VAULT })).toThrow("FORTRESS_KEY_VAULT_URL is not a setting");
    expect(() => resolve({ FORTRESS_SECRETS_PROVIDER: "file", FORTRESS_KEY_VAULT_CLIENT_ID: CLIENT_ID })).toThrow(
      "FORTRESS_KEY_VAULT_CLIENT_ID is not a setting",
    );
    // A variable that is set and empty is not a setting anybody made.
    expect(resolve({ FORTRESS_KEY_VAULT_URL: "  " })).toEqual({ provider: "env" });
    // No message repeats what the variable held.
    for (const env of [half, { FORTRESS_KEY_VAULT_URL: VAULT }]) {
      try {
        resolve(env);
      } catch (error) {
        expect(String(error)).not.toContain(CLIENT_ID);
        expect(String(error)).not.toContain(VAULT);
      }
    }
  });

  test("an Azure setting written one letter short is refused, and does not pass for a secret", () => {
    // FORTRESS_SECRET_AZURE_CLIENT_ID is the variable of a secret named
    // `azure-client-id`. A client id in it is the setting, mistyped.
    const base = { FORTRESS_SECRETS_PROVIDER: "azure-key-vault", FORTRESS_SECRETS_AZURE_VAULT_URL: VAULT };
    expect(() => resolve({ ...base, FORTRESS_SECRET_AZURE_CLIENT_ID: CLIENT_ID })).toThrow(
      "Invalid secrets config: FORTRESS_SECRET_AZURE_CLIENT_ID holds a client id. " +
        "The setting is FORTRESS_SECRETS_AZURE_CLIENT_ID",
    );
    // An address meant to replace the one in config.json.
    expect(() =>
      resolve(
        { FORTRESS_SECRET_AZURE_VAULT_URL: "https://another-kv.vault.azure.net" },
        { secrets: { provider: "azure-key-vault", vaultUrl: VAULT } },
      ),
    ).toThrow(
      "Invalid secrets config: FORTRESS_SECRET_AZURE_VAULT_URL holds an address. " +
        "The setting is FORTRESS_SECRETS_AZURE_VAULT_URL",
    );
    // With the setting itself given, the short name is a secret's own variable.
    expect(
      resolve({ ...base, FORTRESS_SECRETS_AZURE_CLIENT_ID: CLIENT_ID, FORTRESS_SECRET_AZURE_CLIENT_ID: CLIENT_ID }),
    ).toMatchObject({ provider: "azure-key-vault", clientId: CLIENT_ID.toLowerCase() });
    // So is a value that has not the setting's shape.
    expect(resolve({ ...base, FORTRESS_SECRET_AZURE_CLIENT_ID: "not-a-client-id" })).toMatchObject({
      provider: "azure-key-vault",
    });
  });

  test("an address that is not a Key Vault is refused, and what was written is not repeated", () => {
    for (const [url, hidden] of [
      ["https://attacker.example.com", "attacker.example.com"],
      ["http://contoso-kv.vault.azure.net", "http://"],
      ["https://someone:a-password@contoso-kv.vault.azure.net", "a-password"],
    ] as const) {
      let message = "";
      try {
        resolve({ FORTRESS_SECRETS_PROVIDER: "azure-key-vault", FORTRESS_SECRETS_AZURE_VAULT_URL: url });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("Invalid secrets config: FORTRESS_SECRETS_AZURE_VAULT_URL: the Key Vault URL must");
      expect(message).not.toContain(hidden);
    }
    expect(() =>
      resolve({}, { secrets: { provider: "azure-key-vault", vaultUrl: "https://example.com" } }),
    ).toThrow("Invalid secrets config: secrets.vaultUrl in config.json: the Key Vault URL must");
  });

  test("a setting of another provider is refused in both directions", () => {
    expect(() => resolve({ FORTRESS_SECRETS_AZURE_VAULT_URL: VAULT })).toThrow(
      "FORTRESS_SECRETS_AZURE_VAULT_URL is set, but the provider is env. It is a setting of the azure-key-vault " +
        "provider: set FORTRESS_SECRETS_PROVIDER=azure-key-vault, or remove it",
    );
    expect(() => resolve({}, { secrets: { vaultUrl: VAULT } })).toThrow(
      "secrets.vaultUrl is set in config.json with no secrets.provider",
    );
    expect(() =>
      resolve({
        FORTRESS_SECRETS_PROVIDER: "azure-key-vault",
        FORTRESS_SECRETS_AZURE_VAULT_URL: VAULT,
        FORTRESS_SECRETS_DIR: "/run/secrets",
      }),
    ).toThrow("FORTRESS_SECRETS_DIR is set, but the provider is azure-key-vault");
    expect(() =>
      resolve({}, { secrets: { provider: "file", dir: "/run/secrets", cacheSeconds: 30 } }),
    ).toThrow("secrets.cacheSeconds is set in config.json, but secrets.provider is file");
  });

  test("a client id that is not a GUID and a cache time out of range are refused", () => {
    const base = { FORTRESS_SECRETS_PROVIDER: "azure-key-vault", FORTRESS_SECRETS_AZURE_VAULT_URL: VAULT };
    expect(() => resolve({ ...base, FORTRESS_SECRETS_AZURE_CLIENT_ID: "the-fortress-identity" })).toThrow(
      "FORTRESS_SECRETS_AZURE_CLIENT_ID must be the client id (a GUID) of a user-assigned managed identity",
    );
    for (const seconds of ["901", "-1", "1.5", "a minute", "1e2"]) {
      expect(() => resolve({ ...base, FORTRESS_SECRETS_CACHE_SECONDS: seconds })).toThrow(
        "FORTRESS_SECRETS_CACHE_SECONDS must be a whole number of seconds from 0 to 900",
      );
    }
    expect(resolve({ ...base, FORTRESS_SECRETS_CACHE_SECONDS: "900" })).toMatchObject({ cacheTtlMs: 900_000 });
    expect(() =>
      resolve({}, { secrets: { provider: "azure-key-vault", vaultUrl: VAULT, cacheSeconds: 1.5 } }),
    ).toThrow("secrets.cacheSeconds in config.json must be a whole number of seconds from 0 to 900");
  });

  test("the description names the vault", () => {
    expect(describeSecretsConfig({ provider: "azure-key-vault", vault: TARGET })).toBe(
      `azure-key-vault (${VAULT})`,
    );
  });

  test("a host that published half a managed identity endpoint is refused when the provider is built", () => {
    expect(() =>
      createSecretProvider(
        { provider: "azure-key-vault", vault: TARGET },
        { env: { IDENTITY_ENDPOINT: "http://localhost:42356/msi/token" } },
      ),
    ).toThrow("Invalid secrets config: IDENTITY_ENDPOINT and IDENTITY_HEADER must both be set");
  });

  test("the provider built from these settings reads a secret through the fakes", async () => {
    const azure = startFakeAzure({ now: Date.now() });
    // The settings name a real-looking vault address. Requests for it are
    // sent to the fake vault.
    const unroute = routeHostToFake("contoso-kv.vault.azure.net", azure.vault);
    try {
      const value = randomLabel("value");
      azure.secrets.set("db-url", `${value}\n`);
      const env = {
        FORTRESS_SECRETS_PROVIDER: "azure-key-vault",
        FORTRESS_SECRETS_AZURE_VAULT_URL: VAULT,
        IDENTITY_ENDPOINT: `${azure.identity.origin}/msi/token`,
        IDENTITY_HEADER: azure.identityHeader,
      };
      const provider = createSecretProvider(resolve(env), { env });
      expect(provider.kind).toBe("azure-key-vault");
      expect(await provider.get("db-url")).toBe(value);
      expect(await provider.has("not-in-the-vault")).toBe(false);
      expect(azure.identity.requests).toHaveLength(1);
      expect(azure.identity.requests[0]?.query.get("resource")).toBe("https://vault.azure.net");
      expect(azure.vault.requests.map((r) => r.path)).toEqual(["/secrets/db-url", "/secrets/not-in-the-vault"]);
      (provider as AzureKeyVaultSecretProvider).forget();
    } finally {
      unroute();
      await azure.stop();
    }
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
