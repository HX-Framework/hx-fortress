// Zip archives: every file in the zip that LOAD reads is read by its own reader, and each of its
// tables is a table of the zip ("permits", "2019/owners", "parcels: Owners" for a workbook's sheet).
// A dBase or FoxPro table is read with the memo file of its name beside it in the zip, and a Visual
// FoxPro table with the one database container (.dbc) in its folder, for its long names (dbc.ts).
//
// The zip is read by range (zip.ts). A file stored in the zip without compression is a range of
// the zip's bytes and reads as if it stood alone. A compressed one is inflated as its reader asks:
// forward for delimited text, dBase tables, JSON, XML and the formats read whole (.xls, Access),
// which cost what they would alone; a file whose reader reads in any order (a workbook, a SQLite or
// Parquet file, a zip inside the zip) is inflated into memory, up to ZIP_INFLATED_CAP. One file of
// the zip is open at a time: the one whose rows are being read.
//
// A file in the zip that cannot be read is named in the notes and the others load. A zip inside the
// zip is read too, one level down.

import { notLoadedKindWords, nothingToLoadWords } from "./accepted.js";
import { DBC_BYTES_MAX, type DbcTable, readDbc } from "./dbc.js";
import type { ByteSource } from "./source.js";
import { type BatchLimit, type OpenedFile, type ReadCursor, type RowBatch, type SetCodePage, type SourceFormat, type SourceTable, UnreadableFile } from "./types.js";
import { entryBytes, entryRefusal, entrySource, entryText, wholeEntry, type ZipEntry, zipEntries } from "./zip.js";

/**
 * The most a store inflates into memory to read files from inside a zip: a workbook, a SQLite or
 * Parquet file, or a zip inside the zip, when the zip compressed it. A zip inside the zip and a
 * file inside that one share it. Stored without compression, or uploaded on its own, such a file
 * is read by range at any size. An .xlsx keeps its shared strings in memory too (up to
 * `SHARED_TEXT_CAP`), so this leaves room for both in a store's object (README.md, "Size caps").
 */
export const ZIP_INFLATED_CAP = 16 << 20;
/** The most files of a zip a store reads. */
export const ZIP_FILES_MAX = 2000;
/** How deep zips inside zips are read: the zip, and a zip inside it. */
const MAX_DEPTH = 1;

/** Formats whose reader reads its file in any order, so a compressed one is inflated whole; any zip-based file (.ods too) is one. */
const READ_ANYWHERE = new Set<SourceFormat>(["xlsx", "sqlite", "parquet", "zip"]);
const isZip = (head: Uint8Array): boolean => head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;

export interface ArchiveReaders {
  /** What a file is, from its name and opening bytes (open.ts `formatOf`). */
  formatOf(fileName: string, head: Uint8Array, size: number): { format: SourceFormat } | { refused: string };
  /** A file opened by the reader its format needs (open.ts `openAs`); `budget` is what a zip inside it may still inflate. */
  open(
    format: SourceFormat,
    fileName: string,
    source: ByteSource,
    options: {
      memo?: ByteSource | null;
      dbc?: readonly { name: string; source: ByteSource | null; tables?: readonly DbcTable[] | null; unread?: string }[] | null;
      depth: number;
      budget: number;
      codePage?: SetCodePage | null;
    },
  ): Promise<OpenedFile>;
}

const mb = (bytes: number): string => `${(bytes / (1 << 20)).toFixed(1)} MB`;

/** Files a person never meant to send: a Mac's resource forks and folder files, Windows' thumbnails. */
function isClutter(name: string): boolean {
  const last = name.split("/").pop() ?? name;
  return name.endsWith("/") || name.startsWith("__MACOSX/") || last.startsWith("._") || /^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(last);
}

const stem = (name: string): string => name.replace(/\.[^./]+$/, "");
const extension = (name: string): string => /\.([^./]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";

/** An entry's first bytes, inflated: enough to tell what it is. */
async function entryHead(source: ByteSource, entry: ZipEntry): Promise<Uint8Array> {
  if (entry.method === 0) return (await entrySource(source, entry)).read(0, 8192);
  const out = new Uint8Array(Math.min(entry.size, 8192));
  let at = 0;
  const stream = entryBytes(source, entry);
  try {
    for await (const chunk of stream) {
      const take = Math.min(chunk.byteLength, out.byteLength - at);
      out.set(chunk.subarray(0, take), at);
      at += take;
      if (at >= out.byteLength) break;
    }
  } finally {
    await stream.return(undefined).catch(() => undefined);
  }
  return out.subarray(0, at);
}

/** One file of the zip that LOAD reads: where it is, what it is, and its memo file. */
interface Member {
  entry: ZipEntry;
  format: SourceFormat;
  memo: ZipEntry | null;
  /** Its reader reads it in any order: a compressed one is inflated whole. */
  anywhere: boolean;
}

/** Which file of the zip a table is in, and its index among that file's tables. */
interface Place {
  member: number;
  table: number;
}

/** A Visual FoxPro database's container (.dbc), its memo file (.dct) and its index (.dcx). */
const DATABASE_FILES = new Set(["dbc", "dct", "dcx"]);

/** The kinds of file in a zip that take the code page a person set for the zip. */
const TAKES_CODE_PAGE = new Set<SourceFormat>(["dbf", "delimited", "zip"]);

/** A zip archive, opened: the tables of every file in it that LOAD reads; `codePage`, set for the zip, is for its dBase tables and delimited text. */
export async function openArchive(source: ByteSource, fileName: string, readers: ArchiveReaders, depth = 0, budget = ZIP_INFLATED_CAP, codePage: SetCodePage | null = null): Promise<OpenedFile> {
  const entries = await zipEntries(source, "This zip file");
  // A workbook or an OpenDocument file named .zip is read as what it is.
  if (entries.has("xl/workbook.xml")) return readers.open("xlsx", fileName, source, { depth, budget });
  const mimetype = entries.has("mimetype") ? (await entryText(source, entries.get("mimetype"))).trim() : "";
  if (mimetype.startsWith("application/vnd.oasis.opendocument.spreadsheet")) return readers.open("ods", fileName, source, { depth, budget });
  if (mimetype.startsWith("application/vnd.oasis.opendocument.")) throw new UnreadableFile(notLoadedKindWords(fileName, "an OpenDocument file but not a spreadsheet"), "unsupported");
  if (entries.has("word/document.xml")) throw new UnreadableFile(notLoadedKindWords(fileName, "a Word document"), "unsupported");
  if (entries.has("ppt/presentation.xml")) throw new UnreadableFile(notLoadedKindWords(fileName, "a PowerPoint presentation"), "unsupported");

  const files = [...entries.values()].filter((e) => !isClutter(e.name));
  const notes: string[] = [];
  if (files.length > ZIP_FILES_MAX) notes.push(`${fileName} holds ${files.length} files; a store reads the first ${ZIP_FILES_MAX}. Split it into smaller zips to load the rest.`);
  const considered = files.slice(0, ZIP_FILES_MAX);
  // A dBase or FoxPro table's memo file: the .fpt or .dbt of its name in the same folder.
  const memos = new Map<string, ZipEntry>();
  for (const e of considered) if (extension(e.name) === "fpt" || extension(e.name) === "dbt") memos.set(stem(e.name).toLowerCase(), e);
  const paired = new Set<ZipEntry>();
  // A Visual FoxPro database's container, its memo file and its index are read with its tables,
  // never as one. A table is offered every container of the zip, those of its own folder first, and
  // takes the one its header names (dbf.ts). A zip made on Windows may name its folders with
  // backslashes.
  const folderOf = (name: string): string => {
    const path = name.replace(/\\/g, "/");
    return path.slice(0, path.lastIndexOf("/") + 1);
  };
  const ofDatabase = considered.filter((e) => DATABASE_FILES.has(extension(e.name)));
  const containers = ofDatabase.filter((e) => extension(e.name) === "dbc");
  const containersFor = (table: ZipEntry): ZipEntry[] => {
    const here = folderOf(table.name);
    return [...containers.filter((c) => folderOf(c.name) === here), ...containers.filter((c) => folderOf(c.name) !== here)];
  };

  const members: Member[] = [];
  const notRead: string[] = [];
  const failed: string[] = [];
  for (const entry of considered) {
    if (memos.get(stem(entry.name).toLowerCase()) === entry) continue;
    if (DATABASE_FILES.has(extension(entry.name))) continue;
    const refusal = entryRefusal(entry);
    if (refusal) {
      failed.push(refusal.message);
      continue;
    }
    let head: Uint8Array;
    try {
      head = await entryHead(source, entry);
    } catch (err) {
      if (!(err instanceof UnreadableFile)) throw err;
      failed.push(err.message.startsWith(entry.name) ? err.message : `${entry.name} could not be read: ${err.message}`);
      continue;
    }
    const kind = readers.formatOf(entry.name, head, entry.size);
    if ("refused" in kind) {
      notRead.push(entry.name);
      continue;
    }
    if (kind.format === "zip" && depth >= MAX_DEPTH) {
      failed.push(`${entry.name} is a zip inside a zip inside a zip. Unzip it and upload what it holds.`);
      continue;
    }
    const memo = kind.format === "dbf" ? (memos.get(stem(entry.name).toLowerCase()) ?? null) : null;
    if (memo) paired.add(memo);
    members.push({ entry, format: kind.format, memo, anywhere: READ_ANYWHERE.has(kind.format) || isZip(head) });
  }
  for (const memo of memos.values()) if (!paired.has(memo)) notRead.push(memo.name);
  // A database's files go with its tables: named as not loaded only in a zip that holds no table of one.
  if (!members.some((m) => m.format === "dbf")) for (const e of ofDatabase) notRead.push(e.name);

  /** A container the zip could not give, said once in the zip's notes however many tables it had. */
  const containersFailed = new Set<ZipEntry>();
  const containerFailed = (entry: ZipEntry, why: string): void => {
    if (containersFailed.has(entry)) return;
    containersFailed.add(entry);
    failed.push(why.startsWith(entry.name) ? why : `${entry.name} could not be read: ${why}`);
  };

  /** A member's bytes as its reader reads them, its memo file's, and what a zip inside it may still inflate. */
  async function sourcesOf(m: Member): Promise<{ source: ByteSource; memo: ByteSource | null; budget: number }> {
    let own: ByteSource;
    let left = budget;
    if (m.entry.method !== 0 && m.anywhere) {
      if (m.entry.size > budget) {
        throw new UnreadableFile(
          `${m.entry.name} is ${mb(m.entry.size)} and compressed inside the zip. A store reads such a file inside a zip up to ${budget >> 20} MB. Unzip it and upload the file itself.`,
          "too-big",
        );
      }
      own = await wholeEntry(source, m.entry);
      left -= m.entry.size;
    } else own = await entrySource(source, m.entry);
    // A memo file is read where its table's rows point, mostly in order: compressed, it is held
    // whole when it fits, else inflated forward like the table.
    let memo: ByteSource | null = null;
    if (m.memo) memo = m.memo.method !== 0 && m.memo.size <= ZIP_INFLATED_CAP ? await wholeEntry(source, m.memo) : await entrySource(source, m.memo);
    return { source: own, memo, budget: left };
  }

  /**
   * Each container read once, however many of its folder's tables open: listing the zip's tables
   * opens each, and reading a table's rows opens it again. One the zip cannot give (a password, a
   * method a store does not read, damaged bytes) leaves its tables their own names.
   */
  const containersRead = new Map<ZipEntry, Promise<readonly DbcTable[] | null | "unreadable" | "too-big">>();
  function containerTables(entry: ZipEntry): Promise<readonly DbcTable[] | null | "unreadable" | "too-big"> {
    const kept = containersRead.get(entry);
    if (kept) return kept;
    const reading = (async (): Promise<readonly DbcTable[] | null | "unreadable" | "too-big"> => {
      if (entry.size > DBC_BYTES_MAX) return "too-big";
      const refusal = entryRefusal(entry);
      if (refusal) {
        containerFailed(entry, refusal.message);
        return "unreadable";
      }
      try {
        return await readDbc(entry.method !== 0 ? await wholeEntry(source, entry) : await entrySource(source, entry));
      } catch (err) {
        if (!(err instanceof UnreadableFile)) throw err;
        containerFailed(entry, err.message);
        return "unreadable";
      }
    })();
    containersRead.set(entry, reading);
    // A read that fails is tried again by the next table's open, never kept.
    reading.catch(() => containersRead.delete(entry));
    return reading;
  }

  async function openMember(index: number): Promise<OpenedFile> {
    const m = members[index]!;
    const { source: own, memo, budget: left } = await sourcesOf(m);
    const offered = m.format === "dbf" ? containersFor(m.entry) : [];
    const dbc: { name: string; source: null; tables?: readonly DbcTable[] | null; unread?: string }[] = [];
    for (const c of offered) {
      const tables = await containerTables(c);
      dbc.push(
        tables === "unreadable"
          ? { name: c.name, source: null, unread: "could not be read" }
          : tables === "too-big"
            ? { name: c.name, source: null, unread: `is larger than the ${DBC_BYTES_MAX >> 20} MB LOAD reads of a container` }
            : { name: c.name, source: null, tables },
      );
    }
    return readers.open(m.format, m.entry.name, own, {
      memo,
      ...(dbc.length ? { dbc } : {}),
      depth: depth + 1,
      budget: left,
      ...(codePage && TAKES_CODE_PAGE.has(m.format) ? { codePage } : {}),
    });
  }

  const tables: SourceTable[] = [];
  const places: Place[] = [];
  let live: { member: number; file: OpenedFile } | null = null;
  for (let i = 0; i < members.length; i++) {
    const m = members[i]!;
    let file: OpenedFile;
    try {
      file = await openMember(i);
    } catch (err) {
      if (!(err instanceof UnreadableFile)) throw err;
      failed.push(err.message.startsWith(m.entry.name) ? err.message : `${m.entry.name} could not be read: ${err.message}`);
      continue;
    }
    live = { member: i, file };
    const name = stem(m.entry.name);
    file.tables.forEach((t, k) => {
      tables.push({
        // A FoxPro table its container names takes that name in its folder; a sheet keeps its file's.
        name: t.name ? (m.format === "dbf" ? `${folderOf(m.entry.name)}${t.name}` : `${name}: ${t.name}`) : name,
        columns: t.columns,
        rowCount: t.rowCount,
        notes: [`From ${m.entry.name} in the zip.`, ...file.notes, ...t.notes],
      });
      places.push({ member: i, table: k });
    });
  }
  if (notRead.length) notes.push(`${fileName} also holds ${notRead.length === 1 ? "a file" : `${notRead.length} files`} a store does not load: ${notRead.slice(0, 10).join(", ")}${notRead.length > 10 ? ` and ${notRead.length - 10} more` : ""}.`);
  notes.push(...failed);
  if (!tables.length) {
    throw new UnreadableFile(
      failed.length ? `${fileName} holds no file a store could read. ${failed.join(" ")}` : nothingToLoadWords(fileName, notRead),
      "unsupported",
    );
  }

  async function rows(index: number, cursor: ReadCursor | null, limit: BatchLimit): Promise<RowBatch> {
    const place = places[index];
    if (!place) throw new RangeError(`This zip has no table ${index}.`);
    if (live?.member !== place.member) {
      // One file of the zip is open at a time; the one before is let go first.
      live = null;
      live = { member: place.member, file: await openMember(place.member) };
    }
    return live.file.rows(place.table, cursor, limit);
  }

  return { format: "zip", tables, notes, rows };
}
