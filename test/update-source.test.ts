// Where a new version comes from: the project's releases by default, or an
// address the organization names. Never an address worked out from a control
// plane's.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { publishDaemonEnvironment, type Named } from "../src/host/daemon-environment";
import { fortressPaths } from "../src/host/paths";
import { fetchRemoteFortressVersion, resetVersionCache } from "../src/ui/version-check";
import {
  PROJECT_RELEASES_URL,
  UpdateSettingInvalid,
  UpdateSourceNotKnown,
  describeUpdateSource,
  effectiveUpdateSource,
  fetchPublishedVersion,
  hostUpdateSource,
  ownReleaseBases,
  readUpdateSource,
  resolveUpdateSource,
  updateUrlNamedBy,
  type UpdateSource,
  type UpdateSourcePaths,
} from "../src/update-source";

const ENROLLED = {
  schemaVersion: 1,
  cloud: { url: "wss://control.example/_api/hx-gateway/vault-tunnel" },
  modules: { enabled: [] },
};

/** The address the daemon's service names, one config.json names, and one a
 *  person types in a terminal. Three, so a test can tell which one won. */
const MIRROR = "https://mirror.northstar.example/hx-fortress";
const OWN = "https://files.northstar.example/hx-fortress";
const TERMINAL = "https://terminal.northstar.example/hx-fortress";

/** The pid of the daemon that wrote the file, and of another one. */
const DAEMON = 4242;
const ANOTHER_DAEMON = 5151;

/** What a call threw. Fails the test when it did not throw. */
async function refusal(work: Promise<unknown>): Promise<UpdateSettingInvalid> {
  const outcome = await work.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  if (!("error" in outcome)) throw new Error(`expected a refusal, and it answered ${JSON.stringify(outcome.value)}`);
  expect(outcome.error).toBeInstanceOf(UpdateSettingInvalid);
  return outcome.error as UpdateSettingInvalid;
}

/** The refusal for a source that cannot be told: no setting is wrong. */
async function notKnown(work: Promise<unknown>): Promise<UpdateSourceNotKnown> {
  const outcome = await work.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  if (!("error" in outcome)) throw new Error(`expected a refusal, and it answered ${JSON.stringify(outcome.value)}`);
  expect(outcome.error).toBeInstanceOf(UpdateSourceNotKnown);
  // It is not worded, and not handled, as a setting that cannot be understood.
  expect(outcome.error).not.toBeInstanceOf(UpdateSettingInvalid);
  return outcome.error as UpdateSourceNotKnown;
}

describe("the update source", () => {
  test("with no setting it is the project's releases", () => {
    expect(resolveUpdateSource(null, {})).toEqual({
      from: "project-releases",
      base: PROJECT_RELEASES_URL,
      setBy: "default",
    });
    expect(PROJECT_RELEASES_URL).toBe("https://github.com/HX-Framework/hx-fortress/releases/latest/download");
  });

  test("a control plane's address changes nothing about it", () => {
    // HX Fortress is enrolled with a control plane, and still updates from the project.
    const source = resolveUpdateSource(ENROLLED, {});
    expect(source.base).toBe(PROJECT_RELEASES_URL);
    expect(source.base).not.toContain("control.example");
  });

  test("config.json can say project-releases in so many words", () => {
    expect(
      resolveUpdateSource({ updates: { from: "project-releases", install: "administrator-approves" } }, {}),
    ).toEqual({ from: "project-releases", base: PROJECT_RELEASES_URL, setBy: "config" });
    // `from` left out of the block reads as the default answer.
    expect(resolveUpdateSource({ updates: { install: "administrator-approves" } }, {}).from).toBe(
      "project-releases",
    );
  });

  test("config.json that says project-releases and still holds an address goes by what it says", () => {
    // An earlier setup wrote this pair when an address had been typed and the
    // project's releases were chosen after it. The statement decides.
    expect(
      resolveUpdateSource({ updates: { from: "project-releases", address: "https://files.northstar.example/x" } }, {}),
    ).toEqual({ from: "project-releases", base: PROJECT_RELEASES_URL, setBy: "config" });
  });

  test("config.json can name the organization's own address", () => {
    expect(
      resolveUpdateSource({ updates: { from: "own-address", address: "https://files.northstar.example/hx-fortress/" } }, {}),
    ).toEqual({ from: "own-address", base: "https://files.northstar.example/hx-fortress", setBy: "config" });
  });

  test("the host's variable wins over config.json", () => {
    const source = resolveUpdateSource(
      { updates: { from: "own-address", address: "https://files.northstar.example/a" } },
      { FORTRESS_UPDATE_URL: "https://mirror.northstar.example/b//" },
    );
    expect(source).toEqual({ from: "own-address", base: "https://mirror.northstar.example/b", setBy: "host" });
  });

  test("an address in clear text is refused, except to this host itself", () => {
    expect(() => resolveUpdateSource(null, { FORTRESS_UPDATE_URL: "http://files.northstar.example/x" })).toThrow(
      UpdateSettingInvalid,
    );
    expect(resolveUpdateSource(null, { FORTRESS_UPDATE_URL: "http://127.0.0.1:9000/x" }).base).toBe(
      "http://127.0.0.1:9000/x",
    );
  });

  test("an address that is more than an address is refused", () => {
    for (const address of [
      "https://user:secret@files.northstar.example/x",
      "https://files.northstar.example/x?token=1",
      "https://files.northstar.example/x#part",
      // A "?" or a "#" with nothing after it: a file's name would be written after it.
      "https://files.northstar.example/x?",
      "https://files.northstar.example/x#",
      "not an address",
    ]) {
      expect(() => resolveUpdateSource({ updates: { from: "own-address", address } }, {})).toThrow(
        UpdateSettingInvalid,
      );
    }
  });

  test("a refusal does not repeat a password that was written into the address", () => {
    let message = "";
    try {
      resolveUpdateSource(null, { FORTRESS_UPDATE_URL: "https://user:hunter2@files.northstar.example/x" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("FORTRESS_UPDATE_URL");
    expect(message).not.toContain("hunter2");
  });

  test("a setting it does not understand is refused by name, never read as the default", () => {
    const refused = (config: Record<string, unknown> | null, env: Record<string, string | undefined> = {}): string => {
      try {
        resolveUpdateSource(config, env);
      } catch (error) {
        expect(error).toBeInstanceOf(UpdateSettingInvalid);
        return (error as Error).message;
      }
      return "not refused";
    };
    expect(refused({ updates: { from: "own-registry" } })).toContain('"own-registry"');
    expect(refused({ updates: { from: "own-address" } })).toContain("updates.address");
    // An address with no `from` beside it: somebody named a place and did not
    // say that it is the one to use.
    expect(refused({ updates: { address: "https://files.northstar.example" } })).toContain(
      "updates.address is set, and updates.from does not say to use it",
    );
    expect(refused({ updates: "project-releases" })).toContain("must be an object");
    expect(refused(null, { FORTRESS_UPDATE_URL: "  " })).toContain("set and empty");
  });

  test("a refusal says whose setting it is: the environment's, or config.json's", () => {
    const whereOf = (config: Record<string, unknown> | null, env: Record<string, string | undefined>): string => {
      try {
        resolveUpdateSource(config, env);
      } catch (error) {
        return (error as UpdateSettingInvalid).where;
      }
      return "not refused";
    };
    expect(whereOf(null, { FORTRESS_UPDATE_URL: "http://files.northstar.example/x" })).toBe("environment");
    expect(whereOf(null, { FORTRESS_UPDATE_URL: "" })).toBe("environment");
    expect(whereOf({ updates: { from: "own-registry" } }, {})).toBe("config");
    expect(whereOf({ updates: { from: "own-address", address: "http://files.northstar.example/x" } }, {})).toBe("config");
  });
});

describe("one line for a person: where updates come from, and who said so", () => {
  test("the default names the project's releases and their address", () => {
    expect(describeUpdateSource(resolveUpdateSource(null, {}))).toBe(
      "the project's releases, https://github.com/HX-Framework/hx-fortress/releases/latest/download",
    );
  });

  test("config.json is named when it gave the answer", () => {
    expect(describeUpdateSource(resolveUpdateSource({ updates: { from: "own-address", address: OWN } }, {}))).toBe(
      `${OWN}, set in config.json`,
    );
    expect(describeUpdateSource(resolveUpdateSource({ updates: { from: "project-releases" } }, {}))).toBe(
      "the project's releases, https://github.com/HX-Framework/hx-fortress/releases/latest/download, set in config.json",
    );
  });

  test("the variable of this process is named as this host's", () => {
    expect(describeUpdateSource(resolveUpdateSource(null, { FORTRESS_UPDATE_URL: TERMINAL }))).toBe(
      `${TERMINAL}, set on this host by FORTRESS_UPDATE_URL`,
    );
  });

  test("the variable of the running daemon is named as the environment HX Fortress runs with", () => {
    expect(describeUpdateSource({ from: "own-address", base: MIRROR, setBy: "host", asTheDaemonRuns: true })).toBe(
      `${MIRROR}, set by FORTRESS_UPDATE_URL in the environment HX Fortress runs with`,
    );
  });
});

describe("what an environment names for FORTRESS_UPDATE_URL", () => {
  test("nothing, when the variable is not there", () => {
    expect(updateUrlNamedBy({})).toBeNull();
    expect(updateUrlNamedBy({ FORTRESS_ROOT: "/srv/hx-fortress" })).toBeNull();
  });

  test("an empty value is said to be empty, and is not taken for no value", () => {
    expect(updateUrlNamedBy({ FORTRESS_UPDATE_URL: "" })).toEqual({ invalid: "FORTRESS_UPDATE_URL is set and empty" });
    expect(updateUrlNamedBy({ FORTRESS_UPDATE_URL: "   " })).toEqual({ invalid: "FORTRESS_UPDATE_URL is set and empty" });
  });

  test("an address is kept as a base address, with no slash at its end", () => {
    expect(updateUrlNamedBy({ FORTRESS_UPDATE_URL: ` ${MIRROR}/// ` })).toEqual({ value: MIRROR });
    expect(updateUrlNamedBy({ FORTRESS_UPDATE_URL: "http://127.0.0.1:9000/hx/" })).toEqual({
      value: "http://127.0.0.1:9000/hx",
    });
  });

  test("http to another host than this one is refused", () => {
    const named = updateUrlNamedBy({ FORTRESS_UPDATE_URL: "http://mirror.northstar.example/hx" });
    expect(named !== null && "invalid" in named ? named.invalid : "not refused").toContain(
      "FORTRESS_UPDATE_URL must use https:",
    );
  });

  test("an address with a question mark or a hash in it is refused, also with nothing after them", () => {
    for (const value of [`${MIRROR}?channel=stable`, `${MIRROR}#part`, `${MIRROR}?`, `${MIRROR}#`]) {
      expect([value, updateUrlNamedBy({ FORTRESS_UPDATE_URL: value })]).toEqual([
        value,
        { invalid: 'FORTRESS_UPDATE_URL must be a plain address, with no "?" and no "#"' },
      ]);
    }
  });

  test("a user name or a password is refused, and the reason does not repeat them", () => {
    // Put together here, so that no password-shaped text is written in the file.
    const password = ["Tr0ub4dor", "and", "3"].join("-");
    const named = updateUrlNamedBy({ FORTRESS_UPDATE_URL: `https://updater:${password}@mirror.northstar.example/hx` });
    expect(named).toEqual({ invalid: "FORTRESS_UPDATE_URL must not hold a user name or a password" });
    expect(JSON.stringify(named)).not.toContain(password);
  });

  test("text that is no address is refused", () => {
    expect(updateUrlNamedBy({ FORTRESS_UPDATE_URL: "not an address" })).toEqual({
      invalid: "FORTRESS_UPDATE_URL must be a valid URL",
    });
  });
});

describe("the files of one version", () => {
  test("from the project's releases: the release of that version, and then its build", () => {
    const bases = [
      "https://github.com/HX-Framework/hx-fortress/releases/download/releases/hx-fortress-1.2.3",
      "https://github.com/HX-Framework/hx-fortress/releases/download/builds/hx-fortress-1.2.3",
    ];
    expect(ownReleaseBases(resolveUpdateSource(null, {}), "1.2.3")).toEqual(bases);
    expect(ownReleaseBases(resolveUpdateSource({ updates: { from: "project-releases" } }, {}), "1.2.3")).toEqual(bases);
    // The latest release is where the NEXT version comes from, not this one's files.
    expect(ownReleaseBases(resolveUpdateSource(null, {}), "1.2.3")).not.toContain(PROJECT_RELEASES_URL);
  });

  test("from an address the organization names: that address, whatever the version", () => {
    const own = resolveUpdateSource(null, { FORTRESS_UPDATE_URL: `${MIRROR}/` });
    expect(ownReleaseBases(own, "1.2.3")).toEqual([MIRROR]);
    expect(ownReleaseBases(own, "9.9.9")).toEqual([MIRROR]);
    expect(ownReleaseBases(resolveUpdateSource({ updates: { from: "own-address", address: OWN } }, {}), "1.2.3")).toEqual([OWN]);
  });
});

describe("reading the update source from an HX Fortress's folder", () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });
  const folder = async (config?: string): Promise<{ config: string }> => {
    dir = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-update-source-"));
    const file = path.join(dir, "config.json");
    if (config !== undefined) await writeFile(file, config);
    return { config: file };
  };

  test("an HX Fortress that was never set up updates from the project's releases", async () => {
    expect(await readUpdateSource(await folder(), {})).toEqual({
      from: "project-releases",
      base: PROJECT_RELEASES_URL,
      setBy: "default",
    });
  });

  test("it reads the updates block of config.json", async () => {
    const paths = await folder(
      JSON.stringify({ ...ENROLLED, updates: { from: "own-address", address: "https://files.northstar.example/a" } }),
    );
    expect((await readUpdateSource(paths, {})).base).toBe("https://files.northstar.example/a");
  });

  test("a config.json that cannot be read as an object is an error of config.json, not the default", async () => {
    for (const text of ["{ not json", "[]"]) {
      const error = await refusal(readUpdateSource(await folder(text), {}));
      expect(error.where).toBe("config");
    }
  });
});

// The daemon, a terminal and the console may each run with another
// environment. The daemon writes down what its environment names, and a
// command typed in a terminal goes by it while that daemon runs.
describe("a command typed in a terminal goes by the running daemon", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  /** An HX Fortress folder, with config.json when one is given. */
  async function hostFolder(config?: Record<string, unknown>): Promise<UpdateSourcePaths> {
    const root = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-update-daemon-"));
    dirs.push(root);
    const paths = fortressPaths(root);
    if (config !== undefined) await writeFile(paths.config, JSON.stringify(config));
    return paths;
  }

  /** What the daemon with this pid wrote down when it started. */
  async function daemonStarted(paths: UpdateSourcePaths, updateUrl: Named<unknown>, pid = DAEMON): Promise<void> {
    expect(await publishDaemonEnvironment(paths, { updateUrl, controlPlaneKey: null }, { pid })).toBe(true);
  }

  test("with no daemon and no setting it is the default, and with config.json it is config.json's", async () => {
    expect(await effectiveUpdateSource(await hostFolder(), {}, null)).toEqual({
      from: "project-releases",
      base: PROJECT_RELEASES_URL,
      setBy: "default",
    });
    const paths = await hostFolder({ updates: { from: "own-address", address: OWN } });
    expect(await effectiveUpdateSource(paths, {}, null)).toEqual({ from: "own-address", base: OWN, setBy: "config" });
  });

  test("the address a running daemon's environment names is followed by a terminal that has no variable", async () => {
    // config.json names another address: the daemon's environment comes first.
    const paths = await hostFolder({ updates: { from: "own-address", address: OWN } });
    await daemonStarted(paths, { value: MIRROR });
    const source = await effectiveUpdateSource(paths, {}, DAEMON);
    expect(source).toEqual({ from: "own-address", base: MIRROR, setBy: "host", asTheDaemonRuns: true });
    expect(describeUpdateSource(source)).toBe(
      `${MIRROR}, set by FORTRESS_UPDATE_URL in the environment HX Fortress runs with`,
    );
  });

  test("a running daemon whose environment names nothing leaves it to config.json, and then to the default", async () => {
    const paths = await hostFolder({ updates: { from: "own-address", address: OWN } });
    await daemonStarted(paths, null);
    expect(await effectiveUpdateSource(paths, {}, DAEMON)).toEqual({ from: "own-address", base: OWN, setBy: "config" });

    const bare = await hostFolder();
    await daemonStarted(bare, null);
    expect((await effectiveUpdateSource(bare, {}, DAEMON)).setBy).toBe("default");
  });

  test("the process's own variable wins over the running daemon's, a stopped daemon's and config.json", async () => {
    const paths = await hostFolder({ updates: { from: "own-address", address: OWN } });
    await daemonStarted(paths, { value: MIRROR });
    const own: UpdateSource = { from: "own-address", base: TERMINAL, setBy: "host" };
    // The daemon runs.
    expect(await effectiveUpdateSource(paths, { FORTRESS_UPDATE_URL: TERMINAL }, DAEMON)).toEqual(own);
    // It has stopped, and its address is not config.json's: refused without
    // the variable, and the variable settles it.
    expect(await effectiveUpdateSource(paths, { FORTRESS_UPDATE_URL: TERMINAL }, null)).toEqual(own);
    // Its environment held a value that cannot be understood.
    await daemonStarted(paths, { invalid: "FORTRESS_UPDATE_URL must use https:" });
    expect(await effectiveUpdateSource(paths, { FORTRESS_UPDATE_URL: TERMINAL }, DAEMON)).toEqual(own);
  });

  test("a wrong value of the process's own variable throws, whatever the daemon names", async () => {
    const paths = await hostFolder();
    await daemonStarted(paths, { value: MIRROR });
    for (const value of ["http://terminal.northstar.example/hx", "", "not an address"]) {
      const error = await refusal(effectiveUpdateSource(paths, { FORTRESS_UPDATE_URL: value }, DAEMON));
      expect([value, error.where]).toEqual([value, "environment"]);
    }
  });

  test("a value the running daemon's environment holds and that cannot be understood throws, and is not read as the default", async () => {
    const paths = await hostFolder();
    await daemonStarted(paths, { invalid: "FORTRESS_UPDATE_URL must use https: (cleartext http: is only allowed to a loopback host)" });
    const error = await refusal(effectiveUpdateSource(paths, {}, DAEMON));
    expect(error.where).toBe("environment");
    expect(error.message).toBe(
      "Invalid update settings: FORTRESS_UPDATE_URL must use https: (cleartext http: is only allowed to a loopback host) " +
        "(in the environment HX Fortress runs with)",
    );
  });

  test("the running daemon's address is held to the rule again: a file changed to a clear-text address is refused", async () => {
    const paths = await hostFolder();
    await mkdir(path.dirname(paths.daemonEnvironment), { recursive: true });
    await writeFile(
      paths.daemonEnvironment,
      JSON.stringify({
        schemaVersion: 1,
        pid: DAEMON,
        writtenAt: "2026-11-17T09:00:00.000Z",
        updateUrl: { value: "http://mirror.northstar.example/hx-fortress" },
        controlPlaneKey: null,
      }),
    );
    const error = await refusal(effectiveUpdateSource(paths, {}, DAEMON));
    expect(error.where).toBe("environment");
    expect(error.message).toContain("in the environment HX Fortress runs with");
  });

  test("refused: the daemon that named an address does not run now, and this command works out another one", async () => {
    // The variable may still be on the service, or it may have been taken
    // away. Neither the old address nor the default is taken.
    const paths = await hostFolder();
    await daemonStarted(paths, { value: MIRROR });
    const error = await notKnown(effectiveUpdateSource(paths, {}, null));
    expect(error.lastNamed).toBe(MIRROR);
    // The words say what is not known and the two ways out. They do not say
    // that a setting is wrong, and they do not say that nothing runs.
    expect(error.message).toBe(
      "Where new versions come from is not known. The daemon that last wrote down its environment named " +
        `${MIRROR} in FORTRESS_UPDATE_URL, and that daemon is not running now, so it cannot be told from here ` +
        "whether the variable is still set. Start HX Fortress, or give the address in FORTRESS_UPDATE_URL to " +
        "the command you run",
    );
    // A daemon runs, and the file is not its own: what that daemon runs with
    // is not known either.
    expect((await notKnown(effectiveUpdateSource(paths, {}, ANOTHER_DAEMON))).lastNamed).toBe(MIRROR);
    // config.json names a third address: still refused.
    await writeFile(paths.config, JSON.stringify({ updates: { from: "own-address", address: OWN } }));
    await notKnown(effectiveUpdateSource(paths, {}, null));
  });

  test("refused also when the stopped daemon's environment held a value that could not be understood", async () => {
    const paths = await hostFolder({ updates: { from: "own-address", address: OWN } });
    await daemonStarted(paths, { invalid: "FORTRESS_UPDATE_URL must use https:" });
    const error = await notKnown(effectiveUpdateSource(paths, {}, null));
    expect(error.lastNamed).toBeNull();
    expect(error.message).toStartWith(
      "Where new versions come from is not known. The daemon that last wrote down its environment held a value " +
        "in FORTRESS_UPDATE_URL that could not be understood, and that daemon is not running now,",
    );
  });

  test("not refused when the stopped daemon's address is the one config.json gives", async () => {
    const paths = await hostFolder({ updates: { from: "own-address", address: OWN } });
    await daemonStarted(paths, { value: OWN });
    expect(await effectiveUpdateSource(paths, {}, null)).toEqual({ from: "own-address", base: OWN, setBy: "config" });
    // The same when the daemon named the project's own address, and config.json names nothing.
    const bare = await hostFolder();
    await daemonStarted(bare, { value: PROJECT_RELEASES_URL });
    expect(await effectiveUpdateSource(bare, {}, null)).toEqual({
      from: "project-releases",
      base: PROJECT_RELEASES_URL,
      setBy: "default",
    });
  });

  test("a stopped daemon whose environment named nothing is never a reason to refuse", async () => {
    const paths = await hostFolder({ updates: { from: "own-address", address: OWN } });
    await daemonStarted(paths, null);
    expect(await effectiveUpdateSource(paths, {}, null)).toEqual({ from: "own-address", base: OWN, setBy: "config" });
    expect(await effectiveUpdateSource(paths, {}, ANOTHER_DAEMON)).toEqual({ from: "own-address", base: OWN, setBy: "config" });
  });

  test("a file that is not one this build wrote is the same as no file", async () => {
    const paths = await hostFolder({ updates: { from: "project-releases" } });
    await mkdir(path.dirname(paths.daemonEnvironment), { recursive: true });
    for (const text of [
      "{ not json",
      JSON.stringify({ schemaVersion: 2, pid: DAEMON, updateUrl: { value: MIRROR }, controlPlaneKey: null }),
      JSON.stringify({ schemaVersion: 1, pid: DAEMON, updateUrl: MIRROR, controlPlaneKey: null }),
    ]) {
      await writeFile(paths.daemonEnvironment, text);
      expect([text, (await effectiveUpdateSource(paths, {}, DAEMON)).setBy]).toEqual([text, "config"]);
      expect([text, (await effectiveUpdateSource(paths, {}, null)).setBy]).toEqual([text, "config"]);
    }
  });

  test("a config.json that cannot be read is said, also when a daemon has stopped", async () => {
    const paths = await hostFolder();
    await writeFile(paths.config, "{ not json");
    await daemonStarted(paths, { value: MIRROR });
    const error = await refusal(effectiveUpdateSource(paths, {}, null));
    expect(error.where).toBe("config");
    expect(error.message).toContain("malformed JSON");
  });
});

// Whatever describes the HOST (the setup's answers, the lists of addresses,
// the console) goes by what the running daemon goes by, and not by the
// variable of the process that asks.
describe("the update source of the host", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  async function hostFolder(config?: Record<string, unknown>): Promise<UpdateSourcePaths> {
    const root = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-update-host-"));
    dirs.push(root);
    const paths = fortressPaths(root);
    if (config !== undefined) await writeFile(paths.config, JSON.stringify(config));
    return paths;
  }
  async function daemonStarted(paths: UpdateSourcePaths, updateUrl: Named<unknown>, pid = DAEMON): Promise<void> {
    expect(await publishDaemonEnvironment(paths, { updateUrl, controlPlaneKey: null }, { pid })).toBe(true);
  }

  test("while a daemon runs, the address its environment names is the host's, whatever the caller's own variable says", async () => {
    const paths = await hostFolder({ updates: { from: "own-address", address: OWN } });
    await daemonStarted(paths, { value: MIRROR });
    const daemons: UpdateSource = { from: "own-address", base: MIRROR, setBy: "host", asTheDaemonRuns: true };
    expect(await hostUpdateSource(paths, {}, DAEMON)).toEqual(daemons);
    expect(await hostUpdateSource(paths, { FORTRESS_UPDATE_URL: TERMINAL }, DAEMON)).toEqual(daemons);
  });

  test("while a daemon runs that names none, config.json and then the default, and the caller's own variable is not looked at", async () => {
    const paths = await hostFolder({ updates: { from: "own-address", address: OWN } });
    await daemonStarted(paths, null);
    const configs: UpdateSource = { from: "own-address", base: OWN, setBy: "config" };
    expect(await hostUpdateSource(paths, { FORTRESS_UPDATE_URL: TERMINAL }, DAEMON)).toEqual(configs);
    // Not even a wrong one: it is that terminal's own, and nothing on the host goes by it.
    expect(await hostUpdateSource(paths, { FORTRESS_UPDATE_URL: "http://terminal.northstar.example/x" }, DAEMON)).toEqual(
      configs,
    );

    const bare = await hostFolder();
    await daemonStarted(bare, null);
    expect(await hostUpdateSource(bare, { FORTRESS_UPDATE_URL: TERMINAL }, DAEMON)).toEqual({
      from: "project-releases",
      base: PROJECT_RELEASES_URL,
      setBy: "default",
    });
  });

  test("while a daemon runs with a value it could not understand, that is said", async () => {
    const paths = await hostFolder();
    await daemonStarted(paths, { invalid: "FORTRESS_UPDATE_URL must use https:" });
    const error = await refusal(hostUpdateSource(paths, { FORTRESS_UPDATE_URL: TERMINAL }, DAEMON));
    expect(error.where).toBe("environment");
    expect(error.message).toContain("in the environment HX Fortress runs with");
  });

  test("with no daemon running it goes by the rules of a command typed in a terminal", async () => {
    const paths = await hostFolder({ updates: { from: "own-address", address: OWN } });
    // Nothing written down at all: config.json, or the caller's own variable.
    expect(await hostUpdateSource(paths, {}, null)).toEqual({ from: "own-address", base: OWN, setBy: "config" });
    expect(await hostUpdateSource(paths, { FORTRESS_UPDATE_URL: TERMINAL }, null)).toEqual({
      from: "own-address",
      base: TERMINAL,
      setBy: "host",
    });
    // A daemon that has stopped named another address: not known, as it is
    // for a terminal. What describes the host shows no guess.
    await daemonStarted(paths, { value: MIRROR });
    expect((await notKnown(hostUpdateSource(paths, {}, null))).lastNamed).toBe(MIRROR);
    // The file of a daemon that is not the one running now counts as a stopped one.
    await notKnown(hostUpdateSource(paths, {}, ANOTHER_DAEMON));
  });
});

describe("asking an address which version it holds", () => {
  interface Call {
    url: string;
    init: RequestInit & { decompress?: boolean };
  }
  /** A fetch that answers each request with `answer`, and keeps what it was asked. */
  function standIn(answer: (url: string, init: RequestInit) => Response | Promise<Response>): {
    fetchImpl: typeof fetch;
    calls: Call[];
  } {
    const calls: Call[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();
      calls.push({ url, init: init ?? {} });
      return answer(url, init ?? {});
    }) as typeof fetch;
    return { fetchImpl, calls };
  }
  const ask = (fetchImpl: typeof fetch, base = "https://updates.northstar.example/hx-fortress", timeoutMs = 5_000) =>
    fetchPublishedVersion(base, { fetchImpl, timeoutMs, userAgent: "hx-fortress/0.0.0-test" });

  test("a plain stable version is the version, read from <base>/hx-fortress-version", async () => {
    const { fetchImpl, calls } = standIn(() => new Response("1.2.3\n"));
    expect(await ask(fetchImpl, "https://updates.northstar.example/hx-fortress/")).toEqual({ state: "version", version: "1.2.3" });
    expect(calls.map((call) => call.url)).toEqual(["https://updates.northstar.example/hx-fortress/hx-fortress-version"]);
  });

  test("the request asks for the answer as it is on the wire, has a deadline, and says which program asks", async () => {
    const { fetchImpl, calls } = standIn(() => new Response("1.2.3"));
    await ask(fetchImpl);
    const init = calls[0]?.init;
    expect(init?.decompress).toBe(false);
    expect(new Headers(init?.headers).get("accept-encoding")).toBe("identity");
    expect(new Headers(init?.headers).get("user-agent")).toBe("hx-fortress/0.0.0-test");
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("a version of 64 bytes is read, one of 65 is no version", async () => {
    const exactly = `1.2.3${" ".repeat(59)}`;
    expect(Buffer.byteLength(exactly)).toBe(64);
    expect(await ask(standIn(() => new Response(exactly)).fetchImpl)).toEqual({ state: "version", version: "1.2.3" });
    expect(await ask(standIn(() => new Response(`${exactly} `)).fetchImpl)).toEqual({ state: "none", status: 200 });
  });

  test.each([
    ["a prerelease", () => new Response("0.1.2-rc.1\n"), 200],
    ["an HTML page", () => new Response("<html>1.2.3</html>", { headers: { "content-type": "text/html" } }), 200],
    ["no version file", () => new Response("Not Found", { status: 404 }), 404],
    ["an error of the address", () => new Response("1.2.3", { status: 503 }), 503],
    ["a compressed answer", () => new Response(gzipSync("1.2.3"), { headers: { "content-encoding": "gzip" } }), 200],
    ["an answer longer than 64 bytes", () => new Response(`1.2.3\n${"x".repeat(100)}`), 200],
  ])("%s is no version, and the address's status is kept", async (_name, answer, status) => {
    expect(await ask(standIn(answer).fetchImpl)).toEqual({ state: "none", status });
  });

  test("a request that fails is unreachable", async () => {
    const failing = standIn(() => {
      throw new TypeError("fetch failed");
    });
    expect(await ask(failing.fetchImpl)).toEqual({ state: "unreachable" });
  });

  test("an address that does not answer before the deadline is unreachable", async () => {
    // Answers only when the request is called off.
    const silent = standIn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    );
    const started = Date.now();
    expect(await ask(silent.fetchImpl, undefined, 50)).toEqual({ state: "unreachable" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("an answer that ends before it is whole is unreachable", async () => {
    let sent = false;
    const cut = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.error(new Error("the connection ended"));
          return;
        }
        sent = true;
        controller.enqueue(new TextEncoder().encode("1."));
      },
    });
    expect(await ask(standIn(() => new Response(cut)).fetchImpl)).toEqual({ state: "unreachable" });
  });

  test("a redirect to an https address is followed, with the same request", async () => {
    const stored = "https://objects.northstar.example/store/hx-fortress-version";
    const { fetchImpl, calls } = standIn((url) =>
      url === stored ? new Response("2.0.0") : new Response(null, { status: 302, headers: { location: stored } }),
    );
    expect(await ask(fetchImpl)).toEqual({ state: "version", version: "2.0.0" });
    expect(calls.map((call) => call.url)).toEqual(["https://updates.northstar.example/hx-fortress/hx-fortress-version", stored]);
    expect(new Headers(calls[1]?.init.headers).get("accept-encoding")).toBe("identity");
    expect(calls[1]?.init.decompress).toBe(false);
  });

  test("a redirect to plain http on another host is not followed, and the version is unreachable", async () => {
    const { fetchImpl, calls } = standIn(
      () => new Response(null, { status: 302, headers: { location: "http://objects.northstar.example/hx-fortress-version" } }),
    );
    expect(await ask(fetchImpl)).toEqual({ state: "unreachable" });
    expect(calls).toHaveLength(1);
  });

  describe("on the wire", () => {
    let server: ReturnType<typeof Bun.serve> | null = null;
    afterEach(() => {
      void server?.stop(true);
      server = null;
    });

    test("the address is asked for its answer as it is, and a compressed answer is no version", async () => {
      const encodings: Array<string | null> = [];
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          encodings.push(request.headers.get("accept-encoding"));
          return new Response(gzipSync("1.2.3"), { headers: { "content-encoding": "gzip" } });
        },
      });
      expect(await fetchPublishedVersion(`http://127.0.0.1:${server.port}`, { timeoutMs: 5_000 })).toEqual({
        state: "none",
        status: 200,
      });
      expect(encodings).toEqual(["identity"]);
    });
  });
});

// The console's version check reads the version with the same reader, and
// says in its own words why it has none.
describe("the console's version check", () => {
  beforeEach(() => resetVersionCache());
  afterEach(() => resetVersionCache());
  const check = (answer: () => Response) =>
    fetchRemoteFortressVersion("https://updates.northstar.example/hx-fortress", {
      fetchImpl: (async () => answer()) as unknown as typeof fetch,
      timeoutMs: 5_000,
    });

  test("a version is shown as the latest release", async () => {
    expect(await check(() => new Response("9.8.7\n"))).toMatchObject({ kind: "available", version: "9.8.7" });
  });

  test("each answer that is no version keeps its reason", async () => {
    expect(await check(() => new Response("Not Found", { status: 404 }))).toMatchObject({
      kind: "unavailable",
      reason: "the update source answered 404",
    });
    resetVersionCache();
    expect(await check(() => new Response("0.1.2-rc.1"))).toMatchObject({
      kind: "unavailable",
      reason: "the update source did not answer with a version",
    });
    resetVersionCache();
    expect(await check(() => new Response("<html>1.2.3</html>"))).toMatchObject({
      kind: "unavailable",
      reason: "the update source did not answer with a version",
    });
    resetVersionCache();
    expect(
      await check(() => {
        throw new TypeError("fetch failed");
      }),
    ).toMatchObject({ kind: "unavailable", reason: "the update source could not be reached" });
  });
});

// A new version never comes through a control plane. The files below are the
// whole path a download takes: where its address is worked out, and where it is
// fetched. None of them may read a control plane's address, or hold one.
describe("the update path holds no control plane's address and reads none", () => {
  const ROOT = path.resolve(import.meta.dir, "..");
  const UPDATE_PATH = [
    "src/update.ts",
    "src/update-source.ts",
    "src/host/daemon-environment.ts",
    "src/https-redirects.ts",
    "src/ui/version-check.ts",
    "src/host/postgres/resolve.ts",
    "src/host/postgres/pgvector-artifact.ts",
    "src/host/postgres/pgvector-install.ts",
    "src/host/postgres/acquire.ts",
  ];
  // The settings key of a control plane's address, the helpers that read it,
  // and an address written out.
  const READS_A_CONTROL_PLANE = /\bcloud\b|cloudUrl|cloud\/address|controlPlaneHttpBase|readControlPlaneAddress|wss?:\/\//;

  test.each(UPDATE_PATH)("%s", async (file) => {
    const text = await readFile(path.join(ROOT, file), "utf8");
    const lines = text.split("\n").filter((line) => READS_A_CONTROL_PLANE.test(line));
    expect(lines).toEqual([]);
  });

  test.each(["install.sh", "install-from-source.sh"])("%s holds no address of a control plane", async (file) => {
    // A script may name the option that takes a control plane's address, and
    // pass on the address a person gave it. It may not hold one.
    const text = await readFile(path.join(ROOT, file), "utf8");
    expect(text.split("\n").filter((line) => /wss?:\/\//.test(line))).toEqual([]);
  });

  test("the database's own files come from the update source, by one call", async () => {
    // src/host/postgres/index.ts is given the whole config, so it cannot be on
    // the list above. What it does for pgvector is this one call.
    const text = await readFile(path.join(ROOT, "src/host/postgres/index.ts"), "utf8");
    expect(text).toContain("readUpdateSource(deps.paths, deps.env)");
    expect(text.split("\n").filter((line) => /config\.cloud|cloudUrl/.test(line))).toEqual([]);
  });
});
