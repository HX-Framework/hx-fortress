// A4 · hx_session_read_events — whole-object local parse of one in-scope
// session's canonical transcript (NOW: O(session); byte-offset O(window) is
// FUTURE). Three read shapes:
//   • get-by-type   — filterType, sourced from the persisted `kind` taxonomy;
//                     reaches ANY turn incl. tool_result (readable, never embedded)
//   • full          — fromIndex/maxEvents window over the (filtered) event list
//   • get-by-offset — charOffset/length slices the target turn's full text
//                     (serves windows past the per-turn MAX_TEXT cap)
//
// The session is resolved under the passed scope (A6) on its live row, then read
// from the fortress's OWN store (co-located blob — no whole-blob over the wire)
// and re-parsed with the SAME shared classifier the write path persisted `kind`
// from (src/ingest/classify.ts), so get-by-type and the re-parsed text align.

import { and, eq } from "drizzle-orm";

import type { HxDb } from "../host/postgres/db";
import { hxSessions, hxUsers } from "../host/postgres/schema";
import { classifyChunk, type ClassifiedEvent } from "../ingest/classify";
import { maxCanonicalBytes } from "../modules/session-vault/store/limits";
import type { SessionStore } from "../modules/session-vault/store/types";
import { scopePredicate, type FortressScope } from "./scope";

export interface ReadEventsInput {
  scope: FortressScope;
  sessionId: string;
  filterType?: string;
  fromIndex?: number;
  maxEvents?: number;
  charOffset?: number;
  length?: number;
}

export interface ReadEvent {
  index: number;
  kind: ClassifiedEvent["kind"];
  role: ClassifiedEvent["role"];
  ts: string | null;
  toolName: string | null;
  isError: boolean;
  text: string;
  charOffset?: number;
}

export interface ReadEventsResult {
  events: ReadEvent[];
  total: number;
  nextIndex?: number | null;
  error?: string;
  detail?: string;
  /** Set when the read could NOT run due to an INFRA/CREDENTIAL problem (store
   *  unreachable, S3 token expired/invalid, access denied) — affects ALL blob
   *  reads. FAIL-FAST: the caller surfaces this reason to the user rather than
   *  silently degrading (mirrors hx_semantic_search). A benign per-session miss
   *  (one object genuinely absent) is `error:"session_not_found"`, NOT this. */
  unavailable?: { reason: string; detail?: string };
}

const DEFAULT_MAX_EVENTS = 50;
const MAX_MAX_EVENTS = 200;
const FULL_TEXT_CAP = 1500; // bound token usage on full/get-by-type reads
const DEFAULT_OFFSET_LEN = 500;
const MAX_OFFSET_LEN = 4000;
// Keep a full/get-by-type response comfortably under the MCP output cap
// (MAX_TOOL_OUTPUT_CHARS = 30_000) so the envelope never truncates it into
// unparsable JSON; the loop pages the rest via nextIndex.
const OUTPUT_BUDGET = 26_000;

function capText(text: string): string {
  if (text.length <= FULL_TEXT_CAP) return text;
  return `${text.slice(0, FULL_TEXT_CAP)}… [${text.length - FULL_TEXT_CAP} more chars]`;
}

function mapEvent(e: ClassifiedEvent, index: number, text: string, charOffset?: number): ReadEvent {
  const base: ReadEvent = {
    index,
    kind: e.kind,
    role: e.role,
    ts: e.ts,
    toolName: e.toolName,
    isError: e.isError,
    text,
  };
  return charOffset === undefined ? base : { ...base, charOffset };
}

/** A blob read failed. Distinguish a BENIGN per-session miss (the one object is
 *  genuinely absent — NoSuchKey/NotFound) from an INFRA/credential failure
 *  (expired/invalid creds, access denied, bucket/network/timeout) that affects
 *  every blob read. Only the former is soft; the latter fails fast. */
export function isBenignBlobMiss(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  // Match the SDK's missing-object error NAME exactly (NoSuchKey / NotFound) — a
  // substring test would false-match network errors like "getaddrinfo ENOTFOUND"
  // (which contains "NOTFOUND") and wrongly treat a DNS outage as a benign miss.
  // The message check keys on the missing-object phrasing, absent from infra errors.
  return name === "NoSuchKey" || name === "NotFound" || /does not exist|no such key/i.test(msg);
}

export async function hxSessionReadEvents(
  db: HxDb,
  store: SessionStore | null,
  input: ReadEventsInput,
): Promise<ReadEventsResult> {
  const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
  if (!sessionId) return { events: [], total: 0, error: "session_not_found" };

  const rows = await db
    .select({
      family: hxSessions.family,
      sessionId: hxSessions.sessionId,
      userExternalId: hxUsers.externalId,
    })
    .from(hxSessions)
    .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
    .where(and(scopePredicate(input.scope), eq(hxSessions.sessionId, sessionId)))
    .limit(1);

  const session = rows[0];
  if (!session) return { events: [], total: 0, error: "session_not_found" };
  if (!store) return { events: [], total: 0, unavailable: { reason: "vault_unavailable" } };

  const key = {
    userId: session.userExternalId,
    family: session.family,
    sessionId: session.sessionId,
  };

  // M-9c · a whole-object read materializes the full transcript in memory. Stat
  // first and fail-fast on an oversized session rather than OOM the fortress. A
  // stat failure isn't authoritative — fall through to the read, which classifies
  // benign-miss vs infra and fails-fast on its own.
  try {
    const size = await store.statCanonical(key);
    if (size !== null && size > maxCanonicalBytes()) {
      return { events: [], total: 0, unavailable: { reason: "session_too_large" } };
    }
  } catch {
    // ignore — the read below handles a genuinely unreachable store
  }

  let text: string;
  try {
    text = await store.readCanonicalText(key);
  } catch (err) {
    // Benign per-session miss (one blob absent) → soft not-found. Any other read
    // failure is an INFRA/credential problem affecting ALL blob reads → FAIL-FAST
    // with an explicit `unavailable` so the caller tells the user (never a silent
    // degrade that presents a partial answer as complete). The raw SDK error
    // `detail` can carry bucket/object identifiers and crosses back to the agent,
    // so surface only the generic reason (the benign-miss vs infra-fault split is
    // preserved — that's the actionable signal).
    if (isBenignBlobMiss(err)) {
      return { events: [], total: 0, error: "session_not_found" };
    }
    return { events: [], total: 0, unavailable: { reason: "vault_store_unreachable" } };
  }

  const all = classifyChunk(text);
  const filtered = input.filterType ? all.filter((e) => e.kind === input.filterType) : all;
  const total = filtered.length;

  // get-by-offset: a turn-relative window into one event's full text.
  if (typeof input.charOffset === "number") {
    const idx = Math.max(0, input.fromIndex ?? 0);
    const ev = filtered[idx];
    if (!ev) return { events: [], total };
    const start = Math.max(0, input.charOffset);
    const len = Math.min(Math.max(1, input.length ?? DEFAULT_OFFSET_LEN), MAX_OFFSET_LEN);
    const window = (ev.text ?? "").slice(start, start + len);
    return { events: [mapEvent(ev, idx, window, start)], total };
  }

  // full / get-by-type: a window over the (filtered) event list, BOUNDED to the
  // MCP output cap. Accumulate mapped events until the next would exceed the
  // budget, then stop and page via nextIndex — so the response is ALWAYS valid
  // JSON under the cap, never char-truncated into an unparsable payload (which the
  // client would misread as an infra error). Always returns ≥1 event.
  const fromIndex = Math.max(0, input.fromIndex ?? 0);
  const maxEvents = Math.min(Math.max(1, input.maxEvents ?? DEFAULT_MAX_EVENTS), MAX_MAX_EVENTS);
  const upper = Math.min(fromIndex + maxEvents, total);
  const events: ReadEvent[] = [];
  let budget = OUTPUT_BUDGET;
  let idx = fromIndex;
  for (; idx < upper; idx++) {
    const mapped = mapEvent(filtered[idx], idx, capText(filtered[idx].text ?? ""));
    const cost = JSON.stringify(mapped).length + 1;
    if (events.length > 0 && cost > budget) break;
    events.push(mapped);
    budget -= cost;
  }
  const nextIndex = idx < total ? idx : null;
  return { events, total, nextIndex };
}
