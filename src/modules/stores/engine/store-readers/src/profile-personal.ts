// Columns that hold personal numbers: a part of the one profile (profile.ts). Such a column is
// counted like any other (how full, how many values, in which formats), and its values are kept
// back: no example, no common value, no smallest or largest, no histogram. Whatever reads a profile
// (a page, a program's step, a model) then never holds one of them.
//
// A column is personal by its name (a tax id, a date of birth, a password), or by how its values are
// written (most of them as a US social security number or a card number). A name says it in any
// case and any way of joining words: "SSN", "date_of_birth", "DOB", "Taxpayer ID", "passwordHash".

import { wordsOf } from "./profile-links.js";
import type { ShapeCount } from "./profile-formats.js";

/** Why a column's values are kept back. */
export type PersonalWhy = "tax id" | "birth date" | "secret" | "card number" | "bank account" | "id document";

/** Names, as runs of words, that say a column holds personal numbers. */
const NAMED: readonly { words: readonly string[]; why: PersonalWhy }[] = [
  { words: ["ssn"], why: "tax id" },
  { words: ["social", "security"], why: "tax id" },
  { words: ["tin"], why: "tax id" },
  { words: ["itin"], why: "tax id" },
  { words: ["ein"], why: "tax id" },
  { words: ["tax", "id"], why: "tax id" },
  { words: ["taxid"], why: "tax id" },
  { words: ["tax", "number"], why: "tax id" },
  { words: ["taxpayer", "id"], why: "tax id" },
  { words: ["taxpayer", "number"], why: "tax id" },
  { words: ["national", "id"], why: "tax id" },
  { words: ["dob"], why: "birth date" },
  { words: ["birth", "date"], why: "birth date" },
  { words: ["birthdate"], why: "birth date" },
  { words: ["birthday"], why: "birth date" },
  { words: ["date", "of", "birth"], why: "birth date" },
  { words: ["born"], why: "birth date" },
  { words: ["password"], why: "secret" },
  { words: ["passwd"], why: "secret" },
  { words: ["pwd"], why: "secret" },
  { words: ["passcode"], why: "secret" },
  { words: ["secret"], why: "secret" },
  { words: ["access", "token"], why: "secret" },
  { words: ["refresh", "token"], why: "secret" },
  { words: ["auth", "token"], why: "secret" },
  { words: ["api", "token"], why: "secret" },
  { words: ["api", "key"], why: "secret" },
  { words: ["apikey"], why: "secret" },
  { words: ["private", "key"], why: "secret" },
  { words: ["credit", "card"], why: "card number" },
  { words: ["card", "number"], why: "card number" },
  { words: ["cc", "number"], why: "card number" },
  { words: ["ccn"], why: "card number" },
  { words: ["cvv"], why: "card number" },
  { words: ["cvc"], why: "card number" },
  { words: ["bank", "account"], why: "bank account" },
  { words: ["routing", "number"], why: "bank account" },
  { words: ["iban"], why: "bank account" },
  { words: ["passport"], why: "id document" },
  { words: ["drivers", "license"], why: "id document" },
  { words: ["driver", "license"], why: "id document" },
  { words: ["drivers", "licence"], why: "id document" },
  { words: ["driver", "licence"], why: "id document" },
];

/** Whether `words` holds `run` as consecutive words. */
function holds(words: readonly string[], run: readonly string[]): boolean {
  for (let at = 0; at + run.length <= words.length; at += 1) {
    if (run.every((w, i) => words[at + i] === w)) return true;
  }
  return false;
}

/** Why a column's name says it holds personal numbers, or null. A word inside another word never counts: "tin" is not in "routing", nor "born" in "borne". */
export function personalByName(name: string): PersonalWhy | null {
  const words = wordsOf(name);
  return NAMED.find((n) => holds(words, n.words))?.why ?? null;
}

/** Ways of writing that are a person's number, by shape (every digit a 9). */
const SHAPED: readonly { test: RegExp; why: PersonalWhy }[] = [
  { test: /^999-99-9999$/, why: "tax id" },
  { test: /^9999[ -]9999[ -]9999[ -]9999$/, why: "card number" },
];

/** The share of a column's values that must be written so for the column to count as personal. */
const SHAPED_SHARE = 0.6;

/** Why most of a column's values are written as a person's number, or null. */
export function personalByShapes(shapes: readonly ShapeCount[], filled: number): PersonalWhy | null {
  if (filled <= 0) return null;
  for (const rule of SHAPED) {
    const rows = shapes.filter((s) => rule.test.test(s.shape)).reduce((sum, s) => sum + s.rows, 0);
    if (rows / filled >= SHAPED_SHARE) return rule.why;
  }
  return null;
}
