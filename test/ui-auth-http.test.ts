import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SETUP_TOKEN_HEADER } from "../src/ui/auth-routes";
import { UiRuntime } from "../src/ui/runtime";
import { SESSION_HEADER } from "../src/ui/sessions";
import { startUiServer } from "../src/ui/server";
import { INSTANCE_PROBE_IDENTITY } from "../src/ui/routes";
import type { UiAssets } from "../src/ui/assets";

const PASSWORD = "correct-horse-battery";

let root: string;
let runtime: UiRuntime;
let server: ReturnType<typeof startUiServer>;
let origin: string;

const assets: UiAssets = {
  mode: "disk",
  files: { "/index.html": path.join(import.meta.dir, "..", "package.json") },
  inlineScriptHashes: [],
  manifest: { hash: "b".repeat(64), files: 1, bytes: 1 },
};

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hx-ui-http-"));
  runtime = new UiRuntime({
    uiRoot: root,
    uiConfigFile: path.join(root, "ui.json"),
    cmdCredsDir: path.join(root, "cmd-creds"),
    env: {},
  });
  runtime.routes.register({ method: "GET", path: "/ui/api/overview", cls: "read" });
  runtime.routes.register({ method: "POST", path: "/ui/api/service/restart", cls: "mutate" });
  server = startUiServer({ assets, port: 0, runtime }, "127.0.0.1");
  origin = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.stop(true);
  await rm(root, { recursive: true, force: true });
});

async function createUser(login: string, role: "operator" | "readonly"): Promise<string> {
  const created = await runtime.users.create(login, role);
  return created.token;
}

async function signIn(login: string, password: string): Promise<Response> {
  return fetch(`${origin}/ui/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ login, password }),
  });
}

describe("the console's authentication surface", () => {
  test("a setup link completes once, over POST, and then signs in", async () => {
    const token = await createUser("ada", "operator");

    const status = await fetch(`${origin}/ui/api/setup/status`, {
      headers: { [SETUP_TOKEN_HEADER]: token },
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ status: "live", login: "ada" });

    const completed = await fetch(`${origin}/ui/api/setup/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, [SETUP_TOKEN_HEADER]: token },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(completed.status).toBe(200);

    // The link is spent — a second completion, and the status probe, are dead.
    const again = await fetch(`${origin}/ui/api/setup/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, [SETUP_TOKEN_HEADER]: token },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(again.status).toBe(400);
    expect((await fetch(`${origin}/ui/api/setup/status`, { headers: { [SETUP_TOKEN_HEADER]: token } })).status).toBe(404);

    const signedIn = await signIn("ada", PASSWORD);
    expect(signedIn.status).toBe(200);
    expect((await signedIn.json()).role).toBe("operator");
  });

  test("a GET never consumes a setup link", async () => {
    const token = await createUser("ada", "operator");
    await fetch(`${origin}/ui/api/setup/status`, { headers: { [SETUP_TOKEN_HEADER]: token } });
    await fetch(`${origin}/ui/api/setup/status`, { headers: { [SETUP_TOKEN_HEADER]: token } });
    const completed = await fetch(`${origin}/ui/api/setup/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, [SETUP_TOKEN_HEADER]: token },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(completed.status).toBe(200);
  });

  test("the password policy is enforced at the edge", async () => {
    const token = await createUser("ada", "operator");
    const refused = await fetch(`${origin}/ui/api/setup/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, [SETUP_TOKEN_HEADER]: token },
      body: JSON.stringify({ password: "short" }),
    });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toContain("at least");
  });

  test("every failed sign-in answers identically, and points at the remedy", async () => {
    const token = await createUser("ada", "operator");
    await runtime.users.completeSetup(token, PASSWORD);
    await createUser("eve", "readonly");
    await runtime.users.disable("eve");

    const bodies = [];
    for (const [login, password] of [
      ["ada", "wrong-password-here"],
      ["eve", PASSWORD],
      ["nobody-at-all", PASSWORD],
    ]) {
      const response = await signIn(login as string, password as string);
      expect(response.status).toBe(401);
      bodies.push(await response.json());
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0].recovery).toContain("ui user reset");
  });

  test("one address cannot deny sign-in to everybody behind a proxy", async () => {
    // The gate spends its bucket BEFORE the body is read, so it can only key on
    // the address — and behind a proxy (the shape this console ships for:
    // publicUrl set, trustedProxies empty) every caller shares one. A five-per-
    // minute take there was the whole organization's budget: five requests from
    // anywhere denied sign-in to every operator, which is the org-wide lockout
    // the rate limiter's first rule forbids.
    const token = await createUser("ada", "operator");
    await runtime.users.completeSetup(token, PASSWORD);
    for (let i = 0; i < 20; i += 1) {
      const refused = await signIn(`stranger-${i}`, "wrong-password-here");
      expect(refused.status).toBe(401);
    }
    const genuine = await signIn("ada", PASSWORD);
    expect(genuine.status).toBe(200);
  });

  test("a session reaches read routes, and a readonly one is refused a mutate", async () => {
    const token = await createUser("ada", "readonly");
    await runtime.users.completeSetup(token, PASSWORD);
    const session = (await (await signIn("ada", PASSWORD)).json()).token as string;

    const read = await fetch(`${origin}/ui/api/overview`, { headers: { [SESSION_HEADER]: session } });
    // The gate allowed it; no handler is registered, so the shell answers — what
    // matters is that it was not a 401 or a 403.
    expect([200, 404]).toContain(read.status);

    const mutate = await fetch(`${origin}/ui/api/service/restart`, {
      method: "POST",
      headers: { [SESSION_HEADER]: session, origin },
    });
    expect(mutate.status).toBe(403);
  });

  test("disabling the account ends its session on the very next request", async () => {
    const token = await createUser("ada", "operator");
    await runtime.users.completeSetup(token, PASSWORD);
    const session = (await (await signIn("ada", PASSWORD)).json()).token as string;
    expect((await fetch(`${origin}/ui/api/session`, { headers: { [SESSION_HEADER]: session } })).status).toBe(200);

    await runtime.users.disable("ada");
    expect((await fetch(`${origin}/ui/api/session`, { headers: { [SESSION_HEADER]: session } })).status).toBe(401);
  });

  test("logout revokes, and an unknown path answers 401 exactly as a real one does", async () => {
    const token = await createUser("ada", "operator");
    await runtime.users.completeSetup(token, PASSWORD);
    const session = (await (await signIn("ada", PASSWORD)).json()).token as string;

    const out = await fetch(`${origin}/ui/api/session`, {
      method: "DELETE",
      headers: { [SESSION_HEADER]: session, origin },
    });
    expect(out.status).toBe(200);
    expect((await fetch(`${origin}/ui/api/session`, { headers: { [SESSION_HEADER]: session } })).status).toBe(401);

    const real = await fetch(`${origin}/ui/api/overview`);
    const invented = await fetch(`${origin}/ui/api/no-such-endpoint`);
    expect(real.status).toBe(401);
    expect(invented.status).toBe(401);
    expect(await real.text()).toBe(await invented.text());
  });

  test("a cross-site sign-in POST is refused before any hashing happens", async () => {
    const token = await createUser("ada", "operator");
    await runtime.users.completeSetup(token, PASSWORD);
    const hostile: Array<Record<string, string>> = [
      { "content-type": "application/json" },
      { "content-type": "application/json", origin: "null" },
      { "content-type": "application/json", origin: "https://evil.example.com" },
    ];
    for (const headers of hostile) {
      const response = await fetch(`${origin}/ui/api/session`, {
        method: "POST",
        headers,
        body: JSON.stringify({ login: "ada", password: PASSWORD }),
      });
      expect(response.status).toBe(403);
    }
  });

  test("the session token appears in the minting response and nowhere else", async () => {
    const token = await createUser("ada", "operator");
    await runtime.users.completeSetup(token, PASSWORD);
    const minted = await signIn("ada", PASSWORD);
    const session = (await minted.json()).token as string;
    expect(minted.headers.get("location")).toBeNull();
    expect(minted.headers.get("set-cookie")).toBeNull();

    const whoami = await fetch(`${origin}/ui/api/session`, { headers: { [SESSION_HEADER]: session } });
    expect(await whoami.text()).not.toContain(session);
  });

  test("the health probe and the identity handshake answer without a session", async () => {
    expect((await fetch(`${origin}/healthz`)).status).toBe(200);
    const probe = await fetch(`${origin}/ui/api/instance`);
    expect(await probe.json()).toEqual(INSTANCE_PROBE_IDENTITY);
  });

  test("the marker renders to a token-bearing arrival, never on a plain sign-in", async () => {
    await runtime.users.create("ada", "operator");
    const token = await createUser("bob", "operator");
    const { UiConfigStore } = await import("../src/ui/config");
    await new UiConfigStore(path.join(root, "ui.json")).update((c) => ({ ...c, marker: "Ada's fortress" }));

    const status = await fetch(`${origin}/ui/api/setup/status`, {
      headers: { [SETUP_TOKEN_HEADER]: token },
    });
    expect((await status.json()).marker).toBe("Ada's fortress");

    const failed = await signIn("ada", "not-the-password");
    expect(await failed.text()).not.toContain("Ada's fortress");
  });
});
