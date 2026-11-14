// How the daemon is wired for modules. The composition in src/host/main.ts is
// what decides whether the gate and the shelf are actually in the path, so it
// is pinned here rather than assumed from the pieces passing on their own.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WsCloudConnectionDeps } from "../src/cloud";
import { runFortressHost } from "../src/host/main";
import type { ModuleRegistry } from "../src/host/module-registry";
import type { CloudConnection } from "../src/host/types";
import {
  makeOrgKey,
  tempRoot,
  writeConfig,
  writeOrganizations,
  type Paths,
} from "./host/_module-rig";

const SRC = path.join(import.meta.dir, "..", "src");

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** Compose the daemon exactly as `hx-fortress host` does, without running it. */
async function compose(paths: Paths): Promise<{ deps: WsCloudConnectionDeps; registry: ModuleRegistry }> {
  let captured: WsCloudConnectionDeps | null = null;
  await runFortressHost({
    root: paths.root,
    version: "0.0.0-test",
    createConnection(dependencies) {
      captured = dependencies;
      const connection: CloudConnection = {
        state: () => "offline",
        status: () => ({ state: "offline", reason: null, message: null }),
        open: async () => {},
        close: async () => {},
        notifyIngest: () => {},
      };
      return connection;
    },
    run: async () => {},
  });
  if (!captured) throw new Error("the connection was never built");
  const deps = captured as WsCloudConnectionDeps;
  return { deps, registry: deps.dispatcher as ModuleRegistry };
}

describe("the daemon's wiring for modules", () => {
  const priorKey = process.env.FORTRESS_OPENAI_API_KEY;
  let cleanup: (() => Promise<void>) | null = null;
  beforeEach(() => {
    process.env.FORTRESS_OPENAI_API_KEY = "sk-test-fortress-openai-key";
  });
  afterEach(async () => {
    if (priorKey === undefined) delete process.env.FORTRESS_OPENAI_API_KEY;
    else process.env.FORTRESS_OPENAI_API_KEY = priorKey;
    await cleanup?.();
    cleanup = null;
  });

  test("every module message goes to the gate and every offer to the shelf", async () => {
    const root = await tempRoot();
    cleanup = root.cleanup;
    await writeConfig(root.paths, ["session_vault"]);
    const { deps } = await compose(root.paths);
    expect(typeof deps.asks?.handle).toBe("function");
    expect(typeof deps.releases?.offer).toBe("function");
    expect(typeof deps.releases?.remove).toBe("function");
    expect(typeof deps.onAuthenticated).toBe("function");
    // There is nothing to pass a code loader AS: the connection takes none.
    expect("moduleLoader" in deps).toBe(false);

    // And the gate is the real one: an ask with no grant is refused by it.
    const reply = await deps.asks?.handle({
      module: "host",
      id: "m1",
      kind: "request",
      payload: { v: 1, ask: "status", args: {} },
    });
    expect(reply).toEqual({ ok: false, error: "grant_missing" });
    // A fortress with no pinned key refuses whatever grant it is shown.
    const withGrant = await deps.asks?.handle({
      module: "host",
      id: "m2",
      kind: "request",
      payload: { v: 1, ask: "status", args: {}, grant: "aaaa.bbbb.cccc" },
    });
    expect(withGrant).toEqual({ ok: false, error: "grant_invalid" });
    // An unsigned offer is refused by the real shelf.
    expect(
      await deps.releases?.offer({
        moduleId: "host",
        version: "1.0.0",
        artifactUrl: "https://control.example/modules/x.bin",
        checksum: "0".repeat(64),
      }),
    ).toEqual({ moduleId: "host", version: "1.0.0", ok: false, error: "refused:signature_missing" });
  });

  test("a fortress that switched nothing on runs exactly the modules it ran before", async () => {
    const root = await tempRoot();
    cleanup = root.cleanup;
    await writeConfig(root.paths, ["session_vault"]);
    const { registry } = await compose(root.paths);
    expect(registry.snapshot()).toEqual([{ id: "session_vault", state: "stopped", error: null }]);
  });

  test("a module that is switched on is registered, ready for the runtime to start", async () => {
    const root = await tempRoot();
    cleanup = root.cleanup;
    await writeConfig(root.paths, ["session_vault", "host"]);
    const { registry } = await compose(root.paths);
    expect(registry.snapshot().map((module) => module.id)).toEqual(["session_vault", "host"]);
    expect(registry.has("host")).toBe(true);
  });

  test("the daemon decides an ask for the organization its grant names, against its own list", async () => {
    // Made-up organizations. Northstar is the one this fortress enrolled as.
    const NORTHSTAR = "northstar";
    const root = await tempRoot();
    cleanup = root.cleanup;
    const { paths } = root;
    await writeConfig(paths, ["session_vault", "host"]);
    // An enrolled fortress: its credential, and the key it pinned.
    const key = await makeOrgKey();
    await mkdir(path.dirname(paths.credentials), { recursive: true });
    await writeFile(paths.credentials, JSON.stringify({ orgId: NORTHSTAR, fortressId: "fortress-1", credential: "c" }));
    await writeFile(paths.signingKey, `${key.publicKey}\n`);
    await writeOrganizations(paths, [{ id: "alder-dental", modules: ["host"] }, { id: "birch-books" }]);

    const { deps } = await compose(paths);
    let sent = 0;
    const status = async (org: string): Promise<unknown> =>
      deps.asks?.handle({
        module: "host",
        id: `m-${(sent += 1)}`,
        kind: "request",
        payload: {
          v: 1,
          ask: "status",
          args: {},
          grant: await key.grant("host", "status", {}, { org, aud: NORTHSTAR }),
        },
      });
    // Nothing is running in this composition, so an ask that passes every check
    // of the gate ends at "the module is not running". What matters is how far
    // each one gets.
    const passed = { ok: false, error: "failed:module_not_running" };
    expect(await status(NORTHSTAR)).toEqual(passed);
    // On the list, and its entry lists `host`.
    expect(await status("alder-dental")).toEqual(passed);
    // On the list, and its entry does not list `host`.
    expect(await status("birch-books")).toEqual({ ok: false, error: "module_off" });
    // Not on the list.
    expect(await status("cedar-labs")).toEqual({ ok: false, error: "grant_invalid" });

    // The daemon knows which organization it enrolled as: a list with an
    // entry for that one is refused whole, so nobody on it is held.
    await writeOrganizations(paths, [{ id: "alder-dental", modules: ["host"] }, { id: NORTHSTAR }]);
    expect(await status("alder-dental")).toEqual({ ok: false, error: "grant_invalid" });
    expect(await status(NORTHSTAR)).toEqual(passed);
  });
});

describe("the fortress never loads code from the control plane", () => {
  test("nothing in the source reaches the module loader: not by name, by alias or by path", async () => {
    // `ModuleLoader` fetches a module's code from a URL and imports it. It is
    // kept, with its own tests, and nothing uses it. Its name appears in its own
    // file and on the one line that exports it, and nowhere else: an import
    // under another name, or by its file's path, would have to spell one of
    // these three.
    const mentions: string[] = [];
    for (const file of await sourceFiles(SRC)) {
      const name = path.relative(SRC, file);
      if (name === path.join("host", "module-loader.ts")) continue;
      const lines = (await readFile(file, "utf8")).split("\n");
      for (const line of lines) {
        if (!/ModuleLoader|module-loader|importModule/.test(line)) continue;
        if (
          name === path.join("host", "index.ts") &&
          line === 'export { ModuleLoader, type ModuleLoaderDeps } from "./module-loader";'
        ) {
          continue;
        }
        mentions.push(`${name}: ${line.trim()}`);
      }
    }
    expect(mentions).toEqual([]);
  });

  test("the connection to the control plane has no way to load code, however it is built", async () => {
    // Not a matter of what the daemon passes it: the connection takes no loader
    // and calls no install. A frame that offers a release has one place to go.
    const connection = await readFile(path.join(SRC, "cloud", "connection.ts"), "utf8");
    const code = connection
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    for (const word of ["moduleLoader", "ModuleLifecycleHandler", ".install(", ".uninstall(", "import("]) {
      expect([word, code.includes(word)]).toEqual([word, false]);
    }
    // And there is one place in the source that builds a connection: the one
    // this file composes above, which is given the gate and the shelf.
    const builders: string[] = [];
    for (const file of await sourceFiles(SRC)) {
      if (/new\s+WsCloudConnection\s*\(/.test(await readFile(file, "utf8"))) {
        builders.push(path.relative(SRC, file));
      }
    }
    expect(builders).toEqual([path.join("host", "main.ts")]);
  });

  test("an artifact is never imported, evaluated or run by the host", async () => {
    // The release path handles an artifact as bytes: fetched, verified, written
    // to a file, handed to its module. None of these files may turn bytes into
    // code.
    for (const name of ["release-shelf.ts", "release-fetch.ts", "release-intents.ts", "module-host.ts", "ask-gate.ts"]) {
      const text = await readFile(path.join(SRC, "host", name), "utf8");
      const code = text
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect([name, /\bimport\s*\(/.test(code)]).toEqual([name, false]);
      expect([name, /\beval\s*\(|new\s+Function\s*\(/.test(code)]).toEqual([name, false]);
      // Running a program needs one of these, and none is imported.
      expect([name, /node:child_process|node:vm|node:worker_threads|Bun\.spawn|new\s+Worker\s*\(/.test(code)]).toEqual([
        name,
        false,
      ]);
    }
  });
});
