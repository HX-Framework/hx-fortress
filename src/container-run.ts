// `hx-fortress container-run` — one container, two long-running processes.
//
// A container image has one entrypoint and the fortress has two things to run:
// the daemon, and the console beside it. They are deliberately separate
// processes (a stopped daemon cannot serve its own Start button), which on a
// host is systemd's problem and in a container is nobody's — so this is that
// nobody.
//
// PID 1 ONLY, and it refuses otherwise. Not fussiness: pid 1 is what receives
// the container runtime's SIGTERM, and a supervisor that is not pid 1 leaves the
// daemon to be killed by the runtime's timeout instead of stopped by its own
// shutdown path — which means the last status write, the last audit drain and
// the cluster's clean stop all do not happen. pid 1 is also the parent every
// orphan is re-parented to, so it is the only process that can reap them.
//
// THE DAEMON IS NOT RESTARTED. Its exit is this process's exit, with its code.
// A supervisor that respawned it would report a healthy container over a
// fortress that has never once come up: no crash loop for the orchestrator to
// see, no rollback signal, and FORTRESS_STORE_EXIT_ON_WEDGE — whose whole
// contract is "exit and let something restart me" — silently answered by
// something that restarts nothing else. It is also unsurvivable in practice:
// `pg_ctl` daemonizes the postmaster, so a dead daemon leaves its cluster
// re-parented to pid 1 and the next daemon cannot start one that is already
// running. That container serves every Postgres-backed surface as dark.
//
// THE CONSOLE IS RESTARTED, WITH BACKOFF. It is the secondary process and its
// failures are its own; a console that exits immediately backs off toward the
// cap instead of spinning through the container's log.
//
// THE CONSOLE'S ENABLEMENT IS RE-READ BEFORE EVERY RESPAWN, never captured at
// boot. `ui enable` and `ui disable` write a file, and in a container there is no
// unit for `ui disable` to stop — the console stops because this loop notices.
// The same read is what stops a disabled console from being respawned after it
// exits, which is the difference between "disabled" and "restarting forever".

import {
  identify,
  signalIfStillOurs,
  spawnFortress,
  stopChildren,
  type ChildIdentity,
  type SupervisedChild,
} from "./container-children";
import { fortressPaths } from "./host/paths";
import { LiveUiConfig, effectiveUiEnabled } from "./ui/config";
import { proveIdentity, type IdentityVerdict, type InstanceLockRecord } from "./ui/instance";
import { bootstrapRequestPath, writeBootstrapRequest } from "./ui/bootstrap-user";

export type { ChildIdentity, SupervisedChild };
export { signalIfStillOurs, spawnFortress };

/** The first console respawn delay, and the ceiling it doubles toward. Long
 *  enough that a binary which exits immediately does not spin; short enough that
 *  a genuine crash is back inside a health check's window. */
export const RESPAWN_BASE_MS = 1_000;
export const RESPAWN_MAX_MS = 30_000;

/** How long a console has to stay up before its next crash is treated as a fresh
 *  one. Without it the backoff is permanent: a console that has run for a day
 *  would come back at the cap after a single restart. */
export const RESPAWN_RESET_MS = 60_000;

/** How long the daemon is given to stop on its own after the container runtime
 *  asks. Deliberately under Docker's default 10s grace: a supervisor that used
 *  the whole window would be SIGKILLed alongside the child it was waiting for. */
export const SHUTDOWN_GRACE_MS = 8_000;

/** How often the loop re-reads the enablement predicate while everything is up. */
export const SUPERVISE_TICK_MS = 2_000;

export const NOT_PID_ONE_REFUSAL =
  "hx-fortress container-run must be the container's entrypoint (pid 1). It is what receives the " +
  "runtime's SIGTERM and what orphaned processes are re-parented to; started under a shell or an " +
  "init wrapper it can do neither, and the daemon would be killed rather than stopped. " +
  "Set ENTRYPOINT [\"hx-fortress\", \"container-run\"], or run `hx-fortress host` directly.";

/** Doubling from the base to the cap. Exported because the schedule is a
 *  decision, and a test that re-derived it would only re-state the code. */
export function respawnDelayMs(attempt: number): number {
  const doubled = RESPAWN_BASE_MS * 2 ** Math.max(0, attempt);
  return Math.min(RESPAWN_MAX_MS, doubled);
}

type Who = "daemon" | "console";
interface Settled {
  who: Who | "tick" | "stop";
  code: number;
}

export interface ContainerRunDeps {
  env: Record<string, string | undefined>;
  writeLine: (line: string) => void;
  /** Start one child by argv tail. The supervisor never builds a shell string. */
  spawn: (args: readonly string[]) => SupervisedChild;
  pid?: number;
  fortressRoot?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Injected in tests; the real loop runs until it is signalled. */
  stopSignal?: Promise<void>;
  /** Proves a recorded child is still the process that was started. */
  prove?: (record: InstanceLockRecord) => IdentityVerdict;
}

/**
 * Run the container until the daemon stops, or until it is asked to.
 *
 * Returns the daemon's exit code, so the orchestrator sees what the fortress
 * saw rather than a supervisor's opinion of it.
 */
export async function runContainer(deps: ContainerRunDeps): Promise<number> {
  const pid = deps.pid ?? process.pid;
  if (pid !== 1) throw new Error(NOT_PID_ONE_REFUSAL);

  const paths = fortressPaths(deps.fortressRoot);
  // UNREF'D. Every sleep here is one half of a race — the supervise tick against
  // a child exiting, the shutdown grace against the children stopping — so the
  // loser is always left pending. A referenced timer keeps the event loop alive
  // until it fires, and this process exits by draining the loop
  // (`process.exitCode`, never `process.exit`), so the container reported its
  // daemon's exit code up to a whole grace period late and burned the full
  // 8 s window on every clean stop. Unref'd, a race the sleep loses costs
  // nothing.
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((r) => {
        const timer = setTimeout(r, ms);
        (timer as { unref?: () => void }).unref?.();
      }));
  const now = deps.now ?? Date.now;
  const prove = deps.prove ?? proveIdentity;
  const config = new LiveUiConfig(paths.uiConfig, (message) => deps.writeLine(message));
  const uiEnabled = async (): Promise<boolean> => {
    try {
      return effectiveUiEnabled(await config.read(), deps.env);
    } catch (error) {
      // A ui.json this process cannot parse is a reason to leave the console
      // alone, never a reason to take the daemon down with it.
      deps.writeLine(`console configuration unreadable: ${errorText(error)}`);
      return false;
    }
  };

  // The bootstrap request is written ONCE, here, before any console starts —
  // the console consumes it as it reads it, so a respawn finds nothing and the
  // link is printed exactly once per container boot.
  const bootstrapLogin = deps.env.FORTRESS_UI_BOOTSTRAP_USER?.trim();
  if (bootstrapLogin) {
    await writeBootstrapRequest(bootstrapRequestPath(paths.uiRoot), bootstrapLogin).catch(
      (error: unknown) => {
        deps.writeLine(`could not stage the console bootstrap account: ${errorText(error)}`);
      },
    );
  }

  let stopping = false;
  const stop = deps.stopSignal ?? signalled(["SIGTERM", "SIGINT"]);
  // Raced alongside the children, not merely polled at the next tick: the
  // runtime's grace period starts the moment it signals, and a supervisor that
  // spent the first seconds of it asleep has that much less to stop with.
  const stopped: Promise<Settled> = stop.then(() => {
    stopping = true;
    return { who: "stop" as const, code: 0 };
  });

  const consolePort = Number(deps.env.FORTRESS_UI_PORT?.trim()) || 0;
  interface Slot {
    identity: ChildIdentity | null;
    exit: Promise<Settled> | null;
    startedAt: number;
    crashes: number;
  }
  const daemon: Slot = { identity: null, exit: null, startedAt: 0, crashes: 0 };
  const ui: Slot = { identity: null, exit: null, startedAt: 0, crashes: 0 };

  const start = (slot: Slot, who: Who, args: readonly string[], port: number): void => {
    const identity = identify(deps.spawn(args), port);
    slot.identity = identity;
    slot.startedAt = now();
    slot.exit = identity.child.exited.then((code) => ({ who, code }));
    deps.writeLine(`${who} started (pid ${identity.record.pid})`);
  };
  const startDaemon = (): void => start(daemon, "daemon", ["host"], 0);
  const startConsole = (): void => start(ui, "console", ["ui", "--supervised"], consolePort);

  startDaemon();
  if (await uiEnabled()) startConsole();

  let exitCode = 0;
  while (!stopping) {
    const races: Promise<Settled>[] = [
      stopped,
      sleep(SUPERVISE_TICK_MS).then(() => ({ who: "tick" as const, code: 0 })),
    ];
    if (daemon.exit) races.push(daemon.exit);
    if (ui.exit) races.push(ui.exit);
    const settled = await Promise.race(races);
    if (stopping || settled.who === "stop") break;

    if (settled.who === "daemon") {
      // D4: host exit ⇒ exit. See the header — this is the whole reason the
      // container is allowed to fail visibly.
      daemon.identity = null;
      daemon.exit = null;
      exitCode = settled.code;
      deps.writeLine(`daemon exited (${settled.code}); stopping the container`);
      break;
    }

    if (settled.who === "console") {
      ui.identity = null;
      ui.exit = null;
      // Re-read BEFORE respawning, not after: a console that exited because the
      // operator disabled it must not be started again by the loop that noticed.
      if (!(await uiEnabled())) {
        deps.writeLine("console exited and is disabled; leaving it stopped");
        continue;
      }
      // A console that ran long enough to be working is a fresh failure, not the
      // next step of the last one.
      ui.crashes = now() - ui.startedAt >= RESPAWN_RESET_MS ? 0 : ui.crashes + 1;
      const delay = respawnDelayMs(ui.crashes - 1);
      deps.writeLine(`console exited (${settled.code}); restarting in ${delay}ms`);
      await sleep(delay);
      if (stopping) break;
      startConsole();
      continue;
    }

    // A tick. The only thing it decides is whether the console's enablement
    // FLIPPED under a running process.
    const enabled = await uiEnabled();
    const running = ui.identity;
    if (enabled && !running) {
      startConsole();
    } else if (!enabled && running) {
      deps.writeLine(
        signalIfStillOurs(running, "SIGTERM", prove)
          ? `console disabled; stopping pid ${running.record.pid}`
          : "console disabled; the process it was is already gone",
      );
      ui.identity = null;
      ui.exit = null;
    }
  }

  // Console first, daemon last: the console reads the daemon's status and
  // database, and stopping the watched before the watcher turns an ordinary
  // shutdown into a page full of connection errors.
  deps.writeLine("stopping");
  await stopChildren([ui.identity, daemon.identity], {
    graceMs: SHUTDOWN_GRACE_MS,
    sleep,
    prove,
  });
  return exitCode;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolves on the first of these signals. */
function signalled(signals: readonly NodeJS.Signals[]): Promise<void> {
  return new Promise<void>((resolve) => {
    for (const signal of signals) process.once(signal, () => resolve());
  });
}

/** The verb. Separated from the loop so the loop takes no process globals. */
export async function runContainerCommand(
  deps: Pick<ContainerRunDeps, "writeLine"> & Partial<ContainerRunDeps>,
): Promise<number> {
  return await runContainer({
    env: deps.env ?? process.env,
    writeLine: deps.writeLine,
    spawn: deps.spawn ?? spawnFortress(process.execPath),
    ...(deps.pid !== undefined ? { pid: deps.pid } : {}),
    ...(deps.fortressRoot ? { fortressRoot: deps.fortressRoot } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.stopSignal ? { stopSignal: deps.stopSignal } : {}),
    // Forwarded, not dropped: a caller that passes a clock or an identity proof
    // and silently gets the real ones is a test that proves nothing.
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.prove ? { prove: deps.prove } : {}),
  });
}
