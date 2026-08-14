// `bun run rig:emulators:up|down` — the storage emulators, started the same way
// locally and in CI so a green pipeline and a green laptop mean the same thing.
//
// It prints the reason when it cannot start rather than exiting quietly: an
// emulator suite that skips without saying why is how emulator coverage reaches
// zero without anyone noticing.

import { emulatorsDown, emulatorStatus, emulatorsUp, FAKE_GCS_IMAGE, MINIO_IMAGE } from "../test/rig/emulators";

const verb = process.argv[2] ?? "up";

if (verb === "down") {
  await emulatorsDown();
  console.log("storage emulators stopped");
} else if (verb === "up") {
  const status = emulatorStatus();
  if (!status.available) {
    console.error(`cannot start the storage emulators: ${status.reason}`);
    process.exit(1);
  }
  const rig = await emulatorsUp();
  console.log(`MinIO      ${rig.minioEndpoint}  (${MINIO_IMAGE.image}:${MINIO_IMAGE.tag})`);
  console.log(`fake-gcs   ${rig.gcsEndpoint}  (${FAKE_GCS_IMAGE.image}:${FAKE_GCS_IMAGE.tag})`);
} else {
  console.error("usage: bun scripts/rig-emulators.ts up|down");
  process.exit(1);
}
