// The Store's engine, as it rests in this repository.
//
// A script writes `src/modules/stores/engine/` from the repository the engine
// is developed in, and nobody changes a file of it here: its `ENGINE.md` says
// so. `engine-files.json` in the folder lists every other file of it with its
// size and its SHA-256. This file holds the folder to that list, and holds
// this repository's packages to the versions the engine was written against.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { writtenFolderPaths } from "../../../_written-folder";

const ROOT = path.join(import.meta.dir, "..", "..", "..", "..");
const FOLDER_IN_ROOT = "src/modules/stores/engine";
const FOLDER = path.join(ROOT, FOLDER_IN_ROOT);
const LIST = "engine-files.json";

interface Listed {
  path: string;
  bytes: number;
  sha256: string;
}

interface EngineFiles {
  format: number;
  from: { commit: string; onMainBranch: boolean };
  /** The packages the engine's readers import, each with its version. */
  packages: Record<string, string>;
  /** Those of them that the engine's own repository keeps as a file, because
   *  the package registry has no such version. */
  packagesKeptAsFiles: string[];
  files: Listed[];
}

// Every path below is this repository's own folder, or a name read from it.
/* eslint-disable security/detect-non-literal-fs-filename */

async function list(): Promise<EngineFiles> {
  return JSON.parse(await readFile(path.join(FOLDER, LIST), "utf8")) as EngineFiles;
}

/** The folder as the repository holds it, without its own list. */
async function present(): Promise<string[]> {
  return (await writtenFolderPaths(ROOT, FOLDER_IN_ROOT)).filter((name) => name !== LIST).sort();
}

describe("the engine's folder", () => {
  test("holds exactly the files its list names", async () => {
    const { files, format } = await list();
    expect(format).toBe(1);
    expect(files.length).toBeGreaterThan(80);
    for (const file of files) {
      // A path of the list stays inside the folder.
      expect(file.path.startsWith("/") || file.path.split("/").includes("..")).toBe(false);
    }
    // Neither listing has a promised order, so both sides are sorted.
    expect(await present()).toEqual(files.map((file) => file.path).sort());
  });

  test("every file is as the script wrote it: its size and its SHA-256", async () => {
    const changed: string[] = [];
    for (const file of (await list()).files) {
      const at = path.join(FOLDER, file.path);
      // A link to a file elsewhere would be compiled into the program, and
      // its checksum would be that of whatever it points at.
      if (!(await lstat(at)).isFile()) {
        changed.push(`${file.path}: not a plain file`);
        continue;
      }
      const bytes = await readFile(at);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (bytes.byteLength !== file.bytes || sha256 !== file.sha256) changed.push(file.path);
    }
    // A file named here was changed by hand. The engine is changed in the
    // repository it is developed in, and the script writes the folder again.
    expect(changed).toEqual([]);
  });

  test("it was written from the main branch of the engine's repository", async () => {
    const { from } = await list();
    expect(from.onMainBranch).toBe(true);
    expect(from.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  test("this repository has the packages the engine's readers import, at the versions it was written against", async () => {
    const { packages, packagesKeptAsFiles } = await list();
    const own = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(packages).length).toBeGreaterThan(0);
    // Each one that is kept as a file is one of the packages.
    expect(packagesKeptAsFiles.filter((name) => !Object.hasOwn(packages, name))).toEqual([]);
    for (const [name, version] of Object.entries(packages)) {
      const asked = Object.hasOwn(own.dependencies, name) ? own.dependencies[name as keyof typeof own.dependencies] : undefined;
      // A package the registry has at this version is asked for by the
      // version alone. One that the engine's repository keeps as a file is
      // not on the registry at this version: it comes from its maker's own
      // address, as a file whose name holds the version, and the lockfile
      // holds the file's checksum. No other package may come from an address.
      const fits = packagesKeptAsFiles.includes(name)
        ? asked?.startsWith("https://") === true && asked.endsWith(`/${name}-${version}.tgz`)
        : asked === version;
      expect(`${name}: ${fits ? "as the engine asks" : `asked for as ${String(asked)}, the engine was written against ${version}`}`).toBe(
        `${name}: as the engine asks`,
      );
    }
  });
});
