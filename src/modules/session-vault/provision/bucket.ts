// Bucket existence checks + secure create, via the operator's own gcloud/aws.
// Created buckets block public access by default — transcripts must never be
// world-readable.

import { capture, type RunResult } from "./exec.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type Log = (m: string) => void;

// ── GCS ──────────────────────────────────────────────────────────────────────

export interface BucketProbe {
  exists: boolean;
  /** Set when the describe failed for a reason *other* than the bucket being
   *  absent — auth, missing permissions, or a wrong quota/billing project. The
   *  wizard surfaces this instead of misreporting the bucket as "not found". */
  error?: string;
}

/** Args for the existence probe. `--project` scopes the request to the project
 *  the operator chose; without it gcloud uses the active config project as the
 *  quota project, so a bucket living elsewhere is misreported as missing
 *  (MC-2412). */
export function gcsDescribeArgs(bucket: string, project: string): string[] {
  return [
    "storage",
    "buckets",
    "describe",
    `gs://${bucket}`,
    `--project=${project}`,
    "--format=value(name)",
  ];
}

/** A genuinely-missing bucket surfaces as a 404 / "not found". Any other failure
 *  (401/403/quota-project) is a distinct problem we must not relabel as
 *  not-found — that conflation is what made an accessible bucket look missing. */
export function classifyBucketProbe(r: RunResult): BucketProbe {
  if (r.ok) return { exists: true };
  if (/\b404\b|not found|does not exist/i.test(r.stderr)) return { exists: false };
  return { exists: false, error: r.stderr || "gcloud storage buckets describe failed" };
}

export async function gcsBucketExists(bucket: string, project: string): Promise<BucketProbe> {
  return classifyBucketProbe(await capture("gcloud", gcsDescribeArgs(bucket, project)));
}

export interface GcsBucketOpts {
  bucket: string;
  project: string;
  location: string;
  kmsKey?: string;
}

export function gcsCreateCommand(o: GcsBucketOpts): string {
  return `gcloud storage buckets create gs://${o.bucket} --project=${o.project} --location=${o.location} --uniform-bucket-level-access --public-access-prevention=enforced`;
}

export async function createGcsBucket(o: GcsBucketOpts, log: Log): Promise<boolean> {
  const args = [
    "storage",
    "buckets",
    "create",
    `gs://${o.bucket}`,
    `--project=${o.project}`,
    `--location=${o.location}`,
    "--uniform-bucket-level-access",
    "--public-access-prevention=enforced",
  ];
  if (o.kmsKey) args.push(`--default-encryption-key=${o.kmsKey}`);
  const r = await capture("gcloud", args);
  if (!r.ok) {
    log(`Bucket creation failed: ${r.stderr || "unknown error"}`);
    return false;
  }
  // Defense in depth: versioning + soft-delete retention.
  await capture("gcloud", ["storage", "buckets", "update", `gs://${o.bucket}`, "--versioning"]);
  await capture("gcloud", [
    "storage",
    "buckets",
    "update",
    `gs://${o.bucket}`,
    "--soft-delete-duration=7d",
  ]);
  // The write-path probe overwrites one `.session-vault/` object every minute;
  // on a VERSIONED bucket each cycle strands a noncurrent generation forever
  // without a lifecycle rule. Scoped strictly to the probe prefix — customer
  // data is subject to no expiry. Best-effort like the hardening steps above.
  const lifecycle = JSON.stringify({
    rule: [
      {
        action: { type: "Delete" },
        condition: { matchesPrefix: [".session-vault/"], daysSinceNoncurrentTime: 1 },
      },
      // Current probe objects stranded by a failed delete (wedge windows) —
      // only probe artifacts ever live under this prefix.
      {
        action: { type: "Delete" },
        condition: { matchesPrefix: [".session-vault/"], age: 7 },
      },
      // Incomplete multipart uploads (e.g. a compose abandoned mid-wedge)
      // bill storage invisibly; aborting them never touches completed data.
      { action: { type: "AbortIncompleteMultipartUpload" }, condition: { age: 1 } },
    ],
  });
  // mkdtemp: a PRIVATE (0700, unpredictable) directory — this file's content
  // becomes bucket lifecycle DELETION rules, so a predictable path in the
  // shared temp dir would be a symlink/content-swap target (CodeQL
  // js/insecure-temporary-file).
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-"));
  const lifecycleFile = path.join(tmpDir, "lifecycle.json");
  try {
    await writeFile(lifecycleFile, lifecycle, { encoding: "utf8", mode: 0o600 });
    const lr = await capture("gcloud", [
      "storage",
      "buckets",
      "update",
      `gs://${o.bucket}`,
      `--lifecycle-file=${lifecycleFile}`,
    ]);
    if (!lr.ok) log(`Lifecycle rule not applied (probe versions will accrue): ${lr.stderr || "unknown error"}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
  return true;
}

// ── S3 ───────────────────────────────────────────────────────────────────────

export async function s3BucketExists(bucket: string, region: string): Promise<boolean> {
  const r = await capture("aws", ["s3api", "head-bucket", "--bucket", bucket, "--region", region]);
  return r.ok;
}

export interface S3BucketOpts {
  bucket: string;
  region: string;
  /** Customer-managed KMS key ARN/ID → SSE-KMS. Absent → SSE-S3 (AES256). */
  kmsKey?: string;
}

export function s3CreateCommand(o: S3BucketOpts): string {
  const loc =
    o.region === "us-east-1" ? "" : ` --create-bucket-configuration LocationConstraint=${o.region}`;
  return `aws s3api create-bucket --bucket ${o.bucket} --region ${o.region}${loc}`;
}

export async function createS3Bucket(o: S3BucketOpts, log: Log): Promise<boolean> {
  const args = ["s3api", "create-bucket", "--bucket", o.bucket, "--region", o.region];
  // us-east-1 rejects an explicit LocationConstraint.
  if (o.region !== "us-east-1") {
    args.push("--create-bucket-configuration", `LocationConstraint=${o.region}`);
  }
  const r = await capture("aws", args);
  if (!r.ok) {
    log(`Bucket creation failed: ${r.stderr || "unknown error"}`);
    return false;
  }
  await capture("aws", [
    "s3api",
    "put-public-access-block",
    "--bucket",
    o.bucket,
    "--public-access-block-configuration",
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true",
  ]);
  await capture("aws", [
    "s3api",
    "put-bucket-versioning",
    "--bucket",
    o.bucket,
    "--versioning-configuration",
    "Status=Enabled",
  ]);
  // Probe-prefix lifecycle — see the GCS arm: expire noncurrent probe versions
  // and their delete markers, reap stranded current probe objects, and abort
  // incomplete multipart uploads; customer data untouched.
  const s3lr = await capture("aws", [
    "s3api",
    "put-bucket-lifecycle-configuration",
    "--bucket",
    o.bucket,
    "--lifecycle-configuration",
    JSON.stringify({
      Rules: [
        {
          ID: "hx-session-vault-probe",
          Status: "Enabled",
          Filter: { Prefix: ".session-vault/" },
          NoncurrentVersionExpiration: { NoncurrentDays: 1 },
          Expiration: { ExpiredObjectDeleteMarker: true },
        },
        {
          ID: "hx-session-vault-probe-strays",
          Status: "Enabled",
          Filter: { Prefix: ".session-vault/" },
          Expiration: { Days: 7 },
        },
        {
          ID: "hx-abort-incomplete-mpu",
          Status: "Enabled",
          Filter: {},
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
        },
      ],
    }),
  ]);
  if (!s3lr.ok) log(`Lifecycle rules not applied (probe versions will accrue): ${s3lr.stderr || "unknown error"}`);
  const encryption = o.kmsKey
    ? `{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms","KMSMasterKeyID":"${o.kmsKey}"}}]}`
    : '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}';
  await capture("aws", [
    "s3api",
    "put-bucket-encryption",
    "--bucket",
    o.bucket,
    "--server-side-encryption-configuration",
    encryption,
  ]);
  return true;
}
