// `hx-fortress dev` — the development corpus, and nothing else.
//
// Deliberately absent from the help registry: it is not a product surface, and a
// verb group that only works when FORTRESS_DEV is set has no business appearing
// in the terminal help of a shipped binary.
//
// The seed MATERIALIZES rather than uploads. It owns the corpus; it does not own
// bucket credentials, and minting a store here would give a development
// convenience the same reach as the ingest path. The test rig already holds
// emulator credentials and the operator already holds the real ones, so both
// load from the directory this writes.

import path from "node:path";

import { FileCredentialStore } from "./cloud/credentials";
import { buildSeedCorpus, corpusDigest, seedInventory } from "./dev/corpus";
import { devGateVerdict } from "./dev/gate";
import { materializeSeed } from "./dev/seed";
import { fortressPaths } from "./host/paths";

export interface DevCommandDeps {
  writeLine: (line: string) => void;
  env?: Record<string, string | undefined>;
  fortressRoot?: string;
  /** Injected in tests. Fail CLOSED: a credentials file that exists but cannot
   *  be read is treated as an enrolled fortress. */
  isEnrolled?: () => Promise<boolean>;
}

function parseOut(args: readonly string[]): string | null {
  const idx = args.indexOf("--out");
  if (idx < 0) return null;
  const value = args[idx + 1];
  if (!value || value.startsWith("--")) throw new Error("usage: hx-fortress dev seed --out <dir>");
  return value;
}

export async function runDevCommand(
  args: readonly string[],
  deps: DevCommandDeps,
): Promise<number> {
  const env = deps.env ?? process.env;
  const paths = fortressPaths(deps.fortressRoot);
  const isEnrolled =
    deps.isEnrolled ??
    (async (): Promise<boolean> => {
      try {
        return (await new FileCredentialStore(paths.credentials).load()) !== null;
      } catch {
        return true;
      }
    });

  const verdict = devGateVerdict({ env, enrolled: await isEnrolled() });
  if (!verdict.ok) {
    deps.writeLine(`error: ${verdict.reason}`);
    return 1;
  }

  const subcommand = args[0];
  const corpus = buildSeedCorpus();
  const inventory = seedInventory(corpus);

  if (subcommand === "inventory") {
    printInventory(deps.writeLine, corpus, inventory);
    return 0;
  }

  if (subcommand === "seed") {
    const dir = parseOut(args.slice(1)) ?? path.join(paths.root, "dev", "seed");
    const written = await materializeSeed(dir, corpus);
    printInventory(deps.writeLine, corpus, inventory);
    deps.writeLine("");
    deps.writeLine(`seed written to ${written.dir}`);
    deps.writeLine(`  objects      ${written.objects} across ${Object.keys(inventory.objects).length} buckets`);
    deps.writeLine(`  roster       ${written.rosterFile}`);
    deps.writeLine(`  rows         ${written.rowsFile}`);
    deps.writeLine(`  inventory    ${written.inventoryFile}`);
    return 0;
  }

  deps.writeLine("usage: hx-fortress dev seed [--out <dir>] | hx-fortress dev inventory");
  return 1;
}

function printInventory(
  writeLine: (line: string) => void,
  corpus: ReturnType<typeof buildSeedCorpus>,
  inventory: ReturnType<typeof seedInventory>,
): void {
  writeLine(`hx-fortress dev seed — corpus ${corpusDigest(corpus).slice(0, 12)} at ${corpus.epoch}`);
  writeLine(`  people       ${inventory.users} (${inventory.devices} devices)`);
  writeLine(`  sessions     ${inventory.sessions}`);
  for (const [channel, count] of Object.entries(inventory.sessionsByChannel)) {
    writeLine(`    ${channel.padEnd(10)} ${count}`);
  }
  writeLine(`  objects      primary ${inventory.objects.primary}, secondary ${inventory.objects.secondary}`);
  writeLine(`  tombstones   ${inventory.tombstones}`);
  writeLine(`  faults       ${inventory.faults}`);
  writeLine(`  roster       ${inventory.rosterMembers} members`);
  writeLine("  fixtures");
  for (const fixture of corpus.fixtures) {
    writeLine(`    ${fixture.id.padEnd(34)} ${fixture.what}`);
    for (const acceptance of fixture.acceptances) writeLine(`      ${acceptance}`);
  }
}
