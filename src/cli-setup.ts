// `hx-fortress setup`: the setup's questions, on the machine that runs
// HX Fortress.
//
//   hx-fortress setup                 ask the questions here
//   hx-fortress setup <question>      ask one question again, such as `keys`
//   hx-fortress setup --browser       serve the one-time browser setup (a new install only)
//   hx-fortress setup --file <path>   take the answers from a settings file
//   hx-fortress setup --connect <address>/i/<id> [--pages <origin>]
//                                     name a control plane, with its one-time install id
//   hx-fortress setup --print         print the present answers as a settings file
//   hx-fortress setup --list          print the setup's list of questions and options
//   hx-fortress setup check           check every answer again
//   hx-fortress setup link            print the link of a browser setup that is waiting
//
// All of them work on one list (`src/setup/list.ts`) and through one run
// (`src/setup/run.ts`), so a question is asked, checked and written the same
// way however it is answered. `hx-fortress install` asks the same list on an
// engineer's own computer and makes HX Fortress somewhere else: see
// `src/cli-install.ts`.
//
// A LOCAL GESTURE. Whoever can type this already has the host. Nothing a
// control plane sends reaches any of it.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { signalDaemon } from "./console/witness-signal";
import { liveDaemonPid } from "./host/modules-api";
import { fortressPaths } from "./host/paths";
import {
  confirmPrompt,
  passwordPrompt,
  selectPrompt,
  textPrompt,
  ttyAvailable,
} from "./modules/session-vault/prompt";
import { publicAddress, settingsFileText } from "./setup/answers";
import { SetupAudit } from "./setup/audit";
import { runBrowserSetup, setupLinkPath, type BrowserSetupOptions } from "./setup/browser";
import { refusalsOf, type StepCheck } from "./setup/checks";
import { parseConnect } from "./setup/connect";
import { SETUP_LIST, stepById, stepsAsked, visibleList, type StepId } from "./setup/list";
import { linkIsElsewhere, SetupRun, type Connect, type FinishResult, type SetupRunDeps } from "./setup/run";
import { SETUP_SETTINGS_ENV } from "./setup/state";
import { runTerminalSetup, type TerminalIo } from "./setup/terminal";
import { bootstrapLinkPath } from "./ui/bootstrap-user";
import { consolePort, UiConfigStore } from "./ui/config";
import { setupUrl } from "./ui/users";

type WriteLine = (line: string) => void;

export interface SetupCommandDeps {
  writeLine: WriteLine;
  fortressRoot?: string;
  env?: Record<string, string | undefined>;
  /** Whether a person is at a terminal. Default: whether there is one. */
  isTty?: boolean;
  /** Whether what this command prints goes to a terminal, and not to a pipe
   *  or a file. Default: whether its output is one. */
  outputIsTty?: boolean;
  /** The prompts. Default: the real ones. A test passes a script. */
  io?: TerminalIo;
  /** Passed to the run: fakes for the outside calls, in tests. */
  run?: Partial<SetupRunDeps>;
  /** Starts HX Fortress as a service. Given by the command line's own `start`. */
  start?: () => Promise<void>;
  /** Injected in tests: the browser setup. */
  browser?: (options: BrowserSetupOptions) => Promise<number>;
  readFile?: (file: string) => Promise<string>;
  daemonPid?: () => Promise<number | null>;
  kill?: typeof process.kill;
}

/** The questions a setup on the machine itself answers, by their key in a
 *  settings file. Where HX Fortress runs is the install's question. */
const QUESTIONS = stepsAsked("setup");

const USAGE = [
  "usage: hx-fortress setup                 ask the setup's questions in this terminal",
  "       hx-fortress setup <question>      ask one question again",
  "       hx-fortress setup --browser       serve the one-time browser setup (a new install only)",
  "       hx-fortress setup --file <path>   take the answers from a settings file",
  "       hx-fortress setup --connect <address>/i/<id> [--pages <origin>]",
  "                                         name a control plane, with its one-time install id",
  "       hx-fortress setup --print         print the present answers as a settings file",
  "       hx-fortress setup --list          print the setup's list of questions and options",
  "       hx-fortress setup check           check every answer again",
  "       hx-fortress setup link            print the link of a browser setup that is waiting",
  `questions: ${QUESTIONS.join(", ")}`,
  "To make HX Fortress in a cloud or on another machine from this computer: hx-fortress install",
].join("\n");

/** A question by the word a person types for it: its key, or its name in any
 *  case, with or without the dash. */
function stepNamed(word: string): StepId | null {
  const flat = (text: string): string => text.toLowerCase().replace(/[^a-z]/g, "");
  const found = SETUP_LIST.find((step) => flat(step.id) === flat(word) || flat(step.name) === flat(word))?.id;
  return found && QUESTIONS.includes(found) ? found : null;
}

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

function printChecks(write: WriteLine, checks: readonly StepCheck[]): void {
  for (const check of checks) {
    write(stepById(check.step).name);
    if (check.lines.length === 0) write("  ok");
    for (const line of check.lines) {
      write(`${line.ok ? "  ok  " : line.soft ? "  !   " : "  no  "}${line.text}`);
    }
  }
}

/**
 * Say what the setup wrote, and what a person does next.
 *
 * The first administrator's one-time link is a credential. It is printed only
 * when what this command prints goes to a terminal: `tty` says that. The
 * questions are asked on the terminal itself, so they work while the output is
 * piped into a file, and a link printed then would land in that file. In every
 * other case the link is written to a file only HX Fortress's own user can
 * read, and the output names the file.
 */
async function afterFinish(
  result: Extract<FinishResult, { ok: true }>,
  run: SetupRun,
  deps: SetupCommandDeps,
  options: { tty: boolean; mayStart: boolean; startsAfter?: boolean },
): Promise<void> {
  const write = deps.writeLine;
  const paths = fortressPaths(deps.fortressRoot);
  const { applied } = result;
  const names = (steps: readonly StepId[]): string => steps.map((step) => stepById(step).name).join(", ");

  write("");
  write(applied.changed.length > 0 ? `Setup is saved: ${names(applied.changed)}.` : "Setup is saved. No answer changed.");
  for (const note of applied.notes) write(note);

  const madeToken = applied.firstAccount?.token ?? null;
  if (applied.firstAccount && madeToken === null) {
    // Made for a link that was minted where HX Fortress was installed. There
    // is no link here to print or to keep.
    write(`The account ${applied.firstAccount.login} was made.`);
    write(linkIsElsewhere(applied.firstAccount.login));
  } else if (applied.firstAccount && madeToken !== null) {
    // Where the console will answer, by the console's own rule for its port.
    const ui = await new UiConfigStore(paths.uiConfig).load().catch(() => null);
    const port = consolePort(deps.env ?? process.env, ui?.port);
    const base = publicAddress(run.answers) || `http://127.0.0.1:${port}`;
    const link = setupUrl(base, madeToken);
    if (options.tty) {
      write(`The account ${applied.firstAccount.login} was made. Its password is set once, within 24 hours, at:`);
      write(`  ${link}`);
    } else {
      const file = bootstrapLinkPath(paths.uiRoot);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      // The console's own file for the first account's link.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await writeFile(file, `${link}\n`, { mode: 0o600 });
      write(`The account ${applied.firstAccount.login} was made. The link that sets its password is in ${file},`);
      write("which only HX Fortress's own user can read. It is not printed here. It works once, within 24 hours.");
    }
  }

  if (options.startsAfter) {
    write("HX Fortress starts now.");
    return;
  }
  const pid = await (deps.daemonPid ?? ((): Promise<number | null> => liveDaemonPid(paths)))().catch(() => null);
  if (pid === null) {
    if (options.mayStart && deps.start && deps.io && (await deps.io.confirm("Start HX Fortress now?", { default: true }))) {
      await deps.start();
    } else {
      write("Start HX Fortress: hx-fortress start");
    }
    return;
  }
  // A running HX Fortress follows a module's switch as soon as it is told.
  if (applied.changed.includes("modules")) signalDaemon(pid, deps.kill ?? process.kill);
  if (applied.restart.length > 0) {
    write(`These answers take effect when HX Fortress starts again: ${names(applied.restart)}.`);
    write("Restart it: hx-fortress stop, then hx-fortress start");
  }
}

export async function runSetupCommand(args: readonly string[], deps: SetupCommandDeps): Promise<number> {
  const write = deps.writeLine;
  const env = deps.env ?? process.env;
  const paths = fortressPaths(deps.fortressRoot);
  const flag = (name: string): boolean => args.includes(name);
  const valueOf = (name: string): string | null => {
    const at = args.indexOf(name);
    const value = at >= 0 ? args[at + 1] : undefined;
    return value && !value.startsWith("--") ? value : null;
  };

  // `--starts-after` is what a container's entry point passes: HX Fortress
  // starts when the setup ends, so the setup does not tell anybody to start it.
  const known = new Set([
    "--browser",
    "--file",
    "--from-environment",
    "--connect",
    "--pages",
    "--print",
    "--list",
    "--port",
    "--url",
    "--no-container",
    "--starts-after",
  ]);
  const unknown = args.find((arg) => arg.startsWith("--") && !known.has(arg));
  if (unknown || flag("--help")) {
    if (unknown) write(`error: unknown option ${/^--[a-z-]{1,32}$/.test(unknown) ? unknown : "(not shown)"}`);
    write(USAGE);
    return unknown ? 1 : 0;
  }

  // The list as a person is shown it: an option that is not in this build is
  // not printed, because a settings file that names it is refused.
  if (flag("--list")) {
    write(JSON.stringify(visibleList({ way: "setup", place: "here" }), null, 2));
    return 0;
  }

  // A control plane, and the one-time install id that connects to it. The
  // value holds the id, so a refusal never repeats it.
  let connect: Connect | null = null;
  if (flag("--connect") || flag("--pages")) {
    const parsed = parseConnect(valueOf("--connect"), valueOf("--pages"));
    if (!parsed.ok) {
      write(`error: ${parsed.reason}`);
      return 1;
    }
    connect = parsed.connect;
  }
  const runDeps: SetupRunDeps = { paths, env, ...(connect ? { connect } : {}), ...deps.run };

  if (args[0] === "link") {
    const link = await (deps.readFile ?? ((file: string): Promise<string> => readFile(file, "utf8")))(
      setupLinkPath(paths),
    ).catch(() => null);
    if (!link?.trim()) {
      write("No browser setup is waiting on this host. Start one: hx-fortress setup --browser");
      return 1;
    }
    write(link.trim());
    return 0;
  }

  if (flag("--browser")) {
    const port = valueOf("--port");
    if (flag("--port") && (!port || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
      write("error: --port needs a number from 1 to 65535");
      return 1;
    }
    return (deps.browser ?? runBrowserSetup)({
      paths,
      env,
      writeLine: write,
      ...(deps.isTty !== undefined ? { isTty: deps.isTty } : {}),
      port: port ? Number(port) : null,
      url: valueOf("--url"),
      noContainer: flag("--no-container"),
      startsAfter: flag("--starts-after"),
      ...(connect ? { connect } : {}),
      ...(deps.run ? { run: deps.run } : {}),
    });
  }

  const run = await SetupRun.open(runDeps);
  const audit = new SetupAudit(paths.auditSpool);

  if (flag("--print")) {
    // Written without a trailing blank line of its own: the text ends in one.
    write(settingsFileText(run.answers).trimEnd());
    return 0;
  }

  if (args[0] === "check") {
    const checks = await run.checkAll();
    printChecks(write, checks);
    const refused = refusalsOf(checks).length;
    write("");
    write(refused === 0 ? "Every answer passes its check." : `${refused} ${refused === 1 ? "answer is" : "answers are"} refused.`);
    return refused === 0 ? 0 : 1;
  }

  // `--from-environment` is what a container's entry point passes when an
  // install handed the settings over in the container's own settings. The
  // text is read from there, and is never on a command line.
  const fromEnvironment = flag("--from-environment");
  if (flag("--file") || fromEnvironment) {
    const file = valueOf("--file");
    let text: string;
    if (fromEnvironment) {
      // eslint-disable-next-line security/detect-object-injection
      text = env[SETUP_SETTINGS_ENV] ?? "";
      if (!text.trim()) {
        write(`error: ${SETUP_SETTINGS_ENV} holds no settings`);
        return 1;
      }
    } else {
      if (!file) {
        write("error: --file needs the path of a settings file");
        return 1;
      }
      try {
        text = await (deps.readFile ?? ((f: string): Promise<string> => readFile(f, "utf8")))(file);
      } catch {
        write(`error: the settings file ${file} could not be read`);
        return 1;
      }
    }
    const taken = run.takeFile(text);
    if (!taken.ok) {
      write(fromEnvironment ? `The settings in ${SETUP_SETTINGS_ENV} are refused:` : "The settings file is refused:");
      for (const line of taken.refusals) write(`  no  ${line}`);
      write("Nothing was saved.");
      return 1;
    }
    const result = await run.finish(fromEnvironment ? "install" : "file", { audit });
    printChecks(write, result.checks);
    if (!result.ok) {
      write("");
      write("Setup cannot finish: an answer is refused. Nothing was saved.");
      return 1;
    }
    await afterFinish(result, run, deps, { tty: false, mayStart: false, startsAfter: flag("--starts-after") });
    return 0;
  }

  // The questions, in this terminal.
  const only = args[0] ? stepNamed(args[0]) : null;
  if (args[0] && !only) {
    write(`error: ${/^[A-Za-z-]{1,32}$/.test(args[0]) ? args[0] : "that"} is not a question of the setup`);
    write(USAGE);
    return 1;
  }
  const tty = deps.isTty ?? ttyAvailable();
  if (!tty) {
    write("error: hx-fortress setup asks its questions in a terminal, and there is none here.");
    write("Give the answers as a file: hx-fortress setup --file <path>");
    write("Or answer in a browser, on a new install: hx-fortress setup --browser");
    return 1;
  }
  const io = deps.io ?? realIo(write);
  const outcome = await runTerminalSetup(run, io, {
    ...(only ? { only } : {}),
    end: { finish: () => run.finish("terminal", { audit }) },
  });
  if (outcome.ended !== "finished" || !outcome.result) return 1;
  const outputIsTty = deps.outputIsTty ?? deps.isTty ?? Boolean(process.stdout.isTTY);
  await afterFinish(outcome.result, run, { ...deps, io }, { tty: outputIsTty, mayStart: true });
  return 0;
}
