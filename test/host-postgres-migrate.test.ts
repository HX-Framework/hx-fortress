import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { runMigrations, type Migration, type MigrationExec } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";

/** In-memory fake: records exec'd statements, tracks schema_migrations, and
 *  answers extension-availability from the given set. */
function fakeDb(availableExtensions: string[] = []): MigrationExec & {
  calls: string[];
  applied: Set<string>;
} {
  const applied = new Set<string>();
  const calls: string[] = [];
  const available = new Set(availableExtensions);
  return {
    calls,
    applied,
    async exec(sql) {
      calls.push(sql);
      const insert = sql.match(/schema_migrations.*VALUES \('([^']+)'\)/s);
      if (insert) applied.add(insert[1]);
    },
    async query<T>(sql: string): Promise<T[]> {
      if (sql.includes("FROM hx.schema_migrations")) {
        return [...applied].map((name) => ({ name })) as T[];
      }
      // The extension probe is a simple-protocol batch with the ALLOWLISTED
      // name interpolated as a quoted literal (the extended protocol can't
      // share the bounded batch) — parse the literal back out.
      const probe = sql.match(/pg_available_extensions WHERE name = '([^']+)'/);
      if (probe) {
        return [{ n: available.has(probe[1]) ? 1 : 0 }] as T[];
      }
      return [] as T[];
    },
  };
}

const sample: Migration[] = [
  { name: "0000_a", sql: "CREATE TABLE a();" },
  { name: "0001_b", sql: "CREATE TABLE b();" },
];

describe("runMigrations", () => {
  test("applies all migrations in order on a fresh db", async () => {
    const db = fakeDb();
    const done = await runMigrations(db, sample);
    expect(done).toEqual(["0000_a", "0001_b"]);
    expect(db.calls.some((c) => c.includes("CREATE TABLE a()"))).toBe(true);
    expect(db.calls.some((c) => c.includes("CREATE TABLE b()"))).toBe(true);
  });

  test("is idempotent — skips already-applied migrations", async () => {
    const db = fakeDb();
    await runMigrations(db, sample);
    const second = await runMigrations(db, sample);
    expect(second).toEqual([]);
  });

  test("rejects an invalid migration name (SQL-injection guard)", async () => {
    const db = fakeDb();
    await expect(
      runMigrations(db, [{ name: "0000_a'; DROP TABLE x;--", sql: "SELECT 1;" }]),
    ).rejects.toThrow("invalid migration name");
  });

  const gated: Migration[] = [{ name: "0006_vec", sql: "CREATE TABLE v();", requires: "vector" }];

  test("skips a gated migration when its extension is unavailable", async () => {
    const db = fakeDb([]); // vector not available
    const done = await runMigrations(db, gated);
    expect(done).toEqual([]);
    expect(db.applied.has("0006_vec")).toBe(false);
    expect(db.calls.some((c) => c.includes("CREATE TABLE v()"))).toBe(false);
  });

  test("applies a gated migration when its extension is available", async () => {
    const db = fakeDb(["vector"]);
    const done = await runMigrations(db, gated);
    expect(done).toEqual(["0006_vec"]);
    expect(db.applied.has("0006_vec")).toBe(true);
  });
});

// The manifest is the only registry there is — no drizzle journal, no snapshots,
// and `drizzle-kit check` dropped with them. These assertions are what remains
// standing in their place: a mis-numbered or re-used prefix would apply a
// migration out of order on a fresh cluster and silently no-op on an old one.
describe("the migration manifest", () => {
  const prefixes = migrations.map((m) => m.name.slice(0, 4));

  test("every name is NNNN_<slug> and the array is in ascending prefix order", () => {
    for (const migration of migrations) {
      expect(migration.name).toMatch(/^\d{4}_[a-z0-9_]+$/);
    }
    expect(prefixes).toEqual([...prefixes].sort());
  });

  test("no prefix is used twice", () => {
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  test("each entry's name matches the .sql file it embeds", async () => {
    const dir = path.join(import.meta.dir, "..", "src", "host", "postgres", "migrations");
    const onDisk = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    expect(migrations.map((m) => `${m.name}.sql`)).toEqual(onDisk);
  });

  // 0009 was reserved for an embed-job lease table that the implementation
  // replaced with an in-process worker; the runner keys on names, not on a dense
  // range, so the hole is inert. Asserted so a later "fix" cannot renumber into it.
  test("0009 is absent by design", () => {
    expect(prefixes).not.toContain("0009");
  });
});
