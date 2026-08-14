import { describe, expect, test } from "bun:test";

import {
  dbSqlState,
  isKillClassDbError,
  isLockTimeoutDbError,
  isPoolExhaustedDbError,
  isStatementTimeoutDbError,
  isTransientDbError,
  isUnsupportedStartupParamError,
  retryOnceOnTransientDbError,
  SessionLockTimeoutError,
  tagLockTimeout,
  unwrapDbError,
} from "../src/host/postgres/pg-errors";
import { setPoolExhaustedHandler } from "../src/host/postgres/pool-signal";
import { sanitizeDbError } from "../src/host/postgres/sanitize";

// Fixtures MIRROR the empirically-pinned real shapes (Bun 1.3.14 + PG 18; the
// FORTRESS_PG_CI_DSN lane re-pins them against a live server):
//   server error  = { code: "ERR_POSTGRES_SERVER_ERROR", errno: "<SQLSTATE>" }
//   kill-class    = { code: "ERR_POSTGRES_<lifecycle>" } with NO errno
//   drizzle wrap  = { query: string, params: [], cause: <the PostgresError>,
//                     message: "Failed query: …" } — and name STAYS "Error"
//                     (drizzle never sets it; --minify rewrites ctor names).

function serverError(errno: string, message: string): Error {
  const err = new Error(message) as Error & { code: string; errno: string };
  err.code = "ERR_POSTGRES_SERVER_ERROR";
  err.errno = errno;
  return err;
}

function killError(code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function drizzleWrapped(cause: Error, query = "select 1", params: unknown[] = []): Error {
  const err = new Error(`Failed query: ${query}\nparams: ${params.join(",")}`) as Error & {
    query: string;
    params: unknown[];
    cause: Error;
  };
  err.query = query;
  err.params = params;
  err.cause = cause;
  return err; // deliberately name === "Error" — the real wrapper's shape
}

// ERR_POSTGRES_IDLE_TIMEOUT is deliberately ABSENT: despite the name it is not a
// connection kill but the pool checkout queue giving up, so it is neither
// kill-class nor transient. See the isPoolExhaustedDbError block below.
const KILL_CODES = [
  "ERR_POSTGRES_CONNECTION_CLOSED",
  "ERR_POSTGRES_CONNECTION_TIMEOUT",
  "ERR_POSTGRES_LIFETIME_TIMEOUT",
];
const POOL_EXHAUSTED = "ERR_POSTGRES_IDLE_TIMEOUT";

describe("unwrapDbError", () => {
  test("steps down to the cause of a drizzle-shaped wrapper", () => {
    const cause = killError(KILL_CODES[0], "Connection closed");
    expect(unwrapDbError(drizzleWrapped(cause))).toBe(cause);
  });

  test("keeps a bare error (txn-path kills arrive UNwrapped)", () => {
    const bare = killError(KILL_CODES[2], "Max lifetime timeout reached");
    expect(unwrapDbError(bare)).toBe(bare);
  });

  test("does not unwrap a generic error with an incidental cause", () => {
    const err = new Error("outer");
    (err as Error & { cause: Error }).cause = new Error("inner");
    expect(unwrapDbError(err)).toBe(err);
  });
});

describe("isKillClassDbError", () => {
  for (const code of KILL_CODES) {
    test(`${code} — wrapped AND bare`, () => {
      const bare = killError(code, "kill");
      expect(isKillClassDbError(bare)).toBe(true);
      expect(isKillClassDbError(drizzleWrapped(bare))).toBe(true);
    });
  }

  test("57014 is NOT kill-class (server proved the statement too slow — retrying doubles the damage)", () => {
    const cancel = serverError("57014", "canceling statement due to statement timeout");
    expect(isKillClassDbError(cancel)).toBe(false);
    expect(isKillClassDbError(drizzleWrapped(cancel))).toBe(false);
  });

  test("constraint violations and plain errors are not kill-class", () => {
    expect(isKillClassDbError(serverError("23505", "duplicate key"))).toBe(false);
    expect(isKillClassDbError(new Error("nope"))).toBe(false);
    expect(isKillClassDbError(null)).toBe(false);
  });
});

describe("dbSqlState / isStatementTimeoutDbError", () => {
  test("SQLSTATE is read from .errno — NEVER .code (which is the shared ERR_POSTGRES_SERVER_ERROR)", () => {
    const cancel = serverError("57014", "canceling statement due to statement timeout");
    expect(dbSqlState(cancel)).toBe("57014");
    expect(dbSqlState(drizzleWrapped(cancel))).toBe("57014");
    expect(isStatementTimeoutDbError(cancel)).toBe(true);
    expect(isStatementTimeoutDbError(drizzleWrapped(cancel))).toBe(true);
    // A classifier that read `.code` would see this constant and never match —
    // the broken-fixture trap this test exists to close.
    const misread = killError("57014", "wrong field");
    expect(isKillClassDbError(misread)).toBe(false);
  });

  test("kill-class errors carry no SQLSTATE", () => {
    expect(dbSqlState(killError(KILL_CODES[0], "closed"))).toBeNull();
  });
});

describe("isUnsupportedStartupParamError", () => {
  test("matches PgBouncer's literal, wrapped and bare", () => {
    const bare = new Error("unsupported startup parameter: statement_timeout");
    expect(isUnsupportedStartupParamError(bare)).toBe(true);
    expect(
      isUnsupportedStartupParamError(drizzleWrapped(bare as Error & { code?: string })),
    ).toBe(true);
  });

  test("does not match genuine Postgres's phrasing", () => {
    expect(
      isUnsupportedStartupParamError(new Error('unrecognized configuration parameter "x"')),
    ).toBe(false);
  });
});

describe("tagLockTimeout / SessionLockTimeoutError", () => {
  test("re-throws a 57014 as the positional lock-timeout marker", () => {
    const cancel = drizzleWrapped(serverError("57014", "canceling statement due to statement timeout"));
    expect(() => tagLockTimeout(cancel)).toThrow(SessionLockTimeoutError);
  });

  test("re-throws anything else untouched", () => {
    const other = serverError("23505", "duplicate key");
    try {
      tagLockTimeout(other);
      throw new Error("unreachable");
    } catch (err) {
      expect(err).toBe(other);
    }
  });
});

describe("retryOnceOnTransientDbError", () => {
  test("retries EXACTLY once on a kill-class failure", async () => {
    let calls = 0;
    const out = await retryOnceOnTransientDbError(async () => {
      calls += 1;
      if (calls === 1) throw killError(KILL_CODES[1], "Connection timeout");
      return "ok";
    });
    expect(out).toBe("ok");
    expect(calls).toBe(2);
  });

  test("a second transient failure propagates (never loops)", async () => {
    let calls = 0;
    await expect(
      retryOnceOnTransientDbError(async () => {
        calls += 1;
        throw killError(KILL_CODES[0], "Connection closed");
      }),
    ).rejects.toThrow("Connection closed");
    expect(calls).toBe(2);
  });

  test("retries once on the lock-timeout marker (live chunk queued behind a restore txn)", async () => {
    let calls = 0;
    const out = await retryOnceOnTransientDbError(async () => {
      calls += 1;
      if (calls === 1) throw new SessionLockTimeoutError(serverError("57014", "canceling"));
      return calls;
    });
    expect(out).toBe(2);
  });

  test("a plain 57014 (statement, not lock) is NOT retried", async () => {
    let calls = 0;
    await expect(
      retryOnceOnTransientDbError(async () => {
        calls += 1;
        throw serverError("57014", "canceling statement due to statement timeout");
      }),
    ).rejects.toThrow("canceling statement");
    expect(calls).toBe(1);
  });

  test("non-transient failures are never retried", async () => {
    let calls = 0;
    await expect(
      retryOnceOnTransientDbError(async () => {
        calls += 1;
        throw serverError("23505", "duplicate key");
      }),
    ).rejects.toThrow("duplicate key");
    expect(calls).toBe(1);
    expect(isTransientDbError(serverError("23505", "dup"))).toBe(false);
  });
});

describe("sanitizeDbError (DrizzleQueryError collapse)", () => {
  test("collapses a wrapped error to <errno>: <cause message> — never the SQL/params body", () => {
    const cause = serverError("57014", "canceling statement due to statement timeout");
    const wrapped = drizzleWrapped(cause, "insert into hx.turns …", ["SENTINEL_TRANSCRIPT_TEXT"]);
    const out = sanitizeDbError(wrapped);
    expect(out).toBe("57014: canceling statement due to statement timeout");
    expect(out).not.toContain("Failed query");
    expect(out).not.toContain("SENTINEL_TRANSCRIPT_TEXT");
    expect(out).not.toContain("insert into");
  });

  test("errno-first: a kill-class cause (no errno) falls back to its code", () => {
    const wrapped = drizzleWrapped(killError(KILL_CODES[2], "Max lifetime timeout reached"));
    expect(sanitizeDbError(wrapped)).toBe(
      "ERR_POSTGRES_LIFETIME_TIMEOUT: Max lifetime timeout reached",
    );
  });

  test("detection is STRUCTURAL (query+params), not name-based — the minified binary breaks names", () => {
    // Simulates a wrapper whose constructor.name minified to "s": only the
    // structural shape identifies it.
    const cause = serverError("23505", "duplicate key value violates unique constraint");
    const impostor = {
      message: 'Failed query: insert…\nparams: SECRET',
      query: "insert…",
      params: ["SECRET"],
      cause,
    };
    const out = sanitizeDbError(impostor);
    expect(out).toContain("23505");
    expect(out).not.toContain("SECRET");
  });

  test("a wrapper with no usable cause still never leaks the query body", () => {
    const orphan = { message: "Failed query: select secret", query: "select secret", params: [] };
    expect(sanitizeDbError(orphan)).toBe("db_query_failed");
  });

  test("plain errors keep today's DSN redaction", () => {
    expect(sanitizeDbError(new Error("connect to postgresql://u:pw@db.internal:5432/hx failed"))).toBe(
      "connect to [REDACTED_URL] failed",
    );
  });
});


describe("isPoolExhaustedDbError — the 2026-08-05 regression, pinned", () => {
  test("ERR_POSTGRES_IDLE_TIMEOUT is pool exhaustion, wrapped AND bare", () => {
    const bare = killError(POOL_EXHAUSTED, "Idle timeout reached after 1m");
    expect(isPoolExhaustedDbError(bare)).toBe(true);
    expect(isPoolExhaustedDbError(drizzleWrapped(bare))).toBe(true);
  });

  test("it is NOT kill-class — the pool is starved, the connection is fine", () => {
    const err = killError(POOL_EXHAUSTED, "Idle timeout reached after 1m");
    expect(isKillClassDbError(err)).toBe(false);
  });

  test("it is NOT transient — retrying into a full pool is the amplifier", () => {
    const err = killError(POOL_EXHAUSTED, "Idle timeout reached after 1m");
    expect(isTransientDbError(err)).toBe(false);
  });

  test("a genuine lifecycle kill stays transient (the fix narrows nothing else)", () => {
    expect(isTransientDbError(killError(KILL_CODES[2], "Max lifetime timeout"))).toBe(true);
  });

  test("retryOnceOnTransientDbError runs the op EXACTLY once and rethrows", async () => {
    let calls = 0;
    await expect(
      retryOnceOnTransientDbError(async () => {
        calls += 1;
        throw killError(POOL_EXHAUSTED, "Idle timeout reached after 1m");
      }),
    ).rejects.toThrow("Idle timeout reached after 1m");
    expect(calls).toBe(1);
  });

  test("it reports starvation to the healer exactly once per rejection", async () => {
    let signals = 0;
    setPoolExhaustedHandler(() => {
      signals += 1;
    });
    try {
      await expect(
        retryOnceOnTransientDbError(async () => {
          throw killError(POOL_EXHAUSTED, "Idle timeout reached after 1m");
        }),
      ).rejects.toThrow();
      expect(signals).toBe(1);
      // A non-exhaustion failure must never inflate the saturation count.
      await expect(
        retryOnceOnTransientDbError(async () => {
          throw serverError("23505", "dup");
        }),
      ).rejects.toThrow();
      expect(signals).toBe(1);
    } finally {
      setPoolExhaustedHandler(null);
    }
  });

  test("a throwing subscriber never breaks the query path", async () => {
    setPoolExhaustedHandler(() => {
      throw new Error("observer blew up");
    });
    try {
      await expect(
        retryOnceOnTransientDbError(async () => {
          throw killError(POOL_EXHAUSTED, "Idle timeout reached after 1m");
        }),
      ).rejects.toThrow("Idle timeout reached after 1m");
    } finally {
      setPoolExhaustedHandler(null);
    }
  });
});

describe("lock_timeout (55P03) joins statement_timeout (57014) as a bounded lock WAIT", () => {
  test("55P03 is recognised", () => {
    expect(isLockTimeoutDbError(serverError("55P03", "canceling statement due to lock timeout"))).toBe(
      true,
    );
    expect(isLockTimeoutDbError(serverError("57014", "canceling statement"))).toBe(false);
  });

  test("tagLockTimeout tags BOTH shapes as a session-lock timeout", () => {
    expect(() => tagLockTimeout(serverError("55P03", "lock timeout"))).toThrow(
      SessionLockTimeoutError,
    );
    expect(() => tagLockTimeout(serverError("57014", "statement timeout"))).toThrow(
      SessionLockTimeoutError,
    );
  });

  test("an unrelated server error passes through untagged", () => {
    expect(() => tagLockTimeout(serverError("23505", "dup"))).toThrow("dup");
    try {
      tagLockTimeout(serverError("23505", "dup"));
    } catch (err) {
      expect(err instanceof SessionLockTimeoutError).toBe(false);
    }
  });

  test("a bounded-out lock wait stays transient — the txn rolled back, one retry is sound", () => {
    expect(isTransientDbError(new SessionLockTimeoutError(serverError("55P03", "lock")))).toBe(true);
  });

  test("a RAW 55P03 is transient too — the advisory lock is not the only contended statement", () => {
    // Every concurrent ingest upserts the same user/org/project/repo dimension
    // rows; under load that row-lock contention trips lock_timeout, not the
    // advisory lock the positional tag covers. Leaving those un-retried held
    // the post-deploy failure rate near 37%.
    const raw = serverError("55P03", "canceling statement due to lock timeout");
    expect(isTransientDbError(raw)).toBe(true);
    expect(isTransientDbError(drizzleWrapped(raw))).toBe(true);
  });

  test("a raw 55P03 IS retried exactly once, and succeeds on the second attempt", async () => {
    let calls = 0;
    const out = await retryOnceOnTransientDbError(async () => {
      calls += 1;
      if (calls === 1) throw serverError("55P03", "canceling statement due to lock timeout");
      return "indexed";
    });
    expect(out).toBe("indexed");
    expect(calls).toBe(2);
  });

  test("57014 on a working statement stays NON-transient — the server proved it too slow", () => {
    expect(isTransientDbError(serverError("57014", "canceling statement due to statement timeout"))).toBe(
      false,
    );
  });
});
