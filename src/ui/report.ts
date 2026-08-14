// The compliance report: one payload, two renderings, and no invented facts.
//
// It is a COMPOSITE - identity, residency counts, storage configuration, the
// database's own posture, the retention truths and the full data-paths
// inventory - because the questions it answers are asked together. Assembling it
// per-panel would let the JSON and the PDF drift, which is exactly what happened
// to the retention lines before they were derived.
//
// The bucket facts are PROVIDER-READ, and they are allowed to say they could not
// be read. The fortress key is provisioned for object access; bucket-level
// configuration is a permission the customer never granted, and widening the
// credential to make this section look complete would be a real cost paid for a
// cosmetic one. So "unavailable - the fortress key cannot read bucket
// configuration" is a first-class answer here, printed as such.

import type { BucketConfigFact } from "../modules/session-vault/store/types";
import type { DataPathRow } from "./egress";
import { EGRESS_TITLE } from "./egress";
import type { IdentityFacts } from "./identity";
import type { ConsoleSessionTotals } from "../query/console/sessions";
import type { ForeignOrgSummary } from "../query/console/universe";

export const REPORT_TITLE = "HX Fortress - residency and data-paths report";

export interface ReportPostureView {
  state: "fresh" | "stale" | "unavailable" | "never-fetched";
  asOf: string | null;
  cloudOnlySessions: number | null;
  routedHere: number | null;
  /** The qualification sentence, verbatim from the engine. */
  qualification: string;
}

export interface ReportPayload {
  generatedAt: string;
  version: string;
  identity: IdentityFacts;
  totals: ConsoleSessionTotals;
  foreign: ForeignOrgSummary;
  storage: {
    provider: string | null;
    bucket: string | null;
    region: string | null;
    versioning: BucketConfigFact;
    lifecycle: BucketConfigFact;
  };
  posture: ReportPostureView;
  dataPaths: DataPathRow[];
}

function line(label: string, value: string | number | null): string {
  return `${label.padEnd(28)} ${value === null ? "unknown" : String(value)}`;
}

/**
 * The report as text, which the PDF renders and a reader can diff.
 *
 * Deliberately flat. A compliance artifact is read by somebody comparing two of
 * them, and a layout that reorders under a change is a layout that hides one.
 */
export function reportLines(payload: ReportPayload): string[] {
  const lines: string[] = [
    line("Generated", payload.generatedAt),
    line("Fortress version", payload.version),
    line("Fortress id", payload.identity.fortressId ?? "not enrolled"),
    line("Bound organization", payload.identity.boundOrgId ?? "not enrolled"),
    line("Credential written", payload.identity.credentialWrittenAt),
    line("Fortress root", payload.identity.root),
    line("Metadata database", payload.identity.postgresMode),
    "",
    "Sessions on this host",
    line("  total", payload.totals.sessions),
    line("  people", payload.totals.people),
    line("  bytes", payload.totals.bytes),
    line("  relayed by let.ai", payload.totals.tunnel),
    line("  direct to gateway", payload.totals.gateway),
    line("  unknown provenance", payload.totals.unknownProvenance),
    `  ${payload.foreign.label}`,
    "",
    "Object storage",
    line("  provider", payload.storage.provider),
    line("  bucket", payload.storage.bucket),
    line("  region", payload.storage.region),
    line("  versioning", payload.storage.versioning),
    line("  lifecycle", payload.storage.lifecycle),
    "",
    "Retention",
    `  Daemon log      ${payload.identity.retention.logs}`,
    `  Audit trail     ${payload.identity.retention.auditTrail}`,
    "",
    "Residency qualification",
    `  ${payload.posture.qualification}`,
    line("  posture as of", payload.posture.asOf),
    line("  cloud-only sessions", payload.posture.cloudOnlySessions),
    line("  routed here", payload.posture.routedHere),
    "",
    EGRESS_TITLE,
  ];
  for (const row of payload.dataPaths) {
    lines.push(`  ${row.name} (${row.direction})`);
    lines.push(`    peer     ${row.peer}`);
    lines.push(`    carries  ${row.carries}`);
    lines.push(`    gate     ${row.gate}`);
    for (const note of row.notes ?? []) lines.push(`    note     ${note}`);
  }
  lines.push("", "Paths on this host");
  for (const [name, value] of Object.entries(payload.identity.paths)) {
    lines.push(`  ${name.padEnd(22)} ${value}`);
  }
  if (payload.identity.roles.length > 0) {
    lines.push("", "Provisioned database roles");
    for (const role of payload.identity.roles) lines.push(`  ${role.name.padEnd(16)} ${role.what}`);
  }
  return lines;
}
