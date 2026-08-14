-- 0011 · widen session-level token counters to bigint. A long session's summed
-- cache_read_tokens routinely exceeds int4 (2,147,483,647) — a real 40 MB session
-- summed to 2.24B cache-read tokens — which overflowed the integer column and
-- dropped the whole session on ingest ("integer out of range"). Per-turn columns
-- (hx.turns) stay integer (a single turn is bounded). v_session_overview passes
-- these columns through, so drop + recreate it around the ALTERs.

DROP VIEW IF EXISTS hx.v_session_overview;

ALTER TABLE hx.sessions
  ALTER COLUMN input_tokens TYPE bigint,
  ALTER COLUMN output_tokens TYPE bigint,
  ALTER COLUMN cache_read_tokens TYPE bigint,
  ALTER COLUMN cache_creation_tokens TYPE bigint;

ALTER TABLE hx.session_agents
  ALTER COLUMN input_tokens TYPE bigint,
  ALTER COLUMN output_tokens TYPE bigint,
  ALTER COLUMN cache_read_tokens TYPE bigint,
  ALTER COLUMN cache_creation_tokens TYPE bigint;

CREATE VIEW hx.v_session_overview AS
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
