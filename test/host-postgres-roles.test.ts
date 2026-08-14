import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureRoleSecrets } from "../src/host/postgres/roles";

describe("ensureRoleSecrets", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "hx-pg-roles-"));
    file = path.join(dir, "nested", "roles.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("mints three distinct URL-safe hex secrets and persists them 0600", async () => {
    const secrets = await ensureRoleSecrets(file);
    for (const v of [secrets.super, secrets.appRo, secrets.appRw]) {
      expect(v).toMatch(/^[0-9a-f]{48}$/);
    }
    expect(new Set([secrets.super, secrets.appRo, secrets.appRw]).size).toBe(3);

    // Persisted content matches, and the file is owner-read/write only.
    const onDisk = JSON.parse(await readFile(file, "utf8"));
    expect(onDisk).toEqual(secrets);
    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("is idempotent — a second call returns the persisted secrets unchanged", async () => {
    const first = await ensureRoleSecrets(file);
    const second = await ensureRoleSecrets(file);
    expect(second).toEqual(first);
  });

  test("regenerates when the file is present but partial/corrupt", async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ super: "only-super" }));
    const secrets = await ensureRoleSecrets(file);
    expect(secrets.appRo).toMatch(/^[0-9a-f]{48}$/);
    expect(secrets.appRw).toMatch(/^[0-9a-f]{48}$/);
    // The regenerated triple is what is now persisted.
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(secrets);
  });

  test("regenerates when the file is not valid JSON", async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "not json {");
    const secrets = await ensureRoleSecrets(file);
    expect(secrets.super).toMatch(/^[0-9a-f]{48}$/);
  });
});
