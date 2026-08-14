-- Cursor for the count-based completeness sweep.
--
-- The staleness gate selects a session only when its byte watermark is BEHIND
-- the canonical. That gate is blind to every failure that leaves the byte count
-- looking right: records lost from the MIDDLE of a canonical, where the lane
-- stays seq-dense and byte-covering. Such a session reads as healthy, is never
-- selected, and so is never re-examined by anything.
--
-- The check is a LOWER bound (parseChunk is stateful across the text, so an
-- append-built lane legally holds more turns than a whole-text parse yields).
-- It detects missing records; it does not prove wholeness.
--
-- TWO timestamps, not one, and the distinction is load-bearing.
--
--   deep_verified_at   the row was CHECKED and found not short of the records
--                      its canonical parses to. Drives the backlog.
--   deep_attempted_at  the sweep LOOKED at this row, whatever the outcome.
--                      Drives the rotation ORDER.
--
-- With one column the two purposes conflict. Ordering by "proven" and never
-- stamping a row that cannot be proven — an unreadable canonical, a read that
-- comes back short — leaves that row permanently at the head of the queue.
-- Once as many such rows exist as the per-pass cap, the sweep re-selects the
-- identical set every pass and never reaches another row again: the rotation
-- wedges while the backlog flatlines and the pass log still looks healthy.
--
-- Ordering by "attempted" always advances. Reporting the backlog from "proven"
-- stays honest about what has actually been established.
ALTER TABLE "hx"."sessions"
  ADD COLUMN IF NOT EXISTS "deep_verified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "hx"."sessions"
  ADD COLUMN IF NOT EXISTS "deep_attempted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "hx"."session_agents"
  ADD COLUMN IF NOT EXISTS "deep_verified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "hx"."session_agents"
  ADD COLUMN IF NOT EXISTS "deep_attempted_at" timestamp with time zone;
--> statement-breakpoint
-- Partial indexes on the live rows only: the sweep always asks the same
-- question ("least recently attempted, not deleted"), and deleted rows should
-- never enter that ordering. NULLS FIRST matches the sweep's ORDER BY exactly —
-- a never-attempted row is picked up before any attempted one.
CREATE INDEX IF NOT EXISTS "hx_sessions_deep_verify_idx"
  ON "hx"."sessions" ("deep_attempted_at" NULLS FIRST)
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hx_session_agents_deep_verify_idx"
  ON "hx"."session_agents" ("deep_attempted_at" NULLS FIRST)
  WHERE "deleted_at" IS NULL;
