import { describe, expect, test } from "bun:test";

import { hashFortressScope, type McpTunnelRequest, type McpTunnelResult } from "../src/protocol";
import { checkScopeGrant } from "../src/mcp/tools";
import { createMcpTunnelHandler, type McpTunnelDeps } from "../src/mcp/tunnel-handler";
import type { GrantClaims } from "../src/gateway/capability-token";

const SCOPE = { identities: [{ userExternalId: "u1", family: "claude", sessionId: "s1" }] };
const HASH = hashFortressScope(SCOPE);

function readGrant(over: Partial<GrantClaims> = {}): GrantClaims {
  return { v: 2, purpose: "read", org: "org_1", aud: "org_1", sub: "u1", scopeHash: HASH, ...over };
}

/** Drive the tunnel handler and narrow to the callTool result these tests assert on. */
async function callTool(
  deps: McpTunnelDeps,
  req: Extract<McpTunnelRequest, { method: "callTool" }>,
): Promise<{ content: string; isError?: boolean }> {
  const res: McpTunnelResult = await createMcpTunnelHandler(deps).handle(req);
  if (res.method !== "callTool") throw new Error("expected a callTool result");
  return res;
}

describe("checkScopeGrant", () => {
  test("passes when the args scope hashes to the grant scopeHash", () => {
    expect(checkScopeGrant({ scope: SCOPE }, readGrant(), false)).toBeNull();
  });

  test("fails scope_not_granted when the args scope does not match the grant", () => {
    const other = { identities: [{ userExternalId: "u2", family: "claude", sessionId: "s2" }] };
    const gate = checkScopeGrant({ scope: other }, readGrant(), false);
    expect(gate?.isError).toBe(true);
    expect(gate?.content[0]?.text).toContain("scope_not_granted");
  });

  test("no grant: enforce → grant_required, otherwise admitted", () => {
    expect(checkScopeGrant({ scope: SCOPE }, undefined, false)).toBeNull();
    const gate = checkScopeGrant({ scope: SCOPE }, undefined, true);
    expect(gate?.isError).toBe(true);
    // Absent grant under enforcement uses the unified `grant_required` code,
    // distinct from the scope-mismatch `scope_not_granted` above.
    expect(gate?.content[0]?.text).toContain("grant_required");
  });
});

describe("createMcpTunnelHandler grant binding", () => {
  const baseDeps: McpTunnelDeps = {
    db: () => null,
    store: () => null,
    verifyGrant: async (): Promise<GrantClaims> => readGrant(),
  };

  test("scopeHash mismatch → scope_not_granted (tool never runs)", async () => {
    const res = await callTool(baseDeps, {
      method: "callTool",
      name: "hx_sessions_list",
      arguments: { scope: { identities: [{ userExternalId: "uX", family: "c", sessionId: "sX" }] } },
      userId: "u1",
      grant: "GRANT",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("scope_not_granted");
  });

  test("scopeHash match → gate admits the call (postgres_not_ready proves it ran)", async () => {
    const res = await callTool(baseDeps, {
      method: "callTool",
      name: "hx_sessions_list",
      arguments: { scope: SCOPE },
      userId: "u1",
      grant: "GRANT",
    });
    // db() is null → the tool's own needDb guard returns postgres_not_ready, which
    // can only happen if the scope gate ADMITTED the call.
    expect(res.content).toContain("postgres_not_ready");
  });

  test("grant sub != req.userId → principal_object_mismatch", async () => {
    const res = await callTool(
      { ...baseDeps, verifyGrant: async () => readGrant({ sub: "someone_else" }) },
      { method: "callTool", name: "hx_sessions_list", arguments: { scope: SCOPE }, userId: "u1", grant: "GRANT" },
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("principal_object_mismatch");
  });

  test("a present grant with no verifier fails closed", async () => {
    const res = await callTool(
      { db: () => null, store: () => null },
      { method: "callTool", name: "hx_sessions_list", arguments: { scope: SCOPE }, userId: "u1", grant: "GRANT" },
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("unauthorized");
  });

  test("a grant-less read is denied under FORTRESS_TUNNEL_GRANT_ENFORCE", async () => {
    const prior = process.env.FORTRESS_TUNNEL_GRANT_ENFORCE;
    process.env.FORTRESS_TUNNEL_GRANT_ENFORCE = "1";
    try {
      const res = await callTool(baseDeps, {
        method: "callTool",
        name: "hx_sessions_list",
        arguments: { scope: SCOPE },
        userId: "u1",
      });
      expect(res.isError).toBe(true);
      // Absent grant under enforcement → the unified `grant_required` code.
      expect(res.content).toContain("grant_required");
    } finally {
      if (prior === undefined) delete process.env.FORTRESS_TUNNEL_GRANT_ENFORCE;
      else process.env.FORTRESS_TUNNEL_GRANT_ENFORCE = prior;
    }
  });
});
