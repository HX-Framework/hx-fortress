// A Store's process: the side HX Fortress holds.
//
// WHY A PROCESS. SQLite runs a statement to its end on the thread that asked,
// and this runtime has no call that interrupts one. A person or the control
// plane's agent writes a Store's statements, so one of them can run for ever,
// or ask for more memory than the machine has. HX Fortress is one program:
// such a statement on its own thread would stop every module, the connection
// and the console with it.
//
// A thread is not enough. Measured on Bun 1.3.14, from source and in the one
// compiled program: a worker thread inside a statement goes on after it is
// told to end, and keeps a processor busy for good. A process can be ended by
// the operating system, whatever it is doing. So each open Store is a process
// of its own: this same program, started again with one word. Ending it takes
// a few milliseconds, and the Store's file is then as the last keeping left
// it: nothing half written (file-storage.ts says when a keeping happens).
//
// What this class holds to:
//
//   • ONE CALL AT A TIME for a Store. The next is sent when the one before it
//     is answered.
//   • A LIMIT for each call. A call that is not answered in time ends the
//     process. The call is refused as stopped, the calls that waited behind it
//     are not lost, and the next one starts a new process on the same file.
//   • HX Fortress never waits on a Store's process without a limit: not to
//     start it, not for an answer, not to close it, and not for it to be gone
//     after it was ended.
//   • A listener's failure is its own. What `onAlarm` or `onGone` throws is
//     dropped, and the calls go on.
//
// THIS FILE STARTS NO PROCESS. A module of HX Fortress starts none: the module
// host does that for it, and the build fails on a module that tries. So this
// class is handed a `StoreLauncher`, and everything here is what happens around
// the process: the order of calls, the limits, and what a caller is told.
//
// What the launcher is held to, whoever gives it: the process is this same
// program and no other, it gets no environment of HX Fortress's own, no input
// and no output (what a Store's program prints could hold a row's value, so
// nothing it prints is read or kept), and the channel is the runtime's own
// between a parent and its child.

import { withDeadline } from "../../../host/with-deadline";
import type { FromStore, ToStore } from "./process-protocol";

// ── Starting one ─────────────────────────────────────────────────────────────

/** A started process and the channel to it. */
export interface StoreChild {
  send(message: ToStore): void;
  /** End the process now. It cannot refuse. */
  kill(): void;
  /** Settles when the process is gone. */
  readonly exited: Promise<unknown>;
}

/**
 * How a Store's process is started: the module host's to give.
 *
 * `start` starts this same program again with the word `STORE_PROCESS_VERB`,
 * and hands `onMessage` what the process says that `isFromStore` takes.
 */
export interface StoreLauncher {
  start(options: {
    /** The folder the process runs in, and where SQLite keeps its temporary
     *  files: a folder of the Store's own. */
    scratch: string;
    onMessage(message: FromStore): void;
  }): StoreChild;
}

// ── What a caller is told ────────────────────────────────────────────────────

export type StopReason =
  /** A call ran past its limit. */
  | "limit"
  /** The process ended by itself: a crash, or the machine ended it. */
  | "exited"
  /** The Store could not be opened. */
  | "open_failed"
  /** A statement opened a file that is not the Store's own. */
  | "reach_broken"
  /** What a call wrote could not be kept. */
  | "not_kept"
  /** The Store's program asked to be started anew. */
  | "aborted"
  | "crashed";

const STOP_REASONS: readonly StopReason[] = [
  "limit",
  "exited",
  "open_failed",
  "reach_broken",
  "not_kept",
  "aborted",
  "crashed",
];

/** The Store's process ended before it answered. What the call wrote and the
 *  Store had not kept yet is gone: the file is as the last keeping left it. */
export class StoreStopped extends Error {
  readonly why: StopReason;
  /** For `open_failed`: the one word the process gave. */
  readonly code: string | null;

  constructor(why: StopReason, code: string | null = null) {
    super(`the Store's process stopped: ${why}`);
    this.name = "StoreStopped";
    this.why = why;
    this.code = code;
  }
}

/** The Store's program failed the call, or the call could not be sent. */
export class StoreCallFailed extends Error {
  /** One lower-case word. */
  readonly code: string;
  /**
   * The failure's own message, for the person whose call it was. It can hold a
   * row's value: SQLite puts into a message what a statement gave it to say.
   * It goes into no log, no record and no answer to the control plane.
   */
  readonly words: string;

  constructor(code: string, words: string) {
    // The message is the code alone: a message is what gets logged.
    super(`the Store's call failed: ${code}`);
    this.name = "StoreCallFailed";
    this.code = code;
    this.words = words;
  }
}

// ── One Store ────────────────────────────────────────────────────────────────

export interface StoreProcessOptions {
  /** The Store's folder. */
  folder: string;
  /** The folder SQLite's temporary files go in. */
  scratch: string;
  launcher: StoreLauncher;
  /** What the Store's program is opened with. */
  settings?: Readonly<Record<string, string>>;
  /** The longest one call may run, in milliseconds. */
  limitMs?: number;
  /** The longest the process may take to open the Store. */
  startLimitMs?: number;
  /** The process is closed when no call came for this long. 0 keeps it. */
  idleMs?: number;
  /** The longest a process that was ended is waited for. After that the Store
   *  is taken as gone, whatever became of the process. */
  goneLimitMs?: number;
  /** Called when the Store's alarm changes, with its new time or null. */
  onAlarm?: (at: number | null) => void;
  /** Called each time a process of this Store is gone. `null` when it was
   *  asked to close and ended by itself. */
  onGone?: (why: StopReason | null) => void;
}

export const CALL_LIMIT_MS = 30_000;
export const START_LIMIT_MS = 15_000;
export const IDLE_MS = 60_000;
/** How long a process is given to close its file when asked to. */
const CLOSE_LIMIT_MS = 2_000;
/** How long a process that was ended is waited for. */
const GONE_LIMIT_MS = 5_000;
/** A file that another process still holds is tried again this often, this
 *  many times. A process whose parent is gone ends itself within a second. */
const HELD_RETRY_MS = 500;
const HELD_RETRIES = 4;

interface Waiting {
  message(id: number): ToStore;
  limitMs: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface Opening {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether a message can cross the channel: the channel copies a value the way
 *  `structuredClone` does. */
function crosses(message: unknown): boolean {
  try {
    structuredClone(message);
    return true;
  } catch {
    return false;
  }
}

export class StoreProcess {
  private readonly options: StoreProcessOptions;
  /** The process of this Store, from its start until it is taken as gone. */
  private child: StoreChild | null = null;
  /** Set while `child` is opening the Store. */
  private opening: Opening | null = null;
  private readonly queue: Waiting[] = [];
  private running: { id: number; waiting: Waiting; timer: ReturnType<typeof setTimeout> } | null =
    null;
  private pumping = false;
  private nextId = 1;
  /** Why `child` is being ended, once it is. */
  private ending: StopReason | null = null;
  private endingCode: string | null = null;
  /** `child` was asked to close, and nothing ended it since. */
  private askedToClose = false;
  private closing: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** How many calls were sent and not answered, ever. For the console. */
  private stoppedCalls = 0;
  private disposed = false;

  constructor(options: StoreProcessOptions) {
    this.options = options;
  }

  /** Whether a process of this Store is running now. */
  get isOpen(): boolean {
    return this.child !== null;
  }

  /** Whether a call is running or waiting. */
  get isBusy(): boolean {
    return this.running !== null || this.queue.length > 0;
  }

  /** How many calls this Store's processes were ended in the middle of. */
  get stopped(): number {
    return this.stoppedCalls;
  }

  /**
   * Run one call of the Store's program.
   *
   * Rejects with `StoreCallFailed` when the program failed it or its values
   * cannot be sent, and with `StoreStopped` when the process ended first.
   */
  call<T = unknown>(
    name: string,
    args: readonly unknown[] = [],
    options: { limitMs?: number } = {},
  ): Promise<T> {
    return this.enqueue((id) => ({ t: "call", id, name, args }), options.limitMs) as Promise<T>;
  }

  /**
   * Tell the Store that its alarm is due. Answers the time the Store wants to
   * be woken at next, or null. A Store whose alarm is not due yet is not
   * woken, and answers its alarm as it is.
   */
  async wake(options: { limitMs?: number } = {}): Promise<number | null> {
    const answer = (await this.enqueue((id) => ({ t: "wake", id }), options.limitMs)) as {
      alarm?: unknown;
    } | null;
    return typeof answer?.alarm === "number" ? answer.alarm : null;
  }

  private enqueue(message: (id: number) => ToStore, limitMs?: number): Promise<unknown> {
    if (this.disposed) return Promise.reject(new StoreStopped("exited"));
    return new Promise((resolve, reject) => {
      this.queue.push({
        message,
        limitMs: limitMs ?? this.options.limitMs ?? CALL_LIMIT_MS,
        resolve,
        reject,
      });
      void this.pump();
    });
  }

  /** Send the calls that wait, one at a time. Never rejects. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.running === null && this.queue.length > 0 && !this.disposed) {
        // A process that is being closed takes no new call. The call waits for
        // the close to end, and then gets a new process.
        if (this.closing) {
          await this.closing;
          continue;
        }
        try {
          await this.open();
        } catch (thrown) {
          this.queue
            .shift()
            ?.reject(thrown instanceof Error ? thrown : new StoreStopped("open_failed"));
          continue;
        }
        // From here to the send there is no wait: nothing can come between.
        if (this.closing || this.disposed) continue;
        const waiting = this.queue.shift();
        if (!waiting) continue;
        const child = this.child;
        if (!child || this.opening || this.ending !== null) {
          // Gone, or ended, in the moment since it opened.
          waiting.reject(new StoreStopped(this.ending ?? "exited", this.endingCode));
          continue;
        }
        this.send(child, waiting);
      }
    } finally {
      this.pumping = false;
    }
  }

  private send(child: StoreChild, waiting: Waiting): void {
    this.stopIdleTimer();
    const id = this.nextId;
    this.nextId += 1;
    const message = waiting.message(id);
    this.running = {
      id,
      waiting,
      timer: setTimeout(() => this.end(child, "limit"), waiting.limitMs),
    };
    try {
      child.send(message);
    } catch {
      if (!crosses(message)) {
        // This call's values cannot be sent. The process is as it was.
        this.settle(id, (call) => call.reject(new StoreCallFailed("call_unsendable", "")));
        this.startIdleTimer();
        return;
      }
      // The channel is gone. The process is taken as gone at once, so that the
      // call that waits next gets a new one.
      this.end(child, "exited");
      this.gone(child);
    }
  }

  /** Take the running call, if it is `id`, and settle it. */
  private settle(id: number, how: (waiting: Waiting) => void): void {
    const running = this.running;
    if (!running || running.id !== id) return;
    clearTimeout(running.timer);
    this.running = null;
    how(running.waiting);
  }

  /** Run a listener of the caller's. What it throws is dropped. */
  private tell(listener: () => void): void {
    try {
      listener();
    } catch {
      // A listener's failure is its own.
    }
  }

  // ── The process ────────────────────────────────────────────────────────────

  /** Start a process and open the Store in it, unless one is open. */
  private async open(): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      if (this.disposed) throw new StoreStopped("exited");
      const child = this.child;
      if (child && this.ending !== null) {
        // A process that was ended, or said that it ends, and is not gone yet.
        // Nothing is sent to it. When it is gone, a new one is started.
        await this.untilGone(child);
        continue;
      }
      if (child && !this.opening) return;
      try {
        await this.openOnce();
        return;
      } catch (thrown) {
        // Another process still holds the file: one that is ending. Any other
        // failure is told at once.
        const held = thrown instanceof StoreStopped && thrown.code === "sqlite_busy";
        if (!held || attempt >= HELD_RETRIES || this.disposed) throw thrown;
        await sleep(HELD_RETRY_MS);
      }
    }
  }

  private openOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.ending = null;
      this.endingCode = null;
      this.askedToClose = false;
      let child: StoreChild;
      try {
        child = this.options.launcher.start({
          scratch: this.options.scratch,
          onMessage: (message) => this.hear(child, message),
        });
      } catch {
        reject(new StoreStopped("open_failed", "not_started"));
        return;
      }
      this.child = child;
      this.opening = {
        resolve,
        reject,
        timer: setTimeout(
          () => this.end(child, "open_failed", "start_limit"),
          this.options.startLimitMs ?? START_LIMIT_MS,
        ),
      };
      void child.exited.then(
        () => this.gone(child),
        () => this.gone(child),
      );
      try {
        child.send({
          t: "open",
          folder: this.options.folder,
          settings: this.options.settings ?? {},
        });
      } catch {
        this.end(child, "open_failed", "not_started");
      }
    });
  }

  private hear(from: StoreChild, message: FromStore): void {
    // A message from a process that is no longer this Store's is nothing.
    if (from !== this.child) return;
    switch (message.t) {
      case "opened": {
        const opening = this.opening;
        if (!opening) return;
        clearTimeout(opening.timer);
        this.opening = null;
        opening.resolve();
        this.tell(() =>
          this.options.onAlarm?.(typeof message.alarm === "number" ? message.alarm : null),
        );
        return;
      }
      case "open_failed":
        this.ending = "open_failed";
        this.endingCode = typeof message.code === "string" ? message.code : null;
        return;
      case "answer": {
        if (typeof message.id !== "number") return;
        this.settle(message.id, (waiting) => {
          if (message.ok) waiting.resolve(message.value);
          else {
            waiting.reject(
              new StoreCallFailed(
                typeof message.code === "string" ? message.code : "internal",
                typeof message.words === "string" ? message.words : "",
              ),
            );
          }
        });
        this.startIdleTimer();
        void this.pump();
        return;
      }
      case "alarm":
        this.tell(() => this.options.onAlarm?.(typeof message.at === "number" ? message.at : null));
        return;
      case "ending":
        // The process says why it ends. Only a word from the list is taken.
        if (this.ending === null && STOP_REASONS.includes(message.code as StopReason)) {
          this.ending = message.code as StopReason;
        }
        return;
    }
  }

  /**
   * End the process `child` now, and say why. Nothing happens for a process
   * that is no longer this Store's. If the process is not gone within its
   * limit, the Store is taken as gone all the same.
   */
  private end(child: StoreChild, why: StopReason, code: string | null = null): void {
    if (child !== this.child) return;
    if (this.ending === null) {
      this.ending = why;
      this.endingCode = code;
    }
    try {
      child.kill();
    } catch {
      // Taken as gone below, whatever the kill did.
    }
    const limit = setTimeout(() => this.gone(child), this.options.goneLimitMs ?? GONE_LIMIT_MS);
    (limit as { unref?: () => void }).unref?.();
    const done = (): void => clearTimeout(limit);
    void child.exited.then(done, done);
  }

  /** The process `child` is gone, or is taken as gone. */
  private gone(child: StoreChild): void {
    if (child !== this.child) return;
    const inOrder = this.askedToClose && this.ending === null;
    const why: StopReason = this.ending ?? "exited";
    const code = this.endingCode;
    this.child = null;
    this.askedToClose = false;
    this.stopIdleTimer();
    const opening = this.opening;
    if (opening) {
      clearTimeout(opening.timer);
      this.opening = null;
      opening.reject(new StoreStopped("open_failed", code ?? (why === "open_failed" ? null : why)));
    }
    const running = this.running;
    if (running) {
      this.stoppedCalls += 1;
      this.settle(running.id, (waiting) => waiting.reject(new StoreStopped(why, code)));
    }
    this.tell(() => this.options.onGone?.(inOrder ? null : why));
    // What waited behind the call gets a new process.
    void this.pump();
  }

  /** Wait for an ended process to be gone, for at most its limit. */
  private async untilGone(child: StoreChild): Promise<void> {
    const exited = child.exited.then(
      () => undefined,
      () => undefined,
    );
    await withDeadline(exited, this.options.goneLimitMs ?? GONE_LIMIT_MS, "gone limit", {
      unref: true,
    }).catch(() => undefined);
    this.gone(child);
  }

  // ── Closing ────────────────────────────────────────────────────────────────

  private startIdleTimer(): void {
    const idleMs = this.options.idleMs ?? IDLE_MS;
    if (idleMs <= 0 || this.isBusy) return;
    this.stopIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (!this.isBusy) void this.close();
    }, idleMs);
    (this.idleTimer as { unref?: () => void }).unref?.();
  }

  private stopIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /**
   * Close the Store's file and end its process.
   *
   * A Store that is still being opened, and the call that is running, are let
   * finish first, for at most `withinMs`. After that the process is ended, and
   * the call is refused as stopped. A call that was not sent yet, and one that
   * comes later, gets a new process.
   *
   * Never rejects, and never waits longer than `withinMs`, the two seconds a
   * process has to close, and the limit for an ended process to be gone. Left
   * out, `withinMs` is as long as a call may run.
   */
  close(options: { withinMs?: number } = {}): Promise<void> {
    if (this.closing) return this.closing;
    if (!this.child) return Promise.resolve();
    const child = this.child;
    this.stopIdleTimer();
    this.closing = (async (): Promise<void> => {
      const until = Date.now() + (options.withinMs ?? this.options.limitMs ?? CALL_LIMIT_MS);
      // Both are behind limits of their own, so this wait ends.
      while (
        (this.opening !== null || this.running !== null) &&
        this.child === child &&
        Date.now() < until
      ) {
        await sleep(10);
      }
      if (this.child !== child) return;
      if (this.opening !== null || this.running !== null) {
        // Out of time. The process is ended with what it was doing.
        this.end(child, "exited");
      } else {
        this.askedToClose = true;
        try {
          child.send({ t: "close" });
        } catch {
          this.end(child, "exited");
        }
      }
      const closed = await withDeadline(
        child.exited.then(
          () => true,
          () => true,
        ),
        CLOSE_LIMIT_MS,
        "close limit",
        { unref: true },
      ).catch(() => false);
      if (!closed) this.end(child, "exited");
      await this.untilGone(child);
    })()
      .catch(() => undefined)
      .finally(() => {
        this.closing = null;
        // What waited for the close gets its process now.
        void this.pump();
      });
    return this.closing;
  }

  /**
   * End the process at once, whatever it is doing, and take no more calls.
   * The call that is running and every call that waits are refused as stopped.
   * For a Store that is being removed, and for HX Fortress stopping.
   *
   * Never rejects, and waits no longer than the limit for an ended process to
   * be gone.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.stopIdleTimer();
    for (const waiting of this.queue.splice(0)) waiting.reject(new StoreStopped("exited"));
    const child = this.child;
    if (!child) return;
    this.end(child, "exited");
    await this.untilGone(child);
  }
}
