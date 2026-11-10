import { describe, expect, test } from "bun:test";

import {
  EnvSecretProvider,
  SecretMissing,
  SecretUnavailable,
  type SecretProvider,
} from "../src/secrets";
import {
  readSecretAtStart,
  resolveDatabaseUrlSetting,
  secretNameForSetting,
} from "../src/secrets/settings";

describe("a setting given as the name of a secret", () => {
  test("FORTRESS_DATABASE_URL_SECRET names the secret", () => {
    expect(secretNameForSetting({}, "FORTRESS_DATABASE_URL")).toBeNull();
    expect(
      secretNameForSetting({ FORTRESS_DATABASE_URL: "postgresql://db.example.com/app" }, "FORTRESS_DATABASE_URL"),
    ).toBeNull();
    expect(
      secretNameForSetting({ FORTRESS_DATABASE_URL_SECRET: " fortress-database-url " }, "FORTRESS_DATABASE_URL"),
    ).toBe("fortress-database-url");
    expect(
      secretNameForSetting({ FORTRESS_DATABASE_URL_SECRET: "  " }, "FORTRESS_DATABASE_URL"),
    ).toBeNull();
  });

  test("giving the value and the name together is refused", () => {
    expect(() =>
      secretNameForSetting(
        {
          FORTRESS_DATABASE_URL: "postgresql://db.example.com/app",
          FORTRESS_DATABASE_URL_SECRET: "fortress-database-url",
        },
        "FORTRESS_DATABASE_URL",
      ),
    ).toThrow("FORTRESS_DATABASE_URL and FORTRESS_DATABASE_URL_SECRET are both set. Set one of them");
  });

  test("a value put where a name belongs is refused and not repeated", () => {
    const pasted = "postgresql://someone:a-password@db.example.com/app";
    let message = "";
    try {
      secretNameForSetting({ FORTRESS_DATABASE_URL_SECRET: pasted }, "FORTRESS_DATABASE_URL");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("FORTRESS_DATABASE_URL_SECRET must be the name of a secret");
    expect(message).not.toContain("a-password");
  });
});

/** A provider that fails a set number of times before it answers. */
function flaky(failures: unknown[], value = "the value"): SecretProvider & { calls: number } {
  const provider = {
    kind: "azure-key-vault" as const,
    calls: 0,
    async get(): Promise<string> {
      provider.calls += 1;
      const failure = failures.shift();
      if (failure) throw failure;
      return value;
    },
    async has(): Promise<boolean> {
      return true;
    },
  };
  return provider;
}

describe("reading a secret the process cannot start without", () => {
  test("a store that cannot answer yet is asked again", async () => {
    const provider = flaky([
      new SecretUnavailable("db-url", "the vault refused the request (403 ForbiddenByRbac)", {
        transient: true,
      }),
      new SecretUnavailable("db-url", "the vault did not answer (timed out)", { transient: true }),
    ]);
    const waits: number[] = [];
    const retries: string[] = [];
    const value = await readSecretAtStart(provider, "db-url", {
      delayMs: 10_000,
      sleep: async (ms) => {
        waits.push(ms);
      },
      onRetry: (info) => retries.push(`${info.attempt}/${info.attempts} ${info.reason}`),
    });
    expect(value).toBe("the value");
    expect(provider.calls).toBe(3);
    expect(waits).toEqual([10_000, 10_000]);
    expect(retries).toEqual([
      "1/6 the vault refused the request (403 ForbiddenByRbac)",
      "2/6 the vault did not answer (timed out)",
    ]);
  });

  test("it gives up after the last attempt with the store's own reason", async () => {
    const failure = (): SecretUnavailable =>
      new SecretUnavailable("db-url", "the vault answered 503", { transient: true });
    const provider = flaky([failure(), failure(), failure()]);
    await expect(
      readSecretAtStart(provider, "db-url", { attempts: 3, sleep: async () => {} }),
    ).rejects.toThrow('secret "db-url" could not be read: the vault answered 503');
    expect(provider.calls).toBe(3);
  });

  test("a missing secret, and a failure that waiting cannot change, are not asked for again", async () => {
    for (const failure of [
      new SecretMissing("db-url"),
      new SecretUnavailable("db-url", "the file is not UTF-8 text"),
    ]) {
      const provider = flaky([failure]);
      const waits: number[] = [];
      await expect(
        readSecretAtStart(provider, "db-url", {
          sleep: async (ms) => {
            waits.push(ms);
          },
        }),
      ).rejects.toBe(failure);
      expect(provider.calls).toBe(1);
      expect(waits).toEqual([]);
    }
  });
});

describe("the database URL given by secret name", () => {
  test("without the setting nothing is read and the environment is passed through", async () => {
    const env = { FORTRESS_DATABASE_URL: "postgresql://db.example.com/app" };
    let built = 0;
    const setting = await resolveDatabaseUrlSetting({
      env,
      provider: () => {
        built += 1;
        return new EnvSecretProvider({});
      },
    });
    expect(setting).toEqual({ env, secretName: null });
    expect(setting.env).toBe(env);
    expect(built).toBe(0);
  });

  test("with the setting the URL is read from the provider into a copy of the environment", async () => {
    const env: Record<string, string | undefined> = {
      FORTRESS_DATABASE_URL_SECRET: "fortress-database-url",
      OTHER: "kept",
    };
    const setting = await resolveDatabaseUrlSetting({
      env,
      provider: () =>
        new EnvSecretProvider({ FORTRESS_SECRET_FORTRESS_DATABASE_URL: "postgresql://db.example.com/app\n" }),
    });
    expect(setting.secretName).toBe("fortress-database-url");
    expect(setting.env.FORTRESS_DATABASE_URL).toBe("postgresql://db.example.com/app");
    expect(setting.env.OTHER).toBe("kept");
    // The environment that was passed in does not gain the value.
    expect(env.FORTRESS_DATABASE_URL).toBeUndefined();
  });

  test("a secret that is not there stops the start with its name", async () => {
    await expect(
      resolveDatabaseUrlSetting({
        env: { FORTRESS_DATABASE_URL_SECRET: "fortress-database-url" },
        provider: () => new EnvSecretProvider({}),
      }),
    ).rejects.toThrow('secret "fortress-database-url" is not set');
  });
});
