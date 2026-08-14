import type { LogRecord, LogSink } from "./types";

/**
 * Emit each log record as one JSON line to stdout. Used on the non-interactive
 * cloud-service host (Railway) so the platform's log capture actually shows
 * fortress activity + connection errors — the FileLogSink alone writes only to
 * logs/service.log inside the container, which Railway never sees (it shows just
 * "Starting Container"). One record per line = the same shape as the file sink,
 * so downstream parsing is identical.
 */
export class StdoutLogSink implements LogSink {
  write(record: LogRecord): void {
    process.stdout.write(JSON.stringify(record) + "\n");
  }
}

/** Fan one record out to several sinks (e.g. file + stdout). A throwing sink must
 *  not stop the others, so each write is isolated. */
export class MultiLogSink implements LogSink {
  constructor(private readonly sinks: readonly LogSink[]) {}

  write(record: LogRecord): void {
    for (const sink of this.sinks) {
      try {
        sink.write(record);
      } catch {
        /* one sink failing must not blind the others */
      }
    }
  }
}
