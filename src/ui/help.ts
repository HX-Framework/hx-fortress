// The CLI help registry.
//
// One structure, two consumers: `hx-fortress help` renders it in the terminal,
// and the console's Command Line panel renders the same entries in the browser.
// They were separate lists once; the browser one went stale within a release,
// because nothing fails when a panel forgets a verb.
//
// Every verb belongs here, including the ones a human rarely types.

export interface HelpEntry {
  usage: string;
  summary: string;
}

export interface HelpSection {
  name: string;
  blurb: string;
  entries: readonly HelpEntry[];
}

export const CLI_HELP: readonly HelpSection[] = [
  {
    name: "fortress",
    blurb: "Run and inspect the daemon.",
    entries: [
      { usage: "hx-fortress", summary: "open the terminal dashboard" },
      { usage: "hx-fortress enroll [token] --cloud <url>", summary: "connect this host to an organization" },
      { usage: "hx-fortress start", summary: "install and start the service" },
      { usage: "hx-fortress start --reinstall", summary: "point the existing unit at this binary and start it" },
      { usage: "hx-fortress stop", summary: "stop the service" },
      { usage: "hx-fortress status", summary: "report what is running" },
      { usage: "hx-fortress host", summary: "run the daemon in the foreground" },
      { usage: "hx-fortress logs [--module <id>] [-n <lines>] [-f]", summary: "read the daemon log" },
      { usage: "hx-fortress update", summary: "download and install the latest release" },
      { usage: "hx-fortress credentials set <key>", summary: "replace a stored credential (reads stdin)" },
      { usage: "hx-fortress container-run", summary: "supervise the daemon and console in one container" },
    ],
  },
  {
    name: "console",
    blurb: "Serve and configure the administration console.",
    entries: [
      { usage: "hx-fortress ui", summary: "serve the console in the foreground" },
      { usage: "hx-fortress ui --install-service [--allow-insecure-bind]", summary: "install and start the console as a service" },
      { usage: "hx-fortress ui --uninstall-service", summary: "remove the console service, keeping its settings" },
      { usage: "hx-fortress ui enable", summary: "allow the console to run" },
      { usage: "hx-fortress ui disable", summary: "stop the console and revoke live sessions" },
      { usage: "hx-fortress ui config", summary: "print the effective configuration" },
      { usage: "hx-fortress ui config set <key> <value>", summary: "change one setting" },
      { usage: "hx-fortress ui config set databaseUrl --stdin", summary: "point the console at a database (reads stdin)" },
      { usage: "hx-fortress ui config --print-role-sql", summary: "emit the SQL that creates the console's database role" },
      { usage: "hx-fortress ui marker \"<phrase>\"", summary: "set the banner phrase people see on arrival" },
      { usage: "hx-fortress ui marker --clear", summary: "remove the banner phrase" },
    ],
  },
  {
    name: "residency audit",
    blurb: "The check that this fortress holds what it is supposed to hold.",
    entries: [
      { usage: "hx-fortress audit witness show", summary: "report whether session ids are sent to let.ai during an audit" },
      { usage: "hx-fortress audit witness on|off", summary: "turn that off, or back on" },
      { usage: "hx-fortress audit acks reconcile", summary: "list acknowledgements with no matching record in this host's trail" },
      { usage: "hx-fortress audit acks reconcile --re-confirm", summary: "write those acknowledgements again, through the fenced routine" },
    ],
  },
  {
    name: "roster",
    blurb: "The people let.ai reports for this organization, and how long departures are kept.",
    entries: [
      {
        usage: "hx-fortress roster purge-inactive [--days <n>]",
        summary: "remove directory rows for members who left more than the retention ago",
      },
    ],
  },
  {
    name: "console users",
    blurb: "Who may sign in. No password is ever typed here.",
    entries: [
      { usage: "hx-fortress ui user create <login> --role operator|readonly", summary: "create an account and print its setup link" },
      { usage: "hx-fortress ui user list", summary: "list accounts and their state" },
      { usage: "hx-fortress ui user disable <login>", summary: "block sign-in and kill live sessions" },
      { usage: "hx-fortress ui user delete <login>", summary: "remove an account" },
      { usage: "hx-fortress ui user reset <login>", summary: "clear a lockout and print a fresh setup link" },
    ],
  },
  {
    name: "console sso",
    blurb: "The one-click entry from the workbench.",
    entries: [
      { usage: "hx-fortress ui sso on", summary: "advertise the console URL to let.ai" },
      { usage: "hx-fortress ui sso off", summary: "stop advertising it" },
    ],
  },
];

/** Flags that apply to more than one verb, listed once. */
export const GLOBAL_HELP_NOTES: readonly string[] = [
  "--force-unlock   take a console state file whose lock was left behind by a killed writer",
];

export function renderHelp(): string[] {
  const lines: string[] = ["hx-fortress"];
  for (const section of CLI_HELP) {
    lines.push("", `${section.name} — ${section.blurb}`);
    const width = Math.max(...section.entries.map((e) => e.usage.length));
    for (const entry of section.entries) {
      lines.push(`  ${entry.usage.padEnd(width)}  ${entry.summary}`);
    }
  }
  lines.push("", ...GLOBAL_HELP_NOTES.map((note) => `  ${note}`));
  return lines;
}

/** Flat view for the console's Command Line panel. */
export function helpEntries(): HelpEntry[] {
  return CLI_HELP.flatMap((section) => [...section.entries]);
}
