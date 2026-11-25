import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";

import { runFortressUpdate } from "../src/update";
import { FORTRESS_VERSION, parseStableSemver } from "../src/version";

/** The version after the running one, and one before it. */
const running = parseStableSemver(FORTRESS_VERSION);
if (!running) throw new Error(`this build's version is no plain version: ${FORTRESS_VERSION}`);
const NEWER = `${running.major}.${running.minor}.${running.patch + 1}`;
const OLDER =
  running.patch > 0
    ? `${running.major}.${running.minor}.${running.patch - 1}`
    : running.minor > 0
      ? `${running.major}.${running.minor - 1}.0`
      : `${Math.max(running.major - 1, 0)}.0.0`;

const ASSET = `hx-fortress-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;

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
    await stopSources();
    await rm(root, { recursive: true, force: true });
  });

  /** The program is as it was, and nothing was left beside it. */
  async function nothingWritten(): Promise<void> {
    expect((await readFile(binPath)).toString()).toBe("old binary");
    expect(await readdir(root)).toEqual(["hx-fortress"]);
  }

  test("an update source that is not https is refused before anything is asked of it", async () => {
    // Whoever resolved the address already holds it to this rule. The download
    // holds it again, so no caller can start one over clear text by mistake.
    for (const downloadBaseUrl of ["http://updates.example/hx-fortress", "ftp://updates.example/x", "not an address"]) {
      await expect(runFortressUpdate({ downloadBaseUrl, binPath })).rejects.toThrow("the update source");
    }
    await nothingWritten();
  });

  test("a source with no version file is refused, and no program is asked for", async () => {
    // Before, a missing version file let the download go on: without a version
    // there is no telling an update from a step back.
    const source = mockDownloadBase({ remoteVersion: null, ...newBinary() });
    await expect(runFortressUpdate({ downloadBaseUrl: source.url, binPath })).rejects.toThrow(
      `The update source does not say which version it holds: ${source.url}/hx-fortress-version answered 404`,
    );
    await expect(runFortressUpdate({ downloadBaseUrl: source.url, binPath })).rejects.toThrow("Nothing was installed.");
    expect(source.asked.filter((asked) => asked !== "/hx-fortress-version")).toEqual([]);
    await nothingWritten();
  });

  test("a prerelease is no version to update to: refused, and no program is asked for", async () => {
    // Before, a prerelease answered "already latest".
    const source = mockDownloadBase({ remoteVersion: "0.1.2-rc.1", ...newBinary() });
    await expect(runFortressUpdate({ downloadBaseUrl: source.url, binPath })).rejects.toThrow(
      "The update source does not say which version it holds",
    );
    expect(source.asked).toEqual(["/hx-fortress-version"]);
    await nothingWritten();
  });

  test("a page that is no version is refused, and no program is asked for", async () => {
    const source = mockDownloadBase({ remoteVersion: "<html><body>Sign in</body></html>", ...newBinary() });
    await expect(runFortressUpdate({ downloadBaseUrl: source.url, binPath })).rejects.toThrow(
      "and a version such as 1.2.3 was expected. Nothing was installed.",
    );
    expect(source.asked).toEqual(["/hx-fortress-version"]);
    await nothingWritten();
  });

  test("a source that cannot be reached is refused, and says so", async () => {
    const source = mockDownloadBase({ remoteVersion: NEWER, ...newBinary() });
    await source.stop();
    await expect(runFortressUpdate({ downloadBaseUrl: source.url, binPath })).rejects.toThrow(
      `The update source did not answer when asked which version it holds (${source.url}/hx-fortress-version). ` +
        "Nothing was installed.",
    );
    await nothingWritten();
  });

  test("the same version is already the latest, and no program is asked for", async () => {
    const source = mockDownloadBase({ remoteVersion: FORTRESS_VERSION, ...newBinary() });
    const result = await runFortressUpdate({ downloadBaseUrl: source.url, binPath });

    expect(result.alreadyLatest).toBe(true);
    expect(result.localVersion).toBe(FORTRESS_VERSION);
    expect(result.remoteVersion).toBe(FORTRESS_VERSION);
    expect(result.sha256).toBeNull();
    expect(source.asked).toEqual(["/hx-fortress-version"]);
    await nothingWritten();
  });

  test("an older version is never installed: an update does not go backwards", async () => {
    expect(OLDER).not.toBe(FORTRESS_VERSION);
    const source = mockDownloadBase({ remoteVersion: `${OLDER}\n`, ...newBinary() });
    const result = await runFortressUpdate({ downloadBaseUrl: source.url, binPath });

    expect(result.alreadyLatest).toBe(true);
    expect(result.remoteVersion).toBe(OLDER);
    expect(source.asked).toEqual(["/hx-fortress-version"]);
    await nothingWritten();
  });

  test("downloads and installs a newer binary", async () => {
    const { binary, sha256 } = newBinary();
    const progEvents: Array<{ phase: string; pct: number }> = [];
    const logs: string[] = [];

    const result = await runFortressUpdate({
      downloadBaseUrl: mockDownloadBase({ remoteVersion: NEWER, binary, sha256 }).url,
      binPath,
      log: (msg) => logs.push(msg),
      onProgress: (ev) => progEvents.push({ phase: ev.phase, pct: ev.pct }),
    });

    expect(result.alreadyLatest).toBe(false);
    expect(result.sha256).toBe(sha256);
    expect(result.installedPath).toBe(binPath);
    expect(result.localVersion).toBe(FORTRESS_VERSION);
    expect(result.remoteVersion).toBe(NEWER);
    expect((await readFile(binPath)).toString()).toBe(binary.toString());
    expect(await readdir(root)).toEqual(["hx-fortress"]);

    expect(progEvents.some((e) => e.phase === "download")).toBe(true);
    expect(progEvents.some((e) => e.phase === "unpack")).toBe(true);
    expect(progEvents.some((e) => e.phase === "verify" && e.pct === 100)).toBe(true);

    expect(logs.some((l) => l.includes("installed →"))).toBe(true);
  });

  test("throws on checksum mismatch, and installs nothing", async () => {
    await expect(
      runFortressUpdate({
        downloadBaseUrl: mockDownloadBase({
          remoteVersion: NEWER,
          binary: Buffer.from("another binary"),
          sha256: "a".repeat(64), // wrong checksum
        }).url,
        binPath,
      }),
    ).rejects.toThrow("checksum mismatch");
    await nothingWritten();
  });

  test("a redirect on the source's own origin is followed, for the version and for the program", async () => {
    const { binary, sha256 } = newBinary();
    const source = mockDownloadBase({ remoteVersion: NEWER, binary, sha256, movedTo: "/store" });
    const result = await runFortressUpdate({ downloadBaseUrl: source.url, binPath });
    expect(result.alreadyLatest).toBe(false);
    expect((await readFile(binPath)).toString()).toBe(binary.toString());
    expect(source.asked).toContain("/store/hx-fortress-version");
    expect(source.asked).toContain(`/store/${ASSET}.gz`);
  });

  test("a redirect of the program to plain http on another host is not followed, and nothing is installed", async () => {
    const source = mockDownloadBase({
      remoteVersion: NEWER,
      ...newBinary(),
      programMovedTo: "http://objects.northstar.example",
    });
    await expect(runFortressUpdate({ downloadBaseUrl: source.url, binPath })).rejects.toThrow(
      "a redirect is followed only to an https address",
    );
    await nothingWritten();
  });
});

// ── test helpers ──────────────────────────────────────────────────────────────

/** A program newer than the one in place, gzipped, and its checksum. */
function newBinary(): { binary: Buffer; sha256: string } {
  const binary = Buffer.from("the newer hx-fortress program");
  return { binary, sha256: createHash("sha256").update(binary).digest("hex") };
}

interface MockDownloadBaseOpts {
  /** What the version file holds. Null: there is no version file. */
  remoteVersion?: string | null;
  /** The program, NOT gzipped. */
  binary?: Buffer;
  sha256?: string;
  /** Every file answers with a redirect to the same name under this path. */
  movedTo?: string;
  /** The program alone answers with a redirect to this origin. */
  programMovedTo?: string;
}

interface MockSource {
  url: string;
  /** The paths asked, in order. */
  asked: string[];
  stop: () => Promise<void>;
}

const sources: MockSource[] = [];

async function stopSources(): Promise<void> {
  for (const source of sources.splice(0)) await source.stop();
}

function mockDownloadBase(opts: MockDownloadBaseOpts): MockSource {
  const { remoteVersion = FORTRESS_VERSION, binary, sha256 } = opts;

  const assets: Record<string, Uint8Array<ArrayBuffer> | string> = {};
  if (remoteVersion !== null) assets["hx-fortress-version"] = remoteVersion;
  if (binary) {
    assets[`${ASSET}.gz`] = new Uint8Array(gzipSync(binary));
    assets[`${ASSET}.sha256`] = `${sha256 ?? ""}  ${ASSET}`;
  }

  const asked: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      asked.push(pathname);
      const name = pathname.split("/").pop() ?? "";
      if (opts.programMovedTo && name === `${ASSET}.gz`) {
        return new Response(null, { status: 302, headers: { location: `${opts.programMovedTo}/${name}` } });
      }
      if (opts.movedTo && !pathname.startsWith(`${opts.movedTo}/`)) {
        return new Response(null, { status: 302, headers: { location: `${opts.movedTo}/${name}` } });
      }
      const asset = assets[name];
      if (asset === undefined) return new Response("not found", { status: 404 });
      return new Response(asset, { headers: { "content-type": "application/octet-stream" } });
    },
  });

  let stopped = false;
  const source: MockSource = {
    url: `http://127.0.0.1:${server.port}`,
    asked,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await server.stop(true);
    },
  };
  sources.push(source);
  return source;
}
