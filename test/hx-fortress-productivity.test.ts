import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createHxDb, type HxDb } from "../src/host/postgres/db";
import { runMigrations } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";
import { makeMigrationExec } from "../src/host/postgres/sql-exec";
import { ingestCommit, type IngestAttribution } from "../src/ingest/ingest";
import { hxSessionsAggregate } from "../src/query/aggregate";

// PRODUCTIVITY slice — hx.session_facts derivation + hx_sessions_aggregate
// (§13-A4 / §10). Runs against a real Postgres when FORTRESS_DATABASE_URL is set;
// skipped (no failure) otherwise.
//   FORTRESS_DATABASE_URL=postgres://forge:forge@localhost:5499/hx-db \
//     bun test test/hx-fortress-productivity.test.ts
const DSN = process.env.FORTRESS_DATABASE_URL;

const ATTR: IngestAttribution = {
  orgExternalId: null,
  projectExternalId: null,
  repoSlug: null,
  deviceId: null,
};

const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SESSION_ID = `sess-prod-${SUFFIX}`;
// A second, MULTI-DAY session (first-active 2026-06-28, last-active 2026-07-02)
// used only by test (e) to prove last-activity windowing.
const MULTI_SESSION_ID = `sess-prod-multi-${SUFFIX}`;
// A third session for the last_activity_at monotonicity test (g).
const MONO_SESSION_ID = `sess-prod-mono-${SUFFIX}`;
// A fourth session for the timezone / hour-granularity window test (h): a single
// event at 2026-07-08T01:00Z, which is calendar day 07-08 in UTC but 07-07 in
// America/New_York (EDT = UTC-4).
const TZ_SESSION_ID = `sess-prod-tz-${SUFFIX}`;
const USER_ID = `user-prod-${SUFFIX}`;
const KEY = { userId: USER_ID, family: "claude-cli", sessionId: SESSION_ID };
const MULTI_KEY = { userId: USER_ID, family: "claude-cli", sessionId: MULTI_SESSION_ID };
const MONO_KEY = { userId: USER_ID, family: "claude-cli", sessionId: MONO_SESSION_ID };
const TZ_KEY = { userId: USER_ID, family: "claude-cli", sessionId: TZ_SESSION_ID };

const inScope = { userExternalId: USER_ID, family: KEY.family, sessionId: SESSION_ID };
const multiScope = { userExternalId: USER_ID, family: MULTI_KEY.family, sessionId: MULTI_SESSION_ID };
const tzScope = { userExternalId: USER_ID, family: TZ_KEY.family, sessionId: TZ_SESSION_ID };

// 1 user turn · 2 assistant text turns · an Edit on /src/foo.ts (old 2 lines →
// new 4 lines) · a Write of /src/bar.ts (3 lines), with event_ts a few minutes
// apart — and a 12.5-min idle gap (10:02:30 → 10:15:00) that the 5-min idle cap
// must clamp.
function mockChunk(): string {
  return [
    JSON.stringify({
      type: "user",
      timestamp: "2026-06-30T10:00:00Z",
      message: { content: [{ type: "text", text: "let's refactor the parser" }] },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-30T10:02:00Z",
      message: {
        model: "claude-opus-4-8",
        content: [
          { type: "text", text: "I'll edit the file." },
          {
            type: "tool_use",
            id: "tu_edit",
            name: "Edit",
            input: { file_path: "/src/foo.ts", old_string: "old A\nold B", new_string: "new A\nnew B\nnew C\nnew D" },
          },
        ],
        usage: { input_tokens: 12, output_tokens: 7 },
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-06-30T10:02:30Z",
      message: { content: [{ type: "tool_result", tool_use_id: "tu_edit", content: "edited", is_error: false }] },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-30T10:15:00Z",
      message: {
        model: "claude-opus-4-8",
        content: [
          { type: "text", text: "Now writing the module." },
          {
            type: "tool_use",
            id: "tu_write",
            name: "Write",
            input: { file_path: "/src/bar.ts", content: "w1\nw2\nw3" },
          },
        ],
        usage: { input_tokens: 8, output_tokens: 4 },
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-06-30T10:15:30Z",
      message: { content: [{ type: "tool_result", tool_use_id: "tu_write", content: "wrote", is_error: false }] },
    }),
  ].join("\n");
}

// A replace chunk: one Edit on /src/foo.ts (1 line → 1 line). If facts double-
// counted across replace, files/lines/tool_calls would carry the old chunk too.
function replaceChunk(): string {
  return [
    JSON.stringify({
      type: "user",
      timestamp: "2026-06-30T10:00:00Z",
      message: { content: [{ type: "text", text: "redo it" }] },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-30T10:01:00Z",
      message: {
        model: "claude-opus-4-8",
        content: [
          { type: "text", text: "Editing once." },
          {
            type: "tool_use",
            id: "tu_redo",
            name: "Edit",
            input: { file_path: "/src/foo.ts", old_string: "x", new_string: "y" },
          },
        ],
        usage: { input_tokens: 3, output_tokens: 2 },
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-06-30T10:01:30Z",
      message: { content: [{ type: "tool_result", tool_use_id: "tu_redo", content: "done", is_error: false }] },
    }),
  ].join("\n");
}

// A multi-day session for the last-activity windowing test: FIRST activity on
// 2026-06-28 (⇒ primary_day = 2026-06-28) and LAST activity on 2026-07-02 23:30
// (⇒ last_activity_at = 2026-07-02T23:30Z). A "last few days of July" window must
// include it (last-active in-window) even though its first-activity day is weeks
// earlier — the exact case the old primary_day predicate wrongly dropped.
function multiDayChunk(): string {
  return [
    JSON.stringify({
      type: "user",
      timestamp: "2026-06-28T09:00:00Z",
      message: { content: [{ type: "text", text: "kick off a long-running task" }] },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-02T23:30:00Z",
      message: {
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "still on it days later" }],
        usage: { input_tokens: 5, output_tokens: 3 },
      },
    }),
  ].join("\n");
}

interface FactsRow {
  user_msgs: number;
  assistant_msgs: number;
  files_touched: number;
  lines_added: number;
  lines_removed: number;
  active_ms: number | string;
  primary_day: string | null;
  tool_calls_by_type: Record<string, number> | string;
}

describe.if(!!DSN)("hx-fortress productivity slice (facts + aggregate, §13-A4/§10)", () => {
  const dsn = DSN as string;
  const sqlx = makeMigrationExec(dsn);
  let db: HxDb;

  beforeAll(async () => {
    await runMigrations(sqlx, migrations);
    db = createHxDb(dsn);
    await ingestCommit(db, {
      ingestChannel: "tunnel",
      attribution: ATTR,
      key: KEY,
      chunkId: "c1",
      replace: false,
      chunkText: mockChunk(),
      totalBytes: 512,
      componentCount: 1,
      meta: { title: "Productivity smoke", cwd: "/work/let-forge" },
    });
  }, 60_000);

  afterAll(async () => {
    if (!DSN) return;
    const ids = `'${SESSION_ID}', '${MULTI_SESSION_ID}', '${MONO_SESSION_ID}', '${TZ_SESSION_ID}'`;
    await sqlx.exec(`DELETE FROM hx.ingest_events WHERE session_id_ext IN (${ids})`);
    // hx.session_facts / turns / tool_calls cascade off the session delete.
    await sqlx.exec(`DELETE FROM hx.sessions WHERE session_id IN (${ids})`);
  });

  /** The stored last_activity_at (ISO) for a session, read from the live row. */
  async function sessionLastActivity(sessionId: string): Promise<string | null> {
    const rows = await sqlx.query<{ last_activity_at: string | null }>(
      `SELECT to_char(last_activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_activity_at
         FROM hx.sessions WHERE session_id = '${sessionId}'`,
    );
    return rows[0]?.last_activity_at ?? null;
  }

  async function facts(): Promise<FactsRow> {
    const rows = await sqlx.query<FactsRow>(
      `SELECT f.user_msgs, f.assistant_msgs, f.files_touched, f.lines_added, f.lines_removed,
              f.active_ms::bigint AS active_ms,
              to_char(f.primary_day, 'YYYY-MM-DD') AS primary_day,
              f.tool_calls_by_type
         FROM hx.session_facts f
         JOIN hx.sessions s ON s.id = f.session_id
        WHERE s.session_id = '${SESSION_ID}'`,
    );
    return rows[0];
  }

  function tct(row: FactsRow): Record<string, number> {
    return typeof row.tool_calls_by_type === "string"
      ? (JSON.parse(row.tool_calls_by_type) as Record<string, number>)
      : row.tool_calls_by_type;
  }

  test("(a) hx.session_facts derives files/lines/active_ms/primary_day at ingest", async () => {
    const f = await facts();
    expect(f).toBeDefined();
    // /src/foo.ts (Edit) + /src/bar.ts (Write).
    expect(Number(f.files_touched)).toBe(2);
    // Edit new (4) + Write content (3).
    expect(Number(f.lines_added)).toBe(7);
    // Edit old (2) + Write (0).
    expect(Number(f.lines_removed)).toBe(2);
    expect(Number(f.user_msgs)).toBe(1);
    expect(Number(f.assistant_msgs)).toBe(2);
    expect(tct(f)).toEqual({ Edit: 1, Write: 1 });
    // 120 000 (10:00→10:02) + 0 + 30 000 (→10:02:30) + min(750 000, 300 000 cap)
    //   (→10:15:00) + 0 + 30 000 (→10:15:30) = 480 000 ms (the 12.5-min idle is capped).
    expect(Number(f.active_ms)).toBe(480_000);
    // date(min(event_ts)) in UTC.
    expect(f.primary_day).toBe("2026-06-30");
  });

  test("(b) hx_sessions_aggregate sums the in-scope facts", async () => {
    const out = await hxSessionsAggregate(db, { scope: { identities: [inScope] } });
    expect(out.totalSessions).toBe(1);
    expect(out.activeMs).toBe(480_000);
    expect(out.userMsgs).toBe(1);
    expect(out.assistantMsgs).toBe(2);
    expect(out.filesTouched).toBe(2);
    expect(out.linesAdded).toBe(7);
    expect(out.linesRemoved).toBe(2);
    expect(out.toolCallsByType).toEqual({ Edit: 1, Write: 1 });
    expect(out.firstDay).toBe("2026-06-30");
    expect(out.lastDay).toBe("2026-06-30");
  });

  test("(c) a different identity is scope-gated to zeros", async () => {
    const out = await hxSessionsAggregate(db, {
      scope: { identities: [{ ...inScope, userExternalId: "someone-else" }] },
    });
    expect(out.totalSessions).toBe(0);
    expect(out.activeMs).toBe(0);
    expect(out.filesTouched).toBe(0);
    expect(out.linesAdded).toBe(0);
    expect(out.toolCallsByType).toEqual({});
    expect(out.firstDay).toBeNull();
  });

  test("(d) an empty scope fails closed to zeros", async () => {
    const out = await hxSessionsAggregate(db, { scope: { identities: [] } });
    expect(out.totalSessions).toBe(0);
    expect(out.activeMs).toBe(0);
    expect(out.toolCallsByType).toEqual({});
  });

  test("(e) the date filter windows on last activity, not primary_day", async () => {
    // The single-day session (first- AND last-active 2026-06-30) is in-window for
    // a 06-30 query and out for a later one — the baseline both predicates agree on.
    const inDay = await hxSessionsAggregate(db, {
      scope: { identities: [inScope] },
      fromDate: "2026-06-30",
      toDate: "2026-06-30",
    });
    expect(inDay.totalSessions).toBe(1);
    const otherDay = await hxSessionsAggregate(db, {
      scope: { identities: [inScope] },
      fromDate: "2026-07-01",
    });
    expect(otherDay.totalSessions).toBe(0);

    // Seed the MULTI-DAY session: primary_day = 2026-06-28, last_activity = 07-02.
    await ingestCommit(db, {
      ingestChannel: "tunnel",
      attribution: ATTR,
      key: MULTI_KEY,
      chunkId: "m1",
      replace: false,
      chunkText: multiDayChunk(),
      totalBytes: 256,
      componentCount: 1,
      meta: { title: "Multi-day", cwd: "/work/let-forge" },
    });
    const scope = { identities: [multiScope] };

    // The bug case: window entirely AFTER first-activity day but covering the last
    // activity. last_activity_at (07-02) ∈ [07-01, 07-02] ⇒ INCLUDED. The old
    // primary_day predicate (06-28 ∉ window) wrongly returned 0 here.
    const lastActiveInWindow = await hxSessionsAggregate(db, {
      scope,
      fromDate: "2026-07-01",
      toDate: "2026-07-02",
    });
    expect(lastActiveInWindow.totalSessions).toBe(1);
    // Facts are actually summed for the included session, not just counted.
    expect(lastActiveInWindow.userMsgs).toBe(1);
    expect(lastActiveInWindow.assistantMsgs).toBe(1);

    // Day-inclusive upper bound: querying just 07-02 still catches the 23:30 activity.
    const inclusiveUpper = await hxSessionsAggregate(db, {
      scope,
      fromDate: "2026-07-02",
      toDate: "2026-07-02",
    });
    expect(inclusiveUpper.totalSessions).toBe(1);

    // The mirror case: window on the FIRST-activity day only. last_activity (07-02)
    // is OUTSIDE ⇒ EXCLUDED. The old primary_day predicate (06-28 ∈ window) wrongly
    // included it.
    const startDayOnly = await hxSessionsAggregate(db, {
      scope,
      fromDate: "2026-06-28",
      toDate: "2026-06-28",
    });
    expect(startDayOnly.totalSessions).toBe(0);

    // firstDay/lastDay stay the DESCRIPTIVE primary-day span (not the window): an
    // in-window aggregate can honestly report a firstDay that precedes the window.
    expect(lastActiveInWindow.firstDay).toBe("2026-06-28");
    expect(lastActiveInWindow.lastDay).toBe("2026-06-28");
  });

  test("(f) a replace recomputes the facts row — no double-count", async () => {
    await ingestCommit(db, {
      ingestChannel: "tunnel",
      attribution: ATTR,
      key: KEY,
      chunkId: "c2",
      replace: true,
      chunkText: replaceChunk(),
      totalBytes: 128,
      componentCount: 1,
      meta: null,
    });

    const f = await facts();
    // Only the replace chunk's single Edit on /src/foo.ts survives.
    expect(Number(f.files_touched)).toBe(1);
    expect(Number(f.lines_added)).toBe(1);
    expect(Number(f.lines_removed)).toBe(1);
    expect(Number(f.user_msgs)).toBe(1);
    expect(Number(f.assistant_msgs)).toBe(1);
    expect(tct(f)).toEqual({ Edit: 1 });
    // 60 000 (10:00→10:01) + 0 + 30 000 (→10:01:30) = 90 000 ms.
    expect(Number(f.active_ms)).toBe(90_000);

    const out = await hxSessionsAggregate(db, { scope: { identities: [inScope] } });
    expect(out.totalSessions).toBe(1);
    expect(out.filesTouched).toBe(1);
    expect(out.linesAdded).toBe(1);
    expect(out.toolCallsByType).toEqual({ Edit: 1 });
    expect(out.activeMs).toBe(90_000);
  });

  test("(g) last_activity_at advances monotonically on append, authoritative on replace", async () => {
    const userChunk = (ts: string): string =>
      JSON.stringify({ type: "user", timestamp: ts, message: { content: [{ type: "text", text: "hi" }] } });
    const ingest = (chunkId: string, ts: string, replace: boolean) =>
      ingestCommit(db, {
        ingestChannel: "tunnel",
        attribution: ATTR,
        key: MONO_KEY,
        chunkId,
        replace,
        chunkText: userChunk(ts),
        totalBytes: 64,
        componentCount: 1,
        meta: { title: "Mono", cwd: "/work/let-forge" },
      });

    // Establish the newest event at 2026-07-05T12:00.
    await ingest("g1", "2026-07-05T12:00:00Z", false);
    expect(await sessionLastActivity(MONO_SESSION_ID)).toBe("2026-07-05T12:00:00Z");

    // Append an OUT-OF-ORDER / backfill chunk whose newest event is EARLIER —
    // last_activity_at must NOT regress (the pre-fix overwrite would drop it to 07-01).
    await ingest("g2", "2026-07-01T08:00:00Z", false);
    expect(await sessionLastActivity(MONO_SESSION_ID)).toBe("2026-07-05T12:00:00Z");

    // A later append still advances it forward.
    await ingest("g3", "2026-07-06T09:30:00Z", false);
    expect(await sessionLastActivity(MONO_SESSION_ID)).toBe("2026-07-06T09:30:00Z");

    // A `replace` is authoritative — the session is rebuilt from the chunk, so
    // last_activity_at takes the replacing chunk's value even if it's earlier.
    await ingest("g4", "2026-07-03T15:00:00Z", true);
    expect(await sessionLastActivity(MONO_SESSION_ID)).toBe("2026-07-03T15:00:00Z");
  });

  test("(h) date window is timezone-aware and datetime-capable", async () => {
    // last_activity_at = 2026-07-08T01:00Z — calendar day 07-08 in UTC, but 07-07
    // in America/New_York (EDT, UTC-4: 2026-07-07 21:00 local).
    await ingestCommit(db, {
      ingestChannel: "tunnel",
      attribution: ATTR,
      key: TZ_KEY,
      chunkId: "h1",
      replace: false,
      chunkText: JSON.stringify({
        type: "user",
        timestamp: "2026-07-08T01:00:00Z",
        message: { content: [{ type: "text", text: "late night" }] },
      }),
      totalBytes: 64,
      componentCount: 1,
      meta: { title: "TZ", cwd: "/work/let-forge" },
    });
    const scope = { identities: [tzScope] };
    const count = async (input: { fromDate?: string; toDate?: string; timezone?: string }) =>
      (await hxSessionsAggregate(db, { scope, ...input })).totalSessions;

    // Same "07-08" query bucket, different tz → different membership.
    expect(await count({ fromDate: "2026-07-08", toDate: "2026-07-08", timezone: "UTC" })).toBe(1);
    // In New_York the activity belongs to 07-07, so a NY "07-08" window excludes it…
    expect(
      await count({ fromDate: "2026-07-08", toDate: "2026-07-08", timezone: "America/New_York" }),
    ).toBe(0);
    // …and a NY "07-07" window includes it (the instant is 07-07 21:00 local).
    expect(
      await count({ fromDate: "2026-07-07", toDate: "2026-07-07", timezone: "America/New_York" }),
    ).toBe(1);

    // Datetime (instant) bounds — the "last 2 hours" shape: >= an ISO instant.
    expect(await count({ fromDate: "2026-07-08T00:30:00Z" })).toBe(1); // 01:00 ≥ 00:30
    expect(await count({ fromDate: "2026-07-08T01:30:00Z" })).toBe(0); // 01:00 < 01:30
    // Instant upper bound is inclusive-of-instant.
    expect(await count({ toDate: "2026-07-08T01:00:00Z" })).toBe(1);
    expect(await count({ toDate: "2026-07-08T00:59:00Z" })).toBe(0);

    // A malformed timezone falls back to UTC (never errors).
    expect(await count({ fromDate: "2026-07-08", toDate: "2026-07-08", timezone: "Not/AZone;DROP" })).toBe(1);
    // A SHAPE-VALID but non-existent zone also falls back to UTC — must NOT reach
    // Postgres `AT TIME ZONE 'Foo/Bar'` (which would raise + fail the query).
    expect(await count({ fromDate: "2026-07-08", toDate: "2026-07-08", timezone: "Foo/Bar" })).toBe(1);
  });
});
