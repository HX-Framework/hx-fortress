// Console copy whose exact words are a decision — the two claims a page can get
// wrong without anything failing.
//
// PARITY. The Ops lede says which of this console's controls also exist as
// terminal verbs. It was "everything hx-fortress can do from a terminal", which
// is false in both directions: several console surfaces have no verb at all, and
// user management has no console surface. It is stated ONCE, here, with a
// CONTAINER arm — under an orchestrator there is no service to start and no
// binary to swap, so the host wording would promise two verb families the
// container flavor deliberately hides.
//
// RETENTION. Every retention figure this console prints comes from the server's
// derived facts (identity.retention), never from a number typed into a view. The
// four sites that used to carry hand-written figures — the audit tile, the log
// and audit-trail rows on Compliance, and the audit-history note on Residency —
// render those strings verbatim. A test asserts no day-count literal survives in
// ui/src, because a hard-coded "90 days on disk" stays plausible for years after
// the rotation policy changes underneath it.

/** The console-only surfaces, named once and shared by both lede arms. */
const CONSOLE_ONLY =
  "plus console-only surfaces: migration, checkup, residency proofs, reports, and console sign-in " +
  "sessions; user management and enrollment stay in the terminal (`hx-fortress ui user ...`)";

/**
 * What this page is, on a host that owns its own service.
 *
 * Deliberately not "session management": on a console whose primary noun is the
 * HX session, that phrase advertises a capability the product does not ship.
 */
export const OPS_LEDE_HOST =
  `The service, update, credential and diagnostic verbs — with output inline — ${CONSOLE_ONLY}.`;

/** The same page under an orchestrator, which owns the lifecycle and the image. */
export const OPS_LEDE_CONTAINER =
  `The credential and diagnostic verbs — with output inline — ${CONSOLE_ONLY}; ` +
  "service and update are owned by your orchestrator.";

export function opsLede(container: boolean): string {
  return container ? OPS_LEDE_CONTAINER : OPS_LEDE_HOST;
}

/** Beside the console's own sign-in sessions. A revoked session is a closed tab,
 *  not a closed account, and an operator who confuses the two leaves an account
 *  live while believing they revoked it. */
export const OPS_SESSION_LINE =
  "Revoking a sign-in session does not disable the login — `hx-fortress ui user disable` is the " +
  "terminal remedy.";

/** Above the Command Line panel, which is generated from the CLI help registry.
 *  It is the complete verb reference; it is not a claim that every console
 *  control has a verb, which is what the lede above exists to say. */
export const COMMAND_SURFACE_NOTE =
  "Every `hx-fortress` verb, generated from the registry `hx-fortress help` prints — so this list " +
  "cannot go stale. Some console surfaces have no terminal equivalent; the lede above names them.";

/** Row labels for the retention panel. The VALUES are server-derived and are
 *  never written here. */
export const RETENTION_LABELS = {
  transcripts: "Transcripts (bucket)",
  versioning: "Bucket versioning",
  logs: "Fortress logs",
  auditTrail: "Audit trail",
} as const;

/**
 * The two things an adoption page can say when it has no roster, which are NOT
 * the same thing.
 *
 * A fortress that has never received a sync knows nothing about the
 * organization's size; one that received a sync reporting nobody knows the
 * organization has no active members. Rendering both as "no people" would show
 * an unconfigured tunnel as an empty company.
 */
export const ROSTER_ABSENT_COPY =
  "let.ai has not sent this fortress a roster yet, so there is no list of people to compare against. " +
  "Everything below is what this host has observed for itself; a coverage figure would need a " +
  "denominator this fortress does not have.";

export const ROSTER_EMPTY_COPY =
  "let.ai reports no active members for this organization. Anyone sending to this fortress appears " +
  "below as unclaimed.";
