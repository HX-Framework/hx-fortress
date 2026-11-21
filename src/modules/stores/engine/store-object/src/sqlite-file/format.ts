// SQLite's file format, as far as a store's export and import write and read it
// (https://www.sqlite.org/fileformat2.html): 4096-byte pages, UTF-8 text, schema format 4, no
// reserved bytes, no free pages. A Durable Object cannot hand out its database file, so a store
// writes the file itself from its rows, and reads one back the same way.

/** Every page the writer makes is this long. The reader takes any page size SQLite allows. */
export const PAGE_SIZE = 4096;

export const PAGE_INTERIOR_INDEX = 0x02;
export const PAGE_INTERIOR_TABLE = 0x05;
export const PAGE_LEAF_INDEX = 0x0a;
export const PAGE_LEAF_TABLE = 0x0d;

/** The first 16 bytes of every SQLite database file. */
export const MAGIC = new TextEncoder().encode("SQLite format 3\u0000");

/** A value as a record holds it. A whole number past what a JS number holds is a bigint. */
export type SqliteValue = null | number | bigint | string | Uint8Array;

/** The most bytes of a cell's payload kept on its own page, and the least when it overflows. */
export function payloadLimits(usable: number, kind: "table-leaf" | "index"): { maxLocal: number; minLocal: number } {
  const minLocal = Math.floor(((usable - 12) * 32) / 255) - 23;
  const maxLocal = kind === "table-leaf" ? usable - 35 : Math.floor(((usable - 12) * 64) / 255) - 23;
  return { maxLocal, minLocal };
}

/** How many of a payload's bytes stay on the cell's page; the rest go to overflow pages. */
export function localPayloadSize(payload: number, usable: number, kind: "table-leaf" | "index"): number {
  const { maxLocal, minLocal } = payloadLimits(usable, kind);
  if (payload <= maxLocal) return payload;
  const k = minLocal + ((payload - minLocal) % (usable - 4));
  return k <= maxLocal ? k : minLocal;
}

// ── Varints: 1 to 9 bytes, big-endian, seven bits a byte and eight in the ninth ──────────────────

export function varintLength(value: bigint | number): number {
  let v = BigInt.asUintN(64, BigInt(value));
  if (v > 0x00ffffffffffffffn) return 9;
  let n = 1;
  while (v > 0x7fn) {
    v >>= 7n;
    n++;
  }
  return n;
}

/** Writes `value` at `at`; answers the bytes it took. */
export function putVarint(out: Uint8Array, at: number, value: bigint | number): number {
  let v = BigInt.asUintN(64, BigInt(value));
  if (v > 0x00ffffffffffffffn) {
    out[at + 8] = Number(v & 0xffn);
    v >>= 8n;
    for (let i = 7; i >= 0; i--) {
      out[at + i] = Number(v & 0x7fn) | 0x80;
      v >>= 7n;
    }
    return 9;
  }
  const bytes: number[] = [];
  bytes.push(Number(v & 0x7fn));
  v >>= 7n;
  while (v > 0n) {
    bytes.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  for (let i = 0; i < bytes.length; i++) out[at + i] = bytes[bytes.length - 1 - i]!;
  return bytes.length;
}

export function encodeVarint(value: bigint | number): Uint8Array {
  const out = new Uint8Array(varintLength(value));
  putVarint(out, 0, value);
  return out;
}

/** Reads a varint at `at`: its value (as a signed 64-bit integer) and the bytes it took. */
export function readVarint(bytes: Uint8Array, at: number): { value: bigint; length: number } {
  let v = 0n;
  for (let i = 0; i < 8; i++) {
    const b = bytes[at + i];
    if (b === undefined) throw new SqliteFileError("A varint runs past the end of its page.");
    v = (v << 7n) | BigInt(b & 0x7f);
    if ((b & 0x80) === 0) return { value: BigInt.asIntN(64, v), length: i + 1 };
  }
  const last = bytes[at + 8];
  if (last === undefined) throw new SqliteFileError("A varint runs past the end of its page.");
  v = (v << 8n) | BigInt(last);
  return { value: BigInt.asIntN(64, v), length: 9 };
}

/** A varint known to be small enough for a JS number: a length, a page number, a serial type. */
export function readSmallVarint(bytes: Uint8Array, at: number): { value: number; length: number } {
  const { value, length } = readVarint(bytes, at);
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new SqliteFileError("A length in the file is out of range.");
  return { value: Number(value), length };
}

// ── Records: a header of serial types, then the values ───────────────────────────────────────────

const TEXT = new TextEncoder();
// `ignoreBOM` keeps a leading U+FEFF: it is part of the value here, not a mark about the bytes.
const UTF8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

function integerType(v: bigint): { type: number; size: number } {
  if (v === 0n) return { type: 8, size: 0 };
  if (v === 1n) return { type: 9, size: 0 };
  if (v >= -128n && v <= 127n) return { type: 1, size: 1 };
  if (v >= -32768n && v <= 32767n) return { type: 2, size: 2 };
  if (v >= -8388608n && v <= 8388607n) return { type: 3, size: 3 };
  if (v >= -2147483648n && v <= 2147483647n) return { type: 4, size: 4 };
  if (v >= -140737488355328n && v <= 140737488355327n) return { type: 5, size: 6 };
  return { type: 6, size: 8 };
}

type Encoded = { type: number; size: number; write(out: Uint8Array, at: number): void };

function encodeValue(value: SqliteValue): Encoded {
  if (value === null) return { type: 0, size: 0, write: () => {} };
  if (typeof value === "bigint" || (typeof value === "number" && Number.isInteger(value) && !Object.is(value, -0) && Math.abs(value) < 2 ** 63)) {
    let v = BigInt(value);
    if (v < I64_MIN || v > I64_MAX) v = BigInt.asIntN(64, v);
    const { type, size } = integerType(v);
    return {
      type,
      size,
      write(out, at) {
        let x = BigInt.asUintN(size * 8, v);
        for (let i = size - 1; i >= 0; i--) {
          out[at + i] = Number(x & 0xffn);
          x >>= 8n;
        }
      },
    };
  }
  if (typeof value === "number") {
    return {
      type: 7,
      size: 8,
      write(out, at) {
        new DataView(out.buffer, out.byteOffset + at, 8).setFloat64(0, value, false);
      },
    };
  }
  if (typeof value === "string") {
    const bytes = TEXT.encode(value);
    return { type: bytes.length * 2 + 13, size: bytes.length, write: (out, at) => out.set(bytes, at) };
  }
  const bytes = value;
  return { type: bytes.length * 2 + 12, size: bytes.length, write: (out, at) => out.set(bytes, at) };
}

/** A record: its header (its own length, then a serial type per value) and the values. */
export function encodeRecord(values: readonly SqliteValue[]): Uint8Array {
  const parts = values.map(encodeValue);
  let typesLength = 0;
  let bodyLength = 0;
  for (const p of parts) {
    typesLength += varintLength(p.type);
    bodyLength += p.size;
  }
  // The header's length counts the varint that says it.
  let headerLength = typesLength + 1;
  while (varintLength(headerLength) + typesLength !== headerLength) headerLength = varintLength(headerLength) + typesLength;
  const out = new Uint8Array(headerLength + bodyLength);
  let at = putVarint(out, 0, headerLength);
  for (const p of parts) at += putVarint(out, at, p.type);
  for (const p of parts) {
    p.write(out, at);
    at += p.size;
  }
  return out;
}

/** The values of a record. Text is UTF-8; an integer past what a JS number holds is a bigint. */
export function decodeRecord(bytes: Uint8Array): SqliteValue[] {
  const { value: headerLength, length } = readSmallVarint(bytes, 0);
  if (headerLength > bytes.length) throw new SqliteFileError("A record's header runs past its end.");
  const types: number[] = [];
  for (let at = length; at < headerLength; ) {
    const t = readSmallVarint(bytes, at);
    types.push(t.value);
    at += t.length;
  }
  const out: SqliteValue[] = [];
  let at = headerLength;
  for (const type of types) {
    if (type === 0) out.push(null);
    else if (type === 8) out.push(0);
    else if (type === 9) out.push(1);
    else if (type >= 1 && type <= 6) {
      const size = [0, 1, 2, 3, 4, 6, 8][type]!;
      let v = 0n;
      for (let i = 0; i < size; i++) v = (v << 8n) | BigInt(bytes[at + i] ?? 0);
      v = BigInt.asIntN(size * 8, v);
      out.push(v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v);
      at += size;
    } else if (type === 7) {
      out.push(new DataView(bytes.buffer, bytes.byteOffset + at, 8).getFloat64(0, false));
      at += 8;
    } else if (type >= 12) {
      const size = (type - (type % 2 === 0 ? 12 : 13)) / 2;
      const slice = bytes.subarray(at, at + size);
      out.push(type % 2 === 0 ? slice.slice() : UTF8.decode(slice));
      at += size;
    } else {
      throw new SqliteFileError(`A record holds serial type ${type}, which SQLite keeps for itself.`);
    }
    if (at > bytes.length) throw new SqliteFileError("A record's values run past its end.");
  }
  return out;
}

/** Something about a SQLite file that the store cannot write or read, in plain words. */
export class SqliteFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqliteFileError";
  }
}

export function u16(bytes: Uint8Array, at: number): number {
  return (bytes[at]! << 8) | bytes[at + 1]!;
}

export function u32(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! << 24) >>> 0) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!;
}

export function putU16(out: Uint8Array, at: number, value: number): void {
  out[at] = (value >>> 8) & 0xff;
  out[at + 1] = value & 0xff;
}

export function putU32(out: Uint8Array, at: number, value: number): void {
  out[at] = (value >>> 24) & 0xff;
  out[at + 1] = (value >>> 16) & 0xff;
  out[at + 2] = (value >>> 8) & 0xff;
  out[at + 3] = value & 0xff;
}
