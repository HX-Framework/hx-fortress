// A4 · reusable literal / phrase text matcher — the shared core behind the
// pg_trgm literal-match capability. Consumed today by hx_text_occurrences; it is
// deliberately built as slice #1 of the future consolidated full-text-search
// tool (MC-2525), where the SAME matcher becomes the `match: literal|phrase` +
// `return: count` mode — so consolidation is a wrap, not a rewrite.
//
// Kept a PURE, DB-agnostic string module (no drizzle, no SQL) so every consumer
// derives the SAME two artifacts and can never drift:
//
//   • regex     — a POSIX ARE the DB matches case-insensitively (Postgres `~*` /
//                 regexp_count). Every token is escaped to a literal; phrase
//                 tokens join on `\s+` (so "machine learning" also matches a
//                 newline between the words); whole-word mode adds a `\y`
//                 boundary ONLY on an edge that is itself a word char.
//   • prefilter — a single-token `%…%` ILIKE pattern that is a PROVEN SUPERSET of
//                 the regex (every regex match contains that token), so a query
//                 can pre-narrow rows through the `hx_turns_text_trgm_idx`
//                 trigram index before running the exact regex on the survivors.

/** Word char = the class Postgres `\y` treats as "inside a word": Unicode
 *  letters, digits, and underscore (matches Postgres' `[[:alnum:]_]`). */
const WORD_EDGE_RE = /[\p{L}\p{N}_]/u;

/** Escape a string so Postgres ARE (`~*` / regexp_count) matches it LITERALLY.
 *  Every NON-word char is backslash-escaped — in ARE a backslash before an
 *  ordinary (non-alphanumeric) char is always that literal char, and escaping
 *  ONLY non-word chars means we can never accidentally form an escape like `\y`
 *  or `\d` (those need a backslash before a LETTER, which we never touch). */
export function escapeRegex(input: string): string {
  return input.replace(/[^\p{L}\p{N}_]/gu, (c) => `\\${c}`);
}

/** Escape a string for use inside a `%…%` ILIKE pattern: the LIKE metacharacters
 *  `%` and `_`, plus the escape char `\` itself (LIKE's default ESCAPE is `\`). */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Whitespace-delimited tokens of a query (a phrase → its words). */
function tokenize(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

export type LiteralMatchMode = "literal_word" | "literal_substring";

/**
 * Build the POSIX-ARE regex for a literal term / phrase.
 *
 *   • tokens are escaped to literals and joined on `\s+`, so a phrase spans any
 *     run of whitespace (incl. a newline): `machine learning` → `machine\s+learning`.
 *   • `literal_word` wraps the match in PER-EDGE word boundaries; `literal_substring`
 *     does not (so `observ` matches inside `observer`).
 *
 * Per-edge (not blanket) `\y` is load-bearing: a blanket `\yerror:\y` never
 * matches — `:` is a non-word char, so there is no word boundary after it — and
 * would silently return 0 for the punctuation-edged terms this targets (`error:`).
 * So `\y` is applied only on an edge whose outermost char is a word char.
 *
 * Returns "" for an all-whitespace query (the caller treats that as "no match").
 */
export function buildLiteralRegex(query: string, mode: LiteralMatchMode): string {
  const tokens = tokenize(query);
  if (tokens.length === 0) return "";
  const body = tokens.map(escapeRegex).join("\\s+");
  if (mode === "literal_substring") return body;
  const trimmed = query.trim();
  const lead = WORD_EDGE_RE.test(trimmed[0] ?? "") ? "\\y" : "";
  const trail = WORD_EDGE_RE.test(trimmed[trimmed.length - 1] ?? "") ? "\\y" : "";
  return `${lead}${body}${trail}`;
}

/** The single-token ILIKE prefilter — a proven SUPERSET of the regex, so it can
 *  ride the trigram index to pre-narrow rows before the exact `~*` runs. Anchors
 *  on the LONGEST token (most selective; ≥3 chars actually engages pg_trgm),
 *  escaped for LIKE. Every regex match contains that token as a literal
 *  substring, so `text ILIKE '%token%'` can never drop a real match. Returns ""
 *  for an all-whitespace query. */
export function prefilterPattern(query: string): string {
  const tokens = tokenize(query);
  if (tokens.length === 0) return "";
  const longest = tokens.reduce((a, b) => (b.length > a.length ? b : a));
  return `%${escapeLike(longest)}%`;
}
