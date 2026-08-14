import { describe, expect, test } from "bun:test";

import { parseFortressConfig } from "../src/host/config";
import {
  DEFAULT_PG_BINARIES_URL,
  DEFAULT_PG_PORT,
  DEFAULT_PG_VERSION,
  resolvePostgresConfig,
} from "../src/host/postgres/resolve";
import type { FortressConfig } from "../src/host/types";

const base: FortressConfig = {
  schemaVersion: 1,
  cloud: { url: "wss://example.let.ai/tunnel" },
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
      pgvectorUrl: "https://example.let.ai/tunnel",
    });
  });

  test("pgvectorUrl: env over config over the cloud-derived default", () => {
    // default: derived from cloud.url via downloadBaseFromCloudUrl
    expect(resolvePostgresConfig({}, base, "/d").pgvectorUrl).toBe(
      "https://example.let.ai/tunnel",
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
