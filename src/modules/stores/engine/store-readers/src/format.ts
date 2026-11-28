// What a file is, from its opening bytes first and its name second, and the sizes of the files a
// store reads whole: the part of opening a file that reads only its first bytes. open.ts opens
// every file through it.
//
// A server that serves many organizations reads a file's kind here, to choose how a LOAD reads the
// file, before any reader starts, and loads no code that opens a zip. So this module imports no
// zip reader, nor a module that imports one: the .xlsx, .ods and archive readers, zip.ts, and
// parquet.ts and xml.ts, whose detectors live here instead.

import { extensionsOf, notLoadedKindWords } from "./accepted.js";
import { looksLikeDbf } from "./dbf.js";
import { extensionOf } from "./names.js";
import { looksLikeSqlite } from "./sqlite.js";
import { detectEncoding } from "./text.js";
import type { SourceFormat } from "./types.js";
import { xmlOpening } from "./xml-scan.js";

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
/** A Visual FoxPro database's container (.dbc), its memo file (.dct) and its index (.dcx): read with the database's tables, never as one. */
const DATABASE_EXTENSIONS = new Set(["dbc", "dct", "dcx"]);
/** Excel's own extensions, add-ins among them: what Excel reads a workbook under. */
const EXCEL_EXTENSIONS = new Set([...extensionsOf("excel"), "xla"]);
const XLSX_EXTENSIONS = new Set(["xlsx", "xlsm", "xltx", "xltm"]);
const ODS_EXTENSIONS = extensionsOf("opendocument");
const WORD_EXTENSIONS = new Set(["docx", "docm", "dotx", "dotm"]);
const POWERPOINT_EXTENSIONS = new Set(["pptx", "pptm", "potx", "potm", "ppsx", "ppsm"]);

const startsWith = (b: Uint8Array, bytes: readonly number[], at = 0): boolean => bytes.every((x, i) => b[at + i] === x);
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** Little-endian integers in a zip's local header, as zip.ts reads them. */
const u16 = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8);
const u32 = (b: Uint8Array, at: number): number => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)) + b[at + 3]! * 0x1000000;

/** Whether a file's first bytes are a Parquet file's magic, "PAR1" (or "PARE", encrypted). */
export function looksLikeParquet(head: Uint8Array): boolean {
  return head.byteLength >= 4 && head[0] === 0x50 && head[1] === 0x41 && head[2] === 0x52 && (head[3] === 0x31 || head[3] === 0x45);
}

/** Whether an XML file's opening is an Excel 2003 XML spreadsheet's. */
export function isSpreadsheetMl(opening: string): boolean {
  return /progid\s*=\s*"Excel\.Sheet"/i.test(opening) || (/<(?:ss:)?Workbook\b/.test(opening) && opening.includes("urn:schemas-microsoft-com:office:spreadsheet"));
}

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
  if (DATABASE_EXTENSIONS.has(ext)) return { refused: databaseFileWords(fileName) };
  if (looksLikeDbf(head, size) && (ext === "dbf" || !TEXT_EXTENSIONS.has(ext))) return { format: "dbf" };
  if (ext === "dbf") return { refused: `${fileName} is named like a dBase table, but its header is not one.` };
  const text = looksLikeText(head);
  const opening = text ? xmlOpening(head).replace(/^﻿/, "").trimStart() : "";
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

/** What a file of a Visual FoxPro database's container is, and when LOAD reads it: never as a table. */
export function databaseFileWords(fileName: string): string {
  const ext = extensionOf(fileName);
  if (ext === "dbc") return `${fileName} is a Visual FoxPro database's container. LOAD reads it with the database's tables, for their long names.`;
  return `${fileName} is the ${ext === "dct" ? "memo file" : "index"} of a Visual FoxPro database's container, which LOAD reads with the database's tables.`;
}
