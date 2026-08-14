import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { acquireBinaries, zonkyJarUrl } from "../src/host/postgres/acquire";

const JAR_BYTES = new Uint8Array([1, 2, 3, 4]);
// sha256 of the bytes above, lowercase hex:
const JAR_SHA256 = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";

function toArrayBuffer(body: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(body.byteLength);
  new Uint8Array(ab).set(body);
  return ab;
}

function makeFetch(body: Uint8Array, sha: string): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith(".sha256")) {
      return new Response(`${sha}  embedded-postgres-binaries.jar\n`, { status: 200 });
    }
    return new Response(toArrayBuffer(body), { status: 200 });
  }) as typeof fetch;
}

describe("acquire", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-pg-acq-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("builds the Maven jar URL", () => {
    expect(zonkyJarUrl("https://repo1.maven.org/maven2", "linux-amd64", "18.4.0")).toBe(
      "https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-linux-amd64/18.4.0/embedded-postgres-binaries-linux-amd64-18.4.0.jar",
    );
  });

  test("downloads, verifies sha256, extracts, writes sentinel, returns bin dir", async () => {
    let extractCalls = 0;
    const versionDir = path.join(root, "18.4.0");
    const bin = await acquireBinaries({
      fetchImpl: makeFetch(JAR_BYTES, JAR_SHA256),
      extract: async (_jar, dest) => {
        extractCalls += 1;
        await mkdir(path.join(dest, "bin"), { recursive: true });
        await writeFile(path.join(dest, "bin", "postgres"), "x");
      },
      cacheDir: path.join(root, "cache"),
      versionDir,
      classifier: "linux-amd64",
      version: "18.4.0",
      binariesUrl: "https://repo1.maven.org/maven2",
    });
    expect(bin).toBe(path.join(versionDir, "bin"));
    expect(existsSync(path.join(versionDir, ".ready"))).toBe(true);
    expect(extractCalls).toBe(1);
  });

  test("is idempotent — second call skips fetch and extract", async () => {
    let fetchCalls = 0;
    const countingFetch: typeof fetch = (async (i: string | URL | Request) => {
      fetchCalls += 1;
      return makeFetch(JAR_BYTES, JAR_SHA256)(i);
    }) as typeof fetch;
    const versionDir = path.join(root, "18.4.0");
    const deps = {
      fetchImpl: countingFetch,
      extract: async (_jar: string, dest: string) => {
        await mkdir(path.join(dest, "bin"), { recursive: true });
      },
      cacheDir: path.join(root, "cache"),
      versionDir,
      classifier: "linux-amd64" as const,
      version: "18.4.0",
      binariesUrl: "https://repo1.maven.org/maven2",
    };
    await acquireBinaries(deps);
    const before = fetchCalls;
    await acquireBinaries(deps);
    expect(fetchCalls).toBe(before);
  });

  test("aborts on sha256 mismatch", async () => {
    await expect(
      acquireBinaries({
        fetchImpl: makeFetch(JAR_BYTES, "deadbeef"),
        extract: async () => {},
        cacheDir: path.join(root, "cache"),
        versionDir: path.join(root, "18.4.0"),
        classifier: "linux-amd64",
        version: "18.4.0",
        binariesUrl: "https://repo1.maven.org/maven2",
      }),
    ).rejects.toThrow(/checksum/i);
  });
});
