// A tar archive, the one file an export downloads as: `<name>.sqlite`, then `files/<fileId>/<name>`
// for each file. tar streams (each entry's header says its size, and its bytes follow), so the
// gateway writes it as it reads the pieces from the bucket and an import reads it back by range.
// Names longer than ustar's 100 bytes, names past ASCII and sizes past 8 GiB go in a PAX header
// before the entry, as `tar` on macOS, Linux and Windows reads them. Reading also takes GNU's long
// names.

import type { ByteSource } from "../../../store-readers/src/source.js";

import { MAGIC } from "./format.js";

const BLOCK = 512;
const ENC = new TextEncoder();
const DEC = new TextDecoder("utf-8", { fatal: false });

export function tarPadding(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}

/** The two empty blocks that end an archive. */
export const TAR_END = new Uint8Array(2 * BLOCK);

function putString(block: Uint8Array, at: number, length: number, text: string): void {
  const bytes = ENC.encode(text);
  block.set(bytes.subarray(0, length), at);
}

function putOctal(block: Uint8Array, at: number, length: number, value: number): void {
  putString(block, at, length - 1, value.toString(8).padStart(length - 1, "0"));
  block[at + length - 1] = 0;
}

function header(name: string, size: number, type: string, mtime: number): Uint8Array {
  const block = new Uint8Array(BLOCK);
  putString(block, 0, 100, name);
  putOctal(block, 100, 8, 0o644);
  putOctal(block, 108, 8, 0);
  putOctal(block, 116, 8, 0);
  if (size < 8 ** 11) putOctal(block, 124, 12, size);
  else {
    // GNU's base-256 size, for readers that skip PAX: the high bit set, then the number.
    block[124] = 0x80;
    let v = BigInt(size);
    for (let i = 135; i > 124; i--) {
      block[i] = Number(v & 0xffn);
      v >>= 8n;
    }
  }
  putOctal(block, 136, 12, Math.floor(mtime / 1000));
  block.fill(0x20, 148, 156);
  putString(block, 156, 1, type);
  putString(block, 257, 6, "ustar");
  block[262] = 0;
  putString(block, 263, 2, "00");
  let sum = 0;
  for (const b of block) sum += b;
  putString(block, 148, 6, sum.toString(8).padStart(6, "0"));
  block[154] = 0;
  block[155] = 0x20;
  return block;
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = ENC.encode(body).byteLength + 1;
  while (String(length).length + ENC.encode(body).byteLength !== length) length = String(length).length + ENC.encode(body).byteLength;
  return `${length}${body}`;
}

/** An entry's header blocks: a PAX header first when the name or the size needs one. */
export function tarHeader(path: string, size: number, mtime: number): Uint8Array {
  const plain = /^[\x20-\x7e]{1,100}$/.test(path) && size < 8 ** 11;
  if (plain) return header(path, size, "0", mtime);
  const records = (/^[\x20-\x7e]{1,100}$/.test(path) ? "" : paxRecord("path", path)) + (size < 8 ** 11 ? "" : paxRecord("size", String(size)));
  const pax = ENC.encode(records);
  const out = new Uint8Array(BLOCK + pax.byteLength + tarPadding(pax.byteLength) + BLOCK);
  out.set(header("PaxHeader", pax.byteLength, "x", mtime), 0);
  out.set(pax, BLOCK);
  const short = path.replace(/[^\x20-\x7e]/g, "_");
  out.set(header(short.length <= 100 ? short : short.slice(short.length - 100), size, "0", mtime), BLOCK + pax.byteLength + tarPadding(pax.byteLength));
  return out;
}

/** The longest a file's name is in an archive, in bytes: most file systems take 255. */
const NAME_BYTES_MAX = 240;

/** A file's name in an archive: as it is, unless a file system could not hold it; then shortened, keeping its extension. */
export function archiveFileName(name: string): string {
  if (ENC.encode(name).byteLength <= NAME_BYTES_MAX) return name;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
  const room = NAME_BYTES_MAX - ENC.encode(extension).byteLength;
  let kept = "";
  let used = 0;
  for (const character of name.slice(0, name.length - extension.length)) {
    used += ENC.encode(character).byteLength;
    if (used > room) break;
    kept += character;
  }
  return kept + extension;
}

/** Whether a file's first block is a tar header (ustar's magic, as POSIX and GNU write it). */
export function looksLikeTar(head: Uint8Array): boolean {
  return head.byteLength >= BLOCK && DEC.decode(head.subarray(257, 262)) === "ustar";
}

function cString(block: Uint8Array, at: number, length: number): string {
  const slice = block.subarray(at, at + length);
  const end = slice.indexOf(0);
  return DEC.decode(end < 0 ? slice : slice.subarray(0, end));
}

function sizeField(block: Uint8Array): number {
  if (block[124]! & 0x80) {
    let v = 0;
    for (let i = 125; i < 136; i++) v = v * 256 + block[i]!;
    return v;
  }
  const text = cString(block, 124, 12).trim();
  return text ? parseInt(text, 8) : 0;
}

export interface TarContents {
  /** The archive's SQLite file: the shallowest `.sqlite`, `.sqlite3` or `.db` outside `files/` that is one. */
  db: { name: string; offset: number; size: number } | null;
  /** Each file's bytes, by its id, from `files/<fileId>/<name>` (under one folder too). */
  files: Map<string, { name: string; offset: number; size: number }>;
}

const FILE_ENTRY = /(?:^|\/)files\/(fil_[0-9a-f]{24})\/([^/]+)$/;
const ENTRIES_MAX = 200_000;

/** A PAX header's records, each read by the length it starts with: a value may hold any character. */
function paxRecords(bytes: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  for (let at = 0; at < bytes.byteLength; ) {
    const space = bytes.indexOf(0x20, at);
    if (space < 0) break;
    const length = parseInt(DEC.decode(bytes.subarray(at, space)), 10);
    if (!Number.isInteger(length) || length <= space - at || at + length > bytes.byteLength) break;
    const body = bytes.subarray(space + 1, at + length - 1);
    const equals = body.indexOf(0x3d);
    if (equals > 0) out.set(DEC.decode(body.subarray(0, equals)), DEC.decode(body.subarray(equals + 1)));
    at += length;
  }
  return out;
}

/** Where an archive's entries are, read header by header; nothing else of it is read. */
export async function readTar(source: ByteSource): Promise<TarContents> {
  const out: TarContents = { db: null, files: new Map() };
  const databases: { name: string; offset: number; size: number; depth: number }[] = [];
  let at = 0;
  let entries = 0;
  let paxPath: string | null = null;
  let paxSize: number | null = null;
  let longName: string | null = null;
  while (at + BLOCK <= source.size) {
    const block = await source.read(at, BLOCK);
    if (block.byteLength < BLOCK || block.every((b) => b === 0)) break;
    const type = String.fromCharCode(block[156]!);
    const size = sizeField(block);
    const data = at + BLOCK;
    const next = data + size + tarPadding(size);
    if (type === "x" || type === "L") {
      if (size > 1024 * 1024) throw new Error("A header in this archive is too long.");
      const bytes = await source.read(data, size);
      if (type === "L") longName = DEC.decode(bytes).replace(/\0+$/, "");
      else {
        const records = paxRecords(bytes);
        paxPath = records.get("path") ?? paxPath;
        const said = records.get("size");
        if (said !== undefined) paxSize = Number(said);
      }
      at = next;
      continue;
    }
    if (type === "0" || type === "\0" || type === "7") {
      if (++entries > ENTRIES_MAX) throw new Error("This archive holds more files than a store's export does.");
      const prefix = cString(block, 345, 155);
      const name = cString(block, 0, 100);
      const path = (paxPath ?? longName ?? (prefix ? `${prefix}/${name}` : name)).replace(/^(\.\/)+/, "").replace(/^\/+/, "");
      const length = paxSize ?? size;
      const file = FILE_ENTRY.exec(path);
      if (file) out.files.set(file[1]!, { name: file[2]!, offset: data, size: length });
      else if (/\.(sqlite3?|db)$/i.test(path) && !/(^|\/)files\//.test(path)) databases.push({ name: path, offset: data, size: length, depth: path.split("/").length });
      at = data + length + tarPadding(length);
    } else {
      at = next;
    }
    paxPath = null;
    paxSize = null;
    longName = null;
  }
  // The shallowest that really is a SQLite file: macOS's `._x.sqlite` and Windows's `Thumbs.db`
  // carry the suffix and are not.
  databases.sort((a, b) => a.depth - b.depth);
  for (const db of databases.slice(0, 20)) {
    const head = db.size >= MAGIC.byteLength ? await source.read(db.offset, MAGIC.byteLength) : new Uint8Array(0);
    if (head.byteLength === MAGIC.byteLength && MAGIC.every((b, i) => head[i] === b)) {
      out.db = { name: db.name, offset: db.offset, size: db.size };
      break;
    }
  }
  return out;
}
