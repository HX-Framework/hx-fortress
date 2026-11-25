// A console for the Secure Data Island tests: the real server, over a temp
// folder of an HX Fortress, with the page files of this repository.
//
// The company, the people, the addresses and every password here are made up
// for the test run.

import { readdirSync } from "node:fs";
import { mkdtemp, mkdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { UiAssets } from "../../src/ui/assets";
import { loadIslandFiles, type IslandFiles } from "../../src/ui/island-files";
import { LiveIslandSettings } from "../../src/ui/island-settings";
import { UiRuntime } from "../../src/ui/runtime";
import { startUiServer, type UiServerCtx } from "../../src/ui/server";

/** The origin of the made-up control plane's pages. */
export const PAGES = "https://app.control.example";
/** The made-up organization. */
export const ORGANIZATION = "Northstar";

/** A stand-in for the console's own app shell: any file will do. */
const SHELL = path.join(import.meta.dir, "..", "..", "package.json");
/** The console's own fonts, which the styles of a Secure Data Island use. */
const FONTS = path.join(import.meta.dir, "..", "..", "ui", "public", "fonts");
const fonts = readdirSync(FONTS)
  .filter((name) => name.endsWith(".woff2"))
  .sort();
const assets: UiAssets = {
  mode: "disk",
  files: { "/index.html": SHELL, ...Object.fromEntries(fonts.map((name) => [`/fonts/${name}`, path.join(FONTS, name)])) },
  inlineScriptHashes: [],
  manifest: { hash: "c".repeat(64), files: 1 + fonts.length, bytes: 1 },
};

export interface IslandRigOptions {
  /** The origin that may frame a page. Null leaves the setting out. */
  pages?: string | null;
  /** False for an HX Fortress with no control plane, or one whose
   *  administrator cut the connection. */
  connected?: boolean;
  organization?: string | null;
  /** The environment the console is given. */
  env?: Record<string, string | undefined>;
  /** Leaves the door out, as on a build with no page files. */
  withoutDoor?: boolean;
}

export interface IslandRig {
  root: string;
  configFile: string;
  runtime: UiRuntime;
  files: IslandFiles;
  /** The address the console answers at, on this machine. */
  origin: string;
  /** What the settings' reader warned of, in order. */
  warnings: string[];
  /** Write config.json again, as a person's change would. */
  configure(options: IslandRigOptions): Promise<void>;
  cleanup(): Promise<void>;
}

/** A config.json as a setup writes one, with what a test asks for. */
export function configJson(options: IslandRigOptions = {}): string {
  const pages = options.pages === undefined ? PAGES : options.pages;
  const organization = options.organization === undefined ? ORGANIZATION : options.organization;
  return JSON.stringify({
    schemaVersion: 1,
    ...(options.connected === false ? {} : { cloud: { url: "wss://connect.control.example" } }),
    modules: { enabled: ["host", "databases"] },
    ...(organization === null ? {} : { organization: { name: organization } }),
    ...(pages === null ? {} : { controlPlane: { pages } }),
  });
}

/**
 * The file name of the module that a page file loads, or null when the page
 * is not written the one way a page of the folder is: two script tags, each on
 * a line of its own, the theme first and the page's own module second, with
 * no text in either. Read without a pattern for tags.
 */
export function moduleScriptOf(html: string): string | null {
  const START = '<script type="module" src="./';
  const END = '"></script>';
  const tags = html.split("\n").filter((line) => line.includes("<script"));
  const own = tags[1] ?? "";
  if (tags.length !== 2 || tags[0] !== '<script src="./theme.js"></script>') return null;
  if (html.split("<script").length !== 3 || !own.startsWith(START) || !own.endsWith(END)) return null;
  const name = own.slice(START.length, -END.length);
  return /^[a-z0-9-]+\.js$/.test(name) ? name : null;
}

let written = 0;
/**
 * Write a file the way HX Fortress writes config.json: to a file beside it,
 * then moved into place.
 *
 * Two writes inside one tick of the file system's clock, of the same size,
 * would look like one write to any reader that goes by a file's time. A
 * person's two changes are never that close, and a test's are, so each write
 * here gets a time of its own.
 */
export async function writeAsConfig(file: string, text: string): Promise<void> {
  const next = `${file}.${process.pid}.tmp`;
  await writeFile(next, text);
  written += 1;
  const at = new Date(Date.now() + written * 1000);
  await utimes(next, at, at);
  await rename(next, file);
}

/** The page files of this checkout, as the console loads them. */
export async function repositoryIslandFiles(): Promise<IslandFiles> {
  const files = await loadIslandFiles();
  if (!files) throw new Error("this checkout holds no Secure Data Island page files");
  return files;
}

export async function startIslandRig(options: IslandRigOptions = {}): Promise<IslandRig> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hx-island-"));
  const uiRoot = path.join(root, "ui");
  await mkdir(uiRoot, { recursive: true });
  const configFile = path.join(root, "config.json");
  await writeAsConfig(configFile, configJson(options));

  const files = await repositoryIslandFiles();
  const runtime = new UiRuntime({
    uiRoot,
    uiConfigFile: path.join(uiRoot, "ui.json"),
    cmdCredsDir: path.join(root, "cmd-creds"),
    env: {},
  });
  const warnings: string[] = [];
  const settings = new LiveIslandSettings(configFile, options.env ?? {}, (message) => warnings.push(message));
  const ctx: UiServerCtx = {
    assets,
    port: 0,
    runtime,
    ...(options.withoutDoor ? {} : { islands: { files, settings: () => settings.read() } }),
  };
  const server = startUiServer(ctx, "127.0.0.1");
  return {
    root,
    configFile,
    runtime,
    files,
    origin: `http://127.0.0.1:${server.port}`,
    warnings,
    configure: (next) => writeAsConfig(configFile, configJson(next)),
    cleanup: async () => {
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    },
  };
}
