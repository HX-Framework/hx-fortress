import type { Migration } from "../migrate";

// THE registry of migrations, in apply order — nothing else decides what runs or
// when. Each entry imports a `.sql` file as embedded text (so it survives
// `bun build --compile`; the runtime never reads a migrations folder), and `name`
// is the key the runner records as applied.
//
// There is no drizzle journal or snapshot set behind this list. 0000-0014 are
// drizzle-kit output kept verbatim; 0015 onward are hand-written SQL, because what
// they express — roles, REVOKEs, the SECURITY DEFINER apparatus, data backfills —
// is not derivable from the Drizzle schema, and a generator that cannot emit them
// cannot verify them either. `drizzle-kit check` went with the snapshots; the
// ordering invariant it nominally covered is asserted against these entries
// directly (test/host-postgres-migrate.test.ts).
//
// Adding a migration: write `NNNN_<name>.sql` with the next unused number, then
// append one import + one array entry here. Never edit an applied file.
import sql0000Extensions from "./0000_extensions.sql" with { type: "text" };
import sql0001Dimensions from "./0001_dimensions.sql" with { type: "text" };
import sql0002Sessions from "./0002_sessions.sql" with { type: "text" };
import sql0003Transcript from "./0003_transcript.sql" with { type: "text" };
import sql0004Analysis from "./0004_analysis.sql" with { type: "text" };
import sql0005Views from "./0005_views.sql" with { type: "text" };
import sql0006Embeddings from "./0006_embeddings.sql" with { type: "text" };
import sql0007TurnKind from "./0007_turn_kind.sql" with { type: "text" };
import sql0008SessionFacts from "./0008_session_facts.sql" with { type: "text" };
import sql0010EmbeddingsIndexes from "./0010_embeddings_indexes.sql" with { type: "text" };
import sql0011WidenTokens from "./0011_widen_session_tokens.sql" with { type: "text" };
import sql0012EmbedBudget from "./0012_embed_budget.sql" with { type: "text" };
import sql0013DeletedSessions from "./0013_deleted_sessions.sql" with { type: "text" };
import sql0014BackfillTitles from "./0014_backfill_session_titles.sql" with { type: "text" };
import sql0015DeepVerifyCursor from "./0015_deep_verify_cursor.sql" with { type: "text" };
import sql0016FkIndexes from "./0016_fk_indexes.sql" with { type: "text" };
import sql0017ChunkIntents from "./0017_chunk_intents.sql" with { type: "text" };
import sql0018IntegrityFindings from "./0018_integrity_findings.sql" with { type: "text" };
import sql0019ConsolePlane from "./0019_console_plane.sql" with { type: "text" };
import sql0020AuditRefFile from "./0020_audit_ref_file.sql" with { type: "text" };
import sql0021AuditEngine from "./0021_audit_engine.sql" with { type: "text" };
import sql0022Roster from "./0022_roster.sql" with { type: "text" };
import sql0023MigrationRuns from "./0023_migration_runs.sql" with { type: "text" };
import sql0024ResidencyUnchecked from "./0024_residency_unchecked.sql" with { type: "text" };
import sql0025MissingHere from "./0025_missing_here.sql" with { type: "text" };
import sql0026CloudWitnessDefault from "./0026_cloud_witness_default.sql" with { type: "text" };
import sql0027LanesHoldIt from "./0027_lanes_hold_it.sql" with { type: "text" };
import sql0028ResidencyUnwitnessable from "./0028_residency_unwitnessable.sql" with { type: "text" };
import sql0029WitnessChangeStamp from "./0029_witness_change_stamp.sql" with { type: "text" };
import sql0030CopyUnchecked from "./0030_copy_unchecked.sql" with { type: "text" };
import sql0031AuditSettingsSingleton from "./0031_audit_settings_singleton.sql" with { type: "text" };

export const migrations: Migration[] = [
  { name: "0000_extensions", sql: sql0000Extensions },
  { name: "0001_dimensions", sql: sql0001Dimensions },
  { name: "0002_sessions", sql: sql0002Sessions },
  { name: "0003_transcript", sql: sql0003Transcript },
  { name: "0004_analysis", sql: sql0004Analysis },
  { name: "0005_views", sql: sql0005Views },
  // Gated: applied only when pgvector is installable; skipped (and retried)
  // otherwise, so the core schema installs on the stock bundle.
  { name: "0006_embeddings", sql: sql0006Embeddings, requires: "vector" },
  // Net-new `kind` (10-value taxonomy) + `text` nullable for text-less kinds;
  // backfills `kind` from the existing 3-value `role`. NOT gated.
  { name: "0007_turn_kind", sql: sql0007TurnKind },
  // Net-new per-session productivity facts (§13-A4) — derived at ingest from the
  // session's turns/tool_calls; the live aggregate JOINs it to hx.sessions. NOT gated.
  { name: "0008_session_facts", sql: sql0008SessionFacts },
  // 0009 is intentionally absent: the spec slotted an "embed-job lease" table here, but
  // the impl uses one in-process worker (anti-join + ON CONFLICT unique-index fence, 0010) instead.
  // Gated (A7): content_hash btree + UNIQUE(owner_kind, owner_id) on the gated
  // hx.embeddings. Separate migration (never folded into 0006) so the append-
  // only runner applies it once pgvector is present and skips it otherwise.
  { name: "0010_embeddings_indexes", sql: sql0010EmbeddingsIndexes, requires: "vector" },
  { name: "0011_widen_session_tokens", sql: sql0011WidenTokens },
  // Net-new durable daily embed-token budget table (M-9e). NOT gated — the embed
  // worker reads/increments it to hold a per-day OpenAI spend ceiling.
  { name: "0012_embed_budget", sql: sql0012EmbedBudget },
  // Net-new permanent session-delete tombstones. NOT gated — every ingest
  // surface consults it to refuse re-uploads of hard-deleted sessions.
  { name: "0013_deleted_sessions", sql: sql0013DeletedSessions },
  // One-shot DATA backfill (no schema change): derive a fallback title for
  // pre-existing sessions that reached the fortress title-less — the hx client
  // only titles a from-zero upload, so older-client / pre-fortress sessions sit
  // title-less and show a bare id. Fills only NULL titles (idempotent). NOT
  // gated. Going forward ingestCommit derives titles inline (src/ingest/ingest.ts).
  { name: "0014_backfill_session_titles", sql: sql0014BackfillTitles },
  // Covering indexes for the DELETE-cascade foreign keys. An unindexed FK makes
  // every cascading delete scan the whole child table ONCE PER DELETED ROW —
  // this is what made guarantor rebuilds run to the statement timeout and starve
  // the background pool. NOT gated. See the file header for the full account.
  // ORDER MATTERS, and this pair is deliberately this way round.
  //
  // The cursor columns are declared in the drizzle schema, and drizzle expands
  // `select().from(hxSessions)` into the full declared column list — so LIVE
  // INGEST fails with "column does not exist" until they are added. They must
  // therefore land before anything that can fail.
  //
  // The index build is the one migration in this repo whose own header warns it
  // may exceed FORTRESS_DB_MIGRATION_TIMEOUT_MS on a large corpus. If it rolls
  // back un-journalled with the cursor migration behind it, the provider never
  // reaches ready and the fortress stops ingesting entirely. Two instant
  // ADD COLUMNs go first; the risky build goes second, where a rollback costs
  // only the indexes it was trying to create.
  { name: "0015_deep_verify_cursor", sql: sql0015DeepVerifyCursor },
  { name: "0016_fk_indexes", sql: sql0016FkIndexes },
  // Durable intent records for composed-but-maybe-unindexed chunks. NOT gated.
  // Net-new table, no data touched — the whole point is that a dropped index
  // write currently leaves no trace at all. See the file header.
  { name: "0017_chunk_intents", sql: sql0017ChunkIntents },
  // Durable integrity findings (MC-2606 §7b sink): overcounts, canonical-held
  // duplicates, append overlaps — evidence that must outlive the rolling log tail.
  { name: "0018_integrity_findings", sql: sql0018IntegrityFindings },
  // Console/runtime plane: the command queue, the ingest pause, the admin audit
  // and the two audit tables the SECURITY DEFINER routines write — TABLES ONLY,
  // plus role-guarded REVOKEs. The routines, their NOLOGIN owner and every
  // GRANT live in ensureAppRoles instead (see the file header for why). NOT
  // gated. Never edit an applied file; always add the next number.
  { name: "0019_console_plane", sql: sql0019ConsolePlane },
  // One additive column on hx.admin_audit: the FILE half of an outcome's
  // reference to its intent, so a pair split by a spool rotation still resolves.
  // NOT gated.
  { name: "0020_audit_ref_file", sql: sql0020AuditRefFile },
  // The residency audit's own record: runs and findings. The acknowledgement
  // and cloud-witness tables are NOT here (0015 owns them, with their fences) —
  // a run is re-derivable by running the audit again, and an acknowledgement is
  // not. NOT gated.
  { name: "0021_audit_engine", sql: sql0021AuditEngine },
  // The organization's people, as let.ai reports them: a full REPLACE per sync,
  // a locally-derived `active` flag for members who stopped being sent, and a
  // singleton whose ABSENCE means no sync has ever landed. NOT gated.
  { name: "0022_roster", sql: sql0022Roster },
  // The storage migration's own record: one row per run, one per copied session
  // with the checksum it was verified against — which is what makes a resume
  // able to re-copy exactly what is missing. NOT gated.
  { name: "0023_migration_runs", sql: sql0023MigrationRuns },
  { name: "0024_residency_unchecked", sql: sql0024ResidencyUnchecked },
  { name: "0025_missing_here", sql: sql0025MissingHere },
  { name: "0026_cloud_witness_default", sql: sql0026CloudWitnessDefault },
  { name: "0027_lanes_hold_it", sql: sql0027LanesHoldIt },
  { name: "0028_residency_unwitnessable", sql: sql0028ResidencyUnwitnessable },
  { name: "0029_witness_change_stamp", sql: sql0029WitnessChangeStamp },
  { name: "0030_copy_unchecked", sql: sql0030CopyUnchecked },
  { name: "0031_audit_settings_singleton", sql: sql0031AuditSettingsSingleton },
];
