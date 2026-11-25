import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { StoreFiles } from "../../../src/modules/stores/engine/store-object/src/store-files.js";
import { diskFiles, DiskFilesFailed, removeFileDrafts } from "../../../src/modules/stores/host/disk-files";
import { cleanFolders, tempFolder } from "./_rig";

afterEach(cleanFolders);

/** A folder for an organization's files, as the module makes one. Its parent
 *  is the test's own too, and holds nothing else. */
function newRoot(): string {
  const root = path.join(tempFolder("disk-files"), "files");
  mkdirSync(root, { mode: 0o700 });
  return root;
}

function place(): { root: string; files: StoreFiles } {
  const root = newRoot();
  return { root, files: diskFiles(root) };
}

/** Every file under `dir`, as paths from it. */
function under(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[]).filter((name) => statSync(path.join(dir, name)).isFile()).sort();
}

async function text(files: StoreFiles, key: string): Promise<string | null> {
  const object = await files.get(key);
  return object ? new TextDecoder().decode(await object.arrayBuffer()) : null;
}

async function failure(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (thrown) {
    return thrown;
  }
  return "answered";
}

async function code(work: Promise<unknown>): Promise<string> {
  const thrown = await failure(work);
  return thrown instanceof DiskFilesFailed ? thrown.code : `not this file's failure: ${String(thrown)}`;
}

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

describe("an object", () => {
  test("is put and read again: its bytes, its size and what was said about it", async () => {
    const { files } = place();
    const key = "stores/store-1/files/fil_01/permits 2026.csv";
    expect(await files.head(key)).toBeNull();
    expect(await files.get(key)).toBeNull();
    await files.put(key, "permit_no,address\nBP-1,18 Mill Road\n", {
      httpMetadata: { contentType: "text/csv" },
      customMetadata: { fileId: "fil_01", receivedBy: "user:lena" },
    });
    expect(await files.head(key)).toEqual({
      key,
      size: 36,
      httpMetadata: { contentType: "text/csv" },
      customMetadata: { fileId: "fil_01", receivedBy: "user:lena" },
    });
    const object = await files.get(key);
    expect(object?.size).toBe(36);
    expect(new TextDecoder().decode(await object?.arrayBuffer())).toBe("permit_no,address\nBP-1,18 Mill Road\n");
    // Bytes as bytes, and a buffer of them.
    const bytes = new Uint8Array([0, 255, 10, 13, 0]);
    await files.put("stores/store-1/exports/exp_1/0001", bytes);
    await files.put("stores/store-1/exports/exp_1/0002", bytes.buffer);
    for (const name of ["0001", "0002"]) {
      const read = await files.get(`stores/store-1/exports/exp_1/${name}`);
      expect([...new Uint8Array((await read?.arrayBuffer()) as ArrayBuffer)]).toEqual([0, 255, 10, 13, 0]);
      expect(read && Object.hasOwn(read, "httpMetadata")).toBe(false);
    }
    expect(await (await files.get("stores/store-1/files/fil_01/permits 2026.csv"))?.json().catch(() => "not json")).toBe("not json");
    await files.put("stores/store-1/exports/exp_1/manifest.json", JSON.stringify({ pieces: 2 }));
    const manifest: unknown = await (await files.get("stores/store-1/exports/exp_1/manifest.json"))?.json();
    expect(manifest).toEqual({ pieces: 2 });
  });

  test("a key is never a path: whatever a key holds, every file is under the folder, by names of this file's own", async () => {
    const { root, files } = place();
    const keys = [
      "../../outside",
      "/etc/hosts",
      "stores/s/files/f/..",
      "stores/s/files/f/a/b/c/../../d.csv",
      "stores/s/files/f/" + "n".repeat(600),
      "stores/s/files/f/файл 报告.csv",
      "stores/s/files/f/with\0nul",
      "",
    ];
    for (const [at, key] of keys.entries()) await files.put(key, `value ${String(at)}`);
    for (const [at, key] of keys.entries()) expect([key, await text(files, key)]).toEqual([key, `value ${String(at)}`]);
    const made = under(root);
    expect(made).toHaveLength(keys.length * 2);
    for (const name of made) expect(name).toMatch(/^objects\/(?:[0-9a-f]{64}\.json|[0-9a-f]{32}\.bin)$/);
    // Nothing beside the folder: its parent holds the folder and no other thing.
    expect(readdirSync(path.dirname(root))).toEqual([path.basename(root)]);
    // For the owner alone.
    for (const name of made) expect(statSync(path.join(root, name)).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(root, "objects")).mode & 0o777).toBe(0o700);
  });

  test("put again, the new bytes take the old ones' place, and the old ones leave the disk", async () => {
    const { root, files } = place();
    await files.put("k", "first", { customMetadata: { n: "1" } });
    await files.put("k", "the second");
    expect(await text(files, "k")).toBe("the second");
    expect(await files.head("k")).toEqual({ key: "k", size: 10 });
    expect(under(root)).toHaveLength(2);
  });

  test("a part of it is read by where it starts and how long it is", async () => {
    const { files } = place();
    await files.put("k", "0123456789");
    const part = async (offset: number, length: number): Promise<string> => {
      const object = await files.get("k", { range: { offset, length } });
      // The object's own size, whatever part was asked for.
      expect(object?.size).toBe(10);
      return new TextDecoder().decode(await object?.arrayBuffer());
    };
    expect(await part(0, 4)).toBe("0123");
    expect(await part(7, 3)).toBe("789");
    // Past its end there is less, or nothing.
    expect(await part(7, 100)).toBe("789");
    expect(await part(10, 5)).toBe("");
    expect(await part(50, 5)).toBe("");
    expect(await part(3, 0)).toBe("");
    // The buffer is exactly the bytes asked for.
    expect(((await (await files.get("k", { range: { offset: 2, length: 3 } }))?.arrayBuffer()) as ArrayBuffer).byteLength).toBe(3);
  });

  test("its bytes come as a stream too, a piece at a time, and are not read before they are asked for", async () => {
    const { root, files } = place();
    // Larger than one piece.
    const big = new Uint8Array(2_500_000).map((_, at) => at % 251);
    await files.put("big", big);
    const object = await files.get("big");
    const pieces: number[] = [];
    const hash = createHash("sha256");
    const reader = (object as { body: ReadableStream<Uint8Array> }).body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pieces.push(value.byteLength);
      hash.update(value);
    }
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.reduce((sum, n) => sum + n, 0)).toBe(big.byteLength);
    expect(hash.digest("hex")).toBe(sha256(big));
    // An object that is answered and whose bytes then go: the read fails by
    // one word, and holds nothing of a path.
    const answered = await files.get("big");
    // Its body was not read ahead when it was answered: not one piece of it
    // waits in the stream, so this read finds the bytes gone too.
    const unread = await files.get("big");
    await files.delete("big");
    const thrown = await failure((answered as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer());
    expect(thrown).toBeInstanceOf(DiskFilesFailed);
    expect((thrown as DiskFilesFailed).code).toBe("enoent");
    expect((thrown as Error).message).not.toContain(root);
    const piece = await failure((unread as { body: ReadableStream<Uint8Array> }).body.getReader().read());
    expect(piece).toBeInstanceOf(DiskFilesFailed);
    expect((piece as DiskFilesFailed).code).toBe("enoent");
  });

  test("is deleted, one or many, and a key that holds nothing is no error", async () => {
    const { root, files } = place();
    for (const key of ["a", "b", "c"]) await files.put(key, key);
    await files.delete("a");
    expect(await files.get("a")).toBeNull();
    await files.delete(["b", "nothing-here", "c"]);
    await files.delete("nothing-here");
    expect(under(root)).toEqual([]);
    // Deleting before anything was ever written.
    await place().files.delete(["x"]);
  });
});

describe("a listing", () => {
  test("holds the objects under a prefix, in the order of their keys, with what was said about them only when asked", async () => {
    const { files } = place();
    await files.put("stores/s2/files/f1/b.csv", "22", { customMetadata: { via: "page" }, httpMetadata: { contentType: "text/csv" } });
    await files.put("stores/s1/files/f2/a.csv", "1");
    await files.put("stores/s1/exports/e1/0001", "333");
    await files.put("stores/s10/files/f1/z.csv", "4444");
    expect(await files.list({ prefix: "stores/s1/" })).toEqual({
      objects: [
        { key: "stores/s1/exports/e1/0001", size: 3 },
        { key: "stores/s1/files/f2/a.csv", size: 1 },
      ],
      truncated: false,
    });
    // Another Store's prefix is another list. `s1/` is no prefix of `s10/`.
    expect((await files.list({ prefix: "stores/s10/" })).objects.map((object) => object.key)).toEqual(["stores/s10/files/f1/z.csv"]);
    expect((await files.list({})).objects).toHaveLength(4);
    expect((await files.list({ prefix: "stores/s2/" })).objects).toEqual([{ key: "stores/s2/files/f1/b.csv", size: 2 }]);
    expect((await files.list({ prefix: "stores/s2/", include: ["customMetadata", "httpMetadata"] })).objects).toEqual([
      { key: "stores/s2/files/f1/b.csv", size: 2, customMetadata: { via: "page" }, httpMetadata: { contentType: "text/csv" } },
    ]);
    expect(await files.list({ prefix: "nothing/" })).toEqual({ objects: [], truncated: false });
    // Before anything was ever written.
    expect(await place().files.list({ prefix: "stores/" })).toEqual({ objects: [], truncated: false });
  });

  test("comes a page at a time, and a cursor reads on where the page before it ended", async () => {
    const files = diskFiles(newRoot(), { listPage: 3 });
    const keys = Array.from({ length: 8 }, (_, at) => `p/${String(at).padStart(2, "0")}`);
    // Written in another order than they are listed in.
    for (const key of [...keys].reverse()) await files.put(key, key);
    await files.put("q/other", "x");
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await files.list({ prefix: "p/", ...(cursor === undefined ? {} : { cursor }) });
      pages += 1;
      seen.push(...page.objects.map((object) => object.key));
      expect(page.objects.length).toBeLessThanOrEqual(3);
      if (!page.truncated) {
        expect(Object.hasOwn(page, "cursor")).toBe(false);
        break;
      }
      cursor = page.cursor;
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(keys);
    // As the engine empties a prefix: list, delete what came, and list again.
    for (;;) {
      const page = await files.list({ prefix: "p/" });
      if (page.objects.length > 0) await files.delete(page.objects.map((object) => object.key));
      if (!page.truncated) break;
    }
    expect((await files.list({})).objects.map((object) => object.key)).toEqual(["q/other"]);
  });
});

describe("an upload in parts", () => {
  test("makes one object of its parts, in the order of their numbers, with what was said when it began", async () => {
    const { root, files } = place();
    const key = "stores/store-1/files/fil_02/town export.zip";
    const upload = await files.createMultipartUpload(key, {
      httpMetadata: { contentType: "application/zip" },
      customMetadata: { fileId: "fil_02" },
    });
    expect(upload.uploadId).toMatch(/^[0-9a-f]{32}$/);
    // Nothing is an object yet.
    expect(await files.head(key)).toBeNull();
    // The parts arrive through another hand than the one that began: by the
    // key and the upload's id alone, and not in order.
    const other = diskFiles(root).resumeMultipartUpload(key, upload.uploadId);
    const second = await other.uploadPart(2, "world");
    const first = await other.uploadPart(1, new TextEncoder().encode("hello, "));
    expect(first).toEqual({ partNumber: 1, etag: sha256("hello, ") });
    expect(second).toEqual({ partNumber: 2, etag: sha256("world") });
    expect(await files.head(key)).toBeNull();
    expect(await upload.complete([second, first])).toEqual({
      key,
      size: 12,
      httpMetadata: { contentType: "application/zip" },
      customMetadata: { fileId: "fil_02" },
    });
    expect(await text(files, key)).toBe("hello, world");
    // The parts are gone from the disk: the object's two files are all there is.
    expect(under(root)).toHaveLength(2);
    // Done, the upload is no more.
    expect(await code(other.uploadPart(3, "!"))).toBe("upload_unknown");
    expect(await code(other.complete([first, second]))).toBe("upload_unknown");
  });

  test("a part sent again takes the first one's place, and an empty file is one empty part", async () => {
    const { files } = place();
    const upload = await files.createMultipartUpload("k");
    await upload.uploadPart(1, "a draft");
    const again = await upload.uploadPart(1, "the part");
    expect((await upload.complete([again])).size).toBe(8);
    expect(await text(files, "k")).toBe("the part");
    const empty = await files.createMultipartUpload("empty");
    expect((await empty.complete([await empty.uploadPart(1, new Uint8Array(0))])).size).toBe(0);
    expect(await text(files, "empty")).toBe("");
  });

  test("parts that are not what was answered for them make no object", async () => {
    const { root, files } = place();
    await files.put("k", "what the key held before");
    const upload = await files.createMultipartUpload("k");
    const one = await upload.uploadPart(1, "one");
    const two = await upload.uploadPart(2, "two");
    // A part that never arrived, one that was changed since, a number twice,
    // and no part at all.
    expect(await code(upload.complete([one, two, { partNumber: 3, etag: sha256("three") }]))).toBe("part_unknown");
    expect(await code(upload.complete([one, { partNumber: 2, etag: sha256("another two") }]))).toBe("part_changed");
    expect(await code(upload.complete([one, one]))).toBe("part_number_invalid");
    expect(await code(upload.complete([]))).toBe("part_number_invalid");
    for (const partNumber of [0, -1, 1.5, 10_001, Number.NaN]) {
      expect(await code(upload.uploadPart(partNumber, "x"))).toBe("part_number_invalid");
      expect(await code(upload.complete([{ partNumber, etag: "x" }]))).toBe("part_number_invalid");
    }
    // The key still holds what it held, and no bytes of a failed try are left.
    expect(await text(files, "k")).toBe("what the key held before");
    expect(under(path.join(root, "objects"))).toHaveLength(2);
    // The upload is still there, and its right parts still make the object.
    expect((await upload.complete([two, one])).size).toBe(6);
    expect(await text(files, "k")).toBe("onetwo");
  });

  test("given up, its parts leave the disk, and giving up what is not there is no error", async () => {
    const { root, files } = place();
    const upload = await files.createMultipartUpload("k");
    await upload.uploadPart(1, "one");
    await upload.abort();
    expect(under(root)).toEqual([]);
    await upload.abort();
    expect(await code(upload.uploadPart(1, "one"))).toBe("upload_unknown");
    expect(await files.head("k")).toBeNull();
  });

  test("an upload's id is never a path, and an upload is its own key's alone", async () => {
    const { root, files } = place();
    const outside = path.join(path.dirname(root), "outside");
    const real = await files.createMultipartUpload("stores/s1/files/f1/a.csv");
    await real.uploadPart(1, "a");
    for (const id of ["../outside", "..", "", "/tmp/x", "UPPER0123456789abcdef0123456789ab", `${real.uploadId}/../${real.uploadId}`, `${real.uploadId}0`]) {
      const upload = files.resumeMultipartUpload("stores/s1/files/f1/a.csv", id);
      expect([id, await code(upload.uploadPart(1, "x"))]).toEqual([id, "upload_unknown"]);
      expect([id, await code(upload.complete([{ partNumber: 1, etag: sha256("x") }]))]).toEqual([id, "upload_unknown"]);
      expect([id, await code(upload.abort())]).toEqual([id, "upload_unknown"]);
    }
    expect(existsSync(outside)).toBe(false);
    // The right id under another key is no upload of that key.
    const stranger = files.resumeMultipartUpload("stores/s2/files/f9/b.csv", real.uploadId);
    expect(await code(stranger.uploadPart(2, "b"))).toBe("upload_unknown");
    expect(await code(stranger.complete([{ partNumber: 1, etag: sha256("a") }]))).toBe("upload_unknown");
    // Nor is it that key's to give up.
    expect(await code(stranger.abort())).toBe("upload_unknown");
    expect(await files.head("stores/s2/files/f9/b.csv")).toBeNull();
    // And the upload itself is as it was.
    expect((await real.complete([{ partNumber: 1, etag: sha256("a") }])).size).toBe(1);
  });
});

describe("what is written here waits for the Store's own keeping", () => {
  test("every call that changes anything asks first, a refusal there writes nothing, and a read asks nothing", async () => {
    const root = newRoot();
    /** What was on the disk each time it was asked. */
    const asked: string[][] = [];
    let refuse = false;
    const files = diskFiles(root, {
      beforeWrite: () => {
        asked.push(under(root));
        if (refuse) throw new Error("the Store could not keep what it wrote");
      },
    });
    await files.put("a", "1");
    // Asked before the first byte was written.
    expect(asked).toEqual([[]]);
    const upload = await files.createMultipartUpload("b");
    const part = await upload.uploadPart(1, "x");
    await upload.complete([{ partNumber: 1, etag: part.etag }]);
    const given = await files.createMultipartUpload("c");
    await given.abort();
    await files.delete("a");
    // A put, an upload begun, a part, the upload's end, an upload begun and
    // given up, and a delete: once each.
    expect(asked).toHaveLength(7);
    // A read asks nothing.
    await files.get("b");
    await files.head("b");
    await files.list({ prefix: "" });
    files.resumeMultipartUpload("b", given.uploadId);
    expect(asked).toHaveLength(7);

    // Refused, each of them fails, and the disk is as it was.
    const open = await files.createMultipartUpload("d");
    refuse = true;
    const before = under(root);
    for (const work of [
      (): Promise<unknown> => files.put("z", "9"),
      (): Promise<unknown> => files.delete("b"),
      (): Promise<unknown> => files.createMultipartUpload("z"),
      (): Promise<unknown> => open.uploadPart(1, "x"),
      (): Promise<unknown> => open.complete([{ partNumber: 1, etag: sha256("x") }]),
      (): Promise<unknown> => open.abort(),
    ]) {
      expect(((await failure(work())) as Error).message).toBe("the Store could not keep what it wrote");
    }
    expect(under(root)).toEqual(before);
  });

  test("drafts that a process left in the middle of a write are removed, and nothing else is", async () => {
    const { root, files } = place();
    await files.put("a", "1");
    const upload = await files.createMultipartUpload("b");
    await upload.uploadPart(1, "x");
    const whole = under(root);
    writeFileSync(path.join(root, "objects", `${"a".repeat(64)}.json.${"b".repeat(32)}.tmp`), "half a record");
    writeFileSync(path.join(root, "uploads", upload.uploadId, `part-00002.${"c".repeat(32)}.tmp`), "half a part");
    expect(under(root)).toHaveLength(whole.length + 2);
    removeFileDrafts(root);
    expect(under(root)).toEqual(whole);
    expect(await text(files, "a")).toBe("1");
    // Files that are not there yet are no error.
    removeFileDrafts(path.join(root, "nowhere"));
  });
});

describe("what is on the disk and is not this file's", () => {
  test("a record that cannot be read is told by one word, is not listed, and can be put again or deleted", async () => {
    const { root, files } = place();
    await files.put("k", "value");
    await files.put("other", "value");
    const record = path.join(root, "objects", `${sha256("k")}.json`);
    for (const damaged of ["", "not json", "null", "{}", JSON.stringify({ key: "k", size: -1, data: "0".repeat(32) + ".bin" })]) {
      writeFileSync(record, damaged);
      expect([damaged, await code(files.get("k"))]).toEqual([damaged, "record_unreadable"]);
      expect([damaged, await code(files.head("k"))]).toEqual([damaged, "record_unreadable"]);
      expect((await files.list({})).objects.map((object) => object.key)).toEqual(["other"]);
    }
    await files.put("k", "anew");
    expect(await text(files, "k")).toBe("anew");
    writeFileSync(record, "not json");
    await files.delete("k");
    expect(await files.get("k")).toBeNull();
  });

  test("a record never leads to a file outside the folder", async () => {
    const { root, files } = place();
    const secret = path.join(path.dirname(root), "elsewhere.txt");
    writeFileSync(secret, "a row's value");
    try {
      await files.put("k", "value");
      const record = path.join(root, "objects", `${sha256("k")}.json`);
      for (const data of ["../../elsewhere.txt", secret, "../" + "0".repeat(32) + ".bin", "0".repeat(32) + ".bin/../x"]) {
        writeFileSync(record, JSON.stringify({ key: "k", size: 13, data }));
        expect([data, await code(files.get("k"))]).toEqual([data, "record_unreadable"]);
      }
      // A record under one key's name that says it is another's is no object of either.
      writeFileSync(record, JSON.stringify({ key: "another", size: 5, data: "0".repeat(32) + ".bin" }));
      expect(await files.get("k")).toBeNull();
      expect(readFileSync(secret, "utf8")).toBe("a row's value");
    } finally {
      rmSync(secret, { force: true });
    }
  });

  test("a failure of the disk is one word, with nothing of a path or a key in it", async () => {
    const { root, files } = place();
    // Where the object's record is to go is a folder that holds something.
    const record = path.join(root, "objects", `${sha256("stores/s1/files/f1/secret name.csv")}.json`);
    mkdirSync(record, { recursive: true });
    writeFileSync(path.join(record, "in-the-way"), "");
    const thrown = await failure(files.put("stores/s1/files/f1/secret name.csv", "value"));
    expect(thrown).toBeInstanceOf(DiskFilesFailed);
    expect((thrown as DiskFilesFailed).code).toMatch(/^[a-z][a-z0-9_]*$/);
    for (const word of [root, "secret name", "objects", ".json"]) expect((thrown as Error).message).not.toContain(word);
    // The bytes that were written for it are not left behind.
    expect(under(path.join(root, "objects")).filter((name) => name.endsWith(".bin"))).toEqual([]);
  });
});
