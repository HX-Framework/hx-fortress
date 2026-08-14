// The gate every argon2id invocation passes through — verify, hash, setup
// completion, reset, and the dummy verify that makes an unknown login cost the
// same as a real one.
//
// argon2id at m=64MiB is a memory bomb by design. Without a ceiling, a hundred
// concurrent sign-in attempts is 6.4 GiB of resident memory and an OOM kill, so
// a flood does not need to guess a password to take the console down — it only
// needs to try. The gate bounds concurrency (and therefore RSS), bounds the wait
// queue so backpressure is a fast 503 rather than an unbounded pile of pending
// promises, and caps each remote key at ONE in-flight hash so a single source
// cannot occupy every slot.
//
// One slot is RESERVED for principals with no recent failures. During a flood
// from unknown logins, the operator who knows their password still gets in: the
// attacker's keys all carry recent failures and can never take the last slot.

export class ArgonBusyError extends Error {
  /** The console answers 503 + Retry-After; it is load shedding, not a denial. */
  readonly status = 503;

  constructor() {
    super("the sign-in path is saturated — retry in a moment");
    this.name = "ArgonBusyError";
  }
}

export interface ArgonGateOptions {
  /** Total concurrent hashes. Times 64 MiB is the memory ceiling this buys. */
  maxConcurrent?: number;
  /** Slots inside maxConcurrent that only clean principals may take. */
  reserved?: number;
  /** Waiters held before new arrivals are shed immediately. */
  queueLimit?: number;
  /** How long a waiter waits before it is shed. */
  waitMs?: number;
}

interface Waiter {
  key: string;
  clean: boolean;
  admit: () => void;
  shed: (err: ArgonBusyError) => void;
  timer: ReturnType<typeof setTimeout>;
  done: boolean;
}

export const ARGON_MAX_CONCURRENT = 4;
export const ARGON_RESERVED_SLOTS = 1;
export const ARGON_QUEUE_LIMIT = 64;
export const ARGON_WAIT_MS = 2_000;

export class ArgonGate {
  private readonly maxConcurrent: number;
  private readonly reserved: number;
  private readonly queueLimit: number;
  private readonly waitMs: number;
  private inFlight = 0;
  private readonly perKey = new Map<string, number>();
  private readonly waiting: Waiter[] = [];

  constructor(options: ArgonGateOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? ARGON_MAX_CONCURRENT;
    this.reserved = options.reserved ?? ARGON_RESERVED_SLOTS;
    this.queueLimit = options.queueLimit ?? ARGON_QUEUE_LIMIT;
    this.waitMs = options.waitMs ?? ARGON_WAIT_MS;
  }

  get active(): number {
    return this.inFlight;
  }

  get queued(): number {
    return this.waiting.length;
  }

  /**
   * Run `work` under the gate. `clean` marks a principal with no recent failures —
   * the only kind that may take the reserved slot.
   *
   * Throws ArgonBusyError rather than queueing without bound: a request the caller
   * has already given up on is memory nobody is waiting for.
   */
  async run<T>(key: string, clean: boolean, work: () => Promise<T>): Promise<T> {
    await this.acquire(key, clean);
    try {
      return await work();
    } finally {
      this.release(key);
    }
  }

  private canAdmit(key: string, clean: boolean): boolean {
    if ((this.perKey.get(key) ?? 0) >= 1) return false;
    const ceiling = clean ? this.maxConcurrent : this.maxConcurrent - this.reserved;
    return this.inFlight < ceiling;
  }

  private take(key: string): void {
    this.inFlight += 1;
    this.perKey.set(key, (this.perKey.get(key) ?? 0) + 1);
  }

  private acquire(key: string, clean: boolean): Promise<void> {
    if (this.canAdmit(key, clean)) {
      this.take(key);
      return Promise.resolve();
    }
    if (this.waiting.length >= this.queueLimit) return Promise.reject(new ArgonBusyError());
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        key,
        clean,
        done: false,
        admit: () => resolve(),
        shed: (err) => reject(err),
        timer: setTimeout(() => {
          if (waiter.done) return;
          waiter.done = true;
          this.drop(waiter);
          reject(new ArgonBusyError());
        }, this.waitMs),
      };
      // Never hold the process open on a queue that exists to shed load.
      waiter.timer.unref?.();
      this.waiting.push(waiter);
    });
  }

  private drop(waiter: Waiter): void {
    const at = this.waiting.indexOf(waiter);
    if (at >= 0) this.waiting.splice(at, 1);
  }

  private release(key: string): void {
    this.inFlight -= 1;
    const held = (this.perKey.get(key) ?? 1) - 1;
    if (held <= 0) this.perKey.delete(key);
    else this.perKey.set(key, held);
    this.pump();
  }

  /** FIFO, skipping waiters that cannot run yet: a queue head blocked on its own
   *  per-key cap must not stall everyone behind it. */
  private pump(): void {
    for (let i = 0; i < this.waiting.length; i += 1) {
      const waiter = this.waiting[i] as Waiter;
      if (!this.canAdmit(waiter.key, waiter.clean)) continue;
      this.waiting.splice(i, 1);
      waiter.done = true;
      clearTimeout(waiter.timer);
      this.take(waiter.key);
      waiter.admit();
      return;
    }
  }
}
