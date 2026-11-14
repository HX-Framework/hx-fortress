// `connection.sessionContent` in config.json, and the variable that wins over it.
//
// The setting has three states: `on`, `off`, and not there. "Not there" still
// serves session calls, so nothing here may turn a choice somebody made into
// "not there": not a mistyped word, not a re-enrollment, not a switch of a
// module.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  configStoreAgreeingOnSessionContent,
  ensureCoreModulesEnabled,
  ensureEnrollmentConfig,
  FileConfigStore,
  parseFortressConfig,
  resolveSessionContent,
  sessionContentFromEnv,
  setModuleEnabled,
} from "../src/host/config";
import { fortressPaths } from "../src/host/paths";
import type { FortressConfig } from "../src/host/types";

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

  test("a key the block does not have is refused, so a mistyped key is never read as no choice", () => {
    for (const connection of [
      { session_content: "off" },
      { SessionContent: "off" },
      { sessioncontent: "off" },
      { "session-content": "off" },
      { sessionContent: "off", session_content: "on" },
      { sessionContent: "off", proxy: "http://proxy.northstar.example:3128" },
    ]) {
      expect(() => parseFortressConfig({ ...BASE, connection })).toThrow(
        /Invalid Fortress config: connection has a key this build does not know, ".+"; its one key is sessionContent/,
      );
    }
  });

  test("the setting anywhere but in its block is refused, so a mistyped block is never read as no choice", () => {
    for (const misplaced of [
      { sessionContent: "off" },
      { session_content: "off" },
      { conection: { sessionContent: "off" } },
      { Connection: { sessionContent: "off" } },
      { connections: { session_content: "off" } },
      { gateway: { publicUrl: "http://localhost:8787", sessionContent: "off" } },
    ]) {
      expect(() => parseFortressConfig({ ...BASE, ...misplaced })).toThrow(
        /Invalid Fortress config: the choice about session content is read only from connection\.sessionContent, and this file has it under ".+"/,
      );
    }
    // A key of the operator's own that is long is said back cut, not in full.
    const long = `sessionContent${"x".repeat(200)}`;
    const refused = (() => {
      try {
        parseFortressConfig({ ...BASE, [long]: "off" });
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(refused).toContain("...");
    expect(refused.length).toBeLessThan(200);
  });

  test("a config.json from before the setting is read as it always was", () => {
    // Every key an install can have today, and none of them is near the setting.
    const config = parseFortressConfig({
      ...BASE,
      postgres: { mode: "embedded" },
      roster: { inactivePurgeDays: 30 },
      secrets: { provider: "file" },
    });
    expect(config.connection).toBeUndefined();
    expect(config.modules.enabled).toEqual(["session_vault", "host"]);
  });

  test("the variable is one of two words, in any case, or it stops the start", () => {
    expect(sessionContentFromEnv({})).toBeNull();
    expect(sessionContentFromEnv({ FORTRESS_CONNECTION_SESSION_CONTENT: undefined })).toBeNull();
    expect(sessionContentFromEnv({ FORTRESS_CONNECTION_SESSION_CONTENT: "off" })).toBe("off");
    expect(sessionContentFromEnv({ FORTRESS_CONNECTION_SESSION_CONTENT: " Off " })).toBe("off");
    expect(sessionContentFromEnv({ FORTRESS_CONNECTION_SESSION_CONTENT: "ON" })).toBe("on");
    for (const value of ["of", "0", "false", "no", "disabled", "off,on"]) {
      expect(() => sessionContentFromEnv({ FORTRESS_CONNECTION_SESSION_CONTENT: value })).toThrow(
        "FORTRESS_CONNECTION_SESSION_CONTENT must be on or off",
      );
    }
  });

  test("a variable that is set and empty stops the start: a blank is not a choice", () => {
    // What a template gives when the value it was to be filled with was not there.
    for (const value of ["", "  ", "\n"]) {
      expect(() => sessionContentFromEnv({ FORTRESS_CONNECTION_SESSION_CONTENT: value })).toThrow(
        "FORTRESS_CONNECTION_SESSION_CONTENT is set and empty: it must be on or off",
      );
    }
  });

  test("the variable wins over config.json, and with neither nobody chose", () => {
    const off = { connection: { sessionContent: "off" as const } };
    const on = { connection: { sessionContent: "on" as const } };
    expect(resolveSessionContent(null, off)).toBe("off");
    expect(resolveSessionContent(null, on)).toBe("on");
    expect(resolveSessionContent("on", off)).toBe("on");
    expect(resolveSessionContent("off", on)).toBe("off");
    expect(resolveSessionContent("off", {})).toBe("off");
    expect(resolveSessionContent("off", null)).toBe("off");
    expect(resolveSessionContent(null, {})).toBeNull();
    expect(resolveSessionContent(null, null)).toBeNull();
  });
});

describe("the config the runtime connects with says what the start decided", () => {
  const config = (sessionContent?: "on" | "off"): FortressConfig =>
    parseFortressConfig({ ...BASE, ...(sessionContent ? { connection: { sessionContent } } : {}) });
  const store = (loaded: FortressConfig) => ({ load: async () => loaded });

  test("a config that agrees is handed on as it is", async () => {
    const off = config("off");
    expect(await configStoreAgreeingOnSessionContent(store(off), null, () => "off").load()).toBe(off);
    const none = config();
    expect(await configStoreAgreeingOnSessionContent(store(none), null, () => null).load()).toBe(none);
    // The variable decided, so what the file says does not matter.
    expect(await configStoreAgreeingOnSessionContent(store(off), "on", () => "on").load()).toBe(off);
  });

  test("a config that says off to a start that decided nobody chose is refused", async () => {
    // The start read config.json when it could not be read, and decided from
    // nothing. The file can be read now, and it says off.
    await expect(configStoreAgreeingOnSessionContent(store(config("off")), null, () => null).load()).rejects.toThrow(
      "Invalid Fortress config: what config.json says about session content changed while this fortress was starting",
    );
  });

  test("so is every other disagreement", async () => {
    for (const [loaded, decided] of [
      [config(), "off"],
      [config("on"), "off"],
      [config("off"), "on"],
      [config("on"), null],
    ] as const) {
      await expect(
        configStoreAgreeingOnSessionContent(store(loaded), null, () => decided).load(),
      ).rejects.toThrow("changed while this fortress was starting");
    }
  });

  test("a config that cannot be loaded fails as it did", async () => {
    const failing = {
      load: async (): Promise<FortressConfig> => {
        throw new Error("Invalid Fortress config: malformed JSON");
      },
    };
    await expect(configStoreAgreeingOnSessionContent(failing, null, () => null).load()).rejects.toThrow(
      "Invalid Fortress config: malformed JSON",
    );
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
    expect((await new FileConfigStore(paths).load()).cloud?.url).toBe("wss://other.control.example/v1/connection");
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
    for (const connection of [{ sessionContent: "of" }, { sessionContent: null }, "off", null, { session_content: "off" }]) {
      const before = { ...BASE, connection };
      await write(before);
      await expect(ensureEnrollmentConfig(paths, "wss://other.control.example/v1/connection")).rejects.toThrow(
        /Invalid Fortress config: connection/,
      );
      expect(await raw()).toEqual(before);
    }
    const misplaced = { ...BASE, conection: { sessionContent: "off" } };
    await write(misplaced);
    await expect(ensureEnrollmentConfig(paths, "wss://other.control.example/v1/connection")).rejects.toThrow(
      "read only from connection.sessionContent",
    );
    expect(await raw()).toEqual(misplaced);
  });

  test("an enrollment refuses a file that is not JSON and mentions the setting, and leaves it", async () => {
    // Each of these is a file an editor leaves behind, and JSON.parse refuses each.
    for (const text of [
      // A trailing comma.
      '{\n  "schemaVersion": 1,\n  "connection": { "sessionContent": "off" },\n}\n',
      // A comment.
      '{\n  // no session text to the control plane\n  "connection": { "sessionContent": "off" }\n}\n',
      // A word without its quotes.
      '{ "connection": { "sessionContent": off } }',
      // The key in another spelling.
      '{ "connection": { "session_content": "off", } }',
    ]) {
      await writeFile(paths.config, text);
      await expect(ensureEnrollmentConfig(paths, "wss://control.example/v1/connection")).rejects.toThrow(
        "Invalid Fortress config: config.json is not valid JSON and it mentions session content",
      );
      expect(await readFile(paths.config, "utf8")).toBe(text);
    }
  });

  test("a file that is not JSON and says nothing of the setting is replaced, as before", async () => {
    await writeFile(paths.config, '{ "schemaVersion": 1, ');
    await ensureEnrollmentConfig(paths, "wss://control.example/v1/connection");
    const config = await new FileConfigStore(paths).load();
    expect(config.cloud?.url).toBe("wss://control.example/v1/connection");
    expect(config.connection).toBeUndefined();
  });

  test("with no config.json an enrollment writes one, as before", async () => {
    await ensureEnrollmentConfig(paths, "wss://control.example/v1/connection");
    expect((await new FileConfigStore(paths).load()).connection).toBeUndefined();
  });

  test.skipIf(process.getuid?.() === 0)(
    "an enrollment refuses a file that is there and cannot be read, and leaves it",
    async () => {
      const text = `${JSON.stringify({ ...BASE, connection: { sessionContent: "off" } })}\n`;
      await writeFile(paths.config, text);
      await chmod(paths.config, 0o000);
      try {
        await expect(ensureEnrollmentConfig(paths, "wss://control.example/v1/connection")).rejects.toThrow(
          "Invalid Fortress config: config.json is there and could not be read",
        );
      } finally {
        await chmod(paths.config, 0o600);
      }
      expect(await readFile(paths.config, "utf8")).toBe(text);
    },
  );

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
