// The two install scripts, run for real.
//
// `install.sh` is what a person pipes into a shell, so it is tested as a
// program: a stand-in release on loopback, a throwaway folder for the program,
// and the script's own exit code and words. `install-from-source.sh` runs as a
// copy in a folder of its own, with a stand-in for Bun.
//
// A run starts programs that did not exist a moment before, and macOS checks a
// new program the first time it runs (about half a second). A test that runs a
// script several times needs more than the default 5 seconds.

import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { INSTALL_FLAGS, INSTALL_VALUE_OPTIONS } from "../src/cli-install";
import { SETUP_FLAGS, SETUP_VALUE_OPTIONS } from "../src/cli-setup";

setDefaultTimeout(30_000);

const ROOT = path.resolve(import.meta.dir, "..");
const SCRIPT = path.join(ROOT, "install.sh");
const SOURCE_SCRIPT = path.join(ROOT, "install-from-source.sh");
const TARGET = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const ASSET = `hx-fortress-${TARGET}`;

/** The options of the two commands the scripts run, as the program has them.
 *  `--help` is left out: each script answers it with its own usage. */
const withoutHelp = (list: readonly string[]): string[] => list.filter((option) => option !== "--help");
const COMMANDS = {
  install: { flags: withoutHelp(INSTALL_FLAGS), values: withoutHelp(INSTALL_VALUE_OPTIONS) },
  setup: { flags: withoutHelp(SETUP_FLAGS), values: withoutHelp(SETUP_VALUE_OPTIONS) },
} as const;
type Command = keyof typeof COMMANDS;

/** Every option of a command, each one that takes a value with a value after
 *  it that has spaces in it. */
const everyOption = (command: Command): string[] => [
  ...COMMANDS[command].values.flatMap((option) => [option, `the value of ${option}`]),
  ...COMMANDS[command].flags,
];

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** A stand-in for the program: a shell script that answers `help` with the
 *  lines it is given, and `version` with the version it is given. Without a
 *  version it is a program from before that command, which answers it as it
 *  answers any word it does not know: with its help, and exit code 1. Run with
 *  anything else, it says what it was run with, one argument to a line. */
function program(helpLines: string, version?: string): Buffer {
  const help = `cat <<'EOT'\n${helpLines}\nEOT\n`;
  const answer = version === undefined ? `${help}exit 1\n` : `echo '${version}'\nexit 0\n`;
  return Buffer.from(
    "#!/bin/sh\n" +
      `if [ "$1" = "help" ]; then\n${help}exit 0\nfi\n` +
      `if [ "$1" = "version" ]; then\n${answer}fi\n` +
      'echo "ran with $# arguments"\nfor argument in "$@"; do echo "  [$argument]"; done\n',
  );
}
/** The help of a version that has both commands. */
const BOTH = "  hx-fortress install   make HX Fortress somewhere\n  hx-fortress setup   ask the questions here";
/** The help of a version from before both commands. */
const BEFORE_BOTH = "  hx-fortress enroll    enroll with a control plane\n  hx-fortress ui --install-service";
/** A program that is already on this computer, from before the `version`
 *  command: no version is compared with it. */
const EARLIER = program(`${BOTH}\n  (the program that was here before)`);
/** A program that is already on this computer and answers `version`. */
const earlierAt = (version: string): Buffer => program(`${BOTH}\n  (the program that was here before)`, version);

/** What the stand-in program says it was run with. */
const ranWith = (...args: string[]): string =>
  [`ran with ${args.length} arguments`, ...args.map((arg) => `  [${arg}]`)].join("\n");

/** The words of the line `NAME="…"` of a script. It fails when the script
 *  sets that name in any other place too. */
function listIn(text: string, name: string): string[] {
  const lines = text.split("\n").filter((line) => line.trimStart().startsWith(`${name}=`));
  expect([name, lines.length]).toEqual([name, 1]);
  const words = new RegExp(`^${name}="([^"$]*)"$`).exec(lines[0] as string)?.[1];
  expect([name, typeof words]).toEqual([name, "string"]);
  return (words as string).split(/\s+/).filter(Boolean);
}

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function folder(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** What is in a folder, sorted. */
const inFolder = async (dir: string): Promise<string[]> => (await readdir(dir)).sort();

/** Puts `earlier` at `installed` as a program, and holds the file open as a
 *  program that runs from it does. What it returns reads, after a run, what
 *  that program's file then holds. */
async function putEarlier(installed: string, earlier: Buffer): Promise<() => Promise<Buffer>> {
  await mkdir(path.dirname(installed), { recursive: true });
  await writeFile(installed, earlier);
  await chmod(installed, 0o755);
  const handle = await open(installed, "r");
  return async () => {
    try {
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  };
}

describe("the options both scripts check are the program's own", () => {
  test("each script's four lists are the options of hx-fortress install and hx-fortress setup", async () => {
    const sorted = (list: readonly string[]): string[] => [...list].sort();
    for (const script of [SCRIPT, SOURCE_SCRIPT]) {
      const text = await readFile(script, "utf8");
      const name = path.basename(script);
      // Each list on its own: an option that takes a value is in the list of
      // those that take one, in the script as in the program.
      expect([name, sorted(listIn(text, "INSTALL_FLAGS"))]).toEqual([name, sorted(COMMANDS.install.flags)]);
      expect([name, sorted(listIn(text, "INSTALL_VALUES"))]).toEqual([name, sorted(COMMANDS.install.values)]);
      expect([name, sorted(listIn(text, "SETUP_FLAGS"))]).toEqual([name, sorted(COMMANDS.setup.flags)]);
      expect([name, sorted(listIn(text, "SETUP_VALUES"))]).toEqual([name, sorted(COMMANDS.setup.values)]);
    }
  });
});

describe("install.sh", () => {
  interface Release {
    files: Map<string, Buffer | string>;
    /** The files asked for, in the order they were asked. */
    asked: string[];
    /** A file's name, and the address its request is answered with a redirect to. */
    redirects?: Map<string, string>;
  }

  let server: ReturnType<typeof Bun.serve>;
  let release: Release = { files: new Map(), asked: [] };
  let base: string;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const name = new URL(req.url).pathname.replace(/^\/release\//, "");
        release.asked.push(name);
        const elsewhere = release.redirects?.get(name);
        if (elsewhere) return new Response(null, { status: 302, headers: { location: elsewhere } });
        const body = release.files.get(name);
        if (body === undefined) return new Response("not found", { status: 404 });
        return new Response(typeof body === "string" ? body : new Uint8Array(body));
      },
    });
    base = `http://127.0.0.1:${server.port}/release`;
  });
  afterAll(async () => {
    await server.stop(true);
  });

  /** The stand-in release holds these bytes as the program for this computer,
   *  their checksum, and a version file, unless `version` is null. */
  function publish(bytes: Buffer, options: { sha256?: string; version?: string | null } = {}): void {
    const files = new Map<string, Buffer | string>([
      [`${ASSET}.gz`, gzipSync(bytes)],
      [`${ASSET}.sha256`, `${options.sha256 ?? sha256(bytes)}  ${ASSET}\n`],
    ]);
    if (options.version !== null) files.set("hx-fortress-version", `${options.version ?? "9.8.7"}\n`);
    release = { asked: [], files };
  }

  interface Run {
    code: number;
    out: string;
    /** The run's own folder: its HOME and its TMPDIR. */
    dir: string;
    /** The folder the program goes to. */
    bin: string;
    installed: string;
    /** With an earlier program: what a program that runs from it reads from
     *  its file after the run. */
    held: Buffer | null;
  }

  /** Runs the script. The program's folder is named with --dir unless
   *  `dirBy` says otherwise, and `earlier` is a program put there first. */
  async function install(
    args: readonly string[],
    options: {
      env?: Record<string, string>;
      earlier?: Buffer;
      dirBy?: "option" | "environment" | "none";
      withHome?: boolean;
    } = {},
  ): Promise<Run> {
    const dir = await folder("hx-fortress-install-");
    const bin = path.join(dir, "bin");
    const installed = path.join(bin, "hx-fortress");
    const held = options.earlier ? await putEarlier(installed, options.earlier) : null;
    const dirBy = options.dirBy ?? "option";
    const child = Bun.spawn(["sh", SCRIPT, ...(dirBy === "option" ? ["--dir", bin] : []), ...args], {
      env: {
        PATH: process.env.PATH ?? "",
        TMPDIR: dir,
        ...(options.withHome === false ? {} : { HOME: dir }),
        ...(dirBy === "environment" ? { HX_FORTRESS_BIN_DIR: bin } : {}),
        ...options.env,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const code = await child.exited;
    return { code, out: out + err, dir, bin, installed, held: held ? await held() : null };
  }

  /** The program that was here is byte for byte as it was, no new copy is
   *  left beside it, and nothing of the download is left either. */
  async function expectUntouched(run: Run, earlier: Buffer): Promise<void> {
    expect((await readFile(run.installed)).equals(earlier)).toBe(true);
    expect(await inFolder(run.bin)).toEqual(["hx-fortress"]);
    expect(await inFolder(run.dir)).toEqual(["bin"]);
  }

  test("downloads the program for this computer, checks it, and puts it in place", async () => {
    const bytes = program(BOTH);
    publish(bytes);
    const run = await install(["--from", base, "--program-only"]);
    expect(run.out).toContain(`Downloading ${ASSET} from ${base}`);
    expect(run.code).toBe(0);
    expect((await readFile(run.installed)).equals(bytes)).toBe(true);
    expect((await stat(run.installed)).mode & 0o777).toBe(0o755);
    expect(run.out).toContain(`The program hx-fortress 9.8.7 is at ${run.installed}`);
    expect(run.out).toContain(`Checksum ${sha256(bytes)}`);
    // It asked the one address for the three files and for nothing else, and
    // the version file last, after the program's two files.
    expect(release.asked).toEqual([`${ASSET}.gz`, `${ASSET}.sha256`, "hx-fortress-version"]);
    // With --program-only it says what to run next and runs nothing.
    expect(run.out).toContain(`${run.installed} install`);
    expect(run.out).toContain(`${run.installed} setup`);
    expect(run.out).not.toContain("ran with");
  });

  test("a release with no version file is installed all the same", async () => {
    const bytes = program(BOTH);
    publish(bytes, { version: null });
    const run = await install(["--from", base]);
    expect(run.code).toBe(0);
    expect((await readFile(run.installed)).equals(bytes)).toBe(true);
    expect(run.out).toContain(`The program hx-fortress is at ${run.installed}`);
    expect(run.out).toContain(ranWith("install"));
    expect(release.asked).toEqual([`${ASSET}.gz`, `${ASSET}.sha256`, "hx-fortress-version"]);
  });

  test("the address can come from the environment, and a trailing slash does not matter", async () => {
    publish(program(BOTH));
    const run = await install(["--program-only"], { env: { HX_FORTRESS_FROM: `${base}/` } });
    expect(run.code).toBe(0);
    expect(run.out).toContain(`from ${base}\n`);
  });

  test("it ends by running the install command of the program it just put in place", async () => {
    publish(program(BOTH));
    const run = await install(["--from", base]);
    expect(run.code).toBe(0);
    expect(run.out).toContain(ranWith("install"));
  });

  test("the options of a control plane's command go to that command as they are written", async () => {
    publish(program(BOTH));
    const run = await install([
      "--connect",
      "control.example/i/an id with spaces",
      "--from",
      base,
      "--pages",
      "https://app.control.example",
      "--no-open",
    ]);
    expect(run.code).toBe(0);
    // In the order they were written, each as one argument, with the script's
    // own options taken out from between them.
    expect(run.out).toContain(
      ranWith(
        "install",
        "--connect",
        "control.example/i/an id with spaces",
        "--pages",
        "https://app.control.example",
        "--no-open",
      ),
    );
  });

  test("every option of hx-fortress install, and of hx-fortress setup, goes on to that command in the order it was written", async () => {
    for (const [command, own] of [
      ["install", []],
      ["setup", ["--on-this-machine"]],
    ] as const) {
      publish(program(BOTH));
      const options = everyOption(command);
      // The script's own options stand between the command's, after the first
      // option and its value.
      const run = await install([...options.slice(0, 2), "--from", base, ...own, ...options.slice(2)]);
      expect([command, run.code]).toEqual([command, 0]);
      expect(run.out).toContain(ranWith(command, ...options));
    }
  });

  test("--on-this-machine runs the setup on this machine, with the same options", async () => {
    publish(program(BOTH));
    const run = await install(["--from", base, "--on-this-machine", "--connect", "control.example/i/abc"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain(ranWith("setup", "--connect", "control.example/i/abc"));
  });

  test("with --on-this-machine the options are checked against the setup's, and without it against the install's", async () => {
    publish(program(BOTH));
    const setup = await install(["--from", base, "--on-this-machine", "--browser"]);
    expect(setup.code).toBe(0);
    expect(setup.out).toContain(ranWith("setup", "--browser"));

    publish(program(BOTH));
    const notSetup = await install(["--from", base, "--on-this-machine", "--terminal"]);
    expect(notSetup.code).toBe(2);
    expect(notSetup.out).toContain(
      '"--terminal" is not an option of this script, and hx-fortress setup does not take it either.',
    );
    expect(release.asked).toEqual([]);

    publish(program(BOTH));
    const installCommand = await install(["--from", base, "--terminal"]);
    expect(installCommand.code).toBe(0);
    expect(installCommand.out).toContain(ranWith("install", "--terminal"));

    publish(program(BOTH));
    const notInstall = await install(["--from", base, "--browser"]);
    expect(notInstall.code).toBe(2);
    expect(notInstall.out).toContain(
      '"--browser" is not an option of this script, and hx-fortress install does not take it either.',
    );
    expect(release.asked).toEqual([]);
  });

  test("an option that neither the script nor the command takes is refused before anything is downloaded", async () => {
    publish(program(BOTH));
    // A mistyped --from. Before, it went on to the command: the program was
    // downloaded from the default address, put over the one that was here,
    // and only then refused the option.
    const run = await install(["--form", "https://updates.example/hx-fortress"], {
      earlier: EARLIER,
      env: { HX_FORTRESS_FROM: base },
    });
    expect(run.code).toBe(2);
    expect(run.out).toContain(
      '"--form" is not an option of this script, and hx-fortress install does not take it either.',
    );
    expect(run.out).toContain("This script takes: --from <address>, --dir <folder>, --on-this-machine, --program-only.");
    // It names every option the command takes.
    const takes = run.out.split("\n").find((line) => line.includes("hx-fortress install takes:")) ?? "";
    const named = takes.slice(takes.indexOf(":") + 1).replace(/\.\s*$/, "").trim().split(/\s+/);
    expect(named.sort()).toEqual([...COMMANDS.install.flags, ...COMMANDS.install.values].sort());
    expect(run.out).toContain("Nothing was downloaded.");
    expect(release.asked).toEqual([]);
    await expectUntouched(run, EARLIER);
  });

  test("a word that is no option's value is refused before anything is downloaded", async () => {
    publish(program(BOTH));
    // An address pasted without the option it belongs to.
    const run = await install(["--from", base, "--no-open", "control.example/i/abc"], { earlier: EARLIER });
    expect(run.code).toBe(2);
    expect(run.out).toContain('"control.example/i/abc" is not an option of this script');
    expect(run.out).toContain("Nothing was downloaded.");
    expect(release.asked).toEqual([]);
    await expectUntouched(run, EARLIER);
  });

  test("an option that takes a value and is given none is refused before anything is downloaded", async () => {
    for (const [args, option] of [
      [["--file"], "--file"],
      [["--file", "--list"], "--file"],
      [["--connect", "control.example/i/abc", "--pages"], "--pages"],
    ] as const) {
      publish(program(BOTH));
      const run = await install(["--from", base, ...args], { earlier: EARLIER });
      expect([args, run.code]).toEqual([args, 1]);
      expect(run.out).toContain(`the option ${option} needs a value after it. Nothing was downloaded.`);
      expect(release.asked).toEqual([]);
      await expectUntouched(run, EARLIER);
    }
  });

  test("a -- among the options is left out", async () => {
    publish(program(BOTH));
    const run = await install(["--", "--from", base, "--connect", "control.example/i/abc", "--", "--no-open"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain(ranWith("install", "--connect", "control.example/i/abc", "--no-open"));
  });

  test("piped into sh -s --, as a person runs it, it takes its options from there", async () => {
    publish(program(BOTH));
    const dir = await folder("hx-fortress-install-piped-");
    const bin = path.join(dir, "bin");
    // One `--` more than the shell needs is left out.
    const child = Bun.spawn(
      ["sh", "-s", "--", "--", "--dir", bin, "--from", base, "--on-this-machine", "--browser"],
      {
        env: { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: dir },
        stdin: Bun.file(SCRIPT),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(out + err).toContain(ranWith("setup", "--browser"));
    expect(await child.exited).toBe(0);
  });

  test("the script leaves nothing behind when it hands over to the program", async () => {
    publish(program(BOTH));
    const run = await install(["--from", base]);
    expect(run.code).toBe(0);
    // The folder of the download was under TMPDIR, which is this test's own
    // folder: only the program's folder is left in it.
    expect(await readdir(run.dir)).toEqual(["bin"]);
  });

  test("--program-only with an option for a command is refused before anything is downloaded", async () => {
    publish(program(BOTH));
    const run = await install(["--from", base, "--program-only", "--connect", "control.example/i/abc"]);
    expect(run.code).toBe(2);
    expect(run.out).toContain("--program-only runs nothing");
    expect(release.asked).toEqual([]);
  });

  test("--program-only and --on-this-machine together are refused", async () => {
    publish(program(BOTH));
    const run = await install(["--from", base, "--program-only", "--on-this-machine"]);
    expect(run.code).toBe(2);
    expect(release.asked).toEqual([]);
  });

  test("with HOME not set, --dir or HX_FORTRESS_BIN_DIR is enough, and with neither the script says to name a folder", async () => {
    publish(program(BOTH));
    const byOption = await install(["--from", base], { withHome: false });
    expect(byOption.code).toBe(0);
    expect(byOption.out).toContain(ranWith("install"));

    publish(program(BOTH));
    const byEnvironment = await install(["--from", base, "--program-only"], { withHome: false, dirBy: "environment" });
    expect(byEnvironment.code).toBe(0);
    expect((await stat(byEnvironment.installed)).isFile()).toBe(true);

    publish(program(BOTH));
    const neither = await install(["--from", base], { withHome: false, dirBy: "none" });
    expect(neither.code).toBe(1);
    expect(neither.out).toContain("HOME is not set, so there is no folder to put the program in. Name one with --dir.");
    expect(release.asked).toEqual([]);
  });

  test("a release from before the command existed is named, and the program that was here stays as it was", async () => {
    publish(program(BEFORE_BOTH));
    const run = await install(["--from", base, "--connect", "control.example/i/abc"], { earlier: EARLIER });
    expect(run.code).toBe(1);
    expect(run.out).toContain(`the version at ${base} has no 'install' command. Nothing was put in place.`);
    expect(run.out).toContain("--program-only");
    expect(run.out).not.toContain("ran with");
    await expectUntouched(run, EARLIER);

    // A release that has the install command and not the setup.
    publish(program("  hx-fortress install   make HX Fortress somewhere"));
    const setup = await install(["--from", base, "--on-this-machine"], { earlier: EARLIER });
    expect(setup.code).toBe(1);
    expect(setup.out).toContain(`the version at ${base} has no 'setup' command. Nothing was put in place.`);
    await expectUntouched(setup, EARLIER);
  });

  test("with --program-only, a release from before the command existed is put in place, and nothing is run", async () => {
    const bytes = program(BEFORE_BOTH);
    publish(bytes);
    const run = await install(["--from", base, "--program-only"], { earlier: EARLIER });
    expect(run.code).toBe(0);
    expect((await readFile(run.installed)).equals(bytes)).toBe(true);
    expect(await inFolder(run.bin)).toEqual(["hx-fortress"]);
    expect(run.out).not.toContain("ran with");
  });

  test("a download that cannot run on this computer is said so, and the program that was here stays as it was", async () => {
    // A program for another system: its checksum is right, and this computer
    // cannot run it.
    const foreign = Buffer.concat([
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]),
      Buffer.alloc(56),
      Buffer.from("a program for another system\n"),
    ]);
    publish(foreign);
    const run = await install(["--from", base], { earlier: EARLIER });
    expect(run.code).toBe(1);
    expect(run.out).toContain(
      "the program that was downloaded could not be run on this computer. Nothing was put in place.",
    );
    expect(run.out).not.toContain("ran with");
    await expectUntouched(run, EARLIER);

    // With --program-only the program is not run, so it is put in place.
    publish(foreign);
    const only = await install(["--from", base, "--program-only"], { earlier: EARLIER });
    expect(only.code).toBe(0);
    expect((await readFile(only.installed)).equals(foreign)).toBe(true);
    expect(await inFolder(only.bin)).toEqual(["hx-fortress"]);
  });

  test("a download that does not match its checksum is refused, and nothing is put in place", async () => {
    publish(program(BOTH), { sha256: "a".repeat(64) });
    const run = await install(["--from", base]);
    expect(run.code).toBe(1);
    expect(run.out).toContain("does not match its checksum");
    expect(run.out).toContain("Nothing was put in place");
    expect(run.out).not.toContain("ran with");
    await expect(stat(run.installed)).rejects.toThrow();
  });

  test("a checksum file that is not a checksum is refused", async () => {
    publish(program(BOTH), { sha256: "<html>not found</html>" });
    const run = await install(["--from", base, "--program-only"]);
    expect(run.code).toBe(1);
    expect(run.out).toContain("the published checksum is not a sha256");
  });

  test("a release that is not there fails with the address it asked", async () => {
    release = { asked: [], files: new Map() };
    const run = await install(["--from", base, "--program-only"]);
    expect(run.code).toBe(1);
    expect(run.out).toContain(`could not download ${base}/${ASSET}.gz`);
  });

  test("an address in clear text is refused unless it is this computer itself", async () => {
    publish(program(BOTH));
    for (const address of [
      "http://files.northstar.example/release",
      // Names that only start like this computer's.
      "http://localhost.files.northstar.example/release",
      "http://127.0.0.1.files.northstar.example/release",
      "ftp://127.0.0.1/release",
      "https://",
    ]) {
      const run = await install(["--from", address, "--program-only"]);
      expect([address, run.code]).toEqual([address, 1]);
      expect(run.out).toContain("must start with https://");
    }
    expect(release.asked).toEqual([]);
  });

  test("an address with a user name, a query or a fragment is refused: it may be another host than it looks", async () => {
    publish(program(BOTH));
    const port = new URL(base).port;
    for (const address of [
      // Read by a browser or by curl, this is the host files.northstar.example.
      `http://127.0.0.1:${port}@files.northstar.example/release`,
      "https://ops@files.northstar.example/release",
      `${base}?x=1`,
      `${base}#x`,
    ]) {
      const run = await install(["--from", address, "--program-only"]);
      expect([address, run.code]).toEqual([address, 1]);
      expect(run.out).toContain("must be a plain address");
    }
    expect(release.asked).toEqual([]);
  });

  test("for an https address, curl is told to use https only, also after a redirect, and every download has a deadline and is tried again", async () => {
    // A real https server is not at hand, so a stand-in for curl writes down
    // what it is given, one argument to a line and an empty line after them,
    // and answers from a folder.
    const dir = await folder("hx-fortress-install-curl-");
    const files = path.join(dir, "files");
    const stubs = path.join(dir, "stubs");
    const log = path.join(dir, "curl.log");
    await mkdir(files);
    await mkdir(stubs);
    await writeFile(
      path.join(stubs, "curl"),
      [
        "#!/bin/sh",
        `{ for argument in "$@"; do printf '%s\\n' "$argument"; done; printf '\\n'; } >> '${log}'`,
        'out=""',
        'address=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    -o) out="$2"; shift 2 ;;',
        '    https://*) address="$1"; shift ;;',
        "    *) shift ;;",
        "  esac",
        "done",
        `file='${files}'/"\${address##*/}"`,
        '[ -n "$address" ] && [ -f "$file" ] || exit 22',
        'if [ "$out" = "-" ]; then cat "$file"; else cp "$file" "$out"; fi',
        "",
      ].join("\n"),
    );
    await chmod(path.join(stubs, "curl"), 0o755);
    const bytes = program(BOTH);
    await writeFile(path.join(files, `${ASSET}.gz`), gzipSync(bytes));
    await writeFile(path.join(files, `${ASSET}.sha256`), `${sha256(bytes)}  ${ASSET}\n`);
    await writeFile(path.join(files, "hx-fortress-version"), "9.8.7\n");

    const from = "https://updates.example/hx-fortress";
    const run = await install(["--from", from, "--program-only"], {
      env: { PATH: `${stubs}:${process.env.PATH ?? ""}` },
    });
    expect(run.code).toBe(0);
    expect((await readFile(run.installed)).equals(bytes)).toBe(true);
    expect(run.out).toContain(`The program hx-fortress 9.8.7 is at ${run.installed}`);

    const calls = (await readFile(log, "utf8"))
      .split("\n\n")
      .filter((call) => call.trim() !== "")
      .map((call) => call.split("\n").filter((argument) => argument !== ""));
    expect(calls.map((call) => call.find((argument) => argument.startsWith("https://")))).toEqual([
      `${from}/${ASSET}.gz`,
      `${from}/${ASSET}.sha256`,
      `${from}/hx-fortress-version`,
    ]);
    for (const call of calls) {
      const after = (option: string): string | undefined => {
        const at = call.indexOf(option);
        return at < 0 ? undefined : call[at + 1];
      };
      expect(after("--proto")).toBe("=https");
      expect(after("--proto-redir")).toBe("=https");
      expect(call).toContain("--tlsv1.2");
      for (const option of ["--retry", "--connect-timeout", "--max-time"]) {
        expect([option, Number(after(option)) > 0]).toEqual([option, true]);
      }
    }
  });

  test("in the script's text, every download goes through the one curl line, with a deadline and retries, and https only for an https address", async () => {
    const text = await readFile(SCRIPT, "utf8");
    const code = text.split("\n").filter((line) => !line.trimStart().startsWith("#"));
    // curl is run in one place.
    const curls = code.filter((line) => /(^|[\s;&|(])curl\s+-/.test(line));
    expect(curls).toHaveLength(1);
    const curl = curls[0] as string;
    expect(curl).toMatch(/--retry \d+/);
    expect(curl).toMatch(/--connect-timeout \d+/);
    expect(curl).toContain("--max-time ");
    expect(curl).toContain("$protocols");
    // That place is the function every download goes through, and each
    // download names its deadline.
    expect(code.some((line) => line.trim() === "download() {")).toBe(true);
    const downloads = code.filter((line) => /\bdownload "/.test(line));
    expect(downloads.length).toBeGreaterThanOrEqual(3);
    for (const line of downloads) expect(line).toMatch(/\bdownload "[^"]+" (?:"[^"]+"|-) [1-9]\d*\b/);
    // For an https address: https only, also after a redirect.
    const https = code.find((line) => line.trim().startsWith("https://*) protocols=")) ?? "";
    expect(https).toContain("--proto =https ");
    expect(https).toContain("--proto-redir =https");
    // For an address on this computer itself, which may be http: a redirect
    // is still followed only to https.
    const local = code.find((line) => line.trim().startsWith("*) protocols=")) ?? "";
    expect(local).toContain("--proto =http,https");
    expect(local).toContain("--proto-redir =https");
    // No download leaves the protocols to curl's own defaults.
    expect(code.filter((line) => /protocols=/.test(line))).toHaveLength(2);
  });

  test("a redirect from a release on this computer to an address in clear text is not followed, and nothing is put in place", async () => {
    // The release is served from this computer over http, which is the one
    // address in clear text the script takes. What that address answers must
    // not send the request on in clear text: here the program's file answers
    // with a redirect to another http address.
    const earlier = earlierAt("9.8.6");
    publish(program(BOTH, "9.8.7"));
    const origin = new URL(base).origin;
    release.redirects = new Map([[`${ASSET}.gz`, `${origin}/elsewhere/${ASSET}.gz`]]);
    release.files.set(`/elsewhere/${ASSET}.gz`, release.files.get(`${ASSET}.gz`) as Buffer);
    const run = await install(["--from", base, "--program-only"], { earlier });
    expect(run.code).toBe(1);
    expect(run.out).toContain(`could not download ${base}/${ASSET}.gz`);
    // The address the redirect named was never asked.
    expect(release.asked).toEqual([`${ASSET}.gz`]);
    await expectUntouched(run, earlier);
  });

  test("its default is the project's releases, and it holds no control plane's address", async () => {
    const text = await readFile(SCRIPT, "utf8");
    expect(text).toContain('PROJECT_RELEASES="https://github.com/HX-Framework/hx-fortress/releases/latest/download"');
    expect(text).not.toMatch(/wss?:\/\//);
    expect(text).not.toContain("vault-tunnel");
  });

  // A program that is already on this computer is asked for its version, and
  // the address for its own, before anything is put in place. HX Fortress may
  // be running from that program, on a database a newer version has changed.
  describe("never an older program over a newer one", () => {
    test("a release older than the program here is refused, and the program here stays as it was", async () => {
      const earlier = earlierAt("1.3.0");
      for (const args of [["--from", base], ["--from", base, "--program-only"]]) {
        publish(program(BOTH), { version: "1.2.3" });
        const run = await install(args, { earlier });
        expect([args, run.code]).toEqual([args, 1]);
        expect(run.out).toContain(
          `the program at ${run.installed} is version 1.3.0, and ${base} holds the older version 1.2.3. ` +
            `Nothing was put in place. To put the older one in place all the same, remove ${run.installed} first.`,
        );
        expect(run.out).not.toContain("ran with");
        await expectUntouched(run, earlier);
        // The version file was asked once, after the program's two files.
        expect(release.asked).toEqual([`${ASSET}.gz`, `${ASSET}.sha256`, "hx-fortress-version"]);
      }
    });

    test("the same version, and a newer one, replace the program here", async () => {
      for (const [here, there, args] of [
        ["1.2.3", "1.2.3", ["--program-only"]],
        ["1.2.3", "1.2.4", ["--program-only"]],
        ["1.2.3", "2.0.0", []],
      ] as const) {
        const bytes = program(BOTH, there);
        const earlier = earlierAt(here);
        publish(bytes, { version: there });
        const run = await install(["--from", base, ...args], { earlier });
        expect([here, there, run.code]).toEqual([here, there, 0]);
        expect((await readFile(run.installed)).equals(bytes)).toBe(true);
        expect(await inFolder(run.bin)).toEqual(["hx-fortress"]);
        // A new file took the program's name: a program that runs from the
        // earlier one keeps the file it started from.
        expect(run.held?.equals(earlier)).toBe(true);
        expect(run.out).toContain(`The program hx-fortress ${there} is at ${run.installed}`);
        if (args.length === 0) expect(run.out).toContain(ranWith("install"));
      }
    });

    test("versions are compared as numbers, not as text", async () => {
      // As text, 0.10.0 comes before 0.9.9, and 10.0.0 before 9.99.99.
      for (const [here, there, replaced] of [
        ["0.9.9", "0.10.0", true],
        ["0.10.0", "0.9.9", false],
        ["1.2.10", "1.2.9", false],
        ["9.99.99", "10.0.0", true],
      ] as const) {
        const bytes = program(BOTH, there);
        const earlier = earlierAt(here);
        publish(bytes, { version: there });
        const run = await install(["--from", base, "--program-only"], { earlier });
        expect([here, there, run.code]).toEqual([here, there, replaced ? 0 : 1]);
        expect((await readFile(run.installed)).equals(replaced ? bytes : earlier)).toBe(true);
        expect(await inFolder(run.bin)).toEqual(["hx-fortress"]);
      }
    });

    test("a program here that does not answer with a version is replaced, as before", async () => {
      for (const [what, earlier] of [
        // A version from before the command answers with its help.
        ["answers with its help", EARLIER],
        ["fails", Buffer.from("#!/bin/sh\necho 'something went wrong' >&2\nexit 3\n")],
        ["answers with a version that is not three numbers", earlierAt("9.9.9-rc.1")],
      ] as const) {
        const bytes = program(BOTH);
        publish(bytes, { version: "1.2.3" });
        const run = await install(["--from", base, "--program-only"], { earlier });
        expect([what, run.code]).toEqual([what, 0]);
        expect([what, (await readFile(run.installed)).equals(bytes)]).toEqual([what, true]);
        expect(await inFolder(run.bin)).toEqual(["hx-fortress"]);
      }
    });

    test("a release that does not state a plain version is refused when the program here states its own, and the program here stays as it was", async () => {
      // The program here says its version, so this run updates it, and it is
      // held to the rule of `hx-fortress update`: a source that does not say
      // which version it holds could be an older one.
      for (const version of [null, "1.0.0-rc.1", "<html>Sign in</html>"]) {
        const earlier = earlierAt("9.9.9");
        publish(program(BOTH, "9.9.10"), { version });
        const run = await install(["--from", base, "--program-only"], { earlier });
        expect([version, run.code]).toEqual([version, 1]);
        expect(run.out).toContain(
          `the program at ${run.installed} is version 9.9.9, and ${base}/hx-fortress-version does not state a ` +
            "version such as 1.2.3, so it cannot be told whether this would go back to an older one. Nothing was " +
            `put in place. To put it in place all the same, remove ${run.installed} first.`,
        );
        await expectUntouched(run, earlier);
        expect(run.held?.equals(earlier)).toBe(true);
        // The address is asked for its version once.
        expect([version, release.asked.filter((name) => name === "hx-fortress-version")]).toEqual([
          version,
          ["hx-fortress-version"],
        ]);
      }
    });

    test("with no program here, a release that does not state its version is installed: there is nothing it could go back from", async () => {
      const bytes = program(BOTH, "9.9.10");
      publish(bytes, { version: null });
      const run = await install(["--from", base, "--program-only"]);
      expect(run.code).toBe(0);
      expect((await readFile(run.installed)).equals(bytes)).toBe(true);
    });
  });
});

// The script that builds from a checkout. A copy of it runs in a folder of its
// own, with a stand-in for Bun that writes down every time it is run and
// "builds" the stand-in program there: so nothing is built, nothing is
// downloaded, and this checkout is not touched.
describe("install-from-source.sh", () => {
  const BUILT = program(`${BOTH}\n  hx-fortress enroll [token] --cloud <address>`);

  interface SourceRun {
    code: number;
    out: string;
    dir: string;
    bin: string;
    installed: string;
    /** What the stand-in for Bun was run with, one run to a line. */
    bun: string[];
    /** With an earlier program: what a program that runs from it reads from
     *  its file after the run. */
    held: Buffer | null;
  }

  /** Runs the copy of the script. Its folder for the program is named by
   *  HX_FORTRESS_BIN_DIR unless `dirBy` says otherwise. With `line`, that line
   *  of package.json is run in the copy's folder, with the arguments after it,
   *  as `bun run <name> <arguments>` runs it. */
  async function fromSource(
    args: readonly string[],
    options: {
      dirBy?: "option" | "environment" | "none";
      withHome?: boolean;
      earlier?: Buffer;
      line?: string;
      /** False: no Bun on this computer. The script then finds none on its PATH. */
      withBun?: boolean;
    } = {},
  ): Promise<SourceRun> {
    const dir = await folder("hx-fortress-from-source-");
    const checkout = path.join(dir, "checkout");
    const stubs = path.join(dir, "stubs");
    const marks = path.join(dir, "bun-ran");
    const bin = path.join(dir, "bin");
    const installed = path.join(bin, "hx-fortress");
    await mkdir(checkout, { recursive: true });
    await mkdir(stubs, { recursive: true });
    await copyFile(SOURCE_SCRIPT, path.join(checkout, "install-from-source.sh"));
    await writeFile(path.join(checkout, "program"), BUILT);
    // `bun install` does nothing, and `bun run build` puts the program where a
    // build does. Each run leaves a mark.
    await writeFile(
      path.join(stubs, "bun"),
      `#!/bin/sh\nprintf '%s\\n' "bun $*" >> '${marks}'\n` +
        'if [ "$1" = "run" ]; then mkdir -p dist && cp program dist/hx-fortress && chmod 755 dist/hx-fortress; fi\n',
    );
    await chmod(path.join(stubs, "bun"), 0o755);
    // With no Bun, the script could go on to download Bun's installer. A
    // stand-in for curl makes sure that no run of this test reaches the
    // network: it leaves a mark and fails.
    const noBun = path.join(dir, "no-bun");
    if (options.withBun === false) {
      await mkdir(noBun, { recursive: true });
      await writeFile(path.join(noBun, "curl"), `#!/bin/sh\nprintf 'curl %s\\n' "$*" >> '${marks}'\nexit 7\n`);
      await chmod(path.join(noBun, "curl"), 0o755);
    }
    const held = options.earlier ? await putEarlier(installed, options.earlier) : null;
    const dirBy = options.dirBy ?? "environment";
    const argv =
      options.line === undefined
        ? ["sh", path.join(checkout, "install-from-source.sh"), ...(dirBy === "option" ? ["--dir", bin] : []), ...args]
        : ["sh", "-c", `${options.line} "$@"`, "sh", ...args];
    const child = Bun.spawn(argv, {
      cwd: checkout,
      env: {
        // With no Bun: the system's own folders only, which hold none.
        PATH: options.withBun === false ? `${noBun}:/usr/bin:/bin` : `${stubs}:${process.env.PATH ?? ""}`,
        ...(options.withHome === false ? {} : { HOME: dir }),
        ...(dirBy === "environment" ? { HX_FORTRESS_BIN_DIR: bin } : {}),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const code = await child.exited;
    const bun = await readFile(marks, "utf8").then(
      (text) => text.split("\n").filter(Boolean),
      () => [],
    );
    return { code, out: out + err, dir, bin, installed, bun, held: held ? await held() : null };
  }

  test("it builds, puts the program in place and runs the install command, as the release's script does", async () => {
    const run = await fromSource([]);
    expect(run.code).toBe(0);
    expect(run.bun).toEqual(["bun install", "bun run build"]);
    expect(run.out).toContain(`The program hx-fortress is at ${run.installed}`);
    expect((await stat(run.installed)).mode & 0o777).toBe(0o755);
    expect(run.out).toContain(ranWith("install"));
  });

  test("the program it builds replaces the one that was here, and no new copy is left beside it", async () => {
    const run = await fromSource(["--program-only"], { earlier: EARLIER });
    expect(run.code).toBe(0);
    expect((await readFile(run.installed)).equals(BUILT)).toBe(true);
    expect(await inFolder(run.bin)).toEqual(["hx-fortress"]);
    // A new file took the program's name: a program that runs from the
    // earlier one keeps the file it started from.
    expect(run.held?.equals(EARLIER)).toBe(true);
  });

  test("the options of a control plane's command go to that command, and --on-this-machine runs the setup", async () => {
    const install = await fromSource(["--connect", "control.example/i/abc", "--pages", "https://app.control.example"]);
    expect(install.out).toContain(ranWith("install", "--connect", "control.example/i/abc", "--pages", "https://app.control.example"));
    const setup = await fromSource(["--on-this-machine", "--connect", "control.example/i/abc"]);
    expect(setup.out).toContain(ranWith("setup", "--connect", "control.example/i/abc"));
  });

  test("every option of each command goes on to it in the order it was written, and a -- is left out", async () => {
    for (const [command, own] of [
      ["install", []],
      ["setup", ["--on-this-machine"]],
    ] as const) {
      const options = everyOption(command);
      const run = await fromSource(["--", ...own, ...options]);
      expect([command, run.code]).toEqual([command, 0]);
      expect(run.out).toContain(ranWith(command, ...options));
    }
  });

  test("an option the command does not take, a stray word, and an option with no value are refused before Bun is run", async () => {
    for (const [args, code, words] of [
      [
        ["--form", "https://updates.example/hx-fortress"],
        2,
        '"--form" is not an option of this script, and hx-fortress install does not take it either.',
      ],
      [["--connect", "control.example/i/abc", "control.example/i/def"], 2, '"control.example/i/def" is not an option'],
      [["--on-this-machine", "--terminal"], 2, '"--terminal" is not an option of this script, and hx-fortress setup'],
      [["--browser"], 2, '"--browser" is not an option of this script, and hx-fortress install'],
      [["--file"], 1, "the option --file needs a value after it. Nothing was built."],
      [["--file", "--list"], 1, "the option --file needs a value after it. Nothing was built."],
    ] as const) {
      const run = await fromSource(args, { earlier: EARLIER });
      expect([args, run.code, run.bun]).toEqual([args, code, []]);
      expect(run.out).toContain(words);
      expect(run.out).toContain("Nothing was built.");
      expect((await readFile(run.installed)).equals(EARLIER)).toBe(true);
    }
  });

  test("--dir is taken, also over HX_FORTRESS_BIN_DIR", async () => {
    const elsewhere = await folder("hx-fortress-from-source-dir-");
    const run = await fromSource(["--dir", elsewhere, "--program-only"]);
    expect(run.code).toBe(0);
    expect((await readFile(path.join(elsewhere, "hx-fortress"))).equals(BUILT)).toBe(true);
    await expect(stat(run.installed)).rejects.toThrow();
  });

  test("with HOME not set, --dir is enough, and without it the script says to name a folder before Bun is run", async () => {
    const byOption = await fromSource(["--program-only"], { dirBy: "option", withHome: false });
    expect(byOption.code).toBe(0);
    expect((await readFile(byOption.installed)).equals(BUILT)).toBe(true);

    const neither = await fromSource(["--program-only"], { dirBy: "none", withHome: false });
    expect(neither.code).toBe(1);
    expect(neither.out).toContain("HOME is not set, so there is no folder to put the program in. Name one with --dir.");
    expect(neither.bun).toEqual([]);
  });

  test("with HOME not set and no Bun on this computer, the script says what is missing in a sentence of its own, and asks nothing", async () => {
    // Bun's installer puts Bun under HOME. Without this check the script
    // asked whether to install Bun and then ended on the shell's own
    // "parameter not set".
    const run = await fromSource(["--program-only"], { dirBy: "option", withHome: false, withBun: false });
    expect(run.code).toBe(1);
    expect(run.out).toContain(
      "Bun is needed to build from the source, and it is not on this computer. Its installer needs HOME, which is " +
        "not set. Install Bun (https://bun.sh) or set HOME, and run this again.",
    );
    expect(run.out).not.toContain("Install Bun now?");
    expect(run.out).not.toContain("parameter not set");
    // Nothing was built, nothing was downloaded, and no folder was made.
    expect(run.bun).toEqual([]);
    expect(await readdir(run.dir).then((names) => names.includes("bin"))).toBe(false);
  });

  test("--program-only runs nothing, and says what to run", async () => {
    const run = await fromSource(["--program-only"]);
    expect(run.code).toBe(0);
    expect(run.out).not.toContain("ran with");
    expect(run.out).toContain(`${run.installed} install`);
    expect(run.out).toContain(`${run.installed} setup`);
  });

  test("--cloud enrolls with the control plane a person names, with a token or with none", async () => {
    const address = "wss://control.example/v1/connection";
    const withToken = await fromSource(["--cloud", address, "one-time-token"]);
    expect(withToken.code).toBe(0);
    expect(withToken.out).toContain(ranWith("enroll", "one-time-token", "--cloud", address));
    // The token may come first, as an earlier version of this script took it.
    const tokenFirst = await fromSource(["one-time-token", "--cloud", address]);
    expect(tokenFirst.out).toContain(ranWith("enroll", "one-time-token", "--cloud", address));
    const none = await fromSource(["--cloud", address]);
    expect(none.out).toContain(ranWith("enroll", "--cloud", address));
  });

  test("what cannot be meant is refused before anything is built", async () => {
    for (const args of [
      // --cloud with no address.
      ["--cloud"],
      ["--cloud", "wss://control.example/v1/connection", "token", "another"],
      ["--cloud", "wss://control.example/v1/connection", "--connect", "control.example/i/abc"],
      ["--cloud", "wss://control.example/v1/connection", "--on-this-machine"],
      ["--program-only", "--connect", "control.example/i/abc"],
      ["--program-only", "--on-this-machine"],
    ]) {
      const run = await fromSource(args);
      expect([args, run.code, run.bun]).toEqual([args, 2, []]);
      expect(run.out).toContain("usage: ./install-from-source.sh");
    }
  });

  test("package.json runs the script, and runs it with --cloud to enroll, so an address must follow", async () => {
    const scripts = (JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    }).scripts;
    const address = "wss://control.example/v1/connection";

    const enroll = await fromSource([address], { line: scripts["install:enroll"] });
    expect(enroll.code).toBe(0);
    expect(enroll.out).toContain(ranWith("enroll", "--cloud", address));

    const noAddress = await fromSource([], { line: scripts["install:enroll"] });
    expect([noAddress.code, noAddress.bun]).toEqual([2, []]);
    expect(noAddress.out).toContain("usage: ./install-from-source.sh");

    const plain = await fromSource([], { line: scripts["install:from-source"] });
    expect(plain.code).toBe(0);
    expect(plain.out).toContain(ranWith("install"));
  });

  test("it holds no address of a control plane, and no default one", async () => {
    const text = await readFile(SOURCE_SCRIPT, "utf8");
    expect(text).not.toMatch(/wss?:\/\//);
    expect(text).not.toContain("DEFAULT_CLOUD_URL");
  });
});
