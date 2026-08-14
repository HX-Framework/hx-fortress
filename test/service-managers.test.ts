import { describe, expect, test } from "bun:test";

import {
  LaunchdServiceManager,
  renderLaunchdPlist,
} from "../src/service/launchd";
import {
  renderSystemdUnit,
  SystemdServiceManager,
} from "../src/service/systemd";
import type {
  CommandResult,
  CommandRunner,
} from "../src/service/types";

describe("launchd service manager", () => {
  test("renders an escaped persistent LaunchAgent", () => {
    const plist = renderLaunchdPlist({
      executablePath: "/Applications/HX & Tools/hx-fortress",
      serviceLogPath: "/Users/a&b/.let/hx-fortress/logs/service.log",
    });

    expect(plist).toContain(
      "<string>/Applications/HX &amp; Tools/hx-fortress</string>",
    );
    expect(plist).toContain("<string>host</string>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("<key>SuccessfulExit</key><false/>");
    expect(plist).toContain(
      "<string>/Users/a&amp;b/.let/hx-fortress/logs/service.log</string>",
    );
  });

  test("parses state, installs, and verifies stop", async () => {
    const runner = new QueueRunner([
      result(0, '"PID" = 1234;'),
      result(0),
      result(1),
      result(0),
      result(0),
      result(0),
      result(0, '"PID" = 1234;'),
      result(0),
      result(1),
    ]);
    const writes: Array<[string, string]> = [];
    const manager = new LaunchdServiceManager({
      home: "/Users/test",
      uid: 501,
      runner,
      writeFile: async (file, contents) => {
        writes.push([file, contents]);
      },
      mkdir: async () => {},
      sleep: async () => {},
    });

    await expect(manager.state()).resolves.toEqual({
      loaded: true,
      pid: 1234,
    });
    await manager.install({
      executablePath: "/usr/local/bin/hx-fortress",
      serviceLogPath: "/Users/test/.let/hx-fortress/logs/service.log",
    });
    await expect(manager.stop()).resolves.toEqual({ wasRunning: true });

    expect(writes[0]?.[0]).toBe(
      "/Users/test/Library/LaunchAgents/ai.let.hx-fortress.plist",
    );
    expect(runner.calls).toContainEqual([
      "launchctl",
      ["enable", "gui/501/ai.let.hx-fortress"],
    ]);
    expect(runner.calls).toContainEqual([
      "launchctl",
      ["bootstrap", "gui/501", "/Users/test/Library/LaunchAgents/ai.let.hx-fortress.plist"],
    ]);
    expect(runner.calls).toContainEqual([
      "launchctl",
      ["disable", "gui/501/ai.let.hx-fortress"],
    ]);
  });

  test("throws when launchd service survives stop", async () => {
    const manager = new LaunchdServiceManager({
      home: "/Users/test",
      uid: 501,
      runner: new QueueRunner([
        result(0),
        result(0, '"PID" = 10;'),
        result(0),
        ...Array.from({ length: 21 }, () => result(0, '"PID" = 10;')),
      ]),
      writeFile: async () => {},
      mkdir: async () => {},
      sleep: async () => {},
    });

    await expect(manager.stop()).rejects.toThrow("unit still loaded");
  });
});

describe("systemd service manager", () => {
  test("renders an escaped persistent user unit", () => {
    const unit = renderSystemdUnit({
      executablePath: '/opt/HX "Fortress"/hx%fortress',
      serviceLogPath: "/home/test/.let/hx-fortress/logs/service.log",
    });

    expect(unit).toContain(
      'ExecStart="/opt/HX \\"Fortress\\"/hx%%fortress" host',
    );
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain(
      "StandardOutput=append:/home/test/.let/hx-fortress/logs/service.log",
    );
  });

  test("parses state, installs, and verifies stop", async () => {
    const runner = new QueueRunner([
      result(0, "enabled\n"),
      result(0, "MainPID=4321\n"),
      result(0),
      result(0),
      result(0, "enabled\n"),
      result(0, "MainPID=4321\n"),
      result(0),
      result(3, "inactive\n"),
    ]);
    const writes: Array<[string, string]> = [];
    const manager = new SystemdServiceManager({
      home: "/home/test",
      runner,
      writeFile: async (file, contents) => {
        writes.push([file, contents]);
      },
      mkdir: async () => {},
    });

    await expect(manager.state()).resolves.toEqual({
      loaded: true,
      pid: 4321,
    });
    await manager.install({
      executablePath: "/usr/local/bin/hx-fortress",
      serviceLogPath: "/home/test/.let/hx-fortress/logs/service.log",
    });
    await expect(manager.stop()).resolves.toEqual({ wasRunning: true });

    expect(writes[0]?.[0]).toBe(
      "/home/test/.config/systemd/user/hx-fortress.service",
    );
    expect(runner.calls).toContainEqual([
      "systemctl",
      ["--user", "enable", "--now", "hx-fortress.service"],
    ]);
  });
});

class QueueRunner implements CommandRunner {
  readonly calls: Array<[string, readonly string[]]> = [];

  constructor(private readonly results: CommandResult[]) {}

  run(command: string, args: readonly string[]): CommandResult {
    this.calls.push([command, args]);
    return this.results.shift() ?? result(0);
  }
}

function result(
  status: number,
  stdout = "",
  stderr = "",
): CommandResult {
  return { status, stdout, stderr };
}
