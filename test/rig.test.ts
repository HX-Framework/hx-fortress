import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runFortressUpdate } from "../src/update";
import { verifyDetachedSignature } from "../src/host/trust/verify";
import {
  emulatorStatus,
  fakeGcsEndpoint,
  fakeGcsSigner,
  FAKE_GCS_IMAGE,
  FAKE_GCS_PORT,
  imageRef,
  MINIO_IMAGE,
  MINIO_PORT,
  minioEnv,
  emulatorsDown,
} from "./rig/emulators";
import {
  fingerprintTree,
  fortressRigUp,
  hostVaultHome,
  withFortressRig,
} from "./rig/fortress-rig";
import { FIXTURE_BINARY, startUpdateFixture } from "./rig/update-fixture";

describe("the fixture update origin", () => {
  test("serves the pinned artifact with a checksum that verifies", async () => {
    const fixture = await startUpdateFixture();
    try {
      const gz = await fetch(`${fixture.downloadBaseUrl}/hx-fortress-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}.gz`);
      expect(gz.ok).toBe(true);
      const decompressed = Bun.gunzipSync(new Uint8Array(await gz.arrayBuffer()));
      expect(Buffer.from(decompressed).equals(FIXTURE_BINARY)).toBe(true);
      expect(createHash("sha256").update(decompressed).digest("hex")).toBe(fixture.sha256);
    } finally {
      await fixture.stop();
    }
  });

  test("its sidecar verifies the DECOMPRESSED bytes, the way the release signs them", async () => {
    const fixture = await startUpdateFixture();
    try {
      const asset = `hx-fortress-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
      const sidecar = await (await fetch(`${fixture.downloadBaseUrl}/${asset}.sig`)).text();
      await verifyDetachedSignature(FIXTURE_BINARY, sidecar, [fixture.trustedKey]);
      // ...and the baked production anchors do not know this key, which is the
      // point: no private key for a shipped anchor exists in this repository.
      await expect(verifyDetachedSignature(FIXTURE_BINARY, sidecar)).rejects.toThrow(
        /untrusted signing key id/,
      );
    } finally {
      await fixture.stop();
    }
  });

  test("drives the ENFORCED update path end to end onto a temp binPath", async () => {
    const fixture = await startUpdateFixture();
    try {
      const result = await runFortressUpdate({
        downloadBaseUrl: fixture.downloadBaseUrl,
        binPath: fixture.binPath,
        enforceSignature: true,
        trustedKeys: [fixture.trustedKey],
      });
      expect(result.alreadyLatest).toBe(false);
      expect(result.sha256).toBe(fixture.sha256);
      expect(result.installedPath).toBe(fixture.binPath);
      expect(Buffer.from(await readFile(fixture.binPath)).equals(FIXTURE_BINARY)).toBe(true);
    } finally {
      await fixture.stop();
    }
  });

  test("the enforced path refuses a missing sidecar, a tampered one, and a bad checksum", async () => {
    for (const [options, pattern] of [
      [{ withoutSignature: true }, /missing signature/],
      [{ tamperSignature: true }, /signature verification failed/],
      [{ tamperChecksum: true }, /checksum mismatch/],
    ] as const) {
      const fixture = await startUpdateFixture(options);
      try {
        await expect(
          runFortressUpdate({
            downloadBaseUrl: fixture.downloadBaseUrl,
            binPath: fixture.binPath,
            enforceSignature: true,
            trustedKeys: [fixture.trustedKey],
          }),
        ).rejects.toThrow(pattern);
      } finally {
        await fixture.stop();
      }
    }
  });

  test("stop is idempotent", async () => {
    const fixture = await startUpdateFixture();
    await fixture.stop();
    await fixture.stop();
  });
});

describe("rig isolation", () => {
  test("HOME and FORTRESS_ROOT point at the same temp directory", async () => {
    await withFortressRig(async (rig) => {
      expect(process.env.HOME).toBe(rig.root);
      expect(process.env.FORTRESS_ROOT).toBe(rig.root);
      expect(hostVaultHome().startsWith(rig.root)).toBe(true);
    });
  });

  test("the real HOME is restored even when the body throws", async () => {
    const before = process.env.HOME;
    await expect(
      withFortressRig(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(process.env.HOME).toBe(before);
  });

  test("the HOST vault home is byte-unchanged across up and down", async () => {
    const host = hostVaultHome();
    const before = await fingerprintTree(host);
    await withFortressRig(async (rig) => {
      // Everything a rig run would write lands inside the rig.
      await mkdir(rig.vaultHome, { recursive: true });
      await writeFile(path.join(rig.vaultHome, "credentials.json"), '{"store":"s3"}');
      expect(hostVaultHome()).toBe(rig.vaultHome);
    });
    expect(await fingerprintTree(host)).toEqual(before);
  });

  test("teardown removes the root and is idempotent", async () => {
    const rig = await fortressRigUp();
    await writeFile(path.join(rig.root, "scratch"), "x");
    await rig.down();
    await rig.down();
    expect(await Bun.file(path.join(rig.root, "scratch")).exists()).toBe(false);
  });
});

describe("the storage emulator rig", () => {
  test("pins both images by digest rather than by tag", () => {
    for (const image of [MINIO_IMAGE, FAKE_GCS_IMAGE]) {
      expect(image.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(image.tag).not.toBe("latest");
      // The tag is for a human reading a log; the digest is what is pulled.
      expect(imageRef(image)).toBe(`${image.image}@${image.digest}`);
      expect(imageRef(image)).not.toContain(image.tag);
    }
  });

  test("names the opt-in each backend needs, rather than reaching an emulator by accident", () => {
    const env = minioEnv();
    expect(env.FORTRESS_S3_ALLOW_PRIVATE_ENDPOINT).toBe("1");
    expect(env.FORTRESS_S3_ENDPOINT).toBe(`http://127.0.0.1:${MINIO_PORT}`);
    // GCS is reached through a config field, never an ambient variable: a
    // deployed fortress that inherited STORAGE_EMULATOR_HOST must not follow it.
    expect(fakeGcsEndpoint()).toBe(`http://127.0.0.1:${FAKE_GCS_PORT}`);
    const signer = fakeGcsSigner();
    expect(signer.private_key).toContain("BEGIN PRIVATE KEY");
    expect(signer.client_email).toContain("@");
  });

  test("reports WHY it is unavailable rather than skipping silently", () => {
    const status = emulatorStatus();
    if (!status.available) {
      expect(status.reason.length).toBeGreaterThan(0);
    } else {
      expect(status.available).toBe(true);
    }
  });

  test("teardown never throws, whether or not docker is present", async () => {
    await emulatorsDown();
    await emulatorsDown();
  });
});
