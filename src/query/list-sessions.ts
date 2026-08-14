// Prepared "my sessions" read against the fortress hx Postgres (MC-2415). The
// cloud relays this over the tunnel for a fortress-backed org instead of reading
// its own workbench-db mirror, so the fortress is the single source of truth for
// session metadata. Names (org/project/repo/model/device) are resolved here from
// the mirrored dimension tables — the cloud renders the row with no further
// joins. We query hx.sessions directly (a superset of v_session_overview) so the
// list gets the columns that view omits, without mutating the shared analysis
// view the NL->SQL agent depends on.

import { and, eq, isNull, sql } from "drizzle-orm";

import type { HxDb } from "../host/postgres/db.js";
import {
  hxDevices,
  hxModels,
  hxOrgs,
  hxProjects,
  hxRepos,
  hxSessions,
  hxUsers,
} from "../host/postgres/schema/index.js";
import type { FortressSessionRow } from "../modules/session-vault/store/rpc.js";

// MC-2606: the "my sessions" title-donor read (readFortressSessionsForList in
// the workbench) calls listSessions with NO limit, so this DEFAULT is what gates
// how many of a user's sessions get their fortress title. At 500 a user with
// >500 sessions saw the rest render id-only. Raised to cover every real user;
// ~0.8 KB/row × 5000 ≈ 4 MB, well under the 32 MB tunnel frame (maxTunnelResultBytes).
const DEFAULT_LIMIT = 5000;
const MAX_LIMIT = 5000;

export interface ListSessionsOptions {
  /** Cloud user id, carried as hx_users.external_id. */
  userId: string;
  limit?: number;
}

/** List one user's sessions (most recent first), shaped for the cloud's "my
 *  sessions" view. Filters to the user via the reconciled external id and
 *  excludes soft-deleted rows. */
export async function listSessionsForUser(
  db: HxDb,
  opts: ListSessionsOptions,
): Promise<FortressSessionRow[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const rows = await db
    .select({
      family: hxSessions.family,
      sessionId: hxSessions.sessionId,
      title: hxSessions.title,
      titleSource: hxSessions.titleSource,
      cwd: hxSessions.cwd,
      gitBranch: hxSessions.gitBranch,
      sourcePath: hxSessions.sourcePath,
      repoSlug: hxRepos.slug,
      orgName: hxOrgs.name,
      projectName: hxProjects.name,
      model: hxModels.modelId,
      eventCount: hxSessions.eventCount,
      userTextCount: hxSessions.userTextCount,
      assistantCount: hxSessions.assistantCount,
      toolCallCount: hxSessions.toolCallCount,
      inputTokens: hxSessions.inputTokens,
      outputTokens: hxSessions.outputTokens,
      cacheReadTokens: hxSessions.cacheReadTokens,
      cacheCreationTokens: hxSessions.cacheCreationTokens,
      estCostUsd: hxSessions.estCostUsd,
      bytesUploaded: hxSessions.bytesUploaded,
      deviceName: hxDevices.name,
      firstEventAt: hxSessions.firstEventAt,
      lastActivityAt: hxSessions.lastActivityAt,
      createdAt: hxSessions.createdAt,
      updatedAt: hxSessions.updatedAt,
    })
    .from(hxSessions)
    .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
    .leftJoin(hxOrgs, eq(hxOrgs.id, hxSessions.orgId))
    .leftJoin(hxProjects, eq(hxProjects.id, hxSessions.projectId))
    .leftJoin(hxRepos, eq(hxRepos.id, hxSessions.repoId))
    .leftJoin(hxModels, eq(hxModels.id, hxSessions.modelId))
    .leftJoin(hxDevices, eq(hxDevices.id, hxSessions.deviceId))
    .where(and(eq(hxUsers.externalId, opts.userId), isNull(hxSessions.deletedAt)))
    .orderBy(sql`${hxSessions.lastActivityAt} DESC NULLS LAST`)
    .limit(limit);

  return rows.map((r) => ({
    family: r.family,
    sessionId: r.sessionId,
    title: r.title,
    titleSource: r.titleSource,
    cwd: r.cwd,
    gitBranch: r.gitBranch,
    sourcePath: r.sourcePath,
    repoSlug: r.repoSlug,
    orgName: r.orgName,
    projectName: r.projectName,
    model: r.model,
    eventCount: r.eventCount,
    userTextCount: r.userTextCount,
    assistantCount: r.assistantCount,
    toolCallCount: r.toolCallCount,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheCreationTokens: r.cacheCreationTokens,
    estCostUsd: r.estCostUsd,
    bytesUploaded: r.bytesUploaded,
    deviceName: r.deviceName,
    // first_event_at is nullable for a session that only ever logged metadata;
    // fall back to the row's creation time so the cloud always has a timestamp.
    firstSeenAt: r.firstEventAt ?? r.createdAt,
    lastActivityAt: r.lastActivityAt,
    updatedAt: r.updatedAt,
  }));
}
