/**
 * MC-2289 E2E: hx → Fortress gateway → bucket, end to end.
 *
 * Stands up the real gateway server with a mock session_vault store that
 * presigns to a local "bucket" HTTP server. A capability token is minted with a
 * private key whose public half the gateway holds (as the hub would push it over
 * the tunnel). We then drive the same 3-step contract hx uses — append-url → PUT
 * → commit — and assert the bytes land in the bucket and the canonical composes.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { startGatewayServer, type GatewayHandle } from "../../src/gateway/server";
import type { SessionStore } from "../../src/modules/session-vault/store/types";

const silentLogger = { info() { }, error() { } };

async function mintKeyAndToken(claims: Record<string, unknown>) {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  const jwk = await exportJWK(publicKey);
  const publicKeyB64url = jwk.x as string;
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  return { publicKeyB64url, token };
}

let gateway: GatewayHandle | null = null;
let bucket: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
  gateway?.stop();
  gateway = null;
  bucket?.stop(true);
  bucket = null;
});

describe("hx → Fortress gateway → bucket", () => {
  test(
    "append-url presigns to the bucket, PUT lands the object, commit composes",
    async () => {
      // The local bucket: stores whatever is PUT, serves it back on GET.
      const objects = new Map<string, string>();
      bucket = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(req) {
          const url = new URL(req.url);
          if (req.method === "PUT") {
            objects.set(url.pathname, await req.text());
            return new Response(null, { status: 200 });
          }
          const body = objects.get(url.pathname);
          return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
        },
      });
      const bucketBase = `http://127.0.0.1:${bucket.port}`;

      const composed: string[] = [];
      const store: SessionStore = {
        signStagingUpload: async (_key, chunkId) => ({
          url: `${bucketBase}/staging/${chunkId}`,
          objectName: `staging/${chunkId}`,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        }),
        readChunkText: async (_key, chunkId) => objects.get(`/staging/${chunkId}`) ?? "",
        appendChunkToCanonical: async (_key, chunkId) => {
          const bytes = objects.get(`/staging/${chunkId}`) ?? "";
          composed.push(bytes);
          return { totalBytes: composed.join("").length, componentCount: composed.length };
        },
        statCanonical: async () => null,
        signCanonicalDownload: async () => ({ url: `${bucketBase}/canonical`, expiresAt: "z" }),
        readCanonicalText: async () => composed.join(""),
        writeCanonicalText: async (_key, text) => {
          composed.length = 0;
          composed.push(text);
        },
        writeArtifact: async () => { },
        readArtifactText: async () => null,
        listSessionArtifacts: async () => [],
        listSessionMetadata: async () => [],
        selfTest: async () => { },
        deleteSession: async () => ({ complete: true, deleted: 0 }),
        listAllCanonicalKeys: async () => [],
        getBucketVersioning: async () => "Enabled",
        getLifecycle: async () => "no lifecycle rules",
      };

      const { publicKeyB64url, token } = await mintKeyAndToken({
        org: "org_1",
        repo: "acme/app",
        sub: "u1",
      });

      const port = 8000 + Math.floor(Math.random() * 1000);
      gateway = startGatewayServer({
        port,
        logger: silentLogger,
        signingKey: async () => publicKeyB64url,
        store: () => store,
        postgresReady: () => true,
        db: () => null,
        dbRead: () => null,
      });
      const base = `http://127.0.0.1:${port}`;
      const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

      // 1. append-url
      const appendRes = await fetch(`${base}/sessions/append-url`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ family: "claude-cli", sessionId: "s1", chunkId: "c1" }),
      });
      expect(appendRes.status).toBe(200);
      const append = (await appendRes.json()) as { uploadUrl: string; chunkId: string };
      expect(append.uploadUrl).toBe(`${bucketBase}/staging/c1`);

      // 2. PUT bytes straight to the bucket
      const put = await fetch(append.uploadUrl, { method: "PUT", body: "line-1\nline-2\n" });
      expect(put.status).toBe(200);
      expect(objects.get("/staging/c1")).toBe("line-1\nline-2\n");

      // 3. commit composes the canonical
      const commitRes = await fetch(`${base}/sessions/commit`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ family: "claude-cli", sessionId: "s1", chunkId: "c1" }),
      });
      expect(commitRes.status).toBe(200);
      const commit = (await commitRes.json()) as { ok: boolean; totalBytes: number };
      expect(commit.ok).toBe(true);
      expect(commit.totalBytes).toBe("line-1\nline-2\n".length);
    },
    10_000,
  );

  test(
    "lists lightweight session metadata for the authenticated user",
    async () => {
      const store: SessionStore = {
        signStagingUpload: async () => ({
          url: "http://127.0.0.1/upload",
          objectName: "staging/c1",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        }),
        readChunkText: async () => "",
        appendChunkToCanonical: async () => ({ totalBytes: 0, componentCount: 1 }),
        statCanonical: async () => null,
        signCanonicalDownload: async () => ({ url: "http://127.0.0.1/download", expiresAt: "z" }),
        readCanonicalText: async () => "",
        writeCanonicalText: async () => { },
        writeArtifact: async () => { },
        readArtifactText: async () => null,
        listSessionArtifacts: async () => [],
        listSessionMetadata: async () => [
          {
            family: "codex-cli",
            sessionId: "sess-1",
            title: "Fix merged session list",
            titleSource: "user",
            bytesUploaded: 321,
            eventCount: 14,
            userTextCount: 4,
            assistantCount: 5,
            lastActivityAt: "2026-06-18T10:00:00.000Z",
            firstSeenAt: "2026-06-18T09:00:00.000Z",
            updatedAt: "2026-06-18T10:00:00.000Z",
            cwd: "/work/app",
            gitBranch: "feat/mc-2324",
            sourcePath: "/tmp/session.jsonl",
            repoSlug: "let-ai/let-forge",
            deviceName: "MacBook Pro",
          },
        ],
        selfTest: async () => { },
        deleteSession: async () => ({ complete: true, deleted: 0 }),
        listAllCanonicalKeys: async () => [],
        getBucketVersioning: async () => "Enabled",
        getLifecycle: async () => "no lifecycle rules",
      };

      const { publicKeyB64url, token } = await mintKeyAndToken({
        org: "org_1",
        repo: "acme/app",
        sub: "u1",
      });

      const port = 8100 + Math.floor(Math.random() * 1000);
      gateway = startGatewayServer({
        port,
        logger: silentLogger,
        signingKey: async () => publicKeyB64url,
        store: () => store,
        postgresReady: () => true,
        db: () => null,
        dbRead: () => null,
      });

      const res = await fetch(`http://127.0.0.1:${port}/sessions`, {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        sessions: [
          {
            family: "codex-cli",
            sessionId: "sess-1",
            title: "Fix merged session list",
            titleSource: "user",
            bytesUploaded: 321,
            eventCount: 14,
            userTextCount: 4,
            assistantCount: 5,
            lastActivityAt: "2026-06-18T10:00:00.000Z",
            firstSeenAt: "2026-06-18T09:00:00.000Z",
            updatedAt: "2026-06-18T10:00:00.000Z",
            cwd: "/work/app",
            gitBranch: "feat/mc-2324",
            sourcePath: "/tmp/session.jsonl",
            repoSlug: "let-ai/let-forge",
            deviceName: "MacBook Pro",
          },
        ],
      });
    },
    10_000,
  );

  test(
    "rejects a request with no capability token",
    async () => {
      const port = 9000 + Math.floor(Math.random() * 1000);
      gateway = startGatewayServer({
        port,
        logger: silentLogger,
        signingKey: async () => "anything",
        store: () => null,
        postgresReady: () => true,
        db: () => null,
        dbRead: () => null,
      });
      const res = await fetch(`http://127.0.0.1:${port}/sessions/append-url`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(401);
    },
    10_000,
  );
});
