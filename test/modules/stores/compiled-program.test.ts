import { afterEach, expect, test } from "bun:test";
import path from "node:path";

import { cleanFolders, tempFolder } from "./_rig";

afterEach(cleanFolders);

// HX Fortress ships as one compiled program. A Store's process is that same
// program, started again with one word. This compiles a small program the
// same way and runs it, so the claim is checked on the machine the tests run
// on, and not only where it was first tried.
test(
  "in one compiled program: started again with a word it is a Store's process, and a statement that never ends is stopped",
  () => {
    const dir = tempFolder("compiled");
    const program = path.join(dir, "one-program");
    const build = Bun.spawnSync(
      [
        process.execPath,
        "build",
        path.join(import.meta.dir, "_compiled-entry.ts"),
        "--compile",
        "--outfile",
        program,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(build.stderr.toString()).not.toContain("error");
    expect(build.exitCode).toBe(0);

    const run = Bun.spawnSync([program, path.join(dir, "store")], {
      stdout: "pipe",
      stderr: "pipe",
      env: {},
      timeout: 30_000,
    });
    expect(run.stderr.toString()).toBe("");
    expect(JSON.parse(run.stdout.toString())).toEqual({
      stopped: "limit",
      kept: [["BP-2026-0412"]],
      ticked: true,
      newProcess: true,
    });
  },
  90_000,
);
