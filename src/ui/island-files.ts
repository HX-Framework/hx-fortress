// The files of a Secure Data Island, as this HX Fortress serves them.
//
// A Secure Data Island is a small page that HX Fortress serves at its own
// address, for a control plane's page to show in a frame. Its page files are
// the folder `islands/v1/` of the repository: plain HTML, CSS, JavaScript and
// JSON. No build step touches them. So a file that an HX Fortress serves is,
// byte for byte, the file in the repository at that release's tag, and anyone
// can check it: the files load with no sign-in, because they hold no data.
//
// HOW THEY GET INTO THE BINARY. `scripts/gen-island-files.ts` writes
// `src/island-files.gen.ts`, which imports each file of the folder
// `with { type: "file" }`. That module is in the repository. `bun build
// --compile` embeds what it imports, and in a source checkout the same import
// gives the file's own path. A test fails when the module or the list of
// checksums no longer matches the folder, and so does every build.
//
// THEY ARE READ ONCE, when the console starts, and compared with the folder's
// own list of checksums. What is served afterwards is those bytes, from
// memory. So "each file is the one its list names" is said of the very bytes
// that are served, and a file that changed on the disk since is not served.
// When the comparison fails, the console serves no Secure Data Island at all.
//
// Lookups go through a map only. A request's path is never joined onto the
// filesystem.

import { createHash } from "node:crypto";

import { contentTypeFor } from "./assets";

/** Where the files answer. */
export const ISLAND_FILES_PREFIX = "/island/v1/";

/** The list of checksums, in the form `shasum -c` reads. It is a file of the
 *  folder too, and is served like the others. */
export const ISLAND_SUMS_NAME = "SHA256SUMS";

/** The closed list that both sides of a frame hold to. */
const ISLAND_CONTRACT_NAME = "contract.json";

/**
 * A name the folder may hold: lower case, one ending, and that ending one of a
 * plain text kind. Anything else stops the script that embeds the files: a
 * file that is compiled, or made by a tool, has no place in a folder whose
 * point is that it is served as it was written.
 *
 * One dot only. A page also answers without `.html`, and a name with one dot
 * can never be the short form of another page's name.
 */
export const ISLAND_FILE_NAME = /^[a-z0-9][a-z0-9-]{0,63}\.(?:html|css|js|json|svg)$/;

/** The words after `/island/v1/` that are this HX Fortress's own routes, in
 *  this part or a later one. No page may take one as its name, because a page
 *  also answers without `.html`. */
export const ISLAND_ROUTE_WORDS: readonly string[] = ["config", "session", "signout", "claim", "read", "act", "event"];

/**
 * The pages that a control plane's page may show in a frame: one for each kind
 * of Secure Data Island this build serves.
 *
 * A CONSTANT OF THE SERVER, and not only what contract.json lists. That file
 * is also copied by control planes. If it alone decided, an edit that pointed
 * a kind at another page would let that page be framed: the sign-in window's
 * page, say, with its password field. A page is framed only when it is here
 * AND the contract lists it for a kind, so a disagreement between the two can
 * only frame less. Every other page of the folder opens as a window of its
 * own and may be framed by nothing.
 */
export const ISLAND_FRAMED_PAGES: ReadonlySet<string> = new Set(["rows.html"]);

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The lines of a SHA256SUMS text: name to checksum. Null when a line is not
 *  one, or a name is there twice. */
export function parseIslandSums(text: string): Map<string, string> | null {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (!match) return null;
    const [, sum, name] = match as unknown as [string, string, string];
    if (sums.has(name)) return null;
    sums.set(name, sum);
  }
  return sums;
}

/**
 * Compare files with a list of checksums: every listed file is there with the
 * listed checksum, and no file is there that the list does not name. One line
 * for each file that does not match, is missing, or is not listed, and none
 * when they agree.
 *
 * `files` holds each file's bytes by its name. The list itself is not one of
 * the files it lists.
 */
export function compareIslandFiles(sumsText: string, files: ReadonlyMap<string, Uint8Array>): string[] {
  const sums = parseIslandSums(sumsText);
  if (sums === null || sums.size === 0) return [`${ISLAND_SUMS_NAME} is not a list of checksums`];
  const findings: string[] = [];
  for (const [name, sum] of sums) {
    const bytes = files.get(name);
    if (bytes === undefined) findings.push(`${name}: listed, and not there`);
    else if (sha256Hex(bytes) !== sum) findings.push(`${name}: not the listed file`);
  }
  for (const name of files.keys()) {
    if (name !== ISLAND_SUMS_NAME && !sums.has(name)) findings.push(`${name}: there, and not listed`);
  }
  return findings;
}

/** The pages that a contract lists for its kinds, as file names. Null when the
 *  contract lists no kinds at all. */
export function kindPagesOfContract(contract: unknown): string[] | null {
  const listed = (contract as { kinds?: unknown } | null)?.kinds;
  if (!Array.isArray(listed)) return null;
  const pages: string[] = [];
  for (const entry of listed as unknown[]) {
    const page = (entry as { page?: unknown } | null)?.page;
    if (typeof page === "string" && page.startsWith(ISLAND_FILES_PREFIX)) {
      pages.push(`${page.slice(ISLAND_FILES_PREFIX.length)}.html`);
    }
  }
  return pages;
}

/** One file, as it is served. */
export interface IslandFile {
  name: string;
  contentType: string;
  /** The file's bytes, in a buffer of their own. */
  bytes: Uint8Array<ArrayBuffer>;
  /** The file's checksum as a quoted entity tag. */
  etag: string;
}

export interface IslandFiles {
  /** Every file by its name, and every page also by its name without `.html`. */
  byAddress: ReadonlyMap<string, IslandFile>;
  /** The names of the files, the list of checksums among them. */
  names: readonly string[];
  /** The pages that a control plane's page may show in a frame. */
  framed: ReadonlySet<string>;
  /**
   * What is wrong with these files, one line each: a file that is not the one
   * the list of checksums names, a contract that cannot be read, a page that
   * the contract and this build disagree about. Empty when nothing is. A
   * console that finds a line here serves no Secure Data Island.
   */
  problems: readonly string[];
}

function contentTypeOf(name: string): string {
  return name === ISLAND_SUMS_NAME ? "text/plain; charset=utf-8" : contentTypeFor(name);
}

/** Put files, each with its bytes, into the form the door serves from. */
export function islandFilesFrom(bytesByName: ReadonlyMap<string, Uint8Array>): IslandFiles {
  const names = [...bytesByName.keys()].sort();
  const byAddress = new Map<string, IslandFile>();
  for (const name of names) {
    // A copy, so that what is served is these bytes whatever the caller does
    // with its own afterwards.
    const bytes = new Uint8Array(bytesByName.get(name) as Uint8Array);
    const file: IslandFile = { name, contentType: contentTypeOf(name), bytes, etag: `"${sha256Hex(bytes)}"` };
    byAddress.set(name, file);
    if (name.endsWith(".html")) byAddress.set(name.slice(0, -".html".length), file);
  }

  const sums = bytesByName.get(ISLAND_SUMS_NAME);
  const problems =
    sums === undefined
      ? [`${ISLAND_SUMS_NAME} is not among the files`]
      : compareIslandFiles(new TextDecoder().decode(sums), bytesByName);

  let listed: string[] | null = null;
  try {
    listed = kindPagesOfContract(JSON.parse(new TextDecoder().decode(bytesByName.get(ISLAND_CONTRACT_NAME))));
  } catch {
    // Said below: a contract that cannot be read lists no kind.
  }
  if (listed === null) {
    problems.push(`${ISLAND_CONTRACT_NAME} cannot be read, so it names no kind of Secure Data Island`);
    listed = [];
  }
  for (const page of listed) {
    if (!ISLAND_FRAMED_PAGES.has(page)) {
      problems.push(`${ISLAND_CONTRACT_NAME} lists ${page} for a kind, and this build frames no such page`);
    }
  }
  const framed = new Set<string>();
  for (const page of ISLAND_FRAMED_PAGES) {
    if (!listed.includes(page)) problems.push(`this build frames ${page}, and ${ISLAND_CONTRACT_NAME} lists it for no kind`);
    else if (!bytesByName.has(page)) problems.push(`${page}: the page of a kind, and not there`);
    else framed.add(page);
  }
  return { byAddress, names, framed, problems };
}

/**
 * The files this build holds, read into memory. Null when it holds none: a
 * build that was made without them serves no Secure Data Island, and says so
 * when it starts.
 */
export async function loadIslandFiles(): Promise<IslandFiles | null> {
  let paths: Record<string, string>;
  try {
    paths = ((await import("../island-files.gen")) as { ISLAND_FILES: Record<string, string> }).ISLAND_FILES;
  } catch {
    return null;
  }
  const names = Object.keys(paths);
  if (names.length === 0) return null;
  try {
    const read = await Promise.all(
      names.map(async (name): Promise<[string, Uint8Array]> => {
        // A name from this build's own list of files, never a request's.
        // eslint-disable-next-line security/detect-object-injection
        return [name, await Bun.file(paths[name] as string).bytes()];
      }),
    );
    return islandFilesFrom(new Map(read));
  } catch {
    // The module names a file that cannot be read: nothing to serve, and the
    // console says that it holds no page files.
    return null;
  }
}
