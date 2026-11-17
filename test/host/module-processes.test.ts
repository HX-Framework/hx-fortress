// A process of a module's own, as the host starts it: with a real child.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  ProcessSendFailed,
  type ModuleContextV2,
  type ModuleManifest,
  type ModuleProcess,
  type ProcessRule,
} from "../../src/host/module-contract";
import {
  ModuleNotRunning,
  ModuleProcesses,
  PROCESS_END_WAIT_MS,
  PROCESS_WORDS,
  PROCESS_WORD_PATTERN,
  PROCESS_WORKING_FOLDER,
  ProcessNotStarted,
  ProcessesBusy,
  processWordFor,
  selfCommand,
  type ModuleProcessesDeps,
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

type LogLine = { level: string; message: string; fields?: unknown };

/** The launcher by itself. Every module is running unless a test says which are. */
function launcher(
  maxPerModule?: number,
  more: Partial<ModuleProcessesDeps> = {},
): { processes: ModuleProcesses; log: LogLine[] } {
  const log: LogLine[] = [];
  const write = (level: string) => (message: string, fields?: Record<string, unknown>) => void log.push({ level, message, fields });
  const processes = new ModuleProcesses({
    self: () => [process.execPath, CHILD],
    running: () => true,
    logger: { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") } as never,
    ...(maxPerModule === undefined ? {} : { maxPerModule }),
    ...more,
  });
  launchers.push(processes);
  return { processes, log };
}

/** A stand-in for a started child, with no process behind it. */
function madeUpChild(options: { endsWhenKilled?: boolean } = {}): { child: StartedChild; end(code?: number): void; fail(): void; kills: number } {
  let settle: (code: number) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const exited = new Promise<number>((resolve, refuse) => {
    settle = resolve;
    reject = refuse;
  });
  const made = {
    kills: 0,
    end: (code = 0) => settle(code),
    fail: () => reject(new Error("the runtime lost the process")),
    child: {
      send: () => undefined,
      kill: () => {
        made.kills += 1;
        if (options.endsWhenKilled ?? true) settle(137);
      },
      exited,
      exitCode: null,
      signalCode: null,
      pid: 4242,
    } as StartedChild,
  };
  return made;
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
    expect(selfCommand("/usr/local/bin/bun", "/work/hx-fortress/src/cli.ts", "/work/hx-fortress/src/cli.ts")).toEqual([
      "/usr/local/bin/bun",
      "/work/hx-fortress/src/cli.ts",
    ]);
    // The command line of this program, from where these sources are.
    const cli = path.join(import.meta.dir, "..", "..", "src", "cli.ts");
    expect(selfCommand("/usr/local/bin/bun", cli)).toEqual(["/usr/local/bin/bun", cli]);
  });

  test("is none where what runs is not this program's command line", () => {
    // Another file of the same sources, and a file somewhere else.
    expect(selfCommand("/usr/local/bin/bun", "/work/hx-fortress/src/host/main.ts", "/work/hx-fortress/src/cli.ts")).toBeNull();
    expect(selfCommand("/usr/local/bin/bun", "/work/other/cli.ts", "/work/hx-fortress/src/cli.ts")).toBeNull();
    // This test: what runs is the test, and started again it would be the test.
    expect(Bun.main).toEndWith("module-processes.test.ts");
    expect(selfCommand()).toBeNull();
  });

  test("where it is none, nothing is started, and the log says why", async () => {
    const { processes, log } = launcher(undefined, { self: () => null });
    const dir = await folder();
    let thrown: unknown = null;
    try {
      processes.start("stores", "store-engine", dir, () => undefined);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProcessNotStarted);
    expect((thrown as ProcessNotStarted).code).toBe("not_this_program");
    expect(processes.count("stores")).toBe(0);
    expect(log).toEqual([
      {
        level: "error",
        message: "no process was started for a module: what runs here is not this program's command line",
        fields: { module: "stores", word: "store-engine" },
      },
    ]);
  });
});

describe("a started process", () => {
  test("is this program and the word, in the root folder, with one variable that names its folder and nothing of the daemon's", async () => {
    const dir = await folder();
    process.env.HX_FORTRESS_TEST_SECRET_FOR_THE_CHILD = "not for the child";
    try {
      const { processes } = launcher();
      const { first } = await started(processes, dir);
      expect(PROCESS_WORKING_FOLDER).toBe("/");
      expect(first).toEqual({
        started: true,
        word: "store-engine",
        cwd: "/",
        env: ["SQLITE_TMPDIR"],
        tmp: dir,
        preloaded: false,
        // No input, and no output that anybody reads: each is the null device.
        closed: [true, true, true],
      });
    } finally {
      delete process.env.HX_FORTRESS_TEST_SECRET_FOR_THE_CHILD;
    }
  });

  test("takes no variable and no code from the folder it is given, whatever a file there says", async () => {
    // The runtime reads a `.env` and a `bunfig.toml` from the folder a program
    // starts in. A module's folder holds what was written for a client, so
    // the program does not start there.
    const dir = await folder();
    await writeFile(path.join(dir, ".env"), "PLANTED_BY_A_FILE=yes\nSQLITE_TMPDIR=/somewhere/else\n");
    await writeFile(path.join(dir, ".env.local"), "PLANTED_LOCALLY=yes\n");
    await writeFile(path.join(dir, "bunfig.toml"), 'preload = ["./planted.ts"]\n');
    await writeFile(path.join(dir, "planted.ts"), "(globalThis as { plantedCodeRan?: boolean }).plantedCodeRan = true;\n");
    const { processes } = launcher();
    const { first } = await started(processes, dir);
    expect(first).toMatchObject({ cwd: "/", env: ["SQLITE_TMPDIR"], tmp: dir, preloaded: false });
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
        cwd: "/",
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
    expect(log.filter((entry) => entry.level === "error")).toEqual([
      { level: "error", message: "a module's listener failed on a value from its process", fields: { module: "stores", word: "store-engine" } },
      { level: "error", message: "a module's listener failed on a value from its process", fields: { module: "stores", word: "store-engine" } },
    ]);
    child.kill();
    await child.exited;
  });

  test("a listener that fails through a promise fails for itself too: the runtime is told nothing", async () => {
    // A failure nobody takes reaches the runtime, which prints it into the
    // daemon's log, the value with it, and ends the daemon later.
    const unhandled: unknown[] = [];
    const seen = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", seen);
    try {
      const { processes, log } = launcher();
      let heard = 0;
      const child = processes.start("stores", "store-engine", await folder(), async () => {
        heard += 1;
        await Bun.sleep(1);
        throw new Error("the row was 18 Mill Road");
      });
      while (heard < 1) await Bun.sleep(10);
      child.send({ again: true });
      while (heard < 2) await Bun.sleep(10);
      // Long enough for a failure nobody took to be reported.
      await Bun.sleep(100);
      expect(unhandled).toEqual([]);
      expect(JSON.stringify(log)).not.toContain("Mill Road");
      expect(log.filter((entry) => entry.level === "error").map((entry) => entry.message)).toEqual([
        "a module's listener failed on a value from its process",
        "a module's listener failed on a value from its process",
      ]);
      // A thing that is no promise and has a `then` of its own is taken the same way.
      const odd = processes.start("stores", "store-engine", await folder(), () => ({
        then: (_done: unknown, failed: (reason: Error) => void) => failed(new Error("the row was 18 Mill Road")),
      }));
      await Bun.sleep(300);
      expect(unhandled).toEqual([]);
      expect(JSON.stringify(log)).not.toContain("Mill Road");
      odd.kill();
      child.kill();
      await Promise.all([odd.exited, child.exited]);
    } finally {
      process.off("unhandledRejection", seen);
    }
  });

  test("a value the channel cannot carry is told to the sender at once, with nothing of the value, and the process goes on", async () => {
    const { processes } = launcher();
    const { child, said } = await started(processes, await folder());
    const unsendable: unknown[] = [() => "18 Mill Road", { row: () => "18 Mill Road" }, Symbol("18 Mill Road")];
    for (const value of unsendable) {
      let thrown: unknown = null;
      try {
        child.send(value);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ProcessSendFailed);
      expect((thrown as ProcessSendFailed).rule).toBe("value_unsendable");
      expect((thrown as Error).message).toBe("a value could not be sent to the process: value_unsendable");
      expect(String((thrown as Error).stack)).not.toContain("Mill Road");
      expect((thrown as { cause?: unknown }).cause).toBeUndefined();
    }
    child.send({ after: "them" });
    await next(said, 2);
    expect(said[1]).toEqual({ echo: { after: "them" } });
    expect(processes.count("stores")).toBe(1);
  });

  test("a process that closed its side of the channel and still runs: the sender is told, and is not told once it is gone", async () => {
    const { processes } = launcher();
    const { child } = await started(processes, await folder());
    child.send({ do: "close the channel" });
    // The runtime learns of the closed channel a moment later.
    let thrown: unknown = null;
    const deadline = Date.now() + 10_000;
    while (thrown === null && Date.now() < deadline) {
      await Bun.sleep(20);
      try {
        child.send({ into: "nothing" });
      } catch (error) {
        thrown = error;
      }
    }
    expect(thrown).toBeInstanceOf(ProcessSendFailed);
    expect((thrown as ProcessSendFailed).rule).toBe("channel_closed");
    expect(processes.count("stores")).toBe(1);
    child.kill();
    expect(await child.exited).toEqual({ signal: "SIGKILL" });
    // Gone: a value sent now is dropped, and nothing is thrown.
    child.send({ into: "nothing" });
    child.send(() => "not even this");
  });

  test("a process the runtime lost is gone, with a code of its own", async () => {
    const made = madeUpChild();
    const { processes } = launcher(undefined, { spawn: () => made.child });
    const child = processes.start("stores", "store-engine", await folder(), () => undefined);
    made.fail();
    expect(await child.exited).toEqual({ code: -1 });
    expect(processes.count("stores")).toBe(0);
  });

  test("a program that cannot be started is said in one word, and the log holds the machine's word and no path", async () => {
    const { processes, log } = launcher(undefined, {
      spawn: () => {
        throw Object.assign(new Error("ENOENT: no such file or directory, posix_spawn '/a/path/of/this/machine'"), { code: "ENOENT" });
      },
    });
    let thrown: unknown = null;
    try {
      processes.start("stores", "store-engine", await folder(), () => undefined);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProcessNotStarted);
    expect((thrown as ProcessNotStarted).code).toBe("ENOENT");
    expect((thrown as Error).message).toBe("the program could not be started: ENOENT");
    expect(processes.count("stores")).toBe(0);
    expect(log).toEqual([
      { level: "error", message: "the program could not be started for a module", fields: { module: "stores", word: "store-engine", code: "ENOENT" } },
    ]);
    // An error with no word of the machine's, or with one that is no word.
    for (const code of [undefined, "a sentence with /a/path", 7]) {
      const odd = launcher(undefined, {
        spawn: () => {
          throw Object.assign(new Error("something of /a/path"), { code });
        },
      });
      expect(() => odd.processes.start("stores", "store-engine", "/", () => undefined)).toThrow("the program could not be started: unknown");
      expect(JSON.stringify(odd.log)).not.toContain("/a/path");
    }
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

  test("a process is started only for a module that is running", async () => {
    const running = new Set(["stores"]);
    const { processes } = launcher(undefined, { running: (moduleId) => running.has(moduleId) });
    const dir = await folder();
    expect(() => processes.start("probe", "store-engine", dir, () => undefined)).toThrow(ModuleNotRunning);
    const { child } = await started(processes, dir);
    // The module stopped. What it runs is ended by the host, which then
    // starts nothing for it, also at the request of a context it kept.
    running.delete("stores");
    expect(() => processes.start("stores", "store-engine", dir, () => undefined)).toThrow(ModuleNotRunning);
    await processes.endAll("stores");
    expect(await child.exited).toEqual({ signal: "SIGKILL" });
    expect(processes.count("stores")).toBe(0);
    // And once it runs again, it has processes again.
    running.add("stores");
    await started(processes, dir);
  });

  test("the wait for an ended process has a limit: one that the machine holds stops neither a switch nor the daemon's stop", async () => {
    expect(PROCESS_END_WAIT_MS).toBe(5_000);
    const held = madeUpChild({ endsWhenKilled: false });
    const goes = madeUpChild();
    const children = [held, goes];
    const { processes, log } = launcher(undefined, { spawn: () => (children.shift() as typeof held).child, endWaitMs: 60 });
    const dir = await folder();
    processes.start("stores", "store-engine", dir, () => undefined);
    processes.start("stores", "store-engine", dir, () => undefined);

    const asked = Date.now();
    await processes.endAll("stores");
    expect(Date.now() - asked).toBeGreaterThanOrEqual(50);
    expect(Date.now() - asked).toBeLessThan(3_000);
    expect([held.kills, goes.kills]).toEqual([1, 1]);
    // The one that is still there still counts, and the log names it once.
    expect(processes.count("stores")).toBe(1);
    const late = (entries: LogLine[]) => entries.filter((entry) => entry.message.includes("still there"));
    expect(late(log)).toEqual([
      {
        level: "error",
        message: "a module's process was ended and is still there: the host goes on without it",
        fields: { module: "stores", word: "store-engine", pid: 4242, waitedMs: 60 },
      },
    ]);
    // The daemon's stop waits as long, and no longer.
    const stopped = Date.now();
    await processes.endEvery();
    expect(Date.now() - stopped).toBeLessThan(3_000);
    expect(late(log)).toHaveLength(2);
    // Once the machine lets it go, it is gone here too.
    held.end(137);
    await Bun.sleep(5);
    expect(processes.count("stores")).toBe(0);
  });

  test("ending where nothing runs waits for nothing", async () => {
    const { processes } = launcher(undefined, { endWaitMs: 5_000 });
    const asked = Date.now();
    await processes.endAll("stores");
    await processes.endEvery();
    expect(Date.now() - asked).toBeLessThan(1_000);
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

async function storesRig(
  deps: { spawnProcess?: SpawnChild; self?: () => readonly string[] | null; processEndWaitMs?: number } = {},
  held: readonly unknown[] = [],
): Promise<Rig> {
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
  test("starts the word for a folder the module made, with nothing of the daemon's, and the two talk", async () => {
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
      cwd: "/",
      env: ["SQLITE_TMPDIR"],
      tmp: dir,
      preloaded: false,
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

  test("a link at any level above the folder is not followed either", async () => {
    // A folder somewhere else that has the same levels below it: another
    // organization's, say. A link to it at an upper level would hand the
    // process that folder.
    const r = await storesRig();
    const ctx = await contextOf(r);
    const base = await ctx.folder();
    const elsewhere = await folder();
    await mkdir(path.join(elsewhere, "s0000001", "scratch"), { recursive: true });
    await symlink(elsewhere, path.join(base, "stores"));
    const start = (names: string[]) => ctx.processes.start("store-engine", { folder: names, onMessage: () => undefined });
    expect(await refused(start(["stores", "s0000001", "scratch"]))).toBe("folder_missing");
    expect(await refused(start(["stores", "s0000001"]))).toBe("folder_missing");
    expect(await refused(start(["stores"]))).toBe("folder_missing");
    // The middle level.
    await rm(path.join(base, "stores"));
    await ctx.folder("stores");
    await symlink(path.join(elsewhere, "s0000001"), path.join(base, "stores", "s0000001"));
    expect(await refused(start(["stores", "s0000001", "scratch"]))).toBe("folder_missing");
    // The module's own folder for the organization.
    await rename(base, `${base}.moved`);
    await symlink(`${base}.moved`, base);
    expect(await refused(start([]))).toBe("folder_missing");
    expect(r.host.processes.count("stores")).toBe(0);
    await rm(base);
    await rename(`${base}.moved`, base);
  });

  test("the names are taken as they are when the start is asked for: a list changed afterwards changes nothing", async () => {
    const r = await storesRig();
    const ctx = await contextOf(r);
    const dir = await ctx.folder("stores", "s0000001");
    const elsewhere = await folder();
    for (const change of [
      // A full path in place of the names, which a path would be built to.
      (names: string[]) => names.splice(0, names.length, elsewhere),
      // One level up and out.
      (names: string[]) => names.splice(0, names.length, "..", "..", ".."),
      // A fifth level, and a level that is no name.
      (names: string[]) => names.push("a", "b", "c", "../x"),
      (names: string[]) => (names.length = 0),
    ]) {
      const names = ["stores", "s0000001"];
      let tell: (value: Record<string, unknown>) => void = () => undefined;
      const first = new Promise<Record<string, unknown>>((resolve) => (tell = resolve));
      const starting = ctx.processes.start("store-engine", { folder: names, onMessage: (message) => tell(message as Record<string, unknown>) });
      change(names);
      const child = await starting;
      expect((await first).tmp).toBe(dir);
      child.kill();
      await child.exited;
    }
    expect(await refusals(r)).toEqual([]);
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

  test("another organization's process is given that organization's folder, and one that left the list gets none", async () => {
    const r = await storesRig({}, [{ id: ALDER, modules: ["stores"] }]);
    const own = await contextOf(r);
    const alder = await contextOf(r, ALDER);
    const ownDir = await own.folder("stores", "s0000001");
    const alderDir = await alder.folder("stores", "s0000001");
    expect(alderDir).not.toBe(ownDir);
    const started = await startedBy(alder, ["stores", "s0000001"]);
    expect(started.first.tmp).toBe(alderDir);
    started.child.kill();
    await started.child.exited;
    // The folder is still on the disk. The organization is no longer held.
    await writeOrganizations(r.paths, []);
    expect(await refused(alder.processes.start("store-engine", { folder: ["stores", "s0000001"], onMessage: () => undefined }))).toBe(
      "organization_not_held",
    );
    expect((await lstat(alderDir)).isDirectory()).toBe(true);
  });

  test("a module runs at most 32 at once, and the next is refused: none is to be had now", async () => {
    // Stand-ins that never end, so that 32 real processes are not started.
    const made: ReturnType<typeof madeUpChild>[] = [];
    const spawnProcess: SpawnChild = () => {
      const one = madeUpChild();
      made.push(one);
      return one.child;
    };
    const r = await storesRig({ spawnProcess });
    const ctx = await contextOf(r);
    await ctx.folder("stores");
    const start = () => ctx.processes.start("store-engine", { folder: ["stores"], onMessage: () => undefined });
    for (let i = 0; i < 32; i += 1) await start();
    expect(await refused(start())).toBe("processes_unavailable");
    expect((await refusals(r)).at(-1)).toEqual({ module: "stores", rule: "processes_unavailable" });
    // One that ended makes room for one.
    made[0]?.end();
    await Bun.sleep(5);
    await start();
    expect(await refused(start())).toBe("processes_unavailable");
  });

  test("a program that could not be started is a refusal like any other: one word, and a record", async () => {
    const spawnProcess: SpawnChild = () => {
      throw Object.assign(new Error("EAGAIN: resource temporarily unavailable, posix_spawn '/a/path/of/this/machine'"), { code: "EAGAIN" });
    };
    const r = await storesRig({ spawnProcess });
    const ctx = await contextOf(r);
    await ctx.folder("stores");
    const start = () => ctx.processes.start("store-engine", { folder: ["stores"], onMessage: () => undefined });
    expect(await refused(start())).toBe("process_start_failed");
    expect(await refusals(r)).toEqual([{ module: "stores", rule: "process_start_failed" }]);
    expect(r.host.processes.count("stores")).toBe(0);
    expect(JSON.stringify(await spoolRecords(r.paths))).not.toContain("/a/path");
  });

  test("where what runs is not this program's command line, nothing is started", async () => {
    // A module host that was not told what this program is finds out by
    // itself. In a test that is the test, and it starts no test.
    const made = await makeRig({
      enabled: ["session_vault", "stores"],
      probe: createProbeModule(STORES),
      deps: { catalog: CATALOG },
    });
    rig = made;
    const ctx = await contextOf(made);
    await ctx.folder("stores");
    expect(await refused(ctx.processes.start("store-engine", { folder: ["stores"], onMessage: () => undefined }))).toBe(
      "process_start_failed",
    );
    expect(made.host.processes.count("stores")).toBe(0);
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
    for (const rule of [
      "process_not_declared",
      "folder_missing",
      "module_not_running",
      "processes_unavailable",
      "process_start_failed",
      "folder_name_invalid",
    ] as const) {
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
    expect(await refused(ctx.processes.start("store-engine", { folder: ["stores", "s0000001"], onMessage: () => undefined }))).toBe(
      "processes_unavailable",
    );
  });

  test("a module that is off is started nothing, also through a context it kept, and the refusal is recorded", async () => {
    const r = await storesRig();
    const ctx = await contextOf(r);
    await ctx.folder("stores", "s0000001");
    const start = () => ctx.processes.start("store-engine", { folder: ["stores", "s0000001"], onMessage: () => undefined });
    const before = await start();
    await setModuleEnabled(r.paths, "stores", false);
    await r.host.follow();
    expect(r.registry.isRunning("stores")).toBe(false);
    expect(await before.exited).toEqual({ signal: "SIGKILL" });
    // The context is the one the module was handed while it ran.
    expect(await refused(start())).toBe("module_not_running");
    expect(await refusals(r)).toEqual([{ module: "stores", rule: "module_not_running" }]);
    await Bun.sleep(100);
    expect(r.host.processes.count("stores")).toBe(0);
  });

  test("a start that is on its way while the module is switched off leaves nothing running", async () => {
    // Either it was in time, and what it started is ended with the rest, or it
    // was not, and it is refused. No order of the two leaves a process.
    for (let round = 0; round < 6; round += 1) {
      const r = await storesRig();
      const ctx = await contextOf(r);
      await ctx.folder("stores", "s0000001");
      const starting = ctx.processes
        .start("store-engine", { folder: ["stores", "s0000001"], onMessage: () => undefined })
        .then(
          (child) => child,
          (error: unknown) => error,
        );
      // A different moment in each round: before, during and after the checks.
      for (let turn = 0; turn < round; turn += 1) await Promise.resolve();
      await setModuleEnabled(r.paths, "stores", false);
      await r.host.follow();
      const outcome = await starting;
      if (outcome instanceof ProcessRefused) {
        expect(outcome.rule).toBe("module_not_running");
      } else {
        expect(await (outcome as ModuleProcess).exited).toEqual({ signal: "SIGKILL" });
      }
      await Bun.sleep(20);
      expect(r.host.processes.count("stores")).toBe(0);
      await r.cleanup();
      rig = null;
    }
  });

  test("a switch-off and the daemon's stop go on where a process is not let go", async () => {
    const held = madeUpChild({ endsWhenKilled: false });
    const r = await storesRig({ spawnProcess: () => held.child, processEndWaitMs: 80 });
    const ctx = await contextOf(r);
    await ctx.folder("stores");
    await ctx.processes.start("store-engine", { folder: ["stores"], onMessage: () => undefined });
    await setModuleEnabled(r.paths, "stores", false);
    const asked = Date.now();
    await r.host.follow();
    expect(Date.now() - asked).toBeLessThan(5_000);
    expect(r.registry.isRunning("stores")).toBe(false);
    expect(held.kills).toBe(1);
    const stopping = Date.now();
    await r.host.stop();
    expect(Date.now() - stopping).toBeLessThan(5_000);
    held.end(137);
  });
});
