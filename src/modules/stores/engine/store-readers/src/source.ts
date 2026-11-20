// Where a reader's bytes come from. Inside a store's object a file is read from R2 by range, so a
// reader asks for the bytes it needs and never assumes the whole file is in memory; in Node a test
// reads a file from disk or from memory the same way.

/** A file a reader reads by range. */
export interface ByteSource {
  /** The file's size in bytes. */
  readonly size: number;
  /** `length` bytes from `offset`; fewer only where the file ends first. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** Bytes already in memory, as a source. */
export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.byteLength,
    read: async (offset, length) => bytes.subarray(Math.max(0, offset), Math.min(bytes.byteLength, offset + Math.max(0, length))),
  };
}

/** The whole file, for a format read at once (Excel, Access). */
export async function readAll(source: ByteSource): Promise<Uint8Array> {
  return source.read(0, source.size);
}

/**
 * A source read through windows of `windowBytes`, the last few kept: a dBase memo file, whose
 * memos a table's rows point at one by one, mostly in order. A read larger than a window goes
 * straight to the source.
 */
export function windowedSource(source: ByteSource, windowBytes = 1 << 20, keep = 4): ByteSource {
  const windows = new Map<number, Uint8Array>();
  const windowAt = async (index: number): Promise<Uint8Array> => {
    const hit = windows.get(index);
    if (hit) {
      // The most recently used window goes last; the first one is the next to drop.
      windows.delete(index);
      windows.set(index, hit);
      return hit;
    }
    const bytes = await source.read(index * windowBytes, windowBytes);
    windows.set(index, bytes);
    while (windows.size > keep) windows.delete(windows.keys().next().value!);
    return bytes;
  };
  return {
    size: source.size,
    async read(offset, length) {
      const end = Math.min(source.size, offset + length);
      if (offset >= end) return new Uint8Array(0);
      if (end - offset > windowBytes) return source.read(offset, end - offset);
      const first = Math.floor(offset / windowBytes);
      const last = Math.floor((end - 1) / windowBytes);
      if (first === last) {
        const w = await windowAt(first);
        return w.subarray(offset - first * windowBytes, end - first * windowBytes);
      }
      const out = new Uint8Array(end - offset);
      let at = 0;
      for (let i = first; i <= last; i++) {
        const w = await windowAt(i);
        const from = i === first ? offset - first * windowBytes : 0;
        const to = i === last ? end - last * windowBytes : w.byteLength;
        out.set(w.subarray(from, to), at);
        at += to - from;
      }
      return out;
    },
  };
}
