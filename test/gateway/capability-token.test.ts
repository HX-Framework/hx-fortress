import { describe, it, expect } from "bun:test";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { verifyCapabilityToken } from "../../src/gateway/capability-token";

async function makeKeyAndToken(claims: Record<string, unknown>, exp = "5m") {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  const jwk = await exportJWK(publicKey); // OKP / Ed25519
  const rawB64url = jwk.x as string; // base64url 32-byte public key
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(privateKey);
  return { rawB64url, token };
}

describe("verifyCapabilityToken", () => {
  it("returns claims for a valid token", async () => {
    const { rawB64url, token } = await makeKeyAndToken({
      org: "org_1",
      project: "proj_1",
      repo: "acme/app",
      deviceId: "dev_1",
      sub: "user_1",
    });
    const claims = await verifyCapabilityToken(token, rawB64url, null);
    expect(claims.org).toBe("org_1");
    expect(claims.repo).toBe("acme/app");
  });

  it("rejects a token signed by a different key", async () => {
    const { token } = await makeKeyAndToken({ org: "org_1", repo: "acme/app" });
    const { rawB64url: otherKey } = await makeKeyAndToken({ org: "x", repo: "x/y" });
    await expect(verifyCapabilityToken(token, otherKey, null)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const { rawB64url, token } = await makeKeyAndToken({ org: "org_1", repo: "acme/app" }, "-1s");
    await expect(verifyCapabilityToken(token, rawB64url, null)).rejects.toThrow();
  });

  it("rejects a token with no exp claim (requiredClaims)", async () => {
    const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
    const rawB64url = (await exportJWK(publicKey)).x as string;
    // Minted WITHOUT setExpirationTime — an eternal token must be refused.
    const token = await new SignJWT({ org: "org_1", repo: "*" })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuedAt()
      .sign(privateKey);
    await expect(verifyCapabilityToken(token, rawB64url, null)).rejects.toThrow();
  });

  it("rejects a token whose aud names a different org (anti cross-org replay)", async () => {
    const { rawB64url, token } = await makeKeyAndToken({ org: "org_1", repo: "*", aud: "org_1" });
    await expect(verifyCapabilityToken(token, rawB64url, "org_2")).rejects.toThrow();
  });

  it("accepts a token whose aud matches the fortress org id", async () => {
    const { rawB64url, token } = await makeKeyAndToken({ org: "org_1", repo: "*", aud: "org_1" });
    const claims = await verifyCapabilityToken(token, rawB64url, "org_1");
    expect(claims.aud).toBe("org_1");
  });

  it("accepts a token with no aud even when the fortress org id is known (rollout tolerance)", async () => {
    const { rawB64url, token } = await makeKeyAndToken({ org: "org_1", repo: "*" });
    const claims = await verifyCapabilityToken(token, rawB64url, "org_2");
    expect(claims.org).toBe("org_1");
    expect(claims.aud).toBeUndefined();
  });

  it("requires aud===org===expectedOrgId for a v2 token (rejects a mismatched org)", async () => {
    // A v2 token (carries a purpose) is bound to this fortress's own org even
    // during the compat window — never allow a bad one.
    const { rawB64url, token } = await makeKeyAndToken({
      org: "org_OTHER",
      repo: "*",
      aud: "org_1",
      purpose: "read",
    });
    await expect(verifyCapabilityToken(token, rawB64url, "org_1")).rejects.toThrow(/audience mismatch/);
  });

  it("rejects a v1 token once FORTRESS_GRANT_ENFORCE is on", async () => {
    const prior = process.env.FORTRESS_GRANT_ENFORCE;
    process.env.FORTRESS_GRANT_ENFORCE = "1";
    try {
      const { rawB64url, token } = await makeKeyAndToken({ org: "org_1", repo: "*" });
      // No aud/purpose + enforcing ⇒ the compat exemption no longer applies.
      await expect(verifyCapabilityToken(token, rawB64url, "org_1")).rejects.toThrow(
        /audience mismatch/,
      );
      // A v2 token bound to the org still passes under enforcement.
      const v2 = await makeKeyAndToken({ org: "org_1", repo: "*", aud: "org_1", purpose: "read" });
      const claims = await verifyCapabilityToken(v2.token, v2.rawB64url, "org_1");
      expect(claims.purpose).toBe("read");
    } finally {
      if (prior === undefined) delete process.env.FORTRESS_GRANT_ENFORCE;
      else process.env.FORTRESS_GRANT_ENFORCE = prior;
    }
  });
});
