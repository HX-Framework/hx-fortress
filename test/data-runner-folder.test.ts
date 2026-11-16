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
//   • the module's scan of a statement and the program's own rule give the
//     same answer for every example the program publishes, engine by engine
//
// The program's build and its own tests run in CI (the job "Data runner").

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { readOutput } from "../src/modules/databases/data-runner";
import { ENGINES, FAILURE_CODES } from "../src/modules/databases/manifest";
import { ENGINE_WORDS, statementRefusal, WRITE_WORDS } from "../src/modules/databases/read-only";

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

/** One job of a workflow: from its name to the next job, or to the end. The
 *  text of a later job cannot stand in for something this job lost. */
function jobOf(workflow: string, name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`the workflow has no job ${name}`);
  const lines = workflow.slice(start + 1).split("\n");
  // A job's name is a key two spaces in. Its own line is the first.
  const next = lines.findIndex(
    (line, at) => at > 0 && line.startsWith("  ") && line[2] !== " " && line[2] !== "#" && line.endsWith(":"),
  );
  return (next < 0 ? lines : lines.slice(0, next)).join("\n");
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
    const job = jobOf(ci, "data-runner");
    expect(job).toContain("working-directory: data-runner");
    expect(job).toContain("go-version-file: data-runner/go.mod");
    expect(job).toContain("sha256sum --check --strict FILES.sha256");
    expect(job).toContain("go vet ./...");
    expect(job).toContain("go test ./...");
    // The build is the script a release runs: test/data-runner-build.test.ts.
    expect(job).toContain("scripts/build-data-runner.sh");
    // The action is pinned to a commit, as every action in this repository is.
    expect(job).toMatch(/uses: actions\/setup-go@[0-9a-f]{40} # v/);
  });

  test("the static analysis reads the program's code, in a job of its own", async () => {
    const codeql = await readFile(path.join(ROOT, ".github", "workflows", "codeql.yml"), "utf8");
    // The job that reads this repository's TypeScript keeps its name: a setting
    // of the repository can require a check by that name.
    expect(codeql).toContain("name: Analyze (javascript-typescript)");
    const job = jobOf(codeql, "analyze-go");
    expect(job).toContain("name: Analyze (go)");
    expect(job).toContain("languages: go");
    expect(job).toContain("go-version-file: data-runner/go.mod");
    expect(job).toMatch(/uses: actions\/setup-go@[0-9a-f]{40} # v/);
    expect(job).toContain("config-file: ./.github/codeql/go.yml");
  });

  test("what the analysis leaves out stands in one file of the program, and nowhere else", async () => {
    // .github/codeql/go.yml leaves two queries out, each for one thing the
    // program does on purpose in internal/secure/tls.go. This test is what
    // keeps each entry that narrow: the same construct in another file is no
    // longer covered by a reason, so it fails here before it is analysed
    // without the query.
    const config = await readFile(path.join(ROOT, ".github", "codeql", "go.yml"), "utf8");
    const leftOut = config
      .split("\n")
      .map((line) => /^\s+id: (\S+)$/.exec(line)?.[1])
      .filter((id): id is string => id !== undefined);
    expect(leftOut).toEqual(["go/disabled-certificate-check", "go/insecure-tls"]);

    const constructs: Record<string, string[]> = {
      // The library's own certificate check, turned off.
      InsecureSkipVerify: [],
      // The older cipher suites, and the versions below TLS 1.2.
      InsecureCipherSuites: [],
      VersionTLS10: [],
      VersionTLS11: [],
      VersionSSL30: [],
    };
    for (const name of await present()) {
      if (!name.endsWith(".go") || name.endsWith("_test.go")) continue;
      const source = await readFile(path.join(FOLDER, name), "utf8");
      for (const [word, files] of Object.entries(constructs)) {
        if (source.includes(word)) files.push(name);
      }
    }
    const only = ["internal/secure/tls.go"];
    expect(constructs).toEqual({
      InsecureSkipVerify: only,
      InsecureCipherSuites: only,
      VersionTLS10: only,
      VersionTLS11: only,
      VersionSSL30: [],
    });
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

// A statement is checked twice before it runs: by the Databases module, in
// front of the program, and by the program itself. The program publishes its
// rule as examples (contract/vectors/query-refusal.json). These tests hold the
// module's scan to every one of them, so the two checks cannot drift apart
// without a failure here.
describe("the scan of a statement, against the program's own examples", () => {
  interface Case {
    sql: string;
    refused: boolean;
    /** Why it is refused, in the module's own words for a refusal. */
    why?: string;
  }
  interface Vectors {
    writeWords: string[];
    engineWords: Record<string, string[]>;
    /** Statements that are judged alike on every engine. */
    cases: Case[];
    /** Statements that are judged this way on the engines each one names. */
    engineCases: (Case & { engines: string[] })[];
    /** What the program says for one case of each kind. */
    sentences: { engine: string; sql: string; says: string }[];
  }
  const vectors = async (): Promise<Vectors> => (await example("vectors/query-refusal.json")) as Vectors;
  /** The lists of the file that these tests read. */
  const KNOWN = ["about", "cases", "engineCases", "engineWords", "sentences", "writeWords"];
  const isEngine = (name: string): name is (typeof ENGINES)[number] => (ENGINES as readonly string[]).includes(name);

  /** What the example says the answer is: the word of its refusal, or null. */
  const expected = (one: Case): string | null => {
    if (!one.refused) return null;
    // A refused example always says why, in a word.
    if (typeof one.why !== "string" || one.why === "") {
      throw new Error(`a refused example names no reason: ${one.sql}`);
    }
    return one.why;
  };

  test("the file holds the lists these tests read, and no list that no test reads", async () => {
    // The folder is replaced whole. A new list of examples would otherwise be
    // held by nothing here.
    expect(Object.keys(await vectors()).sort()).toEqual(KNOWN);
  });

  test("an example that holds on every engine is judged that way on all four, for the same reason", async () => {
    const { cases } = await vectors();
    // As many as the file holds today: an export that loses examples fails here.
    expect(cases.filter((one) => one.refused).length).toBeGreaterThanOrEqual(72);
    expect(cases.filter((one) => !one.refused).length).toBeGreaterThanOrEqual(24);
    for (const one of cases) {
      for (const engine of ENGINES) {
        expect([one.sql, engine, statementRefusal(one.sql, engine)]).toEqual([one.sql, engine, expected(one)]);
      }
    }
  });

  test("an example for some engines is judged that way on each engine it names", async () => {
    const { engineCases } = await vectors();
    expect(engineCases.length).toBeGreaterThanOrEqual(107);
    const seen = new Set<string>();
    for (const one of engineCases) {
      expect(one.engines.length).toBeGreaterThan(0);
      for (const engine of one.engines) {
        // An engine this build does not know would be an example nobody checks.
        if (!isEngine(engine)) throw new Error(`an example names an engine this build does not have: ${engine}`);
        seen.add(engine);
        expect([one.sql, engine, statementRefusal(one.sql, engine)]).toEqual([one.sql, engine, expected(one)]);
      }
    }
    // Each of the four engines has examples of its own.
    expect([...seen].sort()).toEqual([...ENGINES].sort());
  });

  test("the words that write, and the words each engine reserves, are the same list on both sides", async () => {
    const { writeWords, engineWords } = await vectors();
    expect([...writeWords].sort()).toEqual([...WRITE_WORDS].sort());
    expect(Object.keys(engineWords).sort()).toEqual([...ENGINES].sort());
    for (const engine of ENGINES) {
      // The key is one of this build's four engines.
      // eslint-disable-next-line security/detect-object-injection
      expect([engine, [...(engineWords[engine] ?? [])].sort()]).toEqual([engine, [...ENGINE_WORDS[engine]].sort()]);
    }
  });

  test("every statement the program has a sentence for is one the module refuses first", async () => {
    const { sentences } = await vectors();
    expect(sentences.length).toBeGreaterThanOrEqual(21);
    for (const one of sentences) {
      if (!isEngine(one.engine)) throw new Error(`a sentence names an engine this build does not have: ${one.engine}`);
      expect([one.sql, one.engine, statementRefusal(one.sql, one.engine) !== null]).toEqual([one.sql, one.engine, true]);
    }
  });
});
