import { and, eq, isNull, or } from "drizzle-orm";

import type { HxDb } from "../host/postgres/db";
import { hxSessions, hxUsers } from "../host/postgres/schema";
import type { SessionKey } from "../modules/session-vault/store/types";

export type UpdateTitleOutcome = "applied" | "noop" | "absent";

/**
 * Backfill one already-uploaded session's title from the client's OWN name.
 *
 * Codex writes no title into the rollout the daemon ingests (LETAIR-481), so
 * every codex session lands with the first-message fallback floor. The daemon
 * reads codex's real name from `~/.codex/state_*.sqlite` and, for a dormant
 * session that will never re-commit content, sends it here — the ONLY bytes-free
 * way to reach `hx.sessions.title` (the title Clarity reads).
 *
 * Update-only and CAS-guarded, so it is safe to call for any session:
 *  - it never INSERTS — an absent row yields "absent" (the caller blocks until
 *    the content lands; a tombstoned/purged session simply has no row, so it is
 *    never resurrected);
 *  - it only UPGRADES a fallback/empty/null title — the SAME predicate as the
 *    tier-A title cascade in ingestCommit — so it NEVER clobbers a real user/AI
 *    title ("noop" when one already stands).
 *
 * The write is a single atomic UPDATE whose WHERE re-checks the CAS, so it is
 * correct under a concurrent live `ingestCommit` title-apply: whichever upgrades
 * the fallback first wins, and the other's CAS then fails (Postgres re-evaluates
 * the WHERE against the row it locked) — no lost update, no downgrade. No
 * advisory lock is needed (that guards ingestCommit's multi-write transaction).
 */
export async function updateSessionTitle(
  db: HxDb,
  args: { key: SessionKey; title: string; titleSource: "user" | "ai" },
): Promise<UpdateTitleOutcome> {
  const { key, title, titleSource } = args;

  const [user] = await db
    .select({ id: hxUsers.id })
    .from(hxUsers)
    .where(eq(hxUsers.externalId, key.userId))
    .limit(1);
  if (!user) return "absent";

  const identity = and(
    eq(hxSessions.userId, user.id),
    eq(hxSessions.family, key.family),
    eq(hxSessions.sessionId, key.sessionId),
    isNull(hxSessions.deletedAt),
  );

  const applied = await db
    .update(hxSessions)
    .set({ title, titleSource, updatedAt: new Date().toISOString() })
    .where(
      and(
        identity,
        // CAS: only a fallback / empty / absent title may be upgraded.
        or(isNull(hxSessions.title), eq(hxSessions.title, ""), eq(hxSessions.titleSource, "fallback")),
      ),
    )
    .returning({ id: hxSessions.id });
  if (applied.length > 0) return "applied";

  // No row updated: the session already holds a real title (noop) or no row
  // exists at all (absent). One existence probe distinguishes them.
  const [row] = await db.select({ id: hxSessions.id }).from(hxSessions).where(identity).limit(1);
  return row ? "noop" : "absent";
}
