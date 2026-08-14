// The unit surfaces: what a unit FILE says, what the non-rendering start path
// does, and the two refusals that stop a success being reported over the wrong
// binary or the wrong root.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  divergenceRefusal,
  startFortress,
  updateDivergenceRefusal,
  type LifecycleManager,
} from "../src/cli-lifecycle";
import { installUiService, uninstallUiService } from "../src/cli-ui-service";
import { LaunchdServiceManager, parseLaunchdProgram, renderLaunchdPlist } from "../src/service/launchd";
import { parseSystemdExecStart, renderSystemdUnit, SystemdServiceManager } from "../src/service/systemd";
import { CONSOLE_UNIT } from "../src/service/types";
import { UiConfigStore } from "../src/ui/config";
import { fortressPaths } from "../src/host/paths";
import {
  deriveDaemonRoot,
  parseUnitFortressRoot,
  uiUnitArgs,
  UI_RESTART_DISCIPLINE,
  type UiServiceControl,
  type UiUnitInstallOptions,
} from "../src/ui/service-control";
import type { CommandResult, CommandRunner, ServiceUnit } from "../src/service/types";

describe("the ExecStart parse contract", () => {
  test.each([
    "/usr/local/bin/hx-fortress",
    "/opt/HX Fortress/hx-fortress",
    '/opt/HX "Fortress"/hx%fortress',
    "/opt/back\\slash/hx-fortress",
  ])("round-trips %s through the systemd renderer", (executablePath) => {
    const unit = renderSystemdUnit({ executablePath, serviceLogPath: "/logs/service.log" });
    expect(parseSystemdExecStart(unit)).toBe(executablePath);
  });

  test.each([
    "/usr/local/bin/hx-fortress",
    "/Applications/HX & Tools/hx-fortress",
    "/opt/<odd>/hx-fortress",
  ])("round-trips %s through the launchd renderer", (executablePath) => {
    const plist = renderLaunchdPlist({ executablePath, serviceLogPath: "/logs/service.log" });
    expect(parseLaunchdProgram(plist)).toBe(executablePath);
  });

  test("a unit with no ExecStart reads as unknown rather than as this binary", () => {
    expect(parseSystemdExecStart("[Service]\nType=simple\n")).toBeNull();
    expect(parseLaunchdProgram("<plist></plist>")).toBeNull();
  });
});

describe("unit presence", () => {
  test("is the FILE, not loaded-ness — a stopped unit is still installed", async () => {
    // Everything reports unloaded, which is exactly what `hx-fortress stop`
    // leaves behind.
    const runner = new QueueRunner([]);
    const manager = new SystemdServiceManager({
      home: "/home/test",
      runner,
      readFile: async () =>
        renderSystemdUnit({
          executablePath: "/usr/local/bin/hx-fortress",
          serviceLogPath: "/logs/service.log",
        }),
    });
    await expect(manager.state()).resolves.toEqual({ loaded: false, pid: null });
    const unit = await manager.unit();
    expect(unit.present).toBe(true);
    expect(unit.executablePath).toBe("/usr/local/bin/hx-fortress");
  });

  test("an absent file is an absent unit", async () => {
    const manager = new SystemdServiceManager({
      home: "/home/test",
      runner: new QueueRunner([]),
      readFile: async () => {
        throw new Error("ENOENT");
      },
    });
    await expect(manager.unit()).resolves.toMatchObject({ present: false, executablePath: null });
  });
});

describe("the console unit", () => {
  test("carries FORTRESS_ROOT, the supervised args and a restart ceiling — and no FORTRESS_UI_*", () => {
    const unit = renderSystemdUnit({
      executablePath: "/usr/local/bin/hx-fortress",
      serviceLogPath: "/logs/service.log",
      args: uiUnitArgs(true),
      environment: { FORTRESS_ROOT: "/data/fortress" },
      restart: UI_RESTART_DISCIPLINE,
    });
    expect(unit).toContain('ExecStart="/usr/local/bin/hx-fortress" ui --supervised --allow-insecure-bind');
    expect(unit).toContain('Environment=FORTRESS_ROOT="/data/fortress"');
    // BOTH directives, and in [Unit] — which is the whole property. systemd
    // ignores a start limit written under [Service], so a whole-file substring
    // match is blind to the one regression this test exists to catch; and a
    // burst without its interval falls back to the 10 s default, which never
    // trips at RestartSec=5.
    const sections = new Map<string, string>();
    for (const block of unit.split(/^\[/m).slice(1)) {
      const name = block.slice(0, block.indexOf("]"));
      sections.set(name, block);
    }
    expect(sections.get("Unit")).toContain(`StartLimitBurst=${UI_RESTART_DISCIPLINE.limitBurst}`);
    expect(sections.get("Unit")).toContain(
      `StartLimitIntervalSec=${UI_RESTART_DISCIPLINE.limitIntervalSec}`,
    );
    expect(sections.get("Service") ?? "").not.toContain("StartLimit");
    expect(unit).not.toContain("FORTRESS_UI_");
  });

  test("throttles a binary that cannot run it, and claims nothing more — launchd arm", () => {
    const plist = renderLaunchdPlist(
      {
        executablePath: "/usr/local/bin/hx-fortress",
        serviceLogPath: "/logs/service.log",
        args: uiUnitArgs(false),
        environment: { FORTRESS_ROOT: "/data/fortress" },
        restart: UI_RESTART_DISCIPLINE,
      },
      CONSOLE_UNIT.label,
    );
    // launchd's KeepAlive sub-keys are OR'd, and `Crashed=false` means "restart
    // when it did NOT crash" — the inverse of how it reads. Beside
    // SuccessfulExit=false it matched every termination, i.e. an unconditional
    // KeepAlive dressed as a ceiling. The rule darwin actually gets is: come
    // back after a non-zero exit, no faster than ThrottleInterval.
    expect(plist).not.toContain("Crashed");
    expect(plist).toContain("<key>SuccessfulExit</key><false/>");
    expect(plist).toContain(
      `<key>ThrottleInterval</key><integer>${UI_RESTART_DISCIPLINE.throttleSeconds}</integer>`,
    );
    expect(plist).toContain("<string>ai.let.hx-fortress-ui</string>");
    expect(plist).toContain("<key>FORTRESS_ROOT</key><string>/data/fortress</string>");
  });

  test("the daemon unit keeps its own discipline and no environment", () => {
    const daemon = renderSystemdUnit({
      executablePath: "/usr/local/bin/hx-fortress",
      serviceLogPath: "/logs/service.log",
    });
    expect(daemon).not.toContain("StartLimit");
    expect(daemon).not.toContain("Environment=");
    expect(daemon).toContain('ExecStart="/usr/local/bin/hx-fortress" host');
  });
});

describe("daemon-root derivation", () => {
  test("reads the unit's own environment when it has one", () => {
    expect(
      deriveDaemonRoot({ unitEnvironment: 'Environment=FORTRESS_ROOT="/data/fortress"' }),
    ).toEqual({ root: "/data/fortress", source: "unit environment" });
    expect(
      parseUnitFortressRoot("<key>FORTRESS_ROOT</key><string>/data/fortress</string>"),
    ).toBe("/data/fortress");
  });

  test("an absent environment is the DEFAULT root, never a mismatch", () => {
    // A pre-console unit carries no Environment= at all, and installing the
    // console beside it has to succeed.
    expect(
      deriveDaemonRoot({ unitEnvironment: "Environment=", home: "/home/op", exists: () => false }),
    ).toEqual({ root: "/home/op/.let/hx-fortress", source: "default for the unit's user" });
  });

  test("honors the pre-rename directory when that is what exists", () => {
    expect(
      deriveDaemonRoot({
        unitEnvironment: null,
        home: "/home/op",
        exists: (file) => file === "/home/op/.let/fortress",
      }).root,
    ).toBe("/home/op/.let/fortress");
  });
});

/** A home whose DEFAULT fortress root is the root under test, which is the
 *  shape a real host has. */
async function defaultRootHome(): Promise<{ home: string; root: string }> {
  const home = await mkdtemp(path.join(os.tmpdir(), "hx-home-"));
  return { home, root: path.join(home, ".let", "hx-fortress") };
}

describe("hx-fortress ui --install-service", () => {
  test("installs beside a pre-console daemon unit, with FORTRESS_ROOT set in this shell", async () => {
    const { home, root } = await defaultRootHome();
    try {
      const service = new FakeUiService();
      const lines: string[] = [];
      const code = await installUiService([], {
        writeLine: (line) => lines.push(line),
        fortressRoot: root,
        service,
        // No Environment= on the daemon unit, and the default derivation lands
        // on this same root.
        daemonUnitEnvironment: "Environment=",
        home,
        linger: () => null,
        executablePath: "/usr/local/bin/hx-fortress",
      });
      expect(code).toBe(0);
      expect(service.installs[0]?.fortressRoot).toBe(root);
      // Installing IS enabling: a supervised console that read enabled:false
      // would exit at once and drive the unit to failed.
      const config = await new UiConfigStore(fortressPaths(root).uiConfig).load();
      expect(config.enabled).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("refuses a genuine root divergence at install time", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hx-install-"));
    try {
      const service = new FakeUiService();
      await expect(
        installUiService([], {
          writeLine: () => {},
          fortressRoot: root,
          service,
          daemonUnitEnvironment: 'Environment=FORTRESS_ROOT="/var/lib/other"',
          linger: () => null,
        }),
      ).rejects.toThrow(/refusing to install the console unit/);
      expect(service.installs).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("persists --allow-insecure-bind, which is the only way a unit can carry it", async () => {
    const { home, root } = await defaultRootHome();
    try {
      const service = new FakeUiService();
      const lines: string[] = [];
      await installUiService(["--allow-insecure-bind"], {
        writeLine: (line) => lines.push(line),
        fortressRoot: root,
        service,
        daemonUnitEnvironment: "Environment=",
        home,
        linger: () => null,
      });
      expect(service.installs[0]?.allowInsecureBind).toBe(true);
      const config = await new UiConfigStore(fortressPaths(root).uiConfig).load();
      expect(config.allowInsecureBind).toBe(true);
      expect(lines.some((l) => l.includes("non-loopback bind allowed"))).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("warns about linger rather than silently installing a unit that dies with the session", async () => {
    const { home, root } = await defaultRootHome();
    try {
      const lines: string[] = [];
      await installUiService([], {
        writeLine: (line) => lines.push(line),
        fortressRoot: root,
        service: new FakeUiService(),
        daemonUnitEnvironment: "Environment=",
        home,
        linger: () => "linger is off for op: this unit stops when your last login session ends.",
      });
      expect(lines.some((l) => l.includes("linger is off"))).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("hx-fortress ui --uninstall-service", () => {
  test("removes the unit and leaves the stored enablement untouched", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hx-uninstall-"));
    try {
      const store = new UiConfigStore(fortressPaths(root).uiConfig);
      await store.update((c) => ({ ...c, enabled: true }));
      const service = new FakeUiService();
      const lines: string[] = [];
      await uninstallUiService({
        writeLine: (line) => lines.push(line),
        fortressRoot: root,
        service,
      });
      expect(service.uninstalls).toBe(1);
      // The rollback rung disarms the button with `ui sso off` FIRST and relies
      // on this step leaving `enabled` alone.
      expect((await store.load()).enabled).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("startFortress against an installed unit", () => {
  test("enables and starts WITHOUT rewriting the unit, and recreates the log directory", async () => {
    const manager = fakeLifecycle({
      unit: { path: "/unit", present: true, executablePath: "/usr/local/bin/hx-fortress" },
      states: [{ loaded: false, pid: null }, { loaded: true, pid: 42 }],
    });
    const result = await startFortress({
      manager,
      executablePath: "/usr/local/bin/hx-fortress",
      paths: { log: "/logs/fortress.jsonl", serviceLog: "/logs/service.log" },
      writeLine: () => {},
    });
    expect(result.refused).toBe(false);
    expect(manager.installs).toBe(0);
    expect(manager.starts).toBe(1);
    expect(manager.logDirs).toEqual(["/logs/service.log"]);
  });

  test("installs when there is no unit at all", async () => {
    const manager = fakeLifecycle({
      unit: { path: "/unit", present: false, executablePath: null },
      states: [{ loaded: false, pid: null }, { loaded: true, pid: 42 }],
    });
    await startFortress({
      manager,
      executablePath: "/usr/local/bin/hx-fortress",
      paths: { log: "/logs/fortress.jsonl", serviceLog: "/logs/service.log" },
      writeLine: () => {},
    });
    expect(manager.installs).toBe(1);
    expect(manager.starts).toBe(0);
  });

  test("REFUSES a divergent ExecStart and never reports a clean start", async () => {
    const manager = fakeLifecycle({
      unit: { path: "/unit", present: true, executablePath: "/opt/old/hx-fortress" },
      states: [{ loaded: false, pid: null }],
    });
    const lines: string[] = [];
    const result = await startFortress({
      manager,
      executablePath: "/usr/local/bin/hx-fortress",
      paths: { log: "/logs/fortress.jsonl", serviceLog: "/logs/service.log" },
      writeLine: (line) => lines.push(line),
    });
    expect(result.refused).toBe(true);
    expect(result.divergence).toMatchObject({ unitExecutable: "/opt/old/hx-fortress" });
    // Returned, never printed: the terminal renderer's writeLine goes nowhere.
    expect(lines).toEqual([]);
    expect(manager.starts + manager.installs).toBe(0);
    expect(divergenceRefusal(result.divergence!)).toContain("/opt/old/hx-fortress");
    expect(updateDivergenceRefusal(result.divergence!)).toContain("refusing to update");
  });

  test("--reinstall is the way through, and it re-renders at the invoking binary", async () => {
    const manager = fakeLifecycle({
      unit: { path: "/unit", present: true, executablePath: "/opt/old/hx-fortress" },
      states: [{ loaded: false, pid: null }, { loaded: true, pid: 42 }],
    });
    const result = await startFortress({
      manager,
      executablePath: "/usr/local/bin/hx-fortress",
      paths: { log: "/logs/fortress.jsonl", serviceLog: "/logs/service.log" },
      writeLine: () => {},
      reinstall: true,
    });
    expect(result.refused).toBe(false);
    expect(manager.installs).toBe(1);
  });

  test("decides the console unit BEFORE the already-running early return", async () => {
    const manager = fakeLifecycle({
      unit: { path: "/unit", present: true, executablePath: "/usr/local/bin/hx-fortress" },
      states: [{ loaded: true, pid: 7 }],
    });
    let asked = false;
    const result = await startFortress({
      manager,
      executablePath: "/usr/local/bin/hx-fortress",
      paths: { log: "/logs/fortress.jsonl", serviceLog: "/logs/service.log" },
      writeLine: () => {},
      mayInstallUiUnit: true,
      ensureUiUnit: async (mayInstall) => {
        asked = mayInstall;
        return { kind: "installed", url: "https://fortress.example" };
      },
    });
    expect(asked).toBe(true);
    expect(result.uiUnit).toEqual({ kind: "installed", url: "https://fortress.example" });
  });
});

class FakeUiService implements UiServiceControl {
  readonly name = "fake";
  readonly installs: UiUnitInstallOptions[] = [];
  uninstalls = 0;
  starts = 0;
  present = false;

  async installed(): Promise<boolean> {
    return this.present;
  }

  async install(options: UiUnitInstallOptions): Promise<void> {
    this.installs.push(options);
    this.present = true;
  }

  async start(): Promise<void> {
    this.starts += 1;
  }

  async uninstall(): Promise<void> {
    this.uninstalls += 1;
    this.present = false;
  }

  async stopAndDisable(): Promise<void> {}
}

interface FakeLifecycle extends LifecycleManager {
  installs: number;
  starts: number;
  logDirs: string[];
}

function fakeLifecycle(args: {
  unit: ServiceUnit;
  states: Array<{ loaded: boolean; pid: number | null }>;
}): FakeLifecycle {
  const states = [...args.states];
  return {
    name: "systemd (user)",
    installs: 0,
    starts: 0,
    logDirs: [],
    async unit() {
      return args.unit;
    },
    async state() {
      return states.shift() ?? { loaded: false, pid: null };
    },
    async install() {
      this.installs += 1;
    },
    async start() {
      this.starts += 1;
    },
    async stop() {
      return { wasRunning: false };
    },
    async ensureLogDir(serviceLogPath: string) {
      this.logDirs.push(serviceLogPath);
    },
  };
}

class QueueRunner implements CommandRunner {
  readonly calls: Array<[string, readonly string[]]> = [];

  constructor(private readonly results: CommandResult[]) {}

  run(command: string, args: readonly string[]): CommandResult {
    this.calls.push([command, args]);
    return this.results.shift() ?? { status: 1, stdout: "", stderr: "" };
  }
}

void LaunchdServiceManager;
