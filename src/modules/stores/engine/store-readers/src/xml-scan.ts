// XML, read by range a window at a time and scanned at the level of its bytes (two-byte units for
// UTF-16): the characters that mark tags, quotes and entities are ASCII, and in UTF-8 an ASCII
// byte is never part of another character, so every token's byte offset is exact and a read can
// go on from any offset between two elements. Names, attribute values and text are decoded on
// their own (text.ts `decode`), in the encoding the file's opening says.
//
// The scanner gives tokens (an element's opening tag, its closing tag, text) and, on request, an
// element whole as a small tree. Comments, processing instructions and the document type are
// skipped. Entities a document type declares are never expanded: only XML's five and character
// references are, so a file cannot make the reader expand text without end.
//
// The ODS reader (ods.ts) and the XML reader (xml.ts) read their files through this one scanner.

import type { ByteSource } from "./source.js";
import { decode, detectEncoding, type TextEncoding, unitBytes, UTF8, validUtf8, WINDOWS_1252 } from "./text.js";
import { UnreadableFile } from "./types.js";

/** An element read whole: its name as written ("ss:Cell"), its attributes, and its text and child elements in order. */
export interface XmlNode {
  name: string;
  attrs: Readonly<Record<string, string>>;
  content: (string | XmlNode)[];
}

export type XmlToken =
  | { kind: "open"; name: string; attrs: Record<string, string>; selfClosing: boolean; start: number; end: number }
  | { kind: "close"; name: string; start: number; end: number }
  | { kind: "text"; text: string; start: number; end: number };

const LT = 0x3c;
const GT = 0x3e;
const SLASH = 0x2f;
const BANG = 0x21;
const QUESTION = 0x3f;
const DQUOTE = 0x22;
const SQUOTE = 0x27;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const DASH = 0x2d;

const WINDOW_BYTES = 1 << 20;
/** The longest token or element a read goes looking for the end of; longer is a file that is not XML a store can read. */
export const MAX_ELEMENT_BYTES = 64 << 20;

/** An element's name without its namespace prefix: "Cell" for "ss:Cell". */
export const localName = (name: string): string => name.slice(name.indexOf(":") + 1);

const ENTITY: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** XML text with XML's five entities and character references read; any other entity stays as written. */
export function xmlUnescape(s: string): string {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (match, e: string) => {
    if (e[0] !== "#") return ENTITY[e]!;
    const code = e[1] === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

/** An element's text: its own text and its children's, in order. */
export function textOf(node: XmlNode): string {
  let out = "";
  for (const c of node.content) out += typeof c === "string" ? c : textOf(c);
  return out;
}

/** An element's child elements. */
export const childrenOf = (node: XmlNode): XmlNode[] => node.content.filter((c): c is XmlNode => typeof c !== "string");

/** The encoding names an XML declaration may give, as text.ts reads them. */
function namedEncoding(name: string): TextEncoding | null {
  const n = name.trim().toLowerCase().replace(/_/g, "-");
  if (n === "utf-8" || n === "utf8" || n === "us-ascii" || n === "ascii") return UTF8;
  if (n === "utf-16le") return { kind: "utf-16le" };
  if (n === "utf-16be") return { kind: "utf-16be" };
  // ISO-8859-1 differs from Windows-1252 only in 0x80-0x9F, which real "Latin-1" files use as Windows-1252.
  if (n === "iso-8859-1" || n === "latin1" || n === "latin-1" || n === "l1" || n === "iso8859-1" || n === "cp1252") return WINDOWS_1252;
  const windows = /^(?:windows|cp|x-cp)-?(125\d)$/.exec(n);
  if (windows) return { kind: "code-page", page: Number(windows[1]) };
  const dos = /^(?:ibm|cp|dos)-?(437|850|852|866)$/.exec(n);
  if (dos) return { kind: "code-page", page: Number(dos[1]) };
  return null;
}

/**
 * The encoding an XML file is written in, and where its text starts: a byte order mark first,
 * then UTF-16 by the shape of "<?" without one, then the declaration's encoding, else UTF-8, or
 * Windows-1252 when the opening bytes are not valid UTF-8.
 */
export function xmlEncoding(head: Uint8Array): { encoding: TextEncoding; start: number } {
  const bom = detectEncoding(head);
  if (bom.bom) return { encoding: bom.encoding, start: bom.bom };
  if (head[0] === LT && head[1] === 0 && head[2] === QUESTION && head[3] === 0) return { encoding: { kind: "utf-16le" }, start: 0 };
  if (head[0] === 0 && head[1] === LT && head[2] === 0 && head[3] === QUESTION) return { encoding: { kind: "utf-16be" }, start: 0 };
  const declaration = /^\s*<\?xml\b[^>]*?\bencoding\s*=\s*["']([^"']+)["']/.exec(String.fromCharCode(...head.subarray(0, 256)));
  const named = declaration ? namedEncoding(declaration[1]!) : null;
  if (named && unitBytes(named) === 1) return { encoding: named, start: 0 };
  return { encoding: validUtf8(head.subarray(0, 8192), true) ? UTF8 : WINDOWS_1252, start: 0 };
}

/** The opening of an XML file, decoded as text, for telling what kind of XML it is. */
export function xmlOpening(head: Uint8Array): string {
  const { encoding, start } = xmlEncoding(head);
  const take = head.subarray(start, start + 4096 - ((4096 - start) % unitBytes(encoding)));
  return decode(take, encoding);
}

/** Tokens of an XML file from a byte offset where a token starts. */
export class XmlScanner {
  private buf: Uint8Array = new Uint8Array(0);
  /** Where `buf` starts in the file. Every position below is a byte offset in the file. */
  private bufAt: number;
  /** The next unit to scan. */
  private at: number;
  private readonly step: 1 | 2;
  private readonly le: boolean;

  constructor(
    private readonly source: ByteSource,
    readonly encoding: TextEncoding,
    offset: number,
    private readonly windowBytes = WINDOW_BYTES,
  ) {
    this.bufAt = offset;
    this.at = offset;
    this.step = unitBytes(encoding);
    this.le = encoding.kind !== "utf-16be";
  }

  /** The byte offset of the next token. */
  get offset(): number {
    return this.at;
  }

  private get bufEnd(): number {
    const end = this.bufAt + this.buf.byteLength;
    // Where the file ends, a stray last byte of UTF-16 is no unit.
    return end >= this.source.size ? end - ((end - this.bufAt) % this.step) : end;
  }

  private unit(p: number): number {
    const b = this.buf;
    const i = p - this.bufAt;
    if (this.step === 1) return b[i]!;
    return this.le ? b[i]! | (b[i + 1]! << 8) : (b[i]! << 8) | b[i + 1]!;
  }

  /** Reads the next window, keeping the bytes from `at` on. False when the file has ended. */
  private async more(): Promise<boolean> {
    const end = this.bufAt + this.buf.byteLength;
    if (end >= this.source.size) return false;
    if (end - this.at >= MAX_ELEMENT_BYTES) {
      throw new UnreadableFile(`Something starting at byte ${this.at} runs past ${MAX_ELEMENT_BYTES >> 20} MB without ending, so this file is not XML a store can read.`, "damaged");
    }
    const next = await this.source.read(end, this.windowBytes);
    if (!next.byteLength) return false;
    const keep = this.buf.subarray(this.at - this.bufAt);
    const joined = new Uint8Array(keep.byteLength + next.byteLength);
    joined.set(keep);
    joined.set(next, keep.byteLength);
    this.buf = joined;
    this.bufAt = this.at;
    return true;
  }

  /** Whether the unit at `p` is in the buffer, reading on as needed. */
  private async has(p: number): Promise<boolean> {
    while (p + this.step > this.bufEnd) if (!(await this.more())) return false;
    return true;
  }

  /** Whether the unit at `p` is in the buffer now, without reading. */
  private here(p: number): boolean {
    return p + this.step <= this.bufAt + this.buf.byteLength;
  }

  /** Where `code` next is at or after `from`, reading on as needed; -1 when the file ends first. */
  private async find(code: number, from: number): Promise<number> {
    let p = from;
    for (;;) {
      const end = this.bufEnd;
      if (this.step === 1) {
        const i = this.buf.indexOf(code, p - this.bufAt);
        if (i >= 0 && this.bufAt + i < end) return this.bufAt + i;
        p = Math.max(p, end);
      } else {
        // `p` stays on a unit's first byte: a window may end inside a unit.
        for (; p + 1 < end; p += 2) if (this.unit(p) === code) return p;
      }
      if (!(await this.more())) return -1;
    }
  }

  /** Where the ASCII `codes` next start at or after `from`, reading on as needed; -1 when the file ends first. */
  private async findSequence(codes: readonly number[], from: number): Promise<number> {
    let p = from;
    for (;;) {
      const at = await this.find(codes[0]!, p);
      if (at < 0 || !(await this.has(at + (codes.length - 1) * this.step))) return -1;
      if (codes.every((c, i) => this.unit(at + i * this.step) === c)) return at;
      p = at + this.step;
    }
  }

  /** Whether the units at `p` are `codes`. */
  private async matches(p: number, codes: readonly number[]): Promise<boolean> {
    if (!(await this.has(p + (codes.length - 1) * this.step))) return false;
    return codes.every((c, i) => this.unit(p + i * this.step) === c);
  }

  private text(from: number, to: number): string {
    return to > from ? decode(this.buf.subarray(from - this.bufAt, to - this.bufAt), this.encoding) : "";
  }

  /** The next token, or null at the end of the file. Comments, processing instructions and the document type are skipped. */
  async next(): Promise<XmlToken | null> {
    const s = this.step;
    for (;;) {
      if (!this.here(this.at) && !(await this.has(this.at))) return null;
      const start = this.at;
      if (this.unit(start) !== LT) {
        // Text, up to the next tag or the end of the file.
        const lt = await this.find(LT, start);
        const end = lt < 0 ? this.bufEnd : lt;
        const raw = this.text(start, end);
        this.at = end;
        return { kind: "text", text: xmlUnescape(raw.replace(/\r\n?/g, "\n")), start, end };
      }
      const second = this.here(start + s) || (await this.has(start + s)) ? this.unit(start + s) : -1;
      if (second === BANG) {
        if (await this.matches(start, [LT, BANG, DASH, DASH])) {
          const close = await this.findSequence([DASH, DASH, GT], start + 4 * s);
          if (close < 0) throw this.cutShort(start);
          this.at = close + 3 * s;
          continue;
        }
        if (await this.matches(start, CDATA_OPEN)) {
          const close = await this.findSequence([CLOSE_BRACKET, CLOSE_BRACKET, GT], start + CDATA_OPEN.length * s);
          if (close < 0) throw this.cutShort(start);
          const text = this.text(start + CDATA_OPEN.length * s, close);
          this.at = close + 3 * s;
          return { kind: "text", text: text.replace(/\r\n?/g, "\n"), start, end: this.at };
        }
        // A document type: up to its ">", past an internal subset in brackets.
        let p = start + 2 * s;
        let inSubset = false;
        for (;;) {
          if (!this.here(p) && !(await this.has(p))) throw this.cutShort(start);
          const c = this.unit(p);
          if (inSubset) {
            if (c === CLOSE_BRACKET) inSubset = false;
          } else if (c === OPEN_BRACKET) inSubset = true;
          else if (c === GT) break;
          p += s;
        }
        this.at = p + s;
        continue;
      }
      if (second === QUESTION) {
        const close = await this.findSequence([QUESTION, GT], start + 2 * s);
        if (close < 0) throw this.cutShort(start);
        this.at = close + 2 * s;
        continue;
      }
      // A tag: up to the ">" outside its attributes' quotes.
      let p = start + s;
      let quote = 0;
      for (;;) {
        if (!this.here(p) && !(await this.has(p))) throw this.cutShort(start);
        if (s === 1 && !quote) {
          // Jump to the next ">" unless a quote comes first, whose value may hold one.
          const from = p - this.bufAt;
          const i = this.buf.indexOf(GT, from);
          const span = this.buf.subarray(from, i >= 0 ? i : this.buf.byteLength);
          const dq = span.indexOf(DQUOTE);
          const sq = span.indexOf(SQUOTE);
          const q = dq < 0 ? sq : sq < 0 ? dq : Math.min(dq, sq);
          if (q >= 0) p += q;
          else if (i >= 0) {
            p = this.bufAt + i;
            break;
          } else {
            p = this.bufAt + this.buf.byteLength;
            continue;
          }
        }
        const c = this.unit(p);
        if (quote) {
          if (c === quote) quote = 0;
        } else if (c === DQUOTE || c === SQUOTE) quote = c;
        else if (c === GT) break;
        p += s;
      }
      const inside = this.text(start + s, p);
      this.at = p + s;
      const end = this.at;
      if (second === SLASH) return { kind: "close", name: inside.slice(1).trim(), start, end };
      const selfClosing = inside.endsWith("/");
      const body = selfClosing ? inside.slice(0, -1) : inside;
      const nameEnd = body.search(/\s/);
      const name = nameEnd < 0 ? body : body.slice(0, nameEnd);
      if (!name) throw new UnreadableFile(`The XML is not well formed near byte ${start}: a tag has no name.`, "damaged");
      return { kind: "open", name, attrs: nameEnd < 0 ? {} : attributes(body.slice(nameEnd)), selfClosing, start, end };
    }
  }

  private cutShort(at: number): UnreadableFile {
    return new UnreadableFile(`The XML ends inside a tag or a comment that starts at byte ${at}; the file may be cut short.`, "damaged");
  }

  /** The element an opening tag `next` just gave starts, read whole to its closing tag. */
  async element(open: Extract<XmlToken, { kind: "open" }>): Promise<XmlNode> {
    const root: XmlNode = { name: open.name, attrs: open.attrs, content: [] };
    if (open.selfClosing) return root;
    const stack: XmlNode[] = [root];
    for (;;) {
      if (this.at - open.start > MAX_ELEMENT_BYTES) {
        throw new UnreadableFile(`The element <${open.name}> at byte ${open.start} runs past ${MAX_ELEMENT_BYTES >> 20} MB, so this file is not XML a store can read.`, "damaged");
      }
      const t = await this.next();
      if (!t) throw new UnreadableFile(`The element <${open.name}> at byte ${open.start} never ends; the file may be cut short.`, "damaged");
      const top = stack[stack.length - 1]!;
      if (t.kind === "text") {
        if (t.text) top.content.push(t.text);
      } else if (t.kind === "open") {
        const node: XmlNode = { name: t.name, attrs: t.attrs, content: [] };
        top.content.push(node);
        if (!t.selfClosing) stack.push(node);
      } else {
        if (t.name !== top.name) throw new UnreadableFile(`The XML is not well formed near byte ${t.start}: </${t.name}> closes <${top.name}>.`, "damaged");
        stack.pop();
        if (!stack.length) return root;
      }
    }
  }

  /** Skips the element an opening tag `next` just gave starts, to its closing tag. */
  async skip(open: Extract<XmlToken, { kind: "open" }>): Promise<void> {
    if (open.selfClosing) return;
    let depth = 1;
    for (;;) {
      const t = await this.next();
      if (!t) throw new UnreadableFile(`The element <${open.name}> at byte ${open.start} never ends; the file may be cut short.`, "damaged");
      if (t.kind === "open" && !t.selfClosing) depth++;
      else if (t.kind === "close" && --depth === 0) return;
    }
  }
}

const CDATA_OPEN = [LT, BANG, OPEN_BRACKET, 0x43, 0x44, 0x41, 0x54, 0x41, OPEN_BRACKET] as const;

/** A tag's attributes, from the text after its name: `a="1" b='two'`. */
function attributes(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    // A literal tab or line break in a value reads as a space; a character reference keeps it.
    out[m[1]!] = xmlUnescape((m[2] ?? m[3] ?? "").replace(/[\t\n\r]/g, " "));
  }
  return out;
}

/** Whether bytes start like XML: "<" first, after a byte order mark and spaces. */
export function looksLikeXml(head: Uint8Array): boolean {
  const opening = xmlOpening(head).replace(/^﻿/, "").trimStart();
  return opening.startsWith("<") && !opening.startsWith("<<");
}

