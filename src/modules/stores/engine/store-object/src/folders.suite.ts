// A store's folders (folders.ts): every file is in exactly one; an upload goes into the folder it
// names, else its token's, else Uploads; a folder that holds files goes only with a place for them;
// a token held to a folder reaches nothing outside it; and folders cross a restore as they are now.

import { describe, it, host, stateOf, filesOf, itRestores } from "../testing/suite/host.js";
import { countingHex, FakeClock } from "../testing/suite/stand-ins.js";
import assert from "node:assert/strict";

import type { StoreDeps } from "./core.js";
import { StoreHandler } from "./handler.js";
import type { StoreCaller, StoredFolder, StoreResult } from "./types.js";

const A = "sto_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ME: StoreCaller = { storeId: A, actor: "user:u-1" };

function setup() {
  const clock = new FakeClock();
  const storage = host().storage();
  storage.now = clock.now;
  const state = stateOf(storage);
  const r2 = filesOf();
  const deps: StoreDeps = { now: clock.now, randomHex: countingHex, jobs: new Map() };
  const make = () => new StoreHandler(state as never, { FILES: r2.asBucket() }, deps);
  return { clock, storage, state, r2, store: make(), make };
}

function value<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
}

function refusal<T>(result: StoreResult<T>): { status: number; code: string; error: string } {
  assert.equal(result.ok, false, "expected a refusal");
  return result as { status: number; code: string; error: string };
}

/** Uploads a whole small file through `caller`, into `folderId` when named. */
async function upload(store: StoreHandler, r2: ReturnType<typeof filesOf>, caller: StoreCaller, name: string, folderId?: string): Promise<{ id: string; folderId: string }> {
  const created = value(await store.fileCreate(caller, { name, size: 3, ...(folderId ? { folderId } : {}) }));
  const target = value(await store.filePartTarget(caller, created.file.id, 1));
  const part = await r2.resumeMultipartUpload(target.key, target.uploadId).uploadPart(1, "abc");
  const done = value(await store.fileComplete(caller, created.file.id, { parts: [{ n: 1, etag: part.etag }] }));
  return { id: done.file.id, folderId: done.file.folderId };
}

const named = (folders: StoredFolder[], name: string): StoredFolder => {
  const found = folders.find((f) => f.name === name);
  assert.ok(found, `a folder named ${name}`);
  return found;
};

describe("every file is in a folder", () => {
  it("puts an upload that names no folder into Uploads, made once, and one that names a folder there", async () => {
    const { store, r2 } = setup();
    const first = await upload(store, r2, ME, "a.csv");
    const second = await upload(store, r2, ME, "b.csv");
    const folders = value(await store.folders(ME)).folders;
    assert.deepEqual(
      folders.map((f) => [f.name, f.ref, f.parentId, f.files, f.bytes]),
      [["Uploads", "uploads", null, 2, 6]],
    );
    assert.equal(first.folderId, folders[0]!.id);
    assert.equal(second.folderId, folders[0]!.id);
    const reports = value(await store.folderCreate(ME, { name: "Reports" })).folder;
    const third = await upload(store, r2, ME, "c.csv", reports.id);
    assert.equal(third.folderId, reports.id);
    assert.deepEqual(
      value(await store.files(ME))
        .files.map((f) => [f.name, f.folderId])
        .sort(),
      [
        ["a.csv", folders[0]!.id],
        ["b.csv", folders[0]!.id],
        ["c.csv", reports.id],
      ],
    );
    assert.equal(refusal(await store.fileCreate(ME, { name: "d.csv", size: 1, folderId: "fld_000000000000000000000999" })).code, "folder_not_found");
    assert.equal(refusal(await store.fileCreate(ME, { name: "d.csv", size: 1, folderId: "Reports" })).code, "bad_request");
  });

  it("puts a file kept from before folders into Uploads at the next start, and says so once", async () => {
    const { store, r2, make } = setup();
    const old = await upload(store, r2, ME, "old.csv");
    // A store from before folders: no folder on the file, and no folder at all.
    store.core.sql.exec("UPDATE _files SET folder_id = NULL");
    store.core.sql.exec("DELETE FROM _folders");
    const after = make();
    const files = value(await after.files(ME)).files;
    const uploads = named(value(await after.folders(ME)).folders, "Uploads");
    assert.deepEqual(files.map((f) => [f.id, f.folderId]), [[old.id, uploads.id]]);
    const notes = value(await after.history(ME)).events.filter((e) => e.note.startsWith("Put "));
    assert.deepEqual(notes.map((e) => [e.note, e.by]), [["Put 1 file that was in no folder into Uploads", "store:folders"]]);
    // The next start finds nothing to file and says nothing.
    const again = make();
    value(await again.files(ME));
    assert.equal(value(await again.history(ME)).events.filter((e) => e.note.startsWith("Put ")).length, 1);
  });

  it("makes Uploads again for the next upload that names no folder after a person deleted it", async () => {
    const { store, r2 } = setup();
    const first = await upload(store, r2, ME, "a.csv");
    const keep = value(await store.folderCreate(ME, { name: "Keep" })).folder;
    value(await store.folderDelete(ME, first.folderId, { into: keep.id }));
    const next = await upload(store, r2, ME, "b.csv");
    const folders = value(await store.folders(ME)).folders;
    assert.deepEqual(folders.map((f) => f.name).sort(), ["Keep", "Uploads"]);
    assert.equal(next.folderId, named(folders, "Uploads").id);
    assert.notEqual(next.folderId, first.folderId);
  });
});

describe("folders", () => {
  it("makes folders four levels deep, with names that differ beside each other in more than case", async () => {
    const { store } = setup();
    const one = value(await store.folderCreate(ME, { name: "  2026   permits " })).folder;
    assert.equal(one.name, "2026 permits");
    assert.equal(refusal(await store.folderCreate(ME, { name: "2026 PERMITS" })).code, "folder_name_taken");
    const two = value(await store.folderCreate(ME, { name: "May", parentId: one.id })).folder;
    const three = value(await store.folderCreate(ME, { name: "Week 1", parentId: two.id })).folder;
    const four = value(await store.folderCreate(ME, { name: "Monday", parentId: three.id })).folder;
    assert.equal(four.parentId, three.id);
    assert.equal(refusal(await store.folderCreate(ME, { name: "Too deep", parentId: four.id })).code, "folder_place");
    // The same name in another place is fine.
    value(await store.folderCreate(ME, { name: "May" }));
    assert.equal(refusal(await store.folderCreate(ME, { name: "" })).code, "bad_request");
    assert.equal(refusal(await store.folderCreate(ME, { name: "x".repeat(121) })).code, "bad_request");
    assert.equal(refusal(await store.folderCreate(ME, { name: "A", parentId: "fld_000000000000000000000999" })).code, "folder_not_found");
  });

  it("renames and moves a folder, never into itself, a folder inside it, or too deep", async () => {
    const { store } = setup();
    const top = value(await store.folderCreate(ME, { name: "Top" })).folder;
    const inner = value(await store.folderCreate(ME, { name: "Inner", parentId: top.id })).folder;
    const other = value(await store.folderCreate(ME, { name: "Other" })).folder;
    assert.equal(value(await store.folderUpdate(ME, inner.id, { name: "Renamed" })).folder.name, "Renamed");
    assert.equal(refusal(await store.folderUpdate(ME, top.id, { parentId: inner.id })).code, "folder_place");
    assert.equal(refusal(await store.folderUpdate(ME, top.id, { parentId: top.id })).code, "folder_place");
    const moved = value(await store.folderUpdate(ME, inner.id, { parentId: other.id })).folder;
    assert.equal(moved.parentId, other.id);
    value(await store.folderUpdate(ME, inner.id, { parentId: null }));
    assert.equal(named(value(await store.folders(ME)).folders, "Renamed").parentId, null);
    // A chain three deep under Other cannot take a folder that holds two levels.
    const a = value(await store.folderCreate(ME, { name: "A", parentId: other.id })).folder;
    const b = value(await store.folderCreate(ME, { name: "B", parentId: a.id })).folder;
    value(await store.folderCreate(ME, { name: "Child", parentId: top.id }));
    assert.equal(refusal(await store.folderUpdate(ME, top.id, { parentId: b.id })).code, "folder_place");
    value(await store.folderCreate(ME, { name: "Clash", parentId: other.id }));
    const clash = value(await store.folderCreate(ME, { name: "clash" })).folder;
    assert.equal(refusal(await store.folderUpdate(ME, clash.id, { parentId: other.id })).code, "folder_name_taken");
    const history = value(await store.history(ME)).events.map((e) => e.note);
    assert.ok(history.includes("Renamed the folder Inner to Renamed"));
    assert.ok(history.includes("Moved the folder Renamed to Other"));
  });

  it("deletes a folder that holds files only with a folder for them, and the folders inside it with it", async () => {
    const { store, r2 } = setup();
    const top = value(await store.folderCreate(ME, { name: "Old" })).folder;
    const inner = value(await store.folderCreate(ME, { name: "Inner", parentId: top.id })).folder;
    const keep = value(await store.folderCreate(ME, { name: "Keep" })).folder;
    const a = await upload(store, r2, ME, "a.csv", top.id);
    const b = await upload(store, r2, ME, "b.csv", inner.id);
    const refused = refusal(await store.folderDelete(ME, top.id, {}));
    assert.equal(refused.code, "folder_not_empty");
    assert.equal(refused.error, "Old holds 2 files. Name the folder they go to.");
    assert.equal(refusal(await store.folderDelete(ME, top.id, { into: inner.id })).code, "folder_place");
    const gone = value(await store.folderDelete(ME, top.id, { into: keep.id }));
    assert.deepEqual([gone.deleted.sort(), gone.moved, gone.into], [[top.id, inner.id].sort(), 2, keep.id]);
    const files = value(await store.files(ME)).files;
    assert.deepEqual(files.map((f) => [f.id, f.folderId]).sort(), [[a.id, keep.id], [b.id, keep.id]].sort());
    assert.deepEqual(value(await store.folders(ME)).folders.map((f) => f.name), ["Keep"]);
    // An empty folder goes with no place named.
    const empty = value(await store.folderCreate(ME, { name: "Empty" })).folder;
    assert.deepEqual(value(await store.folderDelete(ME, empty.id, {})).moved, 0);
    assert.equal(refusal(await store.folderDelete(ME, empty.id, {})).code, "folder_not_found");
    assert.match(value(await store.history(ME)).events.map((e) => e.note).join("\n"), /Deleted the folder Old and the 1 folder inside it; 2 files went to Keep/);
  });

  it("moves files into a folder, and leaves a deleted file alone", async () => {
    const { store, r2 } = setup();
    const a = await upload(store, r2, ME, "a.csv");
    const b = await upload(store, r2, ME, "b.csv");
    const c = await upload(store, r2, ME, "c.csv");
    value(await store.fileDelete({ storeId: A, actor: "user:admin" }, c.id));
    const reports = value(await store.folderCreate(ME, { name: "Reports" })).folder;
    const moved = value(await store.filesMove(ME, { fileIds: [a.id, b.id, c.id, a.id], folderId: reports.id }));
    assert.deepEqual(moved.fileIds.sort(), [a.id, b.id].sort());
    assert.equal(named(value(await store.folders(ME)).folders, "Reports").files, 2);
    // Moving them where they are moves nothing.
    assert.deepEqual(value(await store.filesMove(ME, { fileIds: [a.id], folderId: reports.id })).fileIds, []);
    assert.equal(refusal(await store.filesMove(ME, { fileIds: [], folderId: reports.id })).code, "bad_request");
    assert.equal(refusal(await store.filesMove(ME, { fileIds: ["nope"], folderId: reports.id })).code, "bad_request");
    assert.equal(refusal(await store.filesMove(ME, { fileIds: [a.id], folderId: "fld_000000000000000000000999" })).code, "folder_not_found");
  });

  it("finds a folder made for something by its ref after a rename, and numbers a name a person took", async () => {
    const { store } = setup();
    value(await store.folderCreate(ME, { name: "Sales sample" }));
    const made = value(await store.folderCreate(ME, { name: "Sales sample", ref: "sample:sales" }));
    assert.deepEqual([made.made, made.folder.name, made.folder.ref], [true, "Sales sample (2)", "sample:sales"]);
    value(await store.folderUpdate(ME, made.folder.id, { name: "Kettlebird sales" }));
    const again = value(await store.folderCreate(ME, { name: "Sales sample", ref: "sample:sales" }));
    assert.deepEqual([again.made, again.folder.id, again.folder.name], [false, made.folder.id, "Kettlebird sales"]);
    assert.equal(refusal(await store.folderCreate(ME, { name: "X", ref: "Not A Ref" })).code, "bad_request");
  });
});

describe("a token held to a folder", () => {
  it("uploads into its folder and the folders inside it, and nowhere else", async () => {
    const { store, r2 } = setup();
    const place = value(await store.folderCreate(ME, { name: "Ashford Clerks", ref: "sender:sse_1" })).folder;
    const permits = value(await store.folderCreate(ME, { name: "2026 Permits", parentId: place.id })).folder;
    const elsewhere = value(await store.folderCreate(ME, { name: "Elsewhere" })).folder;
    const guest: StoreCaller = { storeId: A, actor: "guest:clerk@ashford.example", folder: place.id };
    assert.equal((await upload(store, r2, guest, "a.csv")).folderId, place.id, "no folder named: the token's own");
    assert.equal((await upload(store, r2, guest, "b.csv", permits.id)).folderId, permits.id);
    assert.equal(refusal(await store.fileCreate(guest, { name: "c.csv", size: 1, folderId: elsewhere.id })).code, "folder_outside");
    // Another's upload in progress outside its folder takes no part from it.
    const mine = value(await store.fileCreate(ME, { name: "d.csv", size: 3, folderId: elsewhere.id }));
    assert.equal(refusal(await store.filePartTarget(guest, mine.file.id, 1)).code, "folder_outside");
    assert.equal(refusal(await store.fileComplete(guest, mine.file.id, { parts: [{ n: 1, etag: "x" }] })).code, "folder_outside");
  });

  it("organizes inside its folder only, and never changes the folder itself", async () => {
    const { store, r2 } = setup();
    const place = value(await store.folderCreate(ME, { name: "Ashford Clerks", ref: "sender:sse_1" })).folder;
    const elsewhere = value(await store.folderCreate(ME, { name: "Elsewhere" })).folder;
    const outside = await upload(store, r2, ME, "outside.csv", elsewhere.id);
    const guest: StoreCaller = { storeId: A, actor: "guest:clerk@ashford.example", folder: place.id };
    const inside = await upload(store, r2, guest, "inside.csv");
    assert.equal(refusal(await store.folderCreate(guest, { name: "Top" })).code, "folder_outside");
    assert.equal(refusal(await store.folderCreate(guest, { name: "Mine", ref: "link:x" })).code, "folder_outside");
    const sub = value(await store.folderCreate(guest, { name: "Mine", parentId: place.id })).folder;
    assert.equal(value(await store.folderUpdate(guest, sub.id, { name: "Ours" })).folder.name, "Ours");
    assert.equal(refusal(await store.folderUpdate(guest, place.id, { name: "Renamed" })).code, "folder_outside");
    assert.equal(refusal(await store.folderUpdate(guest, elsewhere.id, { name: "Renamed" })).code, "folder_outside");
    assert.equal(refusal(await store.folderUpdate(guest, sub.id, { parentId: null })).code, "folder_outside");
    assert.equal(refusal(await store.folderUpdate(guest, sub.id, { parentId: elsewhere.id })).code, "folder_outside");
    assert.deepEqual(value(await store.filesMove(guest, { fileIds: [inside.id, outside.id], folderId: sub.id })).fileIds, [inside.id], "a file outside stays where it is");
    assert.equal(refusal(await store.filesMove(guest, { fileIds: [inside.id], folderId: elsewhere.id })).code, "folder_outside");
    assert.equal(refusal(await store.folderDelete(guest, place.id, {})).code, "folder_outside");
    assert.equal(refusal(await store.folderDelete(guest, sub.id, { into: elsewhere.id })).code, "folder_outside");
    assert.equal(value(await store.folderDelete(guest, sub.id, { into: place.id })).moved, 1);
  });

  it("reaches nothing once its folder is gone", async () => {
    const { store } = setup();
    const place = value(await store.folderCreate(ME, { name: "Gone soon" })).folder;
    value(await store.folderDelete(ME, place.id, {}));
    const guest: StoreCaller = { storeId: A, actor: "guest:clerk@ashford.example", folder: place.id };
    assert.equal(refusal(await store.fileCreate(guest, { name: "a.csv", size: 1 })).code, "folder_outside");
  });
});

describe("folders across a restore", () => {
  itRestores("keeps the folders and each file's folder as they are now", async () => {
    const { store, storage, r2, clock, make } = setup();
    const before = value(await store.folderCreate(ME, { name: "Before" })).folder;
    const file = await upload(store, r2, ME, "a.csv", before.id);
    clock.advance(1_000);
    const point = value(await store.migrate(ME, { id: "0000_a", sql: "CREATE TABLE a (v TEXT)" })).migration.restorePoint!;
    clock.advance(1_000);
    const after = value(await store.folderCreate(ME, { name: "After" })).folder;
    value(await store.filesMove(ME, { fileIds: [file.id], folderId: after.id }));
    value(await store.folderUpdate(ME, before.id, { name: "Before, renamed" }));
    value(await store.restore({ storeId: A, actor: "user:admin" }, { at: point }));
    storage.restart();
    const restored = make();
    const folders = value(await restored.folders(ME)).folders;
    assert.deepEqual(folders.map((f) => f.name).sort(), ["After", "Before, renamed"]);
    assert.deepEqual(value(await restored.files(ME)).files.map((f) => [f.id, f.folderId]), [[file.id, after.id]]);
  });
});
