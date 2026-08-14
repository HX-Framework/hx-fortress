import { describe, expect, test } from "bun:test";

import { HostRuntime } from "../src/host/runtime";
import type {
  CloudConnection,
  ConfigStore,
  FortressConfig,
  HostLogger,
  HostStatusSnapshot,
  ModuleRuntimeStatus,
  ModuleStartResult,
  ModuleStopResult,
  ModuleSupervisor,
  PostgresProvider,
  StatusStore,
} from "../src/host/types";

const CONFIG: FortressConfig = {
  schemaVersion: 1,
  cloud: { url: "wss://example.let.ai/tunnel" },
  gateway: { publicUrl: "http://localhost:8787" },
  modules: { enabled: ["session_vault", "analytics"] },
};

describe("HostRuntime", () => {
  test("boots in dependency order", async () => {
    const harness = createHarness();

    await harness.runtime.start();

    expect(harness.events).toEqual([
      "status:starting",
      "config:load",
      "connection:open",
      "modules:start:session_vault,analytics",
      "status:running",
    ]);
    expect(harness.snapshots.at(-1)).toEqual({
      schemaVersion: 1,
      host: {
        state: "running",
        pid: 4242,
        startedAt: "2026-06-15T10:00:00.000Z",
        updatedAt: "2026-06-15T10:00:01.000Z",
        error: null,
        writtenAt: "2026-06-15T10:00:01.000Z",
      },
      connection: { state: "connected", reason: null, message: null },
      postgres: { phase: "ready", reason: null },
      modules: [
        { id: "session_vault", state: "running", error: null },
        { id: "analytics", state: "running", error: null },
      ],
    });
  });

  test("status snapshot carries the postgres phase", async () => {
    const harness = createHarness({ postgresPhase: "failed" });

    await harness.runtime.start();

    expect(harness.snapshots.at(-1)?.postgres).toEqual({ phase: "failed", reason: "boom" });
  });

  test("keeps the host running when one module fails to start", async () => {
    const harness = createHarness({
      startedModules: [
        { id: "session_vault", state: "failed", error: "bucket unavailable" },
        { id: "analytics", state: "running", error: null },
      ],
    });

    await harness.runtime.start();

    expect(harness.snapshots.at(-1)?.host.state).toBe("running");
    expect(harness.snapshots.at(-1)?.modules).toEqual([
      { id: "session_vault", state: "failed", error: "bucket unavailable" },
      { id: "analytics", state: "running", error: null },
    ]);
  });

  test("fails boot and skips modules when the connection cannot open", async () => {
    const harness = createHarness({
      connectionOpenError: new Error("cloud unavailable"),
    });

    await expect(harness.runtime.start()).rejects.toThrow("cloud unavailable");

    expect(harness.events).not.toContain(
      "modules:start:session_vault,analytics",
    );
    expect(harness.snapshots.at(-1)?.host).toMatchObject({
      state: "failed",
      error: "cloud unavailable",
    });
    expect(harness.snapshots.at(-1)?.host.error).not.toContain("Error:");
  });

  test("rejects a second start call", async () => {
    const harness = createHarness();
    await harness.runtime.start();

    await expect(harness.runtime.start()).rejects.toThrow(
      "Host runtime has already started",
    );
  });

  test("logs a status write failure without aborting boot", async () => {
    const harness = createHarness({ failStatusStates: ["starting"] });

    await harness.runtime.start();

    expect(harness.snapshots.at(-1)?.host.state).toBe("running");
    expect(harness.loggedErrors).toEqual([
      ["Failed to write Fortress runtime status", "status unavailable"],
    ]);
  });

  test("shuts down modules before the cloud connection", async () => {
    const harness = createHarness();
    await harness.runtime.start();
    harness.events.length = 0;

    await harness.runtime.stop();

    expect(harness.events).toEqual([
      "status:draining",
      "modules:stop",
      "connection:close",
      "status:stopped",
    ]);
    expect(harness.snapshots.at(-1)?.host.state).toBe("stopped");
    expect(harness.snapshots.at(-1)?.connection.state).toBe("offline");
  });

  test("shares one shutdown across concurrent and repeated stop calls", async () => {
    const harness = createHarness();
    await harness.runtime.start();
    harness.events.length = 0;

    const first = harness.runtime.stop();
    const second = harness.runtime.stop();

    expect(first).toBe(second);
    await Promise.all([first, second]);
    await harness.runtime.stop();
    expect(harness.events.filter((event) => event === "modules:stop")).toHaveLength(1);
    expect(harness.events.filter((event) => event === "connection:close")).toHaveLength(1);
  });

  test("closes the connection and persists stopped state after module cleanup fails", async () => {
    const harness = createHarness({
      moduleStopError: new Error("module stop failed"),
    });
    await harness.runtime.start();
    harness.events.length = 0;

    await harness.runtime.stop();

    expect(harness.events).toEqual([
      "status:draining",
      "modules:stop",
      "connection:close",
      "status:stopped",
    ]);
    expect(harness.snapshots.at(-1)?.host).toMatchObject({
      state: "stopped",
      error: "module stop failed",
    });
    expect(harness.loggedErrors).toContainEqual([
      "Failed to stop Fortress modules",
      "module stop failed",
    ]);
  });
});

interface HarnessOptions {
  startedModules?: ModuleRuntimeStatus[];
  connectionOpenError?: Error;
  moduleStopError?: Error;
  failStatusStates?: HostStatusSnapshot["host"]["state"][];
  postgresPhase?: "ready" | "failed";
}

function createHarness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const snapshots: HostStatusSnapshot[] = [];
  const loggedErrors: Array<[string, string]> = [];
  let connectionState: ReturnType<CloudConnection["state"]> = "offline";
  let modules: ModuleRuntimeStatus[] = [];
  const times = [
    new Date("2026-06-15T10:00:00.000Z"),
    new Date("2026-06-15T10:00:01.000Z"),
  ];

  const configStore: ConfigStore = {
    async load() {
      events.push("config:load");
      return CONFIG;
    },
  };
  const connection: CloudConnection = {
    state: () => connectionState,
    status: () => ({
      state: connectionState,
      reason: null,
      message: null,
    }),
    async open() {
      events.push("connection:open");
      connectionState = "connecting";
      if (options.connectionOpenError) throw options.connectionOpenError;
      connectionState = "connected";
    },
    async close() {
      events.push("connection:close");
      connectionState = "offline";
    },
    notifyIngest() {},
  };
  const supervisor: ModuleSupervisor = {
    async startAll(moduleIds): Promise<readonly ModuleStartResult[]> {
      events.push(`modules:start:${moduleIds.join(",")}`);
      modules =
        options.startedModules ??
        moduleIds.map((id) => ({ id, state: "running", error: null }));
      return modules.map((module) =>
        module.state === "failed"
          ? { id: module.id, ok: false, error: module.error ?? "module failed" }
          : { id: module.id, ok: true },
      );
    },
    async stopAll(): Promise<readonly ModuleStopResult[]> {
      events.push("modules:stop");
      if (options.moduleStopError) throw options.moduleStopError;
      modules = modules.map(({ id }) => ({ id, state: "stopped", error: null }));
      return modules.map(({ id }) => ({ id, ok: true }));
    },
    snapshot: () => modules,
  };
  const statusStore: StatusStore = {
    async write(snapshot) {
      if (options.failStatusStates?.includes(snapshot.host.state)) {
        throw new Error("status unavailable");
      }
      snapshots.push(structuredClone(snapshot));
      events.push(`status:${snapshot.host.state}`);
    },
  };
  const logger: HostLogger = {
    error(message, error) {
      loggedErrors.push([
        message,
        error instanceof Error ? error.message : String(error),
      ]);
    },
  };
  const postgresPhase = options.postgresPhase ?? "ready";
  const postgres: PostgresProvider = {
    start: async () => {},
    stop: async () => {},
    status: () => ({
      phase: postgresPhase,
      reason: postgresPhase === "failed" ? "boom" : null,
    }),
    isReady: () => postgresPhase === "ready",
    dsn: () => (postgresPhase === "ready" ? "postgresql://fortress@/hx-db?host=/sock" : null),
  };
  const runtime = new HostRuntime({
    configStore,
    connection,
    postgres,
    supervisor,
    statusStore,
    logger,
    clock: () => times.shift() ?? new Date("2026-06-15T10:00:02.000Z"),
    pid: 4242,
  });

  return { runtime, events, snapshots, loggedErrors };
}
