// What a credential rotation is, and the three shapes one can take.
//
// The secret NEVER reaches the command row. It arrives as a 0600 single-use
// file the daemon unlinks as it reads, and the row carries only its 32-hex
// reference — so a rotation is not readable by anyone with SELECT on the table,
// is not replayable, and leaves nothing behind if the daemon dies mid-way.
//
// The daemon is the single writer of credentials.json. The console asks; this is
// what answers.

import type { VaultCredentials } from "../modules/session-vault/credentials";

export type RotationTarget = "storage" | "openai" | "cloud";

export interface StorageRotation {
  target: "storage";
  /** The whole storage block, as the enroll wizard would have written it. */
  credentials: VaultCredentials;
}

export interface OpenAiRotation {
  target: "openai";
  apiKey: string;
}

export interface CloudRotation {
  target: "cloud";
  /** The `vlc_…` paste from the workbench. */
  credential: string;
}

export type RotationPayload = StorageRotation | OpenAiRotation | CloudRotation;

/** Env-managed credentials cannot be rotated through the file: the next boot
 *  rebuilds credentials.json from the environment and the rotation would vanish
 *  without a word. Names the variable, because the fix is a deploy. */
export function envManagedRefusal(target: RotationTarget): string {
  return (
    `refused — this fortress's storage credentials come from FORTRESS_STORAGE_BUCKET and the ` +
    `variables beside it, and every boot rebuilds credentials.json from them. A ${target} ` +
    `rotation written here would be discarded on the next restart. Change it in your deployment.`
  );
}

/** A rotation attempted while a storage migration holds the write gate. A
 *  DISTINCT failure from a broken credential: the credentials may be perfect,
 *  and telling an operator otherwise sends them re-issuing keys mid-migration. */
export function migrationInProgressRefusal(reference: string): string {
  return `refused — a storage migration is in progress (run ${reference})`;
}

/** What the refusal names when the migration has armed no pause yet: the copy
 *  phase holds nothing but the in-process latch, and there is no episode id to
 *  quote. */
export const MIGRATION_COPYING_REFERENCE = "copying";

export function isRotationPayload(value: unknown): value is RotationPayload {
  if (!value || typeof value !== "object") return false;
  const target = (value as { target?: unknown }).target;
  if (target === "openai") return typeof (value as OpenAiRotation).apiKey === "string";
  if (target === "cloud") {
    const credential = (value as CloudRotation).credential;
    return typeof credential === "string" && credential.startsWith("vlc_");
  }
  if (target !== "storage") return false;
  const credentials = (value as StorageRotation).credentials;
  return (
    !!credentials &&
    typeof credentials === "object" &&
    typeof (credentials as VaultCredentials).bucket === "string" &&
    ((credentials as VaultCredentials).store === "s3" ||
      (credentials as VaultCredentials).store === "gcs")
  );
}

/** The file as it will be AFTER this rotation. A storage rotation replaces the
 *  storage block and keeps the embedding key; an OpenAI rotation does the
 *  reverse. Neither ever drops the other, which is the failure a whole-file
 *  write would produce. */
export function applyRotation(
  current: VaultCredentials | null,
  payload: RotationPayload,
): VaultCredentials {
  if (payload.target === "openai") {
    if (!current) {
      throw new Error("this fortress has no storage credentials yet — run the enroll wizard first");
    }
    return { ...current, openaiApiKey: payload.apiKey };
  }
  if (payload.target === "cloud") {
    throw new Error("the cloud credential does not live in credentials.json");
  }
  const next: VaultCredentials = { ...payload.credentials };
  if (current?.openaiApiKey) next.openaiApiKey = current.openaiApiKey;
  return next;
}

/** What the outcome says. Identifiers only — a bucket name and a provider are
 *  facts an operator needs; a key is never one of them. */
export function describeRotation(payload: RotationPayload, applied: VaultCredentials | null): string {
  switch (payload.target) {
    case "storage":
      return `storage credentials rotated (${payload.credentials.store}, bucket ${payload.credentials.bucket})`;
    case "openai":
      return `embedding key rotated${applied?.bucket ? ` (bucket ${applied.bucket} untouched)` : ""}`;
    case "cloud":
      return "cloud credential rotated — the tunnel reconnects with it";
  }
}
