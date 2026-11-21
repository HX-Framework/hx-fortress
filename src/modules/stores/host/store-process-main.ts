// A Store's process: the side that holds the Store's file.
//
// HX Fortress starts this process for one Store, tells it the Store's folder,
// and then sends it one call at a time. The process opens the file, runs the
// Store's program on it, and answers. It holds one Store and nothing else: no
// listener, no connection to anything but the process that started it.
//
// A CALL IS ANSWERED ONLY WHEN WHAT IT WROTE IS KEPT. The storage keeps what a
// program writes as the platform does (file-storage.ts): statements with no
// wait between them together, and a transaction when it ends. Before this
// process answers a call, it has the storage keep whatever still waits. So
// when this process is ended in the middle of a call (a statement that ran too
// long, a crash, the machine going down), the Store's file is as the last
// keeping left it: nothing half written, and nothing the caller was told of
// is missing.
//
// THE PROCESS ENDS ITSELF when the process that started it is gone. A second
// thread checks once every quarter of a second, and it is a thread because the
// first one may be inside a statement that never ends, where no code of this
// process runs. It also ends itself when it can no longer stand behind the
// file: a statement opened a second file, or what was written could not be
// kept. HX Fortress starts a new process for the next call, which reads the
// file as it is.

import { FAILURE_CODE_PATTERN } from "../../../host/module-contract";
import { FileStorage } from "./file-storage";
import { isToStore, type FromStore, type ToStore } from "./process-protocol";
import { SqlRefused } from "./sql-guard";
import { storeFolder, type StoreFolder } from "./store-folder";

/** What a Store's program is handed: the Store, opened. */
export interface StoreProgramContext {
  readonly storage: FileStorage;
  readonly folder: StoreFolder;
  /** The settings HX Fortress opened the Store with. */
  readonly settings: Readonly<Record<string, string>>;
  now(): number;
  /** End this process now. What was written and not kept yet is dropped.
   *  HX Fortress starts a new process for the next call. */
  abort(reason?: string): void;
}

/** What runs on a Store: the engine, or a test's stand-in for it. */
export interface StoreProgram {
  /** One call. What it returns is the answer. What it throws is the failure:
   *  an `Error` whose `code` is one lower-case word is told to the caller by
   *  that word. */
  call(name: string, args: readonly unknown[]): Promise<unknown> | unknown;
  /** The Store's alarm is due. */
  wake?(): Promise<void> | void;
  close?(): Promise<void> | void;
}

export type StoreProgramFactory = (
  context: StoreProgramContext,
) => Promise<StoreProgram> | StoreProgram;

/**
 * The one word a failure is told by.
 *
 * A refusal of the host's is told by its rule (`refused_attach`). A failure
 * with a code is told by the code, in small letters: SQLite's
 * (`sqlite_constraint`), or the program's own. Anything else is `internal`.
 */
function codeOf(thrown: unknown): string {
  if (thrown instanceof SqlRefused) return `refused_${thrown.rule}`;
  const code = (thrown as { code?: unknown } | null)?.code;
  if (typeof code === "string") {
    const word = code.toLowerCase();
    if (FAILURE_CODE_PATTERN.test(word)) return word;
  }
  return "internal";
}

function wordsOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message.slice(0, 2_000) : "";
}

/** How the process tells that its parent is gone, while its own thread may be
 *  inside a statement: a thread that looks, and ends the process. */
const PARENT_WATCH = `
const started = process.ppid;
setInterval(() => {
  if (process.ppid !== started) process.kill(process.pid, "SIGKILL");
}, 250);
`;

/** The exit code of a Store's process that nobody started: it was run by
 *  hand, and has no parent to talk to. */
export const NO_PARENT_EXIT = 64;

/** The exit codes of a Store's process that ended itself. */
const EXIT = { noParent: NO_PARENT_EXIT, openFailed: 65, reachBroken: 70, notKept: 71, crashed: 1 } as const;

/** Whether this process was started by a parent that talks to it: the runtime
 *  gives such a process a way to send. */
export function hasParent(): boolean {
  return typeof (process as { send?: unknown }).send === "function";
}

/**
 * Be a Store's process. Never returns: the process ends when it is told to
 * close, when its parent is gone, or when it can no longer stand behind the
 * Store's file.
 */
export async function runStoreProcess(factory: StoreProgramFactory): Promise<never> {
  const channel = process as unknown as {
    send?: (message: FromStore) => void;
    on(event: "message", listener: (message: unknown) => void): void;
    on(event: "disconnect", listener: () => void): void;
  };
  if (!hasParent()) {
    // Started by hand, with no parent to talk to. There is nothing to do.
    process.exit(EXIT.noParent);
  }
  /** False when the message could not be sent: the parent is gone (the watch
   *  below then ends this process), or the message holds something that cannot
   *  cross. */
  const say = (message: FromStore): boolean => {
    try {
      channel.send?.(message);
      return true;
    } catch {
      return false;
    }
  };
  /** End at once, with a word for why. Nothing more is kept. */
  const endWith = (code: string, status: number): never => {
    say({ t: "ending", code });
    process.exit(status);
  };

  // Whatever this process makes is for its owner alone.
  process.umask(0o077);
  const watch = new Worker(
    URL.createObjectURL(new Blob([PARENT_WATCH], { type: "application/javascript" })),
  );
  // The watch is not what keeps the process alive, the channel is.
  (watch as unknown as { unref?: () => void }).unref?.();

  let storage: FileStorage | null = null;
  let program: StoreProgram | null = null;
  let working: Promise<void> = Promise.resolve();

  /** Keep what waits, close the file and end. */
  const end = (status: number): never => {
    try {
      storage?.close();
    } catch {
      // What could not be kept was told by the storage. The file is closed by
      // the process ending.
    }
    process.exit(status);
  };

  const open = async (message: Extract<ToStore, { t: "open" }>): Promise<void> => {
    if (storage) return;
    const folder = storeFolder(message.folder);
    try {
      const opened = new FileStorage({
        folder,
        onAlarm: (at) => say({ t: "alarm", at }),
        onReachBroken: () => endWith("reach_broken", EXIT.reachBroken),
        onTransactionLost: () => endWith("not_kept", EXIT.notKept),
        onNotKept: () => endWith("not_kept", EXIT.notKept),
      });
      storage = opened;
      program = await factory({
        storage: opened,
        folder,
        settings: message.settings,
        now: () => Date.now(),
        abort: () => endWith("aborted", 0),
      });
      opened.flush();
      say({ t: "opened", alarm: opened.alarm });
    } catch (thrown) {
      say({ t: "open_failed", code: codeOf(thrown) });
      end(EXIT.openFailed);
    }
  };

  const answer = async (id: number, work: () => Promise<unknown> | unknown): Promise<void> => {
    const store = storage;
    if (!store || !program) {
      say({ t: "answer", id, ok: false, code: "not_open", words: "" });
      return;
    }
    let outcome: Extract<FromStore, { t: "answer" }>;
    try {
      const value = await work();
      // The answer is sent only when what the call wrote is kept.
      store.flush();
      outcome = { t: "answer", id, ok: true, value };
    } catch (thrown) {
      // A call that fails keeps what it wrote before it failed, as on the
      // platform. A keeping that fails ends the process (`onNotKept`).
      store.flush();
      outcome = { t: "answer", id, ok: false, code: codeOf(thrown), words: wordsOf(thrown) };
    }
    if (!say(outcome) && outcome.ok) {
      // An answer that cannot cross the channel: a function, a symbol.
      say({ t: "answer", id, ok: false, code: "answer_unreadable", words: "" });
    }
  };

  const wake = (id: number): Promise<void> =>
    answer(id, async () => {
      const store = storage as FileStorage;
      const due = store.alarm;
      // Nothing is due: the alarm was moved or removed since HX Fortress set
      // its timer. The answer says what the alarm is now.
      if (due === null || due > Date.now()) return { alarm: due };
      // The alarm is taken when it fires: the program sees none while it runs,
      // unless it sets a new one. The disk keeps the time meanwhile, so a
      // process that is ended here is woken again by the next one. If the
      // program fails and set no new time, the old time stands, and HX Fortress
      // wakes the Store again later.
      store.takeAlarm();
      let dealtWith = false;
      try {
        await program?.wake?.();
        dealtWith = true;
      } finally {
        store.settleAlarm(due, dealtWith);
      }
      return { alarm: store.alarm };
    });

  channel.on("message", (message: unknown) => {
    if (!isToStore(message)) return;
    // One at a time, in the order they came.
    working = working.then(async (): Promise<void> => {
      switch (message.t) {
        case "open":
          await open(message);
          return;
        case "call":
          await answer(message.id, () => (program as StoreProgram).call(message.name, message.args));
          return;
        case "wake":
          await wake(message.id);
          return;
        case "close":
          try {
            await program?.close?.();
          } catch {
            // Closing anyway.
          }
          end(0);
      }
    });
    // Nothing above is meant to throw. If something does, this process no
    // longer knows what state the Store's program is in.
    working = working.catch(() => endWith("crashed", EXIT.crashed));
  });
  channel.on("disconnect", () => end(0));

  // Held open by the channel until one of the ends above.
  return new Promise<never>(() => {});
}
