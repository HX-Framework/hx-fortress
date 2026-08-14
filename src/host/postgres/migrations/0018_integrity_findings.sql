-- Durable integrity findings (MC-2606 §7b sink).
--
-- The guarantor's data-question evidence — overcounts (indexed vs canonical
-- record counts), canonical-held duplicates found while a rebuild holds the
-- parsed canonical in hand, and append overlaps the dedupe guard let through —
-- previously existed only as log lines behind a ~500-line rolling tail.
-- Append-only; external identity, no row FKs (the recorded session's row may
-- be exactly what is wrong — same reasoning as hx.chunk_intents).
CREATE TABLE IF NOT EXISTS "hx"."integrity_findings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_external_id" text NOT NULL,
  "family" text NOT NULL,
  "session_id" text NOT NULL,
  -- Set for an agent-lane finding; NULL for the parent lane.
  "agent_external_id" text,
  "kind" text NOT NULL,
  "detail" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hx_integrity_findings_kind_idx"
  ON "hx"."integrity_findings" ("kind", "created_at");
--> statement-breakpoint
GRANT SELECT ON "hx"."integrity_findings" TO hx_readonly;
