import { index, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import { hxSchema } from "./namespace";

// Session-delete tombstones (permanent). DELIBERATELY hard-shaped — no pk(),
// no deleted_at: a tombstone IS the record of a hard delete, keyed by the
// client-reconstructible session identity so every ingest surface can refuse
// re-uploads forever. Rows are never deleted; they carry zero content (the
// external user id, family and session UUID only).
//
// Keyed by the EXTERNAL user id (what capability tokens / vault RPC keys carry),
// not the hx.users dimension row — the guard must hold even before/without a
// dimension row for the user.
export const hxDeletedSessions = hxSchema.table(
  "deleted_sessions",
  {
    userExternalId: text("user_external_id").notNull(),
    family: text("family").notNull(),
    sessionId: text("session_id").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userExternalId, t.family, t.sessionId] }),
    // Cross-family guard lookups (child/sidecar uploads can carry a stale
    // family; the tombstone must still match on (user, sessionId)).
    index("hx_deleted_sessions_user_session_idx").on(t.userExternalId, t.sessionId),
  ],
);
