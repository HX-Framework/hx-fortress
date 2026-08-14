import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { fortressPaths } from "./paths";
import type { HostStatusSnapshot, StatusStore } from "./types";

type FortressPaths = ReturnType<typeof fortressPaths>;

export class FileStatusStore implements StatusStore {
  constructor(private readonly paths: FortressPaths) {}

  async write(snapshot: HostStatusSnapshot): Promise<void> {
    // The runtime dir is owner-only (0700) and status.json owner-only (0600):
    // the snapshot can carry a (secret-free) vault view, and locking it down
    // keeps other local users from reading fortress runtime state.
    await mkdir(path.dirname(this.paths.status), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.paths.status}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600).catch(() => {});
    await rename(temporaryPath, this.paths.status);
  }
}
