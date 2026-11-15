// One program with two ways to run, as HX Fortress is one program: started
// with the Store's word it is a Store's process, and started with a folder it
// is the side that holds one. `compiled-program.test.ts` compiles this file
// into one binary and runs it.

import path from "node:path";

import { STORE_PROCESS_VERB } from "../../../src/modules/stores/host/process-protocol";
import { prepareStoreFolder, storeFolder } from "../../../src/modules/stores/host/store-folder";
import { StoreProcess, StoreStopped } from "../../../src/modules/stores/host/store-process";
import { runStoreProcess } from "../../../src/modules/stores/host/store-process-main";
import { probeProgram } from "./_probe-program";
import { commandLauncher } from "./_rig";

if (process.argv.includes(STORE_PROCESS_VERB)) {
  await runStoreProcess(probeProgram);
}

const folder = storeFolder(path.resolve(process.argv.at(-1) as string));
prepareStoreFolder(folder);
const store = new StoreProcess({
  folder: folder.root,
  // This same program, started again with the word.
  launcher: commandLauncher([process.execPath, STORE_PROCESS_VERB], folder.scratch),
  // A call's limit counts from its hand-over, so a call that has to start the
  // Store's process first needs the time of a start. Only the statement that
  // never ends has a short limit.
  limitMs: 10_000,
  idleMs: 0,
});

await store.call("exec", ["CREATE TABLE permits (permit_no TEXT)"]);
await store.call("exec", ["INSERT INTO permits VALUES (?)", "BP-2026-0412"]);
const first = (await store.call("pid")) as number;

// This program's own loop keeps turning while the statement runs.
let ticks = 0;
const ticker = setInterval(() => (ticks += 1), 10);
let stopped = "the statement was not stopped";
try {
  await store.call(
    "exec",
    ["WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c"],
    { limitMs: 500 },
  );
} catch (thrown) {
  stopped = thrown instanceof StoreStopped ? thrown.why : "another failure";
}
clearInterval(ticker);

const kept = (await store.call("exec", ["SELECT permit_no FROM permits"])) as { rows: unknown[][] };
const second = (await store.call("pid")) as number;
await store.close();

console.log(
  JSON.stringify({
    stopped,
    kept: kept.rows,
    ticked: ticks > 15,
    newProcess: first !== second && first !== process.pid && second !== process.pid,
  }),
);
process.exit(0);
