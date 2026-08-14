import type { ConnectionState, ModuleRuntimeStatus } from "./host/types";
import type { StatusReader } from "./status-reader";
import type { ServiceManager } from "./service/types";

/** What the lifecycle verbs actually touch. Narrower than ServiceManager so the
 *  terminal renderer can drive them with the same object it reads state from. */
export type LifecycleManager = Pick<
  ServiceManager,
  "name" | "state" | "unit" | "install" | "start" | "stop" | "ensureLogDir"
>;

type WriteLine = (line: string) => void;

interface FortressPathsView {
  log: string;
  serviceLog: string;
}

/** An installed unit that starts a DIFFERENT binary from the one running this
 *  verb. Enabling it would report a clean start while the service came back on
 *  the previously-installed binary at the old path. */
export interface ExecStartDivergence {
  unitPath: string;
  unitExecutable: string;
  invoking: string;
}

/** What the console unit needed, and what was done about it. */
export type UiUnitDecision =
  | { kind: "not-configured" }
  | { kind: "not-enabled" }
  | { kind: "present" }
  | { kind: "installed"; url: string | null }
  | { kind: "deferred" }
  | { kind: "failed"; reason: string };

export interface StartResult {
  divergence: ExecStartDivergence | null;
  /** True when nothing was started, because of the divergence above. */
  refused: boolean;
  uiUnit: UiUnitDecision;
}

interface StartDependencies {
  manager: LifecycleManager;
  executablePath: string;
  paths: FortressPathsView;
  writeLine: WriteLine;
  /** Runs on EVERY start, before the already-running early return, so the
   *  console can be activated against a daemon that is already up. The argument
   *  is whether this caller may install without a further gesture: a terminal
   *  owns stdin and does; a renderer whose writeLine goes nowhere does not. */
  ensureUiUnit?: (mayInstall: boolean) => Promise<UiUnitDecision>;
  mayInstallUiUnit?: boolean;
  /** Re-render the unit at the invoking binary. The explicit remedy for a
   *  divergence, never the default: a start that rewrote the unit would
   *  silently retarget the service at whatever invoked it. */
  reinstall?: boolean;
}

/** The same refusal for `update`, where the consequence is worse: swapping one
 *  binary and restarting another prints a success and a new version while the
 *  service keeps running the old code. */
export function updateDivergenceRefusal(divergence: ExecStartDivergence): string {
  return (
    `refusing to update: ${divergence.unitPath} starts ${divergence.unitExecutable}, ` +
    `not ${divergence.invoking}. Swapping this binary and restarting that unit would report a ` +
    `new version over the old code. Run the binary the unit names, or reinstall the unit with ` +
    `\`hx-fortress start --reinstall\`.`
  );
}

export function divergenceRefusal(divergence: ExecStartDivergence): string {
  return (
    `refusing to start: ${divergence.unitPath} starts ${divergence.unitExecutable}, ` +
    `not ${divergence.invoking}. Starting it would report success while the service ran the ` +
    `previously-installed binary. Run \`hx-fortress start --reinstall\` to point the unit at ` +
    `this binary, or run the one the unit names.`
  );
}

interface StopDependencies {
  manager: Pick<ServiceManager, "name" | "stop">;
  writeLine: WriteLine;
}

interface StatusDependencies {
  manager: Pick<ServiceManager, "name" | "state">;
  statusReader: StatusReader;
  writeLine: WriteLine;
}

/**
 * Start the fortress, and report what it found rather than printing it.
 *
 * The divergence verdict and the console-unit decision are RETURNED. The TUI
 * calls this with a writeLine that goes nowhere, so anything printed here would
 * vanish and the renderer would report a clean start over a service running the
 * old binary — and a prompt would land on the stdin the terminal renderer owns.
 */
export async function startFortress(
  dependencies: StartDependencies,
): Promise<StartResult> {
  const unit = await dependencies.manager.unit();
  const uiUnit = dependencies.ensureUiUnit
    ? await dependencies.ensureUiUnit(dependencies.mayInstallUiUnit === true)
    : ({ kind: "not-configured" } as const);

  const divergence: ExecStartDivergence | null =
    unit.present &&
    unit.executablePath !== null &&
    unit.executablePath !== dependencies.executablePath
      ? {
          unitPath: unit.path,
          unitExecutable: unit.executablePath,
          invoking: dependencies.executablePath,
        }
      : null;
  if (divergence && dependencies.reinstall !== true) {
    return { divergence, refused: true, uiUnit };
  }

  const before = await dependencies.manager.state();
  if (before.pid !== null) {
    dependencies.writeLine(
      `Fortress is running (${dependencies.manager.name}, pid ${before.pid}).`,
    );
    dependencies.writeLine(`logs: ${dependencies.paths.log}`);
    return { divergence, refused: false, uiUnit };
  }

  if (unit.present && dependencies.reinstall !== true) {
    // The two self-heals install() used to provide as a side effect of writing
    // the unit, kept on the path that deliberately does not write it: the
    // append target's directory has to exist, and the swap target is resolved
    // from the unit rather than from whoever invoked this.
    await dependencies.manager.ensureLogDir(dependencies.paths.serviceLog);
    await dependencies.manager.start();
  } else {
    await dependencies.manager.install({
      executablePath: dependencies.executablePath,
      serviceLogPath: dependencies.paths.serviceLog,
    });
  }

  const after = await dependencies.manager.state();
  if (after.pid !== null) {
    dependencies.writeLine(
      `Fortress started (${dependencies.manager.name}, pid ${after.pid}).`,
    );
  } else {
    dependencies.writeLine(
      `Fortress loaded (${dependencies.manager.name}). It will start automatically.`,
    );
  }
  dependencies.writeLine(`logs: ${dependencies.paths.log}`);
  dependencies.writeLine("status: hx-fortress status");
  return { divergence, refused: false, uiUnit };
}

export async function stopFortress(
  dependencies: StopDependencies,
): Promise<void> {
  const result = await dependencies.manager.stop();
  if (result.wasRunning) {
    dependencies.writeLine(
      `Fortress stopped (${dependencies.manager.name}). Run \`hx-fortress start\` to resume.`,
    );
    return;
  }
  dependencies.writeLine(
    "Fortress is not running - nothing to stop. Run `hx-fortress start` to start it.",
  );
}

export async function statusFortress(
  dependencies: StatusDependencies,
): Promise<void> {
  const serviceState = await dependencies.manager.state();
  if (serviceState.pid === null) {
    if (serviceState.loaded) {
      dependencies.writeLine(
        `Fortress:   loaded, not running (${dependencies.manager.name})`,
      );
    } else {
      dependencies.writeLine(
        "Fortress:   stopped - run `hx-fortress start` to resume",
      );
    }
    dependencies.writeLine("Connection: offline");
    dependencies.writeLine("Modules:    unavailable");
    return;
  }

  dependencies.writeLine(
    `Fortress:   running (${dependencies.manager.name}, pid ${serviceState.pid})`,
  );

  const snapshot = await dependencies.statusReader.read();
  if (!snapshot || snapshot.host.pid !== serviceState.pid) {
    dependencies.writeLine("Connection: starting");
    dependencies.writeLine("Modules:    unavailable");
    return;
  }

  dependencies.writeLine(
    `Connection: ${connectionLabel(snapshot.connection)}`,
  );
  if (snapshot.connection.reason === "invalid_credential" && snapshot.connection.message) {
    dependencies.writeLine(`Detail:     ${snapshot.connection.message}`);
  }
  writeModules(snapshot.modules, dependencies.writeLine);
}

function connectionLabel(connection: {
  state: ConnectionState;
  reason: string | null;
}): string {
  if (connection.reason === "invalid_credential") {
    return "invalid credential";
  }

  switch (connection.state) {
    case "connected":
      return "connected";
    case "connecting":
      return "enrolling";
    case "offline":
    case "closing":
      return "offline";
  }
}

function writeModules(
  modules: readonly ModuleRuntimeStatus[],
  writeLine: WriteLine,
): void {
  if (modules.length === 0) {
    writeLine("Modules:    none");
    return;
  }

  const sorted = [...modules].sort((left, right) => left.id.localeCompare(right.id));
  const width = Math.max(...sorted.map((module) => module.id.length));
  writeLine("Modules:");
  for (const module of sorted) {
    writeLine(`  ${module.id.padEnd(width)}  ${module.state}`);
  }
}

/** What a start FOUND, rendered from the returned value so the terminal and the
 *  full-screen renderer say the same thing. */
export function uiUnitLines(decision: UiUnitDecision): string[] {
  switch (decision.kind) {
    case "installed":
      return decision.url
        ? ["Console service installed and started.", `  open ${decision.url}`]
        : ["Console service installed and started."];
    case "deferred":
      return [
        "The console is enabled here but has no service unit.",
        "  Install it with `hx-fortress ui --install-service`.",
      ];
    case "failed":
      return [`The console service did not start: ${decision.reason}`];
    case "present":
    case "not-enabled":
    case "not-configured":
      return [];
  }
}
