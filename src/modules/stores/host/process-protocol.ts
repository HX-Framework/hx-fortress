// What HX Fortress and a Store's process say to each other.
//
// Each open Store runs in a process of its own (store-process.ts says why).
// The two ends talk over the channel the runtime gives a parent and the child
// it started. It is a pair of file descriptors between the two processes: no
// port is opened, and nothing else on the machine can write to it.
//
// The list is closed. A message that is not on it is dropped by either end.

/** HX Fortress to a Store's process. */
export type ToStore =
  /** Open the Store in this folder. Sent once, first. */
  | { t: "open"; folder: string; settings: Readonly<Record<string, string>> }
  /** Run one call of the Store's program. One at a time: the next is sent when
   *  this one is answered. */
  | { t: "call"; id: number; name: string; args: readonly unknown[] }
  /** The Store's alarm is due. The answer's value is `{ alarm }`: the time the
   *  Store wants to be woken at next, or null. */
  | { t: "wake"; id: number }
  /** Close the file and end. */
  | { t: "close" };

/** A Store's process to HX Fortress. */
export type FromStore =
  /** The Store is open. `alarm` is when it wants to be woken, or null. */
  | { t: "opened"; alarm: number | null }
  /** The Store could not be opened. The process ends after it. */
  | { t: "open_failed"; code: string }
  /**
   * The call's answer. With `anew`, the Store's program asked to be started
   * anew: HX Fortress closes this process before it sends it another call,
   * and the next call gets a new process, which opens the Store's file as it
   * then is.
   */
  | { t: "answer"; id: number; ok: true; value: unknown; anew?: true }
  /**
   * The call failed. `code` is one word. `words` is the failure's own message,
   * for the person whose call it was. It can hold a row's value: SQLite puts
   * into a message what a statement gave it to say. So it stays on this
   * machine, and goes into no log, no record and no answer to the control
   * plane.
   */
  | { t: "answer"; id: number; ok: false; code: string; words: string; anew?: true }
  /** The alarm's time changed, and the change is on the disk. Sent before
   *  the answer of the call that changed it. */
  | { t: "alarm"; at: number | null }
  /** The process is ending itself, and why, in one word. */
  | { t: "ending"; code: string };

/** The word the one compiled program is started again with, to be a Store's
 *  process. */
export const STORE_PROCESS_VERB = "store-engine";

export function isFromStore(message: unknown): message is FromStore {
  if (typeof message !== "object" || message === null) return false;
  const t = (message as { t?: unknown }).t;
  return (
    t === "opened" || t === "open_failed" || t === "answer" || t === "alarm" || t === "ending"
  );
}

export function isToStore(message: unknown): message is ToStore {
  if (typeof message !== "object" || message === null) return false;
  const t = (message as { t?: unknown }).t;
  return t === "open" || t === "call" || t === "wake" || t === "close";
}
