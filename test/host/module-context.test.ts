import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { sanitizeParams } from "../../src/console/audit-actions";
import {
  createModuleState,
  DeferredSecrets,
  MODULE_STATE_MAX_BYTES,
  STATE_WRITING_FOLDER,
} from "../../src/host/module-context";
import { temporaryFor } from "../../src/host/private-json";
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
      // One file for each key, and the folder that a write's temporary file
      // is made in, which is empty while nothing is written.
      expect((await readdir(dir)).sort()).toEqual([STATE_WRITING_FOLDER, "cursor.json", "deployment-id.json"]);
      expect(STATE_WRITING_FOLDER).toBe(".writing");
      expect(await readdir(path.join(dir, STATE_WRITING_FOLDER))).toEqual([]);
      expect((await Bun.file(path.join(dir, STATE_WRITING_FOLDER)).stat()).mode & 0o777).toBe(0o700);
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

  /** A temporary file as a write of `key` leaves it when the daemon stops
   *  between the write and the rename: in the folder for them. */
  async function leftBy(dir: string, key: string, pid = process.pid): Promise<string> {
    const within = path.join(dir, STATE_WRITING_FOLDER);
    await mkdir(within, { recursive: true });
    const temporary = temporaryFor(path.join(within, `${key}.json`), pid);
    await writeFile(temporary, JSON.stringify({ value: "a page of a database's table names" }));
    return path.basename(temporary);
  }
  const leftIn = async (dir: string): Promise<string[]> =>
    (await readdir(path.join(dir, STATE_WRITING_FOLDER)).catch(() => [])).sort();

  test("the first use of a state folder by a process removes what earlier runs left, for every key", async () => {
    for (const use of ["read", "write", "remove"] as const) {
      const { paths, cleanup } = await tempRoot();
      try {
        const dir = paths.moduleState("stores");
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "summary.json"), JSON.stringify({ value: "kept" }));
        // An earlier run, stopped in the middle of two writes. One has the id
        // this process has: a daemon that starts again in a container often does.
        await leftBy(dir, "pages-3", process.pid + 1);
        await leftBy(dir, "summary", process.pid);
        const state = createModuleState(dir);
        if (use === "read") expect(await state.read("other")).toBeNull();
        if (use === "write") await state.write("other", 1);
        if (use === "remove") await state.remove("other");
        expect(await leftIn(dir)).toEqual([]);
        expect(await state.read<string>("summary")).toBe("kept");
      } finally {
        await cleanup();
      }
    }
  });

  test("what a key held is gone when the key is removed: its file, and what a write of it left", async () => {
    const { paths, cleanup } = await tempRoot();
    try {
      const dir = paths.moduleState("probe");
      const state = createModuleState(dir);
      await state.write("pages-3", "a page of a database's table names");
      await state.write("pages-30", "another");
      // After the folder's first use, so that only the removal can take them.
      await leftBy(dir, "pages-3");
      await leftBy(dir, "pages-3", 1);
      const others = await leftBy(dir, "pages-30");
      await state.remove("pages-3");
      expect((await readdir(dir)).sort()).toEqual([STATE_WRITING_FOLDER, "pages-30.json"]);
      expect(await leftIn(dir)).toEqual([others]);
      expect(await state.read("pages-3")).toBeNull();
      // Removing a key that holds nothing removes what was left of it too.
      await state.remove("pages-30");
      await state.remove("pages-30");
      expect(await leftIn(dir)).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("a write that is under way is not ended by a removal of its key", async () => {
    const { paths, cleanup } = await tempRoot();
    try {
      const state = createModuleState(paths.moduleState("probe"));
      const value = "x".repeat(200_000);
      // The two at once, many times. Whichever is last, the write never fails.
      for (let round = 0; round < 150; round += 1) {
        const written = state.write("cursor", value).then(
          () => "written",
          (error: unknown) => error,
        );
        if (round % 3 > 0) await Promise.resolve();
        if (round % 3 > 1) await new Promise((resolve) => setImmediate(resolve));
        await state.remove("cursor");
        expect([round, await written]).toEqual([round, "written"]);
      }
      expect(await leftIn(paths.moduleState("probe"))).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test.skipIf(process.getuid?.() === 0)("a removal that could not make sure says so, and the next one finishes it", async () => {
    const { paths, cleanup } = await tempRoot();
    try {
      const dir = paths.moduleState("probe");
      const state = createModuleState(dir);
      await state.write("pages-3", "a page of a database's table names");
      const one = await leftBy(dir, "pages-3");
      const within = path.join(dir, STATE_WRITING_FOLDER);
      // The folder can be neither listed nor written: a disk that does not answer.
      await chmod(within, 0o000);
      try {
        await expect(state.remove("pages-3")).rejects.toThrow();
        // A key that never had a temporary file is refused the same way: it cannot be known.
        await expect(state.remove("never-written")).rejects.toThrow();
        // A read is answered all the same. The key's own file went with the first try.
        expect(await state.read("pages-3")).toBeNull();
      } finally {
        await chmod(within, 0o700);
      }
      // The key's own file went with the first try, and what was left of it is still there.
      expect((await readdir(dir)).sort()).toEqual([STATE_WRITING_FOLDER]);
      expect(await leftIn(dir)).toEqual([one]);
      await state.remove("pages-3");
      expect(await leftIn(dir)).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test.skipIf(process.getuid?.() === 0)("a first use that could not clear the folder is tried again at the next use", async () => {
    const { paths, cleanup } = await tempRoot();
    try {
      const dir = paths.moduleState("probe");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "kept.json"), JSON.stringify({ value: "kept" }));
      await leftBy(dir, "pages-3", 1);
      const within = path.join(dir, STATE_WRITING_FOLDER);
      await chmod(within, 0o000);
      const state = createModuleState(dir);
      try {
        // A read is answered all the same.
        expect(await state.read<string>("kept")).toBe("kept");
      } finally {
        await chmod(within, 0o700);
      }
      expect(await leftIn(dir)).toHaveLength(1);
      // The next use, of any key and through any port of this folder.
      expect(await createModuleState(dir).read<string>("kept")).toBe("kept");
      expect(await leftIn(dir)).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("a removal looks at the folder for temporary files and at no other: its cost does not grow with the keys", async () => {
    const { paths, cleanup } = await tempRoot();
    try {
      const dir = paths.moduleState("probe");
      const state = createModuleState(dir);
      await state.write("pages-3", 1);
      // A file with a temporary file's name BESIDE the keys. Nothing of this
      // build writes one there, and a removal that found it would have had to
      // list every key of the folder.
      const beside = path.basename(temporaryFor(path.join(dir, "pages-3.json"), 1));
      await writeFile(path.join(dir, beside), "x");
      await state.remove("pages-3");
      expect((await readdir(dir)).sort()).toEqual([STATE_WRITING_FOLDER, beside].sort());
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

  test("can hold a person's address, kept whole, and still no other text", async () => {
    rig = await makeRig();
    const ctx = await contextOf(rig);
    const longest = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    expect(longest).toHaveLength(254);
    ctx.audit.record("write.started", {
      connection: "orders-eu",
      approvedBy: "u-1204",
      // A plus sign and an apostrophe: neither fits a name.
      approverEmail: "marta.k+writes@northstar.example",
      second: "o'brien@northstar.example",
      longest,
      // Neither a name nor an email: left out, not cut and not rewritten.
      spaced: "marta k+writes@northstar.example",
      rarer: "marta&co@northstar.example",
      twoAts: "marta+k@north@star.example",
      tooLong: `${longest}e`,
    });
    await Bun.sleep(20);
    const records = (await spoolRecords(rig.paths)).filter((r) => r.action === "module.probe.write.started");
    expect(records).toHaveLength(1);
    expect(records[0]?.params).toEqual({
      connection: "orders-eu",
      approvedBy: "u-1204",
      approverEmail: "marta.k+writes@northstar.example",
      second: "o'brien@northstar.example",
      longest,
    });
  });

  test("an address in a module's record is held to the audit trail's other rules like any text", () => {
    // What looks like a credential is replaced inside an address too. Its
    // first part is made here, so that no key-like text stands in this file.
    const keyLike = `${["s", "k"].join("")}-${"a1b2".repeat(6)}@northstar.example`;
    expect(sanitizeParams("module.probe.x", { by: keyLike })).toEqual({ by: "[redacted]@northstar.example" });
    // A field whose name says that it holds a secret is left out whatever it holds.
    expect(sanitizeParams("module.probe.x", { approverSecret: "marta@northstar.example" })).toBeNull();
    // An action with a list of its fields is as before: it keeps a text of any
    // form in a field it lists, and no field it does not list.
    expect(sanitizeParams("console.signin", { login: "marta+k@northstar.example", email: "marta+k@northstar.example" })).toEqual({
      login: "marta+k@northstar.example",
    });
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
