// Container detection for the console.
//
// The console cares for exactly two reasons, and they take DIFFERENT answers:
//
//   • bind + printed hints — any container. The loopback the console binds
//     inside a container is the CONTAINER's loopback, so a browser on the host
//     cannot reach it. Whether we may widen that bind is governed by the
//     three-clause rule in bind.ts; this module only reports what the box is.
//   • the no-arg verb default and the ServiceManager flavor — DOCKER-CLASS
//     only. A system container (LXC, systemd-nspawn) runs a full init, so
//     `systemctl --user` works and the operator gets a terminal there: it keeps
//     the TUI and real service control. Only runtimes whose process lifecycle an
//     orchestrator owns switch those two decisions.
//
// The docker-class subset is the set of runtimes that publish ports through
// HOST INDIRECTION (`-p 127.0.0.1:8788:8788`, a Service, a Railway domain), so
// listening on a wildcard inside the netns exposes nothing by itself. LXC and
// nspawn have no such indirection — their address IS a LAN address — which is
// why they are detected but never docker-class.
//
// /proc/1/cgroup is deliberately NOT docker-class even when it names docker:
// one regex cannot tell a docker container that never wrote /.dockerenv from an
// LXC guest or a host with leaked cgroup paths, and the conservative half is the
// safe one — evidence enough to warn and to honor a gesture, never enough to
// widen a bind on its own.

import { existsSync, readFileSync } from "node:fs";

/** The raw signals, separated from the reads so the table is unit-testable. */
export interface ContainerSignals {
  /** /.dockerenv — Docker writes it into every container. */
  dockerenv: boolean;
  /** /run/.containerenv — Podman's equivalent marker. */
  containerenv: boolean;
  /** /proc/1/cgroup, naming the runtime that owns pid 1's cgroup. */
  cgroup: string | null;
  /** /proc/1/environ, NUL-separated; systemd-nspawn and LXC set `container=`. */
  initEnviron: string | null;
  /** KUBERNETES_SERVICE_HOST — injected into every pod. */
  kubernetes: boolean;
  /** Any RAILWAY_* variable — Railway's own container platform. */
  railway: boolean;
}

export interface ContainerVerdict {
  /** Any signal fired. Governs bind widening and the printed access hints. */
  container: boolean;
  /** A publish-indirection runtime. Governs the no-arg verb default and the
   *  ServiceManager flavor, and is clause (1) of the bind rule. */
  dockerClass: boolean;
  /** Which signals fired, in enumeration order — printed with the hints. */
  signals: string[];
}

const NO_CONTAINER: ContainerVerdict = { container: false, dockerClass: false, signals: [] };

/** Runtimes named in a pid-1 cgroup path. Detects; never docker-class. */
const CGROUP_MARKERS = /\b(docker|containerd|kubepods|libpod|podman|lxc)\b/i;

/** Pure decision over the raw signals. */
export function containerFromSignals(sig: ContainerSignals): ContainerVerdict {
  const dockerClass: string[] = [];
  const systemClass: string[] = [];

  if (sig.dockerenv) dockerClass.push("/.dockerenv");
  if (sig.containerenv) dockerClass.push("/run/.containerenv");
  if (sig.kubernetes) dockerClass.push("KUBERNETES_SERVICE_HOST");
  if (sig.railway) dockerClass.push("RAILWAY_*");
  if (sig.cgroup && CGROUP_MARKERS.test(sig.cgroup)) systemClass.push("/proc/1/cgroup");
  if (sig.initEnviron && /(^|\0)container=/.test(sig.initEnviron)) {
    systemClass.push("/proc/1/environ container=");
  }

  const signals = [...dockerClass, ...systemClass];
  return {
    container: signals.length > 0,
    dockerClass: dockerClass.length > 0,
    signals,
  };
}

/** True when the operator has forced host behavior everywhere. */
export function containerDetectionDisabled(
  env: Record<string, string | undefined>,
  noContainerFlag = false,
): boolean {
  return noContainerFlag || env.FORTRESS_CONTAINER === "0";
}

function readTextFile(path: string): string | null {
  try {
    // The two call sites pass literal /proc paths; nothing reaches this from a
    // request.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Read the signals off this host. */
export function readContainerSignals(
  env: Record<string, string | undefined> = process.env,
): ContainerSignals {
  return {
    dockerenv: existsSync("/.dockerenv"),
    containerenv: existsSync("/run/.containerenv"),
    cgroup: readTextFile("/proc/1/cgroup"),
    initEnviron: readTextFile("/proc/1/environ"),
    kubernetes: Boolean(env.KUBERNETES_SERVICE_HOST),
    railway: Object.keys(env).some((key) => key.startsWith("RAILWAY_")),
  };
}

/**
 * Best-effort "what kind of box is this?".
 *
 * Gated to linux on purpose: hx-fortress running natively on macOS is never a
 * container for our purposes and its bind must never widen. A container on a Mac
 * host runs inside a Linux VM, so ITS platform is linux and detection fires.
 */
export function detectContainer(options: {
  env?: Record<string, string | undefined>;
  platform?: string;
  noContainerFlag?: boolean;
} = {}): ContainerVerdict {
  const env = options.env ?? process.env;
  if (containerDetectionDisabled(env, options.noContainerFlag)) return NO_CONTAINER;
  if ((options.platform ?? process.platform) !== "linux") return NO_CONTAINER;
  return containerFromSignals(readContainerSignals(env));
}
