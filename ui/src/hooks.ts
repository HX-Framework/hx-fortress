// Fetching, polling, and the four states a panel can be in.
//
// Every panel that reads the fortress is in exactly one of them: loading (no
// answer yet), ready (an answer), stale (an answer that is no longer current
// because the last refresh failed), or failed (no answer at all and a reason).
// STALE is the one a naive hook drops: on a refresh error it either keeps
// rendering the old numbers as if they were current, or blanks a page that was
// working a second ago. Both are wrong, so the data is kept AND marked.

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "./api";

export interface Resource<T> {
  data: T | null;
  /** Set once an answer has failed to refresh. The data is the last good one. */
  stale: boolean;
  /** The server's own sentence, never a paraphrase. */
  error: string | null;
  status: number | null;
  loading: boolean;
  reload: () => void;
}

export interface ResourceOptions {
  /** Refresh cadence. Omitted means fetch once. */
  pollMs?: number;
  /** False parks the resource: nothing is fetched while the view is off-screen. */
  active?: boolean;
}

export function useResource<T>(
  load: () => Promise<T>,
  deps: readonly unknown[],
  options: ResourceOptions = {},
): Resource<T> {
  const active = options.active ?? true;
  const [state, setState] = useState<{ data: T | null; stale: boolean; error: string | null; status: number | null }>(
    { data: null, stale: false, error: null, status: null },
  );
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const run = async (): Promise<void> => {
      setLoading(true);
      try {
        const data = await loadRef.current();
        if (cancelled) return;
        setState({ data, stale: false, error: null, status: null });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "the fortress did not answer";
        const status = err instanceof ApiError ? err.status : null;
        // A failed refresh keeps what it had and says so; a failed FIRST load has
        // nothing to keep.
        setState((prev) => ({ data: prev.data, stale: prev.data !== null, error: message, status }));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    if (!options.pollMs) return () => {
      cancelled = true;
    };
    const timer = setInterval(() => void run(), options.pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, options.pollMs, tick, ...deps]);

  return { ...state, loading, reload };
}
