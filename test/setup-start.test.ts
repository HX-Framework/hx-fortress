// What happens when HX Fortress starts after its setup: the daemon itself,
// booted in a child process, and the first start of an HX Fortress that an
// install made somewhere else, which sets itself up from the settings the
// install handed over before anything else runs.

import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { runSetupCommand } from "../src/cli-setup";
import { FilePendingEnrollmentStore } from "../src/cloud/credentials";
import { setupArgs } from "../src/container-run";
import { configExists, MODULE_DEFAULTS_KEY } from "../src/host/config";
import { NO_CONTROL_PLANE } from "../src/host/runtime";
import { FIRST_ACCOUNT_DIGEST_ENV, FIRST_ACCOUNT_EXPIRES_ENV } from "../src/install/handover";
import type { HandOver } from "../src/install/place";
import { INSTALL_LINK_LIFE_MS, linkIsElsewhere, SetupRun, type Connect } from "../src/setup/run";
import { needsSetupFirst, NOT_SET_UP, readSetupMark, SETUP_FILE_ENV, SETUP_SETTINGS_ENV } from "../src/setup/state";
import { bootstrapLinkPath, judgeMintedLink } from "../src/ui/bootstrap-user";
import { liveSetupToken, UsersStore } from "../src/ui/users";
import { fixedSecrets, tempRoot, type Paths } from "./host/_module-rig";
import { answerNorthstar, installRun, StandInPlace, untouchedRoot } from "./install-rig";
import { bootHost, UNREACHABLE_DATABASE_URL, type HostBoot } from "./rig/host-boot";
import { CONTROL, DB_URL, INSTALL_ID, rawConfig } from "./setup-rig";

type BootPaths = HostBoot["paths"];

// Built at run time so no secret-shaped literal sits in the repository.
const MODEL_KEY = ["sk", "ant", "typed", "Wd5hNotAReal0ne"].join("-");

/** Answer the setup's questions for a made-up company, on their plain options,
 *  and write them down as the setup does. Nothing here touches the home folder
 *  of whoever runs the test. */
async function setUp(
  paths: BootPaths,
  change: (run: SetupRun) => void = () => {},
  connect: Connect | null = null,
): Promise<void> {
  const run = await SetupRun.open({
    paths,
    env: {},
    ...(connect ? { connect } : {}),
    read: { vaultCredentials: async () => null },
    apply: {
      updateVaultCredentials: async () => {
        throw new Error("no test here keeps files");
      },
    },
    check: {
      fetch: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      probeDatabase: async () => "PostgreSQL 17.2",
      // The key store the answers name is asked for nothing in these tests
      // except whether a name exists, and for the address of the database.
      keyStore: () => ({
        kind: "env",
        get: async () => UNREACHABLE_DATABASE_URL,
        has: async () => true,
      }),
    },
  });
  run.set("organization.name", "Northstar");
  run.set("organization.firstAdministrator", "marta.lindqvist");
  change(run);
  const result = await run.finish("terminal");
  if (!result.ok) throw new Error(`the setup was refused: ${JSON.stringify(result.checks.filter((c) => !c.ok))}`);
}

/** Run the setup once more on an HX Fortress that is set up, and change answers. */
async function setUpAgain(paths: BootPaths, change: (run: SetupRun) => void): Promise<void> {
  const run = await SetupRun.open({
    paths,
    env: {},
    read: { vaultCredentials: async () => null },
    check: {
      fetch: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      probeDatabase: async () => "PostgreSQL 17.2",
      keyStore: () => ({ kind: "env", get: async () => UNREACHABLE_DATABASE_URL, has: async () => true }),
    },
  });
  change(run);
  const result = await run.finish("terminal");
  if (!result.ok) throw new Error(`the setup was refused: ${JSON.stringify(result.checks.filter((c) => !c.ok))}`);
}

let boot: HostBoot | null = null;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await boot?.cleanup();
  boot = null;
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function root(): Promise<Paths> {
  const made = await tempRoot();
  cleanups.push(made.cleanup);
  return made.paths;
}

describe("an HX Fortress with no control plane", () => {
  test("starts, runs, and opens no connection to anything", async () => {
    boot = await bootHost({
      env: { FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL },
      scenario: { enroll: "none" },
      prepare: (paths) => setUp(paths),
    });
    expect(boot.report.error).toBeNull();
    expect(boot.report.started).toBe(true);
    // The loopback control plane the rig runs was never spoken to.
    expect(boot.report.frames).toEqual([]);

    const config = JSON.parse(await readFile(boot.paths.config, "utf8")) as Record<string, unknown>;
    expect(config.cloud).toBeUndefined();
    // Nothing asked for an install id, and none was left for a later start.
    expect(await new FilePendingEnrollmentStore(boot.paths.pendingEnrollment).load()).toBeNull();
    expect(boot.stdout).not.toContain("No HX Fortress credentials");
    expect(boot.stdout).not.toContain("not set up");
  }, 40_000);

  test("its status says it has no control plane, in its own word, and not that a connection failed", async () => {
    boot = await bootHost({
      env: { FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL },
      scenario: { enroll: "none" },
      prepare: (paths) => setUp(paths),
    });
    const status = (await boot.status()) as { connection?: { state: string; reason: string | null }; host?: { error: string | null } };
    expect(status.connection).toMatchObject({ state: "offline", reason: NO_CONTROL_PLANE });
    expect(status.host?.error).toBeNull();
  }, 40_000);

  test("reads the database's address by the name the setup wrote, and writes that address nowhere", async () => {
    boot = await bootHost({
      // The key store is the environment: a key named db-url is this variable.
      env: { FORTRESS_SECRET_DB_URL: UNREACHABLE_DATABASE_URL },
      databaseInConfig: true,
      scenario: { enroll: "none" },
      prepare: (paths) =>
        setUp(paths, (run) => {
          run.set("data.database.store", "existing");
          run.set("data.database.address", "db-url");
        }),
    });
    expect(boot.report.error).toBeNull();
    expect(boot.report.started).toBe(true);
    const config = JSON.parse(await readFile(boot.paths.config, "utf8")) as { postgres?: unknown };
    expect(config.postgres).toEqual({ urlSecret: "db-url" });
    // It went to the organization's own database, not to one on this disk.
    const status = (await boot.status()) as { postgres?: { phase: string } };
    expect(status.postgres?.phase).toBe("retrying");
    expect(await boot.whereWritten(UNREACHABLE_DATABASE_URL)).toEqual([]);
  }, 40_000);
});

describe("when HX Fortress starts, the setup's answers are checked again", () => {
  test("and the log says so when every one still passes", async () => {
    boot = await bootHost({
      env: { FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL },
      scenario: { enroll: "none", holdMs: 400 },
      prepare: (paths) => setUp(paths),
    });
    expect(boot.report.error).toBeNull();
    expect(boot.stdout).toContain("every answer of the setup passes its check");
    expect(boot.stdout).not.toContain("no longer passes its check");
  }, 40_000);

  test("an answer that has stopped being true is named, and HX Fortress starts all the same", async () => {
    boot = await bootHost({
      // The key store is this environment, and it holds no key named model-key.
      env: { FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL },
      scenario: { enroll: "none", holdMs: 400 },
      prepare: (paths) =>
        setUp(paths, (run) => {
          // Given while the key was there: the test's key store has every name.
          run.set("model.provider", "openai");
          run.set("model.address", "https://models.northstar.example/v1");
          run.set("model.key", "model-key");
        }),
    });
    expect(boot.report.error).toBeNull();
    expect(boot.report.started).toBe(true);
    expect(boot.stdout).toContain("an answer of the setup no longer passes its check. AI model: No key with this name");
    expect(boot.stdout).not.toContain("every answer of the setup passes its check");
  }, 40_000);
});

describe("an install made before the setup existed", () => {
  test("starts as before, and is not held to questions nobody asked it", async () => {
    boot = await bootHost({
      env: { FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL },
      scenario: { enroll: "none", holdMs: 400 },
      // A config.json as an earlier build wrote it: no organization, and no
      // mark of a finished setup.
      prepare: async (paths) => {
        await mkdir(path.dirname(paths.config), { recursive: true });
        await writeFile(
          paths.config,
          JSON.stringify({
            schemaVersion: 1,
            gateway: { publicUrl: "http://localhost:8787" },
            modules: { enabled: [] },
            [MODULE_DEFAULTS_KEY]: 1,
          }),
        );
      },
    });
    expect(boot.report.error).toBeNull();
    expect(boot.report.started).toBe(true);
    // Nothing is said about the setup's answers, either way.
    expect(boot.stdout).not.toContain("passes its check");
    expect(boot.stdout).not.toContain("Give the organization a name");
  }, 40_000);
});

describe("an HX Fortress nobody has set up", () => {
  test("a config.json that holds only a block written ahead of the setup does not start one, and is left as it is", async () => {
    const ahead = JSON.stringify({ secrets: { provider: "env" } });
    boot = await bootHost({
      env: { FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL },
      scenario: { enroll: "none" },
      prepare: async (paths) => {
        await mkdir(path.dirname(paths.config), { recursive: true });
        await writeFile(paths.config, ahead);
      },
    });
    expect(boot.report.started).toBe(false);
    expect(boot.report.error).toBe(NOT_SET_UP);
    expect(await readFile(boot.paths.config, "utf8")).toBe(ahead);
  }, 40_000);

  test("does not start, and says in one sentence what to run", async () => {
    boot = await bootHost({
      env: { FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL },
      scenario: { enroll: "none" },
    });
    expect(boot.report.started).toBe(false);
    expect(boot.report.error).toBe(NOT_SET_UP);
    // The status file a terminal or a console reads says why it is not running.
    const status = (await boot.status()) as { host?: { state: string; error: string | null } };
    expect(status.host?.error).toBe(NOT_SET_UP);
    expect(status.host?.state).not.toBe("running");
    // It is not told that Agentic Sessions needs a model: that is not what is wrong.
    expect(boot.stdout).not.toContain("AI model");
    // And the refused start wrote no settings: the next start is refused too,
    // until somebody answers the setup.
    expect(await configExists(boot.paths)).toBe(false);
  }, 40_000);
});

// ── A first start with handed-over settings ──────────────────────────────────

/** Northstar's install in a stand-in Azure, made to the end: what it handed over. */
async function handedOver(options: { showAccountLink: boolean; firstAdministrator?: string }): Promise<{ handOver: HandOver; link: string | null }> {
  const made = await untouchedRoot();
  cleanups.push(made.cleanup);
  const place = new StandInPlace("azure");
  const run = await installRun([place], { paths: made.paths });
  answerNorthstar(run, MODEL_KEY);
  if (options.firstAdministrator) run.set("organization.firstAdministrator", options.firstAdministrator);
  const started = await run.create("browser", null, { showAccountLink: options.showAccountLink });
  if (!started.ok) throw new Error(JSON.stringify(started.checks.filter((check) => !check.ok)));
  await started.ended;
  return { handOver: place.handOver, link: run.done()?.firstAccount?.link ?? null };
}

/** The first start of the HX Fortress the install made: `setup --from-environment`,
 *  as its container's entry point runs it, with the place's key store faked. */
async function firstStart(
  paths: Paths,
  env: Record<string, string | undefined>,
): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  const code = await runSetupCommand(["--from-environment", "--starts-after"], {
    writeLine: (line) => out.push(line),
    fortressRoot: paths.root,
    env,
    isTty: false,
    daemonPid: async () => null,
    run: {
      read: { vaultCredentials: async () => null },
      apply: {
        updateVaultCredentials: async () => {
          throw new Error("no test here keeps files");
        },
      },
      check: {
        // What the place wrote into the vault it made.
        keyStore: () => fixedSecrets({ "model-key": MODEL_KEY, "database-address": DB_URL }),
        fetch: (async () => new Response('{"data":[]}', { status: 200 })) as unknown as typeof fetch,
        probeDatabase: async () => "PostgreSQL 17.2",
        timeoutMs: 2_000,
      },
    },
  });
  return { code, out };
}

const environmentOf = (handOver: HandOver): Record<string, string> => ({
  ...handOver.environment,
  ...handOver.secretEnvironment,
});

describe("a connection that was switched off before it was ever made", () => {
  test("a start leaves the install id that waits alone: nothing is dialed, and config.json names no control plane", async () => {
    boot = await bootHost({
      env: { FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL },
      scenario: { enroll: "none" },
      prepare: async (paths) => {
        // The setup names a control plane and holds its install id, while nothing runs.
        await setUp(paths, () => {}, { address: "control.example", id: INSTALL_ID });
        const named = JSON.parse(await readFile(paths.config, "utf8")) as { cloud?: { url: string } };
        expect(named.cloud?.url).toBe(CONTROL);
        // Then an administrator switches the connection off.
        await setUpAgain(paths, (run) => {
          expect(run.set("controlPlane.connected", "off")).toBe(true);
        });
      },
    });
    expect(boot.report.error).toBeNull();
    expect(boot.report.started).toBe(true);
    expect(boot.report.frames).toEqual([]);

    const config = JSON.parse(await readFile(boot.paths.config, "utf8")) as {
      cloud?: unknown;
      setup?: { disconnectedFrom?: string };
    };
    // The start did not write the control plane back, and spent nothing.
    expect(config.cloud).toBeUndefined();
    expect(config.setup?.disconnectedFrom).toBe(CONTROL);
    // The id still waits, for the day the connection is switched on.
    expect((await new FilePendingEnrollmentStore(boot.paths.pendingEnrollment).load())?.cloudUrl).toBe(CONTROL);
    const status = (await boot.status()) as { connection?: { state: string; reason: string | null } };
    expect(status.connection).toMatchObject({ state: "offline", reason: NO_CONTROL_PLANE });
  }, 40_000);
});

describe("a first start with settings an install handed over", () => {
  test("is set up first: also when the two enrollment variables are set, and from the settings before a file", async () => {
    const paths = await root();
    const settings = JSON.stringify({ organization: { name: "Northstar" } });
    expect(await needsSetupFirst(paths, {})).toBe(true);
    expect(await needsSetupFirst(paths, { [SETUP_SETTINGS_ENV]: settings })).toBe(true);
    expect(
      await needsSetupFirst(paths, { [SETUP_SETTINGS_ENV]: settings, FORTRESS_CLOUD_URL: CONTROL, FORTRESS_ENROLL_TOKEN: INSTALL_ID }),
    ).toBe(true);
    // The two variables alone start as they always did, and write the settings themselves.
    expect(await needsSetupFirst(paths, { FORTRESS_CLOUD_URL: CONTROL, FORTRESS_ENROLL_TOKEN: INSTALL_ID })).toBe(false);
    expect(await needsSetupFirst(paths, { [SETUP_SETTINGS_ENV]: "  " })).toBe(true);

    // The settings stay in the environment: their text is never an argument.
    const args = setupArgs({ [SETUP_SETTINGS_ENV]: settings, [SETUP_FILE_ENV]: "/run/hx/settings.json" });
    expect(args).toEqual(["setup", "--from-environment", "--starts-after"]);
    expect(args.join(" ")).not.toContain("Northstar");
    expect(setupArgs({ [SETUP_FILE_ENV]: "/run/hx/settings.json" })).toEqual(["setup", "--file", "/run/hx/settings.json", "--starts-after"]);
    expect(setupArgs({})).toEqual(["setup", "--browser", "--starts-after"]);
  });

  test("setup --from-environment applies them, marks the way install, and makes the first administrator with a link on its own disk", async () => {
    const { handOver } = await handedOver({ showAccountLink: false });
    expect(handOver.environment[FIRST_ACCOUNT_DIGEST_ENV]).toBeUndefined();
    const paths = await root();
    const { code, out } = await firstStart(paths, environmentOf(handOver));
    if (code !== 0) throw new Error(out.join("\n"));
    expect(out.at(-1)).toBe("HX Fortress starts now.");
    expect((await readSetupMark(paths))?.by).toBe("install");

    const raw = await rawConfig(paths);
    expect(raw.organization).toEqual({ name: "Northstar" });
    expect(raw.model).toEqual({ provider: "anthropic", key: "model-key" });
    // What the environment decides stays there: no install facts, no key store, no database.
    for (const key of ["install", "secrets", "postgres"]) expect(raw[key]).toBeUndefined();
    expect(JSON.stringify(raw)).not.toContain(MODEL_KEY);

    const users = await new UsersStore(path.join(paths.uiRoot, "users.json")).load();
    expect(users.users.map((user) => user.login)).toEqual(["marta.lindqvist"]);
    const linkFile = bootstrapLinkPath(paths.uiRoot);
    // Read first, then looked at.
    expect((await readFile(linkFile, "utf8")).trim()).toStartWith("https://hx.northstar.example/setup#t=");
    expect((await stat(linkFile)).mode & 0o777).toBe(0o600);
    expect(out.join("\n")).not.toContain("#t=");
  });

  test("an answer the environment decides is left as it is when the settings leave it out", async () => {
    const paths = await root();
    const { code, out } = await firstStart(paths, {
      FORTRESS_UI_BOOTSTRAP_USER: "marta.lindqvist",
      [SETUP_SETTINGS_ENV]: JSON.stringify({ organization: { name: "Northstar" }, model: false }),
    });
    if (code !== 0) throw new Error(out.join("\n"));
    const users = await new UsersStore(path.join(paths.uiRoot, "users.json")).load();
    expect(users.users.map((user) => user.login)).toEqual(["marta.lindqvist"]);
  });

  test("settings that give an answer the environment decides another value are refused, by the variable's name, and save nothing", async () => {
    const paths = await root();
    const { code, out } = await firstStart(paths, {
      FORTRESS_SESSIONS: "on",
      [SETUP_SETTINGS_ENV]: JSON.stringify({
        organization: { name: "Northstar", firstAdministrator: "marta.lindqvist" },
        modules: { session_vault: false },
      }),
    });
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("FORTRESS_SESSIONS");
    expect(out).toContain("Setup cannot finish: an answer is refused. Nothing was saved.");
    expect(await configExists(paths)).toBe(false);
  });

  test("settings that are refused, or none, exit 1 and save nothing", async () => {
    for (const [text, said] of [
      [JSON.stringify({ where: { place: "azure" } }), "The settings in FORTRESS_SETUP_SETTINGS are refused:"],
      ["{not json", "The settings in FORTRESS_SETUP_SETTINGS are refused:"],
      [JSON.stringify({ model: { provider: "openai", key: MODEL_KEY } }), "The settings in FORTRESS_SETUP_SETTINGS are refused:"],
      ["   ", "error: FORTRESS_SETUP_SETTINGS holds no settings"],
    ] as const) {
      const paths = await root();
      const { code, out } = await firstStart(paths, { [SETUP_SETTINGS_ENV]: text });
      expect([text, code]).toEqual([text, 1]);
      expect(out[0]).toBe(said);
      expect(out.join("\n")).not.toContain(MODEL_KEY);
      expect(await configExists(paths)).toBe(false);
    }
  });
});

// ── The first administrator's link, minted by the install ───────────────────

describe("the first administrator's link from the install", () => {
  test("a link with no end time, an end time that passed, one too far ahead or one that is no time makes no account, says how to make one, and repeats no digest", async () => {
    const { handOver } = await handedOver({ showAccountLink: true });
    const digest = handOver.environment[FIRST_ACCOUNT_DIGEST_ENV] as string;
    const hour = 60 * 60 * 1000;
    for (const [ends, said] of [
      [null, "FORTRESS_UI_BOOTSTRAP_TOKEN_EXPIRES is not set"],
      [new Date(Date.now() - hour).toISOString(), "the link's end time has passed"],
      [new Date(Date.now() + 25 * hour).toISOString(), "more than 24 hours ahead of this console's clock"],
      ["tomorrow", "is not an ISO 8601 time with its offset"],
    ] as const) {
      const env: Record<string, string> = { ...environmentOf(handOver) };
      if (ends === null) delete env[FIRST_ACCOUNT_EXPIRES_ENV];
      else env[FIRST_ACCOUNT_EXPIRES_ENV] = ends;
      const paths = await root();
      const { code, out } = await firstStart(paths, env);
      const text = out.join("\n");
      // HX Fortress still starts: its settings are whole, and one command makes the account.
      expect([ends, code]).toEqual([ends, 0]);
      expect(text).toContain(said);
      expect(text).toContain("The settings were saved, but the account for marta.lindqvist was not made.");
      expect(text).toContain("Make it with: hx-fortress ui user create marta.lindqvist --role operator");
      expect(text).not.toContain(digest);
      const users = await new UsersStore(path.join(paths.uiRoot, "users.json")).load();
      expect(users.users).toEqual([]);
      expect(await stat(bootstrapLinkPath(paths.uiRoot)).then(() => "written", () => "absent")).toBe("absent");
    }
  });

  test("the link counts only for the login the environment names: an account the settings name gets its own link", async () => {
    const { handOver } = await handedOver({ showAccountLink: true });
    const digest = handOver.environment[FIRST_ACCOUNT_DIGEST_ENV] as string;
    const env: Record<string, string> = { ...environmentOf(handOver) };
    delete env.FORTRESS_UI_BOOTSTRAP_USER;
    env[SETUP_SETTINGS_ENV] = JSON.stringify({
      ...(JSON.parse(env[SETUP_SETTINGS_ENV] ?? "{}") as Record<string, unknown>),
      organization: { name: "Northstar", firstAdministrator: "erik.holm" },
    });
    const paths = await root();
    const { code, out } = await firstStart(paths, env);
    if (code !== 0) throw new Error(out.join("\n"));
    const users = await new UsersStore(path.join(paths.uiRoot, "users.json")).load();
    expect(users.users.map((user) => user.login)).toEqual(["erik.holm"]);
    expect(users.users[0]?.setupTokens.map((record) => record.digest)).not.toContain(digest);
    expect(await stat(bootstrapLinkPath(paths.uiRoot)).then(() => "written", () => "absent")).toBe("written");
  });

  test("the install's link lives 23 hours, so an engineer's clock that runs ahead still leaves the new HX Fortress an account", async () => {
    const before = Date.now();
    const { handOver } = await handedOver({ showAccountLink: true });
    const ends = Date.parse(handOver.environment[FIRST_ACCOUNT_EXPIRES_ENV] ?? "");
    expect(INSTALL_LINK_LIFE_MS).toBe(23 * 60 * 60 * 1000);
    expect(ends).toBeGreaterThanOrEqual(before + INSTALL_LINK_LIFE_MS);
    expect(ends).toBeLessThanOrEqual(Date.now() + INSTALL_LINK_LIFE_MS);
    // HX Fortress's clock is 50 minutes behind the computer that minted the link.
    const judged = judgeMintedLink({
      tokenDigest: handOver.environment[FIRST_ACCOUNT_DIGEST_ENV],
      tokenExpires: handOver.environment[FIRST_ACCOUNT_EXPIRES_ENV],
      accounts: 0,
      now: new Date(before - 50 * 60 * 1000),
    });
    expect(judged.use).toBe("digest");
    // With accounts already there, the same link makes nothing.
    expect(
      judgeMintedLink({
        tokenDigest: handOver.environment[FIRST_ACCOUNT_DIGEST_ENV],
        tokenExpires: handOver.environment[FIRST_ACCOUNT_EXPIRES_ENV],
        accounts: 1,
        now: new Date(),
      }),
    ).toMatchObject({ use: "refused", because: "accounts" });
  });

  test("the account the first start makes holds the handed-over digest, so the install's own link is the one that works", async () => {
    const { handOver, link } = await handedOver({ showAccountLink: true });
    const digest = handOver.environment[FIRST_ACCOUNT_DIGEST_ENV];
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    const token = (link ?? "").slice((link ?? "").indexOf("#t=") + 3);
    expect(createHash("sha256").update(token).digest("hex")).toBe(digest as string);

    const paths = await root();
    const { code, out } = await firstStart(paths, environmentOf(handOver));
    if (code !== 0) throw new Error(out.join("\n"));
    const users = await new UsersStore(path.join(paths.uiRoot, "users.json")).load();
    const account = users.users.find((user) => user.login === "marta.lindqvist");
    expect(account?.setupTokens.map((record) => record.digest)).toEqual([digest as string]);
    expect(account && liveSetupToken(account, token, new Date())).toBeTruthy();
    // No second link is made, so none is written down, and the output says where the link is.
    expect(await stat(bootstrapLinkPath(paths.uiRoot)).then(() => "written", () => "absent")).toBe("absent");
    expect(out).toContain(linkIsElsewhere("marta.lindqvist"));
    expect(out.join("\n")).not.toContain(digest as string);
    expect(out.join("\n")).not.toContain("#t=");

    // Without the digest and its expiry the setup makes its own link, as before.
    const own = await root();
    const plain = Object.fromEntries(
      Object.entries(environmentOf(handOver)).filter(([name]) => !name.startsWith("FORTRESS_UI_BOOTSTRAP_TOKEN_")),
    );
    expect((await firstStart(own, plain)).code).toBe(0);
    expect(await stat(bootstrapLinkPath(own.uiRoot)).then(() => "written", () => "absent")).toBe("written");
  });

  describe("with an email address as the login", () => {
    test("an install's first administrator may be an email address, which suggests the address, and the first start makes that account", async () => {
      const made = await untouchedRoot();
      cleanups.push(made.cleanup);
      const place = new StandInPlace("azure");
      const run = await installRun([place], { paths: made.paths });
      run.set("organization.name", "Northstar");
      run.set("organization.firstAdministrator", "marta.lindqvist@northstar.example");
      expect(run.answers.address.hostname).toBe("hx.northstar.example");
      run.setTyped("model.key", MODEL_KEY);
      expect((await run.check("organization")).ok).toBe(true);
      const started = await run.create("browser", null, { showAccountLink: false });
      if (!started.ok) throw new Error(JSON.stringify(started.checks.filter((check) => !check.ok)));
      await started.ended;
      expect(place.handOver.environment.FORTRESS_UI_BOOTSTRAP_USER).toBe("marta.lindqvist@northstar.example");

      const paths = await root();
      const { code, out } = await firstStart(paths, environmentOf(place.handOver));
      if (code !== 0) throw new Error(out.join("\n"));
      const users = await new UsersStore(path.join(paths.uiRoot, "users.json")).load();
      expect(users.users.map((user) => user.login)).toEqual(["marta.lindqvist@northstar.example"]);
    });
  });
});
