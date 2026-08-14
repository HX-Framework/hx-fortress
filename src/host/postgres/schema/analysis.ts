// ── jsonb columns in this schema are DOUBLE-ENCODED. Read this before writing
// any SQL that touches `payload`, `raw_event`, `input`, `result`, or
// `tool_calls_by_type`. ──────────────────────────────────────────────────────
//
// Every jsonb value written through drizzle's bun-sql driver is stored as a
// jsonb STRING SCALAR, not an object: `PgJsonb.mapToDriver` JSON.stringify's the
// value and Bun.SQL binds that string. On the reference deployment this is 100%
// of rows in every jsonb column.
//
// The application is unaffected — `mapFromDriver` JSON.parses it back, so reads
// and writes round-trip correctly, which is why nothing has ever broken.
//
// SQL is affected, SILENTLY. `payload -> 'chunk'` yields NULL rather than
// erroring, and `payload ? 'chunk'` is false. Every JSON path over the audit
// trail returns NULL unless the text is unwrapped and re-parsed first:
//
//     ((payload #>> '{}')::jsonb -> 'chunk' ->> 'totalBytes')::bigint
//
// This has already produced a false "0 sessions affected" during an incident
// investigation. It also means a GIN index on any of these columns, or a
// migration/backfill that reads them with jsonb operators, would be quietly
// wrong. Deliberately NOT re-encoded: the corpus is ~274k rows, nothing in
// src/ uses jsonb operators (the detectors in ingest/health.ts unwrap), and a
// rewrite would be risk without present benefit. Pinned by a test so any future
// change to the encoding is a decision rather than an accident.
import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { bigCounter, counter, createdAt, deletedAt, pk, ts, updatedAt } from "./columns";
import { hxModels, hxProjects, hxUsers } from "./dimensions";
import { hxSchema } from "./namespace";
import { hxSessions } from "./sessions";

export type HxIngestEventStatus = "pending" | "processed" | "failed" | "ignored";
export type HxAnalysisKind = "script" | "agent";
export type HxAnalysisRunStatus = "running" | "complete" | "failed";

// ── Ingest events — audit + trigger spine ───────────────────────────────────

export const hxIngestEvents = hxSchema.table(
  "ingest_events",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => hxUsers.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    sessionId: uuid("session_id").references(() => hxSessions.id, { onDelete: "set null" }),
    family: text("family"),
    // The client-side session id string (distinct from the FK above).
    sessionIdExt: text("session_id_ext"),
    chunkId: text("chunk_id"),
    dedupeKey: text("dedupe_key"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<HxIngestEventStatus>().notNull().default("pending"),
    error: text("error"),
    processedAt: ts("processed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex("hx_ingest_events_dedupe_unique")
      .on(t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL`),
    index("hx_ingest_events_user_created_idx").on(t.userId, t.createdAt),
    index("hx_ingest_events_status_created_idx").on(t.status, t.createdAt),
    index("hx_ingest_events_session_created_idx").on(t.sessionId, t.createdAt),
  ],
);

// ── Analysis definitions / runs / facts ─────────────────────────────────────

export const hxAnalysisDefinitions = hxSchema.table(
  "analysis_definitions",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => hxUsers.id, { onDelete: "cascade" }),
    kind: text("kind").$type<HxAnalysisKind>().notNull(),
    name: text("name").notNull(),
    version: integer("version").notNull().default(1),
    description: text("description"),
    inputSchema: jsonb("input_schema").notNull(),
    outputSchema: jsonb("output_schema").notNull(),
    projection: jsonb("projection").notNull(),
    body: text("body").notNull(),
    status: text("status").$type<"active" | "archived">().notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [index("hx_analysis_definitions_user_kind_idx").on(t.userId, t.kind)],
);

export const hxAnalysisRuns = hxSchema.table(
  "analysis_runs",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => hxUsers.id, { onDelete: "cascade" }),
    definitionId: uuid("definition_id").references(() => hxAnalysisDefinitions.id, {
      onDelete: "set null",
    }),
    kind: text("kind").$type<HxAnalysisKind>().notNull(),
    status: text("status").$type<HxAnalysisRunStatus>().notNull(),
    sourceScope: jsonb("source_scope").notNull(),
    parameters: jsonb("parameters").notNull(),
    output: jsonb("output"),
    outputSummary: text("output_summary"),
    modelId: uuid("model_id").references(() => hxModels.id, { onDelete: "set null" }),
    usage: jsonb("usage"),
    error: text("error"),
    startedAt: ts("started_at").notNull(),
    endedAt: ts("ended_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index("hx_analysis_runs_user_status_idx").on(t.userId, t.status),
    index("hx_analysis_runs_user_started_idx").on(t.userId, t.startedAt),
    // FK cover: an unindexed foreign key makes every cascading delete scan this
    // whole table ONCE PER DELETED PARENT ROW. Declared here as well as in the
    // migration so drizzle-kit never generates a DROP for it.
    index("hx_analysis_runs_definition_id_idx").on(t.definitionId),
    index("hx_analysis_runs_model_id_idx").on(t.modelId),
  ],
);

// Junction: which sessions fed a run (replaces a jsonb id array → real FKs).
export const hxAnalysisRunSessions = hxSchema.table(
  "analysis_run_sessions",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => hxAnalysisRuns.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => hxSessions.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.sessionId] }),
    index("hx_analysis_run_sessions_session_idx").on(t.sessionId),
  ],
);

export const hxAnalysisFacts = hxSchema.table(
  "analysis_facts",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => hxUsers.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => hxAnalysisRuns.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => hxSessions.id, { onDelete: "set null" }),
    path: text("path").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    valueText: text("value_text"),
    valueNumber: doublePrecision("value_number"),
    valueBool: boolean("value_bool"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index("hx_analysis_facts_user_key_idx").on(t.userId, t.key),
    index("hx_analysis_facts_run_idx").on(t.runId),
    index("hx_analysis_facts_session_idx").on(t.sessionId),
  ],
);

// ── Usage rollup — day × user × project × model, for cheap trend dashboards ──

export const hxUsageRollup = hxSchema.table(
  "usage_rollup",
  {
    id: pk(),
    bucketDate: date("bucket_date", { mode: "string" }).notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => hxUsers.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => hxProjects.id, { onDelete: "set null" }),
    modelId: uuid("model_id").references(() => hxModels.id, { onDelete: "set null" }),
    sessionCount: counter("session_count"),
    turnCount: counter("turn_count"),
    inputTokens: bigCounter("input_tokens"),
    outputTokens: bigCounter("output_tokens"),
    cacheReadTokens: bigCounter("cache_read_tokens"),
    cacheCreationTokens: bigCounter("cache_creation_tokens"),
    estCostUsd: doublePrecision("est_cost_usd").notNull().default(0),
    computedAt: timestamp("computed_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    unique("hx_usage_rollup_grain_unique")
      .on(t.bucketDate, t.userId, t.projectId, t.modelId)
      .nullsNotDistinct(),
    // FK cover: an unindexed foreign key makes every cascading delete scan this
    // whole table ONCE PER DELETED PARENT ROW. Declared here as well as in the
    // migration so drizzle-kit never generates a DROP for it.
    index("hx_usage_rollup_user_id_idx").on(t.userId),
    index("hx_usage_rollup_project_id_idx").on(t.projectId),
    index("hx_usage_rollup_model_id_idx").on(t.modelId),
  ],
);

export type HxIngestEvent = typeof hxIngestEvents.$inferSelect;
export type HxAnalysisDefinition = typeof hxAnalysisDefinitions.$inferSelect;
export type HxAnalysisRun = typeof hxAnalysisRuns.$inferSelect;
export type HxAnalysisFact = typeof hxAnalysisFacts.$inferSelect;
export type HxUsageRollup = typeof hxUsageRollup.$inferSelect;

// ── Chunk intents ───────────────────────────────────────────────────────────
// One row per chunk whose bytes were composed into a canonical, written BEFORE
// the fortress acks. `cleared_at` is set inside the transaction that indexes it,
// so an UNCLEARED row means: the bytes are in object storage and the turns may
// not be in the index. See migration 0017 for why this is a separate table and
// why the remedy is "make the guarantor look at this session", not a replay.
export const hxChunkIntents = hxSchema.table(
  "chunk_intents",
  {
    id: pk(),
    /** The client's identity, deliberately not a row reference — an intent is
     *  recorded before the session row need exist. */
    userExternalId: text("user_external_id").notNull(),
    family: text("family").notNull(),
    sessionId: text("session_id").notNull(),
    /** Set for an agent-lane chunk; NULL for a parent chunk. */
    agentExternalId: text("agent_external_id"),
    chunkId: text("chunk_id").notNull(),
    /** The canonical's size as the store reported it after composing. */
    totalBytes: bigCounter("total_bytes"),
    createdAt: createdAt(),
    /** NULL = composed but possibly unindexed. */
    clearedAt: ts("cleared_at"),
  },
  (t) => [
    unique("hx_chunk_intents_identity_unique")
      .on(t.userExternalId, t.family, t.sessionId, t.agentExternalId, t.chunkId)
      .nullsNotDistinct(),
    index("hx_chunk_intents_uncleared_idx")
      .on(t.createdAt)
      .where(sql`${t.clearedAt} is null`),
  ],
);
