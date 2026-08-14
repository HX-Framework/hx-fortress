// What the console may read, at column granularity — and the three classes that
// decide it.
//
// The privilege layer already enforces this: hx_ui holds a COLUMN-level SELECT
// on hx.sessions, so `SELECT last_user_text` is refused by the server. This
// module is the application-side statement of the same boundary, and it exists
// for two reasons the grant cannot serve. A grant cannot be read by a test that
// has no cluster, and a grant says nothing about the DIFFERENCE between metadata
// and a column that is DERIVED from content — `title` may quote a first message,
// and the console's disclosure has to say so rather than filing it under
// "metadata, never transcript bodies".
//
// Three classes, and every column of hx.sessions is in exactly one:
//
//   metadata              — counts, ids, paths, timestamps. Rendered freely.
//   derived-from-content  — `title` when `title_source` is the derivation floor.
//                           Rendered, WITH its source shown beside it.
//   content               — last_user_text and last_assistant_text, BY NAME.
//                           Never selected, never projected, never rendered.
//
// Table-level classification is the same argument one level up: hx.turns and
// hx.tool_calls ARE transcript bodies, so no console query may name them at all.

import { UI_SESSION_COLUMNS } from "../../host/postgres/console-plane";

export type ColumnClass = "metadata" | "derived-from-content" | "content";

/** The two transcript-text columns, named rather than pattern-matched. A regex
 *  over "text" would have caught `last_user_text` and also `source_path`'s
 *  neighbours, and would have missed a column named without the word. */
export const CONTENT_COLUMNS: readonly string[] = ["last_user_text", "last_assistant_text"];

/** Content-derived, not content: the title may quote the first user message when
 *  `title_source` says it was derived rather than typed. Rendered together with
 *  that source, so nobody has to guess which kind of title they are reading. */
export const DERIVED_FROM_CONTENT_COLUMNS: readonly string[] = ["title"];

export function classifySessionColumn(column: string): ColumnClass {
  if (CONTENT_COLUMNS.includes(column)) return "content";
  if (DERIVED_FROM_CONTENT_COLUMNS.includes(column)) return "derived-from-content";
  return "metadata";
}

/** Every hx.sessions column, classified. Built from the SAME list the column
 *  grant is emitted from plus the two excluded ones, so a column added to the
 *  grant without a class shows up here rather than in a rendered page. */
export const SESSION_COLUMN_CLASSES: ReadonlyMap<string, ColumnClass> = new Map(
  [...UI_SESSION_COLUMNS, ...CONTENT_COLUMNS].map((c) => [c, classifySessionColumn(c)]),
);



/** Tables no console query may name. `turns` and `tool_calls` hold the bodies;
 *  `v_turn_search` is an owner-rights view over them, which would read straight
 *  past the column grant. */
export const CONSOLE_DENIED_TABLES: readonly string[] = [
  "turns",
  "tool_calls",
  "session_agents",
  "v_turn_search",
];

/** Names that must not appear anywhere in a rendered console query — in the
 *  projection, in a JOIN, in a WHERE, in an ORDER BY. The boundary test walks
 *  every query this module's callers build and greps for each. */
export const FORBIDDEN_QUERY_TOKENS: readonly string[] = [
  ...CONTENT_COLUMNS,
  ...CONSOLE_DENIED_TABLES,
];

/** The fields a console search may match on. Content columns are absent by
 *  construction: an ILIKE over transcript text is a transcript read with extra
 *  steps, and it would work through the column grant only because the server
 *  would refuse it — a refusal the operator would experience as a broken search
 *  rather than as a boundary. */
export const CONSOLE_SEARCH_FIELDS: readonly string[] = [
  "title",
  "cwd",
  "git_branch",
  "repo",
  "session_id",
];

/** True when a rendered SQL string names anything the console may not read.
 *  Substring matching on purpose: a query that mentions `hx.turns` in a comment
 *  is still a query nobody should have written. */
export function namesForbiddenColumn(renderedSql: string): string[] {
  const lowered = renderedSql.toLowerCase();
  return FORBIDDEN_QUERY_TOKENS.filter((token) => lowered.includes(token));
}
