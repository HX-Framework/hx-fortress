// How a decision about a release reaches the daemon.
//
// The terminal and the console are not the daemon. They hold no handle on the
// modules, and `applyRelease` has to run inside the process that does. So a
// decision is a REQUEST: a 0600 file under the daemon's own runtime directory,
// and a signal. The daemon carries it out and writes an ANSWER beside it, which
// is what the verb then reports — the same shape the roster and audit-witness
// verbs already use.
//
// A local gesture by construction. The directory is 0700 and owned by the user
// the daemon runs as; a request is a file that user wrote. Nothing that arrives
// over the connection can create one.

// Every path this file opens is under the daemon's own request directory, and
// its file name is a request id that passed the id pattern.
/* eslint-disable security/detect-non-literal-fs-filename */

import { randomBytes } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { ReleaseState } from "./module-contract";
import type { fortressPaths } from "./paths";
import { writePrivateJson } from "./private-json";
import { RELEASE_ID_PATTERN } from "./release-shelf";

type FortressPaths = ReturnType<typeof fortressPaths>;

/** A request older than this is dropped unanswered-for: whoever wrote it has
 *  long since been told it was not carried out. */
export const DECISION_REQUEST_TTL_MS = 10 * 60_000;
/** An answer nobody collected is removed after this long. */
export const DECISION_ANSWER_TTL_MS = 60 * 60_000;

const REQUEST_ID = /^[0-9a-f]{32}$/;
const REQUEST_FILE = /^([0-9a-f]{32})\.json$/;
const ANSWER_FILE = /^([0-9a-f]{32})\.answer\.json$/;

export interface ReleaseDecisionRequest {
  requestId: string;
  /** The release. */
  id: string;
  decision: "approve" | "refuse";
  /** Who decided, as the writer knows them. */
  decidedBy: string;
  at: string;
}

export interface ReleaseDecisionAnswer {
  requestId: string;
  ok: boolean;
  /** Why not, when `ok` is false: one of the shelf's refusal words, or `expired`. */
  reason?: string;
  /** Where the release stands now. */
  state?: ReleaseState;
  /** The failure code, when the release was approved and could not be applied. */
  error?: string;
  moduleId?: string;
  version?: string;
  at: string;
}

function requestPath(paths: FortressPaths, requestId: string): string {
  return path.join(paths.releaseDecisions, `${requestId}.json`);
}

function answerPath(paths: FortressPaths, requestId: string): string {
  return path.join(paths.releaseDecisions, `${requestId}.answer.json`);
}

/** Write one request and return its id. */
export async function writeReleaseDecision(
  paths: FortressPaths,
  request: Omit<ReleaseDecisionRequest, "requestId" | "at">,
  now: Date = new Date(),
): Promise<string> {
  const requestId = randomBytes(16).toString("hex");
  await writePrivateJson(requestPath(paths, requestId), {
    requestId,
    ...request,
    at: now.toISOString(),
  } satisfies ReleaseDecisionRequest);
  return requestId;
}

export async function withdrawReleaseDecision(paths: FortressPaths, requestId: string): Promise<void> {
  if (!REQUEST_ID.test(requestId)) return;
  await rm(requestPath(paths, requestId), { force: true });
}

function parseRequest(text: string, requestId: string): ReleaseDecisionRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.requestId !== requestId) return null;
  if (typeof v.id !== "string" || !RELEASE_ID_PATTERN.test(v.id)) return null;
  if (v.decision !== "approve" && v.decision !== "refuse") return null;
  if (typeof v.decidedBy !== "string" || v.decidedBy.length === 0) return null;
  if (typeof v.at !== "string" || Number.isNaN(Date.parse(v.at))) return null;
  return { requestId, id: v.id, decision: v.decision, decidedBy: v.decidedBy, at: v.at };
}

/**
 * Every request waiting to be carried out, oldest first. A file that is not a
 * request this build wrote is removed rather than left to be read again.
 *
 * TAKEN means removed. Each request's file is deleted here, before the caller
 * acts on it, so a request is carried out at most once: a daemon that dies
 * while applying a release does not find the request again when it starts.
 * The terminal that wrote it then gets no answer and says so. A request whose
 * file cannot be removed is not returned, because it could not be made to
 * happen only once.
 */
export async function takeReleaseDecisions(paths: FortressPaths): Promise<ReleaseDecisionRequest[]> {
  let names: string[];
  try {
    names = await readdir(paths.releaseDecisions);
  } catch {
    return [];
  }
  const requests: ReleaseDecisionRequest[] = [];
  for (const name of names.sort()) {
    const match = REQUEST_FILE.exec(name);
    if (!match) continue;
    const requestId = match[1] as string;
    const file = requestPath(paths, requestId);
    const parsed = parseRequest(await readFile(file, "utf8").catch(() => ""), requestId);
    try {
      await rm(file, { force: true });
    } catch {
      continue;
    }
    if (parsed) requests.push(parsed);
  }
  return requests.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** The daemon's answer to a request it took. The request's own file is already
 *  gone: `takeReleaseDecisions` removed it. */
export async function answerReleaseDecision(
  paths: FortressPaths,
  answer: ReleaseDecisionAnswer,
): Promise<void> {
  await writePrivateJson(answerPath(paths, answer.requestId), answer);
}

/** The daemon's answer to one request, or null while there is none. */
export async function readReleaseAnswer(
  paths: FortressPaths,
  requestId: string,
): Promise<ReleaseDecisionAnswer | null> {
  if (!REQUEST_ID.test(requestId)) return null;
  try {
    return JSON.parse(await readFile(answerPath(paths, requestId), "utf8")) as ReleaseDecisionAnswer;
  } catch {
    return null;
  }
}

export async function clearReleaseAnswer(paths: FortressPaths, requestId: string): Promise<void> {
  if (!REQUEST_ID.test(requestId)) return;
  await rm(answerPath(paths, requestId), { force: true });
}

/** Remove answers nobody came back for. */
export async function sweepReleaseAnswers(paths: FortressPaths, now: Date = new Date()): Promise<void> {
  let names: string[];
  try {
    names = await readdir(paths.releaseDecisions);
  } catch {
    return;
  }
  for (const name of names) {
    if (!ANSWER_FILE.test(name)) continue;
    const file = path.join(paths.releaseDecisions, name);
    const info = await stat(file).catch(() => null);
    if (info && now.getTime() - info.mtimeMs > DECISION_ANSWER_TTL_MS) {
      await rm(file, { force: true });
    }
  }
}
