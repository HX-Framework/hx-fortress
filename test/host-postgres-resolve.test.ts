import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseFortressConfig } from "../src/host/config";
import { planPgvector } from "../src/host/postgres/pgvector-install";
import {
  DEFAULT_PG_BINARIES_URL,
  DEFAULT_PG_PORT,
  DEFAULT_PG_VERSION,
  resolvePostgresConfig,
} from "../src/host/postgres/resolve";
import type { FortressConfig } from "../src/host/types";

const base: FortressConfig = {
  schemaVersion: 1,
  cloud: { url: "wss://control.example/tunnel" },
  gateway: { publicUrl: "https://fortress.example" },
  modules: { enabled: ["session_vault"] },
};

describe("postgres config", () => {
  test("parses a persisted postgres block", () => {
    const parsed = parseFortressConfig({
      ...base,
      postgres: { version: "17.2.0", externalUrl: "postgresql://db/x", junk: true },
    });
    expect(parsed.postgres).toEqual({ version: "17.2.0", externalUrl: "postgresql://db/x" });
  });

  test("omits postgres when absent", () => {
    expect(parseFortressConfig(base).postgres).toBeUndefined();
  });

  test("defaults to embedded with built-in values", () => {
    const resolved = resolvePostgresConfig({}, base, "/data/pgdata");
    expect(resolved).toEqual({
      mode: "embedded",
      version: DEFAULT_PG_VERSION,
      binariesUrl: DEFAULT_PG_BINARIES_URL,
      dataDir: "/data/pgdata",
      port: DEFAULT_PG_PORT,
      externalUrl: null,
      // This host names no address for pgvector alone, so it comes from the
      // release of this version of the program. Never from the control
      // plane's address.
      pgvectorUrl: "",
    });
  });

  test("pgvectorUrl: env over config, and nothing derived from the control plane's address", () => {
    // No address of its own: `ensureVector` asks the release of this version.
    expect(resolvePostgresConfig({}, base, "/d").pgvectorUrl).toBe("");
    // config override
    expect(
      resolvePostgresConfig(
        {},
        { ...base, postgres: { pgvectorUrl: "https://mirror/pgv" } },
        "/d",
      ).pgvectorUrl,
    ).toBe("https://mirror/pgv");
    // env wins
    expect(
      resolvePostgresConfig(
        { FORTRESS_PGVECTOR_URL: "https://env/pgv" },
        { ...base, postgres: { pgvectorUrl: "https://mirror/pgv" } },
        "/d",
      ).pgvectorUrl,
    ).toBe("https://env/pgv");
  });

  test("pgvectorUrl is the same with and without a control plane", () => {
    const noCloud: FortressConfig = { ...base, cloud: { url: "" } };
    expect(resolvePostgresConfig({}, noCloud, "/d").pgvectorUrl).toBe("");
    expect(
      resolvePostgresConfig({ FORTRESS_PGVECTOR_URL: "https://env/pgv" }, noCloud, "/d").pgvectorUrl,
    ).toBe("https://env/pgv");
  });

  test("resolves the port from env over config over default", () => {
    expect(resolvePostgresConfig({}, base, "/d").port).toBe(DEFAULT_PG_PORT);
    expect(
      resolvePostgresConfig({}, { ...base, postgres: { port: 5555 } }, "/d").port,
    ).toBe(5555);
    expect(
      resolvePostgresConfig({ FORTRESS_PG_PORT: "6000" }, { ...base, postgres: { port: 5555 } }, "/d").port,
    ).toBe(6000);
  });

  test("env overrides config which overrides defaults", () => {
    const config: FortressConfig = {
      ...base,
      postgres: { version: "17.2.0", binariesUrl: "https://mirror/x", dataDir: "/cfg/pg" },
    };
    const resolved = resolvePostgresConfig(
      { FORTRESS_PG_VERSION: "16.8.0", FORTRESS_PG_DATA: "/env/pg" },
      config,
      "/data/pgdata",
    );
    expect(resolved.version).toBe("16.8.0");
    expect(resolved.binariesUrl).toBe("https://mirror/x");
    expect(resolved.dataDir).toBe("/env/pg");
  });

  test("external mode when FORTRESS_DATABASE_URL set", () => {
    const resolved = resolvePostgresConfig(
      { FORTRESS_DATABASE_URL: "postgresql://host/hx-db" },
      base,
      "/data/pgdata",
    );
    expect(resolved.mode).toBe("external");
    expect(resolved.externalUrl).toBe("postgresql://host/hx-db");
  });
});

describe("what a start does about the search extension", () => {
  const made: string[] = [];
  afterEach(async () => {
    for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  /** The database program's folder, with or without the extension in it. */
  async function programFolder(withExtension: boolean): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-pg-"));
    made.push(dir);
    const extensions = path.join(dir, "share", "extension");
    await mkdir(extensions, { recursive: true });
    await writeFile(path.join(extensions, "plpgsql.control"), "comment = 'PL/pgSQL'\n");
    if (withExtension) await writeFile(path.join(extensions, "vector.control"), "comment = 'vector'\n");
    return dir;
  }

  test("an extension an earlier start installed is used, whether or not anything needs it", async () => {
    const versionDir = await programFolder(true);
    expect(await planPgvector({ versionDir })).toBe("use-installed");
    expect(await planPgvector({ versionDir, needed: true })).toBe("use-installed");
    expect(await planPgvector({ versionDir, needed: false })).toBe("use-installed");
  });

  test("with no extension and nothing that needs it, the start goes on without it", async () => {
    const versionDir = await programFolder(false);
    expect(await planPgvector({ versionDir, needed: false })).toBe("leave-out");
  });

  test("with no extension and something that needs it, or when that is not known, it is downloaded", async () => {
    const versionDir = await programFolder(false);
    expect(await planPgvector({ versionDir, needed: true })).toBe("download");
    expect(await planPgvector({ versionDir })).toBe("download");
  });

  test("an address the host names for the extension changes none of the three", async () => {
    // Before, an address of its own made every start download the extension,
    // also one that had it already, and also one in which nothing needed it.
    const named = "https://downloads.northstar.example/pgvector";
    const before = process.env.FORTRESS_PGVECTOR_URL;
    process.env.FORTRESS_PGVECTOR_URL = named;
    try {
      const plan = (versionDir: string, needed?: boolean) => {
        // What an earlier version was given, and what the host's settings call it.
        const args = { versionDir, ownUrl: named, pgvectorUrl: named, ...(needed === undefined ? {} : { needed }) };
        return planPgvector(args);
      };
      const installed = await programFolder(true);
      expect(await plan(installed)).toBe("use-installed");
      expect(await plan(installed, true)).toBe("use-installed");
      const missing = await programFolder(false);
      expect(await plan(missing, false)).toBe("leave-out");
      expect(await plan(missing, true)).toBe("download");
    } finally {
      if (before === undefined) delete process.env.FORTRESS_PGVECTOR_URL;
      else process.env.FORTRESS_PGVECTOR_URL = before;
    }
  });
});
