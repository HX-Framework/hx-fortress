// <root>/runtime/metrics.json — the daemon's counters, republished every 10s.
//
// A file rather than an endpoint, for the same reason the whole console
// transport is files: it needs no new authenticated listener, it survives a
// daemon that is up but not serving, and it is honestly ABSENT when the daemon
// is not running at all.
//
// Labels are honest: a source that is switched off publishes NOTHING rather
// than a zero, because a zero and "the direct gateway is not enabled on this
// fortress" read identically on a dashboard and mean opposite things.

import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface MetricsSnapshot {
  schemaVersion: 1;
  writtenAt: string;
  counters: Record<string, number>;
  gauges: Record<string, number>;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, () => number | null>();

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  /** Ensure a counter is PRESENT at zero — for a source that exists on this
   *  fortress but has not fired yet, which is a different fact from a source
   *  that is switched off. */
  declareCounter(name: string): void {
    if (!this.counters.has(name)) this.counters.set(name, 0);
  }

  /** A gauge returning null is omitted from the snapshot: the reading is
   *  unavailable, and publishing 0 would be a lie. */
  registerGauge(name: string, read: () => number | null): void {
    this.gauges.set(name, read);
  }

  snapshot(now: Date = new Date()): MetricsSnapshot {
    const gauges: Record<string, number> = {};
    for (const [name, read] of this.gauges) {
      let value: number | null;
      try {
        value = read();
      } catch {
        value = null;
      }
      if (value !== null && Number.isFinite(value)) gauges[name] = value;
    }
    return {
      schemaVersion: 1,
      writtenAt: now.toISOString(),
      counters: Object.fromEntries(this.counters),
      gauges,
    };
  }
}

export async function writeMetrics(filePath: string, snapshot: MetricsSnapshot): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, filePath);
}

export interface MetricsPublisher {
  stop(): void;
  /** Publish immediately — used at boot so the file exists before the first tick. */
  flush(): Promise<void>;
}

export const METRICS_INTERVAL_MS = 10_000;

export function startMetricsPublisher(args: {
  registry: MetricsRegistry;
  filePath: string;
  intervalMs?: number;
  clock?: () => Date;
  onError?: (err: unknown) => void;
}): MetricsPublisher {
  const clock = args.clock ?? ((): Date => new Date());
  const flush = async (): Promise<void> => {
    try {
      await writeMetrics(args.filePath, args.registry.snapshot(clock()));
    } catch (err) {
      args.onError?.(err);
    }
  };
  const timer = setInterval(() => void flush(), args.intervalMs ?? METRICS_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  return { stop: () => clearInterval(timer), flush };
}
