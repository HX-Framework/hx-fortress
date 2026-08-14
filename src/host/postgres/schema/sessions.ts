import { sql } from "drizzle-orm";
import { doublePrecision, index, text, unique, uuid } from "drizzle-orm/pg-core";

import { bigCounter, counter, createdAt, deletedAt, pk, ts, updatedAt } from "./columns";
import { hxDevices, hxModels, hxOrgs, hxProjects, hxRepos, hxUsers } from "./dimensions";
import { hxSchema } from "./namespace";

export type HxTitleSource = "user" | "ai" | "fallback";
export type HxSessionOrigin = "local" | "let_ai_cloud";
export type HxAttributionSource = "auto" | "manual" | "recovered";
/** Which entry point FIRST wrote this session. Residency disclosure sends raw
 *  session ids only for provenance-proven cloud-relayed sessions, so this is a
 *  fail-private eligibility gate: only 'tunnel' is eligible. 'reconciled' shares
 *  the unknown-provenance bucket with NULL — the reconciler recovers a row after
 *  an index outage and cannot know how the bytes originally arrived. */
export type HxIngestChannel = "tunnel" | "gateway" | "reconciled";

// ── Sessions ────────────────────────────────────────────────────────────────
// One index row per mirrored session. Denormalized rollup counters live here
// (fast dashboards); the per-turn detail lives in hx_turns.

export const hxSessions = hxSchema.table(
  "sessions",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => hxUsers.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id").references(() => hxDevices.id, { onDelete: "set null" }),
    // Null org = Uncategorized (private to the user).
    orgId: uuid("org_id").references(() => hxOrgs.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => hxProjects.id, { onDelete: "set null" }),
    repoId: uuid("repo_id").references(() => hxRepos.id, { onDelete: "set null" }),
    // Primary/last model the session ran on.
    modelId: uuid("model_id").references(() => hxModels.id, { onDelete: "set null" }),
    family: text("family").notNull(),
    sessionId: text("session_id").notNull(),
    ccdSessionId: text("ccd_session_id"),
    title: text("title"),
    titleSource: text("title_source").$type<HxTitleSource>(),
    sourcePath: text("source_path"),
    cwd: text("cwd"),
    gitBranch: text("git_branch"),
    entrypoint: text("entrypoint"),
    originator: text("originator"),
    sessionOrigin: text("session_origin").$type<HxSessionOrigin>().notNull().default("local"),
    attributionSource: text("attribution_source").$type<HxAttributionSource>(),
    // Nullable: every session mirrored before this column existed predates the
    // provenance record and stays ineligible.
    ingestChannel: text("ingest_channel").$type<HxIngestChannel>(),
    assignedAt: ts("assigned_at"),
    assignedBy: text("assigned_by"),
    eventCount: counter("event_count"),
    userTextCount: counter("user_text_count"),
    assistantCount: counter("assistant_count"),
    toolCallCount: counter("tool_call_count"),
    inputTokens: bigCounter("input_tokens"),
    outputTokens: bigCounter("output_tokens"),
    cacheReadTokens: bigCounter("cache_read_tokens"),
    cacheCreationTokens: bigCounter("cache_creation_tokens"),
    estCostUsd: doublePrecision("est_cost_usd"),
    bytesUploaded: bigCounter("bytes_uploaded"),
    chunkCount: counter("chunk_count"),
    lastUserText: text("last_user_text"),
    lastAssistantText: text("last_assistant_text"),
    firstEventAt: ts("first_event_at"),
    lastActivityAt: ts("last_activity_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
    /** When this row's record count was last PROVEN whole against its canonical.
     *  NULL = never proven; this is what the unproven-backlog counts. */
    deepVerifiedAt: ts("deep_verified_at"),
    /** When the sweep last LOOKED at this row, whatever the outcome. Drives the
     *  rotation order so a row that can never be proven cannot wedge the queue
     *  at its head — see migration 0016. */
    deepAttemptedAt: ts("deep_attempted_at"),
  },
  (t) => [
    unique("hx_sessions_natural_unique").on(t.userId, t.family, t.sessionId),
    index("hx_sessions_user_activity_idx").on(t.userId, t.lastActivityAt),
    index("hx_sessions_org_activity_idx").on(t.orgId, t.lastActivityAt),
    index("hx_sessions_project_activity_idx").on(t.projectId, t.lastActivityAt),
    // FK cover: an unindexed foreign key makes every cascading delete scan this
    // whole table ONCE PER DELETED PARENT ROW. Declared here as well as in the
    // migration so drizzle-kit never generates a DROP for it.
    index("hx_sessions_device_id_idx").on(t.deviceId),
    // Sweep cursor: least-recently-proven first, live rows only.
    index("hx_sessions_deep_verify_idx")
      .on(t.deepAttemptedAt.nullsFirst())
      .where(sql`${t.deletedAt} is null`),
    index("hx_sessions_repo_idx").on(t.repoId),
    index("hx_sessions_model_idx").on(t.modelId),
  ],
);

// ── Child execution lanes (subagents + workflow agents) ─────────────────────
// One row per child transcript stream a session spawned. Their turns ARE
// indexed (into hx_turns with agent_id set) — fortress wants full RAG.

export type HxSessionAgentKind = "subagent" | "workflow_agent";

export const hxSessionAgents = hxSchema.table(
  "session_agents",
  {
    id: pk(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => hxSessions.id, { onDelete: "cascade" }),
    // The on-disk agent id (agent-<id>).
    agentExternalId: text("agent_external_id").notNull(),
    kind: text("kind").$type<HxSessionAgentKind>().notNull(),
    // Workflow run this lane belongs to (wf_…); null for plain subagents.
    runId: text("run_id"),
    // The parent transcript's tool_use id that spawned this lane (subagents only).
    toolUseId: text("tool_use_id"),
    agentType: text("agent_type"),
    label: text("label"),
    worktreePath: text("worktree_path"),
    cwd: text("cwd"),
    gitBranch: text("git_branch"),
    modelId: uuid("model_id").references(() => hxModels.id, { onDelete: "set null" }),
    eventCount: counter("event_count"),
    inputTokens: bigCounter("input_tokens"),
    outputTokens: bigCounter("output_tokens"),
    cacheReadTokens: bigCounter("cache_read_tokens"),
    cacheCreationTokens: bigCounter("cache_creation_tokens"),
    estCostUsd: doublePrecision("est_cost_usd"),
    bytesUploaded: bigCounter("bytes_uploaded"),
    chunkCount: counter("chunk_count"),
    lastActivityAt: ts("last_activity_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
    /** When this row's record count was last PROVEN whole against its canonical.
     *  NULL = never proven; this is what the unproven-backlog counts. */
    deepVerifiedAt: ts("deep_verified_at"),
    /** When the sweep last LOOKED at this row, whatever the outcome. Drives the
     *  rotation order so a row that can never be proven cannot wedge the queue
     *  at its head — see migration 0016. */
    deepAttemptedAt: ts("deep_attempted_at"),
  },
  (t) => [
    unique("hx_session_agents_natural_unique").on(t.sessionId, t.agentExternalId),
    // FK cover: an unindexed foreign key makes every cascading delete scan this
    // whole table ONCE PER DELETED PARENT ROW. Declared here as well as in the
    // migration so drizzle-kit never generates a DROP for it.
    index("hx_session_agents_model_id_idx").on(t.modelId),
    index("hx_session_agents_deep_verify_idx")
      .on(t.deepAttemptedAt.nullsFirst())
      .where(sql`${t.deletedAt} is null`),
    index("hx_session_agents_session_idx").on(t.sessionId),
  ],
);

export type HxSession = typeof hxSessions.$inferSelect;
export type HxSessionAgent = typeof hxSessionAgents.$inferSelect;
