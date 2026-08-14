import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { startGatewayServer, type GatewayHandle } from "../../src/gateway/server";
import type { SessionMetadata, SessionStore } from "../../src/modules/session-vault/store/types";

const silentLogger = { info() {}, error() {} };

// A stand-in store: readiness only checks for its presence, never calls it.
const fakeStore = {} as SessionStore;

describe("gateway health endpoints", () => {
  let handle: GatewayHandle;
  let storeValue: SessionStore | null;

  beforeEach(() => {
    storeValue = fakeStore;
    handle = startGatewayServer({
      port: 0,
      logger: silentLogger,
      signingKey: async () => null,
      store: () => storeValue,
      postgresReady: () => true,
      db: () => null,
      dbRead: () => null,
    });
  });

  afterEach(() => {
    handle.stop();
  });

  test("/healthz is an unauthenticated liveness probe that is always 200", async () => {
    storeValue = null;
    const res = await fetch(`http://localhost:${handle.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("/readyz returns 200 once the vault store is available", async () => {
    const res = await fetch(`http://localhost:${handle.port}/readyz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ready: true });
  });

  test("/readyz returns 503 while the vault store is offline", async () => {
    storeValue = null;
    const res = await fetch(`http://localhost:${handle.port}/readyz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, ready: false });
  });

  // M-9a · a body over the 4 MiB ceiling is rejected at the HTTP layer (413)
  // before any handler runs, so a single upload can't exhaust memory.
  test("rejects a request body over the size ceiling", async () => {
    const oversized = "x".repeat(5 * 1024 * 1024);
    const res = await fetch(`http://localhost:${handle.port}/sessions/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversized,
    }).catch(() => null);
    // Bun aborts an oversized body with 413 Payload Too Large.
    expect(res?.status).toBe(413);
  });
});

// The HTTP `/sessions` read routes are OWN-OBJECT: a v2 read grant is sub-bound
// with NO scopeHash (the boundary is token principal === object owner). Before the
// requireScope split, verifyGrant demanded a scopeHash on EVERY read grant, so this
// route 403'd under any v2 grant. This confirms it is now satisfiable.
describe("gateway HTTP read route under a v2 own-object read grant", () => {
  let handle: GatewayHandle;
  let rawB64url: string;
  let privateKey: CryptoKey;
  const ORG = "org_http_read";
  const seenUserIds: string[] = [];

  const readStore = {
    async listSessionMetadata(userId: string): Promise<SessionMetadata[]> {
      // Record the resolved principal so the test proves sub → userId threading.
      seenUserIds.push(userId);
      return [];
    },
  } as unknown as SessionStore;

  beforeEach(async () => {
    const kp = await generateKeyPair("EdDSA", { extractable: true });
    privateKey = kp.privateKey;
    rawB64url = (await exportJWK(kp.publicKey)).x as string;
    handle = startGatewayServer({
      port: 0,
      logger: silentLogger,
      signingKey: async () => rawB64url,
      ownOrgId: async () => ORG,
      store: () => readStore,
      postgresReady: () => true,
      db: () => null,
      dbRead: () => null,
    });
  });

  afterEach(() => handle.stop());

  test("GET /sessions accepts a v2 read grant that carries NO scopeHash", async () => {
    // The same bearer is authed (verifyCapabilityToken needs org+repo) AND then
    // verified as a read grant — but it carries NO scopeHash (own-object read).
    const token = await new SignJWT({ v: 2, purpose: "read", org: ORG, aud: ORG, repo: "*", sub: "user_1" })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const res = await fetch(`http://localhost:${handle.port}/sessions`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessions: [] });
    // The route ran under the grant and resolved the principal from the token sub.
    expect(seenUserIds).toContain("user_1");
  });
});
