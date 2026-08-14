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

interface SystemdDependencies {
  home: string;
  unit?: UnitIdentity;
  runner?: CommandRunner;
  mkdir?: typeof mkdir;
  writeFile?: (
    file: string,
    contents: string,
  ) => Promise<void>;
  readFile?: (file: string) => Promise<string>;
  removeFile?: (file: string) => Promise<void>;
}

export class SystemdServiceManager implements ServiceManager {
  readonly name = "systemd (user)";
  private readonly runner: CommandRunner;
  private readonly makeDirectory: typeof mkdir;
  private readonly write: (file: string, contents: string) => Promise<void>;
  private readonly read: (file: string) => Promise<string>;
  private readonly remove: (file: string) => Promise<void>;
  private readonly unitName: string;

  constructor(private readonly dependencies: SystemdDependencies) {
    this.runner = dependencies.runner ?? new NodeCommandRunner();
    this.makeDirectory = dependencies.mkdir ?? mkdir;
    this.write = dependencies.writeFile ?? ((file, contents) => writeFile(file, contents));
    this.read = dependencies.readFile ?? ((file) => readFile(file, "utf8"));
    this.remove = dependencies.removeFile ?? ((file) => rm(file, { force: true }));
    this.unitName = (dependencies.unit ?? DAEMON_UNIT).unitName;
  }

  async state(): Promise<ServiceState> {
    const enabled = this.runner.run("systemctl", [
      "--user",
      "is-enabled",
      this.unitName,
    ]);
    const show = this.runner.run("systemctl", [
      "--user",
      "show",
      this.unitName,
      "--property=MainPID",
    ]);
    const match = show.stdout.match(/MainPID=(\d+)/);
    const pid = match ? Number(match[1]) : 0;
    return {
      loaded: enabled.status === 0,
      pid: show.status === 0 && pid > 0 ? pid : null,
    };
  }

  async unit(): Promise<ServiceUnit> {
    const unitPath = this.unitPath();
    let text: string;
    try {
      text = await this.read(unitPath);
    } catch {
      return { path: unitPath, present: false, executablePath: null };
    }
    return { path: unitPath, present: true, executablePath: parseSystemdExecStart(text) };
  }

  async install(options: ServiceInstallOptions): Promise<void> {
    const unitPath = this.unitPath();
    await this.makeDirectory(path.dirname(unitPath), { recursive: true });
    await this.ensureLogDir(options.serviceLogPath);
    await this.write(unitPath, renderSystemdUnit(options));
    this.runOrThrow("systemctl", ["--user", "daemon-reload"]);
    this.runOrThrow("systemctl", [
      "--user",
      "enable",
      "--now",
      this.unitName,
    ]);
  }

  /** enable --now against the unit as it stands. The daemon-reload is here
   *  because the file may have been written by an install this process did not
   *  perform. */
  async start(): Promise<void> {
    this.runner.run("systemctl", ["--user", "daemon-reload"]);
    this.runOrThrow("systemctl", ["--user", "enable", "--now", this.unitName]);
  }

  async restart(): Promise<void> {
    this.runOrThrow("systemctl", ["--user", "restart", this.unitName]);
  }

  async stop(): Promise<{ wasRunning: boolean }> {
    const before = await this.state();
    this.runner.run("systemctl", [
      "--user",
      "disable",
      "--now",
      this.unitName,
    ]);
    const active = this.runner.run("systemctl", [
      "--user",
      "is-active",
      this.unitName,
    ]);
    if (active.status === 0) {
      throw new Error(
        `systemctl --user disable --now ${this.unitName} failed: unit still active`,
      );
    }
    return { wasRunning: before.pid !== null };
  }

  async uninstall(): Promise<void> {
    this.runner.run("systemctl", ["--user", "disable", "--now", this.unitName]);
    await this.remove(this.unitPath());
    this.runner.run("systemctl", ["--user", "daemon-reload"]);
  }

  async ensureLogDir(serviceLogPath: string): Promise<void> {
    await this.makeDirectory(path.dirname(serviceLogPath), { recursive: true });
  }

  private unitPath(): string {
    return path.join(
      this.dependencies.home,
      ".config",
      "systemd",
      "user",
      this.unitName,
    );
  }

  private runOrThrow(command: string, args: readonly string[]): void {
    const result = this.runner.run(command, args);
    if (result.status !== 0) throw commandError(command, args, result);
  }
}

export function renderSystemdUnit(options: ServiceInstallOptions): string {
  const executablePath = quoteSystemdArgument(options.executablePath);
  const serviceLogPath = escapeSystemdSpecifier(options.serviceLogPath);
  // Our own literal verbs and flags, rendered verbatim: quoting them would
  // change every already-installed unit for nothing, and only the first token
  // (the binary, whose path is not ours) ever needs escaping.
  const args = (options.args ?? ["host"]).join(" ");
  const environment = Object.entries(options.environment ?? {})
    .map(([key, value]) => `Environment=${key}=${quoteSystemdArgument(value)}\n`)
    .join("");
  const limits = options.restart
    ? `StartLimitIntervalSec=${options.restart.limitIntervalSec}\n` +
      `StartLimitBurst=${options.restart.limitBurst}\n`
    : "";
  // The restart ceiling belongs to [Unit]. `StartLimitIntervalSec` is a [Unit]
  // directive: emitted under [Service] systemd logs "Unknown key name … in
  // section 'Service', ignoring" and drops it, while `StartLimitBurst` survives
  // as a legacy alias and runs against the 10-second default interval — which
  // RestartSec=5 never fills. So the ceiling was absent exactly where it is
  // needed: on the documented rollback, the previous binary has no `ui` verb and
  // the console unit exits 1 every five seconds forever, appending usage text to
  // a log nothing rotates.
  return `[Unit]
Description=HX Fortress
After=network-online.target
${limits}
[Service]
Type=simple
ExecStart=${executablePath} ${args}
Restart=on-failure
RestartSec=5
${environment}StandardOutput=append:${serviceLogPath}
StandardError=append:${serviceLogPath}

[Install]
WantedBy=default.target
`;
}

/**
 * The binary an installed unit starts, read back from its ExecStart.
 *
 * The exact inverse of the renderer, and a round-trip test pins the pair: the
 * update path resolves its swap target from this value, so a parser that lost a
 * quoted space would install a new binary at a path nothing runs.
 */
export function parseSystemdExecStart(unitText: string): string | null {
  const line = unitText
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("ExecStart="));
  if (!line) return null;
  const value = line.slice("ExecStart=".length).trim();
  if (!value) return null;
  const first = firstSystemdToken(value);
  return first === "" ? null : first;
}

/** The first token of a systemd command line: a double-quoted run with
 *  backslash escapes, or everything up to the first space. */
function firstSystemdToken(value: string): string {
  let out = "";
  let index = 0;
  let quoted = false;
  if (value.startsWith('"')) {
    quoted = true;
    index = 1;
  }
  for (; index < value.length; index += 1) {
    const ch = value[index] as string;
    if (ch === "\\" && index + 1 < value.length) {
      out += value[index + 1] as string;
      index += 1;
      continue;
    }
    if (quoted && ch === '"') break;
    if (!quoted && ch === " ") break;
    out += ch;
  }
  return unescapeSystemdSpecifier(out);
}

function quoteSystemdArgument(value: string): string {
  const escaped = escapeSystemdSpecifier(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function escapeSystemdSpecifier(value: string): string {
  return value.replace(/%/g, "%%");
}

function unescapeSystemdSpecifier(value: string): string {
  return value.replace(/%%/g, "%");
}
