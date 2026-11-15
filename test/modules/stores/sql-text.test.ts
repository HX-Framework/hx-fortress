import { describe, expect, test } from "bun:test";

import { asciiLower, asciiUpper, scanSql, type Token } from "../../../src/modules/stores/host/sql-text";

function tokens(sql: string): Token[] {
  const scan = scanSql(sql);
  if (!scan.ok) throw new Error(`not read: stopped at ${scan.at}`);
  return scan.tokens;
}

/** Each token as `kind:text`. */
function read(sql: string): string[] {
  return tokens(sql).map((token) => `${token.kind}:${token.text}`);
}

function refused(sql: string): number | null {
  const scan = scanSql(sql);
  return scan.ok ? null : scan.at;
}

describe("a statement's text, cut as SQLite cuts it", () => {
  test("words, numbers, marks and the semicolon", () => {
    expect(read("SELECT a, 1.5 FROM t;")).toEqual([
      "word:SELECT",
      "word:a",
      "punct:,",
      "number:1.5",
      "word:FROM",
      "word:t",
      "semi:;",
    ]);
  });

  test("text in single quotes is one token, with a doubled quote as one", () => {
    expect(read("SELECT 'it''s; ATTACH'")).toEqual(["word:SELECT", "string:it's; ATTACH"]);
  });

  test("a name in double quotes, backticks or brackets is a name, not a word", () => {
    expect(read('SELECT "a""b", `c``d`, [e f]')).toEqual([
      "word:SELECT",
      'quoted:a"b',
      "punct:,",
      "quoted:c`d",
      "punct:,",
      "quoted:e f",
    ]);
  });

  test("a bracket name ends at the first closing bracket", () => {
    // The name is `a`. The bracket after it is a character with no token.
    expect(read("[a] b")).toEqual(["quoted:a", "word:b"]);
    expect(refused("[a]]")).toBe(3);
  });

  test("bytes are one token, and need an even count of hex digits", () => {
    expect(read("x'0aFF'")).toEqual(["blob:x'0aFF'"]);
    expect(refused("x'0a0'")).toBe(0);
    expect(refused("x'zz'")).toBe(0);
  });

  test("every form of a value to bind", () => {
    expect(read("? ?12 :name @name $name")).toEqual([
      "variable:?",
      "variable:?12",
      "variable::name",
      "variable:@name",
      "variable:$name",
    ]);
  });

  test("numbers: whole, decimal, exponent, hex, and with separators", () => {
    expect(read("12 .5 1e9 1E-3 0x1F 1_000")).toEqual([
      "number:12",
      "number:.5",
      "number:1e9",
      "number:1E-3",
      "number:0x1F",
      "number:1_000",
    ]);
  });

  test("a number does not swallow a comment that follows it", () => {
    expect(read("1--2\n3")).toEqual(["number:1", "number:3"]);
  });
});

describe("where text is skipped", () => {
  test("a line comment ends at a line feed", () => {
    expect(read("SELECT 1 -- note\nFROM t")).toEqual(["word:SELECT", "number:1", "word:FROM", "word:t"]);
  });

  test("a carriage return does NOT end a line comment", () => {
    // If it did, the quote after it would open text, and that text would
    // swallow the statement that follows on the next line.
    expect(read("SELECT 1 -- a\r' \n; ATTACH DATABASE 'f' AS x --'")).toEqual([
      "word:SELECT",
      "number:1",
      "semi:;",
      "word:ATTACH",
      "word:DATABASE",
      "string:f",
      "word:AS",
      "word:x",
    ]);
  });

  test("a block comment ends at the first star and slash", () => {
    expect(read("a /* b */ c /* d */ e")).toEqual(["word:a", "word:c", "word:e"]);
    // Comments do not nest.
    expect(read("a /* /* b */ c")).toEqual(["word:a", "word:c"]);
  });

  test("the star of the opening does not close a block comment", () => {
    expect(read("a /*/ b */ c")).toEqual(["word:a", "word:c"]);
  });

  test("a block comment that never ends runs to the end of the text", () => {
    expect(read("a /* b ; ATTACH")).toEqual(["word:a"]);
  });

  test("a slash and a star as the last two characters are two marks", () => {
    expect(read("a /*")).toEqual(["word:a", "punct:/", "punct:*"]);
  });

  test("a quote inside a comment opens nothing", () => {
    expect(read("a -- it's\nb /* it's */ c")).toEqual(["word:a", "word:b", "word:c"]);
  });

  test("a comment mark inside text is text", () => {
    expect(read("'-- not a comment' b '/* nor this */'")).toEqual([
      "string:-- not a comment",
      "word:b",
      "string:/* nor this */",
    ]);
  });
});

describe("what a letter is", () => {
  test("a byte order mark is white space where a token starts", () => {
    // SQLite skips it, so the word after it is the keyword.
    expect(read("\uFEFFATTACH")).toEqual(["word:ATTACH"]);
    expect(read("SELECT\uFEFF 1")).toEqual(["word:SELECT\uFEFF", "number:1"]);
  });

  test("a no-break space joins the word beside it", () => {
    expect(read("ATTACH\u00A0DATABASE")).toEqual(["word:ATTACH\u00A0DATABASE"]);
  });

  test("a dollar sign is a letter inside a word", () => {
    expect(read("a$b")).toEqual(["word:a$b"]);
  });

  test("keywords are matched on ASCII letters only", () => {
    expect(asciiUpper("attach")).toBe("ATTACH");
    // The long s and the dotless i become S and I for the language's own
    // upper-casing. They are not those letters to SQLite.
    expect(asciiUpper("load_exten\u017Fion")).toBe("LOAD_EXTEN\u017FION");
    expect(asciiLower("PRAGMA_\u0130")).toBe("pragma_\u0130");
  });
});

describe("text this host will not guess at", () => {
  test("text, a quoted name or a bracket name that never ends", () => {
    expect(refused("SELECT 'abc")).toBe(7);
    expect(refused('SELECT "abc')).toBe(7);
    expect(refused("SELECT `abc")).toBe(7);
    expect(refused("SELECT [abc")).toBe(7);
  });

  test("NUL, which ends the text for SQLite and not for this scan", () => {
    expect(refused("SELECT 1\u0000; ATTACH DATABASE 'f' AS x")).toBe(8);
    // Inside text in quotes and inside a comment too.
    expect(refused("SELECT 'a\u0000b'")).toBe(9);
    expect(refused("SELECT 1 /* \u0000 */")).toBe(12);
    expect(refused("SELECT 1 -- \u0000")).toBe(12);
  });

  test("a variable followed by a bracket, or holding two colons", () => {
    // A build of SQLite reads `$a(…)` as one variable, up to the bracket's end.
    // Read the other way, the quote inside would open text.
    expect(refused("SELECT $a('x) ; ATTACH DATABASE 'f' AS y --'")).toBe(7);
    expect(refused("SELECT @a(b)")).toBe(7);
    expect(refused("SELECT $a::b")).toBe(7);
  });

  test("a variable mark with no name", () => {
    expect(refused("SELECT :")).toBe(7);
    expect(refused("SELECT $ ")).toBe(7);
  });

  test("characters SQLite has no token for", () => {
    expect(refused("SELECT #1")).toBe(7);
    expect(refused("SELECT 1 ^ 2")).toBe(9);
    expect(refused("SELECT \\")).toBe(7);
    expect(refused("SELECT {a}")).toBe(7);
    expect(refused("SELECT ! a")).toBe(7);
  });

  test("a vertical tab where a token starts", () => {
    expect(refused("SELECT\u000B1")).toBe(6);
    // After a space it is white space, as in SQLite.
    expect(read("SELECT \u000B1")).toEqual(["word:SELECT", "number:1"]);
  });
});
