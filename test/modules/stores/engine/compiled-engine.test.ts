import { afterEach, expect, test } from "bun:test";
import path from "node:path";

import { STORE_PROCESS_VERB } from "../../../../src/modules/stores/host/process-protocol";
import { makeStoreFolder, storeFolder } from "../../../../src/modules/stores/host/store-folder";
import { StoreProcess } from "../../../../src/modules/stores/host/store-process";
import { NO_PARENT_EXIT } from "../../../../src/modules/stores/host/store-process-main";
import { STORE_ID_SETTING } from "../../../../src/modules/stores/store-calls";
import { endStoresRigs, storesRig } from "../_module-rig";
import { cleanFolders, commandLauncher, compileProgram, tempFolder } from "../_rig";

afterEach(async () => {
  await endStoresRigs();
  cleanFolders();
});

// HX Fortress ships as one compiled program, and the Store's engine is
// compiled into it with the packages its readers import. This compiles the
// program itself, as the release does, and starts it with the Store's word:
// the word reaches the engine through the command line, which loads the
// engine only for that word.
test(
  "the compiled program, started with the Store's word, is a Store's process with the engine in it",
  async () => {
    const program = compileProgram(path.join(import.meta.dir, "..", "..", "..", "..", "src", "cli.ts"), "compiled-engine");

    // Run by hand, it has no parent to talk to: it says what it is and ends.
    const byHand = Bun.spawnSync([program, STORE_PROCESS_VERB], { stdout: "pipe", stderr: "pipe", env: {}, timeout: 30_000 });
    expect(byHand.exitCode).toBe(NO_PARENT_EXIT);
    expect(byHand.stdout.toString()).toContain("HX Fortress starts it itself");

    // Started by a parent that talks to it, it opens a new Store and answers
    // the module's calls.
    const folder = storeFolder(path.join(tempFolder("compiled-engine-store"), "s000001"));
    expect(makeStoreFolder(folder)).toBe(true);
    const store = new StoreProcess({
      folder: folder.root,
      launcher: commandLauncher([program, STORE_PROCESS_VERB], folder.scratch),
      settings: { [STORE_ID_SETTING]: "store-1" },
      limitMs: 30_000,
      idleMs: 0,
    });
    try {
      type Answer<T> = { ok: true; value: T } | { ok: false; code: string };
      const stats = (await store.call("stats")) as Answer<{ tables: number; writes: { limit: number; own: boolean } }>;
      const limit = (await store.call("setWriteLimit", [5_000])) as Answer<{ limit: number; own: boolean }>;
      const catalog = (await store.call("catalog", [0, 40])) as Answer<{ tables: { kind: string }[]; total: number }>;
      const job = (await store.call("jobSummary", ["job_none"])) as Answer<unknown>;
      const other = (await store.call("exec", ["SELECT 1"])) as Answer<unknown>;
      expect({
        stats: stats.ok ? { tables: stats.value.tables, limit: stats.value.writes.limit, own: stats.value.writes.own } : stats.code,
        limit: limit.ok ? { limit: limit.value.limit, own: limit.value.own } : limit.code,
        catalog: catalog.ok ? catalog.value.tables.length === catalog.value.total && catalog.value.total > 0 : catalog.code,
        job: job.ok ? "answered" : job.code,
        other: other.ok ? "answered" : other.code,
      }).toEqual({
        stats: { tables: 0, limit: 2_000_000, own: false },
        limit: { limit: 5_000, own: true },
        catalog: true,
        job: "not_found",
        other: "bad_request",
      });
    } finally {
      await store.dispose();
    }

    // And as in a daemon that runs the compiled program: the module host
    // starts the program again with the Store's word, for the module, and the
    // module's asks are answered by the engine in it.
    const made = await storesRig({ program: [program] });
    expect(await made.ask("create", { store: "store-1" })).toEqual({
      ok: true,
      payload: { store: "store-1", state: "ready", created: true },
    });
    expect(await made.ask("stats.read", { store: "store-1" })).toMatchObject({
      ok: true,
      payload: { tables: 0, rows: 0, writeLimit: 2_000_000, ownLimit: false },
    });
    expect(await made.ask("write_limit.set", { store: "store-1", rows: 5_000 })).toMatchObject({
      ok: true,
      payload: { writeLimit: 5_000, ownLimit: true },
    });
    // The whole command is the program and the word.
    expect(made.started.map((start) => start.command)).toEqual([[program, STORE_PROCESS_VERB]]);
  },
  180_000,
);
