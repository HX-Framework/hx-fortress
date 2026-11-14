// Modules, releases and asks, as a terminal or a console page reads and decides
// them.
//
// Plain functions over files, on purpose. Neither the terminal nor the console
// is the daemon, and neither should need one to answer "what is switched on"
// or "what waits for approval": everything here is read from config.json, the
// daemon's published status, the release shelf and the catalog compiled into
// this binary. The functions that CHANGE something write a request for the
// daemon — the switch in config.json, a release decision — and signal it.
//
// The caller records the act. A terminal wraps these in its own audit pair, a
// console in its own; these functions do not write to the trail themselves, so
// a decision is recorded once, by the surface the person used.

import { readFile } from "node:fs/promises";

import { signalDaemon } from "../console/witness-signal";
import { STATUS_STALE_MS } from "../daemon-state";
import { FileStatusReader } from "../status-reader";
import { FORTRESS_VERSION } from "../version";
import { ModuleSwitchRefused, readEnabledModules, setModuleEnabled } from "./config";
import { MODULE_CATALOG, type CatalogEntry } from "./module-catalog";
import { isModuleId, type ReleaseRecord } from "./module-contract";
import type { fortressPaths } from "./paths";
import { writePrivateJson } from "./private-json";
import { listedReleaseHosts, RELEASE_MAX_BYTES, controlPlaneOriginOf } from "./release-fetch";
import {
  clearReleaseAnswer,
  readReleaseAnswer,
  withdrawReleaseDecision,
  writeReleaseDecision,
  type ReleaseDecisionAnswer,
} from "./release-intents";
import { installedVersions, readReleaseShelf, RELEASE_ID_PATTERN } from "./release-shelf";
import { describeShape, type Shape } from "./shape";
import type { ModuleState } from "./types";

type FortressPaths = ReturnType<typeof fortressPaths>;

/** One thing the control plane may ask, in words. */
export interface AskView {
  module: string;
  name: string;
  /** What the control plane sends, in words on one line. */
  args: string;
  /** Everything the answer can hold, in words on one line. */
  reply: string;
  /** The same two as data, for a page that lays them out itself. */
  argsShape: Shape;
  replyShape: Shape;
}

export interface ModuleView {
  id: string;
  title: string;
  summary: string;
  /** The switch, from config.json. */
  on: boolean;
  /** True when the daemon reads this switch only when it starts, so a change
   *  takes a restart. */
  startOnly: boolean;
  /** What a running daemon last published about it. `stopped` when the daemon
   *  does not list it, and for every module when no daemon is running. A module
   *  that is on and `failed` did not start. */
  state: ModuleState;
  /** Its last installed release, or the Fortress version it shipped in. */
  version: string;
  /** False for a module with no manifest. Such a module is held to no list of
   *  asks, hosts or secrets, so the three lists below are empty because nothing
   *  is declared, and NOT because the module calls nothing and reads nothing. */
  declared: boolean;
  asks: AskView[];
  /** Hosts it may call. */
  egress: string[];
  /** Names of the secrets it may read. Names only. */
  secrets: string[];
}

export interface ModulesApiOptions {
  catalog?: readonly CatalogEntry[];
  version?: string;
  now?: () => Date;
}

// ── The daemon, as its status file shows it ──────────────────────────────────

interface PublishedStatus {
  pid: number;
  modules: Map<string, ModuleState>;
}

/**
 * What a daemon that is running NOW last published, or null.
 *
 * A status file outlives the daemon that wrote it. So the file must say the
 * daemon is up, and must have been written within the time the rest of this
 * program calls fresh (`STATUS_STALE_MS`, three missed heartbeats); otherwise
 * there is no daemon, whatever the file's last words were.
 *
 * Read with the one parser every reader of this file uses. A file that is
 * missing, torn or not a status file is no daemon.
 */
async function liveStatus(paths: FortressPaths, now: Date): Promise<PublishedStatus | null> {
  const snapshot = await new FileStatusReader(paths.status).read().catch(() => null);
  if (!snapshot) return null;
  const { host } = snapshot;
  if (host.state !== "starting" && host.state !== "running") return null;
  // A file with no write time is from a build that had no heartbeat, and no
  // such build has modules to switch. And a write time in the FUTURE is not
  // fresh: after a clock is set back, an old file would otherwise read as fresh
  // for as long as the step was, and its pid is the one a signal goes to.
  const written = host.writtenAt ? Date.parse(host.writtenAt) : Number.NaN;
  if (!Number.isFinite(written) || Math.abs(now.getTime() - written) > STATUS_STALE_MS) return null;
  return { pid: host.pid, modules: new Map(snapshot.modules.map((m) => [m.id, m.state])) };
}

/**
 * The pid of a daemon that is running NOW, or null.
 *
 * This is the pid a signal is sent to, which is why it has to be a live one:
 * signalling the pid of a daemon that died last week reaches whatever process
 * has that number today, and the signal used here ends a process that does not
 * expect it.
 */
export async function liveDaemonPid(
  paths: FortressPaths,
  now: Date = new Date(),
): Promise<number | null> {
  return (await liveStatus(paths, now))?.pid ?? null;
}

// ── Listing ──────────────────────────────────────────────────────────────────

function asksOf(entry: CatalogEntry): AskView[] {
  return (entry.manifest?.asks ?? []).map((ask) => ({
    module: entry.id,
    name: ask.name,
    args: describeShape(ask.args),
    reply: describeShape(ask.reply),
    argsShape: ask.args,
    replyShape: ask.reply,
  }));
}

/** Every module this build ships, with its switch, its state and what it may
 *  be asked. */
export async function listModules(
  paths: FortressPaths,
  options: ModulesApiOptions = {},
): Promise<ModuleView[]> {
  const catalog = options.catalog ?? MODULE_CATALOG;
  const [enabled, status, releases] = await Promise.all([
    // A file that cannot be read lists nothing as on: no ask is let through
    // while it lasts, and that is what this view is asked about.
    readEnabledModules(paths).then((ids) => ids ?? []),
    liveStatus(paths, (options.now ?? ((): Date => new Date()))()),
    listReleases(paths).catch(() => [] as ReleaseRecord[]),
  ]);
  const installed = installedVersions(releases);
  return catalog.map((entry) => ({
    id: entry.id,
    title: entry.title,
    summary: entry.summary,
    on: enabled.includes(entry.id),
    startOnly: entry.startOnly,
    state: status?.modules.get(entry.id) ?? "stopped",
    version: installed.get(entry.id) ?? options.version ?? FORTRESS_VERSION,
    declared: entry.manifest !== null,
    asks: asksOf(entry),
    egress: [...(entry.manifest?.egress ?? [])],
    secrets: [...(entry.manifest?.secrets ?? [])],
  }));
}

/** Everything the control plane may ask of this build, module by module. This
 *  is the whole list: an ask that is not on it is refused. */
export function listAsks(options: ModulesApiOptions = {}): AskView[] {
  return (options.catalog ?? MODULE_CATALOG).flatMap(asksOf);
}

// ── What the console's data-paths list states about modules ──────────────────

export interface ModuleDataPaths {
  /** The control plane's own origin, which a release file may be fetched from.
   *  Null before enrollment. */
  controlPlaneOrigin: string | null;
  /** Hosts the operator listed in FORTRESS_RELEASE_HOSTS. */
  releaseHosts: string[];
  /** Whose FORTRESS_RELEASE_HOSTS that is. `daemon`: the one the daemon was
   *  started with, which is the one that is enforced. `reader`: the process
   *  asking, because no daemon has started on this host yet. */
  releaseHostsFrom: "daemon" | "reader";
  /** The largest release file, in bytes. */
  releaseMaxBytes: number;
  /** The modules that are switched on. A module that is off answers nothing
   *  and calls nothing, so it is not a data path. */
  on: {
    id: string;
    /** Each ask the control plane may send it, and everything the answer can
     *  hold, in words. Empty for a module that takes no asks. */
    asks: { name: string; reply: string }[];
    /** Hosts the module may call. */
    egress: string[];
  }[];
}

/** What the daemon publishes about the settings it was started with. */
export interface ModuleSettings {
  schemaVersion: 1;
  /** FORTRESS_RELEASE_HOSTS as the DAEMON read it: the hosts it will fetch a
   *  release file from, besides the control plane's own origin. */
  releaseHosts: string[];
  writtenAt: string;
}

/** Written by the daemon when it starts. The daemon is the process that
 *  fetches, so its environment is the one that counts. */
export async function publishModuleSettings(
  paths: FortressPaths,
  env: Record<string, string | undefined>,
  now: Date = new Date(),
): Promise<void> {
  const settings: ModuleSettings = {
    schemaVersion: 1,
    releaseHosts: listedReleaseHosts(env),
    writtenAt: now.toISOString(),
  };
  await writePrivateJson(paths.moduleSettings, settings);
}

async function publishedReleaseHosts(paths: FortressPaths): Promise<string[] | null> {
  try {
    // The fortress's own file, never a path a caller supplies.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const raw = JSON.parse(await readFile(paths.moduleSettings, "utf8")) as Partial<ModuleSettings>;
    if (raw.schemaVersion !== 1 || !Array.isArray(raw.releaseHosts)) return null;
    return raw.releaseHosts.filter((host): host is string => typeof host === "string").slice(0, 64);
  } catch {
    return null;
  }
}

/**
 * The module data paths of this host as it is configured now: which modules are
 * switched on, what each may be asked, where each may call, and where a release
 * file may be fetched from.
 *
 * The hosts a release may be fetched from are the ones the DAEMON was started
 * with, read from the file it publishes. The caller may be another process (the
 * console, as its own service) with another environment, and a list taken from
 * that would describe a rule nobody enforces. `source.env` is used only where
 * no daemon has published anything yet.
 */
export async function moduleDataPaths(
  paths: FortressPaths,
  source: { cloudUrl: string | null; env: Record<string, string | undefined> },
  options: ModulesApiOptions = {},
): Promise<ModuleDataPaths> {
  const modules = await listModules(paths, options);
  const published = await publishedReleaseHosts(paths);
  return {
    controlPlaneOrigin: source.cloudUrl ? controlPlaneOriginOf(source.cloudUrl) : null,
    releaseHosts: published ?? listedReleaseHosts(source.env),
    releaseHostsFrom: published ? "daemon" : "reader",
    releaseMaxBytes: RELEASE_MAX_BYTES,
    on: modules
      .filter((module) => module.on)
      .map((module) => ({
        id: module.id,
        asks: module.asks.map((ask) => ({ name: ask.name, reply: ask.reply })),
        egress: module.egress,
      })),
  };
}

/** The release shelf, newest offer first. */
export function listReleases(paths: FortressPaths): Promise<ReleaseRecord[]> {
  return readReleaseShelf(paths);
}

// ── The switch ───────────────────────────────────────────────────────────────

export interface SwitchResult {
  changed: boolean;
  /** Whether a running daemon was told. False means there is none: the switch
   *  takes effect when the Fortress next starts. */
  daemonTold: boolean;
}

export interface DaemonSignalOptions {
  daemonPid?: () => Promise<number | null>;
  kill?: (pid: number, signal: NodeJS.Signals) => boolean;
  now?: () => Date;
}

async function daemonPid(paths: FortressPaths, options: DaemonSignalOptions): Promise<number | null> {
  if (options.daemonPid) return options.daemonPid();
  return liveDaemonPid(paths, (options.now ?? ((): Date => new Date()))());
}

async function tellDaemon(paths: FortressPaths, options: DaemonSignalOptions): Promise<boolean> {
  return signalDaemon(
    await daemonPid(paths, options),
    options.kill as typeof process.kill | undefined,
  );
}

/**
 * Switch a module on or off, and tell the daemon if one is running.
 *
 * Refuses an id this build does not ship: a switch for a module that is not
 * here would sit in config.json reading as a failure on every boot.
 */
export async function switchModule(
  paths: FortressPaths,
  moduleId: string,
  on: boolean,
  options: ModulesApiOptions & DaemonSignalOptions = {},
): Promise<SwitchResult> {
  const catalog = options.catalog ?? MODULE_CATALOG;
  if (!catalog.some((entry) => entry.id === moduleId)) {
    throw new ModuleSwitchRefused(
      `this build has no module named ${isModuleId(moduleId) ? moduleId : "that"}. ` +
        "Run `hx-fortress modules list` to see the ones it has.",
    );
  }
  const { changed } = await setModuleEnabled(paths, moduleId, on);
  const daemonTold = await tellDaemon(paths, options);
  return { changed, daemonTold };
}

// ── A release decision ───────────────────────────────────────────────────────

/** There is no daemon to carry the decision out. */
export class NoDaemon extends Error {
  constructor() {
    super(
      "the daemon is not running, and it is the only thing that can hand a release to its module. " +
        "Start it with `hx-fortress start`, then run this again.",
    );
    this.name = "NoDaemon";
  }
}

export interface DecideOptions extends DaemonSignalOptions {
  /** How long to wait for the daemon's answer, and how often to look. */
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The daemon's answer, or null when it has not answered within the wait. A
 *  null is not a refusal: the request is with the daemon, and `listReleases`
 *  shows where the release stands. */
export type DecisionOutcome = ReleaseDecisionAnswer | null;

async function decide(
  paths: FortressPaths,
  id: string,
  decision: "approve" | "refuse",
  decidedBy: string,
  options: DecideOptions,
): Promise<DecisionOutcome> {
  const now = options.now ?? ((): Date => new Date());
  if (!RELEASE_ID_PATTERN.test(id)) {
    return { requestId: "", ok: false, reason: "release_unknown", at: now().toISOString() };
  }
  const requestId = await writeReleaseDecision(paths, { id, decision, decidedBy }, now());
  if (!(await tellDaemon(paths, options))) {
    // Withdrawn, so it cannot be carried out later by a daemon somebody starts
    // tomorrow for another reason.
    await withdrawReleaseDecision(paths, requestId);
    throw new NoDaemon();
  }
  const waitMs = options.waitMs ?? 120_000;
  const pollMs = options.pollMs ?? 250;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let waited = 0; waited <= waitMs; waited += pollMs) {
    const answer = await readReleaseAnswer(paths, requestId);
    if (answer) {
      await clearReleaseAnswer(paths, requestId);
      return answer;
    }
    if (waited + pollMs > waitMs) break;
    await sleep(pollMs);
  }
  return null;
}

/**
 * Approve a waiting release: the daemon hands it to its module.
 *
 * `decidedBy` names the person, as the calling surface knows them. Throws
 * `NoDaemon` when nothing is running to carry it out.
 */
export function approveRelease(
  paths: FortressPaths,
  id: string,
  decidedBy: string,
  options: DecideOptions = {},
): Promise<DecisionOutcome> {
  return decide(paths, id, "approve", decidedBy, options);
}

/** Refuse a waiting release. It is never handed to its module. */
export function refuseRelease(
  paths: FortressPaths,
  id: string,
  decidedBy: string,
  options: DecideOptions = {},
): Promise<DecisionOutcome> {
  return decide(paths, id, "refuse", decidedBy, options);
}
