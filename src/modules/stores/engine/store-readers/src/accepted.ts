// Every kind of file a store's LOAD reads into tables, by its extensions and its plain name. LOAD's
// own refusal and `store_load`'s description read this one list, so what they say LOAD reads and
// what it reads never disagree. It imports nothing, so it is read (`store-readers/accepted`)
// without any reader.
//
// It is not what a store takes. A store keeps a file of any kind, and the page a town uploads on
// takes any file but a program (programs.ts): a file of a kind that is not here stays in the store
// as it came, and LOAD skips it with the reason.
//
// LOAD tells a file's kind by its bytes first (open.ts `formatOf`): a database renamed .dat is
// still read as a database. The extensions are what open.ts reads a file by when its bytes do not
// say.

/** One kind of file LOAD reads. */
export interface AcceptedFileKind {
  /** A key that stays the same: "delimited", "excel", … */
  kind: "delimited" | "excel" | "opendocument" | "access" | "dbase" | "sqlite" | "json" | "xml" | "parquet" | "zip";
  /** The kind's plain name in English, as a list of kinds reads it. */
  name: string;
  /** Its extensions, lowercase, without the dot. */
  extensions: readonly string[];
}

export const ACCEPTED_FILES: readonly AcceptedFileKind[] = [
  { kind: "delimited", name: "CSV and other delimited text", extensions: ["csv", "tsv", "tab", "txt", "psv", "dat", "prn", "asc"] },
  { kind: "excel", name: "Excel workbooks", extensions: ["xlsx", "xlsm", "xltx", "xltm", "xls", "xlt"] },
  { kind: "opendocument", name: "OpenDocument spreadsheets", extensions: ["ods", "ots", "fods"] },
  { kind: "access", name: "Access databases", extensions: ["mdb", "accdb"] },
  { kind: "dbase", name: "dBase and FoxPro tables, with their memo files", extensions: ["dbf", "fpt", "dbt"] },
  { kind: "sqlite", name: "SQLite databases", extensions: ["sqlite", "sqlite3", "db", "db3", "s3db", "sl3", "gpkg"] },
  { kind: "json", name: "JSON and JSON Lines", extensions: ["json", "jsonl", "ndjson", "geojson"] },
  { kind: "xml", name: "XML exports, Excel 2003 XML among them", extensions: ["xml"] },
  { kind: "parquet", name: "Parquet files", extensions: ["parquet", "pq"] },
  { kind: "zip", name: "zip archives of any of these", extensions: ["zip"] },
];

/** Every accepted extension, lowercase, without the dot. */
export const ACCEPTED_EXTENSIONS: ReadonlySet<string> = new Set(ACCEPTED_FILES.flatMap((k) => k.extensions));

/** The extensions of one kind. */
export const extensionsOf = (kind: AcceptedFileKind["kind"]): ReadonlySet<string> => new Set(ACCEPTED_FILES.find((k) => k.kind === kind)?.extensions ?? []);

/** The kind a file's name says, or null for a name with no accepted extension. */
export function acceptedKindOf(fileName: string): AcceptedFileKind | null {
  const last = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = last.lastIndexOf(".");
  const ext = dot > 0 ? last.slice(dot + 1).toLowerCase() : "";
  return ACCEPTED_FILES.find((k) => k.extensions.includes(ext)) ?? null;
}

/** The kinds as a sentence reads them: "CSV and other delimited text, Excel workbooks, … or zip archives of any of these". */
export function acceptedKindsInWords(): string {
  const names = ACCEPTED_FILES.map((k) => k.name);
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/**
 * Why LOAD skips a file of a kind it has no reader for. `what` names the kind where the file's
 * bytes say it ("a Word document"); without it the sentence lists the kinds LOAD reads.
 */
export function notLoadedKindWords(fileName: string, what?: string): string {
  return what ? `${fileName} is ${what}, so a store does not load it.` : `${fileName} is not a kind of file a store loads: ${acceptedKindsInWords()}.`;
}

/** Why LOAD skips a zip that holds no file of a kind it reads, with up to five of the files it holds. */
export function nothingToLoadWords(fileName: string, held: readonly string[]): string {
  return `${fileName} holds no file a store loads${held.length ? ` (it holds ${held.slice(0, 5).join(", ")}${held.length > 5 ? " and more" : ""})` : ""}.`;
}

/** The reasons of `notLoadedKindWords` and `nothingToLoadWords`, after the file's name. */
const KIND_REASON = /^(?:is .+, so a store does not load it|is not a kind of file a store loads: .+|holds no file a store loads(?: \(it holds .+\))?)\.$/s;

/**
 * Whether LOAD skipped a file because it has no reader for its kind (`notLoadedKindWords`,
 * `nothingToLoadWords`): a database backup, a PDF, a picture, a Word document, a zip of these.
 * Nothing is wrong with such a file, and it stays in the store as it came, so nobody is told it
 * could not be read. The whole reason must be one of those sentences about this file: a zip that
 * also holds a damaged file, or a file that failed partway through, is not one.
 */
export function skippedForItsKind(fileName: string, why: string): boolean {
  return why.startsWith(`${fileName} `) && KIND_REASON.test(why.slice(fileName.length + 1));
}
