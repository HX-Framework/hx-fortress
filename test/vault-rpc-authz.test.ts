import { describe, expect, test } from "bun:test";

import {
  handleVaultRpc,
  isVaultWriteMethod,
  vaultRpcPurpose,
} from "../src/modules/session-vault/store/rpc";
import type { SessionStore } from "../src/modules/session-vault/store/types";

const key = (userId: string) => ({ userId, family: "claude", sessionId: "s1" });
const signed = { url: "u", objectName: "o", expiresAt: "e" };

describe("handleVaultRpc H-4 principal binding", () => {
  test("a WRITE rejects when key.userId != grant.sub (never touches the store)", async () => {
    const store = {
      async signStagingUpload() {
        throw new Error("must not run");
      },
    } as unknown as SessionStore;
    await expect(
      handleVaultRpc(store, { method: "signStagingUpload", key: key("owner"), chunkId: "c1" }, null, {
        sub: "attacker",
      }),
    ).rejects.toThrow("principal_object_mismatch");
  });

  test("a WRITE runs when key.userId == grant.sub", async () => {
    let ran = false;
    const store = {
      async signStagingUpload() {
        ran = true;
        return signed;
      },
    } as unknown as SessionStore;
    const res = await handleVaultRpc(
      store,
      { method: "signStagingUpload", key: key("owner"), chunkId: "c1" },
      null,
      { sub: "owner" },
    );
    expect(ran).toBe(true);
    expect(res.method).toBe("signStagingUpload");
  });

  test("with NO authz (compat window) the binding check is skipped", async () => {
    let ran = false;
    const store = {
      async signStagingUpload() {
        ran = true;
        return signed;
      },
    } as unknown as SessionStore;
    await handleVaultRpc(store, { method: "signStagingUpload", key: key("anyone"), chunkId: "c1" }, null);
    expect(ran).toBe(true);
  });

  test("a list READ binds its userId to grant.sub", async () => {
    const store = {
      async listSessionMetadata() {
        return [];
      },
    } as unknown as SessionStore;
    await expect(
      handleVaultRpc(store, { method: "listSessionMetadata", userId: "victim" }, null, {
        sub: "attacker",
      }),
    ).rejects.toThrow("principal_object_mismatch");
  });

  test("selfTest is never gated (no object) even with authz present", async () => {
    let ran = false;
    const store = {
      async selfTest() {
        ran = true;
      },
    } as unknown as SessionStore;
    await handleVaultRpc(store, { method: "selfTest" }, null, { sub: "whoever" });
    expect(ran).toBe(true);
  });
});

describe("vault method purpose mapping", () => {
  test("writes vs reads", () => {
    expect(isVaultWriteMethod("appendChunkToCanonical")).toBe(true);
    expect(isVaultWriteMethod("ingestAgentCommit")).toBe(true);
    expect(isVaultWriteMethod("readCanonical")).toBe(false);
    expect(vaultRpcPurpose("ingestCommit")).toBe("ingest");
    expect(vaultRpcPurpose("readArtifactText")).toBe("read");
    expect(vaultRpcPurpose("selfTest")).toBe("read");
  });
});
