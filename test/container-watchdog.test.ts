// The liveness watchdog's decision: when a silent heartbeat file means a frozen
// daemon, and every case where it must not. Driven by a fake clock and fake
// reads of the file — no timers, no processes.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { METRICS_INTERVAL_MS } from "../src/console/metrics";
import {
  DEFAULT_GRACE_MS,
  DEFAULT_STALE_MS,
  HEARTBEAT_CHECK_MS,
  HEARTBEAT_STALE_EXIT_CODE,
  HeartbeatWatch,
  MIN_STALE_MS,
  UNWATCHED_GAP_MS,
  staleLine,
  watchdogConfig,
  watchingLine,
  type HeartbeatMark,
  type WatchVerdict,
  type WatchdogSettings,
} from "../src/container-watchdog";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** A watch and a clock to drive it. `look` reads the "file" at the current time;
 *  `wait` lets time pass the way the read loop does, one read per check. */
function harness(settings: WatchdogSettings, baseline: HeartbeatMark = null) {
  const watch = new HeartbeatWatch(settings, baseline);
  let now = 1_000_000;
  let mark: HeartbeatMark = baseline;
  let verdict: WatchVerdict = { state: "waiting" };
  const look = (): WatchVerdict => (verdict = watch.observe(now, mark));
  return {
    watch,
    get now() {
      return now;
    },
    /** The daemon rewrites the file. */
    beat(): WatchVerdict {
      mark = now;
      return look();
    },
    /** The file disappears. */
    remove(): void {
      mark = null;
    },
    /** Time passes in check-sized steps, the file unchanged; the last verdict. */
    wait(ms: number): WatchVerdict {
      for (let waited = 0; waited < ms; waited += HEARTBEAT_CHECK_MS) {
        now += Math.min(HEARTBEAT_CHECK_MS, ms - waited);
        look();
      }
      return verdict;
    },
    /** The clock moves with no read in between: this process did not run, or the
     *  wall clock stepped. */
    jump(ms: number): WatchVerdict {
      now += ms;
      return look();
    },
  };
}

const settings = (over: Partial<WatchdogSettings> = {}): WatchdogSettings => ({
  staleMs: DEFAULT_STALE_MS,
  graceMs: 0,
  ...over,
});

describe("before the first heartbeat", () => {
  test("nothing fires, however long the daemon takes to write once", () => {
    // Postgres crash recovery, a long migration, a first boot downloading its
    // binaries: none of it is a freeze, and none of it has to fit a deadline.
    const h = harness(settings());
    expect(h.wait(6 * HOUR).state).toBe("waiting");
    expect(h.jump(30 * 24 * HOUR).state).toBe("waiting");
  });

  test("the file the previous container left on the volume is not a heartbeat", () => {
    // Read before the daemon started, it is the baseline. Reading it as a
    // heartbeat would start the grace at boot instead of at this daemon's first
    // write, and a slow boot would then be killed for being slow.
    const h = harness(settings(), 123_456);
    expect(h.wait(6 * HOUR).state).toBe("waiting");
    expect(h.watch.beating).toBe(false);
  });

  test("the first rewrite after the baseline is the first heartbeat", () => {
    const h = harness(settings(), 123_456);
    h.wait(MINUTE);
    expect(h.beat().state).toBe("alive");
    expect(h.watch.beating).toBe(true);
  });
});

describe("after the first heartbeat", () => {
  test("a heartbeat that keeps changing keeps the daemon running", () => {
    const h = harness(settings());
    for (let i = 0; i < 360; i++) {
      h.beat();
      expect(h.wait(METRICS_INTERVAL_MS).state).toBe("alive");
    }
  });

  test("silence up to the limit is allowed, past it is stale", () => {
    const h = harness(settings());
    h.beat();
    expect(h.wait(DEFAULT_STALE_MS).state).toBe("alive");
    const verdict = h.wait(HEARTBEAT_CHECK_MS);
    expect(verdict).toEqual({ state: "stale", silentMs: DEFAULT_STALE_MS + HEARTBEAT_CHECK_MS });
  });

  test("a heartbeat file that disappears is silence, not a heartbeat", () => {
    // The daemon recreates the file on every rewrite, so an absent file for
    // longer than the limit is a daemon that is not writing.
    const h = harness(settings());
    h.beat();
    h.remove();
    expect(h.wait(DEFAULT_STALE_MS + HEARTBEAT_CHECK_MS).state).toBe("stale");
  });

  test("a single late rewrite resets the silence", () => {
    const h = harness(settings());
    h.beat();
    h.wait(DEFAULT_STALE_MS - HEARTBEAT_CHECK_MS);
    h.beat();
    expect(h.wait(DEFAULT_STALE_MS).state).toBe("alive");
  });
});

describe("the grace period", () => {
  test("starts at the first heartbeat, not at spawn", () => {
    const h = harness(settings({ graceMs: DEFAULT_GRACE_MS }));
    // A boot that took ten minutes to write once used none of the grace.
    h.wait(10 * MINUTE);
    h.beat();
    // Silent for twice the limit, but inside the grace: start-up work that holds
    // the event loop is not taken for a freeze.
    expect(h.wait(2 * DEFAULT_STALE_MS).state).toBe("grace");
    expect(h.wait(DEFAULT_GRACE_MS - 2 * DEFAULT_STALE_MS - HEARTBEAT_CHECK_MS).state).toBe("grace");
    // Once it is over, a silence already past the limit fires at once.
    expect(h.wait(HEARTBEAT_CHECK_MS).state).toBe("stale");
  });

  test("a daemon that resumes heartbeating inside the grace is alive after it", () => {
    const h = harness(settings({ graceMs: DEFAULT_GRACE_MS }));
    h.beat();
    h.wait(4 * MINUTE);
    h.beat();
    for (let i = 0; i < 60; i++) {
      h.wait(METRICS_INTERVAL_MS);
      h.beat();
    }
    expect(h.wait(METRICS_INTERVAL_MS).state).toBe("alive");
  });

  test("zero arms the watchdog at the first heartbeat", () => {
    const h = harness(settings({ graceMs: 0 }));
    expect(h.beat().state).toBe("alive");
    expect(h.wait(DEFAULT_STALE_MS + HEARTBEAT_CHECK_MS).state).toBe("stale");
  });
});

describe("time this process did not watch", () => {
  test("a suspended container is not a frozen daemon", () => {
    // A paused container, or a laptop that slept with Docker running: the clock
    // moved an hour between two reads. Nothing ran — not the daemon, not this
    // process — and blaming the daemon would restart it on every wake.
    const h = harness(settings());
    h.beat();
    h.wait(MINUTE);
    expect(h.jump(HOUR).state).toBe("alive");
    // The silence it DID watch still counts: one minute before the gap, and the
    // limit is reached a minute after it.
    expect(h.wait(DEFAULT_STALE_MS - MINUTE - UNWATCHED_GAP_MS).state).toBe("alive");
    expect(h.wait(UNWATCHED_GAP_MS + HEARTBEAT_CHECK_MS).state).toBe("stale");
  });

  test("a wall clock stepped backwards neither fires nor hides a freeze", () => {
    const h = harness(settings());
    h.beat();
    h.wait(MINUTE);
    expect(h.jump(-HOUR).state).toBe("alive");
    expect(h.wait(DEFAULT_STALE_MS - MINUTE).state).toBe("alive");
    expect(h.wait(2 * HEARTBEAT_CHECK_MS).state).toBe("stale");
  });

  test("a gap during the grace does not use the grace up", () => {
    const h = harness(settings({ graceMs: DEFAULT_GRACE_MS }));
    h.beat();
    h.wait(MINUTE);
    expect(h.jump(HOUR).state).toBe("grace");
    expect(h.wait(DEFAULT_GRACE_MS - MINUTE - UNWATCHED_GAP_MS).state).toBe("grace");
  });

  test("a gap no longer than the bound is ordinary time, and counts", () => {
    // Reads delayed by a busy host are still watched time; only a gap past the
    // bound is set aside.
    const h = harness(settings());
    h.beat();
    for (let i = 0; i < DEFAULT_STALE_MS / UNWATCHED_GAP_MS; i++) {
      expect(h.jump(UNWATCHED_GAP_MS).state).toBe("alive");
    }
    expect(h.jump(UNWATCHED_GAP_MS).state).toBe("stale");

    // One millisecond past the bound, and the same jumps count for nothing.
    const g = harness(settings());
    g.beat();
    for (let i = 0; i < 10; i++) expect(g.jump(UNWATCHED_GAP_MS + 1).state).toBe("alive");
  });
});

describe("settings", () => {
  test("the defaults", () => {
    expect(watchdogConfig({})).toEqual({
      settings: { staleMs: DEFAULT_STALE_MS, graceMs: DEFAULT_GRACE_MS },
      notes: [],
    });
    expect(DEFAULT_STALE_MS).toBe(120_000);
    expect(DEFAULT_GRACE_MS).toBe(300_000);
  });

  test("FORTRESS_WATCHDOG_DISABLED turns it off with the shared truthy spellings, and only those", () => {
    for (const value of ["1", "true", "yes", "on", " TRUE "]) {
      expect(watchdogConfig({ FORTRESS_WATCHDOG_DISABLED: value }).settings).toBeNull();
    }
    for (const value of ["", "0", "false", "off", "no"]) {
      expect(watchdogConfig({ FORTRESS_WATCHDOG_DISABLED: value }).settings).not.toBeNull();
    }
  });

  test("the limit: a value is used, blank and zero mean the default", () => {
    expect(watchdogConfig({ FORTRESS_WATCHDOG_STALE_MS: "90000" }).settings?.staleMs).toBe(90_000);
    // Zero never disables: the watchdog has its own off switch.
    for (const value of ["", "0", "  "]) {
      expect(watchdogConfig({ FORTRESS_WATCHDOG_STALE_MS: value })).toEqual(watchdogConfig({}));
    }
  });

  test("a limit below the floor is raised to it, and says so", () => {
    // 120 is what someone thinking in seconds types. Taken as milliseconds it
    // would kill a healthy daemon between two rewrites.
    const config = watchdogConfig({ FORTRESS_WATCHDOG_STALE_MS: "120" });
    expect(config.settings?.staleMs).toBe(MIN_STALE_MS);
    expect(config.notes).toEqual([
      `FORTRESS_WATCHDOG_STALE_MS=120 is below the ${MIN_STALE_MS} ms floor; using ${MIN_STALE_MS}`,
    ]);
  });

  test("a value that is not whole milliseconds falls back to the default, and says so", () => {
    for (const value of ["2m", "-1", "1e5", "120000.5"]) {
      const config = watchdogConfig({ FORTRESS_WATCHDOG_STALE_MS: value });
      expect(config.settings?.staleMs).toBe(DEFAULT_STALE_MS);
      expect(config.notes[0]).toContain(`FORTRESS_WATCHDOG_STALE_MS=${value} is not a number of milliseconds`);
    }
  });

  test("the grace: zero is a real value, junk is the default", () => {
    expect(watchdogConfig({ FORTRESS_WATCHDOG_GRACE_MS: "0" }).settings?.graceMs).toBe(0);
    expect(watchdogConfig({ FORTRESS_WATCHDOG_GRACE_MS: "900000" }).settings?.graceMs).toBe(900_000);
    const junk = watchdogConfig({ FORTRESS_WATCHDOG_GRACE_MS: "soon" });
    expect(junk.settings?.graceMs).toBe(DEFAULT_GRACE_MS);
    expect(junk.notes[0]).toContain("FORTRESS_WATCHDOG_GRACE_MS=soon is not a number of milliseconds");
  });

  test("the floor leaves room for a healthy daemon between two rewrites", () => {
    // The longest silence a healthy daemon shows is one rewrite interval plus
    // one read interval. The floor is tied to the interval, so slowing the
    // rewrite raises it rather than turning every daemon stale.
    expect(MIN_STALE_MS).toBe(3 * METRICS_INTERVAL_MS);
    expect(METRICS_INTERVAL_MS + HEARTBEAT_CHECK_MS).toBeLessThan(MIN_STALE_MS);
    expect(DEFAULT_STALE_MS).toBeGreaterThan(MIN_STALE_MS);
  });
});

describe("what it writes to the container log", () => {
  test("the stale line names the file, the limit, the last write and the pid", () => {
    const line = staleLine({
      file: "/data/runtime/metrics.json",
      lastMark: Date.parse("2026-09-19T17:35:11.000Z"),
      settings: settings(),
      pid: 7,
    });
    expect(line).toBe(
      "daemon heartbeat is stale: /data/runtime/metrics.json has not been rewritten for more than 120s " +
        "(last written 2026-09-19T17:35:11.000Z); " +
        `stopping the daemon (pid 7) and exiting with code ${HEARTBEAT_STALE_EXIT_CODE} so the container is restarted`,
    );
  });

  test("the stale line survives a timestamp it cannot print", () => {
    const line = staleLine({ file: "/f", lastMark: Number.NaN, settings: settings(), pid: null });
    expect(line).toBe(
      "daemon heartbeat is stale: /f has not been rewritten for more than 120s; " +
        `stopping the daemon and exiting with code ${HEARTBEAT_STALE_EXIT_CODE} so the container is restarted`,
    );
  });

  test("the watching line says the watchdog has seen the daemon, with its settings", () => {
    const line = watchingLine("/data/runtime/metrics.json", { staleMs: 120_000, graceMs: 300_000 });
    expect(line).toContain("first daemon heartbeat seen in /data/runtime/metrics.json");
    expect(line).toContain("From 300s after it, 120s without a new one stops the daemon");
    expect(watchingLine("/f", { staleMs: 120_000, graceMs: 0 })).toContain(
      "From now on, 120s without a new one stops the daemon",
    );
  });

  test("the exit code is non-zero, so an on-failure restart policy restarts the container", () => {
    expect(HEARTBEAT_STALE_EXIT_CODE).not.toBe(0);
  });
});

describe("the heartbeat it reads", () => {
  test("is the file the daemon republishes on a timer", () => {
    // The watchdog never arms if the daemon stops writing this file, and it
    // would do so silently. Moving the publisher has to move the watchdog too.
    const main = readFileSync(path.join(import.meta.dir, "..", "src", "host", "main.ts"), "utf8");
    expect(main).toContain("startMetricsPublisher({");
    expect(main).toContain("filePath: paths.metrics,");
    const run = readFileSync(path.join(import.meta.dir, "..", "src", "container-run.ts"), "utf8");
    expect(run).toContain("readHeartbeatMark(paths.metrics)");
  });
});
