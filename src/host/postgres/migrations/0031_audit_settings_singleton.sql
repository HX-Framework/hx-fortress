-- `hx.audit_settings` is described everywhere as a singleton and was never
-- constrained to be one.
--
-- 0015 created it with a single column and no primary key; the reader takes
-- `LIMIT 1` with no ORDER BY, and the writer is an UPDATE followed by an
-- INSERT-if-zero-rows — a read-modify-write with no uniqueness underneath it. Two
-- concurrent flips therefore leave two rows with different `changed_at` /
-- `changed_by`, and the reader picks whichever the planner hands back first. That
-- destroys exactly the accountability stamp 0025 exists to provide: the setter
-- cannot be fenced (the daemon and a leaked roles.json present the same Postgres
-- role), so knowing WHO last changed it is the whole compensating control.
--
-- The shape the next migration already uses (`0022_roster.sql`'s roster_sync) is
-- the one this should have had. De-duplicate first, keeping the newest stamp,
-- then constrain — so an install that already has two rows converges rather than
-- failing to migrate.
-- KEEP-ONE, chosen deterministically. A pairwise `a.ctid < b.ctid AND
-- a.changed_at <= b.changed_at` deletes only the rows dominated on BOTH axes, so
-- whenever physical order disagrees with stamp order it deletes nothing and the
-- primary key below then fails — permanently, because `runMigrations` records a
-- migration only after its batch succeeds, so every later boot re-runs this one
-- and no corrective migration can ever be reached.
DELETE FROM "hx"."audit_settings" a
 WHERE a.ctid <> (
   SELECT b.ctid FROM "hx"."audit_settings" b
    ORDER BY b.changed_at DESC NULLS LAST, b.ctid DESC
    LIMIT 1
 );
--> statement-breakpoint
ALTER TABLE "hx"."audit_settings"
  ADD COLUMN IF NOT EXISTS "singleton" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
UPDATE "hx"."audit_settings" SET "singleton" = true WHERE "singleton" IS DISTINCT FROM true;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hx_audit_settings_pk'
       AND conrelid = 'hx.audit_settings'::regclass
  ) THEN
    ALTER TABLE "hx"."audit_settings" ADD CONSTRAINT "hx_audit_settings_pk" PRIMARY KEY ("singleton");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hx_audit_settings_singleton'
       AND conrelid = 'hx.audit_settings'::regclass
  ) THEN
    ALTER TABLE "hx"."audit_settings" ADD CONSTRAINT "hx_audit_settings_singleton" CHECK ("singleton");
  END IF;
END $$;
