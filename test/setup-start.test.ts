import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { FilePendingEnrollmentStore } from "../src/cloud/credentials";
import { configExists, MODULE_DEFAULTS_KEY } from "../src/host/config";
import { NO_CONTROL_PLANE } from "../src/host/runtime";
import { SetupRun } from "../src/setup/run";
import { NOT_SET_UP } from "../src/setup/state";
import { bootHost, UNREACHABLE_DATABASE_URL, type HostBoot } from "./rig/host-boot";

type Paths = HostBoot["paths"];

/** Answer the setup's questions for a made-up company, on their plain options,
 *  and write them down as the setup does. Nothing here touches the home folder
 *  of whoever runs the test. */
async function setUp(paths: Paths, change: (run: SetupRun) => void = () => {}): Promise<void> {
  const run = await SetupRun.open({
    paths,
    env: {},
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
      // except whether a name exists.
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

let boot: HostBoot | null = null;
afterEach(async () => {
  await boot?.cleanup();
  boot = null;
});

describe("a Fortress with no control plane", () => {
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
    // Nothing asked for a token, and none was left for a later start.
    expect(await new FilePendingEnrollmentStore(boot.paths.pendingEnrollment).load()).toBeNull();
    expect(boot.stdout).not.toContain("No Fortress credentials");
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
          run.set("data.database.store", "postgres");
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

describe("when the Fortress starts, the setup's answers are checked again", () => {
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

  test("an answer that has stopped being true is named, and the Fortress starts all the same", async () => {
    boot = await bootHost({
      // The key store is this environment, and it holds no key named model-key.
      env: { FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL },
      scenario: { enroll: "none", holdMs: 400 },
      prepare: (paths) =>
        setUp(paths, (run) => {
          // Given while the key was there: the test's key store has every name.
          run.set("model.provider", "openai-compatible");
          run.set("model.address", "https://models.northstar.example/v1");
          run.set("model.key", "model-key");
        }),
    });
    expect(boot.report.error).toBeNull();
    expect(boot.report.started).toBe(true);
    expect(boot.stdout).toContain(
      "an answer of the setup no longer passes its check. AI model: No key with this name",
    );
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

describe("a Fortress nobody has set up", () => {
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
    // It is not told that Sessions needs a model: that is not what is wrong.
    expect(boot.stdout).not.toContain("AI model");
    // And the refused start wrote no settings: the next start is refused too,
    // until somebody answers the setup.
    expect(await configExists(boot.paths)).toBe(false);
  }, 40_000);
});
