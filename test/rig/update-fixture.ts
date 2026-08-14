// The fixture update origin.
//
// The self-update path is the one place the fortress executes bytes it fetched
// over the network, so its tests cannot run against the real release origin: a
// test that passes because GitHub happened to serve a valid artifact today has
// asserted nothing about the verification code. This serves a PINNED artifact
// instead — fixed bytes, a real gzip, a real sha256, and a real detached Ed25519
// signature over the DECOMPRESSED bytes (the CI signs pre-gzip, so the fixture
// must too, or the enforced path would be exercised against a shape that never
// ships).
//
// The signing keypair is generated per rig and exported as a TrustedSigningKey.
// Consumers hand it to the verifier through the `trustedKeys` seam; the baked
// production anchors are never involved, and no private key exists in the repo.
//
// It listens on loopback so `assertHttpsDownloadUrl` tolerates plain http —
// which is also the only reason a local download base is legal at all.

import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PRODUCTION_KEYID_PREFIX,
  type TrustedSigningKey,
} from "../../src/host/trust/signing-keys";

/** The pinned payload. Not a real binary — the update path never executes what
 *  it downloads during a test, and fixed bytes keep the checksum stable. */
export const FIXTURE_BINARY = Buffer.from(
  "#!/bin/sh\n# hx-fortress update fixture\nexit 0\n",
  "utf8",
);

/** Higher than any version this build carries, so the update is never skipped by
 *  the cheap version pre-check. */
export const FIXTURE_VERSION = "9999.0.0";

export interface UpdateFixture {
  /** Pass as `downloadBaseUrl`. */
  downloadBaseUrl: string;
  /** The anchor the sidecar was signed under — hand it to `trustedKeys`. */
  trustedKey: TrustedSigningKey;
  /** sha256 of the DECOMPRESSED artifact, hex. */
  sha256: string;
  version: string;
  /** A scratch directory for `binPath`; removed by stop(). */
  binDir: string;
  /** The conventional destination: <binDir>/hx-fortress. */
  binPath: string;
  /** How many times each path was fetched — lets a caller prove a cached or
   *  short-circuited path did NOT hit the network. */
  hits: Map<string, number>;
  stop: () => Promise<void>;
}

export interface UpdateFixtureOptions {
  /** Omit the .sig sidecar, to exercise the missing-signature arm. */
  withoutSignature?: boolean;
  /** Corrupt the sidecar, to exercise the hard-failure arm. */
  tamperSignature?: boolean;
  /** Serve a sha256 that does not match, to exercise the checksum arm. */
  tamperChecksum?: boolean;
  version?: string;
  binary?: Buffer;
  /** Mint the anchor as a PRODUCTION one, so the console's enforcing path has a
   *  release-shaped key to verify against without a private key in the repo. */
  production?: boolean;
}

function detectAsset(): string {
  const platformName = process.platform === "darwin" ? "darwin" : "linux";
  const archName = process.arch === "arm64" ? "arm64" : "x64";
  return `hx-fortress-${platformName}-${archName}`;
}

export async function startUpdateFixture(
  options: UpdateFixtureOptions = {},
): Promise<UpdateFixture> {
  const binary = options.binary ?? FIXTURE_BINARY;
  const version = options.version ?? FIXTURE_VERSION;
  const asset = detectAsset();
  const gz = gzipSync(binary);
  const digest = createHash("sha256").update(binary).digest("hex");

  // Ed25519 over the decompressed bytes, exactly as the release workflow signs.
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const rawPublic = publicKey.export({ format: "jwk" }).x as string;
  const keyid = options.production
    ? `${PRODUCTION_KEYID_PREFIX}rig-${digest.slice(0, 8)}`
    : `rig-${digest.slice(0, 8)}`;
  const trustedKey: TrustedSigningKey = {
    keyid,
    publicKey: rawPublic,
    production: options.production === true,
  };
  const signature = signBytes(null, binary, privateKey).toString("base64url");
  const sidecar = JSON.stringify({
    v: 1,
    alg: "Ed25519",
    keyid,
    sig: options.tamperSignature ? `${signature.slice(0, -4)}AAAA` : signature,
  });

  const binDir = await mkdtemp(path.join(os.tmpdir(), "hx-update-fixture-"));
  const hits = new Map<string, number>();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
      if (pathname === "/hx-fortress-version") return new Response(version);
      if (pathname === `/${asset}.gz`) return new Response(gz);
      if (pathname === `/${asset}.sha256`) {
        return new Response(`${options.tamperChecksum ? "0".repeat(64) : digest}  ${asset}\n`);
      }
      if (pathname === `/${asset}.sig`) {
        return options.withoutSignature
          ? new Response("not found", { status: 404 })
          : new Response(sidecar);
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    downloadBaseUrl: `http://127.0.0.1:${server.port}`,
    trustedKey,
    sha256: digest,
    version,
    binDir,
    binPath: path.join(binDir, "hx-fortress"),
    hits,
    // Idempotent: a test that stops the rig in a finally block AND in an
    // afterEach must not fail the second time.
    stop: async () => {
      await server.stop(true).catch(() => {});
      await rm(binDir, { recursive: true, force: true });
    },
  };
}
