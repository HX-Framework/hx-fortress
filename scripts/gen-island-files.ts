// Writes the two things that follow from the folder islands/v1/, the page
// files of a Secure Data Island:
//
//   islands/v1/SHA256SUMS     each file's checksum, in the form `shasum -c` reads
//   src/island-files.gen.ts   one `with { type: "file" }` import for each file,
//                             so that `bun build --compile` embeds each one as
//                             it is
//
// Both are in the repository. Run this after any change to a file of the
// folder:
//
//   bun run gen:islands      writes both
//   bun run check:islands    writes nothing, and exits 1 when either is stale
//
// Every build runs the check before it compiles (`bun run build`, and the
// release and dev-build workflows), so a binary is never made from a folder
// whose two lists do not match it.
//
// The files themselves are never touched: no bundler, no minifier and no
// compiler stands between the folder and the binary. A file that the folder
// may not hold stops this script.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ISLAND_FILE_NAME, ISLAND_ROUTE_WORDS, ISLAND_SUMS_NAME, sha256Hex } from "../src/ui/island-files";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
export const ISLAND_FOLDER = join(repoRoot, "islands", "v1");
export const ISLAND_SUMS_FILE = join(ISLAND_FOLDER, ISLAND_SUMS_NAME);
export const ISLAND_MODULE_FILE = join(repoRoot, "src", "island-files.gen.ts");

/** Why a name may not be a file of the folder, or null when it may. */
export function islandNameRefusal(name: string): string | null {
  if (!ISLAND_FILE_NAME.test(name)) {
    return `${name}: a file of islands/v1/ is plain HTML, CSS, JavaScript, SVG or JSON, with a lower-case name and one ending`;
  }
  if (name.endsWith(".html") && ISLAND_ROUTE_WORDS.includes(name.slice(0, -".html".length))) {
    return `${name}: that name is one of HX Fortress's own routes under /island/v1/`;
  }
  return null;
}

/**
 * The text of SHA256SUMS for these files: one line for each, sorted by name,
 * `<64 hex digits><two spaces><name>`. The list does not list itself.
 */
export function islandSumsText(files: ReadonlyMap<string, Uint8Array>): string {
  return [...files.keys()]
    .filter((name) => name !== ISLAND_SUMS_NAME)
    .sort()
    .map((name) => `${sha256Hex(files.get(name) as Uint8Array)}  ${name}\n`)
    .join("");
}

/**
 * The text of the module that embeds the folder's files: one import for each,
 * `with { type: "file" }`, and a map from a file's name to what the import
 * gives.
 */
export function islandModuleText(names: readonly string[]): string {
  const sorted = [...names].sort();
  const lines: string[] = [
    "// Written by scripts/gen-island-files.ts from the folder islands/v1/. Do not edit.",
    "// One import for each file of that folder: `bun build --compile` embeds each one as",
    "// it is, and in a source checkout the import gives the file's own path. A test",
    "// fails when this module no longer matches the folder (test/islands/files.test.ts),",
    "// and so does every build (`bun run check:islands`).",
    '// @ts-nocheck: tsc has no model for `with { type: "file" }`.',
    "",
  ];
  sorted.forEach((name, i) => {
    lines.push(`import f${i} from "../islands/v1/${name}" with { type: "file" };`);
  });
  lines.push("", "export const ISLAND_FILES: Record<string, string> = {");
  sorted.forEach((name, i) => {
    lines.push(`  ${JSON.stringify(name)}: f${i},`);
  });
  lines.push("};", "");
  return lines.join("\n");
}

/** What the folder gives: each file's bytes by its name, and the two texts. */
export function readIslandFolder(): { files: Map<string, Uint8Array>; sums: string; module: string } {
  const files = new Map<string, Uint8Array>();
  for (const entry of readdirSync(ISLAND_FOLDER, { withFileTypes: true })) {
    // A name that starts with a dot is the operating system's or an editor's
    // own (a folder's view settings, a swap file). It is no file of the
    // folder: it is not listed, not embedded and not served. A test holds the
    // repository to tracking no such name here.
    if (entry.name.startsWith(".") || entry.name === ISLAND_SUMS_NAME) continue;
    if (!entry.isFile()) throw new Error(`${entry.name}: islands/v1/ holds files only, and no folder`);
    const refusal = islandNameRefusal(entry.name);
    if (refusal) throw new Error(refusal);
    // A name this script just listed in its own folder.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    files.set(entry.name, readFileSync(join(ISLAND_FOLDER, entry.name)));
  }
  if (files.size === 0) throw new Error("islands/v1/ holds no file");
  return {
    files,
    sums: islandSumsText(files),
    module: islandModuleText([...files.keys(), ISLAND_SUMS_NAME]),
  };
}

function textOf(file: string): string | null {
  try {
    // One of the two files this script writes.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const folder = readIslandFolder();
  const stale = [
    ...(textOf(ISLAND_SUMS_FILE) === folder.sums ? [] : ["islands/v1/SHA256SUMS"]),
    ...(textOf(ISLAND_MODULE_FILE) === folder.module ? [] : ["src/island-files.gen.ts"]),
  ];
  if (process.argv.includes("--check")) {
    if (stale.length > 0) {
      console.error(`gen-island-files: stale: ${stale.join(", ")}. Run \`bun run gen:islands\`.`);
      process.exit(1);
    }
    console.log(`gen-island-files: ${folder.files.size} files, both lists match the folder`);
  } else {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(ISLAND_SUMS_FILE, folder.sums);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(ISLAND_MODULE_FILE, folder.module);
    console.log(
      `gen-island-files: ${folder.files.size} files of islands/v1/` +
        (stale.length > 0 ? `, wrote ${stale.join(" and ")}` : ", nothing changed"),
    );
  }
}
