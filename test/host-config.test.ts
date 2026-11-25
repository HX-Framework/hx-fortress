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
  parseUpdatesConfig,
  resolveEmbedConfig,
  updateBaseAddress,
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
      model: { provider: "openai", address: "https://models.northstar.example/v1", key: "model-key" },
      auditTrail: { keepFor: "until-removed" },
      updates: {},
      install: { place: "azure", region: "eastus2", certificate: "cloud-issued", database: "managed" },
      controlPlane: { pages: "https://app.control.example" },
    });

    const config = await new FileConfigStore(fortressPaths(root)).load();
    expect(config.cloud).toBeUndefined();
    expect(config.organization).toEqual({ name: "Northstar" });
    expect(config.postgres).toEqual({ urlSecret: "db-url" });
    expect(config.model).toEqual({
      provider: "openai",
      address: "https://models.northstar.example/v1",
      key: "model-key",
    });
    expect(config.auditTrail).toEqual({ keepFor: "until-removed" });
    expect(config.updates).toEqual({});
    expect(config.install).toEqual({ place: "azure", region: "eastus2", certificate: "cloud-issued", database: "managed" });
    expect(config.controlPlane).toEqual({ pages: "https://app.control.example" });
  });

  test("the blocks an earlier setup wrote are read without a word", async () => {
    // A setup before this one wrote `records`, and an `updates` block with a
    // source and a word about who installs. The source is read, the rest is
    // not, and neither stops a start.
    await writeConfig({
      schemaVersion: 1,
      gateway: { publicUrl: "https://fortress.example" },
      modules: { enabled: [] },
      records: { keepFor: "until-removed" },
      updates: { from: "project-releases", install: "administrator-approves" },
    });
    const config = await new FileConfigStore(fortressPaths(root)).load();
    expect(config.updates).toEqual({ from: "project-releases" });
    expect(config.auditTrail).toBeUndefined();
  });

  test("an address an earlier setup left beside the project's releases is not used, and does not stop a start", async () => {
    // An earlier setup wrote this pair when an address had been typed and the
    // project's releases were then chosen.
    await writeConfig({
      schemaVersion: 1,
      gateway: { publicUrl: "https://fortress.example" },
      modules: { enabled: [] },
      updates: { from: "project-releases", address: "https://files.northstar.example/hx" },
    });
    const config = await new FileConfigStore(fortressPaths(root)).load();
    expect(config.updates).toEqual({ from: "project-releases" });
  });

  test.each([
    ["a model address that is not https", { model: { provider: "openai-compatible", address: "http://models.northstar.example" } }, "model.address must use https:"],
    ["a key written where a key's name belongs", { model: { provider: "openai-compatible", key: "sk-Not A Name" } }, "model.key must be the name of a key"],
    ["a database address beside the name of its key", { postgres: { urlSecret: "db-url", externalUrl: "postgres://db/x" } }, "postgres.externalUrl and postgres.urlSecret are both set"],
    ["an organization with no name", { organization: { name: "" } }, "organization.name must be 1 to 80 characters"],
    ["a yes or no about security fixes that is neither", { updates: { securityFixes: "yes" } }, "updates.securityFixes must be true or false"],
    ["a source of new versions that is not one of the two", { updates: { from: "control-plane" } }, 'updates.from is "control-plane". It is project-releases or own-address'],
    ["a source of new versions that is not a word", { updates: { from: "https://files.northstar.example/?key=abc" } }, "updates.from is not an option. It is project-releases or own-address"],
    ["an address of new versions with no word that it is the source", { updates: { address: "https://files.northstar.example/hx" } }, "updates.address is set, and updates.from does not say to use it. Set updates.from to own-address, or remove the address"],
    ["an own source of new versions with no address", { updates: { from: "own-address" } }, "updates.from is own-address, and updates.address does not name an address"],
    ["an address of new versions in clear text", { updates: { from: "own-address", address: "http://files.northstar.example/hx" } }, "updates.address must use https:"],
    ["an address of new versions that holds a password", { updates: { from: "own-address", address: ["https://ops:", "not-a-real-one", "@files.northstar.example/hx"].join("") } }, "updates.address must not hold a user name or a password"],
    ["an address of new versions that holds a query", { updates: { from: "own-address", address: "https://files.northstar.example/hx?x=1" } }, 'updates.address must be a plain address, with no "?" and no "#"'],
    ["an address of new versions that ends in a question mark with nothing after it", { updates: { from: "own-address", address: "https://files.northstar.example/hx?" } }, 'updates.address must be a plain address, with no "?" and no "#"'],
    ["an address of new versions that ends in a number sign with nothing after it", { updates: { from: "own-address", address: "https://files.northstar.example/hx#" } }, 'updates.address must be a plain address, with no "?" and no "#"'],
    ["an address of new versions that holds a fragment", { updates: { from: "own-address", address: "https://files.northstar.example/hx#latest" } }, 'updates.address must be a plain address, with no "?" and no "#"'],
    ["an audit trail kept for something that is not an option's id", { auditTrail: { keepFor: "Until Removed" } }, "auditTrail.keepFor must be the id of an option"],
    ["a model route that is not an option's id", { model: { provider: "openai", route: "Not An Id" } }, "model.route must be the id of an option"],
    ["a place that is not an option's id", { install: { place: "Azure Cloud" } }, "install.place must be the id of an option"],
    ["pages of a control plane given with a wildcard", { controlPlane: { pages: "https://*.control.example" } }, "controlPlane.pages must be one origin"],
    ["pages of a control plane given with a path", { controlPlane: { pages: "https://app.control.example/notebooks" } }, "controlPlane.pages must be one origin"],
    ["a setting of the control plane that this build does not know", { controlPlane: { page: "https://app.control.example" } }, "controlPlane takes one setting: pages"],
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
      "Invalid HX Fortress config: unable to read config.json",
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
      `Invalid HX Fortress config: ${reason}`,
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

describe("the address that holds a release's files", () => {
  const PLAIN = 'must be a plain address, with no "?" and no "#"';

  test("is kept with no slash at its end and no space around it", () => {
    expect(updateBaseAddress("https://files.northstar.example/hx-fortress/", "updates.address")).toBe(
      "https://files.northstar.example/hx-fortress",
    );
    expect(updateBaseAddress("  https://files.northstar.example/hx-fortress//  ", "updates.address")).toBe(
      "https://files.northstar.example/hx-fortress",
    );
  });

  test.each([
    ["a query", "https://files.northstar.example/hx?x=1"],
    ["a fragment", "https://files.northstar.example/hx#latest"],
    // The parsed address of each of these has no query and no fragment, and
    // a file's name written after it would land in one.
    ["a question mark with nothing after it", "https://files.northstar.example/hx?"],
    ["a number sign with nothing after it", "https://files.northstar.example/hx#"],
    ["a question mark after a slash", "https://files.northstar.example/hx/?"],
    ["a question mark and a number sign with nothing after them", "https://files.northstar.example/hx?#"],
  ])("is refused when it holds %s, and the refusal names the setting", (_name, address) => {
    expect(() => updateBaseAddress(address, "FORTRESS_UPDATE_URL")).toThrow(`FORTRESS_UPDATE_URL ${PLAIN}`);
  });
});

describe("the update settings in config.json", () => {
  test("say nothing, the project's releases, or an address of the organization's own", () => {
    expect(parseUpdatesConfig(undefined)).toBeUndefined();
    expect(parseUpdatesConfig({})).toEqual({});
    expect(parseUpdatesConfig({ from: "project-releases" })).toEqual({ from: "project-releases" });
    expect(parseUpdatesConfig({ securityFixes: true })).toEqual({ securityFixes: true });
    expect(parseUpdatesConfig({ from: "own-address", address: "https://files.northstar.example/hx/" })).toEqual({
      from: "own-address",
      address: "https://files.northstar.example/hx",
    });
  });

  test("an address beside the project's releases, stated in so many words, is taken and not used", () => {
    expect(parseUpdatesConfig({ from: "project-releases", address: "https://files.northstar.example/hx" })).toEqual({
      from: "project-releases",
    });
    expect(
      parseUpdatesConfig({ securityFixes: true, from: "project-releases", address: "https://files.northstar.example/hx" }),
    ).toEqual({ securityFixes: true, from: "project-releases" });
  });

  test("an address with no word about where new versions come from is refused", () => {
    expect(() => parseUpdatesConfig({ address: "https://files.northstar.example/hx" })).toThrow(
      "updates.address is set, and updates.from does not say to use it. Set updates.from to own-address, or remove the address",
    );
    expect(() => parseUpdatesConfig({ securityFixes: false, address: "https://files.northstar.example/hx" })).toThrow(
      "updates.address is set, and updates.from does not say to use it",
    );
  });

  test("an address of the organization's own is held to the rule of a download's address", () => {
    expect(() => parseUpdatesConfig({ from: "own-address", address: "https://files.northstar.example/hx?" })).toThrow(
      'updates.address must be a plain address, with no "?" and no "#"',
    );
    expect(() => parseUpdatesConfig({ from: "own-address", address: "  " })).toThrow(
      "updates.from is own-address, and updates.address does not name an address",
    );
    expect(() => parseUpdatesConfig("own-address")).toThrow("updates must be an object");
  });
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

  // An enrollment writes a fresh file when the one on disk does not pass its
  // check, and a fresh file has no update settings: HX Fortress would then
  // take new versions from the project's releases, which the settings may
  // have turned away from.
  const ENROLLED = {
    schemaVersion: 1,
    cloud: { url: "wss://old.control.example/tunnel" },
    gateway: { publicUrl: "https://fortress.example" },
    modules: { enabled: ["session_vault"] },
  };

  /** The message an enrollment is refused with. */
  async function refusal(paths: ReturnType<typeof fortressPaths>): Promise<string> {
    return ensureEnrollmentConfig(paths, "wss://fresh.control.example/tunnel").then(
      () => "the enrollment was not refused",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
  }

  test.each([
    ["name a source that is not one of the two", { from: "elsewhere" }, 'updates.from is "elsewhere". It is project-releases or own-address'],
    ["name an address and do not say to use it", { address: "https://files.northstar.example/hx" }, "updates.address is set, and updates.from does not say to use it"],
    ["name an address of their own in clear text", { from: "own-address", address: "http://files.northstar.example/hx" }, "updates.address must use https:"],
    ["name an address of their own with a question mark at its end", { from: "own-address", address: "https://files.northstar.example/hx?" }, 'updates.address must be a plain address, with no "?" and no "#"'],
    ["are not an object", "own-address", "updates must be an object"],
    ["say neither yes nor no about security fixes", { securityFixes: "yes", from: "own-address", address: "https://files.northstar.example/hx" }, "updates.securityFixes must be true or false"],
  ])("is refused, and config.json is left byte for byte, when its update settings %s", async (_name, updates, reason) => {
    const paths = fortressPaths(root);
    const text = `${JSON.stringify({ ...ENROLLED, updates }, null, 2)}\n`;
    await writeFile(paths.config, text);
    const said = await refusal(paths);
    expect(said).toStartWith(`Invalid HX Fortress config: ${reason}`);
    expect(said).toEndWith("; fix the update settings in config.json, and they are kept");
    expect(await readFile(paths.config, "utf8")).toBe(text);
  });

  test("is refused, and config.json is left byte for byte, when the file is not JSON and mentions update settings", async () => {
    const paths = fortressPaths(root);
    // Each of these is a file an editor leaves behind, and JSON.parse refuses each.
    for (const text of [
      // A comma after the last entry.
      '{\n  "schemaVersion": 1,\n  "updates": { "from": "own-address", "address": "https://files.northstar.example/hx" },\n}\n',
      // A comment.
      '{\n  // our own copy of each release\n  "updates": { "from": "own-address", "address": "https://files.northstar.example/hx" }\n}\n',
      // A word without its quotes.
      '{ "updates" : { "from": own-address } }',
    ]) {
      await writeFile(paths.config, text);
      expect(await refusal(paths)).toBe(
        "Invalid HX Fortress config: config.json is not valid JSON and it mentions update settings; " +
          "fix the file, and where it says a new version comes from is kept",
      );
      expect(await readFile(paths.config, "utf8")).toBe(text);
    }
  });

  test("is refused, and config.json is left byte for byte, when the file is not JSON and names its update settings by a key without quotes", async () => {
    // The same mistake as above, made in the key: the text still names the
    // update settings, and a fresh file would drop them.
    const paths = fortressPaths(root);
    const text = '{\n  updates: { from: "own-address", address: "https://files.northstar.example/hx" }\n}\n';
    await writeFile(paths.config, text);
    expect(await refusal(paths)).toStartWith("Invalid HX Fortress config: config.json is not valid JSON and it mentions update settings");
    expect(await readFile(paths.config, "utf8")).toBe(text);
  });

  test("replaces a file that is not JSON and says nothing of update settings, as before", async () => {
    const paths = fortressPaths(root);
    await writeFile(paths.config, '{ "schemaVersion": 1, ');
    await ensureEnrollmentConfig(paths, "wss://fresh.control.example/tunnel");
    const stored = await new FileConfigStore(paths).load();
    expect(stored.cloud?.url).toBe("wss://fresh.control.example/tunnel");
    expect(stored.updates).toBeUndefined();
  });

  test("keeps update settings that can be read when the file passes its check", async () => {
    const paths = fortressPaths(root);
    const updates = { from: "own-address", address: "https://files.northstar.example/hx-fortress" } as const;
    await writeFile(paths.config, JSON.stringify({ ...ENROLLED, updates }));
    await ensureEnrollmentConfig(paths, "wss://fresh.control.example/tunnel");
    const stored = await new FileConfigStore(paths).load();
    expect(stored.cloud?.url).toBe("wss://fresh.control.example/tunnel");
    expect(stored.updates).toEqual(updates);
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
