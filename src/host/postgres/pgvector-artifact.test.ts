import { test, expect } from "bun:test";
import { createHash } from "node:crypto";

import {
  pgMajorOf,
  pgvectorArtifactName,
  pgvectorArtifactUrl,
  verifySha256,
} from "./pgvector-artifact";

test("pgMajorOf extracts the PG major from a full version", () => {
  expect(pgMajorOf("18.4.0")).toBe(18);
  expect(pgMajorOf("18")).toBe(18);
});

test("pgMajorOf throws on a non-numeric version", () => {
  expect(() => pgMajorOf("")).toThrow();
  expect(() => pgMajorOf("nope")).toThrow();
});

test("pgvectorArtifactName builds the classifier-scoped name", () => {
  expect(pgvectorArtifactName(18, "linux-amd64")).toBe("pgvector-pg18-linux-amd64.tar.gz");
  expect(pgvectorArtifactName(18, "darwin-arm64v8")).toBe(
    "pgvector-pg18-darwin-arm64v8.tar.gz",
  );
});

test("pgvectorArtifactUrl joins base + name with no double slash", () => {
  expect(pgvectorArtifactUrl("https://x/rel/", 18, "darwin-arm64v8")).toBe(
    "https://x/rel/pgvector-pg18-darwin-arm64v8.tar.gz",
  );
  expect(pgvectorArtifactUrl("https://x/rel", 18, "linux-amd64")).toBe(
    "https://x/rel/pgvector-pg18-linux-amd64.tar.gz",
  );
});

test("verifySha256 accepts a matching digest and rejects a mismatch", () => {
  const bytes = new TextEncoder().encode("hi");
  const hex = createHash("sha256").update(bytes).digest("hex");
  expect(verifySha256(bytes, hex)).toBe(true);
  // tolerate surrounding whitespace + case, like a real sha256 sidecar
  expect(verifySha256(bytes, `  ${hex.toUpperCase()}\n`)).toBe(true);
  expect(verifySha256(bytes, "deadbeef")).toBe(false);
});
