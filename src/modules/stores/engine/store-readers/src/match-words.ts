// How MATCH reads a value before it compares it (Stores, Part A, slice E): the same words for the
// same thing however a town typed it. "12 Elm Street", "12 ELM ST." and "12 elm st, Unit 4" all
// read as "12 ELM ST". The store's MATCH job (stores-gateway store/jobs/match.ts) runs three passes
// over a column's distinct values: the same text, the same words read this way, and for what is
// left, the reference rows that share the most telling words, which the api shows a model.
//
// Pure and synchronous, so it runs in a store's object and in tests alike.

import type { MatchKind } from "./jobs.js";

/** USPS street suffixes (Publication 28, appendix C1), the common spellings of each. */
const SUFFIXES: Readonly<Record<string, string>> = {
  ALLEY: "ALY",
  ALLY: "ALY",
  AVENUE: "AVE",
  AVEN: "AVE",
  AVENU: "AVE",
  AVN: "AVE",
  AV: "AVE",
  BOULEVARD: "BLVD",
  BOUL: "BLVD",
  BOULV: "BLVD",
  CIRCLE: "CIR",
  CIRC: "CIR",
  CIRCL: "CIR",
  CRCL: "CIR",
  COURT: "CT",
  CRT: "CT",
  CROSSING: "XING",
  CRSSNG: "XING",
  DRIVE: "DR",
  DRIV: "DR",
  DRV: "DR",
  EXPRESSWAY: "EXPY",
  EXPRESS: "EXPY",
  HEIGHTS: "HTS",
  HIGHWAY: "HWY",
  HIGHWY: "HWY",
  HIWAY: "HWY",
  HILL: "HL",
  HOLLOW: "HOLW",
  JUNCTION: "JCT",
  LANE: "LN",
  MOUNT: "MT",
  MOUNTAIN: "MTN",
  PARKWAY: "PKWY",
  PARKWY: "PKWY",
  PKY: "PKWY",
  PLACE: "PL",
  PLAZA: "PLZ",
  POINT: "PT",
  RIDGE: "RDG",
  ROAD: "RD",
  ROUTE: "RTE",
  SQUARE: "SQ",
  SQR: "SQ",
  STREET: "ST",
  STRT: "ST",
  STR: "ST",
  TERRACE: "TER",
  TERR: "TER",
  TRAIL: "TRL",
  TRAILS: "TRL",
  TURNPIKE: "TPKE",
  TURNPK: "TPKE",
  VIEW: "VW",
  VILLAGE: "VLG",
};

const DIRECTIONS: Readonly<Record<string, string>> = {
  NORTH: "N",
  SOUTH: "S",
  EAST: "E",
  WEST: "W",
  NORTHEAST: "NE",
  NORTHWEST: "NW",
  SOUTHEAST: "SE",
  SOUTHWEST: "SW",
};

const ORDINALS: Readonly<Record<string, string>> = {
  FIRST: "1ST",
  SECOND: "2ND",
  THIRD: "3RD",
  FOURTH: "4TH",
  FIFTH: "5TH",
  SIXTH: "6TH",
  SEVENTH: "7TH",
  EIGHTH: "8TH",
  NINTH: "9TH",
  TENTH: "10TH",
};

/** The words that name a unit inside a building; the unit's own number follows them. */
const UNIT_WORDS = new Set(["APT", "APARTMENT", "UNIT", "STE", "SUITE", "FL", "FLOOR", "RM", "ROOM", "SPC", "SPACE", "TRLR"]);

/** The text in capitals, without accents, with every run of punctuation and spaces as one space. */
function plainWords(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^\p{L}\p{N}#]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/**
 * An address in the words MATCH compares: capitals, no punctuation, street suffixes, directions
 * and ordinal words in USPS form, and no unit ("Unit 4", "Apt 2B", "#3", "Ste 100"), since a
 * parcel or a building is the same for every unit in it.
 */
function addressWords(text: string): string[] {
  const words = plainWords(text);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    let word = words[i]!;
    if (word.startsWith("#")) {
      // "#3", or "#" with its number after it.
      if (word === "#") i++;
      continue;
    }
    if (UNIT_WORDS.has(word)) {
      // The unit's number, when it is one word: "UNIT 4", "APT 2B".
      const next = words[i + 1];
      if (next && /\d/.test(next)) i++;
      continue;
    }
    word = SUFFIXES[word] ?? DIRECTIONS[word] ?? ORDINALS[word] ?? word;
    out.push(word.replace(/#/g, ""));
  }
  return out.filter(Boolean);
}

/** The words of a value as MATCH compares them. */
export function matchWords(text: string, kind: MatchKind): string[] {
  return kind === "address" ? addressWords(text) : plainWords(text).map((w) => w.replace(/#/g, "")).filter(Boolean);
}

/** A value as MATCH compares it, in one line: "12 ELM ST". */
export function matchForm(text: string, kind: MatchKind): string {
  return matchWords(text, kind).join(" ");
}

/** The first word when it holds a digit: an address's house number. */
const houseNumber = (words: readonly string[]): string | null => (words[0] && /^\d/.test(words[0]) ? words[0] : null);

/** The reference rows, read once for a MATCH: their compared form, their words, and which rows hold each word. */
export interface MatchIndex {
  kind: MatchKind;
  refs: readonly { text: string; form: string; words: readonly string[] }[];
  /** Rows by their text in capitals, without spaces at either end: the exact pass. */
  byText: ReadonlyMap<string, number[]>;
  /** Rows by their compared form: the normalized pass. */
  byForm: ReadonlyMap<string, number[]>;
  /** Rows by each word they hold. */
  byWord: ReadonlyMap<string, number[]>;
  /** How telling each word is: rare words weigh more (an inverse document frequency). */
  weight: ReadonlyMap<string, number>;
}

/** What `exact` reads: the text in capitals, with no spaces at either end. */
export const exactForm = (text: string): string => text.trim().toUpperCase();

export function matchIndex(references: readonly string[], kind: MatchKind): MatchIndex {
  const refs = references.map((text) => {
    const words = matchWords(text, kind);
    return { text, form: words.join(" "), words };
  });
  const byText = new Map<string, number[]>();
  const byForm = new Map<string, number[]>();
  const byWord = new Map<string, number[]>();
  refs.forEach((ref, at) => {
    const push = (map: Map<string, number[]>, key: string) => (map.get(key) ?? map.set(key, []).get(key)!).push(at);
    push(byText, exactForm(ref.text));
    if (ref.form) push(byForm, ref.form);
    for (const word of new Set(ref.words)) push(byWord, word);
  });
  const weight = new Map<string, number>();
  for (const [word, rows] of byWord) weight.set(word, Math.log(1 + refs.length / rows.length));
  return { kind, refs, byText, byForm, byWord, weight };
}

/** A word's weight; a word no reference row holds tells nothing about which row is meant. */
const weightOf = (index: MatchIndex, word: string): number => index.weight.get(word) ?? 0;

/**
 * The reference rows most like a value, best first, each with a score from 0 to 1: the weight of
 * the words they share over the weight of the words either holds. An address never takes a row
 * with another house number. Words most rows hold (ST, RD) only count toward a score: they never
 * bring a row in by themselves.
 */
export function candidatesFor(index: MatchIndex, value: string, limit: number): { at: number; score: number }[] {
  const words = [...new Set(matchWords(value, index.kind))];
  if (!words.length) return [];
  const house = index.kind === "address" ? houseNumber(words) : null;
  const common = Math.max(3, Math.floor(index.refs.length / 5));
  const telling = words.filter((w) => (index.byWord.get(w)?.length ?? 0) <= common);
  const lookups = telling.length ? telling : words;
  const seen = new Set<number>();
  for (const word of lookups) for (const at of index.byWord.get(word) ?? []) seen.add(at);
  const own = words.reduce((sum, w) => sum + weightOf(index, w), 0);
  const scored: { at: number; score: number }[] = [];
  for (const at of seen) {
    const ref = index.refs[at]!;
    if (house !== null) {
      const theirs = houseNumber(ref.words);
      if (theirs !== null && theirs !== house) continue;
    }
    const refWords = new Set(ref.words);
    let shared = 0;
    let theirs = 0;
    for (const w of refWords) theirs += weightOf(index, w);
    for (const w of words) if (refWords.has(w)) shared += weightOf(index, w);
    const score = shared / Math.max(own, theirs, 1e-9);
    if (score > 0) scored.push({ at, score: Math.round(score * 1000) / 1000 });
  }
  scored.sort((a, b) => b.score - a.score || a.at - b.at);
  return scored.slice(0, limit);
}

/** How a value matched, if the rules match it: one row's text alike, or one row's compared form alike. */
export type RuleMatch = { method: "exact" | "normalized"; at: number[] } | null;

/**
 * Which reference rows a value is by the rules: those whose text is the same (`exact`), else those
 * whose compared form is (`normalized`). Several rows can come back; the caller decides whether
 * they agree on the value it takes.
 */
export function ruleMatch(index: MatchIndex, value: string): RuleMatch {
  const exact = index.byText.get(exactForm(value));
  if (exact?.length) return { method: "exact", at: exact };
  const form = matchForm(value, index.kind);
  const normalized = form ? index.byForm.get(form) : undefined;
  return normalized?.length ? { method: "normalized", at: normalized } : null;
}
