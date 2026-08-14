import { afterEach, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { startGatewayServer, type GatewayHandle } from "../../src/gateway/server";
import type { SessionStore } from "../../src/modules/session-vault/store/types";

const silentLogger = { info() {}, error() {} };

async function keyAndToken(claims: Record<string, unknown>) {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  const rawB64url = (await exportJWK(publicKey)).x as string;
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  return { rawB64url, token };
}

function startWith(store: SessionStore, rawB64url: string): GatewayHandle {
  return startGatewayServer({
    port: 0,
    logger: silentLogger,
    signingKey: async () => rawB64url,
    ownOrgId: async () => "org_1",
    store: () => store,
    postgresReady: () => true,
    db: () => null,
    dbRead: () => null,
  });
}

describe("gateway C-1 principal binding", () => {
  let handle: GatewayHandle | null = null;
  afterEach(() => {
    handle?.stop();
    handle = null;
  });

  test("rejects a body.userId that disagrees with the token sub (403)", async () => {
    // A v1 token (no aud/purpose) with sub=attacker; body names a different owner.
    const { rawB64url, token } = await keyAndToken({ org: "org_1", repo: "*", sub: "attacker" });
    // The store is never reached — the mismatch short-circuits before the switch.
    handle = startWith({} as SessionStore, rawB64url);
    const res = await fetch(`http://localhost:${handle.port}/sessions/commit`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ userId: "victim", family: "claude", sessionId: "s1", chunkId: "c1" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "principal_object_mismatch" });
  });

  test("derives the object owner from the token sub, ignoring an absent body.userId", async () => {
    const { rawB64url, token } = await keyAndToken({ org: "org_1", repo: "*", sub: "author_1" });
    const captured: { userId?: string } = {};
    const store = {
      async signStagingUpload(key: { userId: string }) {
        captured.userId = key.userId;
        return { url: "https://signed", objectName: "obj", expiresAt: "2026-01-01T00:00:00Z" };
      },
    } as unknown as SessionStore;
    handle = startWith(store, rawB64url);
    const res = await fetch(`http://localhost:${handle.port}/sessions/append-url`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ family: "claude", sessionId: "s1", chunkId: "c1" }),
    });
    expect(res.status).toBe(200);
    expect(captured.userId).toBe("author_1");
  });

  test("rejects a token with no sub on an object route (403 principal_required)", async () => {
    const { rawB64url, token } = await keyAndToken({ org: "org_1", repo: "*" }); // no sub
    handle = startWith({} as SessionStore, rawB64url);
    const res = await fetch(`http://localhost:${handle.port}/sessions`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "principal_required" });
  });
});
