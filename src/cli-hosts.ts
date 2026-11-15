// `hx-fortress hosts`: the addresses HX Fortress calls, printed on the host.
//
// One row for each entry of the one list of hosts (`src/host/hosts-list.ts`):
// the answers of the setup that name an outside service, the hosts the modules
// name in their manifests, and the reaches people added to modules. `--json`
// prints every field of every entry, for a firewall rule or a template to
// read.
//
// It reads files only. It needs no daemon, and it changes nothing.

import { DEFAULT_PORT, HostsList, type HostEntry } from "./host/hosts-list";
import { MODULE_CATALOG, catalogEntry, type CatalogEntry } from "./host/module-catalog";
import { fortressPaths } from "./host/paths";
import type { SetupAnswers } from "./setup/answers";
import { REACH_IS_HELD } from "./setup/reach";

export interface HostsVerbDeps {
  writeLine: (line: string) => void;
  fortressRoot?: string;
  /** The modules of the build. A seam for tests; the terminal uses the catalog
   *  compiled into this binary. */
  catalog?: readonly CatalogEntry[];
  /** The present answers of the setup. A seam for tests; the terminal reads
   *  them from the folder and its own environment. */
  answers?: () => Promise<SetupAnswers>;
}

export const HOSTS_USAGE = "usage: hx-fortress hosts [--json]";

/** An option as a person types one: one or two dashes and a short word. Only
 *  text of this shape is repeated when it is refused. */
const OPTION_SHAPE = /^--?[a-z][a-z0-9-]{0,31}$/;

export async function runHostsVerb(args: readonly string[], deps: HostsVerbDeps): Promise<number> {
  const json = args.length === 1 && args[0] === "--json";
  if (args.length > 0 && !json) throw new Error(refusal(args));
  const catalog = deps.catalog ?? MODULE_CATALOG;
  const list = new HostsList(fortressPaths(deps.fortressRoot), {
    catalog,
    ...(deps.answers ? { answers: deps.answers } : {}),
  });
  const hosts = await list.all();
  if (json) {
    deps.writeLine(JSON.stringify({ hosts }, null, 2));
    return 0;
  }
  printHosts(hosts, catalog, deps.writeLine);
  return 0;
}

function refusal(args: readonly string[]): string {
  const odd = args.find((arg) => arg !== "--json");
  if (odd === undefined) return `--json is given more than once. ${HOSTS_USAGE}`;
  // Text of any other shape is not repeated: it may be something that was
  // never meant for this command, such as an address with a key in it.
  return OPTION_SHAPE.test(odd)
    ? `unknown option ${odd}. ${HOSTS_USAGE}`
    : `that is not an option of hx-fortress hosts. ${HOSTS_USAGE}`;
}

/** The address as a person reads it: the host, and the port when it is not
 *  443. An IPv6 address with a port is written in brackets. A setting whose
 *  host is not known is its words. */
export function shownAddress(entry: HostEntry): string {
  if (entry.host === null) return entry.kind === "setting" ? (entry.described ?? "") : "";
  if (entry.port === null || entry.port === DEFAULT_PORT) return entry.host;
  return entry.host.includes(":") ? `[${entry.host}]:${entry.port}` : `${entry.host}:${entry.port}`;
}

function printHosts(
  hosts: readonly HostEntry[],
  catalog: readonly CatalogEntry[],
  writeLine: (line: string) => void,
): void {
  writeLine("The addresses HX Fortress calls");
  writeLine("");
  if (hosts.length === 0) {
    writeLine("None. With the present settings and modules, HX Fortress calls no address.");
  } else {
    const header = ["Address", "What for", "Module", "Added"];
    const rows = hosts.map((entry) => [
      shownAddress(entry),
      entry.why,
      entry.kind === "setting" ? "" : (catalogEntry(entry.module, catalog)?.title ?? entry.module),
      entry.kind === "reach" ? `${entry.addedBy}, ${entry.addedAt}` : "",
    ]);
    // A column that no row fills is left out.
    const columns = header
      .map((_, column) => column)
      .filter((column) => column < 2 || rows.some((row) => (row.at(column) ?? "") !== ""));
    const widths = columns.map((column) =>
      Math.max(...[header, ...rows].map((row) => (row.at(column) ?? "").length)),
    );
    const line = (row: readonly string[]): string =>
      columns
        .map((column, at) => (row.at(column) ?? "").padEnd(widths.at(at) ?? 0))
        .join("  ")
        .trimEnd();
    writeLine(line(header));
    for (const row of rows) writeLine(line(row));
  }
  writeLine("");
  if (!REACH_IS_HELD) {
    writeLine("This build does not yet refuse a call to an address that is not on this list.");
  }
  writeLine("`hx-fortress hosts --json` prints every field, for a firewall rule or a template.");
}
