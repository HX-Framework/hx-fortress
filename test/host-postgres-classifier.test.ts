import { describe, expect, test } from "bun:test";

import { resolveZonkyClassifier } from "../src/host/postgres/classifier";

describe("zonky classifier", () => {
  test("maps macOS", () => {
    expect(resolveZonkyClassifier("darwin", "arm64", false)).toBe("darwin-arm64v8");
    expect(resolveZonkyClassifier("darwin", "x64", false)).toBe("darwin-amd64");
  });

  test("maps Linux glibc and musl", () => {
    expect(resolveZonkyClassifier("linux", "x64", false)).toBe("linux-amd64");
    expect(resolveZonkyClassifier("linux", "x64", true)).toBe("linux-amd64-alpine");
    expect(resolveZonkyClassifier("linux", "arm64", false)).toBe("linux-arm64v8");
  });

  test("rejects Windows with a clear message", () => {
    expect(() => resolveZonkyClassifier("win32", "x64", false)).toThrow(/Windows is not supported/);
  });

  test("rejects unknown arch", () => {
    expect(() => resolveZonkyClassifier("linux", "mips", false)).toThrow(/unsupported/i);
  });
});
