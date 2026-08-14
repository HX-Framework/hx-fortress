import { describe, it, expect } from "bun:test";
import { handleAppendUrl, handleCommit, handleListSessionMetadata } from "../../src/gateway/handlers";
import { metadataFromCanonicalObjectName } from "../../src/modules/session-vault/store/session-metadata";
import { BUCKET_CONFIG_UNAVAILABLE } from "../../src/modules/session-vault/store/types";
import type { SessionMetadata, SessionStore } from "../../src/modules/session-vault/store/types";

const SAMPLE_METADATA: SessionMetadata[] = [
  {
    family: "codex-cli",
    sessionId: "s1",
    title: "Fix merged session list",
    titleSource: "user",
    bytesUploaded: 42,
    eventCount: 7,
    userTextCount: 2,
    assistantCount: 3,
    lastActivityAt: "2026-06-18T10:00:00.000Z",
    firstSeenAt: "2026-06-18T09:00:00.000Z",
    updatedAt: "2026-06-18T10:00:00.000Z",
    cwd: "/work/app",
    gitBranch: "feat/mc-2324",
    sourcePath: "/tmp/session.jsonl",
    repoSlug: "let-ai/let-forge",
    deviceName: "MacBook Pro",
  },
];

function fakeStore(overrides: Partial<SessionStore> = {}): SessionStore {
  const base: SessionStore = {
    signStagingUpload: async () => ({
      url: "https://bucket.example/presigned",
      objectName: "obj/abc",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }),
    readChunkText: async () => "",
    appendChunkToCanonical: async () => ({ totalBytes: 42, componentCount: 2 }),
    statCanonical: async () => null,
    signCanonicalDownload: async () => ({
      url: "https://bucket.example/canonical",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }),
    readCanonicalText: async () => "",
    writeCanonicalText: async () => {},
    writeArtifact: async () => {},
    readArtifactText: async () => null,
    listSessionArtifacts: async () => [],
    listSessionMetadata: async () => SAMPLE_METADATA,
    selfTest: async () => {},
    getBucketVersioning: async () => BUCKET_CONFIG_UNAVAILABLE,
    getLifecycle: async () => BUCKET_CONFIG_UNAVAILABLE,
    deleteSession: async () => ({ complete: true, deleted: 0 }),
    listAllCanonicalKeys: async () => [],
  };
  return { ...base, ...overrides };
}

describe("handleAppendUrl", () => {
  it("returns the presigned upload URL from the store", async () => {
    const res = await handleAppendUrl(fakeStore(), {
      userId: "u1",
      family: "claude",
      sessionId: "s1",
      chunkId: "c1",
    });
    expect(res.uploadUrl).toBe("https://bucket.example/presigned");
    expect(res.objectName).toBe("obj/abc");
    expect(res.chunkId).toBe("c1");
  });
});

describe("handleCommit", () => {
  it("composes the chunk and returns totals", async () => {
    const res = await handleCommit(fakeStore(), {
      userId: "u1",
      family: "claude",
      sessionId: "s1",
      chunkId: "c1",
    });
    expect(res.ok).toBe(true);
    expect(res.totalBytes).toBe(42);
    expect(res.componentCount).toBe(2);
  });
});

describe("handleListSessionMetadata", () => {
  it("returns lightweight metadata for one user", async () => {
    const res = await handleListSessionMetadata(fakeStore(), { userId: "u1" });
    expect(res.sessions).toEqual(SAMPLE_METADATA);
  });
});

describe("metadataFromCanonicalObjectName", () => {
  it("derives lightweight metadata for canonical logs without a session sidecar", () => {
    expect(
      metadataFromCanonicalObjectName(
        "u1",
        "u1/claude-cli/s1/log.jsonl",
        42,
        "2026-06-18T12:00:00.000Z",
      ),
    ).toEqual({
      family: "claude-cli",
      sessionId: "s1",
      title: null,
      titleSource: null,
      bytesUploaded: 42,
      eventCount: 0,
      userTextCount: 0,
      assistantCount: 0,
      lastActivityAt: "2026-06-18T12:00:00.000Z",
      firstSeenAt: "2026-06-18T12:00:00.000Z",
      updatedAt: "2026-06-18T12:00:00.000Z",
      cwd: null,
      gitBranch: null,
      sourcePath: null,
      repoSlug: null,
      deviceName: null,
    });
  });
});
