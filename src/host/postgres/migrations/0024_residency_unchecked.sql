-- A session missing from this fortress that the witness could not account for.
--
-- Before this it was counted as `no_record` — "benign legacy, nothing to do" —
-- which is a positive claim about let.ai's delivery records made from a question
-- that was never answered. Any run whose witness was unavailable or switched off
-- reported every such session that way, so the one verdict that fails a roll-up
-- was silently downgraded to the one that does not.
ALTER TABLE "hx"."audit_runs" ADD COLUMN IF NOT EXISTS "residency_unchecked" integer DEFAULT 0 NOT NULL;
