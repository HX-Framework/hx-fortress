// The exit-for-supervisor-restart heuristic: overrides win, a TTY vetoes the
// env detection (desktop shells leak INVOCATION_ID / XPC_SERVICE_NAME), and
// any of the three supervisor markers enables it for a daemonized process.
import { describe, expect, it } from "bun:test";
import { supervisedRestartAvailable } from "./store.js";

describe("supervisedRestartAvailable", () => {
  it("explicit override wins in both directions, in several spellings", () => {
    expect(supervisedRestartAvailable({ FORTRESS_STORE_EXIT_ON_WEDGE: "on" }, true)).toBe(true);
    expect(supervisedRestartAvailable({ FORTRESS_STORE_EXIT_ON_WEDGE: "TRUE" }, true)).toBe(true);
    expect(supervisedRestartAvailable({ FORTRESS_STORE_EXIT_ON_WEDGE: "1" }, true)).toBe(true);
    expect(
      supervisedRestartAvailable({ FORTRESS_STORE_EXIT_ON_WEDGE: "off", RAILWAY_ENVIRONMENT: "production" }, false),
    ).toBe(false);
    expect(supervisedRestartAvailable({ FORTRESS_STORE_EXIT_ON_WEDGE: "0", INVOCATION_ID: "x" }, false)).toBe(false);
  });

  it("a TTY vetoes the env heuristic (manual terminal runs are unsupervised)", () => {
    expect(supervisedRestartAvailable({ INVOCATION_ID: "leaked-from-gnome-terminal" }, true)).toBe(false);
    expect(supervisedRestartAvailable({ XPC_SERVICE_NAME: "application.com.apple.Terminal" }, true)).toBe(false);
  });

  it("daemonized processes with a supervisor marker are supervised", () => {
    expect(supervisedRestartAvailable({ INVOCATION_ID: "abc" }, false)).toBe(true);
    expect(supervisedRestartAvailable({ XPC_SERVICE_NAME: "ai.let.hx-fortress" }, false)).toBe(true);
    expect(supervisedRestartAvailable({ RAILWAY_ENVIRONMENT: "production" }, false)).toBe(true);
    expect(supervisedRestartAvailable({ INVOCATION_ID: "" , RAILWAY_ENVIRONMENT: "production" }, false)).toBe(true);
    expect(supervisedRestartAvailable({}, false)).toBe(false);
  });
});
