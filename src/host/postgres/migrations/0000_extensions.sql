-- Extensions used by the hx schema. All three ship in the stock zonky binary
-- bundle (standard contrib): pgcrypto for gen_random_uuid(), pg_trgm for
-- fuzzy/substring search, btree_gin for composite GIN indexes. pgvector is NOT
-- here — it is a separate, gated migration (see the embeddings migration).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;
