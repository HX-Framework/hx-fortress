// A3 · the ingest → embed-worker nudge. ingest.ts runs on the commit path and
// must stay decoupled from the worker (which boots separately in main.ts), so it
// calls `signalEmbedWork()` AFTER its transaction commits — best-effort, never
// throwing back into the commit. main.ts registers the live worker's `signal`
// once it's built (mirrors the `hubNotify.send` repoint pattern in main.ts); the
// default is a no-op, so an ingest before the worker is wired simply isn't
// signalled (the next signal, or the worker's startup drain, picks the turns up
// via the anti-join).

type SignalHandler = () => void;

let handler: SignalHandler = () => {};

/** Wire the worker's debounce nudge. Pass `() => {}` to unwire (e.g. on stop). */
export function setEmbedSignalHandler(fn: SignalHandler): void {
  handler = fn;
}

/** Nudge the embed worker that new indexable turns may have landed. Swallows
 *  everything — a failed signal must never fail the upload that triggered it. */
export function signalEmbedWork(): void {
  try {
    handler();
  } catch {
    // best-effort
  }
}
