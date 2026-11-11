// One set of tests that every secret provider passes.
//
// A provider is listed in src/secrets/providers.ts. Each listed provider has a
// rig below that puts values into its store, and every test in this file runs
// once per rig. A provider that is listed without a rig fails the first test.
//
// What is tested here is the contract in src/secrets/types.ts: what `get` and
// `has` return and throw, and that a value goes to the caller and nowhere else.
// What only one provider does (its own settings, its own failures) is tested in
// that provider's own file.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  EnvSecretProvider,
  FileSecretProvider,
  isSecretProviderKindName,
  MAX_SECRET_BYTES,
  SECRET_PROVIDER_KINDS,
  secretEnvName,
  secretErrorForLog,
  SecretMissing,
  SecretNameInvalid,
  SecretUnavailable,
  type SecretProvider,
} from "../src/secrets";
import { AzureKeyVaultSecretProvider } from "../src/secrets/azure-key-vault";
import { randomLabel, startFakeAzure } from "./rig/azure-fakes";

/** A provider over a store of this test's own, and a way to put values in it. */
interface Rig {
  provider: SecretProvider;
  /** Store `stored` under `name`, exactly as given. */
  put(name: string, stored: string): Promise<void>;
  stop(): Promise<void>;
}

const RIGS: Record<string, () => Promise<Rig>> = {
  env: async () => {
    const env: Record<string, string | undefined> = {};
    return {
      provider: new EnvSecretProvider(env),
      put: async (name, stored) => {
        // The variable's name is built from a checked secret name.
        env[secretEnvName(name)] = stored;
      },
      stop: async () => {},
    };
  },
  file: async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fortress-secrets-contract-"));
    return {
      provider: new FileSecretProvider(dir),
      put: (name, stored) => writeFile(path.join(dir, name), stored, { mode: 0o600 }),
      stop: () => rm(dir, { recursive: true, force: true }),
    };
  },
  "azure-key-vault": async () => {
    // A fake identity endpoint and a fake vault on this host. Nothing here
    // reaches Azure.
    const azure = startFakeAzure();
    return {
      provider: new AzureKeyVaultSecretProvider({
        vault: { origin: azure.vault.origin, resource: "https://vault.azure.net" },
        identity: {
          kind: "identity-endpoint",
          endpoint: `${azure.identity.origin}/msi/token`,
          header: azure.identityHeader,
        },
        now: () => azure.clock.now,
        sleep: async () => {},
        requestTimeoutMs: 2_000,
      }),
      put: async (name, stored) => {
        azure.secrets.set(name, stored);
      },
      stop: () => azure.stop(),
    };
  },
};

/** Everything an error or a provider can show a reader: its message, its
 *  string form, its own fields, what an inspector prints and the line for this
 *  host's log. None of them may hold a value. */
function everythingPrintable(thing: unknown): string {
  const e = thing as Error;
  return [
    e.message ?? "",
    String(e),
    JSON.stringify(e) ?? "",
    JSON.stringify({ ...e }),
    e.stack ?? "",
    Bun.inspect(thing),
    secretErrorForLog(thing),
  ].join("\n");
}

async function thrownBy(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

test("every listed provider has a rig in this file", () => {
  expect(Object.keys(RIGS).sort()).toEqual([...SECRET_PROVIDER_KINDS].sort());
});

for (const kind of Object.keys(RIGS)) {
  describe(`the secret provider contract: ${kind}`, () => {
    let rig: Rig | null = null;

    async function start(): Promise<Rig> {
      // `kind` is one of the keys of RIGS.
      // eslint-disable-next-line security/detect-object-injection
      const make = RIGS[kind];
      if (!make) throw new Error(`no rig for ${kind}`);
      rig = await make();
      return rig;
    }

    afterEach(async () => {
      await rig?.stop();
      rig = null;
    });

    test("its kind is its listed name", async () => {
      const { provider } = await start();
      expect(provider.kind).toBe(kind);
      expect(isSecretProviderKindName(provider.kind)).toBe(true);
    });

    test("get returns the value stored under the name, and has says it is there", async () => {
      const { provider, put } = await start();
      const value = randomLabel("value");
      await put("db-url", value);
      expect(await provider.get("db-url")).toBe(value);
      expect(await provider.has("db-url")).toBe(true);
    });

    test("each name has its own value", async () => {
      const { provider, put } = await start();
      const first = randomLabel("first");
      const second = randomLabel("second");
      await put("db", first);
      await put("db-url", second);
      expect(await provider.get("db")).toBe(first);
      expect(await provider.get("db-url")).toBe(second);
    });

    test("a name with every allowed kind of character reads back", async () => {
      const { provider, put } = await start();
      const longest = `a1-${"z".repeat(61)}`;
      expect(longest.length).toBe(64);
      const value = randomLabel("value");
      await put(longest, value);
      expect(await provider.get(longest)).toBe(value);
    });

    test("exactly one final line ending is removed, and nothing else", async () => {
      const { provider, put } = await start();
      const value = randomLabel("value");
      await put("unix", `${value}\n`);
      await put("windows", `${value}\r\n`);
      await put("two", `${value}\n\n`);
      await put("spaces", `  ${value}  `);
      await put("inner", `line one\nline two\n`);
      expect(await provider.get("unix")).toBe(value);
      expect(await provider.get("windows")).toBe(value);
      expect(await provider.get("two")).toBe(`${value}\n`);
      expect(await provider.get("spaces")).toBe(`  ${value}  `);
      expect(await provider.get("inner")).toBe("line one\nline two");
    });

    test("a value that is not ASCII reads back unchanged", async () => {
      const { provider, put } = await start();
      const value = `pässwörd-口令-${randomLabel("v")}`;
      await put("db-url", value);
      expect(await provider.get("db-url")).toBe(value);
    });

    test("a name with nothing stored under it is a missing secret, and has says so", async () => {
      const { provider, put } = await start();
      await put("another", randomLabel("value"));
      const error = await thrownBy(() => provider.get("db-url"));
      expect(error).toBeInstanceOf(SecretMissing);
      expect((error as SecretMissing).secretName).toBe("db-url");
      expect((error as Error).message).toBe('secret "db-url" is not set');
      expect(await provider.has("db-url")).toBe(false);
    });

    test("a stored value that is empty or only white space is a missing secret", async () => {
      const { provider, put } = await start();
      for (const [name, blank] of [
        ["empty", ""],
        ["newline", "\n"],
        ["spaces", "   \n"],
      ] as const) {
        await put(name, blank);
        expect(await thrownBy(() => provider.get(name))).toBeInstanceOf(SecretMissing);
        expect(await provider.has(name)).toBe(false);
      }
    });

    test("a name that breaks the rule is refused by get and by has, and is not repeated", async () => {
      const { provider, put } = await start();
      const value = randomLabel("value");
      await put("db-url", value);
      // The last one is a value pasted where a name belongs.
      const pasted = `Pasted:${randomLabel("value")}`;
      const bad = ["", "DB-URL", "db_url", "db url", "../db-url", "db/url", "db.url", "a".repeat(65), pasted];
      for (const name of bad) {
        for (const call of [() => provider.get(name), () => provider.has(name)]) {
          const error = await thrownBy(call);
          expect(error).toBeInstanceOf(SecretNameInvalid);
          // What was passed may be a value put where a name belongs.
          if (name.length > 8) expect(everythingPrintable(error)).not.toContain(name);
        }
      }
      // The good name still reads: a refused name changed nothing.
      expect(await provider.get("db-url")).toBe(value);
    });

    test("a value past the size limit is refused, and no part of it is repeated", async () => {
      const { provider, put } = await start();
      const marker = randomLabel("marker");
      await put("big", `${marker}${"x".repeat(MAX_SECRET_BYTES)}`);
      const error = await thrownBy(() => provider.get("big"));
      expect(error).toBeInstanceOf(SecretUnavailable);
      expect((error as SecretUnavailable).transient).toBe(false);
      expect(everythingPrintable(error)).not.toContain(marker);
      // has does not turn "could not read" into "not there".
      expect(await thrownBy(() => provider.has("big"))).toBeInstanceOf(SecretUnavailable);
    });

    test("the largest value that fits is returned whole", async () => {
      const { provider, put } = await start();
      const value = "y".repeat(MAX_SECRET_BYTES);
      await put("largest", `${value}\n`);
      expect(await provider.get("largest")).toBe(value);
    });

    test("several reads at the same time each get the value", async () => {
      const { provider, put } = await start();
      const value = randomLabel("value");
      await put("db-url", value);
      const read = await Promise.all(Array.from({ length: 8 }, () => provider.get("db-url")));
      expect(read).toEqual(Array.from({ length: 8 }, () => value));
      // A name that is not there is missing for every one of them, too.
      const missing = await Promise.all(
        Array.from({ length: 4 }, () => thrownBy(() => provider.get("not-there"))),
      );
      for (const error of missing) expect(error).toBeInstanceOf(SecretMissing);
    });

    test("no error and no printed form of the provider holds a value", async () => {
      const { provider, put } = await start();
      const value = randomLabel("value");
      await put("db-url", value);
      expect(await provider.get("db-url")).toBe(value);
      // After a read, a provider that keeps values in memory still shows none.
      expect(everythingPrintable(provider)).not.toContain(value);
      const missing = await thrownBy(() => provider.get("not-there"));
      expect(everythingPrintable(missing)).not.toContain(value);
    });

    test("where the provider looked is for this host's log only", async () => {
      const { provider } = await start();
      const error = (await thrownBy(() => provider.get("db-url"))) as SecretMissing;
      // The message and the serialized error say the name and nothing about
      // where the store is. Only the line for this host's log may say more.
      expect(error.message).toBe('secret "db-url" is not set');
      expect(JSON.stringify(error)).not.toContain("source");
      expect(secretErrorForLog(error).startsWith(error.message)).toBe(true);
    });
  });
}
