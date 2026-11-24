// The rules the setup holds whatever its questions are: what the host's
// environment decides, which control plane an enrollment belongs to, how the
// connection is switched off and on, when an HX Fortress counts as set up,
// and what a check may do in each of its modes.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { FileCredentialStore, FilePendingEnrollmentStore } from "../src/cloud/credentials";
import { FileConfigStore, mergeConfigPatch, patchConfig } from "../src/host/config";
import { publishDaemonEnvironment, type Named } from "../src/host/daemon-environment";
import type { VaultCredentials } from "../src/modules/session-vault/credentials";
import type { SecretProvider } from "../src/secrets/types";
import { defaultAnswers, UPDATES_FROM_UNREADABLE, type SetupAnswers } from "../src/setup/answers";
import { checkStep, type CheckDeps, type CheckLine } from "../src/setup/checks";
import { readAnswers } from "../src/setup/read";
import { SetupRun } from "../src/setup/run";
import { isSetUp, needsSetupFirst, readSetupMark } from "../src/setup/state";
import { fixedSecrets, publishStatus, tempRoot, type Paths } from "./host/_module-rig";
import {
  CONNECT,
  CONTROL,
  DB_URL,
  EARLIER_CONTROL,
  INSTALL_ID,
  MODULES,
  northstar,
  providerDocument,
  rawConfig,
  runDeps,
} from "./setup-rig";

// Built at run time so no secret-shaped literal sits in the repository.
const A_KEY = ["a", "key", "for", "a", "test"].join("-");

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function root(): Promise<Paths> {
  const made = await tempRoot();
  cleanup = made.cleanup;
  return made.paths;
}

const read = (paths: Paths, env: Record<string, string | undefined> = {}) =>
  readAnswers(paths, env, { vaultCredentials: async () => null });

const texts = (lines: readonly CheckLine[]): string[] => lines.map((line) => line.text);

async function finished(run: SetupRun): Promise<void> {
  const result = await run.finish("terminal");
  if (!result.ok) throw new Error(`the setup was refused: ${JSON.stringify(result.checks.filter((c) => !c.ok))}`);
}

async function writeConfigJson(paths: Paths, value: unknown): Promise<void> {
  await mkdir(path.dirname(paths.config), { recursive: true });
  await writeFile(paths.config, JSON.stringify(value));
}

/** The process id of the HX Fortress that runs in these tests. */
const DAEMON_PID = 4242;

/** What an HX Fortress wrote down when it started: what the environment of its
 *  service names for the address of new versions. */
async function startedWith(paths: Paths, updateUrl: Named<unknown>): Promise<void> {
  expect(await publishDaemonEnvironment(paths, { updateUrl, controlPlaneKey: null }, { pid: DAEMON_PID })).toBe(true);
}

/** An HX Fortress that runs now, as a terminal on its host sees it: a fresh
 *  status file, and what the environment of its service names. */
async function running(paths: Paths, updateUrl: Named<unknown>): Promise<void> {
  await publishStatus(paths, [], { pid: DAEMON_PID });
  await startedWith(paths, updateUrl);
}

/** Both answers of where new versions come from, decided by the variable. */
const PINNED_BY_THE_VARIABLE = { "updates.from": "FORTRESS_UPDATE_URL", "updates.address": "FORTRESS_UPDATE_URL" };

/** The answer when this host's update settings cannot be understood. */
const NOT_KNOWN = { securityFixes: "off", from: UPDATES_FROM_UNREADABLE, address: "" };

// ── What the host's environment decides ──────────────────────────────────────

describe("a setting in the host's environment pins exactly the answers it decides", () => {
  test("the model's key in the environment pins the key, and the address and the name stay a person's to give", async () => {
    const paths = await root();
    const env = { FORTRESS_OPENAI_API_KEY: A_KEY };
    const run = await SetupRun.open(runDeps(paths, { env }));
    expect(run.present.pinned).toEqual({
      "model.provider": "FORTRESS_OPENAI_API_KEY",
      "model.key": "FORTRESS_OPENAI_API_KEY",
    });
    northstar(run);
    expect(run.set("model.key", "another-key")).toBe(false);
    expect(run.set("model.address", "https://models.northstar.example/v1")).toBe(true);
    expect(run.set("model.name", "northstar-embed")).toBe(true);
    await finished(run);

    // What a person gave is written. No key's name is: the key stays where it is.
    expect((await rawConfig(paths)).model).toEqual({
      provider: "openai",
      address: "https://models.northstar.example/v1",
      name: "northstar-embed",
    });
    expect(JSON.stringify(await rawConfig(paths))).not.toContain(A_KEY);
    const again = await read(paths, env);
    expect(again.answers.model).toMatchObject({ address: "https://models.northstar.example/v1", name: "northstar-embed" });
    expect(again.kept.modelKey).toBe(true);
  });

  test("the model's address and its name each have a variable of their own", async () => {
    const paths = await root();
    const present = await read(paths, {
      FORTRESS_OPENAI_API_KEY: A_KEY,
      FORTRESS_OPENAI_BASE_URL: "https://gateway.northstar.example/v1",
      FORTRESS_EMBED_MODEL: "northstar-embed",
    });
    expect(present.answers.model).toMatchObject({
      provider: "openai",
      route: "direct",
      address: "https://gateway.northstar.example/v1",
      name: "northstar-embed",
      key: "",
    });
    expect(present.pinned).toMatchObject({
      "model.address": "FORTRESS_OPENAI_BASE_URL",
      "model.name": "FORTRESS_EMBED_MODEL",
    });
  });

  test("the storage variables are the file store's answer on a folder that holds no credentials file yet", async () => {
    const paths = await root();
    const present = await read(paths, {
      FORTRESS_SESSIONS: "on",
      FORTRESS_STORAGE_KIND: "s3",
      FORTRESS_STORAGE_BUCKET: "northstar-hx-fortress",
      FORTRESS_STORAGE_REGION: "eu-central-1",
    });
    expect(present.answers.modules.session_vault).toBe(true);
    expect(present.answers.data.files).toMatchObject({
      store: "amazon-s3",
      bucket: "northstar-hx-fortress",
      region: "eu-central-1",
    });
    // Every part of the answer is the environment's, each by its own variable.
    expect(Object.fromEntries(Object.entries(present.pinned).filter(([at]) => at.startsWith("data.files.")))).toEqual({
      "data.files.store": "FORTRESS_STORAGE_BUCKET",
      "data.files.bucket": "FORTRESS_STORAGE_BUCKET",
      "data.files.region": "FORTRESS_STORAGE_REGION",
      "data.files.address": "FORTRESS_S3_ENDPOINT",
      "data.files.project": "FORTRESS_GCS_PROJECT_ID",
    });
  });

  test("a refused answer that the environment decides says where it is put right", async () => {
    const paths = await root();
    const env = { FORTRESS_SESSIONS: "on", FORTRESS_STORAGE_KIND: "s3", FORTRESS_STORAGE_BUCKET: "northstar-hx-fortress" };
    const present = await read(paths, env);
    const check = await checkStep("data", present.answers, await checkDeps(paths, { env, present }));
    expect(texts(check.lines)).toContain(
      "Give the bucket's region. This host's environment decides this answer: set FORTRESS_STORAGE_REGION there",
    );
  });

  test("the database's key in the environment pins both parts of that answer", async () => {
    const paths = await root();
    const present = await read(paths, { FORTRESS_DATABASE_URL_SECRET: "db-url" });
    expect(present.answers.data.database).toEqual({ store: "existing", address: "db-url" });
    expect(present.pinned).toEqual({
      "data.database.store": "FORTRESS_DATABASE_URL_SECRET",
      "data.database.address": "FORTRESS_DATABASE_URL_SECRET",
    });
  });

  test("the facts of an install in the environment pin where it runs, its certificate and its database, and are not written", async () => {
    const paths = await root();
    const env = {
      FORTRESS_INSTALL: JSON.stringify({ place: "azure", region: "eastus2", certificate: "cloud-issued", database: "managed" }),
      FORTRESS_DATABASE_URL_SECRET: "db-url",
    };
    const run = await SetupRun.open(runDeps(paths, { env }));
    expect(run.answers.where).toEqual({ place: "azure", region: "eastus2", ssh: "" });
    expect(run.answers.address.certificate).toBe("cloud-issued");
    expect(run.answers.data.database).toEqual({ store: "managed", address: "db-url" });
    expect(run.present.pinned).toMatchObject({
      "where.place": "FORTRESS_INSTALL",
      "where.region": "FORTRESS_INSTALL",
      "where.ssh": "FORTRESS_INSTALL",
      "address.certificate": "FORTRESS_INSTALL",
      "address.certificateName": "FORTRESS_INSTALL",
      "data.database.store": "FORTRESS_INSTALL",
    });
    expect(run.set("where.region", "westeurope")).toBe(false);
    expect(run.set("address.certificate", "own")).toBe(false);
    northstar(run);
    await finished(run);
    // The environment holds them, and keeps holding them.
    expect((await rawConfig(paths)).install).toBeUndefined();
    const again = await read(paths, env);
    expect(again.answers.where.place).toBe("azure");
  });

  test("on an HX Fortress an install made, renaming the organization changes no other answer: the suggestions are the install's", async () => {
    const paths = await root();
    await mkdir(path.dirname(paths.config), { recursive: true });
    await writeFile(
      paths.config,
      JSON.stringify({
        schemaVersion: 1,
        gateway: { publicUrl: "http://localhost:8787" },
        modules: { enabled: ["host"] },
        moduleDefaultsApplied: 1,
        organization: { name: "Northstar" },
      }),
    );
    const env = {
      FORTRESS_INSTALL: JSON.stringify({ place: "azure", region: "eastus2", certificate: "cloud-issued", database: "managed" }),
      FORTRESS_SECRETS_PROVIDER: "azure-key-vault",
      FORTRESS_SECRETS_AZURE_VAULT_URL: "https://northstar-hx-fortress.vault.azure.net",
      FORTRESS_UI_PUBLIC_URL: "https://hx.northstar.example",
      FORTRESS_DATABASE_URL_SECRET: "database-address",
    };
    const run = await SetupRun.open(runDeps(paths, { env }));
    expect(run.answers.where.place).toBe("azure");
    expect(run.changedSteps()).toEqual([]);
    const before = { vault: run.answers.keys.vault, hostname: run.answers.address.hostname };
    expect(before).toEqual({ vault: "northstar-hx-fortress", hostname: "hx.northstar.example" });
    expect(run.set("organization.name", "Northstar Analytics")).toBe(true);
    expect(run.set("organization.firstAdministrator", "marta.lindqvist")).toBe(true);
    expect({ vault: run.answers.keys.vault, hostname: run.answers.address.hostname }).toEqual(before);
    expect(run.changedSteps()).toEqual(["organization"]);
  });

  test("the control plane's pages in the environment pin that answer, and a value there that is not an origin reads as none", async () => {
    const paths = await root();
    expect((await read(paths, { FORTRESS_CONTROL_PLANE_PAGES: "https://App.Control.Example:443/" })).answers.controlPlane.pages).toBe(
      "https://app.control.example",
    );
    const wrong = await read(paths, { FORTRESS_CONTROL_PLANE_PAGES: "https://*.control.example" });
    expect(wrong.answers.controlPlane.pages).toBe("");
    expect(wrong.pinned["controlPlane.pages"]).toBe("FORTRESS_CONTROL_PLANE_PAGES");
  });

  test("a container's first account is the first administrator, and the setup makes it", async () => {
    const paths = await root();
    const run = await SetupRun.open(runDeps(paths, { env: { FORTRESS_UI_BOOTSTRAP_USER: "ops" } }));
    expect(run.answers.organization.firstAdministrator).toBe("ops");
    expect(run.present.pinned).toEqual({ "organization.firstAdministrator": "FORTRESS_UI_BOOTSTRAP_USER" });
    // A settings file or a page cannot name another: the console would then make two.
    expect(run.set("organization.firstAdministrator", "marta.lindqvist")).toBe(false);
    run.set("organization.name", "Northstar");
    const result = await run.finish("file");
    expect(result.ok && result.applied.firstAccount?.login).toBe("ops");
  });

  test("the address of new versions in the environment decides where they come from, and no page or file changes it", async () => {
    const paths = await root();
    const env = { FORTRESS_UPDATE_URL: "https://releases.northstar.example/hx-fortress/" };
    const present = await read(paths, env);
    expect(present.pinned).toEqual({ "updates.from": "FORTRESS_UPDATE_URL", "updates.address": "FORTRESS_UPDATE_URL" });
    expect(present.answers.updates).toEqual({
      securityFixes: "off",
      from: "own-address",
      address: "https://releases.northstar.example/hx-fortress",
    });
    // A file that says nothing about the source is taken: the install's own
    // settings say nothing about it, and a container whose environment names
    // an address must still set itself up from them.
    const quiet = await SetupRun.open(await runDeps(paths, { env }));
    expect(quiet.takeFile(JSON.stringify({ updates: { securityFixes: false } })).ok).toBe(true);
    expect((await quiet.check("updates")).ok).toBe(true);
    expect(quiet.answers.updates.address).toBe("https://releases.northstar.example/hx-fortress");
    // A file that names another address is refused by the answer's check, which names the variable.
    const run = await SetupRun.open(await runDeps(paths, { env }));
    expect(
      run.takeFile(JSON.stringify({ updates: { from: "own-address", address: "https://other.northstar.example/x" } })).ok,
    ).toBe(true);
    const check = await run.check("updates");
    expect(check.ok).toBe(false);
    expect(check.lines.map((line) => line.text)).toEqual([
      "This host's environment decides this answer (FORTRESS_UPDATE_URL). Remove the variable to change it here",
    ]);
  });

  test("a wrong address in this terminal's own variable, while HX Fortress does not run, makes where new versions come from not known, and the variable decides both answers", async () => {
    const paths = await root();
    // config.json names an address of its own. The variable comes first, and
    // it cannot be followed: config.json's address is not shown in its place.
    await writeConfigJson(paths, { updates: { from: "own-address", address: "https://files.northstar.example/hx-fortress" } });
    for (const value of [
      "http://files.northstar.example/hx",
      "https://files.northstar.example/hx?x=1",
      "https://files.northstar.example/hx?",
      "",
    ]) {
      const present = await read(paths, { FORTRESS_UPDATE_URL: value });
      expect([value, present.answers.updates]).toEqual([value, NOT_KNOWN]);
      expect([value, present.pinned]).toEqual([value, PINNED_BY_THE_VARIABLE]);
    }
  });

  test("update settings in config.json that cannot be understood make where new versions come from not known, and decide no answer by a variable", async () => {
    const paths = await root();
    for (const updates of [
      { from: "elsewhere" },
      { address: "https://files.northstar.example/hx" },
      { from: "own-address", address: "http://files.northstar.example/hx" },
      { from: "own-address", address: "https://files.northstar.example/hx#" },
      { securityFixes: "yes" },
      "own-address",
    ]) {
      await writeConfigJson(paths, { updates });
      const present = await read(paths, {});
      // Never the project's releases: the settings may have turned away from them.
      expect([updates, present.answers.updates]).toEqual([updates, NOT_KNOWN]);
      expect([updates, present.pinned]).toEqual([updates, {}]);
    }
    // While HX Fortress runs with no address in its environment, config.json
    // is what it goes by, so it is the same.
    await running(paths, null);
    const present = await read(paths, { FORTRESS_UPDATE_URL: "https://other.northstar.example/x" });
    expect(present.answers.updates).toEqual(NOT_KNOWN);
    expect(present.pinned).toEqual({});
  });

  test("the address the running HX Fortress was started with is the answer, whatever this terminal's own variable says", async () => {
    const paths = await root();
    await writeConfigJson(paths, { updates: { from: "own-address", address: "https://files.northstar.example/hx-fortress" } });
    await running(paths, { value: "https://mirror.northstar.example/f" });
    for (const env of [
      {},
      { FORTRESS_UPDATE_URL: "https://other.northstar.example/x" },
      { FORTRESS_UPDATE_URL: "http://files.northstar.example/hx" },
    ]) {
      const present = await read(paths, env);
      expect([env, present.answers.updates]).toEqual([
        env,
        { securityFixes: "off", from: "own-address", address: "https://mirror.northstar.example/f" },
      ]);
      expect([env, present.pinned]).toEqual([env, PINNED_BY_THE_VARIABLE]);
    }
  });

  test("a running HX Fortress with no address in its environment goes by config.json or the project's releases, and this terminal's own variable is not followed", async () => {
    const paths = await root();
    await running(paths, null);
    const envs = [
      {},
      { FORTRESS_UPDATE_URL: "https://other.northstar.example/x" },
      // A wrong value in this terminal is this terminal's own, and changes nothing either.
      { FORTRESS_UPDATE_URL: "http://files.northstar.example/hx" },
    ];
    for (const env of envs) {
      const present = await read(paths, env);
      expect([env, present.answers.updates]).toEqual([env, { securityFixes: "off", from: "project-releases", address: "" }]);
      expect([env, present.pinned]).toEqual([env, {}]);
    }
    await writeConfigJson(paths, { updates: { from: "own-address", address: "https://files.northstar.example/hx-fortress" } });
    for (const env of envs) {
      const present = await read(paths, env);
      expect([env, present.answers.updates]).toEqual([
        env,
        { securityFixes: "off", from: "own-address", address: "https://files.northstar.example/hx-fortress" },
      ]);
      expect([env, present.pinned]).toEqual([env, {}]);
    }
  });

  test("a running HX Fortress whose environment named a value that cannot be followed makes where new versions come from not known", async () => {
    const paths = await root();
    for (const updateUrl of [
      { invalid: "FORTRESS_UPDATE_URL must use https: (cleartext http: is only allowed to a loopback host)" },
      // The file was changed after HX Fortress wrote it: it is held to the rule again.
      { value: "http://files.northstar.example/hx" },
      { value: 7 },
    ]) {
      await running(paths, updateUrl);
      const present = await read(paths, { FORTRESS_UPDATE_URL: "https://other.northstar.example/x" });
      expect([updateUrl, present.answers.updates]).toEqual([updateUrl, NOT_KNOWN]);
      expect([updateUrl, present.pinned]).toEqual([updateUrl, PINNED_BY_THE_VARIABLE]);
    }
  });

  test("an HX Fortress that last ran with an address in its environment, and does not run now: the answers are what config.json holds, and no variable is said to decide", async () => {
    // Whether the variable is still set where HX Fortress starts cannot be
    // told from a terminal that does not have it. No setting is wrong, so the
    // answer is not "cannot be read", and no variable is known to decide, so
    // nothing is pinned: a settings file may name the source. The Updates
    // check says what is not known (setup-checks.test.ts).
    const paths = await root();
    await startedWith(paths, { value: "https://mirror.northstar.example/f" });
    // No status file: nothing runs. config.json names no source.
    const stopped = await read(paths, {});
    expect(stopped.answers.updates).toEqual({ securityFixes: "off", from: "project-releases", address: "" });
    expect(stopped.pinned).toEqual({});
    // A status file that says it stopped: the same.
    await publishStatus(paths, [], { pid: DAEMON_PID, state: "stopped" });
    expect((await read(paths, {})).answers.updates).toEqual({ securityFixes: "off", from: "project-releases", address: "" });
    expect((await read(paths, {})).pinned).toEqual({});
    // A daemon runs, and the record is not its own (it could not write one):
    // what it runs with is not known either, and the answers say no more.
    await publishStatus(paths, [], { pid: DAEMON_PID + 1 });
    expect((await read(paths, {})).pinned).toEqual({});
    await publishStatus(paths, [], { pid: DAEMON_PID, state: "stopped" });
    // The variable given in this terminal says which.
    const given = await read(paths, { FORTRESS_UPDATE_URL: "https://mirror.northstar.example/f" });
    expect(given.answers.updates).toEqual({
      securityFixes: "off",
      from: "own-address",
      address: "https://mirror.northstar.example/f",
    });
    expect(given.pinned).toEqual(PINNED_BY_THE_VARIABLE);
    // config.json that names another address than the stopped daemon's: that
    // address is the answer, and it is config.json's own to change.
    await writeConfigJson(paths, { updates: { from: "own-address", address: "https://files.northstar.example/hx" } });
    const other = await read(paths, {});
    expect(other.answers.updates).toEqual({
      securityFixes: "off",
      from: "own-address",
      address: "https://files.northstar.example/hx",
    });
    expect(other.pinned).toEqual({});
    // config.json that names the same address leaves nothing in doubt.
    await writeConfigJson(paths, { updates: { from: "own-address", address: "https://mirror.northstar.example/f" } });
    const agreed = await read(paths, {});
    expect(agreed.answers.updates).toEqual({
      securityFixes: "off",
      from: "own-address",
      address: "https://mirror.northstar.example/f",
    });
    expect(agreed.pinned).toEqual({});
    // And a block of config.json that cannot be read is still said as that,
    // with no variable to blame.
    await writeConfigJson(paths, { updates: { from: "elsewhere" } });
    const unreadable = await read(paths, {});
    expect(unreadable.answers.updates).toEqual(NOT_KNOWN);
    expect(unreadable.pinned).toEqual({});
  });

  test("an HX Fortress that last ran with no address in its environment is no reason to doubt config.json or the project's releases", async () => {
    const paths = await root();
    await startedWith(paths, null);
    const present = await read(paths, {});
    expect(present.answers.updates).toEqual({ securityFixes: "off", from: "project-releases", address: "" });
    expect(present.pinned).toEqual({});
  });

  test("an address of new versions that config.json names is an answer, and is written back as it was read", async () => {
    const paths = await root();
    await mkdir(path.dirname(paths.config), { recursive: true });
    await writeFile(
      paths.config,
      JSON.stringify({ updates: { from: "own-address", address: "https://files.northstar.example/hx-fortress" } }),
    );
    const present = await read(paths, {});
    expect(present.pinned).toEqual({});
    expect(present.answers.updates).toEqual({
      securityFixes: "off",
      from: "own-address",
      address: "https://files.northstar.example/hx-fortress",
    });
    // A new install's setup writes every question. The source it read stays.
    const run = await SetupRun.open(await runDeps(paths));
    northstar(run);
    const result = await run.finish("terminal");
    expect(result.ok).toBe(true);
    expect((await rawConfig(paths)).updates).toEqual({
      from: "own-address",
      address: "https://files.northstar.example/hx-fortress",
    });
  });

  test("the Updates page says where new versions come from, and never names a control plane", async () => {
    const paths = await root();
    const from = async (
      config: unknown,
      env: Record<string, string> = {},
    ): Promise<{ value: string; note: string; ok: boolean | null }> => {
      await rm(paths.config, { force: true });
      if (config) await writeConfigJson(paths, config);
      const run = await SetupRun.open(await runDeps(paths, { env }));
      // A control plane is named: it changes nothing about where a new version comes from.
      run.takeFile(JSON.stringify({ controlPlane: { address: "control.example", connected: true } }));
      const fact = (await run.frame()).facts.updates.find((line) => line.label === "From");
      return { value: fact?.value ?? "", note: fact?.note ?? "", ok: fact?.ok ?? null };
    };
    expect(await from(null)).toEqual({ value: "GitHub releases", note: "github.com/HX-Framework/hx-fortress", ok: null });
    expect(await from({ updates: { from: "own-address", address: "https://files.northstar.example/hx-fortress" } })).toEqual({
      value: "An address this host names",
      note: "https://files.northstar.example/hx-fortress",
      ok: null,
    });
    expect(await from(null, { FORTRESS_UPDATE_URL: "https://mirror.northstar.example/f" })).toEqual({
      value: "An address this host names",
      note: "https://mirror.northstar.example/f, set by FORTRESS_UPDATE_URL",
      ok: null,
    });
    // Settings that cannot be understood are said as such, with where they are put right.
    expect(await from({ updates: { from: "elsewhere" } })).toEqual({
      value: "Not known",
      note: "config.json's update settings cannot be read",
      ok: false,
    });
    expect(await from(null, { FORTRESS_UPDATE_URL: "http://files.northstar.example/hx" })).toEqual({
      value: "Not known",
      note: "FORTRESS_UPDATE_URL cannot be understood",
      ok: false,
    });
  });

  test("no page sets where new versions come from: it is named on the host", async () => {
    const paths = await root();
    const run = await SetupRun.open(await runDeps(paths));
    expect(run.set("updates.from", "own-address")).toBe(false);
    expect(run.set("updates.address", "https://elsewhere.example/hx-fortress")).toBe(false);
    expect(run.answers.updates).toEqual({ securityFixes: "off", from: "project-releases", address: "" });
    // A settings file, which a command on the host takes, names it.
    expect(
      run.takeFile(
        JSON.stringify({ updates: { from: "own-address", address: "https://files.northstar.example/hx-fortress" } }),
      ).ok,
    ).toBe(true);
    expect(run.answers.updates.address).toBe("https://files.northstar.example/hx-fortress");
  });
});

// ── Which control plane an enrollment belongs to ─────────────────────────────

describe("an enrollment belongs to one control plane", () => {
  const pending = (paths: Paths) => new FilePendingEnrollmentStore(paths.pendingEnrollment);
  const credential = (paths: Paths) => new FileCredentialStore(paths.credentials);

  /** An HX Fortress set up with an install id for control.example, which has
   *  connected once: the id is spent, and a credential is held. */
  async function enrolled(paths: Paths): Promise<void> {
    const run = await SetupRun.open(runDeps(paths, { connect: CONNECT }));
    northstar(run);
    await finished(run);
    expect(await pending(paths).load()).toEqual({ token: INSTALL_ID, cloudUrl: CONTROL });
    await pending(paths).clear();
    await credential(paths).save({ orgId: "org-northstar", fortressId: "hx-1", credential: A_KEY });
  }

  async function nameNone(paths: Paths): Promise<void> {
    const run = await SetupRun.open(runDeps(paths));
    run.set("controlPlane.connect", "no");
    await finished(run);
  }

  test("naming none keeps the enrollment, and writes down which control plane it belongs to", async () => {
    const paths = await root();
    await enrolled(paths);
    await nameNone(paths);
    expect((await rawConfig(paths)).cloud).toBeUndefined();
    expect((await readSetupMark(paths))?.disconnectedFrom).toBe(CONTROL);
    expect(await credential(paths).load()).not.toBeNull();
    // The enrollment is still there, so the answer is that control plane,
    // switched off. Only removing the enrollment by hand ends it.
    expect((await read(paths)).answers.controlPlane).toMatchObject({
      connect: "yes",
      address: "control.example",
      connected: "off",
    });
    // And every later end of the setup carries it forward.
    const later = await SetupRun.open(runDeps(paths));
    later.set("organization.name", "Northstar Ltd");
    await finished(later);
    expect((await readSetupMark(paths))?.disconnectedFrom).toBe(CONTROL);
  });

  test("another control plane is refused until a person removes the enrollment by hand", async () => {
    const paths = await root();
    await enrolled(paths);
    await nameNone(paths);
    const run = await SetupRun.open(runDeps(paths, { connect: { address: "other.example", id: INSTALL_ID } }));
    const check = await run.check("controlPlane");
    expect(check.ok).toBe(false);
    expect(check.lines[0]?.text).toBe(
      "This HX Fortress is enrolled with another control plane. To connect it here, stop it, remove the folder " +
        `${path.dirname(paths.credentials)}, and give an install id for this control plane. It then enrolls as a new HX Fortress`,
    );
    // Nothing is written, and HX Fortress stays with nobody.
    expect((await run.finish("terminal")).ok).toBe(false);
    expect((await rawConfig(paths)).cloud).toBeUndefined();
    expect(await pending(paths).load()).toBeNull();
  });

  test("the same control plane connects again with no new install id", async () => {
    const paths = await root();
    await enrolled(paths);
    await nameNone(paths);
    const run = await SetupRun.open(runDeps(paths));
    run.set("controlPlane.connected", "on");
    expect((await run.check("controlPlane")).lines).toEqual([{ ok: true, text: "This HX Fortress is enrolled there" }]);
    await finished(run);
    expect((await rawConfig(paths)).cloud).toEqual({ url: CONTROL });
    expect((await readSetupMark(paths))?.disconnectedFrom).toBeUndefined();
    expect(await pending(paths).load()).toBeNull();
  });

  test("an enrollment that nothing on the host explains is refused, whatever the address", async () => {
    const paths = await root();
    const first = await SetupRun.open(runDeps(paths));
    northstar(first);
    await finished(first);
    await credential(paths).save({ orgId: "org", fortressId: "hx", credential: A_KEY });
    const run = await SetupRun.open(runDeps(paths, { connect: CONNECT }));
    const check = await run.check("controlPlane");
    expect(check.ok).toBe(false);
    expect(check.lines[0]?.text).toStartWith(
      "This HX Fortress holds an enrollment, and its settings do not say with which control plane.",
    );
  });

  test("an install id is used even when no answer changed: the settings named a control plane that HX Fortress held no enrollment for", async () => {
    const paths = await root();
    await enrolled(paths);
    // The enrollment is gone, and config.json still names the control plane.
    await unlink(paths.credentials);
    const stale = await SetupRun.open(runDeps(paths));
    expect(stale.changedSteps()).toEqual([]);
    expect((await stale.check("controlPlane")).ok).toBe(false);
    const run = await SetupRun.open(runDeps(paths, { connect: CONNECT }));
    expect(run.changedSteps()).toEqual([]);
    expect((await run.check("controlPlane")).lines).toEqual([
      { ok: true, text: "An install id is held for the first connection" },
    ]);
    await finished(run);
    expect(await pending(paths).load()).toEqual({ token: INSTALL_ID, cloudUrl: CONTROL });
  });

  test("an install id that cannot be kept leaves the settings saved, and a line says what to do", async () => {
    const paths = await root();
    // Something is in the way of the file the id is kept in.
    await mkdir(paths.pendingEnrollment, { recursive: true });
    const run = await SetupRun.open(runDeps(paths, { connect: CONNECT }));
    northstar(run);
    const result = await run.finish("terminal");
    expect(result.ok).toBe(true);
    // config.json is whole: HX Fortress is set up, and simply not enrolled yet.
    expect((await rawConfig(paths)).cloud).toEqual({ url: CONTROL });
    expect(await isSetUp(paths)).toBe(true);
    expect(result.ok && result.applied.notes.join(" ")).toContain("Give it again: hx-fortress setup --connect <address>/i/<id>");
    expect(JSON.stringify(result)).not.toContain(INSTALL_ID);
  });

  test("an HX Fortress enrolled at the earlier path is enrolled there: nothing changes, and its address is kept byte for byte", async () => {
    const paths = await root();
    await mkdir(path.dirname(paths.config), { recursive: true });
    await writeFile(
      paths.config,
      JSON.stringify({
        schemaVersion: 1,
        cloud: { url: EARLIER_CONTROL },
        gateway: { publicUrl: "http://localhost:8787" },
        modules: { enabled: [] },
        moduleDefaultsApplied: 1,
        organization: { name: "Northstar" },
      }),
    );
    await credential(paths).save({ orgId: "org-northstar", fortressId: "hx-1", credential: A_KEY });
    const run = await SetupRun.open(runDeps(paths));
    expect(run.answers.controlPlane).toMatchObject({ connect: "yes", address: "control.example", connected: "on" });
    expect(run.changedSteps()).toEqual([]);
    expect((await run.check("controlPlane")).lines).toEqual([{ ok: true, text: "This HX Fortress is enrolled there" }]);
    await finished(run);
    expect((await rawConfig(paths)).cloud).toEqual({ url: EARLIER_CONTROL });
    // A change to the control plane's own answers writes the address it enrolled at, not this build's path.
    const pages = await SetupRun.open(runDeps(paths));
    pages.set("controlPlane.pages", "https://app.control.example");
    await finished(pages);
    expect((await rawConfig(paths)).cloud).toEqual({ url: EARLIER_CONTROL });
    // Another host is still another control plane.
    const other = await SetupRun.open(runDeps(paths));
    other.set("controlPlane.address", "other.example");
    expect((await other.check("controlPlane")).ok).toBe(false);
  });

  test("an install id that waits at the earlier path's address is the first connection's", async () => {
    const paths = await root();
    await pending(paths).save({ token: INSTALL_ID, cloudUrl: EARLIER_CONTROL });
    const run = await SetupRun.open(runDeps(paths));
    northstar(run);
    run.set("controlPlane.connect", "yes");
    run.set("controlPlane.address", "control.example");
    expect((await run.check("controlPlane")).ok).toBe(true);
    await finished(run);
    expect((await rawConfig(paths)).cloud).toEqual({ url: EARLIER_CONTROL });
    expect(await pending(paths).load()).toEqual({ token: INSTALL_ID, cloudUrl: EARLIER_CONTROL });
  });
});

// ── The connection, switched off and on ──────────────────────────────────────

describe("the connection to the control plane is switched off and on", () => {
  const pending = (paths: Paths) => new FilePendingEnrollmentStore(paths.pendingEnrollment);
  const credential = (paths: Paths) => new FileCredentialStore(paths.credentials);

  test("off takes the control plane out of config.json, keeps the credential, and writes its address into the mark", async () => {
    const paths = await root();
    const first = await SetupRun.open(runDeps(paths, { connect: CONNECT }));
    northstar(first);
    first.set("controlPlane.pages", "https://app.control.example");
    await finished(first);
    await pending(paths).clear();
    await credential(paths).save({ orgId: "org-northstar", fortressId: "hx-1", credential: A_KEY });

    const off = await SetupRun.open(runDeps(paths));
    expect(off.answers.controlPlane).toEqual({
      connect: "yes",
      address: "control.example",
      token: "",
      connected: "on",
      pages: "https://app.control.example",
    });
    expect(off.set("controlPlane.connected", "off")).toBe(true);
    await finished(off);
    const raw = await rawConfig(paths);
    expect(raw.cloud).toBeUndefined();
    // The pages stay a setting of their own, which no page is shown by while off.
    expect(raw.controlPlane).toEqual({ pages: "https://app.control.example" });
    expect(await credential(paths).load()).not.toBeNull();
    expect((await readSetupMark(paths))?.disconnectedFrom).toBe(CONTROL);
    expect((await new FileConfigStore(paths).load()).cloud).toBeUndefined();

    // Read again, it is the same control plane, switched off.
    const present = await read(paths);
    expect(present.answers.controlPlane).toEqual({
      connect: "yes",
      address: "control.example",
      token: "",
      connected: "off",
      pages: "https://app.control.example",
    });
    expect(present.disconnectedFrom).toBe(CONTROL);

    // On again: the same address, and no install id is asked for.
    const on = await SetupRun.open(runDeps(paths));
    on.set("controlPlane.connected", "on");
    await finished(on);
    expect((await rawConfig(paths)).cloud).toEqual({ url: CONTROL });
    expect((await readSetupMark(paths))?.disconnectedFrom).toBeUndefined();
    expect((await read(paths)).answers.controlPlane.connected).toBe("on");
  });

  test("an install id that waits is kept while the connection is only switched off, and removed when no control plane is named", async () => {
    const paths = await root();
    const first = await SetupRun.open(runDeps(paths, { connect: CONNECT }));
    northstar(first);
    await finished(first);
    expect(await pending(paths).load()).toEqual({ token: INSTALL_ID, cloudUrl: CONTROL });

    const off = await SetupRun.open(runDeps(paths));
    off.set("controlPlane.connected", "off");
    await finished(off);
    expect((await rawConfig(paths)).cloud).toBeUndefined();
    expect(await pending(paths).load()).toEqual({ token: INSTALL_ID, cloudUrl: CONTROL });
    expect((await read(paths)).answers.controlPlane).toMatchObject({ connect: "yes", address: "control.example", connected: "off" });

    // Named no more: the id goes, and nothing is left that names a control plane.
    const none = await SetupRun.open(runDeps(paths));
    none.set("controlPlane.connect", "no");
    await finished(none);
    expect(await pending(paths).load()).toBeNull();
    expect((await rawConfig(paths)).cloud).toBeUndefined();
    expect((await readSetupMark(paths))?.disconnectedFrom).toBeUndefined();
    expect((await read(paths)).answers.controlPlane.connect).toBe("no");
  });

  test("switched on again, an install id that waited is the first connection's", async () => {
    const paths = await root();
    const first = await SetupRun.open(runDeps(paths, { connect: CONNECT }));
    northstar(first);
    await finished(first);
    const off = await SetupRun.open(runDeps(paths));
    off.set("controlPlane.connected", "off");
    await finished(off);
    const on = await SetupRun.open(runDeps(paths));
    on.set("controlPlane.connected", "on");
    expect((await on.check("controlPlane")).lines).toEqual([
      { ok: true, text: "An install id is held for the first connection. This HX Fortress connects when it starts" },
    ]);
    await finished(on);
    expect((await rawConfig(paths)).cloud).toEqual({ url: CONTROL });
    expect(await pending(paths).load()).toEqual({ token: INSTALL_ID, cloudUrl: CONTROL });
    expect((await readSetupMark(paths))?.disconnectedFrom).toBeUndefined();
  });

  test("the control plane in the environment pins the answer only while no credential is held", async () => {
    const paths = await root();
    const env = { FORTRESS_CLOUD_URL: CONTROL, FORTRESS_ENROLL_TOKEN: INSTALL_ID };
    const before = await read(paths, env);
    expect(before.answers.controlPlane).toMatchObject({ connect: "yes", address: "control.example", connected: "on" });
    expect(before.pinned).toEqual({
      "controlPlane.connect": "FORTRESS_CLOUD_URL",
      "controlPlane.address": "FORTRESS_CLOUD_URL",
    });
    await credential(paths).save({ orgId: "org-northstar", fortressId: "hx-1", credential: A_KEY });
    const after = await read(paths, env);
    expect(after.pinned).toEqual({});
    // From then on the answer is config.json's, which names none here.
    expect(after.answers.controlPlane.connect).toBe("no");
    // One variable alone pins nothing.
    await unlink(paths.credentials);
    expect((await read(paths, { FORTRESS_CLOUD_URL: CONTROL })).pinned).toEqual({});
  });
});

// ── When an HX Fortress counts as set up ─────────────────────────────────────

describe("an HX Fortress is set up when its config.json is its own", () => {
  test("a file that holds only the key store's block is not one, and the setup keeps the block", async () => {
    const paths = await root();
    const folder = path.join(paths.root, "keys");
    await mkdir(folder, { recursive: true });
    await mkdir(path.dirname(paths.config), { recursive: true });
    await writeFile(paths.config, JSON.stringify({ secrets: { provider: "file", dir: folder } }));
    expect(await isSetUp(paths)).toBe(false);
    expect(await needsSetupFirst(paths, {})).toBe(true);

    const run = await SetupRun.open(runDeps(paths, { check: { ...runDeps(paths).check, keyStore: undefined } }));
    expect(run.present.setUp).toBe(false);
    expect(run.answers.keys).toMatchObject({ store: "file", folder });
    // A new install's modules: the ones this build switches on.
    expect(run.answers.modules).toEqual({ session_vault: false, host: true, databases: true, stores: false });
    northstar(run);
    await finished(run);

    const raw = await rawConfig(paths);
    expect(raw.schemaVersion).toBe(1);
    expect(raw.secrets).toEqual({ provider: "file", dir: folder });
    expect(raw.organization).toEqual({ name: "Northstar" });
    expect(await isSetUp(paths)).toBe(true);
    expect(await needsSetupFirst(paths, {})).toBe(false);
  });

  test("a file that cannot be read counts as set up, so nothing writes over it", async () => {
    const paths = await root();
    await mkdir(path.dirname(paths.config), { recursive: true });
    await writeFile(paths.config, "{not json");
    expect(await isSetUp(paths)).toBe(true);
    expect(await needsSetupFirst(paths, {})).toBe(false);
    expect(await readFile(paths.config, "utf8")).toBe("{not json");
  });

  test("the check of a change and the write of it are one function, and fill in what every config.json has", async () => {
    const paths = await root();
    const ahead = { secrets: { provider: "env" } };
    const merged = mergeConfigPatch(ahead, { organization: { name: "Northstar" } });
    expect(merged.next).toMatchObject({ schemaVersion: 1, modules: { enabled: [] }, secrets: { provider: "env" } });
    expect(merged.checked.organization).toEqual({ name: "Northstar" });

    await mkdir(path.dirname(paths.config), { recursive: true });
    await writeFile(paths.config, JSON.stringify(ahead));
    await patchConfig(paths, { organization: { name: "Northstar" } });
    expect(await rawConfig(paths)).toEqual(merged.next);
  });
});

// ── What a check may do ──────────────────────────────────────────────────────

async function checkDeps(paths: Paths, over: Partial<CheckDeps> = {}): Promise<CheckDeps> {
  const env = over.env ?? {};
  return {
    paths,
    env,
    present: await read(paths, env),
    keyStore: () => fixedSecrets({ "db-url": DB_URL, "model-key": A_KEY, "sign-in-client-secret": A_KEY }),
    fetch: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    probeDatabase: async () => "PostgreSQL 17.2",
    probeFiles: async () => {},
    timeoutMs: 2_000,
    ...over,
  };
}

function answers(change: (a: SetupAnswers) => void = () => {}): SetupAnswers {
  const a = defaultAnswers(MODULES);
  a.organization = { name: "Northstar", firstAdministrator: "marta.lindqvist" };
  change(a);
  return a;
}

const sessions = (a: SetupAnswers): void => {
  a.modules.session_vault = true;
  a.model = { ...a.model, provider: "openai", address: "https://models.northstar.example/v1", key: "model-key" };
  a.data.files = { ...a.data.files, store: "s3-compatible", address: "https://minio.northstar.example", bucket: "northstar-hx-fortress" };
};

/** Every answer that names something outside: a vault, a provider, a database, a model, a file store. */
const everything = (a: SetupAnswers): void => {
  sessions(a);
  a.keys = { ...a.keys, store: "azure-key-vault", address: "https://northstar-hx-fortress.vault.azure.net" };
  a.signIn = {
    ...a.signIn,
    provider: "openid-connect",
    issuer: "https://login.northstar.example",
    clientId: "hx-fortress",
    clientSecret: "sign-in-client-secret",
    administratorGroups: ["hx-fortress-admins"],
  };
  a.data.database = { store: "existing", address: "db-url" };
};

/** A key store, a network and the probes, each writing down what it was asked. */
function watched(): {
  asked: string[];
  outside: string[];
  over: Partial<CheckDeps>;
} {
  const asked: string[] = [];
  const outside: string[] = [];
  const store: SecretProvider = {
    kind: "azure-key-vault",
    get: async (name) => {
      asked.push(`get ${name}`);
      return name === "db-url" ? DB_URL : A_KEY;
    },
    has: async (name) => {
      asked.push(`has ${name}`);
      return true;
    },
  };
  return {
    asked,
    outside,
    over: {
      keyStore: () => store,
      fetch: (async (input: unknown) => {
        outside.push(String(input));
        return String(input).endsWith("/.well-known/openid-configuration")
          ? Response.json(providerDocument("https://login.northstar.example"))
          : Response.json({ data: [{ embedding: [0.1] }] });
      }) as unknown as typeof fetch,
      probeDatabase: async () => {
        outside.push("the database");
        return "PostgreSQL 17.2";
      },
      probeFiles: async () => {
        outside.push("the file store");
      },
    },
  };
}

describe("what a check may do, in each of its modes", () => {
  const STEPS = ["keys", "signIn", "data", "model", "network"] as const;

  test("typing: no request leaves this host and nothing is opened", async () => {
    const paths = await root();
    const seen = watched();
    const deps = await checkDeps(paths, { when: "typing", ...seen.over });
    for (const step of STEPS) {
      const check = await checkStep(step, answers(everything), deps);
      expect([step, check.ok]).toEqual([step, true]);
    }
    expect(seen.outside).toEqual([]);
    expect(seen.asked).toEqual([]);
    // What the host can see by itself is still said: the shape of an answer.
    const wrong = await checkStep("data", answers((a) => {
      a.data.database = { store: "existing", address: "Not A Name" };
    }), deps);
    expect(texts(wrong.lines)).toEqual(["Not a key's name"]);
  });

  test("start: no request leaves this host, and a key store that is not on this host is asked nothing", async () => {
    const paths = await root();
    const seen = watched();
    const deps = await checkDeps(paths, { when: "start", ...seen.over });
    for (const step of STEPS) {
      const check = await checkStep(step, answers(everything), deps);
      expect([step, check.ok]).toEqual([step, true]);
    }
    expect(seen.outside).toEqual([]);
    expect(seen.asked).toEqual([]);
    // A key store on this host is asked whether each named key is there, and for no value.
    const here = watched();
    const onHost = await checkDeps(paths, { when: "start", ...here.over });
    for (const step of STEPS) {
      await checkStep(step, answers((a) => {
        everything(a);
        a.keys = { ...a.keys, store: "env", address: "" };
      }), onHost);
    }
    expect(here.outside).toEqual([]);
    expect(here.asked.sort()).toEqual(["has db-url", "has model-key", "has sign-in-client-secret"]);
  });

  test("checkup: no key's value is read and the model is asked nothing; the sign-in provider is asked whether it is there", async () => {
    const paths = await root();
    const seen = watched();
    const deps = await checkDeps(paths, { when: "checkup", ...seen.over });
    for (const step of STEPS) {
      const check = await checkStep(step, answers(everything), deps);
      expect([step, check.ok]).toEqual([step, true]);
    }
    expect(seen.asked.filter((line) => line.startsWith("get "))).toEqual([]);
    expect(seen.asked.sort()).toEqual(["has db-url", "has model-key", "has sign-in-client-secret"]);
    expect(seen.outside).toEqual(["https://login.northstar.example/.well-known/openid-configuration"]);
  });

  test("given: each check does the real thing", async () => {
    const paths = await root();
    const seen = watched();
    const deps = await checkDeps(paths, { when: "given", ...seen.over });
    for (const step of STEPS) {
      const check = await checkStep(step, answers(everything), deps);
      expect([step, check.ok]).toEqual([step, true]);
    }
    expect(seen.outside).toContain("the database");
    expect(seen.outside).toContain("the file store");
    expect(seen.outside).toContain("https://models.northstar.example/v1/embeddings");
    expect(seen.asked).toContain("get db-url");
    expect(seen.asked).toContain("get model-key");
  });

  test("an address that holds a user name or a password is refused, so no credential is written down with it", async () => {
    const paths = await root();
    const model = await checkStep(
      "model",
      answers((a) => {
        sessions(a);
        a.model.address = "https://user:token@models.northstar.example/v1";
      }),
      await checkDeps(paths),
    );
    expect(texts(model.lines)).toEqual(["The model's address must be https, with no user name or password in it"]);
    const files = await checkStep(
      "data",
      answers((a) => {
        sessions(a);
        a.data.files.address = "https://access:secret@minio.northstar.example";
      }),
      await checkDeps(paths),
    );
    expect(texts(files.lines)).toContain("The storage's address must be https, with no user name or password in it");
  });

  test("a sign-in provider the console would refuse is refused here, by the console's own rules", async () => {
    const paths = await root();
    const issuer = "https://login.northstar.example";
    const check = await checkStep(
      "signIn",
      answers((a) => {
        a.signIn = { ...a.signIn, provider: "openid-connect", issuer, clientId: "hx-fortress", administratorGroups: ["hx-fortress-admins"] };
      }),
      await checkDeps(paths, {
        // It names the right issuer, and gives a token address that is not https.
        fetch: (async () =>
          Response.json({ ...providerDocument(issuer), token_endpoint: "http://login.northstar.example/token" })) as unknown as typeof fetch,
      }),
    );
    expect(check.ok).toBe(false);
    expect(texts(check.lines)).toEqual([
      "The provider at this address cannot sign people in to this console: the discovery document lacks an https authorization, token or key endpoint",
    ]);
  });

  test("Agentic Sessions with Postgres on this disk needs no control plane: the search extension comes from where new versions come from", async () => {
    const paths = await root();
    const on = answers(sessions);
    const check = await checkStep("data", on, await checkDeps(paths));
    expect(texts(check.lines)).toContain("Postgres runs on this disk, in HX Fortress's folder");
    expect(texts(check.lines).filter((text) => /extension|control plane/.test(text))).toEqual([]);
    // The same answer with a control plane named reads the same.
    const connected = answers((a) => {
      sessions(a);
      a.controlPlane = { ...a.controlPlane, connect: "yes", address: "control.example" };
    });
    expect(texts((await checkStep("data", connected, await checkDeps(paths))).lines)).toEqual(texts(check.lines));
  });

  test("keys an earlier setup kept for the same bucket are the ones the test write uses", async () => {
    const paths = await root();
    const kept: VaultCredentials = {
      store: "s3",
      bucket: "northstar-hx-fortress",
      region: "eu-central-1",
      s3: { accessKeyId: ["AKID", "FOR", "A", "TEST"].join(""), secretAccessKey: A_KEY },
    };
    const present = await readAnswers(paths, {}, { vaultCredentials: async () => kept });
    expect(present.kept.filesKeys).toBe(true);
    const on = structuredClone(present.answers);
    on.organization = { name: "Northstar", firstAdministrator: "marta.lindqvist" };
    on.modules.session_vault = true;
    const tried: VaultCredentials[] = [];
    const deps = await checkDeps(paths, {
      present,
      vaultCredentials: async () => kept,
      probeFiles: async (credentials) => {
        tried.push(credentials);
      },
    });
    const same = await checkStep("data", on, deps);
    expect(texts(same.lines)).toContain("A test file was written, read and removed");
    expect(tried).toEqual([kept]);
    // Another bucket is tested with this host's own access, and no key.
    const moved = structuredClone(on);
    moved.data.files.bucket = "another-bucket";
    await checkStep("data", moved, deps);
    expect(tried[1]).toEqual({ store: "s3", bucket: "another-bucket", region: "eu-central-1" });
    expect(JSON.stringify(same)).not.toContain(A_KEY);
  });

  test("the model is asked what HX Fortress will ask: one function gives the address, the name and the size", async () => {
    const paths = await root();
    const sent: { url: string; body: unknown; key: string | null }[] = [];
    const check = await checkStep(
      "model",
      answers(sessions),
      await checkDeps(paths, {
        env: { FORTRESS_EMBED_DIMENSIONS: "512" },
        fetch: (async (input: unknown, init?: RequestInit) => {
          sent.push({
            url: String(input),
            body: JSON.parse(String(init?.body)),
            key: new Headers(init?.headers).get("authorization"),
          });
          return Response.json({ data: [{ embedding: [0.1] }] });
        }) as unknown as typeof fetch,
      }),
    );
    expect(check.ok).toBe(true);
    expect(sent).toEqual([
      {
        url: "https://models.northstar.example/v1/embeddings",
        body: { model: "text-embedding-3-large", input: ["ready"], dimensions: 512 },
        key: `Bearer ${A_KEY}`,
      },
    ]);
    expect(JSON.stringify(check)).not.toContain(A_KEY);
  });

  test("a question that passed a moment ago is not asked of the outside again, and a refused one is", async () => {
    const paths = await root();
    let probes = 0;
    let reachable = true;
    const deps = runDeps(paths);
    const run = await SetupRun.open({
      ...deps,
      check: {
        ...deps.check,
        probeDatabase: async () => {
          probes += 1;
          if (!reachable) throw new Error("ECONNREFUSED");
          return "PostgreSQL 17.2";
        },
      },
    });
    northstar(run);
    run.set("data.database.store", "existing");
    run.set("data.database.address", "db-url");
    // The question, the last step's checks and the end, one after another.
    expect((await run.check("data")).ok).toBe(true);
    expect((await run.checkAll()).find((check) => check.step === "data")?.ok).toBe(true);
    expect((await run.check("data")).ok).toBe(true);
    expect(probes).toBe(1);
    // Another answer is another question.
    run.set("organization.name", "Northstar Ltd");
    await run.check("data");
    expect(probes).toBe(2);
    // A refused answer is asked about every time: the person is putting it right.
    reachable = false;
    run.set("organization.name", "Northstar");
    expect((await run.check("data")).ok).toBe(false);
    expect((await run.check("data")).ok).toBe(false);
    expect(probes).toBe(4);
  });
});
