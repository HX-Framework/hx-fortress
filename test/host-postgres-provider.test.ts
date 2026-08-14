import { describe, expect, test } from "bun:test";

import { createEmbeddedPostgres, createExternalPostgres } from "../src/host/postgres/provider";

const RW_DSN = "postgresql://hx_app_rw:pw-rw@127.0.0.1:54329/hx-db";
const RO_DSN = "postgresql://hx_app_ro:pw-ro@127.0.0.1:54329/hx-db";
const dsnFor = (role?: "ro" | "rw"): string => (role === "ro" ? RO_DSN : RW_DSN);

describe("embedded provider", () => {
  test("a failed boot NAMES the step, quotes the server log, and is logged", async () => {
    // The silence this replaces: the provider swallowed the error into
    // phase/reason and wrote nothing anywhere. An operator saw the binaries
    // install, then nothing, while every ingest was refused with
    // `postgres_not_ready`. The real cause — a backend killed by SIGILL running
    // the pgvector migration — sat in Postgres's own log, which no surface read.
    const logged: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const provider = createEmbeddedPostgres({
      dsn: dsnFor,
      acquire: async () => "/bin",
      ensureCluster: async () => undefined,
      startServer: async () => undefined,
      stopServer: async () => undefined,
      ensureDbSchema: async () => undefined,
      ensureVector: async () => undefined,
      migrate: async () => {
        throw new Error("Connection closed");
      },
      logger: {
        error: (msg: string, fields?: Record<string, unknown>) => logged.push({ msg, fields }),
        info: () => undefined,
        warn: () => undefined,
        debug: () => undefined,
      } as never,
      serverLogTail: async () =>
        'client backend (PID 41050) was terminated by signal 4: Illegal instruction',
    });
    await provider.start();

    const { phase, reason } = provider.status();
    expect(phase).toBe("failed");
    // WHICH step — "Connection closed" alone names nothing actionable.
    expect(reason).toContain("applying migrations");
    // …and the cause, carried out of Postgres's own log.
    expect(reason).toContain("Illegal instruction");
    // …and it reached the log, not just the status file.
    expect(logged).toHaveLength(1);
    expect(logged[0]?.msg).toBe("postgres failed to start");
    expect(logged[0]?.fields?.step).toBe("applying migrations");
    expect(String(logged[0]?.fields?.serverLog)).toContain("signal 4");
    expect(provider.isReady()).toBe(false);
  });

  test("a failure with no server log still names its step", async () => {
    const provider = createEmbeddedPostgres({
      dsn: dsnFor,
      acquire: async () => {
        throw new Error("404 fetching the bundle");
      },
      ensureCluster: async () => undefined,
      startServer: async () => undefined,
      stopServer: async () => undefined,
      ensureDbSchema: async () => undefined,
      migrate: async () => undefined,
    });
    await provider.start();
    expect(provider.status().reason).toContain("acquiring the Postgres binaries");
    expect(provider.status().reason).toContain("404");
  });

  test("progresses to ready and exposes role-aware dsns in de-superuser order", async () => {
    const order: string[] = [];
    const provider = createEmbeddedPostgres({
      dsn: dsnFor,
      acquire: async () => {
        order.push("acquire");
        return "/bin";
      },
      ensureCluster: async () => {
        order.push("cluster");
      },
      startServer: async () => {
        order.push("start");
      },
      ensureAuth: async () => {
        order.push("auth");
      },
      ensureDbSchema: async () => {
        order.push("schema");
      },
      ensureVector: async () => {
        order.push("vector");
      },
      migrate: async () => {
        order.push("migrate");
      },
      ensureAppRoles: async () => {
        order.push("app-roles");
      },
      stopServer: async () => {
        order.push("stop");
      },
    });
    await provider.start();
    expect(provider.status().phase).toBe("ready");
    expect(provider.isReady()).toBe(true);
    // Default + "rw" resolve the DML role; "ro" the SELECT-only role.
    expect(provider.dsn()).toBe(RW_DSN);
    expect(provider.dsn("rw")).toBe(RW_DSN);
    expect(provider.dsn("ro")).toBe(RO_DSN);
    // ensureAuth runs after startServer + before schema; ensureAppRoles last.
    expect(order).toEqual([
      "acquire",
      "cluster",
      "start",
      "auth",
      "schema",
      "vector",
      "migrate",
      "app-roles",
    ]);
    await provider.stop();
    expect(order.at(-1)).toBe("stop");
  });

  test("records failed phase without throwing when acquire fails", async () => {
    const provider = createEmbeddedPostgres({
      dsn: dsnFor,
      acquire: async () => {
        throw new Error("network down");
      },
      ensureCluster: async () => {},
      startServer: async () => {},
      ensureDbSchema: async () => {},
      migrate: async () => {},
      stopServer: async () => {},
    });
    await provider.start();
    expect(provider.status().phase).toBe("failed");
    expect(provider.status().reason).toContain("network down");
    expect(provider.isReady()).toBe(false);
    expect(provider.dsn()).toBeNull();
    expect(provider.dsn("ro")).toBeNull();
  });
});

describe("external provider (re-probe-until-ready)", () => {
  const url = "postgresql://host/hx-db";
  const instant = async (): Promise<void> => {};

  test("is ready when probe + migrate succeed; dsn echoes the url", async () => {
    const provider = createExternalPostgres(url, instant, instant);
    await provider.start();
    expect(provider.isReady()).toBe(true);
    // Role-split is embedded-only: both roles resolve to the operator's URL.
    expect(provider.dsn()).toBe(url);
    expect(provider.dsn("rw")).toBe(url);
    expect(provider.dsn("ro")).toBe(url);
    await provider.stop();
  });

  test("start() returns after the FIRST failed attempt with phase 'retrying' — never 'failed'-forever", async () => {
    let attempts = 0;
    const provider = createExternalPostgres(
      url,
      async () => {
        attempts += 1;
        throw new Error("connection refused");
      },
      instant,
      { retryMs: 5, maxRetryMs: 5 },
    );
    await provider.start();
    expect(provider.status().phase).toBe("retrying");
    expect(provider.isReady()).toBe(false);
    expect(provider.dsn()).toBeNull();
    // The background loop keeps attempting (each attempt time-bounded, the
    // LOOP infinite) — a finite attempt cap would recreate the incident.
    await new Promise((r) => setTimeout(r, 40));
    expect(attempts).toBeGreaterThan(2);
    await provider.stop();
  });

  test("background recovery flips to ready and fires onPhaseChange", async () => {
    let failuresLeft = 2;
    const phases: string[] = [];
    const provider = createExternalPostgres(
      url,
      async () => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error("still booting");
        }
      },
      instant,
      { retryMs: 5, maxRetryMs: 5 },
    );
    provider.onPhaseChange?.((snap) => phases.push(snap.phase));
    await provider.start();
    expect(provider.status().phase).toBe("retrying");
    await new Promise((r) => setTimeout(r, 60));
    expect(provider.isReady()).toBe(true);
    expect(provider.dsn()).toBe(url);
    expect(phases).toContain("retrying");
    expect(phases[phases.length - 1]).toBe("ready");
    await provider.stop();
  });

  test("ready ONLY after migrate — a failing migrate keeps dsn null", async () => {
    const provider = createExternalPostgres(
      url,
      instant,
      async () => {
        throw new Error("relation is locked");
      },
      { retryMs: 5, maxRetryMs: 5 },
    );
    await provider.start();
    expect(provider.status().phase).toBe("retrying");
    expect(provider.dsn()).toBeNull();
    await provider.stop();
  });

  test("a HUNG migrate attempt counts FAILED via the outer deadline; the retry converges; the zombie is pure-swallowed", async () => {
    let calls = 0;
    let releaseZombie: () => void = () => {};
    const provider = createExternalPostgres(
      url,
      instant,
      async () => {
        calls += 1;
        if (calls === 1) {
          // First attempt hangs past the outer deadline (the incident shape).
          await new Promise<void>((resolve) => {
            releaseZombie = resolve;
          });
        }
      },
      { retryMs: 5, maxRetryMs: 5, migrateDeadlineMs: 20 },
    );
    const phases: string[] = [];
    provider.onPhaseChange?.((snap) => phases.push(snap.phase));
    await provider.start();
    expect(provider.status().phase).toBe("retrying");
    await new Promise((r) => setTimeout(r, 60));
    expect(provider.isReady()).toBe(true);
    const readyCount = phases.filter((p) => p === "ready").length;
    // The abandoned first attempt settling LATE must not re-fire the ready
    // path (pure swallow — it never mutates phase/reason).
    releaseZombie();
    await new Promise((r) => setTimeout(r, 10));
    expect(phases.filter((p) => p === "ready").length).toBe(readyCount);
    await provider.stop();
  });

  test("the reason is sanitized — a probe error embedding the DSN never reaches status", async () => {
    const provider = createExternalPostgres(
      url,
      async () => {
        throw new Error(`connect failed: postgresql://user:secret@host/db`);
      },
      instant,
      { retryMs: 60_000, maxRetryMs: 60_000 },
    );
    await provider.start();
    expect(provider.status().reason).not.toContain("secret");
    expect(provider.status().reason).toContain("[REDACTED_URL]");
    await provider.stop();
  });

  test("stop() cancels the loop and suppresses late phase emissions", async () => {
    let attempts = 0;
    const provider = createExternalPostgres(
      url,
      async () => {
        attempts += 1;
        throw new Error("down");
      },
      instant,
      { retryMs: 5, maxRetryMs: 5 },
    );
    const phases: string[] = [];
    provider.onPhaseChange?.((snap) => phases.push(snap.phase));
    await provider.start();
    await provider.stop();
    const seen = attempts;
    const emitted = phases.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(attempts).toBe(seen);
    expect(phases.length).toBe(emitted);
  });
});
