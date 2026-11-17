// A process of a module's own: this same program, started again with one word.
//
// A MODULE STARTS NO PROCESS. A lint rule fails the build on a file under
// `src/modules/<id>/` that tries. Where a module needs work that can be ended
// from outside (a statement that may run for ever), the host starts a process
// for it, and this file is the one place that does.
//
// WHAT CAN BE STARTED IS A CLOSED LIST. A word is a command of this program's
// own command line, compiled into the binary, and each word is for one module.
// The module that has a word adds its command to src/cli.ts. No manifest, ask,
// release or act can add a word, and a module can have started only a word
// that this list gives to it and that its own manifest names.
//
// WHAT THE PROCESS IS GIVEN. Its command line is this program and the word,
// with no shell: no path and no name is in the machine's list of processes.
// Its environment holds one variable, `SQLITE_TMPDIR`, set to a folder the
// module made inside its own folder for one organization, and nothing of the
// daemon's: no secret, no database address, no proxy. (The runtime adds two of
// its own for the channel, and takes them out again before the program's code
// runs.) It has no input and no output: what a module's process prints could
// hold a row's value, so nothing it prints is read or kept.
//
// IT RUNS IN THE MACHINE'S ROOT FOLDER, NOT IN THE MODULE'S. The runtime reads
// settings, variables and code from the folder a program starts in: a `.env`
// there adds variables, and a `bunfig.toml` there can name code that runs
// before the program's own. A module's folder holds what a module wrote for a
// client, so a program started there could be handed both. Only the machine's
// administrator can put a file into the root folder. The module's folder
// reaches the process as the value of its one variable.
//
// THE CHANNEL is the runtime's own between a parent and its child. No port is
// opened. Each value is passed through as it is: the host does not look at it,
// log it, count it or record it, because a value can hold rows. Nothing of a
// value is in a log line or in an error either: where a listener fails or a
// value cannot be sent, the log and the error hold one word.
//
// A PROCESS IS STARTED ONLY FOR A MODULE THAT IS RUNNING, and the host ends a
// module's processes when the module is switched off and when the daemon
// stops. It waits a bounded time for each end: a process that the machine does
// not let go holds up neither the switch nor the daemon's stop.
//
// WHAT THE HOST CANNOT DO is end a process when the daemon itself is killed.
// The process's channel closes then, and the word's own code must end when it
// does.
//
// A START MAKES NOTHING ON THE DISK. The caller checks that the folder is
// there before it calls. A start can end late, after its folder was removed on
// purpose, and a start that made its folder would put an empty one back.

import path from "node:path";

import { ProcessSendFailed, type ModuleProcess, type ProcessEnd } from "./module-contract";
import type { ScopedLogger } from "./types";

export { PROCESS_WORDS, PROCESS_WORD_PATTERN, processWordFor } from "./process-words";

/** How many processes of one module run at once. */
export const PROCESSES_MAX_PER_MODULE = 32;

/** The one variable a module's process is given. SQLite puts its temporary
 *  files where it names. */
export const PROCESS_TMPDIR_VARIABLE = "SQLITE_TMPDIR";

/** The folder a module's process runs in: see the top of this file. */
export const PROCESS_WORKING_FOLDER = "/";

/** How long the host waits for processes it ended, before it goes on. A
 *  process ended by the signal that cannot be refused is gone in a moment,
 *  unless the machine holds it. */
export const PROCESS_END_WAIT_MS = 5_000;

/** This program's own command line, where it runs from its sources. */
const CLI_ENTRY = path.join(import.meta.dir, "..", "cli.ts");

/**
 * This program, as a command that starts it again. Null where what runs is
 * not this program's command line: a test, or a script that loads a part of
 * it. Nothing is started there, because the command would start that file.
 *
 * Compiled into one binary, the binary is the whole command, and the runtime
 * names the entry as a path inside the binary's own file system. Run from its
 * sources, the command is the runtime and the entry file. Measured on Bun
 * 1.3.14 in both ways.
 */
export function selfCommand(
  execPath: string = process.execPath,
  entry: string = Bun.main,
  cli: string = CLI_ENTRY,
): string[] | null {
  if (entry.startsWith("/$bunfs/")) return [execPath];
  return entry === cli ? [execPath, entry] : null;
}

/** What the runtime hands back for a started child. A seam for tests. */
export interface StartedChild {
  send(message: unknown): unknown;
  kill(signal: "SIGKILL"): void;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly pid: number;
}

export interface SpawnOptions {
  cwd: string;
  env: Record<string, string>;
  onMessage: (message: unknown) => void;
}

export type SpawnChild = (command: readonly string[], options: SpawnOptions) => StartedChild;

/** Start a child with the runtime: no shell, no input, no output, and the
 *  runtime's own channel with bytes crossing as bytes. */
export const spawnWithRuntime: SpawnChild = (command, options) =>
  Bun.spawn([...command], {
    cwd: options.cwd,
    // The whole environment: nothing of this process's own is passed on.
    env: options.env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    serialization: "advanced",
    ipc: (message) => options.onMessage(message),
  }) as unknown as StartedChild;

export interface ModuleProcessesDeps {
  /** This program, as a command to start it again: the binary, and where it
   *  runs from its sources the runtime and the entry file. Null where what
   *  runs is not this program's command line. */
  self: () => readonly string[] | null;
  /** Whether a module is running: its own start has ended, and its stop has
   *  not begun. A process is started for no other. */
  running: (moduleId: string) => boolean;
  logger: ScopedLogger;
  /** A seam for tests. */
  spawn?: SpawnChild;
  /** How many of one module run at once. A seam for tests. */
  maxPerModule?: number;
  /** How long an end is waited for. A seam for tests. */
  endWaitMs?: number;
}

/** Thrown by `start` when the module already runs as many as it may, and when
 *  the daemon is stopping. */
export class ProcessesBusy extends Error {
  constructor() {
    super("the module already runs as many processes as it may");
    this.name = "ProcessesBusy";
  }
}

/** Thrown by `start` for a module that is not running. */
export class ModuleNotRunning extends Error {
  constructor() {
    super("the module is not running");
    this.name = "ModuleNotRunning";
  }
}

/** Thrown by `start` when the program could not be started. `code` is the
 *  machine's word for why, or one of this file's own. It holds no path. */
export class ProcessNotStarted extends Error {
  constructor(readonly code: string) {
    super(`the program could not be started: ${code}`);
    this.name = "ProcessNotStarted";
  }
}

interface Running {
  moduleId: string;
  word: string;
  child: StartedChild;
  gone: boolean;
}

/** The machine's word for an error of the runtime, and nothing else of it: an
 *  error's message can hold a path, or say what a value was. */
function codeOf(thrown: unknown): string {
  const code = (thrown as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "unknown";
}

/**
 * The processes the host runs for modules.
 *
 * Which word and which folder a module may have is checked by the module's
 * context (module-context.ts), which then calls `start`. This class holds the
 * count for each module, starts a process only for a module that is running,
 * and ends what is running when a module is switched off and when the daemon
 * stops.
 */
export class ModuleProcesses {
  private readonly running = new Set<Running>();
  private readonly spawn: SpawnChild;
  private readonly maxPerModule: number;
  private readonly endWaitMs: number;
  /** After `endEvery`: nothing is started any more. */
  private closed = false;

  constructor(private readonly deps: ModuleProcessesDeps) {
    this.spawn = deps.spawn ?? spawnWithRuntime;
    this.maxPerModule = deps.maxPerModule ?? PROCESSES_MAX_PER_MODULE;
    this.endWaitMs = deps.endWaitMs ?? PROCESS_END_WAIT_MS;
  }

  /** How many processes of a module are running now. */
  count(moduleId: string): number {
    let count = 0;
    for (const entry of this.running) if (entry.moduleId === moduleId && !entry.gone) count += 1;
    return count;
  }

  /**
   * Start `word` for a module, and give it `dir`, which is there already.
   *
   * Throws `ModuleNotRunning` for a module that is not running, `ProcessesBusy`
   * when the module runs as many as it may and when the daemon is stopping,
   * and `ProcessNotStarted` when the program could not be started.
   *
   * No `await` is in here. So the check that the module is running and the
   * start are one step, and `endAll`, which a module's switch-off calls after
   * the module has stopped, ends every process that was ever started for it.
   */
  start(moduleId: string, word: string, dir: string, onMessage: (message: unknown) => unknown): ModuleProcess {
    if (!this.deps.running(moduleId)) throw new ModuleNotRunning();
    if (this.closed || this.count(moduleId) >= this.maxPerModule) throw new ProcessesBusy();
    const self = this.deps.self();
    if (self === null) {
      this.say("error", "no process was started for a module: what runs here is not this program's command line", {
        module: moduleId,
        word,
      });
      throw new ProcessNotStarted("not_this_program");
    }
    const failed = (): void =>
      this.say("error", "a module's listener failed on a value from its process", { module: moduleId, word });
    let child: StartedChild;
    try {
      child = this.spawn([...self, word], {
        cwd: PROCESS_WORKING_FOLDER,
        env: { [PROCESS_TMPDIR_VARIABLE]: dir },
        onMessage: (message) => {
          // A listener's failure is its own. It does not reach the runtime's
          // channel, where it would be an error of the daemon, and nothing of
          // it is logged: what it says can hold the value. That goes for a
          // listener that answers a promise too.
          try {
            const answer = onMessage(message);
            if (typeof (answer as { then?: unknown } | null | undefined)?.then === "function") {
              Promise.resolve(answer).then(undefined, failed);
            }
          } catch {
            failed();
          }
        },
      });
    } catch (thrown) {
      const code = codeOf(thrown);
      this.say("error", "the program could not be started for a module", { module: moduleId, word, code });
      throw new ProcessNotStarted(code);
    }
    const entry: Running = { moduleId, word, gone: false, child };
    this.running.add(entry);
    this.say("info", "started a process for a module", { module: moduleId, word, pid: child.pid });
    const exited: Promise<ProcessEnd> = child.exited.then(
      (code): ProcessEnd => (child.signalCode ? { signal: child.signalCode } : { code }),
      (): ProcessEnd => ({ code: -1 }),
    );
    void exited.then((end) => {
      entry.gone = true;
      this.running.delete(entry);
      this.say("info", "a module's process ended", { module: moduleId, word, ...end });
    });
    return {
      send: (message) => {
        if (entry.gone) return;
        try {
          child.send(message);
        } catch (thrown) {
          const closed = codeOf(thrown) === "ERR_IPC_CHANNEL_CLOSED";
          // The process went between the check and the send.
          if (closed && (entry.gone || child.exitCode !== null || child.signalCode !== null)) return;
          // The runtime's own error says what the value was. This one does not.
          throw new ProcessSendFailed(closed ? "channel_closed" : "value_unsendable");
        }
      },
      kill: () => this.end(entry),
      exited,
    };
  }

  /** End every process of one module that is still running, and wait for each
   *  to be gone, at most `PROCESS_END_WAIT_MS`. For a module that is switched
   *  off. Never rejects. */
  async endAll(moduleId: string): Promise<void> {
    await this.endWhere((entry) => entry.moduleId === moduleId);
  }

  /** End every process, and start no other. For the daemon's stop. Never
   *  rejects, and never waits longer than `PROCESS_END_WAIT_MS`. */
  async endEvery(): Promise<void> {
    this.closed = true;
    await this.endWhere(() => true);
  }

  private async endWhere(which: (entry: Running) => boolean): Promise<void> {
    const ending = [...this.running].filter(which);
    if (ending.length === 0) return;
    for (const entry of ending) this.end(entry);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), this.endWaitMs);
    });
    const gone = Promise.all(ending.map((entry) => entry.child.exited.catch(() => undefined))).then(() => "gone" as const);
    const waited = await Promise.race([gone, late]);
    clearTimeout(timer);
    if (waited === "gone") return;
    // Ended, and still there: the machine holds it. What waits on this (a
    // module's switch, the daemon's stop) goes on. The process still counts
    // against its module until it is gone.
    for (const entry of ending) {
      if (entry.gone || entry.child.exitCode !== null || entry.child.signalCode !== null) continue;
      this.say("error", "a module's process was ended and is still there: the host goes on without it", {
        module: entry.moduleId,
        word: entry.word,
        pid: entry.child.pid,
        waitedMs: this.endWaitMs,
      });
    }
  }

  private end(entry: Running): void {
    if (entry.gone) return;
    try {
      entry.child.kill("SIGKILL");
    } catch {
      // Gone already.
    }
  }

  private say(level: "info" | "error", message: string, fields: Record<string, unknown>): void {
    try {
      // `level` is one of two method names, both written in this file.
      // eslint-disable-next-line security/detect-object-injection
      this.deps.logger[level](message, fields);
    } catch {
      // A log that is full or gone stops no process.
    }
  }
}
