// The release file and the list of open-source parts: what a release says
// about itself. Both are written by scripts the release workflow runs. They
// are tested here on made-up folders, on a throwaway git repository and on
// this repository's own lockfiles.

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { Glob } from "bun";

import {
  cycloneDx,
  goVersionOf,
  installFolder,
  licenseOfText,
  listParts,
  mergeParts,
  parseBunLock,
  partOfRuntime,
  partsOfBunLock,
  partsOfDatabase,
  partsOfFonts,
  partsOfGoMod,
  pgvectorRefOf,
  type Installed,
  type Part,
} from "../scripts/list-parts";
import {
  baseImagesOf,
  buildReleaseFile,
  changesSince,
  CHANGES_LISTED,
  commitsOf,
  IMAGE_PARTS_FILE,
  imageOfBuild,
  pagesOf,
  parseArguments,
  PARTS_FILE,
  RELEASE_FILE,
  takeImageOfBuild,
  WHAT_CROSSES_FILE,
} from "../scripts/release-file";

const REPOSITORY = path.resolve(import.meta.dir, "..");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER_COMMIT = "89abcdef0123456789abcdef0123456789abcdef";
const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const DIGEST = `sha256:${sha256("an image")}`;

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function folder(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-release-"));
  made.push(dir);
  return dir;
}

/** One program of a release: the gzipped file, its checksum, and its
 *  signature when a key is named. */
async function program(dir: string, name: string, bytes: Uint8Array, signedBy?: string): Promise<void> {
  await writeFile(path.join(dir, `${name}.gz`), gzipSync(bytes));
  await writeFile(path.join(dir, `${name}.sha256`), `${sha256(bytes)}  ${name}\n`);
  if (signedBy) {
    const sig = Buffer.from("a signature made for this test").toString("base64url");
    await writeFile(path.join(dir, `${name}.sig`), JSON.stringify({ v: 1, alg: "Ed25519", keyid: signedBy, sig }));
  }
}

/** A release's folder with one program in it. */
async function dist(
  options: { signedBy?: string; extra?: Record<string, string | Uint8Array> } = {},
): Promise<{ dir: string; bytes: Buffer }> {
  const dir = await folder();
  const bytes = Buffer.from("the program's bytes");
  await program(dir, "hx-fortress-linux-x64", bytes, options.signedBy);
  await writeFile(path.join(dir, "hx-fortress-version"), "1.4.0\n");
  for (const [name, content] of Object.entries(options.extra ?? {})) await writeFile(path.join(dir, name), content);
  return { dir, bytes };
}

const inputs = (dir: string) => ({ dist: dir, version: "1.4.0", commit: COMMIT, builtAt: "2026-11-16T13:00:00.000Z" });

/** Runs a command and answers its exit code and what it printed. */
async function run(command: string[], cwd: string): Promise<{ code: number; out: string }> {
  const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code: await child.exited, out: out + err };
}

/** A throwaway git repository. `commit` makes one empty commit and answers its id. */
async function repository(): Promise<{ dir: string; commit: (subject: string) => Promise<string>; tag: (name: string) => Promise<void> }> {
  const dir = await folder();
  // The settings of the person who runs the test stay out: no signing, no hooks.
  const git = async (...args: string[]): Promise<string> => {
    const said = await run(
      ["git", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
      dir,
    );
    if (said.code !== 0) throw new Error(`git ${args.join(" ")}: ${said.out}`);
    return said.out.trim();
  };
  await git("init", "--quiet", "--initial-branch=main");
  return {
    dir,
    commit: async (subject) => {
      await git("-c", "user.name=A Tester", "-c", "user.email=tester@northstar.example", "commit", "--quiet", "--allow-empty", "-m", subject);
      return git("rev-parse", "HEAD");
    },
    tag: async (name) => {
      await git("tag", name);
    },
  };
}

describe("the release file", () => {
  test("lists every file of the release with its checksum, and the program inside a gzipped file", async () => {
    const { dir, bytes } = await dist();
    const file = await buildReleaseFile(inputs(dir));
    expect(file.v).toBe(1);
    expect(file.product).toBe("HX Fortress");
    expect([file.version, file.commit, file.repository]).toEqual(["1.4.0", COMMIT, "HX-Framework/hx-fortress"]);
    expect(file.builtBy).toEqual({
      workflow: ".github/workflows/release.yml",
      run: null,
      ref: null,
      at: "2026-11-16T13:00:00.000Z",
    });
    expect(file.files.map((entry) => entry.name)).toEqual([
      "hx-fortress-linux-x64.gz",
      "hx-fortress-linux-x64.sha256",
      "hx-fortress-version",
    ]);
    const gz = file.files[0];
    expect(gz?.sha256).toBe(sha256(await readFile(path.join(dir, "hx-fortress-linux-x64.gz"))));
    // What the `.sha256` beside it holds, and what a signature is made over.
    expect(gz?.holds).toEqual({ name: "hx-fortress-linux-x64", sha256: sha256(bytes) });
    expect(file.files[2]).toEqual({ name: "hx-fortress-version", sha256: sha256("1.4.0\n") });
  });

  test("unpacks each program, and refuses a release whose program is not the one its checksum names", async () => {
    // The checksum is of another program.
    const other = await dist();
    await writeFile(path.join(other.dir, "hx-fortress-linux-x64.gz"), gzipSync(Buffer.from("another program")));
    await expect(buildReleaseFile(inputs(other.dir))).rejects.toThrow("does not hold the program hx-fortress-linux-x64.sha256 names");
    // No checksum beside it.
    const bare = await dist();
    await rm(path.join(bare.dir, "hx-fortress-linux-x64.sha256"));
    await expect(buildReleaseFile(inputs(bare.dir))).rejects.toThrow("has no hx-fortress-linux-x64.sha256 beside it");
    // Not a gzipped file at all.
    const broken = await dist();
    await writeFile(path.join(broken.dir, "hx-fortress-linux-x64.gz"), "not gzipped");
    await expect(buildReleaseFile(inputs(broken.dir))).rejects.toThrow("cannot be unpacked");
    // A checksum file that holds a page of an error instead.
    const page = await dist();
    await writeFile(path.join(page.dir, "hx-fortress-linux-x64.sha256"), "<html>not found</html>");
    await expect(buildReleaseFile(inputs(page.dir))).rejects.toThrow("does not hold a sha256");
  });

  test("says signed only when every program has a signature, and names the key those signatures name", async () => {
    expect((await buildReleaseFile(inputs((await dist()).dir))).signature).toEqual({ signed: false, keyId: null });
    const signed = await dist({ signedBy: "a-key" });
    expect((await buildReleaseFile(inputs(signed.dir))).signature).toEqual({ signed: true, keyId: "a-key" });
    // A second program with no signature makes the release an unsigned one.
    const half = await dist({ signedBy: "a-key" });
    await program(half.dir, "hx-fortress-darwin-arm64", Buffer.from("a second program"));
    expect((await buildReleaseFile(inputs(half.dir))).signature).toEqual({ signed: false, keyId: null });
    // Two keys in one release are refused: the file names one.
    const two = await dist({ signedBy: "a-key" });
    await program(two.dir, "hx-fortress-darwin-arm64", Buffer.from("a second program"), "another-key");
    await expect(buildReleaseFile(inputs(two.dir))).rejects.toThrow("more than one key");
    // A signature file that is not one stops the file from being written.
    const bad = await dist({ extra: { "hx-fortress-linux-x64.sig": "not a signature" } });
    await expect(buildReleaseFile(inputs(bad.dir))).rejects.toThrow("malformed signature sidecar");
  });

  test("never lists itself or a folder, and is the same for the same folder", async () => {
    const { dir } = await dist();
    const first = await buildReleaseFile(inputs(dir));
    await writeFile(path.join(dir, RELEASE_FILE), JSON.stringify(first));
    await writeFile(path.join(dir, `${RELEASE_FILE}.sig`), "{}");
    await mkdir(path.join(dir, "a-folder"));
    expect(await buildReleaseFile(inputs(dir))).toEqual(first);
  });

  test("names the lists of open-source parts and the file of what crosses only when the release holds them", async () => {
    const bare = await buildReleaseFile(inputs((await dist()).dir));
    expect(bare.parts).toEqual({ program: null, image: null });
    expect(bare.whatCrosses).toBeNull();
    const full = await dist({ extra: { [PARTS_FILE]: "{}", [IMAGE_PARTS_FILE]: "{}", [WHAT_CROSSES_FILE]: "{}" } });
    const file = await buildReleaseFile(inputs(full.dir));
    expect(file.parts).toEqual({ program: "hx-fortress-parts.cdx.json", image: "hx-fortress-image-parts.cdx.json" });
    expect(file.whatCrosses).toBe("hx-fortress-what-crosses.json");
    // Each is a file of the release like any other, with its checksum.
    expect(file.files.find((entry) => entry.name === PARTS_FILE)).toEqual({ name: PARTS_FILE, sha256: sha256("{}") });
  });

  test("the changes and the page files are what it is given: none read is null, and no page file is an empty list", async () => {
    const { dir } = await dist();
    const bare = await buildReleaseFile(inputs(dir));
    // "Not read" is not "nothing changed".
    expect(bare.changes).toBeNull();
    expect(bare.pages).toEqual([]);
    const changes = { since: "releases/hx-fortress-1.3.0", commits: [{ commit: COMMIT, subject: "A change" }], more: 0 };
    const pages = [{ path: "pages/v1/open.html", sha256: sha256("a page") }];
    const file = await buildReleaseFile({ ...inputs(dir), changes, pages });
    expect(file.changes).toEqual(changes);
    expect(file.pages).toEqual(pages);
  });

  test("holds the image only when it is given, with the base images of the Dockerfile", async () => {
    const { dir } = await dist();
    expect((await buildReleaseFile(inputs(dir))).image).toBeNull();
    // A Dockerfile alone names no image: only a pushed image does.
    expect((await buildReleaseFile({ ...inputs(dir), dockerfile: "FROM a/base:1\n" })).image).toBeNull();
    const file = await buildReleaseFile({
      ...inputs(dir),
      image: { name: "ghcr.io/hx-framework/hx-fortress", digest: DIGEST, tags: ["1.4.0", "sha-01234567"] },
      dockerfile: `FROM a/build:1@sha256:${"a".repeat(64)} AS build\nFROM build AS again\nFROM b/run:2-slim\n`,
    });
    expect(file.image).toEqual({
      name: "ghcr.io/hx-framework/hx-fortress",
      digest: DIGEST,
      tags: ["1.4.0", "sha-01234567"],
      bases: [
        { stage: "build", image: "a/build:1", digest: `sha256:${"a".repeat(64)}` },
        { stage: "runtime", image: "b/run:2-slim", digest: null },
      ],
    });
  });

  test("refuses a version, a commit, a time or an image that is not one", async () => {
    const { dir } = await dist();
    const image = { name: "ghcr.io/hx-framework/hx-fortress", digest: DIGEST, tags: ["1.4.0"] };
    await expect(buildReleaseFile({ ...inputs(dir), version: "1.4" })).rejects.toThrow("three numbers");
    await expect(buildReleaseFile({ ...inputs(dir), commit: "0123456" })).rejects.toThrow("40-character");
    await expect(buildReleaseFile({ ...inputs(dir), builtAt: "yesterday" })).rejects.toThrow("ISO time");
    await expect(buildReleaseFile({ ...inputs(dir), image: { ...image, digest: "latest" } })).rejects.toThrow("sha256:<64 hex>");
    await expect(buildReleaseFile({ ...inputs(dir), image: { ...image, name: "hx-fortress:1.4.0@x" } })).rejects.toThrow(
      "a registry and a path",
    );
    await expect(buildReleaseFile({ ...inputs(dir), image: { ...image, tags: ["a tag"] } })).rejects.toThrow("is not a tag");
  });
});

describe("the base images of a Dockerfile", () => {
  test("each stage's image with its digest, and no entry for a stage that starts from an earlier one", () => {
    const pinned = `sha256:${"b".repeat(64)}`;
    expect(
      baseImagesOf(
        [
          "# a comment",
          `FROM --platform=linux/amd64 a/build:1@${pinned} AS build`,
          "RUN make",
          "FROM build AS test",
          "FROM scratch AS empty",
          "FROM c/tools:3",
          "FROM b/run:2-slim",
          "COPY --from=build /out /out",
        ].join("\n"),
      ),
    ).toEqual([
      { stage: "build", image: "a/build:1", digest: pinned },
      { stage: "stage-4", image: "c/tools:3", digest: null },
      { stage: "runtime", image: "b/run:2-slim", digest: null },
    ]);
  });

  test("an image that a file is copied out of is a base image too, and a stage is not", () => {
    const bases = baseImagesOf(
      [
        "FROM a/build:1 AS build",
        "FROM b/run:2",
        "COPY --from=build /out /out",
        "COPY --chown=1:1 \\",
        "  --from=d/certs:9 /etc/ssl /etc/ssl",
        "RUN --mount=type=bind,from=e/cache:4,target=/cache true",
        "COPY --from=0 /a /a",
      ].join("\n"),
    );
    expect(bases).toEqual([
      { stage: "build", image: "a/build:1", digest: null },
      { stage: "runtime", image: "b/run:2", digest: null },
      { stage: "copied", image: "d/certs:9", digest: null },
      { stage: "copied", image: "e/cache:4", digest: null },
    ]);
  });

  test("a FROM line it cannot read stops it: a stage is never left out without a word", () => {
    expect(() => baseImagesOf("FROM a/build:1 AS\n")).toThrow("cannot be read");
    expect(() => baseImagesOf("FROM a/build:1 AS build extra\n")).toThrow("cannot be read");
  });

  test("every base image of this repository's Dockerfile is pinned by its digest", async () => {
    const bases = baseImagesOf(await readFile(path.join(REPOSITORY, "Dockerfile"), "utf8"));
    expect(bases.map((base) => base.stage)).toEqual(["build", "data-runner", "runtime"]);
    for (const base of bases) {
      expect([base.image, /^sha256:[0-9a-f]{64}$/.test(base.digest ?? "")]).toEqual([base.image, true]);
      // A tag beside the digest says which image it is to a person.
      expect([base.image, /^[a-z0-9./-]+:[A-Za-z0-9._-]+$/.test(base.image)]).toEqual([base.image, true]);
    }
  });
});

describe("the list of changes", () => {
  test("the commits git names, each as one line", () => {
    const one = "a".repeat(40);
    const two = "b".repeat(40);
    expect(commitsOf(`${one}\tThe first change\n${two}\tA second, with a\ttab in it\n\nnot a line\nabc1234\ttoo short an id\n`)).toEqual([
      { commit: one, subject: "The first change" },
      { commit: two, subject: "A second, with a\ttab in it" },
    ]);
    expect(commitsOf(`${one}\t${"x".repeat(400)}`)[0]?.subject).toHaveLength(300);
  });

  test("the commits since the immutable release before this one, the newest first", async () => {
    const repo = await repository();
    await repo.commit("The first release");
    await repo.tag("releases/hx-fortress-1.2.0");
    await repo.commit("A change of 1.3.0");
    await repo.tag("releases/hx-fortress-1.3.0");
    const fourth = await repo.commit("A change since then");
    // A build's tag is not a release: it does not end the list.
    await repo.tag("builds/hx-fortress-1.4.0");
    const fifth = await repo.commit("The newest change");
    expect(await changesSince(repo.dir, "1.4.0")).toEqual({
      since: "releases/hx-fortress-1.3.0",
      commits: [
        { commit: fifth, subject: "The newest change" },
        { commit: fourth, subject: "A change since then" },
      ],
      more: 0,
    });
    // The tag of this very version is left out: a release cut again from the
    // same commit still names the one before it.
    await repo.tag("releases/hx-fortress-1.4.0");
    expect((await changesSince(repo.dir, "1.4.0")).since).toBe("releases/hx-fortress-1.3.0");
    // For the version after it, that tag is the release before, and nothing changed since.
    expect(await changesSince(repo.dir, "1.5.0")).toEqual({ since: "releases/hx-fortress-1.4.0", commits: [], more: 0 });
  });

  test("with no release before it, every commit is a change, and what is not listed is counted", async () => {
    const repo = await repository();
    const first = await repo.commit("The first commit");
    const second = await repo.commit("The second commit");
    const third = await repo.commit("The third commit");
    expect(await changesSince(repo.dir, "1.4.0")).toEqual({
      since: null,
      commits: [
        { commit: third, subject: "The third commit" },
        { commit: second, subject: "The second commit" },
        { commit: first, subject: "The first commit" },
      ],
      more: 0,
    });
    expect(await changesSince(repo.dir, "1.4.0", 2)).toEqual({
      since: null,
      commits: [
        { commit: third, subject: "The third commit" },
        { commit: second, subject: "The second commit" },
      ],
      more: 1,
    });
    expect(CHANGES_LISTED).toBe(500);
  });

  test("a checkout with a part of the history is refused: it would say that nothing came before", async () => {
    const repo = await repository();
    await repo.commit("The first release");
    await repo.tag("releases/hx-fortress-1.3.0");
    await repo.commit("A change since then");
    const shallow = path.join(await folder(), "checkout");
    const cloned = await run(["git", "clone", "--quiet", "--depth", "1", `file://${repo.dir}`, shallow], repo.dir);
    expect(cloned.code).toBe(0);
    await expect(changesSince(shallow, "1.4.0")).rejects.toThrow("needs the whole history");
    // And a folder that is no checkout at all says that git failed.
    await expect(changesSince(await folder(), "1.4.0")).rejects.toThrow("is read with git");
  });
});

describe("the page files of a Secure Data Island", () => {
  /** A repository's folder with one folder of page files and its list. */
  async function pages(): Promise<{ root: string; list: string }> {
    const root = await folder();
    const dir = path.join(root, "pages", "v1");
    await mkdir(path.join(dir, "parts"), { recursive: true });
    await writeFile(path.join(dir, "open.html"), "<p>open</p>");
    await writeFile(path.join(dir, "parts", "rows.js"), "rows();");
    await writeFile(
      path.join(dir, "SHA256SUMS"),
      `${sha256("rows();")}  parts/rows.js\n${sha256("<p>open</p>")} *open.html\n\n`,
    );
    return { root, list: "pages/v1/SHA256SUMS" };
  }

  test("each file its list names, by its path in the repository, with the checksum of its bytes", async () => {
    const { root, list } = await pages();
    expect(await pagesOf(root, [list])).toEqual([
      { path: "pages/v1/open.html", sha256: sha256("<p>open</p>") },
      { path: "pages/v1/parts/rows.js", sha256: sha256("rows();") },
    ]);
    expect(await pagesOf(root, [])).toEqual([]);
  });

  test("a file whose bytes are not what its list says stops the release file", async () => {
    const { root, list } = await pages();
    await writeFile(path.join(root, "pages", "v1", "open.html"), "<p>changed</p>");
    await expect(pagesOf(root, [list])).rejects.toThrow("open.html is not the file pages/v1/SHA256SUMS lists");
  });

  test("a list names files under its own folder, each once, and is a file of the repository", async () => {
    const { root, list } = await pages();
    const file = path.join(root, list);
    for (const name of ["../../outside.txt", "/etc/hosts", "parts//rows.js", "./open.html", "parts\\rows.js"]) {
      await writeFile(file, `${sha256("x")}  ${name}\n`);
      await expect(pagesOf(root, [list])).rejects.toThrow("holds a line that is not");
    }
    await writeFile(file, "not a line of a list\n");
    await expect(pagesOf(root, [list])).rejects.toThrow("holds a line that is not");
    await writeFile(file, `${sha256("<p>open</p>")}  open.html\n${sha256("<p>open</p>")}  open.html\n`);
    await expect(pagesOf(root, [list])).rejects.toThrow("pages/v1/open.html is listed twice");
    await expect(pagesOf(root, ["../SHA256SUMS"])).rejects.toThrow("is not a file of the repository");
  });

  test("this repository's own lists are read whole", async () => {
    const lists = [...new Glob("islands/*/SHA256SUMS").scanSync({ cwd: REPOSITORY })].sort();
    const listed = await pagesOf(REPOSITORY, lists);
    let lines = 0;
    for (const list of lists) {
      lines += (await readFile(path.join(REPOSITORY, list), "utf8")).split("\n").filter((line) => line.trim() !== "").length;
    }
    expect(listed).toHaveLength(lines);
    for (const page of listed) expect([page.path, page.path.startsWith("islands/")]).toEqual([page.path, true]);
  });
});

describe("the image of a release that is cut from a build", () => {
  const build = (changed: Record<string, unknown> = {}): string =>
    JSON.stringify({
      v: 1,
      commit: COMMIT,
      image: { name: "ghcr.io/hx-framework/hx-fortress", digest: DIGEST, tags: ["1.4.0", "sha-01234567"] },
      files: [{ name: IMAGE_PARTS_FILE, sha256: sha256("the image's parts") }],
      ...changed,
    });

  test("is the one the build of the same commit names, and no other", () => {
    expect(imageOfBuild(build(), COMMIT)).toEqual({
      image: { name: "ghcr.io/hx-framework/hx-fortress", digest: DIGEST, tags: ["1.4.0", "sha-01234567"] },
      partsSha256: sha256("the image's parts"),
    });
    // The build of another commit pushed another image.
    expect(imageOfBuild(build(), OTHER_COMMIT)).toBeNull();
    expect(imageOfBuild(build({ commit: OTHER_COMMIT }), COMMIT)).toBeNull();
    // A file that is not a release file of this shape, or names no image that can be read.
    expect(imageOfBuild("not json", COMMIT)).toBeNull();
    expect(imageOfBuild(build({ v: 2 }), COMMIT)).toBeNull();
    expect(imageOfBuild(build({ image: null }), COMMIT)).toBeNull();
    for (const image of [
      { name: "ghcr.io/hx-framework/hx-fortress", digest: "latest", tags: [] },
      { name: "no-registry", digest: DIGEST, tags: [] },
      { name: "ghcr.io/hx-framework/hx-fortress", digest: DIGEST, tags: ["a tag"] },
      { name: "ghcr.io/hx-framework/hx-fortress", digest: DIGEST, tags: "1.4.0" },
    ]) {
      expect(imageOfBuild(build({ image }), COMMIT)).toBeNull();
    }
    // A build that lists no parts of its image still names the image.
    expect(imageOfBuild(build({ files: [] }), COMMIT)?.partsSha256).toBeNull();
  });

  test("its list of parts is copied only when it is the very file the build names", async () => {
    const from = await folder();
    await writeFile(path.join(from, "build.json"), build());
    await writeFile(path.join(from, "parts.json"), "the image's parts");
    await writeFile(path.join(from, "other.json"), "another list");

    const taken = await dist();
    const said: string[] = [];
    const image = await takeImageOfBuild({
      dist: taken.dir,
      commit: COMMIT,
      buildFile: path.join(from, "build.json"),
      partsFile: path.join(from, "parts.json"),
      say: (line) => said.push(line),
    });
    expect(image?.digest).toBe(DIGEST);
    expect(await readFile(path.join(taken.dir, IMAGE_PARTS_FILE), "utf8")).toBe("the image's parts");
    expect(said.join("\n")).toContain(`ghcr.io/hx-framework/hx-fortress@${DIGEST}`);
    // The release file then names both.
    const file = await buildReleaseFile({ ...inputs(taken.dir), image });
    expect(file.image?.digest).toBe(DIGEST);
    expect(file.parts.image).toBe(IMAGE_PARTS_FILE);

    // Another file under the build's name is left where it is. The image is still the build's.
    const left = await dist();
    const still = await takeImageOfBuild({
      dist: left.dir,
      commit: COMMIT,
      buildFile: path.join(from, "build.json"),
      partsFile: path.join(from, "other.json"),
    });
    expect(still?.digest).toBe(DIGEST);
    expect(await readFile(path.join(left.dir, IMAGE_PARTS_FILE), "utf8").catch(() => null)).toBeNull();
    expect((await buildReleaseFile({ ...inputs(left.dir), image: still })).parts.image).toBeNull();
  });

  test("the build of another commit, or no build at all, gives no image and copies nothing", async () => {
    const from = await folder();
    await writeFile(path.join(from, "build.json"), build({ commit: OTHER_COMMIT }));
    await writeFile(path.join(from, "parts.json"), "the image's parts");
    const { dir } = await dist();
    const said: string[] = [];
    for (const buildFile of [path.join(from, "build.json"), path.join(from, "no-such-file.json")]) {
      const image = await takeImageOfBuild({
        dist: dir,
        commit: COMMIT,
        buildFile,
        partsFile: path.join(from, "parts.json"),
        say: (line) => said.push(line),
      });
      expect(image).toBeNull();
    }
    expect(await readFile(path.join(dir, IMAGE_PARTS_FILE), "utf8").catch(() => null)).toBeNull();
    expect(said).toHaveLength(2);
    expect(said[0]).toContain("names none");
  });
});

describe("the two scripts, as a release runs them", () => {
  test("an option the release file's script does not know stops it", () => {
    expect(() => parseArguments(["--dist", "dist", "--changs"])).toThrow("--changs is not an option of this script");
    expect(() => parseArguments(["--dist"])).toThrow("--dist needs a value");
    expect(() => parseArguments(["--dist", "--changes"])).toThrow("--dist needs a value");
    expect(() => parseArguments(["--dist", "a", "--dist", "b"])).toThrow("--dist is given twice");
    const parsed = parseArguments(["--dist", "dist", "--pages", "a/SHA256SUMS", "--changes", "--pages", "b/SHA256SUMS"]);
    expect([...parsed.values]).toEqual([["--dist", "dist"]]);
    expect(parsed.pages).toEqual(["a/SHA256SUMS", "b/SHA256SUMS"]);
    expect(parsed.changes).toBe(true);
  });

  test("the release file's script writes the file into the release's folder, and says no when it cannot", async () => {
    const { dir } = await dist();
    const bun = process.execPath;
    const ok = await run(
      [bun, "scripts/release-file.ts", "--dist", dir, "--version", "1.4.0", "--commit", COMMIT, "--dockerfile", "Dockerfile"],
      REPOSITORY,
    );
    expect([ok.code, ok.out]).toEqual([0, expect.stringContaining("3 files, not signed, no image, the changes not read, 0 page files")]);
    const written = JSON.parse(await readFile(path.join(dir, RELEASE_FILE), "utf8")) as { version: string; image: unknown };
    expect([written.version, written.image]).toEqual(["1.4.0", null]);
    // Two ways to name the image are one too many, and nothing is written over the file.
    const before = await readFile(path.join(dir, RELEASE_FILE), "utf8");
    const twice = await run(
      [bun, "scripts/release-file.ts", "--dist", dir, "--version", "1.4.0", "--commit", COMMIT, "--image-digest", DIGEST, "--image-from", "x"],
      REPOSITORY,
    );
    expect([twice.code, twice.out]).toEqual([1, expect.stringContaining("error: --image-digest and --image-from are two ways")]);
    expect(await readFile(path.join(dir, RELEASE_FILE), "utf8")).toBe(before);
  });

  test("the parts script writes a CycloneDX document where it is told to", async () => {
    const out = path.join(await folder(), PARTS_FILE);
    const said = await run([process.execPath, "scripts/list-parts.ts", "--out", out, "--version", "1.4.0"], REPOSITORY);
    expect([said.code, said.out]).toEqual([0, expect.stringContaining("parts in what a release ships")]);
    const document = JSON.parse(await readFile(out, "utf8")) as { bomFormat: string; metadata: { component: { version: string } } };
    expect([document.bomFormat, document.metadata.component.version]).toEqual(["CycloneDX", "1.4.0"]);
    const unknown = await run([process.execPath, "scripts/list-parts.ts", "--owt", out], REPOSITORY);
    expect([unknown.code, unknown.out]).toEqual([1, expect.stringContaining("error: --owt is not an option of this script")]);
  });
});

describe("the list of open-source parts", () => {
  const LOCK = `{
    "lockfileVersion": 1,
    "workspaces": { "": { "name": "x", "dependencies": { "shipped": "^1.0.0", "@scope/from-a-repository": "github:owner/repo#abc1234", "packed": "https://files.northstar.example/packed-2.0.0.tgz", "other-name": "npm:real-name@^3.0.0" }, "devDependencies": { "a-tool": "1.0.0" }, }, },
    "packages": {
      "shipped": ["shipped@1.2.3", "", { "dependencies": { "deep": "^2.0.0" } }, "sha512-${Buffer.from("a".repeat(64)).toString("base64")}"],
      "deep": ["deep@2.0.0", "", {}, "sha512-AAAA"],
      "shipped/deep": ["deep@2.5.0", "", {}, "sha512-AAAA"],
      "a-tool": ["a-tool@1.0.0", "", { "dependencies": { "deep": "^2.0.0" } }, "sha512-AAAA"],
      "@scope/from-a-repository": ["@scope/from-a-repository@github:Owner/Repo#abc1234", {}, "Owner-Repo-abc1234", "sha512-AAAA"],
      "packed": ["packed@https://files.northstar.example/packed-2.0.0.tgz", {}, "sha512-AAAA"],
      "other-name": ["other-name@npm:real-name@3.1.0", "", {}, "sha512-AAAA"],
    },
  }`;
  const installed = async (dir: string): Promise<Installed> =>
    dir.endsWith("shipped") ? { license: "MIT", version: "1.2.3" } : dir.endsWith("packed") ? { version: "2.0.0" } : {};

  test("a part is in what a release ships when a path of dependencies leads to it, and a tool is not", async () => {
    const parts = await partsOfBunLock(parseBunLock(LOCK), "program", installed);
    const said = Object.fromEntries(parts.map((part) => [`${part.name}@${part.version ?? ""}`, part.scope]));
    expect(said).toEqual({
      "shipped@1.2.3": "required",
      // The copy that `shipped` itself gets, not the one at the top.
      "deep@2.5.0": "required",
      "deep@2.0.0": "excluded",
      "a-tool@1.0.0": "excluded",
      "@scope/from-a-repository@abc1234": "required",
      "packed@2.0.0": "required",
      "real-name@3.1.0": "required",
    });
    expect(parts.find((part) => part.name === "shipped")).toMatchObject({
      purl: "pkg:npm/shipped@1.2.3",
      license: "MIT",
      sha512: Buffer.from("a".repeat(64)).toString("hex"),
    });
    // A license that cannot be read is left out, never guessed.
    expect(parts.find((part) => part.name === "a-tool")).not.toHaveProperty("license");
  });

  test("a part from a repository, from an address of its own, and under another name", async () => {
    const parts = await partsOfBunLock(parseBunLock(LOCK), "program", installed);
    expect(parts.find((part) => part.name === "@scope/from-a-repository")?.purl).toBe("pkg:github/owner/repo@abc1234");
    // The lockfile gives the address, and the installed part its version.
    const where = "download_url=https%3A%2F%2Ffiles.northstar.example%2Fpacked-2.0.0.tgz";
    expect(parts.find((part) => part.name === "packed")).toMatchObject({
      version: "2.0.0",
      purl: `pkg:npm/packed@2.0.0?${where}`,
      from: "https://files.northstar.example/packed-2.0.0.tgz",
    });
    // With nothing installed, the version is left out and not read off the address.
    const bare = await partsOfBunLock(parseBunLock(LOCK), "program", async () => ({}));
    const packed = bare.find((part) => part.name === "packed");
    expect(packed?.purl).toBe(`pkg:generic/packed?${where}`);
    expect(packed).not.toHaveProperty("version");
    // The part that is installed as `other-name` is `real-name`.
    expect(parts.find((part) => part.name === "real-name")?.purl).toBe("pkg:npm/real-name@3.1.0");
    expect(parts.some((part) => part.name === "other-name")).toBe(false);
  });

  test("a lockfile is read as Bun writes it, and a file that is not one is refused", () => {
    expect(Object.keys(parseBunLock(LOCK).packages)).toHaveLength(7);
    expect(() => parseBunLock('{ "workspaces": {} }')).toThrow("this is not a bun.lock");
    expect(() => parseBunLock("null")).toThrow("this is not a bun.lock");
  });

  test("a key of the lockfile is a path of package names, and a scoped name is one name", () => {
    expect(installFolder("jose")).toBe(path.join("node_modules", "jose"));
    expect(installFolder("@a/b")).toBe(path.join("node_modules", "@a/b"));
    expect(installFolder("@a/b/c")).toBe(path.join("node_modules", "@a/b", "node_modules", "c"));
    expect(installFolder("c/@a/b")).toBe(path.join("node_modules", "c", "node_modules", "@a/b"));
  });

  test("the data runner's modules are read from its go.mod, direct and indirect, with the Go that builds them", () => {
    const mod =
      "module x\n\ngo 1.27.4\n\nrequire example.org/one v1.0.0\n\nrequire (\n\texample.org/two/v2 v2.3.4\n\texample.org/three v0.1.0 // indirect\n)\n";
    const parts = partsOfGoMod(mod);
    expect(parts.map((part) => part.purl)).toEqual([
      "pkg:golang/stdlib@v1.27.4",
      "pkg:golang/example.org/one@v1.0.0",
      "pkg:golang/example.org/two/v2@v2.3.4",
      "pkg:golang/example.org/three@v0.1.0",
    ]);
    expect(parts.every((part) => part.scope === "required" && part.partOf === "data-runner")).toBe(true);
    expect(goVersionOf(mod)).toBe("1.27.4");
    // A toolchain line names the Go that builds, when there is one.
    expect(goVersionOf("module x\n\ngo 1.27\n\ntoolchain go1.27.6\n")).toBe("1.27.6");
    expect(goVersionOf("module x\n")).toBeNull();
    expect(partsOfGoMod("module x\n")).toEqual([]);
  });

  test("the console's fonts are files a release holds as they are, under the license the file beside them states", async () => {
    const root = await folder();
    const fonts = path.join(root, "pages", "fonts");
    await mkdir(fonts, { recursive: true });
    await writeFile(path.join(fonts, "a-font-400.woff2"), "the bytes of a font");
    await writeFile(path.join(fonts, "fonts.css"), "@font-face {}");
    await writeFile(path.join(fonts, "OFL.txt"), "Copyright\n\nSIL OPEN FONT LICENSE Version 1.1 - 26 February 2007\n");
    expect(await partsOfFonts(root, "pages/fonts")).toEqual([
      {
        name: "pages/fonts/a-font-400.woff2",
        purl: `pkg:generic/a-font-400.woff2?checksum=sha256:${sha256("the bytes of a font")}`,
        partOf: "console",
        scope: "required",
        kind: "file",
        license: "OFL-1.1",
        sha256: sha256("the bytes of a font"),
      },
    ]);
    // A license file this does not know by its first words gives no license.
    await writeFile(path.join(fonts, "OFL.txt"), "Some other terms.\n");
    expect((await partsOfFonts(root, "pages/fonts"))[0]).not.toHaveProperty("license");
    expect(licenseOfText("SIL Open Font License Version 1.1")).toBe("OFL-1.1");
    expect(licenseOfText("Version 1.1")).toBeUndefined();
  });

  test("the runtime inside the program is the Bun that runs the script", () => {
    expect(partOfRuntime("1.2.3")).toEqual({
      name: "bun",
      version: "1.2.3",
      purl: "pkg:github/oven-sh/bun@bun-v1.2.3",
      partOf: "program",
      scope: "required",
      kind: "platform",
    });
    expect(partOfRuntime().version).toBe(Bun.version);
  });

  test("what a database on HX Fortress's own disk runs is listed as fetched only for that", () => {
    const workflow = 'env:\n      PG_MAJOR: "18"\n      PGVECTOR_REF: "v0.8.4"\n';
    expect(pgvectorRefOf(workflow)).toBe("v0.8.4");
    expect(pgvectorRefOf('      PGVECTOR_REF: "main"\n')).toBeNull();
    const parts = partsOfDatabase(workflow);
    expect(parts.map((part) => [part.name, part.scope, part.partOf])).toEqual([
      ["postgresql", "optional", "database"],
      ["pgvector", "optional", "database"],
    ]);
    expect(parts[0]?.from).toMatch(/^https:\/\//);
    expect(parts[1]).toMatchObject({ version: "v0.8.4", purl: "pkg:github/pgvector/pgvector@v0.8.4" });
    // A workflow that pins no pgvector lists none: it is never guessed.
    expect(partsOfDatabase("env: {}\n").map((part) => part.name)).toEqual(["postgresql"]);
  });

  test("one part at one version is listed once, and the entry that a release ships wins", () => {
    const part = { name: "a", version: "1", purl: "pkg:npm/a@1", partOf: "program" as const };
    const scopes = (list: Part["scope"][]): Part[] => mergeParts(list.map((scope) => ({ ...part, scope })));
    expect(scopes(["excluded", "required", "excluded"])).toEqual([{ ...part, scope: "required" }]);
    expect(scopes(["excluded", "optional"])).toEqual([{ ...part, scope: "optional" }]);
    expect(scopes(["required", "optional"])).toEqual([{ ...part, scope: "required" }]);
    // The same package in the program and in the console is two parts.
    expect(mergeParts([{ ...part, scope: "required" }, { ...part, partOf: "console", scope: "excluded" }])).toHaveLength(2);
  });

  test("the document names each part's version, license, checksum and place, and has no time in it", () => {
    const document = cycloneDx(
      [
        { name: "a", version: "1", purl: "pkg:npm/a@1", partOf: "program", scope: "required", license: "MIT", sha512: "ab" },
        { name: "b", purl: "pkg:generic/b", partOf: "database", scope: "optional", kind: "application", license: "Terms of its own", from: "https://files.northstar.example/b" },
      ],
      "1.4.0",
    ) as { components: Record<string, unknown>[] };
    expect(document).toMatchObject({ bomFormat: "CycloneDX", specVersion: "1.6", version: 1 });
    expect(document.components).toEqual([
      {
        type: "library",
        "bom-ref": "program:pkg:npm/a@1",
        name: "a",
        version: "1",
        purl: "pkg:npm/a@1",
        scope: "required",
        licenses: [{ license: { id: "MIT" } }],
        hashes: [{ alg: "SHA-512", content: "ab" }],
        properties: [{ name: "hx-fortress:part-of", value: "program" }],
      },
      {
        type: "application",
        "bom-ref": "database:pkg:generic/b",
        name: "b",
        purl: "pkg:generic/b",
        scope: "optional",
        // Words that are not a license's short name are given as its name.
        licenses: [{ license: { name: "Terms of its own" } }],
        externalReferences: [{ type: "distribution", url: "https://files.northstar.example/b" }],
        properties: [{ name: "hx-fortress:part-of", value: "database" }],
      },
    ]);
    expect(JSON.stringify(document)).not.toMatch(/"timestamp"|"serialNumber"/);
  });

  test("this repository's own list holds what its package.json depends on, and is the same each time", async () => {
    const parts = await listParts(REPOSITORY);
    const shipped = (name: string, partOf: Part["partOf"]): boolean =>
      parts.some((part) => part.name === name && part.partOf === partOf && part.scope === "required");
    const dependenciesOf = async (file: string): Promise<string[]> =>
      Object.keys((JSON.parse(await readFile(path.join(REPOSITORY, file), "utf8")) as { dependencies: Record<string, string> }).dependencies);
    for (const name of await dependenciesOf("package.json")) expect([name, shipped(name, "program")]).toEqual([name, true]);
    for (const name of await dependenciesOf("ui/package.json")) expect([name, shipped(name, "console")]).toEqual([name, true]);
    // A tool of the build is listed, and marked as not in what a release ships.
    expect(parts.find((part) => part.name === "typescript" && part.partOf === "program")?.scope).toBe("excluded");
    // The runtime, the data runner's modules and its Go, the fonts, and the database a host may run.
    expect(shipped("bun", "program")).toBe(true);
    expect(shipped("stdlib", "data-runner")).toBe(true);
    expect(parts.filter((part) => part.partOf === "data-runner").length).toBeGreaterThan(1);
    const fonts = parts.filter((part) => part.kind === "file");
    expect(fonts.length).toBeGreaterThan(0);
    for (const font of fonts) expect([font.name, font.license, font.scope]).toEqual([font.name, "OFL-1.1", "required"]);
    expect(parts.filter((part) => part.partOf === "database").map((part) => [part.name, part.scope])).toEqual([
      ["postgresql", "optional"],
      ["pgvector", "optional"],
    ]);
    // Every part has an address a scanner can look it up by, and no two parts share one place and address.
    for (const part of parts) expect([part.name, part.purl.startsWith("pkg:")]).toEqual([part.name, true]);
    expect(new Set(parts.map((part) => `${part.partOf} ${part.purl}`)).size).toBe(parts.length);
    // The same lockfiles give the same bytes.
    const document = cycloneDx(parts, "1.4.0");
    expect(JSON.stringify(cycloneDx(await listParts(REPOSITORY), "1.4.0"))).toBe(JSON.stringify(document));
  });

  test("the sources import no package that package.json does not list as a dependency", async () => {
    // A part is `required` when a path leads to it from `dependencies`. That
    // is true of the program only while its sources import nothing else: a
    // tool of the build that a source imported would be compiled in, and
    // listed as not shipped.
    const imported = async (dir: string): Promise<Map<string, string>> => {
      const found = new Map<string, string>();
      for await (const file of new Glob("**/*.{ts,tsx}").scan({ cwd: path.join(REPOSITORY, dir) })) {
        if (/\.test\.tsx?$/.test(file) || file.endsWith(".d.ts")) continue;
        const text = await readFile(path.join(REPOSITORY, dir, file), "utf8");
        const transpiler = new Bun.Transpiler({ loader: file.endsWith(".tsx") ? "tsx" : "ts" });
        for (const { path: spec } of transpiler.scanImports(text)) {
          if (/^(\.|\/|node:|bun:)/.test(spec) || spec === "bun") continue;
          const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : (spec.split("/")[0] as string);
          if (!found.has(name)) found.set(name, `${dir}/${file}`);
        }
      }
      return found;
    };
    const listed = async (file: string): Promise<string[]> =>
      Object.keys((JSON.parse(await readFile(path.join(REPOSITORY, file), "utf8")) as { dependencies: Record<string, string> }).dependencies);
    for (const [dir, manifest] of [
      ["src", "package.json"],
      ["ui/src", "ui/package.json"],
    ] as const) {
      const dependencies = await listed(manifest);
      const found = await imported(dir);
      // The scan found the sources: it is not an empty folder that passes.
      expect([dir, found.size > 0]).toEqual([dir, true]);
      for (const [name, where] of found) expect([name, where, dependencies.includes(name)]).toEqual([name, where, true]);
    }
  });
});
