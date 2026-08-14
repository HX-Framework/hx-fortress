// The boxed pairing-code card — ported from hx's `renderPairingCard`
// (hx/src/connect.ts). The browser approve page says "Check this matches your
// terminal", so the code must stand out: a boxed label/value card with a dim
// chrome + 256-colour-39 accent, box-drawing glyphs on UTF-8 locales with an
// ASCII fallback, and no colour when stdout isn't a TTY. Keep the XXXX-XXXX
// line shape so log-scrapers can lift the code back out.

export interface PairingCardOpts {
  userCode: string;
  /** Host of the approve page, e.g. "workbench.let.ai" — the second card row.
   *  Omit to render a single-row (pairing-code only) card. */
  approveHost?: string;
  /** Paint ANSI colours. Defaults to stdout-is-a-TTY. */
  tty?: boolean;
  /** Use box-drawing glyphs. Defaults to a locale sniff. */
  utf8?: boolean;
}

function isUtf8Locale(): boolean {
  const locale = process.env.LC_ALL ?? process.env.LC_CTYPE ?? process.env.LANG ?? "";
  return /utf-?8/i.test(locale);
}

/** The boxed pairing-code card, as printable lines. */
export function renderPairingCard(o: PairingCardOpts): string[] {
  const tty = o.tty ?? Boolean(process.stdout.isTTY);
  const utf8 = o.utf8 ?? isUtf8Locale();

  const dim = tty ? "\x1b[2m" : "";
  const acc = tty ? "\x1b[1m\x1b[38;5;39m" : ""; // bold + the install.sh blue
  const rst = tty ? "\x1b[0m" : "";
  const [tl, tr, bl, br, hr, vr] = utf8
    ? ["╭", "╮", "╰", "╯", "─", "│"]
    : ["+", "+", "+", "+", "-", "|"];

  const rows: { label: string; value: string; accent: boolean }[] = [
    { label: "Pairing code", value: o.userCode, accent: true },
  ];
  if (o.approveHost) rows.push({ label: "Workbench", value: o.approveHost, accent: false });

  const labelW = Math.max(...rows.map((r) => r.label.length));
  const valueW = Math.max(...rows.map((r) => r.value.length));
  // 3-space pad, label, 3-space gap, value, 3-space pad — mirrored by the
  // installer's draw_code_card so both surfaces render the same card.
  const inner = 3 + labelW + 3 + valueW + 3;

  const edge = (l: string, r: string) => `  ${dim}${l}${hr.repeat(inner)}${r}${rst}`;
  const gap = `  ${dim}${vr}${rst}${" ".repeat(inner)}${dim}${vr}${rst}`;
  const row = (r: (typeof rows)[number]) =>
    `  ${dim}${vr}${rst}   ${dim}${r.label.padEnd(labelW)}${rst}   ` +
    (r.accent ? `${acc}${r.value.padEnd(valueW)}${rst}` : r.value.padEnd(valueW)) +
    `   ${dim}${vr}${rst}`;

  return [edge(tl, tr), gap, ...rows.map(row), gap, edge(bl, br)];
}
