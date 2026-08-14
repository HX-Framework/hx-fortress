import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { fortressPaths, migrateFortressHome } from "../src/host/paths";

describe("Fortress paths", () => {
  test("derives the canonical on-disk layout", () => {
    const paths = fortressPaths("/tmp/fortress");

    expect({
      root: paths.root,
      config: paths.config,
      credentials: paths.credentials,
      moduleInventory: paths.moduleInventory,
      log: paths.log,
      serviceLog: paths.serviceLog,
      status: paths.status,
    }).toEqual({
      root: "/tmp/fortress",
      config: "/tmp/fortress/config.json",
      credentials: "/tmp/fortress/identity/credentials.json",
      moduleInventory: "/tmp/fortress/modules/inventory.json",
      log: "/tmp/fortress/logs/fortress.jsonl",
      serviceLog: "/tmp/fortress/logs/service.log",
      status: "/tmp/fortress/runtime/status.json",
    });
    expect(paths.moduleConfig("session_vault")).toBe(
      "/tmp/fortress/modules/session_vault/config.json",
    );
    expect(paths.moduleArtifacts("session_vault")).toBe(
      "/tmp/fortress/modules/session_vault/artifacts",
    );
  });

  test("exposes postgres paths under the fortress root", () => {
    const paths = fortressPaths("/data");
    expect(paths.postgresRoot).toBe("/data/postgres");
    expect(paths.postgresCache).toBe("/data/postgres/cache");
    expect(paths.postgresSocket).toBe("/data/postgres/socket");
    expect(paths.defaultPgData).toBe("/data/pgdata");
    expect(paths.postgresVersionDir("18.4.0")).toBe("/data/postgres/18.4.0");
  });

  test.each(["", "../escape", "Session_Vault", "session/vault", "_private"])(
    "rejects invalid module id %p",
    (moduleId) => {
      const paths = fortressPaths("/tmp/fortress");

      expect(() => paths.moduleConfig(moduleId)).toThrow("Invalid module id");
      expect(() => paths.moduleArtifacts(moduleId)).toThrow("Invalid module id");
    },
  );
});

describe("Fortress home migration", () => {
  let home: string;

  function mkHome(): string {
    return mkdtempSync(path.join(os.tmpdir(), "fortress-home-"));
  }

  function seedLegacy(root: string): void {
    mkdirSync(path.join(root, ".let", "fortress"), { recursive: true });
    writeFileSync(path.join(root, ".let", "fortress", "config.json"), '{"schemaVersion":1}');
  }

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test("moves the legacy dir to hx-fortress when the new dir is absent", () => {
    home = mkHome();
    seedLegacy(home);

    const current = migrateFortressHome(home);

    expect(current).toBe(path.join(home, ".let", "hx-fortress"));
    expect(existsSync(path.join(home, ".let", "fortress"))).toBe(false);
    expect(readFileSync(path.join(home, ".let", "hx-fortress", "config.json"), "utf8")).toBe(
      '{"schemaVersion":1}',
    );
  });

  test("leaves both dirs untouched when the new dir already exists", () => {
    home = mkHome();
    seedLegacy(home);
    mkdirSync(path.join(home, ".let", "hx-fortress"), { recursive: true });
    writeFileSync(path.join(home, ".let", "hx-fortress", "config.json"), '{"schemaVersion":2}');

    migrateFortressHome(home);

    // New wins; legacy is never merged in or deleted.
    expect(existsSync(path.join(home, ".let", "fortress"))).toBe(true);
    expect(readFileSync(path.join(home, ".let", "hx-fortress", "config.json"), "utf8")).toBe(
      '{"schemaVersion":2}',
    );
  });

  test("no-ops on a fresh install with neither dir present", () => {
    home = mkHome();

    const current = migrateFortressHome(home);

    expect(current).toBe(path.join(home, ".let", "hx-fortress"));
    expect(existsSync(path.join(home, ".let", "hx-fortress"))).toBe(false);
    expect(existsSync(path.join(home, ".let", "fortress"))).toBe(false);
  });
});
