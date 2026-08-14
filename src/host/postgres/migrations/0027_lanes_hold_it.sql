-- A turn-less parent session whose bytes are under its agent lanes.
--
-- These used to report `unknown_provenance` — "upload channel unknown" — about
-- rows whose ingest_channel is recorded, which states a false fact on a
-- compliance surface and inflates that count. They are not unknown and they are
-- not a loss; they simply have no object of their own to expect.
ALTER TABLE "hx"."audit_runs" ADD COLUMN IF NOT EXISTS "lanes_hold_it" integer DEFAULT 0 NOT NULL;
