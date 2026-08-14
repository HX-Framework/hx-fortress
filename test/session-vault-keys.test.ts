import { describe, expect, test } from "bun:test";

import {
  artifactObject,
  canonicalObject,
  listPrefix,
  sessionPrefix,
  stagingObject,
} from "../src/modules/session-vault/store/keys";
import type { SessionKey } from "../src/modules/session-vault/store/types";

// M-6 · the shared object-key builders both stores adopt. Untrusted key segments
// must never escape their `${userId}/${family}/${sessionId}` prefix.

const OK: SessionKey = { userId: "user-1", family: "claude-cli", sessionId: "sess-abc" };

describe("session object-key builders", () => {
  test("builds the canonical / staging / artifact keys for a clean key", () => {
    expect(sessionPrefix(OK)).toBe("user-1/claude-cli/sess-abc");
    expect(canonicalObject(OK)).toBe("user-1/claude-cli/sess-abc/log.jsonl");
    expect(stagingObject(OK, "chunk-7")).toBe("user-1/claude-cli/sess-abc/.staging/chunk-7.jsonl");
    expect(artifactObject(OK, "session.json")).toBe("user-1/claude-cli/sess-abc/session.json");
  });

  test("admits the composite agent-lane sessionId ${sessionId}:a:${agentId}", () => {
    const k: SessionKey = { ...OK, sessionId: "foo:a:bar" };
    expect(sessionPrefix(k)).toBe("user-1/claude-cli/foo:a:bar");
  });

  test.each([
    ["path traversal in userId", { ...OK, userId: "../etc" }],
    ["slash in family", { ...OK, family: "a/b" }],
    ["dot-dot sessionId part", { ...OK, sessionId: ".." }],
    ["single-dot sessionId part", { ...OK, sessionId: "." }],
    ["empty family", { ...OK, family: "" }],
    ["slash smuggled via composite part", { ...OK, sessionId: "ok:a:../evil" }],
    // A raw ":" is allowed ONLY in a well-formed `X:a:Y` composite — everything
    // else is rejected so a crafted id can't fabricate/masquerade an agent lane.
    ["stray colon in a plain sessionId", { ...OK, sessionId: "foo:bar" }],
    ["wrong agent-lane marker", { ...OK, sessionId: "foo:b:bar" }],
    ["over-long composite", { ...OK, sessionId: "foo:a:bar:baz" }],
    ["trailing colon", { ...OK, sessionId: "foo:a:" }],
  ])("rejects %s", (_name, key) => {
    expect(() => sessionPrefix(key as SessionKey)).toThrow(/invalid .* segment/);
  });

  test("listPrefix validates the userId segment", () => {
    expect(listPrefix("user-1")).toBe("user-1/");
    expect(() => listPrefix("../etc")).toThrow(/invalid userId segment/);
    expect(() => listPrefix("a/b")).toThrow(/invalid userId segment/);
  });

  test("rejects a traversal chunkId", () => {
    expect(() => stagingObject(OK, "../evil")).toThrow(/invalid chunkId segment/);
  });

  test("artifact name must be on the allowlist", () => {
    expect(() => artifactObject(OK, "evil.sh")).toThrow(/artifact not allowed: evil.sh/);
    expect(() => artifactObject(OK, "../../log.jsonl")).toThrow(/artifact not allowed/);
    // The legitimate sidecars pass.
    expect(artifactObject(OK, "session.json")).toContain("/session.json");
    expect(artifactObject(OK, "tasks.json")).toContain("/tasks.json");
    expect(artifactObject(OK, "plan.json")).toContain("/plan.json");
  });

  test("admits the workbench workflow-<runId>.json artifact via a strict pattern", () => {
    // The workbench writes/reads workflow-<runId>.json; a fortress-mode org must
    // not throw on it (it is NOT flag-gated).
    expect(artifactObject(OK, "workflow-abc123.json")).toContain("/workflow-abc123.json");
    expect(artifactObject(OK, "workflow-run_01-XYZ.json")).toContain("/workflow-run_01-XYZ.json");
    // …but the pattern stays traversal- and injection-safe.
    expect(() => artifactObject(OK, "workflow-.json")).toThrow(/artifact not allowed/); // too short
    expect(() => artifactObject(OK, "workflow-../evil.json")).toThrow(/artifact not allowed/);
    expect(() => artifactObject(OK, "workflow-a/b.json")).toThrow(/artifact not allowed/);
    expect(() => artifactObject(OK, "workflow-abc.jsonl")).toThrow(/artifact not allowed/);
    expect(() => artifactObject(OK, "prefix-workflow-abc.json")).toThrow(/artifact not allowed/);
  });
});
