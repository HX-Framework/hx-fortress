import { describe, expect, test } from "bun:test";

import {
  EnvSecretProvider,
  SecretMissing,
  SecretUnavailable,
  type SecretProvider,
} from "../src/secrets";
import {
  assertDatabaseUrlSecret,
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
  });

  test("the variable set and empty is refused, never read as not set", () => {
    // A template that was not filled in. Read as "not set", the fortress would
    // start on the embedded Postgres in place of the database it was given.
    for (const empty of ["", "  "]) {
      expect(() =>
        secretNameForSetting({ FORTRESS_DATABASE_URL_SECRET: empty }, "FORTRESS_DATABASE_URL"),
      ).toThrow("FORTRESS_DATABASE_URL_SECRET is set and empty. Give it the name of the secret, or remove it");
    }
  });

  test("a variable that only looks like the setting is refused by name", () => {
    for (const lookalike of [
      "FORTRESS_DATABASE_URL_SECRET_NAME",
      "FORTRESS_DATABASE_URL_SECRETS",
      "fortress_database_url_secret",
    ]) {
      expect(() =>
        secretNameForSetting({ [lookalike]: "fortress-database-url" }, "FORTRESS_DATABASE_URL"),
      ).toThrow(`${lookalike} is not a setting. The name of the secret goes in FORTRESS_DATABASE_URL_SECRET`);
    }
    // One that is set and empty is nobody's mistake.
    expect(
      secretNameForSetting({ FORTRESS_DATABASE_URL_SECRET_NAME: "" }, "FORTRESS_DATABASE_URL"),
    ).toBeNull();
    // Another setting's variables are not this one's look-alikes.
    expect(
      secretNameForSetting({ FORTRESS_DATABASE_URL_RO: "postgresql://db.example.com/app" }, "FORTRESS_DATABASE_URL"),
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

  test("a secret that is not a postgres:// URL stops the start, and its value is not repeated", async () => {
    const marker = "Zq7-the-password-inside-the-secret";
    for (const value of [
      `host=db.internal port=5432 dbname=hx user=fortress password=${marker} sslmode=require`,
      `{"host":"db.internal","user":"fortress","password":"${marker}"}`,
      `Server=db.internal;Password=${marker};`,
      marker,
      `mysql://fortress:${marker}@db.internal/hx`,
      `postgresql://fortress:%zz${marker}@db.internal/hx`,
    ]) {
      let message = "";
      try {
        await resolveDatabaseUrlSetting({
          env: { FORTRESS_DATABASE_URL_SECRET: "fortress-database-url" },
          provider: () => new EnvSecretProvider({ FORTRESS_SECRET_FORTRESS_DATABASE_URL: value }),
        });
      } catch (error) {
        expect(error).toBeInstanceOf(SecretUnavailable);
        expect((error as SecretUnavailable).transient).toBe(false);
        message = `${(error as Error).message} ${JSON.stringify(error)} ${Bun.inspect(error)}`;
      }
      expect(message).toContain('secret "fortress-database-url" could not be read');
      expect(message).not.toContain(marker);
    }
  });

  test("both spellings of the scheme are a database URL", () => {
    for (const url of ["postgres://u:p@db.example.com/app", "postgresql://u:p%40x@db.example.com:5432/app?sslmode=require"]) {
      expect(() => assertDatabaseUrlSecret("fortress-database-url", url)).not.toThrow();
    }
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
