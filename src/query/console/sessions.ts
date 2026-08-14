// The console's session list, projected column by column.
//
// The projection is written out rather than derived from a table object, and
// that is the point: `select(hxSessions)` would carry every column the schema
// grows, including the two the column grant withholds, and the failure would be
// a runtime "permission denied" on a page that used to work. An explicit list
// fails at review instead.
//
// Search is deliberately narrow — title, cwd, branch, repository slug, session
// id. There is no content column in the projection, in a JOIN, in a WHERE or in
// an ORDER BY, which the boundary test proves by rendering every statement this
// module builds and grepping it.

import { sql, type SQL } from "drizzle-orm";

import { consoleUniversePredicate, type ConsoleUniverse } from "./universe";

export interface ConsoleSessionsInput {
  universe: ConsoleUniverse;
  /** Matched against title, cwd, branch, repo slug and session id — nothing else. */
  search?: string;
  family?: string;
  userExternalId?: string;
  /** ISO instants bounding last_activity_at. */
  from?: string;
  to?: string;
  limit?: number;
  /** Opaque keyset cursor from a previous page. */
  cursor?: string;
}

export const CONSOLE_PAGE_DEFAULT = 50;
export const CONSOLE_PAGE_MAX = 200;

export interface ConsoleSessionRow {
  id: string;
  sessionId: string;
  family: string;
  title: string | null;
  titleSource: string | null;
  cwd: string | null;
  gitBranch: string | null;
  sourcePath: string | null;
  ingestChannel: string | null;
  eventCount: number;
  userTextCount: number;
  assistantCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number | null;
  bytesUploaded: number;
  chunkCount: number;
  firstEventAt: string | null;
  lastActivityAt: string | null;
  userExternalId: string;
  userDisplayName: string | null;
  deviceName: string | null;
  repoSlug: string | null;
}

/** Every column the console projects, aliased to the shape above. Enumerated in
 *  one place so the SELECT list and the row type cannot drift. */
const PROJECTION = sql`
  s.id                    AS "id",
  s.session_id            AS "sessionId",
  s.family                AS "family",
  s.title                 AS "title",
  s.title_source          AS "titleSource",
  s.cwd                   AS "cwd",
  s.git_branch            AS "gitBranch",
  s.source_path           AS "sourcePath",
  s.ingest_channel        AS "ingestChannel",
  s.event_count           AS "eventCount",
  s.user_text_count       AS "userTextCount",
  s.assistant_count       AS "assistantCount",
  s.tool_call_count       AS "toolCallCount",
  s.input_tokens          AS "inputTokens",
  s.output_tokens         AS "outputTokens",
  s.est_cost_usd          AS "estCostUsd",
  s.bytes_uploaded        AS "bytesUploaded",
  s.chunk_count           AS "chunkCount",
  s.first_event_at        AS "firstEventAt",
  s.last_activity_at      AS "lastActivityAt",
  u.external_id           AS "userExternalId",
  u.display_name          AS "userDisplayName",
  d.name                  AS "deviceName",
  r.slug                  AS "repoSlug"`;

const FROM = sql`
  FROM hx.sessions s
  JOIN hx.users u ON u.id = s.user_id
  LEFT JOIN hx.devices d ON d.id = s.device_id
  LEFT JOIN hx.repos r ON r.id = s.repo_id`;

export interface Keyset {
  lastActivityAt: string | null;
  id: string;
}

export function encodeConsoleCursor(key: Keyset): string {
  return Buffer.from(`${key.lastActivityAt ?? ""}|${key.id}`).toString("base64url");
}

export function decodeConsoleCursor(raw: string): Keyset | null {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const idx = decoded.indexOf("|");
    if (idx < 0) return null;
    const id = decoded.slice(idx + 1);
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return null;
    return { lastActivityAt: decoded.slice(0, idx) || null, id };
  } catch {
    return null;
  }
}

export function consolePageLimit(requested: number | undefined): number {
  const n = Number(requested);
  if (!Number.isFinite(n)) return CONSOLE_PAGE_DEFAULT;
  return Math.min(Math.max(1, Math.trunc(n)), CONSOLE_PAGE_MAX);
}

function filters(input: ConsoleSessionsInput): SQL[] {
  const out: SQL[] = [consoleUniversePredicate(input.universe)];
  if (input.family) out.push(sql`s.family = ${input.family}`);
  if (input.userExternalId) out.push(sql`u.external_id = ${input.userExternalId}`);
  if (input.from) out.push(sql`s.last_activity_at >= ${input.from}::timestamptz`);
  if (input.to) out.push(sql`s.last_activity_at <= ${input.to}::timestamptz`);
  if (input.search) {
    const pattern = `%${input.search}%`;
    // Five fields, all metadata or metadata-shaped. `title` is content-DERIVED
    // and searchable on purpose — it is what an operator remembers a session by
    // — and it is the only one of the five that is.
    out.push(sql`(
      s.title ILIKE ${pattern}
      OR s.cwd ILIKE ${pattern}
      OR s.git_branch ILIKE ${pattern}
      OR r.slug ILIKE ${pattern}
      OR s.session_id ILIKE ${pattern}
    )`);
  }
  return out;
}

function and(parts: SQL[]): SQL {
  return sql.join(parts, sql` AND `);
}

export function consoleSessionsQuery(input: ConsoleSessionsInput): SQL {
  const limit = consolePageLimit(input.limit);
  const where = filters(input);
  const cursor = input.cursor ? decodeConsoleCursor(input.cursor) : null;
  if (cursor) {
    where.push(
      cursor.lastActivityAt
        ? sql`(s.last_activity_at < ${cursor.lastActivityAt}::timestamptz
               OR (s.last_activity_at = ${cursor.lastActivityAt}::timestamptz AND s.id < ${cursor.id}::uuid))`
        : sql`(s.last_activity_at IS NULL AND s.id < ${cursor.id}::uuid)`,
    );
  }
  // One row past the page, so "is there more" needs no second count.
  return sql`SELECT ${PROJECTION} ${FROM} WHERE ${and(where)}
    ORDER BY s.last_activity_at DESC NULLS LAST, s.id DESC
    LIMIT ${limit + 1}`;
}

/** Totals for the header, including the provenance split the residency surface
 *  reads. NULL and 'reconciled' collapse into one bucket: the reconciler
 *  recovers a row after an index outage and cannot know how the bytes first
 *  arrived, so calling that anything but unknown would be an invention. */
export function consoleSessionTotalsQuery(universe: ConsoleUniverse): SQL {
  return sql`SELECT
      count(*)::int AS "sessions",
      count(DISTINCT s.user_id)::int AS "people",
      coalesce(sum(s.bytes_uploaded), 0)::bigint AS "bytes",
      count(*) FILTER (WHERE s.ingest_channel = 'tunnel')::int AS "tunnel",
      count(*) FILTER (WHERE s.ingest_channel = 'gateway')::int AS "gateway",
      count(*) FILTER (WHERE s.ingest_channel IS NULL OR s.ingest_channel = 'reconciled')::int AS "unknownProvenance"
    FROM hx.sessions s
    WHERE ${consoleUniversePredicate(universe)}`;
}

export interface ConsoleSessionTotals {
  sessions: number;
  people: number;
  bytes: number;
  tunnel: number;
  gateway: number;
  unknownProvenance: number;
}

/** One session, by the two things its storage key is made of. Same projection
 *  as the list, so the detail page and the verify dialog read one shape. */
export function consoleSessionByKeyQuery(
  universe: ConsoleUniverse,
  key: { family: string; sessionId: string },
): SQL {
  return sql`SELECT ${PROJECTION} ${FROM}
    WHERE ${consoleUniversePredicate(universe)}
      AND s.family = ${key.family}
      AND s.session_id = ${key.sessionId}
    LIMIT 1`;
}
