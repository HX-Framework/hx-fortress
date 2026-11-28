// A store's file read as tables in the store's own object (file-tables.ts), for its preview: LOAD's
// readers open an .xlsx workbook, an .ods, an Access database and a FoxPro table with the database
// container of its upload, from the bucket by range, list every table with its columns, and give the
// first rows of the one asked for. A file of another kind, one still uploading, one that is gone and
// one that is damaged are refused in words, before or instead of a read.

import { describe, host, itWhere, stateOf, filesOf } from "../testing/suite/host.js";
import { countingHex, FakeClock } from "../testing/suite/stand-ins.js";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { StoreDeps } from "./core.js";
import { StoreHandler } from "./handler.js";
import { FILE_TABLE_ROWS, type StoreCaller, type StoreResult } from "./types.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "store-readers", "fixtures");
const STORE = "sto_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PERSON: StoreCaller = { storeId: STORE, actor: "user:u-1", org: "org-1" };

function setup() {
  const clock = new FakeClock();
  const storage = host().storage();
  storage.now = clock.now;
  const state = stateOf(storage);
  const r2 = filesOf();
  const ranges: Array<{ offset: number; length: number }> = [];
  const bucket = r2.asBucket();
  // Every read of a file's bytes, so a test can say the file was read by range, never whole.
  const counted = new Proxy(bucket, {
    get(target, prop, receiver) {
      if (prop !== "get") return Reflect.get(target, prop, receiver);
      return (key: string, opts?: { range?: { offset: number; length: number } }) => {
        if (opts?.range) ranges.push(opts.range);
        return target.get(key, opts as never);
      };
    },
  });
  const deps: StoreDeps = { now: clock.now, randomHex: countingHex, jobs: new Map() };
  const store = new StoreHandler(state as never, { FILES: counted }, deps);
  return { r2, store, ranges };
}

function value<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
}

function refusal<T>(result: StoreResult<T>): { status: number; code: string; error: string } {
  assert.equal(result.ok, false, "expected a refusal");
  return result as { status: number; code: string; error: string };
}

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)));

/** `it`, for a test that reads sample files: listed as skipped where one of them is missing. */
function sampled(...names: string[]) {
  const missing = names.find((name) => !existsSync(join(FIXTURES, name)));
  return itWhere(missing === undefined, `this copy of the suite has no sample file ${missing}`);
}

/** A file put into the store as a page puts it: one part, in one upload (`batch`) when named. */
async function upload(s: ReturnType<typeof setup>, name: string, bytes: Uint8Array, opts: { batch?: string; complete?: boolean } = {}): Promise<string> {
  const created = value(await s.store.fileCreate(PERSON, { name, size: bytes.byteLength, contentType: "application/octet-stream", ...(opts.batch ? { batch: opts.batch } : {}) }));
  if (opts.complete === false) return created.file.id;
  const target = value(await s.store.filePartTarget(PERSON, created.file.id, 1));
  const part = await s.r2.resumeMultipartUpload(target.key, target.uploadId).uploadPart(1, bytes);
  value(await s.store.fileComplete(PERSON, created.file.id, { parts: [{ n: 1, etag: part.etag }] }));
  return created.file.id;
}

describe("a file's tables, read in the store's object", () => {
  sampled("permits.xlsx")("lists a workbook's sheets and gives the first rows of the first, reading the file by range", async () => {
    const s = setup();
    const id = await upload(s, "permits.xlsx", fixture("permits.xlsx"));
    s.ranges.length = 0;
    const read = value(await s.store.fileTables(PERSON, id, {}));
    assert.ok(read.tables.length >= 1, "a sheet");
    assert.equal(read.table, 0);
    assert.ok(read.tables[0]!.columns.length > 0, "the sheet's columns");
    assert.ok(read.rows.length > 0 && read.rows.length <= FILE_TABLE_ROWS, "its first rows");
    assert.ok(read.rows.every((row) => row.every((cell) => cell === null || typeof cell === "string")), "every value is text");
    assert.ok(s.ranges.length > 0, "the file was read from the bucket by range");
  });

  sampled("permits-libre.ods")("reads an OpenDocument workbook the same way", async () => {
    const s = setup();
    const id = await upload(s, "permits-libre.ods", fixture("permits-libre.ods"));
    const read = value(await s.store.fileTables(PERSON, id, { table: 0 }));
    assert.ok(read.tables.length >= 1);
    assert.ok(read.rows.length > 0);
  });

  sampled("permits-2010.accdb")("gives the rows of the table asked for, and the first table's when the one asked for is not there", async () => {
    const s = setup();
    const id = await upload(s, "permits-2010.accdb", fixture("permits-2010.accdb"));
    const second = value(await s.store.fileTables(PERSON, id, { table: 1 }));
    assert.deepEqual(
      second.tables.map((t) => t.name),
      ["Permits", "Owners", "Wide"],
    );
    assert.equal(second.table, 1);
    assert.equal(second.rows.length, 3);
    assert.equal(second.more, false);
    for (const asked of [7, -1, 1.5]) assert.equal(value(await s.store.fileTables(PERSON, id, { table: asked })).table, 0);
  });

  sampled("wrenfield.dbc", "bldgperm.dbf")("reads a FoxPro table with its upload's database container, so it shows the long names LOAD makes", async () => {
    const s = setup();
    await upload(s, "wrenfield.dbc", fixture("wrenfield.dbc"), { batch: "bat_1" });
    const id = await upload(s, "bldgperm.dbf", fixture("bldgperm.dbf"), { batch: "bat_1" });
    const read = value(await s.store.fileTables(PERSON, id, {}));
    assert.deepEqual(read.tables, [
      { name: "building_permits", columns: ["permit_number", "application_date", "parcel_identifier", "contractor_license_number", "permit_fee_amount", "work_description"], rows: 8 },
    ]);
    assert.deepEqual(read.rows[0], ["BP-2019-00412", "2019-03-04", "14-106-014", "WC-88213", "245.50", "Detached garage, 24 x 30"]);
  });

  describe("refuses", () => {
    sampled("permits.xlsx")("a file of another kind, one still uploading and one it does not have, before reading any of them", async () => {
      const s = setup();
      const notes = await upload(s, "notes.txt", new TextEncoder().encode("abc"));
      const arriving = await upload(s, "later.xlsx", fixture("permits.xlsx"), { complete: false });
      s.ranges.length = 0;
      const kind = refusal(await s.store.fileTables(PERSON, notes, {}));
      assert.deepEqual([kind.status, kind.code], [400, "file_not_tables"]);
      assert.match(kind.error, /notes\.txt is not a workbook, a database or a Parquet file/);
      const early = refusal(await s.store.fileTables(PERSON, arriving, {}));
      assert.deepEqual([early.status, early.code], [409, "file_not_ready"]);
      assert.match(early.error, /later\.xlsx is still uploading/);
      const gone = refusal(await s.store.fileTables(PERSON, "fil_00000000000000000000000000000000", {}));
      assert.deepEqual([gone.status, gone.code], [404, "file_not_found"]);
      assert.deepEqual(s.ranges, [], "nothing was read");
    });

    sampled("permits.xlsx")("a workbook cut short, in the readers' words", async () => {
      const s = setup();
      // The readers tell a kind by its bytes first, so the bytes must start as a workbook's: its
      // first two kilobytes, without the zip's directory at its end.
      const id = await upload(s, "broken.xlsx", fixture("permits.xlsx").subarray(0, 2048));
      const broken = refusal(await s.store.fileTables(PERSON, id, {}));
      assert.deepEqual([broken.status, broken.code], [422, "file_unreadable"]);
      assert.ok(broken.error.length > 0);
    });
  });
});
