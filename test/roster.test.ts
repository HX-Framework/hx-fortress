// The roster: what one sync does, what ages out, and where every adoption number
// comes from.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import {
  ADOPTION_ACTIVE_DAYS,
  ADOPTION_STAGES,
  adoptionStages,
  attentionRows,
  QUIET_AFTER_DAYS,
  rosterTeams,
} from "../src/console/adoption";
import {
  DEFAULT_ROSTER_INACTIVE_PURGE_DAYS,
  purgeInactiveRoster,
  replaceRoster,
} from "../src/console/roster";
import { readRosterPurge, publishRosterPurge } from "../src/console/roster-signal";
import { runRosterVerb } from "../src/cli-roster";
import { fortressPaths } from "../src/host/paths";
import { parseFortressConfig, rosterInactivePurgeDays } from "../src/host/config";
import { CONSOLE_TABLES, UI_TABLE_GRANTS } from "../src/host/postgres/console-plane";
import { expectedPrivilegeMatrix } from "../src/host/postgres/privilege-matrix";
import { migrations } from "../src/host/postgres/migrations/manifest";
import {
  consoleAdoptionCountsQuery,
  consoleRosterQuery,
  consoleUnrosteredQuery,
  type RosterPersonRow,
} from "../src/query/console/roster";
import { universeConstrains } from "../src/query/console/universe";
import { dataPathRows } from "../src/ui/egress";
import type { HxDb } from "../src/host/postgres/db";
import type { RosterSyncPayload } from "../src/protocol";

const dialect = new PgDialect();
const render = (q: SQL): string => dialect.sqlToQuery(q).sql;
const UNIVERSE = { orgExternalId: "org-1" };
const DAY = 86_400_000;
const NOW = Date.parse("2026-07-31T00:00:00.000Z");

function member(over: Partial<RosterPersonRow> = {}): RosterPersonRow {
  return {
    externalId: "u1",
    displayName: "One",
    email: null,
    teams: [],
    installed: 1,
    lastSeenAt: new Date(NOW - DAY).toISOString(),
    lastUploadAt: new Date(NOW - DAY).toISOString(),
    syncTotal: 10,
    syncDone: 10,
    syncReportedAt: new Date(NOW - DAY).toISOString(),
    active: true,
    inactiveSince: null,
    sessions: 3,
    bytes: 100,
    lastActivityAt: new Date(NOW - DAY).toISOString(),
    ...over,
  };
}

describe("the stage-source table", () => {
  test("every stage names exactly one source, and the posture is not one of them", () => {
    const inventory = ADOPTION_STAGES.filter((s) => s.source === "roster device inventory").map((s) => s.id);
    const local = ADOPTION_STAGES.filter((s) => s.source === "local session rows").map((s) => s.id);
    // No `sync` stage: backfill progress carries no organization, so the hub
    // stopped reporting it and a stage that can only ever read zero is worse
    // than one that is not there.
    expect(inventory).toEqual(["installed"]);
    expect(local).toEqual(["sending", "active"]);
    for (const stage of ADOPTION_STAGES) {
      expect(stage.source).not.toContain("posture");
      // Cloud-attested exactly when the source is the hub's; fortress-observed
      // exactly when it is this host's rows.
      expect(`${stage.id}:${stage.attestation}`).toBe(
        `${stage.id}:${stage.source === "local session rows" ? "fortress-observed" : "cloud-attested"}`,
      );
    }
    expect(new Set(ADOPTION_STAGES.map((s) => s.id)).size).toBe(ADOPTION_STAGES.length);
  });

  test("no share is computed without a roster to divide by", () => {
    const empty = adoptionStages({
      rostered: 0,
      installed: 0,
      syncComplete: 0,
      sending: 4,
      active: 2,
      formerMembers: 0,
      unrostered: 4,
    });
    for (const stage of empty) expect(stage.share).toBeNull();

    const real = adoptionStages({
      rostered: 10,
      installed: 8,
      syncComplete: 6,
      sending: 5,
      active: 4,
      formerMembers: 3,
      unrostered: 1,
    });
    expect(real.map((s) => s.count)).toEqual([10, 8, 5, 4]);
    expect(real.find((s) => s.id === "sending")?.share).toBe(0.5);
  });
});

describe("who needs attention", () => {
  test("quiet is derived from the last UPLOAD, never the last heartbeat", () => {
    const rows = attentionRows(
      [
        member({
          externalId: "heartbeating",
          // Seen minutes ago, and has not uploaded in far longer: the exact
          // install an operator is looking for.
          lastSeenAt: new Date(NOW - 60_000).toISOString(),
          lastUploadAt: new Date(NOW - (QUIET_AFTER_DAYS + 5) * DAY).toISOString(),
        }),
      ],
      NOW,
    );
    expect(rows.map((r) => r.kind)).toEqual(["quiet"]);
  });

  test("departed members are excluded, and the states are ordered worst first", () => {
    const rows = attentionRows(
      [
        member({ externalId: "backlog", syncDone: 2, syncTotal: 9 }),
        // No stamp of ANY kind beside an install: nothing has been observed.
        member({ externalId: "silent", installed: 2, lastUploadAt: null, lastSeenAt: null }),
        member({ externalId: "gone", installed: 0, active: false, inactiveSince: new Date(NOW).toISOString() }),
        member({ externalId: "noclient", installed: 0 }),
        member({ externalId: "fine" }),
      ],
      NOW,
    );
    expect(rows.map((r) => r.externalId)).toEqual(["noclient", "silent", "backlog"]);
    expect(rows.map((r) => r.kind)).toEqual(["nothing-here-yet", "never-uploaded", "backfill-outstanding"]);
  });

  test("a MISSING upload stamp is not an accusation — it falls back to what the org has seen", () => {
    // Every session recorded before the hub's per-destination table has no
    // destination row, so its upload stamp is null. Reading that as "never
    // uploaded" put every member whose history predates it on the attention list
    // permanently, on a surface whose whole job is to be short.
    const rows = attentionRows(
      [
        member({
          externalId: "legacy-active",
          lastUploadAt: null,
          lastSeenAt: new Date(NOW - DAY).toISOString(),
        }),
        member({
          externalId: "legacy-quiet",
          lastUploadAt: null,
          lastSeenAt: new Date(NOW - (QUIET_AFTER_DAYS + 5) * DAY).toISOString(),
        }),
      ],
      NOW,
    );
    // The active one is not on the list at all; the stale one is quiet, which is
    // the true statement about it.
    expect(rows.map((r) => [r.externalId, r.kind])).toEqual([["legacy-quiet", "quiet"]]);
  });
});

describe("teams come from the roster and nowhere else", () => {
  test("active members only, with the share that is actually sending", () => {
    const teams = rosterTeams([
      member({ externalId: "a", teams: ["Payments", "Data"], sessions: 2 }),
      member({ externalId: "b", teams: ["Payments"], sessions: 0 }),
      member({ externalId: "c", teams: ["Payments"], active: false, sessions: 5 }),
    ]);
    expect(teams).toEqual([
      { name: "Payments", members: 2, sending: 1 },
      { name: "Data", members: 1, sending: 1 },
    ]);
  });
});

// -- the replace ------------------------------------------------------------

interface Recorded {
  statements: string[];
  transactions: number;
}

function fakeDb(recorded: Recorded): HxDb {
  const tx = {
    execute: async (statement: SQL) => {
      recorded.statements.push(render(statement));
      return { count: 1 };
    },
  };
  return {
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
      recorded.transactions += 1;
      return await fn(tx);
    },
    execute: async (statement: SQL) => {
      recorded.statements.push(render(statement));
      return { count: 2 };
    },
  } as unknown as HxDb;
}

/** A db whose roster_sync already holds `storedAsOf`, for the ordering gate. */
function fakeDbWithPriorSync(recorded: Recorded, storedAsOf: string): HxDb {
  const answer = async (statement: SQL) => {
    const text = render(statement);
    recorded.statements.push(text);
    if (text.includes("FROM hx.roster_sync")) return { rows: [{ asOf: storedAsOf }] };
    return { count: 1 };
  };
  const tx = { execute: answer };
  return {
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
      recorded.transactions += 1;
      return await fn(tx);
    },
    execute: answer,
  } as unknown as HxDb;
}

function payload(ids: readonly string[], asOf = "2026-07-30T00:00:00.000Z"): RosterSyncPayload {
  return {
    asOf,
    members: ids.map((externalId) => ({
      externalId,
      displayName: externalId.toUpperCase(),
      teams: ["Payments"],
      devices: {
        installed: 1,
        lastSeenAt: "2026-07-29T00:00:00.000Z",
        lastUploadAt: "2026-07-29T00:00:00.000Z",
        syncTotal: 4,
        syncDone: 4,
        syncReportedAt: "2026-07-29T00:00:00.000Z",
      },
    })),
  };
}

describe("one sync", () => {
  test("is a single transaction, and never deletes a departed member", async () => {
    const recorded: Recorded = { statements: [], transactions: 0 };
    const result = await replaceRoster(fakeDb(recorded), payload(["a", "b"]));
    expect(recorded.transactions).toBe(1);
    expect(result.received).toBe(2);

    const upserts = recorded.statements.filter((s) => s.includes("INSERT INTO hx.roster ("));
    expect(upserts.length).toBe(2);
    for (const statement of upserts) expect(statement).toContain("ON CONFLICT (external_id) DO UPDATE");

    const departures = recorded.statements.filter((s) => s.includes("UPDATE hx.roster"));
    expect(departures.length).toBe(1);
    expect(departures[0]).toContain("active = false");
    expect(departures[0]).toContain("coalesce(inactive_since, now())");
    // Not a delete, anywhere in the replace: the sessions those people uploaded
    // are still here, and the row is what says whose they are.
    expect(recorded.statements.some((s) => /DELETE\s+FROM\s+hx\.roster/i.test(s))).toBe(false);

    // The marker is written by the sync itself, so its ABSENCE means no sync has
    // ever landed.
    expect(recorded.statements.some((s) => s.includes("INSERT INTO hx.roster_sync"))).toBe(true);
  });

  test("an empty roster deactivates everyone rather than matching nobody", async () => {
    const recorded: Recorded = { statements: [], transactions: 0 };
    const result = await replaceRoster(fakeDb(recorded), payload([]));
    expect(result.received).toBe(0);
    const departures = recorded.statements.filter((s) => s.includes("UPDATE hx.roster"));
    expect(departures.length).toBe(1);
    // No NOT IN clause at all — every active row is a departure.
    expect(departures[0]).not.toContain("NOT IN");
    expect(recorded.statements.some((s) => s.includes("INSERT INTO hx.roster_sync"))).toBe(true);
  });

  test("retention removes only aged INACTIVE rows", async () => {
    const recorded: Recorded = { statements: [], transactions: 0 };
    const removed = await purgeInactiveRoster(fakeDb(recorded), 90);
    expect(removed).toBe(2);
    const [statement] = recorded.statements;
    expect(statement).toContain("DELETE FROM hx.roster");
    expect(statement).toContain("active = false");
    expect(statement).toContain("inactive_since IS NOT NULL");
    expect(statement).toContain("inactive_since < now()");
    expect(DEFAULT_ROSTER_INACTIVE_PURGE_DAYS).toBe(90);
  });
});

// -- the queries ------------------------------------------------------------

describe("the adoption queries", () => {
  test("every session term carries the console universe", () => {
    for (const [name, sql] of [
      ["roster", consoleRosterQuery(UNIVERSE)],
      ["unrostered", consoleUnrosteredQuery(UNIVERSE)],
      ["counts", consoleAdoptionCountsQuery(UNIVERSE, ADOPTION_ACTIVE_DAYS)],
    ] as const) {
      expect([name, universeConstrains(render(sql)).org]).toEqual([name, true]);
    }
  });

  test("the funnel counts active members, and counts the others apart", () => {
    const sql = render(consoleAdoptionCountsQuery(UNIVERSE, ADOPTION_ACTIVE_DAYS));
    // The denominator and the three stages that narrow it are all gated on
    // r.active — a departed member is never in a coverage figure.
    expect(sql.match(/r\.active AND/g)?.length).toBeGreaterThanOrEqual(4);
    expect(sql).toContain('WHERE NOT r.active) AS "formerMembers"');
    // Never-reported backfill is not complete backfill.
    expect(sql).toContain("r.sync_total IS NOT NULL");
    // A sender the roster does not name is its own bucket.
    expect(sql).toContain("NOT EXISTS (SELECT 1 FROM hx.roster r WHERE r.external_id = u.external_id)");
  });

  test("the roster list keeps members with nothing here", () => {
    const sql = render(consoleRosterQuery(UNIVERSE));
    expect(sql).toContain("FROM hx.roster r");
    expect(sql).toContain("LEFT JOIN LATERAL");
    expect(sql).toContain('r.active AS "active"');
  });
});

// -- the plumbing -----------------------------------------------------------

describe("the roster tables", () => {
  test("0018 creates them, with the read roles revoked at creation", () => {
    const roster = migrations.find((m) => m.name === "0022_roster");
    expect(roster).toBeDefined();
    const sql = roster?.sql ?? "";
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "hx"."roster"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "hx"."roster_sync"');
    expect(sql).toContain("REVOKE ALL ON hx.roster FROM hx_readonly");
    expect(sql).toContain("REVOKE ALL ON hx.roster_sync FROM hx_app_ro");
    // Applied numbers are never edited, so the roster is its own file, appended
    // after the last one that had already run — and later work appends after it
    // rather than reopening it.
    const names = migrations.map((m) => m.name);
    expect(names.indexOf("0022_roster")).toBeGreaterThan(names.indexOf("0021_audit_engine"));
  });

  test("the console reads them and writes neither", () => {
    expect(CONSOLE_TABLES).toContain("roster");
    expect(CONSOLE_TABLES).toContain("roster_sync");
    for (const table of ["roster", "roster_sync"]) {
      expect(UI_TABLE_GRANTS.find((g) => g.table === table)?.privileges).toEqual(["SELECT"]);
    }
    const matrix = expectedPrivilegeMatrix();
    expect(matrix["t:hx_ui:roster:SELECT"]).toBe(true);
    expect(matrix["t:hx_ui:roster:INSERT"]).toBe(false);
    // The daemon receives the sync, so it writes; the cloud-served read roles
    // see a directory of people they have no business reading.
    expect(matrix["t:hx_app_rw:roster:INSERT"]).toBe(true);
    expect(matrix["t:hx_readonly:roster:SELECT"]).toBe(false);
    expect(matrix["t:hx_app_ro:roster:SELECT"]).toBe(false);
    expect(matrix["t:hx_readonly:roster_sync:SELECT"]).toBe(false);
  });
});

describe("the inbound data path", () => {
  test("renders with the configured retention and claims no outbound leg", () => {
    const rows = dataPathRows({
      ui: {
        version: 1,
        enabled: true,
        port: 8788,
        bind: "127.0.0.1",
        trustedProxies: [],
        publicUrl: null,
        sso: false,
        sessionTtlHours: 8,
        sessionIdleMinutes: 30,
        databaseUrl: null,
        allowInsecureBind: false,
        marker: null,
      },
      boundPort: 8788,
      postgres: { mode: "unknown" },
      cloudUrl: "wss://hub.example.test",
      downloadBase: null,
      postgresBinariesUrl: null,
      bucket: null,
      embeddingEndpoint: null,
      ssoAdvertised: false,
      rosterRetentionDays: 45,
    });
    const roster = rows.find((r) => r.id === "roster-inbound");
    expect(roster?.direction).toBe("in");
    expect(roster?.carries).toContain("ACTIVE members");
    expect(roster?.notes?.join(" ")).toContain("45 days");
    expect(roster?.notes?.join(" ")).toContain("no directory of its own");
  });
});

describe("the retention setting", () => {
  test("defaults, parses and refuses nonsense", () => {
    const base = {
      schemaVersion: 1,
      cloud: { url: "wss://hub.example.test" },
      gateway: { publicUrl: "https://fortress.example.test" },
      modules: { enabled: ["session_vault"] },
    };
    expect(rosterInactivePurgeDays(parseFortressConfig(base))).toBe(DEFAULT_ROSTER_INACTIVE_PURGE_DAYS);
    expect(
      rosterInactivePurgeDays(parseFortressConfig({ ...base, roster: { inactivePurgeDays: 30 } })),
    ).toBe(30);
    expect(() => parseFortressConfig({ ...base, roster: { inactivePurgeDays: -1 } })).toThrow(
      /whole number of days/,
    );
    expect(() => parseFortressConfig({ ...base, roster: { inactivePurgeDays: "90" } })).toThrow(
      /whole number of days/,
    );
  });
});

describe("the terminal verb", () => {
  async function withRoot<T>(work: (root: string) => Promise<T>): Promise<T> {
    const root = await mkdtemp(path.join(os.tmpdir(), "hx-roster-cli-"));
    try {
      return await work(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  test("asks the daemon and reports what it removed", async () => {
    await withRoot(async (root) => {
      const paths = fortressPaths(root);
      const lines: string[] = [];
      const signals: Array<[number, string]> = [];
      const code = await runRosterVerb(["purge-inactive"], {
        writeLine: (l) => lines.push(l),
        fortressRoot: root,
        daemonPid: async () => 77,
        kill: (pid, signal) => {
          signals.push([pid, signal]);
          // The daemon's half, synchronously: it purges and publishes.
          void publishRosterPurge(paths.runtimeRoot, {
            at: "2026-07-31T00:00:00.000Z",
            removed: 4,
            days: 90,
          });
          return true;
        },
        waitMs: 1_000,
        pollMs: 1,
      });
      expect(code).toBe(0);
      expect(signals[0]?.[0]).toBe(77);
      expect(lines[0]).toContain("Purged 4 roster row(s)");
      expect(lines.join(" ")).toContain("sessions on this fortress are untouched");
      expect(await readRosterPurge(paths.runtimeRoot)).toMatchObject({ removed: 4 });
    });
  });

  test("refuses when there is no daemon to apply it, and refuses a nonsense window", async () => {
    await withRoot(async (root) => {
      await expect(
        runRosterVerb(["purge-inactive"], {
          writeLine: () => {},
          fortressRoot: root,
          daemonPid: async () => null,
        }),
      ).rejects.toThrow(/only thing that may write the roster/);
      await expect(
        runRosterVerb(["purge-inactive", "--days", "nope"], {
          writeLine: () => {},
          fortressRoot: root,
          daemonPid: async () => 1,
          kill: () => true,
        }),
      ).rejects.toThrow(/whole number of days/);
    });
  });
});


describe("two syncs that arrive out of order", () => {
  // Pushes are fire-and-forget and each awaits an async build before it is sent,
  // so the wire order is not the order they were computed in. A full-replacement
  // payload cannot say "I am out of date" — it can only not land.
  test("an older snapshot is dropped whole, not applied", async () => {
    const recorded: Recorded = { statements: [], transactions: 0 };
    const db = fakeDbWithPriorSync(recorded, "2026-07-30T12:00:00.000Z");

    const result = await replaceRoster(db, payload(["a"], "2026-07-30T09:00:00.000Z"));

    expect(result.stale).toBe(true);
    expect(result.received).toBe(0);
    // Nothing was written: no member upsert, no deactivation, no as_of move.
    expect(recorded.statements.some((s) => s.includes("INSERT INTO hx.roster ("))).toBe(false);
    expect(recorded.statements.some((s) => s.includes("UPDATE hx.roster"))).toBe(false);
    expect(recorded.statements.some((s) => s.includes("INSERT INTO hx.roster_sync"))).toBe(false);
  });

  test("a snapshot with the SAME asOf is stale too — strictly newer, not newer-or-equal", async () => {
    const recorded: Recorded = { statements: [], transactions: 0 };
    const db = fakeDbWithPriorSync(recorded, "2026-07-30T12:00:00.000Z");
    const result = await replaceRoster(db, payload(["a"], "2026-07-30T12:00:00.000Z"));
    expect(result.stale).toBe(true);
  });

  test("a newer snapshot applies, and its as_of upsert cannot move the stored value back", async () => {
    const recorded: Recorded = { statements: [], transactions: 0 };
    const db = fakeDbWithPriorSync(recorded, "2026-07-30T09:00:00.000Z");

    const result = await replaceRoster(db, payload(["a"], "2026-07-30T12:00:00.000Z"));

    expect(result.stale).toBeUndefined();
    expect(result.received).toBe(1);
    const sync = recorded.statements.find((s) => s.includes("INSERT INTO hx.roster_sync"));
    expect(sync).toContain("WHERE EXCLUDED.as_of > hx.roster_sync.as_of");
  });
});
