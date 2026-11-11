// Low · redact connection strings (DSNs) from an error message before it reaches
// a log line, an MCP reply, or a tunnel RPC error surface. A Postgres/driver
// error can echo the DSN it failed to connect with — and a DSN routinely embeds
// `user:password@host`. `scheme://…` up to the next whitespace/quote covers
// postgres://, postgresql://, mysql://, redis://, https:// (a signed URL), etc.

import { DrizzleQueryError } from "drizzle-orm/errors";

const DSN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

// A driver that cannot parse a connection string quotes ALL of it:
//
//   "postgres://host=db user=u password=p dbname=d" cannot be parsed as a URL.
//
// The value there is not a URL, so the rule above stops at its first space and
// leaves the rest, the password included. Everything in front of those words is
// the value (it may hold quotes of its own, as a JSON value does), so it is
// dropped whole.
const UNPARSEABLE_URL = "cannot be parsed as a URL";

/** Redact every `scheme://…` run from a string, and the whole of a connection
 *  string that a driver quoted because it could not parse it. */
export function redactDsns(text: string): string {
  const at = text.lastIndexOf(UNPARSEABLE_URL);
  const safe = at === -1 ? text : `[REDACTED_URL] ${text.slice(at)}`;
  return safe.replace(DSN, "[REDACTED_URL]");
}

/** A known value shorter than this is not searched for. A connection string
 *  that holds a password is longer, and removing every "db" from a message
 *  would only make the message unreadable. */
const KNOWN_VALUE_MIN_CHARS = 8;

/** Remove every occurrence of the values the caller knows to be secret, in
 *  whatever form they are written. Done before any other rule, so a rule that
 *  cuts a value in two cannot leave half of it behind. */
function redactKnown(text: string, known: readonly string[]): string {
  let out = text;
  for (const value of known) {
    if (value.length >= KNOWN_VALUE_MIN_CHARS) out = out.split(value).join("[REDACTED_URL]");
  }
  return out;
}

/** Drizzle's query-error wrapper, detected WITHOUT trusting class names:
 *  DrizzleQueryError never sets `this.name` (it stays "Error") and the release
 *  binary compiles with --minify, which rewrites `constructor.name` — so a
 *  name-based check passes every test lane and silently no-ops in prod.
 *  `instanceof` is safe (single bundle); the structural shape covers a wrapper
 *  that crossed a realm/copy boundary. */
function isDrizzleQueryError(
  err: unknown,
): err is Error & { query: string; params: unknown[]; cause?: unknown } {
  if (err instanceof DrizzleQueryError) return true;
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { query?: unknown }).query === "string" &&
    Array.isArray((err as { params?: unknown }).params)
  );
}

/** `errno` carries the SQLSTATE on Bun's PostgresError ("57014", "23505", …);
 *  `code` is the driver class (ERR_POSTGRES_SERVER_ERROR for every server
 *  error, ERR_POSTGRES_CONNECTION_* for lifecycle kills). errno-first keeps the
 *  collapsed tag useful — collapsing every server error to the shared
 *  ERR_POSTGRES_SERVER_ERROR would erase the only diagnostic bit. */
function causeTag(cause: Error & { errno?: unknown; code?: unknown }): string {
  if (typeof cause.errno === "string" && cause.errno) return cause.errno;
  if (typeof cause.errno === "number") return String(cause.errno);
  if (typeof cause.code === "string" && cause.code) return cause.code;
  return cause.name;
}

/** DSN-free message for an unknown thrown value. Use anywhere a DB/driver error
 *  could cross into a log, an agent-visible reply, or an RPC error.
 *
 *  A DrizzleQueryError's message is `"Failed query: ${sql}\nparams: ${params}"`
 *  — the bound params carry transcript content — so it is collapsed to its
 *  cause's `<errno|code>: <message>`. The cause's `.message` is value-free on
 *  Bun's PostgresError (bound values live only in `.detail`/`.hint`, which are
 *  deliberately never included).
 *
 *  `known` holds connection strings the caller gave a driver. A driver may
 *  quote one in an error, and a connection string need not be a URL: an
 *  operator can write keyword=value pairs, which the URL rule does not
 *  recognize. Each known value is removed wherever it appears, whatever its
 *  form. */
export function sanitizeDbError(err: unknown, known: readonly string[] = []): string {
  const clean = (text: string): string => redactDsns(redactKnown(text, known));
  if (isDrizzleQueryError(err)) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error) {
      return clean(`${causeTag(cause)}: ${cause.message}`);
    }
    // No usable cause — still never surface the query/params body.
    return "db_query_failed";
  }
  const msg = err instanceof Error ? err.message : String(err);
  return clean(msg);
}
