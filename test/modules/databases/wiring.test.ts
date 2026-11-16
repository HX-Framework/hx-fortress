// The Databases module as this build ships it: in the catalog, in the
// terminal's list of modules, and in the daemon, where it is given stand-ins
// that start no program.

import { afterEach, describe, expect, test } from "bun:test";

import { runCli } from "../../../src/cli";
import type { WsCloudConnectionDeps } from "../../../src/cloud";
import { runFortressHost } from "../../../src/host/main";
import { catalogEntry, MODULE_CATALOG } from "../../../src/host/module-catalog";
import type { ModuleRegistry } from "../../../src/host/module-registry";
import { listAsks, moduleDataPaths } from "../../../src/host/modules-api";
import type { CloudConnection } from "../../../src/host/types";
import { PROGRAM_FAILURES } from "../../../src/modules/databases/host-ports";
import { DATABASES_MANIFEST, FAILURE_CODES } from "../../../src/modules/databases/manifest";
import { createStandInPorts } from "../../../src/modules/databases/standins";
import { tempRoot, writeConfig, type Paths } from "../../host/_module-rig";
import { reachHostRefusal } from "./_host-standins";
import { act, addConnection, makeDatabasesRig, PERMITS, testConnection, type DatabasesRig } from "./_rig";

let rig: DatabasesRig | null = null;
let cleanup: (() => Promise<void>) | null = null;
const priorKey = process.env.FORTRESS_OPENAI_API_KEY;
afterEach(async () => {
  await rig?.cleanup();
  await cleanup?.();
  rig = null;
  cleanup = null;
  if (priorKey === undefined) delete process.env.FORTRESS_OPENAI_API_KEY;
  else process.env.FORTRESS_OPENAI_API_KEY = priorKey;
});

async function bareRoot(enabled: readonly string[]): Promise<Paths> {
  const root = await tempRoot();
  cleanup = root.cleanup;
  await writeConfig(root.paths, enabled);
  return root.paths;
}

describe("the build's catalog", () => {
  test("lists the module with the manifest the module carries", () => {
    const entry = catalogEntry("databases");
    expect(entry).toMatchObject({ id: "databases", title: "Databases", startOnly: false });
    expect(entry?.manifest).toBe(DATABASES_MANIFEST);
    expect(MODULE_CATALOG.filter((module) => module.id === "databases")).toHaveLength(1);
  });

  test("the control plane may ask it four things", () => {
    expect(
      listAsks()
        .filter((view) => view.module === "databases")
        .map((view) => view.name),
    ).toEqual(["connections.list", "catalog.read", "test.start", "job.read"]);
  });

  test("every word the host may fail a program with is a word a job may fail with", () => {
    for (const code of PROGRAM_FAILURES) expect(FAILURE_CODES).toContain(code);
  });
});

describe("hx-fortress modules list", () => {
  test("shows databases, off, with what a control plane may ask it", async () => {
    const paths = await bareRoot(["session_vault"]);
    const out: string[] = [];
    const code = await runCli(["modules", "list"], {
      fortressRoot: paths.root,
      writeLine: (line) => out.push(line),
    });
    expect(code).toBe(0);
    const from = out.indexOf("databases (Databases): off");
    expect(from).toBeGreaterThan(0);
    expect(out.slice(from, from + 8)).toEqual([
      "databases (Databases): off",
      "  Does:     reads and writes local databases",
      "  State:    stopped",
      expect.stringMatching(/^ {2}Version: {2}/) as unknown as string,
      "  Calls:    no hosts",
      "  Secrets:  none",
      "  Asks:     4. A control plane may ask it these and nothing else:",
      "    connections.list",
    ]);
    const text = out.slice(from).join("\n");
    for (const ask of ["catalog.read", "test.start", "job.read"]) expect(text).toContain(`    ${ask}`);
    // Nothing for a client's network is on a screen.
    expect(text).not.toContain("runner");
    expect(text).not.toContain("site");
  });

  test("switched on, its asks are on the list of what may cross", async () => {
    const paths = await bareRoot(["session_vault", "databases"]);
    const view = await moduleDataPaths(paths, { cloudUrl: null, env: {} });
    expect(view.on.find((module) => module.id === "databases")).toMatchObject({
      id: "databases",
      egress: [],
      asks: [
        { name: "connections.list" },
        { name: "catalog.read" },
        { name: "test.start" },
        { name: "job.read" },
      ],
    });
  });
});

/** How long a test that starts the linter may take. Each start of it takes
 *  about half a second on an idle machine, one of these tests starts it five
 *  times, and a busy machine once took it past the five seconds a test gets
 *  by default. */
const LINT_LIMIT_MS = 60_000;

describe("in the daemon", () => {
  /** Compose the daemon exactly as `hx-fortress host` does, without running it. */
  async function compose(paths: Paths): Promise<{ deps: WsCloudConnectionDeps; registry: ModuleRegistry }> {
    process.env.FORTRESS_OPENAI_API_KEY = "sk-test-fortress-openai-key";
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

  test("the module is provided, and registered only once it is switched on", async () => {
    const off = await bareRoot(["session_vault"]);
    expect((await compose(off)).registry.has("databases")).toBe(false);
    await cleanup?.();
    const on = await bareRoot(["session_vault", "databases"]);
    const { deps, registry } = await compose(on);
    expect(registry.has("databases")).toBe(true);
    // Its asks go through the real gate: one with no grant is refused there.
    expect(
      await deps.asks?.handle({
        module: "databases",
        id: "m1",
        kind: "request",
        payload: { v: 1, ask: "connections.list", args: {} },
      }),
    ).toEqual({ ok: false, error: "grant_missing" });
  });

  test("with the daemon's stand-ins a test starts no program and reads no secret", async () => {
    rig = await makeDatabasesRig({ asInTheDaemon: true });
    await addConnection(rig);
    const job = await testConnection(rig);
    expect(await act(rig, "job.read", { job })).toMatchObject({
      ok: true,
      payload: { state: "failed", code: "program_not_installed", step: "start" },
    });
    // The store the module's own context reads secrets from was never asked.
    expect(rig.secrets.reads).toEqual([]);
    expect(await act(rig, "connections.read")).toMatchObject({
      payload: { connections: [{ name: PERMITS.name, state: "failed" }] },
    });
  });

  test("the daemon hands the module the stand-ins that take nothing", async () => {
    // `createStandInPorts` has no parameter, so there is no launcher and no
    // recorder to hand it: what the daemon builds can start no program.
    expect(createStandInPorts.length).toBe(0);
    const main = await Bun.file(new URL("../../../src/host/main.ts", import.meta.url)).text();
    expect(main).toContain("createDatabasesModule({ ports: createStandInPorts() })");
    expect(main.match(/createStandInPorts\(/g)).toHaveLength(1);
  });

  test("a file of a module that starts a process fails the build", () => {
    const lint = (source: string): { code: number; out: string } => {
      const result = Bun.spawnSync(
        ["bun", "x", "eslint", "--stdin", "--stdin-filename", "src/modules/example/starts.ts"],
        { cwd: new URL("../../..", import.meta.url).pathname, stdin: Buffer.from(source), stdout: "pipe", stderr: "pipe" },
      );
      return { code: result.exitCode, out: result.stdout.toString() };
    };
    const started = lint(
      [
        'import { spawn } from "node:child_process";',
        "void spawn;",
        'export const a = (): unknown => Bun.spawn(["true"]);',
        "",
      ].join("\n"),
    );
    expect(started.code).not.toBe(0);
    expect(started.out.match(/A module starts no process/g)).toHaveLength(2);
    // The module's own files pass.
    expect(lint('export const a = (name: string): string => name.trim();\n')).toEqual({ code: 0, out: "" });
  }, LINT_LIMIT_MS);

  test("another module imports the Databases module's for-modules file and nothing else of it", () => {
    const lint = (source: string): { code: number; out: string } => {
      const result = Bun.spawnSync(
        ["bun", "x", "eslint", "--stdin", "--stdin-filename", "src/modules/example/pulls.ts"],
        { cwd: new URL("../../..", import.meta.url).pathname, stdin: Buffer.from(source), stdout: "pipe", stderr: "pipe" },
      );
      return { code: result.exitCode, out: result.stdout.toString() };
    };
    expect(
      lint('import type { DatabasesForModules } from "../databases/for-modules";\nexport type A = DatabasesForModules;\n'),
    ).toEqual({ code: 0, out: "" });
    for (const file of ["module", "connections", "standins", "data-runner"]) {
      const refused = lint(`import * as inner from "../databases/${file}";\nvoid inner;\n`);
      expect([file, refused.code !== 0, refused.out.includes("through its for-modules file")]).toEqual([file, true, true]);
    }
  }, LINT_LIMIT_MS);
});

describe("which hosts a reach may name", () => {
  test.each([
    "sql01.northstar.example",
    "SQL01",
    "sql_01.corp.northstar.example",
    "10.20.0.14",
    "192.168.1.20",
    "172.16.4.9",
    "8.8.8.8",
    "fd00::14",
    "2001:db8::14",
    "[2001:db8::14]",
    "::ffff:10.20.0.14",
    "64:ff9b::a14:e",
    "localhost.example.com",
    "sql01.northstar.example.",
  ])("taken: %s", (host) => {
    expect(reachHostRefusal(host)).toBeNull();
  });

  test.each([
    "localhost",
    "db.localhost",
    "127.0.0.1",
    "127.8.9.10",
    "0.0.0.0",
    "169.254.169.254",
    "224.0.0.251",
    "255.255.255.255",
    "::1",
    "::",
    "0:0:0:0:0:0:0:1",
    "::0001",
    "fe80::1",
    "febf::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::127.0.0.1",
    "::ffff:169.254.169.254",
    // Names that mean this machine in a common hosts file.
    "ip6-localhost",
    "ip6-loopback",
    "localhost.localdomain",
    "localhost6",
    // A loopback or a metadata address inside a prefix that carries IPv4.
    "::ffff:0:127.0.0.1",
    "64:ff9b::7f00:1",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
    // The address two clouds answer their instance metadata at, over IPv6.
    "fd00:ec2::254",
    "fd20:ce::254",
  ])("refused as an address this HX Fortress does not dial: %s", (host) => {
    expect(reachHostRefusal(host)).toBe("reach_address_refused");
  });

  test.each([
    "",
    "sql01 northstar",
    "sql01..example",
    "-sql01.example",
    "sql01-.example",
    "2130706433",
    "0x7f.1",
    "sql01.example.123",
    "1.2.3",
    "1.2.3.4.5",
    "256.1.1.1",
    "12345::1",
    "1::2::3",
    "1:2:3:4:5:6:7:8:9",
    "gggg::1",
    ":::::",
    "1.2:3",
    "fd00::1.",
    // A zero in front of a number is octal to a C library.
    "010.0.0.1",
    "127.000.000.001",
    `${"a".repeat(64)}.example`,
  ])("refused as no host at all: %s", (host) => {
    expect(reachHostRefusal(host)).toBe("reach_host_invalid");
  });
});
