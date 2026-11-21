// What settles in a store (events.ts): a batch of files is one event once its newest file is
// FILES_SETTLE_MS old and none of it still arrives; one caller's deletes close together are one
// event; a job is an event as it ends, with its summary and its run; a person's fixes of a table
// are one event once they stop. Each stream answers an event once: the next read from `through`
// does not hold it again.

import { describe, it, host, stateOf, filesOf } from "../testing/suite/host.js";
import { countingHex, FakeClock } from "../testing/suite/stand-ins.js";
import assert from "node:assert/strict";

import type { StoreDeps } from "./core.js";
import { DELETES_SETTLE_MS, FILES_SETTLE_MS, FIXES_SETTLE_MS, UPLOAD_HOLD_MS } from "./events.js";
import { StoreHandler } from "./handler.js";
import type { StoreCaller, StoreEvent, StoreEvents, StoreResult } from "./types.js";

const A = "sto_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const ME: StoreCaller = { storeId: A, actor: "user:u-1" };

function setup() {
  const clock = new FakeClock();
  const storage = host().storage();
  storage.now = clock.now;
  const r2 = filesOf();
  const deps: StoreDeps = { now: clock.now, randomHex: countingHex, jobs: new Map() };
  const store = new StoreHandler(stateOf(storage) as never, { FILES: r2.asBucket() }, deps);
  return { clock, storage, r2, store };
}

function value<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
}

type Setup = ReturnType<typeof setup>;

/** Begins an upload of a small file in `batch`; `finish` makes it whole. */
async function begin(s: Setup, name: string, opts: { batch?: string; folderId?: string; caller?: StoreCaller } = {}): Promise<{ id: string; finish: () => Promise<void> }> {
  const caller = opts.caller ?? ME;
  const created = value(await s.store.fileCreate(caller, { name, size: 3, ...(opts.batch ? { batch: opts.batch } : {}), ...(opts.folderId ? { folderId: opts.folderId } : {}) }));
  return {
    id: created.file.id,
    finish: async () => {
      const target = value(await s.store.filePartTarget(caller, created.file.id, 1));
      const part = await s.r2.resumeMultipartUpload(target.key, target.uploadId).uploadPart(1, "abc");
      value(await s.store.fileComplete(caller, created.file.id, { parts: [{ n: 1, etag: part.etag }] }));
    },
  };
}

async function upload(s: Setup, name: string, opts: { batch?: string; folderId?: string } = {}): Promise<string> {
  const file = await begin(s, name, opts);
  await file.finish();
  return file.id;
}

const read = async (s: Setup, since: StoreEvents["through"] | Record<string, never> = {}): Promise<StoreEvents> => value(await s.store.events(ME, { since }));
const ofKind = <K extends StoreEvent["kind"]>(events: StoreEvents, kind: K): Extract<StoreEvent, { kind: K }>[] =>
  events.events.filter((e): e is Extract<StoreEvent, { kind: K }> => e.kind === kind);

describe("a store's events", () => {
  it("answers two people's fixes of one table as two events, each by its person", async () => {
    const s = setup();
    await s.store.files(ME);
    const fix = (change: number, by: string) =>
      s.storage.sql.exec(
        "INSERT INTO _deltas (change, tbl, version, whole, added, changed, removed, kept, job, at, by_sub) VALUES (?, 'permits', 3, 0, 0, 1, 0, 1, NULL, ?, ?)",
        change,
        new Date(s.clock.now()).toISOString(),
        by,
      );
    fix(1, "user:ana");
    fix(2, "user:ana");
    s.clock.advance(30_000);
    fix(3, "user:ben");
    s.clock.advance(FIXES_SETTLE_MS + 1);
    const fixes = ofKind(await read(s), "fix");
    assert.deepEqual(fixes.map((f) => [f.by, f.fixes]), [
      ["user:ana", 2],
      ["user:ben", 1],
    ]);
  });

  it("answers a batch that keeps arriving once it held the window HOLD_MAX_MS, as it stands", async () => {
    const s = setup();
    await upload(s, "first.csv", { batch: "bat_long" });
    let since = (await read(s)).through;
    // A file always on its way: each begins before the one before it is whole.
    let open = await begin(s, "next-0.csv", { batch: "bat_long" });
    const answered: string[][] = [];
    for (let i = 1; i <= 20; i++) {
      s.clock.advance(60_000);
      const next = await begin(s, `next-${i}.csv`, { batch: "bat_long" });
      await open.finish();
      open = next;
      const r = await read(s, since);
      answered.push(...ofKind(r, "files").map((e) => e.files.map((f) => f.name)));
      since = r.through;
    }
    assert.ok(answered.length >= 1, "answered while it still arrives");
    assert.ok(answered[0]!.includes("first.csv"));
  });

  it("answers a batch of files once it settled, whole, with its folders, and only once", async () => {
    const s = setup();
    const invoices = value(await s.store.folderCreate(ME, { name: "Invoices" })).folder;
    const nov = value(await s.store.folderCreate(ME, { name: "November", parentId: invoices.id })).folder;
    const first = await upload(s, "a.csv", { batch: "bat_1", folderId: nov.id });
    s.clock.advance(5_000);
    const second = await upload(s, "b.csv", { batch: "bat_1", folderId: nov.id });

    // Its newest file arrived a moment ago: it settles first.
    const early = await read(s);
    assert.deepEqual(ofKind(early, "files"), []);
    assert.equal(early.settling, true);

    s.clock.advance(FILES_SETTLE_MS);
    const settled = await read(s, early.through);
    const [batch] = ofKind(settled, "files");
    assert.ok(batch, "the batch is an event");
    // The batch and its newest file: a file that joins it later is a new event.
    assert.equal(batch.key, `bat_1:${second}`);
    assert.equal(batch.by, "user:u-1");
    assert.equal(batch.via, "page");
    assert.equal(batch.count, 2);
    assert.deepEqual(
      batch.files.map((f) => [f.id, f.name, f.size, f.folderId]),
      [
        [first, "a.csv", 3, nov.id],
        [second, "b.csv", 3, nov.id],
      ],
    );
    // The files' folder, then every folder above it.
    assert.deepEqual(batch.folders, ["November", "Invoices"]);

    // A read from where that one ended holds it no more.
    s.clock.advance(60_000);
    assert.deepEqual(ofKind(await read(s, settled.through), "files"), []);
  });

  it("answers a file with no batch as its own event, keyed by the file", async () => {
    const s = setup();
    const id = await upload(s, "alone.pdf");
    s.clock.advance(FILES_SETTLE_MS + 1);
    const [one] = ofKind(await read(s), "files");
    assert.equal(one?.key, id);
    assert.equal(one?.count, 1);
  });

  it("holds a batch while one of its files still arrives, and answers it whole once that file is in", async () => {
    const s = setup();
    await upload(s, "a.csv", { batch: "bat_2" });
    const slow = await begin(s, "big.zip", { batch: "bat_2" });
    s.clock.advance(FILES_SETTLE_MS * 4);
    const waiting = await read(s);
    assert.deepEqual(ofKind(waiting, "files"), []);
    assert.equal(waiting.settling, true);

    await slow.finish();
    s.clock.advance(FILES_SETTLE_MS + 1);
    const whole = ofKind(await read(s, waiting.through), "files");
    assert.equal(whole.length, 1);
    assert.deepEqual(whole[0]!.files.map((f) => f.name), ["a.csv", "big.zip"]);
  });

  it("stops holding a batch for an upload nobody finishes", async () => {
    const s = setup();
    await upload(s, "a.csv", { batch: "bat_3" });
    await begin(s, "never.zip", { batch: "bat_3" });
    s.clock.advance(FILES_SETTLE_MS + 1);
    const held = await read(s);
    assert.deepEqual(ofKind(held, "files"), []);
    s.clock.advance(UPLOAD_HOLD_MS);
    const after = ofKind(await read(s, held.through), "files");
    assert.deepEqual(after.map((e) => e.files.map((f) => f.name)), [["a.csv"]]);
  });

  it("answers a file that joins a batch after the batch was answered as a new event, with the whole batch", async () => {
    const s = setup();
    await upload(s, "a.csv", { batch: "bat_4" });
    s.clock.advance(FILES_SETTLE_MS + 1);
    const first = await read(s);
    assert.equal(ofKind(first, "files").length, 1);
    s.clock.advance(UPLOAD_HOLD_MS);
    const late = await upload(s, "late.csv", { batch: "bat_4" });
    s.clock.advance(FILES_SETTLE_MS + 1);
    const again = ofKind(await read(s, first.through), "files");
    assert.deepEqual(again.map((e) => [e.key, e.files.map((f) => f.name)]), [[`bat_4:${late}`, ["a.csv", "late.csv"]]]);
  });

  it("never splits a person's deletes when another person's still settle: each is answered whole, once", async () => {
    const s = setup();
    const ids = [];
    for (const name of ["a1.csv", "a2.csv", "b1.csv", "b2.csv"]) ids.push(await upload(s, name));
    s.clock.advance(FILES_SETTLE_MS + 1);
    let since = (await read(s)).through;
    const tom: StoreCaller = { storeId: A, actor: "user:u-2" };
    // u-1 deletes at 0 s and 20 s; u-2 at 10 s and 35 s: u-1's burst settles first, inside u-2's.
    value(await s.store.fileDelete(ME, ids[0]!));
    s.clock.advance(10_000);
    value(await s.store.fileDelete(tom, ids[2]!));
    s.clock.advance(10_000);
    value(await s.store.fileDelete(ME, ids[1]!));
    s.clock.advance(15_000);
    value(await s.store.fileDelete(tom, ids[3]!));
    const answered: string[][] = [];
    for (let i = 0; i < 4; i++) {
      s.clock.advance(20_000);
      const r = await read(s, since);
      answered.push(...ofKind(r, "deleted").map((e) => e.files.map((f) => f.name)));
      since = r.through;
    }
    assert.deepEqual(answered, [
      ["a1.csv", "a2.csv"],
      ["b1.csv", "b2.csv"],
    ]);
  });

  it("answers one caller's deletes close together as one event, once they stop", async () => {
    const s = setup();
    const a = await upload(s, "a.csv");
    const b = await upload(s, "b.csv");
    s.clock.advance(FILES_SETTLE_MS + 1);
    const arrived = await read(s);
    value(await s.store.fileDelete(ME, a));
    s.clock.advance(4_000);
    value(await s.store.fileDelete(ME, b));
    const early = await read(s, arrived.through);
    assert.deepEqual(ofKind(early, "deleted"), []);
    s.clock.advance(DELETES_SETTLE_MS + 1);
    const [deleted] = ofKind(await read(s, early.through), "deleted");
    assert.ok(deleted);
    assert.equal(deleted.by, "user:u-1");
    assert.equal(deleted.count, 2);
    assert.deepEqual(deleted.files.map((f) => f.name), ["a.csv", "b.csv"]);
    assert.deepEqual(deleted.folders, ["Uploads"]);
  });

  it("answers a job as it ends, with its summary and the run that made it", async () => {
    const s = setup();
    // A load that ended, as the runner leaves its row.
    await s.store.files(ME);
    const at = new Date(s.clock.now()).toISOString();
    s.storage.sql.exec(
      `INSERT INTO _jobs (id, kind, request_key, state, params, result, by_sub, created_at, updated_at) VALUES (?, 'load', 'k-1', 'done', ?, ?, 'run:run_7', ?, ?)`,
      "job_1",
      JSON.stringify({ madeBy: { runId: "run_7", step: "s2" } }),
      JSON.stringify({ tables: [{ table: "permits", version: 2, rows: 40, changes: { added: 3, changed: 1, removed: 0 } }] }),
      at,
      at,
    );
    s.storage.sql.exec("INSERT INTO _history (id, at, kind, by_sub, note, ref) VALUES ('his_1', ?, 'job', 'run:run_7', 'load finished: wrote 40 rows', 'job_1')", at);
    // A job still open is no event, whatever its history says.
    s.storage.sql.exec(
      `INSERT INTO _jobs (id, kind, request_key, state, params, by_sub, created_at, updated_at) VALUES ('job_2', 'load', 'k-2', 'running', '{}', 'user:u-1', ?, ?)`,
      at,
      at,
    );
    s.storage.sql.exec("INSERT INTO _history (id, at, kind, by_sub, note, ref) VALUES ('his_2', ?, 'job', 'user:u-1', 'load waits where it stopped', 'job_2')", at);
    const jobs = ofKind(await read(s), "job");
    assert.deepEqual(jobs.map((j) => j.key), ["job_1"]);
    const [job] = jobs;
    assert.ok(job);
    assert.equal(job.key, "job_1");
    assert.equal(job.runId, "run_7");
    assert.equal(job.by, "run:run_7");
    assert.equal(job.summary.kind, "load");
    assert.equal(job.summary.state, "done");
    assert.deepEqual(job.summary.tables.map((t) => [t.table, t.version, t.rows, t.counts.added, t.counts.changed]), [["permits", 2, 40, 3, 1]]);
  });

  it("answers a person's fixes of a table as one event once they stop", async () => {
    const s = setup();
    await s.store.files(ME);
    const fix = (change: number) =>
      s.storage.sql.exec(
        "INSERT INTO _deltas (change, tbl, version, whole, added, changed, removed, kept, job, at, by_sub) VALUES (?, 'permits', 3, 0, 0, 1, 0, 1, NULL, ?, 'user:u-2')",
        change,
        new Date(s.clock.now()).toISOString(),
      );
    fix(1);
    s.clock.advance(60_000);
    fix(2);
    const early = await read(s);
    assert.deepEqual(ofKind(early, "fix"), []);
    assert.equal(early.settling, true);
    s.clock.advance(FIXES_SETTLE_MS + 1);
    const [fixed] = ofKind(await read(s, early.through), "fix");
    assert.ok(fixed);
    assert.equal(fixed.table, "permits");
    assert.equal(fixed.fixes, 2);
    assert.equal(fixed.changed, 2);
    assert.equal(fixed.by, "user:u-2");
    assert.equal(fixed.key, `permits@${fixed.at}:user:u-2`);
  });
});
