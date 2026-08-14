import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "bun:test";
import { FileLogSink } from "../src/host/file-log-sink";
import type { LogRecord } from "../src/host/types";

const makeRecord = (overrides: Partial<LogRecord> = {}): LogRecord => ({
  ts: "2024-01-01T00:00:00.000Z",
  module: "test-module",
  level: "info",
  msg: "hello",
  ...overrides,
});

let tmpDir = "";

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  }
});

test("creates directory and writes a valid JSONL line", () => {
  tmpDir = join(tmpdir(), "fls-test-" + Date.now());
  const logPath = join(tmpDir, "sub", "test.jsonl");
  const sink = new FileLogSink(logPath);
  const record = makeRecord();

  sink.write(record);

  const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toEqual(record);
});

test("writes multiple records as separate JSONL lines", () => {
  tmpDir = join(tmpdir(), "fls-test-" + Date.now());
  const logPath = join(tmpDir, "test.jsonl");
  const sink = new FileLogSink(logPath);
  const r1 = makeRecord({ msg: "first" });
  const r2 = makeRecord({ msg: "second", level: "warn" });

  sink.write(r1);
  sink.write(r2);

  const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[0]!)).toEqual(r1);
  expect(JSON.parse(lines[1]!)).toEqual(r2);
});
