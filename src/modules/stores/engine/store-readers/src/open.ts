// Which reader a town's file needs, from its opening bytes first and its name second, and the one
// door every reader is opened through.
//
// An .xls workbook and an Access database are read whole inside the store's object, so each has a
// size cap: a file above it is refused with a sentence that says what to do instead, and no
// reader starts. The caps were measured as the memory a file of that size needs while it is read
// (README.md, "Size caps"). Every other kind is read by range: delimited text, dBase tables,
// .xlsx and .ods workbooks, SQLite and Parquet files, JSON, XML, and zip archives of any of these.
// Which extensions name which kind is accepted.ts, with the words for a kind no reader reads.

import { extensionsOf, notLoadedKindWords } from "./accepted.js";
import { openAccess } from "./access.js";
import { openArchive, ZIP_INFLATED_CAP } from "./archive.js";
import { openDbf, looksLikeDbf } from "./dbf.js";
import { openDelimited } from "./delimited.js";
import { openExcel } from "./excel.js";
import { openJson } from "./json.js";
import { extensionOf } from "./names.js";
import { openOds } from "./ods.js";
import { looksLikeParquet, openParquet } from "./parquet.js";
import { type ByteSource, readAll } from "./source.js";
import { looksLikeSqlite, openSqlite } from "./sqlite.js";
import { codePageName } from "./jobs.js";
import { detectEncoding } from "./text.js";
import { type OpenedFile, type SetCodePage, type SourceFormat, UnreadableFile } from "./types.js";
import { openXml, isSpreadsheetMl } from "./xml.js";
import { xmlOpening } from "./xml-scan.js";
import { openXlsx } from "./xlsx.js";
import { u16, u32 } from "./zip.js";

/**
 * The largest file of each kind a store reads whole inside its own object, in bytes. An .xlsx is
 * read as a stream; only its shared strings have a cap (xlsx.ts `SHARED_TEXT_CAP`).
 */
export const WHOLE_FILE_CAPS: Readonly<Record<"xls" | "access", number>> = {
  xls: 3 << 20,
  access: 64 << 20,
};

const TEXT_EXTENSIONS = extensionsOf("delimited");
const JSON_EXTENSIONS = extensionsOf("json");
const LINES_EXTENSIONS = new Set(["jsonl", "ndjson"]);
const MEMO_EXTENSIONS = new Set(["fpt", "dbt"]);
/** Excel's own extensions, add-ins among them: what Excel reads a workbook under. */
const EXCEL_EXTENSIONS = new Set([...extensionsOf("excel"), "xla"]);
const XLSX_EXTENSIONS = new Set(["xlsx", "xlsm", "xltx", "xltm"]);
const ODS_EXTENSIONS = extensionsOf("opendocument");
const WORD_EXTENSIONS = new Set(["docx", "docm", "dotx", "dotm"]);
const POWERPOINT_EXTENSIONS = new Set(["pptx", "pptm", "potx", "potm", "ppsx", "ppsm"]);

const startsWith = (b: Uint8Array, bytes: readonly number[], at = 0): boolean => bytes.every((x, i) => b[at + i] === x);
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/**
 * Whether bytes look like text: no NUL bytes in single-byte text, and few control characters.
 * UTF-16, with or without a byte order mark, is what the delimited reader decodes (text.ts
 * `detectEncoding`), so the two never disagree about a file.
 */
function looksLikeText(head: Uint8Array): boolean {
  if (!head.byteLength) return true;
  const kind = detectEncoding(head).encoding.kind;
  if (kind === "utf-16le" || kind === "utf-16be") return true;
  let control = 0;
  for (let i = 0; i < Math.min(head.byteLength, 8192); i++) {
    const b = head[i]!;
    if (b === 0) return false;
    if (b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1a)) control++;
  }
  return control < Math.min(head.byteLength, 8192) * 0.01;
}

/** A web page: what many programs save as ".xls". */
const isWebPage = (opening: string): boolean => /^(?:<!doctype html|<html|<table|<head|<body|<meta)/i.test(opening);
/** A flat OpenDocument spreadsheet (.fods). */
const isFlatOds = (opening: string): boolean => /<office:document\b/.test(opening) && opening.includes("opendocument.spreadsheet");

/** The opening of a zip-based OpenDocument file: its first entry, "mimetype", holds its kind. */
function openDocumentKind(head: Uint8Array): string | null {
  const nameLength = u16(head, 26);
  if (new TextDecoder().decode(head.subarray(30, 30 + nameLength)) !== "mimetype") return null;
  const at = 30 + nameLength + u16(head, 28);
  return new TextDecoder().decode(head.subarray(at, at + Math.min(u32(head, 18), 100))).trim();
}

/** What a file is, or why LOAD does not read it. */
export function formatOf(fileName: string, head: Uint8Array, size: number): { format: SourceFormat } | { refused: string } {
  const ext = extensionOf(fileName);
  const jet = new TextDecoder().decode(head.subarray(4, 19));
  if (jet === "Standard Jet DB" || jet === "Standard ACE DB") return { format: "access" };
  if (looksLikeSqlite(head)) return { format: "sqlite" };
  if (looksLikeParquet(head)) return { format: "parquet" };
  if (startsWith(head, OLE)) {
    if (ext === "xls" || ext === "xlt" || ext === "xla" || ext === "") return { format: "xls" };
    // A password-protected .xlsx is an Office container around the encrypted workbook.
    if (ext === "xlsx" || ext === "xlsm") return { refused: `${fileName} is protected with a password. Save a copy without one and upload that.` };
    return { refused: notLoadedKindWords(fileName, "a Microsoft Office file but not an Excel workbook") };
  }
  if (startsWith(head, ZIP)) {
    const odf = openDocumentKind(head);
    if (odf?.startsWith("application/vnd.oasis.opendocument.spreadsheet")) return { format: "ods" };
    if (odf?.startsWith("application/vnd.oasis.opendocument.")) return { refused: notLoadedKindWords(fileName, "an OpenDocument file but not a spreadsheet") };
    if (XLSX_EXTENSIONS.has(ext)) return { format: "xlsx" };
    if (ODS_EXTENSIONS.has(ext)) return { format: "ods" };
    if (WORD_EXTENSIONS.has(ext)) return { refused: notLoadedKindWords(fileName, "a Word document") };
    if (POWERPOINT_EXTENSIONS.has(ext)) return { refused: notLoadedKindWords(fileName, "a PowerPoint presentation") };
    return { format: "zip" };
  }
  if (MEMO_EXTENSIONS.has(ext)) return { refused: `${fileName} is a dBase or FoxPro memo file. It is read with the table of the same name.` };
  if (looksLikeDbf(head, size) && (ext === "dbf" || !TEXT_EXTENSIONS.has(ext))) return { format: "dbf" };
  if (ext === "dbf") return { refused: `${fileName} is named like a dBase table, but its header is not one.` };
  const text = looksLikeText(head);
  const opening = text ? xmlOpening(head).replace(/^\uFEFF/, "").trimStart() : "";
  if (opening.startsWith("<")) {
    if (isSpreadsheetMl(opening)) return { format: "xml" };
    if (isFlatOds(opening)) return { format: "ods" };
    if (isWebPage(opening)) {
      return EXCEL_EXTENSIONS.has(ext)
        ? { refused: `${fileName} is a web page saved under an Excel name, not a workbook. Open it in Excel, save it as .xlsx, and upload that.` }
        : { refused: `${fileName} is a web page, not a table a store reads. Open it in Excel, save it as .xlsx or CSV, and upload that.` };
    }
    // Text under a delimited name that happens to start with "<" stays delimited text.
    if (!TEXT_EXTENSIONS.has(ext)) return { format: "xml" };
  }
  if (text && (JSON_EXTENSIONS.has(ext) || LINES_EXTENSIONS.has(ext) || (!TEXT_EXTENSIONS.has(ext) && /^[[{]/.test(opening)))) return { format: "json" };
  // Text under an Excel name (a tab-separated export named .xls) still reads as delimited text.
  if (TEXT_EXTENSIONS.has(ext) || (text && ext !== "pdf" && ext !== "doc" && ext !== "docx")) {
    if (!text) return { refused: `${fileName} is named like text but holds binary data.` };
    return { format: "delimited" };
  }
  return { refused: notLoadedKindWords(fileName) };
}

const mb = (bytes: number): string => `${Math.round(bytes / (1 << 20))} MB`;
/** A file's size to a tenth of a megabyte, so a file just over a cap does not read as the cap. */
const fileMb = (bytes: number): string => `${(bytes / (1 << 20)).toFixed(1)} MB`;

export interface OpenFileOptions {
  /** A dBase or FoxPro table's memo file, when the store holds one with the table's name. */
  memo?: ByteSource | null;
  /** The code page a person set for the file's text (`READABLE_CODE_PAGES`): a dBase table's, delimited text's, and theirs inside a zip. */
  codePage?: number | null;
}

/** The kinds of file whose code page a person sets: a zip's dBase tables and delimited text take the zip's. */
const SETS_CODE_PAGE = new Set<SourceFormat>(["dbf", "delimited", "zip"]);

/**
 * A town's file, opened by the reader its kind needs. Every kind but a workbook or a database read
 * whole is read by range and has no size limit; one read whole above its cap is refused.
 */
export async function openFile(fileName: string, source: ByteSource, options: OpenFileOptions = {}): Promise<OpenedFile> {
  const head = await source.read(0, Math.min(source.size, 8192));
  const kind = formatOf(fileName, head, source.size);
  if ("refused" in kind) throw new UnreadableFile(kind.refused, "unsupported");
  const codePage = options.codePage ? { page: options.codePage, file: fileName } : null;
  const file = await openAs(kind.format, fileName, source, { memo: options.memo ?? null, depth: 0, budget: ZIP_INFLATED_CAP, codePage });
  if (!codePage || SETS_CODE_PAGE.has(file.format)) return file;
  return { ...file, notes: [...file.notes, `${codePageName(codePage.page)}, the code page set for ${fileName}, was not used: a code page is set only for a dBase table or delimited text.`] };
}

/**
 * A file opened by the reader of a format already known. `depth` counts the zips it is inside, and
 * `budget` is what a zip may still inflate into memory to read the files inside it.
 */
async function openAs(format: SourceFormat, fileName: string, source: ByteSource, options: { memo?: ByteSource | null; depth: number; budget: number; codePage?: SetCodePage | null }): Promise<OpenedFile> {
  const codePage = options.codePage ?? null;
  switch (format) {
    case "delimited":
      return openDelimited(source, { codePage });
    case "dbf":
      return openDbf(source, { fileName, codePage, ...(options.memo ? { memo: options.memo } : {}) });
    case "xlsx":
      return openXlsx(source);
    case "ods": {
      const head = await source.read(0, 4);
      return openOds(source, { flat: !startsWith(head, ZIP) });
    }
    case "json":
      return openJson(source, { lines: LINES_EXTENSIONS.has(extensionOf(fileName)) });
    case "xml":
      return openXml(source);
    case "sqlite":
      return openSqlite(source);
    case "parquet":
      return openParquet(source);
    case "zip":
      return openArchive(source, fileName, { formatOf, open: openAs }, options.depth, options.budget, codePage);
    case "xls":
    case "access": {
      const cap = WHOLE_FILE_CAPS[format];
      if (source.size > cap) {
        throw new UnreadableFile(
          format === "access"
            ? `${fileName} is ${fileMb(source.size)}. An Access database is read whole inside the store, which takes one up to ${mb(cap)}. Export its tables to CSV and upload those: delimited text loads at any size.`
            : `${fileName} is ${fileMb(source.size)}. An Excel 97-2003 workbook is read whole inside the store, which takes one up to ${mb(cap)}. Save it as .xlsx, or each sheet as CSV, and upload that.`,
          "too-big",
        );
      }
      const bytes = await readAll(source);
      return format === "access" ? openAccess(bytes) : openExcel(bytes, "xls");
    }
  }
}
