// A4 · hx_session_get — the full metadata row for one in-scope session. The
// sessionId is disambiguated through scope.identities (which carry the full
// natural key), so an out-of-scope id returns not-found rather than leaking.

import { and, eq } from "drizzle-orm";

import type { HxDb } from "../host/postgres/db";
import { hxSessions } from "../host/postgres/schema";
import { SESSION_META_SELECT, type SessionMeta } from "./sessions-list";
import { scopePredicate, type FortressScope } from "./scope";

export interface GetSessionInput {
  scope: FortressScope;
  sessionId: string;
}

export async function hxSessionGet(
  db: HxDb,
  input: GetSessionInput,
): Promise<{ session: SessionMeta | null; error?: string }> {
  const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
  if (!sessionId) return { session: null, error: "session_not_found" };

  const rows = await db
    .select(SESSION_META_SELECT)
    .from(hxSessions)
    .where(and(scopePredicate(input.scope), eq(hxSessions.sessionId, sessionId)))
    .limit(1);

  if (!rows[0]) return { session: null, error: "session_not_found" };
  return { session: rows[0] };
}
