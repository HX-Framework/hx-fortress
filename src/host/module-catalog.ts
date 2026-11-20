// The modules this build ships.
//
// A module is compiled into the HX Fortress binary, so the complete list of
// them is a constant of the binary, and it is this one. The daemon registers
// from it, the ask gate uses it to decide which module ids may be written to
// the audit trail by name, and the terminal and the console read it to show an
// operator what each module may be asked — without starting a daemon to find
// out.
//
// To add a module: write its manifest as pure data under `src/modules/<id>/`,
// add one entry here, and register its instance in `src/host/main.ts`.

import { DATABASES_MANIFEST } from "../modules/databases/manifest";
import { HOST_MANIFEST } from "../modules/host/manifest";
import { STORES_MANIFEST } from "../modules/stores/manifest";
import type { ModuleManifest } from "./module-contract";

export interface CatalogEntry {
  id: string;
  /** What an operator sees. */
  title: string;
  summary: string;
  /** Null for a module that predates manifests. It takes no asks and no
   *  releases, and it is held to no list of hosts or secrets. */
  manifest: ModuleManifest | null;
  /** True when the daemon reads this module's switch only when it starts. The
   *  daemon wires such a module into the rest of itself at boot, so a changed
   *  switch takes a restart, and the module host neither starts nor stops it. */
  startOnly: boolean;
  /** True when a new install starts with this module switched on. Left out:
   *  off. An install that exists keeps its own list. */
  defaultOn?: boolean;
}

export const MODULE_CATALOG: readonly CatalogEntry[] = [
  {
    id: "session_vault",
    title: "Agentic Sessions",
    summary: "keeps AI session transcripts and their search index",
    manifest: null,
    startOnly: true,
  },
  {
    id: "host",
    title: "Host",
    summary: "answers the control plane about this HX Fortress: its status and its audit trail",
    manifest: HOST_MANIFEST,
    startOnly: false,
    defaultOn: true,
  },
  {
    id: "databases",
    title: "Databases",
    summary: "reads and writes local databases",
    manifest: DATABASES_MANIFEST,
    startOnly: false,
    defaultOn: true,
  },
  {
    id: "stores",
    title: "Stores",
    summary: "keeps working copies of tables on this machine, each in a file of its own",
    manifest: STORES_MANIFEST,
    startOnly: false,
    // Off on a new install: a person of this HX Fortress switches it on.
  },
];

export function catalogEntry(
  moduleId: string,
  catalog: readonly CatalogEntry[] = MODULE_CATALOG,
): CatalogEntry | undefined {
  return catalog.find((entry) => entry.id === moduleId);
}
