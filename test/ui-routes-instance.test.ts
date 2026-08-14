import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  acquireInstanceLock,
  holderAlive,
  machineBootId,
  MOVE_REMEDIATION,
  parseInstanceLock,
  portCollisionMessage,
  probeOccupant,
  processStartToken,
  readInstanceLock,
  sameRoot,
} from "../src/ui/instance";
import { UiConfigStore } from "../src/ui/config";
import { UiRuntime } from "../src/ui/runtime";
import {
  gate,
  INSTANCE_PROBE_IDENTITY,
  PUBLIC_ROUTES,
  requiresOrigin,
  RouteRegistry,
} from "../src/ui/routes";
import { handleUiRequest, INSTANCE_PROBE_PATH, isLoopbackPeer } from "../src/ui/server";
import { SESSION_HEADER } from "../src/ui/sessions";
import type { UiAssets } from "../src/ui/assets";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hx-ui-routes-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the route walk", () => {
  test("the public set is exactly this list", () => {
    expect(new RouteRegistry().publicPaths()).toEqual([
      "GET /*",
      "GET /assets/*",
      "GET /fonts/*",
      "GET /healthz",
      "GET /ui/api/instance",
      "GET /ui/api/setup/status",
      "POST /ui/api/session",
      "POST /ui/api/setup/complete",
      "POST /ui/api/sso/exchange",
    ]);
  });

  test("only the public AUTH routes are spool-audited", () => {
    const audited = PUBLIC_ROUTES.filter((r) => r.audited).map((r) => r.path);
    expect(audited.sort()).toEqual([
      "/ui/api/session",
      "/ui/api/setup/complete",
      "/ui/api/setup/status",
      "/ui/api/sso/exchange",
    ]);
    for (const path of ["/", "/assets/", "/fonts/", "/healthz", INSTANCE_PROBE_PATH]) {
      expect(PUBLIC_ROUTES.find((r) => r.path === path)?.audited).toBe(false);
    }
  });

  test("every public route states a bucket, except the health probe", () => {
    for (const route of PUBLIC_ROUTES) {
      if (route.path === "/healthz") expect(route.bucket).toBeUndefined();
      else expect(route.bucket).toBeDefined();
    }
  });

  test("a specific route beats the shell prefix", () => {
    const registry = new RouteRegistry();
    expect(registry.lookup("POST", "/ui/api/session")?.cls).toBe("public");
    expect(registry.lookup("GET", "/sessions/123")?.path).toBe("/");
    expect(registry.lookup("GET", "/assets/app-abc.js")?.path).toBe("/assets/");
  });
});

describe("the gate", () => {
  const registry = new RouteRegistry();
  registry.register({ method: "GET", path: "/ui/api/overview", cls: "read" });
  registry.register({ method: "POST", path: "/ui/api/service/restart", cls: "mutate" });
  registry.register({ method: "GET", path: "/ui/api/audit/export", cls: "read-audited" });

  test("public routes need no session", () => {
    expect(gate({ method: "POST", path: "/ui/api/session", route: registry.lookup("POST", "/ui/api/session"), role: null }).allow).toBe(true);
  });

  test("an unknown path answers 401 exactly as a real one does", () => {
    const known = gate({ method: "GET", path: "/ui/api/overview", route: registry.lookup("GET", "/ui/api/overview"), role: null });
    const unknown = gate({ method: "GET", path: "/ui/api/there-is-no-such-thing", route: null, role: null });
    expect(known).toEqual({ allow: false, status: 401, reason: "sign in to continue" });
    expect(unknown).toEqual({ allow: false, status: 401, reason: "sign in to continue" });
  });

  test("readonly reaches every read route and no mutate route", () => {
    for (const path of ["/ui/api/overview", "/ui/api/audit/export"]) {
      expect(gate({ method: "GET", path, route: registry.lookup("GET", path), role: "readonly" }).allow).toBe(true);
    }
    const refused = gate({
      method: "POST",
      path: "/ui/api/service/restart",
      route: registry.lookup("POST", "/ui/api/service/restart"),
      role: "readonly",
    });
    expect(refused).toEqual({ allow: false, status: 403, reason: "this account is read-only; ask an administrator for an operator login" });
  });

  test("an unclassified route is mutate, so it is operator-only rather than open", () => {
    expect(gate({ method: "POST", path: "/ui/api/brand-new", route: null, role: "readonly" }).allow).toBe(false);
    expect(gate({ method: "POST", path: "/ui/api/brand-new", route: null, role: "operator" }).allow).toBe(true);
  });

  test("writes carry an Origin check; reads and the exempt probes do not", () => {
    expect(requiresOrigin(registry.lookup("POST", "/ui/api/service/restart"), "POST")).toBe(true);
    expect(requiresOrigin(registry.lookup("GET", "/ui/api/overview"), "GET")).toBe(false);
    expect(requiresOrigin(registry.lookup("GET", INSTANCE_PROBE_PATH), "GET")).toBe(false);
    expect(requiresOrigin(registry.lookup("GET", "/healthz"), "GET")).toBe(false);
  });
});

describe("the gate, end to end through the runtime", () => {
  function runtimeOn(uiRoot: string): UiRuntime {
    return new UiRuntime({
      uiRoot,
      uiConfigFile: path.join(uiRoot, "ui.json"),
      cmdCredsDir: path.join(uiRoot, "cmd-creds"),
      env: {},
    });
  }

  function get(pathname: string, headers: Record<string, string> = {}): Request {
    return new Request(`http://127.0.0.1:8788${pathname}`, { headers: { host: "127.0.0.1:8788", ...headers } });
  }

  test("an unauthenticated read is 401 and never reveals the path", async () => {
    const runtime = runtimeOn(root);
    runtime.routes.register({ method: "GET", path: "/ui/api/overview", cls: "read" });
    const verdict = await runtime.authorize(get("/ui/api/overview"), "127.0.0.1", 8788);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.status).toBe(401);
  });

  test("a signed-in operator passes, a cross-site POST does not", async () => {
    const runtime = runtimeOn(root);
    runtime.routes.register({ method: "POST", path: "/ui/api/service/restart", cls: "mutate" });
    const created = await runtime.users.create("ada", "operator");
    await runtime.users.completeSetup(created.token, "correct-horse-battery");
    const signedIn = await runtime.signIn({ login: "ada", password: "correct-horse-battery", remoteKey: "k", remoteAddr: "k" });
    if (!signedIn.ok) throw new Error("sign-in failed");

    const post = (headers: Record<string, string>): Request =>
      new Request("http://127.0.0.1:8788/ui/api/service/restart", {
        method: "POST",
        headers: { host: "127.0.0.1:8788", [SESSION_HEADER]: signedIn.token, ...headers },
      });

    expect((await runtime.authorize(post({ origin: "http://127.0.0.1:8788" }), "127.0.0.1", 8788)).ok).toBe(true);
    const hostile: Array<Record<string, string>> = [{}, { origin: "null" }, { origin: "https://evil.example.com" }];
    for (const headers of hostile) {
      const verdict = await runtime.authorize(post(headers), "127.0.0.1", 8788);
      expect(verdict.ok).toBe(false);
      expect(verdict.ok === false && verdict.status).toBe(403);
    }
  });

  test("the probe refuses a non-loopback peer with the same 404 a stranger gets", async () => {
    const runtime = runtimeOn(root);
    expect((await runtime.authorize(get(INSTANCE_PROBE_PATH), "127.0.0.1", 8788)).ok).toBe(true);
    const remote = await runtime.authorize(get(INSTANCE_PROBE_PATH), "203.0.113.9", 8788);
    expect(remote.ok).toBe(false);
    expect(remote.ok === false && remote.status).toBe(404);
  });

  test("a publicUrl written while the runtime is live is honored on the NEXT request", async () => {
    const runtime = runtimeOn(root);
    runtime.routes.register({ method: "GET", path: "/ui/api/overview", cls: "read" });
    const external = new Request("http://127.0.0.1:8788/ui/api/overview", {
      headers: { host: "console.example.com" },
    });
    expect(runtime.hostCheck(external, await runtime.readConfig(), 8788).ok).toBe(false);

    await new UiConfigStore(path.join(root, "ui.json")).update((c) => ({
      ...c,
      publicUrl: "https://console.example.com",
    }));
    expect(runtime.hostCheck(external, await runtime.readConfig(), 8788).ok).toBe(true);
  });

  test("a config write concurrent with a burst of requests yields no spurious refusal", async () => {
    const runtime = runtimeOn(root);
    runtime.routes.register({ method: "GET", path: "/ui/api/overview", cls: "read" });
    const store = new UiConfigStore(path.join(root, "ui.json"));
    await store.update((c) => ({ ...c, publicUrl: "https://console.example.com" }));
    const writes = (async (): Promise<void> => {
      for (let i = 0; i < 20; i += 1) {
        await store.update((c) => ({ ...c, port: 8788 + (i % 3) }));
      }
    })();
    const reads = Array.from({ length: 2_000 }, () =>
      runtime.authorize(get("/ui/api/overview"), "127.0.0.1", 8788),
    );
    const verdicts = await Promise.all(reads);
    await writes;
    // Every one is 401 (no session) — never a 403 from a torn Host allowlist,
    // and the runtime never resolved the config to "absent".
    expect(verdicts.every((v) => v.ok === false && v.status === 401)).toBe(true);
  });
});

describe("the instance handshake", () => {
  const assets: UiAssets = {
    mode: "embedded",
    files: { "/index.html": path.join(import.meta.dir, "..", "package.json") },
    inlineScriptHashes: [],
    manifest: { hash: "a".repeat(64), files: 1, bytes: 1 },
  };

  test("answers a loopback peer with the bare identity and nothing else", async () => {
    const response = handleUiRequest(
      new Request(`http://127.0.0.1:8788${INSTANCE_PROBE_PATH}`),
      { assets, port: 8788 },
      "127.0.0.1",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(INSTANCE_PROBE_IDENTITY);
  });

  test("refuses a remote peer, and an unknown peer, with 404", () => {
    for (const peer of ["203.0.113.9", undefined]) {
      const response = handleUiRequest(
        new Request(`http://127.0.0.1:8788${INSTANCE_PROBE_PATH}`),
        { assets, port: 8788 },
        peer,
      );
      expect(response.status).toBe(404);
    }
    expect(isLoopbackPeer("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackPeer("10.0.0.1")).toBe(false);
  });

  test("an unknown occupant is named as such, with the same remediation", () => {
    expect(portCollisionMessage(8788, "console")).toContain("a different fortress root");
    expect(portCollisionMessage(8788, "unknown")).toContain("another process is listening on 8788");
    expect(portCollisionMessage(8788, "unknown")).toContain("do not use the printed URL");
    for (const occupant of ["console", "unknown", "none"] as const) {
      expect(portCollisionMessage(8788, occupant)).toContain(MOVE_REMEDIATION);
    }
  });

  test("probeOccupant reports what answered", async () => {
    const answering = async (body: unknown): Promise<Response> =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    expect(await probeOccupant("http://127.0.0.1:8788", async () => answering(INSTANCE_PROBE_IDENTITY))).toBe("console");
    expect(await probeOccupant("http://127.0.0.1:8788", async () => answering({ app: "grafana" }))).toBe("unknown");
    expect(await probeOccupant("http://127.0.0.1:8788", async () => new Response("nope", { status: 404 }))).toBe("unknown");
    expect(
      await probeOccupant("http://127.0.0.1:8788", () => Promise.reject(new Error("ECONNREFUSED"))),
    ).toBe("none");
  });
});

describe("the single-instance lock", () => {
  test("records the pinned fields at acquisition", async () => {
    const file = path.join(root, "ui", "instance.lock");
    const held = await acquireInstanceLock(file, 8788);
    expect(held.ok).toBe(true);
    const record = await readInstanceLock(file);
    expect(record?.pid).toBe(process.pid);
    expect(record?.port).toBe(8788);
    expect(record?.bootId).toBe(machineBootId());
    expect(record?.startTicks ?? record?.startTime).toBeDefined();
    if (held.ok) await held.release();
  });

  test("a second instance on the same root refuses REGARDLESS of port", async () => {
    const file = path.join(root, "ui", "instance.lock");
    const first = await acquireInstanceLock(file, 8788);
    const second = await acquireInstanceLock(file, 9999);
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.message).toContain("already running on this fortress root");
    expect(second.ok === false && second.holder?.pid).toBe(process.pid);
    if (first.ok) await first.release();
  });

  test("a lock left by a dead process is reclaimed", async () => {
    const file = path.join(root, "ui", "instance.lock");
    const dead = { pid: 999_999, bootId: machineBootId(), startTicks: 1, port: 8788 };
    await Bun.write(file, `${JSON.stringify(dead)}\n`);
    expect(holderAlive(dead)).toBe(false);
    const taken = await acquireInstanceLock(file, 8788);
    expect(taken.ok).toBe(true);
    if (taken.ok) await taken.release();
  });

  test("a lock from a previous boot is dead by definition", () => {
    expect(holderAlive({ pid: process.pid, bootId: "a-different-boot", port: 8788 })).toBe(false);
  });

  test("a recycled pid within one boot is not the holder", () => {
    const mine = processStartToken(process.pid);
    if (mine.startTicks === undefined) return; // no /proc on this platform
    expect(holderAlive({ pid: process.pid, bootId: machineBootId(), startTicks: mine.startTicks, port: 8788 })).toBe(true);
    expect(holderAlive({ pid: process.pid, bootId: machineBootId(), startTicks: mine.startTicks + 1, port: 8788 })).toBe(false);
  });

  test("an unreadable lock is not a permanent refusal", async () => {
    const file = path.join(root, "ui", "instance.lock");
    await Bun.write(file, "not json");
    expect(parseInstanceLock("not json")).toBeNull();
    const taken = await acquireInstanceLock(file, 8788);
    expect(taken.ok).toBe(true);
    if (taken.ok) await taken.release();
  });

  test("roots are compared by file identity, not by spelling", async () => {
    await writeFile(path.join(root, "marker"), "");
    expect(await sameRoot(root, `${root}/`)).toBe(true);
    expect(await sameRoot(root, path.join(root, "marker"))).toBe(false);
    expect(await sameRoot(root, path.join(root, "absent"))).toBe(false);
  });

  test("the lock file holds no secret", async () => {
    const file = path.join(root, "ui", "instance.lock");
    const held = await acquireInstanceLock(file, 8788);
    expect(await readFile(file, "utf8")).not.toMatch(/token|password|secret/i);
    if (held.ok) await held.release();
  });
});
