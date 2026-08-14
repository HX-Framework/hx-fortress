import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FileLogSink } from "../src/host/file-log-sink";
import {
  readLastLines,
  readLastLinesOfFile,
  rotatedSegments,
  segmentPath,
  watchLines,
} from "../src/log-tail";
import { createProductionLogsDeps, logsCommand, parseLogsArgs } from "../src/cli-logs";
import type { LogRecord } from "../src/host/types";

function record(i: number, module = "fortress"): LogRecord {
  return { ts: `2026-07-31T12:00:${String(i % 60).padStart(2, "0")}.000Z`, module, level: "info", msg: `line ${i}` };
}

describe("the logs argument parser", () => {
  test("--lines consumes its value instead of becoming a module filter", () => {
    // The old parser took the first non-`--` token, found the number, and
    // filtered every record to a module called "100" — an empty log that read
    // as a quiet fortress.
    expect(parseLogsArgs(["--lines", "100"])).toEqual({
      moduleFilter: undefined,
      linesBack: 100,
      follow: true,
    });
    expect(parseLogsArgs(["--lines=25"]).linesBack).toBe(25);
  });

  test("a module filter still works, in either order", () => {
    expect(parseLogsArgs(["gateway", "--lines", "10"]).moduleFilter).toBe("gateway");
    expect(parseLogsArgs(["--lines", "10", "gateway"]).moduleFilter).toBe("gateway");
  });

  test("-f/--follow is accepted, and a bare invocation is unchanged", () => {
    expect(parseLogsArgs([]).follow).toBe(true);
    expect(parseLogsArgs(["-f"]).follow).toBe(true);
    expect(parseLogsArgs(["--follow"]).follow).toBe(true);
    expect(parseLogsArgs([]).linesBack).toBe(50);
  });

  test("a nonsense value falls back rather than showing nothing", () => {
    expect(parseLogsArgs(["--lines", "abc"]).linesBack).toBe(50);
    expect(parseLogsArgs(["--lines", "-3"]).linesBack).toBe(50);
  });
});

describe("the reverse-seek tail", () => {
  let root = "";
  let file = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-logtail-"));
    file = path.join(root, "fortress.jsonl");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("returns the last N lines and nothing else", async () => {
    await writeFile(file, Array.from({ length: 500 }, (_, i) => `line-${i}`).join("\n") + "\n");
    const lines = await readLastLinesOfFile(file, 3);
    expect(lines).toEqual(["line-497", "line-498", "line-499"]);
  });

  test("does not read the whole file", async () => {
    // Well past one chunk: a readFile+split implementation would materialize
    // all of it to show three lines.
    const big = Array.from({ length: 60_000 }, (_, i) => `padding-line-${i}`).join("\n") + "\n";
    await writeFile(file, big);
    expect((await stat(file)).size).toBeGreaterThan(1_000_000);
    expect(await readLastLinesOfFile(file, 2)).toEqual(["padding-line-59998", "padding-line-59999"]);
  });

  test("stitches a line that straddles a chunk boundary", async () => {
    const long = "x".repeat(200_000);
    await writeFile(file, `first\n${long}\nlast\n`);
    const lines = await readLastLinesOfFile(file, 3);
    expect(lines[0]).toBe("first");
    expect(lines[1]).toBe(long);
    expect(lines[2]).toBe("last");
  });

  test("a missing file is empty, not an error", async () => {
    expect(await readLastLinesOfFile(path.join(root, "absent"), 5)).toEqual([]);
  });

  test("--lines N spans rotated segments", async () => {
    await writeFile(segmentPath(file, 2), "old-1\nold-2\n");
    await writeFile(segmentPath(file, 1), "mid-1\nmid-2\n");
    await writeFile(file, "new-1\nnew-2\n");
    expect(await readLastLines(file, 4)).toEqual(["mid-1", "mid-2", "new-1", "new-2"]);
    expect(await readLastLines(file, 6)).toEqual([
      "old-1",
      "old-2",
      "mid-1",
      "mid-2",
      "new-1",
      "new-2",
    ]);
    expect(rotatedSegments(file, 2)).toEqual([segmentPath(file, 1), segmentPath(file, 2)]);
  });
});

describe("size rotation", () => {
  let root = "";
  let file = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-logrotate-"));
    file = path.join(root, "logs", "fortress.jsonl");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("rotates past the size boundary and keeps a bounded number of segments", async () => {
    const sink = new FileLogSink(file, { maxBytes: 400, keep: 2 });
    for (let i = 0; i < 60; i += 1) sink.write(record(i));
    expect((await readFile(file, "utf8")).length).toBeGreaterThan(0);
    expect((await stat(segmentPath(file, 1))).isFile()).toBe(true);
    expect((await stat(segmentPath(file, 2))).isFile()).toBe(true);
    // Bounded: the third segment is dropped, not accumulated forever.
    await expect(stat(segmentPath(file, 3))).rejects.toThrow();
  });

  test("a rotation concurrent with other writes loses neither", async () => {
    // Rename-based rotation is atomic, so an interleaved append lands wholly in
    // the old inode or wholly in the new one.
    // keep is generous on purpose: this asserts nothing is LOST to the
    // rename, not that retention is unbounded.
    const sink = new FileLogSink(file, { maxBytes: 2000, keep: 30 });
    const total = 120;
    for (let i = 0; i < total; i += 1) {
      sink.write(record(i));
      if (i % 7 === 0) await appendFile(file, JSON.stringify(record(1000 + i, "enroll")) + "\n");
    }
    const lines = await readLastLines(file, 1000, 30);
    const parsed = lines.map((l) => JSON.parse(l) as LogRecord);
    expect(parsed.filter((r) => r.module === "fortress").length).toBe(total);
    expect(parsed.filter((r) => r.module === "enroll").length).toBe(Math.ceil(total / 7));
  });
});

describe("following across a rotation", () => {
  let root = "";
  let file = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-logfollow-"));
    file = path.join(root, "fortress.jsonl");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("drops no line when the writer rotates underneath it", async () => {
    await writeFile(file, "");
    const seen: string[] = [];
    const ac = new AbortController();
    const watcher = watchLines(file, (line) => seen.push(line), ac.signal, { pollMs: 5 });
    // Following starts at the END of the file, as tail -f does — the CLI shows
    // the backlog through readLines. Let the watcher attach before writing.
    await Bun.sleep(30);

    // ~4 records per segment, one write every 10ms: the follower polls several
    // times per rotation, which is the regime tail -F is meant for.
    const sink = new FileLogSink(file, { maxBytes: 400, keep: 20 });
    for (let i = 0; i < 40; i += 1) {
      sink.write(record(i));
      await Bun.sleep(10);
    }
    await Bun.sleep(60);
    ac.abort();
    await watcher;

    // Every record appears exactly once, across the rotation boundary — a
    // watcher holding one descriptor would have gone silent at the first one.
    const messages = seen.map((l) => (JSON.parse(l) as LogRecord).msg);
    expect(new Set(messages).size).toBe(40);
    expect(messages.length).toBe(40);
  }, 20_000);

  test("logs -f and logs --lines both produce filtered, non-empty output", async () => {
    const sink = new FileLogSink(file, { maxBytes: 1_000_000 });
    for (let i = 0; i < 120; i += 1) sink.write(record(i, i % 2 === 0 ? "fortress" : "gateway"));

    const written: string[] = [];
    await logsCommand(
      {
        logPath: file,
        moduleFilter: "gateway",
        linesBack: 100,
        follow: false,
        writeLine: (l) => written.push(l),
      },
      createProductionLogsDeps(),
    );
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((l) => l.includes("[gateway]"))).toBe(true);

    const followed: string[] = [];
    const ac = new AbortController();
    const running = logsCommand(
      {
        logPath: file,
        moduleFilter: undefined,
        linesBack: 0,
        follow: true,
        writeLine: (l) => followed.push(l),
        signal: ac.signal,
      },
      createProductionLogsDeps(),
    );
    await Bun.sleep(30);
    sink.write(record(999, "gateway"));
    await Bun.sleep(120);
    ac.abort();
    await running;
    expect(followed.some((l) => l.includes("line 999"))).toBe(true);
  }, 20_000);
});

describe("the live follower and a character split by a POLL boundary", () => {
  test("decodes whole, rather than as two replacement characters", async () => {
    // The backwards reader was fixed for this; `watchLines` — the function the
    // console's live Logs tab actually streams from — was not. It decoded each
    // poll's byte range on its own, so a multi-byte character written across two
    // polls became mojibake on the operator's screen.
    const dir = await mkdtemp(path.join(os.tmpdir(), "hx-poll-straddle-"));
    try {
      const file = path.join(dir, "fortress.jsonl");
      await writeFile(file, "");
      const seen: string[] = [];
      const ac = new AbortController();
      const watcher = watchLines(file, (line) => seen.push(line), ac.signal, { pollMs: 5 });
      await Bun.sleep(30);

      // Written one BYTE at a time, so every multi-byte character is guaranteed
      // to straddle at least one poll.
      const bytes = Buffer.from("日本語のログ行です\n", "utf8");
      const handle = await open(file, "a");
      try {
        for (const byte of bytes) {
          await handle.write(Buffer.from([byte]));
          await Bun.sleep(2);
        }
      } finally {
        await handle.close();
      }
      await Bun.sleep(60);
      ac.abort();
      await watcher;

      expect(seen).toEqual(["日本語のログ行です"]);
      expect(seen.join("")).not.toContain("\uFFFD");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("a character split by a chunk boundary", () => {
  test("decodes whole, rather than as two replacement characters", async () => {
    // The reader walks BACKWARDS in 64 KiB chunks and used to decode each one on
    // its own, so a multi-byte character straddling a boundary was split across
    // two `toString` calls and both halves became U+FFFD — mojibake in
    // `hx-fortress logs` and in the console's backfill. Existing coverage used
    // ASCII only, which cannot straddle.
    const dir = await mkdtemp(path.join(os.tmpdir(), "hx-straddle-"));
    try {
      const file = path.join(dir, "fortress.jsonl");
      // Sized so the multi-byte line lands across the 64 KiB read boundary.
      await writeFile(file, `${"a".repeat(65_530)}\n日本語のログ行です\n`, "utf8");
      const lines = await readLastLines(file, 2, 3);
      expect(lines[lines.length - 1]).toBe("日本語のログ行です");
      expect(lines.join("")).not.toContain("\uFFFD");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
