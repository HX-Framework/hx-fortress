-- Who this organization employs, as let.ai reports them.
--
-- The hub sends the WHOLE active roster on every sync, so this table is a
-- REPLACE and not a merge. Two consequences are structural rather than
-- incidental:
--
--   A MEMBER WHO DISAPPEARS IS DEACTIVATED HERE, NOT DELETED. Only active
--   members are on the wire (a departure is an absence, never a tombstone), so
--   the fortress derives `active = false` itself and keeps the row. Deleting it
--   would erase the fact that the sessions this host still holds belong to
--   somebody who has left — which is exactly what a residency question asks
--   about. The rows age out on their own retention, not on the sync.
--
--   NEVER-RECEIVED IS NOT EMPTY. hx.roster_sync is written only when a sync
--   actually lands, so its ABSENCE means the hub has never told this fortress
--   anything, while a present row with zero members means the hub said the
--   organization has no active members. A console that rendered both as "no
--   people" would report an unconfigured tunnel as an empty company.
--
-- Teams ride as jsonb rather than text[]: the console groups and searches by
-- team, and jsonb_array_elements_text keeps that one join away without a second
-- table whose only job is to be re-derived on every replace.

CREATE TABLE IF NOT EXISTS "hx"."roster" (
  -- The same subject the hub puts in a console grant, so a person resolves
  -- across the roster, the sessions and the audit trail by one id.
  "external_id" text PRIMARY KEY NOT NULL,
  "display_name" text NOT NULL,
  "email" text,
  "teams" jsonb DEFAULT '[]'::jsonb NOT NULL,
  -- The device inventory, counted hub-side from ACTIVE tokens. `installed` is a
  -- count of machines, not of tokens.
  "installed" integer DEFAULT 0 NOT NULL,
  -- Heartbeats move last_seen_at, so it says a client is alive and nothing
  -- about whether it is uploading. last_upload_at is the one that can.
  "last_seen_at" timestamp with time zone,
  "last_upload_at" timestamp with time zone,
  "sync_total" integer,
  "sync_done" integer,
  "sync_reported_at" timestamp with time zone,
  "active" boolean DEFAULT true NOT NULL,
  "first_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
  "synced_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- When this fortress first noticed the absence. The retention clock.
  "inactive_since" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hx_roster_active_idx"
  ON "hx"."roster" ("active", "external_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hx_roster_inactive_since_idx"
  ON "hx"."roster" ("inactive_since")
  WHERE "inactive_since" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hx"."roster_sync" (
  "singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
  -- The hub's own wall-clock for the roster it computed, kept apart from when
  -- this host received it: a console that showed only one of them cannot tell a
  -- stale answer from a stalled tunnel.
  "as_of" timestamp with time zone NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "members" integer NOT NULL,
  CONSTRAINT "hx_roster_sync_singleton" CHECK ("singleton")
);

-- ── Role-guarded REVOKEs ────────────────────────────────────────────────────
-- Same belt as 0015 and 0017: a table created here falls under 0005's ALTER
-- DEFAULT PRIVILEGES grant to hx_readonly the moment it exists, and
-- ensureAppRoles only re-applies its REVOKEs on the next boot.
--
-- The roster is a DIRECTORY OF PEOPLE — names, addresses, team membership. The
-- cloud-served read roles serve session queries and have no business reading it.
-- hx_app_rw keeps its DML: the daemon receives the sync and writes it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hx_readonly') THEN
    REVOKE ALL ON hx.roster FROM hx_readonly;
    REVOKE ALL ON hx.roster_sync FROM hx_readonly;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hx_app_ro') THEN
    REVOKE ALL ON hx.roster FROM hx_app_ro;
    REVOKE ALL ON hx.roster_sync FROM hx_app_ro;
  END IF;
END $$;
