import { describe, expect, test } from "bun:test";

import { migrations } from "../src/host/postgres/migrations/manifest";

// Migration ORDER is a correctness property here, not a tidiness one.
//
// The deep-verify cursor columns are declared in the drizzle schema, and drizzle
// expands `select().from(hxSessions)` into the full declared column list — so
// LIVE INGEST fails with "column does not exist" until those columns are added.
//
// The FK-index build is the one migration whose own header warns it may exceed
// FORTRESS_DB_MIGRATION_TIMEOUT_MS on a large corpus. If it rolls back
// un-journalled with the cursor migration BEHIND it, the provider never reaches
// ready and the fortress stops ingesting entirely.
//
// So the instant ADD COLUMNs must precede the risky build. Nothing else in the
// codebase enforces that, and the two were originally the other way round.
describe("migration manifest", () => {
  const nameAt = (n: string) => migrations.findIndex((m) => m.name === n);

  test("the cursor columns land before the index build", () => {
    const cursor = nameAt("0015_deep_verify_cursor");
    const indexes = nameAt("0016_fk_indexes");
    expect(cursor).toBeGreaterThanOrEqual(0);
    expect(indexes).toBeGreaterThanOrEqual(0);
    expect(cursor).toBeLessThan(indexes);
  });

  test("names are unique and numerically ordered", () => {
    const names = migrations.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    const nums = names.map((n) => Number(n.slice(0, 4)));
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
  });

  test("every migration carries non-empty SQL", () => {
    for (const m of migrations) {
      expect(typeof m.sql).toBe("string");
      expect(m.sql.trim().length).toBeGreaterThan(0);
    }
  });
});
