import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { assertSafeTar, assertSafeZip, resolveBin } from "./safe-extract";
import type { Spawner } from "./spawn";

export function makeExtractor(
  spawner: Spawner,
): (jarPath: string, destDir: string) => Promise<void> {
  return async (jarPath, destDir) => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "hx-pg-extract-"));
    try {
      // Audit the OUTER jar (zip) for symlink / path-escape members before unzip,
      // the same guard the inner .txz gets below (don't rely on unzip's own zip-slip).
      await assertSafeZip(spawner, jarPath);
      await run(spawner, [resolveBin("unzip"), "-o", jarPath, "-d", tmp]);
      const inner = (await readdir(tmp)).find((f) => f.endsWith(".txz"))
        ?? path.basename(jarPath).replace(/\.jar$/, ".txz");
      const innerPath = path.join(tmp, inner);
      // Audit the inner .txz for symlink/hardlink/path-escape members before
      // untarring it into the (relocatable) bundle root.
      await assertSafeTar(spawner, innerPath, "J");
      await run(spawner, [resolveBin("tar"), "-xJf", innerPath, "-C", destDir]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  };
}

// Extract a gzipped tarball (the pgvector artifact) into destDir. Unlike the
// zonky jar, this is a plain `.tar.gz`, so a single `tar -xzf` suffices — but
// still audited for unsafe members first.
export function makeTarGzExtractor(
  spawner: Spawner,
): (tarPath: string, destDir: string) => Promise<void> {
  return async (tarPath, destDir) => {
    await assertSafeTar(spawner, tarPath, "z");
    await run(spawner, [resolveBin("tar"), "-xzf", tarPath, "-C", destDir]);
  };
}

async function run(spawner: Spawner, cmd: string[]): Promise<void> {
  const { code, stderr } = await spawner.run(cmd);
  if (code !== 0) throw new Error(`${cmd[0]} failed: ${stderr.trim()}`);
}
