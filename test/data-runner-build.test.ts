// How the data runner is built, released and put into the image.
//
// The data runner is the program an HX Fortress starts beside itself to do one
// job on a database (`data-runner/`, a Go module). One script builds it:
// `scripts/build-data-runner.sh`. The release, the dev build, CI and the image
// all call that script.
//
// This file runs the script against a stand-in for the Go command, so it needs
// no Go: it checks what the script asks Go to do, in which folder, and what it
// refuses before it asks. The real build runs in CI: the job "Data runner
// (build and test)" builds the four files twice and compares them, and the job
// "Image (build, and the data runner inside it)" builds the image and runs the
// program in it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

// Every path below is a file of this repository, or one under a folder this
// test made for itself.
/* eslint-disable security/detect-non-literal-fs-filename */

const ROOT = path.join(import.meta.dir, "..");
const read = (file: string): string => readFileSync(path.join(ROOT, file), "utf8");

/** The version of Go that the program's module names. */
function goVersionOf(mod: string): string {
  const line = mod.split("\n").find((one) => one.startsWith("go "));
  if (line === undefined) throw new Error("data-runner/go.mod has no go line");
  return line.slice("go ".length).trim();
}

// ── The script, run against a stand-in for Go ────────────────────────────────

/** One call of the stand-in: where it was called, what the script set, and
 *  what it asked for. */
interface GoCall {
  /** The folder Go was started in: what it would build. */
  cwd: string;
  /** Every file under that folder, sorted. */
  files: string[];
  env: Record<string, string>;
  args: string[];
}

/**
 * A copy of the script and of the program's folder, with a stand-in `go` first
 * on the PATH. The stand-in writes down its settings and its arguments, and
 * creates the file `-o` names. It builds nothing.
 */
interface RunOptions {
  /** The folder the files are written to, as the caller names it. With none,
   *  a folder of the rig, by its whole path. */
  out?: string;
  /** The folder the script is called from. */
  cwd?: string;
  /** More of the caller's environment. */
  env?: Record<string, string>;
}

function makeRig(): {
  dir: string;
  run: (
    args: string[],
    options?: RunOptions,
  ) => { status: number | null; stderr: string; calls: GoCall[]; built: string[] };
} {
  // The folder by its real path: on macOS the temporary folder is a link, and
  // the stand-in says where it is by the real one.
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "data-runner-build-")));
  mkdirSync(path.join(dir, "scripts"));
  cpSync(path.join(ROOT, "scripts", "build-data-runner.sh"), path.join(dir, "scripts", "build-data-runner.sh"));
  cpSync(path.join(ROOT, "data-runner"), path.join(dir, "data-runner"), { recursive: true });
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const log = path.join(dir, "go-calls.log");
  writeFileSync(
    path.join(bin, "go"),
    [
      "#!/bin/sh",
      "{",
      '  printf "call\\n"',
      '  printf "cwd %s\\n" "$(pwd -P)"',
      '  find . -type f -o -type l | LC_ALL=C sort | while IFS= read -r one; do printf "file %s\\n" "${one#./}"; done',
      "  for name in GOOS GOARCH GOAMD64 GOARM64 CGO_ENABLED GOTOOLCHAIN GOFLAGS GOWORK GOENV GOEXPERIMENT GOFIPS140 LC_ALL CDPATH; do",
      '    eval "value=\\${$name-}"',
      '    printf "env %s=%s\\n" "$name" "$value"',
      "  done",
      '  for arg in "$@"; do printf "arg %s\\n" "$arg"; done',
      `} >> "${log}"`,
      'out=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "-o" ]; then out="$2"; fi',
      "  shift",
      "done",
      'if [ -n "$out" ]; then : > "$out"; fi',
      "",
    ].join("\n"),
  );
  chmodSync(path.join(bin, "go"), 0o755);

  const run = (args: string[], options: RunOptions = {}) => {
    rmSync(log, { force: true });
    const cwd = options.cwd ?? dir;
    const named = options.out ?? path.join(dir, "out");
    const out = path.resolve(cwd, named);
    rmSync(out, { recursive: true, force: true });
    const result = spawnSync("bash", [path.join(dir, "scripts", "build-data-runner.sh"), named, ...args], {
      cwd,
      encoding: "utf8",
      // The stand-in first, then the system's own tools. The caller has Go
      // settings of its own, and each is one the script must not build with.
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: dir,
        GOFLAGS: "-mod=mod",
        GOTOOLCHAIN: "local",
        GOWORK: path.join(dir, "go.work"),
        GOENV: path.join(dir, "go-env"),
        GOEXPERIMENT: "boringcrypto",
        GOFIPS140: "latest",
        GOARM64: "v9.0",
        GOAMD64: "v3",
        CGO_ENABLED: "1",
        LC_ALL: "en_US.UTF-8",
        ...options.env,
      },
    });
    const calls: GoCall[] = [];
    if (existsSync(log)) {
      for (const line of readFileSync(log, "utf8").split("\n")) {
        if (line === "call") calls.push({ cwd: "", files: [], env: {}, args: [] });
        const call = calls[calls.length - 1];
        if (call === undefined) continue;
        if (line.startsWith("cwd ")) call.cwd = line.slice("cwd ".length);
        if (line.startsWith("file ")) call.files.push(line.slice("file ".length));
        if (line.startsWith("env ")) {
          const [name, ...value] = line.slice("env ".length).split("=");
          call.env[name as string] = value.join("=");
        }
        if (line.startsWith("arg ")) call.args.push(line.slice("arg ".length));
      }
    }
    const built = existsSync(out) ? readdirSync(out).sort() : [];
    return { status: result.status, stderr: result.stderr, calls, built };
  };
  return { dir, run };
}

describe("the script that builds the data runner", () => {
  let rig: ReturnType<typeof makeRig>;
  beforeAll(() => {
    rig = makeRig();
  });
  afterAll(() => {
    rmSync(rig.dir, { recursive: true, force: true });
  });

  test("with no target it builds the four platforms HX Fortress is released for, named as its own binaries are", () => {
    const { status, calls, built } = rig.run(["1.2.3+abcdef12"]);
    expect(status).toBe(0);
    expect(built).toEqual([
      "hx-fortress-data-runner-darwin-arm64",
      "hx-fortress-data-runner-darwin-x64",
      "hx-fortress-data-runner-linux-arm64",
      "hx-fortress-data-runner-linux-x64",
    ]);
    expect(calls.map((call) => `${call.env.GOOS}/${call.env.GOARCH}`)).toEqual([
      "darwin/arm64",
      "darwin/amd64",
      "linux/arm64",
      "linux/amd64",
    ]);
  });

  test("every build is static, for every x86-64 processor, the same from the same sources, and stamped with the version", () => {
    const { calls } = rig.run(["1.2.3+abcdef12", "linux/amd64"]);
    expect(calls).toHaveLength(1);
    const call = calls[0] as GoCall;
    expect(call.env).toMatchObject({ GOOS: "linux", GOARCH: "amd64", GOAMD64: "v1", CGO_ENABLED: "0" });
    expect(call.args.slice(0, 3)).toEqual(["build", "-trimpath", "-buildvcs=false"]);
    const flags = call.args[call.args.indexOf("-ldflags") + 1];
    expect(flags).toBe("-s -w -X main.version=1.2.3+abcdef12");
    // The package built is the folder itself, and it is the last argument.
    expect(call.args[call.args.length - 1]).toBe(".");
    expect(call.args[call.args.indexOf("-o") + 1]).toEndWith("/out/hx-fortress-data-runner-linux-x64");
  });

  test("it builds with the Go the program's module names, whatever the caller's settings say", () => {
    const { calls } = rig.run(["dev", "linux/arm64"]);
    const call = calls[0] as GoCall;
    // The rig hands the script a caller's own value for each of these.
    expect(call.env).toEqual({
      GOOS: "linux",
      GOARCH: "arm64",
      GOAMD64: "v1",
      GOARM64: "v8.0",
      CGO_ENABLED: "0",
      GOTOOLCHAIN: `go${goVersionOf(read("data-runner/go.mod"))}`,
      GOFLAGS: "-mod=readonly",
      GOWORK: "off",
      // The file that `go env -w` writes is not read, no experiment is on, and
      // the program's cryptography is Go's own.
      GOENV: "off",
      GOEXPERIMENT: "",
      GOFIPS140: "off",
      LC_ALL: "C",
      CDPATH: "",
    });
  });

  test("a folder named from where the caller stands is that folder, whatever the caller's CDPATH says", () => {
    // A release names `dist`, from the root of the repository.
    const caller = path.join(rig.dir, "caller");
    const elsewhere = path.join(rig.dir, "elsewhere");
    mkdirSync(caller);
    // With CDPATH, `cd dist` would go to this folder and print its path.
    mkdirSync(path.join(elsewhere, "dist"), { recursive: true });
    try {
      const { status, built, calls } = rig.run(["dev", "linux/arm64"], {
        out: "dist",
        cwd: caller,
        env: { CDPATH: elsewhere },
      });
      expect(status).toBe(0);
      expect(built).toEqual(["hx-fortress-data-runner-linux-arm64"]);
      const call = calls[0] as GoCall;
      expect(call.args[call.args.indexOf("-o") + 1]).toBe(
        path.join(caller, "dist", "hx-fortress-data-runner-linux-arm64"),
      );
      expect(readdirSync(path.join(elsewhere, "dist"))).toEqual([]);
    } finally {
      rmSync(caller, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("a module that names a language version only is built by the installed Go", () => {
    const mod = path.join(rig.dir, "data-runner", "go.mod");
    const list = path.join(rig.dir, "data-runner", "FILES.sha256");
    const [before, listBefore] = [readFileSync(mod, "utf8"), readFileSync(list, "utf8")];
    try {
      const changed = before.replace(/^go .*$/m, "go 1.27");
      writeFileSync(mod, changed);
      // The list is the folder's own: the copy's list is written to match.
      const sum = new Bun.CryptoHasher("sha256").update(changed).digest("hex");
      writeFileSync(list, listBefore.replace(/^[0-9a-f]{64}( [ *]go\.mod)$/m, `${sum}$1`));
      const { status, calls } = rig.run(["dev", "linux/arm64"]);
      expect(status).toBe(0);
      // The caller's own setting stands: the script named no toolchain.
      expect((calls[0] as GoCall).env.GOTOOLCHAIN).toBe("local");
    } finally {
      writeFileSync(mod, before);
      writeFileSync(list, listBefore);
    }
  });

  test("it builds a clean copy of the files the folder's list names, and nothing else that is in the folder", () => {
    const folder = path.join(rig.dir, "data-runner");
    const added = [
      // A Go file nobody listed: Go would compile it into the program.
      path.join(folder, "extra.go"),
      path.join(folder, "internal", "run", "extra_linux.go"),
      // The result of an earlier build, where the folder's own README puts it.
      path.join(folder, "data-runner"),
    ];
    const link = path.join(folder, "internal", "job", "linked.go");
    try {
      for (const file of added) writeFileSync(file, "package main\n");
      symlinkSync(path.join(folder, "main.go"), link);
      const { status, calls } = rig.run(["dev", "linux/arm64"]);
      expect(status).toBe(0);
      const call = calls[0] as GoCall;
      // Go was started somewhere else than the folder, and not under it. Both
      // are real paths, so a link on the way cannot hide that they are one.
      expect(call.cwd).not.toBe(realpathSync(folder));
      expect(call.cwd.startsWith(`${rig.dir}${path.sep}`)).toBe(false);
      // What it would build is the list's files, and the list.
      const listed = readFileSync(path.join(folder, "FILES.sha256"), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.slice(66));
      expect(listed.length).toBeGreaterThan(50);
      expect(call.files).toEqual([...listed, "FILES.sha256"].sort());
      // The copy is gone when the script ends.
      expect(existsSync(call.cwd)).toBe(false);
    } finally {
      for (const file of [...added, link]) rmSync(file, { force: true });
    }
  });

  test.each([
    ["a path above the folder", "../outside.go"],
    ["a path from the root of the disk", "/etc/hosts"],
    ["a path that steps out and back in", "internal/../../outside.go"],
  ])("it refuses a list that names %s", (_what, name) => {
    const list = path.join(rig.dir, "data-runner", "FILES.sha256");
    const before = readFileSync(list, "utf8");
    try {
      writeFileSync(list, `${before}${"0".repeat(64)}  ${name}\n`);
      const { status, calls, stderr } = rig.run(["dev"]);
      expect(status).toBe(1);
      expect(calls).toEqual([]);
      expect(stderr).toContain("names a path outside the folder");
    } finally {
      writeFileSync(list, before);
    }
  });

  test.each(["-n", "--help", "-R"])("a list that names the path %s names a file, and never an option of a tool", (name) => {
    const list = path.join(rig.dir, "data-runner", "FILES.sha256");
    const before = readFileSync(list, "utf8");
    try {
      // No such file is in the folder, so the copy fails and nothing is built.
      writeFileSync(list, `${before}${"0".repeat(64)}  ${name}\n`);
      const { status, calls, built, stderr } = rig.run(["dev"]);
      expect(status).toBe(1);
      expect(calls).toEqual([]);
      expect(built).toEqual([]);
      // The tool was told about a file: it did not print how it is used.
      expect(stderr.toLowerCase()).not.toContain("usage");
      expect(stderr).toContain(`./${name}`);
    } finally {
      writeFileSync(list, before);
    }
  });

  test("it refuses a list with a line that is not a checksum and a path", () => {
    const list = path.join(rig.dir, "data-runner", "FILES.sha256");
    const before = readFileSync(list, "utf8");
    try {
      writeFileSync(list, `${before}main.go\n`);
      const { status, calls, stderr } = rig.run(["dev"]);
      expect(status).toBe(1);
      expect(calls).toEqual([]);
      expect(stderr).toContain("is not a checksum and a path");
    } finally {
      writeFileSync(list, before);
    }
  });

  test("with no version the program says it is a development build", () => {
    const { status, calls } = rig.run([]);
    expect(status).toBe(0);
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.args[call.args.indexOf("-ldflags") + 1]).toBe("-s -w -X main.version=dev");
    }
  });

  test.each([
    ["a space, which would start a second linker flag", "1.2.3 -X main.other=x"],
    ["a quote", '1.2.3"'],
    ["a slash", "1.2.3/x"],
    // The same answer in every shell: under a caller's own locale, an older
    // bash took this letter for one of A to Z.
    ["a letter outside a to z", "1.2.3-é"],
    ["nothing", ""],
  ])("it refuses a version that holds %s, before it asks Go for anything", (_what, version) => {
    const { status, calls, built, stderr } = rig.run([version]);
    expect(status).toBe(2);
    expect(calls).toEqual([]);
    expect(built).toEqual([]);
    expect(stderr).toContain("a version holds letters, digits");
  });

  test.each(["windows/amd64", "linux/386", "linux", "linux/amd64/v3"])(
    "it refuses the platform %s, which HX Fortress is not released for",
    (target) => {
      const { status, calls, built } = rig.run(["dev", "linux/amd64", target]);
      expect(status).toBe(2);
      // Not even the platform named before it is built.
      expect(calls).toEqual([]);
      expect(built).toEqual([]);
    },
  );

  test("it builds nothing when a file of the folder differs from the folder's list", () => {
    const file = path.join(rig.dir, "data-runner", "main.go");
    const before = readFileSync(file);
    try {
      appendFileSync(file, "\n");
      const { status, calls, built } = rig.run(["dev"]);
      expect(status).not.toBe(0);
      expect(calls).toEqual([]);
      expect(built).toEqual([]);
    } finally {
      writeFileSync(file, before);
    }
  });

  test("it builds nothing when a file the list names is gone", () => {
    const file = path.join(rig.dir, "data-runner", "go.sum");
    const before = readFileSync(file);
    try {
      rmSync(file);
      const { status, calls } = rig.run(["dev"]);
      expect(status).not.toBe(0);
      expect(calls).toEqual([]);
    } finally {
      writeFileSync(file, before);
    }
  });
});

// ── Where the script is called ───────────────────────────────────────────────

/** A workflow's text from one of its lines to the end of that job or step list. */
function from(text: string, start: string): string {
  const at = text.indexOf(start);
  if (at < 0) throw new Error(`the workflow has no line "${start.trim()}"`);
  return text.slice(at);
}

/** One job of a workflow: from its name to the next job, or to the end. */
function jobOf(workflow: string, name: string): string {
  const lines = from(workflow, `\n  ${name}:\n`).slice(1).split("\n");
  // A job's name is a key two spaces in. Its own line is the first.
  const next = lines.findIndex(
    (line, at) => at > 0 && line.startsWith("  ") && line[2] !== " " && line[2] !== "#" && line.endsWith(":"),
  );
  return (next < 0 ? lines : lines.slice(0, next)).join("\n");
}

/** What a step hands its action: the lines under `with:`, without comments. */
function inputsOf(stepText: string): string[] {
  const lines = stepText.split("\n");
  const at = lines.findIndex((line) => line.trim() === "with:");
  if (at < 0) return [];
  return lines
    .slice(at + 1)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** One step of a workflow: from its `- name:` line to the next step. */
function step(text: string, name: string): string {
  const rest = from(text, `      - name: ${name}\n`);
  const next = rest.indexOf("\n      - ", 1);
  return next < 0 ? rest : rest.slice(0, next);
}

const ASSET = "hx-fortress-data-runner-";

describe("a release holds the data runner", () => {
  const release = read(".github/workflows/release.yml");
  const build = step(release, "Build the data runner");

  test("the release builds it with the script, at the release's version and commit", () => {
    expect(build).toContain("bash scripts/build-data-runner.sh dist \\\n");
    expect(build).toContain('"${{ steps.version.outputs.value }}+${{ steps.short-sha.outputs.value }}"');
    // The script names no target there, so it builds all four.
    expect(build).not.toMatch(/linux\/|darwin\//);
  });

  test("each file gets a checksum and a signature of the file a host runs, and is then compressed", () => {
    expect(build).toContain(`for out_path in dist/${ASSET}*; do`);
    expect(build).toContain('> "${out_path}.sha256"');
    expect(build).toContain('bun run scripts/sign-artifact.ts "$out_path"');
    expect(build).toContain('gzip -9 -f "$out_path"');
    // The order matters as it does for HX Fortress's own binaries: the checksum
    // and the signature are of the file before it is compressed.
    const [sum, sign, gzip] = ["sha256sum", "sign-artifact.ts", "gzip -9 -f"].map((word) => build.indexOf(word));
    expect(sum).toBeGreaterThan(-1);
    expect(sum).toBeLessThan(gzip as number);
    expect(sign).toBeLessThan(gzip as number);
    // Unsigned only while the release has no key, and then it says so.
    expect(build).toContain("FORTRESS_SIGNING_KEY: ${{ secrets.FORTRESS_SIGNING_KEY }}");
    expect(build).toContain("published UNSIGNED");
  });

  test("the files are built before the attestation and both uploads, which take them by name", () => {
    const built = release.indexOf("      - name: Build the data runner\n");
    expect(built).toBeGreaterThan(release.indexOf("      - name: Compile darwin/linux binaries\n"));
    expect(built).toBeLessThan(release.indexOf("      - name: Attest build provenance\n"));
    expect(built).toBeLessThan(release.indexOf("      - name: Publish rolling release\n"));
    // The names start as HX Fortress's own files do, so these take them.
    expect(ASSET.startsWith("hx-fortress-")).toBe(true);
    // The attestation's subjects are a list: these files, and the install script.
    expect(release).toMatch(/subject-path: \|\n\s+dist\/hx-fortress-\*\.gz\n/);
    expect(release.split('gh release create "$tag" dist/hx-fortress-*').length - 1).toBe(2);
  });

  test("a published build takes no cache, and Go is the version the program's module names", () => {
    for (const file of [".github/workflows/release.yml", ".github/workflows/dev-build.yml"]) {
      const workflow = read(file);
      const setup = from(workflow, "      - uses: actions/setup-go@").split("\n      - ")[0] as string;
      expect([file, setup.includes("go-version-file: data-runner/go.mod")]).toEqual([file, true]);
      expect([file, setup.includes("cache: false")]).toEqual([file, true]);
      expect(setup).toMatch(/^ {6}- uses: actions\/setup-go@[0-9a-f]{40} # v/);
    }
  });

  test("a change to the program's source starts a release, as a change to HX Fortress's own source does", () => {
    const paths = from(release, "    paths:\n").split("\n  workflow_dispatch:")[0] as string;
    expect(paths).toContain('      - "data-runner/**"\n');
    expect(paths).toContain('      - "scripts/**"\n');
  });

  test("the image is told the same version as the release's files", () => {
    const image = step(release, "Build and push Docker image");
    expect(image).toContain(
      "HX_FORTRESS_VERSION=${{ steps.version.outputs.value }}+${{ steps.short-sha.outputs.value }}",
    );
  });

  test("a dev build holds it too, unsigned as its other files are", () => {
    const dev = read(".github/workflows/dev-build.yml");
    const devBuild = step(dev, "Build the data runner");
    expect(devBuild).toContain("bash scripts/build-data-runner.sh dist \\\n");
    expect(devBuild).toContain(`for out_path in dist/${ASSET}*; do`);
    expect(devBuild).toContain('> "${out_path}.sha256"');
    expect(devBuild).toContain('gzip -9 -f "$out_path"');
    expect(devBuild).not.toContain("sign-artifact");
    expect(dev.indexOf("      - name: Build the data runner\n")).toBeLessThan(
      dev.indexOf("      - name: Publish per-branch dev release\n"),
    );
  });
});

describe("a pull request builds what a release builds", () => {
  const ci = read(".github/workflows/ci.yml");

  test("the program's job builds the four files with the script, and builds them again to compare", () => {
    const job = jobOf(ci, "data-runner");
    expect(job).toContain('bash ../scripts/build-data-runner.sh "${RUNNER_TEMP}/data-runner" "0.0.0+ci"');
    for (const name of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]) {
      expect(job).toContain(name);
    }
    // The second build takes nothing the first one compiled.
    expect(job).toContain('GOCACHE="$(mktemp -d)" bash ../scripts/build-data-runner.sh');
    expect(job).toContain("cmp ");
  });

  test("the image is built, the program runs in it as the image's user, and it is the file a release publishes", () => {
    const job = jobOf(ci, "image");
    expect(job).toContain("docker build --build-arg HX_FORTRESS_VERSION=0.0.0+ci --tag hx-fortress:ci .");
    expect(job).toContain('test "$path" = "/usr/local/bin/data-runner"');
    expect(job).toContain("run --job-stdin");
    expect(job).toContain('bash scripts/build-data-runner.sh "${RUNNER_TEMP}/release" "0.0.0+ci" linux/amd64');
    expect(job).toContain('cmp "${RUNNER_TEMP}/release/hx-fortress-data-runner-linux-x64" "${RUNNER_TEMP}/from-image"');
    // Nothing is pushed from a pull request.
    expect(job).not.toContain("docker push");
    expect(job).not.toContain("ghcr.io");
  });

  test("it runs a release's two scans on the image it built, with a release's own settings", () => {
    const release = read(".github/workflows/release.yml");
    const job = jobOf(ci, "image");
    for (const [here, there] of [
      ["Trivy image scan, as a release runs it", "Trivy image scan"],
      ["Trivy config scan, as a release runs it", "Trivy config scan"],
    ] as const) {
      const mine = step(job, here);
      const theirs = step(release, there);
      // The same action at the same commit.
      const pin = /uses: aquasecurity\/trivy-action@[0-9a-f]{40} # v[0-9.]+/;
      expect(pin.exec(mine)?.[0]).toBe(pin.exec(theirs)?.[0] as string);
      // The same settings. Only the image differs: this one was never pushed.
      const settings = (text: string): string[] => inputsOf(text).filter((line) => !line.startsWith("image-ref:"));
      expect(settings(mine)).toEqual(settings(theirs));
      expect(settings(mine)).toContain('exit-code: "1"');
    }
    expect(step(job, "Trivy image scan, as a release runs it")).toContain("image-ref: hx-fortress:ci");
  });

  test("every workflow that installs Go installs the version the program's module names, by a pinned action", () => {
    const files = ["ci.yml", "codeql.yml", "release.yml", "dev-build.yml", "security.yml"];
    let found = 0;
    for (const file of files) {
      const parts = read(`.github/workflows/${file}`).split("      - uses: actions/setup-go@");
      for (const part of parts.slice(1)) {
        found += 1;
        const setup = part.split("\n      - ")[0] as string;
        expect([file, /^[0-9a-f]{40} # v[0-9.]+\n/.test(setup)]).toEqual([file, true]);
        expect([file, setup.includes("go-version-file: data-runner/go.mod")]).toEqual([file, true]);
      }
    }
    // The program's job, the image's job, the analysis, the release and the dev build.
    expect(found).toBe(5);
  });
});

// ── The image ────────────────────────────────────────────────────────────────

describe("the image holds the data runner", () => {
  const dockerfile = read("Dockerfile");
  const stage = from(dockerfile, "\nFROM golang:").split("\nFROM ")[1] as string;
  const runtime = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));

  test("its Go is the version the program's module names", () => {
    const version = goVersionOf(read("data-runner/go.mod"));
    // The tag names the version, and the digest beside it is what a build
    // pulls: the two change together when the module's Go does.
    const line = dockerfile.split("\n").find((candidate) => candidate.startsWith("FROM golang:")) ?? "";
    const tagged = `FROM golang:${version}-trixie@sha256:`;
    expect(line.startsWith(tagged)).toBe(true);
    expect(line.slice(tagged.length)).toMatch(/^[0-9a-f]{64} AS data-runner$/);
    // One Go image, so there is one version to hold.
    expect(dockerfile.split("\nFROM golang:").length - 1).toBe(1);
  });

  test("the program is built by the script, from the folder and nothing else", () => {
    expect(stage).toContain("COPY scripts/build-data-runner.sh scripts/build-data-runner.sh\n");
    expect(stage).toContain("COPY data-runner/ data-runner/\n");
    expect(stage).not.toContain("COPY . .");
    expect(stage).toContain(
      'RUN bash scripts/build-data-runner.sh /out "${HX_FORTRESS_VERSION}" "linux/${TARGETARCH:-$(go env GOARCH)}"',
    );
    expect(stage).toContain("ARG HX_FORTRESS_VERSION=dev\n");
  });

  test("it stands beside HX Fortress, owned by root, and the image says where", () => {
    expect(runtime).toContain("COPY --from=data-runner /out/data-runner /usr/local/bin/data-runner\n");
    expect(runtime).toContain("ENV FORTRESS_DATA_RUNNER=/usr/local/bin/data-runner\n");
    // Copied before the image's user is named, and with no --chown: the file
    // is root's, and the daemon's user cannot replace it.
    expect(runtime.indexOf("COPY --from=data-runner")).toBeLessThan(runtime.indexOf("\nUSER fortress\n"));
    expect(runtime).not.toMatch(/COPY --chown[^\n]*data-runner/);
  });

  test("the system's certificate authorities are installed, with nothing recommended beside them", () => {
    expect(runtime).toContain("apt-get install -y --no-install-recommends ca-certificates");
  });

  test("the build context holds the folder and the script", () => {
    const ignored = read(".dockerignore")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    for (const line of ignored) {
      expect([line, /^!?\/?(data-runner|scripts)(\/|$)/.test(line)]).toEqual([line, false]);
      expect([line, line === "*" || line === "**"]).toEqual([line, false]);
    }
  });

  test("the bot that proposes newer images leaves the Go image alone", () => {
    const docker = from(read(".github/dependabot.yml"), '  - package-ecosystem: "docker"\n');
    expect(docker).toContain('      - dependency-name: "golang"\n');
  });
});
