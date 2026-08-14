import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DAEMON_STATE_COPY, STATUS_STALE_MS, compareRoots, daemonState } from "../src/daemon-state";
import { FileStatusReader } from "../src/status-reader";
import { statusFortress } from "../src/cli-lifecycle";
import type { HostStatusSnapshot } from "../src/host/types";
import type { ServiceManager } from "../src/service/types";

const NOW = new Date("2026-07-31T12:00:00.000Z");

function snapshot(over: Partial<HostStatusSnapshot["host"]> = {}): HostStatusSnapshot {
  return {
    schemaVersion: 1,
    host: {
      state: "running",
      pid: 42,
      startedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      error: null,
      writtenAt: NOW.toISOString(),
      ...over,
    },
    connection: { state: "connected", reason: null, message: null },
    postgres: { phase: "ready", reason: null },
    modules: [],
  };
}

describe("the daemon-state predicate", () => {
  test("service state first: stopped, loaded", () => {
    expect(daemonState({ service: { loaded: false, pid: null }, snapshot: null, now: NOW })).toBe("stopped");
    expect(daemonState({ service: { loaded: true, pid: null }, snapshot: null, now: NOW })).toBe("loaded");
  });

  test("then the pid match", () => {
    expect(daemonState({ service: { loaded: true, pid: 42 }, snapshot: null, now: NOW })).toBe("starting");
    expect(
      daemonState({ service: { loaded: true, pid: 43 }, snapshot: snapshot(), now: NOW }),
    ).toBe("starting");
  });

  test("a cleanly stopped daemon renders stopped, never stale", () => {
    // Its own last write says so; calling that "not responding" sends an
    // operator hunting a crash that never happened.
    expect(
      daemonState({
        service: { loaded: true, pid: 42 },
        snapshot: snapshot({ state: "stopped", writtenAt: new Date(NOW.getTime() - 3_600_000).toISOString() }),
        now: NOW,
      }),
    ).toBe("stopped");
  });

  test("then the age leg", () => {
    expect(daemonState({ service: { loaded: true, pid: 42 }, snapshot: snapshot(), now: NOW })).toBe("running");
    expect(
      daemonState({
        service: { loaded: true, pid: 42 },
        snapshot: snapshot({ writtenAt: new Date(NOW.getTime() - STATUS_STALE_MS - 1000).toISOString() }),
        now: NOW,
      }),
    ).toBe("stale");
  });

  test("with NO supervisor to ask, the heartbeat decides", () => {
    // The container image runs `host` and `ui` under its own supervisor and
    // carries no systemd; an undrivable platform has no manager at all. Both
    // answer "no pid" to a question they cannot answer, and taking that as an
    // answer reported a healthy, heartbeating daemon as `stopped` — which
    // disabled Run audit, the witness toggles, Acknowledge, checkup and
    // rotation, since the console gates every one of them on this value.
    expect(daemonState({ service: null, snapshot: snapshot(), now: NOW })).toBe("running");
    // Nothing published yet is a start in progress, not a stopped daemon.
    expect(daemonState({ service: null, snapshot: null, now: NOW })).toBe("starting");
    // A daemon that died stops writing, so the age leg still catches it —
    // absence of a supervisor removes evidence, it does not invent any.
    expect(
      daemonState({
        service: null,
        snapshot: snapshot({ writtenAt: new Date(NOW.getTime() - STATUS_STALE_MS - 1000).toISOString() }),
        now: NOW,
      }),
    ).toBe("stale");
    // …and its own clean shutdown is still honoured.
    expect(daemonState({ service: null, snapshot: snapshot({ state: "stopped" }), now: NOW })).toBe("stopped");
    expect(daemonState({ service: null, snapshot: snapshot({ state: "failed" }), now: NOW })).toBe("failed");
  });

  test("a pre-heartbeat file is age-UNKNOWN, not stale", () => {
    const state = daemonState({
      service: { loaded: true, pid: 42 },
      snapshot: snapshot({ writtenAt: undefined }),
      now: NOW,
    });
    expect(state).toBe("pre-heartbeat");
    expect(DAEMON_STATE_COPY[state]).toContain("restart to finish the upgrade");
  });
});

describe("pre-console status.json", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-status-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("parses with no writtenAt and no host.root", async () => {
    // Every fortress in the field holds one of these; a parse error here would
    // turn an upgrade into "Fortress: unavailable".
    const file = path.join(root, "status.json");
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        host: { state: "running", pid: 42, startedAt: null, updatedAt: NOW.toISOString(), error: null },
        connection: { state: "connected", reason: null, message: null },
        postgres: { phase: "ready", reason: null },
        modules: [],
      }),
    );
    const parsed = await new FileStatusReader(file).read();
    expect(parsed?.host.writtenAt).toBeUndefined();
    expect(parsed?.host.root).toBeUndefined();
    expect(parsed?.host.pid).toBe(42);
  });

  test("round-trips writtenAt and root at schemaVersion 1", async () => {
    const file = path.join(root, "status.json");
    await writeFile(file, JSON.stringify(snapshot({ root: "/srv/fortress" })));
    const parsed = await new FileStatusReader(file).read();
    expect(parsed?.schemaVersion).toBe(1);
    expect(parsed?.host.writtenAt).toBe(NOW.toISOString());
    expect(parsed?.host.root).toBe("/srv/fortress");
  });

  test("a non-string writtenAt is still a parse error", async () => {
    const file = path.join(root, "status.json");
    await writeFile(file, JSON.stringify(snapshot({ writtenAt: 5 as unknown as string })));
    await expect(new FileStatusReader(file).read()).rejects.toThrow(/writtenAt/);
  });
});

describe("`hx-fortress status` output", () => {
  function manager(pid: number | null, loaded = true): ServiceManager {
    return {
      name: "systemd",
      state: async () => ({ loaded, pid }),
      install: async () => {},
      stop: async () => ({ wasRunning: false }),
    } as unknown as ServiceManager;
  }

  test("is byte-identical on a pre-console status.json", async () => {
    // The age leg is CONSOLE-only: two readers with different notions of
    // "running" is how two surfaces end up disagreeing about one daemon.
    const lines: string[] = [];
    await statusFortress({
      manager: manager(42),
      statusReader: {
        read: async () =>
          snapshot({ writtenAt: undefined, root: undefined }) as HostStatusSnapshot,
      },
      writeLine: (l) => lines.push(l),
    });
    expect(lines).toEqual([
      "Fortress:   running (systemd, pid 42)",
      "Connection: connected",
      "Modules:    none",
    ]);
  });

  test("is unchanged for a long-stale heartbeat too", async () => {
    const lines: string[] = [];
    await statusFortress({
      manager: manager(42),
      statusReader: {
        read: async () =>
          snapshot({ writtenAt: new Date(NOW.getTime() - 86_400_000).toISOString() }),
      },
      writeLine: (l) => lines.push(l),
    });
    expect(lines[0]).toBe("Fortress:   running (systemd, pid 42)");
    expect(lines[1]).toBe("Connection: connected");
  });
});

describe("root comparison", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-root-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("compares by FILE IDENTITY, so a symlinked spelling is the same root", async () => {
    const link = path.join(root, "link");
    await symlink(root, link);
    expect(await compareRoots(root, link)).toBe("same");
  });

  test("a genuinely different directory is a mismatch", async () => {
    const other = await mkdtemp(path.join(os.tmpdir(), "hx-root2-"));
    try {
      expect(await compareRoots(root, other)).toBe("different");
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  test("an absent or unreadable side is UNKNOWN, never a mismatch", async () => {
    expect(await compareRoots(undefined, root)).toBe("unknown");
    expect(await compareRoots(root, path.join(root, "nope"))).toBe("unknown");
  });
});
