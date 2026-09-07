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

/** Harness/codex-INJECTED user messages the person did not type — the fortress
 *  twin of the hx client's title rule (preview.ts `extractTitleFallback`, which
 *  skips a "Me" line that `startsWith("<")` or `startsWith("Caveat:")`). Codex
 *  prepends these as `user` messages: tag-shaped (`<recommended_plugins>`,
 *  `<environment_context>`, `<command-message>`, `<in-app-browser-context>`,
 *  `<ide_opened_file>`, …) and caveat-shaped (`Caveat: …`). The `# AGENTS.md
 *  instructions` header is added on top (the client's own rule misses it; a
 *  superset is safe for title selection). Used ONLY to choose the fallback TITLE
 *  source — NEVER to drop a turn from the index or the counts, so the daemon's own
 *  counts stay in parity (it counts these; so do we). */
export function isInjectedUserTitleText(text: string | null): boolean {
  if (!text) return false;
  const t = text.trimStart();
  // Tag-shaped (`<recommended_plugins>`, `<ide_opened_file>`, `<environment_context>`,
  // `<command-message>`, …) and caveat-shaped — the daemon's exact rule.
  if (t.startsWith("<") || t.startsWith("Caveat:")) return true;
  // Harness-injected markdown context HEADERS the daemon's rule misses: codex's
  // `# AGENTS.md instructions`, Claude Code's IDE/context injections
  // (`# Context from my IDE setup:`, `# Files/Applications/… mentioned by the
  // user:`). Matched by their exact injected prefixes so a real prompt that merely
  // opens with a `#` markdown heading is never mistaken for injected context.
  return (
    t.startsWith("# AGENTS.md instructions") ||
    t.startsWith("# Context from my IDE setup:") ||
    /^# \w[\w ]*? mentioned by the user:/.test(t)
  );
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
