// A5 · the hx_* MCP tool registry — the data-plane query tools the workbench
// agent (MCP client) calls. Every tool input carries the resolved `scope`
// (§13-C); the fortress matches those enumerated identities on its live session
// rows (A6) and answers from its OWN Postgres + local blob.
//
// The registry serves every hx_* tool from the fortress's own Postgres + blob:
// keyword (hx_session_search), metadata (hx_sessions_list / hx_session_get),
// transcript reads (hx_session_read_events), semantic (hx_semantic_search over the
// hx.embeddings HNSW — degrades to keyword when the vector index is absent), and
// productivity (hx_sessions_aggregate over the per-session hx.session_facts index,
// §13-A4).

import { hashFortressScope } from "../protocol";
import type { HxDb } from "../host/postgres/db";
import { capToolOutput, fitListPayload } from "./output-limit";
import type { Embedder } from "../modules/embed-worker/openai";
import type { SessionStore } from "../modules/session-vault/store/types";
import { GRANT_REQUIRED_ERROR, type GrantClaims } from "../gateway/capability-token";
import { hxSessionsAggregate } from "../query/aggregate";
import { hxSessionGet } from "../query/get-session";
import { hxSessionReadEvents } from "../query/read-events";
import { hxSessionSearch } from "../query/search";
import { hxSemanticSearch } from "../query/semantic-search";
import { hxSessionsList } from "../query/sessions-list";
import { hxTextOccurrences } from "../query/text-occurrences";
import { parseScope } from "../query/scope";

export interface McpToolContext {
  db: HxDb | null;
  store: SessionStore | null;
  /** The fortress's OpenAI embedder, used by hx_semantic_search to embed the
   *  query text. null ⇒ no key configured ⇒ semantic degrades to keyword. */
  embedder?: Embedder | null;
  /** The verified read grant this call runs under (A5 · H-4), threaded from the
   *  transport. The scope binding is enforced by checkScopeGrant BEFORE the tool
   *  runs; carried here for completeness/future per-tool use. */
  grant?: GrantClaims;
}

export interface McpToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handle(args: unknown, ctx: McpToolContext): Promise<McpToolResult>;
}

// ── arg coercion helpers ─────────────────────────────────────────────────────
function rec(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function numOpt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
}

function ok(value: unknown): McpToolResult {
  return { content: [{ type: "text", text: capToolOutput(JSON.stringify(value)) }] };
}
function err(value: unknown): McpToolResult {
  return { content: [{ type: "text", text: capToolOutput(JSON.stringify(value)) }], isError: true };
}
function needDb(ctx: McpToolContext): McpToolResult | null {
  return ctx.db ? null : err({ error: "postgres_not_ready" });
}

/** A5 · H-4 scope binding for a tools/call. When a read grant is present, the
 *  tool-args scope must hash to the grant's committed `scopeHash` (tamper-evident);
 *  a mismatch fails closed with `scope_not_granted`. When NO grant is present, the
 *  call is admitted UNLESS `enforce` (the transport's grant-enforce flag) is set,
 *  in which case it is denied with `grant_required` (the SAME absent-grant code the
 *  HTTP gateway + tunnel use — distinct from the scope-mismatch code above). Returns
 *  an isError result to short-circuit, or null to proceed. Absent-grant enforcement
 *  is the transport's decision — HTTP and tunnel pass their own flag — so it lives
 *  here beside the hash check. */
export function checkScopeGrant(
  args: unknown,
  grant: GrantClaims | undefined,
  enforce: boolean,
): McpToolResult | null {
  if (grant) {
    const computed = hashFortressScope(parseScope(rec(args).scope));
    return computed === grant.scopeHash ? null : err({ error: "scope_not_granted" });
  }
  return enforce ? err({ error: GRANT_REQUIRED_ERROR }) : null;
}

// ── shared input-schema fragments ────────────────────────────────────────────
const SCOPE_SCHEMA = {
  type: "object",
  description:
    "Workbench-resolved consent scope: the enumerated in-scope session identities + an optional owner gate. The fortress matches these identities on its live session rows and evaluates no org/repo/project predicate of its own. Empty identities ⇒ no results (fail-closed).",
  properties: {
    identities: {
      type: "array",
      description: "Enumerated in-scope sessions, by natural key.",
      items: {
        type: "object",
        properties: {
          userExternalId: { type: "string" },
          family: { type: "string" },
          sessionId: { type: "string" },
        },
        required: ["userExternalId", "family", "sessionId"],
      },
    },
    ownerGate: {
      type: "object",
      description:
        "Additive AND-narrowing owner gate: a session is admitted only if its owner is in this active-member set.",
      properties: { activeMemberExternalIds: { type: "array", items: { type: "string" } } },
      required: ["activeMemberExternalIds"],
    },
  },
  required: ["identities"],
} as const;

const DATE_FILTERS = {
  family: { type: "string", description: "Filter by device family." },
  fromDate: {
    type: "string",
    description:
      "Lower bound. A bare date (YYYY-MM-DD) is a day boundary in `timezone`; a full ISO-8601 timestamp is an absolute instant (for sub-day windows).",
  },
  toDate: {
    type: "string",
    description:
      "Upper bound — day-inclusive for a bare date, instant-inclusive for a timestamp.",
  },
  timezone: {
    type: "string",
    description: "IANA timezone the bare-date bounds are interpreted in (e.g. Europe/Warsaw). Default UTC.",
  },
} as const;

export const MCP_TOOLS: McpTool[] = [
  {
    name: "hx_session_search",
    description:
      "Cross-session keyword/substring search over the in-scope sessions' transcript turns (tsvector + trigram). Broad: matches conversational text AND tool output/logs/code. Returns ranked hits (sessionId, seq, kind, snippet, rank).",
    inputSchema: {
      type: "object",
      properties: {
        scope: SCOPE_SCHEMA,
        query: { type: "string", description: "Keyword/phrase to search for." },
        k: { type: "number", description: "Max hits to return. Default 20, cap 100." },
        kinds: {
          type: "array",
          items: { type: "string" },
          description:
            'Restrict to these turn kinds (e.g. ["user_text"] for what the user SAID, ["user_text","assistant_text"] for the conversation). Default: all kinds, including tool output/code. Unknown values are ignored.',
        },
        ...DATE_FILTERS,
      },
      required: ["scope", "query"],
    },
    async handle(args, ctx) {
      const guard = needDb(ctx);
      if (guard) return guard;
      const a = rec(args);
      const result = await hxSessionSearch(ctx.db!, {
        scope: parseScope(a.scope),
        query: str(a.query) ?? "",
        k: numOpt(a.k),
        kinds: strArray(a.kinds),
        family: str(a.family),
        fromDate: str(a.fromDate),
        toDate: str(a.toDate),
        timezone: str(a.timezone),
      });
      // LETAIR-176 G1: a k=100 result can exceed the output cap — return the
      // ranked prefix that fits (flagged) instead of letting the cap replace
      // the whole answer with an error.
      return ok(fitListPayload(result, "hits"));
    },
  },
  {
    name: "hx_sessions_list",
    description:
      "List the in-scope sessions' metadata, keyset-paged on last activity (descending). Filter by family, date range, cwd substring, or free-text search across title/last texts. Each row carries the owner (userExternalId), per-session cost (estCostUsd) + tokens (inputTokens/outputTokens/cacheReadTokens), and per-session productivity facts (activeMs, filesTouched, linesAdded, linesRemoved) — so use this (then sort) for \"most expensive / most lines / most files / longest\" rankings. Returns { sessions, nextCursor }.",
    inputSchema: {
      type: "object",
      properties: {
        scope: SCOPE_SCHEMA,
        ...DATE_FILTERS,
        cwdContains: { type: "string", description: "Filter by cwd substring (case-insensitive)." },
        search: {
          type: "string",
          description: "Substring across title, last user text, last assistant text.",
        },
        limit: { type: "number", description: "Max rows. Default 25, cap 100." },
        cursor: { type: "string", description: "Opaque keyset cursor from a previous nextCursor." },
      },
      required: ["scope"],
    },
    async handle(args, ctx) {
      const guard = needDb(ctx);
      if (guard) return guard;
      const a = rec(args);
      return ok(
        await hxSessionsList(ctx.db!, {
          scope: parseScope(a.scope),
          family: str(a.family),
          fromDate: str(a.fromDate),
          toDate: str(a.toDate),
          timezone: str(a.timezone),
          cwdContains: str(a.cwdContains),
          search: str(a.search),
          limit: numOpt(a.limit),
          cursor: str(a.cursor),
        }),
      );
    },
  },
  {
    name: "hx_session_get",
    description:
      "Fetch one in-scope session's full metadata row. sessionId is disambiguated through scope.identities. Returns { session } or { session: null, error: 'session_not_found' }.",
    inputSchema: {
      type: "object",
      properties: {
        scope: SCOPE_SCHEMA,
        sessionId: { type: "string", description: "The session's natural session_id." },
      },
      required: ["scope", "sessionId"],
    },
    async handle(args, ctx) {
      const guard = needDb(ctx);
      if (guard) return guard;
      const a = rec(args);
      return ok(await hxSessionGet(ctx.db!, { scope: parseScope(a.scope), sessionId: str(a.sessionId) ?? "" }));
    },
  },
  {
    name: "hx_session_read_events",
    description:
      "Read a bounded slice of one in-scope session's transcript events (whole-object parse of the local canonical). get-by-type via filterType (sourced from persisted kind, reaches tool_result); full via fromIndex/maxEvents; get-by-offset via charOffset/length (turn-relative window). Returns { events, total, nextIndex }.",
    inputSchema: {
      type: "object",
      properties: {
        scope: SCOPE_SCHEMA,
        sessionId: { type: "string", description: "The session's natural session_id." },
        filterType: {
          type: "string",
          description: "Restrict to one kind (e.g. user_text, assistant_text, tool_result).",
        },
        fromIndex: { type: "number", description: "0-based start into the (filtered) event list." },
        maxEvents: { type: "number", description: "Max events. Default 50, cap 200." },
        charOffset: {
          type: "number",
          description: "Turn-relative start offset into the target event's full text.",
        },
        length: { type: "number", description: "Window length for charOffset. Default 500, cap 4000." },
      },
      required: ["scope", "sessionId"],
    },
    async handle(args, ctx) {
      const guard = needDb(ctx);
      if (guard) return guard;
      const a = rec(args);
      return ok(
        await hxSessionReadEvents(ctx.db!, ctx.store, {
          scope: parseScope(a.scope),
          sessionId: str(a.sessionId) ?? "",
          filterType: str(a.filterType),
          fromIndex: numOpt(a.fromIndex),
          maxEvents: numOpt(a.maxEvents),
          charOffset: numOpt(a.charOffset),
          length: numOpt(a.length),
        }),
      );
    },
  },
  {
    name: "hx_semantic_search",
    description:
      "Semantic (vector) search over the in-scope sessions' conversational turns (user/assistant text only). The query text is embedded server-side and matched by cosine distance over the HNSW index. Returns ranked hits (sessionId, seq, kind, snippet, distance), or `{ unavailable: { reason } }` (fail-fast) when it could not run — e.g. the OpenAI credential is missing/invalid/unfunded or the vector index is not provisioned — so the caller can tell the user rather than silently returning worse results.",
    inputSchema: {
      type: "object",
      properties: {
        scope: SCOPE_SCHEMA,
        queryText: { type: "string", description: "Natural-language query; embedded server-side." },
        k: { type: "number", description: "Max hits. Default 20, cap 100." },
        ...DATE_FILTERS,
      },
      required: ["scope", "queryText"],
    },
    async handle(args, ctx) {
      const guard = needDb(ctx);
      if (guard) return guard;
      const a = rec(args);
      const result = await hxSemanticSearch(ctx.db!, ctx.embedder ?? null, {
        scope: parseScope(a.scope),
        queryText: str(a.queryText) ?? "",
        k: numOpt(a.k),
        family: str(a.family),
        fromDate: str(a.fromDate),
        toDate: str(a.toDate),
        timezone: str(a.timezone),
      });
      // Same output-cap fitting as hx_session_search (LETAIR-176 G1).
      return ok(fitListPayload(result as unknown as Record<string, unknown>, "hits"));
    },
  },
  {
    name: "hx_sessions_aggregate",
    description:
      "Aggregate productivity metrics over the in-scope sessions (total sessions, active time, user/assistant message counts, tool calls by type, files touched, lines added/removed). The date range windows on each session's last activity (last_activity_at) — same as hx_sessions_list — so a long-running or multi-day session active in-window is counted. Computed live from the per-session hx.session_facts index JOINed to the live session row.",
    inputSchema: {
      type: "object",
      properties: {
        scope: SCOPE_SCHEMA,
        ...DATE_FILTERS,
        cwdContains: { type: "string", description: "Filter by cwd substring (case-insensitive)." },
        groupBy: { type: "string", enum: ["user", "repo", "cwd"], description: "Adds per-bucket subtotals in `groups`: \"user\" per member (team/org load), \"repo\" per repository, \"cwd\" per working directory. Sessions with no repo/cwd fall into a labeled \"(unattributed)\"/\"(none)\" bucket — so a single/empty breakdown truthfully means the sessions aren't tagged that way (do NOT invent a split)." },
      },
      required: ["scope"],
    },
    async handle(args, ctx) {
      const guard = needDb(ctx);
      if (guard) return guard;
      const a = rec(args);
      const gb = a.groupBy;
      return ok(
        await hxSessionsAggregate(ctx.db!, {
          scope: parseScope(a.scope),
          family: str(a.family),
          fromDate: str(a.fromDate),
          toDate: str(a.toDate),
          timezone: str(a.timezone),
          cwdContains: str(a.cwdContains),
          groupBy: gb === "user" || gb === "repo" || gb === "cwd" ? gb : undefined,
        }),
      );
    },
  },
  {
    name: "hx_text_occurrences",
    description:
      "COUNT how often a literal word or phrase appears across the in-scope sessions' transcript turns — the whole-corpus, UNCAPPED text analogue of hx_sessions_aggregate (one exact SQL count; no row cap, no ranking). Returns occurrences (total literal matches, repeats counted), matchingTurns, and matchingSessions. Covers conversational text AND tool output/code. matchMode: literal_word (default, whole word — \"observer\" ≠ \"observers\"), literal_substring (matches inside larger words), or lexeme (stemmed related word forms — matchingTurns/matchingSessions only, NOT a literal count). Optionally restrict to turn kinds or a date range.",
    inputSchema: {
      type: "object",
      properties: {
        scope: SCOPE_SCHEMA,
        query: {
          type: "string",
          description: "The literal word or phrase to count (a phrase matches across any whitespace, incl. a newline).",
        },
        matchMode: {
          type: "string",
          enum: ["literal_word", "literal_substring", "lexeme"],
          description:
            "literal_word (default): whole-word literal match. literal_substring: literal match inside larger words. lexeme: stemmed tsvector match (related word forms) — returns matchingTurns/matchingSessions only, no occurrence count.",
        },
        kinds: {
          type: "array",
          items: { type: "string" },
          description:
            "Restrict to these turn kinds (e.g. [\"user_text\",\"assistant_text\"] for what was SAID). Default: all text-bearing kinds, including tool output/code.",
        },
        ...DATE_FILTERS,
      },
      required: ["scope", "query"],
    },
    async handle(args, ctx) {
      const guard = needDb(ctx);
      if (guard) return guard;
      const a = rec(args);
      const mode = a.matchMode;
      return ok(
        await hxTextOccurrences(ctx.db!, {
          scope: parseScope(a.scope),
          query: str(a.query) ?? "",
          matchMode:
            mode === "literal_substring" || mode === "lexeme" || mode === "literal_word"
              ? mode
              : undefined,
          kinds: strArray(a.kinds),
          family: str(a.family),
          fromDate: str(a.fromDate),
          toDate: str(a.toDate),
          timezone: str(a.timezone),
        }),
      );
    },
  },
];
