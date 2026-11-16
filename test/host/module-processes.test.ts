// A process of a module's own, as the host starts it: with a real child.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, lstat, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runModulesVerb } from "../../src/cli-modules";
import { setModuleEnabled } from "../../src/host/config";
import type { CatalogEntry } from "../../src/host/module-catalog";
import {
  failureCode,
  failureForLog,
  manifestDefect,
  ProcessRefused,
  type ModuleContextV2,
  type ModuleManifest,
  type ModuleProcess,
  type ProcessRule,
} from "../../src/host/module-contract";
import {
  ModuleProcesses,
  PROCESS_WORDS,
  PROCESS_WORD_PATTERN,
  ProcessesBusy,
  processWordFor,
  selfCommand,
  type SpawnChild,
  type StartedChild,
} from "../../src/host/module-processes";
import { createModuleContext } from "../../src/host/module-context";
import type { Organizations } from "../../src/host/module-organizations";
import { listModules } from "../../src/host/modules-api";
import { S } from "../../src/host/shape";
import {
  ask,
  createProbeModule,
  makeRig,
  PROBE_MANIFEST,
  spoolRecords,
  writeOrganizations,
  type Rig,
} from "./_module-rig";

const CHILD = path.join(import.meta.dir, "_process-child.ts");

let dirs: string[] = [];
let launchers: ModuleProcesses[] = [];
afterEach(async () => {
  for (const launcher of launchers) await launcher.endEvery();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
  launchers = [];
});

async function folder(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "hx-fortress-process-")));
  dirs.push(dir);
  return dir;
}

function launcher(maxPerModule?: number): { processes: ModuleProcesses; log: { level: string; message: string; fields?: unknown }[] } {
  const log: { level: string; message: string; fields?: unknown }[] = [];
  const write = (level: string) => (message: string, fields?: Record<string, unknown>) => void log.push({ level, message, fields });
  const processes = new ModuleProcesses({
    self: () => [process.execPath, CHILD],
    logger: { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") } as never,
    ...(maxPerModule === undefined ? {} : { maxPerModule }),
  });
  launchers.push(processes);
  return { processes, log };
}

/** Start one and wait for what it says first. */
async function started(processes: ModuleProcesses, dir: string, moduleId = "stores"): Promise<{ child: ModuleProcess; first: Record<string, unknown>; said: unknown[] }> {
  const said: unknown[] = [];
  let tell: (value: Record<string, unknown>) => void = () => undefined;
  const first = new Promise<Record<string, unknown>>((resolve) => (tell = resolve));
  const child = processes.start(moduleId, "store-engine", dir, (message) => {
    said.push(message);
    tell(message as Record<string, unknown>);
  });
  return { child, first: await first, said };
}

const next = async (said: unknown[], count: number): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (said.length < count) {
    if (Date.now() > deadline) throw new Error(`the process said ${said.length} things, not ${count}`);
    await Bun.sleep(10);
  }
};

describe("the words that can be started", () => {
  test("are a closed list, each for one module", () => {
    expect(PROCESS_WORDS).toEqual({ "store-engine": "stores" });
    for (const word of Object.keys(PROCESS_WORDS)) expect(PROCESS_WORD_PATTERN.test(word)).toBe(true);
    expect(processWordFor("stores", "store-engine")).toBe(true);
    // The word of another module, a word nobody has, and a name every object has.
    expect(processWordFor("databases", "store-engine")).toBe(false);
    expect(processWordFor("stores", "host")).toBe(false);
    expect(processWordFor("stores", "toString")).toBe(false);
    expect(processWordFor("stores", "__proto__")).toBe(false);
  });
});

describe("this program, as a command that starts it again", () => {
  test("is the binary alone where it is compiled, and the runtime with the entry file from the sources", () => {
    // As Bun 1.3.14 names the two: measured, and written down here.
    expect(selfCommand("/usr/local/bin/hx-fortress", "/$bunfs/root/hx-fortress")).toEqual(["/usr/local/bin/hx-fortress"]);
    expect(selfCommand("/usr/local/bin/bun", "/work/hx-fortress/src/cli.ts")).toEqual([
      "/usr/local/bin/bun",
      "/work/hx-fortress/src/cli.ts",
    ]);
    // This test runs from the sources.
    expect(selfCommand()).toEqual([process.execPath, Bun.main]);
  });
});

describe("a started process", () => {
  test("is this program and the word, in the folder it was given, with one variable and nothing of the daemon's", async () => {
    const dir = await folder();
    process.env.HX_FORTRESS_TEST_SECRET_FOR_THE_CHILD = "not for the child";
    try {
      const { processes } = launcher();
      const { first } = await started(processes, dir);
      expect(first).toEqual({
        started: true,
        word: "store-engine",
        cwd: dir,
        env: ["SQLITE_TMPDIR"],
        tmp: dir,
        // No input, and no output that anybody reads: each is the null device.
        closed: [true, true, true],
      });
    } finally {
      delete process.env.HX_FORTRESS_TEST_SECRET_FOR_THE_CHILD;
    }
  });

  test("the runtime is asked for exactly this: no shell, no input, no output, one variable, bytes as bytes", async () => {
    // What the child above saw depends on what this test's own process has for
    // its three standard files. This holds the request itself.
    const dir = await folder();
    const spawn = spyOn(Bun, "spawn");
    try {
      const { processes } = launcher();
      const { child } = await started(processes, dir);
      expect(spawn).toHaveBeenCalledTimes(1);
      const [command, options] = spawn.mock.calls[0] as unknown as [string[], Record<string, unknown>];
      expect(command).toEqual([process.execPath, CHILD, "store-engine"]);
      const { ipc, ...rest } = options;
      expect(typeof ipc).toBe("function");
      expect(rest).toEqual({
        cwd: dir,
        env: { SQLITE_TMPDIR: dir },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        serialization: "advanced",
      });
      child.kill();
      await child.exited;
    } finally {
      spawn.mockRestore();
    }
  });

  test("is sent values and sends values, and bytes cross as bytes", async () => {
    const { processes } = launcher();
    const { child, said } = await started(processes, await folder());
    child.send({ rows: [1, "two"], bytes: new Uint8Array([0, 255, 7]) });
    await next(said, 2);
    const echoed = (said[1] as { echo: { rows: unknown[]; bytes: unknown } }).echo;
    expect(echoed.rows).toEqual([1, "two"]);
    expect(echoed.bytes).toBeInstanceOf(Uint8Array);
    expect([...(echoed.bytes as Uint8Array)]).toEqual([0, 255, 7]);
  });

  test("what it prints is read by nobody, and it goes on", async () => {
    const { processes, log } = launcher();
    const { child, said } = await started(processes, await folder());
    child.send({ do: "print" });
    await next(said, 2);
    expect(said[1]).toEqual({ printed: true });
    expect(JSON.stringify(log)).not.toContain("a row's value");
  });

  test("is ended at once, also in the middle of work that never ends, and says how it ended", async () => {
    const { processes, log } = launcher();
    const { child } = await started(processes, await folder());
    child.send({ do: "hang" });
    await Bun.sleep(50);
    const asked = Date.now();
    child.kill();
    expect(await child.exited).toEqual({ signal: "SIGKILL" });
    expect(Date.now() - asked).toBeLessThan(2_000);
    expect(processes.count("stores")).toBe(0);
    // Ending it twice, and sending to it once it is gone, do nothing.
    child.kill();
    child.send({ after: "it is gone" });
    expect(log.filter((entry) => entry.message === "a module's process ended").map((entry) => entry.fields)).toEqual([
      { module: "stores", word: "store-engine", signal: "SIGKILL" },
    ]);
  });

  test("that ends by itself says its exit code", async () => {
    const { processes } = launcher();
    const { child } = await started(processes, await folder());
    child.send({ do: "exit" });
    expect(await child.exited).toEqual({ code: 7 });
    expect(processes.count("stores")).toBe(0);
  });

  test("a listener that throws stops neither the process nor the daemon, and the value is in no log", async () => {
    const { processes, log } = launcher();
    const dir = await folder();
    let heard = 0;
    const child = processes.start("stores", "store-engine", dir, () => {
      heard += 1;
      throw new Error("the row was 18 Mill Road");
    });
    while (heard < 1) await Bun.sleep(10);
    child.send({ again: true });
    while (heard < 2) await Bun.sleep(10);
    expect(JSON.stringify(log)).not.toContain("Mill Road");
    expect(log.some((entry) => entry.level === "error")).toBe(true);
    child.kill();
    await child.exited;
  });
});

describe("how many run, and when they are ended", () => {
  test("a module runs at most as many as it may, and another module's count is its own", async () => {
    const { processes } = launcher(2);
    const dir = await folder();
    const first = await started(processes, dir);
    await started(processes, dir);
    expect(() => processes.start("stores", "store-engine", dir, () => undefined)).toThrow(ProcessesBusy);
    expect(processes.count("stores")).toBe(2);
    // Another module is not held up by this one.
    await started(processes, dir, "probe");
    // One that ended makes room.
    first.child.kill();
    await first.child.exited;
    await started(processes, dir);
    expect(processes.count("stores")).toBe(2);
  });

  test("a module that is switched off has every process of its own ended, and no other module's", async () => {
    const { processes } = launcher();
    const dir = await folder();
    const a = await started(processes, dir);
    const b = await started(processes, dir);
    const other = await started(processes, dir, "probe");
    await processes.endAll("stores");
    expect(await a.child.exited).toEqual({ signal: "SIGKILL" });
    expect(await b.child.exited).toEqual({ signal: "SIGKILL" });
    expect(processes.count("stores")).toBe(0);
    expect(processes.count("probe")).toBe(1);
    other.child.kill();
    await other.child.exited;
  });

  test("the daemon's stop ends every process, and none is started after it", async () => {
    const { processes } = launcher();
    const dir = await folder();
    const a = await started(processes, dir);
    const b = await started(processes, dir, "probe");
    await processes.endEvery();
    expect(await a.child.exited).toEqual({ signal: "SIGKILL" });
    expect(await b.child.exited).toEqual({ signal: "SIGKILL" });
    expect(() => processes.start("stores", "store-engine", dir, () => undefined)).toThrow(ProcessesBusy);
  });
});

// ── Through a module's context ───────────────────────────────────────────────
//
// What a module can reach: `ctx.processes.start`. The rig below is the real
// module host with a module named `stores`, the one module the list gives a
// word to. Its process is the stand-in child of this file's first half.

const STORES: ModuleManifest = {
  id: "stores",
  asks: [{ name: "context.probe", args: S.none, reply: S.record({ identity: S.flag }) }],
  egress: [],
  secrets: [],
  processes: [{ verb: "store-engine" }],
};
const CATALOG: readonly CatalogEntry[] = [
  { id: "session_vault", title: "Sessions", summary: "transcripts", manifest: null, startOnly: true },
  { id: "stores", title: "Stores", summary: "a module for tests", manifest: STORES, startOnly: false },
];
const ALDER = "alder-dental";

let rig: Rig | null = null;
afterEach(async () => {
  await rig?.cleanup();
  rig = null;
});

async function storesRig(deps: { spawnProcess?: SpawnChild } = {}, held: readonly unknown[] = []): Promise<Rig> {
  const made = await makeRig({
    enabled: ["session_vault", "stores"],
    probe: createProbeModule(STORES),
    deps: { catalog: CATALOG, self: () => [process.execPath, CHILD], ...deps },
    start: false,
  });
  rig = made;
  if (held.length > 0) await writeOrganizations(made.paths, held);
  await made.host.start();
  await made.registry.startAll(["session_vault", "stores"]);
  await made.host.started();
  return made;
}

/** The context of the module's last ask, for the own organization or another. */
async function contextOf(r: Rig, organization: string | null = null): Promise<ModuleContextV2> {
  const grant = await r.key.grant("stores", "context.probe", {}, organization === null ? {} : { org: organization });
  const reply = await ask(r, "stores", "context.probe", {}, grant);
  if (!reply?.ok) throw new Error(`the ask was refused: ${JSON.stringify(reply)}`);
  if (!r.probe.context) throw new Error("the module was never called");
  return r.probe.context;
}

async function refused(promise: Promise<unknown>): Promise<ProcessRule> {
  const thrown: unknown = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  if (!(thrown instanceof ProcessRefused)) throw new Error(`expected a refusal, got ${String(thrown)}`);
  return thrown.rule;
}

const refusals = async (r: Rig): Promise<unknown[]> =>
  (await spoolRecords(r.paths)).filter((record) => record.action === "system.module.refused").map((record) => record.params);

/** Start through the context and wait for what the process says first. */
async function startedBy(
  ctx: ModuleContextV2,
  folder: readonly string[],
): Promise<{ child: ModuleProcess; first: Record<string, unknown> }> {
  let tell: (value: Record<string, unknown>) => void = () => undefined;
  const first = new Promise<Record<string, unknown>>((resolve) => (tell = resolve));
  const child = await ctx.processes.start("store-engine", { folder, onMessage: (message) => tell(message as Record<string, unknown>) });
  return { child, first: await first };
}

describe("a process, as a module's manifest names it", () => {
  const withProcesses = (processes: unknown, id = "stores"): unknown => ({ ...STORES, id, processes });

  test("a word of the host's list, for the module the list gives it to", () => {
    expect(manifestDefect(STORES)).toBeNull();
    expect(manifestDefect(withProcesses([]))).toBeNull();
    // The same word in another module's manifest: the list does not give it.
    expect(manifestDefect(withProcesses([{ verb: "store-engine" }], "probe"))).toBe(
      "this build starts no process store-engine for this module",
    );
    expect(manifestDefect(withProcesses([{ verb: "host" }]))).toBe("this build starts no process host for this module");
  });

  test("a word, and nothing else: no argument, no path, no environment", () => {
    for (const entry of [
      { verb: "store-engine", args: ["--all"] },
      { verb: "store-engine", cwd: "/" },
      { verb: "store-engine", env: { PATH: "/tmp" } },
    ]) {
      expect(manifestDefect(withProcesses([entry]))).toBe("a process names its word and nothing else");
    }
    for (const verb of ["Store-Engine", "store engine", "../store-engine", "store-engine;id", "", 7, "s".repeat(33)]) {
      expect(manifestDefect(withProcesses([{ verb }]))).toBe(
        "a process's word must be lower-case letters, digits and hyphens",
      );
    }
    expect(manifestDefect(withProcesses("store-engine"))).toBe("the manifest's processes must be a list");
    expect(manifestDefect(withProcesses(["store-engine"]))).toBe("a process is not an object");
    expect(manifestDefect(withProcesses([{ verb: "store-engine" }, { verb: "store-engine" }]))).toBe(
      "the process store-engine is listed twice",
    );
    expect(manifestDefect(withProcesses(Array.from({ length: 5 }, () => ({ verb: "store-engine" }))))).toBe(
      "a module may list at most 4 processes",
    );
  });
});

describe("ctx.processes.start", () => {
  test("starts the word in a folder the module made, with nothing of the daemon's, and the two talk", async () => {
    const r = await storesRig();
    const ctx = await contextOf(r);
    const dir = await ctx.folder("stores", "s0000001", "scratch");
    let said: unknown[] = [];
    const child = await ctx.processes.start("store-engine", {
      folder: ["stores", "s0000001", "scratch"],
      onMessage: (message) => void said.push(message),
    });
    await next(said, 1);
    expect(said[0]).toEqual({
      started: true,
      word: "store-engine",
      cwd: await realpath(dir),
      env: ["SQLITE_TMPDIR"],
      tmp: dir,
      closed: [true, true, true],
    });
    child.send({ rows: 3 });
    await next(said, 2);
    expect(said[1]).toEqual({ echo: { rows: 3 } });
    child.kill();
    expect(await child.exited).toEqual({ signal: "SIGKILL" });
    said = [];
    // Nothing of it is in the audit trail: what opened it is recorded already.
    expect(await refusals(r)).toEqual([]);
  });

  test("makes nothing on the disk: a folder that is not there is refused, and is still not there", async () => {
    const r = await storesRig();
    const ctx = await contextOf(r);
    const base = await ctx.folder();
    expect(await refused(ctx.processes.start("store-engine", { folder: ["stores", "s0000002", "scratch"], onMessage: () => undefined }))).toBe(
      "folder_missing",
    );
    // Not the folder, and no level above it.
    expect(await readdir(base)).toEqual([]);
    // One level is there and the next is not.
    await ctx.folder("stores");
    expect(await refused(ctx.processes.start("store-engine", { folder: ["stores", "s0000002"], onMessage: () => undefined }))).toBe(
      "folder_missing",
    );
    expect(await readdir(path.join(base, "stores"))).toEqual([]);
    // Recorded as the module's own refused call. The second of the same
    // refusal within the minute is counted, and not written again.
    expect(await refusals(r)).toEqual([{ module: "stores", rule: "folder_missing" }]);
    expect(r.host.processes.count("stores")).toBe(0);
  });

  test("a file or a link where the folder should be is not a folder", async () => {
    const r = await storesRig();
    const ctx = await contextOf(r);
    const base = await ctx.folder("stores");
    await writeFile(path.join(base, "a-file"), "x");
    const elsewhere = await folder();
    await symlink(elsewhere, path.join(base, "a-link"));
    for (const name of ["a-file", "a-link"]) {
      expect(await refused(ctx.processes.start("store-engine", { folder: ["stores", name], onMessage: () => undefined }))).toBe(
        "folder_missing",
      );
    }
    // A level under a file is not there either.
    expect(await refused(ctx.processes.start("store-engine", { folder: ["stores", "a-file", "x"], onMessage: () => undefined }))).toBe(
      "folder_missing",
    );
    expect(r.host.processes.count("stores")).toBe(0);
  });

  test("changes no mode: the folder is as the module left it", async () => {
    const r = await storesRig();
    const ctx = await contextOf(r);
    const dir = await ctx.folder("stores", "s0000003");
    await chmod(dir, 0o750);
    const { child } = await startedBy(ctx, ["stores", "s0000003"]);
    expect((await stat(dir)).mode & 0o777).toBe(0o750);
    child.kill();
    await child.exited;
  });

  test("a word the manifest does not name, a word of no list, and a module with no word are refused", async () => {
    const r = await storesRig();
    const ctx = await contextOf(r);
    await ctx.folder("stores");
    const start = (verb: unknown) => ctx.processes.start(verb as string, { folder: ["stores"], onMessage: () => undefined });
    for (const verb of ["host", "ui", "toString", "__proto__", "store-engine ", "", 7, null, undefined]) {
      expect(await refused(start(verb))).toBe("process_not_declared");
    }
    expect(r.host.processes.count("stores")).toBe(0);
    expect((await refusals(r))[0]).toEqual({ module: "stores", rule: "process_not_declared" });
    // The word a manifest of another module could not even name.
    await r.cleanup();
    rig = await makeRig();
    const grant = await rig.key.grant("probe", "context.probe", {});
    await ask(rig, "probe", "context.probe", {}, grant);
    const probe = rig.probe.context as ModuleContextV2;
    await probe.folder("stores");
    expect(PROBE_MANIFEST.processes).toBeUndefined();
    expect(await refused(probe.processes.start("store-engine", { folder: ["stores"], onMessage: () => undefined }))).toBe(
      "process_not_declared",
    );
  });

  test("the manifest's word and the host's list are two checks, and each alone refuses", async () => {
    // A module named `stores`, to which the list gives the word, whose manifest
    // names no process.
    const silent: ModuleManifest = { ...STORES, processes: [] };
    const made = await makeRig({
      enabled: ["session_vault", "stores"],
      probe: createProbeModule(silent),
      deps: {
        catalog: [CATALOG[0] as CatalogEntry, { ...(CATALOG[1] as CatalogEntry), manifest: silent }],
        self: () => [process.execPath, CHILD],
      },
    });
    rig = made;
    const ctx = await contextOf(made);
    await ctx.folder("stores");
    expect(await refused(ctx.processes.start("store-engine", { folder: ["stores"], onMessage: () => undefined }))).toBe(
      "process_not_declared",
    );
    expect(made.host.processes.count("stores")).toBe(0);

    // A manifest that names the word, for a module the list does not give it
    // to. No module host takes such a manifest, so the context is built here.
    const other: ModuleManifest = { ...PROBE_MANIFEST, processes: [{ verb: "store-engine" }] };
    expect(manifestDefect(other)).not.toBeNull();
    const direct = createModuleContext(
      other,
      {
        logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) as never,
        identity: () => null,
        secrets: made.secrets,
        audit: made.host.audit,
        // The module host's own view of its organizations: private to it.
        organizations: (made.host as unknown as { organizations: Organizations }).organizations,
        processes: made.host.processes,
      },
      ctx.organization,
    );
    await direct.folder("stores");
    expect(await refused(direct.processes.start("store-engine", { folder: ["stores"], onMessage: () => undefined }))).toBe(
      "process_not_declared",
    );
    expect(made.host.processes.count("probe")).toBe(0);
  });

  test("a folder's name is held to the rule of a folder, and refused as a process", async () => {
    const r = await storesRig();
    const ctx = await contextOf(r);
    const start = (names: unknown) => ctx.processes.start("store-engine", { folder: names as string[], onMessage: () => undefined });
    for (const names of [["..", "x"], ["stores", "../../etc"], ["Stores"], ["a/b"], [""], [7], "stores", null]) {
      expect(await refused(start(names))).toBe("folder_name_invalid");
    }
    expect(await refused(start(["a", "b", "c", "d", "e"]))).toBe("folder_too_deep");
    expect(r.host.processes.count("stores")).toBe(0);
  });

  test("another organization's process runs in that organization's folder, and one that left the list gets none", async () => {
    const r = await storesRig({}, [{ id: ALDER, modules: ["stores"] }]);
    const own = await contextOf(r);
    const alder = await contextOf(r, ALDER);
    const ownDir = await own.folder("stores", "s0000001");
    const alderDir = await alder.folder("stores", "s0000001");
    expect(alderDir).not.toBe(ownDir);
    const started = await startedBy(alder, ["stores", "s0000001"]);
    expect(started.first.cwd).toBe(await realpath(alderDir));
    started.child.kill();
    await started.child.exited;
    // The folder is still on the disk. The organization is no longer held.
    await writeOrganizations(r.paths, []);
    expect(await refused(alder.processes.start("store-engine", { folder: ["stores", "s0000001"], onMessage: () => undefined }))).toBe(
      "organization_not_held",
    );
    expect((await lstat(alderDir)).isDirectory()).toBe(true);
  });

  test("a module runs at most 32 at once, and the next is refused as busy", async () => {
    // Stand-ins that never end, so that 32 real processes are not started.
    const ends: (() => void)[] = [];
    const spawnProcess: SpawnChild = () => {
      let end: (code: number) => void = () => undefined;
      const exited = new Promise<number>((resolve) => (end = resolve));
      const child: StartedChild = { send: () => undefined, kill: () => end(137), exited, signalCode: null, pid: 1 };
      ends.push(() => end(0));
      return child;
    };
    const r = await storesRig({ spawnProcess });
    const ctx = await contextOf(r);
    await ctx.folder("stores");
    const start = () => ctx.processes.start("store-engine", { folder: ["stores"], onMessage: () => undefined });
    for (let i = 0; i < 32; i += 1) await start();
    expect(await refused(start())).toBe("busy");
    expect((await refusals(r)).at(-1)).toEqual({ module: "stores", rule: "busy" });
    // One that ended makes room for one.
    ends[0]?.();
    await Bun.sleep(5);
    await start();
    expect(await refused(start())).toBe("busy");
  });

  test("a start with no listener is an error of the caller, and starts nothing", async () => {
    const r = await storesRig();
    const ctx = await contextOf(r);
    await ctx.folder("stores");
    await expect(ctx.processes.start("store-engine", { folder: ["stores"] } as never)).rejects.toBeInstanceOf(TypeError);
    await expect(ctx.processes.start("store-engine", undefined as never)).rejects.toBeInstanceOf(ProcessRefused);
    expect(r.host.processes.count("stores")).toBe(0);
  });
});

describe("what a person is shown of a module's processes", () => {
  test("the listing and the terminal name the word, and say nothing for a module that has none", async () => {
    const r = await storesRig();
    const views = await listModules(r.paths, { catalog: CATALOG });
    expect(views.find((view) => view.id === "stores")?.processes).toEqual(["store-engine"]);
    expect(views.find((view) => view.id === "session_vault")).not.toHaveProperty("processes");
    const out: string[] = [];
    expect(await runModulesVerb(["list"], { writeLine: (line) => out.push(line), fortressRoot: r.paths.root, catalog: CATALOG })).toBe(0);
    expect(out.filter((line) => line.startsWith("  Starts:"))).toEqual([
      "  Starts:   hx-fortress store-engine. HX Fortress starts this for the module, as a process of the module's own.",
    ]);
  });
});

describe("a refusal, as a caller of the module is told it", () => {
  test("is its rule as one word, and the log holds no name that was asked for", () => {
    for (const rule of ["process_not_declared", "folder_missing", "busy", "folder_name_invalid"] as const) {
      const refusal = new ProcessRefused("stores", rule);
      expect(failureCode(refusal)).toBe(rule);
      expect(failureForLog(refusal)).toEqual({ code: rule, error: `module stores may not have this process: ${rule}` });
    }
  });
});

describe("what ends a module's processes", () => {
  test("the module being switched off", async () => {
    const r = await storesRig();
    const ctx = await contextOf(r);
    await ctx.folder("stores", "s0000001");
    const { child } = await startedBy(ctx, ["stores", "s0000001"]);
    await setModuleEnabled(r.paths, "stores", false);
    await r.host.follow();
    expect(await child.exited).toEqual({ signal: "SIGKILL" });
    expect(r.host.processes.count("stores")).toBe(0);
  });

  test("the daemon's stop, and none is started after it", async () => {
    const r = await storesRig();
    const ctx = await contextOf(r);
    await ctx.folder("stores", "s0000001");
    const { child } = await startedBy(ctx, ["stores", "s0000001"]);
    await r.host.stop();
    expect(await child.exited).toEqual({ signal: "SIGKILL" });
    expect(await refused(ctx.processes.start("store-engine", { folder: ["stores", "s0000001"], onMessage: () => undefined }))).toBe("busy");
  });
});
