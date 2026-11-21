// A helper program of a module, as the host runs it: with a real program.

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ModulePrograms,
  PROGRAM_DEFAULT_TIMEOUT_MS,
  PROGRAM_ID_PATTERN,
  PROGRAM_MAX_TIMEOUT_MS,
  PROGRAM_WORKING_FOLDER,
  PROGRAMS,
  PROGRAMS_MAX_PER_MODULE,
  programFor,
  programInstalled,
  programTimeoutMs,
  spawnProgramWithRuntime,
  type ModuleProgramsDeps,
  type ProgramRunEnd,
  type ProgramStart,
  type SpawnProgram,
  type StartedProgram,
} from "../../src/host/module-programs";

let dirs: string[] = [];
let launchers: ModulePrograms[] = [];
afterEach(async () => {
  for (const launcher of launchers) await launcher.endEvery();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
  launchers = [];
});

async function folder(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "hx-fortress-program-")));
  dirs.push(dir);
  return dir;
}

/**
 * The stand-in program, as a file that can be run: the child's source under a
 * first line that names the runtime. So the launcher starts it as it starts
 * any program: by its path, with no shell.
 */
async function program(): Promise<string> {
  const source = await readFile(path.join(import.meta.dir, "_program-child.ts"), "utf8");
  const file = path.join(await folder(), "helper.ts");
  await writeFile(file, `#!/usr/bin/env bun\n${source}`, { mode: 0o755 });
  return file;
}

/** Where the runtime and `env` are found. Everything a program of these tests
 *  is given besides what a test names. */
const PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;

type LogLine = { level: string; message: string; fields?: Record<string, unknown> };

/** The launcher by itself. Every module is running unless a test says which are. */
function launcher(more: Partial<ModuleProgramsDeps> = {}): {
  programs: ModulePrograms;
  log: LogLine[];
  pids: number[];
} {
  const log: LogLine[] = [];
  const pids: number[] = [];
  const say = (level: string) => (message: string, fields?: Record<string, unknown>) =>
    void log.push({ level, message, ...(fields ? { fields } : {}) });
  const spawn: SpawnProgram = (command, options) => {
    const child = (more.spawn ?? spawnProgramWithRuntime)(command, options);
    pids.push(child.pid);
    return child;
  };
  const programs = new ModulePrograms({
    running: () => true,
    logger: { debug: say("debug"), info: say("info"), warn: say("warn"), error: say("error") },
    ...more,
    spawn,
  });
  launchers.push(programs);
  return { programs, log, pids };
}

/** One run of the stand-in, with what it printed. */
async function run(
  programs: ModulePrograms,
  file: string,
  job: Record<string, unknown>,
  more: Partial<ProgramStart> = {},
): Promise<{ end: ProgramRunEnd; values: unknown[]; input: Uint8Array }> {
  const values: unknown[] = [];
  const input = new TextEncoder().encode(JSON.stringify(job));
  const end = await programs.run({
    moduleId: "databases",
    program: "data-runner",
    path: file,
    args: [],
    env: { PATH },
    input,
    onOutput: (value) => void values.push(value),
    ...more,
  });
  return { end, values, input };
}

/** Whether a process is still there. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(done: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

// A made-up value in the place of a login's password.
const PASSWORD = ["a-password", "of-the", "tests"].join("-");

describe("what a program is started with", () => {
  test("its arguments, its variables and its folder are the caller's, and nothing of this process's", async () => {
    const { programs } = launcher();
    const file = await program();
    process.env.FORTRESS_TEST_ONLY_HERE = "the daemon's own";
    try {
      const { end, values } = await run(programs, file, { do: "echo" }, {
        args: ["run", "--job-stdin"],
        env: { PATH, DB_IO_NAMES_ITSELF: "1" },
      });
      expect(end).toEqual({ ok: true });
      const [seen] = values as { args: string[]; env: Record<string, string>; cwd: string }[];
      expect(seen?.args).toEqual(["run", "--job-stdin"]);
      // Exactly what it was given: no variable of this process is among them.
      expect(seen?.env).toEqual({ PATH, DB_IO_NAMES_ITSELF: "1" });
      expect(seen?.cwd).toBe(PROGRAM_WORKING_FOLDER);
      expect(PROGRAM_WORKING_FOLDER).toBe("/");
    } finally {
      delete process.env.FORTRESS_TEST_ONLY_HERE;
    }
  });

  test("its job is on its standard input, which is then closed, and in no argument and no variable", async () => {
    const { programs, log } = launcher();
    const file = await program();
    const { end, values, input } = await run(programs, file, { do: "echo", login: { password: PASSWORD } });
    expect(end).toEqual({ ok: true });
    const [seen] = values as { args: string[]; env: Record<string, string>; job: unknown }[];
    // The program read its input to the end, which only a closed input has.
    expect(seen?.job).toEqual({ do: "echo", login: { password: PASSWORD } });
    expect(JSON.stringify(seen?.args)).not.toContain(PASSWORD);
    expect(JSON.stringify(seen?.env)).not.toContain(PASSWORD);
    // The job is in no line of the log, and the host's copy of it is zeros.
    expect(JSON.stringify(log)).not.toContain(PASSWORD);
    expect(input.every((byte) => byte === 0)).toBe(true);
    expect(input.byteLength).toBeGreaterThan(20);
  });

  test("the log says that it started and how it ended, with the module and the program", async () => {
    const { programs, log, pids } = launcher();
    await run(programs, await program(), { do: "lines", values: [{ rows: [["a row's value"]] }] });
    expect(log.map((line) => [line.level, line.message])).toEqual([
      ["info", "started a program for a module"],
      ["info", "a module's program ended"],
    ]);
    expect(log[0]?.fields).toEqual({ module: "databases", program: "data-runner", pid: pids[0] });
    expect(log[1]?.fields).toMatchObject({ module: "databases", program: "data-runner", code: 0 });
    // What it printed is in no line: it can hold rows.
    expect(JSON.stringify(log)).not.toContain("a row's value");
    // Its path is in no line either.
    expect(JSON.stringify(log)).not.toContain("helper.ts");
  });
});

describe("what comes back", () => {
  test("each JSON value it prints is handed over as it is, in order, whatever kind it is", async () => {
    const { programs } = launcher();
    const printed = [{ v: 1, rows: [["a", 1, null]] }, [1, 2], "text", 7, null, true];
    const { end, values } = await run(programs, await program(), { do: "lines", values: printed });
    expect(end).toEqual({ ok: true });
    expect(values).toEqual(printed);
  });

  test("an empty line is no value, and a last line needs no line end", async () => {
    const { programs } = launcher();
    const file = await program();
    expect(await run(programs, file, { do: "blank-lines" })).toMatchObject({ end: { ok: true }, values: [{ n: 1 }] });
    expect(await run(programs, file, { do: "no-line-end" })).toMatchObject({
      end: { ok: true },
      values: [{ n: 1 }, { n: 2 }],
    });
  });

  test("a value of two megabytes arrives whole", async () => {
    const { programs } = launcher();
    const { end, values } = await run(programs, await program(), { do: "large", bytes: 2 * 1024 * 1024 });
    expect(end).toEqual({ ok: true });
    expect((values[0] as { pad: string }).pad).toHaveLength(2 * 1024 * 1024);
  });

  test("a line that is not JSON ends the run, and the program with it", async () => {
    const { programs, pids } = launcher({ stopGraceMs: 200 });
    const { end, values } = await run(programs, await program(), { do: "not-json" });
    expect(end).toEqual({ ok: false, code: "program_failed" });
    // What came before it was handed over. Nothing after it is.
    expect(values).toEqual([{ n: 1 }]);
    // The program would have stayed for ever. It is gone.
    expect(alive(pids[0] as number)).toBe(false);
  });

  test("output that is not text fails the run", async () => {
    const { programs } = launcher();
    expect(await run(programs, await program(), { do: "not-text" })).toMatchObject({
      end: { ok: false, code: "program_failed" },
      values: [],
    });
  });

  test("more than a run may print ends the run, and nothing of it is handed over", async () => {
    const { programs, pids } = launcher({ outputMaxBytes: 64 * 1024, stopGraceMs: 200 });
    const { end, values } = await run(programs, await program(), { do: "too-much", bytes: 512 * 1024 });
    expect(end).toEqual({ ok: false, code: "program_failed" });
    expect(values).toEqual([]);
    expect(alive(pids[0] as number)).toBe(false);
  });

  test("exactly as much as a run may print is taken", async () => {
    // `{"pad":"…"}` and a line end: 10 bytes around the padding, and one.
    const { programs } = launcher({ outputMaxBytes: 10_011 });
    const file = await program();
    expect((await run(programs, file, { do: "large", bytes: 10_000 })).end).toEqual({ ok: true });
    expect((await run(programs, file, { do: "large", bytes: 10_001 })).end).toEqual({ ok: false, code: "program_failed" });
  });

  test("a program that ends badly failed, and what it printed first was still handed over", async () => {
    const { programs, log } = launcher();
    const file = await program();
    expect(await run(programs, file, { do: "exit", code: 1, print: true })).toMatchObject({
      end: { ok: false, code: "program_failed" },
      values: [{ n: 1 }],
    });
    expect(await run(programs, file, { do: "exit", code: 2 })).toMatchObject({
      end: { ok: false, code: "program_failed" },
      values: [],
    });
    expect(log.filter((line) => line.message === "a module's program ended").map((line) => line.fields?.code)).toEqual([1, 2]);
  });

  test("a program that ends well and prints nothing ran: what that means is its caller's to say", async () => {
    const { programs } = launcher();
    expect(await run(programs, await program(), { do: "exit", code: 0 })).toMatchObject({ end: { ok: true }, values: [] });
  });

  test("a listener that fails, at once or later, fails for itself: the run goes on and the log says no more than that", async () => {
    const { programs, log } = launcher();
    const file = await program();
    const thrown = await run(programs, file, { do: "lines", values: [{ secret: "a row's value" }, { n: 2 }] }, {
      onOutput: (value) => {
        throw new Error(`could not take ${JSON.stringify(value)}`);
      },
    });
    expect(thrown.end).toEqual({ ok: true });
    const rejected = await run(programs, file, { do: "lines", values: [{ secret: "a row's value" }] }, {
      onOutput: async (value) => {
        throw new Error(`could not take ${JSON.stringify(value)}`);
      },
    });
    expect(rejected.end).toEqual({ ok: true });
    await Bun.sleep(10);
    const failures = log.filter((line) => line.level === "error");
    expect(failures.map((line) => line.message)).toEqual([
      "a module's listener failed on its program's output",
      "a module's listener failed on its program's output",
      "a module's listener failed on its program's output",
    ]);
    expect(JSON.stringify(log)).not.toContain("a row's value");
    expect(JSON.stringify(log)).not.toContain("could not take");
  });
});

describe("what a program says on its error output", () => {
  test("goes into the log line by line, with what looks like a credential replaced", async () => {
    const { programs, log } = launcher();
    // Made here, so that no key-like text stands in this file.
    const keyLike = `${["s", "k"].join("")}-${"a1b2".repeat(6)}`;
    const { end, values } = await run(programs, await program(), {
      do: "says",
      lines: ["stage connect 12ms", "", `the server said ${keyLike}`, "stage done"],
    });
    expect(end).toEqual({ ok: true });
    expect(values).toEqual([{ said: 4 }]);
    const said = log.filter((line) => line.message === "a module's program says");
    expect(said.map((line) => line.fields)).toEqual([
      { module: "databases", program: "data-runner", line: "stage connect 12ms" },
      { module: "databases", program: "data-runner", line: "the server said [redacted]" },
      { module: "databases", program: "data-runner", line: "stage done" },
    ]);
    expect(JSON.stringify(log)).not.toContain(keyLike);
  });

  test("past the limit the rest is dropped and said so once, and the program is not held up", async () => {
    const { programs, log } = launcher({ errorOutputMaxBytes: 1_000 });
    // 20,000 lines of 100 bytes: two megabytes, far past what a pipe holds.
    const { end, values } = await run(programs, await program(), { do: "says-much", lines: 20_000 });
    expect(end).toEqual({ ok: true });
    expect(values).toEqual([{ said: 20_000 }]);
    const said = log.filter((line) => line.message === "a module's program says");
    expect(said).toHaveLength(10);
    const dropped = log.filter((line) => line.message === "the rest of a program's error output is dropped");
    expect(dropped.map((line) => [line.level, line.fields])).toEqual([
      ["warn", { module: "databases", program: "data-runner", keptBytes: 1_000 }],
    ]);
  });
});

describe("a program is ended from outside", () => {
  test("when its time is up", async () => {
    const { programs, pids, log } = launcher({ stopGraceMs: 200 });
    const started = Date.now();
    const { end, values } = await run(programs, await program(), { do: "hang" }, { timeoutMs: 300 });
    expect(end).toEqual({ ok: false, code: "timeout" });
    expect(values).toEqual([{ started: true }]);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(alive(pids[0] as number)).toBe(false);
    expect(log.at(-1)?.fields).toMatchObject({ endedBy: "timeout", signal: "SIGTERM" });
  });

  test("it is asked first: a program that answers a stop says so and ends well", async () => {
    const { programs } = launcher({ stopGraceMs: 2_000 });
    const file = await program();
    // Stopped by its caller: what it said on its way out is handed over, and
    // how it ended is how the program ended.
    const abort = new AbortController();
    const values: unknown[] = [];
    const running = programs.run({
      moduleId: "databases",
      program: "data-runner",
      path: file,
      args: [],
      env: { PATH },
      input: new TextEncoder().encode(JSON.stringify({ do: "answers-a-stop" })),
      onOutput: (value) => void values.push(value),
      signal: abort.signal,
    });
    await until(() => values.length === 1, "the program to start");
    abort.abort();
    expect(await running).toEqual({ ok: true });
    expect(values).toEqual([{ started: true }, { stopped: true }]);
    // Stopped because its time was up: that is how the run ended, whatever
    // the program said.
    const late = await run(programs, file, { do: "answers-a-stop" }, { timeoutMs: 300 });
    expect(late.end).toEqual({ ok: false, code: "timeout" });
    expect(late.values).toEqual([{ started: true }, { stopped: true }]);
  });

  test("a program that stays through a stop is killed after the grace", async () => {
    const { programs, pids, log } = launcher({ stopGraceMs: 300 });
    const started = Date.now();
    const { end } = await run(programs, await program(), { do: "hang-through-a-stop" }, { timeoutMs: 300 });
    expect(end).toEqual({ ok: false, code: "timeout" });
    const took = Date.now() - started;
    // Not before the grace was over, and not long after it.
    expect(took).toBeGreaterThanOrEqual(550);
    expect(took).toBeLessThan(4_000);
    expect(alive(pids[0] as number)).toBe(false);
    expect(log.at(-1)?.fields).toMatchObject({ endedBy: "timeout", signal: "SIGKILL" });
  });

  test("when its caller aborts", async () => {
    const { programs, pids } = launcher({ stopGraceMs: 200 });
    const abort = new AbortController();
    const values: unknown[] = [];
    const running = run(programs, await program(), { do: "hang" }, {
      signal: abort.signal,
      onOutput: (value) => void values.push(value),
    });
    await until(() => values.length === 1, "the program to start");
    abort.abort();
    expect((await running).end).toEqual({ ok: false, code: "program_failed" });
    expect(alive(pids[0] as number)).toBe(false);
  });

  test("aborted before it was started, nothing is started", async () => {
    const { programs, pids, log } = launcher();
    const abort = new AbortController();
    abort.abort();
    const { end, input } = await run(programs, await program(), { do: "echo" }, { signal: abort.signal });
    expect(end).toEqual({ ok: false, code: "program_failed" });
    expect(pids).toEqual([]);
    expect(log).toEqual([]);
    expect(input.every((byte) => byte === 0)).toBe(true);
  });
});

describe("for which module, and how many", () => {
  test("nothing is started for a module that is not running", async () => {
    const { programs, pids } = launcher({ running: (moduleId) => moduleId === "stores" });
    expect((await run(programs, await program(), { do: "echo" })).end).toEqual({ ok: false, code: "module_not_running" });
    expect(pids).toEqual([]);
  });

  test("a module runs four at once, and a fifth is refused as busy until one has ended", async () => {
    expect(PROGRAMS_MAX_PER_MODULE).toBe(4);
    const { programs, pids } = launcher({ stopGraceMs: 200 });
    const file = await program();
    const aborts = Array.from({ length: 4 }, () => new AbortController());
    const started: unknown[] = [];
    const running = aborts.map((abort) =>
      run(programs, file, { do: "hang" }, { signal: abort.signal, onOutput: (value) => void started.push(value) }),
    );
    await until(() => started.length === 4, "four programs to start");
    expect(programs.count("databases")).toBe(4);
    expect((await run(programs, file, { do: "echo" })).end).toEqual({ ok: false, code: "busy" });
    expect(pids).toHaveLength(4);
    // Another module has its own four.
    expect((await run(programs, file, { do: "echo" }, { moduleId: "stores" })).end).toEqual({ ok: true });
    aborts[0]?.abort();
    await running[0];
    expect(programs.count("databases")).toBe(3);
    expect((await run(programs, file, { do: "echo" })).end).toEqual({ ok: true });
    for (const abort of aborts) abort.abort();
    await Promise.all(running);
    expect(programs.count("databases")).toBe(0);
  });

  test("a module's switch-off ends its programs and no other module's", async () => {
    const { programs, pids } = launcher({ stopGraceMs: 200 });
    const file = await program();
    const started: unknown[] = [];
    const onOutput = (value: unknown): void => void started.push(value);
    const mine = run(programs, file, { do: "hang" }, { onOutput });
    const theirs = run(programs, file, { do: "hang" }, { moduleId: "stores", onOutput });
    await until(() => started.length === 2, "two programs to start");
    await programs.endAll("databases");
    expect((await mine).end).toEqual({ ok: false, code: "program_failed" });
    expect(alive(pids[0] as number)).toBe(false);
    expect(alive(pids[1] as number)).toBe(true);
    expect(programs.count("stores")).toBe(1);
    await programs.endAll("stores");
    expect((await theirs).end).toEqual({ ok: false, code: "program_failed" });
  });

  test("the daemon's stop ends every program, and nothing is started after it", async () => {
    const { programs, pids } = launcher({ stopGraceMs: 200 });
    const file = await program();
    const started: unknown[] = [];
    const onOutput = (value: unknown): void => void started.push(value);
    const running = [
      run(programs, file, { do: "hang" }, { onOutput }),
      run(programs, file, { do: "hang-through-a-stop" }, { moduleId: "stores", onOutput }),
    ];
    await until(() => started.length === 2, "two programs to start");
    const asked = Date.now();
    await programs.endEvery();
    // One left when asked. The other stayed, and was killed after the grace.
    expect(Date.now() - asked).toBeLessThan(3_000);
    expect(pids.map(alive)).toEqual([false, false]);
    await Promise.all(running);
    expect((await run(programs, file, { do: "echo" })).end).toEqual({ ok: false, code: "busy" });
    expect(pids).toHaveLength(2);
  });

  test("a program that the machine does not let go holds the stop up no longer than the grace and the wait", async () => {
    // A child that never ends, whatever it is sent.
    const stuck: StartedProgram = {
      pid: 4_194_000,
      stdout: new ReadableStream<Uint8Array>(),
      stderr: new ReadableStream<Uint8Array>(),
      exited: new Promise<number>(() => {}),
      exitCode: null,
      signalCode: null,
      kill: () => {},
    };
    const { programs, log } = launcher({ spawn: () => stuck, stopGraceMs: 100, endWaitMs: 150 });
    void run(programs, await program(), { do: "hang" });
    await until(() => programs.count("databases") === 1, "the run to start");
    const asked = Date.now();
    await programs.endEvery();
    const took = Date.now() - asked;
    expect(took).toBeGreaterThanOrEqual(240);
    expect(took).toBeLessThan(2_000);
    expect(log.at(-1)).toMatchObject({
      level: "error",
      message: "a module's program was ended and is still there: the host goes on without it",
      fields: { module: "databases", program: "data-runner", waitedMs: 250 },
    });
  });
});

describe("a program that is not there", () => {
  test("no file, a folder, a file nobody may run, and a path that is not a whole one", async () => {
    const { programs, pids, log } = launcher();
    const dir = await folder();
    const plain = path.join(dir, "not-a-program");
    await writeFile(plain, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    await mkdir(path.join(dir, "a-folder"));
    for (const file of [path.join(dir, "nothing-here"), path.join(dir, "a-folder"), plain, "helper.ts", "./helper.ts", ""]) {
      expect([file, programInstalled(file)]).toEqual([file, false]);
      expect([file, (await run(programs, file, { do: "echo" })).end]).toEqual([
        file,
        { ok: false, code: "program_not_installed" },
      ]);
    }
    expect(pids).toEqual([]);
    // The log says that nothing was there. It does not say where.
    expect(log).toHaveLength(6);
    expect(new Set(log.map((line) => line.message))).toEqual(
      new Set(["no program was started for a module: there is no file at its path that can be run"]),
    );
    expect(JSON.stringify(log)).not.toContain(dir);
  });

  test("a file that may be run, and a link to one, are there", async () => {
    const file = await program();
    const link = path.join(await folder(), "a-link");
    await symlink(file, link);
    expect(programInstalled(file)).toBe(true);
    expect(programInstalled(link)).toBe(true);
    await chmod(file, 0o644);
    expect(programInstalled(file)).toBe(false);
    expect(programInstalled(link)).toBe(false);
  });

  test("a start that the machine refuses says whether anything was there to run", async () => {
    const file = await program();
    const refusing = (code: string): SpawnProgram => () => {
      throw Object.assign(new Error(`spawn ${file} failed`), { code });
    };
    for (const [code, word] of [
      ["ENOENT", "program_not_installed"],
      ["EACCES", "program_not_installed"],
      ["ENOEXEC", "program_not_installed"],
      ["EAGAIN", "program_failed"],
      ["EMFILE", "program_failed"],
    ] as const) {
      const { programs, log } = launcher({ spawn: refusing(code) });
      expect([code, (await run(programs, file, { do: "echo" })).end]).toEqual([code, { ok: false, code: word }]);
      expect(log).toEqual([
        {
          level: "error",
          message: "a program could not be started for a module",
          fields: { module: "databases", program: "data-runner", code },
        },
      ]);
      expect(programs.count("databases")).toBe(0);
    }
    // An error with no word of the machine's, or with a sentence in its place.
    const { programs, log } = launcher({
      spawn: () => {
        throw Object.assign(new Error("no"), { code: `could not run ${file}` });
      },
    });
    expect((await run(programs, file, { do: "echo" })).end).toEqual({ ok: false, code: "program_failed" });
    expect(log[0]?.fields).toEqual({ module: "databases", program: "data-runner", code: "unknown" });
  });
});

describe("how long a run may take", () => {
  test("what its caller names, held to thirty minutes, and five minutes when it names none", () => {
    expect(PROGRAM_DEFAULT_TIMEOUT_MS).toBe(5 * 60_000);
    expect(PROGRAM_MAX_TIMEOUT_MS).toBe(30 * 60_000);
    expect(programTimeoutMs(undefined)).toBe(PROGRAM_DEFAULT_TIMEOUT_MS);
    expect(programTimeoutMs(120_000)).toBe(120_000);
    expect(programTimeoutMs(0.4)).toBe(1);
    expect(programTimeoutMs(PROGRAM_MAX_TIMEOUT_MS + 1)).toBe(PROGRAM_MAX_TIMEOUT_MS);
    expect(programTimeoutMs(Number.POSITIVE_INFINITY)).toBe(PROGRAM_DEFAULT_TIMEOUT_MS);
    for (const none of [0, -5, Number.NaN, "60000", null, {}]) {
      expect([none, programTimeoutMs(none)]).toEqual([none, PROGRAM_DEFAULT_TIMEOUT_MS]);
    }
  });
});

describe("the list of programs", () => {
  test("is closed: one program, for one module, with its path's variable, its arguments and its variables", () => {
    expect(PROGRAMS).toEqual({
      "data-runner": {
        module: "databases",
        pathVariable: "FORTRESS_DATA_RUNNER",
        args: ["run", "--job-stdin"],
        env: { DB_IO_NAMES_ITSELF: "1" },
      },
    });
    expect(programFor("databases", "data-runner")).toBe(PROGRAMS["data-runner"] ?? null);
    // Another module has no program, and a word every object has is none.
    expect(programFor("stores", "data-runner")).toBeNull();
    expect(programFor("databases", "store-engine")).toBeNull();
    for (const word of ["toString", "constructor", "__proto__", "hasOwnProperty", ""]) {
      expect([word, programFor("databases", word)]).toEqual([word, null]);
    }
    for (const id of Object.keys(PROGRAMS)) expect(PROGRAM_ID_PATTERN.test(id)).toBe(true);
    for (const bad of ["Data-Runner", "data runner", "../data-runner", "-x", "9x", "x".repeat(33)]) {
      expect([bad, PROGRAM_ID_PATTERN.test(bad)]).toEqual([bad, false]);
    }
  });
});
