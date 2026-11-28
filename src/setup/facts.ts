// What the setup found, and shows without asking.
//
// A fact is a thing the setup can see for itself: what kind of host this is,
// whether HX Fortress's folder can be written and whether it outlives a
// restart, which version runs, which key a release is checked against. Each
// has a value and a few words that say whether it is as it should be. In the
// install, before anything exists, the facts are what the answers will make.

import { access, constants, stat } from "node:fs/promises";
import os from "node:os";

import { liveDaemonPid } from "../host/modules-api";
import type { fortressPaths } from "../host/paths";
import { hasProductionAnchor, TRUSTED_SIGNING_KEYS } from "../host/trust/signing-keys";
import { detectContainer, type ContainerVerdict } from "../ui/container";
import { FORTRESS_VERSION } from "../version";
import { publicAddress, UPDATES_FROM_OWN, UPDATES_FROM_UNREADABLE, type SetupAnswers } from "./answers";
import { NONE, choiceAt, isCloudPlace, placeInfo } from "./list";
import { DISK_SIZE, sshHost } from "./plan";
import { PROJECT_RELEASES } from "./reach";
import { needsFiles } from "./read";
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
    // HX Fortress's own folder and its parents.
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
  // replaced, and the organization's settings and audit trail go with it.
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
    label: "HX Fortress",
    value: pid === null ? "Not started yet" : "Running",
    note: pid === null ? "" : `pid ${pid}`,
    ok: null,
  });
  return facts;
}

export function auditTrailFacts(deps: Pick<FactDeps, "paths">): Fact[] {
  return [
    {
      label: "Kept here",
      value: "Every sign-in, ask, release and switch",
      note: "cannot be edited",
      ok: true,
    },
    { label: "In", value: deps.paths.auditSpool, note: "and the database", ok: null, mono: true },
  ];
}

/** The release this build is, and whether it is one a signature vouches for. */
function releaseFact(version: string | undefined): Fact {
  const release = hasProductionAnchor();
  return {
    label: "Release",
    value: version ?? FORTRESS_VERSION,
    note: release ? "signature checked" : "a development build",
    ok: release ? true : null,
    mono: true,
  };
}

/**
 * Where new versions come from, and who lets one install.
 *
 * `updates` is the Updates answer. `setBy` names the variable of the host's
 * environment that decides the address, when one does. With neither, the facts
 * are the project's releases, which is where a new version comes from unless
 * an organization names an address of its own. A control plane is never part
 * of it.
 */
export function updatesFacts(
  deps: Pick<FactDeps, "version"> & { updates?: SetupAnswers["updates"]; setBy?: string } = {},
): Fact[] {
  const release = hasProductionAnchor();
  const own = deps.updates?.from === UPDATES_FROM_OWN ? deps.updates.address : "";
  // The same shape each way: what kind of place it is, then where it is.
  // A note is a few words: the page sets it on one line beside the value, and
  // a sentence there takes the value's room. What follows from a setting that
  // cannot be read, and how to put it right, is said by the Updates check.
  const from: Fact =
    deps.updates?.from === UPDATES_FROM_UNREADABLE
      ? {
          label: "From",
          value: "Not known",
          note: deps.setBy ? `${deps.setBy} cannot be understood` : "config.json's update settings cannot be read",
          ok: false,
        }
      : own
        ? {
            label: "From",
            value: "An address this host names",
            note: deps.setBy ? `${own}, set by ${deps.setBy}` : own,
            ok: null,
          }
        : { label: "From", value: "GitHub releases", note: PROJECT_RELEASES, ok: null };
  return [
    from,
    {
      label: "Signing key",
      value: TRUSTED_SIGNING_KEYS.map((key) => key.keyid).join(", "),
      note: release ? "checked on every release" : "a development key: this is not a release build",
      ok: release ? true : null,
      mono: true,
    },
    { label: "Before one installs", value: "An administrator approves it", note: "", ok: null },
  ];
}

function region(answers: SetupAnswers): string {
  const place = placeInfo(answers.where.place);
  if (place.id === "docker") return sshHost(answers.where.ssh);
  return place.regions.find((r) => r.id === answers.where.region)?.name ?? answers.where.region;
}

function optionName(at: string, id: string, answers: SetupAnswers): string {
  const option = choiceAt(at)?.options.find((o) => o.id === id);
  if (!option) return id;
  const place = placeInfo(answers.where.place);
  const text = (place.id === "here" && option.here?.name) || option.name;
  return text.replace("{cloud}", place.short).replace("{postgres}", place.postgres ?? "Postgres");
}

/** The identity provider, as Settings shows it: named, and not asked there. */
export function signInFacts(answers: SetupAnswers): Fact[] {
  if (answers.signIn.provider !== "openid-connect") return [];
  return [
    { label: "Issuer address", value: answers.signIn.issuer || "Not set", note: "", ok: null, mono: true },
    { label: "Client ID", value: answers.signIn.clientId || "Not set", note: "", ok: null, mono: true },
    {
      label: "Client secret",
      value: answers.signIn.clientSecret || "None",
      note: answers.signIn.clientSecret ? "the name of a key" : "a public client",
      ok: null,
      mono: Boolean(answers.signIn.clientSecret),
    },
  ];
}

/** What is known about the control plane beside its address. */
export function controlPlaneFacts(answers: SetupAnswers): Fact[] {
  if (answers.controlPlane.connect !== "yes") return [];
  return [
    answers.controlPlane.pages
      ? { label: "Pages shown in", value: answers.controlPlane.pages, note: "", ok: null, mono: true }
      : {
          label: "Pages shown in",
          value: "Not set",
          note: "none of the control plane's pages can show a page of this HX Fortress",
          ok: null,
        },
  ];
}

/** What the install makes for HX Fortress to run on, before it exists. */
export function installFacts(answers: SetupAnswers, deps: Pick<FactDeps, "version"> = {}): Fact[] {
  const place = placeInfo(answers.where.place);
  return [
    { label: "Runs on", value: place.compute, note: region(answers), ok: null },
    { label: "Disk", value: DISK_SIZE, note: "kept across restarts", ok: null },
    releaseFact(deps.version),
    { label: "Copies running", value: "1", note: "it runs as one copy", ok: null },
  ];
}

/** Where the files of a module go in a cloud: that cloud's own file store,
 *  made with HX Fortress. Nothing while no module that is on keeps files. */
export function filesFacts(answers: SetupAnswers): Fact[] {
  if (!needsFiles(answers) || !isCloudPlace(answers.where.place) || answers.data.files.store === NONE) return [];
  return [
    {
      label: "Session files",
      value: optionName("data.files.store", answers.data.files.store, answers),
      note: "made with HX Fortress",
      ok: null,
    },
  ];
}

/** The facts of an install, as the console's Settings page shows them. They
 *  change when the install command is run again, and nowhere else. */
export function thisInstallFacts(answers: SetupAnswers, deps: Pick<FactDeps, "version"> = {}): Fact[] {
  const place = placeInfo(answers.where.place);
  const address = publicAddress(answers);
  const certificate = answers.address.certificate;
  return [
    { label: "Runs on", value: place.compute, note: region(answers), ok: null },
    {
      label: "Address",
      value: address ? answers.address.hostname : "This machine only",
      note: !address
        ? ""
        : certificate === "cloud-issued"
          ? `certificate from ${place.short}`
          : certificate === "own"
            ? "your own certificate"
            : "a proxy in front holds the certificate",
      ok: null,
      ...(address ? { mono: true } : {}),
    },
    { label: "Keys", value: optionName("keys.store", answers.keys.store, answers), note: "read only", ok: null },
    {
      label: "Database",
      value: optionName("data.database.store", answers.data.database.store, answers),
      note: "",
      ok: null,
    },
    releaseFact(deps.version),
  ];
}
