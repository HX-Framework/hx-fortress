// A zip's files as a person browses them: the names its directory lists, grouped into the folders
// those names imply, and a zip inside it opened as a zip of its own, to any depth.
//
// Listing a zip inflates nothing. Its directory is read by range from the end of the file
// (`zipEntries`), so a zip of any size lists in two or three small reads. A file's bytes are read
// only when someone opens it (`entryBytes`, `entrySource` and `wholeEntry` in zip.ts), and never
// more than the directory says it holds. A zip inside the zip is a range of the outer zip when it
// was stored, and is inflated into memory when it was compressed, up to the cap its caller gives.
//
// Nothing here writes a file anywhere, so a name that climbs out of its folder ("../../etc") is
// only words: it is shown as the folders it names. It reads only through a byte source, so a
// browser can run it on a file it reads by range, and no server has to open the zip at all.

import type { ByteSource } from "./source.js";
import { UnreadableFile } from "./types.js";
import { entrySource, wholeEntry, type ZipEntry, zipEntries } from "./zip.js";

/** A folder of the zip: its name, its path from the zip's top ending in "/", and what it holds at every depth. */
export interface ZipFolder {
  kind: "folder";
  name: string;
  path: string;
  /** Files under it at every depth, clutter left out. */
  files: number;
  /** Their sizes added up, as they are unzipped. */
  size: number;
}

/** A file of the zip, with its directory entry. */
export interface ZipFile {
  kind: "file";
  name: string;
  /** Its path from the zip's top, folders joined by "/". */
  path: string;
  /** Its size unzipped, as the directory gives it. */
  size: number;
  entry: ZipEntry;
}

export type ZipItem = ZipFolder | ZipFile;

/** A zip's folders and files. */
export interface ZipTree {
  /** Files at every depth, clutter left out. */
  readonly fileCount: number;
  /** Their sizes added up, as they are unzipped. */
  readonly size: number;
  /** Files left out as a computer's own clutter: a Mac's `__MACOSX` folder and `._` files, `.DS_Store`, `Thumbs.db`. */
  readonly clutter: number;
  /** A folder's items ("" is the zip's top): its folders, then its files, each in the order a person sorts names ("v2" before "v10"). Null for a folder the zip does not hold. */
  list(folder: string): ZipItem[] | null;
  /** Every file under a folder at every depth, in the order `list` shows them. */
  filesUnder(folder: string): ZipFile[];
}

/** Why a file of the zip cannot be read at all, or null: a password, or a way of compressing that only other tools read. */
export function zipFileRefusal(file: ZipFile): "password" | "method" | null {
  if (file.entry.flags & 1) return "password";
  if (file.entry.method !== 0 && file.entry.method !== 8) return "method";
  return null;
}

/** The kinds of file that are zips a person can open like a folder: a zip, and the formats that are a zip under another name. */
const ZIP_NAMES = /\.(zip|jar|war|ear|apk|aab|ipa|epub|whl|nupkg|vsix|xpi)$/i;

/** Whether a name is a zip a person can open like a folder. */
export function isZipName(name: string): boolean {
  return ZIP_NAMES.test(name);
}

/** A file a computer writes beside a person's files, which they never meant to send. */
function isClutter(segments: readonly string[]): boolean {
  if (segments.includes("__MACOSX")) return true;
  const last = segments[segments.length - 1] ?? "";
  return last.startsWith("._") || /^(\.DS_Store|Thumbs\.db|desktop\.ini|Icon\r)$/i.test(last);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const byName = (a: { name: string }, b: { name: string }): number => collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

interface FolderNode {
  name: string;
  path: string;
  folders: Map<string, FolderNode>;
  files: ZipFile[];
  fileCount: number;
  size: number;
}

const folderNode = (name: string, path: string): FolderNode => ({ name, path, folders: new Map(), files: [], fileCount: 0, size: 0 });

/** The folders and files a zip's entries name. A name's empty and "." parts are passed over; an entry whose name ends in "/" is a folder, kept even when empty. */
export function zipTreeOf(entries: ReadonlyMap<string, ZipEntry>): ZipTree {
  const top = folderNode("", "");
  let clutter = 0;
  for (const [key, entry] of entries) {
    const isFolder = key.endsWith("/");
    const segments = key.split("/").filter((s) => s !== "" && s !== ".");
    if (segments.length === 0) continue;
    if (isClutter(segments)) {
      if (!isFolder) clutter += 1;
      continue;
    }
    const folderSegments = isFolder ? segments : segments.slice(0, -1);
    const chain: FolderNode[] = [top];
    let node = top;
    for (const segment of folderSegments) {
      let next = node.folders.get(segment);
      if (!next) {
        next = folderNode(segment, `${node.path}${segment}/`);
        node.folders.set(segment, next);
      }
      node = next;
      chain.push(node);
    }
    if (isFolder) continue;
    const name = segments[segments.length - 1]!;
    node.files.push({ kind: "file", name, path: `${node.path}${name}`, size: entry.size, entry });
    for (const above of chain) {
      above.fileCount += 1;
      above.size += entry.size;
    }
  }

  const sorted = new WeakSet<FolderNode>();
  const sortOnce = (node: FolderNode): void => {
    if (sorted.has(node)) return;
    node.files.sort(byName);
    sorted.add(node);
  };
  const find = (folder: string): FolderNode | null => {
    let node: FolderNode | undefined = top;
    for (const segment of folder.split("/").filter((s) => s !== "")) {
      node = node.folders.get(segment);
      if (!node) return null;
    }
    return node;
  };
  const itemsOf = (node: FolderNode): ZipItem[] => {
    sortOnce(node);
    const folders: ZipFolder[] = [...node.folders.values()].map((f) => ({ kind: "folder", name: f.name, path: f.path, files: f.fileCount, size: f.size }));
    folders.sort(byName);
    return [...folders, ...node.files];
  };

  return {
    fileCount: top.fileCount,
    size: top.size,
    clutter,
    list(folder) {
      const node = find(folder);
      return node ? itemsOf(node) : null;
    },
    filesUnder(folder) {
      const node = find(folder);
      if (!node) return [];
      const out: ZipFile[] = [];
      const walk = (n: FolderNode): void => {
        for (const item of itemsOf(n)) {
          if (item.kind === "file") out.push(item);
          else walk(n.folders.get(item.name)!);
        }
      };
      walk(node);
      return out;
    },
  };
}

/** The longest zip directory a person's browser reads: past it the zip lists as too big to look inside. */
export const ZIP_LIST_MAX_BYTES = 64 << 20;

/** The most of one file anything unzips, a person's browser and the Store gateway's zip reader alike: past it, the zip itself is the way. */
export const ZIP_FILE_OUT_MAX = 512 << 20;

/** A zip's tree, read from its directory alone. Throws `UnreadableFile` for a file that is not a zip, or one cut short. */
export async function readZipTree(source: ByteSource, maxListBytes = ZIP_LIST_MAX_BYTES): Promise<ZipTree> {
  return zipTreeOf(await zipEntries(source, "This zip", maxListBytes));
}

/**
 * A zip inside the zip, as a source of its own. A stored one is a range of the outer zip and opens
 * at any size; a compressed one is inflated into memory, and refused (`too-big`) past `inflateMax`
 * before a byte is read. Throws `UnreadableFile` for a password or a way of compressing that is not
 * read here (`unsupported`), and for one that does not inflate (`damaged`).
 */
export async function openZipInZip(source: ByteSource, file: ZipFile, inflateMax: number): Promise<ByteSource> {
  const refusal = zipFileRefusal(file);
  if (refusal) throw new UnreadableFile(`${file.name} cannot be opened: ${refusal === "password" ? "it is protected with a password" : "it is compressed in a way that is not read here"}.`, "unsupported");
  if (file.entry.method === 0) return entrySource(source, file.entry);
  if (file.size > inflateMax) throw new UnreadableFile(`${file.name} is too big to open inside the zip.`, "too-big");
  return wholeEntry(source, file.entry);
}
