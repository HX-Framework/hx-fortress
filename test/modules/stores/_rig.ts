// What the Stores tests share: a folder that is removed afterwards, and a
// Store's process running the probe program.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { prepareStoreFolder, storeFolder, type StoreFolder } from "../../../src/modules/stores/host/store-folder";
import { isFromStore } from "../../../src/modules/stores/host/process-protocol";
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

/**
 * A launcher that runs `command`: a program and its fixed words, with no shell.
 *
 * IT STANDS IN FOR THE MODULE HOST. A module starts no process, so the Stores
 * module holds only the `StoreLauncher` interface, and the host is to give it
 * the real one. Until it does, this is how a test starts a Store's process,
 * held to what the real one must hold to: no environment of this program's
 * own, no input, no output, the runtime's own channel, and a kill the process
 * cannot refuse. Nothing of a Store is in the command: the Store's folder is
 * sent on the channel, so it is not in the machine's list of processes.
 */
export function commandLauncher(
  command: readonly string[],
  options: {
    /** Let the process write its errors to this program's error output. */
    showErrors?: boolean;
  } = {},
): StoreLauncher {
  return {
    start({ scratch, onMessage }): StoreChild {
      const child = Bun.spawn([...command], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: options.showErrors ? "inherit" : "ignore",
        cwd: scratch,
        // The one name is SQLite's own, for where its temporary files go.
        env: { SQLITE_TMPDIR: scratch },
        serialization: "advanced",
        ipc(message: unknown) {
          if (isFromStore(message)) onMessage(message);
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
    },
  };
}

/** The probe program, started the way a Store's process is started. */
export const PROBE = path.join(import.meta.dir, "_probe-process.ts");

export function probeLauncher(): StoreLauncher {
  return commandLauncher([process.execPath, PROBE], { showErrors: true });
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
    scratch: folder.scratch,
    launcher: probeLauncher(),
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
