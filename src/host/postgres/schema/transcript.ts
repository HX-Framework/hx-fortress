import { sql, type SQL } from "drizzle-orm";
import {
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAt, deletedAt, pk, ts, updatedAt } from "./columns";
import { hxModels } from "./dimensions";
import { hxSchema } from "./namespace";
import { hxSessionAgents, hxSessions } from "./sessions";

/** Postgres `tsvector` — no native Drizzle type, so a thin customType. */
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export type HxTurnRole = "user" | "assistant" | "system";

// The per-content-block classification persisted at ingest — the 10-value
// taxonomy ported from workbench's `parseTranscript` into the fortress's shared
// classifier (src/ingest/classify.ts). `role` (3-value) is kept NOT NULL for
// back-compat but is vestigial; `kind` is the real discriminator that search and
// the embed gate read off (`indexable := kind IN ('user_text','assistant_text')`).
export type HxTurnKind =
  | "user_text"
  | "assistant_text"
  | "tool_use"
  | "tool_result"
  | "thinking"
  | "system_notice"
  | "attachment_notice"
  | "todo_reminder"
  | "image"
  | "queue_enqueue";

// ── Unified transcript ──────────────────────────────────────────────────────
// One row per classified content block/item, for BOTH the parent session
// (agent_id null) and every child lane (agent_id set). tool_use/tool_result also
// get a row here (their text projected into the capped `text` so the broad
// `text_tsv` covers tool output/logs/code); the structured tool payload still
// lands in hx_tool_calls for clean aggregations.

export const hxTurns = hxSchema.table(
  "turns",
  {
    id: pk(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => hxSessions.id, { onDelete: "cascade" }),
    // Null = parent lane; set = a child (subagent/workflow) lane.
    agentId: uuid("agent_id").references(() => hxSessionAgents.id, { onDelete: "cascade" }),
    // Dense emission ordinal within the lane (session_id + agent_id) — what the
    // read path's `fromIndex` pages, NOT the JSONL line index.
    seq: integer("seq").notNull(),
    role: text("role").$type<HxTurnRole>().notNull(),
    // 10-value classification (nullable for text-less kinds like image/queue).
    kind: text("kind").$type<HxTurnKind>(),
    modelId: uuid("model_id").references(() => hxModels.id, { onDelete: "set null" }),
    eventTs: ts("event_ts"),
    // Capped, searchable text. Nullable: text-less kinds (image) carry no text.
    text: text("text"),
    // Convenience copy of the source event; the durable vault blob is the real
    // rebuild source, so this is not load-bearing.
    rawEvent: jsonb("raw_event").$type<Record<string, unknown>>(),
    // Per-turn usage (nullable — populated on assistant turns).
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheCreationTokens: integer("cache_creation_tokens"),
    estCostUsd: doublePrecision("est_cost_usd"),
    textTsv: tsvector("text_tsv").generatedAlwaysAs(
      (): SQL => sql`to_tsvector('english', ${hxTurns.text})`,
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    // NULLS NOT DISTINCT so two parent-lane turns (agent_id null) can't share a seq.
    unique("hx_turns_lane_seq_unique").on(t.sessionId, t.agentId, t.seq).nullsNotDistinct(),
    index("hx_turns_tsv_idx").using("gin", t.textTsv),
    index("hx_turns_text_trgm_idx").using("gin", t.text.op("gin_trgm_ops")),
    // FK cover: an unindexed foreign key makes every cascading delete scan this
    // whole table ONCE PER DELETED PARENT ROW. Declared here as well as in the
    // migration so drizzle-kit never generates a DROP for it.
    index("hx_turns_agent_id_idx").on(t.agentId),
    index("hx_turns_session_seq_idx").on(t.sessionId, t.seq),
    index("hx_turns_role_idx").on(t.role),
    index("hx_turns_kind_idx").on(t.kind),
    index("hx_turns_model_idx").on(t.modelId),
    index("hx_turns_event_ts_idx").on(t.eventTs),
  ],
);

// ── Structured tool calls ───────────────────────────────────────────────────
// tool_use/tool_result projected to columns (not generic turns) so the SQL
// agent gets clean tool-usage / failure-rate aggregations.

export const hxToolCalls = hxSchema.table(
  "tool_calls",
  {
    id: pk(),
    turnId: uuid("turn_id").references(() => hxTurns.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => hxSessions.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => hxSessionAgents.id, { onDelete: "cascade" }),
    toolUseId: text("tool_use_id").notNull(),
    toolName: text("tool_name").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    isError: boolean("is_error").notNull().default(false),
    status: text("status"),
    eventTs: ts("event_ts"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    unique("hx_tool_calls_natural_unique").on(t.sessionId, t.toolUseId),
    // FK cover: an unindexed foreign key makes every cascading delete scan this
    // whole table ONCE PER DELETED PARENT ROW. Declared here as well as in the
    // migration so drizzle-kit never generates a DROP for it.
    index("hx_tool_calls_turn_id_idx").on(t.turnId),
    index("hx_tool_calls_agent_id_idx").on(t.agentId),
    index("hx_tool_calls_session_tool_idx").on(t.sessionId, t.toolName),
    index("hx_tool_calls_tool_idx").on(t.toolName),
  ],
);

export type HxTurn = typeof hxTurns.$inferSelect;
export type HxToolCall = typeof hxToolCalls.$inferSelect;
