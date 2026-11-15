// A QR code encoder for one job: drawing the otpauth:// address of a new second
// step, so an authenticator app on a phone can read it off the screen.
//
// It does as little as that job needs and nothing else: byte mode (the
// address as UTF-8), error correction level M, versions 1 to 10, which hold up
// to 213 bytes. The console never makes a longer address: a login too long to
// fit (an email address can be 254 characters) is shortened in the label the
// app shows, and the key and the issuer stay whole (OTPAUTH_MAX_BYTES in
// src/ui/totp.ts). A longer text throws, and the page then shows the key as
// text alone. No dependency: the console's bundle draws the code in the
// browser, so the secret it carries never leaves the page to be drawn
// somewhere else.
//
// The layout follows ISO/IEC 18004. Each part is exported so the tests can
// hold it against published values: the Reed-Solomon codewords of a known
// block, the format and version bits, and the finder patterns of a version.

/** How a code is drawn: `dark[row][col]` is true for a dark module. */
export interface QrMatrix {
  version: number;
  size: number;
  mask: number;
  dark: boolean[][];
}

interface VersionSpec {
  /** Error correction codewords in each block. */
  ec: number;
  /** Groups of blocks: how many, and the data codewords in each. */
  blocks: ReadonlyArray<readonly [count: number, data: number]>;
  /** Row and column centres of the alignment patterns. */
  align: readonly number[];
}

/** Level M, versions 1 to 10 (ISO/IEC 18004 Table 9 and Annex E). */
export const VERSIONS: Readonly<Record<number, VersionSpec>> = {
  1: { ec: 10, blocks: [[1, 16]], align: [] },
  2: { ec: 16, blocks: [[1, 28]], align: [6, 18] },
  3: { ec: 26, blocks: [[1, 44]], align: [6, 22] },
  4: { ec: 18, blocks: [[2, 32]], align: [6, 26] },
  5: { ec: 24, blocks: [[2, 43]], align: [6, 30] },
  6: { ec: 16, blocks: [[4, 27]], align: [6, 34] },
  7: { ec: 18, blocks: [[4, 31]], align: [6, 22, 38] },
  8: { ec: 22, blocks: [[2, 38], [2, 39]], align: [6, 24, 42] },
  9: { ec: 22, blocks: [[3, 36], [2, 37]], align: [6, 26, 46] },
  10: { ec: 26, blocks: [[4, 43], [1, 44]], align: [6, 28, 50] },
};

export const MAX_VERSION = 10;

function specOf(version: number): VersionSpec {
  const spec = VERSIONS[version];
  if (!spec) throw new RangeError(`version ${version} is outside 1 to ${MAX_VERSION}`);
  return spec;
}

/** Data codewords a version holds at level M. */
export function dataCapacity(version: number): number {
  return specOf(version).blocks.reduce((sum, [count, data]) => sum + count * data, 0);
}

/** Bits of the byte-mode character count: 8 up to version 9, then 16. */
function countBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

/** The most bytes a version holds in byte mode at level M. */
export function byteCapacity(version: number): number {
  return Math.floor((dataCapacity(version) * 8 - 4 - countBits(version)) / 8);
}

// ── GF(256) and Reed-Solomon ────────────────────────────────────────────────

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  // The field QR codes use: x^8 + x^4 + x^3 + x^2 + 1 (0x11D), generator 2.
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255] as number;
}

function mul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : (EXP[(LOG[a] as number) + (LOG[b] as number)] as number);
}

/** The generator polynomial of `degree` error correction codewords, highest
 *  power first: the product of (x - 2^i) for i from 0 to degree - 1. */
function generator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      const term = poly[j] as number;
      next[j] = (next[j] as number) ^ term;
      next[j + 1] = (next[j + 1] as number) ^ mul(term, EXP[i] as number);
    }
    poly = next;
  }
  return poly;
}

/** The error correction codewords of one block: the remainder of the data,
 *  shifted up by `degree`, divided by the generator polynomial. */
export function rsEncode(data: readonly number[], degree: number): number[] {
  const gen = generator(degree);
  const rem = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ (rem[0] as number);
    rem.shift();
    rem.push(0);
    for (let i = 0; i < degree; i += 1) rem[i] = (rem[i] as number) ^ mul(gen[i + 1] as number, factor);
  }
  return rem;
}

// ── format and version information ──────────────────────────────────────────

/** Level M's two bits in the format information. */
const LEVEL_M_BITS = 0b00;

/** The 15 format bits for level M and a mask: BCH(15,5), then XOR 0x5412. */
export function formatBits(mask: number): number {
  const data = (LEVEL_M_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

/** The 18 version bits, for version 7 and up: BCH(18,6). */
export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | (rem & 0xfff);
}

const bit = (value: number, index: number): boolean => ((value >>> index) & 1) !== 0;

// ── the data ────────────────────────────────────────────────────────────────

/** The data codewords of `bytes` in byte mode at `version`: mode, count, the
 *  bytes, a terminator, then the pad bytes 0xEC and 0x11 in turn. */
export function dataCodewords(bytes: Uint8Array, version: number): number[] {
  const capacity = dataCapacity(version);
  if (bytes.length > byteCapacity(version)) throw new RangeError("too long for this version");
  const bits: number[] = [];
  const put = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, countBits(version));
  for (const byte of bytes) put(byte, 8);
  put(0, Math.min(4, capacity * 8 - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    out.push(bits.slice(i, i + 8).reduce((byte, b) => (byte << 1) | b, 0));
  }
  for (let pad = 0xec; out.length < capacity; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/** Split the data into its blocks, add each block's error correction, and
 *  interleave: the first codeword of every block, then the second, and so on,
 *  then the error correction codewords the same way. */
export function finalCodewords(data: readonly number[], version: number): number[] {
  const spec = specOf(version);
  const blocks: number[][] = [];
  let at = 0;
  for (const [count, length] of spec.blocks) {
    for (let c = 0; c < count; c += 1) {
      blocks.push(data.slice(at, at + length));
      at += length;
    }
  }
  const ecs = blocks.map((block) => rsEncode(block, spec.ec));
  const out: number[] = [];
  const longest = Math.max(...blocks.map((block) => block.length));
  for (let i = 0; i < longest; i += 1) {
    for (const block of blocks) if (i < block.length) out.push(block[i] as number);
  }
  for (let i = 0; i < spec.ec; i += 1) for (const ec of ecs) out.push(ec[i] as number);
  return out;
}

// ── the matrix ──────────────────────────────────────────────────────────────

class Grid {
  readonly dark: boolean[][];
  /** Modules that belong to a pattern or to the format and version areas:
   *  never data, never masked. */
  readonly fixed: boolean[][];

  constructor(readonly size: number) {
    this.dark = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }

  set(row: number, col: number, dark: boolean): void {
    (this.dark[row] as boolean[])[col] = dark;
    (this.fixed[row] as boolean[])[col] = true;
  }

  isDark(row: number, col: number): boolean {
    return (this.dark[row] as boolean[])[col] as boolean;
  }

  isFixed(row: number, col: number): boolean {
    return (this.fixed[row] as boolean[])[col] as boolean;
  }
}

function drawFinder(grid: Grid, row: number, col: number): void {
  // The 7x7 pattern and the light separator around it.
  for (let dr = -4; dr <= 4; dr += 1) {
    for (let dc = -4; dc <= 4; dc += 1) {
      const r = row + dr;
      const c = col + dc;
      if (r < 0 || c < 0 || r >= grid.size || c >= grid.size) continue;
      const ring = Math.max(Math.abs(dr), Math.abs(dc));
      grid.set(r, c, ring !== 2 && ring !== 4);
    }
  }
}

function drawAlignment(grid: Grid, row: number, col: number): void {
  for (let dr = -2; dr <= 2; dr += 1) {
    for (let dc = -2; dc <= 2; dc += 1) {
      grid.set(row + dr, col + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
  }
}

function drawFormat(grid: Grid, mask: number): void {
  const bits = formatBits(mask);
  const last = grid.size - 1;
  // Around the top-left finder: down column 8, then along row 8 to the left.
  for (let i = 0; i <= 5; i += 1) grid.set(i, 8, bit(bits, i));
  grid.set(7, 8, bit(bits, 6));
  grid.set(8, 8, bit(bits, 7));
  grid.set(8, 7, bit(bits, 8));
  for (let i = 9; i < 15; i += 1) grid.set(8, 14 - i, bit(bits, i));
  // The second copy: along row 8 under the top-right finder, and up column 8
  // beside the bottom-left one.
  for (let i = 0; i < 8; i += 1) grid.set(8, last - i, bit(bits, i));
  for (let i = 8; i < 15; i += 1) grid.set(grid.size - 15 + i, 8, bit(bits, i));
  // The module that is always dark.
  grid.set(grid.size - 8, 8, true);
}

function drawVersion(grid: Grid, version: number): void {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i += 1) {
    const a = grid.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    grid.set(b, a, bit(bits, i));
    grid.set(a, b, bit(bits, i));
  }
}

function drawFunctionPatterns(grid: Grid, version: number): void {
  for (let i = 0; i < grid.size; i += 1) {
    grid.set(6, i, i % 2 === 0);
    grid.set(i, 6, i % 2 === 0);
  }
  drawFinder(grid, 3, 3);
  drawFinder(grid, 3, grid.size - 4);
  drawFinder(grid, grid.size - 4, 3);
  const align = specOf(version).align;
  const lastIndex = align.length - 1;
  align.forEach((row, i) => {
    align.forEach((col, j) => {
      // Not over the three finders.
      if ((i === 0 && j === 0) || (i === 0 && j === lastIndex) || (i === lastIndex && j === 0)) return;
      drawAlignment(grid, row, col);
    });
  });
  // Reserved now, drawn for real once the mask is chosen.
  drawFormat(grid, 0);
  drawVersion(grid, version);
}

/** Place the codewords, most significant bit first, in the zigzag the
 *  standard reads them in: two columns at a time from the right, up then down,
 *  skipping the vertical timing column. What is left over stays light. */
function drawCodewords(grid: Grid, codewords: readonly number[]): void {
  const total = codewords.length * 8;
  let i = 0;
  for (let right = grid.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let step = 0; step < grid.size; step += 1) {
      const row = upward ? grid.size - 1 - step : step;
      for (let j = 0; j < 2; j += 1) {
        const col = right - j;
        if (grid.isFixed(row, col) || i >= total) continue;
        (grid.dark[row] as boolean[])[col] = bit(codewords[i >>> 3] as number, 7 - (i & 7));
        i += 1;
      }
    }
  }
}

/** Whether mask `mask` inverts the module at (row, col). */
export function maskInverts(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      throw new RangeError(`mask ${mask} is outside 0 to 7`);
  }
}

function applyMask(grid: Grid, mask: number): void {
  for (let row = 0; row < grid.size; row += 1) {
    for (let col = 0; col < grid.size; col += 1) {
      if (!grid.isFixed(row, col) && maskInverts(mask, row, col)) {
        (grid.dark[row] as boolean[])[col] = !grid.isDark(row, col);
      }
    }
  }
}

// ── choosing the mask ───────────────────────────────────────────────────────

const PENALTY_RUN = 3;
const PENALTY_BOX = 3;
const PENALTY_FINDER = 40;
const PENALTY_BALANCE = 10;

/** The standard's four penalty rules, over one line of modules at a time for
 *  the first and third. A light border is assumed around the symbol. */
function linePenalty(line: readonly boolean[], size: number): number {
  let score = 0;
  let runColor = false;
  let runLength = 0;
  const history = [0, 0, 0, 0, 0, 0, 0];
  const pushRun = (length: number): void => {
    const first = history[0] === 0 ? length + size : length;
    history.pop();
    history.unshift(first);
  };
  const finderLike = (): number => {
    const n = history[1] as number;
    const core =
      n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
    return (
      (core && (history[0] as number) >= n * 4 && (history[6] as number) >= n ? 1 : 0) +
      (core && (history[6] as number) >= n * 4 && (history[0] as number) >= n ? 1 : 0)
    );
  };
  for (const dark of line) {
    if (dark === runColor) {
      runLength += 1;
      if (runLength === 5) score += PENALTY_RUN;
      else if (runLength > 5) score += 1;
    } else {
      pushRun(runLength);
      if (!runColor) score += finderLike() * PENALTY_FINDER;
      runColor = dark;
      runLength = 1;
    }
  }
  // Close the last run against the light border.
  if (runColor) {
    pushRun(runLength);
    runLength = 0;
  }
  pushRun(runLength + size);
  score += finderLike() * PENALTY_FINDER;
  return score;
}

function penalty(grid: Grid): number {
  const { size } = grid;
  let score = 0;
  for (let row = 0; row < size; row += 1) score += linePenalty(grid.dark[row] as boolean[], size);
  for (let col = 0; col < size; col += 1) {
    score += linePenalty(
      grid.dark.map((line) => line[col] as boolean),
      size,
    );
  }
  let dark = 0;
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const here = grid.isDark(row, col);
      if (here) dark += 1;
      if (
        row < size - 1 &&
        col < size - 1 &&
        here === grid.isDark(row, col + 1) &&
        here === grid.isDark(row + 1, col) &&
        here === grid.isDark(row + 1, col + 1)
      ) {
        score += PENALTY_BOX;
      }
    }
  }
  const total = size * size;
  // The smallest k with (45 - 5k)% <= dark share <= (55 + 5k)%.
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  return score + Math.max(0, k) * PENALTY_BALANCE;
}

// ── the code ────────────────────────────────────────────────────────────────

/** The smallest version that holds `length` bytes, or null when none does. */
export function versionFor(length: number): number | null {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    if (length <= byteCapacity(version)) return version;
  }
  return null;
}

/**
 * Encode `text` as UTF-8 in byte mode at level M, in the smallest version that
 * holds it, with the mask the standard's penalty rules prefer. The same text
 * always gives the same matrix.
 */
export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const version = versionFor(bytes.length);
  if (version === null) {
    throw new RangeError(`${bytes.length} bytes is more than a version ${MAX_VERSION} code holds at level M`);
  }
  const codewords = finalCodewords(dataCodewords(bytes, version), version);
  const grid = new Grid(17 + 4 * version);
  drawFunctionPatterns(grid, version);
  drawCodewords(grid, codewords);

  let best = 0;
  let lowest = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    applyMask(grid, mask);
    drawFormat(grid, mask);
    const score = penalty(grid);
    if (score < lowest) {
      lowest = score;
      best = mask;
    }
    applyMask(grid, mask);
  }
  applyMask(grid, best);
  drawFormat(grid, best);
  return { version, size: grid.size, mask: best, dark: grid.dark };
}

/** The quiet zone the standard asks for around a code, in modules. */
export const QUIET_ZONE = 4;

/**
 * The dark modules as one SVG path, in a square of `size + 2 * QUIET_ZONE`
 * units: a run of dark modules in a row is one rectangle.
 */
export function qrPath(matrix: QrMatrix): string {
  const parts: string[] = [];
  matrix.dark.forEach((line, row) => {
    let col = 0;
    while (col < matrix.size) {
      if (!line[col]) {
        col += 1;
        continue;
      }
      const start = col;
      while (col < matrix.size && line[col]) col += 1;
      parts.push(`M${start + QUIET_ZONE} ${row + QUIET_ZONE}h${col - start}v1h-${col - start}z`);
    }
  });
  return parts.join("");
}
