import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";

import { ensurePgvectorInstalled, type EnsurePgvectorDeps } from "./pgvector-install";

// A minimal but realistic zonky-style bundle: a stock extension module in the
// lib dir and a stock control file in share/postgresql/extension, so the
// self-locating helpers have real anchors to find (no hardcoded layout).
async function makeBundle(opts: { withVector?: boolean } = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pgv-bundle-"));
  const libDir = path.join(dir, "lib");
  const extDir = path.join(dir, "share", "postgresql", "extension");
  await mkdir(libDir, { recursive: true });
  await mkdir(extDir, { recursive: true });
  await writeFile(path.join(libDir, "plpgsql.so"), "stock-module");
  await writeFile(path.join(extDir, "plpgsql.control"), "stock-control");
  if (opts.withVector) await writeFile(path.join(extDir, "vector.control"), "");
  return dir;
}

// Fetch stub that serves the tar bytes + a matching sha256 sidecar. The `.sig`
// sidecar 404s (Release A verify-if-present: no signature published yet), so the
// real verifier warns and proceeds rather than blocking these tests.
function serving(tarBytes: Uint8Array<ArrayBuffer>, sha?: string): typeof fetch {
  const digest = sha ?? createHash("sha256").update(tarBytes).digest("hex");
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith(".sig")) return new Response("not found", { status: 404 });
    if (u.endsWith(".sha256")) return new Response(`${digest}  artifact\n`);
    return new Response(new Blob([tarBytes]));
  }) as unknown as typeof fetch;
}

// An extractor that materializes what the real tar contains: lib/vector.<ext>
// and share/extension/vector.{control,--*.sql}.
function fakeExtractor(ext: "so" | "dylib"): EnsurePgvectorDeps["extractTarGz"] {
  return async (_tarPath, destDir) => {
    await mkdir(path.join(destDir, "lib"), { recursive: true });
    await mkdir(path.join(destDir, "share", "extension"), { recursive: true });
    await writeFile(path.join(destDir, "lib", `vector.${ext}`), "vector-module");
    await writeFile(path.join(destDir, "share", "extension", "vector.control"), "vector-ctl");
    await writeFile(
      path.join(destDir, "share", "extension", "vector--0.8.0.sql"),
      "create...",
    );
  };
}

const base: Omit<EnsurePgvectorDeps, "versionDir" | "fetchImpl" | "extractTarGz"> = {
  classifier: "linux-amd64",
  pgMajor: 18,
  baseUrl: "https://x/rel",
  darwin: false,
  spawn: async () => {},
  log: () => {},
};

test("no-ops with 'present' and never fetches when vector.control already there", async () => {
  const dir = await makeBundle({ withVector: true });
  let fetched = false;
  const r = await ensurePgvectorInstalled({
    ...base,
    versionDir: dir,
    fetchImpl: (async () => {
      fetched = true;
      return new Response();
    }) as unknown as typeof fetch,
    extractTarGz: async () => {},
  });
  expect(r).toBe("present");
  expect(fetched).toBe(false);
});

test("downloads + injects vector into the bundle's own lib/extension dirs", async () => {
  const dir = await makeBundle();
  const tar = new Uint8Array([1, 2, 3, 4]);
  const r = await ensurePgvectorInstalled({
    ...base,
    versionDir: dir,
    fetchImpl: serving(tar),
    extractTarGz: fakeExtractor("so"),
  });
  expect(r).toBe("installed");
  expect(existsSync(path.join(dir, "lib", "vector.so"))).toBe(true);
  const extFiles = await readdir(path.join(dir, "share", "postgresql", "extension"));
  expect(extFiles).toContain("vector.control");
  expect(extFiles).toContain("vector--0.8.0.sql");
});

test("verifies the downloaded tar signature before extracting", async () => {
  const dir = await makeBundle();
  const tar = new Uint8Array([1, 2, 3, 4]);
  const seen: { bytes?: Uint8Array; url?: string; enforce?: boolean } = {};
  let verified = false;
  let extractedAfterVerify = false;
  const r = await ensurePgvectorInstalled({
    ...base,
    versionDir: dir,
    fetchImpl: serving(tar),
    // Inject a verify spy: record the bytes/url/enforce it was handed…
    verify: async (o) => {
      seen.bytes = o.bytes;
      seen.url = o.url;
      seen.enforce = o.enforce;
      verified = true;
    },
    // …and prove verification ran BEFORE any extraction touched the bytes.
    extractTarGz: async (tarPath, destDir) => {
      expect(verified).toBe(true);
      extractedAfterVerify = true;
      return fakeExtractor("so")(tarPath, destDir);
    },
  });
  expect(r).toBe("installed");
  expect(seen.bytes).toEqual(tar);
  expect(seen.url).toContain("pgvector-pg18-linux-amd64.tar.gz");
  expect(seen.enforce).toBe(false);
  expect(extractedAfterVerify).toBe(true);
});

test("throws (mandatory, no silent fallback) when the download fails", async () => {
  const dir = await makeBundle();
  await expect(
    ensurePgvectorInstalled({
      ...base,
      versionDir: dir,
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
      extractTarGz: fakeExtractor("so"),
    }),
  ).rejects.toThrow();
  expect(existsSync(path.join(dir, "lib", "vector.so"))).toBe(false);
});

test("throws and injects nothing on a checksum mismatch", async () => {
  const dir = await makeBundle();
  const tar = new Uint8Array([9, 9, 9]);
  await expect(
    ensurePgvectorInstalled({
      ...base,
      versionDir: dir,
      fetchImpl: serving(tar, "deadbeef"), // wrong digest
      extractTarGz: fakeExtractor("so"),
    }),
  ).rejects.toThrow();
  expect(existsSync(path.join(dir, "lib", "vector.so"))).toBe(false);
});

test("on darwin, strips quarantine + ad-hoc signs the injected dylib", async () => {
  const dir = await makeBundle();
  const tar = new Uint8Array([5, 6, 7]);
  const cmds: string[][] = [];
  const r = await ensurePgvectorInstalled({
    ...base,
    versionDir: dir,
    darwin: true,
    fetchImpl: serving(tar),
    extractTarGz: fakeExtractor("dylib"),
    spawn: async (cmd) => {
      cmds.push(cmd);
    },
  });
  expect(r).toBe("installed");
  expect(existsSync(path.join(dir, "lib", "vector.dylib"))).toBe(true);
  expect(cmds.some((c) => c[0] === "xattr")).toBe(true);
  expect(cmds.some((c) => c[0] === "codesign")).toBe(true);
});
