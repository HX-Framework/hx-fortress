// The names of the secrets that this HX Fortress's own settings name: which
// they are, that they are read from its own files as the daemon reads them,
// and that a setting which names a secret cannot be added without being one of
// them.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { ownSecretNames, ownSecretNamesOf } from "../../src/host/own-secret-names";
import { OidcConfigStore } from "../../src/ui/oidc-config";
import { tempRoot, type Paths } from "./_module-rig";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function root(): Promise<Paths> {
  const { paths, cleanup } = await tempRoot();
  cleanups.push(cleanup);
  return paths;
}

/** A config.json as the setup writes one, with more settings on top. */
async function writeConfigWith(paths: Paths, more: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(paths.config), { recursive: true });
  await writeFile(
    paths.config,
    JSON.stringify({
      schemaVersion: 1,
      cloud: { url: "wss://control.example/_api/hx-gateway/vault-tunnel" },
      gateway: { publicUrl: "http://localhost:8787" },
      modules: { enabled: ["session_vault"] },
      ...more,
    }),
  );
}

const oidcFile = (paths: Paths): string => path.join(paths.uiRoot, "oidc.json");

describe("the names of the secrets that this HX Fortress's own settings name", () => {
  test("each of the five settings that name a secret is one of them, as its own file has it", async () => {
    const paths = await root();
    await writeConfigWith(paths, {
      postgres: { urlSecret: "northstar-database-address" },
      model: { provider: "openai", key: "northstar-model-key" },
      // The organization's own certificate. HX Fortress does not read it, and
      // a key store keeps the certificate's private key under this name.
      install: { place: "azure", certificate: "own", certificateName: "northstar-certificate" },
    });
    await new OidcConfigStore(oidcFile(paths)).update((current) => ({ ...current, clientSecretName: "northstar-sign-in" }));
    const names = await ownSecretNamesOf(paths, () => ["database-address-at-start", "model-key-at-start"]);
    expect([...names].sort()).toEqual([
      "database-address-at-start",
      "model-key-at-start",
      "northstar-certificate",
      "northstar-database-address",
      "northstar-model-key",
      "northstar-sign-in",
    ]);
  });

  test("a setting that names no secret adds none, and a name that two settings hold is there once", async () => {
    const paths = await root();
    // No config.json and no oidc.json: an HX Fortress that is not set up.
    expect(await ownSecretNamesOf(paths, () => [null, undefined])).toEqual([]);
    await writeConfigWith(paths, { model: { provider: "openai", key: "shared-name" } });
    expect(await ownSecretNamesOf(paths, () => ["shared-name", null])).toEqual(["shared-name"]);
    // A model with no key, and a database given by its address.
    await writeConfigWith(paths, { model: { provider: "none" }, postgres: { externalUrl: "postgres://db.northstar.example/hx" } });
    expect(await ownSecretNamesOf(paths, () => [])).toEqual([]);
  });

  test("a setting that cannot be read rejects: which names are taken is then not known", async () => {
    const paths = await root();
    for (const content of ["{ not json", JSON.stringify({ schemaVersion: 2 }), JSON.stringify([])]) {
      await mkdir(path.dirname(paths.config), { recursive: true });
      await writeFile(paths.config, content);
      await expect(ownSecretNamesOf(paths, () => ["database-address-at-start"])).rejects.toBeDefined();
    }
    // A key's own value where its name belongs is not a config.json either.
    await writeConfigWith(paths, { model: { provider: "openai", key: "Not A Name" } });
    await expect(ownSecretNamesOf(paths, () => [])).rejects.toBeDefined();

    await writeConfigWith(paths, {});
    await mkdir(path.dirname(oidcFile(paths)), { recursive: true });
    await writeFile(oidcFile(paths), "{ not json");
    await expect(ownSecretNamesOf(paths, () => [])).rejects.toBeDefined();
    // And so for a source that fails for any other reason.
    await expect(
      ownSecretNames({
        atStart: [],
        config: async () => null,
        signIn: async () => {
          throw new Error("the file's lock is held");
        },
      }),
    ).rejects.toThrow("the file's lock is held");
  });

  // If this test fails, a setting that names a secret was added or renamed.
  // Add it to `ownSecretNames` (src/host/own-secret-names.ts), with a line in
  // the first test above, and then bring the list here up to date. A name
  // that is left out can be handed to a module by a person at the console.
  test("the settings that name a secret are the five that the list knows", async () => {
    const source = (file: string): Promise<string> => readFile(path.join(import.meta.dir, "..", "..", file), "utf8");
    // config.json: every field that its parser reads as the name of a key.
    const config = await source("src/host/config.ts");
    expect([...config.matchAll(/keyName\(value\.\w+, "([\w.]+)"\)/g)].map((match) => match[1]).sort()).toEqual([
      "install.certificateName",
      "model.key",
      "postgres.urlSecret",
    ]);
    // ui/oidc.json: every field of the sign-in's settings that is a secret's name.
    const signIn = await source("src/ui/oidc-config.ts");
    const settings = /export interface UiOidcConfig \{([\s\S]*?)\n\}/.exec(signIn)?.[1] ?? "";
    expect([...settings.matchAll(/^\s+(\w*[Ss]ecret\w*)\??:/gm)].map((match) => match[1])).toEqual(["clientSecretName"]);
    // The environment: every setting that can be given by a secret's name.
    const settingsByName: string[] = [];
    for await (const file of new Bun.Glob("src/**/*.ts").scan({ cwd: path.join(import.meta.dir, "..", "..") })) {
      for (const match of (await source(file)).matchAll(/secretNameForSetting\(\s*[\w.]+,\s*"([A-Z_]+)"/g)) {
        settingsByName.push(match[1] as string);
      }
    }
    expect([...new Set(settingsByName)]).toEqual(["FORTRESS_DATABASE_URL"]);
  });
});
