// `hx-fortress install` in a browser: the setup's page, served on the
// engineer's own computer.
//
// NOTHING EXISTS YET, AND NOTHING IS ON THE INTERNET. The page is served on
// this computer's own address only. The questions are answered here, and the
// last step makes HX Fortress in the place that was chosen. Until a person
// says yes to that step, nothing is made anywhere.
//
// THE LINK WORKS ONCE and holds a token, as the setup's link always does
// (`src/ui/setup-server.ts`). The command opens it in the person's own
// browser. When it cannot, it prints the link to the terminal it runs in, and
// never anywhere a terminal is not.
//
// THIS COMPUTER KEEPS NOTHING. No file holds the answers or a key a person
// typed. One file exists for a moment: the page that hands the link to the
// browser. The link holds a token, and an address given to the system's
// opener as an argument can be read by every process on the computer while
// the opener runs. So the opener is given a file instead, which only this
// user can read and which sends the browser on to the link. It is removed as
// soon as the link is opened, and when the command ends.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { fortressPaths } from "../host/paths";
import { hasProductionAnchor } from "../host/trust/signing-keys";
import { SetupRun, type SetupRunDeps } from "../setup/run";
import { loadUiAssets, type UiAssets } from "../ui/assets";
import { mintSetupLink, setupLinkUrl, startSetupServer, type SetupServerCtx } from "../ui/setup-server";
import { FORTRESS_VERSION } from "../version";
import { PLACES_OF_THIS_BUILD } from "./place";

/** Where the install's page answers, on this computer. */
export const INSTALL_PORT = 8788;
/** How many ports after it are tried when it is taken. */
const PORTS_TRIED = 10;
const LOOPBACK = "127.0.0.1";

export interface BrowserInstallOptions {
  env?: Record<string, string | undefined>;
  writeLine: (line: string) => void;
  /** Whether what this command prints goes to a terminal. Decides whether the
   *  link may be printed. */
  isTty?: boolean;
  /** `--port <n>`. Left out: 8788, or the next one that is free. */
  port?: number | null;
  /** `--no-open`: do not open a browser; print the link. */
  noOpen?: boolean;
  /** Opens an address in the person's browser. False when it could not. */
  open?: (url: string) => Promise<boolean> | boolean;
  run?: Partial<SetupRunDeps>;
  loadAssets?: () => Promise<UiAssets | null>;
  /** Resolves when the process is told to stop. */
  stopSignal?: Promise<void>;
  /** Called with the link once the page is served. For a test that drives it. */
  onListening?: (info: { link: string; port: number; run: SetupRun }) => void;
}

/** Folders of this computer that the install names and never writes. */
export function installPaths(): ReturnType<typeof fortressPaths> {
  return fortressPaths(path.join(os.tmpdir(), "hx-fortress-install"));
}

/**
 * The page that sends a browser on to an address. The address is written as
 * a JSON string inside a script, with "<" escaped, so nothing in it can end
 * the script or start a tag.
 */
export function openerPage(url: string): string {
  const target = JSON.stringify(url).replace(/</g, "\\u003c");
  return (
    '<!doctype html><meta charset="utf-8"><title>HX Fortress setup</title>' +
    `<script>location.replace(${target});</script>`
  );
}

/**
 * Open the setup's link in the person's own browser, with the system's own
 * opener, without the link ever being an argument of a command: see the top
 * of this file. `forget` gets what removes the file.
 */
export async function openInBrowser(
  url: string,
  forget: (() => Promise<void>)[],
  platform: string = process.platform,
): Promise<boolean> {
  const opener = platform === "darwin" ? "open" : platform === "linux" ? "xdg-open" : null;
  if (!opener) return false;
  let folder: string;
  try {
    // 0700 by `mkdtemp`, and the file 0600: this user only.
    folder = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-open-"));
  } catch {
    return false;
  }
  forget.push(() => rm(folder, { recursive: true, force: true }));
  const page = path.join(folder, "open.html");
  try {
    // A file this function just made a private folder for.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(page, openerPage(url), { mode: 0o600 });
    const child = Bun.spawn([opener, page], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return (await child.exited) === 0;
  } catch {
    return false;
  }
}

/** 0: HX Fortress was made. 1: the install could not run, or was stopped. */
export async function runBrowserInstall(options: BrowserInstallOptions): Promise<number> {
  const env = options.env ?? process.env;
  const write = options.writeLine;

  const run = await SetupRun.open({
    paths: installPaths(),
    env,
    way: "install",
    places: PLACES_OF_THIS_BUILD,
    ...options.run,
  });

  const assets = await (options.loadAssets ?? loadUiAssets)();
  if (!assets) {
    write("error: the setup's pages are missing from this build.");
    write("Answer in this terminal instead: hx-fortress install --terminal");
    return 1;
  }

  const link = mintSetupLink();
  // What removes the file that handed the link to the browser.
  const forget: (() => Promise<void>)[] = [];
  const forgetAll = async (): Promise<void> => {
    for (const remove of forget.splice(0)) await remove().catch(() => {});
  };
  let finished: (() => void) | null = null;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });

  const first = options.port ?? INSTALL_PORT;
  let started: ReturnType<typeof startSetupServer> | null = null;
  let port = first;
  for (let offset = 0; started === null; offset += 1) {
    port = first + offset;
    const ctx: SetupServerCtx = {
      assets,
      port,
      run,
      link,
      bind: LOOPBACK,
      publicUrl: null,
      // The last screen is the only place the first administrator's link is
      // shown, so the listener waits for the page's word with no limit.
      doneGraceMs: null,
      create: () => run.create("browser", null),
      onDone: () => finished?.(),
      // The link is spent: the file that carried it goes at once.
      onOpened: () => forgetAll(),
    };
    try {
      started = startSetupServer(ctx, LOOPBACK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      // A port a person named is theirs to free. The default moves on.
      if (options.port || offset >= PORTS_TRIED) {
        write(`error: port ${port} is in use on this computer, so the setup cannot be served there.`);
        write("Give another port: hx-fortress install --port <n>");
        return 1;
      }
    }
  }
  const boundPort = started.server.port ?? port;
  // The address, never the name `localhost`: a name may be answered at ::1,
  // where this setup does not listen and another program on this computer
  // could. The link holds the one-time token, so it goes to this listener's
  // own address and to nothing else.
  const base = `http://${LOOPBACK}:${boundPort}`;
  const linkUrl = setupLinkUrl(base, link.token);

  try {
    write(`HX Fortress ${FORTRESS_VERSION}   ${hasProductionAnchor() ? "signature checked" : "a development build"}`);
    write(`Setup is open at ${base}, on this computer only.`);
    write("Nothing is created, and nothing is on the internet, until you say so there.");
    const tty = options.isTty ?? Boolean(process.stdout.isTTY);
    let opened = false;
    if (!options.noOpen) {
      write("Opening your browser");
      opened = options.open ? await options.open(linkUrl) : await openInBrowser(linkUrl, forget);
    }
    if (!opened) {
      if (!tty) {
        write("error: no browser could be opened, and the setup's link is shown only in a terminal.");
        write("Run the command in a terminal, or give the answers as a file: hx-fortress install --file <path>");
        return 1;
      }
      write("Open this link in your browser. It works once:");
      write(`  ${linkUrl}`);
    }
    options.onListening?.({ link: linkUrl, port: boundPort, run });

    const stop =
      options.stopSignal ??
      new Promise<void>((resolve) => {
        process.once("SIGINT", () => resolve());
        process.once("SIGTERM", () => resolve());
      });
    const ended = await Promise.race([done.then(() => "done" as const), stop.then(() => "stopped" as const)]);
    const made = run.done();
    if (ended === "stopped" && !made) {
      const stage = run.progress().stage;
      run.stop();
      write(
        stage === "making" || stage === "failed"
          ? "Setup stopped. What was made so far is still there. Run the command again to go on."
          : "Setup stopped. Nothing was made.",
      );
      return 1;
    }
    // The last response is on its way to the page. Let it leave, then close.
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    if (made) write(`HX Fortress is live at ${made.address}. The setup is closed.`);
    return made ? 0 : 1;
  } finally {
    await started.server.stop(true).catch(() => {});
    await forgetAll();
  }
}
