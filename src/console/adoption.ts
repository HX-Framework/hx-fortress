// Adoption, and where every number in it comes from.
//
// The page answers "whose machines have worked here, and who is still using
// them" — a question with two halves that must never be blended. The hub knows
// who the organization employs and which of their machines produced a session
// for it; only this host knows what actually arrived here. Note what the hub
// does NOT know: whether somebody has the client installed at all. The roster's
// count is org-scoped, so a person who installed it and works only elsewhere is
// zero — see the `installed` stage below, and the protocol's own contract.
// So every stage carries the SOURCE it was computed from and whether that source
// is cloud-attested or fortress-observed, and the table below is the whole
// mapping. A stage with two sources would be a figure nobody could reconcile
// against either of them.
//
// Two derivations are pinned here because getting them wrong is easy and silent:
//
//   THE DENOMINATOR IS ACTIVE MEMBERS ONLY. People who have left are counted
//   separately and never divided into: a coverage figure that keeps counting
//   departed employees falls forever, and one that deletes them loses the fact
//   that their sessions are still here.
//
//   QUIET IS DERIVED FROM lastUploadAt WHEN THERE IS ONE. Both roster stamps are
//   org-scoped evidence — the hub deliberately does not report the per-person
//   heartbeat column, which carries no org — so last-seen is the most recent
//   activity this organization has seen from the machine and last-upload is when
//   bytes last landed on its destination row. The upload stamp is the stronger
//   signal and wins; its ABSENCE means the session history predates
//   per-destination tracking, not that nothing was ever sent, so it falls back
//   to last-seen rather than accusing the member of never uploading.

import type { RosterPersonRow } from "../query/console/roster";

export type StageSource = "roster" | "roster device inventory" | "local session rows";
export type StageAttestation = "cloud-attested" | "fortress-observed";
// NO `sync` STAGE. Backfill progress is written by the device's own sync-status
// report, which carries no organization — a person's whole backlog across every
// employer — so the hub deliberately stops reporting it. Rendering the stage
// anyway put a permanent `0` and `0%` in the middle of the funnel, labelled
// "Backfill reported complete" and pilled "cloud-attested", while the per-member
// cell on the same page correctly reads "not reported". A stage that can only
// ever be zero is worse than one that is not there.
export type StageId = "rostered" | "installed" | "sending" | "active";

export interface AdoptionStage {
  id: StageId;
  label: string;
  source: StageSource;
  attestation: StageAttestation;
  /** Exactly what is counted, in the words the page renders. */
  detail: string;
}

/** The stage-source table. ONE source per stage, and the posture cache is not
 *  among them: the gates panel is posture-sourced and is deliberately not a
 *  funnel input — it describes let.ai's routing, not this organization's people. */
export const ADOPTION_STAGES: readonly AdoptionStage[] = [
  {
    id: "rostered",
    label: "On the roster",
    source: "roster",
    attestation: "cloud-attested",
    detail: "active members let.ai reports for this organization",
  },
  {
    id: "installed",
    label: "Has worked here",
    source: "roster device inventory",
    attestation: "cloud-attested",
    // NOT an install count. The roster's `installed` counts machines whose
    // device_id produced a session attributed to THIS organization — that
    // scoping is what keeps another tenant's estate off this console — so a
    // person who installed the client and has only worked elsewhere counts zero.
    detail: "members with at least one machine that has produced a session for this organization",
  },
  {
    id: "sending",
    label: "Sending to this fortress",
    source: "local session rows",
    attestation: "fortress-observed",
    detail: "members with at least one session on this host",
  },
  {
    id: "active",
    label: `Active in the last ${30} days`,
    source: "local session rows",
    attestation: "fortress-observed",
    detail: "members with session activity here inside the window",
  },
];

/** The window "active" means. Pinned here so the label and the SQL cannot drift
 *  apart. */
export const ADOPTION_ACTIVE_DAYS = 30;

/** How long a machine that has worked here may go without uploading before it
 *  is worth an operator's attention. */
export const QUIET_AFTER_DAYS = 14;

export interface AdoptionCounts {
  rostered: number;
  installed: number;
  /** Retained because `hx.roster` still holds the column and older rosters may
   *  carry a value — but no stage renders it; see StageId. */
  syncComplete: number;
  sending: number;
  active: number;
  /** Departed members still retained. Counted, never in the denominator. */
  formerMembers: number;
  /** People sending here whom the roster does not know at all. */
  unrostered: number;
}

export interface AdoptionStageView extends AdoptionStage {
  count: number;
  /** Share of the active-member denominator, or null when there is no roster to
   *  divide by — a percentage invented from the people who already appear would
   *  always read 100%. */
  share: number | null;
}

export function adoptionStages(counts: AdoptionCounts): AdoptionStageView[] {
  const denominator = counts.rostered;
  const value: Record<StageId, number> = {
    rostered: counts.rostered,
    installed: counts.installed,
    sending: counts.sending,
    active: counts.active,
  };
  return ADOPTION_STAGES.map((stage) => ({
    ...stage,
    count: value[stage.id],
    share: denominator > 0 ? value[stage.id] / denominator : null,
  }));
}

export type AttentionKind = "nothing-here-yet" | "never-uploaded" | "quiet" | "backfill-outstanding";

export interface AttentionRow {
  externalId: string;
  displayName: string;
  kind: AttentionKind;
  detail: string;
}

export const ATTENTION_COPY: Record<AttentionKind, string> = {
  "nothing-here-yet": "on the roster, with no machine of theirs having produced a session for this organization",
  "never-uploaded": "has a machine that worked here, with no activity recorded at all",
  quiet: `has a machine that worked here, with nothing uploaded for over ${QUIET_AFTER_DAYS} days`,
  "backfill-outstanding": "is still backfilling — earlier sessions are on their way",
};

/**
 * Who an operator should look at, worst first.
 *
 * INACTIVE MEMBERS ARE EXCLUDED. Somebody who has left the organization is not
 * an adoption problem, and leaving them here would fill the list with people
 * nobody can act on.
 */
export function attentionRows(
  rows: readonly RosterPersonRow[],
  now: number = Date.now(),
): AttentionRow[] {
  const out: AttentionRow[] = [];
  for (const row of rows) {
    if (!row.active) continue;
    const kind = attentionKind(row, now);
    if (!kind) continue;
    out.push({
      externalId: row.externalId,
      displayName: row.displayName,
      kind,
      detail: ATTENTION_COPY[kind],
    });
  }
  const order: AttentionKind[] = ["nothing-here-yet", "never-uploaded", "quiet", "backfill-outstanding"];
  return out.sort(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.externalId.localeCompare(b.externalId),
  );
}

function attentionKind(row: RosterPersonRow, now: number): AttentionKind | null {
  // The observed fact, not an inferred install state: `installed === 0` means no
  // machine of theirs has produced a session for this organization. It does NOT
  // mean they have no client — saying so would send an operator chasing an
  // install that already exists.
  if (row.installed === 0) return "nothing-here-yet";
  // The upload stamp when there is one. A NULL is not "never uploaded": the
  // row got past `installed === 0`, so a machine of theirs did produce a session
  // for this organization — the upload stamp comes from the hub's
  // per-destination row, which sessions recorded before that table existed do
  // not have. Calling that "never uploaded" put every member whose history
  // predates it on the attention list permanently. Fall back to the activity
  // the org has actually seen, and only call it out when THAT has gone quiet.
  const stamp = row.lastUploadAt ?? row.lastSeenAt;
  if (stamp === null) return "never-uploaded";
  const age = now - Date.parse(stamp);
  if (Number.isFinite(age) && age > QUIET_AFTER_DAYS * 86_400_000) return "quiet";
  if (row.syncTotal !== null && row.syncDone !== null && row.syncDone < row.syncTotal) {
    return "backfill-outstanding";
  }
  return null;
}

export interface TeamSummary {
  name: string;
  members: number;
  sending: number;
}

/** Teams, straight from the roster's own field. Only ACTIVE members are grouped:
 *  a team's headcount is who is in it now. */
export function rosterTeams(rows: readonly RosterPersonRow[]): TeamSummary[] {
  const teams = new Map<string, TeamSummary>();
  for (const row of rows) {
    if (!row.active) continue;
    for (const name of row.teams) {
      const team = teams.get(name) ?? { name, members: 0, sending: 0 };
      team.members += 1;
      if (row.sessions > 0) team.sending += 1;
      teams.set(name, team);
    }
  }
  return [...teams.values()].sort((a, b) => b.members - a.members || a.name.localeCompare(b.name));
}

