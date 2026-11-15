// The data runner's source, as it rests in this repository.
//
// The data runner is the program an HX Fortress starts beside itself to do one
// job on a database. Its source is the folder `data-runner/`. A script writes
// that folder from the program's home repository, and nothing here edits it:
// `data-runner/VENDORED.md` says so. This file holds the folder to that, on
// every machine, with no Go installed:
//
//   • every file in the folder is listed in `FILES.sha256` with its checksum,
//     no other file is there, and none is a link
//   • the Databases module reads the program's own examples of its output
//   • the module's scan of a statement refuses every statement that the
//     program's own examples refuse
//
// The program's build and its own tests run in CI (the job "Data runner").

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { readOutput } from "../src/modules/databases/data-runner";
import { ENGINES, FAILURE_CODES } from "../src/modules/databases/manifest";
import { statementRefusal } from "../src/modules/databases/read-only";

const ROOT = path.join(import.meta.dir, "..");
const FOLDER = path.join(ROOT, "data-runner");
const LIST = "FILES.sha256";

// Every path below is this repository's own folder, or a name read from it.
/* eslint-disable security/detect-non-literal-fs-filename */

async function listed(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const line of (await readFile(path.join(FOLDER, LIST), "utf8")).split("\n")) {
    if (line.trim() === "") continue;
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!match) throw new Error(`a line of ${LIST} is not a checksum and a path`);
    const name = match[2] as string;
    // A path of the list stays inside the folder.
    if (name.startsWith("/") || name.split("/").includes("..")) {
      throw new Error(`a line of ${LIST} names a path outside the folder`);
    }
    files.set(name, match[1] as string);
  }
  return files;
}

/**
 * The folder as the repository holds it: every path git tracks there, and every
 * path it would take with the next `git add`. What git ignores is not the
 * repository's: a local build of the program, or a file a desktop leaves.
 * A link is a path too, so one cannot stand in the folder unseen.
 *
 * A copy of the sources with no git in it (an archive) has nothing to ask, so
 * there every path on the disk counts.
 */
async function present(): Promise<string[]> {
  const names = existsSync(path.join(ROOT, ".git")) ? trackedOrNew() : await onDisk();
  return names.filter((name) => name !== LIST).sort();
}

function trackedOrNew(): string[] {
  const result = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "data-runner"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    const reason = (result.stderr || result.error?.message || "it gave no reason").trim();
    throw new Error(`This test lists the folder's files with git, and git failed: ${reason}`);
  }
  return [...new Set(result.stdout.split("\0").filter((name) => name.length > 0))].map((name) =>
    name.slice("data-runner/".length),
  );
}

/** Every path under the folder that is not a directory. A link is not followed. */
async function onDisk(): Promise<string[]> {
  const entries = await readdir(FOLDER, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.relative(FOLDER, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
}

const example = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(path.join(FOLDER, "contract", name), "utf8")) as unknown;

describe("the data runner's folder", () => {
  test("holds exactly the files its list names", async () => {
    const files = await listed();
    expect(files.size).toBeGreaterThan(50);
    // Neither listing has a promised order, so both sides are sorted.
    expect(await present()).toEqual([...files.keys()].sort());
  });

  test("every path in it is a plain file, never a link", async () => {
    // A link to a file elsewhere would be compiled into the program, and its
    // checksum would be the checksum of whatever it points at.
    const others: string[] = [];
    for (const name of [LIST, ...(await present())]) {
      if (!(await lstat(path.join(FOLDER, name))).isFile()) others.push(name);
    }
    expect(others).toEqual([]);
  });

  test("every file is the one the list names, byte for byte", async () => {
    const changed: string[] = [];
    for (const [name, checksum] of await listed()) {
      const bytes = await readFile(path.join(FOLDER, name));
      if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== checksum) changed.push(name);
    }
    // A file is changed at the program's home, and the folder is written again.
    expect(changed).toEqual([]);
  });

  test("is a Go module of its own, with the version of Go that CI builds it with", async () => {
    const mod = await readFile(path.join(FOLDER, "go.mod"), "utf8");
    expect(mod).toMatch(/^module hx-fortress\/data-runner$/m);
    // One line `go 1.27` or `go 1.27.3`: CI installs the version it names.
    const versions = mod.split("\n").filter((line) => line.startsWith("go "));
    expect(versions).toHaveLength(1);
    const parts = (versions[0] as string).slice("go ".length).split(".");
    expect([2, 3]).toContain(parts.length);
    expect(parts.every((part) => /^[0-9]+$/.test(part))).toBe(true);
  });
});

describe("the program's build", () => {
  test("CI checks the folder against its list, runs the program's own tests and builds it", async () => {
    const ci = await readFile(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    const job = ci.slice(ci.indexOf("\n  data-runner:\n"));
    expect(job).toContain("working-directory: data-runner");
    expect(job).toContain("go-version-file: data-runner/go.mod");
    expect(job).toContain("sha256sum --check --strict FILES.sha256");
    expect(job).toContain("go vet ./...");
    expect(job).toContain("go test ./...");
    for (const target of ["linux/amd64", "linux/arm64", "darwin/arm64", "darwin/amd64"]) {
      expect(job).toContain(target);
    }
    // The action is pinned to a commit, as every action in this repository is.
    expect(job).toMatch(/uses: actions\/setup-go@[0-9a-f]{40} # v/);
  });

  test("the static analysis reads the program's code, in a job of its own", async () => {
    const codeql = await readFile(path.join(ROOT, ".github", "workflows", "codeql.yml"), "utf8");
    // The job that reads this repository's TypeScript keeps its name: a setting
    // of the repository can require a check by that name.
    expect(codeql).toContain("name: Analyze (javascript-typescript)");
    const job = codeql.slice(codeql.indexOf("\n  analyze-go:\n"));
    expect(job).toContain("name: Analyze (go)");
    expect(job).toContain("languages: go");
    expect(job).toContain("go-version-file: data-runner/go.mod");
    expect(job).toMatch(/uses: actions\/setup-go@[0-9a-f]{40} # v/);
  });
});

describe("the program's own examples, read by the Databases module", () => {
  const id = (value: unknown): string => (value as { id: string }).id;

  test("a test's output", async () => {
    for (const name of ["output-test-ok.json", "output-test-can-write.json", "output-oracle-native.json"]) {
      const output = await example(name);
      const read = readOutput(output, { id: id(output), kind: "test" });
      expect([name, read.ok && read.findings.kind]).toEqual([name, "test"]);
    }
    const output = await example("output-test-can-write.json");
    expect(readOutput(output, { id: id(output), kind: "test" })).toMatchObject({
      ok: true,
      findings: { canWrite: true },
    });
  });

  test("a query's output", async () => {
    const output = await example("output-query-ok.json");
    const read = readOutput(output, { id: id(output), kind: "query", rowCap: 200 });
    expect(read).toMatchObject({ ok: true, findings: { kind: "query", more: false } });
  });

  test("a pull's and a compare's output", async () => {
    const pull = await example("output-pull-ok.json");
    expect(readOutput(pull, { id: id(pull), kind: "pull" })).toMatchObject({ ok: true, findings: { kind: "pull" } });
    const compare = await example("output-compare-ok.json");
    expect(readOutput(compare, { id: id(compare), kind: "compare" })).toMatchObject({
      ok: true,
      findings: { kind: "compare" },
    });
  });

  test("a failed job's output is read as one word, with its sentence kept apart", async () => {
    const output = (await example("output-failed.json")) as { error: { code: string; message: string } };
    expect(output.error.message.length).toBeGreaterThan(10);
    // A word this build keeps is read as it stands. Any other word, such as one
    // that only a control plane's own runner answers, is the program's own
    // fault as far as a reader of this HX Fortress can tell.
    const word = (FAILURE_CODES as readonly string[]).includes(output.error.code) ? output.error.code : "internal";
    // The whole value: an output the module could not read would be
    // `output_invalid` with no sentence, and must not pass here.
    expect(readOutput(output, { id: id(output), kind: "test" }) as unknown).toEqual({
      ok: false,
      code: word,
      message: output.error.message,
    });
  });

  test("an output that is not the program's is not read at all", async () => {
    const output = (await example("output-failed.json")) as Record<string, unknown>;
    const unreadable = { ok: false, code: "output_invalid", message: "" };
    // The answer of another job, and a failure with no error in it.
    expect(readOutput(output, { id: "dj_000000000000000000000000", kind: "test" }) as unknown).toEqual(unreadable);
    expect(readOutput({ ...output, error: "failed" }, { id: id(output), kind: "test" }) as unknown).toEqual(unreadable);
  });
});

describe("the scan of a statement", () => {
  test("refuses every statement that the program's own examples refuse", async () => {
    const vectors = (await example("vectors/query-refusal.json")) as {
      cases: { sql: string; refused: boolean }[];
    };
    const refused = vectors.cases.filter((one) => one.refused);
    expect(refused.length).toBeGreaterThan(10);
    for (const one of refused) {
      for (const engine of ENGINES) {
        expect([one.sql, engine, statementRefusal(one.sql, engine) !== null]).toEqual([one.sql, engine, true]);
      }
    }
  });
});
