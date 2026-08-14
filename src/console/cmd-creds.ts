// Single-use credential files for command kinds that need a secret.
//
// A command row carries only a 32-hex reference id; the secret itself lives in a
// 0600 file under <root>/runtime/cmd-creds/ that the daemon UNLINKS as it reads.
// Two consequences the callers depend on:
//
//   • consumption is one-shot, so a replayed or re-driven command cannot re-run
//     a rotation with the same material;
//   • a crash between the unlink and the terminal transition leaves the command
//     unrunnable, so the boot reaper FAILS it with "credential consumed —
//     re-issue" rather than re-driving it into a half-applied rotation.

import { chmod, mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

import { CREDENTIAL_REF_PATTERN } from "./command-params";

/** How long an unconsumed credential file may sit before the sweep removes it. */
export const CMD_CRED_TTL_MS = 15 * 60 * 1000;

export function mintCredentialRef(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Resolve a reference id to its file path, refusing anything that is not a bare
 * 32-hex id and anything whose resolved path leaves the directory. The pattern
 * alone already excludes separators, dots and absolute paths; the realpath check
 * additionally defeats a symlink planted inside the directory.
 */
export async function credentialRefPath(dir: string, ref: string): Promise<string | null> {
  if (!CREDENTIAL_REF_PATTERN.test(ref)) return null;
  const candidate = path.join(dir, `${ref}.json`);
  let resolved: string;
  let resolvedDir: string;
  try {
    resolved = await realpath(candidate);
    resolvedDir = await realpath(dir);
  } catch {
    return null;
  }
  return path.dirname(resolved) === resolvedDir && path.basename(resolved) === `${ref}.json`
    ? candidate
    : null;
}

export async function writeCredentialRef(
  dir: string,
  ref: string,
  payload: unknown,
): Promise<void> {
  if (!CREDENTIAL_REF_PATTERN.test(ref)) throw new Error("invalid credential reference");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, `${ref}.json`);
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, target);
}

/** Read and UNLINK in one step. Returns null when the reference is invalid,
 *  already consumed, or unreadable — all of which the caller must treat as a
 *  terminal failure rather than a retry. */
export async function consumeCredentialRef<T = unknown>(
  dir: string,
  ref: string,
): Promise<T | null> {
  const file = await credentialRefPath(dir, ref);
  if (!file) return null;
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch {
    return null;
  }
  await unlink(file).catch(() => {});
  try {
    return JSON.parse(contents) as T;
  } catch {
    return null;
  }
}

export interface SweepResult {
  deleted: string[];
}

/** Delete credential files older than the TTL. Runs at boot and on a timer: an
 *  orphaned file is a secret sitting on disk for a command that will never run. */
export async function sweepCmdCreds(
  dir: string,
  now: Date = new Date(),
  ttlMs: number = CMD_CRED_TTL_MS,
): Promise<SweepResult> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { deleted: [] };
  }
  const deleted: string[] = [];
  for (const entry of entries) {
    const ref = entry.endsWith(".json") ? entry.slice(0, -5) : null;
    if (!ref || !CREDENTIAL_REF_PATTERN.test(ref)) continue;
    const file = path.join(dir, entry);
    try {
      const info = await stat(file);
      if (now.getTime() - info.mtimeMs < ttlMs) continue;
      await unlink(file);
      deleted.push(ref);
    } catch {
      // Raced with a consumer, or unreadable — nothing to sweep either way.
    }
  }
  return { deleted };
}
