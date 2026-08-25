import { describe, expect, test } from "bun:test";
import {
  createPoolOccupancyLog,
  occupancyLogIntervalMs,
  summarize,
  type OccupancyRow,
} from "../src/host/postgres/pool-occupancy-log";
import type { ScopedLogger } from "../src/host/types";

function captureLogger(): { logger: ScopedLogger; lines: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> } {
  const lines: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
  const logger: ScopedLogger = {
    debug: (msg, fields) => lines.push({ level: "debug", msg, fields }),
    info: (msg, fields) => lines.push({ level: "info", msg, fields }),
    warn: (msg, fields) => lines.push({ level: "warn", msg, fields }),
    error: (msg, fields) => lines.push({ level: "error", msg, fields }),
  };
  return { logger, lines };
}

describe("pool occupancy log", () => {
  test("interval env: default / empty / explicit / 0-disables / invalid-falls-back", () => {
    expect(occupancyLogIntervalMs({})).toBe(60_000);
    expect(occupancyLogIntervalMs({ FORTRESS_DB_OCCUPANCY_LOG_MS: "  " })).toBe(60_000);
    expect(occupancyLogIntervalMs({ FORTRESS_DB_OCCUPANCY_LOG_MS: "30000" })).toBe(30_000);
    expect(occupancyLogIntervalMs({ FORTRESS_DB_OCCUPANCY_LOG_MS: "0" })).toBe(0);
    expect(occupancyLogIntervalMs({ FORTRESS_DB_OCCUPANCY_LOG_MS: "-5" })).toBe(60_000);
    expect(occupancyLogIntervalMs({ FORTRESS_DB_OCCUPANCY_LOG_MS: "nope" })).toBe(60_000);
  });

  test("summarize buckets ro/rw/bg + ages, ignores the sampler's own conn class in otherTotal", () => {
    const rows: OccupancyRow[] = [
      { app: "hx-ro", state: "active", n: 5, oldest_query_s: 12, oldest_state_s: 12 },
      { app: "hx-ro", state: "idle", n: 3, oldest_query_s: 0, oldest_state_s: 40 },
      { app: "hx-ro", state: "idle in transaction", n: 2, oldest_query_s: 0, oldest_state_s: 90 },
      { app: "hx-rw", state: "active", n: 4, oldest_query_s: 1, oldest_state_s: 1 },
      { app: "hx-bg", state: "idle", n: 1, oldest_query_s: 0, oldest_state_s: 5 },
      { app: "hx-occupancy", state: "active", n: 1, oldest_query_s: 0, oldest_state_s: 0 },
      { app: "(other)", state: "idle", n: 7, oldest_query_s: 0, oldest_state_s: 100 },
    ];
    const s = summarize(rows);
    expect(s.roTotal).toBe(10);
    expect(s.roActive).toBe(5);
    expect(s.roIdle).toBe(3);
    expect(s.roIdleInTx).toBe(2);
    expect(s.roOldestActiveS).toBe(12);
    expect(s.roOldestIdleTxS).toBe(90);
    expect(s.rwTotal).toBe(4);
    expect(s.bgTotal).toBe(1);
    expect(s.otherTotal).toBe(7); // hx-occupancy excluded from otherTotal
    expect(s.backends).toBe(23); // everything, including the sampler conn
  });

  test("tick logs one summary via the sample seam", async () => {
    const { logger, lines } = captureLogger();
    const occ = createPoolOccupancyLog({
      dsn: () => "postgres://x",
      logger,
      sample: async () => [{ app: "hx-ro", state: "active", n: 7, oldest_query_s: 3, oldest_state_s: 3 }],
    });
    await occ.tick();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe("info");
    expect(lines[0]!.msg).toBe("hx-db pool occupancy");
    expect(lines[0]!.fields!.roActive).toBe(7);
  });

  test("null sample (provider not ready) logs nothing", async () => {
    const { logger, lines } = captureLogger();
    const occ = createPoolOccupancyLog({ dsn: () => null, logger, sample: async () => null });
    await occ.tick();
    expect(lines).toHaveLength(0);
  });

  test("a throwing sample warns, never throws out of tick", async () => {
    const { logger, lines } = captureLogger();
    const occ = createPoolOccupancyLog({
      dsn: () => "postgres://x",
      logger,
      sample: async () => {
        throw new Error("boom");
      },
    });
    await occ.tick();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe("warn");
    expect(lines[0]!.msg).toBe("hx-db pool occupancy sample failed");
  });

  test("interval 0 disables (warns, no timer)", () => {
    const { logger, lines } = captureLogger();
    const occ = createPoolOccupancyLog({ dsn: () => "x", logger, intervalMs: 0, sample: async () => [] });
    occ.start();
    expect(lines.some((l) => l.level === "warn" && /disabled/.test(l.msg))).toBe(true);
  });
});
