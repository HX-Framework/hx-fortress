-- A session this fortress claims whose transcript is not in its bucket.
--
-- The verdict used to be decided after an eligibility gate that returned first,
-- so for every gateway, reconciled and NULL-channel session the presence answer
-- — already paid for with a HEAD — was discarded, and a vanished transcript read
-- as `not_applicable`: "nothing to do, this fortress is the only place these
-- bytes were ever sent". Those rows were also filtered out of hx.audit_findings,
-- so the loss left no record anywhere.
ALTER TABLE "hx"."audit_runs" ADD COLUMN IF NOT EXISTS "missing_here" integer DEFAULT 0 NOT NULL;
