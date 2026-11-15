// The pieces of the second step's screens that are not React: the QR code that
// never throws into a render, and the wait said in minutes.

import { describe, expect, test } from "bun:test";

import { CEILING_CLOSED_MS } from "../src/ui/second-step";
import { otpauthUri } from "../src/ui/totp";
import { qrOf, waitSentence } from "../ui/src/lib/second-step";

describe("the QR code on the page", () => {
  test("is drawn for every address the console makes, the longest login's included", () => {
    const longest = `${"m".repeat(64)}@${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(61)}`;
    expect(qrOf(otpauthUri(longest, "MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U"))?.version).toBe(10);
  });

  test("is null, and throws nothing, for a text no code holds: the page then shows the key alone", () => {
    expect(qrOf("x".repeat(214))).toBeNull();
    expect(qrOf("x".repeat(213))?.version).toBe(10);
  });
});

describe("the wait, in minutes", () => {
  test("whole minutes, never fewer than one", () => {
    expect(waitSentence(CEILING_CLOSED_MS)).toBe("Try again in 15 minutes.");
    expect(waitSentence(CEILING_CLOSED_MS - 1)).toBe("Try again in 15 minutes.");
    expect(waitSentence(60_000)).toBe("Try again in 1 minute.");
    expect(waitSentence(61_000)).toBe("Try again in 2 minutes.");
    expect(waitSentence(1_000)).toBe("Try again in 1 minute.");
    expect(waitSentence(0)).toBe("Try again in 1 minute.");
  });
});
