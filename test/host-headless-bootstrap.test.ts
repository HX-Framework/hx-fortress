import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  applyHeadlessBootstrap,
  parseVaultCredentialsFromEnv,
} from "../src/host/headless-bootstrap";
import {
  FileCredentialStore,
  FilePendingEnrollmentStore,
  type CloudCredential,
} from "../src/cloud";
import type { VaultCredentials } from "../src/modules/session-vault/credentials";

const SA_KEY = {
  type: "service_account",
  project_id: "letai-cloud",
  client_email: "vault@letai-cloud.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
};

const silentLogger = {
  info() {},
  error() {},
};

describe("parseVaultCredentialsFromEnv", () => {
  test("returns null when no bucket is configured", () => {
    expect(parseVaultCredentialsFromEnv({})).toBeNull();
  });

  test("defaults to gcs and parses an inline service-account key (raw JSON)", () => {
    const creds = parseVaultCredentialsFromEnv({
      FORTRESS_STORAGE_BUCKET: "letai-sessions",
      FORTRESS_STORAGE_REGION: "us-central1",
      FORTRESS_GCS_PROJECT_ID: "letai-cloud",
      FORTRESS_GCS_SA_KEY: JSON.stringify(SA_KEY),
    });
    expect(creds).toEqual({
      store: "gcs",
      bucket: "letai-sessions",
      region: "us-central1",
      projectId: "letai-cloud",
      gcs: SA_KEY,
    });
  });

  test("accepts a base64-encoded service-account key", () => {
    const creds = parseVaultCredentialsFromEnv({
      FORTRESS_STORAGE_BUCKET: "letai-sessions",
      FORTRESS_GCS_SA_KEY: Buffer.from(JSON.stringify(SA_KEY)).toString("base64"),
    });
    expect(creds?.gcs).toEqual(SA_KEY);
  });

  test("omits the gcs key when none is supplied (application default credentials)", () => {
    const creds = parseVaultCredentialsFromEnv({
      FORTRESS_STORAGE_BUCKET: "letai-sessions",
      FORTRESS_STORAGE_KIND: "gcs",
    });
    expect(creds).toEqual({ store: "gcs", bucket: "letai-sessions" });
  });

  test("parses an s3 backend with inline access keys", () => {
    const creds = parseVaultCredentialsFromEnv({
      FORTRESS_STORAGE_KIND: "s3",
      FORTRESS_STORAGE_BUCKET: "letai-sessions",
      FORTRESS_STORAGE_REGION: "us-east-1",
      FORTRESS_S3_ACCESS_KEY_ID: "AKIA",
      FORTRESS_S3_SECRET_ACCESS_KEY: "secret",
    });
    expect(creds).toEqual({
      store: "s3",
      bucket: "letai-sessions",
      region: "us-east-1",
      s3: { accessKeyId: "AKIA", secretAccessKey: "secret" },
    });
  });

  test("throws on an unknown storage kind", () => {
    expect(() =>
      parseVaultCredentialsFromEnv({
        FORTRESS_STORAGE_KIND: "azure",
        FORTRESS_STORAGE_BUCKET: "letai-sessions",
      }),
    ).toThrow();
  });
});

describe("applyHeadlessBootstrap", () => {
  let root: string;
  let pendingStore: FilePendingEnrollmentStore;
  let credentialStore: FileCredentialStore;
  let written: VaultCredentials[];

  const writeVaultCredentials = async (creds: VaultCredentials) => {
    written.push(creds);
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "fortress-headless-"));
    pendingStore = new FilePendingEnrollmentStore(path.join(root, "pending-enrollment.json"));
    credentialStore = new FileCredentialStore(path.join(root, "credentials.json"));
    written = [];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("writes vault credentials and a pending enrollment on a fresh boot", async () => {
    const result = await applyHeadlessBootstrap({
      env: {
        FORTRESS_ENROLL_TOKEN: "enroll-123",
        FORTRESS_CLOUD_URL: "wss://let.ai/api/fortress/tunnel",
        FORTRESS_STORAGE_BUCKET: "letai-sessions",
        FORTRESS_GCS_PROJECT_ID: "letai-cloud",
        FORTRESS_GCS_SA_KEY: JSON.stringify(SA_KEY),
      },
      credentialStore,
      pendingEnrollmentStore: pendingStore,
      writeVaultCredentials,
      logger: silentLogger,
    });

    expect(result).toEqual({ wroteVaultCredentials: true, wrotePendingEnrollment: true });
    expect(written).toHaveLength(1);
    expect(written[0]?.bucket).toBe("letai-sessions");
    expect(await pendingStore.load()).toEqual({
      token: "enroll-123",
      cloudUrl: "wss://let.ai/api/fortress/tunnel",
    });
  });

  test("REFUSES to rebuild over credentials it could not read", async () => {
    // The refusal in readVaultCredentials exists so a torn credentials.json is
    // never silently overwritten. Swallowing it here reinstated the loss on the
    // container path — every boot rewrote the file from the environment, so
    // openaiApiKey was destroyed and the CAS version rewound — with the raw,
    // lock-free writer and no operator in the loop.
    await expect(
      applyHeadlessBootstrap({
        env: {
          FORTRESS_STORAGE_BUCKET: "letai-sessions",
          FORTRESS_GCS_PROJECT_ID: "letai-cloud",
          FORTRESS_GCS_SA_KEY: JSON.stringify(SA_KEY),
        },
        credentialStore,
        pendingEnrollmentStore: pendingStore,
        writeVaultCredentials,
        readVaultCredentials: () =>
          Promise.reject(new Error("credentials.json exists but is not valid JSON")),
        logger: silentLogger,
      }),
    ).rejects.toThrow("will not rebuild");
    // Nothing was written over it.
    expect(written).toHaveLength(0);
  });

  test("an ABSENT credentials file is still a fresh boot, not a refusal", async () => {
    const result = await applyHeadlessBootstrap({
      env: {
        FORTRESS_STORAGE_BUCKET: "letai-sessions",
        FORTRESS_GCS_PROJECT_ID: "letai-cloud",
        FORTRESS_GCS_SA_KEY: JSON.stringify(SA_KEY),
      },
      credentialStore,
      pendingEnrollmentStore: pendingStore,
      writeVaultCredentials,
      readVaultCredentials: () => Promise.resolve(null),
      logger: silentLogger,
    });
    expect(result.wroteVaultCredentials).toBe(true);
    expect(written).toHaveLength(1);
  });

  test("does not write a pending enrollment when a credential already exists", async () => {
    const cred: CloudCredential = {
      orgId: "org-1",
      fortressId: "fortress-1",
      credential: "cred-1",
    };
    await credentialStore.save(cred);

    const result = await applyHeadlessBootstrap({
      env: {
        FORTRESS_ENROLL_TOKEN: "enroll-123",
        FORTRESS_CLOUD_URL: "wss://let.ai/api/fortress/tunnel",
        FORTRESS_STORAGE_BUCKET: "letai-sessions",
      },
      credentialStore,
      pendingEnrollmentStore: pendingStore,
      writeVaultCredentials,
      logger: silentLogger,
    });

    expect(result.wrotePendingEnrollment).toBe(false);
    expect(await pendingStore.load()).toBeNull();
    // Storage credentials are still refreshed from the environment on every boot.
    expect(result.wroteVaultCredentials).toBe(true);
  });

  test("leaves an existing pending enrollment untouched", async () => {
    await pendingStore.save({ token: "original", cloudUrl: "wss://existing/tunnel" });

    const result = await applyHeadlessBootstrap({
      env: {
        FORTRESS_ENROLL_TOKEN: "enroll-123",
        FORTRESS_CLOUD_URL: "wss://let.ai/api/fortress/tunnel",
      },
      credentialStore,
      pendingEnrollmentStore: pendingStore,
      writeVaultCredentials,
      logger: silentLogger,
    });

    expect(result.wrotePendingEnrollment).toBe(false);
    expect(await pendingStore.load()).toEqual({
      token: "original",
      cloudUrl: "wss://existing/tunnel",
    });
  });

  test("does nothing when no headless env is present", async () => {
    const result = await applyHeadlessBootstrap({
      env: {},
      credentialStore,
      pendingEnrollmentStore: pendingStore,
      writeVaultCredentials,
      logger: silentLogger,
    });

    expect(result).toEqual({ wroteVaultCredentials: false, wrotePendingEnrollment: false });
    expect(written).toHaveLength(0);
    expect(await pendingStore.load()).toBeNull();
  });

  test("requires both token and cloud url to write a pending enrollment", async () => {
    const result = await applyHeadlessBootstrap({
      env: { FORTRESS_ENROLL_TOKEN: "enroll-123" },
      credentialStore,
      pendingEnrollmentStore: pendingStore,
      writeVaultCredentials,
      logger: silentLogger,
    });

    expect(result.wrotePendingEnrollment).toBe(false);
    expect(await pendingStore.load()).toBeNull();
  });
});
