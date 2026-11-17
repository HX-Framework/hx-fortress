// One run of the setup on the machine that runs HX Fortress: its end, what it
// writes and how it reads back; the terminal that asks its questions, in both
// ways; and the `hx-fortress setup` command.

import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { runCli } from "../src/cli";
import { runSetupCommand, type SetupCommandDeps } from "../src/cli-setup";
import { FileCredentialStore, FilePendingEnrollmentStore } from "../src/cloud/credentials";
import { FileConfigStore, parseFortressConfig } from "../src/host/config";
import { fortressPaths } from "../src/host/paths";
import type { VaultCredentials } from "../src/modules/session-vault/credentials";
import { defaultAnswers, settingsFileText } from "../src/setup/answers";
import { applyAnswers } from "../src/setup/apply";
import { SetupAudit } from "../src/setup/audit";
import { LAST_STEP, SETUP_LIST, STEP_IDS, stepById, stepsAsked, visibleList } from "../src/setup/list";
import { readAnswers } from "../src/setup/read";
import { linkIsElsewhere, SetupRun } from "../src/setup/run";
import { readSetupMark } from "../src/setup/state";
import { runTerminalSetup } from "../src/setup/terminal";
import { BOOTSTRAP_TOKEN_DIGEST_ENV, BOOTSTRAP_TOKEN_EXPIRES_ENV, bootstrapLinkPath } from "../src/ui/bootstrap-user";
import { UiConfigStore } from "../src/ui/config";
import { OidcConfigStore } from "../src/ui/oidc-config";
import { UsersStore } from "../src/ui/users";
import { spoolRecords, tempRoot, type Paths } from "./host/_module-rig";
import { installRun, StandInPlace, untouchedRoot } from "./install-rig";
import {
  CONNECT,
  CONTROL,
  DB_URL,
  INSTALL_ID,
  MODULES,
  PAGES,
  northstar,
  providerDocument,
  rawConfig,
  runDeps,
  scripted,
  vault,
} from "./setup-rig";

// The client id of a made-up managed identity. An identifier, not a key. It is
// put together at run time so that nothing key-shaped sits in the repository.
const IDENTITY = ["0f3a9b7c", "1d2e", "4f5a", "8b6c", "7d8e9f0a1b2c"].join("-");
// Built at run time so no secret-shaped literal sits in the repository.
const TYPED = ["sk", "ant", "typed", "Pw4mZ8NotAReal0ne"].join("-");

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function root(): Promise<Paths> {
  const made = await tempRoot();
  cleanups.push(made.cleanup);
  return made.paths;
}

const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false);

/** A gate that holds a fake until the test lets it go. */
function gate(): { wait: () => Promise<void>; open: () => void; waiting: () => number } {
  const opened = Promise.withResolvers<void>();
  let waiting = 0;
  return {
    wait: async () => {
      waiting += 1;
      await opened.promise;
    },
    open: () => opened.resolve(),
    waiting: () => waiting,
  };
}

async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("waited too long");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

// ── A new install, set up on the machine itself ──────────────────────────────

describe("a new install", () => {
  test("is not set up, and every question starts on its plain answer", async () => {
    const paths = await root();
    const present = await readAnswers(paths, {}, { vaultCredentials: async () => null });
    expect(present.setUp).toBe(false);
    expect(present.pinned).toEqual({});
    expect(present.answers).toEqual(defaultAnswers(MODULES));
    // A run on it starts with the modules this build switches on.
    const run = await SetupRun.open(runDeps(paths));
    expect(run.answers.modules).toEqual({ session_vault: false, host: true, databases: true });
    expect(run.way).toBe("setup");
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
    expect(raw.modules).toEqual({ enabled: ["host", "databases"] });
    expect(raw.moduleDefaultsApplied).toBe(1);
    expect(raw.auditTrail).toEqual({ keepFor: "until-removed" });
    expect(raw.connection).toEqual({ sessionContent: "off" });
    // Nothing is written for an answer on its plain option that HX Fortress reads as no setting.
    for (const key of ["updates", "model", "network", "install", "controlPlane", "postgres"]) expect(raw[key]).toBeUndefined();

    // The same parser HX Fortress starts with reads it, and finds no control plane.
    const config = await new FileConfigStore(paths).load();
    expect(config.cloud).toBeUndefined();
    expect(config.organization).toEqual({ name: "Northstar" });
    // Read first, then looked at: nothing here acts on what a look found.
    expect(await readFile(paths.config, "utf8")).toContain('"schemaVersion"');
    expect((await stat(paths.config)).mode & 0o777).toBe(0o600);

    expect((await readSetupMark(paths))?.by).toBe("terminal");
    // The console is on, because a person answered how people sign in to it.
    expect((await new UiConfigStore(paths.uiConfig).load()).enabled).toBe(true);
    // Where it runs is not a question on the machine itself, so it is not named as written.
    expect(result.ok && result.applied.changed).toEqual(STEP_IDS.filter((id) => id !== "where"));
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
    expect(await exists(paths.config)).toBe(false);
    expect(await exists(path.join(paths.uiRoot, "users.json"))).toBe(false);
  });

  test("a database, sign-in through a provider, an address and a module are written where HX Fortress reads them", async () => {
    const paths = await root();
    const provider = (async (input: Parameters<typeof fetch>[0]) =>
      String(input).endsWith("/.well-known/openid-configuration")
        ? Response.json(providerDocument("https://login.northstar.example"))
        : new Response(null, { status: 200 })) as unknown as typeof fetch;
    const deps = runDeps(paths);
    const run = await SetupRun.open({ ...deps, check: { ...deps.check, fetch: provider } });
    northstar(run);
    run.set("data.database.store", "existing");
    run.set("data.database.address", "db-url");
    run.set("signIn.provider", "openid-connect");
    run.set("signIn.issuer", "https://login.northstar.example");
    run.set("signIn.clientId", "hx-fortress");
    run.set("signIn.administratorGroups", "hx-fortress-admins, data-team");
    run.set("signIn.viewerGroups", "data-viewers");
    run.set("address.hostname", "hx.northstar.example");
    run.set("modules.databases", false);

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
      administratorGroups: ["hx-fortress-admins", "data-team"],
      viewerGroups: ["data-viewers"],
    });
    expect((await new UiConfigStore(paths.uiConfig).load()).publicUrl).toBe("https://hx.northstar.example");
  });

  test("where it runs is no answer on the machine itself: a request cannot change it, nor what follows it", async () => {
    const paths = await root();
    const run = await SetupRun.open(runDeps(paths));
    const before = JSON.stringify(run.answers);
    for (const [at, value] of [
      ["where.place", "azure"],
      ["where.region", "eastus2"],
      ["where.ssh", "marta@hx-fortress-vm.northstar.example"],
    ] as const) {
      expect([at, run.set(at, value)]).toEqual([at, false]);
    }
    expect(JSON.stringify(run.answers)).toBe(before);
  });
});

describe("the end of a setup on the machine itself", () => {
  test("what is written is what was checked: an answer changed while the checks run is not written", async () => {
    const paths = await root();
    const held = gate();
    const deps = runDeps(paths);
    const run = await SetupRun.open({
      ...deps,
      check: {
        ...deps.check,
        // The users file is read by the Organization and Sign-in checks.
        users: async () => {
          await held.wait();
          return { version: 1, users: [] } as never;
        },
      },
    });
    northstar(run);
    const ending = run.finish("terminal");
    await until(() => held.waiting() > 0);
    expect(run.busy).toBe(true);
    run.set("organization.name", "Changed after the checks began");
    held.open();
    expect((await ending).ok).toBe(true);
    expect((await rawConfig(paths)).organization).toEqual({ name: "Northstar" });
  });

  test("one end at a time: a second call gets the first one's result, and the account is made once", async () => {
    const paths = await root();
    const run = await SetupRun.open(runDeps(paths));
    northstar(run);
    const audit = new SetupAudit(paths.auditSpool);
    const [first, second] = await Promise.all([run.finish("terminal", { audit }), run.finish("terminal", { audit })]);
    expect(second).toBe(first);
    const users = await new UsersStore(path.join(paths.uiRoot, "users.json")).load();
    expect(users.users).toHaveLength(1);
    const records = (await spoolRecords(paths)).filter((r) => r.action === "fortress.setup.finished");
    expect(records.map((r) => r.kind)).toEqual(["intent", "outcome"]);
  });

  test("create saves the settings once, marks the way, and the last screen holds the console's address and the account's link", async () => {
    const paths = await root();
    const run = await SetupRun.open(runDeps(paths));
    northstar(run);
    expect(run.progress().stage).toBe("asking");
    const words = { consoleBase: "http://127.0.0.1:9120", next: "Start HX Fortress on its host: hx-fortress start" };
    const started = await run.create("browser", words);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await started.ended;
    expect(run.progress()).toEqual({
      stage: "done",
      made: run.derived().plan.rows.map((row) => row.id),
      now: null,
      dns: null,
      failure: null,
    });
    const done = run.done();
    expect(done?.address).toBe("http://127.0.0.1:9120");
    expect(done?.firstAccount?.login).toBe("marta.lindqvist");
    expect(done?.firstAccount?.link).toStartWith("http://127.0.0.1:9120/setup#t=");
    expect(done?.next).toBe(words.next);
    expect((await readSetupMark(paths))?.by).toBe("browser");

    // Said yes again, nothing is written again and the link is the same.
    const written = await readFile(paths.config, "utf8");
    const again = await run.create("browser", words);
    expect(again).toMatchObject({ ok: true, checks: [] });
    expect(run.done()).toEqual(done);
    expect(await readFile(paths.config, "utf8")).toBe(written);
    expect((await new UsersStore(path.join(paths.uiRoot, "users.json")).load()).users).toHaveLength(1);
  });

  test("the last screen is built on the answers' own address when they give one", async () => {
    const paths = await root();
    const run = await SetupRun.open(runDeps(paths));
    northstar(run);
    run.set("address.hostname", "hx.northstar.example");
    const started = await run.create("terminal", { consoleBase: "http://127.0.0.1:9120", next: "" });
    if (!started.ok) throw new Error("refused");
    await started.ended;
    expect(run.done()?.address).toBe("https://hx.northstar.example");
    expect(run.done()?.firstAccount?.link).toStartWith("https://hx.northstar.example/setup#t=");
  });

  test("an account made for a link from the install shows no link on the last screen, and says where the link is", async () => {
    const paths = await root();
    // A digest of the right shape, put together at run time.
    const digest = createHash("sha256").update("a token that stays where it was minted").digest("hex");
    const run = await SetupRun.open(
      runDeps(paths, {
        env: {
          FORTRESS_UI_BOOTSTRAP_USER: "marta.lindqvist",
          [BOOTSTRAP_TOKEN_DIGEST_ENV]: digest,
          [BOOTSTRAP_TOKEN_EXPIRES_ENV]: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      }),
    );
    run.set("organization.name", "Northstar");
    expect(run.answers.organization.firstAdministrator).toBe("marta.lindqvist");
    const started = await run.create("browser", { consoleBase: "http://127.0.0.1:9120", next: "" });
    if (!started.ok) throw new Error("refused");
    await started.ended;
    const done = run.done();
    expect(done?.firstAccount).toBeNull();
    expect(done?.notes).toEqual([linkIsElsewhere("marta.lindqvist")]);
    const users = await new UsersStore(path.join(paths.uiRoot, "users.json")).load();
    expect(users.users[0]?.setupTokens.map((record) => record.digest)).toEqual([digest]);
    expect(JSON.stringify(done)).not.toContain(digest);
  });

  test("a refused answer leaves the run asking, and an end that cannot be written fails in this program's own words", async () => {
    const paths = await root();
    const refused = await SetupRun.open(runDeps(paths));
    const answer = await refused.create("browser", null);
    expect(answer.ok).toBe(false);
    expect(refused.progress().stage).toBe("asking");
    expect(refused.done()).toBeNull();

    // A block written ahead of the setup that is not a block stops the write.
    await mkdir(path.dirname(paths.config), { recursive: true });
    await writeFile(paths.config, JSON.stringify({ connection: "off" }));
    const run = await SetupRun.open(runDeps(paths));
    northstar(run);
    const started = await run.create("browser", null);
    expect(started.ok).toBe(true);
    expect(run.progress()).toMatchObject({
      stage: "failed",
      failure: { row: "settings", text: "Invalid HX Fortress config: connection must be an object" },
    });
    // Put right, a person says yes again.
    await writeFile(paths.config, JSON.stringify({}));
    const again = await run.create("browser", null);
    expect(again.ok).toBe(true);
    expect(run.progress().stage).toBe("done");
    expect((await rawConfig(paths)).organization).toEqual({ name: "Northstar" });
  });

  test("the plan says what the end writes on this machine", async () => {
    const paths = await root();
    const run = await SetupRun.open(runDeps(paths, { connect: CONNECT }));
    northstar(run);
    expect(run.derived().plan).toEqual({
      heading: "On this machine",
      rows: [
        { id: "settings", label: "Settings", value: `in ${paths.root}` },
        { id: "controlPlane", label: "Control plane", value: "control.example, as Northstar" },
        { id: "account", label: "First administrator", value: "marta.lindqvist, with a one-time link" },
        { id: "console", label: "Console", value: "on this machine only" },
      ],
    });
  });
});

// ── What is written reads back ───────────────────────────────────────────────

describe("what is written reads back as the same answers", () => {
  test("the audit trail, the updates, the model and its route, the address, the control plane's pages and the install's facts", async () => {
    const paths = await root();
    const present = await readAnswers(paths, {}, { vaultCredentials: async () => null });
    const a = structuredClone(present.answers);
    a.where = { place: "azure", region: "westeurope", ssh: "" };
    a.organization = { name: "Northstar", firstAdministrator: "" };
    a.address = { hostname: "hx.northstar.example", certificate: "cloud-issued", certificateName: "" };
    a.data.database = { store: "managed", address: "db-url" };
    a.model = { ...a.model, provider: "anthropic", route: "direct", key: "model-key" };
    a.controlPlane = { connect: "no", address: "", token: "", connected: "on", pages: PAGES };
    a.auditTrail = { copyTo: "none", copyAddress: "", keepFor: "until-removed" };
    a.updates = { securityFixes: "off" };
    await applyAnswers(a, { paths, present, way: "file" });

    const back = (await readAnswers(paths, {}, { vaultCredentials: async () => null })).answers;
    expect(back.where).toEqual(a.where);
    expect(back.address).toEqual(a.address);
    expect(back.data.database).toEqual(a.data.database);
    expect(back.model).toEqual(a.model);
    expect(back.controlPlane.pages).toBe(PAGES);
    expect(back.auditTrail).toEqual(a.auditTrail);
    expect(back.updates).toEqual(a.updates);
    expect((await rawConfig(paths)).install).toEqual({
      place: "azure",
      region: "westeurope",
      certificate: "cloud-issued",
      database: "managed",
    });
    // The host's own parser takes every block that was written.
    const config = await new FileConfigStore(paths).load();
    expect(config.install).toMatchObject({ place: "azure" });
    expect(config.controlPlane).toEqual({ pages: PAGES });
  });

  test("an HX Fortress the install made on a machine of its own reads its facts back, the certificate's name with them", async () => {
    const paths = await root();
    const present = await readAnswers(paths, {}, { vaultCredentials: async () => null });
    const a = structuredClone(present.answers);
    a.where = { place: "docker", region: "", ssh: "marta@hx-fortress-vm.northstar.example" };
    a.organization.name = "Northstar";
    a.address = { hostname: "hx.northstar.example", certificate: "own", certificateName: "hx-fortress-cert" };
    a.data.database = { store: "beside", address: "db-url" };
    await applyAnswers(a, { paths, present, way: "install" });
    const back = (await readAnswers(paths, {}, { vaultCredentials: async () => null })).answers;
    expect(back.where).toEqual(a.where);
    expect(back.address).toEqual(a.address);
    expect(back.data.database).toEqual({ store: "beside", address: "db-url" });
    expect((await readSetupMark(paths))?.by).toBe("install");
  });
});

// ── An install made before the setup existed ─────────────────────────────────

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
      fortressId: "hx_1",
      credential: ["credential", "for", "a", "test"].join("-"),
    });
  }

  const KEPT: VaultCredentials = {
    store: "s3",
    bucket: "northstar-sessions",
    region: "eu-central-1",
    s3: { accessKeyId: "id", secretAccessKey: "kept" },
    openaiApiKey: "kept-too",
  };

  test("its config.json is read as the answers", async () => {
    const paths = await root();
    await older(paths, {
      postgres: { externalUrl: DB_URL },
      secrets: { provider: "file", dir: "/run/secrets" },
      // The name an earlier build wrote for a model that is asked the way OpenAI is.
      model: { provider: "openai-compatible", address: "https://models.northstar.example/v1" },
    });
    const present = await readAnswers(paths, {}, { vaultCredentials: async () => KEPT });
    expect(present.setUp).toBe(true);
    const a = present.answers;
    expect(a.controlPlane).toMatchObject({ connect: "yes", address: "control.example", connected: "on" });
    expect(a.keys).toMatchObject({ store: "file", folder: "/run/secrets" });
    expect(a.modules.session_vault).toBe(true);
    expect(a.data.database).toEqual({ store: "existing", address: "" });
    expect(a.data.files).toMatchObject({ store: "amazon-s3", bucket: "northstar-sessions", region: "eu-central-1" });
    expect(a.model).toMatchObject({ provider: "openai", route: "direct", address: "https://models.northstar.example/v1" });
    // What it keeps as values is known, and stays where it is.
    expect(present.kept).toEqual({ modelKey: true, databaseAddress: true, filesKeys: true });
    // The answers as a file hold no value an earlier setup kept.
    expect(settingsFileText(a)).not.toContain("pw-for-a-test");
    expect(settingsFileText(a)).not.toContain("kept");
  });

  test("setting it up again and changing nothing writes nothing but the mark", async () => {
    const paths = await root();
    await older(paths, { postgres: { externalUrl: DB_URL }, custom: { kept: true }, moduleDefaultsApplied: 1, modules: { enabled: ["host"] } });
    const before = await rawConfig(paths);
    const box = vault(KEPT);
    const run = await SetupRun.open(
      runDeps(paths, { read: { vaultCredentials: box.read }, apply: { updateVaultCredentials: box.update } }),
    );
    // An install from before the setup has no organization name yet.
    run.set("organization.name", "Northstar");
    const result = await run.finish("terminal");
    if (!result.ok) throw new Error(JSON.stringify(result.checks.filter((check) => !check.ok)));
    expect(result.applied.changed).toEqual(["organization"]);
    expect(result.applied.restart).toEqual([]);

    const after = await rawConfig(paths);
    expect(after.cloud).toEqual(before.cloud);
    expect(after.postgres).toEqual(before.postgres);
    expect(after.modules).toEqual(before.modules);
    expect(after.custom).toEqual({ kept: true });
    expect(after.organization).toEqual({ name: "Northstar" });
    // An HX Fortress that was set up before is given no choice about session content.
    expect("connection" in after).toBe(false);
    // The keys an earlier setup kept are where they were.
    expect(box.current).toEqual(KEPT);
    expect(await new FilePendingEnrollmentStore(paths.pendingEnrollment).load()).toBeNull();
  });

  test("an answer the host's environment decides is shown as pinned and cannot be changed", async () => {
    const paths = await root();
    await older(paths);
    const env = { FORTRESS_SESSIONS: "off", FORTRESS_SECRETS_PROVIDER: "env", FORTRESS_UI_PUBLIC_URL: "https://hx.northstar.example" };
    const run = await SetupRun.open(runDeps(paths, { env }));
    expect(run.present.pinned).toEqual({
      "keys.store": "FORTRESS_SECRETS_PROVIDER",
      "address.hostname": "FORTRESS_UI_PUBLIC_URL",
      "modules.session_vault": "FORTRESS_SESSIONS",
    });
    expect(run.answers.address.hostname).toBe("hx.northstar.example");
    expect(run.answers.modules.session_vault).toBe(false);
    expect(run.set("modules.session_vault", true)).toBe(false);
    expect(run.set("keys.store", "file")).toBe(false);
    expect(run.set("address.hostname", "data.northstar.example")).toBe(false);
    expect(run.answers.modules.session_vault).toBe(false);
  });

  test("each setting of the key store is pinned by its own variable, and is left out of what the setup writes", async () => {
    // A cloud install: the container's environment sets the key store and its
    // address. Both are the host's to decide.
    const address = "https://northstar-hx-fortress.vault.azure.net";
    const env = { FORTRESS_SECRETS_PROVIDER: "azure-key-vault", FORTRESS_SECRETS_AZURE_VAULT_URL: address };
    const paths = await root();
    const run = await SetupRun.open(runDeps(paths, { env }));
    expect(run.present.pinned).toEqual({
      "keys.store": "FORTRESS_SECRETS_PROVIDER",
      "keys.address": "FORTRESS_SECRETS_AZURE_VAULT_URL",
    });
    expect(run.answers.keys).toMatchObject({ store: "azure-key-vault", address, vault: "northstar-hx-fortress" });
    expect(run.set("keys.address", "https://other.vault.azure.net")).toBe(false);
    northstar(run);
    const result = await run.finish("file");
    if (!result.ok) throw new Error(JSON.stringify(result.checks.filter((check) => !check.ok)));
    // Nothing of the key store is in the file: the environment holds all of it.
    expect((await rawConfig(paths)).secrets).toBeUndefined();
  });

  test("the project of a Google Secret Manager is read from the host's settings, and written when a person gives it", async () => {
    // A cloud install: the container's environment names the key store and
    // the project. Both are the host's to decide.
    const env = {
      FORTRESS_SECRETS_PROVIDER: "google-secret-manager",
      FORTRESS_SECRETS_GOOGLE_PROJECT: "northstar-hx-fortress",
    };
    const pinned = await SetupRun.open(runDeps(await root(), { env }));
    expect(pinned.present.pinned).toEqual({
      "keys.store": "FORTRESS_SECRETS_PROVIDER",
      "keys.project": "FORTRESS_SECRETS_GOOGLE_PROJECT",
    });
    expect(pinned.answers.keys).toMatchObject({ store: "google-secret-manager", project: "northstar-hx-fortress" });
    expect(pinned.set("keys.project", "another-project")).toBe(false);

    // On a machine of its own, a person answers the question.
    const paths = await root();
    const run = await SetupRun.open(runDeps(paths));
    northstar(run);
    expect(run.set("keys.store", "google-secret-manager")).toBe(true);
    expect(run.set("keys.project", "northstar-hx-fortress")).toBe(true);
    const result = await run.finish("file");
    if (!result.ok) throw new Error(JSON.stringify(result.checks.filter((check) => !check.ok)));
    expect((await rawConfig(paths)).secrets).toEqual({
      provider: "google-secret-manager",
      project: "northstar-hx-fortress",
    });
    // And HX Fortress reads the answer it was given.
    const again = await readAnswers(paths, {}, { vaultCredentials: async () => null });
    expect(again.answers.keys).toMatchObject({ store: "google-secret-manager", project: "northstar-hx-fortress" });
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
    // And HX Fortress reads the answer it was given.
    const again = await readAnswers(paths, env, { vaultCredentials: async () => null });
    expect(again.answers.keys).toMatchObject({ store: "file", folder: keys });
  });

  test("a key store setting that the setup has no field for is kept when the question is answered again", async () => {
    const paths = await root();
    const address = "https://northstar-hx-fortress.vault.azure.net";
    await older(paths, {
      // Its modules were chosen on this host: Agentic Sessions is off, by choice.
      modules: { enabled: ["host"] },
      moduleDefaultsApplied: 1,
      secrets: { provider: "azure-key-vault", vaultUrl: address, cacheSeconds: 30 },
    });
    const run = await SetupRun.open(runDeps(paths));
    run.set("organization.name", "Northstar");
    expect(run.answers.keys).toMatchObject({ store: "azure-key-vault", address });
    // A user-assigned identity is named. How long a value is remembered is not asked.
    expect(run.set("keys.clientId", IDENTITY)).toBe(true);
    const result = await run.finish("terminal");
    if (!result.ok) throw new Error(JSON.stringify(result.checks.filter((check) => !check.ok)));
    expect((await rawConfig(paths)).secrets).toEqual({
      provider: "azure-key-vault",
      vaultUrl: address,
      clientId: IDENTITY,
      cacheSeconds: 30,
    });
  });

  test("naming no control plane disconnects it, and HX Fortress goes on alone", async () => {
    const paths = await root();
    await older(paths, { moduleDefaultsApplied: 1, modules: { enabled: [] } });
    const run = await SetupRun.open(runDeps(paths));
    run.set("organization.name", "Northstar");
    run.set("controlPlane.connect", "no");
    const result = await run.finish("terminal");
    if (!result.ok) throw new Error(JSON.stringify(result.checks.filter((check) => !check.ok)));
    expect(result.applied.restart).toEqual(["controlPlane"]);
    expect((await rawConfig(paths)).cloud).toBeUndefined();
    expect((await new FileConfigStore(paths).load()).cloud).toBeUndefined();
  });
});

// ── The terminal ─────────────────────────────────────────────────────────────

const WHOLE = { "Organization, such as": "Northstar", "First administrator, such as": "marta.lindqvist" };

describe("hx-fortress setup in a terminal", () => {
  test("asks every question of the machine itself in order, checks each, and writes them when the person says yes", async () => {
    const paths = await root();
    const run = await SetupRun.open(runDeps(paths));
    const io = scripted(WHOLE);
    const outcome = await runTerminalSetup(run, io, { end: { finish: () => run.finish("terminal") } });
    expect(outcome.ended).toBe("finished");

    // Each question this way asks, once, in order, with its place in the list.
    const asked = stepsAsked("setup");
    expect(io.out.filter((line) => /^Step \d+ of \d+ · /.test(line))).toEqual(
      asked.map((id, index) => `Step ${index + 1} of ${asked.length} · ${stepById(id).name}`),
    );
    expect(io.out).toContain("HX Fortress setup");
    expect(io.out).toContain("Each question comes with an answer. Enter keeps the answer shown in [brackets].");
    expect(io.out).toContain("Who runs this HX Fortress?");
    // No line says how many questions there are, nor claims the list of addresses is held to.
    expect(io.out.filter((line) => /\b\d+ questions\b/.test(line))).toEqual([]);
    expect(io.out.filter((line) => line.includes("and no other"))).toEqual([]);
    expect(io.out.some((line) => /^ {2}\d+ address(es)?$/.test(line))).toBe(true);
    expect((await new FileConfigStore(paths).load()).organization?.name).toBe("Northstar");
    // It never asked for a key, only for names, and read nothing without showing it.
    expect(io.out.join("\n")).toContain("Setup never asks for the key");
    expect(io.secrets).toEqual([]);
    // A choice with one option is said, not asked.
    expect(io.out).toContain("  SSL certificate: None. A proxy or load balancer in front holds it");
    expect(io.out).toContain("  Files: No module that is on keeps files");
  });

  test("the plan is printed before the yes, and saying no saves nothing", async () => {
    const paths = await root();
    const run = await SetupRun.open(runDeps(paths));
    const io = scripted({ ...WHOLE, [LAST_STEP.setup.ask]: false });
    const outcome = await runTerminalSetup(run, io, { end: { finish: () => run.finish("terminal") } });
    expect(outcome.ended).toBe("stopped");
    const yes = io.out.indexOf(LAST_STEP.setup.ask);
    const plan = io.out.indexOf("  On this machine");
    expect(plan).toBeGreaterThan(io.out.indexOf(LAST_STEP.setup.kicker));
    expect(plan).toBeLessThan(yes);
    expect(io.out.slice(plan, yes).join("\n")).toContain("First administrator  marta.lindqvist, with a one-time link");
    expect(io.out).toContain("Setup stopped. Nothing was saved.");
    expect(await exists(paths.config)).toBe(false);
  });

  test("a wrong answer is refused in plain words, and the question is asked again", async () => {
    const paths = await root();
    const run = await SetupRun.open(runDeps(paths));
    let asked = 0;
    const io = scripted({ "First administrator, such as": "marta.lindqvist" });
    const text = io.text;
    io.text = async (message, options) => {
      if (message.includes("Organization, such as") || message.startsWith("  Organization:")) {
        asked += 1;
        io.out.push(message);
        return asked === 1 ? "" : "Northstar";
      }
      return text(message, options);
    };
    const outcome = await runTerminalSetup(run, io, { end: { finish: () => run.finish("terminal") } });
    expect(outcome.ended).toBe("finished");
    expect(asked).toBe(2);
    expect(io.out).toContain("  no  Give the organization a name");
    expect(io.out).toContain("  Answer this question again?");
  });

  test("an answer refused beside the others brings back exactly its question", async () => {
    const paths = await root();
    const run = await SetupRun.open(runDeps(paths));
    // Each passes alone; the end refuses one, and only that one is asked again.
    let ends = 0;
    const io = scripted(WHOLE);
    const outcome = await runTerminalSetup(run, io, {
      end: {
        finish: async () => {
          ends += 1;
          if (ends === 1) {
            return { ok: false, checks: [{ step: "model", ok: false, lines: [{ ok: false, text: "The model did not answer: 503" }] }] };
          }
          return run.finish("terminal");
        },
      },
    });
    expect(outcome.ended).toBe("finished");
    expect(io.out).toContain("  AI model: The model did not answer: 503");
    const steps = io.out.filter((line) => /^Step \d+ of \d+ · /.test(line));
    expect(steps.at(-1)).toBe(`Step ${stepsAsked("setup").indexOf("model") + 1} of ${stepsAsked("setup").length} · AI model`);
    expect(steps).toHaveLength(stepsAsked("setup").length + 1);
  });
});

describe("hx-fortress install in a terminal", () => {
  /** A terminal that picks the place and the answers of Northstar's install on AWS. */
  function install(extra: Record<string, string | boolean> = {}): ReturnType<typeof scripted> {
    const io = scripted({
      ...WHOLE,
      "API key": TYPED,
      "Address, such as": "hx.northstar.example",
      ...extra,
    });
    const select = io.select;
    io.select = async (message, choices, options) => {
      const aws = choices.find((choice) => choice.label === "Amazon Web Services");
      if (aws) {
        io.out.push(message);
        return aws.value;
      }
      return select(message, choices, options);
    };
    return io;
  }

  async function run(place: StandInPlace[]): Promise<SetupRun> {
    const made = await untouchedRoot();
    cleanups.push(made.cleanup);
    return installRun(place, { paths: made.paths });
  }

  test("it asks the steps of the place that was picked, reads a typed key without showing it, prints the plan, then each row it makes", async () => {
    const aws = new StandInPlace("aws");
    const setup = await run([new StandInPlace("azure"), aws]);
    const io = install();
    const outcome = await runTerminalSetup(setup, io, {
      end: { create: () => setup.create("terminal", null, { showAccountLink: true }) },
    });
    expect(outcome.ended).toBe("finished");
    expect(aws.makes).toBe(1);

    const asked = stepsAsked("install");
    expect(io.out.filter((line) => /^Step \d+ of \d+ · /.test(line))).toEqual(
      asked.map((id, index) => `Step ${index + 1} of ${asked.length} · ${stepById(id).name}`),
    );
    expect(io.out).toContain("HX Fortress install");
    expect(io.out.filter((line) => line.includes("and no other"))).toEqual([]);
    // The questions after the first page are those of AWS: no Azure Key Vault is offered there.
    const keys = visibleList({ way: "install", place: "aws" }).find((step) => step.id === "keys");
    expect(keys?.blocks.flatMap((block) => (block.kind === "choice" ? block.options.map((o) => o.name) : []))).not.toContain(
      "Azure Key Vault",
    );
    expect(io.out).toContain("  SSL certificate");
    // The key is read without being shown, and is in no line.
    expect(io.secrets).toEqual(["  API key:"]);
    expect(io.out.join("\n")).not.toContain(TYPED);
    expect(io.out.join("\n")).not.toContain("Pw4m");

    // The plan before the yes, and each row as it is made.
    const yes = io.out.indexOf(LAST_STEP.install.ask);
    const heading = io.out.indexOf("  In your AWS, us-east-1");
    expect(heading).toBeGreaterThan(-1);
    expect(heading).toBeLessThan(yes);
    const rows = setup.derived().plan.rows;
    for (const row of rows) expect(io.out.indexOf(`  ok  ${row.label}: ${row.value}`)).toBeGreaterThan(yes);
    expect(outcome.ended === "finished" && outcome.done?.address).toBe("https://hx.northstar.example");
  });

  test("a refused answer brings its question back, and a failed make offers to try again", async () => {
    const aws = new StandInPlace("aws");
    aws.failNext = { at: "database", kind: "make", text: "The database could not be made in us-east-1: the quota is used up" };
    const setup = await run([aws]);
    let hostnames = 0;
    const io = install();
    const text = io.text;
    io.text = async (message, options) => {
      if (message.includes("Address, such as") || message.startsWith("  Address:")) {
        hostnames += 1;
        io.out.push(message);
        return hostnames === 1 ? "https://hx.northstar.example" : "hx.northstar.example";
      }
      return text(message, options);
    };
    const outcome = await runTerminalSetup(setup, io, { end: { create: () => setup.create("terminal", null) } });
    expect(hostnames).toBe(2);
    expect(io.out).toContain("  no  A hostname, such as hx.your-company.com");
    expect(io.out).toContain("  no  Amazon RDS for PostgreSQL: The database could not be made in us-east-1: the quota is used up");
    expect(io.out).toContain("Try again?");
    expect(outcome.ended).toBe("finished");
    expect(aws.makes).toBe(2);
  });
});

// ── The command ──────────────────────────────────────────────────────────────

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

  async function settings(paths: Paths, file: Record<string, unknown>): Promise<string> {
    const at = path.join(paths.root, "hx-fortress.setup.json");
    await mkdir(paths.root, { recursive: true });
    await writeFile(at, JSON.stringify(file));
    return at;
  }

  test("--file applies a settings file, says what each check found, and records the act", async () => {
    const paths = await root();
    const file = await settings(paths, {
      organization: { name: "Northstar", firstAdministrator: "marta.lindqvist" },
      data: { database: { store: "existing", address: { key: "db-url" } }, files: false },
      modules: { host: true },
    });
    const { code, out } = await command(paths, ["--file", file]);
    expect(code).toBe(0);
    expect(out).toContain("Database");
    expect(out).toContain("  ok  Database reached. PostgreSQL 17.2");
    expect(out.join("\n")).toContain("Setup is saved: Organization");
    expect(out).toContain("Start HX Fortress: hx-fortress start");
    // No terminal, so the first account's link is in a file and not in the output.
    const said = out.join("\n");
    expect(said).toContain("bootstrap-setup-link.txt");
    expect(said).not.toContain("/setup#t=");
    const linkFile = bootstrapLinkPath(paths.uiRoot);
    // Read first, then looked at: nothing here acts on what a look found.
    expect(await readFile(linkFile, "utf8")).toContain("/setup#t=");
    expect((await stat(linkFile)).mode & 0o777).toBe(0o600);

    const records = (await spoolRecords(paths)).filter((r) => r.action === "fortress.setup.finished");
    expect(records.map((r) => [r.kind, r.outcome])).toEqual([
      ["intent", null],
      ["outcome", "done"],
    ]);
    expect(records[0]?.params).toMatchObject({ way: "file" });
    expect(String(records[0]?.params?.changed)).not.toContain("where");
    // The trail names the questions, and holds no answer.
    expect(JSON.stringify(records)).not.toContain("Northstar");
    expect(JSON.stringify(records)).not.toContain("db-url");
  });

  test("--file refuses a wrong file in plain words and saves nothing", async () => {
    const paths = await root();
    const file = await settings(paths, {
      organization: { name: "Northstar" },
      auditTrail: { copyTo: { to: "syslog", address: "syslog.northstar.example" } },
    });
    const { code, out } = await command(paths, ["--file", file]);
    expect(code).toBe(1);
    expect(out).toContain("The settings file is refused:");
    expect(out.join("\n")).toContain("Syslog is not in this build yet");
    expect(out).toContain("Nothing was saved.");
    expect(await exists(paths.config)).toBe(false);
  });

  test("--file with where it runs is refused: that is the install's question", async () => {
    const paths = await root();
    const file = await settings(paths, { where: { place: "azure" }, organization: { name: "Northstar" } });
    const { code, out } = await command(paths, ["--file", file]);
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("where is asked by hx-fortress install");
    expect(await exists(paths.config)).toBe(false);
  });

  test("--file with an answer that fails its check saves nothing and says which", async () => {
    const paths = await root();
    const file = await settings(paths, {
      organization: { name: "Northstar", firstAdministrator: "marta.lindqvist" },
      data: { database: { store: "existing", address: { key: "no-such-key" } } },
    });
    const { code, out } = await command(paths, ["--file", file]);
    expect(code).toBe(1);
    expect(out).toContain("  no  No key with this name");
    expect(out).toContain("Setup cannot finish: an answer is refused. Nothing was saved.");
    expect(await exists(paths.config)).toBe(false);
    const records = (await spoolRecords(paths)).filter((r) => r.action === "fortress.setup.finished");
    expect(records.map((r) => r.outcome)).toEqual([null, "refused"]);
  });

  test("--connect names the control plane and keeps its install id for the first connection, and a bad value is refused without repeating it", async () => {
    const paths = await root();
    const file = await settings(paths, { organization: { name: "Northstar", firstAdministrator: "marta.lindqvist" } });
    const bad = await command(paths, ["--connect", `control.example/${INSTALL_ID}`, "--file", file]);
    expect(bad.code).toBe(1);
    expect(bad.out).toEqual(["error: --connect needs a control plane's address and a one-time install id, written as <address>/i/<id>"]);
    expect(bad.out.join("\n")).not.toContain(INSTALL_ID);
    const pages = await command(paths, ["--connect", `control.example/i/${INSTALL_ID}`, "--pages", "https://app.control.example/x"]);
    expect(pages.out).toEqual(["error: --pages needs one origin, written as https://host, with no path"]);

    const { code, out } = await command(paths, [
      "--connect",
      `control.example/i/${INSTALL_ID}`,
      "--pages",
      PAGES,
      "--file",
      file,
    ]);
    expect(code).toBe(0);
    expect(out).toContain("  ok  An install id is held for the first connection");
    expect(out.join("\n")).not.toContain(INSTALL_ID);
    expect((await rawConfig(paths)).cloud).toEqual({ url: CONTROL });
    expect((await rawConfig(paths)).controlPlane).toEqual({ pages: PAGES });
    expect(await new FilePendingEnrollmentStore(paths.pendingEnrollment).load()).toEqual({ token: INSTALL_ID, cloudUrl: CONTROL });
    // config.json holds the address, and never the id.
    expect(await readFile(paths.config, "utf8")).not.toContain(INSTALL_ID);
  });

  test("a settings file can give an install id by the name of its key", async () => {
    const paths = await root();
    const file = await settings(paths, {
      organization: { name: "Northstar", firstAdministrator: "marta.lindqvist" },
      controlPlane: { address: "control.example", connected: true, token: { key: "install-id" } },
    });
    const { code } = await command(paths, ["--file", file]);
    expect(code).toBe(0);
    expect((await rawConfig(paths)).cloud).toEqual({ url: CONTROL });
    expect((await new FilePendingEnrollmentStore(paths.pendingEnrollment).load())?.token).toBe(INSTALL_ID);
  });

  test("--print writes the present answers as a settings file that --file takes back", async () => {
    const paths = await root();
    const first = await command(paths, ["--print"]);
    expect(first.code).toBe(0);
    const printed = JSON.parse(first.out.join("\n")) as Record<string, unknown>;
    expect(Object.keys(printed)).toEqual(["version", ...STEP_IDS.filter((id) => id !== "where")]);
    expect(printed.controlPlane).toBe(false);
    const file = await settings(paths, { ...printed, organization: { name: "Northstar", firstAdministrator: "marta.lindqvist" } });
    expect((await command(paths, ["--file", file])).code).toBe(0);
  });

  test("check runs every check again and fails when one is refused", async () => {
    const paths = await root();
    const { code, out } = await command(paths, ["check"]);
    expect(code).toBe(1);
    expect(out).toContain("Organization");
    expect(out).toContain("  no  Give the organization a name");
    expect(out).toContain("2 answers are refused.");
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
    const pasted = await command(paths, [`--${["postgres", "user:pw@db"].join("://")}`]);
    expect(pasted.out[0]).toBe("error: unknown option (not shown)");
    const word = await command(paths, ["postgres://user:pw@db/x"], { isTty: true });
    expect(word.code).toBe(1);
    expect(word.out[0]).toBe("error: that is not a question of the setup");
    // Where it runs is the install's question, so it is not one to ask here.
    expect((await command(paths, ["where"], { isTty: true })).out[0]).toBe("error: where is not a question of the setup");
  });

  test("one question can be asked again by its name", async () => {
    const paths = await root();
    const made = await SetupRun.open(runDeps(paths));
    northstar(made);
    expect((await made.finish("terminal")).ok).toBe(true);

    const io = scripted({ "Switch Agentic Sessions on?": false, "Switch Host on?": true, "Switch Databases on?": false });
    const { code, out } = await command(paths, ["modules"], { isTty: true, io });
    expect(code).toBe(0);
    const asked = stepsAsked("setup");
    expect(io.out.filter((line) => /^Step \d+ of \d+ · /.test(line))).toEqual([
      `Step ${asked.indexOf("modules") + 1} of ${asked.length} · Modules`,
    ]);
    expect((await new FileConfigStore(paths).load()).modules.enabled).toEqual(["host"]);
    expect(out.join("\n")).toContain("Setup is saved: Modules.");
    // No start is offered unless the command line gives one.
    expect(out).toContain("Start HX Fortress: hx-fortress start");
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
    expect(printed.map((step) => step.id)).toEqual(stepsAsked("setup"));
    expect(options(printed).every((option) => option.built)).toBe(true);
    // The list itself holds more: the options whose code is not in this build.
    expect(options(SETUP_LIST).some((option) => !option.built)).toBe(true);
  });

  test("at a terminal the first administrator's link is printed", async () => {
    const paths = await root();
    const { code, out } = await command(paths, [], { isTty: true, io: scripted(WHOLE) });
    expect(code).toBe(0);
    expect(out.some((line) => /^ {2}http:\/\/127\.0\.0\.1:\d+\/setup#t=/.test(line))).toBe(true);
  });

  test("with its output in a pipe the link is written to a file only HX Fortress's user can read, and not printed", async () => {
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
  test("setup is a verb of the binary, and help lists it with install", async () => {
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
    const installed: string[][] = [];
    expect(
      await runCli(["install", "--list"], {
        writeLine: () => {},
        runInstall: async (args) => {
          installed.push([...args]);
          return 0;
        },
      }),
    ).toBe(0);
    expect(installed).toEqual([["--list"]]);
    const help: string[] = [];
    await runCli(["help"], { writeLine: (line) => help.push(line) });
    expect(help.join("\n")).toContain("hx-fortress setup");
    expect(help.join("\n")).toContain("hx-fortress install");
  });

  test("a config with no control plane is one the host's parser accepts, and one with a broken address is still refused", () => {
    const base = { schemaVersion: 1, gateway: { publicUrl: "http://localhost:8787" }, modules: { enabled: [] } };
    expect(parseFortressConfig(base).cloud).toBeUndefined();
    expect(() => parseFortressConfig({ ...base, cloud: { url: "https://control.example" } })).toThrow(
      "cloud.url must use ws: or wss:",
    );
    expect(() => parseFortressConfig({ ...base, cloud: {} })).toThrow("cloud.url must be a string");
  });

  test("the folders of a run are the root it is given", () => {
    expect(fortressPaths("/srv/hx").config).toBe(path.join("/srv/hx", "config.json"));
  });
});
