// The data runner's source, as it rests in this repository.
//
// The data runner is the program an HX Fortress starts beside itself to do one
// job on a database. Its source is the folder `data-runner/`. A script writes
// that folder from the program's home repository, and nothing here edits it:
// `data-runner/VENDORED.md` says so. This file holds the folder to that, on
// every machine, with no Go installed:
//
//   • every file in the folder is listed in `FILES.sha256` with its checksum,
//     and no other file is there
//   • the Databases module reads the program's own examples of its output
//   • the module's scan of a statement refuses every statement that the
//     program's own examples refuse
//
// The program's build and its own tests run in CI (the job "Data runner").

import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { readOutput } from "../src/modules/databases/data-runner";
import { ENGINES } from "../src/modules/databases/manifest";
import { statementRefusal } from "../src/modules/databases/read-only";

const FOLDER = path.join(import.meta.dir, "..", "data-runner");
const LIST = "FILES.sha256";

// Every path below is this repository's own folder, or a name read from it.
/* eslint-disable security/detect-non-literal-fs-filename */

async function listed(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const line of (await readFile(path.join(FOLDER, LIST), "utf8")).split("\n")) {
    if (line.trim() === "") continue;
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!match) throw new Error(`a line of ${LIST} is not a checksum and a path`);
    files.set(match[2] as string, match[1] as string);
  }
  return files;
}

async function present(): Promise<string[]> {
  const entries = await readdir(FOLDER, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(FOLDER, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .filter((name) => name !== LIST)
    .sort();
}

const example = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(path.join(FOLDER, "contract", name), "utf8")) as unknown;

describe("the data runner's folder", () => {
  test("holds exactly the files its list names", async () => {
    const files = await listed();
    expect(files.size).toBeGreaterThan(50);
    // A directory's listing has no promised order, so both sides are sorted.
    expect(await present()).toEqual([...files.keys()].sort());
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
    expect(mod).toMatch(/^go [0-9]+\.[0-9]+(\.[0-9]+)?$/m);
  });
});

describe("the program's build", () => {
  test("CI checks the folder against its list, runs the program's own tests and builds it", async () => {
    const ci = await readFile(path.join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8");
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
});

describe("the program's own examples, read by the Databases module", () => {
  const id = (value: unknown): string => (value as { id: string }).id;

  test("a test's output", async () => {
    for (const name of ["output-test-ok.json", "output-test-can-write.json"]) {
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

  test("a failed job's output is one word, and its sentence is kept apart", async () => {
    const output = await example("output-failed.json");
    const read = readOutput(output, { id: id(output), kind: "test" });
    expect(read.ok).toBe(false);
    expect(typeof (read as { code: string }).code).toBe("string");
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
