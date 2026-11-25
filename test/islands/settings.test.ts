// What a Secure Data Island reads of this HX Fortress's settings: which keys
// of config.json it goes by, what every failure reads as, and what it says.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ISLANDS_CLOSED, LiveIslandSettings, islandsOpen } from "../../src/ui/island-settings";
import { ORGANIZATION, PAGES, configJson, writeAsConfig } from "./_rig";

let root: string;
let file: string;
let warnings: string[];
const reader = (env: Record<string, string | undefined> = {}): LiveIslandSettings =>
  new LiveIslandSettings(file, env, (message) => warnings.push(message));

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hx-island-settings-"));
  file = path.join(root, "config.json");
  warnings = [];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("open or closed", () => {
  test("open with a control plane and the origin of its pages", async () => {
    await writeAsConfig(file, configJson());
    const settings = await reader().read();
    expect(settings).toEqual({ pages: PAGES, organization: ORGANIZATION });
    expect(islandsOpen(settings)).toBe(true);
    expect(warnings).toEqual([]);
  });

  test("closed with no origin set, and with no control plane", async () => {
    await writeAsConfig(file, configJson({ pages: null }));
    expect(islandsOpen(await reader().read())).toBe(false);
    // An administrator cut the connection: the origin is still in the file,
    // and it frames nothing.
    await writeAsConfig(file, configJson({ connected: false }));
    expect(await reader().read()).toEqual({ pages: null, organization: ORGANIZATION });
    expect(islandsOpen(ISLANDS_CLOSED)).toBe(false);
    expect(warnings).toEqual([]);
  });

  test("the environment's origin wins over the file, and one that is no origin closes", async () => {
    await writeAsConfig(file, configJson());
    expect((await reader({ FORTRESS_CONTROL_PLANE_PAGES: "https://env.control.example" }).read()).pages).toBe(
      "https://env.control.example",
    );
    for (const value of ["https://*.control.example", "https://a.example https://b.example", "https://a.example/path", "none"]) {
      expect((await reader({ FORTRESS_CONTROL_PLANE_PAGES: value }).read()).pages).toBeNull();
    }
    // The environment names an origin, and the file names no control plane.
    await writeAsConfig(file, configJson({ connected: false }));
    expect((await reader({ FORTRESS_CONTROL_PLANE_PAGES: "https://env.control.example" }).read()).pages).toBeNull();
  });
});

describe("which keys count", () => {
  test("a value elsewhere in the file that the daemon would refuse closes nothing", async () => {
    const held = JSON.parse(configJson()) as Record<string, unknown>;
    await writeAsConfig(file, JSON.stringify({ ...held, model: { provider: "Not An Option" }, schemaVersion: 7 }));
    expect(await reader().read()).toEqual({ pages: PAGES, organization: ORGANIZATION });
    expect(warnings).toEqual([]);
  });

  test("a control plane setting that is not valid closes, and is said once", async () => {
    const held = JSON.parse(configJson()) as Record<string, unknown>;
    const said = `${file} holds a control plane setting that is not valid, so no Secure Data Island is shown until it is fixed`;
    for (const broken of [
      { ...held, controlPlane: { pages: "https://*.control.example" } },
      { ...held, controlPlane: { pages: PAGES, extra: true } },
      { ...held, cloud: { url: 7 } },
      { ...held, cloud: "wss://connect.control.example" },
    ]) {
      warnings = [];
      const live = reader();
      await writeAsConfig(file, JSON.stringify(broken));
      expect(await live.read()).toEqual(ISLANDS_CLOSED);
      expect(await live.read()).toEqual(ISLANDS_CLOSED);
      expect(warnings).toEqual([said]);
      // The same fault in the next version of the file is not said again.
      await writeAsConfig(file, JSON.stringify({ ...broken, modules: { enabled: [] } }));
      expect(await live.read()).toEqual(ISLANDS_CLOSED);
      expect(warnings).toEqual([said]);
    }
  });

  test("an organization name that is not one is not shown, and closes nothing", async () => {
    const held = JSON.parse(configJson()) as Record<string, unknown>;
    await writeAsConfig(file, JSON.stringify({ ...held, organization: { name: "" } }));
    expect(await reader().read()).toEqual({ pages: PAGES, organization: null });
  });
});

describe("a file that cannot be read", () => {
  test("no file is closed, and nothing is said: the daemon says that", async () => {
    expect(await reader().read()).toEqual(ISLANDS_CLOSED);
    expect(warnings).toEqual([]);
  });

  test("a file that is not JSON is closed, said once, and open again once it is fixed", async () => {
    const live = reader();
    for (const text of ["{ not json", "[]", '"text"', "null"]) {
      await writeAsConfig(file, text);
      expect(await live.read()).toEqual(ISLANDS_CLOSED);
      expect(await live.read()).toEqual(ISLANDS_CLOSED);
    }
    expect(warnings).toEqual([`${file} is not JSON, so no Secure Data Island is shown until it is fixed`]);
    await writeAsConfig(file, configJson());
    expect((await live.read()).pages).toBe(PAGES);
    // The same fault later is said again: it is a new one.
    await writeAsConfig(file, "{ not json");
    await live.read();
    expect(warnings.length).toBe(2);
  });

  test("a read that fails is not remembered: the next request reads again", async () => {
    // Not for an administrator of the machine, who reads every file.
    if (process.getuid?.() === 0) return;
    await writeAsConfig(file, configJson());
    const live = reader();
    await chmod(file, 0o000);
    expect(await live.read()).toEqual(ISLANDS_CLOSED);
    expect(await live.read()).toEqual(ISLANDS_CLOSED);
    expect(warnings).toEqual([
      `${file} could not be read (EACCES), so no Secure Data Island is shown until it can be`,
    ]);
    // The same file, unchanged, readable again: open with no new write.
    await chmod(file, 0o600);
    expect((await live.read()).pages).toBe(PAGES);
  });

  test("a warning never holds a piece of the file", async () => {
    await writeFile(file, '{ "postgres": { "url": "postgres://app:not-for-a-log@db.internal/hx" }, oops');
    await reader().read();
    expect(warnings.join("\n")).not.toContain("not-for-a-log");
    expect(warnings.join("\n")).not.toContain("postgres://");
  });

  test("a change lands without a restart, in both directions", async () => {
    await writeAsConfig(file, configJson());
    const live = reader();
    expect((await live.read()).pages).toBe(PAGES);
    await writeAsConfig(file, configJson({ connected: false }));
    expect((await live.read()).pages).toBeNull();
    await writeAsConfig(file, configJson({ pages: "https://pages.control.example" }));
    expect((await live.read()).pages).toBe("https://pages.control.example");
  });
});
