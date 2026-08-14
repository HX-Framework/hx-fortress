import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";

import packageJson from "../package.json";
import {
  contentTypeFor,
  inlineScriptHashesOf,
  manifestOf,
  mapDistDir,
  type UiAssets,
} from "../src/ui/assets";
import {
  cacheControlFor,
  cspFor,
  handleUiRequest,
  startUiServer,
  isTraversal,
  looksLikeAsset,
  rawRequestPath,
  type UiServerCtx,
} from "../src/ui/server";

const INDEX_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>HX Fortress</title>
<link href="/fonts/fonts.css" rel="stylesheet"></head>
<body><div id="root"></div>
<script type="module" src="/assets/index-abc123.js"></script></body></html>`;

let dist: string;
let assets: UiAssets;
let ctx: UiServerCtx;

beforeAll(async () => {
  dist = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-ui-"));
  await mkdir(path.join(dist, "assets"), { recursive: true });
  await mkdir(path.join(dist, "fonts"), { recursive: true });
  await writeFile(path.join(dist, "index.html"), INDEX_HTML);
  await writeFile(path.join(dist, "assets", "index-abc123.js"), "export const a = 1;\n");
  await writeFile(path.join(dist, "assets", "index-abc123.css"), ":root{--a:1}\n");
  await writeFile(path.join(dist, "fonts", "inter-400.woff2"), "wOF2fake");
  const files = mapDistDir(dist);
  assets = { mode: "disk", files, inlineScriptHashes: [], manifest: await manifestOf(files) };
  ctx = { assets, port: 8788 };
});

afterAll(async () => {
  await rm(dist, { recursive: true, force: true });
});

function get(pathname: string, method = "GET"): Response {
  return handleUiRequest(new Request(`http://127.0.0.1:8788${pathname}`, { method }), ctx);
}

/** GET with the request target written verbatim, bypassing fetch's own parsing. */
function rawGet(port: number, target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
      );
    });
    let raw = "";
    socket.on("data", (chunk) => {
      raw += chunk.toString();
    });
    socket.on("error", reject);
    socket.on("close", () =>
      resolve({ status: Number(raw.split(" ")[1]), body: raw.split("\r\n\r\n").slice(1).join("") }),
    );
  });
}

describe("asset map", () => {
  test("maps every built file to a URL path", () => {
    expect(Object.keys(assets.files).sort()).toEqual([
      "/assets/index-abc123.css",
      "/assets/index-abc123.js",
      "/fonts/inter-400.woff2",
      "/index.html",
    ]);
  });

  test("content types cover the shipped extensions", () => {
    expect(contentTypeFor("/index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("/assets/x.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("/fonts/inter-400.woff2")).toBe("font/woff2");
    expect(contentTypeFor("/nope")).toBe("application/octet-stream");
  });

  test("inline script bodies become CSP hashes; src= scripts do not", () => {
    expect(inlineScriptHashesOf(INDEX_HTML)).toEqual([]);
    const hashes = inlineScriptHashesOf('<script>document.title="x"</script>');
    expect(hashes).toHaveLength(1);
    expect(hashes[0]).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/);
    expect(cspFor(hashes)).toContain(hashes[0] as string);
    expect(cspFor([])).toContain("script-src 'self';");
  });
});

describe("asset manifest", () => {
  test("is content-addressed: same bytes, same hash", async () => {
    const again = await manifestOf(mapDistDir(dist));
    expect(again.hash).toBe(assets.manifest.hash);
    expect(again.files).toBe(4);
    expect(again.bytes).toBeGreaterThan(0);
  });

  test("changes when a byte changes, and when a file is renamed", async () => {
    const other = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-ui-"));
    try {
      await mkdir(path.join(other, "assets"), { recursive: true });
      await writeFile(path.join(other, "index.html"), INDEX_HTML);
      await writeFile(path.join(other, "assets", "index-abc123.js"), "export const a = 2;\n");
      const changed = await manifestOf(mapDistDir(other));
      expect(changed.hash).not.toBe(assets.manifest.hash);

      await rm(path.join(other, "assets", "index-abc123.js"));
      await writeFile(path.join(other, "assets", "index-def456.js"), "export const a = 2;\n");
      const renamed = await manifestOf(mapDistDir(other));
      expect(renamed.hash).not.toBe(changed.hash);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe("serving", () => {
  test("serves the shell at /", async () => {
    const res = get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain('<div id="root">');
  });

  test("serves every deep link from the shell, so a cold load lands where it says", async () => {
    for (const deep of [
      "/sessions",
      "/sessions/by/team",
      "/sessions/claude-cli/59e3ccf5-8f8b",
      "/sessions/claude-cli/59e3ccf5-8f8b/verify",
      "/people/erik",
      "/adoption/by/coverage/not-installed",
      "/residency/verify/claude-cli/59e3ccf5-8f8b",
      "/compliance/egress",
      "/storage/runs/mig_7f3a",
      "/logs/session_vault/errors/7d",
      "/logs/errors/shortcuts",
    ]) {
      const res = get(deep);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toContain('<div id="root">');
    }
  });

  test("cache tiers: hashed assets immutable, the shell revalidated, the rest an hour", () => {
    expect(get("/").headers.get("cache-control")).toBe("no-cache");
    expect(get("/assets/index-abc123.js").headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(get("/fonts/inter-400.woff2").headers.get("cache-control")).toBe("public, max-age=3600");
    expect(get("/sessions").headers.get("cache-control")).toBe("no-cache");
    expect(cacheControlFor("/index.html")).toBe("no-cache");
  });

  test("a missing asset 404s instead of being hidden behind the shell", () => {
    expect(get("/assets/index-gone.js").status).toBe(404);
    expect(get("/fonts/missing.woff2").status).toBe(404);
    expect(get("/favicon.ico").status).toBe(404);
    expect(looksLikeAsset("/assets/x.js")).toBe(true);
    expect(looksLikeAsset("/sessions/by/team")).toBe(false);
  });

  test("traversal 404s — it never reaches the shell and never reaches the disk", () => {
    for (const attempt of [
      "/assets/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      "/%c0%ae%c0%ae/etc/passwd",
      "/assets%2f..%2findex.html",
      "/fonts/..%5c..%5cwindows%5cwin.ini",
    ]) {
      const res = handleUiRequest(new Request(`http://127.0.0.1:8788${attempt}`), ctx);
      expect(res.status).toBe(404);
    }
  });

  test("an unresolved target is judged as it arrived, not as URL parsing rewrites it", () => {
    // The handler reads .url; a Request built from a string has already been
    // normalized, so drive the contract directly to exercise the raw rule.
    for (const raw of [
      "/../package.json",
      "/assets/../../etc/passwd",
      "/./index.html",
      "/..%2fetc",
      "/a\\b",
    ]) {
      expect(isTraversal(raw)).toBe(true);
      const res = handleUiRequest(
        { url: `http://127.0.0.1:8788${raw}`, method: "GET" } as Request,
        ctx,
      );
      expect(res.status).toBe(404);
    }
    expect(rawRequestPath("http://127.0.0.1:8788/assets/../x?y=1")).toBe("/assets/../x");
    expect(isTraversal("/sessions/by/team")).toBe(false);
    expect(isTraversal("/")).toBe(false);
  });

  test("off the wire, a traversal target never yields a byte from outside the map", async () => {
    // Port 0, not the console's default: this is the only test here that binds
    // a real socket, and on 8788 it failed on any machine actually RUNNING a
    // fortress console — which is every machine this is developed on. The
    // handler tests above keep 8788 in their Request URLs because that is the
    // Host the allowlist is built from; only the listener needs to move.
    const server = startUiServer({ ...ctx, port: 0 }, "127.0.0.1");
    try {
      const port = server.port as number;
      // Bun resolves dot segments before the handler runs, so an unencoded
      // attempt arrives as an ordinary path and is answered like any unknown
      // view — with the shell. What must never happen is a file leaving the box.
      const escaped = await rawGet(port, "/assets/../../etc/hosts");
      expect(escaped.status).toBe(200);
      expect(escaped.body).toContain('<div id="root">');
      expect(escaped.body).not.toContain("localhost");

      // Asset-shaped attempts, and the encoded shapes that survive
      // normalization, are refused outright.
      expect((await rawGet(port, "/../package.json")).status).toBe(404);
      expect((await rawGet(port, "/assets/../../etc/hosts.txt")).status).toBe(404);
      expect((await rawGet(port, "/assets/%2e%2e%2f%2e%2e%2fetc%2fhosts")).status).toBe(404);
      expect((await rawGet(port, "/sessions/by/team")).status).toBe(200);
    } finally {
      server.stop(true);
    }
  });

  test("every response carries the security headers", () => {
    for (const p of ["/", "/assets/index-abc123.js", "/sessions", "/nope.js"]) {
      const res = get(p);
      expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  test("the CSP needs no 'unsafe-inline' for scripts and allows no third-party origin", () => {
    const csp = cspFor([]);
    expect(csp).not.toContain("'unsafe-inline'; script-src");
    expect(csp.split("script-src ")[1]?.split(";")[0]).toBe("'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("font-src 'self'");
    expect(csp).not.toMatch(/https?:\/\//);
  });

  test("non-GET methods are refused", () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      expect(get("/", method).status).toBe(405);
      expect(get("/healthz", method).status).toBe(405);
    }
  });
});

describe("pre-auth surface", () => {
  test("/healthz is a bare 200, readable cross-origin, with no body", async () => {
    const res = get("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("nothing served before sign-in discloses a version, an org or a path on this box", async () => {
    for (const p of ["/", "/healthz", "/sessions", "/assets/index-abc123.js", "/nope.js"]) {
      const res = get(p);
      const body = await res.text();
      const headers = [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n");
      expect(headers).not.toContain(packageJson.version);
      expect(headers.toLowerCase()).not.toContain("hx-fortress");
      expect(body).not.toContain(packageJson.version);
      expect(body).not.toContain(dist);
    }
  });

  test("the API namespace 404s until a route claims it", () => {
    // A fetch client must never receive the HTML shell with a 200 where it
    // expected JSON — an unclaimed API path is a missing route, not a view.
    expect(get("/ui/api/instance").status).toBe(404);
    expect(get("/ui/api/snapshot").status).toBe(404);
  });

  test("only the shell, its mapped assets and the probe ever answer", async () => {
    const answered = new Set<string>();
    for (const p of ["/", "/sessions", "/assets/index-abc123.js", "/healthz", "/ui/api/x", "/x.js"]) {
      const res = get(p);
      if (res.status !== 200) continue;
      const body = await res.text();
      answered.add(p === "/healthz" ? "probe" : body.includes("<div id=") ? "shell" : "asset");
    }
    expect([...answered].sort()).toEqual(["asset", "probe", "shell"]);
  });
});
