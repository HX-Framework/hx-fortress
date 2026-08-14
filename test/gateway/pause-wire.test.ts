import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { startGatewayServer, type GatewayHandle } from "../../src/gateway/server";
import { IngestQuiesce, PauseGatedStore } from "../../src/console/pause-gate";
import { PauseState } from "../../src/console/ingest-control";
import { handleVaultRpc } from "../../src/modules/session-vault/store/rpc";
import type { SessionStore } from "../../src/modules/session-vault/store/types";

const ORG = "org_pause";
const PAUSED_UNTIL = new Date(Date.now() + 120_000);

/** A store that would happily serve everything — so a refusal can only come
 *  from the gate, never from the backend. */
const permissiveStore = {
  signStagingUpload: async () => ({ url: "u", objectName: "o", expiresAt: "e" }),
  readChunkText: async () => "",
  appendChunkToCanonical: async () => ({ totalBytes: 1, componentCount: 1 }),
  readArtifactText: async () => "{}",
  writeArtifact: async () => {},
  statCanonical: async () => 1,
  deleteSession: async () => ({ complete: true, deleted: 0 }),
  selfTest: async () => {},
} as unknown as SessionStore;

function gated(): SessionStore {
  const state = new PauseState();
  state.observe({ pausedUntil: PAUSED_UNTIL, capped: false });
  return new PauseGatedStore(permissiveStore, state, new IngestQuiesce());
}

describe("the gateway wire shape while paused", () => {
  let handle: GatewayHandle;
  let privateKey: CryptoKey;
  let rawB64url: string;
  const errors: string[] = [];

  beforeEach(async () => {
    errors.length = 0;
    const kp = await generateKeyPair("EdDSA", { extractable: true });
    privateKey = kp.privateKey;
    rawB64url = (await exportJWK(kp.publicKey)).x as string;
    handle = startGatewayServer({
      port: 0,
      logger: { info() {}, error: (msg) => errors.push(msg) },
      signingKey: async () => rawB64url,
      ownOrgId: async () => ORG,
      store: gated,
      postgresReady: () => true,
      db: () => null,
      dbRead: () => null,
    });
  });
  afterEach(() => handle.stop());

  async function token(purpose: "ingest" | "read"): Promise<string> {
    return new SignJWT({ v: 2, purpose, org: ORG, aud: ORG, repo: "*", sub: "user_1" })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  }

  async function post(pathname: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`http://localhost:${handle.port}${pathname}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await token("ingest")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  test("all four ingest routes answer the SHIPPED offline shape, byte for byte", async () => {
    const routes: Array<[string, Record<string, unknown>]> = [
      ["/sessions/append-url", { family: "f", sessionId: "s", chunkId: "c" }],
      ["/sessions/commit", { family: "f", sessionId: "s", chunkId: "c" }],
      ["/sessions/agent-append-url", { family: "f", sessionId: "s", agentId: "a", chunkId: "c" }],
      ["/sessions/agent-commit", { family: "f", sessionId: "s", agentId: "a", chunkId: "c" }],
    ];
    for (const [pathname, body] of routes) {
      const res = await post(pathname, body);
      expect(res.status).toBe(503);
      // Byte-identical to the shape a store-less fortress already returns, so a
      // shipped hx client parks the job instead of surfacing a fault.
      expect(await res.text()).toBe('{"error":"vault_offline"}');
      // The pause detail rides a HEADER only — never a body field the client parses.
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    }
  });

  test("a paused request produces no error-level log line", async () => {
    await post("/sessions/commit", { family: "f", sessionId: "s", chunkId: "c" });
    expect(errors).toEqual([]);
  });

  test("artifact reads keep working while paused", async () => {
    const res = await fetch(`http://localhost:${handle.port}/sessions/artifact`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await token("read")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ family: "f", sessionId: "s", name: "session.json" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("the tunnel wire literal while paused", () => {
  test("carries vault_offline first and the deadline as its detail", async () => {
    const store = gated();
    const err = await handleVaultRpc(store, {
      method: "appendChunkToCanonical",
      key: { userId: "u", family: "f", sessionId: "s" },
      chunkId: "c",
    }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      `vault_offline:ingest_paused:${PAUSED_UNTIL.toISOString()}`,
    );
  });

  test("deleteSession is gated AHEAD of the tombstone and the Postgres purge", async () => {
    const store = gated();
    // With no db handle the RPC would normally fail `postgres_not_ready`; the
    // pause pre-check has to fire FIRST, or an irreversible purge would run
    // inside the window a migration is holding still.
    const err = await handleVaultRpc(store, {
      method: "deleteSession",
      key: { userId: "u", family: "f", sessionId: "s" },
    }).catch((e: unknown) => e as Error);
    expect((err as Error).message).toStartWith("vault_offline:ingest_paused:");
  });
});
