import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { sanitizeParams } from "../../src/console/audit-actions";
import {
  createModuleState,
  DeferredSecrets,
  MODULE_STATE_MAX_BYTES,
} from "../../src/host/module-context";
import {
  AskFailure,
  egressAllows,
  EgressRefused,
  failureCode,
  failureForLog,
  manifestDefect,
  SecretNotDeclared,
  type ModuleManifest,
} from "../../src/host/module-contract";
import { SecretMissing, SecretUnavailable, type SecretProvider } from "../../src/secrets/types";
import { S } from "../../src/host/shape";
import {
  ask,
  createProbeModule,
  makeRig,
  PROBE_MANIFEST,
  SECRET_VALUE,
  spoolRecords,
  spoolText,
  tempRoot,
  type Rig,
} from "./_module-rig";

let rig: Rig;
afterEach(async () => {
  await rig?.cleanup();
});

/** The context the module was last handed. */
async function contextOf(r: Rig) {
  await ask(r, "probe", "context.probe");
  const context = r.probe.context;
  if (!context) throw new Error("the module was never called");
  return context;
}

describe("a module's secrets", () => {
  test("a declared name is read from the customer's store", async () => {
    rig = await makeRig();
    const ctx = await contextOf(rig);
    expect(ctx.secrets.kind).toBe("file");
    expect(await ctx.secrets.has("probe-token")).toBe(true);
    expect(await ctx.secrets.get("probe-token")).toBe(SECRET_VALUE);
  });

  test("a name the manifest does not list is refused, and recorded", async () => {
    rig = await makeRig();
    const ctx = await contextOf(rig);
    await expect(ctx.secrets.get("database-url")).rejects.toBeInstanceOf(SecretNotDeclared);
    await expect(ctx.secrets.has("database-url")).rejects.toBeInstanceOf(SecretNotDeclared);
    // The message lists what the manifest declares and never what was passed:
    // a value handed over by mistake often looks exactly like a name.
    const error = (await ctx.secrets.get(SECRET_VALUE).catch((e: unknown) => e)) as Error;
    expect(error.message).toBe(
      "module probe asked for a secret its manifest does not list. It lists: probe-token.",
    );
    expect(error.message).not.toContain(SECRET_VALUE);
    await rig.host.audit.flush();
    const refused = (await spoolRecords(rig.paths)).filter((r) => r.action === "system.module.refused");
    expect(refused[0]?.params).toEqual({ module: "probe", rule: "secret_not_declared" });
    // Collapsed, and the value never reaches the trail.
    expect(refused).toHaveLength(2);
    expect(await spoolText(rig.paths)).not.toContain(SECRET_VALUE);
  });

  test("the store is built on first use, and a setting that was wrong is read again", async () => {
    let builds = 0;
    let broken = true;
    const store: SecretProvider = { kind: "file", get: async () => "v", has: async () => true };
    const deferred = new DeferredSecrets(async () => {
      builds += 1;
      if (broken) throw new Error("Invalid secrets config: provider must be one of env, file");
      return store;
    });
    expect(builds).toBe(0);
    // Not known yet: the kind a fortress has when nothing is set.
    expect(deferred.kind).toBe("env");
    await expect(deferred.get("probe-token")).rejects.toThrow(/Invalid secrets config/);
    await expect(deferred.store()).rejects.toThrow(/Invalid secrets config/);
    expect(deferred.kind).toBe("env");
    broken = false;
    expect(await deferred.get("probe-token")).toBe("v");
    expect(await deferred.has("probe-token")).toBe(true);
    expect(deferred.kind).toBe("file");
  });

  test("a failure of a port has its own word, and a message this host wrote", () => {
    expect(failureCode(new SecretMissing("probe-token"))).toBe("secret_missing");
    expect(failureCode(new SecretUnavailable("probe-token", "the store returned 503"))).toBe("secret_unavailable");
    expect(failureCode(new SecretNotDeclared("probe", ["probe-token"]))).toBe("secret_not_declared");
    expect(failureCode(new EgressRefused("probe", "egress_not_declared"))).toBe("egress_not_declared");
    expect(failureCode(new AskFailure("store_unreachable"))).toBe("store_unreachable");
    expect(failureCode(new AskFailure("Not A Code!"))).toBe("internal");
    expect(failureCode(new Error("anything"))).toBe("internal");
    expect(failureCode("a string")).toBe("internal");

    expect(failureForLog(new SecretMissing("probe-token"))).toEqual({
      code: "secret_missing",
      error: 'secret "probe-token" is not set',
    });
    // Anything else: its kind and where it was thrown, never what it said.
    const logged = failureForLog(Object.assign(new TypeError(`cannot read ${SECRET_VALUE}`), { code: "ERR_X" }));
    expect(logged).toMatchObject({ code: "internal", kind: "TypeError", errno: "ERR_X" });
    expect(logged.where).toMatch(/^at /);
    expect(JSON.stringify(logged)).not.toContain(SECRET_VALUE);
    expect(failureForLog({ message: SECRET_VALUE })).toEqual({ code: "internal", kind: "object" });
  });
});

describe("a module's way out", () => {
  test("a declared host is called over https, with redirects off", async () => {
    const calls: { url: string; redirect?: RequestRedirect }[] = [];
    rig = await makeRig({
      deps: {
        fetchImpl: (async (input: string | URL, init?: RequestInit) => {
          calls.push({ url: String(input), redirect: init?.redirect });
          return new Response("ok");
        }) as unknown as typeof fetch,
      },
    });
    const ctx = await contextOf(rig);
    await ctx.fetch("https://api.example.com/v4/accounts");
    await ctx.fetch("https://eu-7.stores.example.net/status", { method: "POST", redirect: "follow" });
    await ctx.fetch("https://api.example.com/x", { redirect: "manual" });
    expect(calls).toEqual([
      { url: "https://api.example.com/v4/accounts", redirect: "error" },
      { url: "https://eu-7.stores.example.net/status", redirect: "error" },
      { url: "https://api.example.com/x", redirect: "manual" },
    ]);
  });

  test.each([
    ["https://evil.example/collect", "egress_not_declared"],
    ["https://api.example.com.evil.example/", "egress_not_declared"],
    ["https://stores.example.net/", "egress_not_declared"],
    ["http://api.example.com/v4", "egress_not_https"],
    ["https://user:pw@api.example.com/", "egress_malformed"],
    ["not a url", "egress_malformed"],
    ["https://169.254.169.254/", "egress_not_declared"],
  ])("%s is refused as %s and never dialed", async (url, rule) => {
    let dialed = 0;
    rig = await makeRig({
      deps: {
        fetchImpl: (async () => {
          dialed += 1;
          return new Response("ok");
        }) as unknown as typeof fetch,
      },
    });
    const ctx = await contextOf(rig);
    const error = await ctx.fetch(url).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EgressRefused);
    expect((error as EgressRefused).rule as string).toBe(rule);
    expect(dialed).toBe(0);
    await rig.host.audit.flush();
    const refused = (await spoolRecords(rig.paths)).filter((r) => r.action === "system.module.refused");
    expect(refused[0]?.params).toEqual({ module: "probe", rule });
  });

  test("only the method, the headers, the body and the signal of a call are passed on", async () => {
    const seen: Record<string, unknown>[] = [];
    rig = await makeRig({
      deps: {
        fetchImpl: (async (_input: string | URL, init?: RequestInit) => {
          seen.push({ ...(init as Record<string, unknown>) });
          return new Response("ok");
        }) as unknown as typeof fetch,
      },
    });
    const ctx = await contextOf(rig);
    const signal = new AbortController().signal;
    // What the runtime's own fetch would take: each is a way to send the
    // request somewhere the manifest check never saw, or to switch a check off.
    const init = {
      method: "POST",
      headers: { "x-a": "1" },
      body: "payload",
      signal,
      proxy: "http://10.0.0.5:3128",
      unix: "/var/run/docker.sock",
      tls: { rejectUnauthorized: false },
      verbose: true,
    } as RequestInit;
    await ctx.fetch("https://api.example.com/x", init);
    expect(seen).toEqual([
      { method: "POST", headers: { "x-a": "1" }, body: "payload", signal, redirect: "error" },
    ]);
  });

  test("a declared name is not taken for an address because of how it starts", async () => {
    const manifest = { ...PROBE_MANIFEST, egress: ["fcm.example.com", "fd-api.example.com"] };
    let dialed = 0;
    rig = await makeRig({
      probe: createProbeModule(manifest),
      deps: {
        catalog: [
          { id: "session_vault", title: "Sessions", summary: "transcripts", manifest: null, startOnly: true },
          { id: "probe", title: "Probe", summary: "a module for tests", manifest, startOnly: false },
        ],
        fetchImpl: (async () => {
          dialed += 1;
          return new Response("ok");
        }) as unknown as typeof fetch,
      },
    });
    const ctx = await contextOf(rig);
    await ctx.fetch("https://fcm.example.com/send");
    await ctx.fetch("https://fd-api.example.com/v1");
    expect(dialed).toBe(2);
  });

  test("a wildcard covers hosts under it and nothing beside it", () => {
    const egress = ["api.example.com", "*.stores.example.net"];
    expect(egressAllows(egress, "api.example.com")).toBe(true);
    expect(egressAllows(egress, "API.Example.com.")).toBe(true);
    expect(egressAllows(egress, "a.stores.example.net")).toBe(true);
    expect(egressAllows(egress, "a.b.stores.example.net")).toBe(true);
    expect(egressAllows(egress, "stores.example.net")).toBe(false);
    expect(egressAllows(egress, "evilstores.example.net")).toBe(false);
    expect(egressAllows(egress, "x.api.example.com")).toBe(false);
    expect(egressAllows([], "api.example.com")).toBe(false);
  });
});

describe("a module's state", () => {
  test("is kept per key in owner-only files, and survives a new context", async () => {
    const { paths, cleanup } = await tempRoot();
    try {
      const dir = paths.moduleState("probe");
      const state = createModuleState(dir);
      expect(await state.read("cursor")).toBeNull();
      await state.write("cursor", { at: "2027-03-14T09:00:00.000Z", n: 3 });
      await state.write("deployment-id", "d-1");
      expect(await createModuleState(dir).read<unknown>("cursor")).toEqual({
        at: "2027-03-14T09:00:00.000Z",
        n: 3,
      });
      expect((await readdir(dir)).sort()).toEqual(["cursor.json", "deployment-id.json"]);
      expect((await Bun.file(path.join(dir, "cursor.json")).stat()).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(path.join(dir, "cursor.json"), "utf8"))).toEqual({
        value: { at: "2027-03-14T09:00:00.000Z", n: 3 },
      });
    } finally {
      await cleanup();
    }
  });

  test("a key is one path segment, and a value has a ceiling", async () => {
    const { paths, cleanup } = await tempRoot();
    try {
      const state = createModuleState(paths.moduleState("probe"));
      for (const key of ["../escape", "a/b", "", "UPPER", ".hidden", "x".repeat(65)]) {
        await expect(state.write(key, 1)).rejects.toThrow(/state key/);
        await expect(state.read(key)).rejects.toThrow(/state key/);
      }
      await expect(state.write("big", "x".repeat(MODULE_STATE_MAX_BYTES))).rejects.toThrow(/at most/);
    } finally {
      await cleanup();
    }
  });

  test("one module's state is not another's", async () => {
    const { paths, cleanup } = await tempRoot();
    try {
      await createModuleState(paths.moduleState("probe")).write("k", "probe's");
      expect(await createModuleState(paths.moduleState("stores")).read("k")).toBeNull();
    } finally {
      await cleanup();
    }
  });
});

describe("a module's own audit records", () => {
  test("are written under its name, with names, counts and flags only", async () => {
    rig = await makeRig();
    const ctx = await contextOf(rig);
    ctx.audit.record("job.started", {
      job: "nightly-sync",
      table: "orders",
      rows: 1204,
      dryRun: false,
      note: "free text, with a comma; and a semicolon",
      password: "hunter2",
      "bad key": "x",
    });
    await Bun.sleep(20);
    const records = (await spoolRecords(rig.paths)).filter((r) => r.action === "module.probe.job.started");
    expect(records).toHaveLength(1);
    expect(records[0]?.params).toEqual({ job: "nightly-sync", table: "orders", rows: 1204, dryRun: false });
    expect(await spoolText(rig.paths)).not.toContain("hunter2");
  });

  test("an action that is not lower-case words is a programming error", async () => {
    rig = await makeRig();
    const ctx = await contextOf(rig);
    expect(() => ctx.audit.record("Job Started!", {})).toThrow(TypeError);
    expect(() => ctx.audit.record("../control_plane.ask", {})).toThrow(TypeError);
  });

  test("a module cannot write a record under another prefix", () => {
    // The module prefix is fixed by the port; this is the allowlist behind it.
    expect(sanitizeParams("module.probe.x", { rows: 3, name: "a b", free: "a,b" })).toEqual({ rows: 3, name: "a b" });
    expect(sanitizeParams("control_plane.ask", { module: "probe", rows: 3, free: "x" })).toEqual({ module: "probe" });
    expect(sanitizeParams("module.probe.x", { token: "abc", apiKey: "abc" })).toBeNull();
  });
});

describe("a manifest the host cannot enforce is refused", () => {
  const base: ModuleManifest = { id: "m", asks: [], egress: [], secrets: [] };

  test("the probe manifest and an empty one are fine", () => {
    expect(manifestDefect(PROBE_MANIFEST)).toBeNull();
    expect(manifestDefect(base)).toBeNull();
  });

  test.each([
    [{ ...base, id: "Bad Id" }, "module id"],
    [{ ...base, asks: [{ name: "Bad", args: S.none, reply: S.none }] }, "lower-case"],
    [{ ...base, asks: [{ name: "a", args: S.name, reply: S.none }] }, "must be a record"],
    [{ ...base, asks: [{ name: "a", args: S.none, reply: { kind: "text" } }] }, "closed set"],
    [{ ...base, asks: [{ name: "a", args: S.none, reply: S.none }, { name: "a", args: S.none, reply: S.none }] }, "twice"],
    [{ ...base, egress: ["https://api.example.com"] }, "host name"],
    [{ ...base, egress: ["*"] }, "host name"],
    [{ ...base, egress: ["api.example.com/path"] }, "host name"],
    [{ ...base, egress: ["10.0.0.1"] }, "host name"],
    [{ ...base, secrets: ["Has Space"] }, "secret"],
    [{ ...base, secrets: ["a", "a"] }, "twice"],
    [null, "not an object"],
  ])("%j", (manifest, word) => {
    expect(manifestDefect(manifest)).toContain(word);
  });

  test("a module is provided only with the manifest the catalog lists", async () => {
    rig = await makeRig();
    expect(() => rig.host.provide(createProbeModule())).toThrow(/provided twice/);
    const drifted = createProbeModule({ ...PROBE_MANIFEST, egress: ["exfil.example"] });
    const fresh = await makeRig({ start: false, probe: createProbeModule() });
    try {
      expect(() => fresh.host.provide(drifted)).toThrow(/provided twice|does not carry the manifest/);
      expect(() => fresh.host.provide(createProbeModule({ ...PROBE_MANIFEST, id: "stores" }))).toThrow(
        /not in this build's catalog/,
      );
    } finally {
      await fresh.cleanup();
    }
  });
});
