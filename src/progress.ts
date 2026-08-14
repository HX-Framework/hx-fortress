// Terminal download progress bar for `hx-fortress update`, matching the look of
// the `curl … | sh` installer: a dim label, a blue block-glyph bar, and a
// percent, redrawn in place as bytes arrive — Downloading → Unpacking → Verifying → 100%.
//
// Like install.sh, we only animate when stderr is a real TTY. Piped or
// redirected runs get plain one-line breadcrumbs instead. Everything goes to
// stderr so whatever the caller reads off stdout stays clean.

const BAR_WIDTH = 24;

export class ProgressBar {
  private readonly out: NodeJS.WriteStream;
  private readonly tty: boolean;
  private readonly glyphFull: string;
  private readonly glyphEmpty: string;
  private readonly esc: string;
  private readonly cr: string;
  private readonly clr: string;
  private readonly dim: string;
  private readonly acc: string;
  private readonly rst: string;
  private cursorHidden = false;
  private lastKey = "";

  constructor(out: NodeJS.WriteStream = process.stderr) {
    this.out = out;
    this.tty = Boolean(out.isTTY);

    const locale = process.env.LC_ALL ?? process.env.LC_CTYPE ?? process.env.LANG ?? "";
    const utf8 = /utf-?8/i.test(locale);
    this.glyphFull = utf8 ? "█" : "#";
    this.glyphEmpty = utf8 ? "░" : "-";

    if (this.tty) {
      this.esc = "\x1b";
      this.cr = "\r";
      this.clr = "\x1b[K";
      this.dim = "\x1b[2m";
      this.acc = "\x1b[38;5;39m";
      this.rst = "\x1b[0m";
    } else {
      this.esc = this.cr = this.clr = this.dim = this.acc = this.rst = "";
    }
  }

  get isTTY(): boolean {
    return this.tty;
  }

  status(msg: string): void {
    if (this.tty) return;
    this.out.write(`  ${msg}\n`);
  }

  draw(pct: number, label: string): void {
    if (!this.tty) return;
    const p = clampPct(pct);
    const key = `${label}:${p}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const filled = Math.floor((p * BAR_WIDTH) / 100);
    const bar = this.glyphFull.repeat(filled) + this.glyphEmpty.repeat(BAR_WIDTH - filled);
    this.out.write(
      `${this.cr}  ${this.dim}${label.padEnd(11)}${this.rst} ` +
        `${this.acc}${bar}${this.rst} ${String(p).padStart(3, " ")}%${this.clr}`,
    );
  }

  pulse(label: string, frame: number): void {
    if (!this.tty) return;
    this.lastKey = "";
    const win = 5;
    const pos = ((frame % BAR_WIDTH) + BAR_WIDTH) % BAR_WIDTH;
    let bar = "";
    for (let i = 0; i < BAR_WIDTH; i++) {
      const rel = (i - pos + BAR_WIDTH) % BAR_WIDTH;
      bar += rel < win ? this.glyphFull : this.glyphEmpty;
    }
    this.out.write(
      `${this.cr}  ${this.dim}${label.padEnd(11)}${this.rst} ${this.acc}${bar}${this.rst}${this.clr}`,
    );
  }

  clearLine(): void {
    if (!this.tty) return;
    this.lastKey = "";
    this.out.write(`${this.cr}${this.clr}`);
  }

  end(): void {
    if (this.tty) this.out.write("\n");
    this.lastKey = "";
  }

  hideCursor(): void {
    if (this.tty && !this.cursorHidden) {
      this.out.write(`${this.esc}[?25l`);
      this.cursorHidden = true;
    }
  }

  showCursor(): void {
    if (this.tty && this.cursorHidden) {
      this.out.write(`${this.esc}[?25h`);
      this.cursorHidden = false;
    }
  }
}

function clampPct(pct: number): number {
  if (!Number.isFinite(pct) || pct < 0) return 0;
  if (pct > 100) return 100;
  return Math.floor(pct);
}
