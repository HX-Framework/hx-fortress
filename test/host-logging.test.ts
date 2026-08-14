import { describe, expect, test } from "bun:test";

import { BusHostLogger, LogBus } from "../src/host/logging";
import type { LogRecord, LogSink } from "../src/host/types";

function captureSink(): { records: LogRecord[]; sink: LogSink } {
  const records: LogRecord[] = [];
  const sink: LogSink = {
    write(record) {
      records.push(record);
    },
  };
  return { records, sink };
}

describe("LogBus", () => {
  test("scopeFor stamps the module id on every record", () => {
    const { records, sink } = captureSink();
    const bus = new LogBus(sink, () => new Date("2026-06-15T12:00:00.000Z"));
    bus.scopeFor("session_vault").info("bucket ready");

    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      ts: "2026-06-15T12:00:00.000Z",
      module: "session_vault",
      level: "info",
      msg: "bucket ready",
    });
  });

  test("each level maps to the correct level field", () => {
    const { records, sink } = captureSink();
    const bus = new LogBus(sink, () => new Date("2026-06-15T12:00:00.000Z"));
    const logger = bus.scopeFor("mod");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(records.map((r) => r.level)).toEqual(["debug", "info", "warn", "error"]);
  });

  test("fields key is absent from the record when not supplied", () => {
    const { records, sink } = captureSink();
    const bus = new LogBus(sink);
    bus.scopeFor("mod").info("no fields");

    expect("fields" in records[0]).toBe(false);
  });

  test("fields key is present and matches when supplied", () => {
    const { records, sink } = captureSink();
    const bus = new LogBus(sink);
    bus.scopeFor("mod").info("with fields", { key: "value", count: 3 });

    expect(records[0].fields).toEqual({ key: "value", count: 3 });
  });

  test("host logger stamps module as 'fortress'", () => {
    const { records, sink } = captureSink();
    const bus = new LogBus(sink);
    bus.host.warn("connection dropped");

    expect(records[0].module).toBe("fortress");
  });

  test("host getter returns the same logger instance each time", () => {
    const { sink } = captureSink();
    const bus = new LogBus(sink);

    expect(bus.host).toBe(bus.host);
  });

  test("ts reflects the injected clock", () => {
    const { records, sink } = captureSink();
    const times = [
      new Date("2026-06-15T12:00:00.000Z"),
      new Date("2026-06-15T12:00:01.000Z"),
    ];
    const bus = new LogBus(sink, () => times.shift()!);
    const logger = bus.scopeFor("mod");
    logger.info("first");
    logger.info("second");

    expect(records[0].ts).toBe("2026-06-15T12:00:00.000Z");
    expect(records[1].ts).toBe("2026-06-15T12:00:01.000Z");
  });
});

describe("BusHostLogger", () => {
  test("error with Error arg produces fields.error = error.message", () => {
    const { records, sink } = captureSink();
    const bus = new LogBus(sink);
    new BusHostLogger(bus).error("startup failed", new Error("timeout"));

    expect(records[0]).toMatchObject({
      module: "fortress",
      level: "error",
      msg: "startup failed",
      fields: { error: "timeout" },
    });
  });

  test("error with non-Error arg coerces to string", () => {
    const { records, sink } = captureSink();
    const bus = new LogBus(sink);
    new BusHostLogger(bus).error("bad", "raw string");

    expect(records[0].fields).toEqual({ error: "raw string" });
  });

  test("error with no second arg produces no fields key", () => {
    const { records, sink } = captureSink();
    const bus = new LogBus(sink);
    new BusHostLogger(bus).error("plain error");

    expect("fields" in records[0]).toBe(false);
  });
});
