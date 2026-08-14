-- The residency audit's own record: one row per RUN, one per FINDING.
--
-- TABLES ONLY, plus the role-guarded REVOKEs. hx.audit_acks and
-- hx.audit_settings are NOT here — they are created by 0015, because their
-- fences and the SECURITY DEFINER routines that write them belong to the
-- command apparatus rather than to this engine. An acknowledgement is not
-- re-derivable by re-running the audit; a run is.
--
-- Findings are therefore DISPOSABLE and acks are not, and the retention sweep
-- reflects that: runs and findings age out, acknowledgements do not.

CREATE TABLE IF NOT EXISTS "hx"."audit_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "trigger" text NOT NULL,
  "requested_by" text,
  -- Counted, so a roll-up can qualify a verdict without re-reading findings.
  "sessions_checked" integer DEFAULT 0 NOT NULL,
  "confirmed" integer DEFAULT 0 NOT NULL,
  "also_at_letai" integer DEFAULT 0 NOT NULL,
  "not_delivered_here" integer DEFAULT 0 NOT NULL,
  "no_record" integer DEFAULT 0 NOT NULL,
  "unknown_provenance" integer DEFAULT 0 NOT NULL,
  "not_applicable" integer DEFAULT 0 NOT NULL,
  -- The tri-state qualification sentence, stored as rendered so a later read
  -- cannot re-derive a cleaner one than the run was entitled to.
  "qualification" text,
  "error" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hx_audit_runs_started_idx"
  ON "hx"."audit_runs" ("started_at" DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hx"."audit_findings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "hx"."audit_runs"("id") ON DELETE CASCADE,
  "org" text NOT NULL,
  "family" text NOT NULL,
  "session_id" text NOT NULL,
  "verdict" text NOT NULL,
  "ingest_channel" text,
  "detail" text,
  "observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hx_audit_findings_run_idx"
  ON "hx"."audit_findings" ("run_id", "verdict");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hx_audit_findings_session_idx"
  ON "hx"."audit_findings" ("org", "session_id");

-- ── Role-guarded REVOKEs ────────────────────────────────────────────────────
-- Same belt as 0015: a table created here sits under 0005's ALTER DEFAULT
-- PRIVILEGES grant to hx_readonly from the moment it exists, and ensureAppRoles
-- only re-applies its REVOKEs on the next boot.
--
-- hx_app_rw KEEPS its DML here, unlike the two fenced tables: the daemon IS the
-- engine, and a run it cannot record is a run that never happened.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hx_readonly') THEN
    REVOKE ALL ON hx.audit_runs FROM hx_readonly;
    REVOKE ALL ON hx.audit_findings FROM hx_readonly;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hx_app_ro') THEN
    REVOKE ALL ON hx.audit_runs FROM hx_app_ro;
    REVOKE ALL ON hx.audit_findings FROM hx_app_ro;
  END IF;
END $$;
