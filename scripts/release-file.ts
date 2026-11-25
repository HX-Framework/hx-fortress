// The release file: one JSON file that says what a release is.
//
//   bun run scripts/release-file.ts --dist dist --version 1.4.0 --commit <40 hex> [options]
//
// A release publishes it as `hx-fortress-release.json`. A person who reviews a
// release, and a program that does it for them, reads it to learn: which
// commit was built and by which run; each file with its checksum; whether the
// programs are signed and with which key; the container image and the base
// images it is built on; where the lists of open-source parts are; what
// changed since the release before; and the page files of a Secure Data
// Island with their checksums.
//
// THE FILE STATES ONLY WHAT THIS RUN CAN SEE.
//
//   - A checksum is of the file in `--dist`, taken here.
//   - A gzipped program is unpacked here, and the checksum of what comes out
//     has to be the one the `.sha256` beside it holds. Otherwise nothing is
//     written.
//   - "Signed" is true only when every program in the folder has a signature
//     beside it, and the key is the one those signatures name. A release with
//     no signature says `"signed": false`: it never claims one.
//   - The image is in the file only when this run pushed it and gave its
//     digest, or when the build of this same commit names it (`imageOfBuild`).
//   - A page file is listed only when its bytes are what its own list says.
//   - The list of changes is read from git, and only from a checkout that
//     holds the whole history. A file that was written without reading it
//     says `"changes": null`, never an empty list.
//
// The release file does not list itself, and it is written last. When a
// release is signed, the file's own signature is `hx-fortress-release.json.sig`
// beside it: one signature over every checksum the file holds.
//
// Options:
//
//   --dist <folder>           the folder a release publishes from
//   --version <x.y.z>         the release's version
//   --commit <40 hex>         the commit that was built
//   --run <address>           the run that built it
//   --ref <git ref>           the ref that run was started on
//   --built-at <time>         when, as an ISO time; now, when left out
//   --root <folder>           the repository; this script's own, when left out
//   --dockerfile <file>       the file the image is built from: its base images
//   --image-name <name> --image-digest sha256:<64 hex> --image-tags <a,b>
//                             the image this run pushed
//   --image-from <file>       the release file of the build of this commit, for
//                             a release that is cut from a build and pushes no
//                             image of its own
//   --image-parts-from <file> that build's list of the image's parts, which is
//                             copied into --dist when it is the file the build names
//   --pages <file>            a list of page files as `sha256sum` writes one;
//                             may be given more than once
//   --changes                 read the list of changes from git
//   --out <file>              where to write; into --dist, when left out

import { createHash } from "node:crypto";
import { copyFile, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { parseSignatureSidecar } from "../src/host/trust/verify";

export const RELEASE_FILE = "hx-fortress-release.json";
export const PARTS_FILE = "hx-fortress-parts.cdx.json";
export const IMAGE_PARTS_FILE = "hx-fortress-image-parts.cdx.json";
export const WHAT_CROSSES_FILE = "hx-fortress-what-crosses.json";
export const REPOSITORY = "HX-Framework/hx-fortress";
/** How the tag of an immutable release starts. Its version follows. */
export const RELEASE_TAGS = "releases/hx-fortress-";
/** How many changes a release file lists. `more` counts the older ones. */
export const CHANGES_LISTED = 500;

export interface ReleaseFileEntry {
  name: string;
  /** Of the file as it is published. */
  sha256: string;
  /** For a gzipped program: the program inside. Its checksum is what the
   *  `.sha256` beside it holds and what a signature is made over. */
  holds?: { name: string; sha256: string };
}

export interface BaseImage {
  /** The stage of the Dockerfile that starts from it: its `AS` name, `runtime`
   *  for the last stage, and `copied` for an image a file is copied out of. */
  stage: string;
  image: string;
  /** Null when the Dockerfile names the image by a tag alone. */
  digest: string | null;
}

export interface PushedImage {
  name: string;
  digest: string;
  tags: string[];
}

export interface Changes {
  /** The tag of the immutable release before this one, or null when there is none. */
  since: string | null;
  /** The newest first, at most CHANGES_LISTED of them. */
  commits: { commit: string; subject: string }[];
  /** How many older changes since that release are not listed. */
  more: number;
}

export interface PageFile {
  /** The file's path in the repository at the release's commit. */
  path: string;
  sha256: string;
}

export interface ReleaseFile {
  v: 1;
  product: "HX Fortress";
  version: string;
  commit: string;
  repository: string;
  builtBy: { workflow: string; run: string | null; ref: string | null; at: string };
  signature: { signed: boolean; keyId: string | null };
  buildRecord: { kind: "github-attestation"; verify: string };
  files: ReleaseFileEntry[];
  image: (PushedImage & { bases: BaseImage[] }) | null;
  parts: { program: string | null; image: string | null };
  /** Null when the list was not read. */
  changes: Changes | null;
  pages: PageFile[];
  whatCrosses: string | null;
}

const SHA256 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
/** A registry and a path, with no tag and no digest: `ghcr.io/owner/name`. */
const isImageName = (name: string): boolean => /^[a-z0-9][a-z0-9._/:-]{1,254}$/.test(name) && name.includes("/");
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The images a Dockerfile builds on: what each stage starts from, and each
 * image a file is copied out of. A stage that starts from an earlier stage, or
 * from `scratch`, builds on no image of its own.
 */
export function baseImagesOf(dockerfile: string): BaseImage[] {
  // A line that ends with a backslash goes on in the next one.
  const lines = dockerfile
    .replace(/\\\r?\n/g, " ")
    .split("\n")
    .map((line) => line.trim());
  const named = (source: string): { image: string; digest: string | null } => {
    const at = source.indexOf("@");
    return at >= 0 ? { image: source.slice(0, at), digest: source.slice(at + 1) } : { image: source, digest: null };
  };
  const stages = new Set<string>();
  const found: { image: string; digest: string | null; stage: string | null; last: boolean }[] = [];
  let froms = 0;
  for (const line of lines) {
    const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?$/i.exec(line);
    // A stage this cannot read is never left out without a word.
    if (!from && /^FROM\s/i.test(line)) throw new Error(`this line of the Dockerfile cannot be read: ${line.slice(0, 120)}`);
    if (from) {
      const source = from[1] as string;
      const name = from[2];
      froms += 1;
      for (const entry of found) entry.last = false;
      const earlier = stages.has(source.toLowerCase()) || /^\d+$/.test(source);
      if (name) stages.add(name.toLowerCase());
      if (!earlier && source.toLowerCase() !== "scratch") {
        found.push({ ...named(source), stage: name ?? `stage-${froms}`, last: name === undefined });
      }
      continue;
    }
    const copiedFrom = [
      ...[...line.matchAll(/\s--from=(\S+)/g)].map((match) => match[1] as string),
      ...[...line.matchAll(/\s--mount=\S*?\bfrom=([^,\s]+)/g)].map((match) => match[1] as string),
    ];
    for (const source of copiedFrom) {
      if (stages.has(source.toLowerCase()) || /^\d+$/.test(source)) continue;
      found.push({ ...named(source), stage: "copied", last: false });
    }
  }
  const seen = new Set<string>();
  const bases: BaseImage[] = [];
  for (const entry of found) {
    const base: BaseImage = { stage: entry.last ? "runtime" : (entry.stage as string), image: entry.image, digest: entry.digest };
    const id = `${base.stage} ${base.image} ${base.digest ?? ""}`;
    if (seen.has(id)) continue;
    seen.add(id);
    bases.push(base);
  }
  return bases;
}

/** `<commit>\t<subject>` lines, as `git log --format=%H%x09%s` prints them. A
 *  subject is one line, and at most 300 characters of it are kept. */
export function commitsOf(log: string): { commit: string; subject: string }[] {
  return log
    .split("\n")
    .map((line) => /^([0-9a-f]{40})\t(.*)$/.exec(line))
    .filter((found): found is RegExpExecArray => found !== null)
    .map((found) => ({ commit: found[1] as string, subject: (found[2] as string).slice(0, 300) }));
}

async function git(repository: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repository, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if ((await child.exited) !== 0) {
    throw new Error(`the list of changes is read with git, and \`git ${args.join(" ")}\` failed: ${err.trim() || "it gave no reason"}`);
  }
  return out;
}

/**
 * What changed since the immutable release before this one: the commits from
 * that release's tag to the commit that is checked out.
 *
 * The release before is the nearest tag `releases/hx-fortress-<version>` that
 * the checked-out commit descends from. The tag of this very version is left
 * out, so a release that is cut again from the same commit still names the
 * one before it. With no such tag, every commit is a change. At most `listed`
 * changes are named, the newest first, and `more` counts the rest.
 */
export async function changesSince(repository: string, version: string, listed: number = CHANGES_LISTED): Promise<Changes> {
  // A checkout with a part of the history has neither the tags nor the
  // commits, and would answer "nothing before this, one change".
  if ((await git(repository, ["rev-parse", "--is-shallow-repository"])).trim() !== "false") {
    throw new Error(
      "the list of changes needs the whole history, and this checkout holds a part of it: check out with fetch-depth: 0",
    );
  }
  const own = `${RELEASE_TAGS}${version}`;
  const earlier = (await git(repository, ["tag", "--merged", "HEAD", "--list", `${RELEASE_TAGS}*`]))
    .split("\n")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "" && tag !== own);
  const since =
    earlier.length === 0
      ? null
      : (
          await git(repository, [
            "describe",
            "--tags",
            "--abbrev=0",
            "--match",
            `${RELEASE_TAGS}*`,
            "--exclude",
            own,
            "HEAD",
          ])
        ).trim();
  const range = since === null ? "HEAD" : `${since}..HEAD`;
  const total = Number((await git(repository, ["rev-list", "--count", range])).trim());
  const commits = commitsOf(await git(repository, ["log", `--max-count=${listed}`, "--format=%H%x09%s", range]));
  if (!Number.isInteger(total) || total < commits.length) {
    throw new Error("the list of changes is read with git, and git counted fewer changes than it listed");
  }
  return { since, commits, more: total - commits.length };
}

/**
 * The page files that the given lists name. A list is what `sha256sum` writes:
 * one line for a file, `<sha256>  <name>`, with the name relative to the
 * list's own folder. Each file is read here, and a file whose bytes are not
 * what its list says stops the release file from being written.
 */
export async function pagesOf(repository: string, lists: readonly string[]): Promise<PageFile[]> {
  const root = path.resolve(repository);
  const pages = new Map<string, string>();
  for (const list of lists) {
    const file = path.resolve(root, list);
    const folder = path.relative(root, path.dirname(file));
    if (folder.startsWith("..") || path.isAbsolute(folder)) throw new Error(`${list} is not a file of the repository`);
    // A list of this repository, named by the release workflow.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const text = await readFile(file, "utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const found = /^([0-9a-f]{64}) [ *](\S.*)$/.exec(line);
      const name = found?.[2] ?? "";
      const parts = name.split("/");
      if (!found || name.includes("\\") || parts.some((part) => part === "" || part === "." || part === "..")) {
        throw new Error(`${list} holds a line that is not "<sha256>  <a file under its folder>": ${line.slice(0, 120)}`);
      }
      // A file under that list's own folder.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const is = sha256Of(await readFile(path.join(path.dirname(file), ...parts)));
      if (is !== found[1]) throw new Error(`${name} is not the file ${list} lists: its sha256 is ${is}`);
      const served = [...folder.split(path.sep).filter((part) => part !== ""), ...parts].join("/");
      if (pages.has(served)) throw new Error(`${served} is listed twice`);
      pages.set(served, is);
    }
  }
  return [...pages].map(([served, sha256]) => ({ path: served, sha256 })).sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * The image that the build of a commit pushed, read from that build's release
 * file. Null unless the file is a release file of this very commit that names
 * an image: a release that is cut from a build pushes no image of its own,
 * and names the one its build pushed, never the image of another commit.
 *
 * `partsSha256` is the checksum that build gives for its list of the image's
 * parts, or null when it lists none.
 */
export function imageOfBuild(text: string, commit: string): { image: PushedImage; partsSha256: string | null } | null {
  let build: unknown;
  try {
    build = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(build) || build.v !== 1 || build.commit !== commit || !isRecord(build.image)) return null;
  const { name, digest, tags } = build.image;
  if (typeof name !== "string" || !isImageName(name)) return null;
  if (typeof digest !== "string" || !DIGEST.test(digest)) return null;
  if (!Array.isArray(tags) || !tags.every((tag): tag is string => typeof tag === "string" && IMAGE_TAG.test(tag))) return null;
  const listed = Array.isArray(build.files)
    ? build.files.find((entry): entry is Record<string, unknown> => isRecord(entry) && entry.name === IMAGE_PARTS_FILE)
    : undefined;
  const partsSha256 = typeof listed?.sha256 === "string" && SHA256.test(listed.sha256) ? listed.sha256 : null;
  return { image: { name, digest, tags: [...tags] }, partsSha256 };
}

export interface ReleaseFileInputs {
  dist: string;
  version: string;
  commit: string;
  run?: string | null;
  ref?: string | null;
  builtAt: string;
  /** The text of the Dockerfile the image is built from. */
  dockerfile?: string;
  image?: PushedImage | null;
  changes?: Changes;
  pages?: PageFile[];
}

export async function buildReleaseFile(inputs: ReleaseFileInputs): Promise<ReleaseFile> {
  if (!/^\d+\.\d+\.\d+$/.test(inputs.version)) throw new Error("the version must be three numbers, such as 1.4.0");
  if (!/^[0-9a-f]{40}$/.test(inputs.commit)) throw new Error("the commit must be a full 40-character id");
  if (Number.isNaN(Date.parse(inputs.builtAt))) throw new Error("the time of the build must be an ISO time");
  if (inputs.image) {
    if (!isImageName(inputs.image.name)) throw new Error("the image's name must be a registry and a path, with no tag");
    if (!DIGEST.test(inputs.image.digest)) throw new Error("the image's digest must be sha256:<64 hex>");
    if (!inputs.image.tags.every((tag) => IMAGE_TAG.test(tag))) throw new Error("a tag of the image is not a tag");
  }

  // The folder a release publishes from, named by the workflow. A folder in
  // it is not a file of the release.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const entries = await readdir(inputs.dist, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && entry.name !== RELEASE_FILE && entry.name !== `${RELEASE_FILE}.sig`)
    .map((entry) => entry.name)
    .sort();
  const read = (name: string): Promise<Buffer> =>
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    readFile(path.join(inputs.dist, name));

  const files: ReleaseFileEntry[] = [];
  const keyIds = new Set<string>();
  let programs = 0;
  let signatures = 0;
  for (const name of names) {
    const bytes = await read(name);
    const entry: ReleaseFileEntry = { name, sha256: sha256Of(bytes) };
    if (name.endsWith(".gz")) {
      // A program, gzipped. What a host runs is the program inside.
      const inner = name.slice(0, -".gz".length);
      if (!names.includes(`${inner}.sha256`)) throw new Error(`${name} has no ${inner}.sha256 beside it`);
      const said = (await read(`${inner}.sha256`)).toString("utf8").trim().split(/\s+/)[0] ?? "";
      if (!SHA256.test(said)) throw new Error(`${inner}.sha256 does not hold a sha256`);
      let unpacked: Buffer;
      try {
        unpacked = gunzipSync(bytes);
      } catch {
        throw new Error(`${name} cannot be unpacked`);
      }
      if (sha256Of(unpacked) !== said) throw new Error(`${name} does not hold the program ${inner}.sha256 names`);
      entry.holds = { name: inner, sha256: said };
      programs += 1;
      if (names.includes(`${inner}.sig`)) {
        keyIds.add(parseSignatureSidecar((await read(`${inner}.sig`)).toString("utf8")).keyid);
        signatures += 1;
      }
    }
    files.push(entry);
  }

  // Signed means: every program has its signature beside it. One without is
  // an unsigned release, whatever the others have.
  const signed = programs > 0 && signatures === programs;
  if (signed && keyIds.size !== 1) throw new Error("the programs are signed with more than one key");

  return {
    v: 1,
    product: "HX Fortress",
    version: inputs.version,
    commit: inputs.commit,
    repository: REPOSITORY,
    builtBy: {
      workflow: ".github/workflows/release.yml",
      run: inputs.run ?? null,
      ref: inputs.ref ?? null,
      at: new Date(inputs.builtAt).toISOString(),
    },
    signature: { signed, keyId: signed ? ([...keyIds][0] as string) : null },
    buildRecord: { kind: "github-attestation", verify: `gh attestation verify <file> --repo ${REPOSITORY}` },
    files,
    image: inputs.image
      ? {
          name: inputs.image.name,
          digest: inputs.image.digest,
          tags: [...inputs.image.tags],
          bases: inputs.dockerfile === undefined ? [] : baseImagesOf(inputs.dockerfile),
        }
      : null,
    parts: {
      program: names.includes(PARTS_FILE) ? PARTS_FILE : null,
      image: names.includes(IMAGE_PARTS_FILE) ? IMAGE_PARTS_FILE : null,
    },
    changes: inputs.changes ?? null,
    pages: inputs.pages ?? [],
    whatCrosses: names.includes(WHAT_CROSSES_FILE) ? WHAT_CROSSES_FILE : null,
  };
}

/**
 * For a release that is cut from a build: the image that build pushed, and its
 * list of the image's parts copied into `dist`. The list is copied only when
 * it is the very file the build's release file names by its checksum.
 */
export async function takeImageOfBuild(options: {
  dist: string;
  commit: string;
  buildFile: string;
  partsFile?: string | null;
  say?: (line: string) => void;
}): Promise<PushedImage | null> {
  const say = options.say ?? (() => {});
  // A file the release workflow downloaded and named.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const text = await readFile(options.buildFile, "utf8").catch(() => null);
  const taken = text === null ? null : imageOfBuild(text, options.commit);
  if (!taken) {
    say("The build of this commit names no image that can be read. This release file names none.");
    return null;
  }
  say(`The image is the one the build of this commit pushed: ${taken.image.name}@${taken.image.digest}`);
  if (options.partsFile && taken.partsSha256) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const parts = await readFile(options.partsFile).catch(() => null);
    if (parts !== null && sha256Of(parts) === taken.partsSha256) {
      const target = path.join(options.dist, IMAGE_PARTS_FILE);
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const there = await stat(target).then(
        () => true,
        () => false,
      );
      if (there) throw new Error(`${IMAGE_PARTS_FILE} is already in ${options.dist}: a release holds one list of the image's parts`);
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await copyFile(options.partsFile, target);
      say(`Its list of parts is the build's: ${IMAGE_PARTS_FILE}`);
      return taken.image;
    }
  }
  say("The build's list of the image's parts is not there, or is not the file the build names. This release holds none.");
  return taken.image;
}

const VALUE_FLAGS = [
  "--dist",
  "--version",
  "--commit",
  "--run",
  "--ref",
  "--built-at",
  "--root",
  "--dockerfile",
  "--image-name",
  "--image-digest",
  "--image-tags",
  "--image-from",
  "--image-parts-from",
  "--out",
] as const;

/** The options of a command line. An option this script does not know stops
 *  it: a mistyped one is never left out without a word. */
export function parseArguments(args: readonly string[]): { values: Map<string, string>; pages: string[]; changes: boolean } {
  const values = new Map<string, string>();
  const pages: string[] = [];
  let changes = false;
  for (let at = 0; at < args.length; at += 1) {
    const flag = args[at] as string;
    if (flag === "--changes") {
      changes = true;
      continue;
    }
    const value = args[at + 1];
    if (flag !== "--pages" && !(VALUE_FLAGS as readonly string[]).includes(flag)) {
      throw new Error(`${flag} is not an option of this script`);
    }
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    if (flag === "--pages") pages.push(value);
    else if (values.has(flag)) throw new Error(`${flag} is given twice`);
    else values.set(flag, value);
    at += 1;
  }
  return { values, pages, changes };
}

async function main(): Promise<void> {
  const { values, pages, changes } = parseArguments(process.argv.slice(2));
  const need = (flag: string): string => {
    const value = values.get(flag);
    if (!value) throw new Error(`${flag} is needed`);
    return value;
  };
  const say = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  const dist = need("--dist");
  const version = need("--version");
  const commit = need("--commit");
  const root = path.resolve(values.get("--root") ?? path.join(import.meta.dir, ".."));
  const dockerfile = values.get("--dockerfile");

  const digest = values.get("--image-digest");
  const buildFile = values.get("--image-from");
  if (digest && buildFile) throw new Error("--image-digest and --image-from are two ways to name the image: give one");
  let image: PushedImage | null = null;
  if (digest) {
    image = {
      name: need("--image-name"),
      digest,
      tags: (values.get("--image-tags") ?? "")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    };
  } else if (buildFile) {
    image = await takeImageOfBuild({ dist, commit, buildFile, partsFile: values.get("--image-parts-from") ?? null, say });
  }

  const file = await buildReleaseFile({
    dist,
    version,
    commit,
    run: values.get("--run") ?? null,
    ref: values.get("--ref") ?? null,
    builtAt: values.get("--built-at") ?? new Date().toISOString(),
    // A file of this repository, named by the workflow.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    ...(dockerfile ? { dockerfile: await readFile(dockerfile, "utf8") } : {}),
    image,
    ...(changes ? { changes: await changesSince(root, version) } : {}),
    pages: await pagesOf(root, pages),
  });
  const out = values.get("--out") ?? path.join(dist, RELEASE_FILE);
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(out, `${JSON.stringify(file, null, 2)}\n`);
  say(
    `${out}: ${file.files.length} files, ` +
      `${file.signature.signed ? `signed with ${file.signature.keyId}` : "not signed"}, ` +
      `${file.image ? `image ${file.image.digest}` : "no image"}, ` +
      `${file.changes ? `${file.changes.commits.length + file.changes.more} changes since ${file.changes.since ?? "the first commit"}` : "the changes not read"}, ` +
      `${file.pages.length} page files`,
  );
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
