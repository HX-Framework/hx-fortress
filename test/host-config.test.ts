import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_GATEWAY_PUBLIC_URL,
  ensureCoreModulesEnabled,
  ensureDefaultConfig,
  ensureEnrollmentConfig,
  ensureGatewayPublicUrlConfigured,
  FileConfigStore,
  resolveEmbedConfig,
} from "../src/host/config";
import { fortressPaths } from "../src/host/paths";

describe("Fortress config", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-config-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("loads the versioned host configuration", async () => {
    await writeConfig({
      schemaVersion: 1,
      cloud: { url: "wss://control.example/tunnel", future: true },
      gateway: { publicUrl: "https://fortress.example", future: true },
      modules: { enabled: ["session_vault"], future: true },
      future: true,
    });

    await expect(new FileConfigStore(fortressPaths(root)).load()).resolves.toEqual({
      schemaVersion: 1,
      cloud: { url: "wss://control.example/tunnel" },
      gateway: { publicUrl: "https://fortress.example" },
      modules: { enabled: ["session_vault"] },
    });
  });

  test("defaults the gateway URL for legacy configs that predate the field", async () => {
    await writeConfig({
      schemaVersion: 1,
      cloud: { url: "wss://control.example/tunnel" },
      modules: { enabled: ["session_vault"] },
    });

    await expect(new FileConfigStore(fortressPaths(root)).load()).resolves.toEqual({
      schemaVersion: 1,
      cloud: { url: "wss://control.example/tunnel" },
      gateway: { publicUrl: DEFAULT_GATEWAY_PUBLIC_URL },
      modules: { enabled: ["session_vault"] },
    });
  });

  test("a config with no cloud key is a Fortress with no control plane, and it loads", async () => {
    await writeConfig({
      schemaVersion: 1,
      gateway: { publicUrl: "https://fortress.example" },
      modules: { enabled: [] },
      organization: { name: "Northstar" },
      postgres: { urlSecret: "db-url" },
      model: { provider: "openai-compatible", address: "https://models.northstar.example/v1", key: "model-key" },
      records: { keepFor: "until-removed" },
      updates: { from: "project-releases", install: "administrator-approves" },
    });

    const config = await new FileConfigStore(fortressPaths(root)).load();
    expect(config.cloud).toBeUndefined();
    expect(config.organization).toEqual({ name: "Northstar" });
    expect(config.postgres).toEqual({ urlSecret: "db-url" });
    expect(config.model).toEqual({
      provider: "openai-compatible",
      address: "https://models.northstar.example/v1",
      key: "model-key",
    });
  });

  test.each([
    ["a model address that is not https", { model: { provider: "openai-compatible", address: "http://models.northstar.example" } }, "model.address must use https:"],
    ["a key written where a key's name belongs", { model: { provider: "openai-compatible", key: "sk-Not A Name" } }, "model.key must be the name of a key"],
    ["a database address beside the name of its key", { postgres: { urlSecret: "db-url", externalUrl: "postgres://db/x" } }, "postgres.externalUrl and postgres.urlSecret are both set"],
    ["an organization with no name", { organization: { name: "" } }, "organization.name must be 1 to 80 characters"],
    ["an update source that is not an option's id", { updates: { from: "Project Releases", install: "administrator-approves" } }, "updates.from must be the id of an option"],
  ])("rejects %s", async (_name, extra, reason) => {
    await writeConfig({
      schemaVersion: 1,
      gateway: { publicUrl: "https://fortress.example" },
      modules: { enabled: [] },
      ...extra,
    });
    await expect(new FileConfigStore(fortressPaths(root)).load()).rejects.toThrow(reason);
  });

  test("rejects a missing config file without exposing file contents", async () => {
    await expect(new FileConfigStore(fortressPaths(root)).load()).rejects.toThrow(
      "Invalid Fortress config: unable to read config.json",
    );
  });

  test.each([
    ["malformed JSON", "{not-json", "malformed JSON"],
    [
      "unsupported schema",
      {
        schemaVersion: 2,
        cloud: { url: "wss://control.example" },
        gateway: { publicUrl: "https://fortress.example" },
        modules: { enabled: [] },
      },
      "schemaVersion must be 1",
    ],
    [
      "unsafe cloud URL",
      {
        schemaVersion: 1,
        cloud: { url: "https://control.example" },
        gateway: { publicUrl: "https://fortress.example" },
        modules: { enabled: [] },
      },
      "cloud.url must use ws: or wss:",
    ],
    [
      "unsafe gateway URL",
      {
        schemaVersion: 1,
        cloud: { url: "wss://control.example" },
        gateway: { publicUrl: "ws://fortress.example" },
        modules: { enabled: [] },
      },
      "gateway.publicUrl must use http: or https:",
    ],
    [
      "duplicate modules",
      {
        schemaVersion: 1,
        cloud: { url: "wss://control.example" },
        gateway: { publicUrl: "https://fortress.example" },
        modules: { enabled: ["session_vault", "session_vault"] },
      },
      "modules.enabled must contain unique module ids",
    ],
    [
      "invalid module id",
      {
        schemaVersion: 1,
        cloud: { url: "wss://control.example" },
        gateway: { publicUrl: "https://fortress.example" },
        modules: { enabled: ["../escape"] },
      },
      "Invalid module id",
    ],
    [
      "a control plane that is not an object",
      {
        schemaVersion: 1,
        cloud: "wss://control.example",
        gateway: { publicUrl: "https://fortress.example" },
        modules: { enabled: [] },
      },
      "cloud must be an object",
    ],
    [
      "a control plane with no address",
      { schemaVersion: 1, cloud: {}, gateway: { publicUrl: "https://fortress.example" }, modules: { enabled: [] } },
      "cloud.url must be a string",
    ],
    [
      "missing modules array",
      {
        schemaVersion: 1,
        cloud: { url: "wss://control.example" },
        gateway: { publicUrl: "https://fortress.example" },
        modules: {},
      },
      "modules.enabled must be an array",
    ],
  ])("rejects %s", async (_name, input, reason) => {
    await writeConfig(input);

    await expect(new FileConfigStore(fortressPaths(root)).load()).rejects.toThrow(
      `Invalid Fortress config: ${reason}`,
    );
  });

  // H-3 · cleartext ws: is tolerated ONLY to a loopback hub (local dev); any
  // network-reachable host must be wss: so the enroll token / credential / vault
  // RPC never crosses the wire in the clear.
  test("accepts cleartext ws: to a loopback hub", async () => {
    await writeConfig({
      schemaVersion: 1,
      cloud: { url: "ws://localhost:8787" },
      gateway: { publicUrl: "https://fortress.example" },
      modules: { enabled: ["session_vault"] },
    });

    await expect(new FileConfigStore(fortressPaths(root)).load()).resolves.toMatchObject({
      cloud: { url: "ws://localhost:8787" },
    });
  });

  test("rejects cleartext ws: to a non-loopback host", async () => {
    await writeConfig({
      schemaVersion: 1,
      cloud: { url: "ws://evil.example" },
      gateway: { publicUrl: "https://fortress.example" },
      modules: { enabled: ["session_vault"] },
    });

    await expect(new FileConfigStore(fortressPaths(root)).load()).rejects.toThrow(
      "cloud.url must use wss: (cleartext ws: is only allowed to a loopback hub)",
    );
  });

  test("accepts wss: to any host", async () => {
    await writeConfig({
      schemaVersion: 1,
      cloud: { url: "wss://hub.control.example/tunnel" },
      gateway: { publicUrl: "https://fortress.example" },
      modules: { enabled: ["session_vault"] },
    });

    await expect(new FileConfigStore(fortressPaths(root)).load()).resolves.toMatchObject({
      cloud: { url: "wss://hub.control.example/tunnel" },
    });
  });

  async function writeConfig(value: unknown): Promise<void> {
    const contents = typeof value === "string" ? value : JSON.stringify(value);
    await writeFile(fortressPaths(root).config, contents);
  }
});

describe("ensureDefaultConfig", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-ensure-config-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("creates config.json with the given cloud URL and default gateway URL when absent", async () => {
    const paths = fortressPaths(root);
    await ensureDefaultConfig(paths, "wss://control.example/tunnel");

    const stored = await new FileConfigStore(paths).load();
    expect(stored).toEqual({
      schemaVersion: 1,
      cloud: { url: "wss://control.example/tunnel" },
      gateway: { publicUrl: DEFAULT_GATEWAY_PUBLIC_URL },
      modules: { enabled: ["session_vault"] },
    });
  });

  test("creates config.json with an explicit gateway public URL when given", async () => {
    const paths = fortressPaths(root);
    await ensureDefaultConfig(paths, "wss://control.example/tunnel", "https://fortress.example");

    const stored = await new FileConfigStore(paths).load();
    expect(stored.gateway.publicUrl).toBe("https://fortress.example");
  });

  test("creates parent directory if it does not exist", async () => {
    const nested = path.join(root, "deep", "fortress");
    const paths = fortressPaths(nested);
    await ensureDefaultConfig(paths, "wss://control.example/tunnel");

    const raw = JSON.parse(await readFile(paths.config, "utf8")) as unknown;
    expect((raw as { schemaVersion: number }).schemaVersion).toBe(1);
  });

  test("does not overwrite an existing config", async () => {
    const paths = fortressPaths(root);
    const existing = {
      schemaVersion: 1,
      cloud: { url: "wss://original.control.example/tunnel" },
      gateway: { publicUrl: "https://original.example" },
      modules: { enabled: ["session_vault"] },
    };
    await writeFile(paths.config, JSON.stringify(existing));

    await ensureDefaultConfig(paths, "wss://new.control.example/tunnel", "https://new.example");

    const stored = await new FileConfigStore(paths).load();
    expect(stored.cloud?.url).toBe("wss://original.control.example/tunnel");
    expect(stored.gateway.publicUrl).toBe("https://original.example");
    expect(stored.modules.enabled).toEqual(["session_vault"]);
  });
});

describe("ensureEnrollmentConfig", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-enrollment-config-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("creates config.json when absent", async () => {
    const paths = fortressPaths(root);
    await ensureEnrollmentConfig(paths, "wss://fresh.control.example/tunnel");

    const stored = await new FileConfigStore(paths).load();
    expect(stored).toEqual({
      schemaVersion: 1,
      cloud: { url: "wss://fresh.control.example/tunnel" },
      gateway: { publicUrl: DEFAULT_GATEWAY_PUBLIC_URL },
      modules: { enabled: ["session_vault"] },
    });
  });

  test("updates the enrollment target while preserving existing modules and gateway by default", async () => {
    const paths = fortressPaths(root);
    await writeFile(
      paths.config,
      JSON.stringify({
        schemaVersion: 1,
        cloud: { url: "wss://old.control.example/tunnel" },
        gateway: { publicUrl: "https://fortress.example" },
        modules: { enabled: ["session_vault", "extra_module"] },
      }),
    );

    await ensureEnrollmentConfig(paths, "wss://fresh.control.example/tunnel");

    const stored = await new FileConfigStore(paths).load();
    expect(stored).toEqual({
      schemaVersion: 1,
      cloud: { url: "wss://fresh.control.example/tunnel" },
      gateway: { publicUrl: "https://fortress.example" },
      modules: { enabled: ["session_vault", "extra_module"] },
    });
  });

  test("updates the gateway URL when the installer collected a new one", async () => {
    const paths = fortressPaths(root);
    await writeFile(
      paths.config,
      JSON.stringify({
        schemaVersion: 1,
        cloud: { url: "wss://old.control.example/tunnel" },
        gateway: { publicUrl: "https://old.example" },
        modules: { enabled: ["session_vault"] },
      }),
    );

    await ensureEnrollmentConfig(
      paths,
      "wss://fresh.control.example/tunnel",
      "https://fresh.example",
    );

    const stored = await new FileConfigStore(paths).load();
    expect(stored.cloud?.url).toBe("wss://fresh.control.example/tunnel");
    expect(stored.gateway.publicUrl).toBe("https://fresh.example");
  });
});

describe("ensureGatewayPublicUrlConfigured", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-ensure-gateway-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("writes the default gateway URL into a legacy config missing the field", async () => {
    const paths = fortressPaths(root);
    await writeFile(
      paths.config,
      JSON.stringify({
        schemaVersion: 1,
        cloud: { url: "wss://control.example/tunnel" },
        modules: { enabled: ["session_vault"] },
      }),
    );

    await ensureGatewayPublicUrlConfigured(paths);

    const stored = await new FileConfigStore(paths).load();
    expect(stored.gateway.publicUrl).toBe(DEFAULT_GATEWAY_PUBLIC_URL);
  });

  test("writes the chosen gateway URL into a legacy config missing the field", async () => {
    const paths = fortressPaths(root);
    await writeFile(
      paths.config,
      JSON.stringify({
        schemaVersion: 1,
        cloud: { url: "wss://control.example/tunnel" },
        modules: { enabled: ["session_vault"] },
      }),
    );

    await ensureGatewayPublicUrlConfigured(paths, "https://fortress.example");

    const stored = await new FileConfigStore(paths).load();
    expect(stored.gateway.publicUrl).toBe("https://fortress.example");
  });

  test("preserves an existing gateway URL", async () => {
    const paths = fortressPaths(root);
    await writeFile(
      paths.config,
      JSON.stringify({
        schemaVersion: 1,
        cloud: { url: "wss://control.example/tunnel" },
        gateway: { publicUrl: "https://fortress.example" },
        modules: { enabled: ["session_vault"] },
      }),
    );

    await ensureGatewayPublicUrlConfigured(paths);

    const stored = await new FileConfigStore(paths).load();
    expect(stored.gateway.publicUrl).toBe("https://fortress.example");
  });
});

describe("ensureCoreModulesEnabled", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-core-modules-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("no-ops when config does not exist", async () => {
    const paths = fortressPaths(root);
    await expect(ensureCoreModulesEnabled(paths)).resolves.toBeUndefined();
  });

  test("no-ops when all core modules already enabled", async () => {
    const paths = fortressPaths(root);
    const existing = {
      schemaVersion: 1,
      cloud: { url: "wss://control.example/tunnel" },
      gateway: { publicUrl: "https://fortress.example" },
      modules: { enabled: ["session_vault"] },
    };
    await writeFile(paths.config, JSON.stringify(existing));

    await ensureCoreModulesEnabled(paths);

    const stored = await new FileConfigStore(paths).load();
    expect(stored.modules.enabled).toEqual(["session_vault"]);
  });

  test("adds missing core modules to existing config", async () => {
    const paths = fortressPaths(root);
    const existing = {
      schemaVersion: 1,
      cloud: { url: "wss://control.example/tunnel" },
      gateway: { publicUrl: "https://fortress.example" },
      modules: { enabled: [] },
    };
    await writeFile(paths.config, JSON.stringify(existing));

    await ensureCoreModulesEnabled(paths);

    const stored = await new FileConfigStore(paths).load();
    expect(stored.modules.enabled).toContain("session_vault");
    expect(stored.cloud?.url).toBe("wss://control.example/tunnel");
  });

  test("preserves existing non-core enabled modules", async () => {
    const paths = fortressPaths(root);
    const existing = {
      schemaVersion: 1,
      cloud: { url: "wss://control.example/tunnel" },
      gateway: { publicUrl: "https://fortress.example" },
      modules: { enabled: [] },
    };
    await writeFile(paths.config, JSON.stringify(existing));

    await ensureCoreModulesEnabled(paths);

    const stored = await new FileConfigStore(paths).load();
    expect(stored.modules.enabled).toContain("session_vault");
  });
});

describe("resolveEmbedConfig — OpenAI base URL (M-5)", () => {
  const KEY = { FORTRESS_OPENAI_API_KEY: "sk-test-key" };

  test("defaults to the public https endpoint", () => {
    expect(resolveEmbedConfig({ ...KEY }).baseUrl).toBe("https://api.openai.com/v1");
  });

  test("accepts an https override and strips a trailing slash", () => {
    const cfg = resolveEmbedConfig({ ...KEY, FORTRESS_OPENAI_BASE_URL: "https://zdr.example/v1/" });
    expect(cfg.baseUrl).toBe("https://zdr.example/v1");
  });

  test("rejects a plaintext http base URL", () => {
    expect(() => resolveEmbedConfig({ ...KEY, FORTRESS_OPENAI_BASE_URL: "http://zdr.example/v1" })).toThrow(
      "FORTRESS_OPENAI_BASE_URL must use https:",
    );
  });

  test("rejects a malformed base URL", () => {
    expect(() => resolveEmbedConfig({ ...KEY, FORTRESS_OPENAI_BASE_URL: "not a url" })).toThrow(
      "FORTRESS_OPENAI_BASE_URL must be a valid URL",
    );
  });

  test("caps the daily token budget knob and admits 0 (unlimited)", () => {
    expect(resolveEmbedConfig({ ...KEY }).dailyTokenBudget).toBe(5_000_000);
    expect(resolveEmbedConfig({ ...KEY, FORTRESS_EMBED_DAILY_TOKEN_BUDGET: "0" }).dailyTokenBudget).toBe(0);
    expect(resolveEmbedConfig({ ...KEY, FORTRESS_EMBED_DAILY_TOKEN_BUDGET: "-5" }).dailyTokenBudget).toBe(5_000_000);
  });

  // MC-2517 · the QUERY-path embed budget (per-attempt timeout + retry count) that
  // bounds hx_semantic_search so a stalled OpenAI call fails fast instead of hanging.
  test("query-embed budget: defaults + env overrides (0 retries admitted)", () => {
    const def = resolveEmbedConfig({ ...KEY });
    expect(def.queryTimeoutMs).toBe(10_000);
    expect(def.queryMaxRetries).toBe(2);
    const over = resolveEmbedConfig({
      ...KEY,
      FORTRESS_EMBED_QUERY_TIMEOUT_MS: "5000",
      FORTRESS_EMBED_QUERY_MAX_RETRIES: "0",
    });
    expect(over.queryTimeoutMs).toBe(5_000);
    expect(over.queryMaxRetries).toBe(0); // 0 = no retry, must be admitted (not the default)
    // a non-numeric / negative timeout falls back to the default.
    expect(resolveEmbedConfig({ ...KEY, FORTRESS_EMBED_QUERY_TIMEOUT_MS: "-1" }).queryTimeoutMs).toBe(10_000);
  });
});
