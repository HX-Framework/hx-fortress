export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[]): CommandResult;
}

export interface ServiceState {
  loaded: boolean;
  pid: number | null;
}

/** Which unit a manager drives. The daemon and the console are two units of the
 *  same shape, so the renderers, the parser and the lifecycle verbs are one
 *  implementation parameterized by this rather than two that drift. */
export interface UnitIdentity {
  /** systemd (user) unit file name. */
  unitName: string;
  /** launchd label; the plist is `<label>.plist`. */
  label: string;
}

export const DAEMON_UNIT: UnitIdentity = {
  unitName: "hx-fortress.service",
  label: "ai.let.hx-fortress",
};

export const CONSOLE_UNIT: UnitIdentity = {
  unitName: "hx-fortress-ui.service",
  label: "ai.let.hx-fortress-ui",
};

/** How a unit is allowed to come back after it dies. The daemon leaves this
 *  unset and keeps its shipped discipline; the console sets it so a binary that
 *  does not understand the console verb does not respawn at full speed against a
 *  downgrade.
 *
 *  The two managers give different guarantees and this type does not pretend
 *  otherwise: systemd has a real ceiling — the unit reaches `failed` and stays
 *  there, which an operator can see — while launchd has no start-limit concept
 *  and no failed state, so all darwin can express is a rate. Anything that reads
 *  a stop-forever guarantee out of this on darwin is reading one that is not
 *  there. */
export interface RestartDiscipline {
  /** systemd StartLimitIntervalSec / StartLimitBurst — a real ceiling. */
  limitIntervalSec: number;
  limitBurst: number;
  /** launchd ThrottleInterval — a rate limit, and the only bound darwin has. */
  throttleSeconds: number;
}

export interface ServiceInstallOptions {
  executablePath: string;
  serviceLogPath: string;
  /** Arguments after the executable. Defaults to the daemon's `host`. */
  args?: readonly string[];
  /** Environment directives baked into the unit. FORTRESS_ROOT and nothing
   *  else: a unit that carried FORTRESS_UI_* would make the console's
   *  enablement unreachable from the file that owns it. */
  environment?: Readonly<Record<string, string>>;
  restart?: RestartDiscipline;
}

/** What a unit FILE says, independent of whether the unit is loaded. `loaded` is
 *  false after any `hx-fortress stop`, so it can never answer "is this fortress
 *  installed as a service" — only the file can. */
export interface ServiceUnit {
  /** Where the file lives, present or not. */
  path: string;
  present: boolean;
  /** The binary the unit starts, read back out of the installed file. Null when
   *  no unit is present or its directive is unreadable. */
  executablePath: string | null;
}

export interface ServiceManager {
  readonly name: string;
  install(options: ServiceInstallOptions): Promise<void>;
  /** Enable and start the unit that is ALREADY installed. Never re-renders it:
   *  a rewrite here would silently retarget the unit at whichever binary
   *  happened to invoke the verb. */
  start(): Promise<void>;
  /** Restart in place, leaving the unit file byte-identical. */
  restart(): Promise<void>;
  stop(): Promise<{ wasRunning: boolean }>;
  state(): Promise<ServiceState>;
  unit(): Promise<ServiceUnit>;
  /** Remove the unit and forget it across a reboot. */
  uninstall(): Promise<void>;
  /** Recreate the directory the unit appends its output to. systemd's
   *  `append:` and launchd's StandardOutPath both fail a unit whose parent
   *  directory has gone, and start no longer rewrites the unit that used to
   *  create it as a side effect. */
  ensureLogDir(serviceLogPath: string): Promise<void>;
}
