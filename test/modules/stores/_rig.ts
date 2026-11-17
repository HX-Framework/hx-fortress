// What the Stores tests share: a folder that is removed afterwards, and a
// Store's process running the probe program.

import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { FromStore, ToStore } from "../../../src/modules/stores/host/process-protocol";
import { prepareStoreFolder, storeFolder, type StoreFolder } from "../../../src/modules/stores/host/store-folder";
import {
  StoreProcess,
  type StoreChild,
  type StoreLauncher,
  type StoreProcessOptions,
} from "../../../src/modules/stores/host/store-process";
import type { ModuleProcesses } from "../../../src/modules/stores/module";

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
 * Run `command`, a program and its fixed words, with no shell, in `folder`.
 *
 * THIS STANDS IN FOR THE MODULE HOST. A module starts no process, so the
 * Stores module holds only interfaces (`StoreLauncher`, `ModuleProcesses`),
 * and the host is to give the real thing. Until it does, this is how a test
 * starts a Store's process, held to what the real one must hold to: no
 * environment of this program's own, no input, no output, the runtime's own
 * channel with every value passed through unread, and a kill the process
 * cannot refuse. Nothing of a Store is in the command: the Store's folder is
 * sent on the channel, so it is not in the machine's list of processes.
 *
 * IT MAKES NOTHING ON THE DISK. A folder that is not there is a refusal.
 */
function startCommand(
  command: readonly string[],
  folder: string,
  onMessage: (message: unknown) => void,
  options: CommandOptions,
): StoreChild {
  if (!existsSync(folder)) throw new Error("the folder a process was to run in is not there");
  const child = Bun.spawn([...command], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: options.showErrors ? "inherit" : "ignore",
    cwd: folder,
    // The one name is SQLite's own, for where its temporary files go.
    env: { SQLITE_TMPDIR: folder },
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

/** A launcher for one Store: `command`, run in the Store's `scratch` folder. */
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

/** What a stand-in for the module host was asked to start. */
export interface AskedStart {
  verb: string;
  /** The folder, as the module named it level by level. */
  folder: readonly string[];
}

/**
 * What the module host is to give a module: `command`, run in the folder of
 * the context's organization that the module named. The word is not passed
 * on: `command` is the program a test wants run. `asked` is told each start.
 *
 * The folder's path is put together from the module's own folder for the
 * organization, which the host gives, and the names. It is not made.
 */
export function commandProcesses(
  command: readonly string[],
  options: CommandOptions & { asked?: (start: AskedStart) => void } = {},
): ModuleProcesses {
  return {
    async start(ctx, verb, { folder, onMessage }) {
      options.asked?.({ verb, folder });
      return startCommand(command, path.join(await ctx.folder(), ...folder), onMessage, options);
    },
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
