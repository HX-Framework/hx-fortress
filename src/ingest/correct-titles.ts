// Corrective title pass (MC-2606 follow-up).
//
// #89 stamped `title_source='fallback'` first-message *guesses* on sessions that
// reached the fortress without a `meta.title` — and empty-string/null-title stubs
// exist too (mirror empties, agent-lane parent stubs, derive-returned-null). The
// REAL title (custom-title / ai-title / codex thread_meta) lives in the canonical
// the fortress already holds. This pass re-derives it with the tier-A cascade and
// applies a **title-only, CAS-guarded UPDATE** — never `ingestCommit`/`replace`,
// so it touches no turns or embeddings, cannot resurrect a tombstone (it only
// UPDATEs an existing id; a purged row matches 0 rows), and is fully idempotent.
// Claude rows flip to their real ai-title/custom-title; codex/untitled rows keep
// the floor (skip-no-op). PACED (bounded batch + inter-batch delay) so the
// canonical downloads don't hammer the object store. Non-throwing per row.
//
// Intended trigger: fold into G's boot-drain (auto each deploy, self-limiting) —
// a Railway fortress has no one-off command surface. Safe to re-run.

import { sanitizeDbError } from "../host/postgres/sanitize";
import { and, asc, eq, gt, isNull, or } from "drizzle-orm";

import type { HxDb } from "../host/postgres/db";
import { hxSessions } from "../host/postgres/schema/sessions";
import { hxUsers } from "../host/postgres/schema/dimensions";
import type { SessionStore } from "../modules/session-vault/store/types";
import { extractRealTitle } from "./real-title";

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export interface CorrectTitlesOptions {
  /** Rows per batch (each row = one canonical download). Default 100. */
  batchSize?: number;
  /** Delay between batches, ms — paces store I/O. Default 250. */
  batchDelayMs?: number;
  /** Optional ceiling on rows examined (safety bound). Default: no cap. */
  maxRows?: number;
  /** Injected sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  logger?: { warn?(message: string, fields?: Record<string, unknown>): void };
}

export interface CorrectTitlesResult {
  scanned: number;
  corrected: number;
  skippedNoRealTitle: number;
  skippedNoop: number;
  errors: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Re-title every fallback / empty / null-title session from its canonical, using
 * the tier-A real-title cascade. Returns per-run stats. Never throws.
 */
export async function correctTitles(
  db: HxDb,
  store: SessionStore,
  opts: CorrectTitlesOptions = {},
): Promise<CorrectTitlesResult> {
  const batchSize = opts.batchSize ?? 100;
  const batchDelayMs = opts.batchDelayMs ?? 250;
  const sleep = opts.sleep ?? defaultSleep;
  const res: CorrectTitlesResult = {
    scanned: 0,
    corrected: 0,
    skippedNoRealTitle: 0,
    skippedNoop: 0,
    errors: 0,
  };

  // '' and NULL both count as absent; 'fallback' is a first-message guess to replace.
  const candidate = or(
    eq(hxSessions.titleSource, "fallback"),
    isNull(hxSessions.title),
    eq(hxSessions.title, ""),
  );

  let cursor = ZERO_UUID;
  for (;;) {
    if (opts.maxRows != null && res.scanned >= opts.maxRows) break;
    const rows = await db
      .select({
        id: hxSessions.id,
        family: hxSessions.family,
        sessionId: hxSessions.sessionId,
        title: hxSessions.title,
        externalUserId: hxUsers.externalId,
      })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(isNull(hxSessions.deletedAt), candidate, gt(hxSessions.id, cursor)))
      .orderBy(asc(hxSessions.id))
      .limit(batchSize);
    if (rows.length === 0) break;

    for (const row of rows) {
      cursor = row.id;
      res.scanned += 1;
      try {
        const canonical = await store.readCanonicalText({
          userId: row.externalUserId,
          family: row.family,
          sessionId: row.sessionId,
        });
        const real = extractRealTitle(canonical);
        if (!real) {
          res.skippedNoRealTitle += 1;
          continue;
        }
        if (real.title === row.title) {
          res.skippedNoop += 1;
          continue;
        }
        // Title-only CAS: re-check the fallback/absent state at write time so a
        // concurrent live ingest that set a real title makes this a no-op.
        const updated = await db
          .update(hxSessions)
          .set({ title: real.title, titleSource: real.titleSource, updatedAt: new Date().toISOString() })
          .where(and(eq(hxSessions.id, row.id), candidate))
          .returning({ id: hxSessions.id });
        if (updated.length > 0) res.corrected += 1;
        else res.skippedNoop += 1;
      } catch (err) {
        // A missing canonical (404) or a transient store error must never abort
        // the pass — this session keeps its current title and is retried next run.
        res.errors += 1;
        opts.logger?.warn?.("correct-titles: skipped one session", {
          err: sanitizeDbError(err),
          sessionId: row.sessionId,
          family: row.family,
        });
      }
    }

    if (rows.length < batchSize) break;
    if (batchDelayMs > 0) await sleep(batchDelayMs);
  }

  return res;
}
