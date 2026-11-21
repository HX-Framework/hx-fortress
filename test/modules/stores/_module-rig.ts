// The Stores module behind the real ask gate, for the tests that run it whole:
// signed grants, the module host's own contexts, and a real process for each
// Store. The program a Store's process runs is the test's to say: the stand-in
// for the engine, or the engine itself.

import path from "node:path";

import type { CatalogEntry } from "../../../src/host/module-catalog";
import type { ModuleStartContext } from "../../../src/host/module-contract";
import { FileStorage } from "../../../src/modules/stores/host/file-storage";
import { STORE_PROCESS_VERB } from "../../../src/modules/stores/host/process-protocol";
import { storeFolder } from "../../../src/modules/stores/host/store-folder";
import { STORES_MANIFEST } from "../../../src/modules/stores/manifest";
import { createStoresModule, type ModuleProcesses, type StoresModule } from "../../../src/modules/stores/module";
import { OpenStores, type OpenStoresOptions, type OpenStoresPort } from "../../../src/modules/stores/open-stores";
import { ask, makeRig, PROBE_CATALOG, spoolRecords, type Rig } from "../../host/_module-rig";
import { commandProcesses, type AskedStart } from "./_rig";

const CATALOG: readonly CatalogEntry[] = [
  ...PROBE_CATALOG,
  { id: "stores", title: "Stores", summary: "a test's entry", manifest: STORES_MANIFEST, startOnly: false },
];

/** The stand-in for the Store's engine: a small program that answers the
 *  module's calls from a Store's real file, with everything a careless copy
 *  would carry. */
const FAKE_ENGINE: readonly string[] = [process.execPath, path.join(import.meta.dir, "_fake-engine-process.ts")];

/** The Store's engine itself, started the way HX Fortress starts it from its
 *  sources: this program's own command line, with the Store's word. */
export const REAL_ENGINE: readonly string[] = [
  process.execPath,
  path.join(import.meta.dir, "..", "..", "..", "src", "cli.ts"),
  STORE_PROCESS_VERB,
];
export interface StoresRig {
  rig: Rig;
  module: StoresModule;
  /** The own organization's context, as the module was started with it. */
  ctx(): ModuleStartContext;
  ask(name: string, args?: Record<string, unknown>, org?: string): Promise<unknown>;
  /** A Store's folder of the own organization, by its folder name. */
  folderOf(name: string): string;
  /** The same for another organization. */
  folderIn(org: string, name: string): string;
  /** The file that holds the own organization's list of Stores. */
  listFile(): string;
  /** Every start of a process the module asked for, in order. */
  asked: AskedStart[];
  /** A module like the rig's own, over the same folders: what a restart of
   *  HX Fortress starts. With `stores: "none"` it has no way to start a
   *  process. It is stopped when the test ends. */
  another(how?: { stores?: "none" }): StoresModule;
}

const rigs: StoresRig[] = [];
/** Modules a test made beside the rig's own. */
const others: StoresModule[] = [];
/** End what the rigs of a test started. For a test file's `afterEach`. */
export async function endStoresRigs(): Promise<void> {
  // Every Store's process is ended before its folder is removed.
  for (const module of others.splice(0)) await module.stop?.();
  for (const made of rigs.splice(0)) {
    await made.module.stop?.();
    await made.rig.cleanup();
  }
}

/** A stand-in for the module host's way to start a process that a test can
 *  hold: a start that was asked for waits until the test lets it go. */
export function held(real: ModuleProcesses): {
  processes: ModuleProcesses;
  hold(): void;
  release(): void;
  /** How many starts the module asked for, held or not. */
  requested(): number;
} {
  let open: Promise<void> = Promise.resolve();
  let release: () => void = () => undefined;
  let requested = 0;
  return {
    processes: {
      async start(ctx, verb, options) {
        requested += 1;
        await open;
        return real.start(ctx, verb, options);
      },
    },
    hold(): void {
      open = new Promise<void>((resolve) => (release = resolve));
    },
    release: () => release(),
    requested: () => requested,
  };
}

/** The Stores module behind the real ask gate, with signed grants. */
export async function storesRig(
  options: {
    enabled?: readonly string[];
    /** `process`: a real process for each Store. `none`: no way to start one,
     *  as in the daemon until the module host gives one. */
    stores?: "process" | "none";
    /** The program a Store's process runs, as a command. Left out, the
     *  stand-in for the engine. */
    program?: readonly string[];
    /** Put something between the module and the stand-in's starts. */
    wrap?: (real: ModuleProcesses) => ModuleProcesses;
    /** How many Stores the module keeps open, as whoever wires the module
     *  into the daemon says it. */
    maxOpen?: number;
    open?: OpenStoresOptions;
    /** Put something between the module and its open Stores. */
    wrapOpen?: (real: OpenStoresPort) => OpenStoresPort;
  } = {},
): Promise<StoresRig> {
  const enabled = options.enabled ?? ["session_vault", "probe", "stores"];
  const rig = await makeRig({ enabled, deps: { catalog: CATALOG }, start: false });
  const clock = (): Date => new Date(rig.now.value.getTime());
  const asked: AskedStart[] = [];
  const real = commandProcesses(options.program ?? FAKE_ENGINE, {
    showErrors: true,
    asked: (start) => void asked.push(start),
  });
  const make = (stores: "process" | "none" = options.stores ?? "process"): StoresModule =>
    createStoresModule({
      clock,
      ...(options.maxOpen !== undefined ? { maxOpen: options.maxOpen } : {}),
      ...(stores === "none" ? {} : { processes: options.wrap ? options.wrap(real) : real }),
      // A process that no call comes for stays, so that a test decides when
      // one ends.
      open: (given) => {
        const real = new OpenStores({ ...given, idleMs: 0, ...options.open });
        return options.wrapOpen ? options.wrapOpen(real) : real;
      },
    });
  const module = make();
  let started: ModuleStartContext | null = null;
  rig.host.provide({
    ...module,
    async init(context) {
      started = context;
      await module.init?.(context);
    },
  });
  await rig.host.start();
  await rig.registry.startAll(enabled);
  await rig.host.started();
  const made: StoresRig = {
    rig,
    module,
    ctx: () => {
      if (!started) throw new Error("the module was not started");
      return started;
    },
    ask: async (name, args = {}, org) =>
      ask(rig, "stores", name, args, await rig.key.grant("stores", name, args, org ? { org } : {})),
    folderOf: (name) => path.join(rig.paths.moduleData("stores"), "stores", name),
    folderIn: (org, name) => path.join(rig.paths.organizationModuleData(org, "stores"), "stores", name),
    listFile: () => path.join(rig.paths.moduleState("stores"), "stores.json"),
    asked,
    another: (how = {}) => {
      const module_ = make(how.stores);
      others.push(module_);
      return module_;
    },
  };
  rigs.push(made);
  return made;
}

/** Whether a Store's process holds the file in `root` now: a second one cannot
 *  open it then. */
export function isHeld(root: string): boolean {
  try {
    new FileStorage({ folder: storeFolder(root) }).close();
    return false;
  } catch {
    return true;
  }
}

export async function until(holds: () => boolean, withinMs = 10_000): Promise<boolean> {
  const end = Date.now() + withinMs;
  while (Date.now() < end) {
    if (holds()) return true;
    await Bun.sleep(25);
  }
  return holds();
}

export async function storesActions(made: StoresRig): Promise<[string, unknown][]> {
  return (await spoolRecords(made.rig.paths))
    .filter((record) => record.action.startsWith("module.stores."))
    .map((record) => [record.action.slice("module.stores.".length), record.params]);
}
