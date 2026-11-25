// The page files of a Secure Data Island: what the folder holds, that the
// console serves each one exactly as it is in the repository, with no sign-in,
// which headers each kind of file answers with, and what else answers at the
// door.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import packageJson from "../../package.json";
import {
  ISLAND_FOLDER,
  ISLAND_MODULE_FILE,
  ISLAND_SUMS_FILE,
  islandNameRefusal,
  islandSumsText,
  readIslandFolder,
} from "../../scripts/gen-island-files";
import {
  ISLAND_FRAME_SANDBOX,
  ISLAND_ROUTES,
  OWN_PAGE_CSP,
  framedPageCsp,
  handleIslandRequest,
} from "../../src/ui/island-door";
import {
  ISLAND_FILES_PREFIX,
  ISLAND_FRAMED_PAGES,
  ISLAND_ROUTE_WORDS,
  ISLAND_SUMS_NAME,
  compareIslandFiles,
  islandFilesFrom,
  kindPagesOfContract,
  parseIslandSums,
  sha256Hex,
} from "../../src/ui/island-files";
import { BUCKETS } from "../../src/ui/rate-limit";
import { ORGANIZATION, PAGES, moduleScriptOf, repositoryIslandFiles, startIslandRig, type IslandRig } from "./_rig";

const REPOSITORY = path.join(ISLAND_FOLDER, "..", "..");
const folder = readIslandFolder();
const NAMES = [...folder.files.keys(), ISLAND_SUMS_NAME].sort();
const PAGE_NAMES = NAMES.filter((name) => name.endsWith(".html"));
/** The pages that a control plane's page shows in a frame. */
const FRAMED = ["rows.html"];
/** The fonts that the styles of a Secure Data Island name: the console's own files. */
const FONTS = ["ibm-plex-mono-400", "ibm-plex-mono-500", "inter-400", "inter-500", "inter-600", "inter-700"].map(
  (name) => `/fonts/${name}.woff2`,
);
const OWN = PAGE_NAMES.filter((name) => !FRAMED.includes(name));
const text = (name: string): string => new TextDecoder().decode(folder.files.get(name));
const withSums = (): Map<string, Uint8Array> =>
  new Map<string, Uint8Array>([...folder.files, [ISLAND_SUMS_NAME, new TextEncoder().encode(folder.sums)]]);

/** One console for the tests that only read. A test that changes a setting
 *  starts its own. */
let shared: IslandRig;
beforeAll(async () => {
  shared = await startIslandRig();
});
afterAll(async () => {
  await shared.cleanup();
});

let rig: IslandRig | null = null;
afterEach(async () => {
  await rig?.cleanup();
  rig = null;
});

describe("the folder islands/v1/", () => {
  test("the list of checksums and the module that embeds the files match the folder", () => {
    // Stale? Run `bun run gen:islands`.
    expect(readFileSync(ISLAND_SUMS_FILE, "utf8")).toBe(folder.sums);
    expect(readFileSync(ISLAND_MODULE_FILE, "utf8")).toBe(folder.module);
  });

  test("the list of checksums is one that `shasum -c` reads, and lists every file but itself", () => {
    const sums = parseIslandSums(folder.sums);
    expect([...(sums?.keys() ?? [])].sort()).toEqual(NAMES.filter((name) => name !== ISLAND_SUMS_NAME));
    for (const line of folder.sums.trimEnd().split("\n")) expect(line).toMatch(/^[0-9a-f]{64} {2}[a-z0-9.-]+$/);
    expect(islandSumsText(new Map([["b.js", new Uint8Array([1])], ["a.js", new Uint8Array([2])]])).split("\n")[0]).toEndWith("  a.js");
  });

  test("the repository tracks exactly these files there", () => {
    const tracked = spawnSync("git", ["ls-files", "--", "islands/v1"], { cwd: REPOSITORY, encoding: "utf8" });
    expect(tracked.status).toBe(0);
    // A name that starts with a dot is skipped by the script that lists the
    // folder, so none may ever be tracked in it.
    expect(tracked.stdout.trim().split("\n").map((file) => path.basename(file)).sort()).toEqual(NAMES);
  });

  test("it holds plain files only: no folder, no TypeScript, one ending, lower case", () => {
    for (const entry of readdirSync(ISLAND_FOLDER, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === ISLAND_SUMS_NAME) continue;
      expect(entry.isFile()).toBe(true);
      expect(islandNameRefusal(entry.name)).toBeNull();
    }
    for (const name of ["rows.ts", "island.min.js", "island.js.html", "Rows.html", "notes.md", "a/b.js", "rows", ".hidden.js"]) {
      expect(`${name}: ${islandNameRefusal(name)}`).toContain("plain HTML, CSS, JavaScript, SVG or JSON");
    }
    // A page also answers without `.html`, so no page may take a route's name.
    for (const word of ISLAND_ROUTE_WORDS) expect(islandNameRefusal(`${word}.html`)).toContain("routes");
    expect(islandNameRefusal("config.js")).toBeNull();
  });

  test("no page holds an inline script, an inline style or an inline handler", () => {
    for (const name of PAGE_NAMES) {
      const html = text(name);
      expect(html.toLowerCase().includes("<style")).toBe(false);
      expect(html).not.toMatch(/\sstyle\s*=/i);
      expect(html).not.toMatch(/\son[a-z]+\s*=/i);
      // Two script tags, each naming a file and holding no text: the theme first, so that it is
      // named before the page paints, then the page's own module.
      expect(html.toLowerCase().split("<script").length - 1).toBe(2);
      expect(`${name}: ${moduleScriptOf(html)}`).toMatch(/: [a-z0-9-]+\.js$/);
      expect(html.indexOf('<script src="./theme.js">')).toBeLessThan(html.indexOf('<link rel="stylesheet" href="./island.css">'));
      // Every address in a page is a file of this folder.
      for (const address of [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((m) => m[1] as string)) {
        expect(address.startsWith("./")).toBe(true);
        expect(NAMES).toContain(address.slice(2));
      }
      expect(html).not.toMatch(/https?:\/\//i);
    }
    for (const name of NAMES.filter((n) => n.endsWith(".css") || n.endsWith(".js"))) {
      // The one address a script names is the namespace of an SVG drawing.
      expect(text(name).replaceAll("http://www.w3.org/2000/svg", "")).not.toMatch(/https?:\/\//i);
    }
  });

  test("HX Fortress's own pages say so on their root, and a framed page does not", () => {
    for (const name of OWN) expect(text(name)).toContain('<html lang="en" class="hx-own">');
    for (const name of FRAMED) expect(text(name)).toContain('<html lang="en">');
  });

  test("the styles name only fonts that the console holds", () => {
    const named = [...text("island.css").matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1] as string);
    expect(named.sort()).toEqual(FONTS);
    for (const font of FONTS) expect(readFileSync(path.join(REPOSITORY, "ui", "public", font)).length).toBeGreaterThan(0);
  });

  test("the console serves each of those fonts", async () => {
    for (const font of FONTS) {
      const response = await fetch(`${shared.origin}${font}`);
      expect(`${font} ${response.status}`).toBe(`${font} 200`);
      expect(response.headers.get("content-type")).toBe("font/woff2");
      expect(Buffer.from(await response.arrayBuffer()).equals(readFileSync(path.join(REPOSITORY, "ui", "public", font)))).toBe(true);
    }
  });

  test("the pages this build frames are the ones contract.json lists for its kinds", () => {
    expect(kindPagesOfContract(JSON.parse(text("contract.json")))).toEqual(FRAMED);
    expect([...ISLAND_FRAMED_PAGES]).toEqual(FRAMED);
    expect(kindPagesOfContract({ kinds: [{ kind: "rows", page: "/elsewhere/rows" }] })).toEqual([]);
    expect(kindPagesOfContract({ kinds: "rows" })).toBeNull();
    expect(kindPagesOfContract(null)).toBeNull();
  });
});

describe("comparing files with their list of checksums", () => {
  test("the folder's own files match", () => {
    expect(compareIslandFiles(folder.sums, withSums())).toEqual([]);
  });

  test("a changed file, a missing file and a file that is not listed are each named", () => {
    const changed = withSums().set("island.js", new TextEncoder().encode("// another script"));
    expect(compareIslandFiles(folder.sums, changed)).toEqual(["island.js: not the listed file"]);

    const missing = withSums();
    missing.delete("rows.html");
    expect(compareIslandFiles(folder.sums, missing)).toEqual(["rows.html: listed, and not there"]);

    const extra = withSums().set("extra.js", new Uint8Array([1]));
    expect(compareIslandFiles(folder.sums, extra)).toEqual(["extra.js: there, and not listed"]);
  });

  test("a text that is not a list of checksums matches nothing", () => {
    for (const sums of ["", "not a list\n", `${"0".repeat(64)} island.js\n`, `${folder.sums}${folder.sums}`]) {
      expect(compareIslandFiles(sums, withSums())).toEqual([`${ISLAND_SUMS_NAME} is not a list of checksums`]);
    }
  });
});

describe("the files a console holds", () => {
  test("the files of this checkout are in order, and are the bytes of the folder", async () => {
    const held = await repositoryIslandFiles();
    expect(held.problems).toEqual([]);
    expect([...held.names]).toEqual(NAMES);
    expect([...held.framed]).toEqual(FRAMED);
    for (const name of NAMES) {
      const file = held.byAddress.get(name);
      expect(Buffer.from(file?.bytes ?? []).equals(readFileSync(path.join(ISLAND_FOLDER, name)))).toBe(true);
      expect(file?.etag).toBe(`"${sha256Hex(readFileSync(path.join(ISLAND_FOLDER, name)))}"`);
    }
    // A page is also found without `.html`, and nothing else is.
    expect(held.byAddress.get("rows")).toBe(held.byAddress.get("rows.html"));
    expect([...held.byAddress.keys()].sort()).toEqual([...NAMES, ...PAGE_NAMES.map((n) => n.slice(0, -5))].sort());
  });

  test("a file that is not the listed one is a problem", () => {
    const held = islandFilesFrom(withSums().set("island.js", new TextEncoder().encode("// another script")));
    expect(held.problems).toEqual(["island.js: not the listed file"]);
  });

  test("files with no list of checksums, or with one that is not a list, are a problem", () => {
    expect(islandFilesFrom(folder.files).problems).toEqual([`${ISLAND_SUMS_NAME} is not among the files`]);
    const broken = withSums().set(ISLAND_SUMS_NAME, new TextEncoder().encode("oops"));
    expect(islandFilesFrom(broken).problems).toEqual([`${ISLAND_SUMS_NAME} is not a list of checksums`]);
  });

  test("a contract that cannot be read frames nothing, and is a problem", () => {
    const files = new Map(folder.files).set("contract.json", new TextEncoder().encode("{ not json"));
    const held = islandFilesFrom(files.set(ISLAND_SUMS_NAME, new TextEncoder().encode(islandSumsText(files))));
    expect([...held.framed]).toEqual([]);
    expect(held.problems).toEqual([
      "contract.json cannot be read, so it names no kind of Secure Data Island",
      "this build frames rows.html, and contract.json lists it for no kind",
    ]);
  });

  test("a contract that points a kind at another page frames no page it did not frame before", () => {
    const contract = JSON.parse(text("contract.json")) as { kinds: { page: string }[] };
    for (const page of ["signin", "open", "callback"]) {
      (contract.kinds[0] as { page: string }).page = `${ISLAND_FILES_PREFIX}${page}`;
      const files = new Map(folder.files).set("contract.json", new TextEncoder().encode(JSON.stringify(contract)));
      const held = islandFilesFrom(files.set(ISLAND_SUMS_NAME, new TextEncoder().encode(islandSumsText(files))));
      // The sign-in window's page, with its password field, is never framed.
      expect([...held.framed]).toEqual([]);
      expect(held.problems).toEqual([
        `contract.json lists ${page}.html for a kind, and this build frames no such page`,
        "this build frames rows.html, and contract.json lists it for no kind",
      ]);
    }
  });
});

describe("serving the page files", () => {
  test("every file is served exactly as it is in the repository, with no sign-in", async () => {
    for (const name of NAMES) {
      const response = await fetch(`${shared.origin}/island/v1/${name}`);
      expect(response.status).toBe(200);
      const served = new Uint8Array(await response.arrayBuffer());
      expect(Buffer.from(served).equals(readFileSync(path.join(ISLAND_FOLDER, name)))).toBe(true);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  test("each kind of file says what it is", async () => {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json",
    };
    for (const name of NAMES) {
      const expected = name === ISLAND_SUMS_NAME ? "text/plain; charset=utf-8" : types[path.extname(name)];
      expect(`${name}: ${(await fetch(`${shared.origin}/island/v1/${name}`)).headers.get("content-type")}`).toBe(`${name}: ${expected}`);
    }
  });

  test("a page also answers without .html, with the same bytes", async () => {
    for (const name of PAGE_NAMES) {
      const short = await fetch(`${shared.origin}/island/v1/${name.slice(0, -".html".length)}`);
      expect(short.status).toBe(200);
      expect(short.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(Buffer.from(await short.arrayBuffer()).equals(readFileSync(path.join(ISLAND_FOLDER, name)))).toBe(true);
    }
  });

  test("a HEAD answers the headers and no body, and a file takes no other method", async () => {
    const head = await fetch(`${shared.origin}/island/v1/island.js`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const refused = await fetch(`${shared.origin}/island/v1/island.js`, { method, headers: { origin: shared.origin } });
      expect(refused.status).toBe(405);
      expect(refused.headers.get("allow")).toBe("GET, HEAD");
    }
  });

  test("a file that is not a page says which bytes it is, and is not sent again to a browser that holds them", async () => {
    for (const name of NAMES.filter((n) => !n.endsWith(".html"))) {
      const address = `${shared.origin}/island/v1/${name}`;
      const first = await fetch(address);
      const etag = first.headers.get("etag") ?? "";
      expect(etag).toBe(`"${sha256Hex(readFileSync(path.join(ISLAND_FOLDER, name)))}"`);
      for (const held of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
        const again = await fetch(address, { headers: { "if-none-match": held } });
        expect(`${name} ${held}: ${again.status}`).toBe(`${name} ${held}: 304`);
        expect(await again.text()).toBe("");
        expect(again.headers.get("etag")).toBe(etag);
        expect(again.headers.get("content-security-policy")).toBe(OWN_PAGE_CSP);
        expect(again.headers.get("cache-control")).toBe("no-cache");
      }
      expect((await fetch(address, { headers: { "if-none-match": '"other"' } })).status).toBe(200);
    }
  });

  test("a page is always sent whole: who may frame it can change while a browser holds an earlier answer", async () => {
    for (const name of PAGE_NAMES) {
      const address = `${shared.origin}/island/v1/${name}`;
      expect((await fetch(address)).headers.get("etag")).toBeNull();
      const again = await fetch(address, { headers: { "if-none-match": "*" } });
      expect(again.status).toBe(200);
      expect((await again.text()).length).toBeGreaterThan(0);
    }
  });

  test("nothing else answers under /island/, and the console's app shell is never served there", async () => {
    const shell = await (await fetch(`${shared.origin}/some/console/view`)).text();
    for (const address of [
      "/island",
      "/island/",
      "/island/v1",
      "/island/v1/",
      "/island/v1/nothing",
      "/island/v1/nothing.js",
      "/island/v1/rows/",
      "/island/v1/rows.html/",
      "/island/v1/ROWS",
      "/island/v1/tsconfig.json",
      "/island/v1/sha256sums",
      "/island/v2/rows",
      "/island/v1/..%2f..%2fpackage.json",
      "/island/v1/rows%00.html",
      "/island/v1/__proto__",
      "/island/v1/constructor",
      "/island/v1/toString",
    ]) {
      const response = await fetch(`${shared.origin}${address}`);
      expect(`${address} ${response.status}`).toBe(`${address} 404`);
      const body = await response.text();
      expect(body).toBe("Not found");
      expect(body).not.toBe(shell);
      expect(response.headers.get("content-security-policy")).toBe(OWN_PAGE_CSP);
    }
    // Dot segments are resolved before the request is sent, so this one names
    // a path outside /island/ and is the console's to refuse.
    const climbed = await fetch(`${shared.origin}/island/v1/%2e%2e/%2e%2e/package.json`);
    expect(climbed.status).toBe(404);
    expect(await climbed.text()).toBe("Not found");
  });

  test("a console with no page files answers 404 for every such address, never its app shell", async () => {
    rig = await startIslandRig({ withoutDoor: true });
    for (const address of ["/island/v1/rows", "/island/v1/island.js", "/island/v1/config", "/island"]) {
      const response = await fetch(`${rig.origin}${address}`);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");
      expect(response.headers.get("content-security-policy")).toBe(OWN_PAGE_CSP);
    }
  });

  test("a request that names another host is refused before the door", async () => {
    const response = await fetch(`${shared.origin}/island/v1/rows`, { headers: { host: "elsewhere.example" } });
    expect(response.status).toBe(400);
  });
});

describe("the door's budget", () => {
  /** Spend what is left of a budget for this machine's own address. */
  const spend = (of: IslandRig, bucket: "islandFile" | "asset" | "font"): void => {
    // The bucket's own limit, from the table of buckets.
    // eslint-disable-next-line security/detect-object-injection
    for (let i = 0; i < BUCKETS[bucket].limit; i += 1) of.runtime.take(bucket, "127.0.0.1");
  };

  test("everything under /island/ spends one budget, found or not, and is refused once it is used up", async () => {
    rig = await startIslandRig();
    spend(rig, "islandFile");
    for (const address of ["/island/v1/rows", "/island/v1/island.js", "/island/v1/config", "/island/v1/nothing", "/island/v2/x", "/island"]) {
      const refused = await fetch(`${rig.origin}${address}`);
      expect(`${address} ${refused.status}`).toBe(`${address} 429`);
      expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(refused.headers.get("content-security-policy")).toBe(OWN_PAGE_CSP);
    }
    const posted = await fetch(`${rig.origin}/island/v1/island.js`, { method: "POST", headers: { origin: rig.origin } });
    expect(posted.status).toBe(429);
  });

  test("a console with no page files spends the same budget", async () => {
    rig = await startIslandRig({ withoutDoor: true });
    spend(rig, "islandFile");
    expect((await fetch(`${rig.origin}/island/v1/rows`)).status).toBe(429);
  });

  test("the door's budget and the console's own are apart: neither uses the other's up", async () => {
    rig = await startIslandRig();
    spend(rig, "islandFile");
    expect((await fetch(`${rig.origin}/`)).status).toBe(200);
    expect((await fetch(`${rig.origin}/fonts/inter-400.woff2`)).status).toBe(200);
    await rig.cleanup();
    rig = await startIslandRig();
    spend(rig, "asset");
    expect((await fetch(`${rig.origin}/`)).status).toBe(429);
    expect((await fetch(`${rig.origin}/island/v1/rows`)).status).toBe(200);
    expect((await fetch(`${rig.origin}/island/v1/config`)).status).toBe(200);
    // The fonts, which a frame loads too, are not counted with the console's shell.
    expect((await fetch(`${rig.origin}/fonts/inter-400.woff2`)).status).toBe(200);
  });

  test("the fonts have a budget of their own: frames that use it up leave the console's shell and the page files alone", async () => {
    rig = await startIslandRig();
    spend(rig, "font");
    expect((await fetch(`${rig.origin}/fonts/inter-400.woff2`)).status).toBe(429);
    expect((await fetch(`${rig.origin}/`)).status).toBe(200);
    expect((await fetch(`${rig.origin}/island/v1/island.css`)).status).toBe(200);
    expect((await fetch(`${rig.origin}/island/v1/rows`)).status).toBe(200);
  });
});

describe("the headers of a page file", () => {
  const headersOf = async (address: string, of: IslandRig = shared): Promise<Headers> =>
    (await fetch(`${of.origin}${address}`)).headers;

  test("a kind's page may be framed by the one origin the settings name, and sandboxes itself", async () => {
    for (const name of FRAMED) {
      for (const address of [`/island/v1/${name}`, `/island/v1/${name.slice(0, -".html".length)}`]) {
        const headers = await headersOf(address);
        expect(headers.get("content-security-policy")).toBe(
          "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; " +
            `connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${PAGES}; ` +
            "sandbox allow-scripts allow-same-origin",
        );
        expect(headers.get("x-content-type-options")).toBe("nosniff");
        expect(headers.get("referrer-policy")).toBe("no-referrer");
        expect(headers.get("cache-control")).toBe("no-cache");
        expect(headers.get("x-frame-options")).toBeNull();
      }
    }
  });

  test("the frame's own words for its sandbox are the ones contract.json gives the page around it", () => {
    const contract = JSON.parse(text("contract.json")) as { frame: { sandbox: string } };
    expect(contract.frame.sandbox).toBe(ISLAND_FRAME_SANDBOX);
    expect(framedPageCsp(PAGES)).toEndWith(`; sandbox ${contract.frame.sandbox}`);
  });

  test("while no origin is set, no page may be framed", async () => {
    rig = await startIslandRig({ pages: null });
    expect((await headersOf("/island/v1/rows", rig)).get("content-security-policy")).toBe(framedPageCsp(null));
    expect(framedPageCsp(null)).toContain("frame-ancestors 'none'; sandbox allow-scripts allow-same-origin");
  });

  test("while the connection to the control plane is cut, no page may be framed", async () => {
    rig = await startIslandRig({ connected: false });
    expect((await headersOf("/island/v1/rows", rig)).get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  test("a setting that changes lands on a running console, both ways", async () => {
    rig = await startIslandRig();
    expect((await headersOf("/island/v1/rows", rig)).get("content-security-policy")).toContain(`frame-ancestors ${PAGES};`);
    await rig.configure({ connected: false });
    expect((await headersOf("/island/v1/rows", rig)).get("content-security-policy")).toContain("frame-ancestors 'none'");
    await rig.configure({ pages: "https://pages.control.example" });
    expect((await headersOf("/island/v1/rows", rig)).get("content-security-policy")).toContain(
      "frame-ancestors https://pages.control.example;",
    );
  });

  test("a config.json that does not parse, or is gone, frames nothing", async () => {
    rig = await startIslandRig();
    const { writeFile, rm } = await import("node:fs/promises");
    await writeFile(rig.configFile, "{ not json");
    expect((await headersOf("/island/v1/rows", rig)).get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(rig.warnings).toEqual([`${rig.configFile} is not JSON, so no Secure Data Island is shown until it is fixed`]);
    await rm(rig.configFile);
    expect((await headersOf("/island/v1/rows", rig)).get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  test("the environment's origin wins over the file, and one that is no origin frames nothing", async () => {
    rig = await startIslandRig({ env: { FORTRESS_CONTROL_PLANE_PAGES: "https://env.control.example" } });
    expect((await headersOf("/island/v1/rows", rig)).get("content-security-policy")).toContain(
      "frame-ancestors https://env.control.example;",
    );
    await rig.cleanup();
    rig = await startIslandRig({ env: { FORTRESS_CONTROL_PLANE_PAGES: "https://*.control.example" } });
    expect((await headersOf("/island/v1/rows", rig)).get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  test("every other page opens as a window of its own: framed by nothing, and not sandboxed", async () => {
    expect(OWN.sort()).toEqual(["callback.html", "open.html", "signin.html"]);
    expect(OWN_PAGE_CSP).toEndWith("form-action 'none'; frame-ancestors 'none'");
    expect(OWN_PAGE_CSP).not.toContain("sandbox");
    for (const name of OWN) {
      const headers = await headersOf(`/island/v1/${name.slice(0, -".html".length)}`);
      expect(headers.get("content-security-policy")).toBe(OWN_PAGE_CSP);
      expect(headers.get("cache-control")).toBe("no-cache");
    }
  });

  test("a script, the styles and the lists carry the same headers, framed by nothing", async () => {
    for (const name of NAMES.filter((n) => !n.endsWith(".html"))) {
      const headers = await headersOf(`/island/v1/${name}`);
      expect(headers.get("content-security-policy")).toBe(OWN_PAGE_CSP);
      expect(headers.get("x-content-type-options")).toBe("nosniff");
      expect(headers.get("referrer-policy")).toBe("no-referrer");
      expect(headers.get("cache-control")).toBe("no-cache");
    }
  });

  test("strict-transport-security is sent over https only", async () => {
    expect((await headersOf("/island/v1/rows")).get("strict-transport-security")).toBeNull();
    const ctx = {
      door: { files: shared.files, settings: () => Promise.resolve({ pages: PAGES, organization: ORGANIZATION }) },
      runtime: shared.runtime,
      remoteKey: "203.0.113.9",
    };
    for (const address of ["/island/v1/rows", "/island/v1/island.js", "/island/v1/config", "/island/v1/nothing"]) {
      const overHttps = await handleIslandRequest(new Request(`https://hx.northstar.example${address}`), { ...ctx, hsts: true });
      expect(overHttps.headers.get("strict-transport-security")).toBe("max-age=31536000");
      const plain = await handleIslandRequest(new Request(`http://127.0.0.1${address}`), { ...ctx, hsts: false });
      expect(plain.headers.get("strict-transport-security")).toBeNull();
    }
  });

  test("the console's own pages are still framed by nothing", async () => {
    const csp = (await headersOf("/")).get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain(PAGES);
  });
});

describe("what a page file reads from HX Fortress", () => {
  test("config says who may frame a page, the organization's name and how its people sign in, with no sign-in", async () => {
    const response = await fetch(`${shared.origin}/island/v1/config`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toBe(OWN_PAGE_CSP);
    const said = (await response.json()) as Record<string, unknown>;
    expect(said).toEqual({ v: 1, pages: PAGES, organization: ORGANIZATION, signIn: "account" });
    // What contract.json lists for it, and nothing else.
    const contract = JSON.parse(text("contract.json")) as { config: { fields: Record<string, unknown> } };
    expect(Object.keys(said).sort()).toEqual(Object.keys(contract.config.fields).sort());
  });

  test("an organization's name is said as it is, also when a word of it looks like a credential's", async () => {
    rig = await startIslandRig({ organization: "Token Security" });
    const said = (await (await fetch(`${rig.origin}/island/v1/config`)).json()) as { organization: unknown };
    expect(said.organization).toBe("Token Security");
  });

  test("an HX Fortress that shows no Secure Data Island says nothing of itself", async () => {
    const closed = { v: 1, pages: null, organization: null, signIn: "account" };
    // No origin is set: the organization's name is not said either.
    rig = await startIslandRig({ pages: null });
    expect(await (await fetch(`${rig.origin}/island/v1/config`)).json()).toEqual(closed);
    // The connection is cut: the same.
    await rig.configure({ connected: false });
    expect(await (await fetch(`${rig.origin}/island/v1/config`)).json()).toEqual(closed);
    // An organization with no name set is null, with pages that may frame.
    await rig.configure({ organization: null });
    expect(await (await fetch(`${rig.origin}/island/v1/config`)).json()).toEqual({ ...closed, pages: PAGES });
  });
});

describe("what answers at the door", () => {
  test("every route of the door's list answers its own method, and refuses every other", async () => {
    expect(ISLAND_ROUTES.map((route) => `${route.method} ${route.path}`)).toEqual(["GET /island/v1/config"]);
    for (const route of ISLAND_ROUTES) {
      expect(route.needs).toBe("nothing");
      expect((await fetch(`${shared.origin}${route.path}`, { method: route.method })).status).toBe(200);
      for (const method of ["POST", "PUT", "DELETE", "PATCH"].filter((m) => m !== route.method)) {
        const refused = await fetch(`${shared.origin}${route.path}`, { method, headers: { origin: shared.origin } });
        expect(`${method} ${route.path}: ${refused.status}`).toBe(`${method} ${route.path}: 405`);
      }
    }
  });

  test("every route's first word is kept from the names a page may take", () => {
    for (const route of ISLAND_ROUTES) {
      expect(ISLAND_ROUTE_WORDS).toContain(route.path.slice(ISLAND_FILES_PREFIX.length).split("/")[0] as string);
    }
  });

  test("every address a page script calls is a route's word, or lies under a page's own name", () => {
    const called = new Set<string>();
    for (const name of NAMES.filter((n) => n.endsWith(".js"))) {
      for (const found of text(name).matchAll(/\b(?:api|call)\("([a-z/-]+)"/g)) called.add(found[1] as string);
      for (const found of text(name).matchAll(/new URL\("([a-z/-]+)", BASE\)/g)) called.add(found[1] as string);
    }
    expect([...called].sort()).toEqual([
      "claim", "config", "event", "read", "session", "signin", "signin/code", "signin/password", "signin/provider",
      "signin/provider/finish", "signout",
    ]);
    for (const address of called) {
      const [word, ...rest] = address.split("/");
      // `signin` is a page. What lies under it holds a slash, which no page's name can.
      if (word === "signin") expect(rest.length === 0 ? PAGE_NAMES.includes("signin.html") : true).toBe(true);
      else expect(ISLAND_ROUTE_WORDS).toContain(word as string);
    }
  });
});

describe("a build", () => {
  const read = (file: string): string => readFileSync(path.join(REPOSITORY, file), "utf8");

  test("a change to a page file alone starts a release build", () => {
    const paths = (read(".github/workflows/release.yml").split("    paths:\n")[1] ?? "").split("\n  workflow_dispatch:")[0];
    expect(paths).toContain('      - "islands/**"\n');
  });

  test("every way a binary is made checks the two lists against the folder first", () => {
    expect(packageJson.scripts["check:islands"]).toBe("bun scripts/gen-island-files.ts --check");
    expect(packageJson.scripts.build).toContain("&& bun run check:islands &&");
    for (const workflow of [".github/workflows/release.yml", ".github/workflows/dev-build.yml"]) {
      const text = read(workflow);
      expect(text).toContain("run: bun run check:islands");
      expect(text.indexOf("run: bun run check:islands")).toBeLessThan(text.indexOf("- name: Compile darwin/linux binaries"));
    }
  });

  test("the check passes on this checkout", () => {
    const check = spawnSync("bun", ["scripts/gen-island-files.ts", "--check"], { cwd: REPOSITORY, encoding: "utf8" });
    expect(check.status).toBe(0);
    expect(check.stdout).toContain("both lists match the folder");
  });

  test("the scripts' types are checked with the rest", () => {
    expect(packageJson.scripts.typecheck).toBe("tsc --noEmit && tsc --noEmit -p islands/tsconfig.json");
  });
});
