import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { commandError, NodeCommandRunner } from "./command-runner";
import {
  DAEMON_UNIT,
  type CommandRunner,
  type ServiceInstallOptions,
  type ServiceManager,
  type ServiceState,
  type ServiceUnit,
  type UnitIdentity,
} from "./types";

const MAX_STATE_POLLS = 20;
const TRANSIENT_BOOTSTRAP =
  /Bootstrap failed: (5|37|125)\b|Input\/output error|Operation (already|now) in progress/i;

interface LaunchdDependencies {
  home: string;
  uid: number;
  unit?: UnitIdentity;
  runner?: CommandRunner;
  mkdir?: typeof mkdir;
  writeFile?: (
    file: string,
    contents: string,
  ) => Promise<void>;
  readFile?: (file: string) => Promise<string>;
  removeFile?: (file: string) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class LaunchdServiceManager implements ServiceManager {
  readonly name = "launchd";
  private readonly runner: CommandRunner;
  private readonly makeDirectory: typeof mkdir;
  private readonly write: (file: string, contents: string) => Promise<void>;
  private readonly read: (file: string) => Promise<string>;
  private readonly remove: (file: string) => Promise<void>;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly label: string;

  constructor(private readonly dependencies: LaunchdDependencies) {
    this.runner = dependencies.runner ?? new NodeCommandRunner();
    this.makeDirectory = dependencies.mkdir ?? mkdir;
    this.write = dependencies.writeFile ?? ((file, contents) => writeFile(file, contents));
    this.read = dependencies.readFile ?? ((file) => readFile(file, "utf8"));
    this.remove = dependencies.removeFile ?? ((file) => rm(file, { force: true }));
    this.sleep =
      dependencies.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.label = (dependencies.unit ?? DAEMON_UNIT).label;
  }

  async state(): Promise<ServiceState> {
    const result = this.runner.run("launchctl", ["list", this.label]);
    if (result.status !== 0) return { loaded: false, pid: null };
    const match = result.stdout.match(/"PID"\s*=\s*(\d+);/);
    return {
      loaded: true,
      pid: match ? Number(match[1]) : null,
    };
  }

  async unit(): Promise<ServiceUnit> {
    const plistPath = this.plistPath();
    let text: string;
    try {
      text = await this.read(plistPath);
    } catch {
      return { path: plistPath, present: false, executablePath: null };
    }
    return { path: plistPath, present: true, executablePath: parseLaunchdProgram(text) };
  }

  async install(options: ServiceInstallOptions): Promise<void> {
    const plistPath = this.plistPath();
    await this.makeDirectory(path.dirname(plistPath), { recursive: true });
    await this.ensureLogDir(options.serviceLogPath);
    await this.write(plistPath, renderLaunchdPlist(options, this.label));
    await this.load(plistPath);
  }

  /** Load the plist that is already on disk. The bootout + wait is not about
   *  re-rendering: without it, a start against a loaded-but-dead agent fails on
   *  the EALREADY family, which is exactly the state a partially-failed stop
   *  leaves behind. */
  async start(): Promise<void> {
    const plistPath = this.plistPath();
    await this.load(plistPath);
  }

  async restart(): Promise<void> {
    this.runOrThrow("launchctl", ["kickstart", "-k", `${this.target()}/${this.label}`]);
  }

  async stop(): Promise<{ wasRunning: boolean }> {
    const target = this.target();
    this.runner.run("launchctl", ["disable", `${target}/${this.label}`]);
    const before = await this.state();
    if (!before.loaded) return { wasRunning: false };

    const bootout = this.runner.run("launchctl", [
      "bootout",
      `${target}/${this.label}`,
    ]);
    if (!(await this.waitUntilUnloaded())) {
      throw new Error(
        `launchctl bootout ${target}/${this.label} failed: unit still loaded${
          bootout.stderr.trim() ? ` (${bootout.stderr.trim()})` : ""
        }`,
      );
    }
    return { wasRunning: before.pid !== null };
  }

  async uninstall(): Promise<void> {
    const target = this.target();
    this.runner.run("launchctl", ["disable", `${target}/${this.label}`]);
    this.runner.run("launchctl", ["bootout", `${target}/${this.label}`]);
    await this.waitUntilUnloaded();
    await this.remove(this.plistPath());
  }

  async ensureLogDir(serviceLogPath: string): Promise<void> {
    await this.makeDirectory(path.dirname(serviceLogPath), { recursive: true });
  }

  private async load(plistPath: string): Promise<void> {
    const target = this.target();
    this.runner.run("launchctl", ["bootout", `${target}/${this.label}`]);
    await this.waitUntilUnloaded();
    this.runOrThrow("launchctl", ["enable", `${target}/${this.label}`]);
    await this.bootstrapWithRetry(target, plistPath);
  }

  private target(): string {
    return `gui/${this.dependencies.uid}`;
  }

  private plistPath(): string {
    return path.join(
      this.dependencies.home,
      "Library",
      "LaunchAgents",
      `${this.label}.plist`,
    );
  }

  private async waitUntilUnloaded(): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_STATE_POLLS; attempt++) {
      if (!(await this.state()).loaded) return true;
      await this.sleep(100);
    }
    return false;
  }

  private async bootstrapWithRetry(
    target: string,
    plistPath: string,
  ): Promise<void> {
    const args = ["bootstrap", target, plistPath] as const;
    const delays = [150, 300, 600, 1000];
    let result = this.runner.run("launchctl", args);
    for (const delay of delays) {
      if (result.status === 0) return;
      const detail = result.stderr.trim() || result.stdout.trim();
      if (!TRANSIENT_BOOTSTRAP.test(detail)) break;
      await this.sleep(delay);
      result = this.runner.run("launchctl", args);
    }
    if (result.status !== 0) {
      throw commandError("launchctl", args, result);
    }
  }

  private runOrThrow(command: string, args: readonly string[]): void {
    const result = this.runner.run(command, args);
    if (result.status !== 0) throw commandError(command, args, result);
  }
}

export function renderLaunchdPlist(
  options: ServiceInstallOptions,
  label: string = DAEMON_UNIT.label,
): string {
  const executablePath = escapeXml(options.executablePath);
  const serviceLogPath = escapeXml(options.serviceLogPath);
  const args = (options.args ?? ["host"])
    .map((arg) => `\n      <string>${escapeXml(arg)}</string>`)
    .join("");
  const environment = Object.entries(options.environment ?? {})
    .map(([key, value]) => `\n      <key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`)
    .join("");
  const environmentBlock = environment
    ? `\n    <key>EnvironmentVariables</key>\n    <dict>${environment}\n    </dict>`
    : "";
  // NO `Crashed` key. Per launchd.plist(5) the KeepAlive sub-keys are OR'd and
  // `Crashed=false` means "restart when the job did NOT crash" — the inverse of
  // what it reads as. Paired with SuccessfulExit=false it matched every
  // termination, making KeepAlive unconditional: the opposite of the ceiling the
  // comment claimed. `SuccessfulExit=false` alone is the honest rule (come back
  // only after a non-zero exit), and ThrottleInterval below rate-limits it.
  // launchd has no start-limit concept and no `failed` state, so on darwin there
  // is no ceiling to express — see RestartDiscipline, which now says so.
  const throttle = options.restart
    ? `\n    <key>ThrottleInterval</key><integer>${options.restart.throttleSeconds}</integer>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${escapeXml(label)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${executablePath}</string>${args}
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key><false/>
    </dict>${throttle}${environmentBlock}
    <key>StandardOutPath</key><string>${serviceLogPath}</string>
    <key>StandardErrorPath</key><string>${serviceLogPath}</string>
  </dict>
</plist>
`;
}

/** The binary an installed agent starts — the first ProgramArguments entry.
 *  Inverse of the renderer above, pinned by a round-trip test. */
export function parseLaunchdProgram(plistText: string): string | null {
  const array = plistText.match(
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/,
  );
  if (!array?.[1]) return null;
  const first = array[1].match(/<string>([\s\S]*?)<\/string>/);
  if (!first?.[1]) return null;
  return unescapeXml(first[1]);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}
