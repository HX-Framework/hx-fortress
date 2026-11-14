// The action vocabulary, and what may be recorded alongside each act.
//
// Its own module because three consumers need it and only one of them runs on a
// server: the writers name their acts from here, and the console's disabled-
// window markers key on the two enablement transitions. A browser bundle that
// reached these constants through the spool WRITER would pull the filesystem in
// with them.

// `shape.ts` imports nothing, so a browser bundle can follow this import too.
import { isName } from "../host/shape";
import { redactCredentials } from "../ui/redact";

// ── The action vocabulary ────────────────────────────────────────────────────
// Every writer names its acts from here, because the console filters, the
// disabled-window markers and the retrofit tests all key on these strings.

export const AUDIT_ACTIONS = {
  signIn: "console.signin",
  signInFailed: "console.signin.failed",
  signOut: "console.signout",
  setupOpened: "console.setup.opened",
  setupFailed: "console.setup.failed",
  setupCompleted: "console.setup.completed",
  ssoExchange: "console.sso.exchange",
  ssoExchangeFailed: "console.sso.exchange.failed",
  /** ONE marker when a window produced more distinct failure records than the
   *  per-window ceiling allows. */
  authOverflow: "console.auth.overflow",
  /** Prefix; the export's own name completes it. */
  exportPrefix: "console.export.",
  exportOverflow: "console.export.overflow",
  /** The CLI reclaimed its own oldest files to stay inside the cap. */
  spoolReclaimed: "console.spool.reclaimed",
  /** A drained record disagrees with the one already in the table. */
  integrityError: "console.audit.integrity_error",
  /** A terminal command row no daemon record agrees with. */
  commandDisputed: "console.command.disputed",
  /** The console asked the daemon to do something. */
  commandSubmitted: "console.command.submit",
  /** The console drove the daemon's own unit. One prefix, one arm per action. */
  servicePrefix: "console.service.",
  cliUpdate: "cli.update",
  cliEnable: "cli.ui.enable",
  cliDisable: "cli.ui.disable",
  cliPrefix: "cli.ui.",

  // ── Modules, asks and releases ─────────────────────────────────────────────
  // Three actors write these, and the prefix says which: `control_plane.` is
  // something the control plane did or tried to do, `cli.` is a person at the
  // terminal, `system.` is this fortress acting on a decision, and `module.` is
  // a module recording its own work.

  /** One ask from the control plane to a module. A pair when the ask ran (the
   *  intent is on disk before the module is called); a single `refused` record
   *  when the gate turned it away. Refusals collapse: see `attempts`.
   *
   *  The module host also writes this action, and `system.module.refused`, with
   *  `.overflow` added. That is one count of refusals for organizations other
   *  than the fortress's own that were not written one by one: see
   *  `REFUSAL_OVERFLOW_SUFFIX` in src/host/module-audit.ts. */
  controlPlaneAsk: "control_plane.ask",
  /** The control plane offered a release for a module. */
  controlPlaneReleaseOffer: "control_plane.release.offer",
  /** The control plane asked for a module to be removed. Always refused. */
  controlPlaneModuleRemove: "control_plane.module.remove",
  /** `hx-fortress modules on|off <id>`. */
  cliModuleOn: "cli.module.on",
  cliModuleOff: "cli.module.off",
  /** `hx-fortress releases approve|refuse <id>`. */
  cliReleaseApprove: "cli.release.approve",
  cliReleaseRefuse: "cli.release.refuse",
  /** The daemon started or stopped a module because its switch changed. */
  moduleSwitched: "system.module.switch",
  /** The daemon recorded a person's decision about a release. */
  releaseApproved: "system.release.approved",
  releaseRefused: "system.release.refused",
  /** The daemon handed an approved release to its module. A pair: the intent is
   *  on disk before the module is called. */
  releaseInstall: "system.release.install",
  /** A module refused itself something its manifest does not declare: a secret
   *  name, or a host to call. */
  moduleRefused: "system.module.refused",
  /** Prefix; `<module id>.<the module's own action>` completes it. */
  modulePrefix: "module.",
} as const;

/**
 * The per-action parameter allowlist.
 *
 * Longest matching PREFIX wins, and an action with no entry records no
 * parameters at all. That direction is deliberate: a new act that forgets to
 * declare its parameters loses them from the trail, where the other direction
 * would put whatever it happened to pass — a password, a DSN, a setup token —
 * into a table with no DELETE.
 */
/** Marks the one prefix whose parameter NAMES are not listed here.
 *
 *  A module's own records (`module.<id>.<action>`) carry detail fields the
 *  module chose, so the rule cannot be a list of names. It is a rule of form
 *  instead, and a stricter one than a listed action gets: the name must be one
 *  word, and a string value must be a NAME — at most 128 characters of letters,
 *  digits, space and `_ . : / @ -`. There is no free text in a module's record,
 *  for the same reason there is none in a reply. A value that does not fit is
 *  left out rather than trimmed into something that looks deliberate. */
const MODULE_DETAIL: readonly string[] = Object.freeze(["*"]);
const MODULE_DETAIL_KEY = /^[a-z][A-Za-z0-9]{0,31}$/;

const PARAM_ALLOWLIST: Record<string, readonly string[]> = {
  // `method` and `subject` are recorded for a sign-in through the identity
  // provider: which way the person came in, and the provider's own id for them.
  "console.signin": ["login", "role", "remote", "attempts", "from", "to", "controlPlaneSub", "method", "subject"],
  "console.signout": ["login", "role"],
  "console.setup": ["login", "role", "remote", "attempts", "from", "to"],
  "console.sso": ["org", "controlPlaneSub", "remote", "attempts", "from", "to"],
  "console.auth.overflow": ["ceiling", "windows", "from", "to"],
  "console.export.": ["format", "generatedAt", "from", "to", "action", "actor", "origin", "module", "level", "lines", "acknowledgedAt", "session", "sessionId", "family", "verdict"],
  "console.export.overflow": ["ceiling", "day", "session"],
  "console.spool.reclaimed": ["files", "records", "from", "to", "bytes"],
  "console.audit.integrity_error": ["spoolFileId", "seq", "field"],
  "console.command.disputed": ["commandKind", "arm", "expectedDigest", "records"],
  "console.command.outcome": ["commandKind", "terminalStatus", "resultDigest", "accepted", "transition", "reason"],
  // `credentialRef` is on this list on purpose: it NAMES the indirection, and the
  // whole reason the reference exists is that the secret it points at never
  // travels on the command. Without it in the trail the corroboration D15 rests
  // on is one-sided — the daemon records consuming a reference the console's own
  // submission record does not carry.
  // `reason` is here rather than on a longer key: the action a submission
  // records is exactly `console.command.submit`, so a `console.command.submit.
  // acknowledge` entry matched nothing and quietly stripped the one field an
  // acknowledgement exists to carry — the operator's stated reason, which is the
  // whole evidentiary value of the record.
  "console.command.submit": ["commandKind", "commandId", "credentialRef", "phase", "scope", "enabled", "org", "session", "sessionId", "reason"],
  "console.service.": ["action", "manager", "pid", "state"],
  "cli.ui.": ["login", "role", "key", "value", "phrase", "sessionEpoch", "state"],
  "cli.update": ["binPath", "asset", "version"],
  "system.": ["engine", "kind", "count", "dropped", "reason", "from", "to"],
  // `rule` is the check that refused the act, from a fixed vocabulary, and
  // `field` is where in the ask's declared shape an argument broke it. `attempts`,
  // `from` and `to` are what a collapsed run of identical refusals carries in
  // place of one record each. `module`, `ask` and `version` are written only once
  // they are known to this build or have passed their own pattern; a name the
  // control plane invented is never copied into the trail.
  // `grant` is a digest this host computed of a grant's id: see ask-gate.ts.
  "control_plane.ask": ["module", "ask", "rule", "field", "attempts", "from", "to", "grant"],
  "control_plane.release.": ["module", "version", "release", "rule", "signedBy", "bytes", "attempts", "from", "to"],
  "control_plane.module.": ["module", "rule", "attempts", "from", "to"],
  "cli.module.": ["module", "state"],
  "cli.release.": ["release", "module", "version"],
  "system.module.": ["module", "state", "rule", "attempts", "from", "to"],
  "system.release.": ["release", "module", "version", "signedBy", "decidedBy"],
  // A module names its own detail fields, so there is no list to hold them to.
  // What holds instead is the form: see MODULE_DETAIL below.
  "module.": MODULE_DETAIL,
};

/** Key names that never reach the spool whatever an action declares. The
 *  allowlist already excludes them; this is the belt that survives an edit to
 *  the allowlist made in a hurry. */
const SECRET_KEYS = /pass|secret|token|credential|dsn|databaseurl|hash|key$|apikey/i;

/** Longest value a parameter may carry. A record is evidence, not a payload. */
const MAX_PARAM_CHARS = 200;

/** Longest actor a record may name. Real actors are a login (≤64 by the login
 *  rule) or a short system label, so this clamps nothing that exists — but the
 *  actor on a failed sign-in is a string an UNAUTHENTICATED caller chose, and
 *  the collapse that bounds those records bounds their COUNT, not their size. */
export const MAX_ACTOR_CHARS = 128;

/** The actor as it may be written down. Applied at the spool, under every
 *  caller, because "who did this" is the one field an anonymous request gets to
 *  influence. */
export function clampActor(actor: string | null): string | null {
  if (actor === null) return null;
  return actor.length <= MAX_ACTOR_CHARS ? actor : `${actor.slice(0, MAX_ACTOR_CHARS)}…`;
}

export function sanitizeParams(
  action: string,
  params: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!params) return null;
  let allowed: readonly string[] = [];
  let matched = -1;
  for (const [prefix, keys] of Object.entries(PARAM_ALLOWLIST)) {
    if (action.startsWith(prefix) && prefix.length > matched) {
      matched = prefix.length;
      allowed = keys;
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    // The one carve-out. It is safe for reasons about this value specifically,
    // not by appeal to another module: the reference is minted server-side, is
    // 32 random hex naming a 0600 file that is unlinked on read, is unreachable
    // by client input, and only `console.command.submit` carries it. What it
    // names never travels. Without the carve-out the secret-shaped belt drops
    // the very field the allowlist just admitted.
    //
    // (`command-params.ts` refuses a `credentialRef` PARAMETER, which is the
    // opposite rule for the opposite reason: on that path the reference belongs
    // in the row's column, not in caller-supplied params.)
    const open = allowed === MODULE_DETAIL;
    if (open ? !MODULE_DETAIL_KEY.test(key) : !allowed.includes(key)) continue;
    if (key !== "credentialRef" && SECRET_KEYS.test(key)) continue;
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      if (open && typeof value === "number" && !Number.isFinite(value)) continue;
      out[key] = value;
    } else if (typeof value === "string") {
      if (open && !isName(value)) continue;
      out[key] = redactCredentials(value).slice(0, MAX_PARAM_CHARS);
    }
  }
  return Object.keys(out).length === 0 ? null : out;
}
