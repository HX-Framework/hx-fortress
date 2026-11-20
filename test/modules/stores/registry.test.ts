import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createModuleState } from "../../../src/host/module-context";
import { AskFailure } from "../../../src/host/module-contract";
import { STORES_MAX } from "../../../src/modules/stores/manifest";
import {
  recordedLogin,
  StoreRegistry,
  storeState,
  Turns,
  type MadeFolder,
} from "../../../src/modules/stores/registry";
import { cleanFolders, tempFolder } from "./_rig";

afterEach(cleanFolders);

const NOW = new Date("2026-03-02T09:14:00.000Z");

interface Made {
  stores: StoreRegistry;
  dir: string;
  /** The folders that are there, as a test says. A new Store's folder is made
   *  only when it is not among them. */
  folders: Set<string>;
  /** Make a folder, as the module does: new, or not at all. */
  make(folder: string): MadeFolder;
  /** Why a list could not be used, each time. */
  unreadable: unknown[];
}

function registry(dir = tempFolder("state")): Made {
  const folders = new Set<string>();
  const unreadable: unknown[] = [];
  return {
    stores: new StoreRegistry(createModuleState(dir), (thrown) => void unreadable.push(thrown ?? "not a list")),
    dir,
    folders,
    make(folder) {
      if (folders.has(folder)) return false;
      folders.add(folder);
      return { remove: () => void folders.delete(folder) };
    },
    unreadable,
  };
}

async function code(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (thrown) {
    if (thrown instanceof AskFailure) return thrown.code;
    throw thrown;
  }
  throw new Error("nothing was thrown");
}

describe("the Stores of one organization", () => {
  test("a new Store gets a folder name of the module's own, never its id", async () => {
    const { stores, make } = registry();
    const first = await stores.create("store_01-A", "Permits", NOW, make);
    expect(first).toEqual({
      created: true,
      record: { id: "store_01-A", folder: "s000001", name: "Permits", createdAt: "2026-03-02T09:14:00.000Z" },
    });
    const second = await stores.create("another", undefined, NOW, make);
    expect(second.record.folder).toBe("s000002");
    expect((await stores.list()).map((store) => store.id)).toEqual(["store_01-A", "another"]);
  });

  test("asking again for an id that is there answers what is there, and makes no folder", async () => {
    const { stores, make, folders } = registry();
    const { record } = await stores.create("store-1", "Permits", NOW, make);
    const again = await stores.create("store-1", "Another name", new Date("2027-01-01T00:00:00.000Z"), () => {
      throw new Error("no folder is made for a Store that is there");
    });
    expect(again).toEqual({ created: false, record });
    expect([...folders]).toEqual(["s000001"]);
  });

  test("a number is never used twice, also for an id that is made again", async () => {
    const { stores, make } = registry();
    await stores.create("store-1", undefined, NOW, make);
    await stores.askDelete("store-1", NOW);
    await stores.decide("store-1", true, "marta", NOW);
    expect(await stores.forget("store-1", "s000001")).toBe(true);
    const again = await stores.create("store-1", undefined, NOW, make);
    expect(again.record.folder).toBe("s000002");
  });

  test("a folder that is there is passed over: a new Store never takes it", async () => {
    const { stores, make, folders } = registry();
    // The list is empty, and three folders are on the disk: the list was lost.
    for (const folder of ["s000001", "s000002", "s000003"]) folders.add(folder);
    const made = await stores.create("store-1", undefined, NOW, make);
    expect(made.record.folder).toBe("s000004");
    // The next one counts on from there.
    expect((await stores.create("store-2", undefined, NOW, make)).record.folder).toBe("s000005");
  });

  test("when no folder can be made, the Store is not made and the list is as it was", async () => {
    const { stores, make } = registry();
    await stores.create("store-1", undefined, NOW, make);
    expect(await code(stores.create("store-2", undefined, NOW, () => false))).toBe("store_folders_taken");
    expect((await stores.list()).map((store) => store.id)).toEqual(["store-1"]);
    // What the disk throws is the caller's to see, and nothing is listed.
    await expect(
      stores.create("store-2", undefined, NOW, () => {
        throw new Error("the disk is full");
      }),
    ).rejects.toThrow("the disk is full");
    expect((await stores.list()).map((store) => store.id)).toEqual(["store-1"]);
  });

  test("when the list cannot be written, the folder that was made is removed again, and no number is used up", async () => {
    const dir = tempFolder("state");
    const state = createModuleState(dir);
    // A state that cannot be written for a while: its folder's owner or mode
    // is wrong after a restore, and the folder for the Stores' files is fine.
    let writable = false;
    const stores = new StoreRegistry({
      read: (key) => state.read(key),
      remove: (key) => state.remove(key),
      write: (key, value) => (writable ? state.write(key, value) : Promise.reject(new Error("read-only"))),
    });
    const { make, folders } = registry();
    // More tries than there are numbers to try for one Store.
    for (let i = 0; i < 1_005; i += 1) {
      await expect(stores.create("store-1", undefined, NOW, make)).rejects.toThrow("read-only");
    }
    expect([...folders]).toEqual([]);
    // Once the list can be written, the Store is made, in the first folder.
    writable = true;
    expect((await stores.create("store-1", undefined, NOW, make)).record.folder).toBe("s000001");
    expect([...folders]).toEqual(["s000001"]);
  });

  test("a folder that cannot be removed again stays, and the next Store passes over it", async () => {
    const dir = tempFolder("state");
    const state = createModuleState(dir);
    let writable = false;
    const stores = new StoreRegistry({
      read: (key) => state.read(key),
      remove: (key) => state.remove(key),
      write: (key, value) => (writable ? state.write(key, value) : Promise.reject(new Error("read-only"))),
    });
    const folders = new Set<string>();
    const stuck = (folder: string): MadeFolder => {
      if (folders.has(folder)) return false;
      folders.add(folder);
      return {
        remove: () => {
          throw new Error("it cannot be removed either");
        },
      };
    };
    // What the caller sees is why the list could not be written.
    await expect(stores.create("store-1", undefined, NOW, stuck)).rejects.toThrow("read-only");
    expect([...folders]).toEqual(["s000001"]);
    writable = true;
    expect((await stores.create("store-1", undefined, NOW, stuck)).record.folder).toBe("s000002");
  });

  test("an id the Store's program would not take, and a name that is none, are refused", async () => {
    const { stores, make, folders } = registry();
    for (const id of ["", "a b", "store.01", "a:b", "a/b", "..", "ü", "x".repeat(129)]) {
      expect(await code(stores.create(id, undefined, NOW, make))).toBe("store_id_invalid");
    }
    for (const name of ["", "x".repeat(65), "Permits\n2026", "Permits <b>"]) {
      expect(await code(stores.create("store-1", name, NOW, make))).toBe("store_name_invalid");
    }
    expect(folders.size).toBe(0);
    expect(await stores.list()).toEqual([]);
  });

  test("an organization keeps a bounded number of Stores", async () => {
    const { stores, make } = registry();
    for (let i = 0; i < STORES_MAX; i += 1) await stores.create(`store-${i}`, undefined, NOW, make);
    expect(await code(stores.create("one-more", undefined, NOW, make))).toBe("stores_full");
    // An id that is there is still answered.
    expect((await stores.create("store-0", undefined, NOW, make)).created).toBe(false);
  });

  test("a Store that is not there", async () => {
    const { stores } = registry();
    expect(await code(stores.need("nowhere"))).toBe("store_unknown");
    expect(await code(stores.askDelete("nowhere", NOW))).toBe("store_unknown");
    expect(await code(stores.decide("nowhere", true, "marta", NOW))).toBe("store_unknown");
    expect(await stores.forget("nowhere", "s000001")).toBe(false);
  });

  test("the list is kept on the disk, and read by another reader", async () => {
    const { stores, dir, make } = registry();
    await stores.create("store-1", "Permits", NOW, make);
    const other = registry(dir).stores;
    expect((await other.need("store-1")).name).toBe("Permits");
  });
});

describe("a delete, step by step", () => {
  test("asked for, it waits. Asking again keeps the first time", async () => {
    const { stores, make } = registry();
    const { record } = await stores.create("store-1", undefined, NOW, make);
    expect(storeState(record)).toBe("ready");
    const asked = await stores.askDelete("store-1", new Date("2026-03-03T00:00:00.000Z"));
    expect(asked.first).toBe(true);
    expect(storeState(asked.record)).toBe("delete_waiting");
    const again = await stores.askDelete("store-1", new Date("2026-03-04T00:00:00.000Z"));
    expect(again.first).toBe(false);
    expect(again.record.deleteAskedAt).toBe("2026-03-03T00:00:00.000Z");
    // It takes calls meanwhile.
    expect((await stores.need("store-1")).id).toBe("store-1");
  });

  test("refused, the Store is as it was. A delete nobody asked for cannot be decided", async () => {
    const { stores, make } = registry();
    const { record } = await stores.create("store-1", undefined, NOW, make);
    expect(await code(stores.decide("store-1", true, "marta", NOW))).toBe("delete_not_asked");
    expect(await code(stores.decide("store-1", false, "marta", NOW))).toBe("delete_not_asked");
    await stores.askDelete("store-1", NOW);
    const kept = await stores.decide("store-1", false, "marta", NOW);
    expect(kept).toEqual({ record, outcome: "kept", first: true });
    expect(await stores.list()).toEqual([record]);
  });

  test("approved, the record says who and when, the Store takes no call, and it stays listed until its folder is gone", async () => {
    const { stores, make, dir } = registry();
    await stores.create("store-1", undefined, NOW, make);
    await stores.askDelete("store-1", NOW);
    const at = new Date("2026-03-05T10:00:00.000Z");
    const decided = await stores.decide("store-1", true, "marta@northstar.example", at);
    expect(decided.outcome).toBe("deleting");
    expect(decided.first).toBe(true);
    expect(decided.record.deleting).toEqual({ by: "marta@northstar.example", at: "2026-03-05T10:00:00.000Z" });
    expect(storeState(decided.record)).toBe("deleting");
    expect(await code(stores.need("store-1"))).toBe("store_unknown");
    expect(await code(stores.create("store-1", undefined, NOW, make))).toBe("store_deleting");
    // Another reader, as after a restart, finds the delete that is to finish.
    expect((await registry(dir).stores.deleting()).map((store) => store.folder)).toEqual(["s000001"]);
    // Decided again, whichever way, it is the same delete, and not a new one.
    const again = await stores.decide("store-1", false, "ruth", new Date("2026-03-06T00:00:00.000Z"));
    expect(again).toEqual({ record: decided.record, outcome: "deleting", first: false });
    expect((await stores.askDelete("store-1", NOW)).first).toBe(false);
  });

  test("only a Store that is being deleted, in that folder, is taken off the list", async () => {
    const { stores, make } = registry();
    await stores.create("store-1", undefined, NOW, make);
    await stores.create("store-2", undefined, NOW, make);
    // Not asked, not approved: it stays.
    expect(await stores.forget("store-1", "s000001")).toBe(false);
    await stores.askDelete("store-1", NOW);
    expect(await stores.forget("store-1", "s000001")).toBe(false);
    await stores.decide("store-1", true, "marta", NOW);
    // Not under another folder's name.
    expect(await stores.forget("store-1", "s000002")).toBe(false);
    expect(await stores.forget("store-1", "s000001")).toBe(true);
    expect((await stores.list()).map((store) => store.id)).toEqual(["store-2"]);
    expect(await stores.deleting()).toEqual([]);
  });

  test("a login that is no name is kept as one fixed word, never cut", async () => {
    const { stores, make } = registry();
    await stores.create("store-1", undefined, NOW, make);
    await stores.askDelete("store-1", NOW);
    const decided = await stores.decide("store-1", true, "marta\n<script>", NOW);
    expect(decided.record.deleting?.by).toBe("unknown");
    expect(recordedLogin("x".repeat(129))).toBe("unknown");
    expect(recordedLogin("")).toBe("unknown");
    expect(recordedLogin("marta")).toBe("marta");
  });
});

describe("a list that cannot be used", () => {
  test("stops every change, is never written over, and says why", async () => {
    const { stores, dir, make, unreadable } = registry();
    await stores.create("store-1", undefined, NOW, make);
    const file = path.join(dir, "stores.json");
    const good = { id: "a", folder: "s000001", createdAt: "2026-03-02T09:14:00.000Z" };
    const damaged = [
      "{ not json",
      JSON.stringify({ value: { version: 2, next: 2, stores: [] } }),
      JSON.stringify({ value: { version: 1, next: 0, stores: [] } }),
      JSON.stringify({ value: { version: 1, next: 2, stores: [{ ...good, folder: "../../etc" }] } }),
      JSON.stringify({ value: { version: 1, next: 3, stores: [good, { ...good, id: "b" }] } }),
      JSON.stringify({ value: { version: 1, next: 3, stores: [good, { ...good, folder: "s000002" }] } }),
      // A time that is no instant, a name that is none, an id the Store's
      // program would not take, a delete with nobody behind it.
      JSON.stringify({ value: { version: 1, next: 2, stores: [{ ...good, createdAt: "yesterday" }] } }),
      JSON.stringify({ value: { version: 1, next: 2, stores: [{ ...good, deleteAskedAt: "soon" }] } }),
      JSON.stringify({ value: { version: 1, next: 2, stores: [{ ...good, name: "" }] } }),
      JSON.stringify({ value: { version: 1, next: 2, stores: [{ ...good, id: "a.b" }] } }),
      JSON.stringify({ value: { version: 1, next: 2, stores: [{ ...good, deleting: { by: "", at: good.createdAt } }] } }),
      JSON.stringify({ value: { version: 1, next: 2, stores: [{ ...good, deleting: { by: "marta", at: "then" } }] } }),
      JSON.stringify({ value: "stores" }),
    ];
    for (const text of damaged) {
      writeFileSync(file, text);
      expect(await code(stores.list())).toBe("stores_unreadable");
      expect(await code(stores.need("store-1"))).toBe("stores_unreadable");
      expect(await code(stores.create("store-2", undefined, NOW, make))).toBe("stores_unreadable");
      expect(await code(stores.askDelete("store-1", NOW))).toBe("stores_unreadable");
      expect(await code(stores.decide("store-1", true, "marta", NOW))).toBe("stores_unreadable");
      expect(await code(stores.deleting())).toBe("stores_unreadable");
      expect(await code(stores.forget("store-1", "s000001"))).toBe("stores_unreadable");
      expect(readFileSync(file, "utf8")).toBe(text);
    }
    // Told each time: seven looks at each damaged list.
    expect(unreadable).toHaveLength(damaged.length * 7);
  });
});

describe("one thing at a time for each key", () => {
  test("two changes for one organization run one after the other, and another organization does not wait", async () => {
    const turns = new Turns();
    const order: string[] = [];
    const slow = turns.run("northstar", async () => {
      order.push("first begins");
      await Bun.sleep(40);
      order.push("first ends");
    });
    const next = turns.run("northstar", async () => void order.push("second"));
    const other = turns.run("alder", async () => void order.push("another organization"));
    await Promise.all([slow, next, other]);
    expect(order).toEqual(["first begins", "another organization", "first ends", "second"]);
  });

  test("a change that fails does not stop the next, and its failure is the caller's", async () => {
    const turns = new Turns();
    const failed = turns.run("northstar", async () => {
      throw new Error("no");
    });
    const next = turns.run("northstar", async () => "done");
    await expect(failed).rejects.toThrow("no");
    expect(await next).toBe("done");
  });

  test("changes made at once through it lose nothing", async () => {
    const { stores, make } = registry();
    const turns = new Turns();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        turns.run("northstar", () => stores.create(`store-${i}`, undefined, NOW, make)),
      ),
    );
    const list = await stores.list();
    expect(list).toHaveLength(25);
    expect(new Set(list.map((store) => store.folder)).size).toBe(25);
  });
});
