// Whether this Fortress has been set up, and how the setup leaves its mark.
//
// A Fortress is SET UP when it has a config.json that is a Fortress's own: one
// that holds `schemaVersion`. The setup writes that file when it ends; an
// install made before the setup existed has one from the day it enrolled, and
// counts as set up too. Its config.json is then read as the answers to the
// setup's questions.
//
// A config.json that holds only a block somebody wrote ahead of the setup (the
// key store's, as the README shows for a host install) is not a set-up
// Fortress: the setup reads that block as an answer and writes the rest.
//
// ONE PREDICATE, `isSetUp`, answers the question wherever it is asked: by the
// setup, by a start, and by a container's entry point. A file that is there and
// cannot be read counts as set up, so that nothing writes over it; the start
// then says what is wrong with it.

import { stat } from "node:fs/promises";

import { readConfigObject } from "../host/config";
import type { fortressPaths } from "../host/paths";

type FortressPaths = ReturnType<typeof fortressPaths>;

/** What a Fortress that is not set up says, wherever it is asked to run. */
export const NOT_SET_UP =
  "This Fortress is not set up yet. Run `hx-fortress setup` on this host, then start it again.";

/** The key in config.json that the setup writes when it ends. A top-level key
 *  of the raw file: the typed config does not carry it. */
export const SETUP_MARK_KEY = "setup";

/** How the answers were given. */
export type SetupWay = "browser" | "terminal" | "file";

export interface SetupMark {
  /** The version of the setup's list the answers were given to. */
  list: 1;
  completedAt: string;
  by: SetupWay;
  /** The connection address of the control plane this Fortress was enrolled
   *  with when the setup disconnected it. See `PresentAnswers.disconnectedFrom`. */
  disconnectedFrom?: string;
}

export function setupMark(by: SetupWay, now: Date = new Date()): SetupMark {
  return { list: 1, completedAt: now.toISOString(), by };
}

/** Whether the raw config.json is a set-up Fortress's. Null is no file. */
export function isSetUpConfig(raw: Record<string, unknown> | null): boolean {
  return raw !== null && raw.schemaVersion !== undefined;
}

export async function isSetUp(paths: FortressPaths): Promise<boolean> {
  try {
    return isSetUpConfig(await readConfigObject(paths));
  } catch {
    return true;
  }
}

/** The variable that names a settings file for a container's first start. */
export const SETUP_FILE_ENV = "FORTRESS_SETUP_FILE";

/**
 * True when nothing on this host says how this Fortress should run: it has no
 * config.json, and none of the two older ways to make one is in place. Those
 * are an enrollment token and an address in the environment, and a token that
 * an earlier `hx-fortress enroll` left on disk. A start writes config.json from
 * either, as it always did, so an install that relies on one starts as before.
 */
export async function needsSetupFirst(
  paths: FortressPaths,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  if (await isSetUp(paths)) return false;
  if (env.FORTRESS_ENROLL_TOKEN?.trim() && env.FORTRESS_CLOUD_URL?.trim()) return false;
  // The Fortress's own file, never a path a caller supplies.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const pending = await stat(paths.pendingEnrollment).catch(() => null);
  return pending === null;
}

/** The mark the setup left, or null: for a Fortress that is not set up, and
 *  for one that was installed before the setup existed. */
export async function readSetupMark(paths: FortressPaths): Promise<SetupMark | null> {
  const raw = await readConfigObject(paths).catch(() => null);
  // A constant key of this file.
  // eslint-disable-next-line security/detect-object-injection
  const mark = raw?.[SETUP_MARK_KEY];
  if (typeof mark !== "object" || mark === null) return null;
  const { completedAt, by, disconnectedFrom } = mark as Record<string, unknown>;
  if (typeof completedAt !== "string") return null;
  if (by !== "browser" && by !== "terminal" && by !== "file") return null;
  return {
    list: 1,
    completedAt,
    by,
    ...(typeof disconnectedFrom === "string" && disconnectedFrom ? { disconnectedFrom } : {}),
  };
}
