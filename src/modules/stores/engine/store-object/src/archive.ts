// An export as the one file a person downloads: a tar of `<name>.sqlite` (the export's pieces, in
// order) and `files/<fileId>/<name>` for each of its files, streamed from the bucket as it is read,
// with its length known before the first byte. Extracted, it is what an app's `store:import` takes:
// `pnpm run store:import ./<name>.sqlite ./files`.

import type { ExportManifest } from "./export.js";
import { archiveFileName, TAR_END, tarHeader, tarPadding } from "./sqlite-file/tar.js";
import type { StoreFiles } from "./store-files.js";

/** A name for the SQLite file inside the archive: letters, digits, dots, dashes and underscores. */
export function archiveName(raw: string | null | undefined, fallback: string): string {
  const name = (raw ?? "").normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 80);
  return name || fallback;
}

/** One object's bytes from the bucket, as it says in the manifest. */
async function* objectBytes(bucket: StoreFiles, key: string, size: number): AsyncGenerator<Uint8Array> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`The export's bytes at ${key} are gone from the bucket.`);
  const reader = object.body.getReader();
  let sent = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sent += value.byteLength;
    yield value;
  }
  if (sent !== size) throw new Error(`The export's bytes at ${key} are not the size its manifest says.`);
}

/** The SQLite file's bytes, a piece at a time. */
async function* databaseBytes(bucket: StoreFiles, manifest: ExportManifest): AsyncGenerator<Uint8Array> {
  for (const piece of manifest.db.pieces) yield* objectBytes(bucket, piece.key, piece.size);
}

function streamOf(bytes: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await bytes.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await bytes.return(undefined);
    },
  });
}

/** The archive's length, and a stream of it read from the bucket a piece and a file at a time. */
export function exportArchive(bucket: StoreFiles, manifest: ExportManifest, name: string): { size: number; body: ReadableStream<Uint8Array> } {
  const mtime = Date.parse(manifest.createdAt);
  const entries: { header: Uint8Array; size: number; read: () => AsyncGenerator<Uint8Array> }[] = [];
  entries.push({ header: tarHeader(`${name}.sqlite`, manifest.db.bytes, mtime), size: manifest.db.bytes, read: () => databaseBytes(bucket, manifest) });
  for (const file of manifest.files) {
    entries.push({ header: tarHeader(`files/${file.id}/${archiveFileName(file.name)}`, file.size, mtime), size: file.size, read: () => objectBytes(bucket, file.key, file.size) });
  }
  const size = entries.reduce((n, e) => n + e.header.byteLength + e.size + tarPadding(e.size), 0) + TAR_END.byteLength;
  async function* all(): AsyncGenerator<Uint8Array> {
    for (const e of entries) {
      yield e.header;
      yield* e.read();
      const pad = tarPadding(e.size);
      if (pad > 0) yield new Uint8Array(pad);
    }
    yield TAR_END;
  }
  return { size, body: streamOf(all()) };
}

/** The export's SQLite file alone, streamed from its pieces. */
export function exportDatabase(bucket: StoreFiles, manifest: ExportManifest): { size: number; body: ReadableStream<Uint8Array> } {
  return { size: manifest.db.bytes, body: streamOf(databaseBytes(bucket, manifest)) };
}
