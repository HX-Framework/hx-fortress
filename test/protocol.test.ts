import { describe, expect, test } from "bun:test";

import {
  decodeFrame,
  encodeFrame,
  type FortressToHubFrame,
  type HubToFortressFrame,
} from "../src/protocol";

describe("protocol codec", () => {
  test("round-trips a Fortress enrollment frame", () => {
    const frame: FortressToHubFrame = {
      t: "enroll",
      enrollToken: "enroll-token",
      version: "1.0.0",
      protocolVersion: 1,
    };

    expect(decodeFrame<FortressToHubFrame>(encodeFrame(frame))).toEqual(frame);
  });

  test("round-trips an addressed module request", () => {
    const frame: HubToFortressFrame = {
      t: "moduleMessage",
      data: {
        module: "session_vault",
        id: "request-1",
        kind: "request",
        payload: { method: "selfTest" },
      },
    };

    expect(decodeFrame<HubToFortressFrame>(encodeFrame(frame))).toEqual(frame);
  });

  test("round-trips a failed module reply", () => {
    const frame: FortressToHubFrame = {
      t: "moduleReply",
      id: "request-1",
      reply: {
        ok: false,
        error: "module failed",
      },
    };

    expect(decodeFrame<FortressToHubFrame>(encodeFrame(frame))).toEqual(frame);
  });

  test("rejects malformed JSON", () => {
    expect(() => decodeFrame("{not-json")).toThrow(SyntaxError);
  });
});
