-- Durable record that a chunk's bytes were composed into a canonical, written
-- BEFORE the fortress acks the upload.
--
-- THE HOLE THIS CLOSES. `/sessions/commit` (and the cloud tunnel's ingestCommit
-- RPC) composes the chunk into the canonical, returns success, and hands the
-- Postgres write to an in-memory queue. If that write is dropped — Postgres
-- unavailable, any throw, or the process restarting — the bytes are durable in
-- object storage and NOTHING RECORDS THAT THE CHUNK EXISTED. The client has
-- advanced its offset and will never resend it.
--
-- The next chunk then hides the damage: `bytesUploaded` is stamped to the whole
-- canonical's size and `seq` continues from max+1, so the lane ends up
-- byte-covering AND seq-dense. It evades the orphan scan (there IS a row), the
-- staleness gate (bytes cover) and the gap scan (seq is dense) alike. The
-- guarantor's `signalReconcile()` on the failure path is therefore a no-op for
-- the very damage it was written to report.
--
-- Observed in production on 2026-08-07 18:04Z: session 95b9f361 indexed one
-- 2,806-byte mirror chunk, its canonical reached 5,796 bytes, and no second
-- index write ever arrived. Only the count sweep found it, 51 minutes later.
--
-- WHY THIS TABLE AND NOT `hx.ingest_events`. That table's `user_id` and
-- `session_id` are NOT NULL and reference rows that need not exist yet — an
-- intent is recorded before the session row does. It also already carries two
-- meanings; a third would make it unreadable.
--
-- WHAT THE REMEDY IS. Deliberately NOT a chunk replay: the canonical already
-- holds the bytes, so an uncleared intent only has to make the guarantor LOOK at
-- that session, and its existing whole-canonical repair does the rest. That is
-- why no chunk text is stored here and why staging objects need no retention.
CREATE TABLE IF NOT EXISTS "hx"."chunk_intents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- The client's own identity, not a row reference: nothing may need to exist.
  "user_external_id" text NOT NULL,
  "family" text NOT NULL,
  "session_id" text NOT NULL,
  -- Set for an agent-lane chunk; NULL for a parent chunk.
  "agent_external_id" text,
  "chunk_id" text NOT NULL,
  -- The canonical's size as the store reported it after composing this chunk.
  "total_bytes" bigint DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- Set inside the ingest transaction that indexes this chunk. NULL means the
  -- bytes are in the canonical and the turns may not be in the index.
  "cleared_at" timestamp with time zone
);
--> statement-breakpoint
-- A replayed chunk id must not error. NULLS NOT DISTINCT so a parent chunk (NULL
-- agent) collides with itself rather than inserting a duplicate every retry.
CREATE UNIQUE INDEX IF NOT EXISTS "hx_chunk_intents_identity_unique"
  ON "hx"."chunk_intents" ("user_external_id", "family", "session_id", "agent_external_id", "chunk_id")
  NULLS NOT DISTINCT;
--> statement-breakpoint
-- The guarantor's only query against this table: oldest uncleared first. Partial,
-- so the index stays small — a healthy fortress clears essentially everything.
CREATE INDEX IF NOT EXISTS "hx_chunk_intents_uncleared_idx"
  ON "hx"."chunk_intents" ("created_at")
  WHERE "cleared_at" IS NULL;
