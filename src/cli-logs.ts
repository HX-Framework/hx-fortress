import { readLastLines, watchLines } from "./log-tail";
import type { LogRecord } from "./host/types";

export interface LogsDependencies {
  readLines(path: string, n: number): Promise<LogRecord[]>;
  watchLines(
    path: string,
    onLine: (r: LogRecord) => void,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface LogsOptions {
  logPath: string;
  moduleFilter: string | undefined;
  linesBack: number;
  follow: boolean;
  writeLine: (line: string) => void;
  signal?: AbortSignal;
}

export const DEFAULT_LINES_BACK = 50;

export interface ParsedLogsArgs {
  moduleFilter: string | undefined;
  linesBack: number;
  follow: boolean;
}

/**
 * Parse `logs [module] [--lines N] [-f|--follow]`.
 *
 * `--lines` CONSUMES its value. Without that, `logs --lines 100` scanned for
 * the first token that did not start with `--`, found `100`, and filtered the
 * output to a module named "100" — an empty log that looked like a quiet
 * fortress. Following stays the default, as it has always been for a bare
 * `hx-fortress logs`; `-f` makes the intent explicit.
 */
export function parseLogsArgs(args: readonly string[]): ParsedLogsArgs {
  let moduleFilter: string | undefined;
  let linesBack = DEFAULT_LINES_BACK;
  let follow = true;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    // `-n` too, because that is what `help` publishes and what the console's
    // Command Line panel renders. Consuming only `--lines` left `-n` matched by
    // the `startsWith("-")` skip below while its VALUE fell through to the
    // module filter: `hx-fortress logs -n 100` filtered to a module named "100",
    // printed nothing, and followed forever.
    if (arg === "--lines" || arg === "-n") {
      const value = Number(args[i + 1]);
      if (Number.isFinite(value) && value >= 0) linesBack = Math.trunc(value);
      i += 1;
      continue;
    }
    if (arg.startsWith("--lines=") || arg.startsWith("-n=")) {
      const value = Number(arg.slice(arg.indexOf("=") + 1));
      if (Number.isFinite(value) && value >= 0) linesBack = Math.trunc(value);
      continue;
    }
    if (arg === "-f" || arg === "--follow") {
      follow = true;
      continue;
    }
    if (arg.startsWith("-")) continue;
    moduleFilter ??= arg;
  }
  return { moduleFilter, linesBack, follow };
}

export function formatRecord(record: LogRecord): string {
  let line = `${record.ts} [${record.module}] ${record.level} ${record.msg}`;
  if (record.fields) {
    const pairs = Object.entries(record.fields)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    if (pairs) line += ` ${pairs}`;
  }
  return line;
}

export async function logsCommand(
  options: LogsOptions,
  deps: LogsDependencies,
): Promise<void> {
  const { logPath, moduleFilter, linesBack, follow, writeLine } = options;

  const records = await deps.readLines(logPath, linesBack);
  for (const record of records) {
    if (moduleFilter === undefined || record.module === moduleFilter) {
      writeLine(formatRecord(record));
    }
  }

  if (!follow) return;

  let signal = options.signal;
  let cleanup: (() => void) | undefined;

  if (!signal) {
    const ac = new AbortController();
    const onSig = () => ac.abort();
    process.once("SIGINT", onSig);
    signal = ac.signal;
    cleanup = () => process.removeListener("SIGINT", onSig);
  }

  try {
    await deps.watchLines(
      logPath,
      (r) => {
        if (moduleFilter === undefined || r.module === moduleFilter) {
          writeLine(formatRecord(r));
        }
      },
      signal,
    );
  } finally {
    cleanup?.();
  }
}

function parseRecord(line: string): LogRecord | undefined {
  try {
    return JSON.parse(line) as LogRecord;
  } catch {
    return undefined;
  }
}

export function createProductionLogsDeps(): LogsDependencies {
  return {
    async readLines(path: string, n: number): Promise<LogRecord[]> {
      // Bounded reverse seek, spanning rotated segments — showing `--lines 500`
      // must not read a multi-GB file, and must not stop short at a rotation.
      const lines = await readLastLines(path, n);
      return lines.flatMap((line) => {
        const record = parseRecord(line);
        return record ? [record] : [];
      });
    },

    async watchLines(
      path: string,
      onLine: (r: LogRecord) => void,
      signal: AbortSignal,
    ): Promise<void> {
      if (signal.aborted) return;
      // In-process and inode-aware: `tail -f` would go silent at the next
      // rotation, and spawning `tail` at all is a dependency on a binary the
      // compiled single-file build cannot assume.
      await watchLines(
        path,
        (line) => {
          const record = parseRecord(line);
          if (record) onLine(record);
        },
        signal,
      );
    },
  };
}
