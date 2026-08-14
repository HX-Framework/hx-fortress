import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ensureCoreModulesEnabled,
  ensureEnrollmentConfig,
  ensureGatewayPublicUrlConfigured,
  FileConfigStore,
} from "../src/host/config";
import { fortressPaths } from "../src/host/paths";

const CLOUD = "wss://beta.let.ai/tunnel";

describe("config.json preservation", () => {
  let root = "";
  let paths: ReturnType<typeof fortressPaths>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-config-"));
    paths = fortressPaths(root);
    await mkdir(path.dirname(paths.config), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function write(value: unknown): Promise<void> {
    await writeFile(paths.config, `${JSON.stringify(value, null, 2)}\n`);
  }

  async function raw(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(paths.config, "utf8")) as Record<string, unknown>;
  }

  test("re-enrolling preserves the postgres block", async () => {
    // Dropping it silently moved a fortress configured against an external
    // database onto a fresh embedded cluster, its data still there but invisible.
    await write({
      schemaVersion: 1,
      cloud: { url: "wss://old.let.ai/tunnel" },
      gateway: { publicUrl: "https://fortress.example" },
      modules: { enabled: ["session_vault"] },
      postgres: { externalUrl: "postgresql://op:pw@db.internal:5432/hx", port: 6543 },
    });

    await ensureEnrollmentConfig(paths, CLOUD);

    const config = await new FileConfigStore(paths).load();
    expect(config.cloud.url).toBe(CLOUD);
    expect(config.postgres?.externalUrl).toBe("postgresql://op:pw@db.internal:5432/hx");
    expect(config.postgres?.port).toBe(6543);
    // …and the gateway URL the operator set is not reset either.
    expect(config.gateway.publicUrl).toBe("https://fortress.example");
  });

  test("re-enrolling preserves keys the parser does not model", async () => {
    await write({
      schemaVersion: 1,
      cloud: { url: "wss://old.let.ai/tunnel" },
      gateway: { publicUrl: "https://fortress.example" },
      modules: { enabled: ["session_vault"] },
      ui: { port: 8788, enabled: true },
    });

    await ensureEnrollmentConfig(paths, CLOUD);
    expect((await raw()).ui).toEqual({ port: 8788, enabled: true });
  });

  test("the core-module migration preserves unmodelled keys too", async () => {
    await write({
      schemaVersion: 1,
      cloud: { url: CLOUD },
      gateway: { publicUrl: "https://fortress.example" },
      modules: { enabled: [] },
      ui: { port: 8788 },
      postgres: { port: 6543 },
    });

    await ensureCoreModulesEnabled(paths);

    const after = await raw();
    expect((after.modules as { enabled: string[] }).enabled).toContain("session_vault");
    expect(after.ui).toEqual({ port: 8788 });
    expect(after.postgres).toEqual({ port: 6543 });
  });

  test("backfilling the gateway URL preserves the rest of the file", async () => {
    await write({
      schemaVersion: 1,
      cloud: { url: CLOUD },
      modules: { enabled: ["session_vault"] },
      ui: { port: 8788 },
      postgres: { dataDir: "/srv/pgdata" },
    });

    await ensureGatewayPublicUrlConfigured(paths);

    const after = await raw();
    expect((after.gateway as { publicUrl: string }).publicUrl).toBeDefined();
    expect(after.ui).toEqual({ port: 8788 });
    expect(after.postgres).toEqual({ dataDir: "/srv/pgdata" });
  });

  test("an unparseable config is not merged forward on re-enrollment", async () => {
    // Preserving keys from a file that failed validation would carry the
    // invalid ones back in.
    await write({ schemaVersion: 1, cloud: { url: "not-a-url" }, junk: true });
    await ensureEnrollmentConfig(paths, CLOUD);
    const after = await raw();
    expect(after.junk).toBeUndefined();
    expect(after.cloud).toEqual({ url: CLOUD });
  });
});
