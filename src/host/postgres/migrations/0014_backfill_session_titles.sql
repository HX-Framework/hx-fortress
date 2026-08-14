-- MC-2606 follow-up — backfill fallback titles for pre-existing title-less sessions.
--
-- The hx client only synthesizes a session title on a FROM-ZERO upload
-- (hx/src/watch.ts, stepOffset === 0). A session first uploaded by a client that
-- predated that logic — or in the pre-fortress era, when the title lived only in
-- the workbench Postgres that MC-2606 has since scrubbed — sits here with title
-- NULL and renders as a bare session id in the cloud UI. A resume can't heal it
-- (a resume is an append, offset > 0, so no title is re-sent), so this one-shot,
-- idempotent pass derives a title from each session's first user turn — the same
-- logic as the client + the runtime ingest path (src/ingest/derive-title.ts) —
-- and fills ONLY null titles. Going forward ingestCommit derives titles inline,
-- so no session should reach this state again.
--
-- The derivation lives in pg_temp functions (this migration runs as one
-- simple-query batch on one connection; pg_temp is dropped automatically when
-- that connection closes) so it never pollutes the hx schema. String-only +
-- IMMUTABLE — a re-run is harmless.

CREATE FUNCTION pg_temp.hx_first_line_label(txt text) RETURNS text AS $fn$
DECLARE
  cap constant int := 80;
  one_line text;
  clipped text;
  rev_pos int;
  last_space int;
  base text;
BEGIN
  IF txt IS NULL THEN RETURN NULL; END IF;
  -- first line, whitespace-collapsed and trimmed
  one_line := btrim(regexp_replace(split_part(txt, E'\n', 1), '\s+', ' ', 'g'));
  IF one_line = '' THEN RETURN NULL; END IF;
  IF char_length(one_line) <= cap THEN RETURN one_line; END IF;
  clipped := left(one_line, cap);
  -- 0-based index of the last space (JS lastIndexOf), -1 when there is none
  rev_pos := position(' ' in reverse(clipped));
  last_space := CASE WHEN rev_pos = 0 THEN -1 ELSE char_length(clipped) - rev_pos END;
  IF last_space >= cap * 0.6 THEN
    base := left(clipped, last_space);   -- first `last_space` chars == JS slice(0, lastSpace)
  ELSE
    base := clipped;
  END IF;
  base := regexp_replace(base, '[[:space:].,;:!?—-]+$', '');
  RETURN base || '…';
END;
$fn$ LANGUAGE plpgsql IMMUTABLE;
--> statement-breakpoint

CREATE FUNCTION pg_temp.hx_fallback_title(first_user_text text, cwd text, repo_slug text) RETURNS text AS $fn$
DECLARE
  from_msg text;
  parts text[];
  repo text;
  base_seg text;
BEGIN
  from_msg := pg_temp.hx_first_line_label(first_user_text);
  IF from_msg IS NOT NULL THEN RETURN from_msg; END IF;
  -- repo slug's last segment
  IF repo_slug IS NOT NULL THEN
    parts := string_to_array(repo_slug, '/');
    repo := btrim(coalesce(parts[array_length(parts, 1)], ''));
    IF repo <> '' THEN RETURN repo; END IF;
  END IF;
  -- cwd's last non-empty, non-dot path segment
  IF cwd IS NOT NULL THEN
    SELECT u.seg INTO base_seg
    FROM unnest(regexp_split_to_array(cwd, '[/\\]+')) WITH ORDINALITY AS u(seg, ord)
    WHERE u.seg <> '' AND u.seg <> '.' AND u.seg <> '..'
    ORDER BY u.ord DESC
    LIMIT 1;
    IF base_seg IS NOT NULL AND btrim(base_seg) <> '' THEN RETURN btrim(base_seg); END IF;
  END IF;
  RETURN NULL;
END;
$fn$ LANGUAGE plpgsql IMMUTABLE;
--> statement-breakpoint

WITH derived AS (
  SELECT
    s.id,
    pg_temp.hx_fallback_title(
      (
        SELECT t.text FROM hx.turns t
        WHERE t.session_id = s.id AND t.agent_id IS NULL AND t.kind = 'user_text' AND t.text IS NOT NULL
        ORDER BY t.seq
        LIMIT 1
      ),
      s.cwd,
      (SELECT r.slug FROM hx.repos r WHERE r.id = s.repo_id)
    ) AS title
  FROM hx.sessions s
  WHERE s.title IS NULL AND s.deleted_at IS NULL
)
UPDATE hx.sessions s
SET title = d.title, title_source = 'fallback'
FROM derived d
WHERE s.id = d.id AND d.title IS NOT NULL AND s.title IS NULL;
