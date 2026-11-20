// What the Stores tests share: a folder that is removed afterwards, a Store's
// process running the probe program, and a program compiled as the release
// compiles HX Fortress.

import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { PROCESS_TMPDIR_VARIABLE, PROCESS_WORKING_FOLDER } from "../../../src/host/module-processes";
import type { FromStore, ToStore } from "../../../src/modules/stores/host/process-protocol";
import { prepareStoreFolder, storeFolder, type StoreFolder } from "../../../src/modules/stores/host/store-folder";
import {
  StoreProcess,
  type StoreChild,
  type StoreLauncher,
  type StoreProcessOptions,
} from "../../../src/modules/stores/host/store-process";

const made: string[] = [];

/** A new, empty folder. Removed by `cleanFolders`. */
export function tempFolder(label = "store"): string {
  // The real path: on a Mac the temporary folder is behind a link.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `hx-fortress-${label}-`)));
  made.push(dir);
  return dir;
}

export function cleanFolders(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A Store's folder, made as the host makes one. */
export function newStoreFolder(label = "store"): StoreFolder {
  const folder = storeFolder(path.join(tempFolder(label), "store"));
  prepareStoreFolder(folder);
  return folder;
}

interface CommandOptions {
  /** Let the process write its errors to this program's error output. */
  showErrors?: boolean;
}

/**
 * Run `command`, a program and its fixed words, with no shell, and give it
 * `folder` for its temporary files. The process is not started in `folder`:
 * it is started where the module host starts a module's process, and is told
 * the folder by the one variable the module host tells it by.
 *
 * THIS STANDS IN FOR THE MODULE HOST, for the tests of one Store's process
 * alone. A module starts no process: the module host does, and the tests of
 * the whole module go through the module host itself (_module-rig.ts). This
 * is held to what the module host holds to: no environment of this program's
 * own, no input, no output, the runtime's own channel with every value passed
 * through unread, and a kill the process cannot refuse. Nothing of a Store is
 * in the command: the Store's folder is sent on the channel, so it is not in
 * the machine's list of processes.
 *
 * IT MAKES NOTHING ON THE DISK. A folder that is not there is a refusal.
 */
function startCommand(
  command: readonly string[],
  folder: string,
  onMessage: (message: unknown) => void,
  options: CommandOptions,
): StoreChild {
  if (!existsSync(folder)) throw new Error("the folder a process was started for is not there");
  const child = Bun.spawn([...command], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: options.showErrors ? "inherit" : "ignore",
    // Not in the Store's folder, as the module host starts one: this runtime
    // reads settings and variables from files of the folder a program starts
    // in, and a Store's folder must not be such a place. A Store's process
    // names every file by its full path.
    cwd: PROCESS_WORKING_FOLDER,
    // The one variable is SQLite's own, for where its temporary files go.
    env: { [PROCESS_TMPDIR_VARIABLE]: folder },
    serialization: "advanced",
    ipc(message: unknown) {
      onMessage(message);
    },
  });
  return {
    send: (message) => {
      child.send(message);
    },
    kill: () => {
      child.kill("SIGKILL");
    },
    exited: child.exited,
  };
}

/** A launcher for one Store: `command`, with the Store's `scratch` folder for
 *  its temporary files. */
export function commandLauncher(
  command: readonly string[],
  scratch: string,
  options: CommandOptions = {},
): StoreLauncher {
  return {
    // A program that cannot be started throws here, and that is a refusal.
    start: ({ onMessage }) => Promise.resolve(startCommand(command, scratch, onMessage, options)),
  };
}

// ── A process that is none ───────────────────────────────────────────────────

/** A stand-in for a Store's process, with no process behind it. */
export interface MadeUpProcess {
  child: StoreChild;
  /** Everything it was sent, in order. */
  sent: ToStore[];
  /** The calls and wakes it was sent and has not answered. */
  waiting: number[];
  /** How often it was ended. */
  kills(): number;
  /** Whether it is gone: ended, or closed. */
  gone(): boolean;
  /** Whether it was asked to close and has not gone (`slowToClose`). */
  closing(): boolean;
  /** Answer every call and wake it has not answered. */
  answer(value?: unknown): void;
  /** Say something to HX Fortress, as the process would. */
  say(message: FromStore): void;
  /** Go, as a process that ended. */
  go(): void;
}

/**
 * A process that is none: it remembers what it is sent, and does what a
 * test tells it to.
 *
 *   opens        it answers the open at once (the default). False: never.
 *   alarm        the alarm it says it has when it opens
 *   endsWhenTold it goes when it is ended or asked to close (the default).
 *                False: it never goes, whatever it is told.
 *   slowToClose  asked to close, it stays until `go()`. Ended, it goes.
 */
export function madeUpProcess(
  onMessage: (message: unknown) => void,
  behaviour: { opens?: boolean; alarm?: number | null; endsWhenTold?: boolean; slowToClose?: boolean } = {},
): MadeUpProcess {
  const { opens = true, alarm = null, endsWhenTold = true, slowToClose = false } = behaviour;
  let kills = 0;
  let gone = false;
  let closing = false;
  let leave: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => (leave = resolve));
  const go = (): void => {
    gone = true;
    leave();
  };
  const made: MadeUpProcess = {
    sent: [],
    waiting: [],
    kills: () => kills,
    gone: () => gone,
    closing: () => closing && !gone,
    answer(value: unknown = { ok: true, value: null }): void {
      for (const id of made.waiting.splice(0)) onMessage({ t: "answer", id, ok: true, value });
    },
    say: (message) => onMessage(message),
    go,
    child: {
      send(message: ToStore): void {
        made.sent.push(message);
        if (message.t === "open") {
          if (opens) queueMicrotask(() => onMessage({ t: "opened", alarm }));
        } else if (message.t === "call" || message.t === "wake") {
          made.waiting.push(message.id);
        } else if (slowToClose) {
          closing = true;
        } else if (endsWhenTold) {
          go();
        }
      },
      kill(): void {
        kills += 1;
        if (endsWhenTold) go();
      },
      exited,
    },
  };
  return made;
}

/** The probe program, started the way a Store's process is started. */
export const PROBE = path.join(import.meta.dir, "_probe-process.ts");

export function probeLauncher(scratch: string): StoreLauncher {
  return commandLauncher([process.execPath, PROBE], scratch, { showErrors: true });
}

export interface ProbeStore {
  folder: StoreFolder;
  process: StoreProcess;
  exec(sql: string, ...bindings: unknown[]): Promise<{ columns: string[]; rows: unknown[][]; written: number }>;
}

const open: StoreProcess[] = [];

export function probeStore(
  options: Partial<Omit<StoreProcessOptions, "folder">> & { folder?: StoreFolder } = {},
): ProbeStore {
  const { folder: given, ...rest } = options;
  const folder = given ?? newStoreFolder();
  const process_ = new StoreProcess({
    launcher: probeLauncher(folder.scratch),
    idleMs: 0,
    ...rest,
    folder: folder.root,
  });
  open.push(process_);
  return {
    folder,
    process: process_,
    exec: (sql, ...bindings) => process_.call("exec", [sql, ...bindings]),
  };
}

/** End every process a test started. */
export async function endProcesses(): Promise<void> {
  await Promise.all(open.splice(0).map((process_) => process_.dispose()));
}

/**
 * Compile `entry` into one program, as the release compiles HX Fortress
 * (`bun build --compile --minify`), into a folder that `cleanFolders` removes.
 * Answers the program's path. THROWS when the build fails, with what the build
 * said.
 *
 * Minified, as the release is: names are shortened then, so code that reads a
 * function's or a class's own name behaves as it does in what is shipped.
 */
export function compileProgram(entry: string, label = "compiled"): string {
  const program = path.join(tempFolder(label), "one-program");
  const build = Bun.spawnSync(
    [process.execPath, "build", entry, "--compile", "--minify", "--outfile", program],
    { stdout: "pipe", stderr: "pipe" },
  );
  const said = build.stderr.toString();
  if (build.exitCode !== 0 || said.includes("error")) {
    throw new Error(`the program was not compiled (exit ${String(build.exitCode)}): ${said.slice(0, 2_000)}`);
  }
  return program;
}
