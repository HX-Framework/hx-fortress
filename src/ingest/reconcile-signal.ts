// The known-failure → guarantor nudge (MC-2606). The best-effort ingest mirror
// (gateway HTTP + tunnel RPC) swallows a Postgres-unavailable / index-failed
// error after the canonical is durably stored — which is exactly how a canonical
// ends up row-less. Those sites call `signalReconcile()` so Component G re-indexes
// the orphan within its debounce window instead of waiting up to a full scan
// interval. Mirrors the embed-worker `signalEmbedWork` seam: ingest stays
// decoupled from the guarantor (built separately in main.ts), the default is a
// no-op (a failure before the guarantor is wired just waits for the next scan),
// and it never throws back into the commit path.

type SignalHandler = () => void;

let handler: SignalHandler = () => {};

/** Wire the guarantor's nudge. Pass `() => {}` to unwire (e.g. on stop). */
export function setReconcileSignalHandler(fn: SignalHandler): void {
  handler = fn;
}

/** Nudge the guarantor that a canonical may have been left row-less. Swallows
 *  everything — a failed signal must never fail the upload that triggered it. */
export function signalReconcile(): void {
  try {
    handler();
  } catch {
    // best-effort
  }
}
