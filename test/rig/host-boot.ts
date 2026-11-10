// Boot the real daemon once, in a child process, against a loopback hub, and
// hand back everything it did: the frames it sent, the files it wrote and what
// it printed.
//
// The child gets an environment built here and nothing from the developer's
// shell. HOME and FORTRESS_ROOT are one temporary directory, so the daemon
// finds no existing fortress to adopt and writes only there.
//
// A boot must name an external database. Without one the daemon would download
// and start the embedded Postgres, which a unit test must never do. The tests
// name a loopback address nothing listens on: the daemon then starts with its
// database "retrying", which is a real state, and everything else runs.

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { fortressPaths } from "../../src/host/paths";
import type { HostBootReport, HostBootScenario } from "./host-boot-driver";

export type { HostBootReport, HostBootScenario } from "./host-boot-driver";

/** A database URL that names this host and a port nothing listens on. */
export const UNREACHABLE_DATABASE_URL = "postgresql://fortress@127.0.0.1:1/fortress";

const DRIVER = path.join(import.meta.dir, "host-boot-driver.ts");
const CHILD_DEADLINE_MS = 30_000;

export interface HostBootOptions {
  /** The daemon's whole environment, apart from HOME, FORTRESS_ROOT and PATH. */
  env: Record<string, string>;
  scenario?: HostBootScenario;
  /** Write files under the root before the daemon starts. */
  prepare?: (paths: ReturnType<typeof fortressPaths>) => Promise<void>;
}

export interface HostBoot {
  root: string;
  paths: ReturnType<typeof fortressPaths>;
  report: HostBootReport;
  /** What the child printed. The daemon logs to stdout when it has no terminal. */
  stdout: string;
  stderr: string;
  /**
   * Every place the daemon wrote `text`: the files under its root, by path
   * relative to the root, and "stdout" or "stderr". Empty when it wrote the
   * text nowhere, which is what a test asserts for a value that must stay in
   * memory.
   */
  whereWritten(text: string): Promise<string[]>;
  /** Parsed `<root>/runtime/status.json`, or null when the daemon wrote none. */
  status(): Promise<Record<string, unknown> | null>;
  cleanup(): Promise<void>;
}

/** Every regular file under `dir`, as a full path. */
async function filesUnder(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

export async function bootHost(options: HostBootOptions): Promise<HostBoot> {
  if (!options.env.FORTRESS_DATABASE_URL && !options.env.FORTRESS_DATABASE_URL_SECRET) {
    throw new Error(
      "a host boot in a test must name an external database (FORTRESS_DATABASE_URL or " +
        "FORTRESS_DATABASE_URL_SECRET), or the daemon would download and start the embedded Postgres",
    );
  }
  // The rig's own files (the scenario, which can hold the secrets a fake
  // vault serves, and the report) sit beside the root, never inside it. What
  // is under the root is then exactly what the daemon wrote.
  const work = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-boot-"));
  const root = path.join(work, "root");
  await mkdir(root, { mode: 0o700 });
  const paths = fortressPaths(root);
  const reportPath = path.join(work, "boot-report.json");
  const scenarioPath = path.join(work, "boot-scenario.json");
  await writeFile(scenarioPath, JSON.stringify(options.scenario ?? {}));
  await options.prepare?.(paths);

  const child = Bun.spawn([process.execPath, DRIVER, reportPath, scenarioPath], {
    // The temporary root, so Bun finds no `.env` file to load.
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      HOME: root,
      FORTRESS_ROOT: root,
      // If a mistake ever sent a boot down the embedded-Postgres path, the
      // download would fail at once instead of fetching anything.
      FORTRESS_PG_BINARIES_URL: "http://127.0.0.1:1/no-download-in-tests",
      ...options.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = setTimeout(() => child.kill(), CHILD_DEADLINE_MS);
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(deadline);

  let report: HostBootReport;
  try {
    report = JSON.parse(await readFile(reportPath, "utf8")) as HostBootReport;
  } catch {
    await rm(work, { recursive: true, force: true });
    throw new Error(`the boot driver wrote no report (exit ${child.exitCode}).\n${stderr}\n${stdout}`);
  }

  return {
    root,
    paths,
    report,
    stdout,
    stderr,
    whereWritten: async (text) => {
      const places: string[] = [];
      for (const file of await filesUnder(root)) {
        // Read as bytes, so a file that is not text is searched too.
        if ((await readFile(file)).includes(text)) places.push(path.relative(root, file));
      }
      if (stdout.includes(text)) places.push("stdout");
      if (stderr.includes(text)) places.push("stderr");
      return places;
    },
    status: async () => {
      try {
        return JSON.parse(await readFile(paths.status, "utf8")) as Record<string, unknown>;
      } catch {
        return null;
      }
    },
    cleanup: () => rm(work, { recursive: true, force: true }),
  };
}
