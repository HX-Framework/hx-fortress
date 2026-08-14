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
      ["enroll", "vlt_test", "--cloud", "wss://let.ai/_api/hx-gateway/vault-tunnel"],
      {
        runEnrollWizard: async (opts) => {
          captured = opts;
        },
        writeLine: (line) => lines.push(line),
      },
    );

    expect(exitCode).toBe(0);
    expect(captured?.token).toBe("vlt_test");
    expect(captured?.cloudUrl).toBe("wss://let.ai/_api/hx-gateway/vault-tunnel");
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
        "Fortress credential updated.",
        "Restart Fortress or reconnect it to use the new credential.",
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
    expect(lines).toEqual(["error: usage: hx-fortress enroll [token] --cloud <url>"]);
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
    await mkdir(path.join(root), { recursive: true });
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

  test("dispatches update with the download base URL derived from config", async () => {
    await writeConfig("wss://workbench.let.ai/_api/hx-gateway/vault-tunnel");
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
      fortressRoot: root,
      runUpdate: async (opts) => {
        capturedDownloadBaseUrl = opts.downloadBaseUrl;
        return alreadyLatestResult;
      },
      getServiceManager: () => fakeManager([{ loaded: false, pid: null }]),
      getUiServiceControl: () => noUiUnit(),
      writeLine: (line) => lines.push(line),
    });

    expect(exitCode).toBe(0);
    expect(capturedDownloadBaseUrl).toBe(
      "https://workbench.let.ai/_api/hx-gateway/download",
    );
    expect(lines).toContain(
      "hx-fortress is already on the latest version (v0.1.1). Nothing to do. 🎉",
    );
  });

  test("prints updated message and version after a successful install", async () => {
    await writeConfig("wss://workbench.let.ai/_api/hx-gateway/vault-tunnel");
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
      fortressRoot: root,
      runUpdate: async () => installedResult,
      getServiceManager: () => fakeManager([{ loaded: false, pid: null }]),
      getUiServiceControl: () => noUiUnit(),
      writeLine: (line) => lines.push(line),
    });

    expect(exitCode).toBe(0);
    expect(lines[0]).toMatch(/hx-fortress updated to latest \(hx-fortress-darwin-arm64, sha256 abcdef123456…\)/);
    expect(lines[lines.length - 1]).toBe("hx-fortress version: 0.1.2");
  });

  test("restarts the service when it was running before the update", async () => {
    await writeConfig("wss://workbench.let.ai/_api/hx-gateway/vault-tunnel");
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
      fortressRoot: root,
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
    expect(lines.some((l) => l.includes("restarting Fortress"))).toBe(true);
    expect(lines.some((l) => l.includes("restarted"))).toBe(true);
  });

  test("does not restart when fortress was not running", async () => {
    await writeConfig("wss://workbench.let.ai/_api/hx-gateway/vault-tunnel");
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
      fortressRoot: root,
      runUpdate: async () => installedResult,
      getServiceManager: () => manager,
      getUiServiceControl: () => noUiUnit(),
      writeLine: () => {},
    });

    expect(exitCode).toBe(0);
    expect(manager.restarts).toBe(0);
    expect(manager.installs).toBe(0);
  });

  test("errors when fortress is not configured", async () => {
    const lines: string[] = [];

    const exitCode = await runCli(["update"], {
      fortressRoot: root,
      runUpdate: async () => {
        throw new Error("should not run");
      },
      writeLine: (line) => lines.push(line),
    });

    expect(exitCode).toBe(1);
    expect(lines[0]).toContain("Fortress is not configured");
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
