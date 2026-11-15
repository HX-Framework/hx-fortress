// JSON, read by range a window at a time and scanned at the level of its bytes (two-byte units
// for UTF-16), with a cursor that is a byte offset in the file. JSON's structural characters are
// ASCII, so a record's end is found without decoding anything before it, and each record is
// decoded and parsed on its own.
//
// What a file's tables are:
//   - an array at the top: one table, a record per element;
//   - an object at the top: one table per array in it, named by its key ("permits"), or by its
//     path for an array inside an object ("response.docs"); an object with no array is one record;
//   - JSON Lines (.jsonl, .ndjson), or values one after another: one table, a record per value.
// A record that is an object gives a column per key, a nested object's keys as "owner.name" (three
// levels deep, deeper ones as JSON), a list as JSON. A GeoJSON feature's properties are its
// columns, its geometry is JSON. A record that is a list gives its values by position, under the
// first list's names when those read as names, as a CSV header does. A value is the file's text: a
// number as written ("150.00"), true or false, a date-time written "2019-01-07T09:30:15" with no
// zone as the other readers write it ("2019-01-07 09:30:15"); null and "" are null.
//
// A record's row number counts from 1 among its table's records; in JSON Lines it is the line the
// record starts on, as an editor numbers lines.

import { looksLikeData } from "./header.js";
import type { ByteSource } from "./source.js";
import { decode, detectEncoding, type TextEncoding, unitBytes } from "./text.js";
import { type BatchLimit, type OpenedFile, type ReadCursor, type RowBatch, type SourceRow, type SourceTable, UnreadableFile } from "./types.js";
import { isoDateText } from "./xml.js";

const SAMPLE_ROWS = 2000;
const WINDOW_BYTES = 1 << 20;
/** The longest record a read goes looking for the end of; longer is a file a store cannot read as records. */
export const MAX_JSON_RECORD_BYTES = 64 << 20;
/** How deep a record's objects become columns of their own; deeper ones are JSON. */
const FLAT_DEPTH = 3;
/** How deep in an object at the top an array is looked for. */
const TABLE_DEPTH = 3;
/** How much of the file's opening tells JSON Lines from one value. */
const SNIFF_BYTES = 1 << 20;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const COMMA = 0x2c;
const COLON = 0x3a;
const LF = 0x0a;

const isSpace = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0xfeff;

/** Bytes of a JSON file through a window that moves forward, read by unit. */
class JsonBytes {
  private buf: Uint8Array = new Uint8Array(0);
  /** Where `buf` starts in the file; every position below is a byte offset in the file. */
  private bufAt: number;
  readonly step: 1 | 2;
  private readonly le: boolean;

  constructor(
    private readonly source: ByteSource,
    readonly encoding: TextEncoding,
    at: number,
  ) {
    this.bufAt = at;
    this.step = unitBytes(encoding);
    this.le = encoding.kind !== "utf-16be";
  }

  get size(): number {
    return this.source.size - ((this.source.size - this.bufAt) % this.step);
  }

  private get bufEnd(): number {
    return this.bufAt + this.buf.byteLength;
  }

  /** Drops what is before `keep`, which is not read again. */
  release(keep: number): void {
    if (keep > this.bufAt && keep <= this.bufEnd) {
      this.buf = this.buf.subarray(keep - this.bufAt);
      this.bufAt = keep;
    }
  }

  /** Whether the unit at `p` exists, reading on as needed. */
  async has(p: number, from: number): Promise<boolean> {
    while (p + this.step > this.bufEnd) {
      if (this.bufEnd >= this.source.size) return false;
      if (this.bufEnd - from > MAX_JSON_RECORD_BYTES) {
        throw new UnreadableFile(`A record starting at byte ${from} runs past ${MAX_JSON_RECORD_BYTES >> 20} MB without ending, so this file is not JSON a store can read as records.`, "damaged");
      }
      const next = await this.source.read(this.bufEnd, WINDOW_BYTES);
      if (!next.byteLength) return false;
      this.release(Math.min(from, this.bufEnd));
      const joined = new Uint8Array(this.buf.byteLength + next.byteLength);
      joined.set(this.buf);
      joined.set(next, this.buf.byteLength);
      this.buf = joined;
    }
    return true;
  }

  /** Whether the unit at `p` is in the buffer now, without reading. */
  here(p: number): boolean {
    return p + this.step <= this.bufEnd;
  }

  unit(p: number): number {
    const i = p - this.bufAt;
    const b = this.buf;
    if (this.step === 1) return b[i]!;
    return this.le ? b[i]! | (b[i + 1]! << 8) : (b[i]! << 8) | b[i + 1]!;
  }

  text(from: number, to: number): string {
    return decode(this.buf.subarray(from - this.bufAt, to - this.bufAt), this.encoding);
  }

  /** The first unit at or after `p` that is not a space, and the line breaks passed; `at` is the end of the file when none is left. */
  async skipSpace(p: number): Promise<{ at: number; lines: number }> {
    let lines = 0;
    while (this.here(p) || (await this.has(p, p))) {
      const c = this.unit(p);
      if (!isSpace(c)) return { at: p, lines };
      if (c === LF) lines++;
      p += this.step;
    }
    return { at: p, lines };
  }

  /**
   * Where the value starting at `p` ends, and the line breaks inside it. `keep` holds the value's
   * bytes for decoding, up to MAX_JSON_RECORD_BYTES; without it a value of any size is passed over.
   */
  async valueEnd(p: number, keep = true): Promise<{ end: number; lines: number }> {
    const s = this.step;
    if (!(await this.has(p, p))) throw this.cutShort(p);
    const first = this.unit(p);
    let lines = 0;
    if (first !== OPEN_BRACE && first !== OPEN_BRACKET && first !== QUOTE) {
      // A number, true, false or null: up to the next delimiter.
      let q = p;
      while (this.here(q) || (await this.has(q, keep ? p : q))) {
        const c = this.unit(q);
        if (c === COMMA || c === CLOSE_BRACKET || c === CLOSE_BRACE || c === COLON || isSpace(c)) break;
        q += s;
      }
      return { end: q, lines };
    }
    let depth = 0;
    let inString = false;
    let q = p;
    for (;;) {
      if (!this.here(q) && !(await this.has(q, keep ? p : q))) throw this.cutShort(p);
      const c = this.unit(q);
      if (inString) {
        if (c === BACKSLASH) q += s;
        else if (c === QUOTE) {
          inString = false;
          if (depth === 0) return { end: q + s, lines };
        }
      } else if (c === QUOTE) inString = true;
      else if (c === OPEN_BRACE || c === OPEN_BRACKET) depth++;
      else if (c === CLOSE_BRACE || c === CLOSE_BRACKET) {
        if (--depth === 0) return { end: q + s, lines };
      } else if (c === LF) lines++;
      q += s;
    }
  }

  cutShort(at: number): UnreadableFile {
    return new UnreadableFile(`The JSON ends inside a value that starts at byte ${at}; the file may be cut short.`, "damaged");
  }
}

/** A number as the file writes it. */
class RawNumber {
  constructor(readonly text: string) {}
}

/** A value's text parsed, every number kept as the file writes it. */
function parseValue(text: string, at: number): unknown {
  try {
    return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) => (typeof value === "number" ? new RawNumber(context?.source ?? String(value)) : value));
  } catch {
    throw new UnreadableFile(`The JSON is not valid near byte ${at}.`, "damaged");
  }
}

/** A parsed value as JSON again, numbers as the file wrote them. */
function asJson(v: unknown): string {
  if (v instanceof RawNumber) return v.text;
  if (Array.isArray(v)) return `[${v.map(asJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}:${asJson(x)}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

/** What a value is, for a column's type. */
function kindOfValue(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof RawNumber) return "number";
  if (typeof v === "boolean") return "yes/no";
  if (typeof v === "string") return /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.test(v) ? "date" : "text";
  if (Array.isArray(v)) return "list";
  return "object";
}

/** A scalar's text: a number as written, true or false, a date-time as the readers write it; null for null and "". */
function scalarText(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof RawNumber) return v.text;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return isoDateText(v);
  return asJson(v);
}

interface Field {
  value: string | null;
  kind: string | null;
}

/** An object record's columns: its keys, nested objects' as "a.b", lists and deeper objects as JSON. */
function objectFields(record: Record<string, unknown>, out = new Map<string, Field>(), prefix = "", depth = 1): Map<string, Field> {
  for (const [k, v] of Object.entries(record)) {
    const name = prefix + k;
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof RawNumber) && depth < FLAT_DEPTH && Object.keys(v).length) objectFields(v as Record<string, unknown>, out, `${name}.`, depth + 1);
    else {
      // A key "a.b" and the key b of an object under a both keep their values: the second is "a.b_2".
      let key = name;
      for (let k = 2; out.has(key); k++) key = `${name}_${k}`;
      out.set(key, { value: scalarText(v), kind: kindOfValue(v) });
    }
  }
  return out;
}

const isFeature = (v: unknown): v is { type: "Feature"; id?: unknown; properties?: Record<string, unknown> | null; geometry?: unknown } =>
  !!v && typeof v === "object" && (v as { type?: unknown }).type === "Feature";

/** A record's columns by name. */
function recordFields(record: unknown, header: readonly string[] | null): Map<string, Field> {
  if (isFeature(record)) {
    // A GeoJSON feature: its id, its properties as columns, its geometry as JSON.
    const out = new Map<string, Field>();
    if (record.id !== undefined) out.set("id", { value: scalarText(record.id), kind: kindOfValue(record.id) });
    if (record.properties && typeof record.properties === "object") objectFields(record.properties, out);
    if (!out.has("geometry")) out.set("geometry", { value: record.geometry == null ? null : asJson(record.geometry), kind: record.geometry == null ? null : "geometry" });
    return out;
  }
  if (Array.isArray(record)) {
    const out = new Map<string, Field>();
    record.forEach((v, i) => out.set(header?.[i] ?? `column ${i + 1}`, { value: scalarText(v), kind: kindOfValue(v) }));
    return out;
  }
  if (record && typeof record === "object" && !(record instanceof RawNumber)) return objectFields(record as Record<string, unknown>);
  return new Map([["value", { value: scalarText(record), kind: kindOfValue(record) }]]);
}

/** A column's type from the kinds of its values in the sample: "number", "text", or "mixed (number, text)". */
function typeOf(kinds: ReadonlySet<string> | undefined): string {
  const seen = [...(kinds ?? [])];
  if (!seen.length) return "empty";
  return seen.length === 1 ? seen[0]! : `mixed (${seen.sort().join(", ")})`;
}

/** How a table's records are laid out: an array's elements from `start`, or values one after another. */
interface JsonTable {
  table: SourceTable;
  mode: "array" | "lines";
  /** Where its first record (or the space before it) starts, and that place's line. */
  start: number;
  line: number;
  columns: string[];
  /** The names a list record's values have, from its first record, or null. */
  header: string[] | null;
}

/** Records of a table from a byte offset, each with where it ends. */
async function* records(bytes: JsonBytes, mode: "array" | "lines", at: number, line: number): AsyncGenerator<{ value: unknown; start: number; end: number; line: number; endLine: number }> {
  let p = at;
  let ln = line;
  for (;;) {
    const gap = await bytes.skipSpace(p);
    ln += gap.lines;
    p = gap.at;
    if (!(await bytes.has(p, p))) {
      if (mode === "array") throw bytes.cutShort(at);
      return;
    }
    const c = bytes.unit(p);
    if (mode === "array") {
      if (c === CLOSE_BRACKET) return;
      if (c === COMMA) {
        p += bytes.step;
        continue;
      }
    }
    const { end, lines } = await bytes.valueEnd(p);
    const value = parseValue(bytes.text(p, end), p);
    yield { value, start: p, end, line: ln, endLine: ln + lines };
    ln += lines;
    p = end;
    bytes.release(p);
  }
}

/** The arrays in an object at the top, by path, and where each one's elements start. */
async function arraysIn(bytes: JsonBytes, at: number, prefix: string, depth: number, out: { name: string; start: number; first: number }[]): Promise<number> {
  // `at` is the object's "{".
  let p = at + bytes.step;
  for (;;) {
    p = (await bytes.skipSpace(p)).at;
    if (!(await bytes.has(p, p))) throw bytes.cutShort(at);
    let c = bytes.unit(p);
    if (c === CLOSE_BRACE) return p + bytes.step;
    if (c === COMMA) {
      p += bytes.step;
      continue;
    }
    if (c !== QUOTE) throw new UnreadableFile(`The JSON is not valid near byte ${p}: a key is missing.`, "damaged");
    const keyEnd = (await bytes.valueEnd(p)).end;
    const key = String(parseValue(bytes.text(p, keyEnd), p));
    p = (await bytes.skipSpace(keyEnd)).at;
    if (!(await bytes.has(p, p)) || bytes.unit(p) !== COLON) throw new UnreadableFile(`The JSON is not valid near byte ${p}: a ":" is missing.`, "damaged");
    p = (await bytes.skipSpace(p + bytes.step)).at;
    if (!(await bytes.has(p, p))) throw bytes.cutShort(at);
    c = bytes.unit(p);
    const name = prefix + key;
    if (c === OPEN_BRACKET) {
      const first = (await bytes.skipSpace(p + bytes.step)).at;
      out.push({ name, start: p + bytes.step, first: (await bytes.has(first, first)) ? bytes.unit(first) : CLOSE_BRACKET });
      p = (await bytes.valueEnd(p, false)).end;
    } else if (c === OPEN_BRACE && depth < TABLE_DEPTH) p = await arraysIn(bytes, p, `${name}.`, depth + 1, out);
    else p = (await bytes.valueEnd(p, false)).end;
    bytes.release(p);
  }
}

export interface OpenJsonOptions {
  /** JSON Lines (.jsonl, .ndjson): a record per line, whatever the first line holds. */
  lines?: boolean;
}

/** A JSON or JSON Lines file, opened. */
export async function openJson(source: ByteSource, options: OpenJsonOptions = {}): Promise<OpenedFile> {
  const head = await source.read(0, Math.min(source.size, 4096));
  const { encoding, bom } = detectEncoding(head);
  const bytes = new JsonBytes(source, encoding, bom);
  const begin = await bytes.skipSpace(bom);
  if (!(await bytes.has(begin.at, begin.at))) throw new UnreadableFile("This JSON file is empty.", "damaged");
  const first = bytes.unit(begin.at);
  const tables: JsonTable[] = [];
  const notes: string[] = [];
  const fileStart = begin.at;
  const fileLine = 1 + begin.lines;

  let lines = !!options.lines;
  if (!lines && (first === OPEN_BRACE || first === OPEN_BRACKET)) lines = await followedByValue(source, encoding, fileStart);
  // A file that starts with a single value (a number, a string) is read as values one after another.
  if (!lines && first !== OPEN_BRACE && first !== OPEN_BRACKET) lines = true;

  if (lines) tables.push(emptyTable(null, "lines", fileStart, fileLine));
  else if (first === OPEN_BRACKET) tables.push(emptyTable(null, "array", fileStart + bytes.step, fileLine));
  else {
    const arrays: { name: string; start: number; first: number }[] = [];
    await arraysIn(bytes, fileStart, "", 1, arrays);
    const ofRecords = arrays.filter((a) => a.first === OPEN_BRACE || a.first === OPEN_BRACKET);
    const chosen = ofRecords.length ? ofRecords : arrays.filter((a) => a.first !== CLOSE_BRACKET);
    if (chosen.length) for (const a of chosen) tables.push(emptyTable(a.name, "array", a.start, 0));
    else tables.push(emptyTable(null, "lines", fileStart, fileLine));
    const left = arrays.filter((a) => !chosen.includes(a) && a.first !== CLOSE_BRACKET).map((a) => a.name);
    if (left.length) notes.push(`The lists of single values (${left.join(", ")}) are not loaded.`);
  }

  // Each table's columns and their types, from its first records.
  for (const t of tables) {
    const reader = new JsonBytes(source, encoding, t.start);
    const kinds = new Map<string, Set<string>>();
    let sampled = 0;
    let count = 0;
    for await (const r of records(reader, t.mode, t.start, t.line)) {
      if (count === 0 && Array.isArray(r.value) && r.value.length && r.value.every((v) => typeof v === "string" && v.trim() !== "" && !looksLikeData(v))) {
        // A list of names first: the header, as a CSV's first row is.
        t.header = r.value as string[];
        t.columns.push(...t.header);
        count++;
        continue;
      }
      for (const [name, f] of recordFields(r.value, t.header)) {
        if (!kinds.has(name)) {
          kinds.set(name, new Set());
          if (!t.columns.includes(name)) t.columns.push(name);
        }
        if (f.kind) kinds.get(name)!.add(f.kind);
      }
      count++;
      if (++sampled >= SAMPLE_ROWS) break;
    }
    t.table.columns = t.columns.map((c) => ({ name: c, originalType: typeOf(kinds.get(c)) }));
    if (!sampled) t.table.notes.push(t.table.name ? `The list "${t.table.name}" is empty.` : "The file holds no records.");
  }

  async function rows(index: number, cursor: ReadCursor | null, limit: BatchLimit): Promise<RowBatch> {
    const t = tables[index];
    if (!t) throw new RangeError(`This file has no table ${index}.`);
    const from = cursor?.at ?? t.start;
    let at = from;
    // In an array, a record's number among the array's elements; in JSON Lines, the line it starts on.
    let n = cursor?.row ?? (t.mode === "lines" ? t.line : 1);
    // A list record's header is not a row.
    let skipHeader = !cursor && !!t.header;
    const reader = new JsonBytes(source, encoding, at);
    const known = new Set(t.columns);
    const out: SourceRow[] = [];
    let ended = true;
    for await (const r of records(reader, t.mode, at, t.mode === "lines" ? n : 0)) {
      at = r.end;
      const number = t.mode === "lines" ? r.line : n;
      n = t.mode === "lines" ? r.endLine : n + 1;
      if (skipHeader) {
        skipHeader = false;
        continue;
      }
      const fields = recordFields(r.value, t.header);
      const values = t.columns.map((c) => fields.get(c)?.value ?? null);
      let extra: Record<string, string> | undefined;
      for (const [k, f] of fields) if (f.value != null && !known.has(k)) (extra ??= {})[k] = f.value;
      out.push(extra ? { n: number, values, extra } : { n: number, values });
      if (out.length >= limit.rows || (limit.bytes && at - from >= limit.bytes)) {
        ended = false;
        break;
      }
    }
    return { rows: out, next: ended ? null : { at, row: n }, deleted: 0 };
  }

  return { format: "json", tables: tables.map((t) => t.table), notes, rows };
}

function emptyTable(name: string | null, mode: "array" | "lines", start: number, line: number): JsonTable {
  return { table: { name, columns: [], rowCount: null, notes: [] }, mode, start, line, columns: [], header: null };
}

/** Whether the first value of a file ends within its opening and another value follows: JSON Lines, or values one after another. */
async function followedByValue(source: ByteSource, encoding: TextEncoding, start: number): Promise<boolean> {
  const window: ByteSource = { size: Math.min(source.size, start + SNIFF_BYTES), read: (o, l) => source.read(o, Math.min(l, start + SNIFF_BYTES - o)) };
  const bytes = new JsonBytes(window, encoding, start);
  try {
    const { end } = await bytes.valueEnd(start);
    const after = await bytes.skipSpace(end);
    return after.at < window.size && (await bytes.has(after.at, after.at)) && bytes.unit(after.at) !== COMMA;
  } catch {
    // The first value does not end in the opening: one big value.
    return false;
  }
}
