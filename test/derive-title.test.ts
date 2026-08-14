import { describe, expect, test } from "bun:test";

import { deriveFallbackTitle, firstLineLabel, FALLBACK_TITLE_MAX } from "../src/ingest/derive-title";

// Pure helpers — mirror hx/src/watch.ts so a title derived on ingest / backfill
// matches what the client would have produced. No DB, always runs.
describe("firstLineLabel", () => {
  test("null / blank → null", () => {
    expect(firstLineLabel(null)).toBeNull();
    expect(firstLineLabel("")).toBeNull();
    expect(firstLineLabel("   \n  ")).toBeNull();
  });

  test("takes the first line, collapsing whitespace", () => {
    expect(firstLineLabel("fix the   login   bug\nmore context")).toBe("fix the login bug");
    expect(firstLineLabel("  hello world  ")).toBe("hello world");
  });

  test("short line passes through verbatim", () => {
    const s = "a".repeat(FALLBACK_TITLE_MAX);
    expect(firstLineLabel(s)).toBe(s);
  });

  test("long line clips at a word boundary with an ellipsis", () => {
    const long =
      "please refactor the authentication middleware so that it validates the bearer token before touching the database";
    const out = firstLineLabel(long)!;
    expect(out.endsWith("…")).toBe(true);
    // trailing punctuation/space is trimmed before the ellipsis
    expect(out).not.toMatch(/[\s.,;:!?—-]…$/);
    // body (sans ellipsis) never exceeds the cap
    expect(out.length - 1).toBeLessThanOrEqual(FALLBACK_TITLE_MAX);
  });

  test("a single very long unbroken token is hard-clipped", () => {
    const out = firstLineLabel("x".repeat(200))!;
    expect(out).toBe(`${"x".repeat(FALLBACK_TITLE_MAX)}…`);
  });
});

describe("deriveFallbackTitle", () => {
  test("prefers the first user message", () => {
    expect(deriveFallbackTitle("investigate the flaky test", "/home/u/let-forge", "let-ai/let-forge")).toBe(
      "investigate the flaky test",
    );
  });

  test("falls back to the repo slug's last segment when there is no message", () => {
    expect(deriveFallbackTitle(null, "/home/u/let-forge", "let-ai/let-forge")).toBe("let-forge");
    expect(deriveFallbackTitle("   ", "/home/u/x", "org/repo-name")).toBe("repo-name");
  });

  test("falls back to the cwd basename when there is no message or repo", () => {
    expect(deriveFallbackTitle(null, "/home/u/projects/my-app/", null)).toBe("my-app");
    expect(deriveFallbackTitle(null, "C:\\work\\thing", null)).toBe("thing");
  });

  test("null when nothing is derivable", () => {
    expect(deriveFallbackTitle(null, null, null)).toBeNull();
    expect(deriveFallbackTitle(null, "/", null)).toBeNull();
  });
});
