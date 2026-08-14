// `hx-fortress ui --install-service` / `--uninstall-service`, and the console-unit
// decision every `hx-fortress start` makes.
//
// Three rules hold here and are asserted:
//
//   THE UNIT CARRIES FORTRESS_ROOT AND NOTHING ELSE. Enablement, bind, port and
//   publicUrl live in ui.json, which the console re-reads per request. A unit
//   that carried FORTRESS_UI_* would put the console's own settings somewhere
//   `ui config set` cannot reach and `ui disable` cannot flip — which is why the
//   non-loopback gesture is persisted into ui.json and the unit's ARGUMENTS
//   instead of into its environment.
//
//   THE DAEMON'S ROOT IS DERIVED, NEVER READ FROM THIS SHELL. `FORTRESS_ROOT=…
//   hx-fortress ui --install-service` describes the terminal, not the service;
//   comparing the console's root against that value would compare it with itself.
//
//   INSTALLING IS NOT ENABLING TWICE. The install flips `enabled` on, because a
//   supervised console that reads `enabled:false` exits at once and the unit
//   would go to failed. Uninstalling deliberately leaves `enabled` alone: the
//   rollback rung disarms the button with `ui sso off` first and then removes the
//   unit, and clearing the setting here would silently change what a later
//   re-install means.

import { existsSync } from "node:fs";
import os from "node:os";

import { fortressPaths } from "./host/paths";
import { printedUrl } from "./ui/bind";
import { effectiveUiEnabled, UiConfigStore } from "./ui/config";
import { PEOPLE_VISIBILITY_DISCLOSURE } from "./ui/copy";
import {
  deriveDaemonRoot,
  getUiServiceControl,
  lingerWarning,
  readDaemonUnitEnvironment,
  rootDivergenceRefusal,
  type UiServiceControl,
} from "./ui/service-control";
import type { UiUnitDecision } from "./cli-lifecycle";

export interface UiServiceDeps {
  writeLine: (line: string) => void;
  env?: Record<string, string | undefined>;
  fortressRoot?: string;
  platform?: string;
  hostName?: string;
  /** The binary the unit will start. */
  executablePath?: string;
  service?: UiServiceControl;
  /** The daemon unit's Environment, as the init system reports it. Null when no
   *  daemon unit is installed. */
  daemonUnitEnvironment?: string | null;
  /** Home of the user the units run as, for the default-root derivation. */
  home?: string;
  linger?: () => string | null;
}

function makeService(deps: UiServiceDeps): UiServiceControl {
  return (
    deps.service ??
    getUiServiceControl({
      ...(deps.platform ? { platform: deps.platform } : {}),
      ...(deps.home ? { home: deps.home } : {}),
    })
  );
}

/** The console URL as this host would print it. */
async function consoleUrl(deps: UiServiceDeps): Promise<string> {
  const paths = fortressPaths(deps.fortressRoot);
  const config = await new UiConfigStore(paths.uiConfig).load();
  return printedUrl({
    urlOverride: null,
    publicUrl: config.publicUrl,
    hostname: config.bind,
    dualStack: false,
    port: config.port,
    hostName: deps.hostName ?? os.hostname(),
  }).base;
}

export async function installUiService(
  args: readonly string[],
  deps: UiServiceDeps,
): Promise<number> {
  const allowInsecureBind = args.includes("--allow-insecure-bind");
  const paths = fortressPaths(deps.fortressRoot);
  const store = new UiConfigStore(paths.uiConfig);

  const daemon = deriveDaemonRoot({
    ...(deps.platform ? { platform: deps.platform } : {}),
    ...(deps.home ? { home: deps.home } : {}),
    unitEnvironment:
      deps.daemonUnitEnvironment !== undefined
        ? deps.daemonUnitEnvironment
        : readDaemonUnitEnvironment({
            ...(deps.platform ? { platform: deps.platform } : {}),
            ...(deps.home ? { home: deps.home } : {}),
          }),
  });
  if (daemon.root !== paths.root) {
    throw new Error(rootDivergenceRefusal(paths.root, daemon));
  }

  const config = await store.update((current) => ({
    ...current,
    enabled: true,
    allowInsecureBind: allowInsecureBind || current.allowInsecureBind,
  }));

  const service = makeService(deps);
  await service.install({
    executablePath: deps.executablePath ?? process.execPath,
    serviceLogPath: paths.serviceLog,
    fortressRoot: paths.root,
    allowInsecureBind: config.allowInsecureBind,
  });

  deps.writeLine(`Console service installed (${service.name}).`);
  deps.writeLine(`  fortress root: ${paths.root}`);
  if (config.allowInsecureBind) {
    deps.writeLine(
      "  non-loopback bind allowed: anyone who can reach this address reaches the sign-in page.",
    );
  }
  const linger = (deps.linger ?? ((): string | null =>
    lingerWarning({ ...(deps.platform ? { platform: deps.platform } : {}) })))();
  if (linger) deps.writeLine(`  warning: ${linger}`);
  for (const line of PEOPLE_VISIBILITY_DISCLOSURE) deps.writeLine(line);
  deps.writeLine(`  open ${await consoleUrl(deps)}`);
  return 0;
}

export async function uninstallUiService(deps: UiServiceDeps): Promise<number> {
  const service = makeService(deps);
  await service.uninstall();
  deps.writeLine(`Console service removed (${service.name}).`);
  // `enabled` is untouched on purpose: it is what a later `--install-service`
  // re-reads, and the rollback rung has already disarmed the workbench button
  // with `ui sso off` before reaching this step.
  deps.writeLine("The stored console settings are unchanged; nothing is serving now.");
  return 0;
}

/**
 * What the console unit needs at `hx-fortress start`, and whether this caller may
 * do it. Runs on EVERY start — including one against an already-running daemon,
 * which is the case where the console would otherwise never come up.
 */
export async function ensureUiUnit(
  mayInstall: boolean,
  deps: UiServiceDeps,
): Promise<UiUnitDecision> {
  const paths = fortressPaths(deps.fortressRoot);
  const env = deps.env ?? process.env;
  if (!existsSync(paths.uiConfig)) return { kind: "not-configured" };
  const store = new UiConfigStore(paths.uiConfig);
  let enabled: boolean;
  let allowInsecureBind: boolean;
  try {
    const config = await store.load();
    enabled = effectiveUiEnabled(config, env);
    allowInsecureBind = config.allowInsecureBind;
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  if (!enabled) return { kind: "not-enabled" };

  const service = makeService(deps);
  try {
    if (await service.installed()) {
      await service.start();
      return { kind: "present" };
    }
    if (!mayInstall) return { kind: "deferred" };
    // The SAME refusal `installUiService` makes, because this installs the same
    // unit. Skipping it here meant `FORTRESS_ROOT=/custom hx-fortress start`
    // wrote a daemon unit with no Environment= alongside a console unit pinned
    // to /custom — two processes reading different databases and different
    // account stores, which is the divergence this file's header says is
    // asserted.
    const daemon = deriveDaemonRoot({
      ...(deps.platform ? { platform: deps.platform } : {}),
      ...(deps.home ? { home: deps.home } : {}),
      unitEnvironment:
        deps.daemonUnitEnvironment !== undefined
          ? deps.daemonUnitEnvironment
          : readDaemonUnitEnvironment({
              ...(deps.platform ? { platform: deps.platform } : {}),
              ...(deps.home ? { home: deps.home } : {}),
            }),
    });
    if (daemon.root !== paths.root) {
      return { kind: "failed", reason: rootDivergenceRefusal(paths.root, daemon) };
    }
    await service.install({
      executablePath: deps.executablePath ?? process.execPath,
      serviceLogPath: paths.serviceLog,
      fortressRoot: paths.root,
      allowInsecureBind,
    });
    return { kind: "installed", url: await consoleUrl(deps) };
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}
