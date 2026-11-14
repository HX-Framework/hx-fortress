// What the setup found on this host, and shows without asking.
//
// A fact is a thing the setup can see for itself: what kind of host this is,
// whether the Fortress's folder can be written and whether it outlives a
// restart, which version runs, which key a release is checked against. Each
// has a value and a few words that say whether it is as it should be.

import { access, constants, stat } from "node:fs/promises";
import os from "node:os";

import { liveDaemonPid } from "../host/modules-api";
import type { fortressPaths } from "../host/paths";
import { hasProductionAnchor, TRUSTED_SIGNING_KEYS } from "../host/trust/signing-keys";
import { detectContainer, type ContainerVerdict } from "../ui/container";
import { FORTRESS_VERSION } from "../version";
import type { Fact } from "./view";

export type { Fact } from "./view";

type FortressPaths = ReturnType<typeof fortressPaths>;

export interface FactDeps {
  paths: FortressPaths;
  env: Record<string, string | undefined>;
  platform?: string;
  container?: ContainerVerdict;
  version?: string;
}

/** The nearest folder that exists, starting at `folder` and going up. */
async function nearestExisting(folder: string): Promise<string> {
  let current = folder;
  for (let i = 0; i < 64; i += 1) {
    // The Fortress's own folder and its parents.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (await stat(current).then(() => true, () => false)) return current;
    const parent = current.replace(/\/[^/]*\/?$/, "") || "/";
    if (parent === current) break;
    current = parent;
  }
  return "/";
}

/** What kind of container this is, from the signals that say so. */
function containerName(verdict: ContainerVerdict): string {
  const signals = verdict.signals.join(" ");
  if (signals.includes("KUBERNETES")) return "Kubernetes";
  if (signals.includes("RAILWAY")) return "Railway";
  if (signals.includes("containerenv")) return "Podman";
  if (signals.includes("dockerenv")) return "Docker";
  return "its runtime";
}

export async function hostFacts(deps: FactDeps): Promise<Fact[]> {
  const platform = deps.platform ?? process.platform;
  const container = deps.container ?? detectContainer({ env: deps.env, platform });
  const facts: Fact[] = [];

  facts.push(
    container.container
      ? { label: "Runs on", value: "A container", note: `started by ${containerName(container)}`, ok: null }
      : {
          label: "Runs on",
          value: platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : platform,
          note: os.hostname(),
          ok: null,
        },
  );

  // The folder everything rests in. In a container it must be a volume: a
  // folder inside the container's own layer is gone when the container is
  // replaced, and the organization's settings and records go with it.
  const root = deps.paths.root;
  const existing = await nearestExisting(root);
  const writable = await access(existing, constants.W_OK).then(() => true, () => false);
  let note = writable ? "can be written" : "cannot be written";
  let ok: boolean | null = writable;
  if (writable && container.container) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const [here, top] = await Promise.all([stat(existing).catch(() => null), stat("/").catch(() => null)]);
    const mounted = here !== null && top !== null && here.dev !== top.dev;
    note = mounted ? "kept across restarts" : "inside the container: it is lost when the container is replaced";
    ok = mounted;
  }
  facts.push({ label: "Folder", value: root, note, ok, mono: true });

  facts.push({
    label: "Version",
    value: deps.version ?? FORTRESS_VERSION,
    note: hasProductionAnchor() ? "a release build" : "a development build",
    ok: null,
    mono: true,
  });

  const pid = await liveDaemonPid(deps.paths).catch(() => null);
  facts.push({
    label: "Fortress",
    value: pid === null ? "Not started yet" : "Running",
    note: pid === null ? "" : `pid ${pid}`,
    ok: null,
  });
  return facts;
}

export function recordsFacts(deps: Pick<FactDeps, "paths">): Fact[] {
  return [
    {
      label: "Kept here",
      value: "Every sign-in, ask, release and switch",
      note: "append-only",
      ok: true,
    },
    { label: "In", value: deps.paths.auditSpool, note: "and the database", ok: null, mono: true },
  ];
}

export function updatesFacts(deps: Pick<FactDeps, "version"> = {}): Fact[] {
  const release = hasProductionAnchor();
  return [
    { label: "This version", value: deps.version ?? FORTRESS_VERSION, note: "", ok: null, mono: true },
    {
      label: "Signing key",
      value: TRUSTED_SIGNING_KEYS.map((key) => key.keyid).join(", "),
      note: release ? "checked on every release" : "a development key: this is not a release build",
      ok: release ? true : null,
      mono: true,
    },
  ];
}
