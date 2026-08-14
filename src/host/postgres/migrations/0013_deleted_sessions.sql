-- Session-delete tombstones (permanent hard-delete support). One row per
-- deleted (user, family, session) identity; consulted by every ingest surface
-- (gateway routes + ingestCommit RPCs) so a deleted session can never be
-- re-uploaded. Deliberately NOT soft-delete-shaped: the tombstone is the
-- record of the hard delete and is never removed.
CREATE TABLE IF NOT EXISTS "hx"."deleted_sessions" (
  "user_external_id" text NOT NULL,
  "family" text NOT NULL,
  "session_id" text NOT NULL,
  "deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "deleted_sessions_pk" PRIMARY KEY ("user_external_id", "family", "session_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hx_deleted_sessions_user_session_idx"
  ON "hx"."deleted_sessions" ("user_external_id", "session_id");
