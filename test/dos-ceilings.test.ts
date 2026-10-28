import { describe, expect, test } from "bun:test";

import { handleMcpRequest, type McpServeDeps } from "../src/mcp/server";
import { MAX_SCOPE_IDENTITIES, parseScope } from "../src/query/scope";
import { estimateEmbedTokens, isEmbedBudgetExceeded } from "../src/modules/embed-worker";

// M-9 · DoS ceilings that don't need a DB or network.

const nullDeps: McpServeDeps = { db: null, store: null, embedder: null, version: "test" };

describe("MCP batch size ceiling (M-9b)", () => {
  test("rejects a JSON-RPC batch over 50 messages", async () => {
    const batch = Array.from({ length: 51 }, (_v, i) => ({ jsonrpc: "2.0", id: i, method: "ping" }));
    const req = new Request("http://fortress/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(batch),
    });
    const res = await handleMcpRequest(req, nullDeps);
    const body = (await res.json()) as { error?: { code: number; message: string } };
    expect(body.error?.code).toBe(-32600);
    expect(body.error?.message).toBe("batch too large");
  });

  test("accepts a batch at the ceiling", async () => {
    const batch = Array.from({ length: 50 }, (_v, i) => ({ jsonrpc: "2.0", id: i, method: "ping" }));
    const req = new Request("http://fortress/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(batch),
    });
    const res = await handleMcpRequest(req, nullDeps);
    const body = (await res.json()) as Array<{ result?: unknown }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(50);
  });
});

describe("parseScope identity cap (M-9d)", () => {
  const identities = (n: number) =>
    Array.from({ length: n }, (_v, i) => ({ userExternalId: `u${i}`, family: "claude-cli", sessionId: `s${i}` }));

  test("keeps a scope of 31,331 identities whole (the cap was 10,000 before 0.36.0)", () => {
    expect(MAX_SCOPE_IDENTITIES).toBe(100_000);
    const scope = parseScope({ identities: identities(31_331) });
    expect(scope.identities).toHaveLength(31_331);
    expect(scope.identities[31_330]?.sessionId).toBe("s31330");
  });

  test("truncates an oversized identity set to the first 100 000 (fail-closed narrowing)", () => {
    const scope = parseScope({ identities: identities(MAX_SCOPE_IDENTITIES + 7) });
    expect(scope.identities).toHaveLength(MAX_SCOPE_IDENTITIES);
    expect(scope.identities.at(-1)?.sessionId).toBe(`s${MAX_SCOPE_IDENTITIES - 1}`);
  });

  test("caps the owner-gate members at the same number", () => {
    const members = Array.from({ length: MAX_SCOPE_IDENTITIES + 3 }, (_v, i) => `u${i}`);
    const scope = parseScope({ identities: identities(1), ownerGate: { activeMemberExternalIds: members } });
    expect(scope.ownerGate?.activeMemberExternalIds).toHaveLength(MAX_SCOPE_IDENTITIES);
  });

  test("leaves a normal-sized scope untouched", () => {
    const identities = [{ userExternalId: "u", family: "f", sessionId: "s" }];
    expect(parseScope({ identities }).identities).toHaveLength(1);
  });
});

describe("embed daily budget helpers (M-9e)", () => {
  test("estimateEmbedTokens is ~ceil(len/4) summed", () => {
    expect(estimateEmbedTokens([])).toBe(0);
    expect(estimateEmbedTokens(["abcd"])).toBe(1);
    expect(estimateEmbedTokens(["abcde"])).toBe(2);
    expect(estimateEmbedTokens(["abcd", "abcd"])).toBe(2);
  });

  test("isEmbedBudgetExceeded gates only at/over a positive budget", () => {
    expect(isEmbedBudgetExceeded(4_999_999, 5_000_000)).toBe(false);
    expect(isEmbedBudgetExceeded(5_000_000, 5_000_000)).toBe(true);
    expect(isEmbedBudgetExceeded(6_000_000, 5_000_000)).toBe(true);
    // 0 (or negative) budget ⇒ unlimited, never exceeded.
    expect(isEmbedBudgetExceeded(10_000_000, 0)).toBe(false);
  });
});
