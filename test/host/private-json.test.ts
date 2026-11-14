// The one writer of this HX Fortress's owner-only files.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writePrivateJson } from "../../src/host/private-json";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "hx-private-json-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writePrivateJson", () => {
  test("writes the file for its owner only, in a folder for its owner only, and leaves nothing beside it", async () => {
    const file = path.join(dir, "kept", "state.json");
    await writePrivateJson(file, { n: 1 });
    await writePrivateJson(file, { n: 2 });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ n: 2 });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect(await readdir(path.dirname(file))).toEqual(["state.json"]);
  });

  test("a write that fails leaves no temporary file, however often it is tried", async () => {
    // A folder where the file should be: the rename onto it fails every time.
    const file = path.join(dir, "kept", "state.json");
    await mkdir(file, { recursive: true });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(writePrivateJson(file, { attempt })).rejects.toThrow();
    }
    expect(await readdir(path.dirname(file))).toEqual(["state.json"]);
  });
});
