import { describe, expect, test } from "bun:test";

import { costUsd, priceForModel } from "../../src/ingest/pricing";

describe("priceForModel", () => {
  test("matches a known model id exactly", () => {
    const p = priceForModel("claude-opus-4-8");
    expect(p).not.toBeNull();
    expect(p?.inputPerMtok).toBe(5);
    expect(p?.outputPerMtok).toBe(25);
    // Anthropic cache multipliers: read = input/10, write = input*1.25.
    expect(p?.cacheReadPerMtok).toBe(0.5);
    expect(p?.cacheWritePerMtok).toBe(6.25);
  });

  test("falls back to a case-insensitive prefix match for dated suffixes", () => {
    const p = priceForModel("claude-sonnet-4-6-20260115");
    expect(p?.inputPerMtok).toBe(3);
    expect(p?.outputPerMtok).toBe(15);
  });

  test("returns null for an unknown or missing model", () => {
    expect(priceForModel("some-unknown-model")).toBeNull();
    expect(priceForModel(null)).toBeNull();
    expect(priceForModel(undefined)).toBeNull();
  });
});

describe("costUsd", () => {
  test("computes USD from the per-Mtok rates", () => {
    const cost = costUsd("claude-opus-4-8", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    // 1M input @ $5 + 1M output @ $25 = $30.
    expect(cost).toBeCloseTo(30, 6);
  });

  test("includes cache read/write tiers", () => {
    const cost = costUsd("claude-opus-4-8", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    });
    // 1M cache-read @ $0.5 + 1M cache-write @ $6.25 = $6.75.
    expect(cost).toBeCloseTo(6.75, 6);
  });

  test("unmapped model costs $0 (never a wrong number)", () => {
    expect(
      costUsd("mystery", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ).toBe(0);
  });
});
