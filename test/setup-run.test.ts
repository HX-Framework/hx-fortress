import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { runCli } from "../src/cli";
import { runSetupCommand, type SetupCommandDeps } from "../src/cli-setup";
import { FileCredentialStore, FilePendingEnrollmentStore } from "../src/cloud/credentials";
import { FileConfigStore, parseFortressConfig } from "../src/host/config";
import type { VaultCredentials } from "../src/modules/session-vault/credentials";
import { settingsFileText, type SetupAnswers } from "../src/setup/answers";
import { SETUP_LIST, stepNumber } from "../src/setup/list";
import { readAnswers } from "../src/setup/read";
import { linkIsElsewhere, SetupRun } from "../src/setup/run";
import { NOT_SET_UP, readSetupMark } from "../src/setup/state";
import { runTerminalSetup, type TerminalIo } from "../src/setup/terminal";
import { BOOTSTRAP_TOKEN_DIGEST_ENV, BOOTSTRAP_TOKEN_EXPIRES_ENV, bootstrapLinkPath } from "../src/ui/bootstrap-user";
import { UiConfigStore } from "../src/ui/config";
import { OidcConfigStore } from "../src/ui/oidc-config";
import { UsersStore } from "../src/ui/users";
import { spoolRecords, tempRoot, type Paths } from "./host/_module-rig";
import { CONTROL, controlPlane, DB_URL, northstar, providerDocument, rawConfig, runDeps, TOKEN, vault } from "./setup-rig";

// The client id of a made-up managed identity. An identifier, not a key. It is
// put together at run time so that nothing key-shaped sits in the repository.
const IDENTITY = ["0f3a9b7c", "1d2e", "4f5a", "8b6c", "7d8e9f0a1b2c"].join("-");

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

describe("a new install", () => {
  test("is not set up, and every question starts on its plain answer", async () => {
    const paths = await root();
    const present = await readAnswers(paths, {}, { vaultCredentials: async () => null });
    expect(present.setUp).toBe(false);
    expect(present.pinned).toEqual({});
    expect(present.answers.controlPlane.connect).toBe("no");
    expect(present.answers.modules).toEqual({ session_vault: false, host: false, databases: false });
  });

  test("finishing writes a config with no control plane, which the host accepts", async () => {
    const paths = await root();
    const run = await SetupRun.open(runDeps(paths));
    northstar(run);
    const result = await run.finish("terminal");
    expect(result.ok).toBe(true);

    const raw = await rawConfig(paths);
    expect(raw.cloud).toBeUndefined();
    expect(raw.organization).toEqual({ name: "Northstar" });
    expect(raw.secrets).toEqual({ provider: "env" });
    expect(raw.modules).toEqual({ enabled: [] });
    expect(raw.moduleDefaultsApplied).toBe(1);
    expect(raw.records).toEqual({ keepFor: "until-removed" });
    expect(raw.updates).toEqual({ from: "project-releases", install: "administrator-approves" });
    expect(raw.model).toBeUndefined();
    expect(raw.network).toBeUndefined();

    // The same parser the Fortress starts with reads it, and finds no control plane.
    const config = await new FileConfigStore(paths).load();
    expect(config.cloud).toBeUndefined();
    expect(config.organization).toEqual({ name: "Northstar" });
    expect((await stat(paths.config)).mode & 0o777).toBe(0o600);

    const mark = await readSetupMark(paths);
    expect(mark?.by).toBe("terminal");
    // The console is on, because a person answered how people sign in to it.
    expect((await new UiConfigStore(paths.uiConfig).load()).enabled).toBe(true);
  });

  test("the first administrator gets an account with a one-time link, and no password is involved", async () => {
    const paths = await root();
    const run = await SetupRun.open(runDeps(paths));
    northstar(run);
    const result = await run.finish("terminal");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied.firstAccount?.login).toBe("marta.lindqvist");
    expect(result.applied.firstAccount?.token?.length).toBeGreaterThan(20);
    const users = await new UsersStore(path.join(paths.uiRoot, "users.json")).load();
    expect(users.users).toHaveLength(1);
    expect(users.users[0]).toMatchObject({ login: "marta.lindqvist", role: "operator", pwdHash: null });
    // The token is not written anywhere: only its digest is.
    expect(JSON.stringify(users)).not.toContain(result.applied.firstAccount?.token ?? "none");
  });

  test("a new install with no account asks for the second step at sign-in, and a later run leaves the setting as it is", async () => {
    const paths = await root();
    const run = await SetupRun.open(runDeps(paths));
    northstar(run);
    expect((await run.finish("terminal")).ok).toBe(true);
    const ui = new UiConfigStore(paths.uiConfig);
    expect((await ui.load()).secondStep).toBe("required");

    // An administrator takes it out. The setup, run again, does not put it back.
    await ui.update((config) => ({ ...config, secondStep: "off" }));
    const again = await SetupRun.open(runDeps(paths));
    again.set("organization.name", "Northstar Group");
    expect((await again.finish("terminal")).ok).toBe(true);
    expect((await ui.load()).secondStep).toBe("off");
  });

  test("an install that already has an account keeps its setting, so an account with a password and no app can still sign in", async () => {
    const paths = await root();
    await new UsersStore(path.join(paths.uiRoot, "users.json")).create("erik.holm", "operator");
    const run = await SetupRun.open(runDeps(paths));
    northstar(run);
    expect((await run.finish("terminal")).ok).toBe(true);
    expect((await new UiConfigStore(paths.uiConfig).load()).secondStep).toBe("off");
  });

  test("an answer that is refused stops the end, and nothing is written", async () => {
    const paths = await root();
    const run = await SetupRun.open(runDeps(paths));
    const result = await run.finish("terminal");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.checks.find((c) => c.step === "organization")?.ok).toBe(false);
    expect(await stat(paths.config).then(() => true, () => false)).toBe(false);
    expect(await stat(path.join(paths.uiRoot, "users.json")).then(() => true, () => false)).toBe(false);
  });

  test("a database, sign-in through a provider and a module are written where the Fortress reads them", async () => {
    const paths = await root();
    const provider = (async (input: Parameters<typeof fetch>[0]) =>
      String(input).endsWith("/.well-known/openid-configuration")
        ? Response.json(providerDocument("https://login.northstar.example"))
        : new Response(null, { status: 200 })) as unknown as typeof fetch;
    const deps = runDeps(paths);
    const run = await SetupRun.open({ ...deps, check: { ...deps.check, fetch: provider } });
    northstar(run);
    run.set("data.database.store", "postgres");
    run.set("data.database.address", "db-url");
    run.set("signIn.provider", "openid-connect");
    run.set("signIn.issuer", "https://login.northstar.example");
    run.set("signIn.clientId", "hx-fortress");
    run.set("signIn.operatorGroups", "fortress-admins, data-team");
    run.set("signIn.consoleAddress", "https://fortress.northstar.example");
    run.set("modules.host", true);

    const result = await run.finish("browser");
    expect(result.ok).toBe(true);

    const raw = await rawConfig(paths);
    expect(raw.postgres).toEqual({ urlSecret: "db-url" });
    expect(raw.modules).toEqual({ enabled: ["host"] });
    // The name of the key is written. The address is not, anywhere under the folder.
    expect(JSON.stringify(raw)).not.toContain("pw-for-a-test");

    const oidc = await new OidcConfigStore(path.join(paths.uiRoot, "oidc.json")).load();
    expect(oidc).toMatchObject({
      enabled: true,
      issuer: "https://login.northstar.example",
      clientId: "hx-fortress",
      clientSecretName: null,
      operatorGroups: ["fortress-admins", "data-team"],
    });
    expect((await new UiConfigStore(paths.uiConfig).load()).publicUrl).toBe("https://fortress.northstar.example");
  });
});

describe("the control plane, the last and optional question", () => {
  test("Yes is refused until a person has signed in at the control plane, and the token is kept for the first connection only", async () => {
    const paths = await root();
    const plane = controlPlane();
    const run = await SetupRun.open(runDeps(paths, { enrollment: plane.deps }));
    northstar(run);
    run.set("controlPlane.connect", "yes");
    run.set("controlPlane.address", "control.example");

    expect((await run.finish("terminal")).ok).toBe(false);

    const shown = await run.enroll();
    expect(shown).toMatchObject({ state: "waiting", code: "K7Q-42M", signInHost: "control.example" });
    expect(plane.asked).toEqual(["https://control.example/_api/hx-gateway"]);
    expect((await run.enrollCheck()).state).toBe("waiting");
    expect((await run.finish("terminal")).ok).toBe(false);

    plane.signIn();
    expect((await run.enrollCheck()).state).toBe("ready");
    // Nothing a screen is given holds the token.
    expect(JSON.stringify(run.derived())).not.toContain(TOKEN);

    const result = await run.finish("terminal");
    expect(result.ok).toBe(true);
    expect((await rawConfig(paths)).cloud).toEqual({ url: CONTROL });
    expect(await new FilePendingEnrollmentStore(paths.pendingEnrollment).load()).toEqual({
      token: TOKEN,
      cloudUrl: CONTROL,
    });
    // config.json holds the address, and never the token.
    expect(await readFile(paths.config, "utf8")).not.toContain(TOKEN);
  });

  test("a sign-in for one address does not connect another", async () => {
    const paths = await root();
    const plane = controlPlane();
    const run = await SetupRun.open(runDeps(paths, { enrollment: plane.deps }));
    northstar(run);
    run.set("controlPlane.connect", "yes");
    run.set("controlPlane.address", "control.example");
    await run.enroll();
    plane.signIn();
    await run.enrollCheck();
    run.set("controlPlane.address", "elsewhere.example");
    expect(run.derived().enrollment.state).toBe("none");
    expect((await run.finish("terminal")).ok).toBe(false);
  });

  test("a settings file can give an enrollment token by its name", async () => {
    const paths = await root();
    const run = await SetupRun.open(runDeps(paths));
    const taken = run.takeFile(
      JSON.stringify({
        organization: { name: "Northstar", firstAdministrator: "marta.lindqvist" },
        controlPlane: { address: "control.example", token: { key: "connection-token" } },
      }),
    );
    expect(taken.ok).toBe(true);
    const result = await run.finish("file");
    expect(result.ok).toBe(true);
    expect((await rawConfig(paths)).cloud).toEqual({ url: CONTROL });
    expect((await new FilePendingEnrollmentStore(paths.pendingEnrollment).load())?.token).toBe(TOKEN);
  });

  test("a settings file cannot give the control plane's key: nothing in this build would hold the Fortress to it", async () => {
    const paths = await root();
    const run = await SetupRun.open(runDeps(paths));
    const taken = run.takeFile(
      JSON.stringify({
        organization: { name: "Northstar", firstAdministrator: "marta.lindqvist" },
        controlPlane: {
          address: "control.example",
          key: { id: "cp-2026-11", publicKey: "2MkypwQYWd8sFrN2hvhWzkf4gf6wg8KFB50Njy_l5Os" },
        },
      }),
    );
    expect(taken.ok).toBe(false);
    expect(JSON.stringify(taken)).toContain("controlPlane.key");
  });
});

describe("an install made before the setup existed", () => {
  async function older(paths: Paths, extra: Record<string, unknown> = {}): Promise<void> {
    await mkdir(path.dirname(paths.config), { recursive: true });
    await writeFile(
      paths.config,
      JSON.stringify({
        schemaVersion: 1,
        cloud: { url: CONTROL },
        gateway: { publicUrl: "http://localhost:8787" },
        modules: { enabled: ["session_vault"] },
        ...extra,
      }),
    );
    // It enrolled once, so it holds the credential the control plane gave it.
    await new FileCredentialStore(paths.credentials).save({
      orgId: "org_northstar",
      fortressId: "fortress_1",
      credential: ["credential", "for", "a", "test"].join("-"),
    });
  }

  test("its config.json is read as the answers", async () => {
    const paths = await root();
    await older(paths, { postgres: { externalUrl: DB_URL }, secrets: { provider: "file", dir: "/run/secrets" } });
    const present = await readAnswers(
      paths,
      {},
      {
        vaultCredentials: async () => ({
          store: "s3",
          bucket: "northstar-sessions",
          region: "eu-central-1",
          s3: { accessKeyId: "id", secretAccessKey: "kept" },
          openaiApiKey: "kept-too",
        }),
      },
    );
    expect(present.setUp).toBe(true);
    const a = present.answers;
    expect(a.controlPlane).toMatchObject({ connect: "yes", address: "control.example" });
    expect(a.keys).toMatchObject({ store: "file", folder: "/run/secrets" });
    expect(a.modules.session_vault).toBe(true);
    expect(a.data.database).toEqual({ store: "postgres", address: "" });
    expect(a.data.files).toMatchObject({ store: "amazon-s3", bucket: "northstar-sessions", region: "eu-central-1" });
    expect(a.model.provider).toBe("openai-compatible");
    // What it keeps as values is known, and stays where it is.
    expect(present.kept).toEqual({ modelKey: true, databaseAddress: true, filesKeys: true });
    // The answers as a file hold no value an earlier setup kept.
    expect(settingsFileText(a)).not.toContain("pw-for-a-test");
    expect(settingsFileText(a)).not.toContain("kept");
  });

  test("setting it up again and changing nothing writes nothing but the mark", async () => {
    const paths = await root();
    await older(paths, { postgres: { externalUrl: DB_URL }, custom: { kept: true } });
    const before = await rawConfig(paths);
    const creds: VaultCredentials = {
      store: "s3",
      bucket: "northstar-sessions",
      region: "eu-central-1",
      s3: { accessKeyId: "id", secretAccessKey: "kept" },
      openaiApiKey: "kept-too",
    };
    const box = vault(creds);
    const run = await SetupRun.open(
      runDeps(paths, { read: { vaultCredentials: box.read }, apply: { updateVaultCredentials: box.update } }),
    );
    // An install from before the setup has no organization name yet.
    run.set("organization.name", "Northstar");
    const result = await run.finish("terminal");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied.changed).toEqual(["organization"]);
    expect(result.applied.restart).toEqual([]);

    const after = await rawConfig(paths);
    expect(after.cloud).toEqual(before.cloud);
    expect(after.postgres).toEqual(before.postgres);
    expect(after.modules).toEqual(before.modules);
    expect(after.custom).toEqual({ kept: true });
    expect(after.moduleDefaultsApplied).toBeUndefined();
    expect(after.organization).toEqual({ name: "Northstar" });
    // The keys an earlier setup kept are where they were.
    expect(box.current).toEqual(creds);
    expect(await new FilePendingEnrollmentStore(paths.pendingEnrollment).load()).toBeNull();
  });

  test("an answer the host's environment decides is shown as pinned and cannot be changed", async () => {
    const paths = await root();
    await older(paths);
    const env = { FORTRESS_SESSIONS: "off", FORTRESS_SECRETS_PROVIDER: "env", FORTRESS_UI_PUBLIC_URL: "https://f.northstar.example" };
    const run = await SetupRun.open(runDeps(paths, { env }));
    expect(run.present.pinned).toEqual({
      "keys.store": "FORTRESS_SECRETS_PROVIDER",
      "signIn.consoleAddress": "FORTRESS_UI_PUBLIC_URL",
      "modules.session_vault": "FORTRESS_SESSIONS",
    });
    expect(run.answers.modules.session_vault).toBe(false);
    expect(run.set("modules.session_vault", true)).toBe(false);
    expect(run.set("keys.store", "file")).toBe(false);
    expect(run.answers.modules.session_vault).toBe(false);
  });

  test("each setting of the key store is pinned by its own variable, and is left out of what the setup writes", async () => {
    // A cloud install: the template sets the key store and its address in the
    // container's environment. Both are the host's to decide.
    const vault = "https://northstar-fortress.vault.azure.net";
    const env = { FORTRESS_SECRETS_PROVIDER: "azure-key-vault", FORTRESS_SECRETS_AZURE_VAULT_URL: vault };
    const paths = await root();
    const run = await SetupRun.open(runDeps(paths, { env }));
    expect(run.present.pinned).toEqual({
      "keys.store": "FORTRESS_SECRETS_PROVIDER",
      "keys.address": "FORTRESS_SECRETS_AZURE_VAULT_URL",
    });
    expect(run.answers.keys).toMatchObject({ store: "azure-key-vault", address: vault });
    expect(run.set("keys.address", "https://other.vault.azure.net")).toBe(false);
    northstar(run);
    const result = await run.finish("file");
    if (!result.ok) throw new Error(JSON.stringify(result.checks.filter((check) => !check.ok)));
    // Nothing of the key store is in the file: the environment holds all of it.
    expect((await rawConfig(paths)).secrets).toBeUndefined();
  });

  test("a setting the environment does not decide is still written beside one that it does", async () => {
    const paths = await root();
    const keys = path.join(paths.root, "keys");
    await mkdir(keys, { recursive: true });
    // The environment says which key store. The folder is this install's to choose.
    const env = { FORTRESS_SECRETS_PROVIDER: "file" };
    const run = await SetupRun.open(runDeps(paths, { env, check: { ...runDeps(paths).check, keyStore: undefined } }));
    expect(run.present.pinned).toEqual({ "keys.store": "FORTRESS_SECRETS_PROVIDER" });
    expect(run.set("keys.folder", keys)).toBe(true);
    northstar(run);
    const result = await run.finish("file");
    if (!result.ok) throw new Error(JSON.stringify(result.checks.filter((check) => !check.ok)));
    // The folder is written. The provider is not: the variable decides it.
    expect((await rawConfig(paths)).secrets).toEqual({ dir: keys });
    // And the Fortress reads the answer it was given.
    const again = await readAnswers(paths, env, { vaultCredentials: async () => null });
    expect(again.answers.keys).toMatchObject({ store: "file", folder: keys });
  });

  test("a key store setting that the setup has no field for is kept when the question is answered again", async () => {
    const paths = await root();
    const vault = "https://northstar-fortress.vault.azure.net";
    await older(paths, {
      // Its modules were chosen on this host: Sessions is off, by choice.
      modules: { enabled: ["host"] },
      moduleDefaultsApplied: 1,
      secrets: { provider: "azure-key-vault", vaultUrl: vault, cacheSeconds: 30 },
    });
    const run = await SetupRun.open(runDeps(paths));
    run.set("organization.name", "Northstar");
    expect(run.answers.keys).toMatchObject({ store: "azure-key-vault", address: vault });
    // A user-assigned identity is named. How long a value is remembered is not asked.
    expect(run.set("keys.clientId", IDENTITY)).toBe(true);
    const result = await run.finish("terminal");
    if (!result.ok) throw new Error(JSON.stringify(result.checks.filter((check) => !check.ok)));
    expect((await rawConfig(paths)).secrets).toEqual({
      provider: "azure-key-vault",
      vaultUrl: vault,
      clientId: IDENTITY,
      cacheSeconds: 30,
    });
  });

  test("answering No disconnects the control plane, and the Fortress goes on alone", async () => {
    const paths = await root();
    await older(paths, { moduleDefaultsApplied: 1, modules: { enabled: [] } });
    const run = await SetupRun.open(runDeps(paths));
    run.set("organization.name", "Northstar");
    run.set("controlPlane.connect", "no");
    const result = await run.finish("terminal");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied.restart).toEqual(["controlPlane"]);
    expect((await rawConfig(paths)).cloud).toBeUndefined();
    expect((await new FileConfigStore(paths).load()).cloud).toBeUndefined();
  });
});

/** A terminal that types a script. Enter keeps the default. */
function scripted(answers: Record<string, string | boolean>): TerminalIo & { out: string[] } {
  const out: string[] = [];
  let again = 0;
  const answer = <T>(message: string, fallback: T): T => {
    const key = Object.keys(answers).find((k) => message.includes(k));
    // The lookup is by a key the test itself wrote.
    // eslint-disable-next-line security/detect-object-injection
    return key === undefined ? fallback : (answers[key] as unknown as T);
  };
  return {
    out,
    line: (text) => {
      out.push(text);
    },
    text: async (message, options) => {
      out.push(message);
      return answer(message, options?.default ?? "");
    },
    select: async (message, choices, options) => {
      out.push(message);
      const wanted = answer<string | null>(message, null);
      const chosen = wanted === null ? choices[options?.defaultIndex ?? 0] : choices.find((c) => c.label === wanted);
      if (!chosen) throw new Error(`no such choice: ${String(wanted)}`);
      return chosen.value;
    },
    confirm: async (message, options) => {
      out.push(message);
      // A script gives the same answer every time, so a question that is asked
      // again and again would never end. Three times is a failed test.
      if (message.includes("Answer this question again?")) {
        again += 1;
        if (again > 3) throw new Error(`the same question was refused ${again} times:\n${out.slice(-12).join("\n")}`);
      }
      return answer(message, options?.default ?? true);
    },
    sleep: async () => {},
  };
}

describe("hx-fortress setup in a terminal", () => {
  test("asks every question in order, checks each, and writes them when the person finishes", async () => {
    const paths = await root();
    const run = await SetupRun.open(runDeps(paths));
    const io = scripted({ "Organization": "Northstar", "First administrator": "marta.lindqvist" });
    const outcome = await runTerminalSetup(run, io, { finish: () => run.finish("terminal") });
    expect(outcome.ended).toBe("finished");

    // Each question of the list, once, in the list's order, with its place in it.
    const steps = io.out.filter((line) => /^Step \d+ of \d+ · /.test(line));
    expect(steps).toEqual(
      SETUP_LIST.map((step, index) => `Step ${index + 1} of ${SETUP_LIST.length} · ${step.name}`),
    );
    expect(io.out).toContain(`${SETUP_LIST.length} questions. Enter keeps the answer shown in [brackets].`);
    expect(io.out).toContain("Who runs this Fortress?");
    expect(io.out).toContain("Does an outside service direct this Fortress?");
    expect(io.out).toContain("Review");
    expect((await new FileConfigStore(paths).load()).organization?.name).toBe("Northstar");
    // It never asked for a key, only for names.
    expect(io.out.join("\n")).toContain("Setup never asks for the key");
    // A choice with one option is said, not asked: nobody picks from a list of one.
    expect(io.out).toContain("  A copy goes to: Nowhere else");
    expect(io.out).toContain("  Direct");
    expect(io.out).not.toContain("  A copy goes to");
  });

  test("a wrong answer is refused in plain words, and the question is asked again", async () => {
    const paths = await root();
    const run = await SetupRun.open(runDeps(paths));
    let asked = 0;
    const io = scripted({ "First administrator": "marta.lindqvist" });
    const text = io.text;
    io.text = async (message, options) => {
      if (message.includes("Organization")) {
        asked += 1;
        io.out.push(message);
        return asked === 1 ? "" : "Northstar";
      }
      return text(message, options);
    };
    const outcome = await runTerminalSetup(run, io, { finish: () => run.finish("terminal") });
    expect(outcome.ended).toBe("finished");
    expect(asked).toBe(2);
    expect(io.out).toContain("  no  Give the organization a name");
    expect(io.out).toContain("  Answer this question again?");
  });

  test("stopping before the end saves nothing", async () => {
    const paths = await root();
    const run = await SetupRun.open(runDeps(paths));
    const io = scripted({ "Organization": "Northstar", "First administrator": "marta.lindqvist", "Finish setup?": false });
    const outcome = await runTerminalSetup(run, io, { finish: () => run.finish("terminal") });
    expect(outcome.ended).toBe("stopped");
    expect(io.out).toContain("Setup stopped. Nothing was saved.");
    expect(await stat(paths.config).then(() => true, () => false)).toBe(false);
  });

  test("connecting a control plane shows where to sign in and the code, and waits for the sign-in", async () => {
    const paths = await root();
    const plane = controlPlane();
    const run = await SetupRun.open(runDeps(paths, { enrollment: plane.deps }));
    const io = scripted({
      "Organization": "Northstar",
      "First administrator": "marta.lindqvist",
      // The control plane's own field, not the console's address in step 3.
      "such as control.example": "control.example",
    });
    const select = io.select;
    io.select = async (message, choices, options) => {
      const yes = choices.find((c) => c.label === "Yes, connect a control plane");
      if (yes) {
        io.out.push(message);
        return yes.value;
      }
      return select(message, choices, options);
    };
    io.sleep = async () => {
      plane.signIn();
    };
    const outcome = await runTerminalSetup(run, io, { finish: () => run.finish("terminal") });
    expect(outcome.ended).toBe("finished");
    expect(io.out).toContain("  Sign in at:  https://control.example/install?code=K7Q-42M");
    expect(io.out).toContain("  Code:        K7Q-42M");
    // Said once, by the question's own check.
    expect(io.out.filter((line) => line === "  ok  Signed in. This Fortress connects when it starts")).toHaveLength(1);
    // Nobody approves a Fortress that joins, and the question does not say so.
    // (A release is approved, and the Updates question before this one says that.)
    const question = io.out.slice(
      io.out.findIndex((line) => line.endsWith("· Control plane")),
      io.out.indexOf("Review"),
    );
    expect(question).toContain("  Waiting for the sign-in. Ctrl+C stops the setup, and nothing is saved.");
    expect(question.join("\n")).not.toMatch(/pairing|approv/i);
    expect((await rawConfig(paths)).cloud).toEqual({ url: CONTROL });
    expect(io.out.join("\n")).not.toContain(TOKEN);
  });
});

describe("the command", () => {
  async function command(
    paths: Paths,
    args: string[],
    over: Partial<SetupCommandDeps> = {},
  ): Promise<{ code: number; out: string[] }> {
    const out: string[] = [];
    const code = await runSetupCommand(args, {
      writeLine: (line) => out.push(line),
      fortressRoot: paths.root,
      env: {},
      isTty: false,
      run: runDeps(paths),
      daemonPid: async () => null,
      ...over,
    });
    return { code, out };
  }

  test("--file applies a settings file, says what each check found, and records the act", async () => {
    const paths = await root();
    const file = path.join(paths.root, "fortress.setup.json");
    await mkdir(paths.root, { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        organization: { name: "Northstar", firstAdministrator: "marta.lindqvist" },
        data: { database: { store: "postgres", address: { key: "db-url" } }, files: false },
        modules: { host: true },
      }),
    );
    const { code, out } = await command(paths, ["--file", file]);
    expect(code).toBe(0);
    expect(out).toContain("Step 4 · Data");
    expect(out).toContain("  ok  Database reached. PostgreSQL 17.2");
    expect(out.join("\n")).toContain("Setup is saved: Organization");
    expect(out).toContain("Start HX Fortress: hx-fortress start");
    // No terminal, so the first account's link is in a file and not in the output.
    const said = out.join("\n");
    expect(said).toContain("bootstrap-setup-link.txt");
    expect(said).not.toContain("/setup#t=");
    const linkFile = path.join(paths.uiRoot, "bootstrap-setup-link.txt");
    // Read first, then looked at: nothing here acts on what a look found.
    expect(await readFile(linkFile, "utf8")).toContain("/setup#t=");
    expect((await stat(linkFile)).mode & 0o777).toBe(0o600);

    const records = (await spoolRecords(paths)).filter((r) => r.action === "fortress.setup.finished");
    expect(records.map((r) => [r.kind, r.outcome])).toEqual([
      ["intent", null],
      ["outcome", "done"],
    ]);
    expect(records[0]?.params).toMatchObject({ way: "file" });
    // The trail names the questions, and holds no answer.
    expect(JSON.stringify(records)).not.toContain("Northstar");
    expect(JSON.stringify(records)).not.toContain("db-url");
  });

  describe("the first administrator's link, minted where HX Fortress was installed", () => {
    // A digest of the right shape, put together at run time.
    const digest = createHash("sha256").update("a token that stays where it was minted").digest("hex");
    const hour = 60 * 60 * 1000;

    async function settingsFile(paths: Paths, organization: Record<string, string>): Promise<string> {
      const file = path.join(paths.root, "fortress.setup.json");
      await mkdir(paths.root, { recursive: true });
      await writeFile(file, JSON.stringify({ organization }));
      return file;
    }

    /** A container's first start: the setup from a settings file, before HX
     *  Fortress starts. The file names the same first administrator as the
     *  environment, as an install writes it. */
    async function firstStart(paths: Paths, env: Record<string, string>, organization: Record<string, string>) {
      const named = env.FORTRESS_UI_BOOTSTRAP_USER;
      const file = await settingsFile(paths, named ? { ...organization, firstAdministrator: named } : organization);
      return command(paths, ["--file", file, "--starts-after"], { env, run: runDeps(paths, { env }) });
    }

    test("a digest and a good end time make the account with that digest, and no link file is written", async () => {
      const paths = await root();
      const env = {
        FORTRESS_UI_BOOTSTRAP_USER: "marta.lindqvist",
        [BOOTSTRAP_TOKEN_DIGEST_ENV]: digest,
        [BOOTSTRAP_TOKEN_EXPIRES_ENV]: new Date(Date.now() + hour).toISOString(),
      };
      const { code, out } = await firstStart(paths, env, { name: "Northstar" });
      if (code !== 0) throw new Error(out.join("\n"));
      expect(out).toContain("The account marta.lindqvist was made.");
      expect(out).toContain(linkIsElsewhere("marta.lindqvist"));
      const said = out.join("\n");
      expect(said).not.toContain(digest);
      expect(said).not.toContain("#t=");
      const users = await new UsersStore(path.join(paths.uiRoot, "users.json")).load();
      expect(users.users.map((user) => [user.login, user.setupTokens.map((record) => record.digest)])).toEqual([
        ["marta.lindqvist", [digest]],
      ]);
      expect(await stat(bootstrapLinkPath(paths.uiRoot)).then(() => "written", () => "absent")).toBe("absent");
    });

    test("no end time, a passed one, one more than a day ahead and one that is no time make no account, and say why", async () => {
      for (const [ends, reason] of [
        [null, "FORTRESS_UI_BOOTSTRAP_TOKEN_EXPIRES is not set"],
        [new Date(Date.now() - hour).toISOString(), "the link's end time has passed"],
        [new Date(Date.now() + 25 * hour).toISOString(), "more than 24 hours ahead of this console's clock"],
        ["tomorrow", "is not an ISO 8601 time with its offset"],
      ] as const) {
        const paths = await root();
        const env: Record<string, string> = { FORTRESS_UI_BOOTSTRAP_USER: "marta.lindqvist", [BOOTSTRAP_TOKEN_DIGEST_ENV]: digest };
        if (ends !== null) env[BOOTSTRAP_TOKEN_EXPIRES_ENV] = ends;
        const { code, out } = await firstStart(paths, env, { name: "Northstar" });
        const said = out.join("\n");
        // The settings are whole, so the setup ends well: one command makes the account.
        expect([ends, code]).toEqual([ends, 0]);
        expect(said).toContain(reason);
        expect(said).toContain("The settings were saved, but the account for marta.lindqvist was not made.");
        expect(said).toContain("Make it with: hx-fortress ui user create marta.lindqvist --role operator");
        expect(said).not.toContain(digest);
        expect((await new UsersStore(path.join(paths.uiRoot, "users.json")).load()).users).toEqual([]);
        expect(await stat(bootstrapLinkPath(paths.uiRoot)).then(() => "written", () => "absent")).toBe("absent");
        await cleanup?.();
        cleanup = null;
      }
    });

    test("the link counts only for the login the environment names: a login the settings name gets its own link", async () => {
      const paths = await root();
      const env = {
        [BOOTSTRAP_TOKEN_DIGEST_ENV]: digest,
        [BOOTSTRAP_TOKEN_EXPIRES_ENV]: new Date(Date.now() + hour).toISOString(),
      };
      const { code, out } = await firstStart(paths, env, { name: "Northstar", firstAdministrator: "erik.holm" });
      if (code !== 0) throw new Error(out.join("\n"));
      const users = await new UsersStore(path.join(paths.uiRoot, "users.json")).load();
      expect(users.users.map((user) => user.login)).toEqual(["erik.holm"]);
      expect(users.users[0]?.setupTokens.map((record) => record.digest)).not.toContain(digest);
      expect(await readFile(bootstrapLinkPath(paths.uiRoot), "utf8")).toContain("/setup#t=");
    });
  });

  test("--file refuses a wrong file in plain words and saves nothing", async () => {
    const paths = await root();
    const file = path.join(paths.root, "fortress.setup.json");
    await mkdir(paths.root, { recursive: true });
    await writeFile(file, JSON.stringify({ organization: { name: "Northstar" }, keys: { store: "google-secret-manager" } }));
    const { code, out } = await command(paths, ["--file", file]);
    expect(code).toBe(1);
    expect(out).toContain("The settings file is refused:");
    expect(out.join("\n")).toContain("Google Secret Manager is not in this build yet");
    expect(out).toContain("Nothing was saved.");
    expect(await stat(paths.config).then(() => true, () => false)).toBe(false);
  });

  test("--file with an answer that fails its check saves nothing and says which", async () => {
    const paths = await root();
    const file = path.join(paths.root, "fortress.setup.json");
    await mkdir(paths.root, { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        organization: { name: "Northstar", firstAdministrator: "marta.lindqvist" },
        data: { database: { store: "postgres", address: { key: "no-such-key" } } },
      }),
    );
    const { code, out } = await command(paths, ["--file", file]);
    expect(code).toBe(1);
    expect(out).toContain("  no  No key with this name");
    expect(out).toContain("Setup cannot finish: an answer is refused. Nothing was saved.");
    expect(await stat(paths.config).then(() => true, () => false)).toBe(false);
    const records = (await spoolRecords(paths)).filter((r) => r.action === "fortress.setup.finished");
    expect(records.map((r) => r.outcome)).toEqual([null, "refused"]);
  });

  test("--print writes the present answers as a settings file that --file takes back", async () => {
    const paths = await root();
    const first = await command(paths, ["--print"]);
    expect(first.code).toBe(0);
    const printed = JSON.parse(first.out.join("\n")) as Record<string, unknown>;
    expect(Object.keys(printed)).toEqual([
      "version",
      "organization",
      "keys",
      "signIn",
      "data",
      "modules",
      "model",
      "network",
      "records",
      "updates",
      "controlPlane",
    ]);
    expect(printed.controlPlane).toBe(false);
  });

  test("check runs every check again and fails when one is refused", async () => {
    const paths = await root();
    const { code, out } = await command(paths, ["check"]);
    expect(code).toBe(1);
    expect(out).toContain("Step 1 · Organization");
    expect(out).toContain("  no  Give the organization a name");
  });

  test("with no terminal, the questions are not asked, and the other ways are named", async () => {
    const paths = await root();
    const { code, out } = await command(paths, []);
    expect(code).toBe(1);
    expect(out[0]).toBe("error: hx-fortress setup asks its questions in a terminal, and there is none here.");
    expect(out.join("\n")).toContain("hx-fortress setup --file <path>");
  });

  test("an option or a question it does not know is refused, and what was typed is repeated only when it is a word", async () => {
    const paths = await root();
    const flag = await command(paths, ["--everything"]);
    expect(flag.code).toBe(1);
    expect(flag.out[0]).toBe("error: unknown option --everything");
    const word = await command(paths, ["postgres://user:pw@db/x"], { isTty: true });
    expect(word.code).toBe(1);
    expect(word.out[0]).toBe("error: that is not a question of the setup");
  });

  test("one question can be asked again by its name", async () => {
    const paths = await root();
    const made = await SetupRun.open(runDeps(paths));
    northstar(made);
    expect((await made.finish("terminal")).ok).toBe(true);

    const io = scripted({ "Switch Host on?": true });
    const { code, out } = await command(paths, ["modules"], { isTty: true, io });
    expect(code).toBe(0);
    expect(io.out.filter((line) => /^Step \d+ of \d+ · /.test(line))).toEqual([
      `Step ${stepNumber("modules")} of ${SETUP_LIST.length} · Modules`,
    ]);
    expect((await new FileConfigStore(paths).load()).modules.enabled).toEqual(["host"]);
    expect(out.join("\n")).toContain("Setup is saved: Modules.");
  });

  test("link says so when no browser setup is waiting", async () => {
    const paths = await root();
    const { code, out } = await command(paths, ["link"]);
    expect(code).toBe(1);
    expect(out).toEqual(["No browser setup is waiting on this host. Start one: hx-fortress setup --browser"]);
  });

  test("--list prints the options this build has for each question, and no other", async () => {
    const paths = await root();
    const { code, out } = await command(paths, ["--list"]);
    expect(code).toBe(0);
    const printed = JSON.parse(out.join("\n")) as typeof SETUP_LIST;
    const options = (list: typeof SETUP_LIST): { id: string; built: boolean }[] =>
      list.flatMap((step) => step.blocks.flatMap((block) => (block.kind === "choice" ? block.options : [])));
    expect(printed.map((step) => step.id)).toEqual(SETUP_LIST.map((step) => step.id));
    expect(options(printed).every((option) => option.built)).toBe(true);
    // The list itself holds more: the options whose code is not in this build.
    expect(options(printed)).toHaveLength(options(SETUP_LIST).filter((option) => option.built).length);
    expect(options(SETUP_LIST).some((option) => !option.built)).toBe(true);
  });

  const WHOLE = { "Organization": "Northstar", "First administrator": "marta.lindqvist" };

  test("at a terminal the first administrator's link is printed", async () => {
    const paths = await root();
    const { code, out } = await command(paths, [], { isTty: true, io: scripted(WHOLE) });
    expect(code).toBe(0);
    expect(out.some((line) => /^ {2}http:\/\/127\.0\.0\.1:\d+\/setup#t=/.test(line))).toBe(true);
  });

  test("with its output in a pipe the link is written to a file only the Fortress's user can read, and not printed", async () => {
    const paths = await root();
    // The questions are asked on the terminal itself, so they work while what
    // the command prints goes into a file.
    const { code, out } = await command(paths, [], { isTty: true, outputIsTty: false, io: scripted(WHOLE) });
    expect(code).toBe(0);
    expect(out.join("\n")).not.toContain("#t=");
    const file = bootstrapLinkPath(paths.uiRoot);
    expect(out.join("\n")).toContain(file);
    expect((await readFile(file, "utf8")).trim()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/setup#t=/);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test("the link is built on the port the console will listen on, by the console's own rule", async () => {
    const paths = await root();
    const { code, out } = await command(paths, [], {
      isTty: true,
      io: scripted(WHOLE),
      env: { FORTRESS_UI_PORT: "8080" },
      run: runDeps(paths, { env: { FORTRESS_UI_PORT: "8080" } }),
    });
    expect(code).toBe(0);
    expect(out.some((line) => line.startsWith("  http://127.0.0.1:8080/setup#t="))).toBe(true);
  });
});

describe("the command line", () => {
  test("start refuses a Fortress that is not set up, and says what to run", async () => {
    const paths = await root();
    const out: string[] = [];
    const code = await runCli(["start"], { fortressRoot: paths.root, writeLine: (line) => out.push(line) });
    expect(code).toBe(1);
    expect(out).toEqual([`error: ${NOT_SET_UP}`]);
  });

  test("setup is a verb of the binary, and help lists it", async () => {
    const paths = await root();
    const seen: string[][] = [];
    const out: string[] = [];
    const code = await runCli(["setup", "--print"], {
      fortressRoot: paths.root,
      writeLine: (line) => out.push(line),
      runSetup: async (args) => {
        seen.push([...args]);
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(seen).toEqual([["--print"]]);
    const help: string[] = [];
    await runCli(["help"], { writeLine: (line) => help.push(line) });
    expect(help.join("\n")).toContain("hx-fortress setup");
  });

  test("a config with no control plane is one the host's parser accepts, and one with a broken address is still refused", () => {
    const base = { schemaVersion: 1, gateway: { publicUrl: "http://localhost:8787" }, modules: { enabled: [] } };
    expect(parseFortressConfig(base).cloud).toBeUndefined();
    expect(() => parseFortressConfig({ ...base, cloud: { url: "https://control.example" } })).toThrow(
      "cloud.url must use ws: or wss:",
    );
    expect(() => parseFortressConfig({ ...base, cloud: {} })).toThrow("cloud.url must be a string");
  });
});

// Used by the type of the scripted answers above.
export type { SetupAnswers };
