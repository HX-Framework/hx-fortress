import { describe, expect, test } from "bun:test";

import { createTuiApp } from "../src/tui/app";
import { buildMainScreenModel } from "../src/tui/model";

describe("createTuiApp", () => {
  test("exposes the model for a renderer to consume", () => {
    const model = buildMainScreenModel({
      service: { loaded: false, pid: null },
      snapshot: null,
      installedModules: [],
      updates: {},
    });
    const app = createTuiApp({
      model,
      actions: {
        start: async () => {},
        stop: async () => {},
        update: async () => {},
        uninstall: async () => {},
      },
    });

    expect(app.model()).toBe(model);
  });

  test("wraps rows and resets the selected action when the row changes", () => {
    const app = createTuiApp({
      // Hand-built multi-row model: MC-2465 currently ships only session_vault, but
      // createTuiApp's row-wrap + action-reset navigation is general — exercise it
      // across rows independently of how many the product renders today.
      model: {
        footerNote: "test",
        rows: [
          {
            id: "session_vault",
            label: "session_vault",
            availability: "live",
            statusLabel: "stopped",
            installedVersion: null,
            availableVersion: "1.2.4",
            actions: [
              { kind: "stop", enabled: true },
              { kind: "update", enabled: true, version: "1.2.4" },
              { kind: "view-details", enabled: true },
            ],
          },
          {
            id: "session_computer",
            label: "session_computer",
            availability: "unavailable",
            statusLabel: "unavailable",
            installedVersion: null,
            availableVersion: null,
            actions: [{ kind: "view-details", enabled: true }],
          },
          {
            id: "devops_utility",
            label: "devops-utility",
            availability: "unavailable",
            statusLabel: "unavailable",
            installedVersion: null,
            availableVersion: null,
            actions: [{ kind: "view-details", enabled: true }],
          },
        ],
      },
      actions: {
        start: async () => {},
        stop: async () => {},
        update: async () => {},
        uninstall: async () => {},
      },
    });

    app.moveAction(1);
    expect(app.state()).toMatchObject({
      screen: "main",
      selectedRow: 0,
      selectedAction: 1,
      pendingDetailsFor: null,
      error: null,
    });

    app.moveRow(1);
    expect(app.state()).toMatchObject({
      screen: "main",
      selectedRow: 1,
      selectedAction: 0,
      pendingDetailsFor: null,
      error: null,
    });

    app.moveRow(-1);
    expect(app.state()).toMatchObject({
      selectedRow: 0,
      selectedAction: 0,
    });

    app.moveRow(-1);
    expect(app.state()).toMatchObject({
      selectedRow: 2,
      selectedAction: 0,
    });
  });

  test("preserves the selected action when a row move resolves to the same row", () => {
    const app = createTuiApp({
      model: buildMainScreenModel({
        service: { loaded: true, pid: 1234 },
        snapshot: null,
        installedModules: [],
        updates: {
          session_vault: { kind: "module", version: "1.2.4" },
        },
      }),
      actions: {
        start: async () => {},
        stop: async () => {},
        update: async () => {},
        uninstall: async () => {},
      },
    });

    app.moveAction(1);
    expect(app.state()).toMatchObject({
      selectedRow: 0,
      selectedAction: 1,
    });

    app.moveRow(0);
    expect(app.state()).toMatchObject({
      selectedRow: 0,
      selectedAction: 1,
    });

    app.moveRow(3);
    expect(app.state()).toMatchObject({
      selectedRow: 0,
      selectedAction: 1,
    });
  });

  test("wraps actions within the current row", () => {
    const app = createTuiApp({
      model: buildMainScreenModel({
        service: { loaded: true, pid: 1234 },
        snapshot: null,
        installedModules: [],
        updates: {
          session_vault: { kind: "module", version: "1.2.4" },
        },
      }),
      actions: {
        start: async () => {},
        stop: async () => {},
        update: async () => {},
        uninstall: async () => {},
      },
    });

    app.moveAction(-1);
    expect(app.state().selectedAction).toBe(2);

    app.moveAction(1);
    expect(app.state().selectedAction).toBe(0);
  });

  test("dispatches start, stop, and update actions through injected handlers", async () => {
    const startCalls: string[] = [];
    const startApp = createTuiApp({
      model: buildMainScreenModel({
        service: { loaded: false, pid: null },
        snapshot: null,
        installedModules: [],
        updates: {},
      }),
      actions: {
        start: async () => {
          startCalls.push("start");
        },
        stop: async () => {
          startCalls.push("stop");
        },
        update: async (version) => {
          startCalls.push(`update:${version}`);
        },
        uninstall: async () => {},
      },
    });

    await startApp.activate();
    expect(startCalls).toEqual(["start"]);

    const stopCalls: string[] = [];
    const stopApp = createTuiApp({
      model: buildMainScreenModel({
        service: { loaded: true, pid: 1234 },
        snapshot: null,
        installedModules: [],
        updates: {
          session_vault: { kind: "module", version: "1.2.4" },
        },
      }),
      actions: {
        start: async () => {
          stopCalls.push("start");
        },
        stop: async () => {
          stopCalls.push("stop");
        },
        update: async (version) => {
          stopCalls.push(`update:${version}`);
        },
        uninstall: async () => {},
      },
    });

    await stopApp.activate();
    expect(stopCalls).toEqual(["stop"]);

    const updateCalls: string[] = [];
    const updateApp = createTuiApp({
      model: buildMainScreenModel({
        service: { loaded: true, pid: 1234 },
        snapshot: null,
        installedModules: [],
        updates: {
          session_vault: { kind: "module", version: "1.2.4" },
        },
      }),
      actions: {
        start: async () => {
          updateCalls.push("start");
        },
        stop: async () => {
          updateCalls.push("stop");
        },
        update: async (version) => {
          updateCalls.push(`update:${version}`);
        },
        uninstall: async () => {},
      },
    });

    updateApp.moveAction(1);
    await updateApp.activate();
    expect(updateCalls).toEqual(["update:1.2.4"]);
  });

  test("records a pending details target instead of rendering details", async () => {
    const app = createTuiApp({
      model: buildMainScreenModel({
        service: { loaded: false, pid: null },
        snapshot: null,
        installedModules: [],
        updates: {},
      }),
      actions: {
        start: async () => {},
        stop: async () => {},
        update: async () => {},
        uninstall: async () => {},
      },
    });

    app.moveAction(1);
    await app.activate();

    expect(app.state()).toMatchObject({
      screen: "details",
      pendingDetailsFor: "session_vault",
      selectedRow: 0,
      selectedAction: 0,
      error: null,
    });
  });

  test("captures action errors in controller state without throwing", async () => {
    const app = createTuiApp({
      model: buildMainScreenModel({
        service: { loaded: false, pid: null },
        snapshot: null,
        installedModules: [],
        updates: {},
      }),
      actions: {
        start: async () => {
          throw new Error("boom");
        },
        stop: async () => {},
        update: async () => {},
        uninstall: async () => {},
      },
    });

    await expect(app.activate()).resolves.toBeUndefined();
    expect(app.state().error).toBe("boom");
  });

  test("ignores disabled actions", async () => {
    const calls: string[] = [];
    const app = createTuiApp({
      model: {
        rows: [
          {
            id: "session_vault",
            label: "session_vault",
            availability: "live",
            statusLabel: "stopped",
            installedVersion: null,
            availableVersion: null,
            actions: [{ kind: "start", enabled: false }],
          },
        ],
        footerNote: "note",
      },
      actions: {
        start: async () => {
          calls.push("start");
        },
        stop: async () => {
          calls.push("stop");
        },
        update: async (version) => {
          calls.push(`update:${version}`);
        },
        uninstall: async () => {},
      },
    });

    await app.activate();

    expect(calls).toEqual([]);
    expect(app.state()).toMatchObject({
      screen: "main",
      pendingDetailsFor: null,
      error: null,
    });
  });

  test("refreshes the model after a successful lifecycle action", async () => {
    const afterStart = buildMainScreenModel({
      service: { loaded: true, pid: 9999 },
      snapshot: null,
      installedModules: [],
      updates: {},
    });

    const app = createTuiApp({
      model: buildMainScreenModel({
        service: { loaded: false, pid: null },
        snapshot: null,
        installedModules: [],
        updates: {},
      }),
      reloadModel: async () => afterStart,
      actions: {
        start: async () => {},
        stop: async () => {},
        update: async () => {},
        uninstall: async () => {},
      },
    });

    await app.activate();

    expect(app.model()).toBe(afterStart);
    expect(app.state().screen).toBe("main");
    expect(app.state().pendingDetailsFor).toBeNull();
  });

  test("keeps the stale model when reloadModel throws, without surfacing the reload error", async () => {
    const initialModel = buildMainScreenModel({
      service: { loaded: false, pid: null },
      snapshot: null,
      installedModules: [],
      updates: {},
    });

    const app = createTuiApp({
      model: initialModel,
      reloadModel: async () => {
        throw new Error("reload boom");
      },
      actions: {
        start: async () => {},
        stop: async () => {},
        update: async () => {},
        uninstall: async () => {},
      },
    });

    await expect(app.activate()).resolves.toBeUndefined();

    expect(app.model()).toBe(initialModel);
    expect(app.state().error).toBeNull();
  });

  test("clamps selectedAction when the refreshed model has fewer actions on the current row", async () => {
    const oneActionModel = {
      rows: [
        {
          id: "session_vault" as const,
          label: "session_vault",
          availability: "live" as const,
          statusLabel: "stopped" as const,
          installedVersion: "1.2.4",
          availableVersion: null,
          actions: [{ kind: "stop" as const, enabled: true }],
        },
      ],
      footerNote: "note",
    };

    const app = createTuiApp({
      model: {
        rows: [
          {
            id: "session_vault" as const,
            label: "session_vault",
            availability: "live" as const,
            statusLabel: "stopped" as const,
            installedVersion: "1.2.3",
            availableVersion: "1.2.4",
            actions: [
              { kind: "stop" as const, enabled: true },
              { kind: "update" as const, enabled: true, version: "1.2.4" },
              { kind: "view-details" as const, enabled: true },
            ],
          },
        ],
        footerNote: "note",
      },
      reloadModel: async () => oneActionModel,
      actions: {
        start: async () => {},
        stop: async () => {},
        update: async () => {},
        uninstall: async () => {},
      },
    });

    app.moveAction(1);
    expect(app.state().selectedAction).toBe(1);

    await app.activate();

    expect(app.model()).toBe(oneActionModel);
    expect(app.state().selectedAction).toBe(0);
  });
});
