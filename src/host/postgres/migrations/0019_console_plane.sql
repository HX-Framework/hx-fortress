-- 0015 · console/runtime plane — TABLES ONLY (plus role-guarded REVOKEs).
--
-- Deliberately carries NO `CREATE ROLE`, NO `CREATE FUNCTION` and NO `OWNER TO`.
-- The one-way command machine (the SECURITY DEFINER transition routines, their
-- NOLOGIN owner and its grants) is applied by ensureAppRoles on EVERY boot
-- instead, because:
--   • migrate() runs BEFORE ensureAppRoles(), so on a fresh cluster hx_app_rw
--     does not exist yet and a GRANT here would abort the migration;
--   • the journal is NAME-keyed with no content hash, so a later correction to
--     an applied file is a silent no-op — an apparatus pinned here could never
--     be fixed forward on an already-migrated cluster;
--   • `ALTER … OWNER TO` needs a role membership a limited operator role lacks
--     on an external Postgres, which would leave the fortress permanently
--     not-ready there.
--
-- Every statement is IF NOT EXISTS or DO-guarded: the runner is append-only and
-- re-running an applied file (a restored journal, a manual replay) must be a
-- clean no-op.

-- ── Console commands ────────────────────────────────────────────────────────
-- The console MINTS rows here (as hx_ui); the daemon polls, claims, executes and
-- reports — every transition through hx.claim_command / hx.complete_command /
-- hx.reject_command, never direct DML. `kind` is plain TEXT on purpose: its
-- allowlist lives in application code, because neither an edit to this applied
-- file nor `ALTER TYPE … ADD VALUE` is something a later task could apply (the
-- first is a silent no-op, the second is neither a table nor a role REVOKE).
-- `claimed_by`/`claimed_at` are OBSERVABILITY ONLY — never a security predicate;
-- crash-recovery eligibility is decided by a daemon-only runtime file.
CREATE TABLE IF NOT EXISTS "hx"."console_commands" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "params" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'requested' NOT NULL,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "requested_by" text,
  "deadline_at" timestamp with time zone,
  "credential_ref" text,
  "claimed_by" text,
  "claimed_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "outcome" text,
  "error" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hx_console_commands_status_idx"
  ON "hx"."console_commands" ("status", "requested_at");

-- ── Ingest control (the store-write pause) ──────────────────────────────────
-- ONE ROW PER PAUSE EPISODE, never updated in place across episodes: the clamp
-- that bounds a pause is anchored on `row_written_at`, which a column DEFAULT
-- stamps at INSERT and which hx_app_rw is not granted. A singleton updated in
-- place would carry an anchor older than the cap and resolve every pause to
-- "already expired"; a per-episode row anchors each pause to itself.
CREATE TABLE IF NOT EXISTS "hx"."ingest_control" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "paused_until" timestamp with time zone NOT NULL,
  "reason" text,
  "armed_by" text,
  "resumed_at" timestamp with time zone,
  "row_written_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hx_ingest_control_episode_idx"
  ON "hx"."ingest_control" ("row_written_at" DESC);

-- ── Admin audit ─────────────────────────────────────────────────────────────
-- The drained form of the daemon's 0600 write-ahead spool. (spool_file_id, seq)
-- is UNIQUE so the drain is `ON CONFLICT DO NOTHING` idempotent. Written only as
-- hx_ui: the cloud-reachable write role must not be able to forge or amend an
-- audit record, which is also what lets a spool record CORROBORATE a command
-- outcome that same role could otherwise fabricate.
CREATE TABLE IF NOT EXISTS "hx"."admin_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "spool_file_id" text NOT NULL,
  "seq" bigint NOT NULL,
  "ts" timestamp with time zone DEFAULT now() NOT NULL,
  "origin" text DEFAULT 'console' NOT NULL,
  "actor" text,
  "session_ref" text,
  "tier" text,
  "action" text NOT NULL,
  "params" jsonb,
  "kind" text NOT NULL,
  "ref_seq" bigint,
  "outcome" text,
  "error" text,
  CONSTRAINT "hx_admin_audit_spool_unique" UNIQUE ("spool_file_id", "seq")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hx_admin_audit_ts_idx" ON "hx"."admin_audit" ("ts" DESC);

-- ── Audit acknowledgements + settings ───────────────────────────────────────
-- Created here, ahead of the audit engine that gives them meaning, because the
-- apparatus GRANTs on both relations and the whole ensureAppRoles block is ONE
-- transaction: a missing relation would roll the entire block back on every
-- boot — no command owner, no transition functions, no claimable command.
-- Both are SEQUENCE-FREE by construction (a composite PK and a keyless
-- singleton), so the command owner needs no sequence USAGE and its pinned grant
-- set stays exactly the statements ensureAppRoles emits. A serial/identity
-- column added later must add sequence USAGE to that set in the same edit.
CREATE TABLE IF NOT EXISTS "hx"."audit_acks" (
  "org" text NOT NULL,
  "session_id" text NOT NULL,
  "acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
  "acknowledged_by" text,
  "reason" text,
  CONSTRAINT "hx_audit_acks_pk" PRIMARY KEY ("org", "session_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hx"."audit_settings" (
  "cloud_witness" boolean DEFAULT false NOT NULL
);

-- ── Ingest provenance ───────────────────────────────────────────────────────
-- Which entry point first wrote the session ('tunnel' | 'gateway' |
-- 'reconciled'). Residency disclosure is eligible for cloud-relayed sessions
-- ONLY, so this column is a fail-private eligibility gate; pre-existing rows
-- stay NULL (unknown provenance ⇒ ineligible).
ALTER TABLE "hx"."sessions" ADD COLUMN IF NOT EXISTS "ingest_channel" text;

-- ── Role-guarded REVOKEs ────────────────────────────────────────────────────
-- ensureAppRoles re-applies these on every boot; carrying them here as well
-- closes the window where a table created by THIS migration sits under 0005's
-- `ALTER DEFAULT PRIVILEGES … GRANT SELECT … TO hx_readonly` (which fires at
-- CREATE time) before the first ensureAppRoles pass. Guarded on pg_roles: a
-- fresh cluster has no app roles yet and an external Postgres never has them.
--
-- NOTE the limit of this belt: it survives a DOWNGRADE only for hx_readonly.
-- An older binary's blanket `GRANT … ON ALL TABLES` re-grants hx_app_rw full
-- DML on its first boot, which is why audit rows written during a downgrade
-- window are documented as untrusted.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hx_app_rw') THEN
    REVOKE INSERT, UPDATE, DELETE ON hx.console_commands FROM hx_app_rw;
    REVOKE INSERT, UPDATE, DELETE ON hx.admin_audit FROM hx_app_rw;
    REVOKE INSERT, UPDATE, DELETE ON hx.audit_acks FROM hx_app_rw;
    REVOKE INSERT, UPDATE, DELETE ON hx.audit_settings FROM hx_app_rw;
    REVOKE INSERT, UPDATE, DELETE ON hx.ingest_control FROM hx_app_rw;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hx_readonly') THEN
    REVOKE ALL ON hx.console_commands FROM hx_readonly;
    REVOKE ALL ON hx.admin_audit FROM hx_readonly;
    REVOKE ALL ON hx.audit_acks FROM hx_readonly;
    REVOKE ALL ON hx.audit_settings FROM hx_readonly;
    REVOKE ALL ON hx.ingest_control FROM hx_readonly;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hx_app_ro') THEN
    REVOKE ALL ON hx.console_commands FROM hx_app_ro;
    REVOKE ALL ON hx.admin_audit FROM hx_app_ro;
    REVOKE ALL ON hx.audit_acks FROM hx_app_ro;
    REVOKE ALL ON hx.audit_settings FROM hx_app_ro;
    REVOKE ALL ON hx.ingest_control FROM hx_app_ro;
  END IF;
END $$;
