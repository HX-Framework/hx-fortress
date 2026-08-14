import { describe, expect, test } from "bun:test";

import { getServiceManager } from "../src/service";

describe("getServiceManager", () => {
  test("selects launchd and systemd user managers", () => {
    expect(getServiceManager({ platform: "darwin", home: "/tmp", uid: 1 }).name).toBe(
      "launchd",
    );
    expect(getServiceManager({ platform: "linux", home: "/tmp", uid: 1 }).name).toBe(
      "systemd (user)",
    );
  });

  test("returns an actionable unsupported manager", async () => {
    const manager = getServiceManager({
      platform: "win32",
      home: "/tmp",
      uid: 1,
    });

    await expect(manager.state()).rejects.toThrow(
      "Fortress background service is not supported on win32.",
    );
  });
});
