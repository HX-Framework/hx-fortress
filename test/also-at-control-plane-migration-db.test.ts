// Migration 0032 over rows that already exist.
//
// The residency audit's weaker finding was stored under a name that held the
// name of one control plane: the verdict of each such finding, and a count
// column of hx.audit_runs. 0032 moves both to the name the code has. What it
// must not do is lose a count, lose a finding, touch a verdict that is not the
// one it moves, or stop the binary one release older from recording a run:
// that binary still writes the first count column. Those are properties of SQL
// over rows, so they are proved here against a real Postgres.
//
// The migration has already run on the database this suite gets, as on every
// migrated database, and its statements are safe to run again. So the suite
// writes rows as the older binary wrote them and runs the file's SQL over
// them. It never puts a database back to an earlier step, and it touches only
// rows of its own.
//
// Gated like every DB-backed suite: FORTRESS_DATABASE_URL, one database per file.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { finishAuditRun, recordFindings, startAuditRun } from "../src/console/audit-store";
import type { RollUpCounts } from "../src/console/audit-verdicts";
import { createHxDb, type HxDb } from "../src/host/postgres/db";
import { runMigrations } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";
import { makeMigrationExec } from "../src/host/postgres/sql-exec";
import { auditFindingsQuery } from "../src/query/console/audit";

const DSN = process.env.FORTRESS_DATABASE_URL;
const NAME = "0032_also_at_control_plane";

describe.skipIf(!DSN)("migration 0032 moves the stored verdict and its count, and keeps what was recorded", () => {
  const exec = makeMigrationExec(DSN as string);
  const OLDER_RUN = "0a320000-0000-4000-8000-000000000001";
  const OLDER_RUN_AFTER = "0a320000-0000-4000-8000-000000000002";
  const ORG = "org-migration-0032";
  const sql = migrations.find((migration) => migration.name === NAME)?.sql ?? "";
  let db: HxDb;

  const removeOwnRows = async (): Promise<void> => {
    // Findings go with their run.
    await exec.exec(
      `DELETE FROM hx.audit_runs WHERE id IN ('${OLDER_RUN}', '${OLDER_RUN_AFTER}') OR requested_by = '${ORG}';
       DELETE FROM hx.audit_acks WHERE org = '${ORG}';`,
    );
  };

  const verdicts = async (run: string): Promise<Record<string, string>> => {
    const rows = await exec.query<{ session_id: string; verdict: string }>(
      `SELECT session_id, verdict FROM hx.audit_findings WHERE run_id = '${run}' ORDER BY session_id`,
    );
    return Object.fromEntries(rows.map((row) => [row.session_id, row.verdict]));
  };

  const counts = async (run: string): Promise<{ moved: number; first: number; confirmed: number } | undefined> =>
    (
      await exec.query<{ moved: number; first: number; confirmed: number }>(
        `SELECT also_at_control_plane AS moved, also_at_letai AS first, confirmed
           FROM hx.audit_runs WHERE id = '${run}'`,
      )
    )[0];

  beforeAll(async () => {
    expect(sql.length).toBeGreaterThan(0);
    await runMigrations(exec, migrations);
    db = createHxDb(DSN as string);
    await removeOwnRows();
    // A run and its findings as the binary before this migration recorded them.
    await exec.exec(
      `INSERT INTO hx.audit_runs (id, trigger, requested_by, finished_at, sessions_checked, confirmed, also_at_letai)
            VALUES ('${OLDER_RUN}', 'manual', '${ORG}', now(), 8, 5, 3);
       INSERT INTO hx.audit_findings (run_id, org, family, session_id, verdict) VALUES
         ('${OLDER_RUN}', '${ORG}', 'claude', 'held-twice', 'also_at_letai'),
         ('${OLDER_RUN}', '${ORG}', 'claude', 'held-here', 'confirmed'),
         ('${OLDER_RUN}', '${ORG}', 'claude', 'never-arrived', 'not_delivered_here');
       INSERT INTO hx.audit_acks (org, session_id, acknowledged_at, acknowledged_by, reason)
            VALUES ('${ORG}', 'held-twice', now(), 'marta', 'kept from before the move');`,
    );
  });

  afterAll(async () => {
    await removeOwnRows();
  });

  test("only the one verdict is rewritten, and the count is copied with the first column kept", async () => {
    await exec.exec(sql);

    expect(await verdicts(OLDER_RUN)).toEqual({
      "held-here": "confirmed",
      "held-twice": "also_at_control_plane",
      "never-arrived": "not_delivered_here",
    });
    expect(await counts(OLDER_RUN)).toEqual({ moved: 3, first: 3, confirmed: 5 });
    // The acknowledgement is keyed by organization and session and holds no
    // verdict, so it still answers the finding under its new name.
    const acks = await exec.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM hx.audit_acks k
         JOIN hx.audit_findings f
           ON f.org = k.org AND f.session_id = k.session_id AND f.verdict = 'also_at_control_plane'
        WHERE k.org = '${ORG}'`,
    );
    expect(acks[0]?.n).toBe(1);
  });

  test("it is recorded once, and its statements change nothing when run again", async () => {
    expect(await runMigrations(exec, migrations)).toEqual([]);
    await exec.exec(sql);
    expect((await verdicts(OLDER_RUN))["held-twice"]).toBe("also_at_control_plane");
    expect(await counts(OLDER_RUN)).toEqual({ moved: 3, first: 3, confirmed: 5 });
  });

  test("this binary records a run on the migrated schema, and its page reads the finding with its acknowledgement", async () => {
    const run = await startAuditRun(db, { trigger: "manual", requestedBy: ORG });
    await recordFindings(db, run.id, [
      {
        org: ORG,
        family: "claude",
        sessionId: "held-twice",
        verdict: "also_at_control_plane",
        ingestChannel: "tunnel",
        detail: "held here, and the control plane holds a historical copy",
        acknowledged: true,
      },
    ]);
    const zero: RollUpCounts = {
      sessionsChecked: 0,
      confirmed: 0,
      alsoAtControlPlane: 0,
      alsoAtControlPlaneAcknowledged: 0,
      notDeliveredHere: 0,
      noRecord: 0,
      residencyUnchecked: 0,
      residencyUnwitnessable: 0,
      missingHere: 0,
      lanesHoldIt: 0,
      unknownProvenance: 0,
      notApplicable: 0,
      copyUnchecked: 0,
    };
    await finishAuditRun(db, run.id, {
      counts: { ...zero, sessionsChecked: 4, confirmed: 3, alsoAtControlPlane: 1, alsoAtControlPlaneAcknowledged: 1 },
      qualification: "1 historical copy at the control plane, acknowledged",
      error: null,
    });

    expect(await counts(run.id)).toEqual({ moved: 1, first: 0, confirmed: 3 });
    // Running the file again must not overwrite a count this binary wrote.
    await exec.exec(sql);
    expect(await counts(run.id)).toEqual({ moved: 1, first: 0, confirmed: 3 });

    // The page's own query, over the run that is now the latest finished one.
    const result: unknown = await db.execute(auditFindingsQuery());
    const page = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Array<{
      org: string;
      sessionId: string;
      verdict: string;
      acknowledged: boolean;
    }>;
    expect(page.filter((row) => row.org === ORG)).toEqual([
      expect.objectContaining({ sessionId: "held-twice", verdict: "also_at_control_plane", acknowledged: true }),
    ]);
  });

  test("the binary one release older still records its run", async () => {
    // The statement that binary runs when a residency audit finishes, with the
    // column names it knows. It has to keep working after this migration,
    // because going back to that binary is a documented way out of a bad release.
    await exec.exec(
      `INSERT INTO hx.audit_runs (id, trigger, requested_by) VALUES ('${OLDER_RUN_AFTER}', 'manual', '${ORG}');
       UPDATE hx.audit_runs
          SET finished_at = now(),
              sessions_checked = 6,
              confirmed = 4,
              also_at_letai = 2,
              not_delivered_here = 0,
              no_record = 0,
              residency_unchecked = 0,
              residency_unwitnessable = 0,
              missing_here = 0,
              lanes_hold_it = 0,
              unknown_provenance = 0,
              not_applicable = 0,
              copy_unchecked = 0,
              qualification = 'a run by the older binary',
              error = NULL
        WHERE id = '${OLDER_RUN_AFTER}'::uuid;`,
    );
    expect(await counts(OLDER_RUN_AFTER)).toEqual({ moved: 0, first: 2, confirmed: 4 });
  });
});
