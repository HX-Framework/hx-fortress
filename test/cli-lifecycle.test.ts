import { describe, expect, test } from "bun:test";

import {
  startFortress,
  statusFortress,
  stopFortress,
} from "../src/cli-lifecycle";
import type { StatusReader } from "../src/status-reader";
import type {
  ServiceManager,
  ServiceState,
} from "../src/service/types";
import type { HostStatusSnapshot } from "../src/host/types";

describe("startFortress", () => {
  test("does not reinstall an already-running service", async () => {
    const manager = fakeManager([{ loaded: true, pid: 1234 }]);
    const lines: string[] = [];

    await startFortress(deps(manager, lines));

    expect(manager.installs).toBe(0);
    expect(lines).toEqual([
      "Fortress is running (launchd, pid 1234).",
      "logs: /home/test/.let/hx-fortress/logs/fortress.jsonl",
    ]);
  });

  test("installs and reports a newly running service", async () => {
    const manager = fakeManager([
      { loaded: false, pid: null },
      { loaded: true, pid: 1234 },
    ]);
    const lines: string[] = [];

    await startFortress(deps(manager, lines));

    expect(manager.installs).toBe(1);
    expect(lines).toEqual([
      "Fortress started (launchd, pid 1234).",
      "logs: /home/test/.let/hx-fortress/logs/fortress.jsonl",
      "status: hx-fortress status",
    ]);
  });
});

describe("stopFortress", () => {
  test("reports a verified stop", async () => {
    const manager = fakeManager([], true);
    const lines: string[] = [];

    await stopFortress({ manager, writeLine: (line) => lines.push(line) });

    expect(lines).toEqual([
      "Fortress stopped (launchd). Run `hx-fortress start` to resume.",
    ]);
  });

  test("reports a no-op stop", async () => {
    const manager = fakeManager([], false);
    const lines: string[] = [];

    await stopFortress({ manager, writeLine: (line) => lines.push(line) });

    expect(lines).toEqual([
      "Fortress is not running - nothing to stop. Run `hx-fortress start` to start it.",
    ]);
  });
});

describe("statusFortress", () => {
  test("reports stopped service without trusting a snapshot", async () => {
    const lines: string[] = [];
    await statusFortress({
      manager: fakeManager([{ loaded: false, pid: null }]),
      statusReader: reader(snapshot(999, "connected")),
      writeLine: (line) => lines.push(line),
    });

    expect(lines).toEqual([
      "Fortress:   stopped - run `hx-fortress start` to resume",
      "Connection: offline",
      "Modules:    unavailable",
    ]);
  });

  test("reports startup while the snapshot is missing or stale", async () => {
    const lines: string[] = [];
    await statusFortress({
      manager: fakeManager([{ loaded: true, pid: 1234 }]),
      statusReader: reader(snapshot(999, "connected")),
      writeLine: (line) => lines.push(line),
    });

    expect(lines).toEqual([
      "Fortress:   running (launchd, pid 1234)",
      "Connection: starting",
      "Modules:    unavailable",
    ]);
  });

  test.each([
    ["connected", "connected"],
    ["connecting", "enrolling"],
    ["offline", "offline"],
    ["closing", "offline"],
  ] as const)("maps %s connection state to %s", async (state, expected) => {
    const lines: string[] = [];
    await statusFortress({
      manager: fakeManager([{ loaded: true, pid: 1234 }]),
      statusReader: reader(snapshot(1234, state)),
      writeLine: (line) => lines.push(line),
    });

    expect(lines).toEqual([
      "Fortress:   running (launchd, pid 1234)",
      `Connection: ${expected}`,
      "Modules:",
      "  analytics      stopped",
      "  session_vault  running",
    ]);
  });

  test("reports invalid credential failures directly", async () => {
    const lines: string[] = [];
    await statusFortress({
      manager: fakeManager([{ loaded: true, pid: 1234 }]),
      statusReader: reader(snapshot(1234, "offline", {
        reason: "invalid_credential",
        message: "Hub rejected connection: invalid_credential",
      })),
      writeLine: (line) => lines.push(line),
    });

    expect(lines).toEqual([
      "Fortress:   running (launchd, pid 1234)",
      "Connection: invalid credential",
      "Detail:     Hub rejected connection: invalid_credential",
      "Modules:",
      "  analytics      stopped",
      "  session_vault  running",
    ]);
  });
});

function deps(manager: FakeManager, lines: string[]) {
  return {
    manager,
    executablePath: "/usr/local/bin/hx-fortress",
    paths: {
      log: "/home/test/.let/hx-fortress/logs/fortress.jsonl",
      serviceLog: "/home/test/.let/hx-fortress/logs/service.log",
    },
    writeLine: (line: string) => lines.push(line),
  };
}

interface FakeManager extends ServiceManager {
  installs: number;
  starts: number;
  unitPresent: boolean;
}

function fakeManager(
  states: ServiceState[],
  wasRunning = false,
  unitPresent = false,
): FakeManager {
  return {
    name: "launchd",
    installs: 0,
    starts: 0,
    unitPresent,
    async unit() {
      return {
        path: "/Users/test/Library/LaunchAgents/ai.let.hx-fortress.plist",
        present: this.unitPresent,
        executablePath: this.unitPresent ? "/usr/local/bin/hx-fortress" : null,
      };
    },
    async start() {
      this.starts += 1;
    },
    async restart() {},
    async uninstall() {},
    async ensureLogDir() {},
    async install() {
      this.installs += 1;
    },
    async stop() {
      return { wasRunning };
    },
    async state() {
      return states.shift() ?? { loaded: false, pid: null };
    },
  };
}

function reader(value: HostStatusSnapshot | null): StatusReader {
  return {
    async read() {
      return value;
    },
  };
}

function snapshot(
  pid: number,
  connectionState: HostStatusSnapshot["connection"]["state"],
  override?: Partial<HostStatusSnapshot["connection"]>,
): HostStatusSnapshot {
  return {
    schemaVersion: 1,
    host: {
      state: "running",
      pid,
      startedAt: "2026-06-15T10:00:00.000Z",
      updatedAt: "2026-06-15T10:00:01.000Z",
      error: null,
    },
    connection: {
      state: connectionState,
      reason: null,
      message: null,
      ...override,
    },
    postgres: { phase: "ready", reason: null },
    modules: [
      { id: "session_vault", state: "running", error: null },
      { id: "analytics", state: "stopped", error: null },
    ],
  };
}
