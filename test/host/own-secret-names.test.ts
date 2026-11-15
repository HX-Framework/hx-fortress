// The names of the secrets that this HX Fortress's own settings name: which
// they are, that they are read from its own files as the daemon reads them,
// and that a setting which names a secret cannot be added without being one of
// them.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  test("each of the six settings that name a secret is one of them, as its own place has it", async () => {
    const paths = await root();
    await writeConfigWith(paths, {
      postgres: { urlSecret: "northstar-database-address" },
      model: { provider: "openai", key: "northstar-model-key" },
      // The organization's own certificate. HX Fortress does not read it, and
      // a key store keeps the certificate's private key under this name.
      install: { place: "azure", certificate: "own", certificateName: "northstar-certificate" },
    });
    await new OidcConfigStore(oidcFile(paths)).update((current) => ({ ...current, clientSecretName: "northstar-sign-in" }));
    const names = await ownSecretNamesOf(paths, () => ["database-address-at-start", "model-key-at-start"], {
      // What an install hands over. The setup then writes no `install` block
      // to config.json, so this variable is the only place that has the name.
      FORTRESS_INSTALL: JSON.stringify({ place: "azure", certificate: "own", certificateName: "northstar-certificate-of-the-install" }),
    });
    expect([...names].sort()).toEqual([
      "database-address-at-start",
      "model-key-at-start",
      "northstar-certificate",
      "northstar-certificate-of-the-install",
      "northstar-database-address",
      "northstar-model-key",
      "northstar-sign-in",
    ]);
  });

  test("a setting that names no secret adds none, and a name that two settings hold is there once", async () => {
    const paths = await root();
    // No config.json and no oidc.json: an HX Fortress that is not set up.
    expect(await ownSecretNamesOf(paths, () => [null, undefined], {})).toEqual([]);
    await writeConfigWith(paths, { model: { provider: "openai", key: "shared-name" } });
    expect(await ownSecretNamesOf(paths, () => ["shared-name", null], {})).toEqual(["shared-name"]);
    // A model with no key, and a database given by its address.
    await writeConfigWith(paths, { model: { provider: "none" }, postgres: { externalUrl: "postgres://db.northstar.example/hx" } });
    expect(await ownSecretNamesOf(paths, () => [], {})).toEqual([]);
    // An install that brought no certificate of the organization's own.
    for (const FORTRESS_INSTALL of ["", "  ", JSON.stringify({ place: "azure", certificate: "managed" })]) {
      expect(await ownSecretNamesOf(paths, () => [], { FORTRESS_INSTALL })).toEqual([]);
    }
  });

  test("a setting that cannot be read rejects: which names are taken is then not known", async () => {
    const paths = await root();
    for (const content of ["{ not json", JSON.stringify({ schemaVersion: 2 }), JSON.stringify([])]) {
      await mkdir(path.dirname(paths.config), { recursive: true });
      await writeFile(paths.config, content);
      await expect(ownSecretNamesOf(paths, () => ["database-address-at-start"], {})).rejects.toMatchObject({
        name: "SettingUnreadable",
        place: "config.json",
      });
    }
    // A key's own value where its name belongs is not a config.json either.
    await writeConfigWith(paths, { model: { provider: "openai", key: "Not A Name" } });
    await expect(ownSecretNamesOf(paths, () => [], {})).rejects.toMatchObject({ place: "config.json" });

    await writeConfigWith(paths, {});
    await mkdir(path.dirname(oidcFile(paths)), { recursive: true });
    await writeFile(oidcFile(paths), "{ not json");
    await expect(ownSecretNamesOf(paths, () => [], {})).rejects.toMatchObject({ place: "ui/oidc.json" });
    await rm(oidcFile(paths));
    // The install's variable is set, and is not the install's facts.
    for (const FORTRESS_INSTALL of ["{ not json", "[]", '"azure"']) {
      await expect(ownSecretNamesOf(paths, () => [], { FORTRESS_INSTALL })).rejects.toMatchObject({
        name: "SettingUnreadable",
        place: "the variable FORTRESS_INSTALL",
      });
    }
    expect(await ownSecretNamesOf(paths, () => [], {})).toEqual([]);
    // And so for a source that fails for any other reason. What it said is
    // not repeated: a reader's own error can quote a part of a file.
    const failed = await ownSecretNames({
      atStart: [],
      config: async () => null,
      signIn: async () => {
        throw new Error("could not parse: clientSecretName northstar-sign-in");
      },
      env: {},
    }).catch((error: unknown) => error as Error);
    expect(failed).toMatchObject({ name: "SettingUnreadable", place: "ui/oidc.json" });
    expect(String((failed as Error).message)).not.toContain("northstar-sign-in");
  });

  // If this test fails, a setting that names a secret was added or renamed.
  // Add it to `ownSecretNames` (src/host/own-secret-names.ts), with a line in
  // the first test above, and then bring the list here up to date. A name
  // that is left out can be handed to a module by a person at the console.
  test("the settings that name a secret are the six that the list knows", async () => {
    const source = (file: string): Promise<string> => readFile(path.join(import.meta.dir, "..", "..", file), "utf8");
    // The setup's own answers, which is where a new such setting begins:
    // every answer that is the NAME of a key. For each, where it is kept
    // once the setup has written it, and so where `ownSecretNames` reads it:
    //
    //   address.certificateName  config.json `install.certificateName`, or the
    //                            variable FORTRESS_INSTALL of an install
    //   data.database.address    config.json `postgres.urlSecret`, or the
    //                            variable FORTRESS_DATABASE_URL_SECRET
    //   model.key                config.json `model.key`
    //   signIn.clientSecret      ui/oidc.json `clientSecretName`
    //   controlPlane.token       nowhere: a one-time enrollment token, read
    //                            once by the setup. It is not kept back.
    const answers = await source("src/setup/answers.ts");
    expect([...new Set([...answers.matchAll(/keyName\("([\w.]+)",/g)].map((match) => match[1]))].sort()).toEqual([
      "address.certificateName",
      "controlPlane.token",
      "data.database.address",
      "model.key",
      "signIn.clientSecret",
    ]);
    // What an install hands over in a variable: every field of its facts
    // that is a key's name.
    const facts = /export interface InstallFacts \{([\s\S]*?)\n\}/.exec(await source("src/setup/read.ts"))?.[1] ?? "";
    expect([...facts.matchAll(/^\s+(\w+): string;/gm)].map((match) => match[1]).sort()).toEqual([
      "certificate",
      "certificateName",
      "database",
      "place",
      "region",
      "ssh",
    ]);
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
