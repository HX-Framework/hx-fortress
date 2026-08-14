// `hx-fortress ui` — serve the administration console, and dispatch its verbs.
//
// Serving prints exactly four things: what it is serving (the asset manifest, so
// a running console can be matched against a release), what anyone who signs in
// will be able to see, where it is listening, and how to reach it. It never
// prints a credential, and the surface it serves discloses nothing before
// sign-in.
//
// Before it binds, it takes a ROOT-SCOPED instance lock. Two consoles on one
// fortress root would each own the user store and each hold sessions the other
// cannot revoke, so the second refuses regardless of which port it was given. A
// busy PORT is a different failure with a different remedy, and it is diagnosed
// separately by asking the occupant to identify itself.

import os from "node:os";
import path from "node:path";

import { adoptDaemonHome } from "./host/daemon-home";
import { fortressPaths } from "./host/paths";
import { isUiSubcommand, runUiVerb } from "./cli-ui-verbs";
import { installUiService, uninstallUiService } from "./cli-ui-service";
import { loadUiAssets, type UiAssets } from "./ui/assets";
import {
  bracketed,
  DEFAULT_UI_PORT,
  LOOPBACK_BIND,
  DUAL_STACK_FALLBACK_BIND,
  printedUrl,
  resolveUiBind,
} from "./ui/bind";
import { LiveUiConfig, UiConfigColdStartError } from "./ui/config";
import { createConsoleMount } from "./ui/console-mount";
import { detectContainer } from "./ui/container";
import { PEOPLE_VISIBILITY_DISCLOSURE } from "./ui/copy";
import { acquireInstanceLock, portCollisionMessage, probeOccupant } from "./ui/instance";
import { UiRuntime } from "./ui/runtime";
import { startUiServer, type UiServerCtx } from "./ui/server";
import { getServiceManager } from "./service";
import { FileCredentialStore } from "./cloud/credentials";
import { FileSigningKeyStore } from "./gateway/signing-key-store";
import { clearClockSkew, writeClockSkew } from "./ui/clock-skew";
import {
  applyBootstrapUser,
  bootstrapLinkPath,
  bootstrapRequestPath,
  consumeBootstrapRequest,
} from "./ui/bootstrap-user";

type WriteLine = (line: string) => void;

function uiServiceDeps(deps: UiCommandDeps): {
  writeLine: WriteLine;
  env?: Record<string, string | undefined>;
  fortressRoot?: string;
  platform?: string;
  hostName?: string;
} {
  return {
    writeLine: deps.writeLine,
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.fortressRoot ? { fortressRoot: deps.fortressRoot } : {}),
    ...(deps.platform ? { platform: deps.platform } : {}),
    ...(deps.hostName ? { hostName: deps.hostName } : {}),
  };
}

export interface UiCommandDeps {
  writeLine: WriteLine;
  env?: Record<string, string | undefined>;
  platform?: string;
  /** os.hostname(), quoted into the SSH one-liner. */
  hostName?: string;
  /** Overrides the fortress root — the console's state lives under <root>/ui. */
  fortressRoot?: string;
  loadAssets?: () => Promise<UiAssets | null>;
  /** Injected in tests; reports the port actually bound. */
  serve?: (
    ctx: UiServerCtx,
    hostname: string,
    fallbackHostname?: string,
  ) => { readonly port?: number | null };
  /** Injected in tests. The console's exit really is an exit: a stop that only
   *  released things would leave the surface serving. */
  exit?: (code: number) => void;
}

/**
 * Stop serving, then let go of everything the console was holding.
 *
 * ORDER MATTERS. The server closes FIRST, so no request can append a record
 * after the failure window has been flushed; the timers stop next so nothing
 * re-opens one; the flush is what a clean stop exists to save; the instance lock
 * is released last, because a lock let go before the port is closed invites the
 * respawn to fail its bind instead.
 *
 * It ENDS THE PROCESS. Everything above is release, and release is not exit —
 * the defect this replaces flushed the spool and then served on.
 */
export async function stopConsole(
  signal: string,
  deps: {
    write: (line: string) => void;
    stopServer: () => void;
    stopSweep: () => void;
    stopDrain: () => void;
    flush: () => Promise<unknown>;
    releaseLock: () => Promise<void>;
    exit: (code: number) => void;
  },
): Promise<void> {
  deps.write(`stopping on ${signal}`);
  try {
    deps.stopServer();
    deps.stopSweep();
    deps.stopDrain();
    await deps.flush().catch(() => {});
    await deps.releaseLock().catch(() => {});
  } finally {
    deps.exit(0);
  }
}

interface UiFlags {
  port: number | null;
  bind: string | null;
  url: string | null;
  allowInsecureBind: boolean;
  noContainer: boolean;
  /** Set by the unit's ExecStart and by the container supervisor. A supervised
   *  console honors the enablement belt; a foreground one is self-authorizing —
   *  otherwise a fresh install (no ui.json, no env) would print a URL and exit on
   *  its first request. */
  supervised: boolean;
}

function parseFlags(args: readonly string[], env: Record<string, string | undefined>): UiFlags {
  const flags: UiFlags = {
    port: null,
    bind: env.FORTRESS_UI_BIND?.trim() || null,
    url: null,
    allowInsecureBind: false,
    noContainer: false,
    supervised: false,
  };

  const envPort = env.FORTRESS_UI_PORT?.trim();
  if (envPort) flags.port = portOrThrow(envPort);

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    switch (arg) {
      case "--port":
        flags.port = portOrThrow(args[i + 1]);
        i += 1;
        break;
      case "--bind":
        flags.bind = requireValue(arg, args[i + 1]);
        i += 1;
        break;
      case "--url":
        flags.url = requireValue(arg, args[i + 1]);
        i += 1;
        break;
      case "--allow-insecure-bind":
        flags.allowInsecureBind = true;
        break;
      case "--no-container":
        flags.noContainer = true;
        break;
      case "--supervised":
        flags.supervised = true;
        break;
      default:
        throw new Error(
          `unknown option ${arg}\n` +
            "usage: hx-fortress ui [--port <n>] [--bind <addr>] [--url <base>] " +
            "[--allow-insecure-bind] [--no-container] [--supervised]",
        );
    }
  }
  return flags;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

function portOrThrow(value: string | undefined): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${value ?? ""}`);
  }
  return port;
}

function humanBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} kB`;
}

export async function runUiCommand(
  args: readonly string[],
  deps: UiCommandDeps,
): Promise<number> {
  // The unit verbs are flags rather than subcommands because they configure the
  // very invocation the unit will make; they take the same --allow-insecure-bind
  // the foreground console takes, and persist it.
  if (args.includes("--install-service")) {
    return await installUiService(args, uiServiceDeps(deps));
  }
  if (args.includes("--uninstall-service")) {
    return await uninstallUiService(uiServiceDeps(deps));
  }
  if (isUiSubcommand(args[0])) {
    return await runUiVerb(args, {
      writeLine: deps.writeLine,
      env: deps.env,
      fortressRoot: deps.fortressRoot,
      platform: deps.platform,
      hostName: deps.hostName,
    });
  }

  const env = deps.env ?? process.env;
  const write = deps.writeLine;
  const flags = parseFlags(args, env);
  const paths = fortressPaths(deps.fortressRoot);
  // The same home walk the daemon does, for the same file. credentials.json
  // lives under $HOME/.let/session-vault, and an image whose HOME moved between
  // versions leaves the daemon adopting the older location at ITS boot while
  // this process still looks at the new one — where the bucket panel reads
  // empty and every residency proof answers "this fortress has no object-store
  // credential". One walk, at boot, before anything reads the file. It writes
  // nothing: an absent file is simply not a candidate.
  const home = adoptDaemonHome({ env });

  const assets = await (deps.loadAssets ?? loadUiAssets)();
  if (!assets) {
    write("error: the console assets are missing from this build.");
    write("Build them with `bun run build:ui && bun run gen:ui`, or install a released binary.");
    return 1;
  }

  // A cold start against an unparseable ui.json refuses by name. There is no last
  // good value yet, and the one fallback available — pg.json's DSN — would
  // connect the browser-facing console as the table-owning role while silently
  // dropping trustedProxies and publicUrl.
  const live = new LiveUiConfig(paths.uiConfig, (message) => write(`warning: ${message}`));
  let stored;
  try {
    stored = await live.read();
  } catch (err) {
    if (err instanceof UiConfigColdStartError) {
      write(`error: ${err.message}`);
      return 1;
    }
    throw err;
  }

  const port = flags.port ?? stored.port ?? DEFAULT_UI_PORT;
  const publicUrl = env.FORTRESS_UI_PUBLIC_URL?.trim() || stored.publicUrl;
  const container = detectContainer({
    env,
    platform: deps.platform,
    noContainerFlag: flags.noContainer,
  });

  const bind = resolveUiBind({
    bind: flags.bind ?? stored.bind ?? LOOPBACK_BIND,
    port,
    publicUrl,
    uiEnable: env.FORTRESS_UI_ENABLE === "1" || env.FORTRESS_UI_ENABLE === "true",
    containerBind: env.FORTRESS_UI_CONTAINER_BIND === "1",
    allowInsecureBind: flags.allowInsecureBind || stored.allowInsecureBind,
    container,
  });

  if (!bind.ok) {
    write(`error: ${bind.reason}`);
    for (const note of bind.notes) write(`  ${note}`);
    return 1;
  }

  const lock = await acquireInstanceLock(path.join(paths.uiRoot, "instance.lock"), port, {
    supervised: flags.supervised,
  });
  if (!lock.ok) {
    write(`error: ${lock.message}`);
    return 1;
  }

  const runtime = new UiRuntime({
    uiRoot: paths.uiRoot,
    uiConfigFile: paths.uiConfig,
    cmdCredsDir: paths.cmdCreds,
    env,
    onWarn: (message) => write(`warning: ${message}`),
    sso: {
      // Read per verification, never cached: the hub can rotate the org key
      // while this console is serving, and a cached copy would reject every
      // grant minted after the rotation.
      pinnedKey: () => new FileSigningKeyStore(paths.signingKey).pinnedKey().catch(() => null),
      orgId: async () =>
        (await new FileCredentialStore(paths.credentials).load().catch(() => null))?.orgId ?? null,
      // The producer of the file the Posture panel reads. Written only when the
      // clock is the reason a hand-off failed, so the warning it drives is
      // never permanently on.
      onClockSkew: async (offsetSeconds) => {
        await writeClockSkew(paths.runtimeRoot, offsetSeconds).catch(() => {});
      },
      // …and the eraser. A hand-off that worked is proof the clock is usable.
      onClockOk: async () => {
        await clearClockSkew(paths.runtimeRoot).catch(() => {});
      },
    },
  });
  await runtime.restoreLockouts();

  // The read surface is mounted BEFORE the bind, so a page never reaches a
  // console whose API answers 404. Nothing in the mount throws on a broken
  // fortress: every panel behind it degrades into a named state instead.
  // The read surface is mounted BEFORE the bind, so a page never reaches a
  // console whose API answers 404. Nothing in the mount throws on a broken
  // fortress: every panel behind it degrades into a named state instead.
  const mount = createConsoleMount({
    paths,
    runtime,
    boundPort: port,
    onWarn: (message) => write(`warning: ${message}`),
    // Under an orchestrator there is no unit to start and no binary to swap,
    // and the console says so rather than offering verbs the container hides.
    serviceManager: container.container ? "container" : getServiceManager({ platform: deps.platform }).name,
    env,
  });
  await mount.ready;
  const ctx: UiServerCtx = { assets, port, runtime, read: mount, write: mount, audit: mount.audit };
  let started: { readonly port?: number | null };
  try {
    started = (deps.serve ?? startUiServer)(
      ctx,
      bind.hostname,
      bind.dualStack ? DUAL_STACK_FALLBACK_BIND : undefined,
    );
  } catch (err) {
    await lock.release();
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    // A busy port is a DIFFERENT failure from a second console on this root, and
    // the remedy depends on who is holding it — so ask.
    const occupant = await probeOccupant(`http://127.0.0.1:${port}`);
    write(`error: ${portCollisionMessage(port, occupant)}`);
    return 1;
  }

  runtime.startSweepTimer();
  // Boot is a drain trigger of its own: whatever a CLI invocation or the daemon
  // spooled while no console was running belongs in the table now, not at the
  // first tick 30 seconds from here.
  mount.drain.start();
  void mount.drain.run();

  // A signal is the ONLY way a supervised console is told to go away: `ui
  // disable` flips the setting and the supervisor signals, and `docker stop`
  // signals the entrypoint which forwards it. Owned here because this is the
  // only frame holding everything a stop has to release, and because a handler
  // registered anywhere at all suppresses the default termination — which is
  // how a console that was told to stop kept serving the admin surface while the
  // operator read "Console disabled."
  const shutdown = (signal: NodeJS.Signals): void => {
    void stopConsole(signal, {
      write,
      stopServer: () => (started as { stop?: (closeActive?: boolean) => void }).stop?.(true),
      stopSweep: () => runtime.stopSweepTimer(),
      stopDrain: () => mount.drain.stop(),
      flush: () => mount.audit.flushFailures(true),
      releaseLock: () => lock.release(),
      exit: deps.exit ?? ((code: number): void => process.exit(code)),
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  const boundPort = started.port ?? port;
  const url = printedUrl({
    urlOverride: flags.url,
    publicUrl,
    hostname: bind.hostname,
    dualStack: bind.dualStack,
    port: boundPort,
    hostName: deps.hostName ?? os.hostname(),
  });

  write("HX Fortress console");
  write(
    `  assets: ${assets.mode}, ${assets.manifest.files} files, ` +
      `${humanBytes(assets.manifest.bytes)}, sha256 ${assets.manifest.hash}`,
  );
  write(`  listening on ${bracketed(bind.hostname)}:${boundPort}`);
  if (home.adopted) {
    // Said out loud, like the daemon says it: a home that moved between image
    // versions is only ever noticed by an operator comparing this line against
    // the volume they think they mounted.
    write(`  reading credentials from an adopted fortress home: ${home.home}`);
  }
  for (const line of PEOPLE_VISIBILITY_DISCLOSURE) write(line);
  write(`  open ${url.base}`);
  for (const note of [...url.notes, ...bind.notes]) write(`  ${note}`);
  if (flags.supervised) {
    write("  supervised: it stops when `hx-fortress ui disable` flips the setting");
  }

  // The container's first account, if one was staged. AFTER the URL is printed,
  // because the setup link is built on it — and consumed as it is read, so a
  // respawned console prints nothing and mints nothing.
  const staged = await consumeBootstrapRequest(bootstrapRequestPath(paths.uiRoot));
  if (staged) {
    const applied = await applyBootstrapUser({
      request: staged,
      users: runtime.users,
      base: url.base,
      linkFile: bootstrapLinkPath(paths.uiRoot),
    }).catch((error: unknown) => ({
      created: false,
      lines: [`could not apply FORTRESS_UI_BOOTSTRAP_USER: ${error instanceof Error ? error.message : String(error)}`],
    }));
    for (const line of applied.lines) write(`  ${line}`);
  }
  return 0;
}
