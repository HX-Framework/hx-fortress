// Stand-ins the suite uses on every host, because no host differs in them: a clock a test moves by
// hand, randomness a test can follow, the state around a storage, and a bucket of files kept in
// memory. Nothing here needs a platform or a SQLite, so they load wherever the suite runs.

import type { StoreState } from "../../src/core.js";
import type { StoreFiles } from "../../src/store-files.js";
import type { SharedWrites, WriteBudget } from "../../src/types.js";
import type { HostStorage } from "./host.js";

/**
 * An organization's daily write budget kept in memory, as a deployment's gateway keeps one for every
 * organization (write-limit.ts): what each store told it, per UTC day, against a limit a test sets.
 */
export class FakeBudget implements WriteBudget {
  limit: number;
  /** Rows the organization's stores wrote, by UTC day. */
  readonly days = new Map<string, number>();
  /** Every report, in order: a store's rows, or 0 when it only asked. */
  readonly reports: { day: string; rows: number }[] = [];
  /** While true, every report fails, as a budget out of reach does. */
  unreachable = false;

  constructor(limit = 2_000_000) {
    this.limit = limit;
  }

  wrote = async (day: string, rows: number): Promise<SharedWrites> => {
    this.reports.push({ day, rows });
    if (this.unreachable) throw new Error("The budget could not be reached.");
    const n = (this.days.get(day) ?? 0) + rows;
    this.days.set(day, n);
    return { day, rows: n, limit: this.limit };
  };

  /** Rows another store of the organization wrote on `day`. */
  othersWrote(day: string, rows: number): void {
    this.days.set(day, (this.days.get(day) ?? 0) + rows);
  }
}

/** A clock a test moves by hand. */
export class FakeClock {
  t: number;
  constructor(start = Date.UTC(2026, 10, 7, 12, 0, 0)) {
    this.t = start;
  }
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

let counter = 0;
/** Randomness a test can follow: a counter in hex. */
export function countingHex(bytes: number): string {
  counter += 1;
  return counter.toString(16).padStart(bytes * 2, "0");
}

/** The state a store gets around a storage: it remembers why the store asked to be stopped, and runs one thing at a time. */
export class FakeState<S extends HostStorage = HostStorage> implements StoreState {
  readonly storage: S;
  aborted: string | null = null;

  constructor(storage: S) {
    this.storage = storage;
  }

  abort(reason?: string): void {
    this.aborted = reason ?? "aborted";
  }

  async blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  }
}

interface FileMetadata {
  contentType?: string;
}

/** One object of a bucket in memory, as a test reads it directly. */
export interface MemoryObject {
  bytes: Uint8Array;
  httpMetadata?: FileMetadata;
  customMetadata?: Record<string, string>;
  etag: string;
}

type Range = { offset?: number; length?: number } | { suffix: number };

async function bytesOf(value: unknown): Promise<Uint8Array> {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  if (value instanceof ReadableStream) return new Uint8Array(await new Response(value).arrayBuffer());
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value === null || value === undefined) return new Uint8Array(0);
  throw new Error("unsupported R2 value");
}

/**
 * A bucket in memory, as R2 answers where a bug would hide: ranges, listing with metadata, and
 * multipart uploads. A test reads `objects` and `uploads` directly.
 */
export class MemoryFiles {
  readonly objects = new Map<string, MemoryObject>();
  readonly uploads = new Map<string, { key: string; httpMetadata?: FileMetadata; customMetadata?: Record<string, string>; parts: Map<number, { bytes: Uint8Array; etag: string }> }>();
  private version = 0;

  private describe(key: string, o: MemoryObject, range?: { offset: number; length: number }) {
    return {
      key,
      version: String(this.version),
      size: o.bytes.byteLength,
      etag: o.etag,
      httpEtag: `"${o.etag}"`,
      httpMetadata: o.httpMetadata,
      customMetadata: o.customMetadata,
      range,
      uploaded: new Date(0),
      storageClass: "Standard",
      checksums: {},
      writeHttpMetadata(headers: Headers) {
        if (o.httpMetadata?.contentType) headers.set("content-type", o.httpMetadata.contentType);
      },
    };
  }

  async get(key: string, options?: { range?: Range | Headers; onlyIf?: Headers }) {
    const o = this.objects.get(key);
    if (!o) return null;
    // As R2 does: a precondition that fails answers the object without its body.
    const only = options?.onlyIf;
    if (only instanceof Headers) {
      const tag = `"${o.etag}"`;
      const ifMatch = only.get("if-match");
      const ifNoneMatch = only.get("if-none-match");
      if ((ifMatch && ifMatch !== "*" && ifMatch !== tag) || (ifNoneMatch && (ifNoneMatch === "*" || ifNoneMatch === tag))) return this.describe(key, o);
    }
    let bytes = o.bytes;
    let range: { offset: number; length: number } | undefined;
    let asked = options?.range;
    if (asked instanceof Headers) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(asked.get("range") ?? "");
      asked = m ? { offset: Number(m[1]), ...(m[2] ? { length: Number(m[2]) - Number(m[1]) + 1 } : {}) } : undefined;
    }
    if (asked && "suffix" in asked) {
      const length = Math.min(asked.suffix, o.bytes.byteLength);
      range = { offset: o.bytes.byteLength - length, length };
      bytes = o.bytes.slice(range.offset);
    } else if (asked) {
      const offset = asked.offset ?? 0;
      // R2 refuses a range it cannot serve.
      if (offset >= o.bytes.byteLength) throw new Error("get: The requested range is not satisfiable (10039)");
      range = { offset, length: Math.min(asked.length ?? o.bytes.byteLength - offset, o.bytes.byteLength - offset) };
      bytes = o.bytes.slice(range.offset, range.offset + range.length);
    }
    const copy = bytes.slice();
    return {
      ...this.describe(key, o, range),
      get body() {
        return new Response(copy).body!;
      },
      arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
      text: async () => new TextDecoder().decode(copy),
      json: async () => JSON.parse(new TextDecoder().decode(copy)) as unknown,
    };
  }

  async head(key: string) {
    const o = this.objects.get(key);
    return o ? this.describe(key, o) : null;
  }

  async put(key: string, value: unknown, options?: { httpMetadata?: FileMetadata; customMetadata?: Record<string, string> }) {
    this.version += 1;
    const o: MemoryObject = { bytes: await bytesOf(value), etag: `e${this.version}`, ...(options?.httpMetadata ? { httpMetadata: options.httpMetadata } : {}), ...(options?.customMetadata ? { customMetadata: { ...options.customMetadata } } : {}) };
    this.objects.set(key, o);
    return this.describe(key, o);
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  async list(options: { prefix?: string; cursor?: string; include?: string[] } = {}) {
    const objects = [...this.objects.entries()].filter(([key]) => key.startsWith(options.prefix ?? "")).map(([key, o]) => this.describe(key, o));
    return { objects, delimitedPrefixes: [], truncated: false };
  }

  async createMultipartUpload(key: string, options?: { httpMetadata?: FileMetadata; customMetadata?: Record<string, string> }) {
    this.version += 1;
    const uploadId = `up-${this.version}`;
    this.uploads.set(uploadId, { key, ...(options?.httpMetadata ? { httpMetadata: options.httpMetadata } : {}), ...(options?.customMetadata ? { customMetadata: options.customMetadata } : {}), parts: new Map() });
    return this.resumeMultipartUpload(key, uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string) {
    const self = this;
    return {
      key,
      uploadId,
      async uploadPart(partNumber: number, value: unknown) {
        const upload = self.uploads.get(uploadId);
        if (!upload || upload.key !== key) throw new Error("NoSuchUpload");
        self.version += 1;
        const part = { bytes: await bytesOf(value), etag: `p${self.version}` };
        upload.parts.set(partNumber, part);
        return { partNumber, etag: part.etag };
      },
      async complete(parts: { partNumber: number; etag: string }[]) {
        const upload = self.uploads.get(uploadId);
        if (!upload) throw new Error("NoSuchUpload");
        const chunks: Uint8Array[] = [];
        for (const p of parts) {
          const stored = upload.parts.get(p.partNumber);
          if (!stored || stored.etag !== p.etag) throw new Error("InvalidPart");
          chunks.push(stored.bytes);
        }
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const bytes = new Uint8Array(total);
        let at = 0;
        for (const c of chunks) {
          bytes.set(c, at);
          at += c.byteLength;
        }
        self.uploads.delete(uploadId);
        return self.put(key, bytes, { ...(upload.httpMetadata ? { httpMetadata: upload.httpMetadata } : {}), ...(upload.customMetadata ? { customMetadata: upload.customMetadata } : {}) });
      },
      async abort() {
        self.uploads.delete(uploadId);
      },
    };
  }

  /** The bucket as a store takes it. */
  asBucket(): StoreFiles {
    return this as unknown as StoreFiles;
  }
}
