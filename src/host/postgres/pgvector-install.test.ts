import { afterEach, test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";

import { ensurePgvectorInstalled, pgvectorBaseUrls, type EnsurePgvectorDeps } from "./pgvector-install";

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

// A minimal but realistic zonky-style bundle: a stock extension module in the
// lib dir and a stock control file in share/postgresql/extension, so the
// self-locating helpers have real anchors to find (no hardcoded layout).
async function makeBundle(opts: { withVector?: boolean } = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pgv-bundle-"));
  made.push(dir);
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

/** The name of the archive for Postgres 18 on linux-amd64, as a release holds it. */
const ARCHIVE = "pgvector-pg18-linux-amd64.tar.gz";

/** A stand-in for the network. Each address answers as the table says, and
 *  any other with 404. A redirect is followed by the stand-in itself unless
 *  the request says `redirect: "manual"`, as fetch does. Every request is
 *  written down, with what it was asked with. */
function network(routes: Record<string, () => Response>): {
  fetchImpl: typeof fetch;
  asked: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const asked: Array<{ url: string; init: RequestInit | undefined }> = [];
  const answer = (url: string): Response => routes[url]?.() ?? new Response("not found", { status: 404 });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    let url = input instanceof Request ? input.url : String(input);
    asked.push({ url, init });
    let response = answer(url);
    for (let hop = 0; init?.redirect !== "manual" && response.status >= 300 && response.status < 400 && hop < 10; hop += 1) {
      url = new URL(response.headers.get("location") ?? "", url).toString();
      asked.push({ url, init });
      response = answer(url);
    }
    return response;
  }) as unknown as typeof fetch;
  return { fetchImpl, asked };
}

/** The archive at `url` and its checksum beside it. */
function archiveAt(url: string, bytes: Uint8Array<ArrayBuffer>): Record<string, () => Response> {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    [url]: () => new Response(new Blob([bytes])),
    [`${url}.sha256`]: () => new Response(`${digest}  ${ARCHIVE}\n`),
  };
}

const redirect = (location: string): (() => Response) => () =>
  new Response(null, { status: 302, headers: { location } });

/** An extractor that writes down the bytes of the archive it was handed. */
function extractingInto(seen: Buffer[]): EnsurePgvectorDeps["extractTarGz"] {
  return async (tarPath, destDir) => {
    seen.push(await readFile(tarPath));
    await fakeExtractor("so")(tarPath, destDir);
  };
}

const base: Omit<EnsurePgvectorDeps, "versionDir" | "fetchImpl" | "extractTarGz"> = {
  classifier: "linux-amd64",
  pgMajor: 18,
  baseUrls: ["https://x/rel"],
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

// The addresses may be given as a function. A host that already holds the
// files then asks nobody for them, and a host whose update settings cannot be
// read still starts.
test("addresses given as a function are not asked for when the files are already there", async () => {
  const dir = await makeBundle({ withVector: true });
  let asked = 0;
  const r = await ensurePgvectorInstalled({
    ...base,
    baseUrls: async () => {
      asked += 1;
      throw new Error("Invalid update settings: updates.from in config.json is \"somewhere\"");
    },
    versionDir: dir,
    fetchImpl: (async () => new Response()) as unknown as typeof fetch,
    extractTarGz: async () => {},
  });
  expect(r).toBe("present");
  expect(asked).toBe(0);
});

test("addresses given as a function are asked once when the files are missing, and their refusal stops the download", async () => {
  const dir = await makeBundle();
  const tar = new Uint8Array(Buffer.from("fake-tar-bytes"));
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    urls.push(String(url));
    return serving(tar)(url);
  }) as unknown as typeof fetch;

  let asked = 0;
  const r = await ensurePgvectorInstalled({
    ...base,
    baseUrls: async () => {
      asked += 1;
      return ["https://updates.example/hx-fortress"];
    },
    versionDir: dir,
    fetchImpl,
    extractTarGz: fakeExtractor("so"),
  });
  expect(r).toBe("installed");
  expect(asked).toBe(1);
  expect(urls[0]).toBe("https://updates.example/hx-fortress/pgvector-pg18-linux-amd64.tar.gz");

  const other = await makeBundle();
  const none: string[] = [];
  await expect(
    ensurePgvectorInstalled({
      ...base,
      baseUrls: async () => {
        throw new Error("Invalid update settings: updates.address in config.json must use https:");
      },
      versionDir: other,
      fetchImpl: (async (url: string | URL) => {
        none.push(String(url));
        return new Response();
      }) as unknown as typeof fetch,
      extractTarGz: async () => {},
    }),
  ).rejects.toThrow("Invalid update settings");
  expect(none).toEqual([]);
});

// The release of this version of the program is asked first, and another
// address only when that release has no such file: a release from before the
// files were published, or a program built from a source no release was cut
// from.
test("when the first address has no such file, the next one is asked, and its files are installed", async () => {
  const dir = await makeBundle();
  const first = "https://first.example/rel";
  const second = "https://second.example/rel";
  const tar = new Uint8Array(Buffer.from("the archive the second address holds"));
  const { fetchImpl, asked } = network(archiveAt(`${second}/${ARCHIVE}`, tar));
  const extracted: Buffer[] = [];
  let verifiedUrl: string | undefined;
  const r = await ensurePgvectorInstalled({
    ...base,
    baseUrls: [first, second],
    versionDir: dir,
    fetchImpl,
    verify: async (o) => {
      verifiedUrl = o.url;
    },
    extractTarGz: extractingInto(extracted),
  });
  expect(r).toBe("installed");
  expect(asked.map((request) => request.url)).toEqual([
    `${first}/${ARCHIVE}`,
    `${second}/${ARCHIVE}`,
    `${second}/${ARCHIVE}.sha256`,
  ]);
  // The archive, its checksum and its signature are the second address's.
  expect(extracted.map((bytes) => bytes.equals(Buffer.from(tar)))).toEqual([true]);
  expect(verifiedUrl).toBe(`${second}/${ARCHIVE}`);
  expect(existsSync(path.join(dir, "lib", "vector.so"))).toBe(true);
});

test("an address that answers with an error stops the download at once, and the next one is not asked", async () => {
  const dir = await makeBundle();
  const first = "https://first.example/rel";
  const second = "https://second.example/rel";
  const { fetchImpl, asked } = network({
    [`${first}/${ARCHIVE}`]: () => new Response("unavailable", { status: 500 }),
    ...archiveAt(`${second}/${ARCHIVE}`, new Uint8Array([1, 2, 3])),
  });
  await expect(
    ensurePgvectorInstalled({
      ...base,
      baseUrls: [first, second],
      versionDir: dir,
      fetchImpl,
      extractTarGz: fakeExtractor("so"),
    }),
  ).rejects.toThrow(`GET ${first}/${ARCHIVE} → 500`);
  expect(asked.map((request) => request.url)).toEqual([`${first}/${ARCHIVE}`]);
  expect(existsSync(path.join(dir, "lib", "vector.so"))).toBe(false);
});

test("when no address has the files, the error names each address asked and FORTRESS_PGVECTOR_URL", async () => {
  const dir = await makeBundle();
  const first = "https://first.example/rel";
  const second = "https://second.example/rel";
  const { fetchImpl, asked } = network({});
  await expect(
    ensurePgvectorInstalled({
      ...base,
      baseUrls: [first, second],
      versionDir: dir,
      fetchImpl,
      extractTarGz: fakeExtractor("so"),
    }),
  ).rejects.toThrow(
    `pgvector inject: the files for Postgres 18 on linux-amd64 are not at ${first}/${ARCHIVE} or ${second}/${ARCHIVE}. ` +
      "They are published with each version of HX Fortress. Update HX Fortress, or name an address that " +
      "holds them in FORTRESS_PGVECTOR_URL.",
  );
  expect(asked.map((request) => request.url)).toEqual([`${first}/${ARCHIVE}`, `${second}/${ARCHIVE}`]);
  expect(existsSync(path.join(dir, "lib", "vector.so"))).toBe(false);
});

test("a redirect to https is followed, and every request has a deadline and leaves no redirect to the runtime", async () => {
  // The project's releases answer a file's address with a redirect to the
  // host that stores the file.
  const dir = await makeBundle();
  const release = "https://releases.example/rel";
  const stored = "https://objects.example/stored/archive";
  const tar = new Uint8Array(Buffer.from("the archive behind a redirect"));
  const { fetchImpl, asked } = network({
    [`${release}/${ARCHIVE}`]: redirect(stored),
    [`${release}/${ARCHIVE}.sha256`]: redirect(`${stored}.sha256`),
    [`${release}/${ARCHIVE}.sig`]: redirect(`${stored}.sig`),
    ...archiveAt(stored, tar),
  });
  const extracted: Buffer[] = [];
  // The real signature check: it asks for the signature too, which this
  // release does not have yet.
  const r = await ensurePgvectorInstalled({
    ...base,
    baseUrls: [release],
    versionDir: dir,
    fetchImpl,
    extractTarGz: extractingInto(extracted),
  });
  expect(r).toBe("installed");
  expect(extracted.map((bytes) => bytes.equals(Buffer.from(tar)))).toEqual([true]);
  expect(asked.map((request) => request.url)).toEqual([
    `${release}/${ARCHIVE}`,
    stored,
    `${release}/${ARCHIVE}.sha256`,
    `${stored}.sha256`,
    `${release}/${ARCHIVE}.sig`,
    `${stored}.sig`,
  ]);
  for (const request of asked) {
    expect([request.url, request.init?.signal instanceof AbortSignal]).toEqual([request.url, true]);
    expect([request.url, request.init?.redirect]).toEqual([request.url, "manual"]);
  }
});

test("a redirect to an address in clear text on another host is refused, and that address is never asked", async () => {
  const dir = await makeBundle();
  const release = "https://releases.example/rel";
  const second = "https://second.example/rel";
  const plain = "http://files.northstar.example/pgvector.tar.gz";
  const tar = new Uint8Array(Buffer.from("the archive in clear text"));
  const { fetchImpl, asked } = network({
    [`${release}/${ARCHIVE}`]: redirect(plain),
    ...archiveAt(plain, tar),
    ...archiveAt(`${second}/${ARCHIVE}`, tar),
  });
  await expect(
    ensurePgvectorInstalled({
      ...base,
      baseUrls: [release, second],
      versionDir: dir,
      fetchImpl,
      extractTarGz: fakeExtractor("so"),
    }),
  ).rejects.toThrow("the answer is a redirect to http://files.northstar.example, and a redirect is followed only to an https address");
  // Neither the address in clear text nor the next address was asked.
  expect(asked.map((request) => request.url)).toEqual([`${release}/${ARCHIVE}`]);
  expect(existsSync(path.join(dir, "lib", "vector.so"))).toBe(false);
});

// ── where the files are asked for ───────────────────────────────────────────

const RELEASE_OF = "https://github.com/HX-Framework/hx-fortress/releases/download";
const LATEST = "https://github.com/HX-Framework/hx-fortress/releases/latest/download";

test("with the project's releases, the files of this version are asked for first: its release, then its build, and the newest release last", async () => {
  // The files are built for the Postgres this version runs and signed with
  // the keys it carries. The newest release stops holding an older version's
  // files the day a release moves to another Postgres or another key.
  expect(
    await pgvectorBaseUrls({
      ownUrl: "",
      updateSource: async () => ({ from: "project-releases", base: LATEST, setBy: "default" }),
      version: "1.2.3",
    }),
  ).toEqual([`${RELEASE_OF}/releases/hx-fortress-1.2.3`, `${RELEASE_OF}/builds/hx-fortress-1.2.3`, LATEST]);
});

test("an address the organization names for new versions holds one release's files, and is asked alone", async () => {
  expect(
    await pgvectorBaseUrls({
      ownUrl: "",
      updateSource: async () => ({
        from: "own-address",
        base: "https://files.northstar.example/hx-fortress",
        setBy: "config",
      }),
      version: "1.2.3",
    }),
  ).toEqual(["https://files.northstar.example/hx-fortress"]);
});

test("an address named for the extension alone is the only one, and the update settings are not read for it", async () => {
  // A host whose update settings cannot be understood still starts with the
  // extension from the address it names for it.
  let read = 0;
  expect(
    await pgvectorBaseUrls({
      ownUrl: "https://files.northstar.example/pgvector",
      updateSource: async () => {
        read += 1;
        throw new Error("the update settings cannot be understood");
      },
      version: "1.2.3",
    }),
  ).toEqual(["https://files.northstar.example/pgvector"]);
  expect(read).toBe(0);
});

test("update settings that cannot be understood stop the list, by name, when no address is named for the extension", async () => {
  await expect(
    pgvectorBaseUrls({
      ownUrl: "",
      updateSource: async () => {
        throw new Error("Invalid update settings: updates.from is not an option");
      },
      version: "1.2.3",
    }),
  ).rejects.toThrow("Invalid update settings: updates.from is not an option");
});
