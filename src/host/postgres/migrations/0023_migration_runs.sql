-- Storage migrations: one row per RUN, one per copied session.
--
-- The run record is what makes a migration RESUMABLE. A copy that died halfway
-- must not start again from the first object — and, more importantly, must not
-- believe it finished. Every session that reached the target is recorded with
-- the checksum it was verified against, so a resume re-copies exactly what is
-- missing and nothing else.
--
-- The rows are DISPOSABLE in the sense that they describe work, not data: they
-- are the audit of a move, and the objects themselves are the truth. The daemon
-- owns them end to end — hx_app_rw writes, hx_ui reads, and nobody else sees
-- them at all.

CREATE TABLE IF NOT EXISTS "hx"."migration_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  -- plan | copy | switch. A plan writes nothing; a copy stops before the swap.
  "mode" text NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  -- The phase reached, so a resumed run can say where the last one stopped.
  "phase" text DEFAULT 'planning' NOT NULL,
  "source_bucket" text NOT NULL,
  "target_bucket" text NOT NULL,
  "sessions_total" integer DEFAULT 0 NOT NULL,
  "sessions_copied" integer DEFAULT 0 NOT NULL,
  "bytes_copied" bigint DEFAULT 0 NOT NULL,
  "delta_passes" integer DEFAULT 0 NOT NULL,
  -- Set only once the credentials file actually points at the target.
  "switched_at" timestamp with time zone,
  "error" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hx_migration_runs_started_idx"
  ON "hx"."migration_runs" ("started_at" DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hx"."migration_objects" (
  "run_id" uuid NOT NULL REFERENCES "hx"."migration_runs"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "family" text NOT NULL,
  "session_id" text NOT NULL,
  -- sha256 of what was READ BACK from the target, not of what was sent: a copy
  -- is proven by the destination, never by the source.
  "checksum" text NOT NULL,
  "bytes" bigint DEFAULT 0 NOT NULL,
  "copied_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("run_id", "user_id", "family", "session_id")
);

-- ── Role-guarded REVOKEs ────────────────────────────────────────────────────
-- Same belt as 0015/0017/0018: 0005's ALTER DEFAULT PRIVILEGES grants
-- hx_readonly SELECT at CREATE time, and ensureAppRoles only re-applies its
-- REVOKEs on the next boot. A migration run names buckets and session ids; the
-- cloud-served read roles have no reason to see either.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hx_readonly') THEN
    REVOKE ALL ON hx.migration_runs FROM hx_readonly;
    REVOKE ALL ON hx.migration_objects FROM hx_readonly;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hx_app_ro') THEN
    REVOKE ALL ON hx.migration_runs FROM hx_app_ro;
    REVOKE ALL ON hx.migration_objects FROM hx_app_ro;
  END IF;
END $$;
