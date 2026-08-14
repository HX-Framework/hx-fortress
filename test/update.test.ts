import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";

import { downloadBaseFromCloudUrl, runFortressUpdate } from "../src/update";
import { FORTRESS_VERSION } from "../src/version";

describe("downloadBaseFromCloudUrl", () => {
  test("converts wss:// cloud URL to https:// download base", () => {
    expect(
      downloadBaseFromCloudUrl("wss://workbench.let.ai/_api/hx-gateway/vault-tunnel"),
    ).toBe("https://workbench.let.ai/_api/hx-gateway/download");
  });

  test("converts ws:// cloud URL to http:// download base", () => {
    expect(
      downloadBaseFromCloudUrl("ws://localhost:9000/workbench/_api/hx-gateway/vault-tunnel"),
    ).toBe("http://localhost:9000/workbench/_api/hx-gateway/download");
  });
});

describe("runFortressUpdate", () => {
  let root: string;
  let binPath: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-update-"));
    binPath = path.join(root, "hx-fortress");
    await writeFile(binPath, Buffer.from("old binary"));
    await chmod(binPath, 0o755);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("returns alreadyLatest when remote version is not newer", async () => {
    const result = await runFortressUpdate({
      downloadBaseUrl: mockDownloadBase({ remoteVersion: FORTRESS_VERSION }),
      binPath,
    });

    expect(result.alreadyLatest).toBe(true);
    expect(result.localVersion).toBe(FORTRESS_VERSION);
    expect(result.remoteVersion).toBe(FORTRESS_VERSION);
    expect(result.sha256).toBeNull();
  });

  test("ignores prerelease remote versions during the pre-check", async () => {
    const result = await runFortressUpdate({
      downloadBaseUrl: mockDownloadBase({ remoteVersion: "0.1.2-rc.1" }),
      binPath,
    });

    expect(result.alreadyLatest).toBe(true);
    expect(result.localVersion).toBe(FORTRESS_VERSION);
    expect(result.remoteVersion).toBeNull();
  });

  test("downloads and installs a newer binary", async () => {
    const newBinary = Buffer.from("new fortress binary content");
    const sha256 = createHash("sha256").update(newBinary).digest("hex");
    const gzipped = gzipSync(newBinary);

    const progEvents: Array<{ phase: string; pct: number }> = [];
    const logs: string[] = [];

    const result = await runFortressUpdate({
      downloadBaseUrl: mockDownloadBase({
        remoteVersion: FORTRESS_VERSION + 1,
        binary: gzipped,
        sha256,
      }),
      binPath,
      log: (msg) => logs.push(msg),
      onProgress: (ev) => progEvents.push({ phase: ev.phase, pct: ev.pct }),
    });

    expect(result.alreadyLatest).toBe(false);
    expect(result.sha256).toBe(sha256);
    expect(result.installedPath).toBe(binPath);
    expect(result.remoteVersion).toBe(FORTRESS_VERSION + 1);

    expect(progEvents.some((e) => e.phase === "download")).toBe(true);
    expect(progEvents.some((e) => e.phase === "unpack")).toBe(true);
    expect(progEvents.some((e) => e.phase === "verify" && e.pct === 100)).toBe(true);

    expect(logs.some((l) => l.includes("installed →"))).toBe(true);
  });

  test("throws on checksum mismatch", async () => {
    const newBinary = Buffer.from("another binary");
    const gzipped = gzipSync(newBinary);

    await expect(
      runFortressUpdate({
        downloadBaseUrl: mockDownloadBase({
          remoteVersion: FORTRESS_VERSION + 1,
          binary: gzipped,
          sha256: "a".repeat(64), // wrong checksum
        }),
        binPath,
      }),
    ).rejects.toThrow("checksum mismatch");
  });
});

// ── test helpers ──────────────────────────────────────────────────────────────

interface MockDownloadBaseOpts {
  remoteVersion?: string;
  binary?: Buffer;
  sha256?: string;
}

function mockDownloadBase(opts: MockDownloadBaseOpts): string {
  const { remoteVersion = FORTRESS_VERSION, binary, sha256 } = opts;

  const assets: Record<string, { blob: Blob; contentType: string }> = {
    "hx-fortress-version": {
      blob: new Blob([String(remoteVersion)]),
      contentType: "text/plain",
    },
  };

  if (binary) {
    const p = process.platform === "darwin" ? "darwin" : "linux";
    const a = process.arch === "arm64" ? "arm64" : "x64";
    const assetName = `hx-fortress-${p}-${a}`;
    assets[`${assetName}.gz`] = {
      blob: new Blob([binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength) as ArrayBuffer]),
      contentType: "application/octet-stream",
    };
    assets[`${assetName}.sha256`] = {
      blob: new Blob([`${sha256 ?? ""}  ${assetName}`]),
      contentType: "text/plain",
    };
  }

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const assetKey = url.pathname.split("/").pop() ?? "";
      const asset = assets[assetKey];
      if (!asset) {
        return new Response("not found", { status: 404 });
      }
      return new Response(asset.blob, {
        headers: { "content-type": asset.contentType },
      });
    },
  });

  return `http://localhost:${server.port}`;
}
