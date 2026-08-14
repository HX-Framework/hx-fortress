-- Missing here, and an id let.ai is never asked about.
--
-- An unattributed session is withheld from the witness by design, so it can
-- never be "re-run once let.ai is reachable" — the instruction the shared
-- residency_unchecked verdict gave. Its own verdict, so the fleet sentence and
-- the remediation say something the operator can act on.
ALTER TABLE "hx"."audit_runs" ADD COLUMN IF NOT EXISTS "residency_unwitnessable" integer DEFAULT 0 NOT NULL;
