// What a spreadsheet cell reads as, the same in an .xls workbook (excel.ts, read with SheetJS) and
// an .xlsx one (xlsx.ts, read by this package's own reader), so a town's workbook loads the same
// whichever way it was saved.

/** The kind of value a cell holds, which a column's type in the catalog is made of. */
export type Kind = "number" | "date" | "text" | "yes/no" | "error";

/**
 * A format whose leading zeros are the value's meaning: "00000", "000-00-0000", "00000-0000". It
 * has at least two zeros: "0" alone is Excel's plain whole-number format (built-in format 1).
 */
export const ZERO_PADDED = /^(?=[^0]*0[^0]*0)[0#\-\s()/]+$/;

/** A number as Excel shows it: at most 15 significant digits, no float noise. */
export const excelNumber = (v: number): string => String(Number(v.toPrecision(15)));

/** The kind a column's values are, as the catalog says it. */
export function kindOf(kinds: ReadonlySet<Kind> | undefined): string {
  const seen = [...(kinds ?? [])].filter((k) => k !== "error");
  if (!seen.length) return kinds?.has("error") ? "error" : "empty";
  return seen.length === 1 ? seen[0]! : `mixed (${seen.sort().join(", ")})`;
}

/** An error cell's text, by the code an .xls workbook (BIFF) keeps for it. */
export const ERROR_TEXT: Readonly<Record<number, string>> = {
  0x00: "#NULL!",
  0x07: "#DIV/0!",
  0x0f: "#VALUE!",
  0x17: "#REF!",
  0x1d: "#NAME?",
  0x24: "#NUM!",
  0x2a: "#N/A",
  0x2b: "#GETTING_DATA",
};
