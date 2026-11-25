// A helper program the host runs for a module: another binary on this
// machine, given one job on its standard input.
//
// A MODULE STARTS NO PROCESS AND OPENS NO SOCKET. A lint rule fails the build
// on a file under `src/modules/<id>/` that tries. Where a module needs a
// database reached, the host starts a program that does it, and this file is
// the one place that does.
//
// WHAT CAN BE STARTED IS A CLOSED LIST (program-list.ts). Which program, which
// path, which arguments and which variables are the list's. A module chooses
// none of them. Who may have which program run, and what goes into its job, is
// decided by the module's context (module-context.ts), which then calls `run`.
//
// WHAT THE PROGRAM IS GIVEN. Its command line is its own path and the list's
// arguments, with no shell. Its environment is what the caller hands over and
// nothing of the daemon's besides: no secret, no database address, no proxy.
// Its job goes to its standard input, which is then closed. So a login is in
// no command line and in no variable, where the machine's list of processes
// would show it.
//
// WHAT COMES BACK. The program prints JSON on its standard output, one value
// to a line. Each value is handed to the caller's listener as it is: the host
// does not look into it, log it or record it, because it can hold rows. It
// counts the bytes, for the limit. What the program prints on its error
// output goes to the daemon's log, up to a limit of bytes and of lines, with
// anything that looks like a credential replaced.
//
// IT IS ENDED FROM OUTSIDE when its time is up, when its caller aborts, when
// its module is switched off and when the daemon stops. It is asked first
// (SIGTERM), so that a program in the middle of a write can give its
// transaction up and say so, and it is killed a few seconds later if it is
// still there.
//
// A RUN THAT THE HOST ENDED IS NEVER ANSWERED AS ONE THAT WENT WELL, whatever
// the program printed when it was asked to stop and however it left. What it
// printed still reaches the listener.
//
// IT RUNS IN THE MACHINE'S ROOT FOLDER, like a module's own process: a folder
// that only the machine's administrator can put a file into.
//
// WHAT THE HOST CANNOT DO is end a program when the daemon itself is killed.
// The program's output then has nowhere to go, and a program that stops at
// its job's own deadline ends by itself.

import { statSync } from "node:fs";
import path from "node:path";

import { redactCredentials } from "../ui/redact";
import type { ScopedLogger } from "./types";

export { PROGRAMS, PROGRAM_ID_PATTERN, programFor, type ProgramEntry } from "./program-list";

/** How many programs of one module run at once. */
export const PROGRAMS_MAX_PER_MODULE = 4;
/** How long one run may take when its caller names no time. */
export const PROGRAM_DEFAULT_TIMEOUT_MS = 5 * 60_000;
/** The longest one run may take, whatever its caller names. */
export const PROGRAM_MAX_TIMEOUT_MS = 30 * 60_000;
/** The most a program may print on its standard output in one run. */
export const PROGRAM_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
/** The most of a program's error output that goes into the log, for one run. */
export const PROGRAM_ERROR_OUTPUT_MAX_BYTES = 64 * 1024;
/** The most lines of it. Each line is one record of the log, so the bytes
 *  alone would allow tens of thousands of records for one run. */
export const PROGRAM_ERROR_OUTPUT_MAX_LINES = 1_000;
/** How long a program that was asked to stop has before it is killed. */
export const PROGRAM_STOP_GRACE_MS = 5_000;
/** How long the host waits for programs it killed, before it goes on. A
 *  process that was killed is gone at once, unless the machine does not let
 *  it go. */
export const PROGRAM_END_WAIT_MS = 2_000;
/** The folder a program runs in: see the top of this file. */
export const PROGRAM_WORKING_FOLDER = "/";

/** The longest piece of a program's error output that is one line of the log. */
const ERROR_LINE_MAX_CHARS = 2_000;
/** How long what a program printed before it ended is read for, once it has
 *  ended. A pipe that something else holds open does not hold a run up. */
const PIPE_DRAIN_MS = 2_000;

/** How a run that did not go well ended, as far as this file can tell. */
export type ProgramRunFailure =
  /** The module is not running: nothing is started for it. */
  | "module_not_running"
  /** The module already runs as many as it may, or the daemon is stopping. */
  | "busy"
  /** There is no file to run at the program's path, or it cannot be run. */
  | "program_not_installed"
  /** The run's time was up. The program was ended. */
  | "timeout"
  /** The program could not be started, ended badly, was ended before it was
   *  done, or printed what is not JSON or more than it may. */
  | "program_failed";

export type ProgramRunEnd = { ok: true } | { ok: false; code: ProgramRunFailure };

export interface ProgramStart {
  moduleId: string;
  /** The program's id, for the log. */
  program: string;
  /** The program's file: an absolute path. */
  path: string;
  args: readonly string[];
  /** The program's whole environment. */
  env: Readonly<Record<string, string>>;
  /** What the program reads from its standard input. It can hold a login: it
   *  is written to the program and nowhere else, and it is overwritten with
   *  zeros when the run has ended. */
  input: Uint8Array;
  /** Called with each JSON value the program prints. */
  onOutput: (value: unknown) => unknown;
  /** How long the run may take. Held to `PROGRAM_MAX_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Aborted to have the program ended. */
  signal?: AbortSignal;
  /**
   * Called with how the run ended, before `run` answers. The launcher waits
   * for it, also when it ends a module's programs and at the daemon's stop:
   * the caller completes the record of the run here. Its failure is its own.
   */
  afterEnd?: (end: ProgramRunEnd) => Promise<void> | void;
}

/** What the runtime hands back for a started program. A seam for tests. */
export interface StartedProgram {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}

export interface SpawnProgramOptions {
  cwd: string;
  env: Record<string, string>;
  input: Uint8Array;
}

export type SpawnProgram = (command: readonly string[], options: SpawnProgramOptions) => StartedProgram;

/** Start a program with the runtime: no shell, the input on its standard
 *  input, which is then closed, and its two outputs as pipes. */
export const spawnProgramWithRuntime: SpawnProgram = (command, options) =>
  Bun.spawn([...command], {
    cwd: options.cwd,
    // The whole environment: nothing of this process's own is passed on.
    env: options.env,
    stdin: options.input,
    stdout: "pipe",
    stderr: "pipe",
  }) as unknown as StartedProgram;

export interface ModuleProgramsDeps {
  /** Whether a module is running: its own start has ended, and its stop has
   *  not begun. A program is started for no other. */
  running: (moduleId: string) => boolean;
  logger: ScopedLogger;
  /** Seams for tests. */
  spawn?: SpawnProgram;
  maxPerModule?: number;
  outputMaxBytes?: number;
  errorOutputMaxBytes?: number;
  errorOutputMaxLines?: number;
  stopGraceMs?: number;
  endWaitMs?: number;
}

/** Why the host ended a program: its time was up, its caller gave it up, it
 *  printed what it may not, or its module was switched off or the daemon
 *  stopped. */
type RunEnd = "timeout" | "aborted" | "output" | "stopped";

interface Run {
  moduleId: string;
  program: string;
  child: StartedProgram;
  gone: boolean;
  /** Set once the program was asked to stop: the timer that kills it. */
  kill: ReturnType<typeof setTimeout> | null;
  /** Why the host ended the program, when it did. The first reason stays. */
  ended: RunEnd | null;
  /** True once the run has its answer. Nothing that is printed after that
   *  reaches the listener or the log. */
  answered: boolean;
}

/** The time one run may take: what was asked for when that is a time, held to
 *  the longest a run may take. */
export function programTimeoutMs(asked: unknown): number {
  if (typeof asked !== "number" || !Number.isFinite(asked) || asked <= 0) return PROGRAM_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.ceil(asked), PROGRAM_MAX_TIMEOUT_MS);
}

/** Whether there is a file at the path that can be run: an absolute path to a
 *  file that somebody may execute. A link to such a file is one. */
export function programInstalled(file: string): boolean {
  if (typeof file !== "string" || file.length === 0 || !path.isAbsolute(file)) return false;
  try {
    // The path is the install's own setting, read from the daemon's
    // environment. No module, ask or act names it.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const info = statSync(file);
    return info.isFile() && (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** The machine's word for an error of the runtime, and nothing else of it: an
 *  error's message can hold a path. */
function codeOf(thrown: unknown): string {
  const code = (thrown as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "unknown";
}

/** Errors of a start that mean "there is nothing here that can be run". */
const NOT_RUNNABLE = new Set(["ENOENT", "EACCES", "ENOEXEC", "ENOTDIR", "EPERM", "ELOOP"]);

const failed = (code: ProgramRunFailure): ProgramRunEnd => ({ ok: false, code });

/**
 * The programs the host runs for modules.
 *
 * This class holds the count for each module, starts a program only for a
 * module that is running, ends a program whose time is up or whose caller
 * aborts, and ends what is running when a module is switched off and when the
 * daemon stops.
 */
export class ModulePrograms {
  private readonly runs = new Set<Run>();
  /** Every call of `run` that has not answered yet, with what follows it. */
  private readonly closing = new Set<{ moduleId: string; whole: Promise<unknown> }>();
  private readonly spawn: SpawnProgram;
  private readonly maxPerModule: number;
  private readonly outputMaxBytes: number;
  private readonly errorOutputMaxBytes: number;
  private readonly errorOutputMaxLines: number;
  private readonly stopGraceMs: number;
  private readonly endWaitMs: number;
  /** After `endEvery`: nothing is started any more. */
  private closed = false;

  constructor(private readonly deps: ModuleProgramsDeps) {
    this.spawn = deps.spawn ?? spawnProgramWithRuntime;
    this.maxPerModule = deps.maxPerModule ?? PROGRAMS_MAX_PER_MODULE;
    this.outputMaxBytes = deps.outputMaxBytes ?? PROGRAM_OUTPUT_MAX_BYTES;
    this.errorOutputMaxBytes = deps.errorOutputMaxBytes ?? PROGRAM_ERROR_OUTPUT_MAX_BYTES;
    this.errorOutputMaxLines = deps.errorOutputMaxLines ?? PROGRAM_ERROR_OUTPUT_MAX_LINES;
    this.stopGraceMs = deps.stopGraceMs ?? PROGRAM_STOP_GRACE_MS;
    this.endWaitMs = deps.endWaitMs ?? PROGRAM_END_WAIT_MS;
  }

  /** How many programs of a module are running now. */
  count(moduleId: string): number {
    let count = 0;
    for (const run of this.runs) if (run.moduleId === moduleId && !run.gone) count += 1;
    return count;
  }

  /**
   * Why nothing would be started for this module at this moment, or null.
   * These are the two checks `run` makes before a start. A caller asks here
   * first, so that it reads nothing for a run that would not be made.
   */
  refusal(moduleId: string): "module_not_running" | "busy" | null {
    if (!this.deps.running(moduleId)) return "module_not_running";
    if (this.closed || this.count(moduleId) >= this.maxPerModule) return "busy";
    return null;
  }

  /**
   * Run one program to its end, and then do what its caller wants done with
   * how it ended (`afterEnd`). Never rejects.
   *
   * Nothing is awaited between the check that the module is running and the
   * start. So `endAll`, which a module's switch-off calls after the module has
   * stopped, ends every program that was ever started for it.
   */
  run(start: ProgramStart): Promise<ProgramRunEnd> {
    const whole = this.runAndClose(start);
    const entry = { moduleId: start.moduleId, whole };
    this.closing.add(entry);
    void whole.then(() => this.closing.delete(entry));
    return whole;
  }

  private async runAndClose(start: ProgramStart): Promise<ProgramRunEnd> {
    const end = await this.runOnce(start);
    try {
      await start.afterEnd?.(end);
    } catch {
      // Its failure is its own. Nothing of it is logged: it can hold a path.
      this.say("error", "what follows a run of a module's program failed", {
        module: start.moduleId,
        program: start.program,
      });
    }
    return end;
  }

  private async runOnce(start: ProgramStart): Promise<ProgramRunEnd> {
    const { moduleId, program } = start;
    try {
      const refusal = this.refusal(moduleId);
      if (refusal !== null) return failed(refusal);
      // What ends a run is a signal or nothing. Anything else is refused
      // here, before a start: a program must never be left with nobody
      // attending it.
      if (start.signal !== undefined && !(start.signal instanceof AbortSignal)) return failed("program_failed");
      if (typeof start.onOutput !== "function" || !(start.input instanceof Uint8Array)) return failed("program_failed");
      // Aborted before anything was started: nothing is.
      if (start.signal?.aborted) return failed("program_failed");
      if (!programInstalled(start.path)) {
        this.say("error", "no program was started for a module: there is no file at its path that can be run", {
          module: moduleId,
          program,
        });
        return failed("program_not_installed");
      }
      let child: StartedProgram;
      try {
        child = this.spawn([start.path, ...start.args], {
          cwd: PROGRAM_WORKING_FOLDER,
          env: { ...start.env },
          input: start.input,
        });
      } catch (thrown) {
        const code = codeOf(thrown);
        this.say("error", "a program could not be started for a module", { module: moduleId, program, code });
        return failed(NOT_RUNNABLE.has(code) ? "program_not_installed" : "program_failed");
      }
      return await this.attend(start, child);
    } catch {
      // Nothing above is meant to throw. What was thrown is not looked at: it
      // can hold a path or a piece of the job.
      this.say("error", "a run of a module's program failed on this side", { module: moduleId, program });
      return failed("program_failed");
    } finally {
      // The job can hold a login. This copy of it is of no use any more.
      try {
        start.input.fill(0);
      } catch {
        // A caller's own read-only bytes.
      }
    }
  }

  /** Stay with a started program until it has ended, and say how it went. */
  private async attend(start: ProgramStart, child: StartedProgram): Promise<ProgramRunEnd> {
    const { moduleId, program } = start;
    const run: Run = { moduleId, program, child, gone: false, kill: null, ended: null, answered: false };
    this.runs.add(run);
    const startedAt = Date.now();
    this.say("info", "started a program for a module", { module: moduleId, program, pid: child.pid });

    const end = (why: RunEnd): void => this.stop(run, why);
    const timer = setTimeout(() => end("timeout"), programTimeoutMs(start.timeoutMs));
    const onAbort = (): void => end("aborted");
    start.signal?.addEventListener("abort", onAbort, { once: true });
    // Aborted between the check before the start and this listener.
    if (start.signal?.aborted) onAbort();

    const printed = this.readOutput(run, start.onOutput, () => end("output"));
    const said = this.readErrors(run);
    let code: number;
    try {
      code = await child.exited;
    } catch {
      code = -1;
    }
    run.gone = true;
    this.runs.delete(run);
    clearTimeout(timer);
    if (run.kill !== null) clearTimeout(run.kill);
    start.signal?.removeEventListener("abort", onAbort);

    // What the program printed before it ended is still in its pipes.
    let late: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      Promise.all([printed, said]).then(([whole]) => whole),
      new Promise<null>((resolve) => {
        late = setTimeout(() => resolve(null), PIPE_DRAIN_MS);
      }),
    ]);
    clearTimeout(late);
    // The run has its answer from here on. What a process that the program
    // left behind still prints into the same pipes reaches nobody.
    run.answered = true;

    const signal = child.signalCode;
    const ended = run.ended;
    this.say("info", "a module's program ended", {
      module: moduleId,
      program,
      ...(signal ? { signal } : { code }),
      ...(ended === null ? {} : { endedBy: ended }),
      ms: Date.now() - startedAt,
    });
    if (ended === "timeout") return failed("timeout");
    // ENDED BY THE HOST BEFORE IT WAS DONE: that is how the run ended, whatever
    // the program said when it was asked to stop and however it left. DB IO
    // answers a stop by printing its failure and leaving with 0.
    // `drained` is `null` when its output could not be read to the end, and
    // `false` when it printed what is not JSON, or more than it may.
    if (ended !== null || drained !== true) return failed("program_failed");
    return code === 0 && !signal ? { ok: true } : failed("program_failed");
  }

  /**
   * Read what the program prints on its standard output, and hand each JSON
   * value to the listener. Answers whether all of it was JSON and within the
   * limit. Never rejects.
   *
   * Nothing of what is read is logged, here or anywhere: it can hold rows.
   */
  private async readOutput(run: Run, onOutput: (value: unknown) => unknown, bad: () => void): Promise<boolean> {
    const listenerFailed = (): void =>
      this.say("error", "a module's listener failed on its program's output", {
        module: run.moduleId,
        program: run.program,
      });
    let good = true;
    const line = (bytes: Uint8Array): void => {
      if (run.answered) return;
      let value: unknown;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (text.trim() === "") return;
        value = JSON.parse(text);
      } catch {
        good = false;
        return;
      }
      // A listener's failure is its own. Nothing of it is logged: what it
      // says can hold the value. That goes for a listener that answers a
      // promise too.
      try {
        const answer = onOutput(value);
        if (typeof (answer as { then?: unknown } | null | undefined)?.then === "function") {
          Promise.resolve(answer).then(undefined, listenerFailed);
        }
      } catch {
        listenerFailed();
      }
    };

    let total = 0;
    let pending: Uint8Array[] = [];
    const flush = (last: Uint8Array): void => {
      pending.push(last);
      line(pending.length === 1 ? last : Buffer.concat(pending));
      pending = [];
    };
    try {
      for await (const chunk of run.child.stdout) {
        if (run.answered) break;
        total += chunk.byteLength;
        if (total > this.outputMaxBytes) {
          good = false;
          break;
        }
        let from = 0;
        for (;;) {
          const at = chunk.indexOf(0x0a, from);
          if (at < 0) break;
          flush(chunk.subarray(from, at));
          from = at + 1;
          if (!good) break;
        }
        if (!good) break;
        if (from < chunk.byteLength) pending.push(chunk.subarray(from));
      }
    } catch {
      good = false;
    }
    if (!good) {
      // More than it may print, or not JSON: the program is ended.
      bad();
      return false;
    }
    // A last line with no line end after it.
    if (pending.length > 0) flush(new Uint8Array(0));
    if (!good) bad();
    return good;
  }

  /**
   * Read what the program prints on its error output into the daemon's log,
   * line by line, up to the limit. The rest is read and dropped, so that a
   * program is never held up by a full pipe. Never rejects.
   */
  private async readErrors(run: Run): Promise<void> {
    const fields = { module: run.moduleId, program: run.program };
    const decoder = new TextDecoder();
    let kept = 0;
    /** How many lines of it went into the log. */
    let logged = 0;
    let dropped = false;
    let rest = "";
    const drop = (): void => {
      if (dropped) return;
      dropped = true;
      this.say("warn", "the rest of a program's error output is dropped", { ...fields, keptBytes: kept });
    };
    const emit = (text: string): void => {
      const line = text.trim();
      if (line === "" || run.answered) return;
      if (logged >= this.errorOutputMaxLines) {
        drop();
        return;
      }
      logged += 1;
      this.say("info", "a module's program says", { ...fields, line: redactCredentials(line).slice(0, ERROR_LINE_MAX_CHARS) });
    };
    try {
      for await (const chunk of run.child.stderr) {
        if (run.answered) break;
        const room = this.errorOutputMaxBytes - kept;
        if (room <= 0 || logged >= this.errorOutputMaxLines) {
          drop();
          continue;
        }
        const take = chunk.byteLength <= room ? chunk : chunk.subarray(0, room);
        kept += take.byteLength;
        rest += decoder.decode(take, { stream: true });
        const lines = rest.split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) emit(line);
        if (take.byteLength < chunk.byteLength) drop();
      }
    } catch {
      // A pipe that broke: what was read is in the log.
    }
    emit(rest);
  }

  /** End every program of one module that is still running: ask each to
   *  stop, and kill what is still there after the grace. For a module that is
   *  switched off. Never rejects. */
  async endAll(moduleId: string): Promise<void> {
    await this.endWhere((id) => id === moduleId);
  }

  /** End every program, and start no other. For the daemon's stop. Never
   *  rejects, and never waits longer than the grace and `PROGRAM_END_WAIT_MS`. */
  async endEvery(): Promise<void> {
    this.closed = true;
    await this.endWhere(() => true);
  }

  private async endWhere(which: (moduleId: string) => boolean): Promise<void> {
    const ending = [...this.runs].filter((run) => which(run.moduleId));
    // One limit for all of it: the grace each program has, and then the wait
    // for the ones that were killed.
    const waitMs = this.stopGraceMs + this.endWaitMs;
    const deadline = Date.now() + waitMs;
    for (const run of ending) this.stop(run, "stopped");
    if (ending.length > 0) {
      const gone = Promise.all(ending.map((run) => run.child.exited.catch(() => undefined))).then(() => "gone" as const);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<"late">((resolve) => {
        timer = setTimeout(() => resolve("late"), waitMs);
      });
      const waited = await Promise.race([gone, late]);
      clearTimeout(timer);
      if (waited === "late") {
        for (const run of ending) {
          if (run.gone || run.child.exitCode !== null || run.child.signalCode !== null) continue;
          this.say("error", "a module's program was ended and is still there: the host goes on without it", {
            module: run.moduleId,
            program: run.program,
            pid: run.child.pid,
            waitedMs: waitMs,
          });
        }
      }
    }
    // WHAT FOLLOWS EACH RUN IS WAITED FOR TOO, within the same limit: its
    // caller completes the run's record there. So a module's switch-off and
    // the daemon's stop go on only once the record of every run that has
    // ended has its second half.
    const closing = [...this.closing].filter((entry) => which(entry.moduleId)).map((entry) => entry.whole);
    const left = deadline - Date.now();
    if (closing.length === 0 || left <= 0) return;
    let limit: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(closing),
      new Promise<void>((resolve) => {
        limit = setTimeout(resolve, left);
      }),
    ]);
    clearTimeout(limit);
  }

  /** Ask a program to stop, and kill it after the grace if it is still there.
   *  `why` is kept as how the run ended, when it is the first reason. */
  private stop(run: Run, why: RunEnd): void {
    if (run.gone) return;
    if (run.ended === null) run.ended = why;
    if (run.kill !== null) return;
    const signal = (which: "SIGTERM" | "SIGKILL"): void => {
      try {
        run.child.kill(which);
      } catch {
        // Gone already.
      }
    };
    signal("SIGTERM");
    run.kill = setTimeout(() => {
      if (!run.gone) signal("SIGKILL");
    }, this.stopGraceMs);
  }

  private say(level: "info" | "warn" | "error", message: string, fields: Record<string, unknown>): void {
    try {
      // `level` is one of three method names, all written in this file.
      // eslint-disable-next-line security/detect-object-injection
      this.deps.logger[level](message, fields);
    } catch {
      // A log that is full or gone stops no program.
    }
  }
}
