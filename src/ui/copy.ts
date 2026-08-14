// Console copy that has to be identical everywhere it appears.
//
// The disclosure below is the D5 people-visibility statement. It prints before
// EVERY setup URL and every console URL the CLI emits — one constant, so the
// wizard, `ui user create`, `ui user reset` and `hx-fortress ui` cannot drift
// into four differently-honest versions of the same warning. A test asserts they
// are byte-identical.
//
// What it has to say is uncomfortable and says it anyway: a console login is not
// an organization membership, and the views behind it are people-keyed.

export const PEOPLE_VISIBILITY_DISCLOSURE: readonly string[] = [
  "Before you hand out access to this console, read what it grants:",
  "  Anyone who signs in to this console can see people data for this organization -",
  "  who is enrolled, what each person's activity looks like, session titles (which",
  "  may quote a first message) and where sessions were stored. Never transcript bodies.",
  "  Console logins are created here, on this host, by whoever has a shell on it.",
  "  They are not organization memberships, and the people holding them need not be",
  "  members of your organization.",
];

/** Printed under a setup URL. States the two properties the recipient needs to
 *  act on: it is one-time, and it dies on its own. */
export const SETUP_LINK_NOTE: readonly string[] = [
  "The link works once and expires in 24 hours. It carries no password — the person",
  "who opens it sets their own. Re-issue it with `hx-fortress ui user reset <login>`.",
];

/** The sign-in page's recovery guidance. Deliberately names the CLI verb: the
 *  person who is locked out cannot fix it, and the person who can needs to be
 *  told exactly what to run. */
export const SIGN_IN_RECOVERY_COPY =
  "Forgot your password, or locked out? Ask an administrator to run " +
  "`hx-fortress ui user reset <login>` on the fortress host — it sends you a fresh setup link.";

/** One answer for every failed sign-in. Naming the cause — unknown login, wrong
 *  password, disabled account — would answer "does this account exist?" for
 *  anyone who asks. */
export const SIGN_IN_FAILURE_COPY = "That login and password did not match.";

/** What a readonly account is told when it reaches a mutating route, and what
 *  its disabled controls say in the browser. One string, because a button whose
 *  tooltip disagrees with the server's refusal teaches the reader to distrust
 *  both. */
export const READONLY_REFUSAL_COPY =
  "this account is read-only; ask an administrator for an operator login";

/** Shown while a lockout delay is in force. Says nothing about whether the login
 *  exists, so it cannot be used to enumerate accounts either. */
export const LOCKOUT_COPY =
  "Too many attempts from this network. Wait a moment and try again, or ask an " +
  "administrator to run `hx-fortress ui user reset <login>`.";

/** `ui disable` against a console with no unit and no supervisor to tell. */
export function foregroundDisableRefusal(pid: number): string {
  return (
    `this console is running in the foreground — stop it with Ctrl-C, or \`kill ${pid}\`. ` +
    `\`ui disable\` flips the stored setting and stops a SERVICE; there is no service here to stop.`
  );
}

/** `ui disable` where enablement comes from the environment, which no file write
 *  can override. */
export const ENV_ENABLED_DISABLE_REFUSAL =
  "enabled by FORTRESS_UI_ENABLE — unset it on the service and redeploy. " +
  "Writing `enabled: false` here would change nothing: the environment wins, and the " +
  "supervisor would keep the console up.";

/** `ui disable` inside a container, where the console is a supervisor CHILD.
 *  There is no unit to stop and no terminal to Ctrl-C — the supervisor re-reads
 *  the setting and stops it, which is why the flip is the whole act here. */
export const CONTAINER_DISABLE_NOTE =
  "The container supervisor stops the console within a few seconds and will not restart it.";

/** What `ui disable` prints once it has actually done it. */
export const DISABLE_PROPAGATION_NOTE =
  "The workbench button disappears on the next tunnel reconnect (or daemon restart).";

/** `ui sso on` before the console is enabled. Two arms: a host installs a unit, a
 *  container has no unit to install. */
export function ssoRequiresEnablement(container: boolean): string {
  return container
    ? "the console is not enabled — set FORTRESS_UI_ENABLE=1 on the service and redeploy, then run this again"
    : "the console is not enabled — run `hx-fortress ui --install-service` first, then run this again";
}

/**
 * What turning one-click entry ON actually discloses, printed at every site that
 * turns it on — the wizard's combined prompt and `ui sso on`. One constant,
 * because the two used to say different amounts of the truth.
 *
 * It is uncomfortable and says it anyway: the URL travels on every reconnect, it
 * is visible to people outside this organization, and turning it off is not
 * retroactive — it stops the next reconnect from sending it.
 */
export const SSO_ON_DISCLOSURE: readonly string[] = [
  "Turning this on sends this console's public URL to let.ai:",
  "  It is re-sent on every reconnect, not once. Organization owners see it in the workbench,",
  "  and let.ai operators see it in their fleet view. `hx-fortress ui sso off` clears it on the",
  "  next reconnect; it does not unsend what has already been sent.",
  "  The URL conveys no capability on its own: a one-click arrival lands on this console's",
  "  sign-in form and can do nothing until a local account signs in.",
];

/** Stated on the audit panel. Failed public sign-ins are the one thing this
 *  system collapses, and the open window is the only thing a crash can cost — a
 *  console that implied otherwise would be claiming a completeness no
 *  write-ahead spool can give. */
export const OPEN_WINDOW_COPY =
  "Failed sign-ins are collapsed into one record per account, source and 5-minute window, " +
  "written when the window closes. A console that stops mid-window loses that window and " +
  "nothing else.";

/** Said by the service route, and by the disabled control, under an orchestrator.
 *  The verbs exist on a host with a unit; here the lifecycle belongs to whatever
 *  started the container, and a console that offered to restart it would be
 *  claiming an authority it does not have. */
export const CONTAINER_SERVICE_REFUSAL =
  "this fortress runs under a container orchestrator, which owns starting, stopping and " +
  "updating it. Use your orchestrator's controls.";

/** Said when the daemon has written no recent heartbeat. Told BEFORE the request
 *  is made: a row nobody polls for sits in the queue until its deadline and is
 *  then rejected, which reads as a failure of the work rather than of the ask. */
export const NO_POLLER_REFUSAL =
  "the daemon is not running, so nothing would pick this up. Start the fortress first.";

/** What every control that hands work to the daemon says about the answer it
 *  will render. The console reports the daemon's own record, not the fact that
 *  the request was accepted. */
export const COMMAND_REQUEST_NOTE =
  "The daemon does the work and records the result; this page shows its answer, not this " +
  "request's success.";
