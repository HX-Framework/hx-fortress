// Fallback session-title derivation — the fortress-side twin of the hx client's
// helpers (hx/src/watch.ts: firstLineLabel / deriveFallbackTitle). Kept
// byte-for-byte identical so a title synthesized on ingest matches what the
// client would have produced from the same transcript. The client only
// synthesizes a title on a FROM-ZERO upload (stepOffset === 0), so a resumed or
// older-client session reaches the fortress with no meta.title; deriving here —
// where the whole transcript lives — makes every session name-bearing regardless
// of which client version wrote it.
//
// Ideal long-term home: the shared @let-ai/hx-protocol package, so the client
// and the fortress import ONE copy and can't drift. Deferred here to keep this a
// single-repo fix (protocol is a git-pinned dep; hoisting needs a protocol
// release + a client migration).

/** Max characters for a synthesized fallback title. */
export const FALLBACK_TITLE_MAX = 80;

/** The first non-empty line of `text`, whitespace-collapsed and clipped to
 *  FALLBACK_TITLE_MAX at a word boundary with an ellipsis. Returns null for
 *  empty/blank input. */
export function firstLineLabel(text: string | null): string | null {
  if (!text) return null;
  const oneLine = (text.split("\n", 1)[0] ?? "").trim().replace(/\s+/g, " ");
  if (!oneLine) return null;
  if (oneLine.length <= FALLBACK_TITLE_MAX) return oneLine;
  const clipped = oneLine.slice(0, FALLBACK_TITLE_MAX);
  const lastSpace = clipped.lastIndexOf(" ");
  const base = lastSpace >= FALLBACK_TITLE_MAX * 0.6 ? clipped.slice(0, lastSpace) : clipped;
  return `${base.replace(/[\s.,;:!?—-]+$/, "")}…`;
}

/** A readable label for a session that carries no user/AI title of its own: the
 *  opening user message, else the repo or working-directory name. Returns null
 *  when even those are unavailable, so the caller leaves the title unset. */
export function deriveFallbackTitle(
  firstUserText: string | null,
  cwd: string | null,
  repoSlug: string | null,
): string | null {
  const fromMessage = firstLineLabel(firstUserText);
  if (fromMessage) return fromMessage;
  const repo = repoSlug?.split("/").pop()?.trim();
  if (repo) return repo;
  const base = cwd
    ?.split(/[/\\]+/)
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .pop()
    ?.trim();
  return base && base.length > 0 ? base : null;
}
