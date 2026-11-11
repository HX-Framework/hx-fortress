import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  createSecretProvider,
  DEFAULT_SECRET_PROVIDER_KIND,
  describeSecretsConfig,
  isSecretProviderKind,
  isSecretProviderKindName,
  resolveSecretsConfig,
  SECRET_PROVIDER_KINDS,
  SECRET_PROVIDERS,
  secretProviderDefinition,
  type SecretProvider,
} from "../src/secrets";
import { isName } from "../src/host/shape";
import { secretProviderNeedLine } from "../src/secrets/config";
import { secretProvidersTable, secretSettingsTable } from "../src/secrets/docs";

// The smallest settings each listed provider resolves with. A provider added to
// the list needs an entry here, or the first test below fails.
const SMALLEST_SETTINGS: Record<string, Record<string, string>> = {
  env: {},
  file: {},
  "azure-key-vault": { FORTRESS_KEY_VAULT_URL: "https://example.vault.azure.net" },
};

function settingsFor(kind: string): Record<string, string> {
  // `kind` is one of the listed names.
  // eslint-disable-next-line security/detect-object-injection
  const settings = SMALLEST_SETTINGS[kind];
  if (!settings) throw new Error(`this test has no settings for the ${kind} provider`);
  return { FORTRESS_SECRETS_PROVIDER: kind, ...settings };
}

describe("the one list of secret providers", () => {
  test("every listed provider has settings in this test", () => {
    expect(Object.keys(SMALLEST_SETTINGS).sort()).toEqual([...SECRET_PROVIDER_KINDS].sort());
  });

  test("a provider's kind is a name with a fixed shape, and no two share one", () => {
    for (const kind of SECRET_PROVIDER_KINDS) expect(isSecretProviderKindName(kind)).toBe(true);
    expect(new Set(SECRET_PROVIDER_KINDS).size).toBe(SECRET_PROVIDER_KINDS.length);
    for (const bad of ["", "Env", "9lives", "aws secrets", "a".repeat(33), "x_y", 7, null, undefined]) {
      expect(isSecretProviderKindName(bad)).toBe(false);
    }
  });

  test("the providers that need no cloud come first, then each cloud's own by the cloud's name", () => {
    const clouds = SECRET_PROVIDERS.map((provider) => provider.cloud);
    const plain = clouds.filter((cloud) => cloud === null);
    const named = clouds.filter((cloud): cloud is string => cloud !== null);
    expect(clouds).toEqual([...plain, ...[...named].sort((a, b) => a.localeCompare(b))]);
  });

  test("the default provider is the first one, and it needs no cloud and nothing from the host", () => {
    const first = SECRET_PROVIDERS[0];
    expect(first?.kind).toBe(DEFAULT_SECRET_PROVIDER_KIND);
    expect(first?.cloud).toBeNull();
    expect(first?.needs).toBeNull();
  });

  test("a name that is not on the list is not a provider of this build", () => {
    expect(isSecretProviderKind("env")).toBe(true);
    expect(isSecretProviderKind("ENV")).toBe(false);
    expect(isSecretProviderKind("some-later-store")).toBe(false);
    expect(secretProviderDefinition("some-later-store")).toBeNull();
    expect(() =>
      resolveSecretsConfig({ env: { FORTRESS_SECRETS_PROVIDER: "some-later-store" }, config: null, root: "/data" }),
    ).toThrow(`FORTRESS_SECRETS_PROVIDER must be one of ${SECRET_PROVIDER_KINDS.join(", ")}`);
  });

  test("code that is handed a provider may be handed one this build does not list", () => {
    // The contract's `kind` is a string. This compiles, which is the point: a
    // caller cannot switch over a closed set of kinds.
    const later: SecretProvider = {
      kind: "some-later-store",
      get: async () => "value",
      has: async () => true,
    };
    expect(isSecretProviderKindName(later.kind)).toBe(true);
  });

  test("each listed provider resolves, builds and describes itself under its own name", () => {
    for (const definition of SECRET_PROVIDERS) {
      const env = { ...settingsFor(definition.kind), IDENTITY_ENDPOINT: "http://127.0.0.1:1/token", IDENTITY_HEADER: "h" };
      const config = resolveSecretsConfig({ env, config: null, root: "/data" });
      expect<string>(config.provider).toBe(definition.kind);
      expect(createSecretProvider(config, { env }).kind).toBe(definition.kind);
      expect(describeSecretsConfig(config).startsWith(definition.kind)).toBe(true);

      const where = definition.path(config);
      expect(where.peer.length).toBeGreaterThan(0);
      expect(where.gate.length).toBeGreaterThan(0);
      // A provider that needs no cloud reads on this host.
      if (definition.cloud === null) expect(where.leavesHost).toBe(false);
    }
  });

  test("a provider that needs something from the host has one line that says so, and the others have none", () => {
    for (const definition of SECRET_PROVIDERS) {
      const env = { ...settingsFor(definition.kind) };
      const line = secretProviderNeedLine(resolveSecretsConfig({ env, config: null, root: "/data" }));
      if (definition.needs === null) {
        expect(line).toBeNull();
      } else {
        expect(line).toContain(`secrets are read by the ${definition.kind}`);
        expect(line).toContain(`It needs: ${definition.needs}`);
      }
    }
  });

  test("every setting has one variable, one key, and a prefix under which a mistyped variable is refused", () => {
    const keys = new Map<string, string>();
    for (const definition of SECRET_PROVIDERS) {
      for (const setting of definition.settings) {
        expect(setting.key).toMatch(/^[a-z][A-Za-z0-9]{0,31}$/);
        expect(setting.key).not.toBe("provider");
        expect(setting.env).toMatch(/^FORTRESS_[A-Z0-9_]{1,56}$/);
        expect(setting.meaning.length).toBeGreaterThan(0);
        // Two providers may share a setting, and then it is the same variable.
        expect(keys.get(setting.key) ?? setting.env).toBe(setting.env);
        keys.set(setting.key, setting.env);

        const mistyped = `${setting.env}X`;
        expect(() =>
          resolveSecretsConfig({ env: { ...settingsFor(definition.kind), [mistyped]: "v" }, config: null, root: "/data" }),
        ).toThrow(`${mistyped} is not a setting this build knows`);
      }
    }
  });

  test("a setting written one letter short is refused when its value has the setting's shape", () => {
    // FORTRESS_SECRET_<X> is the variable of a secret named <x>, and one letter
    // short of the setting FORTRESS_SECRETS_<X>. A value with the setting's
    // shape there is the setting, mistyped.
    const SHAPED: Record<string, string> = { dir: "/run/secrets", cacheSeconds: "120" };
    const NOT_SHAPED: Record<string, string> = { dir: "a-secret-value", cacheSeconds: "a-secret-value" };
    let checked = 0;
    for (const definition of SECRET_PROVIDERS) {
      for (const setting of definition.settings) {
        if (!setting.oneLetterShort) continue;
        checked += 1;
        expect(setting.env.startsWith("FORTRESS_SECRETS_")).toBe(true);
        const short = setting.env.replace("FORTRESS_SECRETS_", "FORTRESS_SECRET_");
        // `setting.key` is a key of a listed setting.
        // eslint-disable-next-line security/detect-object-injection
        const shaped = SHAPED[setting.key];
        // eslint-disable-next-line security/detect-object-injection
        const notShaped = NOT_SHAPED[setting.key];
        if (shaped === undefined || notShaped === undefined) {
          throw new Error(`this test has no example values for the setting ${setting.key}`);
        }
        expect(() => resolveSecretsConfig({ env: { [short]: shaped }, config: null, root: "/data" })).toThrow(
          `${short} holds ${setting.oneLetterShort.holds}. The setting is ${setting.env}`,
        );
        // With the real setting given too, the short name is a secret's own.
        expect(() =>
          resolveSecretsConfig({ env: { ...settingsFor(definition.kind), [setting.env]: shaped, [short]: shaped }, config: null, root: "/data" }),
        ).not.toThrow();
        // A value without the shape is a secret of that name, and is left alone.
        expect(() => resolveSecretsConfig({ env: { [short]: notShaped }, config: null, root: "/data" })).not.toThrow();
      }
    }
    expect(checked).toBeGreaterThan(0);
    // The provider's own name, one letter short.
    expect(() => resolveSecretsConfig({ env: { FORTRESS_SECRET_PROVIDER: "file" }, config: null, root: "/data" })).toThrow(
      "FORTRESS_SECRET_PROVIDER holds a provider name. The setting is FORTRESS_SECRETS_PROVIDER",
    );
  });

  test("an unknown variable under a provider's own prefix is refused by name", () => {
    let checked = 0;
    for (const definition of SECRET_PROVIDERS) {
      for (const prefix of definition.guardedEnvPrefixes ?? []) {
        checked += 1;
        expect(prefix).toMatch(/^FORTRESS_[A-Z0-9_]+_$/);
        const unknown = `${prefix}NOT_A_SETTING`;
        // Whichever provider is in use.
        for (const other of SECRET_PROVIDERS) {
          expect(() =>
            resolveSecretsConfig({ env: { ...settingsFor(other.kind), [unknown]: "v" }, config: null, root: "/data" }),
          ).toThrow(`${unknown} is not a setting this build knows`);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  test("a setting given for a provider that is not in use is refused, from the environment and from config.json", () => {
    for (const owner of SECRET_PROVIDERS) {
      for (const setting of owner.settings) {
        for (const other of SECRET_PROVIDERS) {
          if (other.settings.some((theirs) => theirs.key === setting.key)) continue;
          expect(() =>
            resolveSecretsConfig({
              env: { ...settingsFor(other.kind), [setting.env]: "anything" },
              config: null,
              root: "/data",
            }),
          ).toThrow(`${setting.env} is set, but the provider is ${other.kind}`);
          expect(() =>
            resolveSecretsConfig({
              env: {},
              config: { secrets: { provider: other.kind, [setting.key]: "anything" } },
              root: "/data",
            }),
          ).toThrow(`secrets.${setting.key} is set in config.json, but secrets.provider is ${other.kind}`);
        }
      }
    }
  });

  test("no message about a refused setting repeats the value that was given", () => {
    const pasted = "p4ssw0rd-pasted-into-the-wrong-place";
    for (const owner of SECRET_PROVIDERS) {
      const attempts: (() => unknown)[] = [
        () => resolveSecretsConfig({ env: { FORTRESS_SECRETS_PROVIDER: pasted }, config: null, root: "/data" }),
        () => resolveSecretsConfig({ env: {}, config: { secrets: { provider: pasted } }, root: "/data" }),
      ];
      for (const setting of owner.settings) {
        attempts.push(
          () => resolveSecretsConfig({ env: { ...settingsFor(owner.kind), [setting.env]: pasted }, config: null, root: "/data" }),
          () => resolveSecretsConfig({ env: { [setting.env]: pasted }, config: null, root: "/data" }),
        );
      }
      for (const attempt of attempts) {
        try {
          attempt();
        } catch (error) {
          expect(String(error)).not.toContain(pasted);
        }
      }
    }
  });
});

/**
 * Every table in a Markdown text that starts with `header`: the header line and
 * each line that follows it and still belongs to the table.
 *
 * The whole table is taken, not only the part that matches. A row that
 * somebody added by hand below the written ones is part of what a reader sees,
 * so it has to be part of what is compared.
 */
function tablesStartingWith(markdown: string, header: string): string[] {
  const lines = markdown.split("\n");
  const tables: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines.at(i) !== header) continue;
    let end = i;
    while (end + 1 < lines.length && (lines.at(end + 1) ?? "").startsWith("|")) end += 1;
    tables.push(lines.slice(i, end + 1).join("\n"));
  }
  return tables;
}

describe("the docs are written from the list", () => {
  const readme = readFileSync(path.join(import.meta.dir, "..", "README.md"), "utf8");
  const headerOf = (table: string): string => table.split("\n").at(0) ?? "";

  test("README.md holds the table of providers once, and exactly as the list writes it", () => {
    const written = secretProvidersTable();
    expect(tablesStartingWith(readme, headerOf(written))).toEqual([written]);
  });

  test("README.md holds the table of settings once, and exactly as the list writes it", () => {
    const written = secretSettingsTable();
    expect(tablesStartingWith(readme, headerOf(written))).toEqual([written]);
  });

  test("a table with a row the list does not have is not the table the list writes", () => {
    // What the two tests above would let through if they only looked for the
    // written table somewhere in the text.
    const written = secretProvidersTable();
    const header = headerOf(written);
    const extraRow = `${written}\n| \`a-later-store\` | Somewhere else. | Nothing. |`;
    expect(tablesStartingWith(`intro\n\n${extraRow}\n\nmore`, header)).not.toEqual([written]);
    const twice = `${written}\n\ntext between\n\n${written}`;
    expect(tablesStartingWith(twice, header)).toHaveLength(2);
    expect(tablesStartingWith(`intro\n\n${written}\n\nmore`, header)).toEqual([written]);
    expect(tablesStartingWith("no table here", header)).toEqual([]);
  });

  test("every listed kind is a name the status report may carry", () => {
    // The control plane is told the kind as a `name`. A kind that the name
    // rule refused could not be reported.
    for (const kind of SECRET_PROVIDER_KINDS) expect(isName(kind)).toBe(true);
  });

  test("the tables name every provider and every setting of the list", () => {
    const providers = secretProvidersTable();
    const settings = secretSettingsTable();
    for (const definition of SECRET_PROVIDERS) {
      expect(providers).toContain(`\`${definition.kind}\``);
      for (const setting of definition.settings) {
        expect(settings).toContain(`| \`${setting.env}\` | \`${setting.key}\` |`);
      }
    }
  });
});
