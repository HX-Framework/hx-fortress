// Wiring one residency audit to a live fortress: its sessions, its bucket, its
// witness and its acknowledgements.
//
// Kept apart from the engine so the engine stays a pure function of what it was
// told — the verdict matrix is the part that has to be provable, and it is
// testable without a bucket, a database or a tunnel.

import { sql } from "drizzle-orm";

import {
  ackKey,
  canonicalKeyOf,
  runResidencyAudit,
  type AuditRunDeps,
  type AuditRunResult,
  type AuditSessionRow,
  type WitnessAnswer,
} from "./audit-engine";
import { readAcknowledgements, readCloudWitness } from "./audit-store";
import type { HxDb } from "../host/postgres/db";
import type { SessionStore } from "../modules/session-vault/store/types";

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const wrapped = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(wrapped) ? (wrapped as T[]) : [];
}

export interface AuditRunnerDeps {
  db: () => HxDb | null;
  store: () => SessionStore | null;
  /** The organization this fortress is enrolled to, from its cloud credential.
   *  Null before enrollment — and then there is nothing to audit, because every
   *  attributed row on the host belongs to somebody else. */
  ownOrgId: () => Promise<string | null>;
  /** Ask let.ai about a batch of ids. Null when there is no tunnel. */
  askWitness: ((ids: readonly string[]) => Promise<WitnessAnswer | null>) | null;
  postureFresh: () => Promise<boolean>;
  /** Published for `hx-fortress audit acks reconcile`, which cannot read the
   *  database and must not be given a way to. */
  publish?: (acks: Awaited<ReturnType<typeof readAcknowledgements>>) => Promise<void>;
}

export async function runAuditForFortress(deps: AuditRunnerDeps): Promise<AuditRunResult> {
  const db = deps.db();
  if (!db) throw new Error("the fortress database is not available");
  const store = deps.store();
  if (!store) throw new Error("the object store is not initialized on this fortress");

  const witnessOn = await readCloudWitness(db).catch(() => false);
  const acks = await readAcknowledgements(db);
  await deps.publish?.(acks);
  const acknowledged = new Set(acks.map((a) => ackKey(a.org, a.sessionId)));

  // The audit is about THIS organization's residency, and its ids leave the box:
  // an eligible session is named to let.ai over this fortress's own credential.
  // A host that ever served a second organization — two enrollments, a bucket
  // reconciled after a re-enrollment — would otherwise hand that organization's
  // session ids to a hub acting for this one, and report verdicts about rows
  // whose metadata is not this organization's to read.
  const ownOrg = await deps.ownOrgId();

  const runDeps: AuditRunDeps = {
    sessions: async () => {
      // Fail closed rather than wide: an unenrolled fortress holds no attributed
      // session of its own, so there is nothing here to audit.
      if (!ownOrg) return [];
      const result = await db.execute(
        // The NATURAL ids, not the row UUIDs. A bucket key is
        // `${externalUserId}/${family}/${sessionId}` (store/keys.ts), so
        // selecting `s.id` and `s.user_id` — the UUID PK and the users FK —
        // builds a key that can never match anything `listCanonical` returns,
        // and every session reads as absent from its own bucket. The reconciler
        // has always joined it this way (ingest/reconciler.ts).
        // LEFT join on orgs, and an unattributed session counts as ours.
        //
        // `s.org_id` is nullable by design — a session with no org is a local
        // session — and the console's own universe says so in one place
        // (`query/console/universe.ts`): `(s.org_id IS NULL OR s.org_id = ...)`.
        // An inner join dropped every one of them, so a tunnel-relayed session
        // with no attribution that let.ai recorded a delivery for and that never
        // arrived — R8/R9's incident — could not be raised at all, while the
        // console's own session list went on showing it.
        //
        // No disclosure risk: only `tunnel` ids ever leave this box
        // (`witnessEligible`), and a NULL-org row is by definition not another
        // organization's.
        //
        // No `u.deleted_at` term: nothing in this repo ever sets it, and the day
        // something does, a departed member's live sessions with transcripts
        // still in the bucket would silently leave the denominator while the
        // console kept counting them. The session's own `deleted_at` is the
        // residency-relevant one.
        sql`SELECT s.session_id AS "sessionId", s.family AS "family", u.external_id AS "userId",
                   s.ingest_channel AS "ingestChannel", s.event_count AS "eventCount",
                   coalesce(o.external_id, ${ownOrg}) AS "org",
                   (s.org_id IS NOT NULL) AS "orgAttributed"
              FROM hx.sessions s
              LEFT JOIN hx.orgs o ON o.id = s.org_id AND o.deleted_at IS NULL
              JOIN hx.users u ON u.id = s.user_id
             WHERE s.deleted_at IS NULL
               AND (s.org_id IS NULL OR o.external_id = ${ownOrg})
             ORDER BY s.created_at ASC`,
      );
      return rows<Record<string, unknown>>(result).map(
        (row): AuditSessionRow => ({
          org: String(row.org ?? ""),
          family: String(row.family ?? ""),
          sessionId: String(row.sessionId ?? ""),
          userId: String(row.userId ?? ""),
          ingestChannel: row.ingestChannel === null ? null : String(row.ingestChannel),
          eventCount: Number(row.eventCount ?? 0),
          orgAttributed: row.orgAttributed === true,
        }),
      );
    },
    listCanonical: async () => {
      const keys = await store.listAllCanonicalKeys();
      return new Set(
        keys.map((key) =>
          canonicalKeyOf({
            org: "",
            family: key.family,
            sessionId: key.sessionId,
            userId: key.userId,
            ingestChannel: null,
            eventCount: 0,
            orgAttributed: false,
          }),
        ),
      );
    },
    headCanonical: async (row) => {
      const bytes = await store.statCanonical({
        family: row.family,
        sessionId: row.sessionId,
        userId: row.userId,
      });
      return bytes !== null;
    },
    // OFF means the ids never leave the box — a different answer from "let.ai
    // reported no copies", and every eligible session says so by name.
    askWitness: witnessOn ? deps.askWitness : null,
    acknowledged: async () => acknowledged,
    postureFresh: deps.postureFresh,
  };
  return await runResidencyAudit(runDeps);
}
