import { date, index, jsonb, uuid } from "drizzle-orm/pg-core";

import { bigCounter, counter, createdAt, deletedAt, updatedAt } from "./columns";
import { hxUsers } from "./dimensions";
import { hxSchema } from "./namespace";
import { hxSessions } from "./sessions";

// ── Per-session productivity facts (§13-A4) ──────────────────────────────────
// One row per session, DERIVED AT INGEST from the session's turns + tool_calls
// (net-new: the shipped hx.analysis_* is per-run EAV and hx.usage_rollup is
// day-grained — neither is per-session productivity). Recomputed in the commit
// transaction on every chunk (and on `replace`), so the row always reflects the
// session's LIVE parent-lane turns/tool_calls — no double-count across replace.
//
// The §10 rollup reads this LIVE: `hx.session_facts JOIN live hx.sessions`,
// scoped by the workbench-resolved in-scope identities (A6) + the live
// `hx.sessions.deleted_at IS NULL` row. The facts row carries NO consent of its
// own; the fortress evaluates no org/repo predicate here.
//
// Bucketing (§10 — one source, one bucketing): every metric attributes WHOLLY to
// the session's PRIMARY DAY = date(min(event_ts)) in UTC (a fixed org/UTC basis
// keeps org/team day boundaries uniform across members' timezones). A session is
// one entity — it does not split across midnight.
//
// session_id is the PK (one facts row per session) AND the FK to hx.sessions, so
// a hard session delete cascades the facts row.

export const hxSessionFacts = hxSchema.table(
  "session_facts",
  {
    sessionId: uuid("session_id")
      .primaryKey()
      .references(() => hxSessions.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => hxUsers.id, { onDelete: "cascade" }),
    // date(min(event_ts)) in UTC — null only when the session has no known activity.
    primaryDay: date("primary_day", { mode: "string" }),
    // Idle-capped sum of inter-event gaps over the §10-filled event_ts.
    activeMs: bigCounter("active_ms"),
    userMsgs: counter("user_msgs"),
    assistantMsgs: counter("assistant_msgs"),
    // { [toolName]: count } over the session's tool_calls.
    toolCallsByType: jsonb("tool_calls_by_type").$type<Record<string, number>>().notNull().default({}),
    filesTouched: counter("files_touched"),
    linesAdded: counter("lines_added"),
    linesRemoved: counter("lines_removed"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [index("hx_session_facts_user_day_idx").on(t.userId, t.primaryDay)],
);

export type HxSessionFacts = typeof hxSessionFacts.$inferSelect;
