// Zip files, read by range: an .xlsx or .ods workbook's parts, and the files a zip archive holds.
//
// The directory is read from the end of the file, then each entry where it is: a stored entry is
// a range of the zip's bytes, and a deflated one is inflated as a stream
// (`DecompressionStream("deflate-raw")`, native in workerd and Node). Nothing is ever held whole
// except where a caller asks for an entry whole (`wholeEntry`), under its own cap.
//
// An entry is read one of three ways:
//   - `entryBytes`: its bytes, inflated, a chunk at a time, once through;
//   - `entrySource`: a `ByteSource` over it. A stored entry's is a range of the zip and reads any
//     part at any time. A deflated entry's inflates forward: a read behind the last one inflates
//     the entry again from its start, so it suits readers that read forward (delimited text, a
//     dBase table, JSON, XML);
//   - `wholeEntry`: inflated into memory, for a reader that reads its file in any order (a
//     workbook, a database) when the entry is deflated.

import { type ByteSource, bytesSource } from "./source.js";
import { decodeCodePage, validUtf8 } from "./text.js";
import { UnreadableFile } from "./types.js";

/** One file in a zip, from its directory. */
export interface ZipEntry {
  /** Its name in the zip, folders joined by "/". */
  name: string;
  /** 0 stored, 8 deflated; anything else is a method a store does not read. */
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  /** General purpose flags: bit 0 says the entry is encrypted. */
  flags: number;
}

export const u16 = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8);
export const u32 = (b: Uint8Array, at: number): number => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)) + b[at + 3]! * 0x1000000;
const u64 = (b: Uint8Array, at: number): number => u32(b, at) + u32(b, at + 4) * 0x1_0000_0000;

const utf8 = new TextDecoder("utf-8");

/**
 * An entry's name: UTF-8 when the entry says so (flag bit 11) or carries Info-ZIP's Unicode path
 * field, UTF-8 when the bytes are valid UTF-8, else code page 437, what Windows writes for US
 * systems.
 */
function entryName(raw: Uint8Array, flags: number, extra: Uint8Array): string {
  if (flags & 0x800) return utf8.decode(raw);
  for (let p = 0; p + 4 <= extra.byteLength; ) {
    const id = u16(extra, p);
    const length = u16(extra, p + 2);
    if (id === 0x7075 && length > 5 && p + 4 + length <= extra.byteLength) return utf8.decode(extra.subarray(p + 9, p + 4 + length));
    p += 4 + length;
  }
  return validUtf8(raw) ? utf8.decode(raw) : decodeCodePage(raw, 437);
}

/** The 64-bit sizes and offset of an entry whose 32-bit fields are full (0xFFFFFFFF). */
function zip64Fields(extra: Uint8Array, entry: { size: number; compressedSize: number; localOffset: number }): void {
  for (let p = 0; p + 4 <= extra.byteLength; ) {
    const id = u16(extra, p);
    const length = u16(extra, p + 2);
    if (id === 0x0001) {
      let at = p + 4;
      const end = at + length;
      if (entry.size === 0xffffffff && at + 8 <= end) (entry.size = u64(extra, at)), (at += 8);
      if (entry.compressedSize === 0xffffffff && at + 8 <= end) (entry.compressedSize = u64(extra, at)), (at += 8);
      if (entry.localOffset === 0xffffffff && at + 8 <= end) entry.localOffset = u64(extra, at);
      return;
    }
    p += 4 + length;
  }
}

/**
 * A zip's entries by name, in the order its directory lists them. `what` names the file in a
 * refusal: "This workbook", "This zip file". `maxListBytes` refuses a directory longer than that
 * before reading it ("too-big"), for a caller that holds it in a small memory.
 */
export async function zipEntries(source: ByteSource, what: string, maxListBytes = Number.POSITIVE_INFINITY): Promise<Map<string, ZipEntry>> {
  const tailLength = Math.min(source.size, 65_557);
  const tail = await source.read(source.size - tailLength, tailLength);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new UnreadableFile(`${what}'s zip directory is missing; the file may be cut short.`, "damaged");
  let count = u16(tail, eocd + 10);
  let dirSize = u32(tail, eocd + 12);
  let dirOffset = u32(tail, eocd + 16);
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
    // A Zip64 file: its locator, just before the end record, says where the 64-bit end record is.
    const locator = eocd - 20;
    if (locator < 0 || u32(tail, locator) !== 0x07064b50) throw new UnreadableFile(`${what}'s zip directory is damaged.`, "damaged");
    const recordAt = u64(tail, locator + 8);
    const record = await source.read(recordAt, 56);
    if (record.byteLength < 56 || u32(record, 0) !== 0x06064b50) throw new UnreadableFile(`${what}'s zip directory is damaged.`, "damaged");
    count = u64(record, 32);
    dirSize = u64(record, 40);
    dirOffset = u64(record, 48);
  }
  if (dirOffset + dirSize > source.size) throw new UnreadableFile(`${what}'s zip directory points past the end of the file; the file may be cut short.`, "damaged");
  if (dirSize > maxListBytes) throw new UnreadableFile(`${what}'s zip directory is longer than ${maxListBytes} bytes.`, "too-big");
  const dir = await source.read(dirOffset, dirSize);
  const out = new Map<string, ZipEntry>();
  for (let p = 0, n = 0; n < count && p + 46 <= dir.byteLength; n++) {
    if (u32(dir, p) !== 0x02014b50) throw new UnreadableFile(`${what}'s zip directory is damaged.`, "damaged");
    const flags = u16(dir, p + 8);
    const nameLength = u16(dir, p + 28);
    const extraLength = u16(dir, p + 30);
    const commentLength = u16(dir, p + 32);
    const extra = dir.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength);
    const entry: ZipEntry = {
      name: entryName(dir.subarray(p + 46, p + 46 + nameLength), flags, extra),
      method: u16(dir, p + 10),
      compressedSize: u32(dir, p + 20),
      size: u32(dir, p + 24),
      localOffset: u32(dir, p + 42),
      flags,
    };
    zip64Fields(extra, entry);
    out.set(entry.name.replace(/\\/g, "/").replace(/^\/+/, ""), entry);
    p += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

const CHUNK = 1 << 20;

/** Where an entry's bytes start: after its local header, whose name and extra field may differ from the directory's. */
async function dataStart(source: ByteSource, entry: ZipEntry): Promise<number> {
  const local = await source.read(entry.localOffset, 30);
  if (local.byteLength < 30 || u32(local, 0) !== 0x04034b50) throw new UnreadableFile(`${entry.name} inside this file is damaged.`, "damaged");
  return entry.localOffset + 30 + u16(local, 26) + u16(local, 28);
}

/** Why an entry cannot be read at all, or null when it can. */
export function entryRefusal(entry: ZipEntry): UnreadableFile | null {
  if (entry.flags & 1) return new UnreadableFile(`${entry.name} is protected with a password inside the zip. Zip it again without one and upload that.`, "unsupported");
  if (entry.method !== 0 && entry.method !== 8) {
    return new UnreadableFile(`${entry.name} is compressed inside the zip in a way a store does not read. Zip it again with ordinary compression, or upload the file itself.`, "unsupported");
  }
  return null;
}

/**
 * An entry's bytes, inflated, a chunk at a time, never more than the directory says it holds.
 * Stopping early cancels the inflater.
 */
export async function* entryBytes(source: ByteSource, entry: ZipEntry): AsyncGenerator<Uint8Array> {
  const refusal = entryRefusal(entry);
  if (refusal) throw refusal;
  const start = await dataStart(source, entry);
  if (start + entry.compressedSize > source.size) throw new UnreadableFile(`${entry.name} inside this file runs past the file's end; the file may be cut short.`, "damaged");
  if (entry.method === 0) {
    for (let at = 0; at < entry.compressedSize; at += CHUNK) yield await source.read(start + at, Math.min(CHUNK, entry.compressedSize - at));
    return;
  }
  const inflater = new DecompressionStream("deflate-raw");
  const writer = inflater.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
  const reader = inflater.readable.getReader();
  /** A read of the zip that failed: thrown as itself, so a caller can try the read again. */
  let readFailure: { error: unknown } | null = null;
  const feeding = (async () => {
    try {
      for (let at = 0; at < entry.compressedSize; at += CHUNK) {
        let bytes: Uint8Array;
        try {
          bytes = await source.read(start + at, Math.min(CHUNK, entry.compressedSize - at));
        } catch (err) {
          readFailure = { error: err };
          throw err;
        }
        await writer.write(bytes);
      }
      await writer.close();
    } catch (err) {
      // A failure fails the inflater too, so the reader below throws instead of waiting for bytes
      // that will never come.
      await writer.abort(err).catch(() => undefined);
      throw err;
    }
  })();
  // The failure reaches the caller through the reader; this keeps it from being unhandled.
  feeding.catch(() => undefined);
  let finished = false;
  let given = 0;
  try {
    for (;;) {
      // Typed by the reader itself: hosts differ in what they call a read's result, and in whether
      // a finished read holds a value.
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (err) {
        if (readFailure) throw (readFailure as { error: unknown }).error;
        if (err instanceof UnreadableFile) throw err;
        // Anything else is the inflater refusing bytes that are not deflate data.
        throw new UnreadableFile(`${entry.name} inside this file is damaged: its compressed bytes do not inflate.`, "damaged");
      }
      if (next.done) {
        if (given < entry.size) throw new UnreadableFile(`${entry.name} inside this file ends before the size the file's directory gives it, so the file may be damaged.`, "damaged");
        break;
      }
      given += next.value.byteLength;
      if (given > entry.size) throw new UnreadableFile(`${entry.name} inside this file holds more than the file's directory says, so the file may be damaged.`, "damaged");
      yield next.value;
    }
    finished = true;
    await feeding;
  } finally {
    if (!finished) {
      await reader.cancel().catch(() => undefined);
      await writer.abort().catch(() => undefined);
    }
  }
}

/** A small part (a workbook's list of sheets, its styles) as text. */
export async function entryText(source: ByteSource, entry: ZipEntry | undefined): Promise<string> {
  if (!entry) return "";
  const decoder = new TextDecoder("utf-8");
  let text = "";
  for await (const chunk of entryBytes(source, entry)) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

/**
 * A deflated entry as a source that inflates forward. It keeps the bytes from the last read's
 * start to where the stream stopped, so the next read, which starts inside the last one or after
 * it, inflates nothing twice; a read behind them inflates the entry again from its start. A read
 * of the whole entry (an Access database) holds it once.
 */
function inflatedSource(source: ByteSource, entry: ZipEntry): ByteSource {
  let stream: AsyncGenerator<Uint8Array> | null = null;
  /** Inflated bytes the stream has given. */
  let given = 0;
  /** The bytes from `keptAt` to `given`. */
  let kept: Uint8Array = new Uint8Array(0);
  let keptAt = 0;
  async function restart(): Promise<void> {
    if (stream) await stream.return(undefined).catch(() => undefined);
    stream = entryBytes(source, entry);
    given = 0;
    kept = new Uint8Array(0);
    keptAt = 0;
  }
  return {
    size: entry.size,
    async read(offset, length) {
      const end = Math.min(entry.size, offset + Math.max(0, length));
      if (offset >= end) return new Uint8Array(0);
      if (!stream || offset < keptAt) await restart();
      let filled = 0;
      let tail: Uint8Array | null = null;
      if (offset < keptAt + kept.byteLength) {
        // The kept bytes from this read's start: all of it, or its first part.
        tail = kept.subarray(offset - keptAt);
        if (tail.byteLength >= end - offset) {
          kept = tail;
          keptAt = offset;
          return tail.subarray(0, end - offset);
        }
      }
      const out = new Uint8Array(end - offset);
      if (tail) {
        out.set(tail);
        filled = tail.byteLength;
      }
      let rest: Uint8Array | null = null;
      try {
        while (filled < out.byteLength) {
          const { value, done } = await stream!.next();
          if (done) break;
          const chunkAt = given;
          given += value.byteLength;
          // A chunk wholly before the read is passed over: the read jumped ahead of the stream.
          if (given <= offset) continue;
          const from = Math.max(0, offset - chunkAt);
          const take = Math.min(value.byteLength - from, out.byteLength - filled);
          out.set(value.subarray(from, from + take), filled);
          filled += take;
          if (from + take < value.byteLength) rest = value.subarray(from + take);
        }
      } catch (err) {
        // A stream that threw is finished: the next read starts it again.
        stream = null;
        throw err;
      }
      const got = out.subarray(0, filled);
      // What the stream gave past this read is kept with it, for the read after.
      if (rest) {
        kept = new Uint8Array(filled + rest.byteLength);
        kept.set(got);
        kept.set(rest, filled);
      } else kept = got;
      keptAt = offset;
      return got;
    },
  };
}

/** A stored entry's bytes, as a range of the zip's. */
function rangeSource(source: ByteSource, start: number, size: number): ByteSource {
  return {
    size,
    read: (offset, length) => {
      const from = Math.max(0, offset);
      const to = Math.min(size, offset + Math.max(0, length));
      return to > from ? source.read(start + from, to - from) : Promise.resolve(new Uint8Array(0));
    },
  };
}

/** An entry as a source: a range of the zip when stored, an inflating stream when deflated. */
export async function entrySource(source: ByteSource, entry: ZipEntry): Promise<ByteSource> {
  const refusal = entryRefusal(entry);
  if (refusal) throw refusal;
  if (entry.method === 0) {
    const start = await dataStart(source, entry);
    if (start + entry.size > source.size) throw new UnreadableFile(`${entry.name} inside this file runs past the file's end; the file may be cut short.`, "damaged");
    return rangeSource(source, start, entry.size);
  }
  return inflatedSource(source, entry);
}

/** A deflated entry inflated into memory, as a source; a stored one stays a range of the zip. */
export async function wholeEntry(source: ByteSource, entry: ZipEntry): Promise<ByteSource> {
  if (entry.method === 0) return entrySource(source, entry);
  const out = new Uint8Array(entry.size);
  let at = 0;
  for await (const chunk of entryBytes(source, entry)) out.set(chunk, at), (at += chunk.byteLength);
  return bytesSource(at === out.byteLength ? out : out.subarray(0, at));
}
