-- The residency audit's weaker finding is named for what it says: the control
-- plane also holds a copy of a session that is held here. Its first name held
-- the name of one control plane, in the verdict of every such finding and in a
-- count column of hx.audit_runs.
--
-- The stored verdicts are rewritten to the new name. An acknowledgement made
-- under the first name still answers the same finding: hx.audit_acks is keyed
-- by organization and session and holds no verdict.
--
-- The count gets a new column, and the counts of earlier runs are copied into
-- it. The first column stays, unused, for one release: a binary older than
-- this migration still writes its count there, so the residency audit keeps
-- working on a host that goes back to that binary. A later migration drops it.
--
-- GOING BACK TO AN OLDER BINARY. The older binary does not know the new name
-- of the verdict. Until it has finished a residency audit of its own, its
-- Residency page leaves out the findings this migration rewrote, and it
-- refuses to acknowledge them. Run one audit after going back.
--
-- NOT REWRITTEN. A finding and a run also store the sentence that explained
-- them when they were recorded (hx.audit_findings.detail,
-- hx.audit_runs.qualification). Those stay as they were written. The next
-- audit run records new ones.
--
-- UPGRADE NOTE. The runner executes this file as ONE transaction bounded by
-- FORTRESS_DB_MIGRATION_TIMEOUT_MS (default 300 s). The first statement
-- rewrites one row per stored finding of this verdict, by a scan of
-- hx.audit_findings. Findings are recorded only by a run an operator starts,
-- and a run is kept 180 days, so most databases hold a few thousand of them.
-- Measured on a laptop with 900,000 such rows among 1,000,000 (303 MB): 15 s,
-- and 40 s while the machine was busy. A database with tens of millions of
-- findings needs a higher FORTRESS_DB_MIGRATION_TIMEOUT_MS before the update:
-- a rewrite that exceeds it is rolled back, and tried again on every boot.
-- The rewrite runs first because it takes no lock a reader waits on. The lock
-- on hx.audit_runs that adding a column takes is then held only while one
-- small table is copied. Every statement is safe to run again.
UPDATE "hx"."audit_findings"
   SET "verdict" = 'also_at_control_plane'
 WHERE "verdict" = 'also_at_letai';
--> statement-breakpoint
ALTER TABLE "hx"."audit_runs" ADD COLUMN IF NOT EXISTS "also_at_control_plane" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "hx"."audit_runs"
   SET "also_at_control_plane" = "also_at_letai"
 WHERE "also_at_letai" <> 0 AND "also_at_control_plane" = 0;
