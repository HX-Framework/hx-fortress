// What the events stream carries: the daemon's log, followed across rotations.
//
// The console's Logs view used to fetch the whole file and slice it in the tab.
// That is two problems - a multi-megabyte download to show fifty lines, and a
// view that goes silent the moment the log rotates, because the tab is holding
// bytes from an inode nothing writes to any more. So the view follows instead,
// over the one long-lived connection the console has.
//
// RESUME is by record timestamp rather than by a per-connection counter. A
// counter is meaningless to the next connection, so a reconnect would replay
// everything the backfill holds; the timestamp is a property of the RECORD, so a
// client that reconnects two seconds later picks up where it was without the
// server holding any per-client state at all.

import { readLastLines, rotateKeepFromEnv, watchLines } from "../log-tail";
import { redactCredentials } from "./redact";
import type { EventProducer, StreamEvent } from "./events";

/** How much history a fresh connection receives before it starts following.
 *  Enough to fill a view, small enough that opening one is not a download. */
export const LOG_BACKFILL_LINES = 200;

export interface LogEventProducerOptions {
  logPath: string;
  backfill?: number;
  env?: Record<string, string | undefined>;
  /** Injected in tests; the follow poll cadence. */
  pollMs?: number;
}

interface LogRecordish {
  ts?: unknown;
  module?: unknown;
  level?: unknown;
}

function timestampOf(line: string): string | null {
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object") return null;
    const ts = (value as LogRecordish).ts;
    return typeof ts === "string" ? ts : null;
  } catch {
    return null;
  }
}

/**
 * The daemon log as a stream of events.
 *
 * A line that does not parse is still delivered - a torn write or a stray stdout
 * line is exactly what somebody reading the log at 3am needs to see - but it
 * carries no id, so it can never move a client's resume point backwards.
 */
export function createLogEventProducer(options: LogEventProducerOptions): EventProducer {
  const keep = rotateKeepFromEnv(options.env ?? process.env);
  return {
    async start(sink: (event: StreamEvent) => void, signal: AbortSignal, lastEventId: string | null) {
      const since = lastEventId ? Date.parse(lastEventId) : NaN;
      const history = await readLastLines(options.logPath, options.backfill ?? LOG_BACKFILL_LINES, keep).catch(
        () => [] as string[],
      );
      for (const line of history) {
        if (signal.aborted) return;
        const ts = timestampOf(line);
        // Already seen by this client. Comparing on the RECORD's own timestamp is
        // what makes the resume point survive a reconnect.
        if (Number.isFinite(since) && ts && Date.parse(ts) <= since) continue;
        sink({ event: "log", ...(ts ? { id: ts } : {}), data: { line: redactCredentials(line) } });
      }
      if (signal.aborted) return;
      sink({ event: "log-backfill-complete", data: { lines: history.length } });
      await watchLines(
        options.logPath,
        (line) => {
          const ts = timestampOf(line);
          // Redacted on the way out, like every other value this console emits.
          // These are raw daemon log lines — driver errors quote connection
          // strings, an object-store rejection quotes the key it was handed —
          // and the stream is reachable by a readonly session.
          sink({ event: "log", ...(ts ? { id: ts } : {}), data: { line: redactCredentials(line) } });
        },
        signal,
        options.pollMs ? { pollMs: options.pollMs } : {},
      );
    },
  };
}
