// One table file opened in a person's browser: the door a page reads a single table file through,
// on a worker, so a CSV there shows the header, the separator and the text a store's LOAD would
// read from it.
//
// It opens the kinds a browser reads with no help from Node: delimited text, JSON and JSON Lines,
// Parquet, dBase and FoxPro tables, SQLite databases, and .xls and .ods workbooks, with the same
// readers and the same caps as `openFile` (open.ts). It leaves out two: an Access database, whose
// reader brings Node's streams into a browser, and a zip archive, which a page opens as folders.
// A kind added to `openFile` that a browser can read is added here too.

import { openDbf } from "./dbf.js";
import { openDelimited } from "./delimited.js";
import { openExcel } from "./excel.js";
import { formatOf, WHOLE_FILE_CAPS } from "./format.js";
import { openJson } from "./json.js";
import { extensionOf } from "./names.js";
import { openOds } from "./ods.js";
import { openParquet } from "./parquet.js";
import { type ByteSource, readAll } from "./source.js";
import { openSqlite } from "./sqlite.js";
import { type OpenedFile, UnreadableFile } from "./types.js";

export { bytesSource, type ByteSource } from "./source.js";
export { type OpenedFile, type SourceFormat, type SourceRow, type SourceTable, UnreadableFile } from "./types.js";

const LINES_EXTENSIONS = new Set(["jsonl", "ndjson"]);
const ZIP = [0x50, 0x4b, 0x03, 0x04];

/** A table file, opened by the reader its bytes need; a kind this door does not read is refused as "unsupported". */
export async function openTableFile(fileName: string, source: ByteSource): Promise<OpenedFile> {
  const head = await source.read(0, Math.min(source.size, 8192));
  const kind = formatOf(fileName, head, source.size);
  if ("refused" in kind) throw new UnreadableFile(kind.refused, "unsupported");
  switch (kind.format) {
    case "delimited":
      return openDelimited(source);
    case "json":
      return openJson(source, { lines: LINES_EXTENSIONS.has(extensionOf(fileName)) });
    case "parquet":
      return openParquet(source);
    case "dbf":
      return openDbf(source, { fileName });
    case "sqlite":
      return openSqlite(source);
    case "ods":
      return openOds(source, { flat: !ZIP.every((byte, at) => head[at] === byte) });
    case "xls": {
      const cap = WHOLE_FILE_CAPS.xls;
      if (source.size > cap) {
        throw new UnreadableFile(`${fileName} is ${(source.size / (1 << 20)).toFixed(1)} MB. An Excel 97-2003 workbook is read whole, up to ${Math.round(cap / (1 << 20))} MB. Save it as .xlsx, or each sheet as CSV.`, "too-big");
      }
      return openExcel(await readAll(source), "xls");
    }
    default:
      throw new UnreadableFile(`${fileName} is not a table file this page reads.`, "unsupported");
  }
}
