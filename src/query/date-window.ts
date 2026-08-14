// A4 · shared date-window predicate for every hx session-query surface
// (aggregate / list / search / semantic-search), so they can never disagree on
// which instants a caller's date range covers.
//
// Each bound accepts EITHER a bare calendar date (YYYY-MM-DD) — interpreted as a
// day boundary in the caller's `timezone`, with a day-INCLUSIVE upper bound — OR
// a full ISO-8601 timestamp, compared as an absolute instant (timezone-
// independent), which is what powers sub-day windows like "last 2 hours".
//
// `timezone` defaults to UTC, which reproduces the pre-tz behavior exactly
// (`date AT TIME ZONE 'UTC'` == midnight-UTC). The window instant is computed in
// Postgres via `AT TIME ZONE`, so DST and offset arithmetic are exact — never
// done in JS or by the model.

import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

// IANA tz-name shape guard — a cheap first filter (rejects spaces, ';', etc.)
// before the existence check.
const TZ_RE = /^[A-Za-z][A-Za-z0-9+_/-]{0,63}$/;

/** Coerce an arbitrary timezone input to a REAL IANA zone name, else "UTC" — so
 *  the `AT TIME ZONE` cast (and any Intl formatter) can never receive an
 *  unrecognized zone. Shape-passing is not enough: a syntactically-valid but
 *  non-existent name ("Foo/Bar", a tzdb-skew rename) must also degrade to UTC. */
export function safeTz(timezone: string | null | undefined): string {
  if (!timezone || !TZ_RE.test(timezone)) return "UTC";
  try {
    // Constructing a formatter throws RangeError for an unknown zone.
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone;
  } catch {
    return "UTC";
  }
}

/** A bare calendar date (no time-of-day), as opposed to a full timestamp. */
function isBareDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * The `fromDate`/`toDate` window predicates against a timestamptz `column`.
 *
 *  - bare date lower bound  → `column >= midnight(fromDate) in tz`
 *  - bare date upper bound  → `column <  midnight(toDate + 1 day) in tz`  (day-inclusive)
 *  - ISO timestamp lower    → `column >= fromDate` (absolute instant)
 *  - ISO timestamp upper    → `column <= toDate`   (absolute instant, inclusive)
 */
export function dateWindowConditions(
  column: SQLWrapper,
  fromDate: string | undefined,
  toDate: string | undefined,
  timezone?: string,
): SQL[] {
  const tz = safeTz(timezone);
  const conditions: SQL[] = [];
  if (fromDate) {
    conditions.push(
      isBareDate(fromDate)
        ? sql`${column} >= (${fromDate}::timestamp AT TIME ZONE ${tz}::text)`
        : sql`${column} >= ${fromDate}::timestamptz`,
    );
  }
  if (toDate) {
    conditions.push(
      isBareDate(toDate)
        ? sql`${column} < ((${toDate}::date + interval '1 day')::timestamp AT TIME ZONE ${tz}::text)`
        : sql`${column} <= ${toDate}::timestamptz`,
    );
  }
  return conditions;
}
