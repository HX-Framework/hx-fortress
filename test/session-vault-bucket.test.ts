import { describe, expect, test } from "bun:test";

import { classifyBucketProbe, gcsDescribeArgs } from "../src/modules/session-vault/provision/bucket";

describe("gcsDescribeArgs", () => {
  test("scopes the existence check to the chosen project", () => {
    // Regression (MC-2412): without --project the describe runs against the
    // active gcloud config project, so a bucket in a different project is
    // misreported as missing.
    expect(gcsDescribeArgs("hx-fortress-test", "mintcoder-dev")).toContain("--project=mintcoder-dev");
  });

  test("describes the bucket by its gs:// URL", () => {
    expect(gcsDescribeArgs("hx-fortress-test", "mintcoder-dev")).toContain("gs://hx-fortress-test");
  });
});

describe("classifyBucketProbe", () => {
  test("a successful describe means the bucket exists", () => {
    expect(classifyBucketProbe({ ok: true, stdout: "hx-fortress-test", stderr: "" })).toEqual({
      exists: true,
    });
  });

  test("a 404 means the bucket is genuinely absent", () => {
    expect(
      classifyBucketProbe({ ok: false, stdout: "", stderr: "HTTPError 404: Not Found" }),
    ).toEqual({ exists: false });
  });

  test("an auth/permission failure is surfaced, not relabeled as not-found", () => {
    const probe = classifyBucketProbe({
      ok: false,
      stdout: "",
      stderr: "ERROR: (gcloud.storage.buckets.describe) HTTPError 401: Invalid Credentials",
    });
    expect(probe.exists).toBe(false);
    expect(probe.error).toContain("401");
  });
});
