// A folder of this repository that a script writes at another repository, and
// that nobody edits here: how a test lists what the folder holds, to hold it
// to the list the script wrote with it.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

// Every path below is this repository's own folder, or a name read from it.
/* eslint-disable security/detect-non-literal-fs-filename */

/**
 * The paths of a folder as the repository holds it, each from the folder
 * down, with `/` between its parts: every path git tracks there, and every
 * path it would take with the next `git add`. What git ignores is not the
 * repository's: a local build, or a file a desktop leaves. A link is a path
 * too, so one cannot stand in the folder unseen.
 *
 * A copy of the sources with no git in it (an archive) has nothing to ask, so
 * there every path on the disk counts.
 *
 * `root` is the repository's own folder, and `folder` the written folder's
 * path from it (`data-runner`, `src/modules/stores/engine`).
 */
export async function writtenFolderPaths(root: string, folder: string): Promise<string[]> {
  return existsSync(path.join(root, ".git")) ? trackedOrNew(root, folder) : await onDisk(path.join(root, folder));
}

function trackedOrNew(root: string, folder: string): string[] {
  const result = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", folder],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    const reason = (result.stderr || result.error?.message || "it gave no reason").trim();
    throw new Error(`This test lists the folder's files with git, and git failed: ${reason}`);
  }
  return [...new Set(result.stdout.split("\0").filter((name) => name.length > 0))].map((name) =>
    name.slice(folder.length + 1),
  );
}

/** Every path under the folder that is not a directory. A link is not followed. */
async function onDisk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
}
