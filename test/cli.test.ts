import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli";
import type { LogsOptions } from "../src/cli-logs";
import type { WizardEntryOpts } from "../src/modules/session-vault/wizard";
import type { UpdateResult } from "../src/update";
import type { ServiceManager, ServiceState } from "../src/service/types";
import type { UiServiceControl } from "../src/ui/service-control";

describe("runCli", () => {
  test("dispatches no args into the tui entrypoint", async () => {
    let ranTui = false;

    const exitCode = await runCli([], {
      runTui: async () => {
        ranTui = true;
        return 0;
      },
      writeLine: () => {},
    });

    expect(exitCode).toBe(0);
    expect(ranTui).toBe(true);
  });

  test("shows public help for unknown commands", async () => {
    const lines: string[] = [];

    const exitCode = await runCli(["wat"], {
      writeLine: (line) => lines.push(line),
    });

    expect(exitCode).toBe(1);
    // Rendered from the one help registry the console's Command Line panel also
    // reads, so a verb can never exist in only one of the two.
    const help = lines.join("\n");
    for (const verb of ["enroll", "credentials set", "start", "stop", "status", "logs", "ui", "update"]) {
      expect(help).toContain(`hx-fortress ${verb}`);
    }
  });

  test("dispatches enroll with the token and cloud URL", async () => {
    let captured: WizardEntryOpts | undefined;
    const lines: string[] = [];

    const exitCode = await runCli(
      ["enroll", "vlt_test", "--cloud", "wss://control.example/_api/hx-gateway/vault-tunnel"],
      {
        runEnrollWizard: async (opts) => {
          captured = opts;
        },
        writeLine: (line) => lines.push(line),
      },
    );

    expect(exitCode).toBe(0);
    expect(captured?.token).toBe("vlt_test");
    expect(captured?.cloudUrl).toBe("wss://control.example/_api/hx-gateway/vault-tunnel");
    captured?.log("wizard output");
    expect(lines).toEqual(["wizard output"]);
  });

  test("updates the saved Fortress credential", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-cli-root-"));
    const lines: string[] = [];
    try {
      await mkdir(path.join(root, "identity"), { recursive: true });
      await writeFile(
        path.join(root, "identity", "credentials.json"),
        `${JSON.stringify({
          orgId: "org-1",
          fortressId: "fortress-1",
          credential: "vlc_old",
        }, null, 2)}\n`,
      );

      const exitCode = await runCli(["credentials", "set", "vlc_new"], {
        fortressRoot: root,
        writeLine: (line) => lines.push(line),
      });

      expect(exitCode).toBe(0);
      expect(lines).toEqual([
        "HX Fortress credential updated.",
        "Restart HX Fortress or reconnect it to use the new credential.",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("dispatches enroll with an undefined token when none is given", async () => {
    let captured: WizardEntryOpts | undefined;

    const exitCode = await runCli(["enroll", "--cloud", "wss://x"], {
      runEnrollWizard: async (opts) => {
        captured = opts;
      },
      writeLine: () => {},
    });

    expect(exitCode).toBe(0);
    expect(captured?.token).toBeUndefined();
    expect(captured?.cloudUrl).toBe("wss://x");
  });

  test("rejects enroll without a cloud URL", async () => {
    const lines: string[] = [];

    const exitCode = await runCli(["enroll", "vlt_test"], {
      runEnrollWizard: async () => {
        throw new Error("wizard should not run");
      },
      writeLine: (line) => lines.push(line),
    });

    expect(exitCode).toBe(1);
    expect(lines).toEqual(["error: usage: hx-fortress enroll [token] --cloud <address>"]);
  });

  test("dispatches the internal host command without listing it in help", async () => {
    let ranHost = false;
    const lines: string[] = [];

    const exitCode = await runCli(["host"], {
      runFortressHost: async () => {
        ranHost = true;
      },
      writeLine: (line) => lines.push(line),
    });

    expect(exitCode).toBe(0);
    expect(ranHost).toBe(true);
    expect(lines).toEqual([]);
  });

  test("dispatches logs with module filter and --lines flag", async () => {
    let captured: Omit<LogsOptions, "follow" | "signal"> | undefined;

    const exitCode = await runCli(["logs", "session_vault", "--lines", "20"], {
      runLogs: async (opts) => {
        captured = opts;
      },
      writeLine: () => {},
    });

    expect(exitCode).toBe(0);
    expect(captured?.moduleFilter).toBe("session_vault");
    expect(captured?.linesBack).toBe(20);
  });

  test("dispatches logs with no module filter when none given", async () => {
    let captured: Omit<LogsOptions, "follow" | "signal"> | undefined;

    const exitCode = await runCli(["logs"], {
      runLogs: async (opts) => {
        captured = opts;
      },
      writeLine: () => {},
    });

    expect(exitCode).toBe(0);
    expect(captured?.moduleFilter).toBeUndefined();
    expect(captured?.linesBack).toBe(50);
  });
});

describe("runCli update", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-cli-update-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeConfig(cloudUrl: string): Promise<void> {
    const config = {
      schemaVersion: 1,
      cloud: { url: cloudUrl },
      modules: { enabled: ["session_vault"] },
    };
    await writeFile(path.join(root, "config.json"), JSON.stringify(config));
  }

  const PROJECT_RELEASES = "https://github.com/HX-Framework/hx-fortress/releases/latest/download";
  const MIRROR = "https://mirror.northstar.example/f";
  const UNIT_PATH = "/Users/test/Library/LaunchAgents/ai.let.hx-fortress.plist";
  const DAEMON = 4242;
  const alreadyLatest: UpdateResult = {
    asset: "hx-fortress-darwin-arm64",
    sha256: null,
    installedPath: "/usr/local/bin/hx-fortress",
    alreadyLatest: true,
    localVersion: "0.1.1",
    remoteVersion: "0.1.1",
  };

  /**
   * What every `update` here runs with unless a test says otherwise: the
   * service's unit runs HX Fortress with this test's folder, no daemon runs,
   * and the environment is empty. So no test reads the service, the status
   * or the environment of this computer.
   */
  function onThisFolder(): {
    fortressRoot: string;
    env: Record<string, string | undefined>;
    daemonPid: () => Promise<number | null>;
    daemonUnitEnvironment: string;
  } {
    return {
      fortressRoot: root,
      env: {},
      daemonPid: async () => null,
      daemonUnitEnvironment: `FORTRESS_ROOT=${root}`,
    };
  }

  interface UpdateRun {
    env?: Record<string, string | undefined>;
    daemonPid?: () => Promise<number | null>;
    /** The unit's environment. Null: the unit names none. */
    daemonUnitEnvironment?: string | null;
    unitPresent?: boolean;
  }

  /** Run `update` and say which base address the download was given. */
  async function updateFrom(run: UpdateRun = {}) {
    const lines: string[] = [];
    let base: string | undefined;
    const exitCode = await runCli(["update"], {
      ...onThisFolder(),
      ...(run.env ? { env: run.env } : {}),
      ...(run.daemonPid ? { daemonPid: run.daemonPid } : {}),
      ...(run.daemonUnitEnvironment !== undefined ? { daemonUnitEnvironment: run.daemonUnitEnvironment } : {}),
      runUpdate: async (opts) => {
        base = opts.downloadBaseUrl;
        return alreadyLatest;
      },
      getServiceManager: () => fakeManager([{ loaded: false, pid: null }], false, run.unitPresent ?? true),
      getUiServiceControl: () => noUiUnit(),
      writeLine: (line) => lines.push(line),
    });
    return { exitCode, base, lines };
  }

  /** What the daemon with this pid wrote down about its environment when it
   *  started, at the path a terminal reads it from. */
  async function daemonWrote(updateUrl: unknown, pid = DAEMON): Promise<void> {
    await mkdir(path.join(root, "runtime"), { recursive: true });
    await writeFile(
      path.join(root, "runtime", "daemon-environment.json"),
      JSON.stringify({ schemaVersion: 1, pid, writtenAt: new Date().toISOString(), updateUrl, controlPlaneKey: null }),
    );
  }

  test("a new version comes from the project's releases, never from the control plane's address", async () => {
    await writeConfig("wss://control.example/_api/hx-gateway/vault-tunnel");
    const run = await updateFrom();
    expect(run.exitCode).toBe(0);
    expect(run.base).toBe(PROJECT_RELEASES);
    expect(run.base).not.toContain("control.example");
    expect(run.lines[0]).toBe(
      "Update source: the project's releases, https://github.com/HX-Framework/hx-fortress/releases/latest/download",
    );
  });

  test("an HX Fortress that was never set up updates in the same way", async () => {
    // No config.json at all: no control plane, no enrollment.
    const run = await updateFrom();
    expect(run.exitCode).toBe(0);
    expect(run.base).toBe(PROJECT_RELEASES);
  });

  test("an address the organization names in config.json is the source", async () => {
    await writeFile(
      path.join(root, "config.json"),
      JSON.stringify({
        schemaVersion: 1,
        cloud: { url: "wss://control.example/_api/hx-gateway/vault-tunnel" },
        modules: { enabled: ["session_vault"] },
        updates: { from: "own-address", address: "https://updates.northstar.example/hx-fortress/" },
      }),
    );
    const run = await updateFrom();
    expect(run.base).toBe("https://updates.northstar.example/hx-fortress");
    expect(run.lines[0]).toBe("Update source: https://updates.northstar.example/hx-fortress, set in config.json");
  });

  test("config.json that says project-releases and still holds an address updates from the project's releases", async () => {
    await writeFile(
      path.join(root, "config.json"),
      JSON.stringify({ schemaVersion: 1, updates: { from: "project-releases", address: "https://updates.example/x" } }),
    );
    const run = await updateFrom();
    expect(run.exitCode).toBe(0);
    expect(run.base).toBe(PROJECT_RELEASES);
    expect(run.lines[0]).toBe(`Update source: the project's releases, ${PROJECT_RELEASES}, set in config.json`);
  });

  test("FORTRESS_UPDATE_URL wins over config.json", async () => {
    await writeFile(
      path.join(root, "config.json"),
      JSON.stringify({ schemaVersion: 1, updates: { from: "own-address", address: "https://a.example/x" } }),
    );
    const run = await updateFrom({ env: { FORTRESS_UPDATE_URL: "https://b.example/y" } });
    expect(run.base).toBe("https://b.example/y");
    expect(run.lines[0]).toBe("Update source: https://b.example/y, set on this host by FORTRESS_UPDATE_URL");
  });

  test("the address the running daemon's environment names is followed, though this terminal does not have it", async () => {
    // The organization set the variable on the service. This terminal does not
    // have it, and must not go back to the default behind that setting.
    await daemonWrote({ value: MIRROR });
    const run = await updateFrom({ daemonPid: async () => DAEMON });
    expect(run.exitCode).toBe(0);
    expect(run.base).toBe(MIRROR);
    expect(run.lines[0]).toBe(
      `Update source: ${MIRROR}, set by FORTRESS_UPDATE_URL in the environment HX Fortress runs with`,
    );
  });

  test("a daemon that has stopped, and whose environment named another address, stops the update before anything is downloaded", async () => {
    await daemonWrote({ value: MIRROR });
    const run = await updateFrom({ daemonPid: async () => null });
    expect(run.exitCode).toBe(1);
    expect(run.base).toBeUndefined();
    expect(run.lines).toHaveLength(1);
    // Nothing is wrong with a setting, and the words do not say so: what is
    // not known is whether the variable is still set where HX Fortress starts.
    expect(run.lines[0]).toBe(
      "error: Where new versions come from is not known. The daemon that last wrote down its environment named " +
        `${MIRROR} in FORTRESS_UPDATE_URL, and that daemon is not running now, so it cannot be told from here ` +
        "whether the variable is still set. Start HX Fortress, or give the address in FORTRESS_UPDATE_URL to " +
        "the command you run",
    );

    // The person says which: the address given to this command settles it.
    const given = await updateFrom({ daemonPid: async () => null, env: { FORTRESS_UPDATE_URL: MIRROR } });
    expect(given.exitCode).toBe(0);
    expect(given.base).toBe(MIRROR);
  });

  test("a unit that runs HX Fortress with another folder is a named refusal, and nothing is downloaded", async () => {
    const other = path.join(root, "the-service-folder");
    const run = await updateFrom({ daemonUnitEnvironment: `FORTRESS_ROOT=${other}` });
    expect(run.exitCode).toBe(1);
    expect(run.base).toBeUndefined();
    expect(run.lines).toEqual([
      `error: refusing to update: ${UNIT_PATH} runs HX Fortress with the folder ${other} (unit environment), ` +
        `and this terminal's folder is ${root}. Where a new version comes from is read from the folder's settings, ` +
        `and another folder can name another place. Run the update with the service's folder: ` +
        `FORTRESS_ROOT=${other} hx-fortress update.`,
    ]);
  });

  test("a unit that names no folder runs with its user's default one, and a terminal with another folder is refused", async () => {
    const run = await updateFrom({ daemonUnitEnvironment: null });
    expect(run.exitCode).toBe(1);
    expect(run.base).toBeUndefined();
    expect(run.lines[0]).toStartWith(`error: refusing to update: ${UNIT_PATH} runs HX Fortress with the folder `);
    expect(run.lines[0]).toContain(`(default for the unit's user), and this terminal's folder is ${root}.`);
  });

  test("a unit that runs HX Fortress with this folder lets the update go on, as a launchd unit states it too", async () => {
    expect((await updateFrom({ daemonUnitEnvironment: `FORTRESS_ROOT=${root}` })).base).toBe(PROJECT_RELEASES);
    const plist =
      "<dict>\n  <key>EnvironmentVariables</key>\n  <dict>\n" +
      `    <key>FORTRESS_ROOT</key>\n    <string>${root}</string>\n  </dict>\n</dict>`;
    const run = await updateFrom({ daemonUnitEnvironment: plist });
    expect(run.exitCode).toBe(0);
    expect(run.base).toBe(PROJECT_RELEASES);
  });

  test("with no unit there is no service folder to compare, and the update goes on", async () => {
    const run = await updateFrom({
      unitPresent: false,
      daemonUnitEnvironment: `FORTRESS_ROOT=${path.join(root, "the-service-folder")}`,
    });
    expect(run.exitCode).toBe(0);
    expect(run.base).toBe(PROJECT_RELEASES);
  });

  test("a setting that cannot be understood stops the update and is named", async () => {
    for (const updates of [
      { from: "somewhere-else" },
      { from: "own-address" },
      { from: "own-address", address: "http://updates.example/x" },
      // An address with no `from` beside it: nobody said to use it.
      { address: "https://updates.example/x" },
      "project-releases",
    ]) {
      await writeFile(path.join(root, "config.json"), JSON.stringify({ schemaVersion: 1, updates }));
      const run = await updateFrom();
      expect([updates, run.base, run.exitCode]).toEqual([updates, undefined, 1]);
      expect(run.lines[0]).toStartWith("error: Invalid update settings: ");
    }
    const env = await updateFrom({ env: { FORTRESS_UPDATE_URL: "http://updates.example/x" } });
    expect(env.base).toBeUndefined();
    expect(env.exitCode).toBe(1);
    expect(env.lines[0]).toStartWith("error: Invalid update settings: FORTRESS_UPDATE_URL must use https:");
  });

  test("says so when the running version is already the latest", async () => {
    await writeConfig("wss://control.example/_api/hx-gateway/vault-tunnel");
    let capturedDownloadBaseUrl: string | undefined;
    const lines: string[] = [];

    const alreadyLatestResult: UpdateResult = {
      asset: "hx-fortress-darwin-arm64",
      sha256: null,
      installedPath: "/usr/local/bin/hx-fortress",
      alreadyLatest: true,
      localVersion: "0.1.1",
      remoteVersion: "0.1.1",
    };

    const exitCode = await runCli(["update"], {
      ...onThisFolder(),
      runUpdate: async (opts) => {
        capturedDownloadBaseUrl = opts.downloadBaseUrl;
        return alreadyLatestResult;
      },
      getServiceManager: () => fakeManager([{ loaded: false, pid: null }]),
      getUiServiceControl: () => noUiUnit(),
      writeLine: (line) => lines.push(line),
    });

    expect(exitCode).toBe(0);
    expect(capturedDownloadBaseUrl).toBe(PROJECT_RELEASES);
    expect(lines).toContain(
      "hx-fortress is already on the latest version (v0.1.1). Nothing to do. 🎉",
    );
  });

  test("prints updated message and version after a successful install", async () => {
    await writeConfig("wss://control.example/_api/hx-gateway/vault-tunnel");
    const lines: string[] = [];

    const installedResult: UpdateResult = {
      asset: "hx-fortress-darwin-arm64",
      sha256: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      installedPath: "/usr/local/bin/hx-fortress",
      alreadyLatest: false,
      localVersion: "0.1.1",
      remoteVersion: "0.1.2",
    };

    const exitCode = await runCli(["update"], {
      ...onThisFolder(),
      runUpdate: async () => installedResult,
      getServiceManager: () => fakeManager([{ loaded: false, pid: null }]),
      getUiServiceControl: () => noUiUnit(),
      writeLine: (line) => lines.push(line),
    });

    expect(exitCode).toBe(0);
    expect(lines[0]).toMatch(/^Update source: /);
    expect(lines[1]).toMatch(/hx-fortress updated to latest \(hx-fortress-darwin-arm64, sha256 abcdef123456…\)/);
    expect(lines[lines.length - 1]).toBe("hx-fortress version: 0.1.2");
  });

  test("restarts the service when it was running before the update", async () => {
    await writeConfig("wss://control.example/_api/hx-gateway/vault-tunnel");
    const lines: string[] = [];
    const manager = fakeManager([{ loaded: true, pid: 9999 }]);

    const installedResult: UpdateResult = {
      asset: "hx-fortress-linux-x64",
      sha256: "a".repeat(64),
      installedPath: "/home/user/.let/bin/hx-fortress",
      alreadyLatest: false,
      localVersion: "0.1.1",
      remoteVersion: "0.1.3",
    };

    const exitCode = await runCli(["update"], {
      ...onThisFolder(),
      runUpdate: async () => installedResult,
      getServiceManager: () => manager,
      getUiServiceControl: () => noUiUnit(),
      writeLine: (line) => lines.push(line),
    });

    expect(exitCode).toBe(0);
    // The unit is restarted in place: a re-render would drop directives the
    // host added to it.
    expect(manager.restarts).toBe(1);
    expect(manager.installs).toBe(0);
    expect(lines.some((l) => l.includes("restarting HX Fortress"))).toBe(true);
    expect(lines.some((l) => l.includes("restarted"))).toBe(true);
  });

  test("does not restart when HX Fortress was not running", async () => {
    await writeConfig("wss://control.example/_api/hx-gateway/vault-tunnel");
    const manager = fakeManager([{ loaded: false, pid: null }]);

    const installedResult: UpdateResult = {
      asset: "hx-fortress-darwin-arm64",
      sha256: "b".repeat(64),
      installedPath: "/home/user/.let/bin/hx-fortress",
      alreadyLatest: false,
      localVersion: "0.1.1",
      remoteVersion: "0.1.2",
    };

    const exitCode = await runCli(["update"], {
      ...onThisFolder(),
      runUpdate: async () => installedResult,
      getServiceManager: () => manager,
      getUiServiceControl: () => noUiUnit(),
      writeLine: () => {},
    });

    expect(exitCode).toBe(0);
    expect(manager.restarts).toBe(0);
    expect(manager.installs).toBe(0);
  });

  test("a config.json that cannot be read stops the update, and is not taken for the default", async () => {
    // The file may name the organization's own address. Reading it as "no
    // setting" would download from the place that address turned away from.
    await writeFile(path.join(root, "config.json"), "{ not json");
    const lines: string[] = [];

    const exitCode = await runCli(["update"], {
      ...onThisFolder(),
      runUpdate: async () => {
        throw new Error("should not run");
      },
      getServiceManager: () => fakeManager([{ loaded: false, pid: null }]),
      getUiServiceControl: () => noUiUnit(),
      writeLine: (line) => lines.push(line),
    });

    expect(exitCode).toBe(1);
    expect(lines.join("\n")).toContain("Invalid update settings: config.json cannot be read as settings (malformed JSON)");
    expect(lines.join("\n")).not.toContain("should not run");
  });
});

interface FakeManager extends ServiceManager {
  installs: number;
  stops: number;
  restarts: number;
  unitPresent: boolean;
}

function fakeManager(states: ServiceState[], wasRunning = false, unitPresent = true): FakeManager {
  let callIndex = 0;
  return {
    name: "launchd",
    installs: 0,
    stops: 0,
    restarts: 0,
    unitPresent,
    async unit() {
      return {
        path: "/Users/test/Library/LaunchAgents/ai.let.hx-fortress.plist",
        present: (this as FakeManager).unitPresent,
        executablePath: (this as FakeManager).unitPresent ? process.execPath : null,
      };
    },
    async start(): Promise<void> {
      (this as FakeManager).installs++;
    },
    async restart(): Promise<void> {
      (this as FakeManager).restarts++;
    },
    async uninstall(): Promise<void> {},
    async ensureLogDir(): Promise<void> {},
    async state(): Promise<ServiceState> {
      const s = states[callIndex] ?? states[states.length - 1] ?? { loaded: false, pid: null };
      callIndex++;
      return s;
    },
    async install(): Promise<void> {
      (this as FakeManager).installs++;
    },
    async stop(): Promise<{ wasRunning: boolean }> {
      (this as FakeManager).stops++;
      return { wasRunning };
    },
  };
}

/** No console unit on this host: the update path must not reach for one. */
function noUiUnit(): UiServiceControl {
  return {
    name: "none",
    async installed() {
      return false;
    },
    async install() {},
    async start() {},
    async uninstall() {},
    async stopAndDisable() {},
  };
}
