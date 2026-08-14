import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

import { rotateKeepFromEnv, rotateSizeFromEnv, segmentPath } from "../log-tail";
import type { LogRecord, LogSink } from "./types";

/**
 * The daemon's JSONL log, rotated by size.
 *
 * Rotation is rename-based (`<log>` → `<log>.1`, shifting the rest down) rather
 * than copy-and-truncate: a rename is atomic, so a concurrent writer's
 * `appendFileSync` lands wholly in the old inode or wholly in the new one and
 * no record is torn or lost. The reader side follows by inode for the same
 * reason — see log-tail.ts.
 */
export class FileLogSink implements LogSink {
  private dirReady = false;
  private readonly maxBytes: number;
  private readonly keep: number;

  constructor(
    private readonly logPath: string,
    options: { maxBytes?: number; keep?: number } = {},
  ) {
    this.maxBytes = options.maxBytes ?? rotateSizeFromEnv();
    this.keep = options.keep ?? rotateKeepFromEnv();
  }

  write(record: LogRecord): void {
    if (!this.dirReady) {
      // 0700/0600. Every other secret-adjacent writer in this codebase is
      // explicit about its mode; this one took the umask default, so the daemon
      // log — which quotes raw driver and SDK errors — and each rotated segment
      // were world-readable on a multi-user host.
      const dir = dirname(this.logPath);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // CHMOD, not just mode-on-create. `mkdirSync`'s mode applies only to a
      // directory it creates and `appendFileSync`'s only to a file that does not
      // exist, so on every upgraded install both were no-ops: logs/ stayed 0755
      // and fortress.jsonl 0644 forever, holding unredacted driver errors — DSN
      // passwords, key pairs, service-account keys. Fresh installs were correct,
      // which is exactly why it read as fixed.
      chmodSync(dir, 0o700);
      for (const p of [this.logPath, ...this.rotatedSegments()]) {
        try {
          chmodSync(p, 0o600);
        } catch {
          // Absent yet, or not ours. The mode on create covers the first, and
          // the second is not this process's to correct.
        }
      }
      this.dirReady = true;
    }
    this.rotateIfNeeded();
    appendFileSync(this.logPath, JSON.stringify(record) + "\n", { mode: 0o600 });
  }

  /** Every rotated segment this sink can own, whether or not it exists yet. */
  private rotatedSegments(): string[] {
    return Array.from({ length: this.keep }, (_, i) => segmentPath(this.logPath, i + 1));
  }

  private rotateIfNeeded(): void {
    let size: number;
    try {
      size = statSync(this.logPath).size;
    } catch {
      return; // no file yet — nothing to rotate
    }
    if (size < this.maxBytes) return;
    try {
      const oldest = segmentPath(this.logPath, this.keep);
      if (existsSync(oldest)) unlinkSync(oldest);
      for (let i = this.keep - 1; i >= 1; i -= 1) {
        const from = segmentPath(this.logPath, i);
        if (existsSync(from)) renameSync(from, segmentPath(this.logPath, i + 1));
      }
      renameSync(this.logPath, segmentPath(this.logPath, 1));
    } catch {
      // A rotation that cannot happen must never stop the daemon logging;
      // the next write simply appends to the oversized file and retries.
    }
  }
}
