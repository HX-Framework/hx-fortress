// Env-driven, non-interactive bootstrap for the let.ai cloud-service run mode.
// A container started with only environment variables and an empty mounted
// volume materializes the same on-disk state the interactive enroll wizard
// would — storage credentials for the session_vault and a pending enrollment
// token — so the host enrolls into the let.ai hub on first boot with zero
// interaction. Restarts persist config.json / credentials.json / signing-key on
// the volume and re-`hello` without re-enrolling; storage credentials are
// re-applied from the environment on every boot (idempotent, the env is the
// source of truth and supports rotation).

import type { CloudCredential, CredentialStore, PendingEnrollment } from "../cloud";
import {
  type GcsServiceAccountKey,
  type S3Credentials,
  type VaultCredentials,
  type VaultStorageKind,
} from "../modules/session-vault/credentials";
import { parseBooleanEnv } from "../env";

export interface HeadlessLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

interface PendingEnrollmentWriter {
  load(): Promise<PendingEnrollment | null>;
  save(enrollment: PendingEnrollment): Promise<void>;
}

export interface ApplyHeadlessBootstrapDeps {
  env: Record<string, string | undefined>;
  credentialStore: Pick<CredentialStore, "load">;
  pendingEnrollmentStore: PendingEnrollmentWriter;
  writeVaultCredentials: (creds: VaultCredentials) => Promise<void>;
  /** The on-disk credentials, so the fields the environment does not manage
   *  survive the rebuild. Omitted ⇒ nothing to carry over (a fresh volume). */
  readVaultCredentials?: () => Promise<VaultCredentials | null>;
  logger: HeadlessLogger;
}

export interface HeadlessBootstrapResult {
  wroteVaultCredentials: boolean;
  wrotePendingEnrollment: boolean;
}

/** Parse session_vault storage credentials from the environment. Returns null
 *  when no bucket is configured, leaving any on-disk credentials untouched. */
export function parseVaultCredentialsFromEnv(
  env: Record<string, string | undefined>,
): VaultCredentials | null {
  const bucket = env.FORTRESS_STORAGE_BUCKET?.trim();
  if (!bucket) return null;

  const kind = parseStorageKind(env.FORTRESS_STORAGE_KIND);
  const region = env.FORTRESS_STORAGE_REGION?.trim() || undefined;

  if (kind === "gcs") {
    const creds: VaultCredentials = { store: "gcs", bucket };
    if (region) creds.region = region;
    const projectId = env.FORTRESS_GCS_PROJECT_ID?.trim();
    if (projectId) creds.projectId = projectId;
    const gcs = parseGcsServiceAccountKey(env.FORTRESS_GCS_SA_KEY);
    if (gcs) creds.gcs = gcs;
    return creds;
  }

  const creds: VaultCredentials = { store: "s3", bucket };
  if (region) creds.region = region;
  const endpoint = env.FORTRESS_S3_ENDPOINT?.trim();
  if (endpoint) creds.endpoint = endpoint;
  if (parseBooleanEnv(env.FORTRESS_S3_FORCE_PATH_STYLE)) creds.forcePathStyle = true;
  const s3 = parseS3Credentials(env);
  if (s3) creds.s3 = s3;
  return creds;
}

/** Apply env-driven bootstrap. Idempotent and safe to run on every boot:
 *  storage credentials are re-applied from the environment; a pending
 *  enrollment is written only on a truly fresh boot (no saved credential and no
 *  enrollment already pending), so a restart re-`hello`s instead of re-enrolling
 *  with an already-consumed token. */
export async function applyHeadlessBootstrap(
  deps: ApplyHeadlessBootstrapDeps,
): Promise<HeadlessBootstrapResult> {
  const { env, logger } = deps;
  let wroteVaultCredentials = false;
  let wrotePendingEnrollment = false;

  const vaultCreds = parseVaultCredentialsFromEnv(env);
  if (vaultCreds) {
    // Rebuild from the environment (so REMOVING an env var actually takes
    // effect), then carry back exactly the fields the environment does not
    // manage. `version` is one of them: without it every redeploy would rewrite
    // the file with the counter absent — reading as 0 — and the console would
    // see 1 → 1 across genuinely different credentials and keep signing with
    // the old ones.
    //
    // A read that FAILS is not a read that found nothing. `readVaultCredentials`
    // refuses on unparseable JSON precisely so a torn file is never silently
    // rebuilt; catching that to null here reinstated the loss it was written to
    // stop — `openaiApiKey` gone and the CAS `version` rewound — on every boot of
    // the container path, since the raw writer takes no lock and asks no
    // questions. ENOENT is the only absence: the reader already returns null for
    // it, so anything thrown is a real fault and is re-raised by name.
    const existing = await deps.readVaultCredentials?.().catch((err: unknown) => {
      throw new Error(
        "the existing session_vault credentials could not be read, so this fortress will not rebuild " +
          `them from the environment and overwrite what is there (${
            err instanceof Error ? err.message : String(err)
          }). Move the file aside once you have a copy, then restart.`,
        { cause: err },
      );
    });
    const merged = reattachUnmanaged(vaultCreds, existing ?? null);
    await deps.writeVaultCredentials(merged);
    wroteVaultCredentials = true;
    logger.info("Applied session_vault storage credentials from environment", {
      store: merged.store,
      bucket: merged.bucket,
    });
  }

  const token = env.FORTRESS_ENROLL_TOKEN?.trim();
  const cloudUrl = env.FORTRESS_CLOUD_URL?.trim();
  if (token && cloudUrl) {
    const existing = await loadCredentialQuietly(deps.credentialStore, logger);
    const alreadyPending = await deps.pendingEnrollmentStore.load().catch(() => null);
    if (existing) {
      logger.info("Skipping enrollment — Fortress already holds a saved credential");
    } else if (alreadyPending) {
      logger.info("Skipping enrollment — a pending enrollment is already staged");
    } else {
      await deps.pendingEnrollmentStore.save({ token, cloudUrl });
      wrotePendingEnrollment = true;
      logger.info("Staged pending enrollment from environment", { cloudUrl });
    }
  }

  return { wroteVaultCredentials, wrotePendingEnrollment };
}

/** The fields a headless rebuild carries over from the previous file. Keep this
 *  list and the reason for each entry together — anything not named here is
 *  env-managed and is meant to disappear when its variable does. */
export function reattachUnmanaged(
  fromEnv: VaultCredentials,
  existing: VaultCredentials | null,
): VaultCredentials {
  if (!existing) return fromEnv;
  const merged: VaultCredentials = { ...fromEnv };
  // Set in the enroll wizard, never by the container environment.
  if (existing.openaiApiKey) merged.openaiApiKey = existing.openaiApiKey;
  // Monotonic across redeploys — see the call site.
  if (typeof existing.version === "number") merged.version = existing.version;
  return merged;
}

async function loadCredentialQuietly(
  store: Pick<CredentialStore, "load">,
  logger: HeadlessLogger,
): Promise<CloudCredential | null> {
  try {
    return await store.load();
  } catch (error) {
    logger.error("Failed to read existing Fortress credential during bootstrap", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function parseStorageKind(value: string | undefined): VaultStorageKind {
  const kind = value?.trim();
  if (!kind || kind === "gcs") return "gcs";
  if (kind === "s3") return "s3";
  throw new Error(`Unsupported FORTRESS_STORAGE_KIND: ${kind} (expected "gcs" or "s3")`);
}

/** Accept a GCP service-account key as raw JSON or base64-encoded JSON. Env
 *  transports mangle the embedded private-key newlines unevenly, so base64 is
 *  the safer wire form; raw JSON is accepted for local convenience. */
function parseGcsServiceAccountKey(value: string | undefined): GcsServiceAccountKey | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const parsed = tryParseJson(raw) ?? tryParseJson(decodeBase64(raw));
  if (!parsed) {
    throw new Error("FORTRESS_GCS_SA_KEY is not valid JSON or base64-encoded JSON");
  }
  return parsed;
}

function parseS3Credentials(env: Record<string, string | undefined>): S3Credentials | undefined {
  const accessKeyId = env.FORTRESS_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.FORTRESS_S3_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) return undefined;
  const creds: S3Credentials = { accessKeyId, secretAccessKey };
  const sessionToken = env.FORTRESS_S3_SESSION_TOKEN?.trim();
  if (sessionToken) creds.sessionToken = sessionToken;
  return creds;
}

function tryParseJson(value: string | null): GcsServiceAccountKey | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as GcsServiceAccountKey;
    }
    return null;
  } catch {
    return null;
  }
}

function decodeBase64(value: string): string | null {
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return null;
  }
}
