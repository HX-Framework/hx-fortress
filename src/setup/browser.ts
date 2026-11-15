// `hx-fortress setup --browser`: the one-time browser setup, from the link it
// prints to the moment it closes.
//
// IT RUNS ONCE, ON A NEW INSTALL. A Fortress that has been set up refuses to
// serve it: from then on an answer changes only through a command a person
// types on the host. So the only time a browser can write a setting is the
// first setup, with a link that came from the host.
//
// THE LINK IS PRINTED TO A TERMINAL, NEVER TO A LOG. It is as strong as a shell
// on this host for as long as the setup is open. On a host with a terminal
// attached it is printed there. With none, and ALWAYS in a container, it is
// written to a file that only the Fortress's own user can read, and the output
// names the file and the command that prints it. A container's output is its
// log even when a terminal is attached to it: the runtime keeps what was
// printed. This is the rule the console's account links already follow.

import { mkdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { fortressPaths } from "../host/paths";
import { loadUiAssets, type UiAssets } from "../ui/assets";
import { bracketed, DUAL_STACK_FALLBACK_BIND, LOOPBACK_BIND, printedUrl, resolveUiBind } from "../ui/bind";
import { consolePort, LiveUiConfig, uiEnabledFromEnv } from "../ui/config";
import { isLoopbackHost } from "../host/config";
import { detectContainer } from "../ui/container";
import {
  mintSetupLink,
  setupLinkUrl,
  startSetupServer,
  type SetupDone,
  type SetupServerCtx,
} from "../ui/setup-server";
import { setupUrl } from "../ui/users";
import { SetupAudit } from "./audit";
import { linkIsElsewhere, SetupRun, type FinishResult, type SetupRunDeps } from "./run";

type FortressPaths = ReturnType<typeof fortressPaths>;

/** Where the link of a browser setup that is waiting is kept, 0600. */
export function setupLinkPath(paths: FortressPaths): string {
  return path.join(paths.uiRoot, "setup-link.txt");
}

export const ALREADY_SET_UP =
  "This HX Fortress is set up. The browser setup runs once, on a new install. " +
  "To change an answer, run `hx-fortress setup` in a terminal on this host.";

export interface BrowserSetupOptions {
  paths: FortressPaths;
  env?: Record<string, string | undefined>;
  writeLine: (line: string) => void;
  /** Whether a person is reading the output. Decides whether the link is printed. */
  isTty?: boolean;
  /** `--port <n>`: where the setup listens. Saved as the console's port when
   *  the setup ends, so the console answers where the setup did. */
  port?: number | null;
  /** `--url <base>`: what the link is built on, when the host knows better. */
  url?: string | null;
  noContainer?: boolean;
  /** Injected in tests: the platform the container detector reads. */
  platform?: string;
  hostName?: string;
  run?: Partial<SetupRunDeps>;
  /** Injected in tests. */
  loadAssets?: () => Promise<UiAssets | null>;
  /** Resolves when the process is told to stop. */
  stopSignal?: Promise<void>;
  /** Called with the link once the setup is listening. For a test that drives it. */
  onListening?: (info: { link: string; port: number }) => void;
  /** True when whatever started this setup starts the Fortress once it ends,
   *  as a container's entry point does. The last screen then says so. */
  startsAfter?: boolean;
  /** How long the listener waits for the page's word that the last screen
   *  arrived. Shortened in tests. */
  doneGraceMs?: number;
}

/** 0: the answers were written. 1: the setup could not run, or was stopped. */
export async function runBrowserSetup(options: BrowserSetupOptions): Promise<number> {
  const env = options.env ?? process.env;
  const write = options.writeLine;
  const { paths } = options;

  const run = await SetupRun.open({ paths, env, ...options.run });
  if (run.present.setUp) {
    write(`error: ${ALREADY_SET_UP}`);
    return 1;
  }

  const assets = await (options.loadAssets ?? loadUiAssets)();
  if (!assets) {
    write("error: the console's pages are missing from this build, and the browser setup is drawn with them.");
    write("Answer in this terminal instead: hx-fortress setup");
    return 1;
  }

  // Where it listens is the console's own rule, with the console's own
  // inputs and nothing added: this host only, unless the environment switches
  // the console on in a container that publishes its ports, or an https
  // address is set for the console. The setup has no flag of its own that
  // widens it: a person who can finish the setup decides everything this
  // Fortress does, so its listener is exactly as wide as the console's will be.
  const stored = await new LiveUiConfig(paths.uiConfig).read().catch(() => null);
  let port: number;
  try {
    port = options.port ?? consolePort(env, stored?.port);
  } catch (error) {
    write(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const publicUrl = env.FORTRESS_UI_PUBLIC_URL?.trim() || stored?.publicUrl || null;
  const container = detectContainer({
    env,
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.noContainer ? { noContainerFlag: true } : {}),
  });
  const bind = resolveUiBind({
    bind: env.FORTRESS_UI_BIND?.trim() || stored?.bind || LOOPBACK_BIND,
    port,
    publicUrl,
    uiEnable: uiEnabledFromEnv(env),
    containerBind: env.FORTRESS_UI_CONTAINER_BIND === "1",
    allowInsecureBind: stored?.allowInsecureBind === true,
    container,
  });
  if (!bind.ok) {
    write(`error: ${bind.reason}`);
    for (const note of bind.notes) write(`  ${note}`);
    return 1;
  }

  const link = mintSetupLink();
  const audit = new SetupAudit(paths.auditSpool);
  const printed = printedUrl({
    urlOverride: options.url ?? null,
    publicUrl,
    hostname: bind.hostname,
    dualStack: bind.dualStack,
    port,
    hostName: options.hostName ?? os.hostname(),
  });

  let finished: (() => void) | null = null;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  // The end of the setup while it runs, and whether it wrote. A stop that
  // arrives in the middle waits for it, and then says what is true.
  let ending: Promise<unknown> | null = null;
  let saved = false;

  const ctx: SetupServerCtx = {
    assets,
    port,
    run,
    link,
    bind: bind.hostname,
    publicUrl,
    ...(options.doneGraceMs !== undefined ? { doneGraceMs: options.doneGraceMs } : {}),
    finish: (): Promise<FinishResult> => {
      const result = run.finish("browser", { consolePort: options.port ?? null, audit }).then((outcome) => {
        if (outcome.ok) saved = true;
        return outcome;
      });
      ending = result.catch(() => null);
      return result;
    },
    done: (result): SetupDone => {
      const base = run.answers.signIn.consoleAddress || printed.base;
      const account = result.applied.firstAccount;
      return {
        consoleAddress: base,
        // An account made for a link that was minted where HX Fortress was
        // installed has no link here: the last screen shows none, and says
        // where it is.
        firstAccount: !account
          ? null
          : account.token
            ? { login: account.login, link: setupUrl(base, account.token) }
            : { login: account.login, link: null, elsewhere: linkIsElsewhere(account.login) },
        notes: result.applied.notes,
        summary: run.derived().summary,
        next: options.startsAfter
          ? "HX Fortress starts now. Its console answers in a moment."
          : "Start HX Fortress on its host: hx-fortress start",
      };
    },
    onDone: () => finished?.(),
    onOpened: (remote) => audit.opened(remote).catch(() => {}),
    onLinkRefused: (remote, attempts) => audit.linkRefused(remote, attempts).catch(() => {}),
  };

  let started;
  try {
    started = startSetupServer(ctx, bind.hostname, bind.dualStack ? DUAL_STACK_FALLBACK_BIND : undefined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    write(`error: port ${port} is in use on this host, so the setup cannot listen there.`);
    write("Stop what holds it, or give another port: hx-fortress setup --browser --port <n>");
    return 1;
  }
  const boundPort = started.server.port ?? port;
  const base = boundPort === port ? printed.base : printed.base.replace(`:${port}`, `:${boundPort}`);
  const linkUrl = setupLinkUrl(base, link.token);
  const linkFile = setupLinkPath(paths);

  // From here on the listener is up and the link is live. Whatever happens
  // below, both end with this function: a setup that could not go on must not
  // keep answering on the port.
  try {
    // Kept beside the console's own files, readable by the Fortress's user
    // only, so a person on the host can ask for it again while the setup waits.
    await mkdir(path.dirname(linkFile), { recursive: true, mode: 0o700 });
    // The Fortress's own file, never a path a caller supplies.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(linkFile, `${linkUrl}\n`, { mode: 0o600 });

    write("HX Fortress setup");
    write(`  listening on ${bracketed(bind.hostname)}:${boundPort}`);
    const atTerminal = (options.isTty ?? Boolean(process.stdout.isTTY)) && !container.container;
    if (atTerminal) {
      write("  open this link to answer the setup's questions. It works once:");
      write(`    ${linkUrl}`);
    } else {
      const here = container.container ? "in this container" : "on this host";
      write(`  the one-time link is in ${linkFile}, which only HX Fortress's own user can read`);
      write(`  print it ${here}: hx-fortress setup link`);
      write("  it is not printed here, because whoever reads this output could open it");
    }
    if (container.container && isLoopbackHost(bind.hostname)) {
      write("  this listener answers inside the container only, as the console would");
      write("  to answer in a browser, set FORTRESS_UI_ENABLE=1 and publish the port");
      write("  or give the answers as a file (FORTRESS_SETUP_FILE), or in a terminal: hx-fortress setup");
    }
    for (const note of [...printed.notes, ...bind.notes]) write(`  ${note}`);
    options.onListening?.({ link: linkUrl, port: boundPort });

    const stop =
      options.stopSignal ??
      new Promise<void>((resolve) => {
        process.once("SIGINT", () => resolve());
        process.once("SIGTERM", () => resolve());
      });
    const ended = await Promise.race([done.then(() => "done" as const), stop.then(() => "stopped" as const)]);

    // A stop in the middle of the end waits for the end: the answers are being
    // written, and what is said next must be what happened.
    if (ended === "stopped" && ending) await ending;
    // The last response is on its way to the page. Let it leave, then close.
    if (saved) await new Promise<void>((resolve) => setTimeout(resolve, 400));

    if (!saved) {
      write("Setup stopped. Nothing was saved.");
      return 1;
    }
    write("Setup is saved, and the browser setup is closed.");
    return 0;
  } finally {
    await started.server.stop(true).catch(() => {});
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await unlink(linkFile).catch(() => {});
  }
}
