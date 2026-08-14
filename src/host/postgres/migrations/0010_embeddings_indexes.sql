-- pgvector-gated embeddings indexes (A7). These touch the GATED hx.embeddings
-- table (created by 0006, which is itself `requires:"vector"`), so this MUST be
-- its own gated migration — NOT folded into the already-recorded 0006. The
-- append-only runner skips recorded names, so editing 0006 in place would never
-- re-run; on a non-pgvector fortress hx.embeddings does not exist, so an
-- ungated CREATE INDEX here would throw "relation does not exist" at boot.
--
--   • content_hash btree — the embed worker's vector-reuse lookup (skip the
--     OpenAI call when identical text was already embedded).
--   • UNIQUE(owner_kind, owner_id) — write-idempotency for the worker's
--     `INSERT … ON CONFLICT (owner_kind, owner_id) DO NOTHING`. The anti-join
--     alone can't stop a concurrent double-claim / crash-after-OpenAI-before-
--     insert from duplicating a vector; the unique index is the fence. Plain
--     UNIQUE (not a partial on deleted_at IS NULL) is correct because the
--     embeddings hard-delete policy means a soft-deleted vector never exists
--     (a soft-deleted vector would stay live in the HNSW and waste RAM).
CREATE INDEX IF NOT EXISTS hx_embeddings_content_hash_idx ON hx.embeddings (content_hash);
CREATE UNIQUE INDEX IF NOT EXISTS hx_embeddings_owner_unique ON hx.embeddings (owner_kind, owner_id);
