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
      // default download base: cloud ws url → https download proxy base
      pgvectorUrl: "https://control.example/tunnel",
    });
  });

  test("pgvectorUrl: env over config over the cloud-derived default", () => {
    // default: derived from cloud.url via downloadBaseFromCloudUrl
    expect(resolvePostgresConfig({}, base, "/d").pgvectorUrl).toBe(
      "https://control.example/tunnel",
    );
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

  test("pgvectorUrl is '' when the fortress has no cloud URL yet", () => {
    const noCloud: FortressConfig = { ...base, cloud: { url: "" } };
    expect(resolvePostgresConfig({}, noCloud, "/d").pgvectorUrl).toBe("");
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

  test("with a download address it is downloaded when missing", async () => {
    const versionDir = await programFolder(false);
    expect(await planPgvector({ baseUrl: "https://downloads.northstar.example", versionDir })).toBe("download");
  });

  test("with no address, an extension an earlier start installed is used: a disconnected Fortress keeps its database", async () => {
    const versionDir = await programFolder(true);
    expect(await planPgvector({ baseUrl: "", versionDir })).toBe("use-installed");
    expect(await planPgvector({ baseUrl: "", versionDir, needed: true })).toBe("use-installed");
  });

  test("with no address and nothing that needs it, the start goes on without it", async () => {
    const versionDir = await programFolder(false);
    expect(await planPgvector({ baseUrl: "", versionDir, needed: false })).toBe("leave-out");
  });

  test("with no address and something that needs it, the start stops and says why", async () => {
    const versionDir = await programFolder(false);
    await expect(planPgvector({ baseUrl: "", versionDir, needed: true })).rejects.toThrow(
      "pgvector requires a download base but none is configured",
    );
    await expect(planPgvector({ baseUrl: "", versionDir })).rejects.toThrow("pgvector requires a download base");
  });
});
