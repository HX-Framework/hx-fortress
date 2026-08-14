// One general cap for every MCP tool result, mirroring agent-kit's
// MAX_OUTPUT_CHARS (packages/agent-kit/src/tools/coding.ts). Tools that can
// return many rows ALSO paginate (limit+offset) so callers navigate instead of
// hitting this blunt cap.

/** Hard cap on the character length of any single tool result body. */
export const MAX_TOOL_OUTPUT_CHARS = 30_000;

export function capToolOutput(content: string, limit = MAX_TOOL_OUTPUT_CHARS): string {
  if (content.length <= limit) return content;
  // The callers (ok/err) serialize JSON, so a char-truncation would produce
  // UNPARSABLE JSON (a half-object → the client's JSON.parse fails →
  // "fortress_response_unparsable"). Return a VALID JSON error instead, so the
  // caller reads a clear "narrow or page" signal. read_events budget-bounds its
  // own output; this is the safety net for the other tools.
  return JSON.stringify({
    error: "output_too_large",
    bytes: content.length,
    limit,
    // LETAIR-176 G2: name only remedies every capped tool actually has. The old
    // text told the model to "page with fromIndex/cursor" — parameters
    // hx_session_search does not accept — so a hard failure came with an
    // unactionable hint. Tools that DO paginate say so in their own schemas.
    hint: "Result exceeds the tool-output limit — narrow the query: a smaller k/limit, fewer kinds, or a tighter date range.",
  });
}

/** LETAIR-176 G1 — fit a list-bearing payload INSIDE the output cap by
 *  dropping trailing (lowest-ranked) list entries instead of erroring.
 *
 *  A k=100 hx_session_search result measured ~30k+ serialized chars on
 *  production — past MAX_TOOL_OUTPUT_CHARS — and capToolOutput then replaced
 *  the WHOLE result with an error: a legal input yielding zero data. Returning
 *  the prefix that fits is strictly better for every caller (the list is
 *  already ranked; the entries dropped are the ones a smaller k would never
 *  have returned), flagged so the model knows the answer is a page, not the
 *  total. Callers pass this through ok() as usual — the cap stays as the
 *  safety net and simply no longer fires for fitted payloads. */
export function fitListPayload<T>(
  payload: Record<string, unknown> & { truncated?: true; dropped?: number },
  listKey: string,
  limit = MAX_TOOL_OUTPUT_CHARS,
): Record<string, unknown> {
  if (JSON.stringify(payload).length <= limit) return payload;
  const full = payload[listKey];
  if (!Array.isArray(full)) return payload;
  const list: T[] = [...(full as T[])];
  let dropped = 0;
  while (list.length > 0) {
    const candidate = { ...payload, [listKey]: list, truncated: true as const, dropped };
    if (JSON.stringify(candidate).length <= limit) return candidate;
    list.pop();
    dropped += 1;
  }
  return { ...payload, [listKey]: [], truncated: true as const, dropped };
}
