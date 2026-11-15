// The QR encoder that draws the address of a new second step, held to
// published values part by part, and read back by a decoder written here,
// apart from the encoder: its own map of the fixed modules, its own reading
// order, its own field arithmetic, and Reed-Solomon checked by syndromes
// rather than by dividing again.

import { describe, expect, test } from "bun:test";

import { accountLabel, OTPAUTH_MAX_BYTES, otpauthUri } from "../src/ui/totp";
import { MAX_EMAIL_LOGIN_LENGTH } from "../src/ui/users";
import {
  byteCapacity,
  encodeQr,
  formatBits,
  qrPath,
  QUIET_ZONE,
  rsEncode,
  versionBits,
  VERSIONS,
  type QrMatrix,
} from "../ui/src/qr";

/** The longest login there is: an email address of 254 characters, 64 before
 *  the "@" and a host of 189. */
const LONGEST_LOGIN = `${"m".repeat(64)}@${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(61)}`;

// ── published values ─────────────────────────────────────────────────────────

describe("Reed-Solomon", () => {
  test("the error correction of a published block: HELLO WORLD at 1-M", () => {
    // The worked example of the thonky.com QR tutorial: the 16 data codewords
    // of "HELLO WORLD" (alphanumeric mode) at version 1, level M.
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(rsEncode(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  test("the error correction of a published block: 01234567 at 1-M", () => {
    // ISO/IEC 18004, the encoding example of Annex I (numeric mode, 1-M).
    const data = [16, 32, 12, 86, 97, 128, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17];
    expect(rsEncode(data, 10)).toEqual([165, 36, 212, 193, 237, 54, 199, 135, 44, 85]);
  });
});

describe("format and version information", () => {
  test("the 15 format bits for level M and each mask", () => {
    // ISO/IEC 18004 Table C.1, the eight rows of level M.
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(formatBits)).toEqual([
      0b101010000010010, 0b101000100100101, 0b101111001111100, 0b101101101001011, 0b100010111111001,
      0b100000011001110, 0b100111110010111, 0b100101010100000,
    ]);
  });

  test("the 18 version bits for versions 7 to 10", () => {
    // ISO/IEC 18004 Table D.1.
    expect([7, 8, 9, 10].map(versionBits)).toEqual([0x07c94, 0x085bc, 0x09a99, 0x0a4d3]);
  });
});

describe("versions", () => {
  test("each holds its published byte count at level M, and a byte more moves up", () => {
    const published = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
    published.forEach((bytes, i) => {
      const version = i + 1;
      expect([version, byteCapacity(version)]).toEqual([version, bytes]);
      expect(encodeQr("x".repeat(bytes)).version).toBe(version);
      if (version < 10) expect(encodeQr("x".repeat(bytes + 1)).version).toBe(version + 1);
    });
    expect(() => encodeQr("x".repeat(214))).toThrow(RangeError);
  });

  test("every block structure adds up to the version's codewords", () => {
    const total = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
    for (let version = 1; version <= 10; version += 1) {
      const spec = VERSIONS[version]!;
      const codewords = spec.blocks.reduce((sum, [count, data]) => sum + count * (data + spec.ec), 0);
      expect([version, codewords]).toEqual([version, total[version - 1]]);
    }
  });

  test("the size and the finder patterns of each version", () => {
    for (let version = 1; version <= 10; version += 1) {
      const text = "x".repeat(byteCapacity(version));
      const m = encodeQr(text);
      expect(m.size).toBe(17 + 4 * version);
      expect(m.dark).toHaveLength(m.size);
      for (const line of m.dark) expect(line).toHaveLength(m.size);
      for (const [top, left] of [
        [0, 0],
        [0, m.size - 7],
        [m.size - 7, 0],
      ] as const) {
        for (let r = 0; r < 7; r += 1) {
          for (let c = 0; c < 7; c += 1) {
            const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
            expect([version, top + r, left + c, m.dark[top + r]![left + c]]).toEqual([
              version,
              top + r,
              left + c,
              ring !== 2,
            ]);
          }
        }
      }
      // The separators are light.
      for (let i = 0; i < 8; i += 1) {
        expect(m.dark[7]![i]).toBe(false);
        expect(m.dark[i]![7]).toBe(false);
        expect(m.dark[7]![m.size - 1 - i]).toBe(false);
        expect(m.dark[i]![m.size - 8]).toBe(false);
        expect(m.dark[m.size - 8]![i]).toBe(false);
        expect(m.dark[m.size - 1 - i]![7]).toBe(false);
      }
      // The timing patterns alternate between the finders, dark on even.
      for (let i = 8; i < m.size - 8; i += 1) {
        expect(m.dark[6]![i]).toBe(i % 2 === 0);
        expect(m.dark[i]![6]).toBe(i % 2 === 0);
      }
      // The module that is always dark.
      expect(m.dark[4 * version + 9]![8]).toBe(true);
    }
  });

  test("both copies of the format bits name the mask the code uses", () => {
    for (let version = 1; version <= 10; version += 1) {
      const m = encodeQr("y".repeat(byteCapacity(version) - 1));
      expect([version, readFormat(m, 1)]).toEqual([version, formatBits(m.mask)]);
      expect([version, readFormat(m, 2)]).toEqual([version, formatBits(m.mask)]);
    }
  });

  test("both blocks of the version bits, from version 7", () => {
    for (let version = 7; version <= 10; version += 1) {
      const m = encodeQr("z".repeat(byteCapacity(version)));
      expect(m.version).toBe(version);
      expect(readVersion(m, "top-right")).toBe(versionBits(version));
      expect(readVersion(m, "bottom-left")).toBe(versionBits(version));
    }
  });
});

describe("the drawn code", () => {
  test("reads back to its text, for every version", () => {
    const texts = [
      "a",
      "HX Fortress",
      "Grüße aus Göteborg, 東京 and back",
      otpauthUri("ada", "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"),
      otpauthUri("marta.lindqvist", "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"),
      // The longest login of the name kind, and the longest login there is: an
      // email address of 254 characters, shortened in the label.
      otpauthUri(`m${"a".repeat(63)}`, "MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U"),
      otpauthUri(LONGEST_LOGIN, "MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U"),
    ];
    for (let length = 1; length <= 213; length += 7) texts.push("0123456789abcdef".repeat(14).slice(0, length));
    const versions = new Set<number>();
    for (const text of texts) {
      const m = encodeQr(text);
      versions.add(m.version);
      expect(decode(m)).toBe(text);
    }
    expect([...versions].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test("the address of any login fits in version 10: the label is shortened, the key and the issuer are not", () => {
    // The two numbers are one: what the address builder allows is what the
    // largest code this encoder draws holds.
    expect(OTPAUTH_MAX_BYTES).toBe(byteCapacity(10));
    // Put together at run time, so that nothing key-shaped sits in the repository.
    const secret = ["MFRGGZDF", "MZTWQ2LK", "NNWG23TP", "OBYXE43U"].join("");
    for (let length = 60; length <= MAX_EMAIL_LOGIN_LENGTH; length += 1) {
      // Addresses of every length, with an "@" and a "+" that encode to three bytes each.
      const login = `m+${"a".repeat(Math.max(1, length - 2 - "@northstar.example".length))}@northstar.example`.slice(-length);
      const uri = otpauthUri(login, secret);
      expect([length, new TextEncoder().encode(uri).length <= OTPAUTH_MAX_BYTES]).toEqual([length, true]);
    }
    const uri = otpauthUri(LONGEST_LOGIN, secret);
    expect(new TextEncoder().encode(uri).length).toBeLessThanOrEqual(byteCapacity(10));
    expect(encodeQr(uri).version).toBe(10);
    expect(decode(encodeQr(uri))).toBe(uri);
    const parsed = new URL(uri);
    expect(parsed.searchParams.get("secret")).toBe(secret);
    expect(parsed.searchParams.get("issuer")).toBe("HX Fortress");
    const label = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    expect(label.startsWith(`HX Fortress:${LONGEST_LOGIN.slice(0, 40)}`)).toBe(true);
    expect(label.endsWith("…")).toBe(true);
    // A login that fits is not touched.
    expect(otpauthUri("marta.lindqvist@northstar.example", secret)).toContain(
      "HX%20Fortress:marta.lindqvist%40northstar.example?",
    );
    // A cut never splits the encoding of a character: four bytes would end
    // inside "%2B", so the "+" goes whole.
    expect(accountLabel("aaa+bbbbbbbb", 13)).toBe("aaa%E2%80%A6");
    expect(decodeURIComponent(accountLabel("a+b+c+d+e", 13))).toBe("a+…");
    // Nothing is ever longer than the room it was given.
    for (let room = 0; room <= 20; room += 1) {
      expect([room, accountLabel("a+b+c+d+e+f+g", room).length <= room]).toEqual([room, true]);
    }
  });

  test("the same text always gives the same matrix", () => {
    const uri = otpauthUri("marta.lindqvist", "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
    const first = encodeQr(uri);
    for (let i = 0; i < 5; i += 1) {
      const again = encodeQr(uri);
      expect(again).toEqual(first);
      expect(qrPath(again)).toBe(qrPath(first));
    }
    expect(encodeQr(`${uri}x`).dark).not.toEqual(first.dark);
  });

  test("the path draws exactly the dark modules, inside a quiet zone", () => {
    const m = encodeQr(otpauthUri("ada", "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"));
    const drawn = new Set<string>();
    for (const [, x, y, w] of qrPath(m).matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      for (let i = 0; i < Number(w); i += 1) drawn.add(`${Number(y) - QUIET_ZONE},${Number(x) + i - QUIET_ZONE}`);
    }
    const dark = new Set<string>();
    m.dark.forEach((line, r) => line.forEach((on, c) => on && dark.add(`${r},${c}`)));
    expect(drawn).toEqual(dark);
  });
});

// ── a decoder, written apart from the encoder ────────────────────────────────

/** GF(256) over 0x11D, by repeated doubling: a different route from the
 *  encoder's log tables. */
function gfMul(a: number, b: number): number {
  let product = 0;
  let x = a;
  let y = b;
  while (y > 0) {
    if (y & 1) product ^= x;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
    y >>= 1;
  }
  return product;
}

function gfPow2(exponent: number): number {
  let value = 1;
  for (let i = 0; i < exponent; i += 1) value = gfMul(value, 2);
  return value;
}

/** A block is a codeword when it vanishes at 2^0 .. 2^(ec-1). */
function syndromesAreZero(block: readonly number[], ec: number): boolean {
  for (let i = 0; i < ec; i += 1) {
    const root = gfPow2(i);
    let value = 0;
    for (const coefficient of block) value = gfMul(value, root) ^ coefficient;
    if (value !== 0) return false;
  }
  return true;
}

function alignmentCentres(version: number): Array<[number, number]> {
  const positions = VERSIONS[version]!.align;
  const centres: Array<[number, number]> = [];
  const last = positions.length - 1;
  positions.forEach((r, i) =>
    positions.forEach((c, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      centres.push([r, c]);
    }),
  );
  return centres;
}

function isFixed(version: number, size: number, row: number, col: number): boolean {
  if (row === 6 || col === 6) return true;
  if (row <= 8 && col <= 8) return true;
  if (row <= 8 && col >= size - 8) return true;
  if (row >= size - 8 && col <= 8) return true;
  if (alignmentCentres(version).some(([r, c]) => Math.abs(row - r) <= 2 && Math.abs(col - c) <= 2)) return true;
  if (version >= 7) {
    if (row <= 5 && col >= size - 11 && col <= size - 9) return true;
    if (col <= 5 && row >= size - 11 && row <= size - 9) return true;
  }
  return false;
}

function readFormat(m: QrMatrix, copy: 1 | 2): number {
  const cells: Array<[number, number]> =
    copy === 1
      ? [
          [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8],
          [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
        ]
      : [
          ...Array.from({ length: 8 }, (_, i) => [8, m.size - 1 - i] as [number, number]),
          ...Array.from({ length: 7 }, (_, i) => [m.size - 7 + i, 8] as [number, number]),
        ];
  return cells.reduce((bits, [r, c], i) => bits | ((m.dark[r]![c] ? 1 : 0) << i), 0);
}

function readVersion(m: QrMatrix, block: "top-right" | "bottom-left"): number {
  let bits = 0;
  for (let i = 0; i < 18; i += 1) {
    const a = m.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    const dark = block === "top-right" ? m.dark[b]![a] : m.dark[a]![b];
    if (dark) bits |= 1 << i;
  }
  return bits;
}

function decode(m: QrMatrix): string {
  const version = (m.size - 17) / 4;
  const spec = VERSIONS[version]!;
  // Which mask: the format bits, matched against level M's eight.
  const format = readFormat(m, 1);
  const mask = [0, 1, 2, 3, 4, 5, 6, 7].find((candidate) => formatBits(candidate) === format);
  if (mask === undefined) throw new Error("format bits name no mask of level M");
  const flips: Array<(r: number, c: number) => boolean> = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (_r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];
  const flip = flips[mask]!;
  // The reading order: column pairs from the right, up, then down, then up.
  const bits: number[] = [];
  let upward = true;
  for (let right = m.size - 1; right > 0; right -= 2) {
    if (right === 6) right -= 1;
    for (let k = 0; k < m.size; k += 1) {
      const row = upward ? m.size - 1 - k : k;
      for (const col of [right, right - 1]) {
        if (isFixed(version, m.size, row, col)) continue;
        bits.push((m.dark[row]![col] ? 1 : 0) ^ (flip(row, col) ? 1 : 0));
      }
    }
    upward = !upward;
  }
  const total = spec.blocks.reduce((sum, [count, data]) => sum + count * (data + spec.ec), 0);
  const codewords: number[] = [];
  for (let i = 0; i < total; i += 1) codewords.push(bits.slice(i * 8, i * 8 + 8).reduce((v, b) => (v << 1) | b, 0));
  // Undo the interleaving.
  const lengths: number[] = [];
  for (const [count, data] of spec.blocks) for (let c = 0; c < count; c += 1) lengths.push(data);
  const blocks = lengths.map(() => [] as number[]);
  let at = 0;
  for (let i = 0; i < Math.max(...lengths); i += 1) {
    lengths.forEach((length, b) => {
      if (i < length) blocks[b]!.push(codewords[at++]!);
    });
  }
  for (let i = 0; i < spec.ec; i += 1) for (const block of blocks) block.push(codewords[at++]!);
  for (const block of blocks) expect(syndromesAreZero(block, spec.ec)).toBe(true);
  const data = blocks.flatMap((block, b) => block.slice(0, lengths[b]));
  // Byte mode: 0100, the count, the bytes.
  const stream = data.flatMap((byte) => Array.from({ length: 8 }, (_, i) => (byte >> (7 - i)) & 1));
  const take = (from: number, length: number): number => stream.slice(from, from + length).reduce((v, b) => (v << 1) | b, 0);
  expect(take(0, 4)).toBe(0b0100);
  const countLength = version <= 9 ? 8 : 16;
  const count = take(4, countLength);
  const bytes = Array.from({ length: count }, (_, i) => take(4 + countLength + i * 8, 8));
  return new TextDecoder().decode(new Uint8Array(bytes));
}
