import { sanitizeDbError } from "./postgres/sanitize";
import type { Clock, HostLogger, LogRecord, LogSink, ScopedLogger } from "./types";

function createScopedLogger(moduleId: string, sink: LogSink, clock: Clock): ScopedLogger {
  const log = (level: LogRecord["level"], msg: string, fields?: Record<string, unknown>): void => {
    const record: LogRecord = { ts: clock().toISOString(), module: moduleId, level, msg };
    if (fields !== undefined) record.fields = fields;
    sink.write(record);
  };
  return {
    debug: (msg, fields) => log("debug", msg, fields),
    info: (msg, fields) => log("info", msg, fields),
    warn: (msg, fields) => log("warn", msg, fields),
    error: (msg, fields) => log("error", msg, fields),
  };
}

export class LogBus {
  private readonly clock: Clock;
  private _host: ScopedLogger | undefined;

  constructor(
    private readonly sink: LogSink,
    clock?: Clock,
  ) {
    this.clock = clock ?? (() => new Date());
  }

  scopeFor(moduleId: string): ScopedLogger {
    return createScopedLogger(moduleId, this.sink, this.clock);
  }

  get host(): ScopedLogger {
    if (!this._host) {
      this._host = createScopedLogger("fortress", this.sink, this.clock);
    }
    return this._host;
  }
}

export class BusHostLogger implements HostLogger {
  constructor(private readonly bus: LogBus) {}

  error(message: string, error?: unknown): void {
    // The funnel every logger.error(msg, err) drains through — sanitize HERE so
    // no caller can ship a raw driver error (drizzle's wrapper embeds the full
    // SQL + bound params — transcript content — and connect errors the DSN).
    const fields = error !== undefined ? { error: sanitizeDbError(error) } : undefined;
    this.bus.host.error(message, fields);
  }
}
