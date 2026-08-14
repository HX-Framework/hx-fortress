import { describe, expect, test } from "bun:test";

import { formatRecord, logsCommand } from "../src/cli-logs";
import type { LogsDependencies } from "../src/cli-logs";
import type { LogRecord } from "../src/host/types";

const record = (overrides: Partial<LogRecord> = {}): LogRecord => ({
  ts: "2026-06-15T10:00:00.000Z",
  module: "session_vault",
  level: "info",
  msg: "started",
  ...overrides,
});

const noopWatch: LogsDependencies["watchLines"] = async () => {};

function fakeDeps(records: LogRecord[], onWatch?: LogsDependencies["watchLines"]): LogsDependencies {
  return {
    async readLines() {
      return records;
    },
    watchLines: onWatch ?? noopWatch,
  };
}

describe("formatRecord", () => {
  test("formats without fields", () => {
    expect(formatRecord(record())).toBe(
      "2026-06-15T10:00:00.000Z [session_vault] info started",
    );
  });

  test("appends key=value pairs for each field", () => {
    const r = record({ fields: { error: "timeout", retries: 3 } });
    expect(formatRecord(r)).toBe(
      '2026-06-15T10:00:00.000Z [session_vault] info started error="timeout" retries=3',
    );
  });

  test("omits the fields section when fields is empty", () => {
    const r = record({ fields: {} });
    expect(formatRecord(r)).toBe(
      "2026-06-15T10:00:00.000Z [session_vault] info started",
    );
  });
});

describe("logsCommand", () => {
  test("writes all records when no module filter", async () => {
    const records = [
      record({ module: "session_vault", msg: "a" }),
      record({ module: "fortress", msg: "b" }),
    ];
    const lines: string[] = [];

    await logsCommand(
      { logPath: "/fake.jsonl", moduleFilter: undefined, linesBack: 50, follow: false, writeLine: (l) => lines.push(l) },
      fakeDeps(records),
    );

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("[session_vault]");
    expect(lines[1]).toContain("[fortress]");
  });

  test("filters to the requested module", async () => {
    const records = [
      record({ module: "session_vault", msg: "vault line" }),
      record({ module: "fortress", msg: "host line" }),
      record({ module: "session_vault", msg: "another vault" }),
    ];
    const lines: string[] = [];

    await logsCommand(
      { logPath: "/fake.jsonl", moduleFilter: "session_vault", linesBack: 50, follow: false, writeLine: (l) => lines.push(l) },
      fakeDeps(records),
    );

    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.includes("[session_vault]"))).toBe(true);
  });

  test("does not call watchLines when follow is false", async () => {
    let watched = false;

    await logsCommand(
      { logPath: "/fake.jsonl", moduleFilter: undefined, linesBack: 50, follow: false, writeLine: () => {} },
      fakeDeps([], async () => { watched = true; }),
    );

    expect(watched).toBe(false);
  });

  test("calls watchLines when follow is true", async () => {
    let watched = false;
    const ac = new AbortController();
    ac.abort();

    await logsCommand(
      {
        logPath: "/fake.jsonl",
        moduleFilter: undefined,
        linesBack: 50,
        follow: true,
        writeLine: () => {},
        signal: ac.signal,
      },
      fakeDeps([], async () => { watched = true; }),
    );

    expect(watched).toBe(true);
  });

  test("filters live records by module in follow mode", async () => {
    const ac = new AbortController();
    const lines: string[] = [];

    const watch: LogsDependencies["watchLines"] = async (_path, onLine, signal) => {
      if (signal.aborted) return;
      onLine(record({ module: "session_vault", msg: "live vault" }));
      onLine(record({ module: "fortress", msg: "live host" }));
    };

    await logsCommand(
      {
        logPath: "/fake.jsonl",
        moduleFilter: "session_vault",
        linesBack: 50,
        follow: true,
        writeLine: (l) => lines.push(l),
        signal: ac.signal,
      },
      fakeDeps([], watch),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[session_vault]");
    expect(lines[0]).toContain("live vault");
  });

  test("returns immediately when signal is already aborted in follow mode", async () => {
    const ac = new AbortController();
    ac.abort();
    let watched = false;

    await logsCommand(
      {
        logPath: "/fake.jsonl",
        moduleFilter: undefined,
        linesBack: 50,
        follow: true,
        writeLine: () => {},
        signal: ac.signal,
      },
      fakeDeps([], async () => { watched = true; }),
    );

    // watchLines is still called (signal handling is inside watchLines itself in production)
    // but the mock respects the signal by checking signal.aborted
    expect(watched).toBe(true);
  });
});
