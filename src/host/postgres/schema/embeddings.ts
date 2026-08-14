import { index, integer, text, uuid, vector } from "drizzle-orm/pg-core";

import { createdAt, deletedAt, pk, updatedAt } from "./columns";
import { hxSchema } from "./namespace";

// NOTE: deliberately NOT re-exported from ./index (the drizzle-kit generate
// barrel). pgvector isn't in the stock zonky bundle, so this table ships via a
// hand-authored, gated migration (0006_embeddings) rather than `generate`.
// The Drizzle definition here is for query typing once vectors are populated.

export type HxEmbeddingOwnerKind = "turn" | "session_summary";

/** The embedding dimension. Single knob to revisit when the model is chosen. */
export const HX_EMBEDDING_DIM = 1024;

export const hxEmbeddings = hxSchema.table(
  "embeddings",
  {
    id: pk(),
    ownerKind: text("owner_kind").$type<HxEmbeddingOwnerKind>().notNull(),
    ownerId: uuid("owner_id").notNull(),
    model: text("model").notNull(),
    dim: integer("dim").notNull(),
    embedding: vector("embedding", { dimensions: HX_EMBEDDING_DIM }),
    contentHash: text("content_hash"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [index("hx_embeddings_owner_idx").on(t.ownerKind, t.ownerId)],
);

export type HxEmbedding = typeof hxEmbeddings.$inferSelect;
