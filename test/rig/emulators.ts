// The storage emulator rig — MinIO for S3, fake-gcs-server for GCS.
//
// The vault's two store backends are the code most likely to be wrong in a way
// unit tests cannot see: signed URLs, multipart compose, versioned deletes and
// bucket-level listing are all provider behaviour, not ours. Mocks assert our
// idea of the protocol back at us.
//
// Both images are PINNED BY DIGEST. A floating tag turns "the store still works"
// into "the store worked against whatever was pushed this morning", which is the
// same class of non-test as mocking it. Ports and credentials are fixed so a
// developer's rig and CI observe the same rig.
//
// Reaching either emulator requires an explicit opt-in in the code under test:
// MinIO is plaintext on a private address, which endpoint-safety refuses unless
// FORTRESS_S3_ALLOW_PRIVATE_ENDPOINT is set, and fake-gcs is reached through
// GcsStoreConfig.apiEndpoint rather than an ambient env var. Neither can be
// wandered into by a deployed fortress.

import { generateKeyPairSync } from "node:crypto";
import { rm } from "node:fs/promises";

export interface EmulatorImage {
  image: string;
  /** Human-readable, for the person reading a failing log. Never what is pulled. */
  tag: string;
  /** The multi-arch index digest — what `docker run` is actually given. */
  digest: string;
}

export const MINIO_IMAGE: EmulatorImage = {
  image: "quay.io/minio/minio",
  tag: "RELEASE.2025-04-22T22-12-26Z",
  digest: "sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e",
};

export const FAKE_GCS_IMAGE: EmulatorImage = {
  image: "fsouza/fake-gcs-server",
  tag: "1.52.2",
  digest: "sha256:d47b4cf8b87006cab8fbbecfa5f06a2a3c5722e464abddc0d107729663d40ec4",
};

/** What `docker run` receives: the digest, never the tag. */
export function imageRef(image: EmulatorImage): string {
  return `${image.image}@${image.digest}`;
}

export const MINIO_PORT = 19000;
export const FAKE_GCS_PORT = 19100;
export const MINIO_ACCESS_KEY = "hxfortressrig";
export const MINIO_SECRET_KEY = "hxfortressrigsecret";
export const RIG_BUCKET = "hx-fortress-rig";

const MINIO_CONTAINER = "hx-fortress-rig-minio";
const FAKE_GCS_CONTAINER = "hx-fortress-rig-gcs";

/** The environment a test must set to reach MinIO. Named here so the opt-in is
 *  one fact in one place rather than a string repeated across suites. */
export function minioEnv(): Record<string, string> {
  return {
    FORTRESS_S3_ENDPOINT: `http://127.0.0.1:${MINIO_PORT}`,
    FORTRESS_S3_ALLOW_PRIVATE_ENDPOINT: "1",
    AWS_ACCESS_KEY_ID: MINIO_ACCESS_KEY,
    AWS_SECRET_ACCESS_KEY: MINIO_SECRET_KEY,
    AWS_REGION: "us-east-1",
  };
}

/** fake-gcs verifies no signature, but the SDK refuses to SIGN without a private
 *  key — so the rig mints a throwaway one. It authenticates nothing; it exists so
 *  the signing code path runs at all instead of being skipped in the one test
 *  that was meant to cover it. Generated per call, never persisted. */
export function fakeGcsSigner(): { client_email: string; private_key: string } {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    client_email: "rig@hx-fortress-rig.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export function fakeGcsEndpoint(): string {
  return `http://127.0.0.1:${FAKE_GCS_PORT}`;
}

export type EmulatorStatus =
  | { available: true }
  | { available: false; reason: string };

function docker(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["docker", ...args]);
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** Why a suite skipped. A skip with no reason is indistinguishable from a test
 *  that never existed, which is how emulator coverage quietly reaches zero. */
export function emulatorStatus(): EmulatorStatus {
  try {
    const version = docker(["version", "--format", "{{.Server.Version}}"]);
    if (version.status !== 0) {
      return { available: false, reason: "docker is installed but no daemon is reachable" };
    }
  } catch {
    return { available: false, reason: "docker is not installed on this host" };
  }
  return { available: true };
}

function runContainer(name: string, args: readonly string[]): void {
  docker(["rm", "-f", name]);
  const result = docker(["run", "-d", "--name", name, ...args]);
  if (result.status !== 0) {
    throw new Error(`failed to start ${name}: ${result.stderr.trim()}`);
  }
}

export interface EmulatorRig {
  minioEndpoint: string;
  gcsEndpoint: string;
  bucket: string;
  down: () => Promise<void>;
}

/** Start both emulators and wait until each answers. Idempotent: an existing
 *  container from an interrupted run is replaced, not collided with. */
export async function emulatorsUp(): Promise<EmulatorRig> {
  const status = emulatorStatus();
  if (!status.available) throw new Error(status.reason);

  runContainer(MINIO_CONTAINER, [
    "-p",
    `127.0.0.1:${MINIO_PORT}:9000`,
    "-e",
    `MINIO_ROOT_USER=${MINIO_ACCESS_KEY}`,
    "-e",
    `MINIO_ROOT_PASSWORD=${MINIO_SECRET_KEY}`,
    imageRef(MINIO_IMAGE),
    "server",
    "/data",
  ]);
  runContainer(FAKE_GCS_CONTAINER, [
    "-p",
    `127.0.0.1:${FAKE_GCS_PORT}:4443`,
    imageRef(FAKE_GCS_IMAGE),
    "-scheme",
    "http",
    "-public-host",
    `127.0.0.1:${FAKE_GCS_PORT}`,
  ]);

  await waitFor(`http://127.0.0.1:${MINIO_PORT}/minio/health/live`);
  await waitFor(`${fakeGcsEndpoint()}/storage/v1/b`);

  return {
    minioEndpoint: `http://127.0.0.1:${MINIO_PORT}`,
    gcsEndpoint: fakeGcsEndpoint(),
    bucket: RIG_BUCKET,
    down: emulatorsDown,
  };
}

/** Idempotent, and never fails: teardown that can itself fail leaves a rig half
 *  up and a suite that cannot start next time. */
export async function emulatorsDown(): Promise<void> {
  for (const name of [MINIO_CONTAINER, FAKE_GCS_CONTAINER]) {
    try {
      docker(["rm", "-f", name]);
    } catch {
      // Docker gone, or the container already removed. Nothing to undo.
    }
  }
}

async function waitFor(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok || response.status === 404) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() >= deadline) throw new Error(`emulator did not answer at ${url}`);
    await Bun.sleep(250);
  }
}

/** Remove a scratch directory, tolerating one that is already gone. */
export async function removeQuietly(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
