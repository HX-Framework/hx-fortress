// The console-disabled windows, derived from the trail rather than remembered.
//
// A fortress can be operated for days with its console switched off - the first
// operator is created that way by definition - and every one of those acts is
// spooled and drained later, out of order with everything around it. Without a
// marker the trail reads as though nothing happened for a week and then eleven
// things happened at once.
//
// Enablement transitions are always spooled, so the windows are derivable: a
// `ui disable` opens one, a `ui enable` closes it, and the CLI acts in between
// are the ones nobody was watching. Records the CLI had to prune before any
// console drained them are COUNTED here too - a hole in the trail that the trail
// itself does not mention is the one thing worse than the hole.

import { AUDIT_ACTIONS } from "../console/audit-actions";

export interface MarkerRow {
  ts: string;
  action: string;
  origin: string;
  kind: string;
  params: unknown;
}

export interface DisabledWindowMarker {
  from: string;
  /** Null while the console is still disabled. */
  to: string | null;
  cliActs: number;
  pruned: number;
  text: string;
}

function prunedCount(params: unknown): number {
  if (!params || typeof params !== "object") return 0;
  const value = (params as { records?: unknown }).records;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Oldest first, whatever order the rows arrive in. */
export function disabledWindowMarkers(rows: readonly MarkerRow[]): DisabledWindowMarker[] {
  const ordered = [...rows].sort((a, b) => a.ts.localeCompare(b.ts));
  const markers: DisabledWindowMarker[] = [];
  let open: DisabledWindowMarker | null = null;
  for (const row of ordered) {
    if (row.action === AUDIT_ACTIONS.cliDisable && row.kind === "intent") {
      open = { from: row.ts, to: null, cliActs: 0, pruned: 0, text: "" };
      markers.push(open);
      continue;
    }
    if (!open) continue;
    if (row.action === AUDIT_ACTIONS.cliEnable && row.kind === "intent") {
      open.to = row.ts;
      open.text = markerText(open);
      open = null;
      continue;
    }
    if (row.action === AUDIT_ACTIONS.spoolReclaimed) {
      open.pruned += prunedCount(row.params);
      continue;
    }
    // One act, one intent: counting outcomes as well would double every act,
    // and counting both would make a crashed verb look like two.
    if (row.origin === "cli" && row.kind === "intent") open.cliActs += 1;
  }
  for (const marker of markers) if (!marker.text) marker.text = markerText(marker);
  return markers;
}

function markerText(marker: DisabledWindowMarker): string {
  const acts = `${marker.cliActs} CLI ${marker.cliActs === 1 ? "act" : "acts"} recorded`;
  const pruned = marker.pruned > 0 ? `, ${marker.pruned} pruned before drain` : "";
  return marker.to === null
    ? `console-disabled window, open since ${marker.from}: ${acts}${pruned}, still to drain`
    : `console-disabled window ${marker.from} to ${marker.to}: ${acts}${pruned}, drained when the console returned`;
}
