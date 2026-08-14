import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { fortressPaths } from "../src/host/paths";
import { FileStatusStore } from "../src/host/status";
import type { HostStatusSnapshot } from "../src/host/types";

describe("Fortress runtime status", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-status-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("atomically writes and replaces the secret-free status snapshot", async () => {
    const paths = fortressPaths(root);
    const store = new FileStatusStore(paths);
    const starting = snapshot("starting", "2026-06-15T10:00:00.000Z");
    const running = snapshot("running", "2026-06-15T10:00:01.000Z");

    await store.write(starting);
    expect(JSON.parse(await readFile(paths.status, "utf8"))).toEqual(starting);

    await store.write(running);
    const contents = await readFile(paths.status, "utf8");
    expect(contents).toBe(`${JSON.stringify(running, null, 2)}\n`);
    expect(Object.keys(JSON.parse(contents)).sort()).toEqual([
      "connection",
      "host",
      "modules",
      "postgres",
      "schemaVersion",
    ]);
    expect(await readdir(path.dirname(paths.status))).toEqual(["status.json"]);
  });
});

function snapshot(
  state: HostStatusSnapshot["host"]["state"],
  updatedAt: string,
): HostStatusSnapshot {
  return {
    schemaVersion: 1,
    host: {
      state,
      pid: 123,
      startedAt: "2026-06-15T10:00:00.000Z",
      updatedAt,
      error: null,
    },
    connection: {
      state: state === "running" ? "connected" : "connecting",
      reason: null,
      message: null,
    },
    postgres: { phase: "ready", reason: null },
    modules: [
      {
        id: "session_vault",
        state: state === "running" ? "running" : "starting",
        error: null,
      },
    ],
  };
}
