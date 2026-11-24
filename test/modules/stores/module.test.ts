import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { ASK_DEADLINE_MS } from "../../../src/host/ask-gate";
import { createModuleState } from "../../../src/host/module-context";
import type { Person } from "../../../src/host/module-contract";
import { FileStorage } from "../../../src/modules/stores/host/file-storage";
import { readAlarm, storeFolder, writeAlarm } from "../../../src/modules/stores/host/store-folder";
import { DEFAULT_WRITE_LIMIT_CEILING } from "../../../src/modules/stores/module";
import { CALL_LIMIT_MS } from "../../../src/modules/stores/open-stores";
import { StoreRegistry } from "../../../src/modules/stores/registry";
import { ORG, spoolRecords, writeConfig, writeOrganizations } from "../../host/_module-rig";
import {
  endStoresRigs,
  FAKE_ENGINE,
  heldStarts,
  hostRefusals,
  isHeld,
  storesActions,
  storesRig,
  until,
} from "./_module-rig";

const ALDER = "org-alder";

const MARTA: Person = { login: "marta", email: null, role: "operator" };
const RUTH: Person = { login: "ruth", email: null, role: "readonly" };

afterEach(endStoresRigs);

/** Put rows into a Store's file, the way a load will: before the Store's
 *  process has it open. */
function fill(root: string): void {
  const storage = new FileStorage({ folder: storeFolder(root) });
  storage.sql.exec("CREATE TABLE permits (permit_no TEXT PRIMARY KEY, address TEXT, fee REAL, issued DATE)");
  storage.sql.exec("INSERT INTO permits VALUES ('BP-2026-0412', '18 Mill Road', 120.5, '2026-03-02')");
  storage.sql.exec("INSERT INTO permits VALUES ('BP-2026-0413', '7 Alder Court', 80, '2026-03-02')");
  storage.sql.exec("CREATE TABLE owners (id INTEGER PRIMARY KEY, name TEXT)");
  storage.sql.exec("INSERT INTO owners VALUES (1, 'Lena Hart')");
  storage.close();
}

function holdsNoRow(answer: unknown): void {
  const text = JSON.stringify(answer);
  for (const value of ["Mill Road", "Alder Court", "Lena Hart", "BP-2026", "120.5", "lena_hart"]) {
    expect(text).not.toContain(value);
  }
}

describe("the module, behind the ask gate", () => {
  test("is off until somebody on this host switches it on", async () => {
    const made = await storesRig({ enabled: ["session_vault", "probe"] });
    expect(await made.ask("list")).toEqual({ ok: false, error: "module_off" });
  });

  test("create makes a Store in a new folder of the module's own, for the owner alone", async () => {
    const made = await storesRig({ stores: "none" });
    expect(await made.ask("create", { store: "store_01-A", name: "Elm Falls permits" })).toEqual({
      ok: true,
      payload: { store: "store_01-A", state: "ready", created: true },
    });
    const root = made.folderOf("s000001");
    expect(existsSync(path.join(root, "store.sqlite"))).toBe(true);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(root, "store.sqlite")).mode & 0o777).toBe(0o600);
    // The id is nowhere in a path.
    expect(existsSync(made.folderOf("store_01-A"))).toBe(false);

    // Asking again changes nothing, and touches nothing of the Store's.
    fill(root);
    const size = statSync(path.join(root, "store.sqlite")).size;
    expect(await made.ask("create", { store: "store_01-A", name: "Another name" })).toEqual({
      ok: true,
      payload: { store: "store_01-A", state: "ready", created: false },
    });
    expect(statSync(path.join(root, "store.sqlite")).size).toBe(size);
    const list = (await made.ask("list")) as { payload: { stores: Record<string, unknown>[] } };
    expect(list.payload.stores).toEqual([
      {
        store: "store_01-A",
        name: "Elm Falls permits",
        state: "ready",
        bytes: size,
        createdAt: "2027-03-14T09:00:00.000Z",
      },
    ]);
    expect(await storesActions(made)).toEqual([["store.create", { target: "store_01-A" }]]);
  });

  test("an id the Store's own program would not take is refused, and nothing is made", async () => {
    const made = await storesRig({ stores: "none" });
    for (const store of ["store.01", "a:b", ".."]) {
      expect(await made.ask("create", { store })).toEqual({ ok: false, error: "failed:store_id_invalid" });
    }
    expect(await made.ask("list")).toEqual({ ok: true, payload: { stores: [] } });
    expect(existsSync(made.folderOf("s000001"))).toBe(false);
    expect(await storesActions(made)).toEqual([]);
  });

  test("where the module host cannot start this program again, a Store is kept and none is opened", async () => {
    // What runs is not this program's own command line: the module host has
    // no command to start again, and starts nothing.
    const made = await storesRig({ stores: "none" });
    await made.ask("create", { store: "store-1" });
    for (const [name, args] of [
      ["catalog.read", { store: "store-1", page: 0 }],
      ["stats.read", { store: "store-1" }],
      ["history.read", { store: "store-1" }],
      ["review.read", { store: "store-1" }],
      ["job.read", { store: "store-1", job: "job_1" }],
      ["write_limit.set", { store: "store-1", rows: 1000 }],
    ] as const) {
      // The module host's own word for the rule: whoever reads it reads a
      // defect on this side, and nothing to ask again for.
      expect(await made.ask(name, args)).toEqual({ ok: false, error: "failed:process_start_failed" });
    }
    expect(made.asked).toEqual([]);
    expect(((await made.ask("list")) as { ok: boolean }).ok).toBe(true);
    // The module host recorded the start it did not make, by its own rule.
    // The same refusal again is counted with the first, and not written again.
    expect(await hostRefusals(made)).toEqual([{ module: "stores", rule: "process_start_failed" }]);

    // With a command to start, the same Store opens: nothing was kept against it.
    made.startAs(FAKE_ENGINE);
    expect(((await made.ask("stats.read", { store: "store-1" })) as { ok: boolean }).ok).toBe(true);
  }, 30_000);

  test("after a start the module host refused, the Store's folder is looked at again: a Store whose file is gone is not opened as an empty one", async () => {
    const made = await storesRig({ stores: "none" });
    await made.ask("create", { store: "store-1" });
    const folder = storeFolder(made.folderOf("s000001"));
    expect(await made.ask("stats.read", { store: "store-1" })).toEqual({ ok: false, error: "failed:process_start_failed" });
    // The Store's file goes while nothing holds it, and its folder stays.
    rmSync(folder.database);
    made.startAs(FAKE_ENGINE);
    // The module host would start a process now, and that process would make
    // a new, empty file. The module does not ask for one.
    expect(await made.ask("stats.read", { store: "store-1" })).toEqual({ ok: false, error: "failed:store_folder_missing" });
    expect(existsSync(folder.database)).toBe(false);
    expect(made.asked).toEqual([]);
  }, 30_000);

  test("after a start the module host refused, a level of the folder that held nothing and is missing is put back", async () => {
    const made = await storesRig({ stores: "none" });
    await made.ask("create", { store: "store-1" });
    const folder = storeFolder(made.folderOf("s000001"));
    expect(await made.ask("stats.read", { store: "store-1" })).toEqual({ ok: false, error: "failed:process_start_failed" });
    // As after a copy of the disk that left empty folders out.
    rmSync(folder.scratch, { recursive: true });
    made.startAs(FAKE_ENGINE);
    expect(((await made.ask("stats.read", { store: "store-1" })) as { ok: boolean }).ok).toBe(true);
    expect(existsSync(folder.scratch)).toBe(true);
  }, 30_000);

  test("a Store that is not there", async () => {
    const made = await storesRig();
    for (const [name, args] of [
      ["catalog.read", { store: "nowhere", page: 0 }],
      ["stats.read", { store: "nowhere" }],
      ["job.read", { store: "nowhere", job: "job_1" }],
      ["write_limit.set", { store: "nowhere", rows: 1 }],
      // Also with a number no Store may be set to here: the Store comes first.
      ["write_limit.set", { store: "nowhere", rows: DEFAULT_WRITE_LIMIT_CEILING + 1 }],
      ["delete", { store: "nowhere" }],
      // An id that could never be a Store's.
      ["stats.read", { store: "a.b:c" }],
    ] as const) {
      expect(await made.ask(name, args)).toEqual({ ok: false, error: "failed:store_unknown" });
    }
    expect(made.asked).toEqual([]);
  });
});

describe("what a Store's asks answer, from a real file in a real process", () => {
  test("names, counts and states, and never a row's value", async () => {
    const made = await storesRig();
    await made.ask("create", { store: "store-1", name: "Permits" });
    fill(made.folderOf("s000001"));

    const catalog = await made.ask("catalog.read", { store: "store-1", page: 0 });
    expect(catalog).toEqual({
      ok: true,
      payload: {
        page: 0,
        pages: 1,
        tables: 2,
        leftOut: { tables: 0, columns: 0 },
        items: [
          {
            name: "owners",
            kind: "managed",
            view: false,
            rows: 1,
            estimated: false,
            version: 1,
            columnCount: 2,
            columns: [
              { name: "id", type: "whole_number", key: 1 },
              { name: "name", type: "characters" },
            ],
          },
          {
            name: "permits",
            kind: "managed",
            view: false,
            rows: 2,
            estimated: false,
            version: 1,
            columnCount: 4,
            columns: [
              { name: "permit_no", type: "characters", key: 1 },
              { name: "address", type: "characters" },
              { name: "fee", type: "decimal" },
              { name: "issued", type: "date" },
            ],
          },
        ],
      },
    });
    expect(await made.ask("catalog.read", { store: "store-1", page: 1 })).toEqual({
      ok: false,
      error: "failed:page_unknown",
    });
    const stats = (await made.ask("stats.read", { store: "store-1" })) as { ok: boolean; payload: Record<string, unknown> };
    expect(stats.ok).toBe(true);
    expect(stats.payload).toMatchObject({ tables: 2, rows: 3, files: 0, busy: false, writeLimit: 2_000_000, ownLimit: false });
    const history = await made.ask("history.read", { store: "store-1" });
    expect(history).toEqual({
      ok: true,
      payload: {
        lines: [{ id: "ev_1", at: "2026-03-02T09:14:00.000Z", kind: "table", by: "user:lena", restorable: false }],
        leftOut: 0,
        more: 0,
        restorableFrom: "2026-02-01T00:00:00.000Z",
      },
    });
    const review = await made.ask("review.read", { store: "store-1" });
    expect((review as { payload: { tables: unknown[] } }).payload.tables).toHaveLength(2);
    // A job that is there, from the form the Store's program answers in.
    const job = await made.ask("job.read", { store: "store-1", job: "job_1" });
    expect(job).toEqual({
      ok: true,
      payload: {
        job: "job_1",
        kind: "pull",
        state: "done",
        createdAt: "2026-03-02T09:00:00.000Z",
        updatedAt: "2026-03-02T09:05:00.000Z",
        rowsWritten: 2,
        done: 1,
        total: 1,
        tables: 1,
        rows: 2,
        read: 2,
        added: 2,
        changed: 0,
        removed: 0,
        cut: 0,
        pulled: [{ table: "permits", version: 1, rows: 2, mode: "new", read: 2, added: 2 }],
        leftOut: 0,
        more: 0,
      },
    });

    // The stand-in engine's own answers held the first row of each table, a
    // sentence with an address, and a job's error and result. None of it is
    // in what left.
    for (const answer of [catalog, stats, history, review, job]) holdsNoRow(answer);
  }, 20_000);

  test("the module host starts the Store's process: this program again with the Store's word, given the Store's own scratch folder", async () => {
    const made = await storesRig();
    await made.ask("create", { store: "store-1" });
    await made.ask("create", { store: "store-2" });
    await made.ask("stats.read", { store: "store-2" });
    // The folder is the Store's own, under a name of the module's, and never
    // under the Store's id.
    const scratch = path.join(made.folderOf("s000002"), "scratch");
    expect(made.asked).toEqual([{ verb: "store-engine", folder: scratch }]);
    // The command is the program and the word, and nothing of the Store. The
    // process is started in the machine's root folder, and its whole
    // environment is the one variable that names the folder.
    const [started] = made.started;
    expect(started?.command.at(-1)).toBe("store-engine");
    expect(started?.command.join(" ")).not.toContain("s000002");
    expect(started?.command.join(" ")).not.toContain("store-2");
    expect(started?.cwd).toBe("/");
    expect(started?.env).toEqual({ SQLITE_TMPDIR: scratch });
    expect(isHeld(made.folderOf("s000002"))).toBe(true);
    expect(isHeld(made.folderOf("s000001"))).toBe(false);
  }, 20_000);

  test("a refusal of the Store's program crosses as a word of a closed list, and its sentence stays", async () => {
    const made = await storesRig();
    await made.ask("create", { store: "store-1" });
    expect(await made.ask("job.read", { store: "store-1", job: "job_9" })).toEqual({
      ok: false,
      error: "failed:engine_not_found",
    });
    // A word that is not on the list, here one that carries a row's value,
    // crosses as one fixed word.
    expect(await made.ask("write_limit.set", { store: "store-1", rows: 4242 })).toEqual({
      ok: false,
      error: "failed:engine_refused",
    });
    // Not in the log or the audit trail either.
    holdsNoRow(made.rig.logs);
    holdsNoRow(await spoolRecords(made.rig.paths));
  }, 20_000);

  test("the write limit is set up to the ceiling, and recorded", async () => {
    const made = await storesRig();
    await made.ask("create", { store: "store-1" });
    expect(await made.ask("write_limit.set", { store: "store-1", rows: 500_000 })).toEqual({
      ok: true,
      payload: { writeLimit: 500_000, ownLimit: true },
    });
    expect(await made.ask("write_limit.set", { store: "store-1", rows: DEFAULT_WRITE_LIMIT_CEILING + 1 })).toEqual({
      ok: false,
      error: "failed:above_ceiling",
    });
    const stats = (await made.ask("stats.read", { store: "store-1" })) as { payload: Record<string, unknown> };
    expect(stats.payload.writeLimit).toBe(500_000);
    expect(await storesActions(made)).toEqual([
      ["store.create", { target: "store-1" }],
      ["store.write_limit.set", { target: "store-1", rows: 500_000 }],
    ]);
  }, 20_000);

  test("a Store whose program does not answer in time is stopped, and the module goes on answering", async () => {
    // A call's limit includes the start of the Store's process, so it is not
    // a short one.
    const made = await storesRig({ open: { limitMs: 3_000 } });
    await made.ask("create", { store: "stuck" });
    await made.ask("create", { store: "fine" });
    const storage = new FileStorage({ folder: storeFolder(made.folderOf("s000001")) });
    storage.sql.exec("CREATE TABLE endless (n INTEGER)");
    storage.close();
    fill(made.folderOf("s000002"));

    let settled = false;
    const stuck = made.ask("review.read", { store: "stuck" }).finally(() => (settled = true));
    expect(await until(() => isHeld(made.folderOf("s000001")))).toBe(true);
    // Another Store, and the same Store's list, answer while that call runs.
    expect(((await made.ask("stats.read", { store: "fine" })) as { ok: boolean }).ok).toBe(true);
    expect(((await made.ask("list")) as { ok: boolean }).ok).toBe(true);
    expect(settled).toBe(false);
    expect(await stuck).toEqual({ ok: false, error: "failed:store_timeout" });
    // The Store is not lost: its next call gets a new process.
    expect(((await made.ask("stats.read", { store: "stuck" })) as { ok: boolean }).ok).toBe(true);
  }, 30_000);

  test("a call's own limit is under the time the module host gives an ask", () => {
    // Otherwise the host answers first, and nobody is told that the Store was
    // too slow.
    expect(CALL_LIMIT_MS).toBeLessThan(ASK_DEADLINE_MS);
  });

  test("asks for one Store that does not answer do not hold more than its own line", async () => {
    const made = await storesRig({ open: { limitMs: 3_000, maxWaiting: 2 } });
    await made.ask("create", { store: "stuck" });
    await made.ask("create", { store: "fine" });
    const storage = new FileStorage({ folder: storeFolder(made.folderOf("s000001")) });
    storage.sql.exec("CREATE TABLE endless (n INTEGER)");
    storage.close();
    const began = Date.now();
    const asks = Array.from({ length: 6 }, () => made.ask("review.read", { store: "stuck" }));
    const answers = (await Promise.all(asks)) as { ok: boolean; error?: string }[];
    // One ran to its limit and two waited with it: their limits count from
    // the hand-over, so all three end together. The rest had no place.
    const told = answers.map((answer) => answer.error).sort();
    expect(told).toEqual([
      "failed:busy",
      "failed:busy",
      "failed:busy",
      "failed:store_timeout",
      "failed:store_timeout",
      "failed:store_timeout",
    ]);
    // Not one limit after the other: three of them would be nine seconds.
    expect(Date.now() - began).toBeLessThan(7_500);
    expect(((await made.ask("stats.read", { store: "fine" })) as { ok: boolean }).ok).toBe(true);
  }, 30_000);
});

describe("a delete waits for a person of this organization", () => {
  test("the ask only notes it; a person refuses or approves it", async () => {
    const made = await storesRig();
    await made.ask("create", { store: "store-1" });
    fill(made.folderOf("s000001"));
    // The Store's process is open.
    await made.ask("stats.read", { store: "store-1" });

    expect(await made.ask("delete", { store: "store-1" })).toEqual({
      ok: true,
      payload: { store: "store-1", state: "delete_waiting" },
    });
    // Nothing is removed, and the Store still answers.
    expect(existsSync(made.folderOf("s000001"))).toBe(true);
    expect(((await made.ask("stats.read", { store: "store-1" })) as { ok: boolean }).ok).toBe(true);
    const listed = (await made.ask("list")) as { payload: { stores: { state: string }[] } };
    expect(listed.payload.stores.map((store) => store.state)).toEqual(["delete_waiting"]);

    const ctx = made.ctx();
    // Not everybody may decide it.
    await expect(made.module.decideDelete(ctx, RUTH, "store-1", true)).rejects.toThrow("ask failed: not_allowed");
    expect(await made.module.decideDelete(ctx, MARTA, "store-1", false)).toEqual({ state: "kept" });
    expect(((await made.ask("list")) as { payload: { stores: { state: string }[] } }).payload.stores.at(0)?.state).toBe("ready");
    // A delete nobody asked for cannot be approved.
    await expect(made.module.decideDelete(ctx, MARTA, "store-1", true)).rejects.toThrow("ask failed: delete_not_asked");

    await made.ask("delete", { store: "store-1" });
    expect(await made.module.decideDelete(ctx, MARTA, "store-1", true)).toEqual({ state: "deleted" });
    expect(existsSync(made.folderOf("s000001"))).toBe(false);
    expect(await made.ask("list")).toEqual({ ok: true, payload: { stores: [] } });
    expect(await made.ask("stats.read", { store: "store-1" })).toEqual({ ok: false, error: "failed:store_unknown" });

    // The approval is recorded before anything is removed, and the removal after.
    expect(await storesActions(made)).toEqual([
      ["store.create", { target: "store-1" }],
      ["store.delete.asked", { target: "store-1" }],
      ["store.delete.refused", { target: "store-1", by: "marta" }],
      ["store.delete.asked", { target: "store-1" }],
      ["store.delete.approved", { target: "store-1", by: "marta" }],
      ["store.deleted", { target: "store-1", by: "marta" }],
    ]);

    // The same id again is a new, empty Store in a new folder.
    await made.ask("create", { store: "store-1" });
    expect(existsSync(made.folderOf("s000002"))).toBe(true);
    const again = (await made.ask("catalog.read", { store: "store-1", page: 0 })) as { payload: { tables: number } };
    expect(again.payload.tables).toBe(0);
  }, 30_000);

  test("a delete that was cut short is finished when the module next starts", async () => {
    const made = await storesRig();
    await made.ask("create", { store: "store-1" });
    const root = made.folderOf("s000001");
    fill(root);
    await made.ask("delete", { store: "store-1" });
    // The approval was kept, and HX Fortress stopped before anything else.
    const kept = new StoreRegistry(createModuleState(path.dirname(made.listFile())));
    await kept.decide("store-1", true, "marta", new Date("2027-03-14T09:00:00.000Z"));
    expect(existsSync(path.join(root, "store.sqlite"))).toBe(true);
    // Meanwhile the Store is listed as it is, and takes no call.
    const listed = (await made.ask("list")) as { payload: { stores: { state: string }[] } };
    expect(listed.payload.stores.map((store) => store.state)).toEqual(["deleting"]);
    expect(await made.ask("stats.read", { store: "store-1" })).toEqual({ ok: false, error: "failed:store_unknown" });
    expect(await made.ask("create", { store: "store-1" })).toEqual({ ok: false, error: "failed:store_deleting" });
    expect(made.asked).toEqual([]);

    // The next start goes on with it, with no ask and no person.
    await made.another().init?.(made.ctx());
    expect(existsSync(root)).toBe(false);
    expect(await made.ask("list")).toEqual({ ok: true, payload: { stores: [] } });
    expect((await storesActions(made)).at(-1)).toEqual(["store.deleted", { target: "store-1", by: "marta" }]);
  }, 30_000);

  test.skipIf(process.getuid?.() === 0)(
    "where the folder cannot be removed, the Store stays listed as being deleted, and the same decision goes on with it",
    async () => {
      const made = await storesRig();
      await made.ask("create", { store: "store-1" });
      await made.ask("delete", { store: "store-1" });
      const root = made.folderOf("s000001");
      // Nothing can be taken out of the Store's folder.
      chmodSync(root, 0o500);
      try {
        expect(await made.module.decideDelete(made.ctx(), MARTA, "store-1", true)).toEqual({ state: "deleting" });
      } finally {
        chmodSync(root, 0o700);
      }
      expect(existsSync(path.join(root, "store.sqlite"))).toBe(true);
      const listed = (await made.ask("list")) as { payload: { stores: { state: string }[] } };
      expect(listed.payload.stores.map((store) => store.state)).toEqual(["deleting"]);
      // Decided again, by whoever, it is the same delete.
      expect(await made.module.decideDelete(made.ctx(), MARTA, "store-1", false)).toEqual({ state: "deleted" });
      expect(existsSync(root)).toBe(false);
      // An ask's own record is written after every record before it.
      expect(await made.ask("list")).toEqual({ ok: true, payload: { stores: [] } });
      expect((await storesActions(made)).map(([action]) => action)).toEqual([
        "store.create",
        "store.delete.asked",
        "store.delete.approved",
        "store.deleted",
      ]);
    },
    30_000,
  );
});

describe("a delete that is finished by more than one", () => {
  test("decided twice at the same moment, it is carried out and recorded once", async () => {
    const made = await storesRig();
    await made.ask("create", { store: "store-1" });
    await made.ask("delete", { store: "store-1" });
    const ctx = made.ctx();
    expect(
      await Promise.all([
        made.module.decideDelete(ctx, MARTA, "store-1", true),
        made.module.decideDelete(ctx, MARTA, "store-1", true),
      ]),
    ).toEqual([{ state: "deleted" }, { state: "deleted" }]);
    expect(existsSync(made.folderOf("s000001"))).toBe(false);
    // An ask's own record is written after every record before it.
    expect(await made.ask("list")).toEqual({ ok: true, payload: { stores: [] } });
    expect((await storesActions(made)).map(([action]) => action)).toEqual([
      "store.create",
      "store.delete.asked",
      "store.delete.approved",
      "store.deleted",
    ]);
  }, 30_000);

  test("one that comes late leaves a new Store of the same id alone", async () => {
    // The open Stores, with a way to hold the end of one Store's process.
    const removed: string[] = [];
    let hold: { key: string; open: Promise<void> } | null = null;
    const made = await storesRig({
      wrapOpen: (real) => ({
        call: (key, opener, name, args) => real.call(key, opener, name, args),
        watch: (key, root, opener) => real.watch(key, root, opener),
        stop: () => real.stop(),
        async remove(key) {
          removed.push(key);
          if (hold && key.endsWith(hold.key)) await hold.open;
          await real.remove(key);
        },
      }),
    });
    const ctx = made.ctx();
    for (const store of ["store-a", "store-b"]) {
      await made.ask("create", { store });
      await made.ask("delete", { store });
    }
    // Both approvals were kept, and HX Fortress stopped before anything else.
    await made.module.stop?.();
    const kept = new StoreRegistry(createModuleState(path.dirname(made.listFile())));
    for (const store of ["store-a", "store-b"]) {
      await kept.decide(store, true, "marta", new Date("2027-03-14T09:00:00.000Z"));
    }

    // The module starts again and goes on with both, one after the other. The
    // first takes a while.
    let release: () => void = () => undefined;
    hold = { key: "/store-a", open: new Promise<void>((resolve) => (release = resolve)) };
    const starting = Promise.resolve(made.module.init?.(ctx));
    expect(await until(() => removed.length === 1)).toBe(true);
    // Meanwhile a person decides the second again, which carries it out, and
    // the control plane makes a Store of the same id, and opens it.
    expect(await made.module.decideDelete(ctx, MARTA, "store-b", true)).toEqual({ state: "deleted" });
    expect(await made.module.onAsk("create", { store: "store-b" }, ctx)).toEqual({
      store: "store-b",
      state: "ready",
      created: true,
    });
    const root = made.folderOf("s000003");
    await made.module.onAsk("stats.read", { store: "store-b" }, ctx);
    expect(isHeld(root)).toBe(true);

    // The start gets to the second, late. Its delete is done, and the id names
    // another Store now: that one's process is not ended.
    release();
    await starting;
    expect(removed.filter((key) => key.endsWith("/store-b"))).toHaveLength(1);
    expect(isHeld(root)).toBe(true);
    // An ask's own record is written after every record before it.
    expect(await made.ask("list")).toEqual({
      ok: true,
      payload: { stores: [expect.objectContaining({ store: "store-b", state: "ready" })] },
    });
    expect((await storesActions(made)).filter(([action]) => action === "store.deleted")).toEqual([
      ["store.deleted", { target: "store-b", by: "marta" }],
      ["store.deleted", { target: "store-a", by: "marta" }],
    ]);
  }, 30_000);
});

describe("a delete and an ask at the same moment", () => {
  test("a call that was running is stopped with the Store's process, and the folder is gone", async () => {
    const made = await storesRig({ open: { limitMs: 20_000 } });
    await made.ask("create", { store: "store-1" });
    const root = made.folderOf("s000001");
    const storage = new FileStorage({ folder: storeFolder(root) });
    storage.sql.exec("CREATE TABLE endless (n INTEGER)");
    storage.close();
    // A call that does not end by itself.
    const running = made.ask("review.read", { store: "store-1" });
    expect(await until(() => isHeld(root))).toBe(true);
    await made.ask("delete", { store: "store-1" });
    expect(await made.module.decideDelete(made.ctx(), MARTA, "store-1", true)).toEqual({ state: "deleted" });
    expect(await running).toEqual({ ok: false, error: "failed:store_stopped" });
    expect(existsSync(root)).toBe(false);
  }, 30_000);

  test("an ask that was handed to a process still starting, then the delete: the start makes nothing again", async () => {
    const starts = heldStarts();
    const made = await storesRig({ wrapOpen: starts.wrapOpen });
    await made.ask("create", { store: "store-1" });
    await made.ask("delete", { store: "store-1" });
    const root = made.folderOf("s000001");
    // The ask comes first: its call is handed over, and the Store's process
    // is asked for and has not come yet.
    starts.hold();
    const asking = made.ask("stats.read", { store: "store-1" });
    // The module asked for the start, and the test holds it: the module host
    // has not been asked yet.
    expect(await until(() => starts.requested() === 1)).toBe(true);
    expect(made.asked).toEqual([]);
    // Then a person approves the delete. It does not wait for the start.
    expect(await made.module.decideDelete(made.ctx(), MARTA, "store-1", true)).toEqual({ state: "deleted" });
    expect(existsSync(root)).toBe(false);
    expect(await asking).toEqual({ ok: false, error: "failed:store_stopped" });
    // The start goes on, late. The module host looks at the folder now, finds
    // none, starts nothing and makes nothing.
    starts.release();
    expect(await until(async () => (await hostRefusals(made)).length > 0)).toBe(true);
    expect(await hostRefusals(made)).toEqual([{ module: "stores", rule: "folder_missing" }]);
    expect(made.asked).toEqual([]);
    expect(existsSync(root)).toBe(false);
    expect(await made.ask("list")).toEqual({ ok: true, payload: { stores: [] } });
  }, 30_000);

  test("the delete first, then asks: the Store is unknown, and the same id made again gets a folder of its own", async () => {
    const made = await storesRig();
    await made.ask("create", { store: "store-1" });
    await made.ask("delete", { store: "store-1" });
    const root = made.folderOf("s000001");
    const deciding = made.module.decideDelete(made.ctx(), MARTA, "store-1", true);
    const answers = await Promise.all([
      made.ask("stats.read", { store: "store-1" }),
      made.ask("catalog.read", { store: "store-1", page: 0 }),
      made.ask("list"),
    ]);
    expect(await deciding).toEqual({ state: "deleted" });
    expect(answers.at(0)).toEqual({ ok: false, error: "failed:store_unknown" });
    expect(answers.at(1)).toEqual({ ok: false, error: "failed:store_unknown" });
    expect(existsSync(root)).toBe(false);
    expect(await made.ask("create", { store: "store-1" })).toEqual({
      ok: true,
      payload: { store: "store-1", state: "ready", created: true },
    });
    expect(existsSync(root)).toBe(false);
    expect(existsSync(made.folderOf("s000002"))).toBe(true);
  }, 30_000);
});

describe("a new Store never takes a folder that is there", () => {
  test("with the list lost and the folders kept, a new Store gets a folder of its own, and the old file is not touched", async () => {
    const made = await storesRig();
    await made.ask("create", { store: "payroll" });
    const old = made.folderOf("s000001");
    fill(old);
    const size = statSync(path.join(old, "store.sqlite")).size;
    // The list is gone: a person removed a damaged one, or the state was put
    // back from before the Store was made.
    rmSync(made.listFile());
    expect(await made.ask("list")).toEqual({ ok: true, payload: { stores: [] } });

    expect(await made.ask("create", { store: "public-site-stats" })).toEqual({
      ok: true,
      payload: { store: "public-site-stats", state: "ready", created: true },
    });
    // Not the folder that holds the other Store's rows.
    expect(existsSync(made.folderOf("s000002"))).toBe(true);
    expect(statSync(path.join(old, "store.sqlite")).size).toBe(size);
    const catalog = (await made.ask("catalog.read", { store: "public-site-stats", page: 0 })) as {
      payload: { tables: number };
    };
    expect(catalog.payload.tables).toBe(0);
    expect(made.asked.at(-1)?.folder).toBe(path.join(made.folderOf("s000002"), "scratch"));
    holdsNoRow(catalog);
  }, 30_000);

  test.skipIf(process.getuid?.() === 0)(
    "when the list cannot be written, the folder that was made for the new Store is not left behind",
    async () => {
      const made = await storesRig();
      await made.ask("create", { store: "store-1" });
      const stateDir = path.dirname(made.listFile());
      // The list's folder takes no new file, and the folder for the Stores'
      // files is as it was.
      chmodSync(stateDir, 0o500);
      try {
        for (let i = 0; i < 3; i += 1) {
          expect(await made.ask("create", { store: "store-2" })).toEqual({ ok: false, error: "failed:internal" });
        }
      } finally {
        chmodSync(stateDir, 0o700);
      }
      expect(existsSync(made.folderOf("s000002"))).toBe(false);
      expect(existsSync(made.folderOf("s000003"))).toBe(false);
      // The first Store's folder is not touched, and the next one takes the
      // number that was tried.
      expect(existsSync(path.join(made.folderOf("s000001"), "store.sqlite"))).toBe(true);
      expect(await made.ask("create", { store: "store-2" })).toEqual({
        ok: true,
        payload: { store: "store-2", state: "ready", created: true },
      });
      expect(existsSync(path.join(made.folderOf("s000002"), "store.sqlite"))).toBe(true);
    },
    30_000,
  );

  test("a Store whose folder was removed by hand is not opened, and its folder is not made again", async () => {
    const made = await storesRig();
    await made.ask("create", { store: "store-1" });
    const root = made.folderOf("s000001");
    rmSync(root, { recursive: true });
    expect(await made.ask("stats.read", { store: "store-1" })).toEqual({
      ok: false,
      error: "failed:store_folder_missing",
    });
    expect(await made.ask("create", { store: "store-1" })).toEqual({
      ok: true,
      payload: { store: "store-1", state: "ready", created: false },
    });
    const listed = (await made.ask("list")) as { payload: { stores: { bytes: number }[] } };
    expect(listed.payload.stores.map((store) => store.bytes)).toEqual([0]);
    expect(existsSync(root)).toBe(false);
    expect(made.asked).toEqual([]);
  });
});

describe("a Store that was put back from a copy of the disk", () => {
  test("levels of its folder that held nothing and were left out are put back, and the Store opens", async () => {
    const made = await storesRig();
    await made.ask("create", { store: "store-1" });
    const root = made.folderOf("s000001");
    fill(root);
    const folder = storeFolder(root);
    for (const dir of [folder.files, folder.snapshots, folder.scratch]) rmSync(dir, { recursive: true });
    const stats = (await made.ask("stats.read", { store: "store-1" })) as { ok: boolean; payload: { rows: number } };
    expect(stats.ok).toBe(true);
    expect(stats.payload.rows).toBe(3);
    expect(existsSync(folder.scratch)).toBe(true);
    expect(made.asked.at(-1)?.folder).toBe(path.join(made.folderOf("s000001"), "scratch"));
  }, 30_000);

  test("a Store whose file is gone is not opened as an empty one", async () => {
    const made = await storesRig();
    await made.ask("create", { store: "store-1" });
    const root = made.folderOf("s000001");
    fill(root);
    const folder = storeFolder(root);
    rmSync(folder.database);
    rmSync(folder.scratch, { recursive: true });
    expect(await made.ask("stats.read", { store: "store-1" })).toEqual({
      ok: false,
      error: "failed:store_folder_missing",
    });
    // Nothing was made in its place, and no process was started.
    expect(existsSync(folder.database)).toBe(false);
    expect(existsSync(folder.scratch)).toBe(false);
    expect(made.asked).toEqual([]);
  }, 30_000);
});

describe("a module that is switched off and on again", () => {
  test("opens its Stores again, and reads their alarms again", async () => {
    const made = await storesRig();
    await made.ask("create", { store: "store-1" });
    const root = made.folderOf("s000001");
    fill(root);
    expect(((await made.ask("stats.read", { store: "store-1" })) as { ok: boolean }).ok).toBe(true);

    // Somebody on this host switches the module off. Its processes end.
    await writeConfig(made.rig.paths, ["session_vault", "probe"]);
    await made.rig.host.follow();
    expect(await made.ask("list")).toEqual({ ok: false, error: "module_off" });
    expect(isHeld(root)).toBe(false);
    // While the module is off, the Store's alarm comes due, and nothing wakes it.
    writeAlarm(storeFolder(root), Date.now() - 1_000);
    await Bun.sleep(200);
    expect(readAlarm(storeFolder(root))).not.toBeNull();

    // On again: the same module object is started a second time.
    await writeConfig(made.rig.paths, ["session_vault", "probe", "stores"]);
    await made.rig.host.follow();
    // The alarm is read again and the Store is woken, with no ask.
    expect(await until(() => readAlarm(storeFolder(root)) === null)).toBe(true);
    const stats = (await made.ask("stats.read", { store: "store-1" })) as { ok: boolean; payload: { rows: number } };
    expect(stats.ok).toBe(true);
    expect(stats.payload.rows).toBe(3);
  }, 30_000);

  test("a delete that a person approves while the module stops waits until no process of it runs", async () => {
    const made = await storesRig({ open: { limitMs: 20_000, stopWithinMs: 1_000 } });
    await made.ask("create", { store: "store-1" });
    const root = made.folderOf("s000001");
    const storage = new FileStorage({ folder: storeFolder(root) });
    storage.sql.exec("CREATE TABLE endless (n INTEGER)");
    storage.close();
    await made.ask("delete", { store: "store-1" });
    // A call that does not end by itself holds the Store's process.
    const running = made.ask("review.read", { store: "store-1" });
    expect(await until(() => isHeld(root))).toBe(true);
    // The module is stopped. The call that runs is given a moment to end.
    let stopped = false;
    const stopping = Promise.resolve(made.module.stop?.()).then(() => (stopped = true));
    // In that moment a person approves the delete. The folder is not removed
    // under a process that still holds its file: the delete waits for the stop.
    expect(await made.module.decideDelete(made.ctx(), MARTA, "store-1", true)).toEqual({ state: "deleted" });
    expect(stopped).toBe(true);
    expect(existsSync(root)).toBe(false);
    await stopping;
    expect(await running).toEqual({ ok: false, error: "failed:store_stopped" });
    const kept = new StoreRegistry(createModuleState(path.dirname(made.listFile())));
    expect(await kept.list()).toEqual([]);
  }, 30_000);

  test("an ask that reaches the module after its stop opens nothing", async () => {
    const made = await storesRig();
    await made.ask("create", { store: "store-1" });
    const root = made.folderOf("s000001");
    writeAlarm(storeFolder(root), Date.now() + 300);
    const ctx = made.ctx();
    // Let in before the stop, and running after it: the gate checked that the
    // module runs, and then waited for the disk.
    const late = made.module.onAsk("stats.read", { store: "store-1" }, ctx);
    const stopping = made.module.stop?.();
    await expect(late).rejects.toThrow("ask failed: stores_stopping");
    await stopping;
    // And one that only arrives afterwards.
    await expect(made.module.onAsk("stats.read", { store: "store-1" }, ctx)).rejects.toThrow(
      "ask failed: stores_stopping",
    );
    // No process was started, and the alarm that came due meanwhile woke nothing.
    await Bun.sleep(500);
    expect(made.asked).toEqual([]);
    expect(isHeld(root)).toBe(false);
    expect(readAlarm(storeFolder(root))).not.toBeNull();
  }, 30_000);
});

describe("each organization's Stores are its own", () => {
  test("the same id in two organizations is two Stores, in two folders, and neither sees the other's", async () => {
    const made = await storesRig();
    await writeOrganizations(made.rig.paths, [{ id: ALDER, modules: ["stores"], keys: {} }]);

    await made.ask("create", { store: "permits" });
    await made.ask("create", { store: "permits" }, ALDER);
    await made.ask("create", { store: "only-alder" }, ALDER);
    const own = made.folderOf("s000001");
    const other = made.folderIn(ALDER, "s000001");
    expect(existsSync(own)).toBe(true);
    expect(existsSync(other)).toBe(true);
    fill(own);

    const ownCatalog = (await made.ask("catalog.read", { store: "permits", page: 0 })) as { payload: { tables: number } };
    const otherCatalog = (await made.ask("catalog.read", { store: "permits", page: 0 }, ALDER)) as { payload: { tables: number } };
    expect(ownCatalog.payload.tables).toBe(2);
    expect(otherCatalog.payload.tables).toBe(0);

    const ids = async (org?: string): Promise<string[]> =>
      ((await made.ask("list", {}, org)) as { payload: { stores: { store: string }[] } }).payload.stores.map((store) => store.store);
    expect(await ids()).toEqual(["permits"]);
    expect(await ids(ALDER)).toEqual(["permits", "only-alder"]);
    expect(await made.ask("stats.read", { store: "only-alder" })).toEqual({ ok: false, error: "failed:store_unknown" });
    expect(await made.ask("stats.read", { store: "only-alder" }, ORG)).toEqual({ ok: false, error: "failed:store_unknown" });
  }, 30_000);

  test("the Store of an organization that left this HX Fortress is not woken, and nothing is made for it", async () => {
    const made = await storesRig();
    await writeOrganizations(made.rig.paths, [{ id: ALDER, modules: ["stores"], keys: {} }]);
    await made.ask("create", { store: "permits" }, ALDER);
    await made.ask("create", { store: "owners" }, ALDER);
    const open = made.folderIn(ALDER, "s000001");
    const closed = made.folderIn(ALDER, "s000002");
    // Both ask to be woken shortly. One has a process, the other has none.
    const at = Date.now() + 1_200;
    writeAlarm(storeFolder(open), at);
    await made.ask("stats.read", { store: "permits" }, ALDER);
    expect(isHeld(open)).toBe(true);
    writeAlarm(storeFolder(closed), at);
    const again = made.another();
    await again.init?.(made.ctx());

    // The organization is taken off the list, and a person removes the folder
    // of the Store that has no process.
    await writeOrganizations(made.rig.paths, []);
    rmSync(closed, { recursive: true });
    const starts = made.asked.length;

    await Bun.sleep(Math.max(0, at - Date.now()) + 800);
    // No wake: the alarm of the open one is still on the disk, its process
    // was ended, and nothing was started or made for either.
    expect(readAlarm(storeFolder(open))).toBe(at);
    expect(isHeld(open)).toBe(false);
    expect(made.asked.length).toBe(starts);
    expect(existsSync(closed)).toBe(false);
  }, 30_000);
});

describe("how many Stores are open at once", () => {
  test("past the bound, the Store used longest ago is closed, and opened again when it is asked for", async () => {
    const made = await storesRig({ maxOpen: 2 });
    for (const id of ["a", "b", "c"]) {
      await made.ask("create", { store: id });
      expect(((await made.ask("stats.read", { store: id })) as { ok: boolean }).ok).toBe(true);
    }
    // The first one was closed for the third: nothing holds its file.
    expect(await until(() => !isHeld(made.folderOf("s000001")))).toBe(true);
    expect(isHeld(made.folderOf("s000003"))).toBe(true);
    // All three still answer: one that was closed is started again.
    for (const id of ["a", "b", "c", "a"]) {
      expect(((await made.ask("stats.read", { store: id })) as { ok: boolean }).ok).toBe(true);
    }
    expect(made.asked.length).toBeGreaterThan(3);
  }, 30_000);
});

describe("a Store's alarm, with no ask running", () => {
  test("an alarm that comes due while the module is still starting is woken once the start has ended", async () => {
    let started: () => void = () => undefined;
    const starting = { ends: Promise.resolve() };
    // A wake that fails is tried again after 10 ms, then 20, and is given up
    // well inside a second.
    const made = await storesRig({ open: { alarmRetryBaseMs: 10 }, afterInit: () => starting.ends });
    await made.ask("create", { store: "store-1" });
    const folder = storeFolder(made.folderOf("s000001"));
    // Somebody switches the module off, and the Store's alarm comes due.
    await writeConfig(made.rig.paths, ["session_vault", "probe"]);
    await made.rig.host.follow();
    writeAlarm(folder, Date.now() - 1_000);

    // On again, and the module's own start takes a while. The alarm is read
    // and is due at once. The module host starts no process for a module whose
    // start has not ended, and records that by its own rule.
    starting.ends = new Promise<void>((resolve) => (started = resolve));
    await writeConfig(made.rig.paths, ["session_vault", "probe", "stores"]);
    const following = made.rig.host.follow();
    const refused = async (): Promise<boolean> =>
      (await hostRefusals(made)).some((refusal) => (refusal as { rule?: unknown } | null)?.rule === "module_not_running");
    expect(await until(refused)).toBe(true);
    // Longer than a wake that fails is tried for: each try here is a wait,
    // and none counts against the alarm.
    await Bun.sleep(900);
    expect(made.asked).toEqual([]);
    expect(readAlarm(folder)).not.toBeNull();

    // The start ends, and the next try wakes the Store.
    started();
    await following;
    expect(await until(() => readAlarm(folder) === null)).toBe(true);
    expect(made.asked).toEqual([{ verb: "store-engine", folder: folder.scratch }]);
    expect(made.rig.logs.filter((record) => record.msg.includes("could not be woken"))).toEqual([]);
  }, 30_000);

  test("alarms that are due when the module starts ask the module host for no process before the module runs", async () => {
    const made = await storesRig();
    const others = [ALDER, "org-birch", "org-cedar"];
    await writeOrganizations(
      made.rig.paths,
      others.map((id) => ({ id, modules: ["stores"], keys: {} })),
    );
    await made.ask("create", { store: "permits" });
    for (const org of others) await made.ask("create", { store: "permits" }, org);
    const folders = [made.folderOf("s000001"), ...others.map((org) => made.folderIn(org, "s000001"))].map((root) =>
      storeFolder(root),
    );
    // Somebody switches the module off, and every Store's alarm comes due.
    await writeConfig(made.rig.paths, ["session_vault", "probe"]);
    await made.rig.host.follow();
    for (const folder of folders) writeAlarm(folder, Date.now() - 1_000);

    // On again, with nothing slow about it. The module looks over four
    // organizations, and each has a Store that is due.
    await writeConfig(made.rig.paths, ["session_vault", "probe", "stores"]);
    await made.rig.host.follow();
    expect(await until(() => folders.every((folder) => readAlarm(folder) === null))).toBe(true);
    // Each was woken by a process of its own, and the module host refused
    // the module nothing on the way: no alarm asked for a process while the
    // module was still starting.
    expect(made.asked.map((start) => start.folder).sort()).toEqual(folders.map((folder) => folder.scratch).sort());
    expect(await hostRefusals(made)).toEqual([]);
  }, 30_000);

  test("a Store whose alarm is due is woken when the module starts, in its own organization's folder", async () => {
    // A wake that fails is tried again after 5 ms, then 10, and is given up
    // well inside a second.
    const made = await storesRig({ open: { alarmRetryBaseMs: 5 } });
    await writeOrganizations(made.rig.paths, [{ id: ALDER, modules: ["stores"], keys: {} }]);
    await made.ask("create", { store: "permits" });
    await made.ask("create", { store: "permits" }, ALDER);
    const own = storeFolder(made.folderOf("s000001"));
    const other = storeFolder(made.folderIn(ALDER, "s000001"));
    // Each Store asked to be woken a moment ago, and HX Fortress stopped
    // before it was.
    writeAlarm(own, Date.now() - 1_000);
    writeAlarm(other, Date.now() - 1_000);

    // While the module host can start no process, no Store is woken. Each
    // wake is tried as often as a failed wake is, and then the module says so
    // in the log, once for each Store, with the host's own word. Every try
    // has ended by then: none is still on its way.
    made.startAs(null);
    const quiet = made.another();
    await quiet.init?.(made.ctx());
    const givenUp = (): { fields?: unknown }[] => made.rig.logs.filter((record) => record.msg.includes("could not be woken"));
    expect(await until(() => givenUp().length === 2)).toBe(true);
    expect(givenUp().map((record) => (record.fields as { why?: unknown }).why)).toEqual([
      "process_start_failed",
      "process_start_failed",
    ]);
    expect(made.asked).toEqual([]);
    // What is not lost is each alarm's time: it stays on the disk, for the
    // module's next start.
    expect(readAlarm(own)).not.toBeNull();
    expect(readAlarm(other)).not.toBeNull();
    await quiet.stop?.();

    // The module as it is after HX Fortress starts again. Nothing asks it
    // anything: the alarms alone start each Store's process.
    made.startAs(FAKE_ENGINE);
    await made.another().init?.(made.ctx());
    // A wake with nothing to do spends the alarm: its time leaves the disk.
    expect(await until(() => readAlarm(own) === null && readAlarm(other) === null)).toBe(true);
    // Each in the folder of its own organization.
    expect(made.asked.map((start) => start.folder).sort()).toEqual([own.scratch, other.scratch].sort());
    expect(made.asked.map((start) => start.verb)).toEqual(["store-engine", "store-engine"]);
  }, 30_000);
});
