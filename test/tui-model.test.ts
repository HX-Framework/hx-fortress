import { describe, expect, test } from "bun:test";

import { buildMainScreenModel } from "../src/tui/model";
import type { HostStatusSnapshot } from "../src/host/types";

describe("buildMainScreenModel", () => {
  test("renders only the live session_vault row (future modules hidden — MC-2465)", () => {
    const model = buildMainScreenModel({
      service: { loaded: true, pid: 1234 },
      snapshot: runningSnapshot(),
      installedModules: [
        {
          moduleId: "session_vault",
          version: "1.2.3",
          artifactPath: "/tmp/session_vault.js",
          checksum: "abc",
          installedAt: "2026-06-15T18:00:00.000Z",
        },
      ],
      updates: {
        session_vault: { kind: "module", version: "1.2.4" },
      },
    });

    // MC-2465: session_computer + devops_utility are hidden until they're real, so
    // only the live session_vault row renders.
    expect(model.rows.map((row) => row.id)).toEqual(["session_vault"]);
    expect(model.rows[0]).toMatchObject({
      id: "session_vault",
      label: "session_vault",
      availability: "live",
      statusLabel: "running",
      installedVersion: "1.2.3",
      availableVersion: "1.2.4",
    });
    expect(model.rows[0]?.actions.map((action) => action.kind)).toEqual([
      "stop",
      "update",
      "view-details",
    ]);
    expect(model.rows[0]?.actions[1]).toEqual({
      kind: "update",
      enabled: true,
      version: "1.2.4",
    });
    expect(model.footerNote).toBe(
      "Safe to exit HX Fortress. Components keep running in the background.",
    );
  });

  test("shows start when Fortress is stopped", () => {
    const model = buildMainScreenModel({
      service: { loaded: false, pid: null },
      snapshot: null,
      installedModules: [],
      updates: {},
    });

    expect(model.rows[0]?.actions.map((action) => action.kind)).toEqual([
      "start",
      "view-details",
    ]);
  });

  test("falls back to stopped when the runtime module status is missing", () => {
    const model = buildMainScreenModel({
      service: { loaded: true, pid: 1234 },
      snapshot: {
        ...runningSnapshot(),
        modules: [],
      },
      installedModules: [],
      updates: {},
    });

    expect(model.rows[0]).toMatchObject({
      id: "session_vault",
      label: "session_vault",
      availability: "live",
      statusLabel: "stopped",
    });
    expect(model.rows[0]?.actions.map((action) => action.kind)).toEqual([
      "stop",
      "view-details",
    ]);
  });

  test("treats stale runtime status as stopped while keeping pid-based stop action", () => {
    const model = buildMainScreenModel({
      service: { loaded: true, pid: 1234 },
      snapshot: {
        ...runningSnapshot(),
        host: {
          ...runningSnapshot().host,
          pid: 9999,
        },
      },
      installedModules: [],
      updates: {
        session_vault: { kind: "binary", version: "2.0.0" },
      },
    });

    expect(model.rows[0]).toMatchObject({
      id: "session_vault",
      statusLabel: "stopped",
      availableVersion: "2.0.0",
    });
    expect(model.rows[0]?.actions).toEqual([
      { kind: "stop", enabled: true },
      { kind: "update", enabled: true, version: "2.0.0" },
      { kind: "view-details", enabled: true },
    ]);
  });
});

function runningSnapshot(): HostStatusSnapshot {
  return {
    schemaVersion: 1,
    host: {
      state: "running",
      pid: 1234,
      startedAt: "2026-06-15T18:00:00.000Z",
      updatedAt: "2026-06-15T18:00:01.000Z",
      error: null,
    },
    connection: {
      state: "connected",
      reason: null,
      message: null,
    },
    postgres: { phase: "ready", reason: null },
    modules: [
      {
        id: "session_vault",
        state: "running",
        error: null,
      },
    ],
  };
}
