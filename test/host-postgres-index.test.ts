import { describe, expect, test } from "bun:test";

import { buildPostgresProvider } from "../src/host/postgres";
import { fortressPaths } from "../src/host/paths";
import type { FortressConfig } from "../src/host/types";

const base: FortressConfig = {
  schemaVersion: 1,
  cloud: { url: "wss://x/tunnel" },
  gateway: { publicUrl: "https://x" },
  modules: { enabled: [] },
};

describe("buildPostgresProvider", () => {
  test("returns an external provider when FORTRESS_DATABASE_URL is set", () => {
    const provider = buildPostgresProvider({
      env: { FORTRESS_DATABASE_URL: "postgresql://host/hx-db" },
      config: base,
      paths: fortressPaths("/data"),
    });
    expect(provider.dsn()).toBeNull(); // not started yet
    expect(typeof provider.start).toBe("function");
  });

  test("returns an embedded provider by default", () => {
    const provider = buildPostgresProvider({
      env: {},
      config: base,
      paths: fortressPaths("/data"),
      platform: "linux",
      arch: "x64",
    });
    expect(typeof provider.start).toBe("function");
  });
});
