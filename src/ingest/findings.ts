// Durable integrity findings (hx.integrity_findings, migration 0018).
//
// The guarantor's most valuable observations — overcounts, canonical-held
// duplicates, append overlaps — used to exist only as log lines, and the prod
// log is a ~500-line rolling tail: the evidence that settles a data question
// ages out in minutes. This table is the durable sink. Append-only, external
// identity (no row FKs — same reasoning as hx.chunk_intents: the thing being
// recorded may describe a session whose row is the problem), best-effort
// writes that never fail the caller.

import { sql as dsql } from "drizzle-orm";

import type { HxDb } from "../host/postgres/db";

export type IntegrityFindingKind =
  | "overcount"
  | "canonical_held_duplicates"
  | "append_overlap";

export interface IntegrityFinding {
  userExternalId: string;
  family: string;
  sessionId: string;
  agentExternalId?: string | null;
  kind: IntegrityFindingKind;
  detail?: Record<string, unknown> | null;
}

/** Best-effort insert; swallows every error (the finding is evidence, never a
 *  prerequisite — failing the observed operation over it would be backwards). */
export async function recordIntegrityFinding(db: HxDb, f: IntegrityFinding): Promise<void> {
  try {
    await db.execute(dsql`
      insert into hx.integrity_findings
        (user_external_id, family, session_id, agent_external_id, kind, detail)
      values
        (${f.userExternalId}, ${f.family}, ${f.sessionId}, ${f.agentExternalId ?? null},
         ${f.kind}, ${f.detail ? JSON.stringify(f.detail) : null})
    `);
  } catch {
    // deliberately silent — see docstring
  }
}
