// One container, two processes: who supervises them, what it re-reads before it
// respawns anything, and what it is allowed to signal.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  NOT_PID_ONE_REFUSAL,
  RESPAWN_BASE_MS,
  RESPAWN_MAX_MS,
  RESPAWN_RESET_MS,
  respawnDelayMs,
  runContainer,
  signalIfStillOurs,
  SUPERVISE_TICK_MS,
  type ChildIdentity,
  type ContainerRunDeps,
  type SupervisedChild,
} from "../src/container-run";
import {
  CONTAINER_HOME_CANDIDATES,
  credentialsUnder,
  adoptDaemonHome,
  resolveDaemonHome,
} from "../src/host/daemon-home";
import {
  applyBootstrapUser,
  bootstrapRequestPath,
  consumeBootstrapRequest,
  writeBootstrapRequest,
} from "../src/ui/bootstrap-user";
import { UsersStore, setupUrl } from "../src/ui/users";
import { UiConfigStore } from "../src/ui/config";
import { fortressPaths } from "../src/host/paths";
import { CONTAINER_DISABLE_NOTE } from "../src/ui/copy";
import { runUiVerb } from "../src/cli-ui-verbs";
import { runCli } from "../src/cli";
import type { UiServiceControl } from "../src/ui/service-control";
import { machineBootId, processStartToken } from "../src/ui/instance";
import type { IdentityVerdict, InstanceLockRecord } from "../src/ui/instance";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hx-container-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// ── a child the test drives ──────────────────────────────────────────────────

class FakeChild implements SupervisedChild {
  readonly signals: (NodeJS.Signals | number)[] = [];
  private resolve: (code: number) => void = () => {};
  readonly exited: Promise<number>;

  constructor(readonly pid: number) {
    this.exited = new Promise<number>((r) => (this.resolve = r));
  }
  kill(signal: NodeJS.Signals | number): void {
    this.signals.push(signal);
    this.resolve(143);
  }
  die(code = 1): void {
    this.resolve(code);
  }
}

interface Rig {
  deps: ContainerRunDeps;
  spawned: string[][];
  children: FakeChild[];
  lines: string[];
  stop: () => void;
  finished: Promise<number>;
}

function rig(
  over: { env?: Record<string, string | undefined>; slowTick?: boolean; now?: () => number } = {},
): Rig {
  const spawned: string[][] = [];
  const children: FakeChild[] = [];
  const lines: string[] = [];
  let release = (): void => {};
  const stopSignal = new Promise<void>((r) => (release = r));
  const deps: ContainerRunDeps = {
    env: over.env ?? {},
    writeLine: (line) => lines.push(line),
    spawn: (args) => {
      spawned.push([...args]);
      const child = new FakeChild(1000 + children.length);
      children.push(child);
      return child;
    },
    pid: 1,
    fortressRoot: root,
    // Time is a yield here: the loop's races have to actually settle between
    // assertions, and a real 2s tick would make the suite a minute long.
    // `slowTick` parks the tick so a test can drive the child-exit path alone.
    sleep: (ms) =>
      new Promise<void>((r) => setTimeout(r, over.slowTick && ms >= SUPERVISE_TICK_MS ? 10_000 : 1)),
    stopSignal,
    ...(over.now ? { now: over.now } : {}),
    // The fake children have no pids the kernel knows; the identity guard is
    // exercised on its own below.
    prove: () => "same",
  };
  const finished = runContainer(deps);
  return { deps, spawned, children, lines, stop: release, finished };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 25));

/** The delay each console respawn announced, in order. */
const respawnDelays = (r: Rig): number[] =>
  r.lines
    .filter((line) => line.startsWith("console exited"))
    .map((line) => Number(/restarting in (\d+)ms/.exec(line)?.[1] ?? 0));

async function enableConsole(enabled: boolean): Promise<void> {
  const store = new UiConfigStore(fortressPaths(root).uiConfig);
  await store.update((config) => ({ ...config, enabled }));
}

describe("who may supervise", () => {
  test("the verb is wired, and says so where it cannot run", async () => {
    const lines: string[] = [];
    // Typed on a host, this reaches the pid-1 refusal rather than an unknown
    // verb — the difference between a diagnostic and a help screen.
    const code = await runCli(["container-run"], {
      fortressRoot: root,
      writeLine: (line) => lines.push(line),
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("must be the container's entrypoint (pid 1)");
  });


  test("anything that is not pid 1 is refused, by name", async () => {
    await expect(
      runContainer({
        env: {},
        writeLine: () => {},
        spawn: () => {
          throw new Error("must not spawn");
        },
        pid: 4242,
        fortressRoot: root,
      }),
    ).rejects.toThrow(NOT_PID_ONE_REFUSAL);
  });

  test("the refusal names what pid 1 is for, and what to run instead", () => {
    expect(NOT_PID_ONE_REFUSAL).toContain("SIGTERM");
    expect(NOT_PID_ONE_REFUSAL).toContain("hx-fortress host");
  });
});

describe("what the loop starts", () => {
  test("the daemon always, the console only when it is enabled", async () => {
    const r = rig();
    await settle();
    expect(r.spawned).toEqual([["host"]]);
    r.stop();
    await r.finished;
  });

  test("an enabled console starts beside the daemon, supervised", async () => {
    await enableConsole(true);
    const r = rig();
    await settle();
    expect(r.spawned).toEqual([["host"], ["ui", "--supervised"]]);
    r.stop();
    await r.finished;
  });

  test("FORTRESS_UI_ENABLE alone is enough — the file need not exist", async () => {
    const r = rig({ env: { FORTRESS_UI_ENABLE: "1" } });
    await settle();
    expect(r.spawned).toEqual([["host"], ["ui", "--supervised"]]);
    r.stop();
    await r.finished;
  });
});

describe("what the loop re-reads", () => {
  test("a daemon that dies takes the container with it, carrying its code", async () => {
    await enableConsole(true);
    const r = rig();
    await settle();
    r.children[0]?.die(7);
    // Not respawned. A supervisor that restarted it would report a healthy
    // container over a fortress that never came up — no crash loop for the
    // orchestrator to see and no rollback signal — and the postmaster `pg_ctl`
    // daemonized is re-parented to pid 1, so the next daemon cannot start a
    // cluster that is already running.
    expect(await r.finished).toBe(7);
    expect(r.spawned).toEqual([["host"], ["ui", "--supervised"]]);
    expect(r.lines.some((l) => l.includes("daemon exited (7); stopping the container"))).toBe(true);
    // The console goes down with it rather than serving beside nothing.
    expect(r.children[1]?.signals).toEqual(["SIGTERM"]);
  });

  test("a console that keeps crashing backs off instead of spinning", async () => {
    await enableConsole(true);
    // Real ticks here: the rig collapses every sleep to a yield, and the delay
    // this test reads is the one the loop announced before taking it.
    const r = rig();
    await settle();
    r.children[1]?.die(1);
    await settle();
    r.children[2]?.die(1);
    await settle();
    expect(respawnDelays(r)).toEqual([RESPAWN_BASE_MS, RESPAWN_BASE_MS * 2]);
    r.stop();
    await r.finished;
  });

  test("a console that stayed up is a fresh failure, not the next step of the last one", async () => {
    await enableConsole(true);
    let clock = 0;
    const r = rig({ slowTick: true, now: () => clock });
    await settle();
    // It ran long enough to have been working. Without the reset the backoff is
    // permanent, and a console up for a day comes back at the cap after one
    // restart.
    clock += RESPAWN_RESET_MS;
    r.children[1]?.die(1);
    await settle();
    clock += RESPAWN_RESET_MS;
    r.children[2]?.die(1);
    await settle();
    expect(respawnDelays(r)).toEqual([RESPAWN_BASE_MS, RESPAWN_BASE_MS]);
    r.stop();
    await r.finished;
  });

  test("the backoff doubles to a cap, and no further", () => {
    expect(respawnDelayMs(0)).toBe(RESPAWN_BASE_MS);
    expect(respawnDelayMs(1)).toBe(RESPAWN_BASE_MS * 2);
    expect(respawnDelayMs(99)).toBe(RESPAWN_MAX_MS);
  });

  test("a console that dies while DISABLED is not started again", async () => {
    await enableConsole(true);
    // The tick is parked, so the exit itself is what the loop reacts to — the
    // path this test is about.
    const r = rig({ slowTick: true });
    await settle();
    expect(r.spawned).toHaveLength(2);
    // The operator disables it, then it exits. The predicate is re-read before
    // the respawn, not captured at boot — otherwise "disabled" and "restarting
    // forever" would be the same state.
    await enableConsole(false);
    r.children[1]?.die(0);
    await settle();
    expect(r.spawned).toEqual([["host"], ["ui", "--supervised"]]);
    expect(r.lines.some((l) => l.includes("leaving it stopped"))).toBe(true);
    r.stop();
    await r.finished;
  });

  test("a console that dies while ENABLED comes back", async () => {
    await enableConsole(true);
    const r = rig();
    await settle();
    r.children[1]?.die(1);
    await settle();
    expect(r.spawned).toEqual([["host"], ["ui", "--supervised"], ["ui", "--supervised"]]);
    r.stop();
    await r.finished;
  });

  test("disabling under a RUNNING console stops it — there is no unit to do it", async () => {
    await enableConsole(true);
    const r = rig();
    await settle();
    const child = r.children[1];
    await enableConsole(false);
    await settle();
    expect(child?.signals).toEqual(["SIGTERM"]);
    expect(r.lines.some((l) => l.includes("console disabled; stopping pid"))).toBe(true);
    r.stop();
    await r.finished;
  });

  test("enabling under a stopped console starts it, with no restart of anything else", async () => {
    const r = rig();
    await settle();
    await enableConsole(true);
    await settle();
    expect(r.spawned).toEqual([["host"], ["ui", "--supervised"]]);
    r.stop();
    await r.finished;
  });
});

describe("stopping", () => {
  test("both children are signalled, console first", async () => {
    await enableConsole(true);
    const r = rig();
    await settle();
    r.stop();
    await r.finished;
    expect(r.children[0]?.signals).toEqual(["SIGTERM"]);
    expect(r.children[1]?.signals).toEqual(["SIGTERM"]);
  });
});

describe("what may be signalled", () => {
  function identity(pid: number): ChildIdentity {
    const child = new FakeChild(pid);
    return {
      child,
      exited: false,
      record: { pid, bootId: "boot-a", startTicks: 100, port: 8788 },
    };
  }

  test("a child whose identity still matches is signalled", () => {
    const target = identity(1234);
    expect(signalIfStillOurs(target, "SIGTERM", () => "same")).toBe(true);
    expect((target.child as FakeChild).signals).toEqual(["SIGTERM"]);
  });

  test("a recycled pid is NOT signalled — the daemon is the likeliest recycler", () => {
    const target = identity(1234);
    // A loopback probe would say "a console is listening"; a bare kill(pid, 0)
    // would say "something has that number". Neither says it is still ours, and
    // the process most likely to be wearing a recycled pid in this container is
    // the daemon a console shutdown must never touch.
    const stale = (record: InstanceLockRecord): IdentityVerdict =>
      record.startTicks === 999 ? "same" : "gone";
    expect(signalIfStillOurs(target, "SIGTERM", stale)).toBe(false);
    expect((target.child as FakeChild).signals).toEqual([]);
  });

  test("a child this process already watched exit is never signalled", () => {
    const target = identity(1234);
    target.exited = true;
    // The parent's own observation, and the reason UNPROVEN is allowed to pass
    // below: a reaped pid's next owner is somebody else.
    expect(signalIfStillOurs(target, "SIGTERM", () => "same")).toBe(false);
    expect((target.child as FakeChild).signals).toEqual([]);
  });

  test("an UNPROVEN record still stops the console — a slim image has no start token", () => {
    // Neither /proc nor `ps`: the record cannot say whose pid this is. The
    // supervisor has seen no exit, which is what carries it — a bare pid check
    // on its own would not.
    const target = identity(1234);
    expect(signalIfStillOurs(target, "SIGTERM", () => "unproven")).toBe(true);
    expect((target.child as FakeChild).signals).toEqual(["SIGTERM"]);
  });

  test("the identity carries the boot id AND the start token, not just the pid", () => {
    const record = identity(1234).record;
    expect(record.bootId).toBeTruthy();
    expect(record.startTicks ?? record.startTime).toBeDefined();
  });
});

// ── the daemon's home ────────────────────────────────────────────────────────

describe("where the daemon's credentials are", () => {
  test("a HOME that already holds them wins outright", () => {
    const resolution = resolveDaemonHome({
      env: { HOME: "/data" },
      exists: (file) => file === credentialsUnder("/data"),
    });
    expect(resolution).toMatchObject({ home: "/data", adopted: null });
  });

  test("an image whose HOME moved adopts the one that holds the file", () => {
    const resolution = resolveDaemonHome({
      env: { HOME: "/data" },
      exists: (file) => file === credentialsUnder("/root"),
    });
    expect(resolution.home).toBe("/root");
    expect(resolution.adopted).toBe("/root");
  });

  test("a fresh volume adopts nothing and keeps the home it was given", () => {
    const resolution = resolveDaemonHome({
      env: { HOME: "/data" },
      exists: () => false,
      homedir: () => "/home/ada",
    });
    expect(resolution).toMatchObject({ home: "/data", adopted: null });
    expect(resolution.searched).toEqual(["/data", "/home/ada", "/root", "/"]);
  });

  test("a daemon started under a different HOME adopts the operator's own home", () => {
    const resolution = resolveDaemonHome({
      env: { HOME: "/var/lib/hx-fortress" },
      homedir: () => "/home/ada",
      // Where the enroll wizard put them: `~` for the account that ran it.
      // Credentials live at ~/.let/session-vault on every deployment, and a
      // candidate list of container paths alone never looks at a host's.
      exists: (file) => file === credentialsUnder("/home/ada"),
    });
    expect([resolution.home, resolution.adopted]).toEqual(["/home/ada", "/home/ada"]);
  });

  test("an EMPTY .let is not a home — the file is what makes one", () => {
    const resolution = resolveDaemonHome({
      env: { HOME: "/data" },
      // The directory exists everywhere; the credentials exist only under /root.
      exists: (file) => file === credentialsUnder("/root"),
      candidates: CONTAINER_HOME_CANDIDATES,
    });
    expect(resolution.home).toBe("/root");
  });

  test("the '/' candidate is on the list, and recovers only under a volume", () => {
    expect(CONTAINER_HOME_CANDIDATES).toContain("/");
    expect(credentialsUnder("/")).toBe("/.let/session-vault/credentials.json");
    // The claim the candidate rests on: VOLUME is /data, so /.let is in the
    // writable layer unless the operator mounted something over it.
    const dockerfile = readFileSync(
      path.join(import.meta.dir, "..", "Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toContain('VOLUME ["/data"]');
  });

  test("adopting SETS the home, and leaves it alone when there is nothing to adopt", () => {
    const adopted: Record<string, string | undefined> = { HOME: "/data" };
    adoptDaemonHome({ env: adopted, exists: (file) => file === credentialsUnder("/root") });
    expect(adopted.HOME).toBe("/root");

    const untouched: Record<string, string | undefined> = { HOME: "/data" };
    adoptDaemonHome({ env: untouched, exists: () => false });
    expect(untouched.HOME).toBe("/data");
  });

  test("both processes walk it — one container, two processes, one credentials.json", () => {
    // The daemon adopting the older home while the console keeps the newer one
    // is the state where the bucket panel reads empty and every residency proof
    // answers "this fortress has no object-store credential", on a fortress that
    // is ingesting perfectly well.
    for (const file of ["src/host/main.ts", "src/cli-ui.ts"]) {
      const text = readFileSync(path.join(import.meta.dir, "..", file), "utf8");
      expect(`${file}: ${text.includes("adoptDaemonHome(")}`).toBe(`${file}: true`);
    }
  });

  test("the walk is not reachable from readVaultCredentials", () => {
    // A read-class console handler reaches that function, and the route classes
    // forbid a read route from having an effect. Re-homing the process is one.
    const credentials = readFileSync(
      path.join(import.meta.dir, "..", "src", "modules", "session-vault", "credentials.ts"),
      "utf8",
    );
    expect(credentials).not.toContain("daemon-home");
    expect(credentials).not.toContain("CONTAINER_HOME_CANDIDATES");
  });
});

// ── the first account ────────────────────────────────────────────────────────

describe("FORTRESS_UI_BOOTSTRAP_USER", () => {
  test("the supervisor stages it once per boot; the console consumes it", async () => {
    const r = rig({ env: { FORTRESS_UI_BOOTSTRAP_USER: "ops" } });
    await settle();
    const file = bootstrapRequestPath(fortressPaths(root).uiRoot);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ login: "ops" });
    r.stop();
    await r.finished;

    // Consumed as it is read: a respawned console finds nothing and prints no
    // second link into the container log.
    expect(await consumeBootstrapRequest(file)).toMatchObject({ login: "ops" });
    expect(await consumeBootstrapRequest(file)).toBeNull();
  });

  test("a fresh volume gets an operator account and its setup link", async () => {
    const users = new UsersStore(path.join(root, "users.json"));
    const applied = await applyBootstrapUser({
      request: { login: "ops", requestedAt: new Date().toISOString() },
      users,
      base: "http://127.0.0.1:8788",
      linkFile: path.join(root, "ui", "bootstrap-setup-link.txt"),
    });
    expect(applied.created).toBe(true);
    const file = await users.load();
    expect(file.users[0]).toMatchObject({ login: "ops", role: "operator" });
    const token = file.users[0]?.setupTokens[0];
    expect(token).toBeDefined();
    // The link is a live 24-hour operator credential and this console's stdout
    // is pid 1's stdout — the container log aggregator, where a secret is
    // retained, indexed and searchable. It goes to a 0600 file; the log names
    // the path.
    const linkFile = path.join(root, "ui", "bootstrap-setup-link.txt");
    expect(applied.lines.some((l) => l.includes("/setup#t="))).toBe(false);
    expect(applied.lines.some((l) => l.includes(linkFile))).toBe(true);
    const written = await readFile(linkFile, "utf8");
    expect(written).toContain("/setup#t=");
    expect((await stat(linkFile)).mode & 0o777).toBe(0o600);
    expect(applied.lines.join("\n")).toContain("hx-fortress ui user reset ops");
  });

  test("a login that already exists is LEFT ALONE, and the reset verb is printed", async () => {
    const users = new UsersStore(path.join(root, "users.json"));
    const first = await users.create("ops", "operator");
    const applied = await applyBootstrapUser({
      request: { login: "ops", requestedAt: new Date().toISOString() },
      users,
      base: "http://127.0.0.1:8788",
      linkFile: path.join(root, "ui", "bootstrap-setup-link.txt"),
    });
    // `ui user create` fails on an existing login, and resetting one on every
    // redeploy would make a container restart an account takeover.
    expect(applied.created).toBe(false);
    expect(applied.lines.join("\n")).toContain("hx-fortress ui user reset ops");
    const file = await users.load();
    expect(file.users[0]?.setupTokens).toHaveLength(1);
    // The link the first boot printed still works: nothing was rotated.
    expect(applied.lines.join("\n")).not.toContain(setupUrl("http://127.0.0.1:8788", first.token));
  });

  test("an unusable login is reported rather than created", async () => {
    const users = new UsersStore(path.join(root, "users.json"));
    const applied = await applyBootstrapUser({
      request: { login: "not a login!", requestedAt: "" },
      users,
      base: "http://127.0.0.1:8788",
      linkFile: path.join(root, "ui", "bootstrap-setup-link.txt"),
    });
    expect(applied.created).toBe(false);
    expect(applied.lines[0]).toContain("not a usable login");
    expect((await users.load()).users).toEqual([]);
  });

  test("a torn request file is no request", async () => {
    const file = path.join(root, "bootstrap-user.json");
    await writeFile(file, "{not json");
    expect(await consumeBootstrapRequest(file)).toBeNull();
    await writeBootstrapRequest(file, "ops");
    expect(await consumeBootstrapRequest(file)).toMatchObject({ login: "ops" });
  });
});

// ── ui disable, in a container ───────────────────────────────────────────────

describe("ui disable inside a container", () => {
  const noUnit: UiServiceControl = {
    name: "container",
    installed: async () => false,
    install: async () => {},
    start: async () => {},
    uninstall: async () => {},
    stopAndDisable: async () => {},
  };

  /** A console holding its own lock, as this process would find it. */
  async function lockHeldBy(record: Partial<InstanceLockRecord>): Promise<void> {
    const file = path.join(fortressPaths(root).uiRoot, "instance.lock");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      `${JSON.stringify({
        pid: process.pid,
        bootId: machineBootId(),
        ...processStartToken(process.pid),
        port: 8788,
        ...record,
      })}\n`,
    );
  }

  test("flips the setting and names the supervisor, instead of naming a pid to kill", async () => {
    await enableConsole(true);
    // A SUPERVISED console: it recorded that something re-reads the setting and
    // will stop it. That claim comes off its lock, never off the detector.
    await lockHeldBy({ supervised: true });
    const lines: string[] = [];
    const code = await runUiVerb(["disable"], {
      writeLine: (line) => lines.push(line),
      env: { KUBERNETES_SERVICE_HOST: "10.0.0.1" },
      platform: "linux",
      fortressRoot: root,
      service: noUnit,
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain(CONTAINER_DISABLE_NOTE);
    // Killing the pid here would be undone by the next respawn; the flip is what
    // the supervisor reads.
    expect(lines.join("\n")).not.toContain("kill ");
    expect((await new UiConfigStore(fortressPaths(root).uiConfig).load()).enabled).toBe(false);
  });

  test("a container console nobody supervises is not promised a supervisor", async () => {
    await enableConsole(true);
    // A custom entrypoint, or an image built before `container-run`: the console
    // is running and nothing is watching the setting. Saying the supervisor will
    // stop it within a few seconds names a process that does not exist.
    await lockHeldBy({});
    await expect(
      runUiVerb(["disable"], {
        writeLine: () => {},
        env: { KUBERNETES_SERVICE_HOST: "10.0.0.1" },
        platform: "linux",
        fortressRoot: root,
        service: noUnit,
      }),
    ).rejects.toThrow(/running in the foreground/);
    // And the setting is untouched, because the flip alone would have done
    // nothing while reading as though it had.
    expect((await new UiConfigStore(fortressPaths(root).uiConfig).load()).enabled).toBe(true);
  });

  test("the note says the supervisor will not bring it back", () => {
    expect(CONTAINER_DISABLE_NOTE).toContain("will not restart it");
  });
});
