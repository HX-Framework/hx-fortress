// What the last step of the setup shows before a person says yes: one row
// for each thing the answers make, in the order it is made.
//
// The install makes HX Fortress somewhere else: a container, a disk, a key
// store, a database, the connection to the control plane, the DNS record, the
// certificate, and last the address itself. A setup on the machine that runs
// HX Fortress writes its settings there. Nobody types this list. It is worked
// out from the answers, and it holds nothing that the answers do not make.
//
// A row's `id` is what the place reports its progress by.
//
// Free of Node: a page may work the rows out as a person answers.

import { hostOf, publicAddress, type SetupAnswers } from "./answers";
import { NONE, choiceAt, isCloudPlace, placeInfo } from "./list";
import type { PlanRow, PlanShown } from "./view";

/** The size of the disk HX Fortress gets. */
export const DISK_SIZE = "32 GB";

/** The rows an install can make, by id. */
export const PLAN_ROW_IDS = [
  "container",
  "disk",
  "keys",
  "database",
  "files",
  "controlPlane",
  "dns",
  "certificate",
  "open",
] as const;

export type PlanRowId = (typeof PLAN_ROW_IDS)[number];

/** The host of `user@host`. */
export function sshHost(ssh: string): string {
  return hostOf(ssh.trim().replace(/^[^@]*@/, ""));
}

function optionName(path: string, id: string): string {
  return choiceAt(path)?.options.find((option) => option.id === id)?.name ?? id;
}

/**
 * The plan of an install.
 *
 * `needsFiles` says whether a module that is on keeps files.
 */
export function installPlan(answers: SetupAnswers, options: { needsFiles: boolean }): PlanShown {
  const a = answers;
  const place = placeInfo(a.where.place);
  const cloud = isCloudPlace(place.id);
  const region = place.regions.find((r) => r.id === a.where.region)?.name ?? a.where.region;
  const machine = sshHost(a.where.ssh);
  const hostname = a.address.hostname.trim();
  const rows: PlanRow[] = [];
  const row = (id: PlanRowId, label: string, value: string): void => {
    rows.push({ id, label, value });
  };

  row("container", cloud ? place.compute : "Container", `hx-fortress, 1 copy${cloud || !machine ? "" : `, on ${machine}`}`);
  row("disk", "Disk", DISK_SIZE);
  if (cloud && a.keys.store === place.keys) {
    row("keys", optionName("keys.store", a.keys.store), a.keys.vault || "for HX Fortress alone");
  }
  if (a.data.database.store === "managed") {
    row("database", place.postgres ?? "Postgres", "reached only by HX Fortress");
  } else if (a.data.database.store === "beside") {
    row("database", "Postgres", "a second container");
  } else {
    row("database", "Postgres", "an existing one, connected");
  }
  if (options.needsFiles && cloud && a.data.files.store !== NONE) {
    row("files", optionName("data.files.store", a.data.files.store), "for session files");
  }
  if (a.controlPlane.connect === "yes" && a.controlPlane.connected !== "off") {
    row(
      "controlPlane",
      "Control plane",
      [hostOf(a.controlPlane.address), a.organization.name.trim() ? `as ${a.organization.name.trim()}` : ""]
        .filter(Boolean)
        .join(", "),
    );
  }
  if (a.address.certificate !== NONE) row("dns", "DNS record", hostname);
  if (a.address.certificate === "cloud-issued") {
    row("certificate", "SSL certificate", `from ${place.short}, renewed by ${place.short}`);
  }
  if (a.address.certificate === "own") {
    row("certificate", "SSL certificate", `yours, ${a.address.certificateName || "by name"}`);
  }
  if (a.address.certificate === NONE) row("open", "Open to your proxy", `which serves ${publicAddress(a)}`);
  else row("open", "On the internet", publicAddress(a));

  return {
    heading: cloud ? `In your ${place.short}${region ? `, ${region}` : ""}` : `On ${machine || "your machine"}`,
    rows,
  };
}

/**
 * The plan of a setup on the machine that runs HX Fortress: what is written
 * there.
 */
export function setupPlan(
  answers: SetupAnswers,
  options: {
    /** HX Fortress's own folder. */
    folder: string;
    /** The login of the account the end makes, or null when it makes none. */
    account: string | null;
    /** True when the end keeps a one-time install id for the first connection. */
    connects: boolean;
  },
): PlanShown {
  const rows: PlanRow[] = [{ id: "settings", label: "Settings", value: `in ${options.folder}` }];
  if (options.connects) {
    rows.push({
      id: "controlPlane",
      label: "Control plane",
      value: [
        hostOf(answers.controlPlane.address),
        answers.organization.name.trim() ? `as ${answers.organization.name.trim()}` : "",
      ]
        .filter(Boolean)
        .join(", "),
    });
  }
  if (options.account) {
    rows.push({ id: "account", label: "First administrator", value: `${options.account}, with a one-time link` });
  }
  rows.push({ id: "console", label: "Console", value: publicAddress(answers) || "on this machine only" });
  return { heading: "On this machine", rows };
}
