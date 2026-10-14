import { describe, expect, test } from "bun:test";

import {
  createBackendCanceller,
  createPgCancelScope,
  NO_CANCEL_SCOPE,
  PgPhaseAbandonedError,
} from "../src/host/postgres/pg-cancel";

// The deadline-cancel contract racePgPhase and the ingest transaction share:
// the transaction attaches the backend it runs on, the race cancels every
// attached backend when the deadline passes, and the transaction's cooperative
// checks make it unwind instead of starting its next statement.

describe("createPgCancelScope", () => {
  test("cancel() reaches every attached backend exactly once and marks the scope cancelled", async () => {
    const cancelled: number[] = [];
    const scope = createPgCancelScope("db_unavailable:ingest_commit", async (pid) => {
      cancelled.push(pid);
    });
    const detachA = scope.attach(101);
    scope.attach(202);
    expect(scope.pids().sort()).toEqual([101, 202]);
    expect(scope.cancelled()).toBe(false);
    detachA(); // this transaction finished before the deadline
    await scope.cancel();
    expect(cancelled).toEqual([202]);
    expect(scope.cancelled()).toBe(true);
  });

  test("a backend attached AFTER the deadline is cancelled on arrival (the retry attempt of an abandoned phase)", async () => {
    const cancelled: number[] = [];
    const scope = createPgCancelScope("tag", async (pid) => {
      cancelled.push(pid);
    });
    await scope.cancel();
    scope.attach(303);
    await new Promise((r) => setTimeout(r, 0));
    expect(cancelled).toEqual([303]);
  });

  test("throwIfCancelled is silent before the deadline and throws the typed abandon error after it", async () => {
    const scope = createPgCancelScope("db_unavailable:reindex_canonical", null);
    expect(() => scope.throwIfCancelled()).not.toThrow();
    await scope.cancel();
    let caught: unknown = null;
    try {
      scope.throwIfCancelled();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PgPhaseAbandonedError);
    expect((caught as Error).message).toBe("pg_phase_abandoned:db_unavailable:reindex_canonical");
  });

  test("a failing or missing canceller never throws into the race", async () => {
    const failing = createPgCancelScope("tag", async () => {
      throw new Error("cancel client down");
    });
    failing.attach(1);
    await expect(failing.cancel()).resolves.toBeUndefined();
    const absent = createPgCancelScope("tag", null);
    absent.attach(2);
    await expect(absent.cancel()).resolves.toBeUndefined();
    expect(absent.cancelled()).toBe(true);
  });

  test("NO_CANCEL_SCOPE records nothing, cancels nothing, never throws — the deadline-free call sites", async () => {
    const detach = NO_CANCEL_SCOPE.attach(9);
    detach();
    expect(NO_CANCEL_SCOPE.pids()).toEqual([]);
    expect(NO_CANCEL_SCOPE.cancelled()).toBe(false);
    expect(() => NO_CANCEL_SCOPE.throwIfCancelled()).not.toThrow();
    await NO_CANCEL_SCOPE.cancel();
    expect(NO_CANCEL_SCOPE.cancelled()).toBe(false);
  });
});

describe("createBackendCanceller", () => {
  /** A fake Bun.SQL: records the SQL it was asked to run, answers with rows. */
  function fakeClient(answer: () => Promise<unknown[]>) {
    const calls: string[] = [];
    let closed = 0;
    const tag = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
      calls.push(strings.raw.join("?") + " :: " + values.join(","));
      return answer();
    };
    const sql = Object.assign(tag, {
      close: async () => {
        closed += 1;
      },
    }) as unknown as Bun.SQL;
    return { sql, calls, closed: () => closed };
  }

  test("runs pg_cancel_backend(pid) on its own lazily-built client and logs the verdict", async () => {
    const fake = fakeClient(async () => [{ cancelled: true }]);
    const logs: Array<{ level: string; msg: string; meta?: Record<string, unknown> }> = [];
    const logger = {
      warn: (msg: string, meta?: Record<string, unknown>) => logs.push({ level: "warn", msg, meta }),
    } as never;
    let built = 0;
    const handle = createBackendCanceller(
      () => "postgresql://db.internal/hx",
      logger,
      () => {
        built += 1;
        return fake.sql;
      },
    );
    expect(built).toBe(0); // nothing connects until the first cancel
    await handle.cancel(4242);
    await handle.cancel(4243);
    expect(built).toBe(1); // one client, reused
    expect(fake.calls).toEqual([
      "select pg_cancel_backend(?) as cancelled :: 4242",
      "select pg_cancel_backend(?) as cancelled :: 4243",
    ]);
    expect(logs.map((l) => [l.msg, l.meta?.pid, l.meta?.cancelled])).toEqual([
      ["pg phase cancelled at the deadline", 4242, true],
      ["pg phase cancelled at the deadline", 4243, true],
    ]);
    handle.close();
    expect(fake.closed()).toBe(1);
  });

  test("a DSN that is not ready yet is a no-op; a failing cancel is logged, never thrown", async () => {
    const logs: string[] = [];
    const logger = { warn: (msg: string) => logs.push(msg) } as never;
    const notReady = createBackendCanceller(() => null, logger, () => {
      throw new Error("must not build");
    });
    await expect(notReady.cancel(1)).resolves.toBeUndefined();
    const failing = createBackendCanceller(
      () => "postgresql://db.internal/hx",
      logger,
      () => fakeClient(async () => Promise.reject(new Error("connection refused"))).sql,
    );
    await expect(failing.cancel(7)).resolves.toBeUndefined();
    expect(logs).toEqual(["pg phase cancel failed"]);
  });
});
