// A PDF, rendered here rather than in the browser.
//
// The compliance report has to be downloadable as a document, and the obvious
// implementation - build it client-side from the JSON the page already has -
// puts artifact GENERATION in the one place the console cannot audit and cannot
// bound. A client-rendered report is also a report whose contents depend on what
// the tab happened to have loaded, which is not a property a compliance artifact
// may have.
//
// So it is written here, from the same payload the JSON endpoint returns, by a
// deliberately small writer: PDF 1.4, one built-in font, no images, no
// compression, no external library. Every string is escaped for the PDF string
// syntax, so a session title containing a parenthesis or a backslash - the
// shapes that break a naive writer - renders as itself instead of corrupting the
// document.

const PAGE_WIDTH = 595; // A4 at 72dpi
const PAGE_HEIGHT = 842;
const MARGIN = 56;
const LINE_HEIGHT = 14;
const FONT_SIZE = 10;
const TITLE_SIZE = 15;
const LINES_PER_PAGE = Math.floor((PAGE_HEIGHT - MARGIN * 2) / LINE_HEIGHT) - 3;
/** Wrap width in characters at FONT_SIZE in Helvetica. Approximate on purpose:
 *  the alternative is shipping font metrics for a document nobody typesets. */
const WRAP = 96;

/** PDF string escaping. `(`, `)` and `\` are the syntax itself; a title carrying
 *  one would otherwise end the string early and corrupt every object after it. */
function escapePdfText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    // Anything outside printable ASCII is dropped rather than guessed at: the
    // built-in Helvetica encoding cannot represent it, and a mojibake glyph in a
    // compliance document is worse than a missing one.
    .replace(/[^\x20-\x7e]/g, "?");
}

function wrap(line: string): string[] {
  if (line.length <= WRAP) return [line];
  const words = line.split(" ");
  const out: string[] = [];
  let current = "";
  for (const word of words) {
    if (current && `${current} ${word}`.length > WRAP) {
      out.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) out.push(current);
  return out;
}

function contentStream(title: string | null, lines: readonly string[]): string {
  const parts: string[] = ["BT"];
  let y = PAGE_HEIGHT - MARGIN;
  if (title) {
    parts.push(`/F1 ${TITLE_SIZE} Tf`, `1 0 0 1 ${MARGIN} ${y} Tm`, `(${escapePdfText(title)}) Tj`);
    y -= LINE_HEIGHT * 2;
  }
  parts.push(`/F1 ${FONT_SIZE} Tf`);
  for (const line of lines) {
    parts.push(`1 0 0 1 ${MARGIN} ${y} Tm`, `(${escapePdfText(line)}) Tj`);
    y -= LINE_HEIGHT;
  }
  parts.push("ET");
  return parts.join("\n");
}

/**
 * Render lines into a PDF. Paginates rather than clipping: a report that silently
 * stops at the bottom of page one is a report that lies by omission.
 */
export function renderPdf(title: string, lines: readonly string[]): Uint8Array {
  const wrapped = lines.flatMap((line) => wrap(line));
  const pages: string[][] = [];
  for (let i = 0; i < Math.max(1, wrapped.length); i += LINES_PER_PAGE) {
    pages.push(wrapped.slice(i, i + LINES_PER_PAGE));
  }

  const objects: string[] = [];
  const pageObjectIds: number[] = [];
  // 1 = catalog, 2 = pages, 3 = font, then a (page, content) pair each.
  let nextId = 4;
  const contents: Array<{ pageId: number; contentId: number; body: string }> = [];
  for (const [index, page] of pages.entries()) {
    const pageId = nextId++;
    const contentId = nextId++;
    pageObjectIds.push(pageId);
    contents.push({
      pageId,
      contentId,
      body: contentStream(index === 0 ? title : null, page),
    });
  }

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageObjectIds.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  for (const { pageId, contentId, body } of contents) {
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(body, "latin1")} >>\nstream\n${body}\nendstream`;
  }

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    const body = objects[id];
    if (body === undefined) continue;
    offsets[id] = Buffer.byteLength(pdf, "latin1");
    pdf += `${id} 0 obj\n${body}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(pdf, "latin1");
  const count = objects.length;
  pdf += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id += 1) {
    pdf += `${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}
