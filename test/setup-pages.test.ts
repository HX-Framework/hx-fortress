// The origin of the control plane's pages: the one origin that may frame a
// page this HX Fortress serves for the control plane to show. It ends up in a
// `frame-ancestors` header, so it is exactly one origin or it is nothing.

import { describe, expect, test } from "bun:test";

import { CONTROL_PLANE_PAGES_ENV, controlPlanePages, pagesOrigin, parseFortressConfig } from "../src/host/config";
import { CONTROL, PAGES } from "./setup-rig";

const BASE = { schemaVersion: 1, gateway: { publicUrl: "http://localhost:8787" }, modules: { enabled: [] } };

function config(extra: Record<string, unknown>): ReturnType<typeof parseFortressConfig> {
  return parseFortressConfig({ ...BASE, ...extra });
}

describe("pagesOrigin", () => {
  test("takes one origin, written the one way a browser compares it", () => {
    expect(pagesOrigin(PAGES)).toBe(PAGES);
    expect(pagesOrigin(`${PAGES}/`)).toBe(PAGES);
    expect(pagesOrigin(`  ${PAGES}  `)).toBe(PAGES);
    expect(pagesOrigin("https://app.control.example:8443")).toBe("https://app.control.example:8443");
    // A default port is dropped.
    expect(pagesOrigin("https://app.control.example:443")).toBe(PAGES);
    expect(pagesOrigin("http://localhost:80")).toBe("http://localhost");
    // An upper-case host and scheme are lowered.
    expect(pagesOrigin("HTTPS://App.Control.Example")).toBe(PAGES);
    // Cleartext to this machine itself, for a test or a development stack.
    expect(pagesOrigin("http://localhost:9000")).toBe("http://localhost:9000");
    expect(pagesOrigin("http://127.0.0.1:9000")).toBe("http://127.0.0.1:9000");
  });

  test("refuses anything that would widen who may frame a page, or break the header", () => {
    for (const value of [
      "https://*.control.example",
      "https://*",
      "https://app.control.example/pages",
      "https://app.control.example/pages/",
      "https://app.control.example?pages=1",
      "https://app.control.example#pages",
      "https://marta@app.control.example",
      "https://marta:pw@app.control.example",
      "https://app.control .example",
      `${PAGES} https://other.example`,
      `${PAGES};`,
      "https://app.control.example;script-src *",
      "http://app.control.example",
      "http://10.0.0.5:9000",
      "https://app.control.example:0",
      "https://app.control.example:65536",
      "https://app.control.example:99999",
      "https://app..control.example",
      "app.control.example",
      "wss://app.control.example",
      "",
      "   ",
    ]) {
      expect([value, pagesOrigin(value)]).toEqual([value, null]);
    }
    for (const value of [undefined, null, 7, true, {}, [PAGES]]) expect(pagesOrigin(value)).toBeNull();
  });

  test("refuses a value of more than 300 characters, though the same origin with less around it is taken", () => {
    expect(pagesOrigin(PAGES.padEnd(300, " "))).toBe(PAGES);
    expect(PAGES.padEnd(301, " ")).toHaveLength(301);
    expect(pagesOrigin(PAGES.padEnd(301, " "))).toBeNull();
  });
});

describe("controlPlanePages", () => {
  test("is null with no control plane in the config, also when the pages are set: the connection is switched off", () => {
    expect(controlPlanePages(null, {})).toBeNull();
    expect(controlPlanePages(config({}), {})).toBeNull();
    expect(controlPlanePages(config({ controlPlane: { pages: PAGES } }), {})).toBeNull();
    expect(controlPlanePages(config({ controlPlane: { pages: PAGES } }), { [CONTROL_PLANE_PAGES_ENV]: PAGES })).toBeNull();
  });

  test("is the file's origin while a control plane is connected", () => {
    expect(controlPlanePages(config({ cloud: { url: CONTROL }, controlPlane: { pages: PAGES } }), {})).toBe(PAGES);
    expect(controlPlanePages(config({ cloud: { url: CONTROL } }), {})).toBeNull();
  });

  test("the environment wins over the file", () => {
    const connected = config({ cloud: { url: CONTROL }, controlPlane: { pages: PAGES } });
    expect(controlPlanePages(connected, { [CONTROL_PLANE_PAGES_ENV]: "https://pages.control.example" })).toBe(
      "https://pages.control.example",
    );
    expect(controlPlanePages(config({ cloud: { url: CONTROL } }), { [CONTROL_PLANE_PAGES_ENV]: `${PAGES}:443/` })).toBe(PAGES);
    // An empty value names nothing, and the file decides.
    expect(controlPlanePages(connected, { [CONTROL_PLANE_PAGES_ENV]: "  " })).toBe(PAGES);
  });

  test("a value in the environment that is not an origin gives null, even when the file holds a good one", () => {
    const connected = config({ cloud: { url: CONTROL }, controlPlane: { pages: PAGES } });
    for (const value of ["https://*.control.example", `${PAGES}/pages`, "http://app.control.example", "not an origin"]) {
      expect([value, controlPlanePages(connected, { [CONTROL_PLANE_PAGES_ENV]: value })]).toEqual([value, null]);
    }
  });
});

describe("the controlPlane block of config.json", () => {
  test("is taken with one origin, written the one way", () => {
    expect(config({ controlPlane: { pages: "HTTPS://App.Control.Example:443" } }).controlPlane).toEqual({ pages: PAGES });
    expect(config({ controlPlane: {} }).controlPlane).toEqual({});
    expect(config({}).controlPlane).toBeUndefined();
  });

  test("is refused with a key this build does not know, and with pages that are not one origin", () => {
    expect(() => config({ controlPlane: { pages: PAGES, frameAncestors: "*" } })).toThrow(
      "Invalid HX Fortress config: controlPlane takes one setting: pages",
    );
    for (const pages of ["https://*.control.example", `${PAGES}/pages`, "http://app.control.example", 7, ""]) {
      expect(() => config({ controlPlane: { pages } })).toThrow(
        "Invalid HX Fortress config: controlPlane.pages must be one origin, such as https://app.control.example",
      );
    }
    expect(() => config({ controlPlane: PAGES })).toThrow("Invalid HX Fortress config: controlPlane must be an object");
  });
});
