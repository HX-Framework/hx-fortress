// What a job of each kind is about to write, said before its first write (runner.ts keeps it on the
// job and logs it with its cost at $1 per million rows). A handler's own `estimate` wins; these are
// the kinds' defaults, from what the store already knows. Each is a forecast, never a promise. They
// live here, not in load.ts and shape.ts, so the sessions that change those files keep them alone.
//
//   load   delimited text and JSON Lines (the kinds whose rows are lines, by the readers' own list,
//          `store-readers/accepted`): the lines in the first 64 KB of up to 8 of them,
//          scaled to each file's size; every line of a smaller one; and the bytes a line took in
//          those for any more. Any other kind: a row for so many bytes of it, by its kind (a
//          compressed workbook packs more rows into a byte, an Access database fewer).
//   shape  as many rows as its largest source table whose count the store knows: a SHAPE is
//          mostly one row per source row. A count writes left unknown is not read again here.

import { acceptedKindOf, type AcceptedFileKind } from "../../../store-readers/src/accepted.js";
import type { JobEstimate } from "../types.js";
import type { JobEstimateView } from "./types.js";

/** Bytes of a file per row it holds, about, by its kind, for a kind whose lines are not its rows. */
const BYTES_PER_ROW: Readonly<Record<AcceptedFileKind["kind"], number>> = {
  delimited: 120,
  excel: 60,
  opendocument: 60,
  access: 300,
  dbase: 200,
  sqlite: 150,
  json: 200,
  xml: 200,
  parquet: 25,
  zip: 30,
};
const BYTES_PER_ROW_ELSE = 120;

/** JSON Lines are JSON by kind, and a row per line. */
const LINES_EXTENSIONS = new Set(["jsonl", "ndjson"]);

/** How much of a file an estimate reads, and how many files it reads. */
export const SAMPLE_BYTES = 64 * 1024;
export const SAMPLED_FILES_MAX = 8;

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/** Whether a file's rows are its lines, by the readers' list of kinds. */
function linesAreRows(name: string): boolean {
  const kind = acceptedKindOf(name)?.kind;
  return kind === "delimited" || (kind === "json" && LINES_EXTENSIONS.has(extensionOf(name)));
}

/**
 * Lines in bytes, ended as the delimited reader ends a record (LF, CR LF, or a CR alone, as an old
 * Mac saves a CSV), and a last line without an end.
 */
export function linesIn(bytes: Uint8Array, whole: boolean): number {
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x0a || (b === 0x0d && bytes[i + 1] !== 0x0a)) n++;
  }
  const last = bytes[bytes.length - 1];
  if (whole && bytes.length > 0 && last !== 0x0a && last !== 0x0d) n++;
  return n;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** LOAD: the rows its files hold, from the first lines of a few, and each kind's bytes per row for the rest. */
export async function estimateLoad(params: unknown, view: JobEstimateView): Promise<JobEstimate | null> {
  if (!isRecord(params) || !Array.isArray(params.files)) return null;
  const files: { id: string; name: string; size: number }[] = [];
  for (const f of params.files) {
    if (!isRecord(f) || typeof f.id !== "string") continue;
    const file = view.file(f.id);
    if (file) files.push({ id: f.id, ...file });
  }
  if (files.length === 0) return null;
  let rows = 0;
  let sampled = 0;
  let sampledBytes = 0;
  let sampledLines = 0;
  const unsampled: { size: number }[] = [];
  for (const file of files) {
    if (!linesAreRows(file.name) || file.size <= 0) {
      rows += file.size / (BYTES_PER_ROW[acceptedKindOf(file.name)?.kind ?? "delimited"] ?? BYTES_PER_ROW_ELSE);
      continue;
    }
    const sample = sampled < SAMPLED_FILES_MAX ? await view.sample(file.id, SAMPLE_BYTES).catch(() => null) : null;
    if (!sample || sample.length === 0) {
      unsampled.push(file);
      continue;
    }
    sampled++;
    const whole = sample.length >= file.size;
    const lines = linesIn(sample, whole);
    sampledBytes += sample.length;
    sampledLines += lines;
    // Lines minus the header row; a sample that holds part of the file speaks for the rest.
    rows += whole ? Math.max(0, lines - 1) : Math.max(0, (lines / sample.length) * file.size - 1);
  }
  // Files past the ones read: the bytes a line took in those, else a delimited row's usual bytes.
  const bytesPerLine = sampledLines > 0 ? sampledBytes / sampledLines : BYTES_PER_ROW.delimited;
  for (const file of unsampled) rows += file.size / bytesPerLine;
  const basis =
    sampled === files.length
      ? `the lines in ${files.length === 1 ? "its file" : `its ${files.length} files`}`
      : sampled > 0
        ? `the lines in ${sampled} of its ${files.length} files, and the others' sizes`
        : `the sizes of ${files.length} file${files.length === 1 ? "" : "s"}`;
  return { rows: Math.ceil(rows), basis };
}

/** SHAPE: the rows of its largest source table (`sources` names them, as the api sent it). */
export function estimateShape(params: unknown, view: JobEstimateView): JobEstimate | null {
  if (!isRecord(params) || typeof params.sources !== "string") return null;
  let sources: unknown;
  try {
    sources = JSON.parse(params.sources);
  } catch {
    return null;
  }
  if (!Array.isArray(sources)) return null;
  let most: { name: string; rows: number } | null = null;
  for (const source of sources) {
    const name = Array.isArray(source) && typeof source[0] === "string" ? source[0] : null;
    if (!name) continue;
    const rows = view.tableRows(name);
    if (rows !== null && (most === null || rows > most.rows)) most = { name, rows };
  }
  return most ? { rows: most.rows, basis: `its largest source table, ${most.name}` } : null;
}

type Estimate = (params: unknown, view: JobEstimateView) => JobEstimate | null | Promise<JobEstimate | null>;

export const KIND_ESTIMATES: ReadonlyMap<string, Estimate> = new Map<string, Estimate>([
  ["load", estimateLoad],
  ["shape", estimateShape],
]);
