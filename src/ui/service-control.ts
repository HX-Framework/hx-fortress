// The console's own service unit — named here, installed by the install-service
// verb, and consulted by `ui disable` and by the SSO precondition.
//
// The names are PINNED. `ui disable` has to stop the same unit the installer
// wrote, and the SSO precondition has to know whether a unit exists at all: when
// one does, the precondition reads ui.json and the unit's own environment and
// NEVER the invoking shell's, because `FORTRESS_UI_PUBLIC_URL=... hx-fortress ui
// sso on` would otherwise pass a check the unit can never satisfy.
//
// "Installed" means the UNIT FILE EXISTS. It is deliberately not `state().loaded`
// — a unit is unloaded by `hx-fortress ui disable` and by any stop, and reading
// loaded-ness here would report an installed console as absent and send the
// update path down its no-unit branch.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeCommandRunner } from "../service/command-runner";
import { getServiceManager } from "../service";
import { CONSOLE_UNIT, type CommandRunner, type RestartDiscipline, type ServiceManager } from "../service/types";

export const SYSTEMD_UI_UNIT = CONSOLE_UNIT.unitName;
export const LAUNCHD_UI_LABEL = CONSOLE_UNIT.label;

/**
 * How the console unit is allowed to come back.
 *
 * A binary that does not understand `ui --supervised` — a downgrade — exits
 * immediately, every time. On systemd the burst is a real ceiling: the unit goes
 * to failed and stays there, which is a state an operator can see and a loop is
 * not. On launchd there is no equivalent — no start limit, no failed state — so
 * `throttleSeconds` buys a slow loop rather than a stopped one, and the darwin
 * remedy is `ui --uninstall-service`. Stated rather than assumed, because the
 * unit generator used to claim a ceiling it did not have.
 */
export const UI_RESTART_DISCIPLINE: RestartDiscipline = {
  limitIntervalSec: 60,
  limitBurst: 5,
  throttleSeconds: 30,
};

export interface UiUnitInstallOptions {
  executablePath: string;
  serviceLogPath: string;
  /** Baked into the unit as its only environment directive. */
  fortressRoot: string;
  /** Persisted into the unit's ARGUMENTS. A unit carries no FORTRESS_UI_*, so
   *  this is the only way a supervised console can be told that its non-loopback
   *  bind was a deliberate gesture. */
  allowInsecureBind: boolean;
}

export interface UiServiceControl {
  readonly name: string;
  /** True when a console unit FILE exists on this host, loaded or not. */
  installed(): Promise<boolean>;
  /** Write the unit and start it. */
  install(options: UiUnitInstallOptions): Promise<void>;
  /** Enable and start the unit that is already installed, without rewriting it. */
  start(): Promise<void>;
  /** Stop it, forget it across a reboot, and remove the file. Never touches
   *  ui.json: the rollback rung disarms the button with `ui sso off` first and
   *  depends on `enabled` surviving this step. */
  uninstall(): Promise<void>;
  /** Stop it and keep it stopped across a reboot. */
  stopAndDisable(): Promise<void>;
}

/** The unit arguments, in one place: the installer writes them and the parse
 *  contract reads them back. */
export function uiUnitArgs(allowInsecureBind: boolean): string[] {
  return allowInsecureBind ? ["ui", "--supervised", "--allow-insecure-bind"] : ["ui", "--supervised"];
}

/** A console unit driven through the same manager the daemon unit uses, so the
 *  renderers, the ExecStart parse contract and the lifecycle verbs are one
 *  implementation rather than two. */
class ManagedUiService implements UiServiceControl {
  constructor(private readonly manager: ServiceManager) {}

  get name(): string {
    return this.manager.name;
  }

  async installed(): Promise<boolean> {
    return (await this.manager.unit()).present;
  }

  async install(options: UiUnitInstallOptions): Promise<void> {
    await this.manager.install({
      executablePath: options.executablePath,
      serviceLogPath: options.serviceLogPath,
      args: uiUnitArgs(options.allowInsecureBind),
      environment: { FORTRESS_ROOT: options.fortressRoot },
      restart: UI_RESTART_DISCIPLINE,
    });
  }

  async start(): Promise<void> {
    await this.manager.start();
  }

  async uninstall(): Promise<void> {
    await this.manager.uninstall();
  }

  async stopAndDisable(): Promise<void> {
    await this.manager.stop().catch(() => ({ wasRunning: false }));
  }
}

/** A host whose init system this build does not drive. Reports no unit, which is
 *  the honest answer: the console runs in the foreground there. */
export class NoUiService implements UiServiceControl {
  readonly name = "none";

  async installed(): Promise<boolean> {
    return false;
  }

  async install(): Promise<void> {
    throw new Error(
      `this build does not install services on ${process.platform} — run \`hx-fortress ui\` in the foreground`,
    );
  }

  async start(): Promise<void> {
    // Nothing to start.
  }

  async uninstall(): Promise<void> {
    // Nothing to remove.
  }

  async stopAndDisable(): Promise<void> {
    // Nothing to stop.
  }
}

export function getUiServiceControl(
  options: { platform?: string; uid?: number; home?: string } = {},
): UiServiceControl {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin") return new NoUiService();
  return new ManagedUiService(
    getServiceManager({
      platform,
      unit: CONSOLE_UNIT,
      ...(options.home ? { home: options.home } : {}),
      ...(options.uid !== undefined ? { uid: options.uid } : {}),
    }),
  );
}

// ── Linger ──────────────────────────────────────────────────────────────────

/** Systemd user units die with the last session unless the account lingers, so
 *  a console installed over ssh disappears when that ssh session ends. Detected
 *  and named rather than fixed: enabling linger is a decision about the host. */
export function lingerWarning(options: {
  platform?: string;
  user?: string;
  runner?: CommandRunner;
}): string | null {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") return null;
  const user = options.user ?? os.userInfo().username;
  const runner = options.runner ?? new NodeCommandRunner();
  const result = runner.run("loginctl", ["show-user", user, "-p", "Linger"]);
  if (result.status !== 0) return null;
  if (/Linger=yes/i.test(result.stdout)) return null;
  return (
    `linger is off for ${user}: this unit stops when your last login session ends. ` +
    `Enable it with \`sudo loginctl enable-linger ${user}\`.`
  );
}

// ── Daemon root derivation ──────────────────────────────────────────────────

export type DaemonRootSource = "unit environment" | "default for the unit's user";

export interface DaemonRootDerivation {
  root: string;
  source: DaemonRootSource;
}

/**
 * Where the DAEMON keeps its state, derived without consulting this process's
 * environment.
 *
 * `FORTRESS_ROOT=… hx-fortress ui --install-service` describes the shell, not
 * the service: reading it here would compare the console's root against itself
 * and pass every time. The unit's own Environment is authoritative when present;
 * an ABSENT one means the daemon takes its default, which is a root, not an
 * unknown — a pre-console unit carries no Environment at all and installing
 * beside it must succeed.
 */
export function deriveDaemonRoot(options: {
  platform?: string;
  home?: string;
  unitEnvironment?: string | null;
  exists?: (file: string) => boolean;
}): DaemonRootDerivation {
  const fromUnit = options.unitEnvironment
    ? parseUnitFortressRoot(options.unitEnvironment)
    : null;
  if (fromUnit) return { root: fromUnit, source: "unit environment" };
  const home = options.home ?? os.homedir();
  const current = path.join(home, ".let", "hx-fortress");
  const legacy = path.join(home, ".let", "fortress");
  const exists = options.exists ?? existsSync;
  if (!exists(current) && exists(legacy)) {
    return { root: legacy, source: "default for the unit's user" };
  }
  return { root: current, source: "default for the unit's user" };
}

/** FORTRESS_ROOT out of a `systemctl show -p Environment` line or a plist
 *  EnvironmentVariables dict. Returns null when the daemon names none. */
export function parseUnitFortressRoot(text: string): string | null {
  const plist = text.match(
    /<key>FORTRESS_ROOT<\/key>\s*<string>([\s\S]*?)<\/string>/,
  );
  if (plist?.[1]) return decodeXml(plist[1]);
  const environment = text.match(/FORTRESS_ROOT=("([^"]*)"|(\S+))/);
  if (environment) return environment[2] ?? environment[3] ?? null;
  return null;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/** The daemon unit's environment as the host states it, or null when no unit is
 *  installed. Read through the init system rather than the file so a unit
 *  written by hand, by a package or by an older release is read the same way. */
export function readDaemonUnitEnvironment(options: {
  platform?: string;
  uid?: number;
  home?: string;
  runner?: CommandRunner;
  readFile?: (file: string) => string | null;
}): string | null {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? new NodeCommandRunner();
  if (platform === "linux") {
    const result = runner.run("systemctl", [
      "--user",
      "show",
      "hx-fortress.service",
      "-p",
      "Environment",
    ]);
    return result.status === 0 ? result.stdout : null;
  }
  if (platform === "darwin") {
    const home = options.home ?? os.homedir();
    const plist = path.join(home, "Library", "LaunchAgents", "ai.let.hx-fortress.plist");
    const read = options.readFile ?? readFileSyncSafe;
    return read(plist);
  }
  return null;
}

function readFileSyncSafe(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function rootDivergenceRefusal(consoleRoot: string, daemon: DaemonRootDerivation): string {
  return (
    `refusing to install the console unit: this shell's fortress root is ${consoleRoot}, ` +
    `but the daemon's is ${daemon.root} (${daemon.source}). ` +
    `A console on a different root reads a different database, a different audit spool and a ` +
    `different set of accounts. Install it from the daemon's root, or point the daemon at this one.`
  );
}

/**
 * Restart the console unit from a process that may be the console.
 *
 * DETACHED, and after the outcome record is already on disk. A console that
 * restarted its own unit in-process would be killed part-way through writing the
 * record of what it just did; the terminal takes the same path so there is one
 * ordering to reason about rather than two.
 */
export function restartUiUnitDetached(options: {
  platform?: string;
  uid?: number;
  spawnImpl?: typeof spawn;
}): void {
  const platform = options.platform ?? process.platform;
  const run = options.spawnImpl ?? spawn;
  const [command, args]: [string, string[]] =
    platform === "darwin"
      ? [
          "launchctl",
          ["kickstart", "-k", `gui/${options.uid ?? process.getuid?.() ?? 0}/${LAUNCHD_UI_LABEL}`],
        ]
      : ["systemctl", ["--user", "restart", SYSTEMD_UI_UNIT]];
  const child = run(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}
