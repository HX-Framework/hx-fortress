import { describe, expect, test } from "bun:test";

import { buildLiteralRegex, escapeLike, escapeRegex, prefilterPattern } from "./text-match";

describe("escapeRegex (POSIX ARE literal)", () => {
  test("escapes regex metacharacters to literals", () => {
    expect(escapeRegex("a.b*c+d?")).toBe("a\\.b\\*c\\+d\\?");
    expect(escapeRegex("(x)[y]{z}")).toBe("\\(x\\)\\[y\\]\\{z\\}");
    expect(escapeRegex("a|b^c$d")).toBe("a\\|b\\^c\\$d");
  });
  test("escapes a backslash to a literal backslash", () => {
    expect(escapeRegex("a\\b")).toBe("a\\\\b");
  });
  test("leaves word chars (letters, digits, underscore) untouched", () => {
    expect(escapeRegex("observer_42")).toBe("observer_42");
  });
  test("escapes punctuation so it can never form an escape like \\y or \\d", () => {
    expect(escapeRegex("error:")).toBe("error\\:");
    expect(escapeRegex("MC-2410")).toBe("MC\\-2410");
  });
});

describe("escapeLike", () => {
  test("escapes %, _ and the backslash escape char", () => {
    expect(escapeLike("50%_off\\x")).toBe("50\\%\\_off\\\\x");
  });
  test("leaves ordinary chars (incl. ':') untouched", () => {
    expect(escapeLike("error:")).toBe("error:");
  });
});

describe("buildLiteralRegex — literal_word (per-edge \\y)", () => {
  test("wraps a plain word in boundaries on both edges", () => {
    expect(buildLiteralRegex("observer", "literal_word")).toBe("\\yobserver\\y");
  });
  test("boundary ONLY on a word-char edge — a trailing ':' gets none", () => {
    // A blanket \yerror:\y never matches (':' is a non-word char); per-edge
    // yields \yerror\: which correctly matches "error:" / "error: X".
    expect(buildLiteralRegex("error:", "literal_word")).toBe("\\yerror\\:");
  });
  test("leading punctuation gets no leading boundary", () => {
    expect(buildLiteralRegex(":foo", "literal_word")).toBe("\\:foo\\y");
  });
  test("a hyphenated id escapes the hyphen, boundaries on the alnum edges", () => {
    expect(buildLiteralRegex("MC-2410", "literal_word")).toBe("\\yMC\\-2410\\y");
  });
  test("a phrase joins tokens on \\s+ inside the boundaries", () => {
    expect(buildLiteralRegex("machine learning", "literal_word")).toBe(
      "\\ymachine\\s+learning\\y",
    );
  });
  test("collapses arbitrary surrounding / inter-token whitespace", () => {
    expect(buildLiteralRegex("  machine   learning  ", "literal_word")).toBe(
      "\\ymachine\\s+learning\\y",
    );
  });
});

describe("buildLiteralRegex — literal_substring (no boundaries)", () => {
  test("matches a stem inside a larger word", () => {
    expect(buildLiteralRegex("observ", "literal_substring")).toBe("observ");
  });
  test("a phrase still joins on \\s+", () => {
    expect(buildLiteralRegex("machine learning", "literal_substring")).toBe(
      "machine\\s+learning",
    );
  });
});

describe("buildLiteralRegex — empty", () => {
  test("all-whitespace query yields an empty string", () => {
    expect(buildLiteralRegex("   ", "literal_word")).toBe("");
    expect(buildLiteralRegex("", "literal_substring")).toBe("");
  });
});

describe("prefilterPattern — single-token superset", () => {
  test("anchors on the longest token", () => {
    expect(prefilterPattern("machine learning")).toBe("%learning%");
    expect(prefilterPattern("observer")).toBe("%observer%");
  });
  test("escapes LIKE metacharacters in the anchor token", () => {
    expect(prefilterPattern("100%")).toBe("%100\\%%");
  });
  test("empty query yields an empty pattern", () => {
    expect(prefilterPattern("  ")).toBe("");
  });
});
