import {
  divergenceRefusal,
  startFortress,
  statusFortress,
  stopFortress,
  uiUnitLines,
  updateDivergenceRefusal,
  updateRootRefusal,
} from "./cli-lifecycle";
import { CliAudit } from "./cli-audit";
import { runAuditVerb } from "./cli-audit-verbs";
import { runRosterVerb } from "./cli-roster";
import { runControlPlaneVerb } from "./cli-control-plane";
import { runModulesVerb, runReleasesVerb } from "./cli-modules";
import { runHostsVerb } from "./cli-hosts";
import { runInstallCommand } from "./cli-install";
import { runSetupCommand } from "./cli-setup";
import { isSetUp, NOT_SET_UP } from "./setup/state";
import { AUDIT_ACTIONS } from "./console/audit-actions";
import { ensureUiUnit } from "./cli-ui-service";
import {
  getUiServiceControl,
  restartUiUnitDetached,
  type UiServiceControl,
} from "./ui/service-control";
import { LiveUiConfig, effectiveUiEnabled } from "./ui/config";
import { setFortressCredential } from "./cli-credentials";
import { runDevCommand, type DevCommandDeps } from "./cli-dev";
import { runUiCommand, type UiCommandDeps } from "./cli-ui";
import { renderHelp } from "./ui/help";
import {
  createProductionLogsDeps,
  logsCommand,
  parseLogsArgs,
  type LogsOptions,
} from "./cli-logs";
import { runFortressHost } from "./host/main";
import { runContainerCommand } from "./container-run";
import { fortressPaths } from "./host/paths";
import {
  runEnrollWizard,
  type WizardEntryOpts,
} from "./modules/session-vault/wizard";
import { ProgressBar } from "./progress";
import { FileStatusReader } from "./status-reader";
import { getServiceManager } from "./service";
import { runFortressTui } from "./tui";
import {
  runFortressUpdate,
  type UpdateProgress,
  type UpdateResult,
} from "./update";
import { describeUpdateSource, effectiveUpdateSource } from "./update-source";
import { FORTRESS_VERSION } from "./version";
import { liveDaemonPid } from "./host/modules-api";
import { deriveDaemonRoot, readDaemonUnitEnvironment } from "./ui/service-control";

type RunLogs = (options: Omit<LogsOptions, "follow" | "signal">) => Promise<void>;
type RunUi = (args: readonly string[], deps: UiCommandDeps) => Promise<number>;
type RunDev = (args: readonly string[], deps: DevCommandDeps) => Promise<number>;
type RunEnrollWizard = (options: WizardEntryOpts) => Promise<void>;
type RunTui = () => Promise<number>;
type RunUpdate = (opts: { downloadBaseUrl: string; binPath?: string; log?: (msg: string) => void; onProgress?: (ev: UpdateProgress) => void }) => Promise<UpdateResult>;

interface CliDependencies {
  getServiceManager?: typeof getServiceManager;
  getUiServiceControl?: () => UiServiceControl;
  restartUiUnit?: (options: { platform?: string; uid?: number }) => void;
  ensureUiUnit?: typeof ensureUiUnit;
  runAuditVerb?: typeof runAuditVerb;
  runContainer?: typeof runContainerCommand;
  runRosterVerb?: typeof runRosterVerb;
  runModulesVerb?: typeof runModulesVerb;
  runReleasesVerb?: typeof runReleasesVerb;
  runControlPlaneVerb?: typeof runControlPlaneVerb;
  runHostsVerb?: typeof runHostsVerb;
  runSetup?: typeof runSetupCommand;
  runInstall?: typeof runInstallCommand;
  runEnrollWizard?: RunEnrollWizard;
  runFortressHost?: typeof runFortressHost;
  /** Be a Store's own process. A test gives its own. */
  runStoreEngine?: (options: { writeLine: (line: string) => void }) => Promise<number>;
  runLogs?: RunLogs;
  runTui?: RunTui;
  runUi?: RunUi;
  runDev?: RunDev;
  runUpdate?: RunUpdate;
  writeLine?: (line: string) => void;
  /** Override HX Fortress root directory — used in tests to supply a temp config. */
  fortressRoot?: string;
  /** The environment the verbs read their settings from. Defaults to this
   *  process's own. */
  env?: Record<string, string | undefined>;
  /** The process id of the daemon that runs now, or null. Defaults to what
   *  the status file of this folder says. */
  daemonPid?: () => Promise<number | null>;
  /** The environment of the daemon's service unit, as the host states it, or
   *  null when the unit names none. Defaults to asking the host. */
  daemonUnitEnvironment?: string | null;
}

export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const writeLine = dependencies.writeLine ?? ((line: string) => process.stdout.write(`${line}\n`));
  const command = args[0];

  /** Install the service if it is not there, and start it. Shared by `start`
   *  and by the setup, which offers to start HX Fortress when it ends. */
  const startService = async (reinstall: boolean): Promise<void> => {
    const paths = fortressPaths(dependencies.fortressRoot);
    const result = await startFortress({
      manager: (dependencies.getServiceManager ?? getServiceManager)(),
      executablePath: process.execPath,
      paths,
      writeLine,
      // The terminal owns stdin and is the caller the console unit is meant
      // to be installed from.
      mayInstallUiUnit: true,
      ensureUiUnit: (mayInstall) =>
        (dependencies.ensureUiUnit ?? ensureUiUnit)(mayInstall, {
          writeLine,
          ...(dependencies.fortressRoot ? { fortressRoot: dependencies.fortressRoot } : {}),
        }),
      reinstall,
    });
    if (result.refused && result.divergence) {
      throw new Error(divergenceRefusal(result.divergence));
    }
    for (const line of uiUnitLines(result.uiUnit)) writeLine(line);
  };

  try {
    switch (command) {
      case undefined:
        return await (dependencies.runTui ?? runFortressTui)();
      case "enroll": {
        const cloudIdx = args.indexOf("--cloud");
        const cloudUrl = cloudIdx >= 0 ? args[cloudIdx + 1] : undefined;
        const maybeToken = args[1];
        const token = maybeToken && !maybeToken.startsWith("--") ? maybeToken : undefined;
        if (!cloudUrl) {
          throw new Error("usage: hx-fortress enroll [token] --cloud <address>");
        }
        await (dependencies.runEnrollWizard ?? runEnrollWizard)({
          token,
          cloudUrl,
          log: writeLine,
        });
        return 0;
      }
      case "credentials": {
        if (args[1] !== "set" || !args[2] || args[3]) {
          throw new Error("usage: hx-fortress credentials set <key>");
        }
        await setFortressCredential(args[2], { root: dependencies.fortressRoot });
        writeLine("HX Fortress credential updated.");
        writeLine("Restart HX Fortress or reconnect it to use the new credential.");
        return 0;
      }
      // Make HX Fortress somewhere else, from this computer: a cloud account
      // or a machine with Docker. It asks the setup's own list.
      case "install":
        return await (dependencies.runInstall ?? runInstallCommand)(args.slice(1), { writeLine });
      // The setup's questions on the machine itself: in this terminal, in a
      // browser once, or from a file. HX Fortress starts with no control
      // plane; a control plane is named with the command, or not at all.
      case "setup":
        return await (dependencies.runSetup ?? runSetupCommand)(args.slice(1), {
          writeLine,
          ...(dependencies.fortressRoot ? { fortressRoot: dependencies.fortressRoot } : {}),
          start: () => startService(false),
        });
      case "start": {
        // An HX Fortress nobody has set up has nothing to start with. Said here,
        // before a service is installed that would only fail and restart.
        if (!(await isSetUp(fortressPaths(dependencies.fortressRoot)))) {
          throw new Error(NOT_SET_UP);
        }
        await startService(args.includes("--reinstall"));
        return 0;
      }
      case "stop":
        await stopFortress({
          manager: (dependencies.getServiceManager ?? getServiceManager)(),
          writeLine,
        });
        return 0;
      case "status": {
        const paths = fortressPaths();
        await statusFortress({
          manager: (dependencies.getServiceManager ?? getServiceManager)(),
          statusReader: new FileStatusReader(paths.status),
          writeLine,
        });
        return 0;
      }
      case "host":
        await (dependencies.runFortressHost ?? runFortressHost)();
        return 0;
      // The container entrypoint: one image, two long-running processes. It
      // refuses anywhere it is not pid 1, so typing it on a host is a diagnostic
      // rather than a second, weaker supervisor.
      case "container-run":
        return await (dependencies.runContainer ?? runContainerCommand)({
          writeLine,
          ...(dependencies.fortressRoot ? { fortressRoot: dependencies.fortressRoot } : {}),
        });
      // A Store's own process. HX Fortress starts it for the Stores module,
      // and nothing else does. It is loaded only here: the Store's engine is a
      // large program, and no other command needs it.
      // Absent from `help` on purpose: nobody types it. Run by hand it has no
      // parent to talk to, says so and ends.
      case "store-engine": {
        const run =
          dependencies.runStoreEngine ??
          (await import("./modules/stores/engine-main")).runStoreEngine;
        return await run({ writeLine });
      }
      case "logs": {
        const paths = fortressPaths();
        const { moduleFilter, linesBack, follow } = parseLogsArgs(args.slice(1));
        const runLogs =
          dependencies.runLogs ??
          ((opts: Omit<LogsOptions, "follow" | "signal">) => {
            const ac = new AbortController();
            const onSig = () => ac.abort();
            process.once("SIGINT", onSig);
            return logsCommand(
              { ...opts, follow, signal: ac.signal },
              createProductionLogsDeps(),
            ).finally(() => process.removeListener("SIGINT", onSig));
          });
        await runLogs({ logPath: paths.log, moduleFilter, linesBack, writeLine });
        return 0;
      }
      case "update": {
        const paths = fortressPaths(dependencies.fortressRoot);
        const manager = (dependencies.getServiceManager ?? getServiceManager)();
        // UNIT-FILE existence, never loaded-ness: `hx-fortress stop` unloads the
        // unit, and the runbook has that rung, so a loaded-ness test would send
        // an installed HX Fortress down the no-unit branch — swapping this
        // process's binary and leaving the unit to start the untouched old one.
        const unit = await manager.unit();
        // The program that is replaced is the one the service runs, so the
        // settings that say where a new version comes from have to be the
        // service's too. A terminal with another folder has another
        // config.json, or none, and what it works out could be the default
        // that this host's own settings turned away from.
        if (unit.present) {
          const daemon = deriveDaemonRoot({
            unitEnvironment:
              dependencies.daemonUnitEnvironment !== undefined
                ? dependencies.daemonUnitEnvironment
                : readDaemonUnitEnvironment({}),
          });
          if (daemon.root !== paths.root) {
            throw new Error(updateRootRefusal({ unitPath: unit.path, shellRoot: paths.root, daemon }));
          }
        }
        // The project's releases, or the address this host names. Never a
        // control plane's address, so an HX Fortress with no control plane updates
        // in the same way. A setting that cannot be understood stops here, by
        // name: it is not read as "the default". An address named only in the
        // environment the running daemon has counts here too.
        const source = await effectiveUpdateSource(
          paths,
          dependencies.env ?? process.env,
          await (dependencies.daemonPid ?? ((): Promise<number | null> => liveDaemonPid(paths)))().catch(() => null),
        );
        const downloadBaseUrl = source.base;

        if (
          unit.present &&
          unit.executablePath !== null &&
          unit.executablePath !== process.execPath
        ) {
          throw new Error(
            updateDivergenceRefusal({
              unitPath: unit.path,
              unitExecutable: unit.executablePath,
              invoking: process.execPath,
            }),
          );
        }
        // With no unit there is nothing to resolve a target from and nothing to
        // restart: this binary is the whole install.
        const binPath = unit.executablePath ?? process.execPath;

        // Said before anything is asked of it, so a person sees where the new
        // version comes from, and who named that place.
        writeLine(`Update source: ${describeUpdateSource(source)}`);

        const bar = new ProgressBar();
        const LABEL: Record<UpdateProgress["phase"], string> = {
          download: "Downloading",
          unpack: "Unpacking",
          verify: "Verifying",
        };
        const CRUMB: Record<UpdateProgress["phase"], string> = {
          download: "Downloading hx-fortress…",
          unpack: "Unpacking…",
          verify: "Verifying…",
        };
        const seen = new Set<UpdateProgress["phase"]>();
        let pulseFrame = 0;
        let barClosed = false;
        const onProgress = (ev: UpdateProgress): void => {
          if (seen.size === 0) bar.hideCursor();
          if (!seen.has(ev.phase)) {
            seen.add(ev.phase);
            bar.status(CRUMB[ev.phase]);
          }
          if (ev.phase === "download" && (!ev.total || ev.total <= 0)) {
            bar.pulse(LABEL[ev.phase], pulseFrame++);
          } else {
            bar.draw(ev.pct, LABEL[ev.phase]);
          }
          if (ev.phase === "verify" && ev.pct >= 100) {
            bar.end();
            bar.showCursor();
            barClosed = true;
          }
        };

        const doUpdate = dependencies.runUpdate ?? runFortressUpdate;
        const audit = new CliAudit({
          dir: paths.auditSpool,
          onWarn: (message) => writeLine(`warning: the audit record was incomplete - ${message}`),
        });
        const result = await audit.run(AUDIT_ACTIONS.cliUpdate, { binPath, source: source.base }, async () => {
          let updated: UpdateResult;
          try {
            updated = await doUpdate({ downloadBaseUrl, binPath, log: writeLine, onProgress });
          } catch (err) {
            if (seen.size > 0 && !barClosed) bar.clearLine();
            throw err;
          } finally {
            bar.showCursor();
          }

          if (updated.alreadyLatest) return updated;

          const shaNote = updated.sha256 ? `, sha256 ${updated.sha256.slice(0, 12)}…` : "";
          writeLine(`hx-fortress updated to latest (${updated.asset}${shaNote}).`);

          // Restart the service if it was running so the new binary takes over.
          // A restart failure is fatal: the binary is new but modules are still
          // on the old code. Report the state and a concrete next step. The unit
          // is RESTARTED, never re-rendered — a rewrite would drop whatever
          // Environment= or EnvironmentFile= the host added to it.
          const before = await manager.state();
          if (unit.present && before.pid !== null) {
            writeLine(`restarting HX Fortress (${manager.name}, was pid ${before.pid})`);
            try {
              await manager.restart();
            } catch (err) {
              const after = await manager.state().catch(() => ({ loaded: false, pid: null }));
              const next =
                after.pid !== null
                  ? `the previous version is still running (pid ${after.pid}); run \`hx-fortress stop && hx-fortress start\` to load the new binary.`
                  : `Fortress is not running; run \`hx-fortress start\` to launch the new binary.`;
              throw new Error(
                `binary installed at ${updated.installedPath}, but HX Fortress failed to restart: ` +
                  `${(err as Error).message}\n${next}`,
                { cause: err },
              );
            }
            writeLine(`Fortress restarted (${manager.name}).`);
          }
          return updated;
        });

        if (result.alreadyLatest) {
          writeLine(
            `hx-fortress is already on the latest version (v${result.localVersion}). Nothing to do. 🎉`,
          );
          return 0;
        }

        // AFTER the outcome record: this restart can kill a console mid-write,
        // and a swap with no record of its result is the one state nobody can
        // reconstruct.
        const uiService = (dependencies.getUiServiceControl ?? getUiServiceControl)();
        // Installed AND still enabled. `installed()` reports the unit FILE, and
        // `ui disable` stops the unit without removing it, so restarting on
        // `installed()` alone put a console the operator had switched off back
        // on the network — from an update they may have run in that console.
        const uiCfg = await new LiveUiConfig(paths.uiConfig).read().catch(() => null);
        if ((await uiService.installed()) && uiCfg && effectiveUiEnabled(uiCfg, process.env)) {
          (dependencies.restartUiUnit ?? restartUiUnitDetached)({});
          writeLine("Console service restarting onto the new binary.");
        }

        writeLine(`hx-fortress version: ${result.remoteVersion ?? result.localVersion}`);
        return 0;
      }
      case "audit":
        return await (dependencies.runAuditVerb ?? runAuditVerb)(args.slice(1), {
          writeLine,
          ...(dependencies.fortressRoot ? { fortressRoot: dependencies.fortressRoot } : {}),
        });
      case "roster":
        return await (dependencies.runRosterVerb ?? runRosterVerb)(args.slice(1), {
          writeLine,
          ...(dependencies.fortressRoot ? { fortressRoot: dependencies.fortressRoot } : {}),
        });
      // The local gestures: which modules are on, and which releases a person
      // here has approved. Nothing the control plane sends reaches either verb.
      case "modules":
        return await (dependencies.runModulesVerb ?? runModulesVerb)(args.slice(1), {
          writeLine,
          ...(dependencies.fortressRoot ? { fortressRoot: dependencies.fortressRoot } : {}),
        });
      case "releases":
        return await (dependencies.runReleasesVerb ?? runReleasesVerb)(args.slice(1), {
          writeLine,
          ...(dependencies.fortressRoot ? { fortressRoot: dependencies.fortressRoot } : {}),
        });
      // The addresses HX Fortress calls, from the one list of hosts. It reads
      // files only, so it runs with no daemon.
      case "hosts":
        return await (dependencies.runHostsVerb ?? runHostsVerb)(args.slice(1), {
          writeLine,
          ...(dependencies.fortressRoot ? { fortressRoot: dependencies.fortressRoot } : {}),
        });
      // Which key of its control plane this HX Fortress trusts. Also a local
      // gesture: nothing a control plane sends reaches this verb.
      case "control-plane":
        return await (dependencies.runControlPlaneVerb ?? runControlPlaneVerb)(args.slice(1), {
          writeLine,
          ...(dependencies.fortressRoot ? { fortressRoot: dependencies.fortressRoot } : {}),
          ...(dependencies.env ? { env: dependencies.env } : {}),
          ...(dependencies.daemonPid ? { daemonPid: dependencies.daemonPid } : {}),
        });
      case "ui":
        return await (dependencies.runUi ?? runUiCommand)(args.slice(1), {
          writeLine,
          fortressRoot: dependencies.fortressRoot,
        });
      // Absent from `help` on purpose: it is gated on a development build and on
      // an unenrolled HX Fortress, and a shipped binary should not advertise a verb
      // group it refuses to run.
      case "dev":
        return await (dependencies.runDev ?? runDevCommand)(args.slice(1), {
          writeLine,
          fortressRoot: dependencies.fortressRoot,
        });
      // The version and nothing else, on one line. The install script asks
      // the program that is already on a computer for it, so that it never
      // puts an older program over a newer one.
      case "version":
      case "--version":
        writeLine(FORTRESS_VERSION);
        return 0;
      case "help":
      case "--help":
        printHelp(writeLine);
        return 0;
      default:
        printHelp(writeLine);
        return 1;
    }
  } catch (error) {
    writeLine(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** One registry, rendered here and in the console's Command Line panel — the two
 *  drifted when they were separate lists. */
function printHelp(writeLine: (line: string) => void): void {
  for (const line of renderHelp()) writeLine(line);
}

if (import.meta.main) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
