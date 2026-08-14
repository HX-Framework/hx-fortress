import { bigint, integer, timestamp, uuid } from "drizzle-orm/pg-core";

// Shared column builders so every hx table follows the same conventions:
// uuid PKs, timestamptz audit columns, soft-delete.

/** uuid primary key. At runtime Drizzle inserts a time-ordered UUIDv7
 *  (index-friendly); `gen_random_uuid()` is the DB-side DEFAULT so direct SQL
 *  inserts still get a key. */
export const pk = () =>
  uuid("id")
    .primaryKey()
    .defaultRandom()
    .$defaultFn(() => Bun.randomUUIDv7());

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow();

/** Soft-delete marker — every entity has one; reads filter `deleted_at IS NULL`. */
export const deletedAt = () => timestamp("deleted_at", { withTimezone: true, mode: "string" });

/** timestamptz column helper for the many nullable activity/seen timestamps. */
export const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

/** Accumulated non-negative counter, `NOT NULL DEFAULT 0`. */
export const counter = (name: string) => integer(name).notNull().default(0);

/** Like `counter` but bigint, for byte totals that can exceed int range. */
export const bigCounter = (name: string) =>
  bigint(name, { mode: "number" }).notNull().default(0);
