// When a LOAD's table is parked (park.ts): a while after a step read it, so the program's next
// steps, which often read the same table, find it in the store.

import { LOADED_GROUP } from "../../store-readers/src/jobs.js";
import type { StoreCore } from "./core.js";

/** How long after a SHAPE read a LOAD's table the store parks it. */
export const PARK_AFTER_MS = 10 * 60_000;

/** What the store says of a parked table a call or a step reads. */
export const parkedWords = (table: string): string => `${table} is parked: its rows are in the store's files, not its database. Bring it back to read it.`;

/** Gives LOAD tables a step read their time to park, unless they are parked already. */
export function parkLater(core: StoreCore, tables: readonly string[]): void {
  const at = new Date(core.deps.now() + (core.deps.parkAfterMs ?? PARK_AFTER_MS)).toISOString();
  for (const table of tables) {
    core.sql.exec("UPDATE _tables SET park_at = ? WHERE lower(name) = lower(?) AND kind = 'program' AND grp = ? AND parked IS NULL", at, table, LOADED_GROUP);
  }
}
