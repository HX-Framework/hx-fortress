// Which code page a dBase table's text is in (dbf.ts). A table's header names one, and mostly its
// text is in it. But FoxPro names the code page of the computer a table was made on, and the text
// is in the code page of the program that typed it: a US town's tables whose headers name
// Windows-1251 (Cyrillic) hold English text in Windows-1252, and read in Windows-1251 "Peña" is
// "Peсa", with a Cyrillic "с".
//
// The code pages LOAD reads agree on ASCII, so only the words that hold other bytes tell them
// apart. Each such word is read in every code page, and a reading is wrong where nobody writes a
// word so: letters of two alphabets in one word ("Peсa"), a symbol among its letters ("Pe±a",
// "CafÃ©"), a control character, three or more accented letters and hardly a plain one ("Ïðèâåò",
// Russian read as Windows-1252), or, in UTF-8, bytes that are not UTF-8. The header's code page
// stands unless another reads at most half as many of the words wrong. Of the code pages that read
// the fewest wrong, the first in `PREFERRED` wins: Windows-1252 before the others, as a US town's
// Windows programs write it.

import { CODE_PAGE_HIGH } from "./codepages.js";
import { UTF8_CODE_PAGE } from "./jobs.js";
import { decode, encodingOfPage, validUtf8 } from "./text.js";

/** The code pages tried after the header's, in the order that settles a tie. */
export const PREFERRED: readonly number[] = [UTF8_CODE_PAGE, 1252, 437, 850, 1250, 1251, 866, 852, 1253, 737, 1254, 857, 1257, 1255, 1256, 874, 860, 861, 863, 865, 10000, 10029, 10007, 10006];

// What a character is, to judge a word: the alphabet of a letter, or what else it is.
const ASCII_LETTER = 1;
const DIGIT = 2;
/** A Latin letter beyond A to Z: é, ñ, ß, ł. */
const LATIN = 3;
const CYRILLIC = 4;
const GREEK = 5;
const HEBREW = 6;
const ARABIC = 7;
const THAI = 8;
/** Fine anywhere in a word: an apostrophe, a middle dot, a dash, a no-break space, a direction mark. */
const JOIN = 9;
/** Fine at a word's start or end only: quotation marks, ¿ and ¡, an ellipsis, Arabic's comma. */
const EDGE = 10;
const SYMBOL = 11;
/** In no text: a C1 control character (a byte the code page leaves undefined), or bytes UTF-8 cannot read. */
const CONTROL = 12;

function kindOf(cp: number): number {
  if (cp < 0x80) {
    if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) return ASCII_LETTER;
    return cp >= 0x30 && cp <= 0x39 ? DIGIT : SYMBOL;
  }
  if (cp <= 0x9f || cp === 0xfffd) return CONTROL;
  if (cp === 0xa0 || cp === 0xb4 || cp === 0xb7 || cp === 0x2bc || cp === 0x2013 || cp === 0x2014 || cp === 0x2018 || cp === 0x2019 || (cp >= 0x200c && cp <= 0x200f)) return JOIN;
  if (cp === 0xa1 || cp === 0xab || cp === 0xbb || cp === 0xbf || cp === 0x201a || cp === 0x201c || cp === 0x201d || cp === 0x201e || cp === 0x2026 || cp === 0x2039 || cp === 0x203a) return EDGE;
  if (cp === 0x60c || cp === 0x61b || cp === 0x61f) return EDGE;
  if (cp === 0xaa || cp === 0xba || (cp >= 0xc0 && cp <= 0x24f && cp !== 0xd7 && cp !== 0xf7) || (cp >= 0x1e00 && cp <= 0x1eff)) return LATIN;
  if ((cp >= 0x386 && cp <= 0x3ff && cp !== 0x387) || (cp >= 0x1f00 && cp <= 0x1fff)) return GREEK;
  if (cp >= 0x400 && cp <= 0x52f) return CYRILLIC;
  if (cp >= 0x591 && cp <= 0x5f4) return HEBREW;
  if (cp >= 0x610 && cp <= 0x6ff) return ARABIC;
  if ((cp >= 0xe01 && cp <= 0xe3a) || (cp >= 0xe40 && cp <= 0xe5b)) return THAI;
  return SYMBOL;
}

const ASCII_KINDS = Uint8Array.from({ length: 128 }, (_, b) => kindOf(b));
/** Each code page's kinds of character for the bytes 0x80 to 0xFF, made the first time it is asked for. */
const HIGH_KINDS = new Map<number, Uint8Array>();

function highKinds(page: number): Uint8Array {
  let kinds = HIGH_KINDS.get(page);
  if (!kinds) {
    // A code page with no table reads as Windows-1252, as decodeCodePage reads it.
    const high = CODE_PAGE_HIGH[page] ?? CODE_PAGE_HIGH[1252]!;
    kinds = Uint8Array.from({ length: 128 }, (_, i) => kindOf(high.charCodeAt(i)));
    HIGH_KINDS.set(page, kinds);
  }
  return kinds;
}

/** A word's characters, by kind, as a code page reads its bytes. */
function kindsIn(word: Uint8Array, page: number): number[] {
  if (page === UTF8_CODE_PAGE) {
    if (!validUtf8(word)) return [CONTROL];
    const kinds: number[] = [];
    for (const ch of decode(word, encodingOfPage(page))) kinds.push(kindOf(ch.codePointAt(0)!));
    return kinds;
  }
  const high = highKinds(page);
  const kinds = new Array<number>(word.byteLength);
  for (let i = 0; i < word.byteLength; i++) kinds[i] = word[i]! < 0x80 ? ASCII_KINDS[word[i]!]! : high[word[i]! - 0x80]!;
  return kinds;
}

/** Whether a word reads as nobody writes one: see the top of this file. */
function readsWrong(kinds: readonly number[]): boolean {
  let start = 0;
  let end = kinds.length;
  while (start < end && (kinds[start] === EDGE || kinds[start] === JOIN)) start++;
  while (end > start && (kinds[end - 1] === EDGE || kinds[end - 1] === JOIN)) end--;
  let alphabets = 0;
  let plain = 0;
  let accented = 0;
  let letters = 0;
  let symbol = false;
  for (let i = start; i < end; i++) {
    const k = kinds[i]!;
    if (k === CONTROL) return true;
    if (k === SYMBOL || k === EDGE) symbol = true;
    else if (k === ASCII_LETTER || k === LATIN) {
      alphabets |= 1 << LATIN;
      if (k === LATIN) accented++;
      else plain++;
      letters++;
    } else if (k >= CYRILLIC && k <= THAI) {
      alphabets |= 1 << k;
      letters++;
    }
  }
  if (alphabets & (alphabets - 1)) return true;
  if (symbol && letters > 0) return true;
  return (accented >= 3 && plain === 0) || (accented >= 4 && accented > 2 * plain);
}

/** Whether a code page reads a word's bytes as nobody writes a word. */
export const readsWrongIn = (word: Uint8Array, page: number): boolean => readsWrong(kindsIn(word, page));

/** One word of the text that holds a byte past ASCII, and a short stretch of text around it, to show. */
export interface SeenWord {
  word: Uint8Array;
  around: Uint8Array;
}

/** The longest run of letters judged as a word: a longer one is no word. */
const WORD_BYTES_MAX = 48;
/** The most of a value an example shows: a longer value shows its word alone. */
const AROUND_BYTES_MAX = 40;

const inWord = (b: number): boolean => b >= 0x80 || (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);

/** Adds the words of a value that hold a byte past ASCII, each once, until `into` holds `max`. Words end at ASCII punctuation and spaces. */
export function addWords(value: Uint8Array, into: Map<string, SeenWord>, max: number): void {
  let start = -1;
  let high = false;
  for (let i = 0; i <= value.byteLength && into.size < max; i++) {
    const b = i < value.byteLength ? value[i]! : 0x20;
    if (inWord(b)) {
      if (start < 0) start = i;
      if (b >= 0x80) high = true;
      continue;
    }
    if (start >= 0 && high && i - start <= WORD_BYTES_MAX) {
      const word = value.subarray(start, i);
      const key = String.fromCharCode.apply(null, word as unknown as number[]);
      if (!into.has(key)) {
        // The value without the spaces and NULs a dBase field is padded with.
        let around = value;
        while (around.byteLength && around[around.byteLength - 1]! <= 0x20) around = around.subarray(0, around.byteLength - 1);
        while (around.byteLength && around[0]! <= 0x20) around = around.subarray(1);
        into.set(key, { word: word.slice(), around: (around.byteLength <= AROUND_BYTES_MAX ? around : word).slice() });
      }
    }
    start = -1;
    high = false;
  }
}

/** What the words of a table's text say about its code page. */
export interface CodePageGuess {
  /** The code page to read the text in. */
  page: number;
  /** The words past ASCII it was told by, and how many of them the header's code page reads wrong. */
  words: number;
  wrongInNamed: number;
  /** Where `page` is not the header's: a stretch of text as `page` reads it, and as the header's code page does. */
  example: { read: string; named: string } | null;
}

/** The code page a table's text is in, from its words past ASCII and the code page its header names. */
export function guessCodePage(seen: ReadonlyMap<string, SeenWord>, named: number): CodePageGuess {
  const words = [...seen.values()];
  const wrongIn = (page: number): number => {
    let n = 0;
    for (const w of words) if (readsWrong(kindsIn(w.word, page))) n++;
    return n;
  };
  const wrongInNamed = wrongIn(named);
  const stays: CodePageGuess = { page: named, words: words.length, wrongInNamed, example: null };
  if (wrongInNamed === 0) return stays;
  let best = named;
  let fewest = wrongInNamed;
  for (const page of PREFERRED) {
    if (page === named) continue;
    const n = wrongIn(page);
    if (n < fewest) {
      best = page;
      fewest = n;
    }
  }
  if (best === named || fewest * 2 >= wrongInNamed) return stays;
  const shown = words.find((w) => readsWrong(kindsIn(w.word, named)) && !readsWrong(kindsIn(w.word, best)));
  // A control character the header's code page reads a byte as shows as the replacement character.
  const shownIn = (page: number): string => decode(shown!.around, encodingOfPage(page)).replace(/[\u0000-\u001f\u007f-\u009f]/g, "\ufffd");
  const example = shown ? { read: shownIn(best), named: shownIn(named) } : null;
  return { page: best, words: words.length, wrongInNamed, example };
}
