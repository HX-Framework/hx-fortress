import { pgSchema } from "drizzle-orm/pg-core";

/** Every hx table is namespaced under the `hx` schema. Kept in its own module
 *  (no re-exports) so group modules can import it without a circular import
 *  through the aggregating `index.ts`. */
export const hxSchema = pgSchema("hx");
