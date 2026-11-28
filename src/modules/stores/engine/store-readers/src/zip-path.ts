// A place in a zip named by a path, through the zips inside it one level at a time, and the words of
// a text file in it: what a reader that is handed a path opens (Maya's tools, through the Store
// gateway's zip reader), where a person opens column after column on the page (ZipBrowser).
//
// A path names folders and files from the top of the outermost zip, joined by "/". A zip inside the
// zip is named by its own path, and what it holds follows it: "site.zip/docs/readme.md". The walk
// opens such a zip only when the path goes into it. A compressed one is inflated into memory, under
// `heldMax` counted over every level the walk opens; a stored one is a range of the zip above it and
// opens at any size.
//
// A name is only words: ".." is a folder named "..", never the folder above, and nothing here writes
// a file anywhere, so a name that climbs out of its folder reaches nothing.

import type { ByteSource } from "./source.js";
import { decode, detectEncoding, encodingName, unitBytes, validUtf8, type TextEncoding } from "./text.js";
import { UnreadableFile } from "./types.js";
import { entryBytes, entryRefusal } from "./zip.js";
import { isZipName, openZipInZip, readZipTree, zipFileRefusal, type ZipFile, type ZipItem, type ZipTree } from "./zip-tree.js";

/** One zip of a walk: the outermost one, or a zip inside it that the walk opened. */
export interface ZipLevel {
  source: ByteSource;
  tree: ZipTree;
  /** Its path from the top of the outermost zip, ending in "/": "" for the outermost, "site.zip/" for a zip in it. */
  base: string;
}

/** Where a path leads: a folder of some level (its top included), or a file. */
export type ZipPlace =
  | { kind: "folder"; level: ZipLevel; /** The folder in its level's tree: "" or a path ending in "/". */ folder: string; /** Its whole path: "" or ending in "/". */ path: string }
  | { kind: "file"; level: ZipLevel; file: ZipFile; /** Its whole path. */ path: string };

/** A path that names nothing the zip holds, or a file where it needs a folder. */
export class ZipPathMissing extends Error {
  constructor(
    readonly path: string,
    readonly reason: "missing" | "not-a-folder",
    message: string,
  ) {
    super(message);
    this.name = "ZipPathMissing";
  }
}

export interface ZipWalkLimits {
  /** The longest directory read, per zip (`readZipTree`'s cap). */
  listMax: number;
  /** Bytes of compressed zips inside the zip that one walk may hold in memory, every level together. */
  heldMax: number;
}

/** The outermost zip as a walk's first level. Throws `UnreadableFile` for a file that is not a zip, or a directory over `listMax`. */
export async function zipTop(source: ByteSource, limits: Pick<ZipWalkLimits, "listMax">): Promise<ZipLevel> {
  return { source, tree: await readZipTree(source, limits.listMax), base: "" };
}

/** A path's parts: empty and "." parts are passed over, as the tree passes them over in names. */
export function zipPathParts(path: string): string[] {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "" && s !== ".");
}

/** Whether a zip inside the zip opens in a walk with `held` bytes held so far. */
export function zipOpens(file: ZipFile, limits: Pick<ZipWalkLimits, "heldMax">, held = 0): boolean {
  if (zipFileRefusal(file)) return false;
  return file.entry.method === 0 || held + file.size <= limits.heldMax;
}

/**
 * The place `path` names. With `intoZip`, a path that ends at a zip inside the zip opens it and
 * names its top, as a folder. Throws `ZipPathMissing` for a path that names nothing, and
 * `UnreadableFile` for a zip on the way that does not open: a password, a way of compressing that is
 * not read here, too big to hold (`too-big`), or damaged.
 */
export async function zipPlace(top: ZipLevel, path: string, limits: ZipWalkLimits, opts: { intoZip?: boolean } = {}): Promise<ZipPlace> {
  const parts = zipPathParts(path);
  let level = top;
  let folder = "";
  let held = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const asFolder = `${folder}${part}/`;
    if (level.tree.list(asFolder)) {
      folder = asFolder;
      continue;
    }
    const file = (level.tree.list(folder) ?? []).find((item): item is ZipFile => item.kind === "file" && item.name === part);
    const here = `${level.base}${folder}${part}`;
    if (!file) throw new ZipPathMissing(path, "missing", `${here} is not in the zip.`);
    const last = i === parts.length - 1;
    if (last && !(opts.intoZip && isZipName(file.name))) return { kind: "file", level, file, path: `${level.base}${file.path}` };
    if (!isZipName(file.name)) throw new ZipPathMissing(path, "not-a-folder", `${here} is a file, not a folder or a zip.`);
    // A zip inside the zip, opened one level down.
    if (file.entry.method !== 0 && !zipFileRefusal(file) && held + file.size > limits.heldMax) {
      throw new UnreadableFile(`${file.name} is too big to open inside the zip here.`, "too-big");
    }
    const source = await openZipInZip(level.source, file, limits.heldMax - held);
    if (file.entry.method !== 0) held += file.size;
    level = { source, tree: await readZipTree(source, limits.listMax), base: `${level.base}${file.path}/` };
    folder = "";
  }
  return { kind: "folder", level, folder, path: `${level.base}${folder}` };
}

/** A folder's items as a reader lists them, each with its whole path. */
export type ZipListed =
  | { kind: "folder"; name: string; path: string; files: number; size: number }
  | { kind: "file"; name: string; path: string; size: number; refusal?: "password" | "method" | "too-big" }
  | { kind: "zip"; name: string; path: string; size: number; opens: boolean; refusal?: "password" | "method" | "too-big" };

/** One item of a folder, for a reader: its whole path, a zip marked as one, and why it cannot be read when it cannot. */
export function zipListed(level: ZipLevel, item: ZipItem, limits: ZipWalkLimits & { fileOutMax: number }): ZipListed {
  if (item.kind === "folder") return { kind: "folder", name: item.name, path: `${level.base}${item.path}`, files: item.files, size: item.size };
  const refusal = zipFileRefusal(item) ?? (item.size > limits.fileOutMax ? "too-big" : null);
  const path = `${level.base}${item.path}`;
  if (isZipName(item.name)) return { kind: "zip", name: item.name, path, size: item.size, opens: zipOpens(item, limits), ...(refusal ? { refusal } : {}) };
  return { kind: "file", name: item.name, path, size: item.size, ...(refusal ? { refusal } : {}) };
}

// ── A text file's words ──────────────────────────────────────────────────────

/** How many of a file's first bytes tell whether it is text. */
export const ZIP_TEXT_HEAD_BYTES = 8 * 1024;

/** The encoding a file's first bytes are text in, or null when they are not text: a NUL byte outside UTF-16, or mostly control characters. */
export function textEncodingOf(head: Uint8Array): { encoding: TextEncoding; bom: number } | null {
  const found = detectEncoding(head);
  if (found.encoding.kind === "utf-16le" || found.encoding.kind === "utf-16be") return found;
  if (head.includes(0)) return null;
  if (found.encoding.kind === "utf-8" && validUtf8(head.subarray(found.bom), true)) return found;
  // Neither UTF-8 nor UTF-16: Windows-1252 text, unless most of it is control characters.
  let control = 0;
  for (const b of head) if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c && b !== 0x1b) control++;
  return control * 50 > head.byteLength ? null : { encoding: found.encoding, bom: found.bom };
}

/** Part of a text file's words, by the bytes they take in it. */
export interface ZipText {
  /** The words, from `from` to `to`. */
  text: string;
  /** Where the words start and stop in the file's bytes; `to` is where the next read starts. */
  from: number;
  to: number;
  /** Whether the file goes on past `to`. */
  more: boolean;
  /** "UTF-8", "UTF-16 (little-endian)", "Windows-1252". */
  encoding: string;
}

/** A file that is not text: its first bytes say so. */
export class ZipNotText extends Error {
  constructor(readonly file: ZipFile) {
    super(`${file.name} is not text.`);
    this.name = "ZipNotText";
  }
}

/** Steps `at` forward past UTF-8 continuation bytes, so text never starts inside a character. */
function utf8Start(bytes: Uint8Array, at: number): number {
  let i = at;
  while (i < bytes.byteLength && i < at + 3 && (bytes[i]! & 0xc0) === 0x80) i++;
  return i;
}

/** Steps `end` back to the start of a UTF-8 character the bytes cut, so text never ends inside one. */
function utf8End(bytes: Uint8Array, end: number): number {
  for (let back = 1; back <= 3 && end - back >= 0; back++) {
    const b = bytes[end - back]!;
    if ((b & 0xc0) === 0x80) continue;
    // A lead byte: whole when the bytes after it are as many as it says.
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return back >= need ? end : end - back;
  }
  return end;
}

/**
 * Up to `max` bytes of a text file's words from `from`, inflated as the file is read and no further:
 * reading the first part of a big file unzips only that part. The file's first bytes say whether it
 * is text (`ZipNotText` when not) and in which encoding. Never inflates past the size the directory
 * gives the file, and throws `UnreadableFile` for a password, a way of compressing that is not read
 * here, or bytes that do not inflate.
 */
export async function zipText(source: ByteSource, file: ZipFile, opts: { from?: number; max: number }): Promise<ZipText> {
  const refusal = entryRefusal(file.entry);
  if (refusal) throw refusal;
  const from = Math.max(0, Math.min(Math.floor(opts.from ?? 0), file.size));
  const max = Math.max(4, Math.floor(opts.max));
  // Two parts of the file are kept: its first bytes, which tell the encoding, and the bytes from
  // `from`. Everything between them is inflated and let go.
  const head = new Uint8Array(Math.min(file.size, ZIP_TEXT_HEAD_BYTES));
  const part = new Uint8Array(Math.min(file.size - from, max));
  let headGot = 0;
  let partGot = 0;
  const stopAt = Math.max(head.byteLength, from + part.byteLength);
  let at = 0;
  const stream = entryBytes(source, file.entry);
  try {
    for await (const chunk of stream) {
      const chunkEnd = at + chunk.byteLength;
      if (at < head.byteLength) {
        const n = Math.min(chunkEnd, head.byteLength) - at;
        head.set(chunk.subarray(0, n), at);
        headGot = at + n;
      }
      const s = Math.max(at, from);
      const e = Math.min(chunkEnd, from + part.byteLength);
      if (e > s) {
        part.set(chunk.subarray(s - at, e - at), s - from);
        partGot = e - from;
      }
      at = chunkEnd;
      if (at >= stopAt) break;
    }
  } finally {
    // Stopping early cancels the inflater: the rest of the file is never unzipped.
    await stream.return(undefined).catch(() => undefined);
  }
  const found = textEncodingOf(head.subarray(0, headGot));
  if (!found) throw new ZipNotText(file);
  const { encoding, bom } = found;
  const bytes = part.subarray(0, partGot);
  // Offsets in the file; `bytes` starts at `from`.
  let start = Math.max(from, bom);
  let end = from + bytes.byteLength;
  if (unitBytes(encoding) === 2) {
    // UTF-16 reads in pairs from just after its byte order mark.
    start = bom + Math.ceil((start - bom) / 2) * 2;
    end = Math.max(start, bom + Math.floor((end - bom) / 2) * 2);
  } else if (encoding.kind === "utf-8") {
    start = from + utf8Start(bytes, start - from);
    if (end < file.size) end = Math.max(start, from + utf8End(bytes, end - from));
  }
  return {
    text: decode(bytes.subarray(start - from, end - from), encoding),
    from: start,
    to: end,
    more: end < file.size,
    encoding: encodingName(encoding),
  };
}

/** A file's whole bytes, inflated a chunk at a time, as a stream. Cancelling it cancels the inflater. */
export function zipFileStream(source: ByteSource, file: ZipFile): ReadableStream<Uint8Array> {
  const chunks = entryBytes(source, file.entry);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await chunks.return(undefined).catch(() => undefined);
    },
  });
}
