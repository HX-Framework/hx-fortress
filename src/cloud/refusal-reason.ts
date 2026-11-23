// The word a refused connection is kept with: in the daemon's log and status
// file, and on the console's Settings page, which reads that file.
//
// A module of its own, with no imports, so the console can hold a reason to
// the daemon's rule without loading the connection itself.

/** The word the status file and the log hold in place of a reason that is not
 *  one word. */
export const REASON_WITHHELD = "reason_withheld";
const REASON_WORD = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * The reason the control plane gave for refusing the connection, as this
 * HX Fortress keeps it.
 *
 * A reason is a word such as `invalid_credential`, and a word is kept as it
 * is. Anything else is text the control plane chose, of any length up to the
 * frame cap. It would go into the log and the status file in full, so it is
 * replaced with one fixed word.
 */
export function refusalReason(reason: unknown): string {
  return typeof reason === "string" && REASON_WORD.test(reason) ? reason : REASON_WITHHELD;
}
