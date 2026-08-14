import { describe, it, expect } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import {
  isGrantEnforcing,
  isTunnelGrantEnforcing,
  isV2Claims,
  verifyGrant,
} from "../../src/gateway/capability-token";

async function makeGrant(claims: Record<string, unknown>, exp = "5m") {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  const rawB64url = (await exportJWK(publicKey)).x as string;
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(privateKey);
  return { rawB64url, token };
}

const READ = { v: 2, purpose: "read", org: "org_1", aud: "org_1", sub: "user_1", scopeHash: "HASH" };
const INGEST = { v: 2, purpose: "ingest", org: "org_1", aud: "org_1", sub: "user_1", repo: "acme/app" };

describe("verifyGrant", () => {
  it("returns claims for a valid read grant", async () => {
    const { rawB64url, token } = await makeGrant(READ);
    const grant = await verifyGrant(token, rawB64url, "org_1", { purpose: "read" });
    expect(grant.purpose).toBe("read");
    expect(grant.sub).toBe("user_1");
    expect(grant.scopeHash).toBe("HASH");
  });

  it("returns claims for a valid ingest grant", async () => {
    const { rawB64url, token } = await makeGrant(INGEST);
    const grant = await verifyGrant(token, rawB64url, "org_1", { purpose: "ingest" });
    expect(grant.purpose).toBe("ingest");
    expect(grant.sub).toBe("user_1");
    expect(grant.repo).toBe("acme/app");
  });

  it("rejects a grant whose org is not the fortress org", async () => {
    const { rawB64url, token } = await makeGrant({ ...READ, org: "org_X" });
    await expect(verifyGrant(token, rawB64url, "org_1", { purpose: "read" })).rejects.toThrow(
      /org mismatch/,
    );
  });

  it("rejects a grant whose aud is not the fortress org (cross-org replay)", async () => {
    const { rawB64url, token } = await makeGrant({ ...READ, aud: "org_X" });
    await expect(verifyGrant(token, rawB64url, "org_1", { purpose: "read" })).rejects.toThrow(
      /audience mismatch/,
    );
  });

  it("rejects a grant whose purpose does not match the route", async () => {
    const { rawB64url, token } = await makeGrant(INGEST);
    await expect(verifyGrant(token, rawB64url, "org_1", { purpose: "read" })).rejects.toThrow(
      /purpose mismatch/,
    );
  });

  it("rejects a grant with an empty/missing sub", async () => {
    const { rawB64url, token } = await makeGrant({ v: 2, purpose: "read", org: "org_1", aud: "org_1", scopeHash: "HASH" });
    await expect(verifyGrant(token, rawB64url, "org_1", { purpose: "read" })).rejects.toThrow(
      /missing sub/,
    );
  });

  it("rejects a read grant with no scopeHash (scope-bound MCP read, requireScope default)", async () => {
    const { rawB64url, token } = await makeGrant({ v: 2, purpose: "read", org: "org_1", aud: "org_1", sub: "user_1" });
    await expect(verifyGrant(token, rawB64url, "org_1", { purpose: "read" })).rejects.toThrow(
      /missing scopeHash/,
    );
  });

  it("ACCEPTS a read grant with no scopeHash when requireScope:false (own-object read)", async () => {
    // The vault-RPC own-data reads + HTTP /sessions reads are sub-bound with no
    // scopeHash (the boundary is key.userId === sub). requireScope:false must let
    // such a grant verify — otherwise every own-object read throws once grants ship.
    const { rawB64url, token } = await makeGrant({ v: 2, purpose: "read", org: "org_1", aud: "org_1", sub: "user_1" });
    const grant = await verifyGrant(token, rawB64url, "org_1", { purpose: "read", requireScope: false });
    expect(grant.sub).toBe("user_1");
    expect(grant.scopeHash).toBeUndefined();
  });

  it("rejects a grant that is not v2", async () => {
    const { rawB64url, token } = await makeGrant({ ...READ, v: 1 });
    await expect(verifyGrant(token, rawB64url, "org_1", { purpose: "read" })).rejects.toThrow(
      /version unsupported/,
    );
  });

  it("rejects a grant with no exp (requiredClaims)", async () => {
    const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
    const rawB64url = (await exportJWK(publicKey)).x as string;
    const token = await new SignJWT(READ).setProtectedHeader({ alg: "EdDSA" }).setIssuedAt().sign(privateKey);
    await expect(verifyGrant(token, rawB64url, "org_1", { purpose: "read" })).rejects.toThrow();
  });
});

describe("grant enforce helpers", () => {
  function withEnv(key: string, value: string | undefined, fn: () => void) {
    const prior = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    try {
      fn();
    } finally {
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  }

  it("defaults OFF and reads the 1/true/yes forms", () => {
    withEnv("FORTRESS_GRANT_ENFORCE", undefined, () => expect(isGrantEnforcing()).toBe(false));
    withEnv("FORTRESS_GRANT_ENFORCE", "1", () => expect(isGrantEnforcing()).toBe(true));
    withEnv("FORTRESS_GRANT_ENFORCE", "true", () => expect(isGrantEnforcing()).toBe(true));
    withEnv("FORTRESS_GRANT_ENFORCE", "0", () => expect(isGrantEnforcing()).toBe(false));
    withEnv("FORTRESS_TUNNEL_GRANT_ENFORCE", undefined, () =>
      expect(isTunnelGrantEnforcing()).toBe(false),
    );
    withEnv("FORTRESS_TUNNEL_GRANT_ENFORCE", "yes", () => expect(isTunnelGrantEnforcing()).toBe(true));
  });
});

describe("isV2Claims", () => {
  it("is true when aud, purpose, or v===2 is present; false for a bare v1 token", () => {
    expect(isV2Claims({ org: "o", repo: "r" })).toBe(false);
    expect(isV2Claims({ org: "o", repo: "r", aud: "o" })).toBe(true);
    expect(isV2Claims({ org: "o", repo: "r", purpose: "read" })).toBe(true);
    expect(isV2Claims({ org: "o", repo: "r", v: 2 })).toBe(true);
  });
});
