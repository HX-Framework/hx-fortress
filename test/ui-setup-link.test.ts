// The token of a one-time link that sets a password is kept for the setup page
// alone. Before, it outlived the page in its tab: open a link, go to the
// console, sign in as somebody else, sign out, type /setup, and the page
// offered to set the first account's password.

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { forgetSetupLink, keepSetupLink, keptSetupLink, settleSetupLink } from "../ui/src/lib/setup-link";

/** A tab's sessionStorage. */
function fakeStorage(): Map<string, string> {
  const held = new Map<string, string>();
  (globalThis as { sessionStorage?: unknown }).sessionStorage = {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
    removeItem: (key: string) => void held.delete(key),
  };
  return held;
}

afterEach(() => {
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
});

describe("the kept link", () => {
  test("is kept, read back, and forgotten", () => {
    const held = fakeStorage();
    keepSetupLink("a-link-token");
    expect(keptSetupLink()).toBe("a-link-token");
    forgetSetupLink();
    expect(keptSetupLink()).toBeNull();
    expect(held.size).toBe(0);
  });

  test("stays while the tab is on the setup page, and goes on any other page", () => {
    fakeStorage();
    keepSetupLink("a-link-token");
    settleSetupLink(true);
    expect(keptSetupLink()).toBe("a-link-token");
    settleSetupLink(false);
    expect(keptSetupLink()).toBeNull();
  });

  test("a tab whose storage is refused keeps nothing and breaks nothing", () => {
    (globalThis as { sessionStorage?: unknown }).sessionStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => keepSetupLink("a-link-token")).not.toThrow();
    expect(keptSetupLink()).toBeNull();
    expect(() => forgetSetupLink()).not.toThrow();
  });
});

describe("where the console lets go of it", () => {
  // The console's state is a React provider with no DOM here, so what it calls
  // is read from its source: every sign-in, every sign-out and dropped session,
  // and every page other than the setup page.
  const state = readFileSync(path.join(import.meta.dir, "..", "ui", "src", "state.tsx"), "utf8");
  /** The body of one `useCallback` in the provider, up to its list of deps. */
  const body = (name: string): string => {
    const start = state.indexOf(`const ${name} = useCallback(`);
    expect([name, start >= 0]).toEqual([name, true]);
    return state.slice(start, state.indexOf("}, [", start));
  };

  test("on a sign-in, with a password, a code or the identity provider", () => {
    expect(body("adoptSession")).toContain("forgetSetupLink()");
    expect(body("signInWithProvider")).toContain("forgetSetupLink()");
    expect(body("finishSecondStep")).toContain("forgetSetupLink()");
  });

  test("on a sign-out and a dropped session", () => {
    expect(body("forgetSession")).toContain("forgetSetupLink()");
    // A refused request and a failed resume both end here.
    expect(state).toContain("setUnauthorizedHandler(() => forgetSession())");
  });

  test("on every page other than the setup page", () => {
    expect(state).toContain('settleSetupLink(route.view === "setup")');
  });

  test("the setup page keeps it only through the module", () => {
    const page = readFileSync(
      path.join(import.meta.dir, "..", "ui", "src", "views", "setup", "AccountPassword.tsx"),
      "utf8",
    );
    expect(page).not.toMatch(/sessionStorage\.(getItem|setItem|removeItem)/);
    expect(page).toContain("keepSetupLink(arrived)");
  });
});
