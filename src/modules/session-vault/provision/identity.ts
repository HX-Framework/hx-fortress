// Create a least-privilege identity scoped to the one bucket, via the operator's
// own gcloud/aws. The minted credential is returned for inlining into
// credentials.json; it never leaves the host.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { capture } from "./exec.js";
import type { GcsServiceAccountKey, S3Credentials } from "../credentials.js";

type Log = (m: string) => void;

export interface GcsIdentityOpts {
  project: string;
  bucket: string;
  name?: string;
}

/** Create a service account, grant it objectAdmin on the ONE bucket (not the
 *  project), mint a key, and return the key JSON. */
export async function createGcsServiceAccount(
  o: GcsIdentityOpts,
  log: Log,
): Promise<GcsServiceAccountKey | null> {
  const sa = o.name ?? "hx-session-vault";
  const email = `${sa}@${o.project}.iam.gserviceaccount.com`;

  const create = await capture("gcloud", [
    "iam",
    "service-accounts",
    "create",
    sa,
    `--project=${o.project}`,
    "--display-name=Session Vault",
  ]);
  if (!create.ok && !/already exists/i.test(create.stderr)) {
    log(`Service-account creation failed: ${create.stderr}`);
    return null;
  }

  const grant = await capture("gcloud", [
    "storage",
    "buckets",
    "add-iam-policy-binding",
    `gs://${o.bucket}`,
    `--member=serviceAccount:${email}`,
    "--role=roles/storage.objectAdmin",
  ]);
  if (!grant.ok) {
    log(`IAM grant failed: ${grant.stderr}`);
    return null;
  }

  // gcloud writes the key to a file (never stdout). It goes in a PRIVATE
  // (0700, unpredictable) mkdtemp directory, never a predictable shared-/tmp
  // name: the file briefly holds a LIVE service-account key, so a predictable
  // path is a symlink target for gcloud's write, a read race for any local
  // user, and a content-swap source for what gets inlined into
  // credentials.json (same js/insecure-temporary-file class as the
  // lifecycle-file fix; the 0700 directory shields the key regardless of the
  // mode gcloud gives the file).
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-key-"));
  const tmp = path.join(tmpDir, "sa-key.json");
  try {
    const key = await capture("gcloud", [
      "iam",
      "service-accounts",
      "keys",
      "create",
      tmp,
      `--iam-account=${email}`,
      `--project=${o.project}`,
    ]);
    if (!key.ok) {
      log(`Key creation failed: ${key.stderr}`);
      return null;
    }
    return JSON.parse(await readFile(tmp, "utf8")) as GcsServiceAccountKey;
  } catch (e) {
    log(`Could not read minted key: ${String(e)}`);
    return null;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface S3IdentityOpts {
  bucket: string;
  name?: string;
}

/** Create an IAM user with a bucket-scoped policy and an access key. */
export async function createS3IamUser(
  o: S3IdentityOpts,
  log: Log,
): Promise<S3Credentials | null> {
  const user = o.name ?? "hx-session-vault";
  // Ignore "already exists".
  await capture("aws", ["iam", "create-user", "--user-name", user]);
  const policy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket",
          "s3:AbortMultipartUpload",
        ],
        Resource: [`arn:aws:s3:::${o.bucket}`, `arn:aws:s3:::${o.bucket}/*`],
      },
    ],
  });
  const put = await capture("aws", [
    "iam",
    "put-user-policy",
    "--user-name",
    user,
    "--policy-name",
    "session-vault",
    "--policy-document",
    policy,
  ]);
  if (!put.ok) {
    log(`IAM policy attach failed: ${put.stderr}`);
    return null;
  }
  const r = await capture("aws", [
    "iam",
    "create-access-key",
    "--user-name",
    user,
    "--output",
    "json",
  ]);
  if (!r.ok) {
    log(`Access-key creation failed: ${r.stderr}`);
    return null;
  }
  try {
    const parsed = JSON.parse(r.stdout) as {
      AccessKey: { AccessKeyId: string; SecretAccessKey: string };
    };
    return {
      accessKeyId: parsed.AccessKey.AccessKeyId,
      secretAccessKey: parsed.AccessKey.SecretAccessKey,
    };
  } catch (e) {
    log(`Could not parse access key: ${String(e)}`);
    return null;
  }
}
