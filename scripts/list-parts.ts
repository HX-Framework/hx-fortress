// The list of open-source parts of a release, as a CycloneDX document.
//
//   bun run scripts/list-parts.ts [--out <file>] [--version <version>]
//
// A release publishes it as `hx-fortress-parts.cdx.json`. It answers one
// question for a person who reviews a release: which other people's code and
// files does an HX Fortress hold or fetch, at which version, under which
// license.
//
// WHERE THE LIST COMES FROM. Nothing is typed here. Each part is read from the
// file that pins it:
//
//   bun.lock                        the program's own packages
//   ui/bun.lock                     the console's pages, which the program embeds
//   data-runner/go.mod              the data runner's Go modules, and its Go
//   ui/public/fonts                 the console's fonts
//   the Bun that runs this script   the runtime inside the compiled program:
//                                   a release compiles and lists with one Bun
//   src/host/postgres/resolve.ts    the PostgreSQL an HX Fortress downloads when
//                                   it keeps its database on its own disk
//   .github/workflows/release.yml   the pgvector a release builds for that database
//
// WHAT EACH PART SAYS ABOUT ITSELF. A lockfile also pins the tools that build
// and check the program: the compiler, the linter, the bundler of the pages.
// They are not in what a release ships. So each part has a scope:
//
//   required   in what a release ships: the program, the pages or the data runner
//   optional   fetched or used only by an HX Fortress that keeps its database
//              on its own disk
//   excluded   a tool of the build
//
// A package is `required` when a path of dependencies leads to it from what
// `package.json` lists under `dependencies`. A test holds the sources to that
// list (test/release-file.test.ts): they import no package that is not on it.
// The Go modules are all `required`: go.mod lists what the data runner's
// build links.
//
// A license is read from the part's own `package.json` in `node_modules`,
// which `bun install --frozen-lockfile` has filled before a release runs
// this, and for the fonts from the license file beside them. A part whose
// license cannot be read has none in the list: it is never guessed.
//
// The image's parts are another list, `hx-fortress-image-parts.cdx.json`,
// which a scanner makes from the image a release pushes.
//
// The output has no time in it and is sorted, so the same inputs give the
// same bytes.

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_PG_BINARIES_URL, DEFAULT_PG_VERSION } from "../src/host/postgres/resolve";

export type PartOf = "program" | "console" | "data-runner" | "database";

export interface Part {
  name: string;
  /** Left out when the file that pins the part does not say it. */
  version?: string;
  /** Package URL: what a scanner looks a part up by. */
  purl: string;
  partOf: PartOf;
  scope: "required" | "optional" | "excluded";
  /** `file` for a file a release holds as it is, such as a font; `platform`
   *  for the runtime inside the program; `application` for a program that
   *  runs beside HX Fortress. A library, when left out. */
  kind?: "file" | "platform" | "application";
  license?: string;
  /** The checksum the lockfile gives for the part, as hex. */
  sha512?: string;
  /** Of a file a release holds as it is. */
  sha256?: string;
  /** Where an HX Fortress fetches the part from, when it is not in a release. */
  from?: string;
}

/** A `bun.lock` as this script reads it. */
interface BunLock {
  workspaces: Record<string, { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }>;
  packages: Record<string, unknown[]>;
}

/** The lockfile is JSON with a comma after the last item of a list, which
 *  `JSON.parse` does not take. Bun reads its own file. */
export function parseBunLock(text: string): BunLock {
  const parsed = Bun.JSONC.parse(text) as Partial<BunLock> | null;
  if (typeof parsed !== "object" || parsed === null || typeof parsed.packages !== "object" || parsed.packages === null) {
    throw new Error("this is not a bun.lock: it has no packages");
  }
  return { workspaces: parsed.workspaces ?? {}, packages: parsed.packages };
}

/** `name@rest` parted at the `@` that follows the name. A scoped name starts
 *  with one, and what follows may hold more: an address, or a login. */
function nameAndRest(spec: string): { name: string; rest: string } | null {
  const at = spec.indexOf("@", 1);
  if (at <= 0) return null;
  return { name: spec.slice(0, at), rest: spec.slice(at + 1) };
}

/** The folder under `node_modules` that a key of `packages` is installed in.
 *  A key is a path of package names: `a/b` is `b` as `a` needs it. */
export function installFolder(key: string): string {
  const segments = key.split("/");
  const names: string[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] as string;
    if (segment.startsWith("@") && i + 1 < segments.length) {
      names.push(`${segment}/${segments[i + 1] as string}`);
      i += 1;
    } else names.push(segment);
  }
  return names.map((name) => path.join("node_modules", name)).join(path.sep);
}

function purlOfNpm(name: string, version: string): string {
  const [scope, bare] = name.startsWith("@") ? (name.split("/") as [string, string]) : [null, name];
  return scope ? `pkg:npm/${encodeURIComponent(scope)}/${bare}@${version}` : `pkg:npm/${bare}@${version}`;
}

function hexOfIntegrity(integrity: unknown): string | undefined {
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) return undefined;
  return Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex");
}

/** What a part's own `package.json` says, where it is installed. */
export interface Installed {
  license?: string;
  version?: string;
}

/**
 * The parts one `bun.lock` pins. `installed` reads what a part says about
 * itself from where it is installed, or answers nothing.
 */
export async function partsOfBunLock(
  lock: BunLock,
  partOf: PartOf,
  installed: (folder: string) => Promise<Installed>,
): Promise<Part[]> {
  // A package's entry names what it needs in the one item that is an object.
  const needs = (entry: unknown[]): string[] => {
    const info = entry.find((item) => typeof item === "object" && item !== null && !Array.isArray(item)) as
      | {
          dependencies?: Record<string, string>;
          optionalDependencies?: Record<string, string>;
          peerDependencies?: Record<string, string>;
        }
      | undefined;
    return [
      ...Object.keys(info?.dependencies ?? {}),
      ...Object.keys(info?.optionalDependencies ?? {}),
      ...Object.keys(info?.peerDependencies ?? {}),
    ];
  };
  /** The entry a package at `from` gets when it asks for `name`: the nearest
   *  one up its own path, as the installer resolves it. */
  const resolve = (from: string, name: string): string | null => {
    let at = from;
    for (;;) {
      const key = at ? `${at}/${name}` : name;
      if (Object.hasOwn(lock.packages, key)) return key;
      if (!at) return null;
      // One package name up: a scoped name is two segments.
      const segments = at.split("/");
      segments.pop();
      if (segments.length > 0 && (segments[segments.length - 1] as string).startsWith("@")) segments.pop();
      at = segments.join("/");
    }
  };
  // What a release ships: everything a path of dependencies reaches from the
  // workspace's own `dependencies`.
  const shipped = new Set<string>();
  const queue: string[] = [];
  for (const workspace of Object.values(lock.workspaces)) {
    for (const name of [...Object.keys(workspace.dependencies ?? {}), ...Object.keys(workspace.optionalDependencies ?? {})]) {
      const key = resolve("", name);
      if (key) queue.push(key);
    }
  }
  while (queue.length > 0) {
    const key = queue.pop() as string;
    if (shipped.has(key)) continue;
    shipped.add(key);
    for (const name of needs(lock.packages[key] ?? [])) {
      const next = resolve(key, name);
      if (next && !shipped.has(next)) queue.push(next);
    }
  }

  const parts: Part[] = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    const spec = typeof entry[0] === "string" ? nameAndRest(entry[0]) : null;
    if (!spec) continue;
    const said = await installed(installFolder(key));
    const sha512 = hexOfIntegrity(entry[entry.length - 1]);
    const scope = shipped.has(key) ? "required" : "excluded";
    // A part that comes from a repository: `github:<owner>/<repo>#<commit>`.
    const fromRepository = /^github:([^/#]+)\/([^/#]+)#([0-9a-f]+)$/.exec(spec.rest);
    // A part that comes from an address of its own: a packed file.
    const fromAddress = /^https?:\/\//.test(spec.rest);
    // A part that is installed under another name: `npm:<its own name>@<version>`.
    const underAnotherName = /^npm:(.+)@([^@]+)$/.exec(spec.rest);
    let name = spec.name;
    let version: string | undefined;
    let purl: string;
    if (underAnotherName) {
      name = underAnotherName[1] as string;
      version = underAnotherName[2] as string;
      purl = purlOfNpm(name, version);
    } else if (fromRepository) {
      version = fromRepository[3] as string;
      purl = `pkg:github/${(fromRepository[1] as string).toLowerCase()}/${(fromRepository[2] as string).toLowerCase()}@${version}`;
    } else if (fromAddress) {
      // The lockfile gives the address. The version is what the installed
      // part says, and is left out when that cannot be read.
      version = said.version;
      const where = `download_url=${encodeURIComponent(spec.rest)}`;
      purl = version ? `${purlOfNpm(spec.name, version)}?${where}` : `pkg:generic/${encodeURIComponent(spec.name)}?${where}`;
    } else {
      version = spec.rest;
      purl = purlOfNpm(spec.name, version);
    }
    parts.push({
      name,
      ...(version ? { version } : {}),
      purl,
      partOf,
      scope,
      ...(said.license ? { license: said.license } : {}),
      ...(sha512 ? { sha512 } : {}),
      ...(fromAddress ? { from: spec.rest } : {}),
    });
  }
  return parts;
}

/** The version of Go a `go.mod` names: its `toolchain` line, or its `go` line. */
export function goVersionOf(text: string): string | null {
  const toolchain = /^toolchain\s+go(\d+\.\d+(?:\.\d+)?)\s*$/m.exec(text)?.[1];
  return toolchain ?? /^go\s+(\d+\.\d+(?:\.\d+)?)\s*$/m.exec(text)?.[1] ?? null;
}

/** The modules a `go.mod` requires, direct and indirect, and the Go that
 *  builds them, whose standard library the program links. */
export function partsOfGoMod(text: string): Part[] {
  const parts: Part[] = [];
  const go = goVersionOf(text);
  // The name and the address a scanner knows Go's standard library by.
  if (go) parts.push({ name: "stdlib", version: go, purl: `pkg:golang/stdlib@v${go}`, partOf: "data-runner", scope: "required" });
  let inBlock = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (line === "require (") {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ")") {
      inBlock = false;
      continue;
    }
    const found = inBlock ? /^(\S+)\s+(v\S+)$/.exec(line) : /^require\s+(\S+)\s+(v\S+)$/.exec(line);
    if (!found) continue;
    const [, name, version] = found as unknown as [string, string, string];
    parts.push({ name, version, purl: `pkg:golang/${name}@${version}`, partOf: "data-runner", scope: "required" });
  }
  return parts;
}

/** The license a license file states, when it is one this script knows by its
 *  own first words. */
export function licenseOfText(text: string): string | undefined {
  if (/SIL OPEN FONT LICENSE Version 1\.1/i.test(text)) return "OFL-1.1";
  return undefined;
}

/** The console's fonts: files a release holds as they are. */
export async function partsOfFonts(repository: string, folder: string): Promise<Part[]> {
  const dir = path.join(repository, folder);
  // A folder of this repository, named above.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const names = (await readdir(dir)).sort();
  const licenseFile = names.find((name) => /^(OFL|LICENSE)(\.txt)?$/i.test(name));
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const license = licenseFile ? licenseOfText(await readFile(path.join(dir, licenseFile), "utf8")) : undefined;
  const parts: Part[] = [];
  for (const name of names) {
    if (!/\.(woff2?|ttf|otf)$/i.test(name)) continue;
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const sha256 = createHash("sha256").update(await readFile(path.join(dir, name))).digest("hex");
    parts.push({
      name: `${folder}/${name}`,
      purl: `pkg:generic/${encodeURIComponent(name)}?checksum=sha256:${sha256}`,
      partOf: "console",
      scope: "required",
      kind: "file",
      ...(license ? { license } : {}),
      sha256,
    });
  }
  return parts;
}

/** The runtime inside the compiled program. A release compiles the program
 *  and runs this script with one Bun, so the Bun that runs this is the one. */
export function partOfRuntime(version: string = Bun.version): Part {
  return {
    name: "bun",
    version,
    purl: `pkg:github/oven-sh/bun@bun-v${version}`,
    partOf: "program",
    scope: "required",
    kind: "platform",
  };
}

/** The pgvector a release builds, as the release workflow pins it. */
export function pgvectorRefOf(workflow: string): string | null {
  return /^\s*PGVECTOR_REF:\s*"(v[0-9][0-9A-Za-z.-]*)"\s*$/m.exec(workflow)?.[1] ?? null;
}

/** What an HX Fortress that keeps its database on its own disk runs beside
 *  itself: the PostgreSQL it downloads at its first start, and the pgvector
 *  files of the release. */
export function partsOfDatabase(workflow: string): Part[] {
  const parts: Part[] = [
    {
      name: "postgresql",
      version: DEFAULT_PG_VERSION,
      purl: `pkg:generic/postgresql@${DEFAULT_PG_VERSION}`,
      partOf: "database",
      scope: "optional",
      kind: "application",
      from: DEFAULT_PG_BINARIES_URL,
    },
  ];
  const pgvector = pgvectorRefOf(workflow);
  if (pgvector) {
    parts.push({
      name: "pgvector",
      version: pgvector,
      purl: `pkg:github/pgvector/pgvector@${pgvector}`,
      partOf: "database",
      scope: "optional",
    });
  }
  return parts;
}

const RANK = { required: 0, optional: 1, excluded: 2 } as const;

/** Two entries for one part at one version are one part: a lockfile lists a
 *  package once for each place it is installed. The entry that is in what a
 *  release ships wins. */
export function mergeParts(parts: readonly Part[]): Part[] {
  const byId = new Map<string, Part>();
  for (const part of parts) {
    const id = `${part.partOf} ${part.purl}`;
    const held = byId.get(id);
    if (!held || RANK[part.scope] < RANK[held.scope]) byId.set(id, held ? { ...held, ...part } : part);
  }
  return [...byId.values()].sort((a, b) =>
    a.purl < b.purl ? -1 : a.purl > b.purl ? 1 : a.partOf < b.partOf ? -1 : a.partOf > b.partOf ? 1 : 0,
  );
}

/** The CycloneDX document. No time and no random id in it: the same parts
 *  give the same bytes. */
export function cycloneDx(parts: readonly Part[], version: string): Record<string, unknown> {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: { type: "application", name: "hx-fortress", version, "bom-ref": `hx-fortress@${version}` },
    },
    components: parts.map((part) => ({
      type: part.kind ?? "library",
      "bom-ref": `${part.partOf}:${part.purl}`,
      name: part.name,
      ...(part.version ? { version: part.version } : {}),
      purl: part.purl,
      scope: part.scope,
      ...(part.license
        ? { licenses: [{ license: /^[A-Za-z0-9.+-]+$/.test(part.license) ? { id: part.license } : { name: part.license } }] }
        : {}),
      ...(part.sha512 || part.sha256
        ? {
            hashes: [
              ...(part.sha256 ? [{ alg: "SHA-256", content: part.sha256 }] : []),
              ...(part.sha512 ? [{ alg: "SHA-512", content: part.sha512 }] : []),
            ],
          }
        : {}),
      ...(part.from ? { externalReferences: [{ type: "distribution", url: part.from }] } : {}),
      properties: [{ name: "hx-fortress:part-of", value: part.partOf }],
    })),
  };
}

/** What a part's own `package.json` under `root` says. */
function installedReader(root: string): (folder: string) => Promise<Installed> {
  return async (folder) => {
    try {
      // A folder under this repository's own node_modules, named by its lockfile.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const pkg = JSON.parse(await readFile(path.join(root, folder, "package.json"), "utf8")) as {
        license?: unknown;
        version?: unknown;
      };
      const plain = typeof pkg.license === "string" ? pkg.license.trim() : "";
      // The older form: { "type": "MIT" }.
      const older = (pkg.license as { type?: unknown } | undefined)?.type;
      const license = plain !== "" ? plain : typeof older === "string" ? older.trim() : "";
      return {
        ...(license !== "" && license.length <= 200 ? { license } : {}),
        ...(typeof pkg.version === "string" && /^[0-9A-Za-z.+-]{1,60}$/.test(pkg.version) ? { version: pkg.version } : {}),
      };
    } catch {
      return {};
    }
  };
}

export async function listParts(repository: string): Promise<Part[]> {
  const read = (file: string): Promise<string> =>
    // One of the files of this repository that are named above.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    readFile(path.join(repository, file), "utf8");
  return mergeParts([
    partOfRuntime(),
    ...(await partsOfBunLock(parseBunLock(await read("bun.lock")), "program", installedReader(repository))),
    ...(await partsOfBunLock(parseBunLock(await read("ui/bun.lock")), "console", installedReader(path.join(repository, "ui")))),
    ...(await partsOfFonts(repository, "ui/public/fonts")),
    ...partsOfGoMod(await read("data-runner/go.mod")),
    ...partsOfDatabase(await read(".github/workflows/release.yml")),
  ]);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const known = ["--out", "--version"];
  const values = new Map<string, string>();
  for (let at = 0; at < args.length; at += 2) {
    const flag = args[at] as string;
    const value = args[at + 1];
    if (!known.includes(flag)) throw new Error(`${flag} is not an option of this script`);
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    values.set(flag, value);
  }
  const repository = path.resolve(import.meta.dir, "..");
  const version =
    values.get("--version") ?? (JSON.parse(await readFile(path.join(repository, "package.json"), "utf8")) as { version: string }).version;
  const parts = await listParts(repository);
  const text = `${JSON.stringify(cycloneDx(parts, version), null, 2)}\n`;
  const out = values.get("--out");
  if (out) {
    // The path the release workflow names.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(out, text);
    const count = (scope: Part["scope"]): number => parts.filter((part) => part.scope === scope).length;
    process.stdout.write(
      `${out}: ${count("required")} parts in what a release ships, ${count("optional")} for a database on its own disk, ` +
        `${count("excluded")} tools of the build\n`,
    );
  } else process.stdout.write(text);
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
