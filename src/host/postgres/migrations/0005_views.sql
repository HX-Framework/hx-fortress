-- Read-only role + curated views for the NL->SQL analysis agent. The agent
-- targets the views (simpler joins) and the role guarantees it can't mutate.
-- RLS is intentionally omitted — fortress is single-tenant.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hx_readonly') THEN
    CREATE ROLE hx_readonly NOLOGIN;
  END IF;
END $$;

CREATE OR REPLACE VIEW hx.v_session_overview AS
SELECT s.id,
       s.user_id,
       s.family,
       s.session_id,
       s.title,
       s.session_origin,
       s.event_count,
       s.tool_call_count,
       s.input_tokens,
       s.output_tokens,
       s.cache_read_tokens,
       s.cache_creation_tokens,
       s.est_cost_usd,
       s.first_event_at,
       s.last_activity_at,
       o.name  AS org_name,
       p.name  AS project_name,
       r.slug  AS repo_slug,
       m.model_id AS model
FROM hx.sessions s
LEFT JOIN hx.orgs o     ON o.id = s.org_id
LEFT JOIN hx.projects p ON p.id = s.project_id
LEFT JOIN hx.repos r    ON r.id = s.repo_id
LEFT JOIN hx.models m   ON m.id = s.model_id
WHERE s.deleted_at IS NULL;

CREATE OR REPLACE VIEW hx.v_turn_search AS
SELECT t.id,
       t.session_id,
       t.agent_id,
       t.seq,
       t.role,
       t.text,
       t.event_ts,
       m.model_id  AS model,
       s.user_id,
       s.project_id
FROM hx.turns t
JOIN hx.sessions s    ON s.id = t.session_id
LEFT JOIN hx.models m ON m.id = t.model_id
WHERE t.deleted_at IS NULL;

GRANT USAGE ON SCHEMA hx TO hx_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA hx TO hx_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA hx GRANT SELECT ON TABLES TO hx_readonly;
