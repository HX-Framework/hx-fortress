/**
 * MC-2269 / T16: End-to-end verify the session_vault module against the hub.
 *
 * Wire-compat decision (T16):
 *   The Fortress protocol (FortressToHubFrame / HubToFortressFrame) is NOT
 *   wire-compatible with the old vault protocol (VaultToHubFrame / HubToVaultFrame)
 *   that the current workbench vault-tunnel.ts speaks. T22 (hub generalization) is
 *   therefore a prerequisite for live-workbench E2E. This file uses the loopback
 *   FakeHub (speaks the new protocol) to cover the full functional path in CI.
 */

import { describe, expect, test } from "bun:test";
import { SUPPORTED_PROTOCOL_VERSION, WsCloudConnection } from "../src/cloud/connection";
import type { CloudCredential } from "../src/cloud/credentials";
import { LogBus } from "../src/host/logging";
import { ModuleRegistry } from "../src/host/module-registry";
import type { FortressConfig, HostLogger, Module } from "../src/host/types";
import { handleVaultRpc, type VaultRpcRequest } from "../src/modules/session-vault/store/rpc";
import type { SessionStore } from "../src/modules/session-vault/store/types";
import type { FortressToHubFrame } from "../src/protocol";
import { FakeHub } from "./fake-hub";

// ── constants ────────────────────────────────────────────────────────────────

const TEST_TIMING = { heartbeatMs: 20, reconnectMinMs: 10, reconnectMaxMs: 50 };
const IDENTITY = { version: "0.0.0-test", protocolVersion: SUPPORTED_PROTOCOL_VERSION };
const SESSION_KEY = { userId: "u1", family: "f1", sessionId: "s1" };
const BASE_CONFIG: Omit<FortressConfig, "cloud"> = {
  schemaVersion: 1,
  gateway: { publicUrl: "http://localhost:8787" },
  modules: { enabled: ["session_vault"] },
};
const TEST_TIMEOUT = 5_000;

// ── helpers ──────────────────────────────────────────────────────────────────

function silentLogger(): HostLogger {
  return { error() {} };
}

function silentBus(): LogBus {
  return new LogBus({ write: () => {} });
}

function makeCredentialStore(initial: CloudCredential | null = null) {
  let stored = initial;
  return {
    async load(): Promise<CloudCredential | null> {
      return stored;
    },
    async save(cred: CloudCredential): Promise<void> {
      stored = cred;
    },
    get stored(): CloudCredential | null {
      return stored;
    },
  };
}

function createMockStore(overrides: Partial<SessionStore> = {}): SessionStore {
  return {
    signStagingUpload: async (_key, chunkId) => ({
      url: `https://mock-storage.test/staging/${chunkId}`,
      objectName: `staging/${chunkId}`,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }),
    readChunkText: async () => "chunk-text-content",
    getBucketVersioning: async () => "Enabled",
    getLifecycle: async () => "no lifecycle rules",
    appendChunkToCanonical: async () => ({ totalBytes: 128, componentCount: 2 }),
    signCanonicalDownload: async () => ({
      url: "https://mock-storage.test/canonical",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }),
    readCanonicalText: async () => "canonical-text-content",
    statCanonical: async () => 1024,
    writeCanonicalText: async () => {},
    writeArtifact: async () => {},
    readArtifactText: async () => "artifact-text-content",
    listSessionArtifacts: async () => ["plan.json"],
    listSessionMetadata: async () => [],
    selfTest: async () => {},
    deleteSession: async () => ({ complete: true, deleted: 0 }),
    listAllCanonicalKeys: async () => [],
    ...overrides,
  };
}

function createVaultModule(store: SessionStore): Module {
  return {
    id: "session_vault",
    async onMessage(data) {
      const req = data.payload as VaultRpcRequest;
      try {
        const result = await handleVaultRpc(store, req);
        return { ok: true, payload: result };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  };
}

/** Race a promise against a timeout; resolves to undefined on timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
}

interface Stack {
  hub: FakeHub;
  conn: WsCloudConnection;
  credStore: ReturnType<typeof makeCredentialStore>;
}

async function buildStack(store = createMockStore()): Promise<Stack> {
  const hub = await FakeHub.create();
  const registry = new ModuleRegistry(silentBus());
  registry.register(createVaultModule(store));
  await registry.startAll(["session_vault"]);

  const credStore = makeCredentialStore();
  const conn = new WsCloudConnection({
    dispatcher: registry,
    credentialStore: credStore,
    logger: silentLogger(),
    identity: IDENTITY,
    enrollToken: "test-enroll-token",
    ...TEST_TIMING,
  });

  return { hub, conn, credStore };
}

/** Run a test with a guaranteed-cleanup stack. Cleanup is best-effort (1 s timeout). */
async function withStack(
  store: SessionStore,
  fn: (stack: Stack) => Promise<void>,
): Promise<void> {
  const stack = await buildStack(store);
  try {
    await fn(stack);
  } finally {
    await withTimeout(stack.conn.close(), 1_000);
    await withTimeout(stack.hub.stop(), 1_000);
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("waitFor timed out");
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

async function waitForReply(
  hub: FakeHub,
  id: string,
  timeoutMs = 300,
): Promise<FortressToHubFrame & { t: "moduleReply" }> {
  await waitFor(
    () => hub.received().some((f) => f.t === "moduleReply" && (f as { id: string }).id === id),
    timeoutMs,
  );
  const frame = hub.received().find(
    (f): f is FortressToHubFrame & { t: "moduleReply" } =>
      f.t === "moduleReply" && (f as { id: string }).id === id,
  );
  if (!frame) throw new Error(`moduleReply id=${id} not found`);
  return frame;
}

function openConn(stack: Stack): Promise<void> {
  return stack.conn.open({ ...BASE_CONFIG, cloud: { url: stack.hub.url } });
}

// ── enrollment ────────────────────────────────────────────────────────────────

describe("enrollment", () => {
  test(
    "fresh vault enrolls and Fortress transitions to connected",
    async () => {
      await withStack(createMockStore(), async (stack) => {
        await openConn(stack);

        expect(stack.conn.state()).toBe("connected");
        expect(stack.hub.received().some((f) => f.t === "enroll")).toBe(true);
        expect(stack.credStore.stored).toEqual({
          orgId: "test-org",
          fortressId: "test-fortress",
          credential: "test-credential",
        });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "enrolled Fortress reconnects with hello (not enroll) when credentials are present",
    async () => {
      await withStack(createMockStore(), async (stack) => {
        await openConn(stack);
        expect(stack.credStore.stored).not.toBeNull();

        // Second connection using the same credential store — must use hello.
        const registry2 = new ModuleRegistry(silentBus());
        registry2.register(createVaultModule(createMockStore()));
        await registry2.startAll(["session_vault"]);

        const conn2 = new WsCloudConnection({
          dispatcher: registry2,
          credentialStore: stack.credStore,
          logger: silentLogger(),
          identity: IDENTITY,
          ...TEST_TIMING,
        });
        await conn2.open({ ...BASE_CONFIG, cloud: { url: stack.hub.url } });

        expect(stack.hub.received().some((f) => f.t === "hello")).toBe(true);
        expect(conn2.state()).toBe("connected");
        await withTimeout(conn2.close(), 1_000);
      });
    },
    TEST_TIMEOUT,
  );
});

// ── RPC methods ───────────────────────────────────────────────────────────────

describe("VaultRpc methods via Fortress + FakeHub", () => {
  async function rpcTest(
    payload: VaultRpcRequest,
    id: string,
    store = createMockStore(),
  ): Promise<FortressToHubFrame & { t: "moduleReply" }> {
    let result!: FortressToHubFrame & { t: "moduleReply" };
    await withStack(store, async (stack) => {
      await openConn(stack);
      stack.hub.send({
        t: "moduleMessage",
        data: { module: "session_vault", id, kind: "request", payload },
      });
      result = await waitForReply(stack.hub, id);
    });
    return result;
  }

  test(
    "selfTest",
    async () => {
      const reply = await rpcTest({ method: "selfTest" }, "rpc-selftest");
      expect(reply.reply).toEqual({ ok: true, payload: { method: "selfTest", value: { ok: true } } });
    },
    TEST_TIMEOUT,
  );

  test(
    "signStagingUpload",
    async () => {
      const reply = await rpcTest(
        { method: "signStagingUpload", key: SESSION_KEY, chunkId: "chunk-1" },
        "rpc-sign-upload",
      );
      expect(reply.reply.ok).toBe(true);
      if (!reply.reply.ok) throw new Error("expected ok");
      const result = reply.reply.payload as { method: string; value: { url: string; objectName: string } };
      expect(result.method).toBe("signStagingUpload");
      expect(result.value.url).toContain("chunk-1");
      expect(result.value.objectName).toContain("chunk-1");
    },
    TEST_TIMEOUT,
  );

  test(
    "readChunkText",
    async () => {
      const reply = await rpcTest(
        { method: "readChunkText", key: SESSION_KEY, chunkId: "chunk-1" },
        "rpc-read-chunk",
      );
      expect(reply.reply).toEqual({
        ok: true,
        payload: { method: "readChunkText", value: "chunk-text-content" },
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "appendChunkToCanonical",
    async () => {
      const reply = await rpcTest(
        { method: "appendChunkToCanonical", key: SESSION_KEY, chunkId: "chunk-1" },
        "rpc-append",
      );
      expect(reply.reply).toEqual({
        ok: true,
        payload: { method: "appendChunkToCanonical", value: { totalBytes: 128, componentCount: 2 } },
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "appendChunkToCanonical with replace flag",
    async () => {
      const reply = await rpcTest(
        { method: "appendChunkToCanonical", key: SESSION_KEY, chunkId: "chunk-1", replace: true },
        "rpc-append-replace",
      );
      expect(reply.reply.ok).toBe(true);
      if (!reply.reply.ok) throw new Error("expected ok");
      expect((reply.reply.payload as { method: string }).method).toBe("appendChunkToCanonical");
    },
    TEST_TIMEOUT,
  );

  test(
    "signCanonicalDownload",
    async () => {
      const reply = await rpcTest(
        { method: "signCanonicalDownload", key: SESSION_KEY },
        "rpc-sign-download",
      );
      expect(reply.reply.ok).toBe(true);
      if (!reply.reply.ok) throw new Error("expected ok");
      const result = reply.reply.payload as { method: string; value: { url: string } };
      expect(result.method).toBe("signCanonicalDownload");
      expect(result.value.url).toBe("https://mock-storage.test/canonical");
    },
    TEST_TIMEOUT,
  );

  test(
    "statCanonical — returns size",
    async () => {
      const reply = await rpcTest({ method: "statCanonical", key: SESSION_KEY }, "rpc-stat");
      expect(reply.reply).toEqual({
        ok: true,
        payload: { method: "statCanonical", value: 1024 },
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "statCanonical — returns null when canonical absent",
    async () => {
      const reply = await rpcTest(
        { method: "statCanonical", key: SESSION_KEY },
        "rpc-stat-null",
        createMockStore({ statCanonical: async () => null }),
      );
      expect(reply.reply).toEqual({
        ok: true,
        payload: { method: "statCanonical", value: null },
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "writeArtifact",
    async () => {
      const reply = await rpcTest(
        { method: "writeArtifact", key: SESSION_KEY, name: "plan.json", text: '{"ok":true}' },
        "rpc-write-artifact",
      );
      expect(reply.reply).toEqual({
        ok: true,
        payload: { method: "writeArtifact", value: { ok: true } },
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "readArtifactText — returns text",
    async () => {
      const reply = await rpcTest(
        { method: "readArtifactText", key: SESSION_KEY, name: "plan.json" },
        "rpc-read-artifact",
      );
      expect(reply.reply).toEqual({
        ok: true,
        payload: { method: "readArtifactText", value: "artifact-text-content" },
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "readArtifactText — returns null when artifact absent",
    async () => {
      const reply = await rpcTest(
        { method: "readArtifactText", key: SESSION_KEY, name: "missing.json" },
        "rpc-read-artifact-null",
        createMockStore({ readArtifactText: async () => null }),
      );
      expect(reply.reply).toEqual({
        ok: true,
        payload: { method: "readArtifactText", value: null },
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "readCanonical — fetches bytes from the signed URL and returns base64",
    async () => {
      const expectedContent = "hello canonical bytes";
      const canonicalServer = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch() {
          return new Response(expectedContent);
        },
      });

      try {
        const canonicalUrl = `http://127.0.0.1:${canonicalServer.port}/canonical`;
        const store = createMockStore({
          signCanonicalDownload: async () => ({
            url: canonicalUrl,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        });

        const reply = await rpcTest(
          { method: "readCanonical", key: SESSION_KEY },
          "rpc-read-canonical",
          store,
        );

        expect(reply.reply.ok).toBe(true);
        if (!reply.reply.ok) throw new Error("expected ok");
        const result = reply.reply.payload as { method: string; value: { base64: string } };
        expect(result.method).toBe("readCanonical");
        expect(Buffer.from(result.value.base64, "base64").toString("utf8")).toBe(expectedContent);
      } finally {
        await canonicalServer.stop(true);
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "error reply when store method throws",
    async () => {
      const reply = await rpcTest(
        { method: "selfTest" },
        "rpc-fail",
        createMockStore({
          selfTest: async () => {
            throw new Error("bucket_unreachable");
          },
        }),
      );
      expect(reply.reply).toEqual({ ok: false, error: "bucket_unreachable" });
    },
    TEST_TIMEOUT,
  );
});

// ── liveness and reconnect ────────────────────────────────────────────────────

describe("liveness and reconnect", () => {
  test(
    "sends heartbeat frames after connecting",
    async () => {
      await withStack(createMockStore(), async (stack) => {
        await openConn(stack);
        await new Promise<void>((r) => setTimeout(r, TEST_TIMING.heartbeatMs * 3));
        const heartbeats = stack.hub.received().filter((f) => f.t === "heartbeat");
        expect(heartbeats.length).toBeGreaterThanOrEqual(2);
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "reconnects after connection drop and delivers RPC after reconnect",
    async () => {
      await withStack(createMockStore(), async (stack) => {
        await openConn(stack);
        expect(stack.conn.state()).toBe("connected");

        const enrollsBefore = stack.hub.received().filter((f) => f.t === "enroll").length;
        stack.hub.dropConnection();

        // Credentials were saved during enrollment so reconnect uses hello.
        await waitFor(
          () => stack.hub.received().some((f) => f.t === "hello"),
          TEST_TIMING.reconnectMinMs * 10 + 200,
        );

        // Must not re-enroll — only hello.
        expect(stack.hub.received().filter((f) => f.t === "enroll").length).toBe(enrollsBefore);

        // Wait for the Fortress to reach connected state again.
        await waitFor(() => stack.conn.state() === "connected", 300);

        // RPC works after reconnect.
        stack.hub.send({
          t: "moduleMessage",
          data: { module: "session_vault", id: "rpc-post-reconnect", kind: "request", payload: { method: "selfTest" } },
        });
        const reply = await waitForReply(stack.hub, "rpc-post-reconnect");
        expect(reply.reply).toEqual({ ok: true, payload: { method: "selfTest", value: { ok: true } } });
      });
    },
    TEST_TIMEOUT,
  );
});
