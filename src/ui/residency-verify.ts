// Verifying ONE session, and refusing to say more than was checked.
//
// Three things can be asked about a session on this host: whether its metadata
// row is here, whether its transcript object is in the organization's bucket at
// the size the row claims, and whether any staging chunks were left behind by an
// upload that never composed. The fourth question - whether let.ai still holds a
// copy - is a CLOUD question, and this console does not ask it: the attested arm
// belongs to the task that owns the witness, so every verdict here reports the
// witness as NOT CHECKED rather than as clean.
//
// The proof text is built from the checks that actually ran. A dialog that
// printed the same five reassuring lines whatever it managed to do would be the
// green tick with nothing behind it, which is worse than no dialog at all.

import {
  sessionCheckPasses,
  verdictFor,
  VERDICT_CAUSE,
  VERDICT_HEADLINE,
} from "../console/audit-verdicts";

export type VerifyVerdict = "healthy" | "missing" | "mismatch" | "orphan" | "witness-unavailable";

export type CheckState = "passed" | "failed" | "not-checked";

export interface VerifyCheck {
  name: string;
  state: CheckState;
  detail: string;
}

export interface VerifyInput {
  family: string;
  sessionId: string;
  /** The metadata row, or null when this fortress holds none. */
  row: { bytesUploaded: number | null; ingestChannel: string | null; lastActivityAt: string | null } | null;
  /** Size of the canonical object, null when there is none, and UNDEFINED when
   *  the store could not be asked at all. The three are different answers. */
  canonicalBytes?: number | null;
  /** Staging chunks still present. Undefined when the listing was not run. */
  stagingOrphans?: number;
  /** Why the store could not be asked, when it could not. */
  storeUnavailable?: string;
  /** What the residency audit established about let.ai for this session.
   *  ABSENT means nobody asked, which is the state this dialog reports when the
   *  witness is switched off, unreachable, or the session is not eligible. */
  witness?: {
    letaiCopy: boolean;
    anyDestinationRecord: boolean;
    /** let.ai recorded a delivery to THIS fortress — the narrow fact the
     *  incident verdict is keyed on, carried rather than inferred from the one
     *  above. */
    hubRoutedHere: boolean;
    acknowledged: boolean;
  };
}

export interface VerifyResult {
  family: string;
  sessionId: string;
  verdict: VerifyVerdict;
  headline: string;
  checks: VerifyCheck[];
  /** The copy the operator can copy out. Reflects the checks above, nothing
   *  else - it is the artifact the proof-copy acknowledgement records. */
  proof: string[];
}

const HEADLINE: Record<VerifyVerdict, string> = {
  healthy: "This session is here, and its transcript is the size this fortress recorded.",
  missing: "This session's transcript is not in the bucket this fortress writes to.",
  mismatch:
    "This session's transcript is in the bucket at a different size from the one recorded here.",
  orphan: "This session left staging chunks behind that were never composed into its transcript.",
  "witness-unavailable":
    "This session could not be verified end to end: part of the check could not be run.",
};

/** The one sentence about the cloud, on every verdict. The console never asks
 *  let.ai here, and saying nothing would read as having asked and found nothing. */
export const WITNESS_NOT_CHECKED =
  "let.ai was not asked whether it still holds a copy. This check is local only, so its absence " +
  "is a scope, not a result.";

export function verifySessionResidency(input: VerifyInput): VerifyResult {
  const checks: VerifyCheck[] = [];
  const asked = input.canonicalBytes !== undefined;

  checks.push(
    input.row
      ? {
          name: "Metadata row",
          state: "passed",
          detail: `in this fortress's own database${
            input.row.ingestChannel ? `, arrived by ${input.row.ingestChannel}` : ""
          }`,
        }
      : { name: "Metadata row", state: "failed", detail: "this fortress holds no row for it" },
  );

  checks.push(
    asked
      ? input.canonicalBytes === null
        ? { name: "Transcript object", state: "failed", detail: "no canonical object under this session's prefix" }
        : { name: "Transcript object", state: "passed", detail: `${input.canonicalBytes} bytes in the organization's bucket` }
      : {
          name: "Transcript object",
          state: "not-checked",
          detail: input.storeUnavailable ?? "the object store could not be asked",
        },
  );

  const recorded = input.row?.bytesUploaded ?? null;
  const sizeComparable = asked && input.canonicalBytes !== null && recorded !== null;
  checks.push(
    sizeComparable
      ? recorded === input.canonicalBytes
        ? { name: "Recorded size", state: "passed", detail: `${recorded} bytes, matching the object` }
        : {
            name: "Recorded size",
            state: "failed",
            detail: `this fortress recorded ${recorded} bytes; the object is ${input.canonicalBytes}`,
          }
      : { name: "Recorded size", state: "not-checked", detail: "there is nothing to compare it against" },
  );

  checks.push(
    input.stagingOrphans === undefined
      ? {
          name: "Staging chunks",
          state: "not-checked",
          detail: input.storeUnavailable ?? "the object store could not be asked",
        }
      : input.stagingOrphans > 0
        ? { name: "Staging chunks", state: "failed", detail: `${input.stagingOrphans} left behind` }
        : { name: "Staging chunks", state: "passed", detail: "none left behind" },
  );

  // The ATTESTED arm. Present only when a run actually asked; every other case
  // still says the absence is a scope rather than a result.
  const attested = input.witness
    ? verdictFor({
        fortressPresent: input.canonicalBytes !== null && input.canonicalBytes !== undefined,
        letaiCopy: input.witness.letaiCopy,
        anyDestinationRecord: input.witness.anyDestinationRecord,
        hubRoutedHere: input.witness.hubRoutedHere,
        ingestChannel: input.row?.ingestChannel ?? null,
        acknowledged: input.witness.acknowledged,
        // This arm is built only when a run actually asked, so by construction.
        witnessAskable: true, witnessAnswered: true,
        // This surface is opened for one session the operator picked, and it has
        // already reported the object check on its own line above; the verdict
        // here is about the witness, so the parent-stub exemption does not apply.
        hasOwnTranscript: true,
        hasLaneObject: false,
      })
    : null;
  checks.push(
    attested
      ? {
          name: "let.ai copy",
          state: sessionCheckPasses(attested, input.witness?.acknowledged ?? false)
            ? "passed"
            : "failed",
          detail: `${VERDICT_HEADLINE[attested]} - ${VERDICT_CAUSE[attested]}`,
        }
      : { name: "let.ai copy", state: "not-checked", detail: WITNESS_NOT_CHECKED },
  );

  const verdict = verdictOf(input, asked);
  return {
    family: input.family,
    sessionId: input.sessionId,
    verdict,
    headline: HEADLINE[verdict],
    checks,
    proof: proofLines(input, verdict, checks),
  };
}

function verdictOf(input: VerifyInput, asked: boolean): VerifyVerdict {
  // Order matters: the honest "could not check" wins over every verdict that
  // would be an assertion about something nobody looked at.
  if (!asked) return "witness-unavailable";
  if (input.canonicalBytes === null) return "missing";
  if (!input.row) return "orphan";
  const recorded = input.row.bytesUploaded;
  if (recorded !== null && recorded !== input.canonicalBytes) return "mismatch";
  if ((input.stagingOrphans ?? 0) > 0) return "orphan";
  return "healthy";
}

function proofLines(input: VerifyInput, verdict: VerifyVerdict, checks: readonly VerifyCheck[]): string[] {
  const marks: Record<CheckState, string> = { passed: "checked", failed: "checked", "not-checked": "not checked" };
  return [
    `Session ${input.family}/${input.sessionId}`,
    HEADLINE[verdict],
    "",
    ...checks.map((check) => `${check.name}: ${marks[check.state]} - ${check.detail}`),
  ];
}
