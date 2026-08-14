import { describe, expect, test } from "bun:test";

import { buildDetailsScreenModel, buildMainScreenModel } from "../src/tui/model";
import { createTuiApp } from "../src/tui/app";
import type { MainScreenModel } from "../src/tui/types";

// ── buildDetailsScreenModel ──────────────────────────────────────────────────

describe("buildDetailsScreenModel", () => {
  test("session_vault with update shows guarded uninstall and update action", () => {
    const model = buildDetailsScreenModel({
      id: "session_vault",
      installedVersion: "1.2.3",
      availableVersion: "1.2.4",
    });

    expect(model).toMatchObject({
      id: "session_vault",
      label: "session_vault",
      installedVersion: "1.2.3",
      availableVersion: "1.2.4",
      isBundledCore: true,
    });
    expect(model.actions.map((a) => a.kind)).toEqual(["update", "uninstall", "back"]);
    expect(model.actions[0]).toEqual({ kind: "update", enabled: true, version: "1.2.4" });
    expect(model.actions[1]).toMatchObject({
      kind: "uninstall",
      enabled: false,
      reason: "bundled component — cannot remove",
    });
    expect(model.actions[2]).toEqual({ kind: "back", enabled: true });
  });

  test("session_vault without update shows only guarded uninstall and back", () => {
    const model = buildDetailsScreenModel({
      id: "session_vault",
      installedVersion: "1.2.3",
      availableVersion: null,
    });

    expect(model.actions.map((a) => a.kind)).toEqual(["uninstall", "back"]);
    expect(model.actions[0]).toMatchObject({ kind: "uninstall", enabled: false });
  });

  test("session_vault with no inventory entry is still treated as bundled core", () => {
    const model = buildDetailsScreenModel({
      id: "session_vault",
      installedVersion: null,
      availableVersion: null,
    });

    expect(model.isBundledCore).toBe(true);
    expect(model.actions.map((a) => a.kind)).toEqual(["uninstall", "back"]);
    expect(model.actions[0]).toMatchObject({ kind: "uninstall", enabled: false });
  });

  test("unavailable component shows only back action", () => {
    const model = buildDetailsScreenModel({
      id: "session_computer",
      installedVersion: null,
      availableVersion: null,
    });

    expect(model).toMatchObject({
      id: "session_computer",
      label: "session_computer",
      installedVersion: null,
      availableVersion: null,
      isBundledCore: false,
      actions: [{ kind: "back", enabled: true }],
    });
  });

  test("installed non-core component shows enabled uninstall", () => {
    const model = buildDetailsScreenModel({
      id: "devops_utility",
      installedVersion: "2.0.0",
      availableVersion: null,
    });

    expect(model.isBundledCore).toBe(false);
    expect(model.actions.map((a) => a.kind)).toEqual(["uninstall", "back"]);
    expect(model.actions[0]).toMatchObject({
      kind: "uninstall",
      enabled: true,
      reason: null,
    });
  });
});

// ── createTuiApp — details screen navigation ─────────────────────────────────

describe("createTuiApp details screen", () => {
  function makeVaultApp(hasUpdate = false) {
    const calls: string[] = [];
    const app = createTuiApp({
      model: buildMainScreenModel({
        service: { loaded: true, pid: 1234 },
        snapshot: null,
        installedModules: [
          {
            moduleId: "session_vault",
            version: "1.2.3",
            artifactPath: "/tmp/sv.js",
            checksum: "abc",
            installedAt: "2026-06-15T00:00:00.000Z",
          },
        ],
        updates: hasUpdate
          ? { session_vault: { kind: "module", version: "1.2.4" } }
          : {},
      }),
      actions: {
        start: async () => { calls.push("start"); },
        stop: async () => { calls.push("stop"); },
        update: async (v) => { calls.push(`update:${v}`); },
        uninstall: async (id) => { calls.push(`uninstall:${id}`); },
      },
    });
    return { app, calls };
  }

  test("entering view-details builds the details model from the row's version", async () => {
    const { app } = makeVaultApp();

    // session_vault with service running, no update: actions are ["stop", "view-details"]
    app.moveAction(1);
    await app.activate();

    expect(app.state().screen).toBe("details");
    expect(app.state().pendingDetailsFor).toBe("session_vault");
    const details = app.detailsModel();
    expect(details).toBeDefined();
    expect(details?.installedVersion).toBe("1.2.3");
    expect(details?.isBundledCore).toBe(true);
  });

  test("selectedAction resets to 0 when entering details", async () => {
    const { app } = makeVaultApp();

    // action 0 = "stop", action 1 = "view-details"
    app.moveAction(1);
    expect(app.state().selectedAction).toBe(1);
    await app.activate();

    expect(app.state().screen).toBe("details");
    expect(app.state().selectedAction).toBe(0);
  });

  test("back action on details screen returns to main", async () => {
    const { app } = makeVaultApp();

    app.moveAction(1);
    await app.activate();
    expect(app.state().screen).toBe("details");

    // session_vault no update: details actions are ["uninstall", "back"]
    // selectedAction is 0 (uninstall), move to 1 (back)
    app.moveAction(1);
    await app.activate();

    expect(app.state().screen).toBe("main");
    expect(app.state().pendingDetailsFor).toBeNull();
  });

  test("goBack from details returns to main and clears details model", async () => {
    const { app } = makeVaultApp();

    app.moveAction(1);
    await app.activate();
    expect(app.state().screen).toBe("details");

    app.goBack();

    expect(app.state().screen).toBe("main");
    expect(app.state().pendingDetailsFor).toBeNull();
    expect(app.detailsModel()).toBeNull();
  });

  test("goBack on main screen is a no-op", () => {
    const { app } = makeVaultApp();

    expect(app.state().screen).toBe("main");
    app.goBack();
    expect(app.state().screen).toBe("main");
  });

  test("disabled uninstall on bundled core does nothing", async () => {
    const { app, calls } = makeVaultApp();

    // Enter details for session_vault
    app.moveAction(1);
    await app.activate();
    expect(app.state().screen).toBe("details");

    // uninstall is at index 0, and it's disabled
    expect(app.state().selectedAction).toBe(0);
    await app.activate();

    // Should be a no-op: still on details, no calls made
    expect(calls).toEqual([]);
    expect(app.state().screen).toBe("details");
  });

  test("update action from details screen dispatches and returns to main", async () => {
    const { app, calls } = makeVaultApp(true);

    // With update: main actions are ["stop", "update", "view-details"] (index 2)
    app.moveAction(2);
    await app.activate();
    expect(app.state().screen).toBe("details");

    // details actions with update: ["update", "uninstall", "back"] — index 0 = update
    expect(app.state().selectedAction).toBe(0);
    await app.activate();

    expect(calls).toEqual(["update:1.2.4"]);
    expect(app.state().screen).toBe("main");
  });

  test("moveRow on details screen is a no-op", async () => {
    const { app } = makeVaultApp();

    app.moveAction(1);
    await app.activate();
    expect(app.state().screen).toBe("details");
    expect(app.state().selectedRow).toBe(0);

    app.moveRow(1);

    expect(app.state().selectedRow).toBe(0);
  });
});

// ── createTuiApp — confirm-uninstall screen ───────────────────────────────────

describe("createTuiApp confirm-uninstall screen", () => {
  function makeUninstallableApp() {
    const calls: string[] = [];
    // Use a custom model with an installed, non-core module that has an enabled uninstall
    const model: MainScreenModel = {
      rows: [
        {
          id: "devops_utility",
          label: "devops-utility",
          availability: "live",
          statusLabel: "running",
          installedVersion: "2.0.0",
          availableVersion: null,
          actions: [{ kind: "view-details", enabled: true }],
        },
      ],
      footerNote: "Safe to exit HX Fortress. Components keep running in the background.",
    };
    const app = createTuiApp({
      model,
      actions: {
        start: async () => { calls.push("start"); },
        stop: async () => { calls.push("stop"); },
        update: async (v) => { calls.push(`update:${v}`); },
        uninstall: async (id) => { calls.push(`uninstall:${id}`); },
      },
    });
    return { app, calls };
  }

  async function enterDetails(app: ReturnType<typeof createTuiApp>) {
    await app.activate();
    expect(app.state().screen).toBe("details");
  }

  test("selecting uninstall on an installable component transitions to confirm-uninstall", async () => {
    const { app } = makeUninstallableApp();
    await enterDetails(app);

    // details for devops_utility (installed): actions = ["uninstall", "back"]
    expect(app.state().selectedAction).toBe(0);
    await app.activate();

    expect(app.state().screen).toBe("confirm-uninstall");
    expect(app.state().pendingDetailsFor).toBe("devops_utility");
  });

  test("selecting Confirm calls the uninstall handler and returns to main", async () => {
    const { app, calls } = makeUninstallableApp();
    await enterDetails(app);

    await app.activate();
    expect(app.state().screen).toBe("confirm-uninstall");
    expect(app.state().selectedAction).toBe(0);

    await app.activate();

    expect(calls).toEqual(["uninstall:devops_utility"]);
    expect(app.state().screen).toBe("main");
    expect(app.state().pendingDetailsFor).toBeNull();
  });

  test("selecting Cancel from confirm-uninstall returns to details", async () => {
    const { app, calls } = makeUninstallableApp();
    await enterDetails(app);

    await app.activate();
    expect(app.state().screen).toBe("confirm-uninstall");

    app.moveAction(1);
    await app.activate();

    expect(calls).toEqual([]);
    expect(app.state().screen).toBe("details");
  });

  test("goBack from confirm-uninstall returns to details without calling uninstall", async () => {
    const { app, calls } = makeUninstallableApp();
    await enterDetails(app);

    await app.activate();
    expect(app.state().screen).toBe("confirm-uninstall");

    app.goBack();

    expect(calls).toEqual([]);
    expect(app.state().screen).toBe("details");
  });

  test("uninstall errors are captured in controller state without throwing", async () => {
    const model: MainScreenModel = {
      rows: [
        {
          id: "devops_utility",
          label: "devops-utility",
          availability: "live",
          statusLabel: "running",
          installedVersion: "2.0.0",
          availableVersion: null,
          actions: [{ kind: "view-details", enabled: true }],
        },
      ],
      footerNote: "Safe to exit.",
    };
    const app = createTuiApp({
      model,
      actions: {
        start: async () => {},
        stop: async () => {},
        update: async () => {},
        uninstall: async () => { throw new Error("disk full"); },
      },
    });

    await enterDetails(app);
    await app.activate();
    expect(app.state().screen).toBe("confirm-uninstall");

    await app.activate();

    expect(app.state().error).toBe("disk full");
    expect(app.state().screen).toBe("confirm-uninstall");
  });
});

// ── tui-index integration ────────────────────────────────────────────────────

describe("runFortressTui details integration", () => {
  test("navigating to details exposes detailsModel with installed version", async () => {
    const { runFortressTui } = await import("../src/tui");

    let renderedApp: ReturnType<typeof createTuiApp> | undefined;

    await runFortressTui(
      {},
      {
        serviceStateReader: { state: async () => ({ loaded: true, pid: 1234 }) },
        statusReader: { read: async () => null },
        inventoryStore: {
          load: async () => [
            {
              moduleId: "session_vault",
              version: "1.5.0",
              artifactPath: "/tmp/sv.js",
              checksum: "abc",
              installedAt: "2026-06-15T00:00:00.000Z",
            },
          ],
        },
        runTerminalRenderer: async (app) => {
          renderedApp = app;
          return 0;
        },
      },
    );

    // session_vault with running service, no update: actions are ["stop", "view-details"]
    renderedApp!.moveAction(1);
    await renderedApp!.activate();

    expect(renderedApp!.state().screen).toBe("details");
    expect(renderedApp!.detailsModel()?.installedVersion).toBe("1.5.0");
    expect(renderedApp!.detailsModel()?.isBundledCore).toBe(true);
  });

  test("session_vault uninstall is always disabled (no lifecycle handler needed)", async () => {
    const { runFortressTui } = await import("../src/tui");

    let renderedApp: ReturnType<typeof createTuiApp> | undefined;

    await runFortressTui(
      {},
      {
        serviceStateReader: { state: async () => ({ loaded: true, pid: 1234 }) },
        statusReader: { read: async () => null },
        runTerminalRenderer: async (app) => {
          renderedApp = app;
          return 0;
        },
      },
    );

    // session_vault: actions are ["stop", "view-details"] (pid:1234, no update)
    renderedApp!.moveAction(1);
    await renderedApp!.activate();

    expect(renderedApp!.state().screen).toBe("details");
    expect(renderedApp!.detailsModel()?.isBundledCore).toBe(true);
    expect(renderedApp!.detailsModel()?.actions[0]).toMatchObject({ kind: "uninstall", enabled: false });
  });
});
