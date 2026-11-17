// The alarm of each Store, kept by the module.
//
// A Store's engine asks to be woken at a time: to go on with a job, to keep a
// count. On the platform it was written for, the platform wakes it. Here the
// module does. A Store has one alarm. Its time is kept in the Store's folder
// (store-folder.ts), so it outlives the Store's process and HX Fortress
// itself: when the module starts it reads every Store's time again.
//
// WHAT THE ALARM IS AFTER A WAKE is the Store's to say: `wake` answers the
// time the Store wants to be woken at next, or null. A time told meanwhile
// (`set`) is used only when the wake fails, or answers nothing.
//
// A Store is woken at least once for each alarm. A wake that cannot be taken
// just now (`WakeLater`: there is no room for one more process) is tried again
// after two seconds, as often as it takes: it is no failure, and it is not
// counted.
//
// When waking fails, the alarm stands and the Store is woken again later:
// after 2 seconds, then 4, and so on, six times. The count of failed tries
// stands until the alarm's time changes or a wake goes well: being told the
// same time again, as each new process of the Store does when it opens, does
// not start it anew. After the last try the module gives the alarm up. That
// time is then not taken again until a call changes the Store's alarm, or
// HX Fortress starts again.

/** What `wake` rejects with when the Store cannot be woken just now, and
 *  nothing is wrong with it: the alarm stands, and is tried again soon. */
export class WakeLater extends Error {
  constructor() {
    super("the Store cannot be woken just now");
    this.name = "WakeLater";
  }
}

export interface StoreAlarmsOptions {
  /**
   * Wake the Store named `key`. Answers the time the Store wants to be woken
   * at next, or null for none, or nothing where it cannot say. Rejects when
   * the Store could not be woken, and with `WakeLater` when it only has to
   * wait.
   */
  wake(key: string): Promise<number | null | void>;
  now?: () => number;
  /** Called when a Store could not be woken after every try. */
  onGiveUp?: (key: string) => void;
  /** The wait before the first new try, doubled for each try after it. */
  retryBaseMs?: number;
  /** The longest one timer waits before the alarm is looked at again. */
  longestWaitMs?: number;
}

/** A timer cannot wait longer than this. A later alarm is looked at again
 *  when this much time has passed. */
const LONGEST_WAIT_MS = 60 * 60 * 1000;
export const WAKE_RETRIES = 6;
export const WAKE_RETRY_BASE_MS = 2_000;

interface Entry {
  at: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** How many times in a row waking failed. */
  failed: number;
  waking: boolean;
  /** What was told while the Store was being woken: a time, null for none,
   *  or undefined when nothing was told. */
  told: number | null | undefined;
}

export class StoreAlarms {
  private readonly entries = new Map<string, Entry>();
  /** The time of each alarm that was given up. */
  private readonly givenUp = new Map<string, number>();
  private readonly options: StoreAlarmsOptions;
  private stopped = false;

  constructor(options: StoreAlarmsOptions) {
    this.options = options;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** The time the Store named `key` is woken at next, or null. */
  at(key: string): number | null {
    return this.entries.get(key)?.at ?? null;
  }

  /** How many Stores wait for an alarm. */
  get size(): number {
    return this.entries.size;
  }

  /** The Store's alarm is now `at`, or it has none. */
  set(key: string, at: number | null): void {
    if (this.stopped) return;
    const entry = this.entries.get(key);
    if (entry?.waking) {
      // While the Store is being woken, its old alarm is being spent. What the
      // wake answers decides. This is used when it answers nothing.
      entry.told = at;
      return;
    }
    if (at === null) {
      if (entry?.timer) clearTimeout(entry.timer);
      this.entries.delete(key);
      this.givenUp.delete(key);
      return;
    }
    // The same time told again changes nothing: not the timer, not the count
    // of failed tries, and not an alarm that was given up.
    if (entry?.at === at || this.givenUp.get(key) === at) return;
    this.givenUp.delete(key);
    if (entry?.timer) clearTimeout(entry.timer);
    const fresh: Entry = { at, timer: null, failed: 0, waking: false, told: undefined };
    this.entries.set(key, fresh);
    this.arm(key, fresh, at - this.now());
  }

  private arm(key: string, entry: Entry, inMs: number): void {
    const wait = Math.min(Math.max(0, inMs), this.options.longestWaitMs ?? LONGEST_WAIT_MS);
    entry.timer = setTimeout(() => void this.due(key), wait);
    (entry.timer as { unref?: () => void }).unref?.();
  }

  /** The timer of `key` fired. Never rejects. */
  private async due(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry || entry.waking || this.stopped) return;
    entry.timer = null;
    const left = entry.at - this.now();
    if (left > 0) {
      // A long wait, looked at again.
      this.arm(key, entry, left);
      return;
    }
    entry.waking = true;
    entry.told = undefined;
    let answered: number | null | undefined;
    let woken = true;
    let later = false;
    try {
      const answer = await this.options.wake(key);
      answered = typeof answer === "number" || answer === null ? answer : undefined;
    } catch (thrown) {
      woken = false;
      later = thrown instanceof WakeLater;
    }
    entry.waking = false;
    const told = entry.told;
    entry.told = undefined;
    if (this.stopped || this.entries.get(key) !== entry) return;

    if (later) {
      // Nothing was woken and nothing failed. A time told meanwhile is the
      // alarm now. Either way it is looked at again soon.
      if (told === null) {
        this.entries.delete(key);
        return;
      }
      if (typeof told === "number") entry.at = told;
      const soon = this.options.retryBaseMs ?? WAKE_RETRY_BASE_MS;
      this.arm(key, entry, Math.max(soon, entry.at - this.now()));
      return;
    }

    if (woken) {
      // The Store's own answer, or what it told meanwhile, or nothing: an
      // alarm that nobody set again was spent by this wake.
      const next = answered !== undefined ? answered : (told ?? null);
      if (next === null) {
        this.entries.delete(key);
        return;
      }
      entry.at = next;
      entry.failed = 0;
      this.arm(key, entry, next - this.now());
      return;
    }

    // The wake failed. A new time that the Store set before it failed is a new
    // alarm, as on the platform: it is waited for, and its tries start anew.
    if (typeof told === "number" && told !== entry.at) {
      entry.at = told;
      entry.failed = 0;
      this.arm(key, entry, told - this.now());
      return;
    }
    entry.failed += 1;
    if (entry.failed > WAKE_RETRIES) {
      this.entries.delete(key);
      this.givenUp.set(key, entry.at);
      try {
        this.options.onGiveUp?.(key);
      } catch {
        // A listener's failure is its own.
      }
      return;
    }
    this.arm(key, entry, (this.options.retryBaseMs ?? WAKE_RETRY_BASE_MS) * 2 ** (entry.failed - 1));
  }

  /** Forget a Store: it was removed. */
  forget(key: string): void {
    const entry = this.entries.get(key);
    if (entry?.timer) clearTimeout(entry.timer);
    this.entries.delete(key);
    this.givenUp.delete(key);
  }

  /** Stop every timer. Nothing is woken after this. */
  stop(): void {
    this.stopped = true;
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.entries.clear();
    this.givenUp.clear();
  }
}
