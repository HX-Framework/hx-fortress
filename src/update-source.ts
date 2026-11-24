// Where a new version of HX Fortress comes from.
//
// HX Fortress updates from the project's own releases, or from an address the
// organization names. It never updates through a control plane: what runs on
// this host is decided on this host, and an HX Fortress with no control plane
// updates exactly as one that has one.
//
// An update source is ONE base address. A release's files are found under it
// by name, and the names are the ones the project's release publishes:
//
//   <base>/hx-fortress-version                  the version, as text
//   <base>/hx-fortress-<os>-<arch>.gz           the program, gzipped
//   <base>/hx-fortress-<os>-<arch>.sha256       its checksum
//   <base>/hx-fortress-<os>-<arch>.sig          its signature, when the release is signed
//   <base>/pgvector-pg<major>-<platform>.tar.gz the pgvector files for the Postgres on this disk
//
// So an organization that keeps its own copy serves one release's files from
// one folder over https, and names that folder's address.
//
// The setting, in the order it is read:
//
//   FORTRESS_UPDATE_URL                         a base address, set on the host
//   config.json  "updates": { "from": "own-address", "address": "https://…" }
//   config.json  "updates": { "from": "project-releases" }      (also the default)
//
// A setting this file does not understand is refused by name. It is never read
// as "the default", because the default downloads from somewhere else.
//
// Three processes read it, and they may not share an environment: the daemon,
// a terminal where a person types `hx-fortress update`, and the console. An
// organization that sets FORTRESS_UPDATE_URL on the daemon's service has
// turned away from the default, and a terminal that does not have the variable
// must not go back to the default behind its back. So the daemon writes down
// what its environment names (src/host/daemon-environment.ts), and the other
// two go by it: see `effectiveUpdateSource`.

import { AS_ON_THE_WIRE, isCompressed, readBoundedBytes } from "./bounded-json";
import { parseUpdatesConfig, readConfigObject, updateBaseAddress } from "./host/config";
import { readDaemonEnvironment, type DaemonEnvironmentPaths, type Named } from "./host/daemon-environment";
import { followingHttpsRedirects } from "./https-redirects";
import { parseStableSemver } from "./version";

/** The project's releases: the files of the release that GitHub marks as the
 *  latest one. RELEASING.md says which release that is. */
export const PROJECT_RELEASES_URL =
  "https://github.com/HX-Framework/hx-fortress/releases/latest/download";

/** Where a person reads about the project's releases. Shown, never fetched. */
export const PROJECT_RELEASES_PAGE = "https://github.com/HX-Framework/hx-fortress/releases";

export const UPDATE_URL_ENV = "FORTRESS_UPDATE_URL";

export interface UpdateSource {
  /** Which of the two this is: the project's releases, or an address the
   *  organization names. */
  from: "project-releases" | "own-address";
  /** The base address, with no trailing slash. */
  base: string;
  /** Where the answer was read: the host's environment, config.json, or
   *  neither, which means the default. */
  setBy: "host" | "config" | "default";
  /** True when the environment that named it is the running daemon's, and not
   *  the one of the process that asks. */
  asTheDaemonRuns?: true;
}

export class UpdateSettingInvalid extends Error {
  /**
   * `where` is whose setting could not be followed: the environment (of the
   * process that asked, or of the daemon), or config.json. A setting of the
   * environment is the host's own to put right, and nothing the setup writes
   * changes it.
   */
  constructor(
    reason: string,
    readonly where: "environment" | "config",
  ) {
    super(`Invalid update settings: ${reason}`);
    this.name = "UpdateSettingInvalid";
  }
}

/**
 * Where new versions come from cannot be told from here.
 *
 * The daemon that last wrote down its environment had `FORTRESS_UPDATE_URL`
 * set, that daemon is not running now, and config.json and the default give
 * another address than the one it named. No setting is wrong. What is missing
 * is the knowledge whether the variable is still set where the daemon starts.
 * So this is not an `UpdateSettingInvalid`, and no caller words it as a
 * variable that cannot be understood:
 *
 *   - `hx-fortress update` downloads nothing and prints these words.
 *   - The setup shows what config.json holds, and says in a line what is not
 *     known. It pins nothing.
 *   - The console asks no address for a version, and shows these words.
 */
export class UpdateSourceNotKnown extends Error {
  constructor(
    /** The address that daemon's environment named, or null when what the
     *  variable held there was no address. */
    readonly lastNamed: string | null,
  ) {
    super(
      "Where new versions come from is not known. The daemon that last wrote down its environment " +
        (lastNamed
          ? `named ${lastNamed} in ${UPDATE_URL_ENV}`
          : `held a value in ${UPDATE_URL_ENV} that could not be understood`) +
        ", and that daemon is not running now, so it cannot be told from here whether the variable is " +
        `still set. Start HX Fortress, or give the address in ${UPDATE_URL_ENV} to the command you run`,
    );
    this.name = "UpdateSourceNotKnown";
  }
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What an environment names for FORTRESS_UPDATE_URL: nothing, a base address
 *  a download may start from, or why the value is not one. */
export function updateUrlNamedBy(env: Record<string, string | undefined>): Named<string> {
  // A constant of this file names the variable.
  // eslint-disable-next-line security/detect-object-injection
  const given = env[UPDATE_URL_ENV];
  if (given === undefined) return null;
  if (given.trim() === "") return { invalid: `${UPDATE_URL_ENV} is set and empty` };
  try {
    return { value: updateBaseAddress(given, UPDATE_URL_ENV) };
  } catch (error) {
    return { invalid: reasonOf(error) };
  }
}

/**
 * The update source that a parsed config.json and an environment name.
 *
 * `config` is config.json as parsed JSON, or null when there is none: an
 * HX Fortress that was never set up still updates from the project's releases.
 * The `updates` block is read by the config's own parser, so the host that
 * starts with the file and the update that reads it refuse the same blocks.
 */
export function resolveUpdateSource(
  config: Record<string, unknown> | null,
  env: Record<string, string | undefined>,
): UpdateSource {
  const named = updateUrlNamedBy(env);
  if (named && "invalid" in named) throw new UpdateSettingInvalid(named.invalid, "environment");
  if (named) return { from: "own-address", base: named.value, setBy: "host" };

  let updates: ReturnType<typeof parseUpdatesConfig>;
  try {
    updates = parseUpdatesConfig(config?.updates);
  } catch (error) {
    throw new UpdateSettingInvalid(`${reasonOf(error)} (in config.json)`, "config");
  }
  if (updates?.from === "own-address" && updates.address) {
    return { from: "own-address", base: updates.address, setBy: "config" };
  }
  return {
    from: "project-releases",
    base: PROJECT_RELEASES_URL,
    setBy: updates?.from === undefined ? "default" : "config",
  };
}

/**
 * Read config.json and resolve the update source it and `env` name.
 *
 * A missing config.json means the default. A config.json that exists and
 * cannot be read as settings is an error: guessing "the default" there would
 * download from a place the organization may have meant to turn away from.
 * The file is read by the config's own reader, so the setup and the update
 * cannot disagree about what counts as readable.
 */
export async function readUpdateSource(
  paths: { config: string },
  env: Record<string, string | undefined> = process.env,
): Promise<UpdateSource> {
  let config: Record<string, unknown> | null;
  try {
    config = await readConfigObject(paths);
  } catch (error) {
    // The config's own reader starts its sentence with these words, and this
    // error starts with its own.
    const why = reasonOf(error).replace(/^Invalid HX Fortress config: /, "");
    throw new UpdateSettingInvalid(`config.json cannot be read as settings (${why})`, "config");
  }
  return resolveUpdateSource(config, env);
}

/** One line for a person: where updates come from, and who said so. */
export function describeUpdateSource(source: UpdateSource): string {
  const where = source.from === "project-releases" ? `the project's releases, ${source.base}` : source.base;
  if (source.setBy === "host") {
    return source.asTheDaemonRuns
      ? `${where}, set by ${UPDATE_URL_ENV} in the environment HX Fortress runs with`
      : `${where}, set on this host by ${UPDATE_URL_ENV}`;
  }
  if (source.setBy === "config") return `${where}, set in config.json`;
  return where;
}

// ── A process that is not the daemon ─────────────────────────────────────────

export interface UpdateSourcePaths extends DaemonEnvironmentPaths {
  config: string;
}

/** The source a running daemon's environment names, or null when it names
 *  none. Throws where what it names cannot be understood. */
function followingTheDaemon(named: Named<unknown>): UpdateSource | null {
  if (named === null) return null;
  if ("invalid" in named) {
    throw new UpdateSettingInvalid(`${named.invalid} (in the environment HX Fortress runs with)`, "environment");
  }
  // Held to the same rule as when the daemon read it: the file is a file, and
  // this is an address a download will start from.
  let base: string;
  try {
    base = updateBaseAddress(String(named.value), UPDATE_URL_ENV);
  } catch (error) {
    throw new UpdateSettingInvalid(`${reasonOf(error)} (in the environment HX Fortress runs with)`, "environment");
  }
  return { from: "own-address", base, setBy: "host", asTheDaemonRuns: true };
}

/**
 * The update source for a command a person types in a terminal. `daemonPid`
 * is the process id of the daemon that runs now, or null when none does
 * (`liveDaemonPid`).
 *
 * In this order:
 *
 *   1. This process's own environment names an address. That is the address.
 *   2. A daemon runs, and its environment names one. This process follows it:
 *      the organization set it for this host, and this process simply does
 *      not have the variable.
 *   3. config.json, and then the default.
 *
 * One case is refused, with `UpdateSourceNotKnown`. The daemon that last
 * wrote down its environment had an address named there, that daemon does not
 * run now, and what this process works out is another address. The variable
 * may still be on the service, or it may have been taken away since, and
 * nothing here can tell which. Following the old address could download from
 * a place the organization gave up. Going on to config.json or the default
 * could download from the place it turned away from. So the person says
 * which: with the variable on this command, or by starting HX Fortress, which
 * writes down what its environment names now. (Another daemon may be running:
 * one whose own record could not be written. Its environment is not known
 * either, so the words do not say that nothing runs.)
 *
 * It throws UpdateSettingInvalid wherever a setting cannot be understood.
 */
export async function effectiveUpdateSource(
  paths: UpdateSourcePaths,
  env: Record<string, string | undefined>,
  daemonPid: number | null,
): Promise<UpdateSource> {
  // A constant of this file names the variable.
  // eslint-disable-next-line security/detect-object-injection
  if (env[UPDATE_URL_ENV] !== undefined) return readUpdateSource(paths, env);

  const daemon = await readDaemonEnvironment(paths, daemonPid);
  const named = daemon?.updateUrl ?? null;
  if (!daemon || named === null) return readUpdateSource(paths, env);

  if (daemon.running) return followingTheDaemon(named) as UpdateSource;

  const here = await readUpdateSource(paths, env);
  if ("value" in named && named.value === here.base) return here;
  throw new UpdateSourceNotKnown("value" in named && typeof named.value === "string" ? named.value : null);
}

/**
 * The update source of the HOST, for whatever describes it: the setup's
 * answers, the lists of addresses, the console's own pages.
 *
 * The daemon is what downloads for the host, so while a daemon runs, what its
 * environment names decides: its address when it names one, and config.json
 * and the default when it names none, whatever variable the process that asks
 * happens to have. A variable that only one terminal has is that terminal's
 * own: `hx-fortress update` typed there uses it (`effectiveUpdateSource`), and
 * nothing else on the host does.
 *
 * With no daemon running, nothing is known about the environment it will start
 * with, and this falls back to the rules of `effectiveUpdateSource`. So it
 * throws `UpdateSourceNotKnown` in the same case, and each caller says in its
 * own place what is not known: none of them shows a guess.
 */
export async function hostUpdateSource(
  paths: UpdateSourcePaths,
  env: Record<string, string | undefined>,
  daemonPid: number | null,
): Promise<UpdateSource> {
  const daemon = await readDaemonEnvironment(paths, daemonPid);
  if (daemon?.running) return followingTheDaemon(daemon.updateUrl) ?? readUpdateSource(paths, {});
  return effectiveUpdateSource(paths, env, daemonPid);
}

// ── The files that belong to this version ───────────────────────────────────

const PROJECT_RELEASE_OF = "https://github.com/HX-Framework/hx-fortress/releases/download";

/**
 * Where the files that belong to ONE version of the program are, in the order
 * to ask. The pgvector files are such files: they are built for the Postgres
 * this version runs, and signed with the keys this version carries. "The
 * latest release" is where the NEXT version comes from, and it stops holding
 * an older version's files the day a release moves to another Postgres or to
 * another signing key.
 *
 * For the project's releases: the release of this version, and then the build
 * of this version, which exists before a release is cut from it. For an
 * address the organization names: that address, which holds one release's
 * files, and it is the organization's to keep it at the version its hosts run.
 */
export function ownReleaseBases(source: UpdateSource, version: string): string[] {
  if (source.from === "own-address") return [source.base];
  return [`${PROJECT_RELEASE_OF}/releases/hx-fortress-${version}`, `${PROJECT_RELEASE_OF}/builds/hx-fortress-${version}`];
}

// ── The version a base address holds ────────────────────────────────────────

/** The one small file every release has: its version, as text. */
export const VERSION_FILE = "hx-fortress-version";

/** A version is a few characters. A longer answer is some other page, and no
 *  more of it is read. */
const VERSION_FILE_MAX_BYTES = 64;

export type PublishedVersion =
  | { state: "version"; version: string }
  /** The address answered, and what it sent is no version: `status` is its
   *  HTTP status. */
  | { state: "none"; status: number }
  | { state: "unreachable" };

/**
 * Ask a base address which version it holds.
 *
 * One reader for everything that asks: the update, the console's version
 * check and the setup's check. It has a deadline and a size limit, it takes
 * the answer as it is on the wire, and it follows a redirect as the download
 * itself does, only to https (src/https-redirects.ts): the project's releases
 * answer a file's address with one.
 */
export async function fetchPublishedVersion(
  base: string,
  options: { fetchImpl?: typeof fetch; timeoutMs: number; userAgent?: string },
): Promise<PublishedVersion> {
  const doFetch = followingHttpsRedirects(options.fetchImpl ?? fetch);
  try {
    const response = await doFetch(`${base.replace(/\/+$/, "")}/${VERSION_FILE}`, {
      ...AS_ON_THE_WIRE,
      headers: {
        ...AS_ON_THE_WIRE.headers,
        ...(options.userAgent ? { "User-Agent": options.userAgent } : {}),
      },
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok || isCompressed(response)) {
      await response.body?.cancel().catch(() => {});
      return { state: "none", status: response.status };
    }
    const body = await readBoundedBytes(response, VERSION_FILE_MAX_BYTES);
    if (body.state === "cut") return { state: "unreachable" };
    const version = body.state === "whole" ? parseStableSemver(body.bytes.toString("utf8")) : null;
    return version ? { state: "version", version: version.raw } : { state: "none", status: response.status };
  } catch {
    // A deadline, DNS, TLS, a host that is not there: one answer for all of
    // them, because the next step of whoever asked is the same.
    return { state: "unreachable" };
  }
}
