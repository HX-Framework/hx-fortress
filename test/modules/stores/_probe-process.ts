// A Store's process for tests: the host's own main loop, with the probe
// program in the engine's place.

import { runStoreProcess } from "../../../src/modules/stores/host/store-process-main";
import { probeProgram } from "./_probe-program";

await runStoreProcess(probeProgram);
