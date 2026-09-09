import { describe, expect, test } from "bun:test";

import {
  deriveFallbackTitle,
  firstLineLabel,
  isInjectedUserTitleText,
  FALLBACK_TITLE_MAX,
} from "../src/ingest/derive-title";

// Pure helpers — mirror hx/src/watch.ts so a title derived on ingest / backfill
// matches what the client would have produced. No DB, always runs.
describe("isInjectedUserTitleText — codex harness-injected first messages (parity with hx preview.ts)", () => {
  test("tag-shaped injected context is skipped", () => {
    for (const t of [
      "<recommended_plugins>\nHere is a list of plugins…",
      "<environment_context>",
      "<command-message>plan</command-message>",
      "<in-app-browser-context source=…>",
      "<ide_opened_file>The user opened…",
    ]) {
      expect(isInjectedUserTitleText(t)).toBe(true);
    }
  });

  test("caveat-shaped and injected markdown headers are skipped", () => {
    expect(isInjectedUserTitleText("Caveat: the messages below were generated…")).toBe(true);
    expect(isInjectedUserTitleText("# AGENTS.md instructions for /repo")).toBe(true);
    expect(isInjectedUserTitleText("# AGENTS.md instructions")).toBe(true);
    // Claude Code IDE/context injections (the daemon's <>/Caveat rule misses these)
    expect(isInjectedUserTitleText("# Context from my IDE setup:")).toBe(true);
    expect(isInjectedUserTitleText("# Files mentioned by the user:")).toBe(true);
    expect(isInjectedUserTitleText("# Applications mentioned by the user:")).toBe(true);
    expect(isInjectedUserTitleText("# Directories mentioned by the user:")).toBe(true);
    // leading whitespace is trimmed before the check
    expect(isInjectedUserTitleText("  <recommended_plugins>")).toBe(true);
  });

  test("a real prompt is NOT injected — even one that mentions markup or a heading", () => {
    expect(isInjectedUserTitleText("fix the login bug")).toBe(false);
    expect(isInjectedUserTitleText("Посмотри, в git diff много изменений")).toBe(false);
    // starts with '#' but not the AGENTS.md header → a real prompt, kept
    expect(isInjectedUserTitleText("# How do I center a div?")).toBe(false);
    expect(isInjectedUserTitleText(null)).toBe(false);
    expect(isInjectedUserTitleText("")).toBe(false);
  });
});

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
