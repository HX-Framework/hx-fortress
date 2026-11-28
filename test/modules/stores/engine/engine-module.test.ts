// The Stores module with the Store's engine behind it: every ask goes through
// the real ask gate to a real process that runs the real engine on a real
// file. This is where the forms the module reads (answers.ts) are held to the
// forms the engine answers in.

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";

import type { Person } from "../../../../src/host/module-contract";
import type { StoreCaller } from "../../../../src/modules/stores/engine/store-object/src/types.js";
import { engineOnStore } from "../../../../src/modules/stores/engine-program";
import { FileStorage } from "../../../../src/modules/stores/host/file-storage";
import { readWriteLimit, storeFolder } from "../../../../src/modules/stores/host/store-folder";
import { STORE_ID_SETTING } from "../../../../src/modules/stores/store-calls";
import { spoolRecords, writeConfig } from "../../../host/_module-rig";
import { endStoresRigs, isHeld, REAL_ENGINE, storesActions, storesRig, until, type StoresRig } from "../_module-rig";

afterEach(endStoresRigs);

/** The module behind the ask gate, with the Store's engine in each Store's
 *  process: this program's own command line, started with the Store's word. */
const engineRig = (): Promise<StoresRig> => storesRig({ program: REAL_ENGINE });

/**
 * Give a Store a table and rows, as a person of the organization would: with
 * the engine's own calls that hold rows, on the Store's file, before the
 * Store's process has it open. Those calls are not the module's yet. The
 * engine is put on the file the way the Store's own process puts it there.
 */
async function fill(root: string, storeId: string): Promise<void> {
  const folder = storeFolder(root);
  const storage = new FileStorage({ folder });
  try {
    const { handler } = engineOnStore({
      storage,
      folder,
      settings: { [STORE_ID_SETTING]: storeId },
      now: () => Date.now(),
      abort: () => undefined,
    });
    const lena: StoreCaller = { storeId, actor: "user:lena" };
    const table = await handler.migrate(lena, {
      id: "0001_permits",
      sql: "CREATE TABLE permits (permit_no text PRIMARY KEY, address text, fee real, issued text);",
    });
    if (!table.ok) throw new Error(`the table was not made: ${table.code}`);
    const rows = await handler.exec(lena, {
      sql: "INSERT INTO permits VALUES ('BP-2026-0412', '18 Mill Road', 120.5, '2026-03-02'), ('BP-2026-0413', '7 Alder Court', 80, '2026-03-02')",
    });
    if (!rows.ok) throw new Error(`the rows were not written: ${rows.code}`);
  } finally {
    storage.close();
  }
}

const MARTA: Person = { login: "marta", email: null, role: "operator" };

function holdsNoRow(answer: unknown): void {
  const text = JSON.stringify(answer);
  for (const value of ["Mill Road", "Alder Court", "BP-2026", "120.5", "INSERT INTO", "CREATE TABLE"]) {
    expect(text).not.toContain(value);
  }
}

describe("the module's asks, answered by the Store's engine", () => {
  test("a new Store is empty, and says so in every answer", async () => {
    const stores = await engineRig();
    await stores.ask("create", { store: "store-1" });
    const catalog = (await stores.ask("catalog.read", { store: "store-1", page: 0 })) as {
      ok: boolean;
      payload: { page: number; pages: number; tables: number; leftOut: unknown; items: { kind: string; rows: number }[] };
    };
    expect(catalog.ok).toBe(true);
    // The engine lists the tables it keeps its own records in, and no other.
    expect(catalog.payload.items.length).toBe(catalog.payload.tables);
    expect(catalog.payload.items.every((item) => item.kind === "system")).toBe(true);
    expect(catalog.payload.leftOut).toEqual({ tables: 0, columns: 0 });
    expect(catalog.payload.pages).toBe(1);
    const stats = (await stores.ask("stats.read", { store: "store-1" })) as { ok: boolean; payload: Record<string, unknown> };
    expect(stats.ok).toBe(true);
    // No table of its people's, and the limit every Store has.
    expect(stats.payload).toMatchObject({ tables: 0, rows: 0, files: 0, fileBytes: 0, busy: false, writeLimit: 2_000_000, ownLimit: false });
    expect(await stores.ask("review.read", { store: "store-1" })).toEqual({
      ok: true,
      payload: { tables: [], leftOut: 0, more: 0 },
    });
    // Nothing happened to it yet: no line, and so no moment to take the Store
    // back to.
    expect(await stores.ask("history.read", { store: "store-1" })).toEqual({
      ok: true,
      payload: { lines: [], leftOut: 0, more: 0 },
    });
  }, 30_000);

  test("a Store with a table and rows: names, counts and times, and never a row's value or a statement's text", async () => {
    const stores = await engineRig();
    await stores.ask("create", { store: "store-1" });
    await fill(stores.folderOf("s000001"), "store-1");

    const catalog = (await stores.ask("catalog.read", { store: "store-1", page: 0 })) as {
      ok: boolean;
      payload: { tables: number; leftOut: unknown; items: { name: string; kind: string; rows: number; columns: unknown[] }[] };
    };
    expect(catalog.ok).toBe(true);
    expect(catalog.payload.leftOut).toEqual({ tables: 0, columns: 0 });
    const permits = catalog.payload.items.find((item) => item.name === "permits");
    expect(permits).toMatchObject({
      name: "permits",
      kind: "managed",
      rows: 2,
      columns: [
        { name: "permit_no", type: "characters", key: 1 },
        { name: "address", type: "characters" },
        { name: "fee", type: "decimal" },
        { name: "issued", type: "characters" },
      ],
    });

    const stats = (await stores.ask("stats.read", { store: "store-1" })) as { ok: boolean; payload: Record<string, unknown> };
    expect(stats.ok).toBe(true);
    expect(stats.payload.tables).toBeGreaterThanOrEqual(1);
    expect(stats.payload.bytes).toBeGreaterThan(0);
    expect(typeof stats.payload.writesSince).toBe("string");

    const history = (await stores.ask("history.read", { store: "store-1" })) as {
      ok: boolean;
      payload: { lines: { kind: string; by: string; restorable: boolean }[]; leftOut: number; more: number };
    };
    expect(history.ok).toBe(true);
    expect(history.payload.leftOut).toBe(0);
    expect(history.payload.more).toBe(0);
    // The table was made by a migration, and the engine kept who made it.
    expect(history.payload.lines.some((line) => line.kind === "migration" && line.by === "user:lena")).toBe(true);
    // The Store holds the snapshot that was taken before the migration. So
    // that line can take the Store back, and the answer says how far back.
    expect(history.payload.lines.filter((line) => line.restorable).map((line) => line.kind)).toEqual(["migration"]);
    expect(typeof (history.payload as { restorableFrom?: unknown }).restorableFrom).toBe("string");

    const review = await stores.ask("review.read", { store: "store-1" });
    expect((review as { ok: boolean }).ok).toBe(true);

    for (const answer of [catalog, stats, history, review]) holdsNoRow(answer);
    holdsNoRow(stores.rig.logs);
    holdsNoRow(await spoolRecords(stores.rig.paths));
  }, 30_000);

  test("a restore: asked for by a line of the history, approved by a person, and the Store is back at the moment before that line", async () => {
    const stores = await engineRig();
    await stores.ask("create", { store: "store-1" });
    await fill(stores.folderOf("s000001"), "store-1");
    type Line = { id: string; kind: string; by: string; restorable: boolean };
    const lines = async (): Promise<Line[]> =>
      ((await stores.ask("history.read", { store: "store-1" })) as { payload: { lines: Line[] } }).payload.lines;
    const tableNames = async (): Promise<string[]> =>
      (
        (await stores.ask("catalog.read", { store: "store-1", page: 0 })) as {
          payload: { items: { name: string; kind: string; rows: number }[] };
        }
      ).payload.items
        .filter((item) => item.kind !== "system")
        .map((item) => `${item.name}:${item.rows}`);
    expect(await tableNames()).toEqual(["permits:2"]);

    // The line of the migration that made the table is a way back, to the
    // moment before the table was there.
    const migration = (await lines()).find((line) => line.kind === "migration" && line.restorable);
    if (!migration) throw new Error("the history has no line that is a way back");
    const asked = (await stores.ask("restore", { store: "store-1", line: migration.id })) as { ok: boolean; payload: { line: string } };
    expect(asked).toMatchObject({ ok: true, payload: { store: "store-1", line: migration.id } });
    // Asked, and nothing more: the table is there.
    expect(await tableNames()).toEqual(["permits:2"]);

    const ctx = stores.ctx();
    const processes = stores.asked.length;
    const done = await stores.module.decideRestore(ctx, MARTA, "store-1", migration.id, true);
    expect(done.state).toBe("restored");
    expect(stores.asked).toHaveLength(processes + 1);
    // The Store is as it was before the migration: the table is gone.
    expect(await tableNames()).toEqual([]);
    // Its history still has the migration's line, and the restore's own: by
    // the console, never by the person's login.
    const after = await lines();
    expect(after.some((line) => line.id === migration.id)).toBe(true);
    const restore = after.find((line) => line.kind === "restore");
    expect(restore).toMatchObject({ kind: "restore", by: "console", restorable: true });
    expect(JSON.stringify(after)).not.toContain("marta");

    // The restore's own line is the way back to the moment just before it:
    // the table and both its rows are there again.
    await stores.ask("restore", { store: "store-1", line: (restore as Line).id });
    expect((await stores.module.decideRestore(ctx, MARTA, "store-1", (restore as Line).id, true)).state).toBe("restored");
    expect(await tableNames()).toEqual(["permits:2"]);
    expect((await lines()).filter((line) => line.kind === "restore")).toHaveLength(2);

    // HX Fortress's own audit trail has who approved each, and no row.
    const actions = await storesActions(stores);
    expect(actions.map(([action]) => action)).toEqual([
      "store.create",
      "store.restore.asked",
      "store.restore.approved",
      "store.restored",
      "store.restore.asked",
      "store.restore.approved",
      "store.restored",
    ]);
    expect(actions.at(3)?.[1]).toMatchObject({ target: "store-1", line: migration.id, by: "marta" });
    holdsNoRow(actions);
    holdsNoRow(stores.rig.logs);
  }, 60_000);

  test("a job that is not there, and a write limit that is none, cross as the Store program's own words", async () => {
    const stores = await engineRig();
    await stores.ask("create", { store: "store-1" });
    expect(await stores.ask("job.read", { store: "store-1", job: "job_000000000000000000000000" })).toEqual({
      ok: false,
      error: "failed:engine_not_found",
    });
    // Under the fewest rows a Store's own limit may be.
    expect(await stores.ask("write_limit.set", { store: "store-1", rows: 500 })).toEqual({
      ok: false,
      error: "failed:engine_bad_request",
    });
  }, 30_000);

  test("a Store's own write limit is kept with the Store: its next process holds the Store to it", async () => {
    const stores = await engineRig();
    await stores.ask("create", { store: "store-1" });
    const root = stores.folderOf("s000001");
    expect(await stores.ask("write_limit.set", { store: "store-1", rows: 5_000 })).toEqual({
      ok: true,
      payload: { writeLimit: 5_000, ownLimit: true },
    });
    const stats = (await stores.ask("stats.read", { store: "store-1" })) as { payload: Record<string, unknown> };
    expect(stats.payload).toMatchObject({ writeLimit: 5_000, ownLimit: true });
    // In the Store's own folder, beside its file.
    expect(readWriteLimit(storeFolder(root))).toBe(5_000);

    // Somebody on this host switches the module off and on: the Store's
    // process ends, and the next ask gets a new one.
    await writeConfig(stores.rig.paths, ["session_vault", "probe"]);
    await stores.rig.host.follow();
    expect(isHeld(root)).toBe(false);
    await writeConfig(stores.rig.paths, ["session_vault", "probe", "stores"]);
    await stores.rig.host.follow();
    const again = (await stores.ask("stats.read", { store: "store-1" })) as { payload: Record<string, unknown> };
    expect(again.payload).toMatchObject({ writeLimit: 5_000, ownLimit: true });
    // Another Store of the same organization has the limit every Store has.
    await stores.ask("create", { store: "store-2" });
    const other = (await stores.ask("stats.read", { store: "store-2" })) as { payload: Record<string, unknown> };
    expect(other.payload).toMatchObject({ writeLimit: 2_000_000, ownLimit: false });
  }, 30_000);

  test("a Store whose own write limit cannot be read is not opened, and the log says so by one word", async () => {
    const stores = await engineRig();
    await stores.ask("create", { store: "store-1" });
    const root = stores.folderOf("s000001");
    // The file is damaged, as by a hand that wrote text where the number goes.
    writeFileSync(storeFolder(root).writeLimit, '{"rows":"5000"}');
    for (const [name, args] of [
      ["stats.read", { store: "store-1" }],
      // The ask that sets a limit needs the Store open too.
      ["write_limit.set", { store: "store-1", rows: 5_000 }],
    ] as const) {
      expect(await stores.ask(name, args)).toEqual({ ok: false, error: "failed:store_stopped" });
    }
    expect(isHeld(root)).toBe(false);
    // Whoever reads the log is told which thing to look at.
    const said = stores.rig.logs.filter((record) => record.msg === "a Store's process stopped during a call");
    expect(said.map((record) => record.fields)).toEqual([
      { call: "stats", why: "open_failed", code: "write_limit_unreadable" },
      { call: "setWriteLimit", why: "open_failed", code: "write_limit_unreadable" },
    ]);
  }, 30_000);

  test("a Store whose engine cannot start: the process ends itself, and each ask gets a new one", async () => {
    const stores = await engineRig();
    await stores.ask("create", { store: "store-1" });
    const root = stores.folderOf("s000001");
    // One of the engine's own tables is there as something it cannot index:
    // its start fails on this file every time.
    const storage = new FileStorage({ folder: storeFolder(root) });
    storage.sql.exec("CREATE VIEW _jobs AS SELECT 1 AS id");
    storage.close();
    for (let asks = 1; asks <= 2; asks += 1) {
      expect(await stores.ask("stats.read", { store: "store-1" })).toEqual({ ok: false, error: "failed:store_stopped" });
      // The process did not stay to fail the next call: it is gone, and the
      // next ask started one more.
      expect(await until(() => !isHeld(root))).toBe(true);
      expect(stores.asked).toHaveLength(asks);
    }
  }, 30_000);

  test("the engine takes calls for its own Store only: a file that was another Store's is refused by a word", async () => {
    const stores = await engineRig();
    await stores.ask("create", { store: "store-1" });
    // The file was first used under another id.
    await fill(stores.folderOf("s000001"), "another-store");
    expect(await stores.ask("stats.read", { store: "store-1" })).toEqual({
      ok: false,
      error: "failed:engine_token_wrong_store",
    });
  }, 30_000);
});
