// The dot-namespace is reserved for internal artifacts — with lifecycle
// DELETION rules now attached to ".session-vault/", a customer key segment
// must be structurally unable to land under it.
import { describe, expect, it } from "bun:test";
import { canonicalObject, sessionPrefix } from "./keys.js";

describe("key segment reservation", () => {
  it("rejects dot-leading userId segments (incl. the probe prefix itself)", () => {
    for (const userId of [".session-vault", ".staging", ".", "..", ".x"]) {
      expect(() => sessionPrefix({ userId, family: "claude-cli", sessionId: "s1" })).toThrow(
        "invalid userId segment",
      );
    }
  });

  it("rejects dot-leading family and sessionId segments", () => {
    expect(() =>
      sessionPrefix({ userId: "u1", family: ".session-vault", sessionId: "s1" }),
    ).toThrow("invalid family segment");
    expect(() =>
      canonicalObject({ userId: "u1", family: "claude-cli", sessionId: ".hidden" }),
    ).toThrow("invalid sessionId segment");
  });

  it("keeps accepting ordinary segments (dots allowed when not leading)", () => {
    expect(sessionPrefix({ userId: "u.1", family: "claude-cli", sessionId: "a-b.c" })).toBe(
      "u.1/claude-cli/a-b.c",
    );
  });
});
