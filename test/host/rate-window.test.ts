import { describe, expect, test } from "bun:test";

import { RateWindow } from "../../src/host/rate-window";

describe("at most N starts in any minute", () => {
  test("the limit is exact at the edge of the window", () => {
    const window = new RateWindow(2, 60_000);
    expect(window.take(0)).toBe(true);
    expect(window.take(0)).toBe(true);
    expect(window.take(0)).toBe(false);
    expect(window.take(59_999)).toBe(false);
    // A start leaves the window exactly one window after it happened.
    expect(window.take(60_000)).toBe(true);
    expect(window.take(60_000)).toBe(true);
    expect(window.take(60_000)).toBe(false);
  });

  test("a refused start takes nothing", () => {
    const window = new RateWindow(1, 1_000);
    expect(window.take(0)).toBe(true);
    for (let at = 1; at < 1_000; at += 1) expect(window.take(at)).toBe(false);
    expect(window.count(999)).toBe(1);
    expect(window.take(1_000)).toBe(true);
  });

  test("no window of one minute ever holds more than the limit, whatever the pattern", () => {
    // Every millisecond pattern a caller could choose is too many to try, so
    // this tries a few thousand starts at seeded pseudo-random gaps, some of
    // them bursts, and then measures every window that begins at a start.
    const limit = 7;
    const windowMs = 60_000;
    const window = new RateWindow(limit, windowMs);
    let seed = 0x2f6e2b1;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const taken: number[] = [];
    let now = 0;
    for (let i = 0; i < 6_000; i += 1) {
      const roll = next();
      now += roll < 0.6 ? 0 : roll < 0.9 ? Math.floor(next() * 9_000) : Math.floor(next() * 70_000);
      if (window.take(now)) taken.push(now);
    }
    expect(taken.length).toBeGreaterThan(limit * 20);
    let most = 0;
    for (let i = 0; i < taken.length; i += 1) {
      let inside = 0;
      for (let j = i; j < taken.length && (taken[j] as number) - (taken[i] as number) < windowMs; j += 1) {
        inside += 1;
      }
      most = Math.max(most, inside);
    }
    // The limit is reached, and never passed.
    expect(most).toBe(limit);
  });

  test("a bucket that refills evenly would pass twice the limit; this does not", () => {
    // The pattern that separates the two: spend everything at once, then take
    // each start the moment an even refill would hand one back.
    const limit = 6;
    const window = new RateWindow(limit, 60_000);
    let taken = 0;
    for (let i = 0; i < limit; i += 1) if (window.take(0)) taken += 1;
    for (let at = 10_000; at < 60_000; at += 10_000) if (window.take(at)) taken += 1;
    expect(taken).toBe(limit);
  });

  test("a clock that was set back does not hold the limit shut for as long as the step", () => {
    const window = new RateWindow(2, 60_000);
    const day = 24 * 60 * 60 * 1000;
    expect(window.take(day)).toBe(true);
    expect(window.take(day)).toBe(true);
    // The clock is now a day earlier. The two starts count as made now.
    expect(window.take(0)).toBe(false);
    expect(window.take(59_999)).toBe(false);
    expect(window.take(60_000)).toBe(true);
  });

  test("a limit of zero allows nothing", () => {
    const window = new RateWindow(0, 60_000);
    expect(window.take(0)).toBe(false);
    expect(window.take(10 * 60_000)).toBe(false);
  });
});
