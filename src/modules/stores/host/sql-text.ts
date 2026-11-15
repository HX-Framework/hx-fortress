// A statement's text, cut into tokens the way SQLite cuts it.
//
// The guard beside this file (sql-guard.ts) refuses a statement by what its
// tokens are. That is only as good as this file's agreement with SQLite on
// where a string, a quoted name and a comment begin and end: text that this
// file skipped as a string, and that SQLite read as code, would run unseen.
//
// So this follows SQLite's own tokenizer rule for rule, and where SQLite's
// answer depends on how it was built, or on a corner nobody needs, the text is
// ILLEGAL here and the guard refuses it whole:
//
//   • a string, a quoted name or a blob that never ends
//   • a variable followed by "(" or holding "::" (a build of SQLite may or may
//     not read those as part of the variable)
//   • a character SQLite has no token for, NUL and the vertical tab among them
//
// Three rules are easy to get wrong, and each one is a way to hide a keyword:
//
//   • "--" ends at a line feed only. A carriage return does not end it.
//   • A byte order mark is white space where a token starts, and part of a name
//     inside one.
//   • Every character past ASCII is a letter of a name. A no-break space joins
//     the word beside it, it does not separate.
//
// No keyword is looked up here. A bare word is a word; the guard decides what
// it means, comparing ASCII letters only, as SQLite does.

export type TokenKind =
  /** A bare word: a keyword or a name. Letters, digits, `_`, `$` and every
   *  character past ASCII. */
  | "word"
  /** A name in double quotes, backticks or square brackets. */
  | "quoted"
  /** Text in single quotes. */
  | "string"
  /** Bytes, written `x'…'`. */
  | "blob"
  | "number"
  /** A value to bind: `?`, `?3`, `:name`, `@name`, `$name`. */
  | "variable"
  /** `;` */
  | "semi"
  /** Any other operator or mark. */
  | "punct";

export interface Token {
  kind: TokenKind;
  /** For a word, a number, a variable and a mark: the text as written. For a
   *  quoted name and a string: what is inside the quotes, with a doubled quote
   *  as one. */
  text: string;
  /** Where the token starts in the statement, and where it ends (exclusive). */
  start: number;
  end: number;
}

export type Scan =
  | { ok: true; tokens: Token[] }
  /** The text holds something SQLite has no token for, or that this file will
   *  not guess at. `at` is where it starts. */
  | { ok: false; at: number };

const TAB = 0x09;
const LINE_FEED = 0x0a;
const VERTICAL_TAB = 0x0b;
const FORM_FEED = 0x0c;
const CARRIAGE_RETURN = 0x0d;
const SPACE = 0x20;
const BYTE_ORDER_MARK = 0xfeff;

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isHexDigit(code: number): boolean {
  return isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}

function isLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/** A character a name may hold after its first: letters, digits, `_`, `$`, and
 *  everything past ASCII. */
function isNameChar(code: number): boolean {
  return isLetter(code) || isDigit(code) || code === 0x5f || code === 0x24 || code >= 0x80;
}

/** White space where a token may start. The vertical tab is not among them. */
function startsSpace(code: number): boolean {
  return (
    code === SPACE ||
    code === TAB ||
    code === LINE_FEED ||
    code === FORM_FEED ||
    code === CARRIAGE_RETURN
  );
}

/** White space after the first: the same, and the vertical tab. */
function continuesSpace(code: number): boolean {
  return startsSpace(code) || code === VERTICAL_TAB;
}

/** The tokens of `sql`, without its white space and comments. */
export function scanSql(sql: string): Scan {
  const tokens: Token[] = [];
  const length = sql.length;
  // NUL ends the text for SQLite, wherever it stands: inside text in quotes and
  // inside a comment too. What follows it would be read here and never there,
  // so a statement that holds one is refused. A value is bound, never written
  // into a statement, so no statement needs one.
  const nul = sql.indexOf("\u0000");
  if (nul >= 0) return { ok: false, at: nul };
  let i = 0;
  const at = (index: number): number => (index < length ? sql.charCodeAt(index) : 0);
  const push = (kind: TokenKind, start: number, end: number, text?: string): void => {
    tokens.push({ kind, text: text ?? sql.slice(start, end), start, end });
  };

  while (i < length) {
    const start = i;
    const c = sql.charCodeAt(i);

    if (startsSpace(c)) {
      i += 1;
      while (i < length && continuesSpace(sql.charCodeAt(i))) i += 1;
      continue;
    }
    if (c === BYTE_ORDER_MARK) {
      i += 1;
      continue;
    }

    // "--" to the end of the line. Only a line feed ends it.
    if (c === 0x2d && at(i + 1) === 0x2d) {
      i += 2;
      while (i < length && sql.charCodeAt(i) !== LINE_FEED) i += 1;
      continue;
    }
    // "/*" to "*/", or to the end of the text. "/*" as the last two characters
    // is a slash and a star.
    if (c === 0x2f && at(i + 1) === 0x2a && i + 2 < length) {
      i += 2;
      while (i < length && !(sql.charCodeAt(i) === 0x2a && at(i + 1) === 0x2f)) i += 1;
      i = Math.min(length, i + 2);
      continue;
    }

    // '…', "…" and `…`: the quote doubled inside stands for itself.
    if (c === 0x27 || c === 0x22 || c === 0x60) {
      let j = i + 1;
      let closed = false;
      while (j < length) {
        if (sql.charCodeAt(j) === c) {
          if (at(j + 1) === c) {
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) return { ok: false, at: start };
      const quote = String.fromCharCode(c);
      const inside = sql.slice(i + 1, j).split(quote + quote).join(quote);
      i = j + 1;
      push(c === 0x27 ? "string" : "quoted", start, i, inside);
      continue;
    }
    // […] ends at the first "]".
    if (c === 0x5b) {
      const close = sql.indexOf("]", i + 1);
      if (close < 0) return { ok: false, at: start };
      i = close + 1;
      push("quoted", start, i, sql.slice(start + 1, close));
      continue;
    }

    // x'…': an even count of hex digits and nothing else.
    if ((c === 0x78 || c === 0x58) && at(i + 1) === 0x27) {
      let j = i + 2;
      while (j < length && isHexDigit(sql.charCodeAt(j))) j += 1;
      if (at(j) !== 0x27 || (j - (i + 2)) % 2 !== 0) return { ok: false, at: start };
      i = j + 1;
      push("blob", start, i);
      continue;
    }

    // A number: 12, 1.5, .5, 1e9, 0x1f, 1_000. Whatever letters follow it
    // belong to it, as SQLite has it (and then refuses it).
    if (isDigit(c) || (c === 0x2e && isDigit(at(i + 1)))) {
      let j = i;
      if (c === 0x30 && (at(j + 1) === 0x78 || at(j + 1) === 0x58) && isHexDigit(at(j + 2))) {
        j += 3;
        while (j < length && (isHexDigit(sql.charCodeAt(j)) || sql.charCodeAt(j) === 0x5f)) j += 1;
      } else {
        const digits = (): void => {
          while (j < length && (isDigit(sql.charCodeAt(j)) || sql.charCodeAt(j) === 0x5f)) j += 1;
        };
        digits();
        if (at(j) === 0x2e) {
          j += 1;
          digits();
        }
        const e = at(j);
        if (
          (e === 0x65 || e === 0x45) &&
          (isDigit(at(j + 1)) || ((at(j + 1) === 0x2b || at(j + 1) === 0x2d) && isDigit(at(j + 2))))
        ) {
          j += 2;
          digits();
        }
      }
      while (j < length && isNameChar(sql.charCodeAt(j))) j += 1;
      i = j;
      push("number", start, i);
      continue;
    }

    // ? and ?123.
    if (c === 0x3f) {
      i += 1;
      while (i < length && isDigit(sql.charCodeAt(i))) i += 1;
      push("variable", start, i);
      continue;
    }
    // :name, @name and $name. "#" starts nothing a statement may hold.
    if (c === 0x3a || c === 0x40 || c === 0x24) {
      let j = i + 1;
      while (j < length && isNameChar(sql.charCodeAt(j))) j += 1;
      // No name, a "(" right after the name, or "::" inside it.
      if (j === i + 1) return { ok: false, at: start };
      if (at(j) === 0x28 || (at(j) === 0x3a && at(j + 1) === 0x3a)) return { ok: false, at: start };
      i = j;
      push("variable", start, i);
      continue;
    }

    if (isLetter(c) || c === 0x5f || c >= 0x80) {
      i += 1;
      while (i < length && isNameChar(sql.charCodeAt(i))) i += 1;
      push("word", start, i);
      continue;
    }

    if (c === 0x3b) {
      i += 1;
      push("semi", start, i);
      continue;
    }

    // Two characters that are one mark. Which mark it is does not matter to
    // the guard; that the pair is not read as two does not either.
    const next = at(i + 1);
    const two =
      (c === 0x7c && next === 0x7c) || // ||
      (c === 0x3d && next === 0x3d) || // ==
      (c === 0x3c && (next === 0x3d || next === 0x3e || next === 0x3c)) || // <= <> <<
      (c === 0x3e && (next === 0x3d || next === 0x3e)) || // >= >>
      (c === 0x21 && next === 0x3d) || // !=
      (c === 0x2d && next === 0x3e); // ->
    if (two) {
      i += 2;
      if (c === 0x2d && at(i) === 0x3e) i += 1; // ->>
      push("punct", start, i);
      continue;
    }
    // One character that is a mark by itself.
    if ("()+-*/%=<>|,&~.".includes(sql.charAt(i))) {
      i += 1;
      push("punct", start, i);
      continue;
    }

    // "!" alone, "#", "^", "\", a brace, a control character.
    return { ok: false, at: start };
  }
  return { ok: true, tokens };
}

/** A word in capital ASCII letters, with every other character left as it is.
 *  SQLite matches a keyword this way: a letter past ASCII never becomes one. */
export function asciiUpper(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    out += code >= 0x61 && code <= 0x7a ? String.fromCharCode(code - 0x20) : text.charAt(i);
  }
  return out;
}

/** The same, in small letters. */
export function asciiLower(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    out += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : text.charAt(i);
  }
  return out;
}
