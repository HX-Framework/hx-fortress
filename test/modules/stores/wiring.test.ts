// The Stores module as this build ships it: in the catalog, in the terminal's
// list of modules, and in the daemon, where it takes its processes from the
// module host and is handed nothing else.

import { afterEach, describe, expect, test } from "bun:test";

import { runCli } from "../../../src/cli";
import { catalogEntry, MODULE_CATALOG } from "../../../src/host/module-catalog";
import type { ProcessRule } from "../../../src/host/module-contract";
import { listAsks, moduleDataPaths } from "../../../src/host/modules-api";
import { processWordFor } from "../../../src/host/process-words";
import { STORE_PROCESS_VERB } from "../../../src/modules/stores/host/process-protocol";
import type { StartRefusal } from "../../../src/modules/stores/host/store-process";
import { STORES_MANIFEST } from "../../../src/modules/stores/manifest";
import { createStoresModule, startRefusal } from "../../../src/modules/stores/module";
import { composeDaemon, moduleLines, restoreDaemonEnvironment } from "../../host/_daemon-rig";
import { tempRoot, writeConfig, type Paths } from "../../host/_module-rig";

const ASKS = [
  "create",
  "list",
  "catalog.read",
  "stats.read",
  "history.read",
  "review.read",
  "job.read",
  "write_limit.set",
  "delete",
  "restore",
];

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  restoreDaemonEnvironment();
});

async function bareRoot(enabled: readonly string[]): Promise<Paths> {
  const root = await tempRoot();
  cleanup = root.cleanup;
  await writeConfig(root.paths, enabled);
  return root.paths;
}

describe("the build's catalog", () => {
  test("lists the module with the manifest the module carries", () => {
    const entry = catalogEntry("stores");
    expect(entry).toMatchObject({ id: "stores", title: "Stores", startOnly: false });
    expect(entry?.manifest).toBe(STORES_MANIFEST);
    expect(createStoresModule().manifest).toBe(STORES_MANIFEST);
    expect(MODULE_CATALOG.filter((module) => module.id === "stores")).toHaveLength(1);
  });

  test("a new install starts with the module off", () => {
    expect(catalogEntry("stores")?.defaultOn ?? false).toBe(false);
  });

  test("the control plane may ask it ten things", () => {
    expect(
      listAsks()
        .filter((view) => view.module === "stores")
        .map((view) => view.name),
    ).toEqual(ASKS);
  });

  test("the module has one process started, by a word the host's list gives to it alone", () => {
    expect(STORES_MANIFEST.processes).toEqual([{ verb: STORE_PROCESS_VERB }]);
    expect(processWordFor("stores", STORE_PROCESS_VERB)).toBe(true);
    for (const other of ["databases", "host", "session_vault"]) {
      expect(processWordFor(other, STORE_PROCESS_VERB)).toBe(false);
    }
    // It calls no host and reads no secret.
    expect(STORES_MANIFEST.egress).toEqual([]);
    expect(STORES_MANIFEST.secrets).toEqual([]);
  });
});

describe("why the module host started no process, as a Store is told it", () => {
  test("every rule of the module host has its reason", () => {
    // Every rule a start can be refused by, each named here: a rule the
    // module host adds fails the build at this list until it is given one.
    const rules: Record<ProcessRule, StartRefusal> = {
      // These pass: the module's own start ends, a process ends, and the
      // same start is made then.
      module_not_running: "later",
      processes_unavailable: "later",
      // The folder the process was to be given is gone.
      folder_missing: "folder_missing",
      // The same start meets each of these again.
      process_not_declared: "unavailable",
      process_start_failed: "unavailable",
      folder_name_invalid: "unavailable",
      folder_too_deep: "unavailable",
      organization_not_held: "unavailable",
    };
    for (const [rule, why] of Object.entries(rules)) expect([rule, startRefusal(rule as ProcessRule)]).toEqual([rule, why]);
  });
});

describe("hx-fortress modules list", () => {
  test("shows stores, off, with the process it has started and what a control plane may ask it", async () => {
    const paths = await bareRoot(["session_vault"]);
    const out: string[] = [];
    const code = await runCli(["modules", "list"], {
      fortressRoot: paths.root,
      writeLine: (line) => out.push(line),
    });
    expect(code).toBe(0);
    const from = out.indexOf("stores (Stores): off");
    expect(from).toBeGreaterThan(0);
    expect(out.slice(from, from + 9)).toEqual([
      "stores (Stores): off",
      "  Does:     keeps working copies of tables on this machine, each in a file of its own",
      "  State:    stopped",
      expect.stringMatching(/^ {2}Version: {2}/) as unknown as string,
      "  Calls:    no hosts",
      "  Secrets:  none",
      "  Starts:   hx-fortress store-engine. HX Fortress starts this for the module, as a process of the module's own.",
      "  Asks:     10. A control plane may ask it these and nothing else:",
      "    create",
    ]);
    // The module's own lines: up to where the next module's begin.
    const text = moduleLines(out, "stores (Stores): off").join("\n");
    for (const ask of ASKS) expect(text).toContain(`    ${ask}`);
    // No ask is named for a statement, and none takes one. The words are
    // looked for inside longer ones too: `statements`, `sqlText`, `run_query`.
    expect(text).not.toMatch(/sql|statement|quer/i);
  });

  test("switched on, its asks are on the list of what may cross", async () => {
    const paths = await bareRoot(["session_vault", "stores"]);
    const view = await moduleDataPaths(paths, { cloudUrl: null, env: {} });
    expect(view.on.find((module) => module.id === "stores")).toMatchObject({
      id: "stores",
      egress: [],
      asks: ASKS.map((name) => ({ name })),
    });
  });
});

describe("in the daemon", () => {
  test("the module is provided, and registered only once it is switched on", async () => {
    const off = await bareRoot(["session_vault"]);
    expect((await composeDaemon(off)).registry.has("stores")).toBe(false);
    await cleanup?.();
    const on = await bareRoot(["session_vault", "stores"]);
    const { deps, registry } = await composeDaemon(on);
    expect(registry.has("stores")).toBe(true);
    // Its asks go through the real gate: one with no grant is refused there.
    expect(
      await deps.asks?.handle({
        module: "stores",
        id: "m1",
        kind: "request",
        payload: { v: 1, ask: "list", args: {} },
      }),
    ).toEqual({ ok: false, error: "grant_missing" });
  });

  test("the daemon hands the module nothing: its processes are the module host's to start", async () => {
    // The module is made with no parameter, so there is no launcher to hand
    // it: a Store's process can only come from the context the module host
    // gives the module.
    const main = await Bun.file(new URL("../../../src/host/main.ts", import.meta.url)).text();
    expect(main).toContain("moduleHost.provide(createStoresModule());");
    expect(main.match(/createStoresModule\(/g)).toHaveLength(1);
  });
});
