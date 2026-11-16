// A process of a module's own: this same program, started again with one word.
//
// A MODULE STARTS NO PROCESS. A lint rule fails the build on a file under
// `src/modules/<id>/` that tries. Where a module needs work that can be ended
// from outside (a statement that may run for ever), the host starts a process
// for it, and this file is the one place that does.
//
// WHAT CAN BE STARTED IS A CLOSED LIST. A word is a command of this program's
// own command line (src/cli.ts), compiled into the binary, and each word is
// for one module. No manifest, ask, release or act can add a word, and a module
// can have started only a word that this list gives to it and that its own
// manifest names.
//
// WHAT THE PROCESS IS GIVEN. Its command line is this program and the word,
// with no shell: no path and no name is in the machine's list of processes.
// Its working folder is one the module made, inside its own folder for one
// organization. Its environment holds one variable, `SQLITE_TMPDIR`, set to
// that folder, and nothing of the daemon's: no secret, no database address, no
// proxy. It has no input and no output: what a module's process prints could
// hold a row's value, so nothing it prints is read or kept.
//
// THE CHANNEL is the runtime's own between a parent and its child. No port is
// opened. Each value is passed through as it is: the host does not look at it,
// log it, count it or record it, because a value can hold rows.
//
// A START MAKES NOTHING ON THE DISK. The caller checks that the folder is
// there before it calls. A start can end late, after its folder was removed on
// purpose, and a start that made its folder would put an empty one back.

import type { ModuleProcess, ProcessEnd } from "./module-contract";
import type { ScopedLogger } from "./types";

export { PROCESS_WORDS, PROCESS_WORD_PATTERN, processWordFor } from "./process-words";

/** How many processes of one module run at once. */
export const PROCESSES_MAX_PER_MODULE = 32;

/** The one variable a module's process is given. SQLite puts its temporary
 *  files where it names. */
export const PROCESS_TMPDIR_VARIABLE = "SQLITE_TMPDIR";

/**
 * This program, as a command that starts it again.
 *
 * Compiled into one binary, the binary is the whole command, and the runtime
 * names the entry as a path inside the binary's own file system. Run from its
 * sources, the command is the runtime and the entry file. Measured on Bun
 * 1.3.14 in both ways.
 */
export function selfCommand(execPath: string = process.execPath, entry: string = Bun.main): string[] {
  return entry.startsWith("/$bunfs/") ? [execPath] : [execPath, entry];
}

/** What the runtime hands back for a started child. A seam for tests. */
export interface StartedChild {
  send(message: unknown): void;
  kill(signal: "SIGKILL"): void;
  readonly exited: Promise<number>;
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
   *  runs from its sources the runtime and the entry file. */
  self: () => readonly string[];
  logger: ScopedLogger;
  /** A seam for tests. */
  spawn?: SpawnChild;
  /** How many of one module run at once. A seam for tests. */
  maxPerModule?: number;
}

/** Thrown by `start` when the module already runs as many as it may. */
export class ProcessesBusy extends Error {
  constructor() {
    super("the module already runs as many processes as it may");
    this.name = "ProcessesBusy";
  }
}

interface Running {
  moduleId: string;
  word: string;
  child: StartedChild;
  gone: boolean;
}

/**
 * The processes the host runs for modules.
 *
 * It decides nothing about who may start what: the context of a module checks
 * the word and the folder (module-context.ts) and then calls `start`. It holds
 * the count for each module, and it ends what is running when a module is
 * switched off and when the daemon stops.
 */
export class ModuleProcesses {
  private readonly running = new Set<Running>();
  private readonly spawn: SpawnChild;
  private readonly maxPerModule: number;
  /** After `endEvery`: nothing is started any more. */
  private closed = false;

  constructor(private readonly deps: ModuleProcessesDeps) {
    this.spawn = deps.spawn ?? spawnWithRuntime;
    this.maxPerModule = deps.maxPerModule ?? PROCESSES_MAX_PER_MODULE;
  }

  /** How many processes of a module are running now. */
  count(moduleId: string): number {
    let count = 0;
    for (const entry of this.running) if (entry.moduleId === moduleId && !entry.gone) count += 1;
    return count;
  }

  /**
   * Start `word` for a module in `dir`, which is there already.
   *
   * Throws `ProcessesBusy` when the module runs as many as it may, and when
   * the daemon is stopping. An error of the runtime (the program cannot be
   * started) is thrown as it is.
   */
  start(moduleId: string, word: string, dir: string, onMessage: (message: unknown) => void): ModuleProcess {
    if (this.closed || this.count(moduleId) >= this.maxPerModule) throw new ProcessesBusy();
    const entry: Running = { moduleId, word, gone: false, child: undefined as unknown as StartedChild };
    entry.child = this.spawn([...this.deps.self(), word], {
      cwd: dir,
      env: { [PROCESS_TMPDIR_VARIABLE]: dir },
      onMessage: (message) => {
        // A listener's failure is its own: it does not reach the runtime's
        // channel, where it would be an error of the daemon.
        try {
          onMessage(message);
        } catch {
          this.say("error", "a module's listener failed on a value from its process", { module: moduleId, word });
        }
      },
    });
    this.running.add(entry);
    this.say("info", "started a process for a module", { module: moduleId, word, pid: entry.child.pid });
    const exited: Promise<ProcessEnd> = entry.child.exited.then(
      (code): ProcessEnd => (entry.child.signalCode ? { signal: entry.child.signalCode } : { code }),
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
          entry.child.send(message);
        } catch {
          // The process went between the check and the send.
        }
      },
      kill: () => this.end(entry),
      exited,
    };
  }

  /** End every process of one module that is still running, and wait until
   *  each is gone. For a module that is switched off. Never rejects. */
  async endAll(moduleId: string): Promise<void> {
    await this.endWhere((entry) => entry.moduleId === moduleId);
  }

  /** End every process, and start no other. For the daemon's stop. Never
   *  rejects. */
  async endEvery(): Promise<void> {
    this.closed = true;
    await this.endWhere(() => true);
  }

  private async endWhere(which: (entry: Running) => boolean): Promise<void> {
    const ending = [...this.running].filter(which);
    for (const entry of ending) this.end(entry);
    await Promise.all(ending.map((entry) => entry.child.exited.catch(() => undefined)));
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
