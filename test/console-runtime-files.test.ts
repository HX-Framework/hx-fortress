import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CMD_CRED_TTL_MS,
  consumeCredentialRef,
  credentialRefPath,
  mintCredentialRef,
  sweepCmdCreds,
  writeCredentialRef,
} from "../src/console/cmd-creds";
import { addInFlight, readInFlight, removeInFlight } from "../src/console/runtime-files";

const REF = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";

describe("the in-flight command file", () => {
  let root = "";
  let file = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-inflight-"));
    file = path.join(root, "runtime", "commands-inflight.json");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("round-trips ids and is owner-only", async () => {
    expect(await readInFlight(file)).toEqual(new Set());
    await addInFlight(file, "a");
    await addInFlight(file, "b");
    await addInFlight(file, "a");
    expect(await readInFlight(file)).toEqual(new Set(["a", "b"]));
    await removeInFlight(file, "a");
    expect(await readInFlight(file)).toEqual(new Set(["b"]));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
  });

  test("a corrupt file reads as empty rather than throwing", async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{not json");
    expect(await readInFlight(file)).toEqual(new Set());
  });
});

describe("command credential files", () => {
  let root = "";
  let dir = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-cmdcred-"));
    dir = path.join(root, "cmd-creds");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("a reference is single-use: the file is unlinked as it is read", async () => {
    await writeCredentialRef(dir, REF, { s3: { accessKeyId: "AKIA", secretAccessKey: "x" } });
    expect(await consumeCredentialRef<{ s3: { accessKeyId: string } }>(dir, REF)).toEqual({
      s3: { accessKeyId: "AKIA", secretAccessKey: "x" },
    } as never);
    // A re-driven or replayed command cannot re-run the rotation.
    expect(await consumeCredentialRef(dir, REF)).toBeNull();
  });

  test("minted ids match the reference shape", () => {
    expect(mintCredentialRef()).toMatch(/^[0-9a-f]{32}$/);
  });

  test("traversal and absolute paths are refused by shape alone", async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (const ref of ["../secrets", "/etc/passwd", "..", "a".repeat(31), "A".repeat(32), ""]) {
      expect(await credentialRefPath(dir, ref)).toBeNull();
      expect(await consumeCredentialRef(dir, ref)).toBeNull();
    }
  });

  test("a symlink planted inside the directory is refused", async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const outside = path.join(root, "outside.json");
    await writeFile(outside, JSON.stringify({ stolen: true }), { mode: 0o600 });
    await symlink(outside, path.join(dir, `${REF}.json`));
    // The name matches, so only resolving the real path catches this.
    expect(await credentialRefPath(dir, REF)).toBeNull();
    expect(await consumeCredentialRef(dir, REF)).toBeNull();
  });

  test("the sweep removes orphans past the TTL and leaves fresh ones", async () => {
    await writeCredentialRef(dir, REF, { a: 1 });
    await writeCredentialRef(dir, OTHER, { b: 2 });
    const stale = new Date(Date.now() - CMD_CRED_TTL_MS - 60_000);
    await utimes(path.join(dir, `${REF}.json`), stale, stale);

    const result = await sweepCmdCreds(dir);
    expect(result.deleted).toEqual([REF]);
    expect(await consumeCredentialRef<{ b: number }>(dir, OTHER)).toEqual({ b: 2 } as never);
  });

  test("sweeping a directory that does not exist is a no-op", async () => {
    expect(await sweepCmdCreds(path.join(root, "absent"))).toEqual({ deleted: [] });
  });
});
