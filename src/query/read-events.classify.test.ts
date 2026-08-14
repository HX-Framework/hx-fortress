import { test, expect } from "bun:test";
import { isBenignBlobMiss } from "./read-events";

// A genuinely-absent object (one session's blob missing) is BENIGN → soft not-found.
test("benign per-session miss: NoSuchKey / not found", () => {
  expect(isBenignBlobMiss(Object.assign(new Error("x"), { name: "NoSuchKey" }))).toBe(true);
  expect(isBenignBlobMiss(new Error("The specified key does not exist."))).toBe(true);
  expect(isBenignBlobMiss(Object.assign(new Error("x"), { name: "NotFound" }))).toBe(true);
});

// Infra/credential/network failures affect ALL reads → NOT benign → fail-fast.
test("infra/credential failure is NOT a benign miss", () => {
  expect(isBenignBlobMiss(new Error("The provided token has expired."))).toBe(false);
  expect(isBenignBlobMiss(Object.assign(new Error("x"), { name: "ExpiredToken" }))).toBe(false);
  expect(isBenignBlobMiss(Object.assign(new Error("x"), { name: "AccessDenied" }))).toBe(false);
  expect(isBenignBlobMiss(Object.assign(new Error("x"), { name: "InvalidAccessKeyId" }))).toBe(false);
  expect(isBenignBlobMiss(new Error("getaddrinfo ENOTFOUND s3.amazonaws.com"))).toBe(false);
  expect(isBenignBlobMiss(new Error("connect ETIMEDOUT"))).toBe(false);
});
