// store-readers: reads a town's files for a store's LOAD (Stores, Part A), in workerd inside
// the store's object and in Node. One door, `openFile`, picks the reader by the file's bytes:
//
//   delimited.ts  CSV and other delimited text, any size, read by range across alarms
//   dbf.ts        dBase and FoxPro tables with their memo files, any size, read by range
//   xlsx.ts       Excel .xlsx, streamed; excel.ts Excel .xls, read whole up to a cap
//   ods.ts        OpenDocument .ods (streamed) and .fods (by range)
//   access.ts     Access .mdb and .accdb through mdb-reader, read whole up to a cap
//   sqlite.ts     SQLite databases, page by page, any size
//   parquet.ts    Parquet files, a row group at a time, up to a row group's cap
//   json.ts       JSON, JSON Lines and GeoJSON, by range
//   xml.ts        XML exports and Excel 2003 XML spreadsheets, by range
//   archive.ts    zip archives of any of these, each file read by its own reader
//   code-page.ts  which code page a dBase table's text is in, from its words, where its header names another
//
// Every reader answers in the same shapes (types.ts): the tables a file holds, their columns with
// the town's own types, and rows of text a batch at a time, with a cursor that a later batch goes
// on from. names.ts says what a store calls the tables and columns LOAD makes, and row-key.ts how a
// raw row is named and fingerprinted across loads; accepted.ts lists every kind of file LOAD reads,
// and programs.ts the one kind a guest's upload refuses, alone or inside a zip.

export { ACCEPTED_EXTENSIONS, ACCEPTED_FILES, type AcceptedFileKind, acceptedKindOf, acceptedKindsInWords, notLoadedKindWords, nothingToLoadWords, skippedForItsKind } from "./accepted.js";
export { isProgramFile, isZipFile, PROGRAM_EXTENSIONS, programsInZip } from "./programs.js";
export { openArchive, ZIP_FILES_MAX, ZIP_INFLATED_CAP } from "./archive.js";
export { openJson } from "./json.js";
export { odfDate, odfTime, openOds } from "./ods.js";
export { looksLikeParquet, openParquet } from "./parquet.js";
export { looksLikeSqlite, openSqlite } from "./sqlite.js";
export { isoDateText, openXml, xmlColumnName } from "./xml.js";
export { openAccess, singleText } from "./access.js";
export { addWords, type CodePageGuess, guessCodePage, PREFERRED, readsWrongIn, type SeenWord } from "./code-page.js";
export { dbfInteger, dbfTypeName, looksLikeDbf, openDbf, type OpenDbfOptions, readDbfHeader, SAMPLE_BYTES, type DbfField, type DbfHeader } from "./dbf.js";
export { openDelimited, type OpenDelimitedOptions, readDelimitedRows, sniffDelimited, type DelimitedShape } from "./delimited.js";
export { chooseHeader, type HeaderChoice, looksLikeData, OPENING_ROWS, type OpeningRow, type OpeningValue, readsAsName, ROWS_ABOVE_MAX } from "./header.js";
export { openExcel } from "./excel.js";
export { isDateFormat, openXlsx, serialDate, SHARED_TEXT_CAP, zeroPadded } from "./xlsx.js";
export {
  baseName,
  cleanColumnName,
  type ColumnPlan,
  EXTRA_COLUMN,
  extensionOf,
  FILE_COLUMN,
  filePrefixes,
  HASH_COLUMN,
  KEY_COLUMN,
  MAX_KEPT_COLUMNS,
  packRow,
  planColumns,
  type PlannedColumn,
  ROW_COLUMN,
  secondTableName,
  slug,
  tableNameIn,
  unusedName,
} from "./names.js";
export { formatOf, openFile, type OpenFileOptions, WHOLE_FILE_CAPS } from "./open.js";
export { hashKey, keyColumnOf, rowHash, rowKey } from "./row-key.js";
export { type ByteSource, bytesSource, readAll, windowedSource } from "./source.js";
export { decode, detectEncoding, encodingName, encodingOfPage, type TextEncoding, validUtf8 } from "./text.js";
export {
  type BatchLimit,
  type OpenedFile,
  type ReadCursor,
  type RowBatch,
  type SetCodePage,
  type SourceColumn,
  type SourceFormat,
  type SourceRow,
  type SourceTable,
  UnreadableFile,
} from "./types.js";
export {
  codePageName,
  codePageOf,
  LOADED_GROUP,
  type LoadedTable,
  type LoadFile,
  type LoadParams,
  type LoadResult,
  madeByOf,
  type MadeBy,
  MAX_TABLE_NAME,
  READABLE_CODE_PAGES,
  type SavedShape,
  SHAPED_GROUP,
  shapeKey,
  type ShapeParams,
  UTF8_CODE_PAGE,
} from "./jobs.js";
export { candidatesFor, exactForm, matchForm, matchIndex, type MatchIndex, matchWords, ruleMatch, type RuleMatch } from "./match-words.js";
