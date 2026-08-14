// The residency verdict matrix, and the words each verdict is allowed to use.
//
// The distinction that governs everything here: THE INCIDENT is
// `not_delivered_here` — a session that should be on this fortress and is not.
// `also_at_letai` is a separate, weaker finding: the object IS here, and a
// historical copy also exists at let.ai. Collapsing the two would either raise
// a permanent alarm about bytes that predate the fortress, or bury a genuine
// delivery failure under a label an operator has learned to acknowledge.
//
// Severity is LAYERED, not contradictory. Per SESSION, `also_at_letai` fails the
// residency check until it is acknowledged. In the FLEET roll-up an acknowledged
// one qualifies the verdict and never fails it. `not_delivered_here` is never
// downgraded by an acknowledgement — an acknowledgement says "we know why a copy
// exists there", and no answer to that question makes a missing object present.

/** Every verdict, as a VALUE — so a caller that has to partition the matrix
 *  (the console's findings page partitions it by `sessionCheckPasses`) derives
 *  the partition from this list instead of restating one that drifts. */
export const RESIDENCY_VERDICTS = [
  "confirmed",
  "also_at_letai",
  "not_delivered_here",
  "no_record",
  "copy_unchecked",
  "missing_here",
  "lanes_hold_it",
  "residency_unchecked",
  "residency_unwitnessable",
  "unknown_provenance",
  "not_applicable",
] as const;

export type ResidencyVerdict = (typeof RESIDENCY_VERDICTS)[number];

/** What was actually observed for one session. */
export interface VerdictInput {
  /** The transcript object is in this fortress's bucket. */
  fortressPresent: boolean;
  /** let.ai reports a copy of this session's bytes. */
  letaiCopy: boolean;
  /** let.ai holds ANY per-destination record for this session. Absent records
   *  predate destination tracking and are benign legacy, not an incident.
   *  Deliberately NOT the incident key — see `hubRoutedHere`. */
  anyDestinationRecord: boolean;
  /** let.ai recorded a delivery to THIS fortress. The narrow fact the incident
   *  verdict rests on: a destination row that points somewhere else says nothing
   *  about what this appliance was sent. */
  hubRoutedHere: boolean;
  /** How the session first reached this fortress. */
  ingestChannel: string | null;
  /** An acknowledgement already exists for this session. */
  acknowledged: boolean;
  /** This session records turns of its own. A turn-less parent stub keeps its
   *  bytes under the agent-lane prefixes, so no object under the parent prefix
   *  is expected. */
  hasOwnTranscript: boolean;
  /** At least one `:a:<agentId>` lane object exists for this session. Checked
   *  rather than assumed: a stub with no lane objects either has lost its bytes
   *  or never received them, and exempting it on the theory that they live
   *  elsewhere would erase the only surface that says so. */
  hasLaneObject: boolean;
  /** This session's id may be SENT at all. An unattributed row is withheld by
   *  design — `org_id IS NULL` means attribution was absent, so on a host that
   *  ever served a second organization it may not be this one's. */
  witnessAskable: boolean;
  /** The witness ANSWERED for this run. When it did not, `letaiCopy` and
   *  `anyDestinationRecord` are absences of an answer rather than answers, and a
   *  session missing from this bucket cannot be told apart from benign legacy. */
  witnessAnswered: boolean;
}

/** Eligibility, fail-private: only a cloud-relayed session may have its id sent
 *  to the witness at all. */
export function witnessEligible(ingestChannel: string | null): boolean {
  return ingestChannel === "tunnel";
}

export function verdictFor(input: VerdictInput): ResidencyVerdict {
  // Ahead of the eligibility gate, because a session with no transcript of its
  // own has no expected object on ANY channel. Placing it inside the ineligible
  // arm left a tunnel-channel stub — which `ingestAgentCommit` creates whenever a
  // child chunk arrives first over the tunnel — failing the fleet verdict, with
  // remediation telling the operator to restore data that was never under that
  // prefix.
  //
  // The lane object is CHECKED. Exempting on the theory that the bytes live
  // elsewhere, without looking, would silently erase a session whose parent and
  // every lane are empty.
  if (
    !input.fortressPresent &&
    !input.hasOwnTranscript &&
    input.hasLaneObject &&
    // ...and the hub is not saying it routed a parent transcript HERE. Moving
    // this ahead of the eligibility gate made it catch tunnel rows too, and
    // without this clause it swallowed `not_delivered_here` — the one incident
    // R8/R9 says is never downgraded. The hub writes its destination row inside
    // the parent commit, independently of the forward to this fortress, so "stub
    // with lanes" and "the parent never arrived" are reachable at once. The
    // NARROW fact, matching what the incident is keyed on: a destination row
    // pointing elsewhere is not a parent this fortress was sent. Gateway and
    // reconciled rows are never asked, so this is already false for them.
    !input.hubRoutedHere &&
    // ...and that "no destination record" is an ANSWER, not an absence. It is
    // false-by-default whenever the witness returned null or the row was never
    // asked about, so without this the exemption sat ahead of the
    // residency_unchecked guards and turned an unanswered question into a pass —
    // the same substitution this file condemns a few lines below.
    (!witnessEligible(input.ingestChannel) || input.witnessAnswered)
  ) {
    // Its own verdict, not `unknown_provenance`: the channel IS recorded, and
    // saying otherwise states a false fact on a compliance surface and inflates
    // the unknown-provenance count.
    return "lanes_hold_it";
  }
  if (!witnessEligible(input.ingestChannel)) {
    // Presence FIRST, inside this arm. Whether the object is still in the bucket
    // is a local fact that needs no witness, and the engine has already paid a
    // HEAD to establish it — but this gate used to return before reading it, so
    // for every gateway, reconciled and NULL-channel session a vanished
    // transcript read as "nothing to do, this fortress is the only place these
    // bytes were ever sent", and `recordFindings` drops `not_applicable`, so the
    // loss left no row anywhere.
    //
    // Only in this arm: for a witness-eligible session an absent object already
    // has verdicts that say MORE than "missing" — not_delivered_here when let.ai
    // recorded a delivery here, residency_unchecked when nobody answered — and
    // testing presence ahead of the gate would make both unreachable.
    if (!input.fortressPresent) return "missing_here";
    // Present, and never named to let.ai, so there is nothing to ask about — and
    // one whose channel is unknown must not be assumed to be either.
    return input.ingestChannel === "gateway" ? "not_applicable" : "unknown_provenance";
  }
  if (input.fortressPresent) {
    if (input.letaiCopy) return "also_at_letai";
    // `confirmed` says "let.ai reports no copy". `letaiCopy` is false BY DEFAULT
    // whenever the witness was off, unreachable, or this row was left out of the
    // ask, so returning it unguarded asserted the absence of a copy from a
    // question nobody put — the same substitution 0020 removed from the absent
    // branch. The object really is here either way, so this qualifies the run
    // rather than failing it.
    return input.witnessAnswered ? "confirmed" : "copy_unchecked";
  }
  // Absent from this bucket, and nobody answered. `no_record` would assert that
  // let.ai holds no delivery record — a positive claim about a question never
  // put — and it is the verdict remediation calls benign legacy, so the incident
  // this audit exists to surface would read as nothing to do.
  // Two different silences. "Nobody could answer" is recoverable — re-run when
  // let.ai is reachable. "This id is never sent" is not: an unattributed session
  // is deliberately withheld, so telling the operator to re-run leaves the fleet
  // verdict stuck at failed with an instruction that can never clear it.
  if (!input.witnessAskable) return "residency_unwitnessable";
  if (!input.witnessAnswered) return "residency_unchecked";
  // `hubRoutedHere`, not `anyDestinationRecord`. The narrative this verdict
  // renders — "let.ai recorded THIS fortress as a destination and the object is
  // not here" — is only true of the narrow fact. A session whose one destination
  // row points somewhere else (a let.ai-hosted destination, another fortress) is
  // not one this appliance failed to receive, and this verdict is deliberately
  // non-acknowledgeable, so over-reporting it left an operator with a failed
  // compliance surface and nothing they could do about it.
  if (input.hubRoutedHere) return "not_delivered_here";
  // Gone, and the hub holds no delivery record. `no_record` reads as benign
  // legacy — "predates per-destination tracking, nothing to do" — and says
  // nothing about the absent transcript, so a row that claims a transcript whose
  // bytes are missing would PASS. The identical facts on a gateway row return
  // `missing_here` and fail; only the channel differed.
  //
  // A STUB WITH NO LANE OBJECT is the same loss wearing the other shape. The
  // exemption at the top of this function is `lanes_hold_it` — the bytes are
  // under the lane prefixes — and it requires a lane object to actually be
  // there. Reaching here without one means neither the parent prefix nor any
  // lane holds anything, on the one channel agent-lane sessions arrive over.
  // Asking only about `hasOwnTranscript` let exactly that read as benign.
  if (input.hasOwnTranscript || !input.hasLaneObject) return "missing_here";
  // Unreachable as the matrix now stands, and deliberately kept. The one shape
  // that could land here — a stub whose lanes DO hold the bytes — is claimed by
  // `lanes_hold_it` at the top of this function, which is a truer answer than
  // "benign legacy". The verdict itself stays because `hx.audit_runs.no_record`
  // is a stored counter: runs recorded before 0023 still render through
  // VERDICT_HEADLINE and VERDICT_CAUSE, and dropping it would leave their rows
  // with a verdict nothing can describe.
  return "no_record";
}

/** Whether the PER-SESSION residency check passes. An unacknowledged
 *  also_at_letai fails it; an acknowledged one does not. */
export function sessionCheckPasses(verdict: ResidencyVerdict, acknowledged: boolean): boolean {
  if (verdict === "not_delivered_here") return false;
  // The object this fortress claims to hold is not in its bucket. Local, certain,
  // and independent of anything let.ai says.
  if (verdict === "missing_here") return false;
  // Fails, because the object really is missing from this fortress. What is
  // unknown is only WHY, and an unknown is not a pass on a compliance surface.
  if (verdict === "residency_unchecked") return false;
  if (verdict === "residency_unwitnessable") return false;
  if (verdict === "also_at_letai") return acknowledged;
  return true;
}

/** Whether an operator can clear this finding by acknowledging it. Only the
 *  weaker one: acknowledging a missing object would be acknowledging a fact
 *  rather than explaining one. */
export function acknowledgeable(verdict: ResidencyVerdict): boolean {
  return verdict === "also_at_letai";
}

export const VERDICT_HEADLINE: Record<ResidencyVerdict, string> = {
  confirmed: "held here, and let.ai reports no copy",
  copy_unchecked: "held here; let.ai was not asked whether it also holds a copy",
  also_at_letai: "held here, and a historical let.ai copy exists",
  not_delivered_here: "should be on this fortress, and is not",
  no_record: "no destination record at let.ai — predates per-destination tracking",
  lanes_hold_it: "no transcript of its own — its agent lanes hold the bytes, and they are here",
  missing_here: "this fortress claims this session, and its transcript is not in the bucket",
  residency_unwitnessable: "missing from this fortress, and not a session let.ai can be asked about",
  residency_unchecked: "missing from this fortress, and the witness did not answer",
  unknown_provenance: "upload channel unknown — not verified with let.ai",
  not_applicable: "not checked with let.ai — uploaded directly; id never sent",
};

/** Why a verdict happened, and what to do about it. Pinned: the same sentence
 *  renders in the finding, in the per-session proof and on the tile. */
export const VERDICT_CAUSE: Record<ResidencyVerdict, string> = {
  confirmed: "the transcript is in this organization's bucket and let.ai reports no copy of it",
  copy_unchecked:
    "the transcript is in this organization's bucket, and no answer came back about whether let.ai also holds a copy",
  also_at_letai: "bytes at let.ai predate this fortress, or the session is also attributed to a let.ai-hosted org",
  not_delivered_here: "let.ai recorded this fortress as a destination and the object never arrived",
  no_record: "this session was uploaded before let.ai recorded per-destination delivery",
  lanes_hold_it: "the parent row records no turns and at least one agent-lane object exists for it",
  missing_here: "the session row is live here and no canonical object exists under its prefix",
  residency_unwitnessable:
    "the object is not in this organization's bucket, and the session has no attribution, so its id is withheld from let.ai by design",
  residency_unchecked:
    "the object is not in this organization's bucket, and no answer came back about whether let.ai ever routed it here",
  unknown_provenance:
    "this session's row predates channel tracking, or it was recovered after an index outage",
  not_applicable: "this session was uploaded straight to this fortress; its id was never sent to let.ai",
};

export const VERDICT_REMEDIATION: Record<ResidencyVerdict, string> = {
  confirmed: "nothing to do",
  copy_unchecked:
    "nothing to do about the object — it is here; re-run with the cloud witness on, or once let.ai is reachable, if you need the copy question answered too",
  also_at_letai:
    "acknowledge it once you have confirmed which of the two causes applies; the acknowledgement is kept per session and inherited by later runs",
  not_delivered_here:
    "re-upload the session from the client that holds it, or ask let.ai to re-deliver it; this one is not acknowledgeable",
  no_record: "nothing to do — it is benign legacy, and it qualifies the verdict rather than failing it",
  lanes_hold_it:
    "nothing to do — this session records no turns of its own; its bytes are under its agent lanes, which are present",
  missing_here:
    "the transcript is gone from this fortress's own bucket; restore it from a client that still holds the session, or from a bucket version if object versioning is on",
  residency_unwitnessable:
    "the transcript is missing here and this session carries no organization attribution, so its id is never sent to let.ai; restore it from a client that still holds the session, or attribute the session and re-run",
  residency_unchecked:
    "the object is missing from this fortress and the cloud witness did not answer, so it cannot be told apart from benign legacy; re-run the audit once let.ai is reachable, or with the cloud witness on",
  unknown_provenance:
    "nothing to do per session; the share of these qualifies every verdict this run produces",
  not_applicable: "nothing to do — this fortress is the only place these bytes were ever sent",
};

/** The sub-cause an unknown-provenance session carries, rendered from the value
 *  rather than from a second lookup — a `reconciled` session reports unknown
 *  provenance, never not_applicable. */
export function unknownProvenanceCause(ingestChannel: string | null): string {
  return ingestChannel === "reconciled"
    ? "recovered after an index outage, so its original channel is not recorded"
    : "predates channel tracking";
}

export interface RollUpCounts {
  sessionsChecked: number;
  confirmed: number;
  /** Held here, on a run that never asked let.ai about it. */
  copyUnchecked: number;
  alsoAtLetai: number;
  alsoAtLetaiAcknowledged: number;
  notDeliveredHere: number;
  noRecord: number;
  missingHere: number;
  lanesHoldIt: number;
  residencyUnchecked: number;
  residencyUnwitnessable: number;
  unknownProvenance: number;
  notApplicable: number;
}

export type FleetVerdict = "clean" | "qualified" | "failed";

/** Whether let.ai was asked about this run's eligible sessions at all. The three
 *  states are different facts and the roll-up says which one it was: an operator
 *  who switched the witness off knows why nothing was checked, and one whose hub
 *  is unreachable must not be told the same thing. */
export type WitnessState = "attested" | "off" | "unavailable";

/** Why no let.ai copy was checked, named. Never "no copy was found": nothing was
 *  asked, and the two read identically only to someone who was not there. */
export const WITNESS_UNCHECKED_NOTE: Record<Exclude<WitnessState, "attested">, string> = {
  off: "the cloud witness is switched off, so no session id left this host and no let.ai copy was checked",
  unavailable: "let.ai could not be asked for this run, so no let.ai copy was checked",
};

/**
 * The fleet roll-up, TRI-STATE and never clean without a fresh posture.
 *
 * A run that could not ask let.ai has not proven anything about let.ai, and a
 * console that said "clean" on that basis would be reporting the absence of a
 * question as the absence of a copy.
 */
export function rollUp(
  counts: RollUpCounts,
  context: { fresh: boolean; witness?: WitnessState },
): { verdict: FleetVerdict; qualification: string } {
  if (counts.notDeliveredHere > 0) {
    return {
      verdict: "failed",
      qualification: `${counts.notDeliveredHere} session${counts.notDeliveredHere === 1 ? "" : "s"} should be on this fortress and ${counts.notDeliveredHere === 1 ? "is" : "are"} not`,
    };
  }
  // Fails at the roll-up too, not only per session. Leaving it to qualify would
  // make it behave exactly like the `no_record` it replaced, which is the
  // downgrade 0020 exists to undo: the object really is absent from this
  // fortress, and the unknown is only whether let.ai ever routed it here.
  // Ahead of the witness cases: an object missing from this fortress's own bucket
  // is certain, where an unanswered witness is only unknown.
  if (counts.missingHere > 0) {
    const n = counts.missingHere;
    return {
      verdict: "failed",
      qualification: `${n} session${n === 1 ? "" : "s"} this fortress claims ${n === 1 ? "is" : "are"} not in its bucket`,
    };
  }
  if (counts.residencyUnwitnessable > 0) {
    const n = counts.residencyUnwitnessable;
    return {
      verdict: "failed",
      qualification: `${n} session${n === 1 ? "" : "s"} missing here that let.ai cannot be asked about — ${n === 1 ? "it carries" : "they carry"} no organization attribution, so ${n === 1 ? "its id is" : "their ids are"} withheld by design`,
    };
  }
  if (counts.residencyUnchecked > 0) {
    const n = counts.residencyUnchecked;
    // Which silence it was, in the same sentence. This branch returns before the
    // notes block, and it fires ONLY when the witness did not answer — so the
    // note that distinguishes "switched off" from "unreachable" would otherwise
    // be unreachable in exactly the case it was written for, and the run history
    // could never say which one it had been.
    const witness = context.witness ?? "unavailable";
    const silence = witness === "attested" ? "the witness answered" : WITNESS_UNCHECKED_NOTE[witness];
    return {
      verdict: "failed",
      qualification: `${n} session${n === 1 ? "" : "s"} missing here that the witness could not account for — ${silence}`,
    };
  }
  const outstanding = counts.alsoAtLetai - counts.alsoAtLetaiAcknowledged;
  if (outstanding > 0) {
    return {
      verdict: "failed",
      qualification: `${outstanding} session${outstanding === 1 ? "" : "s"} also hold a let.ai copy and ${outstanding === 1 ? "has" : "have"} not been acknowledged`,
    };
  }
  const notes: string[] = [];
  if (counts.alsoAtLetaiAcknowledged > 0) {
    notes.push(
      `${counts.alsoAtLetaiAcknowledged} historical let.ai cop${counts.alsoAtLetaiAcknowledged === 1 ? "y" : "ies"}, acknowledged`,
    );
  }
  if (counts.unknownProvenance > 0) {
    notes.push(`${counts.unknownProvenance} of unknown upload channel`);
  }
  if (counts.notApplicable > 0) {
    notes.push(`${counts.notApplicable} uploaded directly and never named to let.ai`);
  }
  if (counts.noRecord > 0) {
    notes.push(`${counts.noRecord} predating per-destination tracking`);
  }
  if (counts.copyUnchecked > 0) {
    notes.push(
      `${counts.copyUnchecked} held here but never checked against let.ai — the object is present; the copy question was not put`,
    );
  }
  const witness = context.witness ?? "attested";
  if (witness !== "attested") {
    // One reason, not two. An unasked witness is ALSO why the posture cannot be
    // fresh for this run, and printing both would read as two independent
    // failures where there is one.
    notes.push(WITNESS_UNCHECKED_NOTE[witness]);
  } else if (!context.fresh) {
    notes.push("let.ai's own view of this organization could not be refreshed for this run");
  }
  if (notes.length === 0) {
    return { verdict: "clean", qualification: "every checked session is held here and nowhere else" };
  }
  return { verdict: "qualified", qualification: `qualified (${notes.join("; ")})` };
}
