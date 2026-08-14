import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli";
import { getServiceManager } from "../src/service";
import { SystemdServiceManager } from "../src/service/systemd";
import {
  containerFromSignals,
  detectContainer,
  type ContainerSignals,
} from "../src/ui/container";

const NONE: ContainerSignals = {
  dockerenv: false,
  containerenv: false,
  cgroup: null,
  initEnviron: null,
  kubernetes: false,
  railway: false,
};

/** The detector table. Every row states what the box is and which of the two
 *  consumer decisions it may drive: `container` governs the bind and the printed
 *  access hints, `dockerClass` governs the no-arg verb default and the
 *  ServiceManager flavor. */
const TABLE: {
  name: string;
  signals: Partial<ContainerSignals>;
  container: boolean;
  dockerClass: boolean;
}[] = [
  { name: "bare host", signals: {}, container: false, dockerClass: false },
  {
    name: "desktop session cgroup (not a container)",
    signals: { cgroup: "0::/user.slice/user-1000.slice/session-3.scope" },
    container: false,
    dockerClass: false,
  },
  { name: "docker", signals: { dockerenv: true }, container: true, dockerClass: true },
  { name: "podman", signals: { containerenv: true }, container: true, dockerClass: true },
  { name: "kubernetes", signals: { kubernetes: true }, container: true, dockerClass: true },
  { name: "railway", signals: { railway: true }, container: true, dockerClass: true },
  {
    // --network host / hostNetwork: true. The markers are identical to a normal
    // container's; only the netns differs, and that is invisible from inside —
    // which is why clause (1) prints the residual even though it permits the bind.
    name: "docker --network host",
    signals: { dockerenv: true, cgroup: "0::/docker/abc123" },
    container: true,
    dockerClass: true,
  },
  {
    name: "lxc (cgroup marker)",
    signals: { cgroup: "1:name=systemd:/lxc/webapp" },
    container: true,
    dockerClass: false,
  },
  {
    name: "lxc (init environ marker)",
    signals: { initEnviron: "PATH=/usr/bin\0container=lxc\0TERM=linux" },
    container: true,
    dockerClass: false,
  },
  {
    name: "systemd-nspawn",
    signals: { initEnviron: "container=systemd-nspawn\0HOME=/root" },
    container: true,
    dockerClass: false,
  },
  {
    // A cgroup line naming docker is still not docker-class: one regex cannot
    // separate it from a nested or leaked cgroup path, so it warns and honors a
    // gesture but never widens a bind on its own.
    name: "containerd cgroup only",
    signals: { cgroup: "0::/system.slice/containerd.service" },
    container: true,
    dockerClass: false,
  },
  {
    name: "kubepods cgroup only",
    signals: { cgroup: "12:cpuset:/kubepods/burstable/pod123" },
    container: true,
    dockerClass: false,
  },
];

describe("container detector table", () => {
  for (const row of TABLE) {
    test(`${row.name} → container=${row.container} dockerClass=${row.dockerClass}`, () => {
      const verdict = containerFromSignals({ ...NONE, ...row.signals });
      expect(verdict.container).toBe(row.container);
      expect(verdict.dockerClass).toBe(row.dockerClass);
      expect(verdict.signals.length > 0).toBe(row.container);
    });
  }

  test("names the signals that fired, docker-class first", () => {
    const verdict = containerFromSignals({
      ...NONE,
      dockerenv: true,
      cgroup: "0::/docker/abc123",
    });
    expect(verdict.signals).toEqual(["/.dockerenv", "/proc/1/cgroup"]);
  });

  test("any RAILWAY_* variable counts, not one pinned name", () => {
    const verdict = detectContainer({
      platform: "linux",
      env: { RAILWAY_ENVIRONMENT_NAME: "production" },
    });
    expect(verdict.dockerClass).toBe(true);
  });
});

describe("container detection overrides", () => {
  test("FORTRESS_CONTAINER=0 forces host behavior everywhere", () => {
    const env = { KUBERNETES_SERVICE_HOST: "10.0.0.1", FORTRESS_CONTAINER: "0" };
    expect(detectContainer({ platform: "linux", env })).toEqual({
      container: false,
      dockerClass: false,
      signals: [],
    });
  });

  test("--no-container forces host behavior everywhere", () => {
    const env = { KUBERNETES_SERVICE_HOST: "10.0.0.1" };
    expect(detectContainer({ platform: "linux", env, noContainerFlag: true }).container).toBe(false);
  });

  test("a native macOS install is never a container", () => {
    expect(detectContainer({ platform: "darwin", env: { RAILWAY_PROJECT_ID: "p" } }).container).toBe(
      false,
    );
  });
});

describe("consumer split", () => {
  test("a system-container marker leaves the verb default and the service flavor alone", async () => {
    // systemd --user works in an LXC guest, so the operator keeps the TUI and
    // real service control there; only the bind and the printed hints change.
    expect(
      containerFromSignals({ ...NONE, cgroup: "1:name=systemd:/lxc/webapp" }).dockerClass,
    ).toBe(false);

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
    expect(getServiceManager({ platform: "linux", home: "/home/op" })).toBeInstanceOf(
      SystemdServiceManager,
    );
  });
});
