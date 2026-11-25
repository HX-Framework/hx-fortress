// The release workflow, read as text. Two of its steps are also run here as
// the shell they are, with stand-ins for the commands they call: the one that
// lists the digests of the unpacked programs, and the one that marks a
// release as latest.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const workflowPath = new URL("../.github/workflows/release.yml", import.meta.url);
const workflow = await Bun.file(workflowPath).text();

/** The text from one of its lines to its end. */
function from(text: string, start: string): string {
  const at = text.indexOf(start);
  if (at < 0) throw new Error(`the workflow has no line "${start.trim()}"`);
  return text.slice(at);
}

/** One job of the workflow: from its name to the next job, or to the end. */
function jobOf(name: string): string {
  const lines = from(workflow, `\n  ${name}:\n`).slice(1).split("\n");
  // A job's name is a key two spaces in. Its own line is the first.
  const next = lines.findIndex(
    (line, at) => at > 0 && line.startsWith("  ") && line[2] !== " " && line[2] !== "#" && line.endsWith(":"),
  );
  return (next < 0 ? lines : lines.slice(0, next)).join("\n");
}

/** One step: from its `- name:` line to the next step, or to the end. */
function stepOf(text: string, name: string): string {
  const rest = from(text, `      - name: ${name}\n`);
  const next = rest.indexOf("\n      - ", 1);
  return next < 0 ? rest : rest.slice(0, next);
}

/** What a step hands its action: the lines under `with:`, without comments. */
function inputsOf(step: string): string[] {
  const lines = step.split("\n");
  const at = lines.findIndex((line) => line.trim() === "with:");
  if (at < 0) return [];
  return lines
    .slice(at + 1)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** The shell a step runs: its `run: |` block, without the block's indent. */
function shellOf(step: string): string {
  const lines = step.split("\n");
  const at = lines.findIndex((line) => /^\s+run: \|$/.test(line));
  if (at < 0) throw new Error("the step has no run block");
  const keyIndent = (lines[at] as string).search(/\S/);
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== "" && line.search(/\S/) <= keyIndent) break;
    body.push(line);
  }
  const indent = Math.min(...body.filter((line) => line.trim() !== "").map((line) => line.search(/\S/)));
  return `${body
    .map((line) => line.slice(indent))
    .join("\n")
    .trimEnd()}\n`;
}

/** Each command of a shell text that starts with `start`, with the lines it
 *  continues on joined to it. */
function commandsOf(shell: string, start: string): string[] {
  const lines = shell.split("\n");
  const found: string[] = [];
  lines.forEach((line, at) => {
    if (!line.trimStart().startsWith(start)) return;
    let command = line.trim();
    for (let next = at + 1; command.endsWith("\\") && next < lines.length; next += 1) {
      command = `${command.slice(0, -1).trimEnd()} ${(lines[next] as string).trim()}`;
    }
    found.push(command);
  });
  return found;
}

/** The workflow's lines that are not comments. */
const code = workflow.split("\n").filter((line) => !line.trimStart().startsWith("#"));

/**
 * Runs a shell text with bash in a throwaway folder, which is its working
 * folder, with stand-ins for commands in front of the PATH. `prepare` fills
 * the folder first, and `look` reads it after the run, before it is removed.
 */
async function runShell<T>(
  shell: string,
  options: {
    stubs?: Record<string, string>;
    env: (dir: string) => Record<string, string>;
    prepare?: (dir: string) => Promise<void>;
    look: (dir: string, run: { code: number; out: string }) => Promise<T>;
  },
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-workflow-"));
  try {
    const stubs = path.join(dir, "stubs");
    await mkdir(stubs);
    for (const [name, text] of Object.entries(options.stubs ?? {})) {
      await writeFile(path.join(stubs, name), text);
      await chmod(path.join(stubs, name), 0o755);
    }
    await options.prepare?.(dir);
    const child = Bun.spawn(["bash", "-c", shell], {
      cwd: dir,
      env: { PATH: `${stubs}:${process.env.PATH ?? ""}`, ...options.env(dir) },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return await options.look(dir, { code: await child.exited, out: out + err });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("release workflow", () => {
  test("builds the four supported hx-fortress binaries with checksums and gzip assets", () => {
    for (const target of [
      "bun-darwin-arm64",
      "bun-darwin-x64",
      "bun-linux-arm64",
      "bun-linux-x64",
    ]) {
      expect(workflow).toContain(target);
    }

    expect(workflow).toContain("hx-fortress-${target#bun-}");
    expect(workflow).toContain("./src/cli.ts");
    // x64 builds must use the -baseline runtime so they run on CPUs without
    // AVX2 (MC-2366); the build target is derived from $target at runtime.
    expect(workflow).toContain('*-x64) build_target="${target}-baseline" ;;');
    expect(workflow).toContain('--target="$build_target"');
    expect(workflow).toContain('> "${out_path}.sha256"');
    expect(workflow).toContain('gzip -9 -f "$out_path"');
    expect(workflow).toContain("dist/hx-fortress-version");
  });

  test("builds the console before the compile and refuses an irreproducible rebuild", () => {
    expect(workflow).toContain("bun run build:ui");
    expect(workflow).toContain("scripts/gen-ui-assets.ts --print-hash");
    expect(workflow).toContain('if [[ "$first" != "$second" ]]; then');
    expect(workflow).toContain("bun run gen:ui");
    // Order is load-bearing: the compile embeds whatever gen:ui wrote.
    expect(workflow.indexOf("bun run gen:ui")).toBeLessThan(
      workflow.indexOf("Compile darwin/linux binaries"),
    );
  });

  test("a console-only change triggers the release", () => {
    expect(workflow).toContain('- "ui/**"');
    expect(workflow).toContain('- "scripts/**"');
  });

  test("publishes rolling releases and immutable releases on manual dispatch", () => {
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain('gh release create "$tag" dist/hx-fortress-*');
    expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
  });

  test("the install script is a file of the release, published with its checksum and its build record", () => {
    // `curl …/releases/latest/download/hx-fortress-install.sh | sh` is how a
    // host is installed, so the file has to be in every release under that name.
    expect(workflow).toContain("cp install.sh dist/hx-fortress-install.sh");
    expect(workflow).toContain("> dist/hx-fortress-install.sh.sha256");
    // Copied before either release is created, so the upload glob takes it.
    const copied = workflow.indexOf("cp install.sh dist/hx-fortress-install.sh");
    expect(copied).toBeGreaterThan(-1);
    expect(copied).toBeLessThan(workflow.indexOf("- name: Publish rolling release"));
    expect(copied).toBeLessThan(workflow.indexOf("- name: Publish immutable release"));
    // And named in the build record beside the programs.
    expect(inputsOf(stepOf(jobOf("release"), "Attest build provenance"))).toContain("dist/hx-fortress-install.sh");
  });

  test("no release is created as latest: the rolling and the immutable release are both created --latest=false", () => {
    const release = jobOf("release");
    // The install script and `hx-fortress update` take their files from
    // `…/releases/latest/download/`. A rolling build is recreated on every
    // push to main, and the immutable release lacks the pgvector files until
    // the pgvector jobs have attached them.
    for (const name of ["Publish rolling release", "Publish immutable release"]) {
      const creates = commandsOf(shellOf(stepOf(release, name)), "gh release create");
      expect([name, creates.length]).toEqual([name, 1]);
      expect([name, creates[0]?.includes("--latest=false")]).toEqual([name, true]);
      expect([name, /--latest(?![=\w-])/.test(creates[0] as string)]).toEqual([name, false]);
    }
    expect(shellOf(stepOf(release, "Publish immutable release"))).toContain('tag="releases/hx-fortress-${version}"');
    // The one bare --latest of the workflow is the last job's.
    const bare = code.filter((line) => /--latest(?![=\w-])/.test(line)).map((line) => line.trim());
    expect(bare).toEqual(['gh release edit "$tag" --latest']);
    expect(jobOf("mark-latest")).toContain('gh release edit "$tag" --latest');
  });

  test("the immutable release is marked latest by a last job, only on a dispatch, and only after every pgvector job attached its files", () => {
    const job = jobOf("mark-latest");
    // Its own condition. With no status function in it, GitHub runs the job
    // only when every job it needs has succeeded: a pgvector job that fails
    // leaves the release before this one latest.
    const condition = job.split("\n").find((line) => line.startsWith("    if: "));
    expect(condition).toBe("    if: ${{ github.event_name == 'workflow_dispatch' }}");
    expect(condition).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)|success\(\)/);
    const needs = /^ {4}needs: \[([^\]]*)\]$/m
      .exec(job)?.[1]
      ?.split(",")
      .map((name) => name.trim())
      .sort();
    expect(needs).toEqual(["pgvector", "release"]);
    expect(job).toContain("      contents: write");
    // The pgvector jobs attach their files to the immutable release, and wait
    // for the job that creates it.
    const pgvector = jobOf("pgvector");
    expect(pgvector).toMatch(/^ {4}needs: release$/m);
    expect(pgvector).toContain('gh release upload "releases/hx-fortress-${VERSION}"');
    // The job has no checkout, so gh is told the repository, and the version
    // comes from the job that built it.
    const step = stepOf(job, "Mark it latest, unless a newer release already is");
    expect(step).toContain("GH_REPO: ${{ github.repository }}");
    expect(step).toContain("GH_TOKEN: ${{ github.token }}");
    expect(step).toContain("VERSION: ${{ needs.release.outputs.version }}");
    expect(jobOf("release")).toContain("version: ${{ steps.version.outputs.value }}");
  });

  test("the last job marks the release latest unless a newer immutable release already is", async () => {
    const shell = shellOf(stepOf(jobOf("mark-latest"), "Mark it latest, unless a newer release already is"));
    // A stand-in for gh. It writes down what it is given, one argument to a
    // line and an empty line after them. Asked which release is latest, it
    // answers as gh does: the tag alone when that field is asked for, "Not
    // Found (HTTP 404)" when no release is latest, and another failure when
    // the test says the service is down.
    const gh = [
      "#!/bin/sh",
      `{ for argument in "$@"; do printf '%s\\n' "$argument"; done; printf '\\n'; } >> "$GH_LOG"`,
      'case "$1" in',
      "  api)",
      '    [ "$2" = "repos/HX-Framework/hx-fortress/releases/latest" ] || { echo "not expected here: gh $*" >&2; exit 3; }',
      '    [ -z "$GH_DOWN" ] || { echo "gh: Bad Gateway (HTTP 502)" >&2; exit 1; }',
      '    [ -n "$GH_LATEST" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }',
      '    field=""; previous=""',
      '    for argument in "$@"; do',
      '      case "$previous" in --jq|-q) field="$argument" ;; esac',
      '      previous="$argument"',
      "    done",
      '    if [ "$field" = .tag_name ]; then',
      '      printf \'%s\\n\' "$GH_LATEST"',
      "    else",
      "      printf '{\"tag_name\":\"%s\"}\\n' \"$GH_LATEST\"",
      "    fi",
      "    ;;",
      "  release)",
      '    [ "$2" = edit ] || { echo "not expected here: gh $*" >&2; exit 3; }',
      "    ;;",
      '  *) echo "not expected here: gh $*" >&2; exit 3 ;;',
      "esac",
      "",
    ].join("\n");

    for (const [latest, version, marks] of [
      // Before the first immutable release, a rolling build is latest.
      ["builds/hx-fortress-0.36.2", "0.36.2", true],
      // No release is latest.
      [null, "0.36.2", true],
      ["releases/hx-fortress-0.36.1", "0.36.2", true],
      // Compared as versions: as text, 0.10.0 comes before 0.9.9.
      ["releases/hx-fortress-0.9.9", "0.10.0", true],
      // A dispatch from an older build tag does not move latest backwards.
      ["releases/hx-fortress-0.37.0", "0.36.2", false],
      ["releases/hx-fortress-0.10.0", "0.9.9", false],
      // The same release.
      ["releases/hx-fortress-0.36.2", "0.36.2", false],
    ] as const) {
      const { code: exit, edits } = await runShell(shell, {
        stubs: { gh },
        env: (dir) => ({
          VERSION: version,
          GH_LATEST: latest ?? "",
          GH_DOWN: "",
          GH_LOG: path.join(dir, "gh.log"),
          GH_REPO: "HX-Framework/hx-fortress",
        }),
        look: async (dir, run) => {
          const calls = (await readFile(path.join(dir, "gh.log"), "utf8").catch(() => ""))
            .split("\n\n")
            .filter((call) => call.trim() !== "")
            .map((call) => call.split("\n").filter((argument) => argument !== ""));
          return { code: run.code, edits: calls.filter((call) => call[0] === "release" && call[1] === "edit") };
        },
      });
      expect([latest, version, exit]).toEqual([latest, version, 0]);
      expect([latest, version, edits]).toEqual([
        latest,
        version,
        marks ? [["release", "edit", `releases/hx-fortress-${version}`, "--latest"]] : [],
      ]);
    }

    // "Could not ask" is not "none is latest". Marking on a guess could move
    // latest backwards, so the step fails and marks nothing.
    const down = await runShell(shell, {
      stubs: { gh },
      env: (dir) => ({
        VERSION: "0.36.2",
        GH_LATEST: "releases/hx-fortress-0.37.0",
        GH_DOWN: "yes",
        GH_LOG: path.join(dir, "gh.log"),
        GH_REPO: "HX-Framework/hx-fortress",
      }),
      look: async (dir, run) => ({
        code: run.code,
        log: await readFile(path.join(dir, "gh.log"), "utf8").catch(() => ""),
      }),
    });
    expect(down.code).not.toBe(0);
    expect(down.log).not.toContain("edit");
  });

  test("the rolling release publishes only on a push to main", () => {
    // A workflow_dispatch is how the IMMUTABLE release is cut, from a build tag
    // that already exists. Ungated, the rolling step would run there too and
    // delete that tag's release, then force-move the very tag the pre-dispatch
    // check verified — underneath the ceremony reading it.
    const step = workflow.indexOf("- name: Publish rolling release");
    expect(step).toBeGreaterThan(-1);
    const gate = workflow.indexOf(
      "if: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}",
      step,
    );
    expect(gate).toBeGreaterThan(step);
    // The gate is this step's own, not one belonging to a later step.
    expect(gate).toBeLessThan(workflow.indexOf('gh release create "$tag"', step));
  });

  test("signs artifacts and attests build provenance (supply-chain)", () => {
    // Ed25519 detached signatures over the binaries + pgvector tarball…
    expect(workflow).toContain("scripts/sign-artifact.ts");
    // WHAT is signed, and WHEN. The signature sidecar the updater fetches is
    // `<name>.sig` for the UNCOMPRESSED artifact, so signing after the gzip — a
    // natural "sign what you upload" edit — publishes `<name>.gz.sig`. Every
    // HX Fortress then 404s on the path it asks for, and because enforcement is off
    // by default the missing-signature branch warns and installs anyway: an
    // authenticity gate disabled fleet-wide with this suite green.
    const signAt = workflow.indexOf("scripts/sign-artifact.ts");
    const gzipAt = workflow.indexOf("gzip -9 -f");
    expect(gzipAt).toBeGreaterThan(-1);
    expect(signAt).toBeLessThan(gzipAt);
    expect(workflow).toMatch(/sign-artifact\.ts[^\n]*"\$out_path"/);
    expect(workflow).toContain("FORTRESS_SIGNING_KEY");
    // …plus GitHub build-provenance attestation…
    expect(workflow).toContain("attest-build-provenance");
    expect(workflow).toContain("id-token: write");
    // …while keeping the same-origin .sha256 integrity sidecars.
    expect(workflow).toContain('> "${out_path}.sha256"');
  });

  test("a second build record names each program as a host has it, unpacked, and leaves the install script out", async () => {
    const release = jobOf("release");
    const list = stepOf(release, "List the digests of the unpacked programs");
    const attest = stepOf(release, "Attest the unpacked programs");
    // The record is given one file of digests, in the runner's own folder.
    const inputs = inputsOf(attest);
    expect(inputs).toHaveLength(1);
    const given = /^subject-checksums: \$\{\{ runner\.temp \}\}\/(\S+)$/.exec(inputs[0] as string)?.[1];
    expect(typeof given).toBe("string");

    // The list is made from the .sha256 files a release holds: those of the
    // programs and the data runners, and the install script's, which the
    // first record already names by its own path.
    const programs = [
      "hx-fortress-darwin-arm64",
      "hx-fortress-darwin-x64",
      "hx-fortress-linux-arm64",
      "hx-fortress-linux-x64",
      "hx-fortress-data-runner-darwin-arm64",
      "hx-fortress-data-runner-darwin-x64",
      "hx-fortress-data-runner-linux-arm64",
      "hx-fortress-data-runner-linux-x64",
    ];
    const line = (name: string): string => `${createHash("sha256").update(name).digest("hex")}  ${name}`;
    const { code: exit, listed } = await runShell(shellOf(list), {
      env: (dir) => ({ RUNNER_TEMP: path.join(dir, "runner-temp") }),
      prepare: async (dir) => {
        await mkdir(path.join(dir, "runner-temp"));
        const dist = path.join(dir, "dist");
        await mkdir(dist);
        for (const name of programs) {
          await writeFile(path.join(dist, `${name}.sha256`), `${line(name)}\n`);
          await writeFile(path.join(dist, `${name}.gz`), "packed");
        }
        await writeFile(path.join(dist, "hx-fortress-install.sh"), "#!/bin/sh\n");
        await writeFile(path.join(dist, "hx-fortress-install.sh.sha256"), `${line("hx-fortress-install.sh")}\n`);
        await writeFile(path.join(dist, "hx-fortress-version"), "0.36.2\n");
      },
      // The file the record is given, where the runner's folder is.
      look: async (dir, run) => ({
        code: run.code,
        listed: await readFile(path.join(dir, "runner-temp", given as string), "utf8").catch(() => null),
      }),
    });
    expect(exit).toBe(0);
    expect(listed?.split("\n").filter(Boolean).sort()).toEqual(programs.map(line).sort());
    expect(listed).not.toContain("hx-fortress-install.sh");
  });

  test("the second record is made after every program is built, before either release is published, by the same pinned action as the first", () => {
    const release = jobOf("release");
    const at = (name: string): number => {
      const where = release.indexOf(`      - name: ${name}\n`);
      expect([name, where >= 0]).toEqual([name, true]);
      return where;
    };
    expect(at("Compile darwin/linux binaries")).toBeLessThan(at("List the digests of the unpacked programs"));
    expect(at("Build the data runner")).toBeLessThan(at("List the digests of the unpacked programs"));
    expect(at("List the digests of the unpacked programs")).toBeLessThan(at("Attest the unpacked programs"));
    expect(at("Attest the unpacked programs")).toBeLessThan(at("Publish rolling release"));
    expect(at("Attest the unpacked programs")).toBeLessThan(at("Publish immutable release"));
    const pin = /uses: actions\/attest-build-provenance@[0-9a-f]{40} # v[0-9.]+/;
    const first = pin.exec(stepOf(release, "Attest build provenance"))?.[0];
    expect(first).toBeDefined();
    expect(pin.exec(stepOf(release, "Attest the unpacked programs"))?.[0]).toBe(first as string);
  });

  test("publishes GHCR tags and tells the downstream repository after a successful image push", () => {
    expect(workflow).toContain("packages: write");
    expect(workflow).toContain("docker/setup-buildx-action");
    expect(workflow).toContain("docker/metadata-action");
    expect(workflow).toContain("docker/build-push-action");
    expect(workflow).toContain("ghcr.io/hx-framework/hx-fortress");
    expect(workflow).toContain("type=raw,value=latest");
    expect(workflow).toContain("type=raw,value=${{ steps.version.outputs.value }}");
    expect(workflow).toContain("type=raw,value=sha-");
    // The repository that is told, and the token that tells it, are settings of
    // this repository. Each has a fallback to the value the step used before
    // those settings existed, and the step is never skipped for want of one: a
    // release that tells nobody leaves a deployment on the old image with no
    // error anywhere.
    expect(workflow).toMatch(/repository: \$\{\{ vars\.DOWNSTREAM_DISPATCH_REPOSITORY \|\| '[\w.-]+\/[\w.-]+' \}\}/);
    expect(workflow).toMatch(/token: \$\{\{ secrets\.DOWNSTREAM_DISPATCH_TOKEN \|\| secrets\.[A-Z_]+ \}\}/);
    expect(workflow).not.toContain("DOWNSTREAM_DISPATCH_REPOSITORY != ''");
    expect(workflow).toContain("event-type: hx-fortress-image-published");
  });
});
