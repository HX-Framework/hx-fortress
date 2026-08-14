import { describe, expect, test } from "bun:test";

import type { TrustedSigningKey } from "../src/host/trust/signing-keys";
import {
  parseSignatureSidecar,
  verifyDetachedSignature,
  verifyFetchedArtifact,
} from "../src/host/trust/verify";

// An ephemeral in-test signer: generates a real Ed25519 keypair, exposes its
// public half as a trusted anchor (injected via the `trustedKeys` seam), and
// signs bytes into the `.sig` sidecar JSON the verifier consumes.
async function makeSigner(keyid: string): Promise<{
  trusted: TrustedSigningKey[];
  sidecarFor: (bytes: Uint8Array) => Promise<string>;
}> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
  const trusted: TrustedSigningKey[] = [{ keyid, publicKey: pub.x ?? "", production: false }];
  const sidecarFor = async (bytes: Uint8Array): Promise<string> => {
    // Fresh ArrayBuffer-backed copy to satisfy WebCrypto's BufferSource typing.
    const data = new Uint8Array(bytes.byteLength);
    data.set(bytes);
    const sig = await crypto.subtle.sign("Ed25519", kp.privateKey, data);
    const b64 = Buffer.from(new Uint8Array(sig)).toString("base64url");
    return JSON.stringify({ v: 1, alg: "Ed25519", keyid, sig: b64 });
  };
  return { trusted, sidecarFor };
}

function fetchReturning(sigResponse: Response | (() => Response)): typeof fetch {
  return (async (url: string | URL) => {
    if (String(url).endsWith(".sig")) {
      return typeof sigResponse === "function" ? sigResponse() : sigResponse;
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
}

describe("parseSignatureSidecar", () => {
  test("accepts a well-formed sidecar", () => {
    const s = parseSignatureSidecar('{"v":1,"alg":"Ed25519","keyid":"k","sig":"AAAA"}');
    expect(s).toEqual({ v: 1, alg: "Ed25519", keyid: "k", sig: "AAAA" });
  });

  test("throws on non-JSON, wrong version, wrong alg, and missing fields", () => {
    expect(() => parseSignatureSidecar("not json")).toThrow(/malformed/);
    expect(() => parseSignatureSidecar("[]")).toThrow(/not an object/);
    expect(() =>
      parseSignatureSidecar('{"v":2,"alg":"Ed25519","keyid":"k","sig":"s"}'),
    ).toThrow(/version/);
    expect(() =>
      parseSignatureSidecar('{"v":1,"alg":"RS256","keyid":"k","sig":"s"}'),
    ).toThrow(/algorithm/);
    expect(() => parseSignatureSidecar('{"v":1,"alg":"Ed25519","sig":"s"}')).toThrow(/keyid/);
    expect(() => parseSignatureSidecar('{"v":1,"alg":"Ed25519","keyid":"k"}')).toThrow(/sig/);
  });
});

describe("verifyDetachedSignature", () => {
  test("passes for a genuine signature from a trusted key", async () => {
    const { trusted, sidecarFor } = await makeSigner("test-key-1");
    const bytes = new TextEncoder().encode("artifact bytes");
    await expect(
      verifyDetachedSignature(bytes, await sidecarFor(bytes), trusted),
    ).resolves.toBeUndefined();
  });

  test("throws 'untrusted' when the sidecar names an unknown key id", async () => {
    const { sidecarFor } = await makeSigner("test-key-1");
    const bytes = new TextEncoder().encode("artifact bytes");
    // Verify against a DIFFERENT trusted set (empty of this key id).
    await expect(
      verifyDetachedSignature(bytes, await sidecarFor(bytes), [
        { keyid: "some-other-key", publicKey: "AAAA", production: false },
      ]),
    ).rejects.toThrow(/untrusted signing key id/);
  });

  test("fails when a byte is flipped after signing", async () => {
    const { trusted, sidecarFor } = await makeSigner("test-key-1");
    const bytes = new TextEncoder().encode("artifact bytes");
    const sidecar = await sidecarFor(bytes);
    const tampered = new Uint8Array(bytes);
    tampered[0] ^= 0x01;
    await expect(verifyDetachedSignature(tampered, sidecar, trusted)).rejects.toThrow(
      /signature verification failed/,
    );
  });

  test("propagates malformed-sidecar errors", async () => {
    const bytes = new TextEncoder().encode("x");
    await expect(verifyDetachedSignature(bytes, "garbage")).rejects.toThrow(/malformed/);
  });
});

describe("verifyFetchedArtifact", () => {
  test("passes when a valid sidecar is present", async () => {
    const { trusted, sidecarFor } = await makeSigner("test-key-1");
    const bytes = new TextEncoder().encode("release binary");
    const sidecar = await sidecarFor(bytes);
    await expect(
      verifyFetchedArtifact({
        fetchImpl: fetchReturning(new Response(sidecar)),
        url: "https://origin/hx-fortress-linux-x64",
        bytes,
        enforce: false,
        trustedKeys: trusted,
      }),
    ).resolves.toBeUndefined();
  });

  test("throws a present-but-invalid signature regardless of enforce", async () => {
    const { trusted } = await makeSigner("test-key-1");
    const bytes = new TextEncoder().encode("release binary");
    const wrongSidecar = JSON.stringify({
      v: 1,
      alg: "Ed25519",
      keyid: "test-key-1",
      sig: "AAAA", // not a real signature over `bytes`
    });
    await expect(
      verifyFetchedArtifact({
        fetchImpl: fetchReturning(new Response(wrongSidecar)),
        url: "https://origin/hx-fortress-linux-x64",
        bytes,
        enforce: false,
        trustedKeys: trusted,
      }),
    ).rejects.toThrow(/signature verification failed/);
  });

  test("404 + enforce → throws 'missing signature'", async () => {
    const bytes = new TextEncoder().encode("release binary");
    await expect(
      verifyFetchedArtifact({
        fetchImpl: fetchReturning(new Response("nope", { status: 404 })),
        url: "https://origin/hx-fortress-linux-x64",
        bytes,
        enforce: true,
      }),
    ).rejects.toThrow(/missing signature/);
  });

  test("404 + !enforce → warns and returns (verify-if-present)", async () => {
    const bytes = new TextEncoder().encode("release binary");
    const warnings: string[] = [];
    await expect(
      verifyFetchedArtifact({
        fetchImpl: fetchReturning(new Response("nope", { status: 404 })),
        url: "https://origin/hx-fortress-linux-x64",
        bytes,
        enforce: false,
        log: (msg) => warnings.push(msg),
      }),
    ).resolves.toBeUndefined();
    expect(warnings.some((w) => w.startsWith("SECURITY:"))).toBe(true);
  });

  test("transport error + enforce → throws", async () => {
    const bytes = new TextEncoder().encode("release binary");
    const throwingFetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    await expect(
      verifyFetchedArtifact({
        fetchImpl: throwingFetch,
        url: "https://origin/hx-fortress-linux-x64",
        bytes,
        enforce: true,
      }),
    ).rejects.toThrow(/missing signature/);
  });
});
