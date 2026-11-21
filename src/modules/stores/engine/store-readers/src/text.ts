// Turning a town's bytes into text. Delimited files say nothing about their encoding, so it is
// read from the bytes: a UTF-8 or UTF-16 byte order mark, else UTF-8 when the opening bytes are
// valid UTF-8, else UTF-16 when every other byte is zero, else Windows-1252, what a US town's
// Windows programs write. A dBase or FoxPro table names its code page in its header, and its text is
// read in the code page its words show where the two disagree (dbf.ts, code-page.ts).
//
// Single-byte code pages are decoded from tables of our own (codepages.ts), never TextDecoder:
// workerd's TextDecoder knows UTF-8 and UTF-16 only, and no TextDecoder knows the DOS code pages
// (437, 850) that old dBase files use.

import { CODE_PAGE_HIGH } from "./codepages.js";
import { codePageName, UTF8_CODE_PAGE } from "./jobs.js";

/** How a file's text is written: UTF-8, UTF-16, or a single-byte code page by its number. */
export type TextEncoding = { kind: "utf-8" } | { kind: "utf-16le" } | { kind: "utf-16be" } | { kind: "code-page"; page: number };

export const UTF8: TextEncoding = { kind: "utf-8" };
export const WINDOWS_1252: TextEncoding = { kind: "code-page", page: 1252 };

/** The encoding of a code page by its number (`READABLE_CODE_PAGES`): UTF-8 for 65001, else that single-byte code page. */
export const encodingOfPage = (page: number): TextEncoding => (page === UTF8_CODE_PAGE ? UTF8 : { kind: "code-page", page });

/** The encoding's name as a person reads it: "UTF-8", "Windows-1252", "code page 437". */
export function encodingName(e: TextEncoding): string {
  switch (e.kind) {
    case "utf-8":
      return "UTF-8";
    case "utf-16le":
      return "UTF-16 (little-endian)";
    case "utf-16be":
      return "UTF-16 (big-endian)";
    case "code-page":
      return codePageName(e.page);
  }
}

/** Bytes in a code unit of the encoding: 2 for UTF-16, else 1. */
export const unitBytes = (e: TextEncoding): 1 | 2 => (e.kind === "utf-16le" || e.kind === "utf-16be" ? 2 : 1);

/** The encoding a file's opening bytes show, and how many bytes its byte order mark takes. */
export function detectEncoding(head: Uint8Array): { encoding: TextEncoding; bom: number } {
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return { encoding: UTF8, bom: 3 };
  if (head[0] === 0xff && head[1] === 0xfe) return { encoding: { kind: "utf-16le" }, bom: 2 };
  if (head[0] === 0xfe && head[1] === 0xff) return { encoding: { kind: "utf-16be" }, bom: 2 };
  const utf16 = utf16Without(head);
  if (utf16) return { encoding: utf16, bom: 0 };
  return { encoding: validUtf8(head, true) ? UTF8 : WINDOWS_1252, bom: 0 };
}

/** UTF-16 without a byte order mark: in Latin text one byte of every pair is zero, always the same one. */
function utf16Without(head: Uint8Array): TextEncoding | null {
  const pairs = Math.floor(Math.min(head.byteLength, 4096) / 2);
  if (pairs < 4) return null;
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < pairs; i++) {
    if (head[2 * i] === 0) evenZero++;
    if (head[2 * i + 1] === 0) oddZero++;
  }
  if (oddZero > pairs * 0.4 && evenZero < pairs * 0.05) return { kind: "utf-16le" };
  if (evenZero > pairs * 0.4 && oddZero < pairs * 0.05) return { kind: "utf-16be" };
  return null;
}

/**
 * Whether bytes are valid UTF-8. `open` allows a sequence the bytes end in the middle of: the
 * opening bytes of a file are cut wherever the read stopped.
 */
export function validUtf8(bytes: Uint8Array, open = false): boolean {
  const n = bytes.byteLength;
  let i = 0;
  while (i < n) {
    const b = bytes[i]!;
    if (b < 0x80) {
      i++;
      continue;
    }
    let need: number;
    let min: number;
    if (b >= 0xc2 && b <= 0xdf) {
      need = 1;
      min = 0x80;
    } else if (b >= 0xe0 && b <= 0xef) {
      need = 2;
      min = 0x800;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3;
      min = 0x10000;
    } else return false;
    let cp = b & (need === 1 ? 0x1f : need === 2 ? 0x0f : 0x07);
    for (let k = 1; k <= need; k++) {
      if (i + k >= n) return open;
      const c = bytes[i + k]!;
      if ((c & 0xc0) !== 0x80) return false;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
    i += need + 1;
  }
  return true;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** Whether every byte is below 0x80, so any of our encodings but UTF-16 reads it as ASCII. */
function ascii(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.byteLength; i++) if (bytes[i]! >= 0x80) return false;
  return true;
}

/** ASCII bytes as a string, in pieces small enough for `fromCharCode`'s argument limit. */
function asciiText(bytes: Uint8Array): string {
  if (bytes.byteLength <= 4096) return String.fromCharCode.apply(null, bytes as unknown as number[]);
  let out = "";
  for (let i = 0; i < bytes.byteLength; i += 4096) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 4096) as unknown as number[]);
  return out;
}

/** Bytes in a single-byte code page; a code page we have no table for reads as Windows-1252. */
export function decodeCodePage(bytes: Uint8Array, page: number): string {
  if (ascii(bytes)) return asciiText(bytes);
  const high = CODE_PAGE_HIGH[page] ?? CODE_PAGE_HIGH[1252]!;
  let out = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    const b = bytes[i]!;
    out += b < 0x80 ? String.fromCharCode(b) : high[b - 0x80]!;
  }
  return out;
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  let out = "";
  const n = bytes.byteLength - (bytes.byteLength % 2);
  for (let i = 0; i < n; i += 2) out += String.fromCharCode(littleEndian ? bytes[i]! | (bytes[i + 1]! << 8) : (bytes[i]! << 8) | bytes[i + 1]!);
  return out;
}

/**
 * Bytes as text in an encoding. Bytes that are not valid UTF-8 in a file that opened as UTF-8 (a
 * file whose later rows another program wrote) read as Windows-1252 rather than as question marks.
 */
export function decode(bytes: Uint8Array, e: TextEncoding): string {
  switch (e.kind) {
    case "utf-8":
      if (ascii(bytes)) return asciiText(bytes);
      try {
        return utf8Decoder.decode(bytes);
      } catch {
        return decodeCodePage(bytes, 1252);
      }
    case "utf-16le":
      return decodeUtf16(bytes, true);
    case "utf-16be":
      return decodeUtf16(bytes, false);
    case "code-page":
      return decodeCodePage(bytes, e.page);
  }
}
