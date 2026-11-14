// `connection.sessionContent` in config.json, and the variable that wins over it.
//
// The setting has three states: `on`, `off`, and not there. "Not there" still
// serves session calls, so nothing here may turn a choice somebody made into
// "not there": not a mistyped word, not a re-enrollment, not a switch of a
// module.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ensureCoreModulesEnabled,
  ensureEnrollmentConfig,
  FileConfigStore,
  parseFortressConfig,
  resolveSessionContent,
  sessionContentFromEnv,
  setModuleEnabled,
} from "../src/host/config";
import { fortressPaths } from "../src/host/paths";

const BASE = {
  schemaVersion: 1,
  cloud: { url: "wss://control.example/v1/connection" },
  gateway: { publicUrl: "http://localhost:8787" },
  modules: { enabled: ["session_vault", "host"] },
  moduleDefaultsApplied: 1,
};

describe("reading the setting", () => {
  test("on and off are read; a file without the setting has none", () => {
    expect(parseFortressConfig({ ...BASE, connection: { sessionContent: "off" } }).connection).toEqual({
      sessionContent: "off",
    });
    expect(parseFortressConfig({ ...BASE, connection: { sessionContent: "on" } }).connection).toEqual({
      sessionContent: "on",
    });
    expect(parseFortressConfig(BASE).connection).toBeUndefined();
    // An empty block says nothing, and stays out of the typed config.
    expect(parseFortressConfig({ ...BASE, connection: {} }).connection).toBeUndefined();
  });

  test("anything else is refused, so a mistyped word is never read as no choice", () => {
    for (const connection of [
      { sessionContent: "of" },
      { sessionContent: "OFF" },
      { sessionContent: "" },
      { sessionContent: false },
      { sessionContent: 0 },
      { sessionContent: null },
      { sessionContent: ["off"] },
      "off",
      ["off"],
      null,
      7,
    ]) {
      expect(() => parseFortressConfig({ ...BASE, connection })).toThrow(/Invalid Fortress config: connection/);
    }
  });

  test("the variable is one of two words, in any case, or it stops the start", () => {
    expect(sessionContentFromEnv({})).toBeNull();
    expect(sessionContentFromEnv({ FORTRESS_CONNECTION_SESSION_CONTENT: "" })).toBeNull();
    expect(sessionContentFromEnv({ FORTRESS_CONNECTION_SESSION_CONTENT: "  " })).toBeNull();
    expect(sessionContentFromEnv({ FORTRESS_CONNECTION_SESSION_CONTENT: "off" })).toBe("off");
    expect(sessionContentFromEnv({ FORTRESS_CONNECTION_SESSION_CONTENT: " Off " })).toBe("off");
    expect(sessionContentFromEnv({ FORTRESS_CONNECTION_SESSION_CONTENT: "ON" })).toBe("on");
    for (const value of ["of", "0", "false", "no", "disabled", "off,on"]) {
      expect(() => sessionContentFromEnv({ FORTRESS_CONNECTION_SESSION_CONTENT: value })).toThrow(
        "FORTRESS_CONNECTION_SESSION_CONTENT must be on or off",
      );
    }
  });

  test("the variable wins over config.json, and with neither nobody chose", () => {
    const off = { connection: { sessionContent: "off" as const } };
    const on = { connection: { sessionContent: "on" as const } };
    expect(resolveSessionContent(off, {})).toBe("off");
    expect(resolveSessionContent(on, {})).toBe("on");
    expect(resolveSessionContent(off, { FORTRESS_CONNECTION_SESSION_CONTENT: "on" })).toBe("on");
    expect(resolveSessionContent(on, { FORTRESS_CONNECTION_SESSION_CONTENT: "off" })).toBe("off");
    expect(resolveSessionContent({}, { FORTRESS_CONNECTION_SESSION_CONTENT: "off" })).toBe("off");
    expect(resolveSessionContent(null, { FORTRESS_CONNECTION_SESSION_CONTENT: "off" })).toBe("off");
    expect(resolveSessionContent({}, {})).toBeNull();
    expect(resolveSessionContent(null, {})).toBeNull();
  });
});

describe("the setting stays in config.json", () => {
  let root = "";
  let paths: ReturnType<typeof fortressPaths>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-config-connection-"));
    paths = fortressPaths(root);
    await mkdir(path.dirname(paths.config), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const write = (value: unknown): Promise<void> => writeFile(paths.config, `${JSON.stringify(value, null, 2)}\n`);
  const raw = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(paths.config, "utf8")) as Record<string, unknown>;

  test("through an enrollment that rewrites the file", async () => {
    await write({ ...BASE, connection: { sessionContent: "off" } });
    await ensureEnrollmentConfig(paths, "wss://other.control.example/v1/connection");
    expect((await raw()).connection).toEqual({ sessionContent: "off" });
    expect((await new FileConfigStore(paths).load()).cloud.url).toBe("wss://other.control.example/v1/connection");
  });

  test("through an enrollment over a file whose other fields do not pass", async () => {
    // The address is cleartext to a host that is not this one, which the check
    // refuses. The choice about session content is still readable, and kept.
    await write({ ...BASE, cloud: { url: "ws://control.example/v1/connection" }, connection: { sessionContent: "off" } });
    await expect(new FileConfigStore(paths).load()).rejects.toThrow();
    await ensureEnrollmentConfig(paths, "wss://control.example/v1/connection");
    expect((await new FileConfigStore(paths).load()).connection).toEqual({ sessionContent: "off" });
  });

  test("an enrollment refuses a file whose setting cannot be read, and leaves the file as it is", async () => {
    for (const connection of [{ sessionContent: "of" }, { sessionContent: null }, "off", null]) {
      const before = { ...BASE, connection };
      await write(before);
      await expect(ensureEnrollmentConfig(paths, "wss://other.control.example/v1/connection")).rejects.toThrow(
        'connection.sessionContent must be "on" or "off"',
      );
      expect(await raw()).toEqual(before);
    }
  });

  test("through a module switch and through the start that applies the default modules", async () => {
    await write({ ...BASE, modules: { enabled: ["session_vault"] }, connection: { sessionContent: "off" } });
    await ensureCoreModulesEnabled(paths, { sessions: "off" });
    expect((await raw()).connection).toEqual({ sessionContent: "off" });
    await setModuleEnabled(paths, "host", true);
    await setModuleEnabled(paths, "host", false);
    expect((await raw()).connection).toEqual({ sessionContent: "off" });
    expect((await new FileConfigStore(paths).load()).connection).toEqual({ sessionContent: "off" });
  });
});
