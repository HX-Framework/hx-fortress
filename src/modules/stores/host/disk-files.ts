// A Store's files, kept in a folder on this HX Fortress's disk.
//
// The Store's engine keeps a file's record in the Store, and its bytes in a
// place it calls a bucket: seven calls on the place, and three on an upload in
// progress (`engine/store-object/src/store-files.ts`). This file answers those
// calls from one folder: the `files/` folder of the Store's own.
//
// ONE FOLDER FOR EACH STORE. On the platform the engine was written for, the
// Stores of a deployment share one bucket, and the engine names every object
// by a key that begins with its Store's id. Here a Store's process holds one
// Store and nothing else, so each Store has a place of its own:
//
//   • Removing a Store's folder removes its files with it.
//   • A new Store that is given an id an earlier one had starts with no file.
//   • A Store cannot read another Store's objects. The one place the engine
//     does that is where a Store takes in what another exported, and that is
//     not done between two Stores of one HX Fortress yet: the key of the
//     other Store's export holds nothing here.
//
// A KEY IS NEVER A PATH. A key is the engine's text and can hold a person's
// file name. An object's files are named by the SHA-256 of its key and by
// random letters, so no key decides where on the disk anything is written.
//
// WHAT IS IN THE FOLDER
//
//   objects/<sha-256 of the key>.json   an object's record: its key, its size,
//                                       what was said about it, and the name
//                                       of the file that holds its bytes
//   objects/<32 random letters>.bin     an object's bytes
//   uploads/<upload's id>/              an upload in progress: what it is
//                                       for, and each part that has arrived
//
// AN OBJECT IS THERE ONCE ITS RECORD IS. The bytes are written first, under a
// name nothing refers to, and kept on the disk. Then the record takes its name
// in one step. So a reader finds the old object or the new one, never half of
// either, and a process that is ended in the middle leaves at most a file of
// bytes that no record names.
//
// ONE PROCESS WRITES THE FOLDER at a time: the one that holds the Store.
// Another may read it meanwhile, and finds every object whole.
//
// WHAT IS WRITTEN HERE IS ON THE DISK AT ONCE, and what the engine writes in
// the Store waits for the Store's next keeping. The engine counts on an order
// that the platform it was written for gives it: nothing leaves for the
// bucket before what was written in the Store until then is kept. It marks a
// restore in the Store and then puts what the restore carries across here,
// and reads the mark, when it next starts, to know whether the restore
// happened. So this file is handed `beforeWrite`, and calls it before every
// call that changes anything: the Store's storage keeps what waits there.
//
// A FAILURE OF THE DISK is told by one word, the machine's own for it, and by
// no message of the runtime's: such a message holds a path.

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import type {
  StoreFileBody,
  StoreFileList,
  StoreFileObject,
  StoreFileOptions,
  StoreFilePart,
  StoreFiles,
  StoreFileUpload,
} from "../engine/store-object/src/store-files.js";
import { syncFolder } from "./store-folder";

/** How many objects one page of a listing holds, as on the platform the
 *  engine was written for. */
export const LIST_PAGE_OBJECTS = 1_000;
/** The highest number a part of an upload may have. */
export const UPLOAD_PARTS_MAX = 10_000;
/** How many bytes are copied at a time when an upload's parts become one
 *  object. */
const COPY_BYTES = 1 << 20;

const OBJECTS = "objects";
const UPLOADS = "uploads";
const UPLOAD_ID = /^[0-9a-f]{32}$/;
const RECORD_NAME = /^[0-9a-f]{64}\.json$/;
const DATA_NAME = /^[0-9a-f]{32}\.bin$/;

/**
 * The disk failed a call, or a call named something that is not there to be
 * worked on. `code` is one lower-case word: the machine's own (`enospc`), or
 * one of this file's (`upload_unknown`, `part_unknown`, `part_changed`,
 * `part_number_invalid`, `record_unreadable`). The message is that word and
 * nothing of a path, a key or a value.
 */
export class DiskFilesFailed extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`a Store's files could not be read or written: ${code}`);
    this.name = "DiskFilesFailed";
    this.code = code;
  }
}

/** The one word for what the disk said, or `io` where it said none. */
function failed(thrown: unknown): DiskFilesFailed {
  if (thrown instanceof DiskFilesFailed) return thrown;
  const code = (thrown as { code?: unknown } | null)?.code;
  return new DiskFilesFailed(typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code.toLowerCase() : "io");
}

function isGone(thrown: unknown): boolean {
  const code = (thrown as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** What a record on the disk holds. */
interface Kept {
  key: string;
  size: number;
  /** The name of the file of bytes, in `objects/`. */
  data: string;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

function recordName(key: string): string {
  return `${createHash("sha256").update(key, "utf8").digest("hex")}.json`;
}

function randomName(): string {
  return randomBytes(16).toString("hex");
}

function bytesOf(value: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

/** What a put or a new upload said about an object, as plain values of this
 *  file's own. Nothing else of `options` is kept. */
function said(options: StoreFileOptions | undefined): Pick<Kept, "httpMetadata" | "customMetadata"> {
  const out: Pick<Kept, "httpMetadata" | "customMetadata"> = {};
  const type = options?.httpMetadata?.contentType;
  if (typeof type === "string") out.httpMetadata = { contentType: type };
  const custom = options?.customMetadata;
  if (custom && typeof custom === "object") {
    const kept: Record<string, string> = {};
    for (const [name, value] of Object.entries(custom)) {
      if (typeof value === "string") kept[name] = value;
    }
    out.customMetadata = kept;
  }
  return out;
}

/** Write `chunks` to a new file for the owner alone, and keep it on the disk.
 *  Answers how many bytes it holds. The file is removed when a write fails. */
function writeNew(file: string, chunks: Iterable<Uint8Array>): number {
  let size = 0;
  let fd: number;
  try {
    fd = openSync(file, "wx", 0o600);
  } catch (thrown) {
    throw failed(thrown);
  }
  try {
    // The mode above is a request that the process's mask may narrow.
    fchmodSync(fd, 0o600);
    for (const chunk of chunks) {
      let at = 0;
      while (at < chunk.byteLength) at += writeSync(fd, chunk, at, chunk.byteLength - at);
      size += chunk.byteLength;
    }
    fsyncSync(fd);
  } catch (thrown) {
    closeSync(fd);
    rmSync(file, { force: true });
    throw failed(thrown);
  }
  closeSync(fd);
  return size;
}

/** Put `value` under `file`'s name in one step: written beside it first. */
function replaceWith(file: string, value: Uint8Array): void {
  const draft = `${file}.${randomName()}${DRAFT_SUFFIX}`;
  writeNew(draft, [value]);
  try {
    renameSync(draft, file);
  } catch (thrown) {
    rmSync(draft, { force: true });
    throw failed(thrown);
  }
  syncFolder(path.dirname(file));
}

/** What every draft's name ends in: a record or a part that was being written
 *  beside its own name. */
const DRAFT_SUFFIX = ".tmp";

/**
 * Remove the drafts that a process left in `root` when it was ended in the
 * middle of a write: in `objects/`, and in each upload's folder. Only the
 * process that holds the Store calls this, once it holds it: no other writes
 * a draft here. It never throws: a draft that stays takes room only.
 */
export function removeFileDrafts(root: string): void {
  const sweep = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.endsWith(DRAFT_SUFFIX)) rmSync(path.join(dir, name), { force: true });
    }
  };
  try {
    sweep(path.join(root, OBJECTS));
    for (const upload of readdirSync(path.join(root, UPLOADS))) {
      if (UPLOAD_ID.test(upload)) sweep(path.join(root, UPLOADS, upload));
    }
  } catch {
    // No uploads yet, or a folder that cannot be read.
  }
}

export interface DiskFilesOptions {
  /** A seam for tests: how many objects one page of a listing holds. */
  listPage?: number;
  /**
   * Called before every call that changes anything here: a put, a delete, and
   * each call of an upload. What it throws fails that call, and nothing is
   * written. The Store's program hands the storage's own keeping (see the top
   * of this file).
   */
  beforeWrite?: () => void;
}

/** A Store's files in `root`, the Store's own folder for them. The folder is
 *  there already: this makes the two levels under it, when they are not there,
 *  on the first call that writes. */
export function diskFiles(root: string, options: DiskFilesOptions = {}): StoreFiles {
  const objects = path.join(root, OBJECTS);
  const uploads = path.join(root, UPLOADS);
  const listPage = options.listPage ?? LIST_PAGE_OBJECTS;
  const beforeWrite = (): void => options.beforeWrite?.();

  const prepare = (): void => {
    try {
      for (const dir of [objects, uploads]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (thrown) {
      throw failed(thrown);
    }
  };

  /** The record of `key`, or null when the key holds nothing. */
  const read = (key: string): Kept | null => {
    let text: string;
    try {
      text = readFileSync(path.join(objects, recordName(key)), "utf8");
    } catch (thrown) {
      if (isGone(thrown)) return null;
      throw failed(thrown);
    }
    return recordOf(text, key);
  };

  /** A record's text as a record, held to what this file writes. With `key`,
   *  it is the record of that key or none. */
  const recordOf = (text: string, key?: string): Kept | null => {
    let kept: Partial<Kept> | null;
    try {
      kept = JSON.parse(text) as Partial<Kept> | null;
    } catch {
      throw new DiskFilesFailed("record_unreadable");
    }
    if (
      kept === null ||
      typeof kept !== "object" ||
      typeof kept.key !== "string" ||
      typeof kept.size !== "number" ||
      !Number.isSafeInteger(kept.size) ||
      kept.size < 0 ||
      typeof kept.data !== "string" ||
      // The name of a file of bytes as this file names one, and no path.
      !DATA_NAME.test(kept.data)
    ) {
      throw new DiskFilesFailed("record_unreadable");
    }
    // Two keys of one hash do not happen. A record under another key's name
    // was put there by hand, and is no object of this key.
    if (key !== undefined && kept.key !== key) return null;
    return kept as Kept;
  };

  const told = (kept: Kept): StoreFileObject => ({
    key: kept.key,
    size: kept.size,
    ...(kept.httpMetadata ? { httpMetadata: kept.httpMetadata } : {}),
    ...(kept.customMetadata ? { customMetadata: kept.customMetadata } : {}),
  });

  /** Make `data`, a file of bytes that is on the disk, the object of `key`. */
  const commit = (key: string, data: string, size: number, options: StoreFileOptions | undefined): StoreFileObject => {
    let before: Kept | null = null;
    try {
      before = read(key);
    } catch {
      // A record that cannot be read is replaced like one that can.
    }
    const kept: Kept = { key, size, data, ...said(options) };
    try {
      replaceWith(path.join(objects, recordName(key)), new TextEncoder().encode(JSON.stringify(kept)));
    } catch (thrown) {
      rmSync(path.join(objects, data), { force: true });
      throw thrown;
    }
    // The bytes the key held before. No record names them now.
    if (before && before.data !== data) rmSync(path.join(objects, before.data), { force: true });
    return told(kept);
  };

  const remove = (key: string): void => {
    let kept: Kept | null = null;
    try {
      kept = read(key);
    } catch {
      // Removed all the same: only its bytes cannot be found.
    }
    try {
      rmSync(path.join(objects, recordName(key)), { force: true });
      if (kept) rmSync(path.join(objects, kept.data), { force: true });
    } catch (thrown) {
      throw failed(thrown);
    }
  };

  /** The bytes of an object from `offset`, `length` of them, or fewer where
   *  the object ends. Null when its file of bytes is gone. */
  const slice = (kept: Kept, offset: number, length: number): Uint8Array | null => {
    const from = Math.min(Math.max(0, offset), kept.size);
    const most = Math.max(0, Math.min(length, kept.size - from));
    let fd: number;
    try {
      fd = openSync(path.join(objects, kept.data), "r");
    } catch (thrown) {
      // Removed since its record was read: the key holds nothing now.
      if (isGone(thrown)) return null;
      throw failed(thrown);
    }
    try {
      const out = new Uint8Array(most);
      let got = 0;
      while (got < most) {
        const n = readSync(fd, out, got, most - got, from + got);
        if (n === 0) break;
        got += n;
      }
      // A buffer of exactly what was read, so that its whole buffer is the answer.
      return got === most ? out : out.slice(0, got);
    } catch (thrown) {
      throw failed(thrown);
    } finally {
      closeSync(fd);
    }
  };

  const upload = (key: string, uploadId: string): StoreFileUpload => {
    /** The upload's folder. THROWS for an id that is none of this file's:
     *  the id comes back from the engine's own records, and is still never
     *  used as a path before it is checked. */
    const folder = (): string => {
      if (!UPLOAD_ID.test(uploadId)) throw new DiskFilesFailed("upload_unknown");
      return path.join(uploads, uploadId);
    };
    /** What the upload is for. THROWS when there is no such upload, or it is
     *  another key's. */
    const begun = (): { key: string; options: Pick<Kept, "httpMetadata" | "customMetadata"> } => {
      let text: string;
      try {
        text = readFileSync(path.join(folder(), "upload.json"), "utf8");
      } catch (thrown) {
        throw isGone(thrown) ? new DiskFilesFailed("upload_unknown") : failed(thrown);
      }
      let kept: { key?: unknown; options?: unknown } | null;
      try {
        kept = JSON.parse(text) as { key?: unknown; options?: unknown } | null;
      } catch {
        throw new DiskFilesFailed("record_unreadable");
      }
      if (kept === null || kept.key !== key) throw new DiskFilesFailed("upload_unknown");
      return { key, options: said(kept.options as StoreFileOptions | undefined) };
    };
    const partFile = (partNumber: number): string => path.join(folder(), `part-${String(partNumber).padStart(5, "0")}`);
    const checked = (partNumber: unknown): number => {
      if (typeof partNumber !== "number" || !Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > UPLOAD_PARTS_MAX) {
        throw new DiskFilesFailed("part_number_invalid");
      }
      return partNumber;
    };
    return {
      uploadId,
      // `async`, so that every failure is a promise that rejects, as the
      // engine expects of an upload's calls.
      async uploadPart(partNumber, value): Promise<StoreFilePart> {
        const number = checked(partNumber);
        beforeWrite();
        begun();
        const bytes = bytesOf(value);
        // The same part sent again takes the first one's place.
        replaceWith(partFile(number), bytes);
        return { partNumber: number, etag: createHash("sha256").update(bytes).digest("hex") };
      },
      async complete(parts): Promise<StoreFileObject> {
        beforeWrite();
        const { options } = begun();
        for (const part of parts) checked(part.partNumber);
        const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
        // At least one part, and each number once: an object is its parts in
        // the order of their numbers.
        if (ordered.length === 0 || ordered.some((part, at) => at > 0 && part.partNumber === ordered[at - 1]?.partNumber)) {
          throw new DiskFilesFailed("part_number_invalid");
        }
        const data = `${randomName()}.bin`;
        const target = path.join(objects, data);
        // Each part is read once: copied on, and held to what was answered
        // for it when it arrived.
        function* copied(): Generator<Uint8Array> {
          for (const part of ordered) {
            let fd: number;
            try {
              fd = openSync(partFile(part.partNumber), "r");
            } catch (thrown) {
              throw isGone(thrown) ? new DiskFilesFailed("part_unknown") : failed(thrown);
            }
            const hash = createHash("sha256");
            try {
              for (;;) {
                const chunk = new Uint8Array(COPY_BYTES);
                const n = readSync(fd, chunk, 0, COPY_BYTES, null);
                if (n === 0) break;
                const read = chunk.subarray(0, n);
                hash.update(read);
                yield read;
              }
            } finally {
              closeSync(fd);
            }
            if (hash.digest("hex") !== part.etag) throw new DiskFilesFailed("part_changed");
          }
        }
        const size = writeNew(target, copied());
        const object = commit(key, data, size, options);
        try {
          rmSync(folder(), { recursive: true, force: true });
        } catch {
          // The object is there. What is left of the upload takes room only.
        }
        return object;
      },
      async abort(): Promise<void> {
        beforeWrite();
        const dir = folder();
        let kept: { key?: unknown } | null = null;
        try {
          kept = JSON.parse(readFileSync(path.join(dir, "upload.json"), "utf8")) as { key?: unknown } | null;
        } catch (thrown) {
          // Gone already, or its own record cannot be read: it is nobody's,
          // and what is left of it goes.
          if (!isGone(thrown) && !(thrown instanceof SyntaxError)) throw failed(thrown);
        }
        // Another key's upload is not this key's to give up.
        if (kept !== null && kept.key !== key) throw new DiskFilesFailed("upload_unknown");
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (thrown) {
          throw failed(thrown);
        }
      },
    };
  };

  return {
    async get(key, options): Promise<StoreFileBody | null> {
      const kept = read(key);
      if (!kept) return null;
      const range = options?.range;
      const from = Math.min(Math.max(0, range ? range.offset : 0), kept.size);
      const length = Math.max(0, Math.min(range ? range.length : kept.size, kept.size - from));
      // Whether its bytes are there is asked now. They are read when the
      // caller reads them: an object can be larger than a process should hold.
      if (slice(kept, from, 0) === null) return null;
      const all = (): Uint8Array => {
        const bytes = slice(kept, from, length);
        // Removed, or cut short, since the object was answered.
        if (bytes === null || bytes.byteLength !== length) throw new DiskFilesFailed("enoent");
        return bytes;
      };
      let sent = 0;
      return {
        ...told(kept),
        // Nothing is read ahead: a stream reads its first piece as soon as it
        // is made, unless it is told to keep none waiting.
        body: new ReadableStream<Uint8Array>(
          {
            pull(controller): void {
              if (sent >= length) {
                controller.close();
                return;
              }
              let chunk: Uint8Array | null;
              try {
                chunk = slice(kept, from + sent, Math.min(COPY_BYTES, length - sent));
              } catch (thrown) {
                controller.error(thrown);
                return;
              }
              if (chunk === null || chunk.byteLength === 0) {
                controller.error(new DiskFilesFailed("enoent"));
                return;
              }
              sent += chunk.byteLength;
              controller.enqueue(chunk);
            },
          },
          { highWaterMark: 0 },
        ),
        // Read into a buffer of its own, of exactly the bytes asked for.
        arrayBuffer: async () => all().buffer as ArrayBuffer,
        json: async <T>() => JSON.parse(new TextDecoder().decode(all())) as T,
      };
    },
    async head(key): Promise<StoreFileObject | null> {
      const kept = read(key);
      return kept ? told(kept) : null;
    },
    async put(key, value, options): Promise<StoreFileObject> {
      beforeWrite();
      prepare();
      const data = `${randomName()}.bin`;
      const size = writeNew(path.join(objects, data), [bytesOf(value)]);
      return commit(key, data, size, options);
    },
    async delete(keys): Promise<void> {
      beforeWrite();
      for (const key of typeof keys === "string" ? [keys] : keys) remove(key);
    },
    async list(options): Promise<StoreFileList> {
      const prefix = options.prefix ?? "";
      const after = options.cursor === undefined ? null : Buffer.from(options.cursor, "base64url").toString("utf8");
      const include = new Set(options.include ?? []);
      let names: string[];
      try {
        names = readdirSync(objects);
      } catch (thrown) {
        if (isGone(thrown)) return { objects: [], truncated: false };
        throw failed(thrown);
      }
      const found: Kept[] = [];
      for (const name of names) {
        if (!RECORD_NAME.test(name)) continue;
        let kept: Kept | null;
        try {
          kept = recordOf(readFileSync(path.join(objects, name), "utf8"));
        } catch (thrown) {
          // Removed while this looked, or a record nothing can read: neither
          // is an object that can be listed.
          if (isGone(thrown) || thrown instanceof DiskFilesFailed) continue;
          throw failed(thrown);
        }
        if (kept === null || !kept.key.startsWith(prefix)) continue;
        if (after !== null && !(kept.key > after)) continue;
        found.push(kept);
      }
      // In the order of the keys, so that a cursor is a place in the list.
      found.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const page = found.slice(0, listPage);
      const truncated = found.length > page.length;
      const last = page.at(-1);
      return {
        objects: page.map((kept) => ({
          key: kept.key,
          size: kept.size,
          ...(include.has("httpMetadata") && kept.httpMetadata ? { httpMetadata: kept.httpMetadata } : {}),
          ...(include.has("customMetadata") && kept.customMetadata ? { customMetadata: kept.customMetadata } : {}),
        })),
        truncated,
        ...(truncated && last ? { cursor: Buffer.from(last.key, "utf8").toString("base64url") } : {}),
      };
    },
    async createMultipartUpload(key, options): Promise<StoreFileUpload> {
      beforeWrite();
      prepare();
      const uploadId = randomName();
      try {
        mkdirSync(path.join(uploads, uploadId), { mode: 0o700 });
      } catch (thrown) {
        throw failed(thrown);
      }
      replaceWith(
        path.join(uploads, uploadId, "upload.json"),
        new TextEncoder().encode(JSON.stringify({ key, options: said(options) })),
      );
      return upload(key, uploadId);
    },
    // It asks the disk nothing, as on the platform: the first call of the
    // upload does.
    resumeMultipartUpload: (key, uploadId) => upload(key, uploadId),
  };
}
