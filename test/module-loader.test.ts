import { describe, expect, test } from "bun:test";

import type { InstalledModuleRecord, ModuleInventoryStore } from "../src/host/module-inventory";
import { ModuleLoader } from "../src/host/module-loader";
import { LogBus } from "../src/host/logging";
import { ModuleRegistry } from "../src/host/module-registry";
import type { HostLogger, LogRecord, Module } from "../src/host/types";
import type { MsgData } from "../src/protocol";

// ── helpers ──────────────────────────────────────────────────────────────────

function silentBus(): LogBus {
  return new LogBus({ write: () => {} });
}

function silentLogger(): HostLogger {
  return { error() {} };
}

function recordingLogger(sink: Array<[string, string]>): HostLogger {
  return {
    error(message, error) {
      sink.push([message, error instanceof Error ? error.message : String(error)]);
    },
  };
}

function makeInventory(initial: InstalledModuleRecord[] = []): ModuleInventoryStore & {
  records: InstalledModuleRecord[];
} {
  let records = [...initial];
  return {
    get records() {
      return records;
    },
    async load() {
      return [...records];
    },
    async add(record) {
      const existing = records.findIndex((r) => r.moduleId === record.moduleId);
      if (existing >= 0) records[existing] = record;
      else records = [...records, record];
    },
    async remove(moduleId) {
      records = records.filter((r) => r.moduleId !== moduleId);
    },
  };
}

function echoModuleFactory(id = "test_echo"): () => Module {
  return () => ({
    id,
    onMessage(data) {
      return { ok: true, payload: data.payload };
    },
  });
}

function sha256hex(data: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  return hasher.digest("hex");
}

interface FakeLoaderDepsOptions {
  artifactData?: Uint8Array;
  moduleFactory?: () => Module;
  fetchError?: Error;
  importError?: Error;
  saveError?: Error;
  inventory?: InstalledModuleRecord[];
  logger?: HostLogger;
  bus?: LogBus;
}

function makeLoader(opts: FakeLoaderDepsOptions = {}) {
  const artifactBytes = opts.artifactData ?? new TextEncoder().encode("fake-artifact");
  const checksum = sha256hex(artifactBytes);
  const registry = new ModuleRegistry(opts.bus ?? silentBus());
  const inventory = makeInventory(opts.inventory);
  const saved = new Map<string, Uint8Array>();
  const deleted: string[] = [];

  const loader = new ModuleLoader({
    registry,
    inventory,
    fetchArtifact: async () => {
      if (opts.fetchError) throw opts.fetchError;
      return artifactBytes;
    },
    importModule: async () => {
      if (opts.importError) throw opts.importError;
      return opts.moduleFactory ?? echoModuleFactory();
    },
    saveArtifact: async (path, data) => {
      if (opts.saveError) throw opts.saveError;
      saved.set(path, data);
    },
    deleteArtifact: async (path) => {
      saved.delete(path);
      deleted.push(path);
    },
    artifactPathFor: (moduleId, version) => `/fake/modules/${moduleId}/${moduleId}-${version}.js`,
    logger: opts.logger ?? silentLogger(),
  });

  return { loader, registry, inventory, saved, deleted, checksum };
}

// ── install ───────────────────────────────────────────────────────────────────

describe("ModuleLoader.install", () => {
  test("fetches, verifies, saves, imports, registers, and starts a module", async () => {
    const { loader, registry, inventory, saved, checksum } = makeLoader();

    await loader.install({
      moduleId: "test_echo",
      version: "1.0.0",
      artifactUrl: "https://example.com/test_echo-1.0.0.js",
      checksum,
    });

    expect(registry.has("test_echo")).toBe(true);
    expect(registry.snapshot().find((m) => m.id === "test_echo")?.state).toBe("running");
    expect(saved.has("/fake/modules/test_echo/test_echo-1.0.0.js")).toBe(true);

    const records = await inventory.load();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      moduleId: "test_echo",
      version: "1.0.0",
      checksum,
    });
  });

  test("module handles onMessage after install", async () => {
    const { loader, registry, checksum } = makeLoader();

    await loader.install({
      moduleId: "test_echo",
      version: "1.0.0",
      artifactUrl: "https://example.com/test_echo-1.0.0.js",
      checksum,
    });

    const request: MsgData = {
      module: "test_echo",
      id: "req-1",
      kind: "request",
      payload: { value: 42 },
    };
    const reply = await registry.dispatch(request);
    expect(reply).toEqual({ ok: true, payload: { value: 42 } });
  });

  test("gates install on a checksum-INTEGRITY mismatch (fail-closed, defense in depth)", async () => {
    const { loader, registry, saved } = makeLoader();

    // With SIGNATURE_ENFORCE off and no signature published, the hub-supplied
    // `checksum` is the ONLY integrity control — so a mismatched checksum must fail
    // the install (corrupted / truncated / substituted artifact), and the artifact
    // is never saved. (It is NOT authenticity — the signature gate covers that.)
    await expect(
      loader.install({
        moduleId: "test_echo",
        version: "1.0.0",
        artifactUrl: "https://example.com/test_echo-1.0.0.js",
        checksum: "0000000000000000000000000000000000000000000000000000000000000000",
      }),
    ).rejects.toThrow(/integrity|checksum/i);

    expect(registry.has("test_echo")).toBe(false);
    expect(saved.size).toBe(0);
  });

  test("rejects a module whose detached signature does not verify", async () => {
    const { loader, saved } = makeLoader();

    // keyid is a genuinely trusted baked anchor, but the signature bytes are
    // bogus → verification fails BEFORE the artifact is ever saved.
    const badSidecar = JSON.stringify({
      v: 1,
      alg: "Ed25519",
      keyid: "hxf-dev-2026-07",
      sig: "AAAA",
    });

    await expect(
      loader.install({
        moduleId: "test_echo",
        version: "1.0.0",
        artifactUrl: "https://example.com/test_echo-1.0.0.js",
        checksum: "unused",
        signature: badSidecar,
      }),
    ).rejects.toThrow(/signature verification failed/);

    expect(saved.size).toBe(0);
  });

  test("rejects a module signed by an untrusted key id", async () => {
    const { loader, saved } = makeLoader();

    const sidecar = JSON.stringify({
      v: 1,
      alg: "Ed25519",
      keyid: "attacker-key",
      sig: "AAAA",
    });

    await expect(
      loader.install({
        moduleId: "test_echo",
        version: "1.0.0",
        artifactUrl: "https://example.com/test_echo-1.0.0.js",
        checksum: "unused",
        signature: sidecar,
      }),
    ).rejects.toThrow(/untrusted signing key id/);

    expect(saved.size).toBe(0);
  });

  test("deletes artifact and rejects when import fails", async () => {
    const { loader, registry, inventory, deleted, checksum } = makeLoader({
      importError: new Error("syntax error in artifact"),
    });

    await expect(
      loader.install({
        moduleId: "test_echo",
        version: "1.0.0",
        artifactUrl: "https://example.com/test_echo-1.0.0.js",
        checksum,
      }),
    ).rejects.toThrow("syntax error in artifact");

    expect(deleted).toContain("/fake/modules/test_echo/test_echo-1.0.0.js");
    expect(registry.has("test_echo")).toBe(false);
    expect((await inventory.load())).toHaveLength(0);
  });

  test("rejects when fetch fails", async () => {
    const { loader } = makeLoader({
      fetchError: new Error("network timeout"),
    });

    await expect(
      loader.install({
        moduleId: "test_echo",
        version: "1.0.0",
        artifactUrl: "https://example.com/test_echo-1.0.0.js",
        checksum: "any",
      }),
    ).rejects.toThrow("network timeout");
  });

  test("updates an already-installed module to a new version", async () => {
    const artifactData = new TextEncoder().encode("fake-artifact");
    const checksum = sha256hex(artifactData);
    const registry = new ModuleRegistry(silentBus());
    const inventory = makeInventory([
      {
        moduleId: "test_echo",
        version: "1.0.0",
        artifactPath: "/fake/modules/test_echo/test_echo-1.0.0.js",
        checksum,
        installedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const saved = new Map<string, Uint8Array>();

    const loader = new ModuleLoader({
      registry,
      inventory,
      fetchArtifact: async () => artifactData,
      importModule: async () => echoModuleFactory(),
      saveArtifact: async (p, d) => { saved.set(p, d); },
      deleteArtifact: async () => {},
      artifactPathFor: (moduleId, version) => `/fake/modules/${moduleId}/${moduleId}-${version}.js`,
      logger: silentLogger(),
    });

    // Register and start v1 first
    registry.register(echoModuleFactory()());
    await registry.startOne("test_echo");
    expect(registry.snapshot()[0]?.state).toBe("running");

    // Install v2
    await loader.install({
      moduleId: "test_echo",
      version: "2.0.0",
      artifactUrl: "https://example.com/test_echo-2.0.0.js",
      checksum,
    });

    expect(registry.snapshot()[0]?.state).toBe("running");
    const records = await inventory.load();
    expect(records).toHaveLength(1);
    expect(records[0]?.version).toBe("2.0.0");
  });
});

// ── uninstall ─────────────────────────────────────────────────────────────────

describe("ModuleLoader.uninstall", () => {
  test("stops, unregisters, deletes artifact, and removes from inventory", async () => {
    const { loader, registry, inventory, deleted, checksum } = makeLoader();

    await loader.install({
      moduleId: "test_echo",
      version: "1.0.0",
      artifactUrl: "https://example.com/test_echo-1.0.0.js",
      checksum,
    });
    expect(registry.has("test_echo")).toBe(true);

    await loader.uninstall("test_echo");

    expect(registry.has("test_echo")).toBe(false);
    expect(deleted).toContain("/fake/modules/test_echo/test_echo-1.0.0.js");
    expect((await inventory.load())).toHaveLength(0);
  });

  test("rejects when module is not in inventory", async () => {
    const { loader } = makeLoader();

    await expect(loader.uninstall("ghost")).rejects.toThrow("Module not installed: ghost");
  });

  test("calls module uninstall hook during uninstall", async () => {
    const events: string[] = [];
    const artifactData = new TextEncoder().encode("fake-artifact");
    const checksum = sha256hex(artifactData);
    const registry = new ModuleRegistry(silentBus());
    const inventory = makeInventory();

    const loader = new ModuleLoader({
      registry,
      inventory,
      fetchArtifact: async () => artifactData,
      importModule: async () => () => ({
        id: "test_echo",
        uninstall() {
          events.push("uninstall:test_echo");
        },
        onMessage() {
          return { ok: true, payload: null };
        },
      }),
      saveArtifact: async () => {},
      deleteArtifact: async () => {},
      artifactPathFor: (moduleId, version) => `/fake/${moduleId}-${version}.js`,
      logger: silentLogger(),
    });

    await loader.install({
      moduleId: "test_echo",
      version: "1.0.0",
      artifactUrl: "https://example.com/test_echo-1.0.0.js",
      checksum,
    });

    await loader.uninstall("test_echo");

    expect(events).toContain("uninstall:test_echo");
  });

  test("proceeds with cleanup even when stop hook throws", async () => {
    const busRecords: LogRecord[] = [];
    const bus = new LogBus({ write: (r) => busRecords.push(r) });
    const artifactData = new TextEncoder().encode("fake-artifact");
    const checksum = sha256hex(artifactData);
    const registry = new ModuleRegistry(bus);
    const inventory = makeInventory();
    const deleted: string[] = [];

    const loader = new ModuleLoader({
      registry,
      inventory,
      fetchArtifact: async () => artifactData,
      importModule: async () => () => ({
        id: "test_echo",
        stop() {
          throw new Error("stop failed");
        },
        onMessage() {
          return { ok: true, payload: null };
        },
      }),
      saveArtifact: async () => {},
      deleteArtifact: async (path) => { deleted.push(path); },
      artifactPathFor: (moduleId, version) => `/fake/${moduleId}-${version}.js`,
      logger: silentLogger(),
    });

    await loader.install({
      moduleId: "test_echo",
      version: "1.0.0",
      artifactUrl: "https://example.com/test_echo-1.0.0.js",
      checksum,
    });

    await loader.uninstall("test_echo");

    expect(registry.has("test_echo")).toBe(false);
    expect(deleted).toHaveLength(1);
    expect((await inventory.load())).toHaveLength(0);
    expect(busRecords.some((r) => r.level === "error" && r.msg.includes("stop"))).toBe(true);
  });
});

// ── loadFromInventory ─────────────────────────────────────────────────────────

describe("ModuleLoader.loadFromInventory", () => {
  test("registers and starts all modules recorded in the inventory", async () => {
    const artifactData = new TextEncoder().encode("fake-artifact");
    const checksum = sha256hex(artifactData);
    const registry = new ModuleRegistry(silentBus());
    const inventory = makeInventory([
      {
        moduleId: "test_echo",
        version: "1.0.0",
        artifactPath: "/fake/test_echo-1.0.0.js",
        checksum,
        installedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const loader = new ModuleLoader({
      registry,
      inventory,
      fetchArtifact: async () => artifactData,
      importModule: async () => echoModuleFactory(),
      saveArtifact: async () => {},
      deleteArtifact: async () => {},
      artifactPathFor: () => "",
      logger: silentLogger(),
    });

    await loader.loadFromInventory();

    expect(registry.has("test_echo")).toBe(true);
    expect(registry.snapshot()[0]?.state).toBe("running");
  });

  test("skips failed modules and loads the rest", async () => {
    const artifactData = new TextEncoder().encode("fake-artifact");
    const checksum = sha256hex(artifactData);
    const loggedErrors: Array<[string, string]> = [];
    const registry = new ModuleRegistry(silentBus());
    const inventory = makeInventory([
      {
        moduleId: "broken",
        version: "1.0.0",
        artifactPath: "/fake/broken-1.0.0.js",
        checksum,
        installedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        moduleId: "test_echo",
        version: "1.0.0",
        artifactPath: "/fake/test_echo-1.0.0.js",
        checksum,
        installedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    let callCount = 0;
    const loader = new ModuleLoader({
      registry,
      inventory,
      fetchArtifact: async () => artifactData,
      importModule: async () => {
        callCount++;
        if (callCount === 1) throw new Error("corrupt artifact");
        return echoModuleFactory();
      },
      saveArtifact: async () => {},
      deleteArtifact: async () => {},
      artifactPathFor: () => "",
      logger: recordingLogger(loggedErrors),
    });

    await loader.loadFromInventory();

    expect(registry.has("broken")).toBe(false);
    expect(registry.has("test_echo")).toBe(true);
    expect(loggedErrors.some(([msg]) => msg.includes("broken"))).toBe(true);
  });

  test("does nothing when inventory is empty", async () => {
    const registry = new ModuleRegistry(silentBus());
    const inventory = makeInventory([]);

    const loader = new ModuleLoader({
      registry,
      inventory,
      fetchArtifact: async () => new Uint8Array(),
      importModule: async () => echoModuleFactory(),
      saveArtifact: async () => {},
      deleteArtifact: async () => {},
      artifactPathFor: () => "",
      logger: silentLogger(),
    });

    await loader.loadFromInventory();

    expect(registry.snapshot()).toHaveLength(0);
  });
});

// ── end-to-end: full advertise→install→onMessage→uninstall path ───────────────

describe("ModuleLoader end-to-end (throwaway test module)", () => {
  test("advertise→install→onMessage→uninstall with real module fixture", async () => {
    // Uses the actual test-echo-module fixture file via dynamic import
    const artifactPath = new URL("./fixtures/test-echo-module.ts", import.meta.url).pathname;
    const artifactData = await Bun.file(artifactPath).bytes();
    const checksum = sha256hex(artifactData);

    const registry = new ModuleRegistry(silentBus());
    const inventory = makeInventory();

    const loader = new ModuleLoader({
      registry,
      inventory,
      fetchArtifact: async () => artifactData,
      importModule: async () => {
        // Real dynamic import of the fixture module
        const { default: factory } = (await import("./fixtures/test-echo-module")) as {
          default: () => Module;
        };
        return factory;
      },
      saveArtifact: async () => {},
      deleteArtifact: async () => {},
      artifactPathFor: () => artifactPath,
      logger: silentLogger(),
    });

    // advertise → install
    await loader.install({
      moduleId: "test_echo",
      version: "1.0.0",
      artifactUrl: "https://example.com/test_echo-1.0.0.js",
      checksum,
    });

    expect(registry.has("test_echo")).toBe(true);
    expect(registry.snapshot()[0]?.state).toBe("running");

    // onMessage
    const reply = await registry.dispatch({
      module: "test_echo",
      id: "req-1",
      kind: "request",
      payload: { hello: "fortress" },
    });
    expect(reply).toEqual({ ok: true, payload: { hello: "fortress" } });

    // uninstall
    await loader.uninstall("test_echo");

    expect(registry.has("test_echo")).toBe(false);
    expect((await inventory.load())).toHaveLength(0);
  });
});
