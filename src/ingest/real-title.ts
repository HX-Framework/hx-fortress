// Tier-A real session-title extraction from the canonical transcript.
//
// A byte-parity port of the hx client's *canonical-derivable* title precedence —
// `summariseChunk` (custom-title / ai-title) in hx/src/parse.ts and the codex
// `thread_meta.payload.title` branch of `readHead` in hx/src/sources.ts. The
// client's full precedence is `ccdMeta?.title ?? summary.title ?? head.title`;
// `ccdMeta.title` is read from a client-local Desktop file and is NOT in the
// canonical, so it is deliberately excluded here (such sessions already carry
// their title in PG). What remains — the user/AI title the client would have
// sent — IS in the canonical the fortress holds, so we can recover it for
// resumed / older-client / orphaned sessions instead of falling to the
// first-message floor.
//
// DRIFT GUARD: this mirrors client logic across a repo boundary (the shared
// `@let-ai/hx-protocol` hoist is a tracked follow-up). The parity test pins the
// client SHA it was verified against; if the client's summariseChunk/readHead
// title logic changes, re-verify and re-pin. See real-title.test.ts.
//
// NON-THROWING by construction: every line is wrapped in try/catch, exactly like
// the client twins. Callers run this to derive a title during ingest; it must
// never throw and abort the ingest transaction.

export type RealTitle = { title: string; titleSource: "user" | "ai" };

/** Claude: `custom-title` (user-set) beats `ai-title` (generated); the latest of
 *  each kind wins; both trimmed and empty-rejected. Mirrors summariseChunk. */
function claudeTitle(text: string): RealTitle | null {
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (d.type === "custom-title" && typeof d.customTitle === "string" && d.customTitle.trim()) {
      customTitle = d.customTitle.trim();
    } else if (d.type === "ai-title" && typeof d.aiTitle === "string" && d.aiTitle.trim()) {
      aiTitle = d.aiTitle.trim();
    }
  }
  if (customTitle) return { title: customTitle, titleSource: "user" };
  if (aiTitle) return { title: aiTitle, titleSource: "ai" };
  return null;
}

/** Codex: `{"type":"thread_meta","payload":{"title": string}}` within the first
 *  64 non-empty lines (the head), stamped "ai", NO trim/empty-check. Mirrors the
 *  codex branch of readHead. */
function codexTitle(text: string): RealTitle | null {
  let n = 0;
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    n += 1;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // fallthrough to the 64-line bound so a garbage head can't scan forever
      if (n >= 64) break;
      continue;
    }
    if (d.type === "thread_meta" && d.payload && typeof d.payload === "object") {
      const p = d.payload as Record<string, unknown>;
      if (typeof p.title === "string") return { title: p.title, titleSource: "ai" };
    }
    if (n >= 64) break;
  }
  return null;
}

/**
 * Extract the real user/AI title from a whole canonical transcript, matching how
 * the hx client derives it (Claude custom/ai title, else codex thread_meta).
 * Returns null when no real title is present — the caller then falls to tier B /
 * the first-message floor. Never throws.
 *
 * Effective only when `canonicalText` is the WHOLE transcript (whole-transcript
 * producers, and C/G/corrective which download the canonical). A chunked delta
 * whose title event lives in an earlier chunk yields null → floor, as today.
 */
export function extractRealTitle(canonicalText: string): RealTitle | null {
  if (!canonicalText) return null;
  try {
    const t = claudeTitle(canonicalText) ?? codexTitle(canonicalText);
    // Empty-as-absent (a fortress invariant enforced everywhere): the codex
    // branch mirrors the client's no-trim read, so an empty/whitespace
    // thread_meta title reaches here as `{title:"",…}` — treat it as no real
    // title so the caller falls to the first-message floor instead of stamping a
    // blank title (which would render id-only, the exact MC-2606 symptom).
    return t && t.title.trim() ? t : null;
  } catch {
    // Defensive: the per-line guards already prevent throws; this is belt-and-
    // suspenders so a title derivation can never abort an ingest.
    return null;
  }
}
