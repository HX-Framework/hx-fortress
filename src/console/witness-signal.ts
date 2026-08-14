// `hx-fortress audit witness on|off`, and why it is a signal rather than a row.
//
// The CLI never mints a console_commands row: INSERT on that table belongs to
// hx_ui alone, and handing the credential to every CLI invocation would widen
// "the console process" into "the console process and every shell on this host"
// — the containment story the whole command plane rests on. It also never reads
// pg.json for the same reason.
//
// So the terminal writes its INTENT to a 0600 file under the daemon's own
// runtime directory and sends the daemon a signal. The daemon — which already
// holds the database — executes hx.set_cloud_witness through the fenced routine,
// clears the intent, and republishes the setting for `witness show` to read.
//
// The published files are the same pattern as status.json and metrics.json: the
// daemon writes, everyone else reads.

import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { writePrivateJson } from "../host/private-json";

/** The signal the terminal sends. SIGUSR2 is unused elsewhere in the daemon. */
export const WITNESS_SIGNAL = "SIGUSR2" as const;

export interface WitnessIntent {
  /** Absent when the writer is not changing the setting. A reconcile that only
   *  re-confirms acknowledgements must not carry a value it had to guess: the
   *  published mirror is written by an explicit toggle, so on a host that never
   *  ran one it is simply missing, and `?? false` there turns the witness OFF. */
  enabled?: boolean;
  at: string;
  /** Acknowledgements the corrective pass asks to be re-confirmed, if any. */
  reconfirm?: Array<{ org: string; sessionId: string; reason: string }>;
}

export interface PublishedAuditSettings {
  cloudWitness: boolean;
  writtenAt: string;
}

export interface PublishedAck {
  org: string;
  sessionId: string;
  acknowledgedAt: string;
  acknowledgedBy: string | null;
  reason: string | null;
}

export function witnessIntentPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "witness-intent.json");
}

export function auditSettingsPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "audit-settings.json");
}

export function auditAcksPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "audit-acks.json");
}

const writeJson = (file: string, value: unknown): Promise<void> => writePrivateJson(file, value);

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function writeWitnessIntent(
  runtimeRoot: string,
  intent: WitnessIntent,
): Promise<void> {
  await writeJson(witnessIntentPath(runtimeRoot), intent);
}

export function readWitnessIntent(runtimeRoot: string): Promise<WitnessIntent | null> {
  return readJson<WitnessIntent>(witnessIntentPath(runtimeRoot));
}

export async function clearWitnessIntent(runtimeRoot: string): Promise<void> {
  await rm(witnessIntentPath(runtimeRoot), { force: true });
}

export async function publishAuditSettings(
  runtimeRoot: string,
  cloudWitness: boolean,
  now: Date = new Date(),
): Promise<void> {
  await writeJson(auditSettingsPath(runtimeRoot), {
    cloudWitness,
    writtenAt: now.toISOString(),
  } satisfies PublishedAuditSettings);
}

export function readPublishedAuditSettings(
  runtimeRoot: string,
): Promise<PublishedAuditSettings | null> {
  return readJson<PublishedAuditSettings>(auditSettingsPath(runtimeRoot));
}

export async function publishAcks(runtimeRoot: string, acks: readonly PublishedAck[]): Promise<void> {
  await writeJson(auditAcksPath(runtimeRoot), { acks });
}

export async function readPublishedAcks(runtimeRoot: string): Promise<PublishedAck[]> {
  const file = await readJson<{ acks?: PublishedAck[] }>(auditAcksPath(runtimeRoot));
  return file?.acks ?? [];
}

/** Nudge the daemon. False when there is no daemon to nudge — which is a
 *  refusal the caller reports, never a silent success: the setting gates egress
 *  and an operator who thinks they turned it off must not be wrong. */
export function signalDaemon(pid: number | null, kill = process.kill): boolean {
  if (pid === null || pid <= 0) return false;
  try {
    kill(pid, WITNESS_SIGNAL);
    return true;
  } catch {
    return false;
  }
}
