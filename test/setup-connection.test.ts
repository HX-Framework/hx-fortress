// What the setup writes about session content on the connection.
//
// A new HX Fortress keeps session content off its connection. The setup has
// no question for it: it writes the choice once, when an HX Fortress is first
// set up. It never changes a choice that is already written, and it never
// gives one to an install that was made before the setup.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { FileCredentialStore } from "../src/cloud/credentials";
import { FileConfigStore, resolveSessionContent } from "../src/host/config";
import { SetupRun } from "../src/setup/run";
import { isSetUp } from "../src/setup/state";
import { tempRoot, type Paths } from "./host/_module-rig";
import { CONTROL, northstar, rawConfig, runDeps } from "./setup-rig";

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

async function write(paths: Paths, value: unknown): Promise<void> {
  await mkdir(path.dirname(paths.config), { recursive: true });
  await writeFile(paths.config, JSON.stringify(value));
}

/** Answer the questions as Northstar would, and finish. */
async function setUp(paths: Paths): ReturnType<SetupRun["finish"]> {
  const run = await SetupRun.open(runDeps(paths));
  northstar(run);
  return run.finish("terminal");
}

describe("the setup and session content on the connection", () => {
  test("a new HX Fortress is set up with session content off", async () => {
    const paths = await root();
    expect((await setUp(paths)).ok).toBe(true);
    expect((await rawConfig(paths)).connection).toEqual({ sessionContent: "off" });
    // The parser the daemon starts with reads it, and the start decides "off".
    const config = await new FileConfigStore(paths).load();
    expect(config.connection).toEqual({ sessionContent: "off" });
    expect(resolveSessionContent(null, config)).toBe("off");
  });

  test("a choice a person wrote ahead of the setup stays", async () => {
    const paths = await root();
    // Only this block: the file is not a set-up HX Fortress yet.
    await write(paths, { connection: { sessionContent: "on" } });
    expect(await isSetUp(paths)).toBe(false);
    expect((await setUp(paths)).ok).toBe(true);
    expect((await rawConfig(paths)).connection).toEqual({ sessionContent: "on" });
  });

  test("an empty block written ahead of the setup stays empty: the setup writes over nothing", async () => {
    const paths = await root();
    await write(paths, { connection: {} });
    expect((await setUp(paths)).ok).toBe(true);
    expect((await rawConfig(paths)).connection).toEqual({});
    expect(resolveSessionContent(null, await new FileConfigStore(paths).load())).toBeNull();
  });

  test("a choice written ahead that cannot be read stops the setup, and the file stays as it was", async () => {
    const paths = await root();
    const text = JSON.stringify({ connection: { session_content: "off" } });
    await mkdir(path.dirname(paths.config), { recursive: true });
    await writeFile(paths.config, text);
    await expect(setUp(paths)).rejects.toThrow(
      'Invalid HX Fortress config: connection has a key this build does not know, "session_content"',
    );
    expect(await readFile(paths.config, "utf8")).toBe(text);
  });

  test("an install made before the setup existed is given no choice when it is set up again", async () => {
    const paths = await root();
    await write(paths, {
      schemaVersion: 1,
      cloud: { url: CONTROL },
      gateway: { publicUrl: "http://localhost:8787" },
      // No module is on, and the list is this install's own: nothing needs a
      // file store or a model, so every other answer passes its check.
      modules: { enabled: [] },
      moduleDefaultsApplied: 1,
    });
    // It enrolled once, so it holds the credential the control plane gave it.
    await new FileCredentialStore(paths.credentials).save({
      orgId: "org_northstar",
      fortressId: "fortress_1",
      credential: ["credential", "for", "a", "test"].join("-"),
    });
    const run = await SetupRun.open(runDeps(paths));
    run.set("organization.name", "Northstar");
    const result = await run.finish("terminal");
    expect(result.ok).toBe(true);
    const raw = await rawConfig(paths);
    expect(raw.organization).toEqual({ name: "Northstar" });
    expect("connection" in raw).toBe(false);
    expect(resolveSessionContent(null, await new FileConfigStore(paths).load())).toBeNull();
  });

  test("a second run of the setup does not put the choice back after a person removed it", async () => {
    const paths = await root();
    expect((await setUp(paths)).ok).toBe(true);
    const raw = await rawConfig(paths);
    delete raw.connection;
    await write(paths, raw);
    const again = await SetupRun.open(runDeps(paths));
    again.set("organization.name", "Northstar Analytics");
    expect((await again.finish("terminal")).ok).toBe(true);
    expect("connection" in (await rawConfig(paths))).toBe(false);
  });
});
