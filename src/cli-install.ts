// `hx-fortress install`: make HX Fortress in a cloud account or on a machine
// with Docker, from an engineer's own computer.
//
//   hx-fortress install                      serve the setup in a browser, on this computer only
//   hx-fortress install --terminal           ask the questions in this terminal
//   hx-fortress install --file <path>        take the answers from a settings file
//   hx-fortress install --connect <address>/i/<id> [--pages <origin>]
//                                            the control plane, and its one-time install id
//   hx-fortress install --port <n>           where the browser setup is served (default 8788)
//   hx-fortress install --no-open            print the link and open no browser
//   hx-fortress install --list               print the list of questions and options
//
// NOTHING EXISTS WHEN IT STARTS, AND NOTHING IS MADE UNTIL A PERSON SAYS YES
// to the last step. The questions are the setup's own list
// (`src/setup/list.ts`), asked for the place a person picks first. The last
// step hands everything to that place (`src/install/place.ts`), which makes
// the resources with the engineer's own sign-in. This computer keeps nothing.
//
// A control plane writes `--connect` into the command it shows: its address
// and a one-time install id. Without it, HX Fortress is made with no control
// plane, and runs on its own.

import { readFile } from "node:fs/promises";

import {
  confirmPrompt,
  passwordPrompt,
  selectPrompt,
  textPrompt,
  ttyAvailable,
} from "./modules/session-vault/prompt";
import { installPaths, runBrowserInstall, type BrowserInstallOptions } from "./install/browser";
import { PLACES_OF_THIS_BUILD, type Place } from "./install/place";
import type { StepCheck } from "./setup/checks";
import { parseConnect } from "./setup/connect";
import { INSTALL_PLACES, stepById, stepsAsked, visibleList } from "./setup/list";
import { SetupRun, type Connect, type SetupRunDeps } from "./setup/run";
import { runTerminalSetup, type TerminalIo } from "./setup/terminal";
import type { SetupDone } from "./setup/view";

type WriteLine = (line: string) => void;

export interface InstallCommandDeps {
  writeLine: WriteLine;
  env?: Record<string, string | undefined>;
  /** Whether a person is at a terminal. Default: whether there is one. */
  isTty?: boolean;
  /** Whether what this command prints goes to a terminal, and not to a pipe
   *  or a file. Default: whether its output is one. */
  outputIsTty?: boolean;
  io?: TerminalIo;
  /** The places this build can make HX Fortress in. Default: the build's own. */
  places?: readonly Place[];
  /** Passed to the run: fakes for the outside calls, in tests. */
  run?: Partial<SetupRunDeps>;
  browser?: (options: BrowserInstallOptions) => Promise<number>;
  readFile?: (file: string) => Promise<string>;
}

const USAGE = [
  "usage: hx-fortress install                      serve the setup in a browser, on this computer only",
  "       hx-fortress install --terminal           ask the questions in this terminal",
  "       hx-fortress install --file <path>        take the answers from a settings file",
  "       hx-fortress install --connect <address>/i/<id> [--pages <origin>]",
  "                                                the control plane, and its one-time install id",
  "       hx-fortress install --port <n>           where the browser setup is served (default 8788)",
  "       hx-fortress install --no-open            print the link and open no browser",
  "       hx-fortress install --list               print the list of questions and options",
  `questions: ${stepsAsked("install").join(", ")}`,
  "To set up HX Fortress on the machine it runs on: hx-fortress setup",
].join("\n");

function realIo(writeLine: WriteLine): TerminalIo {
  return {
    line: writeLine,
    text: (message, options) => textPrompt(message, options),
    secret: (message) => passwordPrompt(message),
    select: (message, choices, options) => selectPrompt(message, choices, options),
    confirm: (message, options) => confirmPrompt(message, options),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

function printRefusals(write: WriteLine, checks: readonly StepCheck[]): void {
  for (const check of checks) {
    for (const line of check.lines.filter((l) => !l.ok && !l.soft)) {
      write(`  no  ${stepById(check.step).name}: ${line.text}`);
    }
  }
}

/**
 * Say what was made. The first administrator's one-time link is a credential,
 * and this computer keeps no file for it: it is printed only when what this
 * command prints goes to a terminal.
 */
function printDone(write: WriteLine, done: SetupDone | null, tty: boolean): void {
  if (!done) return;
  write("");
  write(`HX Fortress is live at ${done.address}`);
  for (const note of done.notes) write(note);
  if (done.firstAccount) {
    if (tty) {
      write(`The account ${done.firstAccount.login} sets its password once, within 23 hours, at:`);
      write(`  ${done.firstAccount.link}`);
    }
  }
}

export async function runInstallCommand(args: readonly string[], deps: InstallCommandDeps): Promise<number> {
  const write = deps.writeLine;
  const env = deps.env ?? process.env;
  const flag = (name: string): boolean => args.includes(name);
  const valueOf = (name: string): string | null => {
    const at = args.indexOf(name);
    const value = at >= 0 ? args[at + 1] : undefined;
    return value && !value.startsWith("--") ? value : null;
  };

  const known = new Set(["--terminal", "--file", "--connect", "--pages", "--port", "--no-open", "--list", "--help"]);
  const unknown = args.find((arg) => arg.startsWith("--") && !known.has(arg));
  // A word that is no option's value is not a question to ask alone here.
  const stray = args.find(
    (arg, at) => !arg.startsWith("--") && !["--file", "--connect", "--pages", "--port"].includes(args[at - 1] ?? ""),
  );
  if (unknown || stray || flag("--help")) {
    if (unknown) write(`error: unknown option ${/^--[a-z-]{1,32}$/.test(unknown) ? unknown : "(not shown)"}`);
    else if (stray) write("error: hx-fortress install takes options only");
    write(USAGE);
    return unknown || stray ? 1 : 0;
  }

  if (flag("--list")) {
    // The list for each place this command can ask about, by the place's id.
    write(
      JSON.stringify(
        Object.fromEntries(INSTALL_PLACES.map((place) => [place, visibleList({ way: "install", place })])),
        null,
        2,
      ),
    );
    return 0;
  }

  // The value holds the one-time install id, so a refusal never repeats it.
  let connect: Connect | null = null;
  if (flag("--connect") || flag("--pages")) {
    const parsed = parseConnect(valueOf("--connect"), valueOf("--pages"));
    if (!parsed.ok) {
      write(`error: ${parsed.reason}`);
      return 1;
    }
    connect = parsed.connect;
  }

  const places = deps.places ?? PLACES_OF_THIS_BUILD;
  // Said before anything is served: a first page with nothing to pick would
  // leave a person guessing.
  if (places.length === 0) {
    write("error: this build has no place to install HX Fortress into yet.");
    write("Set it up on the machine it runs on instead: hx-fortress setup");
    return 1;
  }
  const outputIsTty = deps.outputIsTty ?? deps.isTty ?? Boolean(process.stdout.isTTY);
  const runDeps: SetupRunDeps = {
    paths: installPaths(),
    env,
    way: "install",
    places,
    ...(connect ? { connect } : {}),
    ...deps.run,
  };

  // ── A settings file ────────────────────────────────────────────────────────
  if (flag("--file")) {
    const file = valueOf("--file");
    if (!file) {
      write("error: --file needs the path of a settings file");
      return 1;
    }
    let text: string;
    try {
      text = await (deps.readFile ?? ((f: string): Promise<string> => readFile(f, "utf8")))(file);
    } catch {
      write(`error: the settings file ${file} could not be read`);
      return 1;
    }
    const run = await SetupRun.open(runDeps);
    const taken = run.takeFile(text);
    if (!taken.ok) {
      write("The settings file is refused:");
      for (const line of taken.refusals) write(`  no  ${line}`);
      write("Nothing was made.");
      return 1;
    }
    const started = await run.create("file", null, { showAccountLink: outputIsTty });
    if (!started.ok) {
      write("An answer is refused:");
      printRefusals(write, started.checks);
      write("Nothing was made.");
      return 1;
    }
    const plan = run.derived().plan;
    write(plan.heading);
    const said = new Set<string>();
    const say = (): void => {
      for (const id of run.progress().made) {
        if (said.has(id)) continue;
        said.add(id);
        const row = plan.rows.find((r) => r.id === id);
        if (row) write(`  ok  ${row.label}: ${row.value}`);
      }
    };
    let dnsSaid = false;
    const watch = setInterval(() => {
      say();
      const dns = run.progress().dns;
      if (dns && !dnsSaid) {
        dnsSaid = true;
        write("  Waiting for this record at your DNS provider:");
        write(`    CNAME ${dns.name} → ${dns.target}`);
      }
    }, 500);
    try {
      await started.ended;
    } finally {
      clearInterval(watch);
    }
    say();
    const progress = run.progress();
    if (progress.stage !== "done") {
      const row = plan.rows.find((r) => r.id === progress.failure?.row);
      write(`  no  ${row ? `${row.label}: ` : ""}${progress.failure?.text ?? "It could not be made"}`);
      write("What was made so far is still there. Run the command again to go on.");
      return 1;
    }
    printDone(write, run.done(), outputIsTty);
    return 0;
  }

  // ── This terminal ──────────────────────────────────────────────────────────
  if (flag("--terminal")) {
    const tty = deps.isTty ?? ttyAvailable();
    if (!tty) {
      write("error: hx-fortress install --terminal asks its questions in a terminal, and there is none here.");
      write("Give the answers as a file: hx-fortress install --file <path>");
      return 1;
    }
    const run = await SetupRun.open(runDeps);
    const io = deps.io ?? realIo(write);
    const outcome = await runTerminalSetup(run, io, {
      end: { create: () => run.create("terminal", null, { showAccountLink: outputIsTty }) },
    });
    if (outcome.ended !== "finished") return 1;
    printDone(write, outcome.done, outputIsTty);
    return 0;
  }

  // ── A browser, on this computer only ───────────────────────────────────────
  const port = valueOf("--port");
  if (flag("--port") && (!port || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
    write("error: --port needs a number from 1 to 65535");
    return 1;
  }
  return (deps.browser ?? runBrowserInstall)({
    env,
    writeLine: write,
    isTty: outputIsTty,
    port: port ? Number(port) : null,
    noOpen: flag("--no-open"),
    run: { places, ...(connect ? { connect } : {}), ...deps.run },
  });
}
