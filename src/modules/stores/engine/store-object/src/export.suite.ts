// A store's export, import and copy, on stand-ins for its storage and bucket: the export is a
// SQLite file SQLite itself finds sound and reads as the same store, written in chunks that stop
// and go on; it downloads as a tar with the files; that tar imports into an empty store as the same
// rows, people, migrations and files; a copy of a big store takes each table's newest rows and the
// rows they point to, with personal values replaced; a failed import leaves the store empty again.

import { describe, it, host, stateOf, filesOf, whereBookmarks, type HostDatabase, type HostFiles } from "../testing/suite/host.js";
import { countingHex, FakeClock } from "../testing/suite/stand-ins.js";
import assert from "node:assert/strict";

import { exportArchive } from "./archive.js";
import type { StoreDeps } from "./core.js";
import { checkHandler } from "./jobs/check.js";
import { shapeHandler } from "./jobs/shape.js";
import type { JobHandler } from "./jobs/types.js";
import type { ExportManifest } from "./export.js";
import { StoreHandler } from "./handler.js";
import { decodeRecord, encodeRecord, u32 } from "./sqlite-file/format.js";
import { archiveFileName, readTar, TAR_END, tarHeader, tarPadding } from "./sqlite-file/tar.js";
import { finishFile, PageOut, TableTree } from "./sqlite-file/writer.js";
import type { Job, StoreCaller, StoreResult } from "./types.js";

const A = "sto_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "sto_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "sto_cccccccccccccccccccccccccccccccc";
const ME = (storeId: string): StoreCaller => ({ storeId, actor: "user:u-1" });

function value<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
}

const refusalCode = <T>(result: StoreResult<T>): string => (result.ok ? "(it was taken)" : result.code);

/** A store on its own storage, all stores on one bucket, as a deployment of many stores keeps them. */
function storeOn(r2: HostFiles, clock: { now: () => number }, env: { STORE_DAILY_WRITE_LIMIT?: string } = {}) {
  const storage = host().storage();
  storage.now = clock.now;
  const state = stateOf(storage);
  const deps: StoreDeps = { now: clock.now, randomHex: countingHex, jobs: new Map() };
  return { storage, store: new StoreHandler(state as never, { FILES: r2.asBucket(), ...env }, deps), db: () => storage.sql.db };
}

/** Runs the store's alarms until the job ends. */
async function finish(store: StoreHandler, caller: StoreCaller, job: Job, clock?: FakeClock): Promise<Job> {
  for (let i = 0; i < 10_000; i++) {
    await store.alarm();
    const now = value(await store.job(caller, job.id)).job;
    if (now.state === "done" || now.state === "failed") return now;
    clock?.advance(3_000);
  }
  throw new Error("the job never ended");
}

async function upload(store: StoreHandler, caller: StoreCaller, r2: HostFiles, name: string, bytes: Uint8Array): Promise<string> {
  const { file, partBytes } = value(await store.fileCreate(caller, { name, size: bytes.byteLength, contentType: "application/octet-stream" }));
  const parts: { n: number; etag: string }[] = [];
  for (let n = 1, at = 0; at < bytes.byteLength || n === 1; n++, at += partBytes) {
    const target = value(await store.filePartTarget(caller, file.id, n));
    const part = await r2.resumeMultipartUpload(target.key, target.uploadId).uploadPart(n, bytes.subarray(at, at + partBytes));
    parts.push({ n, etag: part.etag });
    if (at + partBytes >= bytes.byteLength) break;
  }
  value(await store.fileComplete(caller, file.id, { parts }));
  return file.id;
}

function fileBytes(r2: HostFiles, manifest: ExportManifest): Uint8Array {
  const parts = manifest.db.pieces.map((p) => r2.objects.get(p.key)!.bytes);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

function opened(bytes: Uint8Array): HostDatabase {
  const db = host().database(bytes);
  return db;
}

const all = (db: HostDatabase, sql: string) => db.prepare(sql).all().map((r) => ({ ...r }));
/** Rows with every integer as a bigint: Node's SQLite reads one past 2^53 no other way. */
const allExact = (db: HostDatabase, sql: string) => {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  return statement.all().map((r) => ({ ...r }));
};

const SCHEMA = [
  "CREATE TABLE `laptops` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL, `serial` text, `bought_at` text, `price` real, `notes` text, `photo` blob, `owner_email` text personal);",
  "CREATE UNIQUE INDEX `laptops_serial` ON `laptops` (`serial`);",
  "CREATE TABLE `loans` (`id` integer PRIMARY KEY AUTOINCREMENT, `laptop_id` text NOT NULL REFERENCES `laptops`(`id`), `borrower` text personal, `due_at` text, `note_file` text);",
  "CREATE INDEX `loans_due` ON `loans` (`due_at` DESC);",
  "CREATE INDEX `loans_borrower` ON `loans` (lower(`borrower`));",
  "CREATE INDEX `loans_open` ON `loans` (`laptop_id`) WHERE `due_at` IS NOT NULL;",
  "CREATE TABLE `tags` (`laptop_id` text NOT NULL, `tag` text NOT NULL COLLATE NOCASE, `at` text, PRIMARY KEY (`laptop_id`, `tag`)) WITHOUT ROWID;",
  "CREATE TABLE `managers` (`id` integer PRIMARY KEY, `boss_id` integer REFERENCES `managers`(`id`), `name` text);",
  "CREATE VIEW `open_loans` AS SELECT `id`, `laptop_id` FROM `loans` WHERE `due_at` IS NOT NULL;",
  "CREATE TRIGGER `loans_touch` AFTER UPDATE ON `loans` BEGIN UPDATE `laptops` SET `notes` = 'lent' WHERE `id` = NEW.`laptop_id`; END;",
].join("\n--> statement-breakpoint\n");

/** A store with every shape an app's store can have: types of every kind, overflow, indexes on expressions and parts, WITHOUT ROWID, AUTOINCREMENT, a self-reference, a table a hundred columns wide, people and files. */
async function filled(r2: HostFiles, clock: { now: () => number }, storeId = A, laptops = 2_500) {
  const s = storeOn(r2, clock);
  const me = ME(storeId);
  value(await s.store.migrate(me, { id: "0000_first_tables", sql: SCHEMA, when: 1_762_000_000_000 }));
  const wide = Array.from({ length: 100 }, (_, i) => `\`c${i + 1}\` text`).join(", ");
  value(await s.store.migrate(me, { id: "0001_wide", sql: `CREATE TABLE \`wide\` (${wide});` }));
  const db = s.db();
  const laptop = db.prepare("INSERT INTO laptops VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (let i = 1; i <= laptops; i++) {
    const photo = i % 500 === 0 ? new Uint8Array(70_000).map((_, j) => (j * 7 + i) % 256) : i % 7 === 0 ? new Uint8Array([0, 1, 2, 255]) : null;
    laptop.run(`lap_${String(i).padStart(5, "0")}`, i % 3 === 0 ? `ThinkPad ${i} — Ünïcode ✓` : `MacBook ${i}`, i % 11 === 0 ? null : `SN-${i * 7919}`, i % 5 === 0 ? null : `2026-0${(i % 9) + 1}-1${i % 9}`, i % 4 === 0 ? null : i * 1.25 - 3, i % 13 === 0 ? "x".repeat(5_000) : i % 2 === 0 ? "" : null, photo, `person${i % 50}@example.org`);
  }
  const loan = db.prepare("INSERT INTO loans (laptop_id, borrower, due_at) VALUES (?, ?, ?)");
  for (let i = 1; i <= laptops * 2; i++) loan.run(`lap_${String(((i * 37) % laptops) + 1).padStart(5, "0")}`, `Borrower ${i % 300}`, i % 6 === 0 ? null : `2026-11-${String((i % 28) + 1).padStart(2, "0")}`);
  db.prepare("DELETE FROM loans WHERE id % 97 = 0").run();
  const tag = db.prepare("INSERT INTO tags VALUES (?, ?, ?)");
  for (let i = 1; i <= laptops; i += 3) tag.run(`lap_${String(i).padStart(5, "0")}`, i % 2 ? "Spare" : "loaner", null);
  const mgr = db.prepare("INSERT INTO managers VALUES (?, ?, ?)");
  mgr.run(5, null, "Top");
  mgr.run(2, 5, "Second");
  mgr.run(9, 2, "Third");
  mgr.run(1, 9, "Fourth points at a later row");
  db.prepare(`INSERT INTO wide VALUES (${Array.from({ length: 100 }, (_, i) => `'v${i}'`).join(", ")})`).run();
  db.prepare(`INSERT INTO wide (c1, c100) VALUES ('first', 'last')`).run();
  value(await s.store.appUserInvite(me, { email: "it@example.com", role: "IT" }));
  value(await s.store.appUserInvite(me, { email: "owner@example.com", role: "Owner", tester: true }));
  const fileA = await upload(s.store, me, r2, "inventory.csv", new TextEncoder().encode("serial,owner\nX1-001,Example County\n"));
  const fileB = await upload(s.store, me, r2, "a photo of the spare laptops.jpg", new Uint8Array(20_000).map((_, i) => i % 251));
  const gone = await upload(s.store, me, r2, "old.txt", new TextEncoder().encode("gone"));
  value(await s.store.fileDelete(me, gone));
  db.prepare("UPDATE loans SET note_file = ? WHERE id = (SELECT max(id) FROM loans)").run(fileB);
  return { ...s, me, files: { fileA, fileB, gone } };
}

const DATA_TABLES = ["laptops", "loans", "tags", "managers", "wide", "sqlite_sequence"];

describe("an export to download", () => {
  it("is a SQLite file SQLite finds sound, holding the same tables, rows, indexes and records", async () => {
    const clock = new FakeClock();
    const r2 = filesOf();
    const src = await filled(r2, clock);
    const { job, exportId } = value(await src.store.exportStart(src.me, { requestKey: "export-1" }));
    const done = await finish(src.store, src.me, job, clock);
    assert.equal(done.state, "done", done.error ?? "");
    const { manifest } = value(await src.store.exportManifest(src.me, exportId));
    assert.equal(manifest.purpose, "download");
    const out = opened(fileBytes(r2, manifest));
    assert.deepEqual(all(out, "PRAGMA integrity_check"), [{ integrity_check: "ok" }]);
    assert.deepEqual(all(out, "PRAGMA foreign_key_check"), []);
    for (const table of DATA_TABLES) assert.deepEqual(all(out, `SELECT * FROM ${table} ORDER BY 1, 2`), all(src.db(), `SELECT * FROM ${table} ORDER BY 1, 2`), table);
    // Each index answers as the store's own does.
    assert.deepEqual(all(out, "SELECT id FROM loans INDEXED BY loans_due WHERE due_at > '2026-11-20' ORDER BY due_at DESC, id"), all(src.db(), "SELECT id FROM loans WHERE due_at > '2026-11-20' ORDER BY due_at DESC, id"));
    assert.deepEqual(all(out, "SELECT id FROM loans INDEXED BY loans_borrower WHERE lower(borrower) = 'borrower 12' ORDER BY id"), all(src.db(), "SELECT id FROM loans WHERE lower(borrower) = 'borrower 12' ORDER BY id"));
    assert.deepEqual(all(out, "SELECT tag, count(*) AS n FROM tags WHERE tag = 'SPARE' GROUP BY 1"), all(src.db(), "SELECT tag, count(*) AS n FROM tags WHERE tag = 'SPARE' GROUP BY 1"));
    assert.deepEqual(all(out, "SELECT * FROM open_loans ORDER BY id LIMIT 5"), all(src.db(), "SELECT * FROM open_loans ORDER BY id LIMIT 5"));
    assert.equal(all(out, "SELECT name FROM sqlite_master WHERE type = 'trigger'").length, 1);
    // The store's own records: the migrations as drizzle reads them, the people, no sessions, no marks of the store's own life.
    assert.deepEqual(all(out, "SELECT id, checksum FROM _migrations ORDER BY id"), all(src.db(), "SELECT id, checksum FROM _migrations ORDER BY id"));
    assert.deepEqual(all(out, "SELECT hash, created_at FROM __drizzle_migrations ORDER BY rowid"), all(src.db(), "SELECT hash, created_at FROM __drizzle_migrations ORDER BY rowid"));
    assert.deepEqual(all(out, "SELECT email, role, tester FROM _users ORDER BY email"), all(src.db(), "SELECT email, role, tester FROM _users ORDER BY email"));
    assert.deepEqual(all(out, "SELECT count(*) AS n FROM _sessions"), [{ n: 0 }]);
    assert.deepEqual(all(out, "SELECT key FROM _meta WHERE key IN ('store_id', 'created_at', 'held')"), []);
    // The files that arrived and were not deleted, each named by its place in the archive.
    assert.deepEqual(
      all(out, "SELECT id, r2_key FROM _files ORDER BY id"),
      [src.files.fileA, src.files.fileB].sort().map((id) => ({ id, r2_key: `files/${id}/${id === src.files.fileA ? "inventory.csv" : "a photo of the spare laptops.jpg"}` })),
    );
    assert.deepEqual(manifest.files.map((f) => f.id).sort(), [src.files.fileA, src.files.fileB].sort());
    // While it ran the store took no writes; now it takes them again.
    value(await src.store.exec(src.me, { sql: "UPDATE laptops SET name = 'Renamed' WHERE id = 'lap_00001'" }));
  });

  it("is written in chunks that stop and go on, and holds the store's writes until it ends", async () => {
    const r2 = filesOf();
    // A clock that moves on every read: each chunk reaches its deadline after a few batches.
    let t = Date.UTC(2026, 10, 9, 9, 0, 0);
    const ticking = { now: () => (t += 2_500) };
    const src = await filled(r2, ticking, A, 3_000);
    const { job, exportId } = value(await src.store.exportStart(src.me, { requestKey: "export-chunks" }));
    await src.store.alarm();
    await src.store.alarm();
    const mid = value(await src.store.job(src.me, job.id)).job;
    assert.equal(mid.state, "running");
    const refused = await src.store.exec(src.me, { sql: "DELETE FROM loans" });
    assert.deepEqual(refused.ok ? null : { status: refused.status, code: refused.code }, { status: 409, code: "store_busy" });
    assert.ok(value(await src.store.query(src.me, { sql: "SELECT count(*) FROM laptops" })).rows.length === 1, "reads go on");
    let chunks = 2;
    for (let state: Job["state"] = mid.state; state !== "done"; chunks++) {
      assert.notEqual(state, "failed", value(await src.store.job(src.me, job.id)).job.error ?? "");
      await src.store.alarm();
      state = value(await src.store.job(src.me, job.id)).job.state;
    }
    assert.ok(chunks > 3, `took ${chunks} chunks`);
    const { manifest } = value(await src.store.exportManifest(src.me, exportId));
    const out = opened(fileBytes(r2, manifest));
    assert.deepEqual(all(out, "PRAGMA integrity_check"), [{ integrity_check: "ok" }]);
    for (const table of DATA_TABLES) assert.deepEqual(all(out, `SELECT * FROM ${table} ORDER BY 1, 2`), all(src.db(), `SELECT * FROM ${table} ORDER BY 1, 2`), table);
  });

  it("downloads as a tar that holds the SQLite file and every file under files/<id>/<name>", async () => {
    const clock = new FakeClock();
    const r2 = filesOf();
    const src = await filled(r2, clock, A, 300);
    const { job, exportId } = value(await src.store.exportStart(src.me, { requestKey: "export-tar" }));
    await finish(src.store, src.me, job, clock);
    const { manifest } = value(await src.store.exportManifest(src.me, exportId));
    const archive = exportArchive(r2.asBucket(), manifest, "laptop-loans");
    const bytes = new Uint8Array(await new Response(archive.body).arrayBuffer());
    assert.equal(bytes.byteLength, archive.size);
    const tar = await readTar({ size: bytes.byteLength, read: async (o, l) => bytes.subarray(o, o + l) });
    assert.equal(tar.db?.name, "laptop-loans.sqlite");
    assert.deepEqual(bytes.subarray(tar.db!.offset, tar.db!.offset + tar.db!.size), fileBytes(r2, manifest));
    const photo = tar.files.get(src.files.fileB)!;
    assert.equal(photo.name, "a photo of the spare laptops.jpg");
    assert.deepEqual(bytes.subarray(photo.offset, photo.offset + photo.size), new Uint8Array(20_000).map((_, i) => i % 251));
    assert.equal(tar.files.has(src.files.gone), false);
  });
});

describe("an import", () => {
  it("loads an export's tar into an empty store as the same rows, people, migrations and files", async () => {
    const clock = new FakeClock();
    const r2 = filesOf();
    const src = await filled(r2, clock);
    const ex = value(await src.store.exportStart(src.me, { requestKey: "export-for-import" }));
    await finish(src.store, src.me, ex.job, clock);
    const { manifest } = value(await src.store.exportManifest(src.me, ex.exportId));
    const archive = new Uint8Array(await new Response(exportArchive(r2.asBucket(), manifest, "laptop-loans").body).arrayBuffer());

    const dst = storeOn(r2, clock);
    const me = ME(B);
    const archiveId = await upload(dst.store, me, r2, "laptop-loans.tar", archive);
    const { job } = value(await dst.store.importStart(me, { fileId: archiveId, requestKey: "import-1" }));
    const done = await finish(dst.store, me, job, clock);
    assert.equal(done.state, "done", done.error ?? "");
    const dataRows = ["laptops", "loans", "tags", "managers", "wide"].reduce((n, t) => n + Number(all(src.db(), `SELECT count(*) AS n FROM ${t}`)[0]!.n), 0);
    assert.deepEqual(done.result, { tables: 5, rows: dataRows, files: 2, fileBytes: 20_000 + 35, migrations: 2, users: 2 });
    for (const table of DATA_TABLES) assert.deepEqual(all(dst.db(), `SELECT * FROM ${table} ORDER BY 1, 2`), all(src.db(), `SELECT * FROM ${table} ORDER BY 1, 2`), table);
    assert.deepEqual(all(dst.db(), "PRAGMA integrity_check"), [{ integrity_check: "ok" }]);
    assert.deepEqual(all(dst.db(), "SELECT id, checksum, sql FROM _migrations ORDER BY id"), all(src.db(), "SELECT id, checksum, sql FROM _migrations ORDER BY id"));
    assert.deepEqual(all(dst.db(), "SELECT hash, created_at FROM __drizzle_migrations ORDER BY rowid"), all(src.db(), "SELECT hash, created_at FROM __drizzle_migrations ORDER BY rowid"));
    assert.deepEqual(all(dst.db(), "SELECT id, email, role, tester, status FROM _users ORDER BY id"), all(src.db(), "SELECT id, email, role, tester, status FROM _users ORDER BY id"));
    // The indexes, the view and the trigger are the store's own again.
    assert.deepEqual(all(dst.db(), "SELECT type, name FROM sqlite_master WHERE type IN ('index', 'view', 'trigger') AND name NOT LIKE 'sqlite_%' AND tbl_name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name"), all(src.db(), "SELECT type, name FROM sqlite_master WHERE type IN ('index', 'view', 'trigger') AND name NOT LIKE 'sqlite_%' AND tbl_name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name"));
    // Each file, under this store's key, with its bytes; the archive itself is gone.
    const files = value(await dst.store.files(me)).files;
    assert.deepEqual(files.map((f) => f.id).sort(), [src.files.fileA, src.files.fileB].sort());
    const target = value(await dst.store.fileTarget(me, src.files.fileB));
    assert.equal(target.key, `stores/${B}/files/${src.files.fileB}/a photo of the spare laptops.jpg`);
    assert.deepEqual(r2.objects.get(target.key)!.bytes, new Uint8Array(20_000).map((_, i) => i % 251));
    assert.equal(r2.objects.get(target.key)!.customMetadata?.fileId, src.files.fileB);
    assert.equal(files.some((f) => f.id === archiveId), false);
    // AUTOINCREMENT goes on from where the source left it, and the store takes writes again.
    value(await dst.store.exec(me, { sql: "INSERT INTO loans (laptop_id, borrower) VALUES ('lap_00001', 'New')" }));
    assert.deepEqual(all(dst.db(), "SELECT max(id) AS id FROM loans"), [{ id: Number(all(src.db(), "SELECT seq FROM sqlite_sequence WHERE name = 'loans'")[0]!.seq) + 1 }]);
    assert.ok(value(await dst.store.history(me)).events.some((e) => e.note.startsWith("Imported 5 tables")));
  });

  it("brings the store's folders and each file's folder, and keeps one Uploads", async () => {
    const clock = new FakeClock();
    const r2 = filesOf();
    const src = await filled(r2, clock, A, 50);
    const inventory = value(await src.store.folderCreate(src.me, { name: "Inventory" })).folder;
    value(await src.store.filesMove(src.me, { fileIds: [src.files.fileA], folderId: inventory.id }));
    const ex = value(await src.store.exportStart(src.me, { requestKey: "export-folders" }));
    await finish(src.store, src.me, ex.job, clock);
    const { manifest } = value(await src.store.exportManifest(src.me, ex.exportId));
    const archive = new Uint8Array(await new Response(exportArchive(r2.asBucket(), manifest, "folders").body).arrayBuffer());
    const dst = storeOn(r2, clock);
    const me = ME(B);
    // The archive itself arrives in this store's Uploads, as any upload that names no folder does.
    const archiveId = await upload(dst.store, me, r2, "folders.tar", archive);
    const { job } = value(await dst.store.importStart(me, { fileId: archiveId, requestKey: "import-folders" }));
    assert.equal((await finish(dst.store, me, job, clock)).state, "done");
    const folders = value(await dst.store.folders(me)).folders;
    assert.deepEqual(folders.map((f) => [f.name, f.ref, f.files]), [["Inventory", null, 1], ["Uploads", "uploads", 1]]);
    const byId = new Map(folders.map((f) => [f.id, f.name]));
    assert.deepEqual(
      value(await dst.store.files(me)).files.map((f) => [f.id, byId.get(f.folderId)]).sort(),
      [[src.files.fileA, "Inventory"], [src.files.fileB, "Uploads"]].sort(),
    );
  });

  it("puts the files of an export from before folders into Uploads", async () => {
    const clock = new FakeClock();
    const r2 = filesOf();
    const src = await filled(r2, clock, A, 50);
    // A store as it was before folders: its files in none, and no folders.
    src.db().prepare("UPDATE _files SET folder_id = NULL").run();
    src.db().prepare("DELETE FROM _folders").run();
    const ex = value(await src.store.exportStart(src.me, { requestKey: "export-old" }));
    await finish(src.store, src.me, ex.job, clock);
    const { manifest } = value(await src.store.exportManifest(src.me, ex.exportId));
    const archive = new Uint8Array(await new Response(exportArchive(r2.asBucket(), manifest, "old").body).arrayBuffer());
    const dst = storeOn(r2, clock);
    const me = ME(B);
    const archiveId = await upload(dst.store, me, r2, "old.tar", archive);
    const { job } = value(await dst.store.importStart(me, { fileId: archiveId, requestKey: "import-old" }));
    assert.equal((await finish(dst.store, me, job, clock)).state, "done");
    const folders = value(await dst.store.folders(me)).folders;
    assert.deepEqual(folders.map((f) => [f.name, f.files]), [["Uploads", 2]]);
    assert.ok(value(await dst.store.files(me)).files.every((f) => f.folderId === folders[0]!.id));
  });

  it("refuses a store that is not empty, and leaves a store empty again when it fails", async () => {
    const clock = new FakeClock();
    const r2 = filesOf();
    const src = await filled(r2, clock, A, 50);
    const ex = value(await src.store.exportStart(src.me, { requestKey: "export-x" }));
    await finish(src.store, src.me, ex.job, clock);
    const { manifest } = value(await src.store.exportManifest(src.me, ex.exportId));
    // A full store is refused at once.
    const archive = new Uint8Array(await new Response(exportArchive(r2.asBucket(), manifest, "x").body).arrayBuffer());
    const fileId = await upload(src.store, src.me, r2, "x.tar", archive);
    const refused = await src.store.importStart(src.me, { fileId, requestKey: "import-into-full" });
    assert.deepEqual(refused.ok ? null : refused.code, "store_not_empty");
    // The SQLite file alone, without the files it lists, fails, and the store is as it was.
    const dst = storeOn(r2, clock);
    const me = ME(C);
    const bare = await upload(dst.store, me, r2, "x.sqlite", fileBytes(r2, manifest));
    const { job } = value(await dst.store.importStart(me, { fileId: bare, requestKey: "import-bare" }));
    const failed = await finish(dst.store, me, job, clock);
    assert.equal(failed.state, "failed");
    assert.match(failed.error ?? "", /lacks the bytes of 2 of its files/);
    assert.deepEqual(all(dst.db(), "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%'"), []);
    assert.deepEqual(value(await dst.store.files(me)).files.map((f) => f.id), [bare]);
    // Its hold is gone with it: the store takes writes again.
    value(await dst.store.exec(me, { sql: "CREATE TABLE t (x)" }));
  });
});

describe("a copy for a preview", () => {
  it("takes each table's newest rows and the rows they point to, with personal values replaced the same way everywhere", async () => {
    const clock = new FakeClock();
    const r2 = filesOf();
    const src = await filled(r2, clock, A, 6_000);
    const sourceToken = value(await src.store.exportStart(src.me, { requestKey: "copy:preview-1", purpose: "copy", mode: "sample", personal: "replace" }));
    const dst = storeOn(r2, clock);
    const me = ME(B);
    const { job } = value(await dst.store.importStart(me, { from: { storeId: A, exportId: sourceToken.exportId }, requestKey: "preview-1", label: "staging" }));
    // The copy waits for the source's export, then loads it.
    await dst.store.alarm();
    assert.equal(value(await dst.store.job(me, job.id)).job.progress?.note, "Waiting for the other store's export");
    const exported = await finish(src.store, src.me, sourceToken.job, clock);
    assert.equal(exported.state, "done", exported.error ?? "");
    assert.equal((exported.result as { mode: string }).mode, "sample");
    clock.advance(5_000);
    const done = await finish(dst.store, me, job, clock);
    assert.equal(done.state, "done", done.error ?? "");
    const db = dst.db();
    // The newest 5,000 loans, every laptop one of them points at, and the newest 5,000 laptops.
    const newestLoans = all(src.db(), "SELECT id FROM loans ORDER BY id DESC LIMIT 5000").map((r) => r.id);
    assert.deepEqual(all(db, "SELECT id FROM loans ORDER BY id DESC").map((r) => r.id), newestLoans);
    const pointedAt = new Set(all(db, "SELECT DISTINCT laptop_id FROM loans").map((r) => r.laptop_id));
    const newestLaptops = all(src.db(), "SELECT id FROM laptops ORDER BY rowid DESC LIMIT 5000").map((r) => r.id);
    const have = new Set(all(db, "SELECT id FROM laptops").map((r) => r.id));
    for (const id of pointedAt) assert.ok(have.has(id), `laptop ${String(id)} a loan points at`);
    for (const id of newestLaptops) assert.ok(have.has(id), `newest laptop ${String(id)}`);
    assert.equal(have.size, new Set([...newestLaptops, ...pointedAt]).size);
    assert.deepEqual(all(db, "PRAGMA foreign_key_check"), []);
    // A table under 5,000 rows comes whole, and so does a WITHOUT ROWID table.
    assert.equal(all(db, "SELECT count(*) AS n FROM managers")[0]!.n, 4);
    assert.equal(all(db, "SELECT count(*) AS n FROM tags")[0]!.n, all(src.db(), "SELECT count(*) AS n FROM tags")[0]!.n);
    // Personal columns are replaced, the same value with the same replacement in every table.
    const emails = all(db, "SELECT DISTINCT owner_email FROM laptops").map((r) => String(r.owner_email));
    assert.ok(emails.every((e) => /^person-[0-9a-f]{12}@example\.com$/.test(e)), emails.slice(0, 3).join());
    assert.equal(emails.length, 50);
    const borrowers = all(db, "SELECT DISTINCT borrower FROM loans").map((r) => String(r.borrower));
    assert.ok(borrowers.every((b) => /^Person [0-9a-f]{12}$/.test(b)));
    const sameSource = all(src.db(), "SELECT id FROM loans WHERE borrower = 'Borrower 7' ORDER BY id DESC LIMIT 5000").map((r) => r.id);
    const replacedOnce = new Set(all(db, `SELECT borrower FROM loans WHERE id IN (${sameSource.join(",")})`).map((r) => r.borrower));
    assert.equal(replacedOnce.size, 1);
    // Columns not marked personal keep their values.
    assert.deepEqual(all(db, "SELECT name, serial FROM laptops WHERE id = 'lap_06000'"), all(src.db(), "SELECT name, serial FROM laptops WHERE id = 'lap_06000'"));
    // The migrations and the user list come; history and jobs do not; only the files the rows name.
    assert.equal(all(db, "SELECT count(*) AS n FROM _migrations")[0]!.n, 2);
    assert.equal(all(db, "SELECT count(*) AS n FROM _users")[0]!.n, 2);
    assert.deepEqual(value(await dst.store.files(me)).files.map((f) => f.id), [src.files.fileB]);
    assert.equal(value(await dst.store.history(me)).events.filter((e) => e.kind === "migration").length, 0);
  });
});

describe("a copy that replaces a store's data", () => {
  async function targetWithData(r2: HostFiles, clock: FakeClock) {
    const dst = storeOn(r2, clock);
    const me = ME(B);
    value(await dst.store.migrate(me, { id: "0000_old", sql: "CREATE TABLE old_rows (id integer PRIMARY KEY, note text);\n--> statement-breakpoint\nCREATE VIEW old_view AS SELECT id FROM old_rows;" }));
    dst.db().exec("INSERT INTO old_rows VALUES (1, 'the store''s own');");
    value(await dst.store.appUserInvite(me, { email: "tester@example.com", role: "Tester" }));
    const file = await upload(dst.store, me, r2, "before.txt", new TextEncoder().encode("before"));
    return { ...dst, me, file, fileKey: String(dst.db().prepare("SELECT r2_key FROM _files WHERE id = ?").get(file)!.r2_key) };
  }
  const named = (db: HostDatabase) => all(db, "SELECT type, name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => String(r.name));

  it("empties the store only once the export is there, and keeps its people, its history and its files' bytes", async () => {
    const clock = new FakeClock();
    const r2 = filesOf();
    const src = await filled(r2, clock, A, 50);
    const ex = value(await src.store.exportStart(src.me, { requestKey: "copy:replace-1", purpose: "copy", mode: "whole", personal: "replace" }));
    const dst = await targetWithData(r2, clock);
    const { job } = value(await dst.store.importStart(dst.me, { from: { storeId: A, exportId: ex.exportId }, requestKey: "replace-1", label: "the prod stage of Laptop Loans", replace: true }));

    // While the export is being written the store holds what it held, and takes no writes.
    await dst.store.alarm();
    assert.equal(value(await dst.store.job(dst.me, job.id)).job.progress?.note, "Waiting for the other store's export");
    assert.deepEqual(named(dst.db()), ["old_rows", "old_view"]);
    assert.equal(refusalCode(await dst.store.exec(dst.me, { sql: "INSERT INTO old_rows VALUES (2, 'late')" })), "store_busy");

    assert.equal((await finish(src.store, src.me, ex.job, clock)).state, "done");
    clock.advance(5_000);
    const done = await finish(dst.store, dst.me, job, clock);
    assert.equal(done.state, "done", done.error ?? "");

    // The tables and the store changes are the copy's.
    assert.deepEqual(named(dst.db()), ["laptops", "loans", "managers", "open_loans", "tags", "wide"]);
    assert.deepEqual(all(dst.db(), "SELECT id FROM _migrations ORDER BY id").map((r) => r.id), ["0000_first_tables", "0001_wide"]);
    assert.deepEqual(all(dst.db(), "SELECT count(*) AS n FROM _migrations WHERE restore_point IS NOT NULL"), [{ n: 0 }], "a moment of the source store means nothing here");
    const emails = all(dst.db(), "SELECT DISTINCT owner_email FROM laptops").map((r) => String(r.owner_email));
    assert.ok(emails.every((e) => /^person-[0-9a-f]{12}@example\.com$/.test(e)));
    // Who may come in is this store's own.
    assert.deepEqual(all(dst.db(), "SELECT email FROM _users"), [{ email: "tester@example.com" }]);
    // The store's own file is marked deleted, its bytes stay for a restore, and the copy's files are there.
    assert.equal(value(await dst.store.files(dst.me)).files.some((f) => f.id === dst.file), false);
    assert.ok(all(dst.db(), `SELECT deleted_at FROM _files WHERE id = '${dst.file}'`)[0]!.deleted_at);
    assert.ok(r2.objects.has(dst.fileKey));
    assert.deepEqual(value(await dst.store.files(dst.me)).files.map((f) => f.id).sort(), [src.files.fileA, src.files.fileB].sort());
    // The history goes on, and says what happened with the moment before it.
    const events = value(await dst.store.history(dst.me)).events;
    assert.ok(events.some((e) => e.note.includes("0000_old")));
    const replaced = events.find((e) => e.note.startsWith("Replaced this store's data with 5 tables"));
    assert.ok(replaced, JSON.stringify(events.map((e) => e.note)));
    assert.match(replaced.note, /from the prod stage of Laptop Loans$/);
    whereBookmarks(() => assert.ok(replaced.restorePoint, "the moment before the copy"));
    assert.ok(Date.parse(replaced.at) < clock.now(), "and its time is when the copy began, for a restore that names it");
    // And it takes writes again.
    value(await dst.store.exec(dst.me, { sql: "INSERT INTO managers VALUES (100, NULL, 'New')" }));
  });

  it("leaves the store as it was when the export never comes", async () => {
    const clock = new FakeClock();
    const r2 = filesOf();
    const exportId = `exp_${"0".repeat(24)}`;
    await r2.asBucket().put(`stores/${A}/exports/${exportId}/failed.json`, JSON.stringify({ error: "the export broke" }));
    const dst = await targetWithData(r2, clock);
    const { job } = value(await dst.store.importStart(dst.me, { from: { storeId: A, exportId }, requestKey: "replace-2", replace: true }));
    const failed = await finish(dst.store, dst.me, job, clock);
    assert.equal(failed.state, "failed");
    assert.match(failed.error ?? "", /the export broke/);
    assert.deepEqual(named(dst.db()), ["old_rows", "old_view"]);
    assert.deepEqual(all(dst.db(), "SELECT note FROM old_rows"), [{ note: "the store's own" }]);
    assert.equal(value(await dst.store.files(dst.me)).files.length, 1);
    value(await dst.store.exec(dst.me, { sql: "INSERT INTO old_rows VALUES (2, 'and it takes writes')" }));
  });

  it("leaves the store empty, with its people, when the copy fails after emptying it", async () => {
    const clock = new FakeClock();
    const r2 = filesOf();
    const src = storeOn(r2, clock);
    const me = ME(A);
    value(await src.store.migrate(me, { id: "0000_first", sql: "CREATE TABLE rows_of_mine (id integer PRIMARY KEY);" }));
    src.db().exec("INSERT INTO rows_of_mine VALUES (1);");
    const fileId = await upload(src.store, me, r2, "a.txt", new TextEncoder().encode("bytes"));
    const ex = value(await src.store.exportStart(me, { requestKey: "copy:3", purpose: "copy", mode: "whole", personal: "keep" }));
    await finish(src.store, me, ex.job, clock);
    const dst = await targetWithData(r2, clock);
    // The file's bytes go missing, so the copy fails after its rows are in.
    for (const key of [...r2.objects.keys()]) if (key.includes(fileId)) r2.objects.delete(key);
    const { job } = value(await dst.store.importStart(dst.me, { from: { storeId: A, exportId: ex.exportId }, requestKey: "replace-3", replace: true }));
    const failed = await finish(dst.store, dst.me, job, clock);
    assert.equal(failed.state, "failed");
    assert.deepEqual(named(dst.db()), []);
    assert.deepEqual(all(dst.db(), "SELECT email FROM _users"), [{ email: "tester@example.com" }], "the people stay, as a restore expects");
    assert.ok(r2.objects.has(dst.fileKey), "and the file's bytes, for the restore");
    value(await dst.store.exec(dst.me, { sql: "CREATE TABLE t (x)" }));
  });

  it("keeps the bytes of a file the store already held when a second copy of it fails", async () => {
    const clock = new FakeClock();
    const r2 = filesOf();
    const src = storeOn(r2, clock);
    const me = ME(A);
    value(await src.store.migrate(me, { id: "0000_first", sql: "CREATE TABLE rows_of_mine (id integer PRIMARY KEY);" }));
    const fileId = await upload(src.store, me, r2, "a.txt", new TextEncoder().encode("bytes"));
    const first = value(await src.store.exportStart(me, { requestKey: "copy:first", purpose: "copy", mode: "whole", personal: "keep" }));
    await finish(src.store, me, first.job, clock);
    const dst = await targetWithData(r2, clock);
    const job1 = value(await dst.store.importStart(dst.me, { from: { storeId: A, exportId: first.exportId }, requestKey: "replace-a", replace: true })).job;
    assert.equal((await finish(dst.store, dst.me, job1, clock)).state, "done");
    const ownKey = String(dst.db().prepare("SELECT r2_key FROM _files WHERE id = ?").get(fileId)!.r2_key);

    const second = value(await src.store.exportStart(me, { requestKey: "copy:second", purpose: "copy", mode: "whole", personal: "keep" }));
    await finish(src.store, me, second.job, clock);
    // The source's bytes go missing, so the second copy fails after it emptied the store.
    for (const key of [...r2.objects.keys()]) if (key.includes(fileId) && !key.includes(`/${B}/`)) r2.objects.delete(key);
    const job2 = value(await dst.store.importStart(dst.me, { from: { storeId: A, exportId: second.exportId }, requestKey: "replace-b", replace: true })).job;
    assert.equal((await finish(dst.store, dst.me, job2, clock)).state, "failed");
    assert.ok(r2.objects.has(ownKey), "a restore still needs them");
  });

  it("only takes another store's export: a file of its own still asks for an empty store", async () => {
    const clock = new FakeClock();
    const r2 = filesOf();
    const dst = await targetWithData(r2, clock);
    const fileId = await upload(dst.store, dst.me, r2, "x.tar", new TextEncoder().encode("not read"));
    assert.equal(refusalCode(await dst.store.importStart(dst.me, { fileId, requestKey: "replace-4", replace: true })), "store_not_empty");
  });
});

describe("the file's edges", () => {
  async function exported(setupRows: (db: HostDatabase) => void, migrations: string[]): Promise<{ out: HostDatabase; src: HostDatabase }> {
    const clock = new FakeClock();
    const r2 = filesOf();
    const s = storeOn(r2, clock);
    const me = ME(A);
    for (const [i, sql] of migrations.entries()) value(await s.store.migrate(me, { id: `000${i}_m`, sql }));
    setupRows(s.db());
    const { job, exportId } = value(await s.store.exportStart(me, { requestKey: "edges" }));
    const done = await finish(s.store, me, job, clock);
    assert.equal(done.state, "done", done.error ?? "");
    const { manifest } = value(await s.store.exportManifest(me, exportId));
    return { out: opened(fileBytes(r2, manifest)), src: s.db() };
  }

  it("keeps a schema of hundreds of tables, which page 1 holds only the root of", async () => {
    const tables = Array.from({ length: 300 }, (_, i) => `CREATE TABLE \`t${i}\` (\`id\` integer PRIMARY KEY, \`a_rather_long_column_name_${i}\` text NOT NULL DEFAULT 'something to make the statement long');`);
    const { out } = await exported((db) => db.prepare("INSERT INTO t299 (id) VALUES (1)").run(), [tables.join("\n--> statement-breakpoint\n")]);
    assert.deepEqual(all(out, "PRAGMA integrity_check"), [{ integrity_check: "ok" }]);
    assert.equal(all(out, "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 't%'")[0]!.n, 300);
    assert.deepEqual(all(out, "SELECT * FROM t299"), [{ id: 1, a_rather_long_column_name_299: "something to make the statement long" }]);
  });

  it("keeps empty tables, a row of almost 2 MB, index keys that overflow, deep trees and every kind of number", async () => {
    const { out, src } = await exported(
      (db) => {
        db.prepare("INSERT INTO big VALUES (1, ?)").run("é".repeat(950_000));
        db.prepare("INSERT INTO big VALUES (2, ?)").run(new Uint8Array(1_900_000).map((_, i) => i % 256));
        const key = db.prepare("INSERT INTO keys (k) VALUES (?)");
        for (let i = 0; i < 6_000; i++) key.run(`${String(i).padStart(6, "0")}${"k".repeat(i % 50 === 0 ? 3_000 : 900)}`);
        const n = db.prepare("INSERT INTO nums (v) VALUES (?)");
        for (const v of [0, 1, -1, 127, -128, 32_767, 2 ** 31, -(2 ** 31), 2 ** 47, 2 ** 53 - 1, -(2 ** 53) + 1, 0.5, -0.25, 1e300, -1e-300, 3.0]) n.run(v);
        db.prepare("INSERT INTO nums (v) VALUES (?)").run(9_223_372_036_854_775_807n);
        db.prepare("INSERT INTO nums (v) VALUES (?)").run(-9_223_372_036_854_775_808n);
      },
      [
        [
          "CREATE TABLE `empty_t` (`a` text, `b` integer);",
          "CREATE INDEX `empty_i` ON `empty_t` (`a`);",
          "CREATE TABLE `big` (`id` integer PRIMARY KEY, `v`);",
          "CREATE TABLE `keys` (`k` text NOT NULL);",
          "CREATE UNIQUE INDEX `keys_k` ON `keys` (`k`);",
          "CREATE TABLE `nums` (`v`);",
          "CREATE INDEX `nums_v` ON `nums` (`v`);",
        ].join("\n--> statement-breakpoint\n"),
      ],
    );
    assert.deepEqual(all(out, "PRAGMA integrity_check"), [{ integrity_check: "ok" }]);
    for (const table of ["empty_t", "big", "keys"]) assert.deepEqual(allExact(out, `SELECT rowid, * FROM ${table} ORDER BY rowid`), allExact(src, `SELECT rowid, * FROM ${table} ORDER BY rowid`), table);
    assert.deepEqual(all(out, "SELECT k FROM keys INDEXED BY keys_k WHERE k > '005000' ORDER BY k LIMIT 3"), all(src, "SELECT k FROM keys WHERE k > '005000' ORDER BY k LIMIT 3"));
    // A real with no fraction (3.0) in a column of no type comes back an integer: the same number.
    const kinds = (db: HostDatabase) => allExact(db, "SELECT v, typeof(v) AS t FROM nums ORDER BY v").map((r) => ({ v: r.v, t: r.t === "real" && Number.isInteger(r.v as number) && Math.abs(r.v as number) < 2 ** 63 ? "integer" : r.t }));
    assert.deepEqual(allExact(out, "SELECT v, typeof(v) AS t FROM nums INDEXED BY nums_v ORDER BY v").map((r) => ({ v: typeof r.v === "number" && Number.isInteger(r.v) ? BigInt(r.v) : r.v, t: r.t })), kinds(src).map((r) => ({ v: typeof r.v === "number" && Number.isInteger(r.v) ? BigInt(r.v) : r.v, t: r.t })));
  });
});

describe("what a person's review keeps", () => {
  it("comes with an export to download and its import, and a copy holds no fix", async () => {
    const clock = new FakeClock();
    const r2 = filesOf();
    const src = await filled(r2, clock);
    src.db().exec(`INSERT INTO _fixes (id, tbl, key_columns, row_key, column_name, was, value, version, by_sub, at)
      VALUES ('fix_1', 'laptops', '["rowid"]', '{"rowid":1}', 'name', 'Old name', 'A person''s secret', 1, 'user:u-1', '2026-11-09T00:00:00.000Z')`);
    src.db().exec(`INSERT INTO _meta (key, value) VALUES ('check:laptops', '{"rules":[]}'), ('answers:answers_kind', '{"kind":"classify"}'), ('profile:laptops', '["x"]'), ('code_page:loans.dbf', '1252')`);
    const fixes = (db: HostDatabase) => all(db, "SELECT tbl, column_name, was, value FROM _fixes");
    const kept = (db: HostDatabase) => all(db, "SELECT key FROM _meta WHERE key LIKE 'check:%' OR key LIKE 'answers:%' OR key LIKE 'profile:%' OR key LIKE 'code^_page:%' ESCAPE '^' ORDER BY key").map((r) => r.key);

    const ex = value(await src.store.exportStart(src.me, { requestKey: "export-with-fixes" }));
    await finish(src.store, src.me, ex.job, clock);
    const { manifest } = value(await src.store.exportManifest(src.me, ex.exportId));
    const archive = new Uint8Array(await new Response(exportArchive(r2.asBucket(), manifest, "laptop-loans").body).arrayBuffer());
    const dst = storeOn(r2, clock);
    const me = ME(B);
    const archiveId = await upload(dst.store, me, r2, "laptop-loans.tar", archive);
    const { job } = value(await dst.store.importStart(me, { fileId: archiveId, requestKey: "import-with-fixes" }));
    assert.equal((await finish(dst.store, me, job, clock)).state, "done");
    assert.deepEqual(fixes(dst.db()), fixes(src.db()), "a later run writes the person's fix again");
    assert.deepEqual(kept(dst.db()), ["answers:answers_kind", "check:laptops", "code_page:loans.dbf"], "a table's rules and answers, the code page set for a file, and not a profile's marks of this store");

    const copied = value(await src.store.exportStart(src.me, { requestKey: "copy-with-fixes", purpose: "copy", mode: "sample", personal: "replace" }));
    await finish(src.store, src.me, copied.job, clock);
    const { manifest: copyFile } = value(await src.store.exportManifest(src.me, copied.exportId));
    // A copy's file has no indexes for SQLite to open it by, so its bytes are read as they are.
    assert.equal(Buffer.from(fileBytes(r2, copyFile)).includes("A person's secret"), false, "the value a person typed is not in a copy's file");
  });
});

describe("a check's rules in an export and its import", () => {
  it("keep their conditions, their days counted from today, their other columns, their zone and their unchecked words, and a fix after the import tests them", async () => {
    // Noon on 2026-11-12 in Los Angeles.
    const clock = new FakeClock(Date.UTC(2026, 10, 12, 20, 0, 0));
    const r2 = filesOf();
    const withJobs = (storeId: string) => {
      const storage = host().storage();
      storage.now = clock.now;
      const deps: StoreDeps = { now: clock.now, randomHex: countingHex, jobs: new Map(([shapeHandler, checkHandler] as unknown as JobHandler[]).map((h) => [h.kind, h])) };
      return { me: ME(storeId), store: new StoreHandler(stateOf(storage) as never, { FILES: r2.asBucket() }, deps), db: () => storage.sql.db };
    };
    const job = async (s: ReturnType<typeof withJobs>, kind: string, params: unknown, requestKey: string) => {
      const ended = await finish(s.store, s.me, value(await s.store.jobSubmit(s.me, { kind, params, requestKey })).job, clock);
      assert.equal(ended.state, "done", ended.error ?? "");
    };
    const src = withJobs(A);
    value(
      await src.store.exec(src.me, {
        sql: `CREATE TABLE county (permit_number TEXT, status_code TEXT, issued_on TEXT, finaled_on TEXT, _file TEXT, _row INTEGER);
          INSERT INTO county VALUES ('BP-2022-0904', 'ISSUED', '', NULL, 'fil_1', 1), ('BP-2023-0112', 'FINALED', '2062-07-04', '2062-08-01', 'fil_1', 2), ('BP-2022-0907', 'APPLIED', NULL, NULL, 'fil_1', 3), ('BP-2023-0120', 'FINALED', '2023-05-10', '2023-04-01', 'fil_1', 4);`,
      }),
    );
    const madeBy = { runId: "mrn-1", step: "s5" };
    await job(src, "shape", { into: "permits", sql: "SELECT permit_number, status_code, issued_on, finaled_on, _file, _row FROM county", goal: null, sources: "[]", madeBy }, "shape-1");
    const rules = [
      { rule: "range", column: "issued_on", min: null, max: "today" },
      { rule: "required", columns: ["issued_on"], when: [{ column: "status_code", values: ["ISSUED", "FINALED"] }] },
      { rule: "range", column: "finaled_on", min: { column: "issued_on" }, max: null },
    ];
    const unchecked = [{ words: "a permit's fees add up to its total_fee", why: "no rule adds up values" }];
    await job(src, "check", { table: "permits", into: "permits_flags", rules, key: null, words: "no issued_on is after today; an ISSUED or FINALED permit has an issued_on; no permit is finaled before it is issued; a permit's fees add up to its total_fee", signature: "[]", madeBy, zone: "America/Los_Angeles", unchecked, wordsBy: madeBy }, "check-1");
    const kept = (db: HostDatabase) => JSON.parse(String(all(db, "SELECT value FROM _meta WHERE key = 'check:permits'")[0]!.value));

    const ex = value(await src.store.exportStart(src.me, { requestKey: "export-a-check" }));
    await finish(src.store, src.me, ex.job, clock);
    const { manifest } = value(await src.store.exportManifest(src.me, ex.exportId));
    const archive = new Uint8Array(await new Response(exportArchive(r2.asBucket(), manifest, "county").body).arrayBuffer());
    const dst = withJobs(B);
    const archiveId = await upload(dst.store, dst.me, r2, "county.tar", archive);
    const { job: imported } = value(await dst.store.importStart(dst.me, { fileId: archiveId, requestKey: "import-a-check" }));
    assert.equal((await finish(dst.store, dst.me, imported, clock)).state, "done");
    const there = kept(dst.db());
    assert.deepEqual([there.rules, there.zone, there.day, there.unchecked, there.wordsBy], [rules, "America/Los_Angeles", "2026-11-12", unchecked, madeBy]);

    const page = value(await dst.store.reviewRows(dst.me, { table: "permits", offset: 0, limit: 10 }));
    const rowNo = page.columns.indexOf("_row");
    assert.deepEqual(
      page.rows.map((r) => [r.cells[rowNo], r.flags.map((f) => f.problem)]),
      [
        ["2", ["issued_on is after today"]],
        ["1", ["issued_on is empty while status_code is ISSUED or FINALED"]],
        ["4", ["finaled_on is before issued_on"]],
      ],
    );
    // A day later, a fix there tests the row against that day, and the condition's column against the rule.
    clock.advance(24 * 3600_000);
    const first = page.rows.find((r) => r.cells[rowNo] === "1")!;
    const fixed = value(await dst.store.reviewFix(dst.me, { table: "permits", id: first.id, column: "status_code", was: "ISSUED", value: "APPLIED" }));
    assert.deepEqual(fixed.row.flags, []);
    const later = page.rows.find((r) => r.cells[rowNo] === "2")!;
    const tomorrow = value(await dst.store.reviewFix(dst.me, { table: "permits", id: later.id, column: "issued_on", was: "2062-07-04", value: "2026-11-13" }));
    assert.deepEqual(tomorrow.row.flags, [], "the 13th is today in Los Angeles by now");
    // The county wrote the wrong issue date: fixed, the permit was issued before it was finaled.
    const early = page.rows.find((r) => r.cells[rowNo] === "4")!;
    const reissued = value(await dst.store.reviewFix(dst.me, { table: "permits", id: early.id, column: "issued_on", was: "2023-05-10", value: "2023-03-10" }));
    assert.deepEqual(reissued.row.flags, [], "a fix of the other column tests the rule on finaled_on again");
  });
});

describe("what a review of the export and import found", () => {
  const tables = (db: HostDatabase) => all(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);

  /** A store from these statements and rows, and its export as one SQLite file. */
  async function small(r2: HostFiles, clock: FakeClock, schema: string, fill: (db: HostDatabase) => void = () => undefined, storeId = A) {
    const s = storeOn(r2, clock);
    const me = ME(storeId);
    value(await s.store.migrate(me, { id: "0000_first", sql: schema }));
    fill(s.db());
    const { job, exportId } = value(await s.store.exportStart(me, { requestKey: "whole" }));
    const done = await finish(s.store, me, job, clock);
    assert.equal(done.state, "done", done.error ?? "");
    const { manifest } = value(await s.store.exportManifest(me, exportId));
    return { ...s, me, bytes: fileBytes(r2, manifest) };
  }

  async function imported(r2: HostFiles, clock: FakeClock, bytes: Uint8Array, storeId = C) {
    const dst = storeOn(r2, clock);
    const me = ME(storeId);
    const fileId = await upload(dst.store, me, r2, "x.sqlite", bytes);
    const { job } = value(await dst.store.importStart(me, { fileId, requestKey: "imp" }));
    return { ...dst, me, fileId, job, done: await finish(dst.store, me, job, clock) };
  }

  it("leaves the store as it found it when an import is refused at its first chunk", async () => {
    const clock = new FakeClock();
    const r2 = filesOf();
    const src = await small(r2, clock, "CREATE TABLE t (id integer PRIMARY KEY);");
    const dst = storeOn(r2, clock);
    const me = ME(C);
    const fileId = await upload(dst.store, me, r2, "x.sqlite", src.bytes);
    const { job } = value(await dst.store.importStart(me, { fileId, requestKey: "imp" }));
    // The store is held from the moment the import is accepted.
    assert.equal(refusalCode(await dst.store.exec(me, { sql: "CREATE TABLE early (x)" })), "store_busy");
    assert.equal(refusalCode(await dst.store.importStart(me, { fileId, requestKey: "another" })), "store_busy");
    // Something that passed its check before the hold began lands anyway, before the first chunk.
    dst.db().exec("CREATE TABLE late (x)");
    const failed = await finish(dst.store, me, job, clock);
    assert.equal(failed.state, "failed");
    assert.match(failed.error ?? "", /empty store/);
    assert.deepEqual(tables(dst.db()), ["late"], "what the store held stays");
    value(await dst.store.exec(me, { sql: "CREATE TABLE after_it (x)" }));
  });

  it("answers a finished import's retry with its job, though its archive is gone", async () => {
    const clock = new FakeClock();
    const r2 = filesOf();
    const src = await small(r2, clock, "CREATE TABLE t (id integer PRIMARY KEY);");
    const dst = await imported(r2, clock, src.bytes);
    assert.equal(dst.done.state, "done", dst.done.error ?? "");
    const again = value(await dst.store.importStart(dst.me, { fileId: dst.fileId, requestKey: "imp" }));
    assert.equal(again.job.id, dst.job.id);
  });

  it("empties a store again after a failed import, parents with children and all, keeping a file deleted before it", async () => {
    const clock = new FakeClock();
    const r2 = filesOf();
    const src = storeOn(r2, clock);
    const me = ME(A);
    value(await src.store.migrate(me, { id: "0000_first", sql: "CREATE TABLE parents (id integer PRIMARY KEY);\n--> statement-breakpoint\nCREATE TABLE children (id integer PRIMARY KEY, up integer NOT NULL REFERENCES parents(id));" }));
    src.db().exec("INSERT INTO parents VALUES (1); INSERT INTO children VALUES (10, 1);");
    const fileId = await upload(src.store, me, r2, "a.txt", new TextEncoder().encode("bytes"));
    const ex = value(await src.store.exportStart(me, { requestKey: "copy:1", purpose: "copy", mode: "whole", personal: "keep" }));
    await finish(src.store, me, ex.job, clock);
    const dst = storeOn(r2, clock);
    const mine = ME(B);
    // A file this store deleted before the import keeps its 30 days.
    const kept = await upload(dst.store, mine, r2, "earlier.txt", new TextEncoder().encode("earlier"));
    value(await dst.store.fileDelete(mine, kept));
    const keptKey = String(dst.db().prepare("SELECT r2_key FROM _files WHERE id = ?").get(kept)!.r2_key);
    // The file's bytes go missing, so the import fails after its rows are in.
    for (const key of [...r2.objects.keys()]) if (key.includes(fileId)) r2.objects.delete(key);
    const { job } = value(await dst.store.importStart(mine, { from: { storeId: A, exportId: ex.exportId }, requestKey: "copy" }));
    const failed = await finish(dst.store, mine, job, clock);
    assert.equal(failed.state, "failed");
    assert.deepEqual(tables(dst.db()), []);
    assert.equal(dst.db().prepare("SELECT count(*) AS n FROM _files").get()!.n, 1, "only what the import brought is gone");
    assert.ok(r2.objects.has(keptKey), "and the earlier file's bytes stay");
    assert.ok(value(await dst.store.importCheck(mine, "another")) === null, "and the store can be tried again");
  });

  it("makes the unique indexes before the rows, for a foreign key that points at one", async () => {
    const clock = new FakeClock();
    const r2 = filesOf();
    const schema = "CREATE TABLE users (id integer PRIMARY KEY, public_id text NOT NULL);\n--> statement-breakpoint\nCREATE UNIQUE INDEX users_public ON users (public_id);\n--> statement-breakpoint\nCREATE TABLE posts (id integer PRIMARY KEY, author text NOT NULL REFERENCES users(public_id));";
    const src = await small(r2, clock, schema, (db) => db.exec("INSERT INTO users VALUES (1, 'u-1'); INSERT INTO posts VALUES (5, 'u-1');"));
    const dst = await imported(r2, clock, src.bytes);
    assert.equal(dst.done.state, "done", dst.done.error ?? "");
    assert.deepEqual(all(dst.db(), "SELECT * FROM posts"), [{ id: 5, author: "u-1" }]);
    assert.deepEqual(all(dst.db(), "SELECT name FROM sqlite_master WHERE name = 'users_public'"), [{ name: "users_public" }]);
  });

  it("loads rows that point at themselves, at later rows and at each other, however large", async () => {
    const clock = new FakeClock();
    const r2 = filesOf();
    const schema = [
      "CREATE TABLE tree (id integer PRIMARY KEY, up integer REFERENCES tree(id), payload blob);",
      "CREATE TABLE teams (id integer PRIMARY KEY, owner integer NOT NULL REFERENCES people(id));",
      "CREATE TABLE people (id integer PRIMARY KEY, team integer NOT NULL REFERENCES teams(id));",
    ].join("\n--> statement-breakpoint\n");
    const big = new Uint8Array(1_800_000).map((_, i) => i % 251);
    const src = await small(r2, clock, schema, (db) => {
      db.exec("PRAGMA defer_foreign_keys = ON");
      db.exec("BEGIN");
      db.prepare("INSERT INTO tree VALUES (7, 7, NULL)").run();
      db.prepare("INSERT INTO tree VALUES (1, 2, ?)").run(big);
      db.prepare("INSERT INTO tree VALUES (2, 3, NULL)").run();
      db.prepare("INSERT INTO tree VALUES (3, 7, NULL)").run();
      db.exec("INSERT INTO teams VALUES (1, 1); INSERT INTO people VALUES (1, 1);");
      db.exec("COMMIT");
    });
    const dst = await imported(r2, clock, src.bytes);
    assert.equal(dst.done.state, "done", dst.done.error ?? "");
    assert.deepEqual(all(dst.db(), "PRAGMA foreign_key_check"), []);
    assert.deepEqual(all(dst.db(), "SELECT id, up, length(payload) AS n FROM tree ORDER BY id"), [
      { id: 1, up: 2, n: big.byteLength },
      { id: 2, up: 3, n: null },
      { id: 3, up: 7, n: null },
      { id: 7, up: 7, n: null },
    ]);
    assert.deepEqual(all(dst.db(), "SELECT * FROM people"), [{ id: 1, team: 1 }]);
    assert.equal(tables(dst.db()).includes("_import_pending"), false);
  });

  it("refuses rows that point at nothing, and says how many waited", async () => {
    const clock = new FakeClock();
    const r2 = filesOf();
    const src = await small(r2, clock, "CREATE TABLE a (id integer PRIMARY KEY, up integer REFERENCES a(id));", (db) => {
      db.exec("PRAGMA foreign_keys = OFF; INSERT INTO a VALUES (1, 99); PRAGMA foreign_keys = ON;");
    });
    const dst = await imported(r2, clock, src.bytes);
    assert.equal(dst.done.state, "failed");
    assert.match(dst.done.error ?? "", /Of 1 row that waited/);
  });

  it("skips SQLite's lock-byte page, and an overflow chain that crosses it says so", () => {
    const page = new Uint8Array(4096);
    const out = new PageOut(262_144);
    assert.equal(out.emit(page), 262_144);
    assert.equal(out.upcoming, 262_146);
    assert.equal(out.emit(page), 262_146);
    assert.equal(out.pending, 3, "the lock-byte page is a page of the file, and empty");
    const chain = new PageOut(262_143);
    new TableTree().add(1, [new Uint8Array(20_000)], chain);
    assert.equal(u32(chain.pages[0]!, 0), 262_144);
    assert.equal(u32(chain.pages[1]!, 0), 262_146, "the page after 262,144 is 262,146");
    assert.deepEqual([...chain.pages[2]!], Array.from({ length: 4096 }, () => 0));
    assert.equal(u32(chain.pages[3]!, 0), 262_147);
  });

  it("keeps a schema of one row too large for page 1", () => {
    const out = new PageOut();
    const root = new TableTree().finish(out);
    const sql = `CREATE TABLE t (a, b${" ".repeat(3_980)})`;
    const { page1 } = finishFile([{ type: "table", name: "t", tableName: "t", rootPage: root, sql }], out);
    const rest = out.take();
    const file = new Uint8Array(page1.byteLength + rest.byteLength);
    file.set(page1, 0);
    file.set(rest, page1.byteLength);
    const db = opened(file);
    assert.deepEqual(all(db, "PRAGMA integrity_check"), [{ integrity_check: "ok" }]);
    assert.deepEqual(all(db, "SELECT count(*) AS n FROM t"), [{ n: 0 }]);
  });

  it("keeps a byte-order mark at the start of a text", () => {
    assert.deepEqual(decodeRecord(encodeRecord(["\uFEFFhello"])), ["\uFEFFhello"]);
  });

  describe("a tar", () => {
    const source = (bytes: Uint8Array) => ({ size: bytes.byteLength, read: async (at: number, n: number) => bytes.subarray(at, at + n) });
    function tar(entries: { path: string; bytes: Uint8Array }[]): Uint8Array {
      const parts: Uint8Array[] = [];
      for (const e of entries) parts.push(tarHeader(e.path, e.bytes.byteLength, 0), e.bytes, new Uint8Array(tarPadding(e.bytes.byteLength)));
      parts.push(TAR_END);
      const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.byteLength;
      }
      return out;
    }

    it("reads a long name whatever characters it holds, by each record's own length", async () => {
      const name = `a\u2028${"b".repeat(150)}.txt`;
      const id = "fil_0123456789abcdef01234567";
      const found = await readTar(source(tar([{ path: `files/${id}/${name}`, bytes: new Uint8Array(3) }])));
      assert.equal(found.files.get(id)?.name, name);
      assert.equal(found.files.get(id)?.size, 3);
    });

    it("takes the SQLite file among others with its suffix", async () => {
      const real = new Uint8Array(4096);
      real.set(new TextEncoder().encode("SQLite format 3\u0000"), 0);
      const found = await readTar(source(tar([{ path: "._x.sqlite", bytes: new Uint8Array(15) }, { path: "Thumbs.db", bytes: new Uint8Array(500) }, { path: "x.sqlite", bytes: real }])));
      assert.equal(found.db?.name, "x.sqlite");
    });

    it("shortens a name a file system could not hold, by its bytes, and keeps its extension", () => {
      const name = `${"é".repeat(130)}.pdf`;
      const short = archiveFileName(name);
      assert.ok(new TextEncoder().encode(short).byteLength <= 240);
      assert.ok(short.endsWith(".pdf"));
      assert.equal(archiveFileName("plain.pdf"), "plain.pdf");
    });
  });

  it("replaces personal values in WITHOUT ROWID tables and in the keys tied to them, follows a key whatever its case, and walks a long chain", async () => {
    const clock = new FakeClock();
    const r2 = filesOf();
    const schema = [
      "CREATE TABLE people (email text personal PRIMARY KEY, nick text) WITHOUT ROWID;",
      "CREATE TABLE contacts (id integer PRIMARY KEY, who text NOT NULL REFERENCES People(email));",
      "CREATE TABLE steps (id integer PRIMARY KEY, prev integer REFERENCES steps(id));",
    ].join("\n--> statement-breakpoint\n");
    const src = storeOn(r2, clock);
    const me = ME(A);
    value(await src.store.migrate(me, { id: "0000_first", sql: schema }));
    const db = src.db();
    db.exec("INSERT INTO people VALUES ('ann@real.example', 'Ann'); INSERT INTO contacts VALUES (1, 'ann@real.example');");
    db.exec("INSERT INTO steps VALUES (1, NULL)");
    const step = db.prepare("INSERT INTO steps VALUES (?, ?)");
    for (let i = 2; i <= 6_500; i++) step.run(i, i - 1);
    const ex = value(await src.store.exportStart(me, { requestKey: "copy:1", purpose: "copy", mode: "sample", personal: "replace" }));
    assert.equal(String(all(db, "SELECT params FROM _jobs")[0]!.params).includes('"key"'), false, "a copy's key stays out of the job's params");
    const done = await finish(src.store, me, ex.job, clock);
    assert.equal(done.state, "done", done.error ?? "");
    const dst = storeOn(r2, clock);
    const mine = ME(B);
    const { job } = value(await dst.store.importStart(mine, { from: { storeId: A, exportId: ex.exportId }, requestKey: "copy" }));
    const loaded = await finish(dst.store, mine, job, clock);
    assert.equal(loaded.state, "done", loaded.error ?? "");
    const copy = dst.db();
    const [person] = all(copy, "SELECT email, nick FROM people");
    assert.match(String(person!.email), /^person-[0-9a-f]{12}@example\.com$/);
    assert.deepEqual(all(copy, "SELECT who FROM contacts"), [{ who: person!.email }]);
    assert.deepEqual(all(copy, "PRAGMA foreign_key_check"), []);
    assert.equal(copy.prepare("SELECT count(*) AS n FROM steps").get()!.n, 6_500, "every step the newest ones point back to came too");
    const row = all(db, "SELECT run_state FROM _jobs")[0]!;
    assert.equal(row.run_state, null, "a finished job keeps no working state");
  });

  it("brings a sample's newest files up to 1 GiB, and says how many it left out", async () => {
    const clock = new FakeClock();
    const r2 = filesOf();
    const src = storeOn(r2, clock);
    const me = ME(A);
    value(await src.store.migrate(me, { id: "0000_first", sql: "CREATE TABLE notes (id integer PRIMARY KEY, file text);" }));
    const db = src.db();
    const old = "fil_00000000000000000000aaaa";
    const fresh = "fil_00000000000000000000bbbb";
    const insert = db.prepare("INSERT INTO _files (id, name, size, content_type, state, received_at, received_by, via, r2_key) VALUES (?, ?, ?, 'text/plain', 'ready', ?, 'user:u-1', 'api', ?)");
    insert.run(old, "old.bin", 900 * 1024 * 1024, "2026-01-01T00:00:00.000Z", `stores/${A}/files/${old}/old.bin`);
    insert.run(fresh, "new.bin", 900 * 1024 * 1024, "2026-06-01T00:00:00.000Z", `stores/${A}/files/${fresh}/new.bin`);
    db.prepare("INSERT INTO notes VALUES (1, ?), (2, ?)").run(old, fresh);
    const ex = value(await src.store.exportStart(me, { requestKey: "copy:1", purpose: "copy", mode: "sample", personal: "replace" }));
    const done = await finish(src.store, me, ex.job, clock);
    assert.equal(done.state, "done", done.error ?? "");
    const { manifest } = value(await src.store.exportManifest(me, ex.exportId));
    assert.deepEqual(manifest.files.map((f) => f.id), [fresh]);
    assert.equal(manifest.filesLeftOut, 1);
  });

  it("refuses to copy a virtual table before it reads the store", async () => {
    const clock = new FakeClock();
    const r2 = filesOf();
    const src = storeOn(r2, clock);
    const me = ME(A);
    value(await src.store.migrate(me, { id: "0000_first", sql: "CREATE VIRTUAL TABLE docs USING fts5(body);" }));
    const ex = value(await src.store.exportStart(me, { requestKey: "copy:1", purpose: "copy", mode: "whole", personal: "replace" }));
    const done = await finish(src.store, me, ex.job, clock);
    assert.equal(done.state, "failed");
    assert.match(done.error ?? "", /virtual table/);
    const dst = storeOn(r2, clock);
    const { job } = value(await dst.store.importStart(ME(B), { from: { storeId: A, exportId: ex.exportId }, requestKey: "copy" }));
    const failed = await finish(dst.store, ME(B), job, clock);
    assert.equal(failed.state, "failed");
    assert.match(failed.error ?? "", /virtual table/, "the store waiting for it says why");
  });

  it("refuses a trigger on the store's own tables, however it is quoted", async () => {
    const clock = new FakeClock();
    const r2 = filesOf();
    // A file that says the trigger is on `x`, while its text says otherwise.
    const out = new PageOut();
    const root = new TableTree().finish(out);
    const { page1 } = finishFile(
      [
        { type: "table", name: "x", tableName: "x", rootPage: root, sql: "CREATE TABLE x (id integer PRIMARY KEY)" },
        { type: "trigger", name: "carrier", tableName: "x", rootPage: 0, sql: "CREATE TRIGGER carrier AFTER UPDATE ON '_tables' BEGIN UPDATE x SET id = 0; END" },
      ],
      out,
    );
    const rest = out.take();
    const crafted = new Uint8Array(page1.byteLength + rest.byteLength);
    crafted.set(page1, 0);
    crafted.set(rest, page1.byteLength);
    const dst = await imported(r2, clock, crafted);
    assert.equal(dst.done.state, "failed");
    assert.match(dst.done.error ?? "", /_tables/);
  });

  describe("a store held by an export", () => {
    const signIn = (sub: string, email: string, session: string) => ({
      identity: { issuer: "https://id.example", sub, email, emailVerified: true, name: "A Person" },
      whoOpens: "users" as const,
      join: { mode: "link" as const, domains: [] as string[] },
      defaultRole: "Viewer",
      authorRole: "Owner",
      author: false,
      session: { id: session, days: 7 },
    });

    /** A store with one person, whose export has taken the hold and stopped between chunks. */
    async function held() {
      const clock = new FakeClock();
      const r2 = filesOf();
      const s = storeOn(r2, clock);
      const me = ME(A);
      value(await s.store.migrate(me, { id: "0000_first", sql: "CREATE TABLE t (id integer PRIMARY KEY);" }));
      const first = value(await s.store.appSignIn(me, signIn("sub-1", "one@example.com", "a".repeat(64) as never) as never));
      assert.equal(first.ok, true);
      const { job } = value(await s.store.exportStart(me, { requestKey: "export" }));
      s.db().exec("INSERT INTO _meta (key, value) VALUES ('held', '" + JSON.stringify({ job: job.id, what: "export", loading: false }) + "')");
      return { ...s, me, job, clock, r2 };
    }

    it("still takes a restore, a returning person's sign-in, a session's end, and a new job in the queue", async () => {
      const { store, me, db } = await held();
      assert.equal(refusalCode(await store.exec(me, { sql: "CREATE TABLE u (x)" })), "store_busy");
      const again = value(await store.appSignIn(me, signIn("sub-1", "one@example.com", "b".repeat(64) as never) as never));
      assert.equal(again.ok, true, "a returning person signs in");
      assert.equal(refusalCode(await store.appSignIn(me, signIn("sub-2", "two@example.com", "c".repeat(64) as never) as never)), "store_busy", "someone new tries again in a moment");
      value(await store.appSessionEnd(me, { id: "b".repeat(64) }));
      assert.equal(all(db(), "SELECT revoked_at IS NOT NULL AS ended FROM _sessions WHERE id = '" + "b".repeat(64) + "'")[0]!.ended, 1);
      assert.equal(refusalCode(await store.jobSubmit(me, { kind: "nothing", params: {}, requestKey: "later" })), "job_kind_unknown", "a new job would wait its turn");
      // The hold lets a restore through to the store's own answer: what is wrong with the request, or, on a host that keeps no bookmarks, that there is no moment to return to.
      assert.equal(refusalCode(await store.restore(me, { at: "not a time" })), host().traits.bookmarks ? "bad_request" : "restore_unavailable", "a restore is not refused by the hold");
    });

    it("counts a chunk that never returned, and ends its hold after three", async () => {
      const { store, me, db, job } = await held();
      db().prepare("UPDATE _jobs SET state = 'running', tries = 3 WHERE id = ?").run(job.id);
      await store.alarm();
      const ended = value(await store.job(me, job.id)).job;
      assert.equal(ended.state, "failed");
      assert.match(ended.error ?? "", /three times/);
      assert.equal(value(await store.jobSummary(me, job.id)).summary.refusal, "chunk_failed", "its summary says so by a code");
      value(await store.exec(me, { sql: "CREATE TABLE after_it (x)" }));
    });
  });

  it("is refused past the day's write limit before the source is held", async () => {
    const clock = new FakeClock();
    const r2 = filesOf();
    const s = storeOn(r2, clock, { STORE_DAILY_WRITE_LIMIT: "1000" });
    const me = ME(A);
    value(await s.store.exec(me, { sql: "CREATE TABLE t (n INTEGER)" }));
    value(await s.store.exec(me, { sql: "INSERT INTO t SELECT value FROM json_each(?)", params: [JSON.stringify(Array.from({ length: 1_100 }, (_, i) => i))] }));
    s.db().exec("DROP TABLE t");
    assert.equal(refusalCode(await s.store.importCheck(me, "copy")), "write_limit_reached");
  });
});
