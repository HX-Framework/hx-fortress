// The Stores module behind the real ask gate and the real module host, for the
// tests that run it whole: signed grants, the module host's own contexts, and
// a real process for each Store, which the module host itself starts. What the
// module host starts as "this program" is the test's to say: the stand-in for
// the engine, or this program's own command line.

import path from "node:path";

import { AUDIT_ACTIONS } from "../../../src/console/audit-actions";
import { catalogEntry, type CatalogEntry } from "../../../src/host/module-catalog";
import type { ModuleStartContext } from "../../../src/host/module-contract";
import { PROCESS_TMPDIR_VARIABLE, spawnWithRuntime, type SpawnChild } from "../../../src/host/module-processes";
import { FileStorage } from "../../../src/modules/stores/host/file-storage";
import { storeFolder } from "../../../src/modules/stores/host/store-folder";
import { createStoresModule, type StoresModule } from "../../../src/modules/stores/module";
import {
  OpenStores,
  type OpenStoresOptions,
  type OpenStoresPort,
  type StoreOpener,
} from "../../../src/modules/stores/open-stores";
import { recordsOf } from "../../host/_acts-rig";
import { ask, makeRig, PROBE_CATALOG, spoolRecords, type Rig } from "../../host/_module-rig";

/** The probe's catalog, and the Stores module's own entry of the catalog this
 *  build ships. */
function catalog(): readonly CatalogEntry[] {
  const stores = catalogEntry("stores");
  if (!stores) throw new Error("the catalog this build ships does not list the Stores module");
  return [...PROBE_CATALOG, stores];
}

/** The stand-in for the Store's engine: a small program that answers the
 *  module's calls from a Store's real file, with everything a careless copy
 *  would carry. The module host puts the Store's word after it, and the
 *  stand-in reads no word. */
export const FAKE_ENGINE: readonly string[] = [
  process.execPath,
  path.join(import.meta.dir, "_fake-engine-process.ts"),
];

/** This program's own command line, run from its sources: what the module
 *  host starts again in a daemon that runs from its sources. With the Store's
 *  word after it, it is the Store's engine itself. */
export const REAL_ENGINE: readonly string[] = [
  process.execPath,
  path.join(import.meta.dir, "..", "..", "..", "src", "cli.ts"),
];

/** One process the module host started for the module. */
export interface AskedStart {
  /** The word the program was started with: the command's last. */
  verb: string;
  /** The folder the process was given, as the value of its one variable. */
  folder: string;
}

/** The same start, with everything the process was started with. */
export interface StartedWith {
  command: readonly string[];
  /** The folder the process was started in. */
  cwd: string;
  /** Its whole environment. */
  env: Readonly<Record<string, string>>;
}

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
  /** Every process the module host started for the module, in order: the
   *  word and the folder of each of `started`. */
  readonly asked: AskedStart[];
  /** The same starts, each with its command, its folder and its environment. */
  started: StartedWith[];
  /**
   * What the module host starts as this program from now on: a command, which
   * the host puts the Store's word after. Null: what runs here is not this
   * program's own command line, and the host starts nothing then.
   */
  startAs(command: readonly string[] | null): void;
  /** A module like the rig's own, over the same folders and the same module
   *  host: what a restart of HX Fortress starts. It is stopped when the test
   *  ends. */
  another(): StoresModule;
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

/**
 * A way for a test to hold the start of a Store's process. Put between the
 * module and its open Stores (`wrapOpen`), it makes every start the module
 * asks for wait until the test lets it go. The module host is asked only
 * then, so it looks at the folder only then.
 */
export function heldStarts(): {
  wrapOpen(real: OpenStoresPort): OpenStoresPort;
  hold(): void;
  release(): void;
  /** How many starts the module asked for, held or not. */
  requested(): number;
} {
  let open: Promise<void> = Promise.resolve();
  let release: () => void = () => undefined;
  let requested = 0;
  const through =
    (opener: StoreOpener): StoreOpener =>
    (hand) =>
      opener((place) =>
        hand({
          ...place,
          launcher: {
            async start(options) {
              requested += 1;
              await open;
              return place.launcher.start(options);
            },
          },
        }),
      );
  return {
    wrapOpen: (real) => ({
      call: (key, opener, name, args) => real.call(key, through(opener), name, args),
      watch: (key, root, opener) => real.watch(key, root, through(opener)),
      remove: (key) => real.remove(key),
      stop: () => real.stop(),
    }),
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
    /** `process`: the module host starts a real process for each Store.
     *  `none`: what runs here is not this program's own command line, and the
     *  module host starts nothing. */
    stores?: "process" | "none";
    /** What the module host starts as this program, as a command. Left out,
     *  the stand-in for the engine. */
    program?: readonly string[];
    /** How many Stores the module keeps open, as whoever wires the module
     *  into the daemon says it. */
    maxOpen?: number;
    open?: OpenStoresOptions;
    /** Put something between the module and its open Stores. */
    wrapOpen?: (real: OpenStoresPort) => OpenStoresPort;
    /** Waited for at the end of every start of the rig's own module: until it
     *  settles, the module host does not count the module as running. */
    afterInit?: () => Promise<void>;
  } = {},
): Promise<StoresRig> {
  const enabled = options.enabled ?? ["session_vault", "probe", "stores"];
  const started: StartedWith[] = [];
  let self: readonly string[] | null = options.stores === "none" ? null : (options.program ?? FAKE_ENGINE);
  // Each start is noted, and then made by the module host's own way of
  // starting a child: these tests start a Store's process as HX Fortress does.
  const spawn: SpawnChild = (command, given) => {
    started.push({ command: [...command], cwd: given.cwd, env: { ...given.env } });
    return spawnWithRuntime(command, given);
  };
  const rig = await makeRig({
    enabled,
    deps: { catalog: catalog(), self: () => self, spawnProcess: spawn },
    start: false,
  });
  const clock = (): Date => new Date(rig.now.value.getTime());
  const make = (): StoresModule =>
    createStoresModule({
      clock,
      ...(options.maxOpen !== undefined ? { maxOpen: options.maxOpen } : {}),
      // A process that no call comes for stays, so that a test decides when
      // one ends.
      open: (given) => {
        const real = new OpenStores({ ...given, idleMs: 0, ...options.open });
        return options.wrapOpen ? options.wrapOpen(real) : real;
      },
    });
  const module = make();
  let context: ModuleStartContext | null = null;
  rig.host.provide({
    ...module,
    async init(given) {
      context = given;
      await module.init?.(given);
      await options.afterInit?.();
    },
  });
  await rig.host.start();
  await rig.registry.startAll(enabled);
  await rig.host.started();
  const made: StoresRig = {
    rig,
    module,
    ctx: () => {
      if (!context) throw new Error("the module was not started");
      return context;
    },
    ask: async (name, args = {}, org) =>
      ask(rig, "stores", name, args, await rig.key.grant("stores", name, args, org ? { org } : {})),
    folderOf: (name) => path.join(rig.paths.moduleData("stores"), "stores", name),
    folderIn: (org, name) => path.join(rig.paths.organizationModuleData(org, "stores"), "stores", name),
    listFile: () => path.join(rig.paths.moduleState("stores"), "stores.json"),
    get asked(): AskedStart[] {
      return started.map((start) => ({
        verb: start.command.at(-1) ?? "",
        folder: start.env[PROCESS_TMPDIR_VARIABLE] ?? "",
      }));
    },
    started,
    startAs: (command) => {
      self = command;
    },
    another: () => {
      const module_ = make();
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

/** Wait until `holds`, for at most `withinMs`. Answers whether it held. */
export async function until(holds: () => boolean | Promise<boolean>, withinMs = 10_000): Promise<boolean> {
  const end = Date.now() + withinMs;
  while (Date.now() < end) {
    if (await holds()) return true;
    await Bun.sleep(25);
  }
  return holds();
}

/** What the module host recorded of each thing it refused the module, in
 *  order: the module and the host's own rule. */
export async function hostRefusals(made: StoresRig): Promise<unknown[]> {
  return (await recordsOf(made.rig, AUDIT_ACTIONS.moduleRefused)).map((record) => record.params);
}

export async function storesActions(made: StoresRig): Promise<[string, unknown][]> {
  return (await spoolRecords(made.rig.paths))
    .filter((record) => record.action.startsWith("module.stores."))
    .map((record) => [record.action.slice("module.stores.".length), record.params]);
}
