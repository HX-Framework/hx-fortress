// `hx-fortress store-engine`: a Store's own process.
//
// HX Fortress starts this for the Stores module, once for each open Store,
// over a channel only the two share (host/store-process.ts says why a Store
// has a process of its own). Nothing else starts it. Run by hand, it has
// nobody to talk to: it says so and ends.

import { engineProgram } from "./engine-program";
import { hasParent, NO_PARENT_EXIT, runStoreProcess } from "./host/store-process-main";

export async function runStoreEngine(options: { writeLine: (line: string) => void }): Promise<number> {
  if (!hasParent()) {
    options.writeLine(
      "hx-fortress store-engine is the process of one Store. HX Fortress starts it itself, " +
        "and it does nothing when it is run by hand.",
    );
    return NO_PARENT_EXIT;
  }
  return runStoreProcess(engineProgram);
}
