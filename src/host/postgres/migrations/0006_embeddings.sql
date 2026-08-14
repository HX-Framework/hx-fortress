-- pgvector-gated embeddings. The runner applies this migration ONLY when the
-- `vector` extension is installable (it is not in the stock zonky bundle); on
-- a bundle without pgvector it is skipped and retried on a later boot. Keeping
-- it out of the core 0000-0005 path means the schema installs unconditionally.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE hx.embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_kind text NOT NULL,
  owner_id uuid NOT NULL,
  model text NOT NULL,
  dim integer NOT NULL,
  embedding vector(1024),
  content_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX hx_embeddings_owner_idx ON hx.embeddings (owner_kind, owner_id);
CREATE INDEX hx_embeddings_hnsw_idx ON hx.embeddings USING hnsw (embedding vector_cosine_ops);

-- This table is created after 0005's blanket grant, so grant the read-only
-- role explicitly rather than relying on ALTER DEFAULT PRIVILEGES semantics.
GRANT SELECT ON hx.embeddings TO hx_readonly;
