// The place a store keeps its files, as the store itself calls it: seven calls on the bucket and
// three on an upload in progress. On Cloudflare the bucket is R2, and an `R2Bucket` fits this
// interface as it is. Another host hands the store anything that answers the same calls: a folder
// on a disk, or a stand-in in memory for a test.
//
// Nothing here is the platform's type, so the package reads the same wherever it is built. The
// gateway in front of a store moves a file's bytes (an upload's parts, a download); a store keeps
// the records, and reads and writes only what its own jobs need.

/** What a put or a new upload says about an object. */
export interface StoreFileOptions {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

/** An object's record: what `head`, a finished upload and a listing answer. */
export interface StoreFileObject {
  readonly key: string;
  readonly size: number;
  readonly httpMetadata?: { contentType?: string };
  readonly customMetadata?: Record<string, string>;
}

/** An object with its bytes. */
export interface StoreFileBody extends StoreFileObject {
  readonly body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
  json<T = unknown>(): Promise<T>;
}

/** A part of an upload the bucket took. */
export interface StoreFilePart {
  partNumber: number;
  etag: string;
}

/** An upload in progress: its parts arrive one by one, and `complete` makes the object of them. */
export interface StoreFileUpload {
  readonly uploadId: string;
  uploadPart(partNumber: number, value: Uint8Array | ArrayBuffer | string): Promise<StoreFilePart>;
  complete(parts: StoreFilePart[]): Promise<StoreFileObject>;
  abort(): Promise<void>;
}

/** One page of a listing; `cursor` reads the next page while `truncated` says there is one. */
export interface StoreFileList {
  objects: StoreFileObject[];
  truncated: boolean;
  cursor?: string;
}

/** The bucket a store's files are in. */
export interface StoreFiles {
  /** An object with its bytes, or the `length` bytes from `offset` of it; null when the key holds none. */
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<StoreFileBody | null>;
  head(key: string): Promise<StoreFileObject | null>;
  put(key: string, value: Uint8Array | ArrayBuffer | string, options?: StoreFileOptions): Promise<unknown>;
  /** Removes one key or many; a key that holds nothing is no error. */
  delete(keys: string | string[]): Promise<void>;
  /** The objects under a prefix. `include` asks for their metadata, which a listing leaves out otherwise. */
  list(options: { prefix?: string; cursor?: string; include?: ("httpMetadata" | "customMetadata")[] }): Promise<StoreFileList>;
  createMultipartUpload(key: string, options?: StoreFileOptions): Promise<StoreFileUpload>;
  /** The upload a `createMultipartUpload` began, by its id. It asks the bucket nothing until a part is sent. */
  resumeMultipartUpload(key: string, uploadId: string): StoreFileUpload;
}
