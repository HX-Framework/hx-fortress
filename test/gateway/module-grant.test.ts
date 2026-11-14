import { describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import {
  GrantRefused,
  MODULE_GRANT_MAX_LIFETIME_SECONDS,
  verifyCapabilityToken,
  verifyGrant,
} from "../../src/gateway/capability-token";
import { askScopeHash } from "../../src/host/ask-scope";
import { verifyConsoleGrant } from "../../src/ui/sso-grant";

const ORG = "org_1";
const NOW = new Date("2027-03-14T09:00:00.000Z");
const now = (): Date => NOW;
const IAT = Math.floor(NOW.getTime() / 1000);
const ARGS = { from: "2027-03-01T00:00:00.000Z", to: "2027-03-14T00:00:00.000Z" };
const SCOPE = askScopeHash({ module: "host", ask: "audit.count", args: ARGS });
const BIND = { purpose: "module" as const, sub: "host:audit.count", scopeHash: SCOPE, now };
const GOOD = { v: 2, purpose: "module", org: ORG, aud: ORG, sub: "host:audit.count", scopeHash: SCOPE };

async function keypair() {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  return { privateKey, raw: (await exportJWK(publicKey)).x as string };
}

async function mint(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  options: { iat?: number; ttl?: number; jti?: string | null; exp?: false } = {},
): Promise<string> {
  const iat = options.iat ?? IAT;
  let jwt = new SignJWT(claims).setProtectedHeader({ alg: "EdDSA" }).setIssuedAt(iat);
  if (options.exp !== false) jwt = jwt.setExpirationTime(iat + (options.ttl ?? 60));
  if (options.jti !== null) jwt = jwt.setJti(options.jti ?? "jti-1");
  return jwt.sign(privateKey);
}

async function rule(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GrantRefused) return error.rule;
    return `not a GrantRefused: ${(error as { code?: string }).code ?? String(error)}`;
  }
  return "accepted";
}

describe("a module grant", () => {
  test("verifies, and returns every claim the gate binds", async () => {
    const { privateKey, raw } = await keypair();
    const claims = await verifyGrant(await mint(privateKey, GOOD), raw, ORG, BIND);
    expect(claims).toEqual({
      v: 2,
      purpose: "module",
      org: ORG,
      aud: ORG,
      sub: "host:audit.count",
      scopeHash: SCOPE,
      iat: IAT,
      exp: IAT + 60,
      jti: "jti-1",
    });
  });

  test("a token signed by another key is refused before any claim is read", async () => {
    const { privateKey } = await keypair();
    const other = await keypair();
    const error = await verifyGrant(await mint(privateKey, GOOD), other.raw, ORG, BIND).catch(
      (e: unknown) => e,
    );
    expect(error).not.toBeInstanceOf(GrantRefused);
    expect((error as { code?: string }).code).toBe("ERR_JWS_SIGNATURE_VERIFICATION_FAILED");
  });

  test.each([
    ["version", { v: 1 }],
    ["purpose", { purpose: "read" }],
    ["purpose", { purpose: "console" }],
    ["organization", { org: "org_other" }],
    ["organization", { aud: "org_other" }],
    ["subject", { sub: "host:status" }],
    ["subject", { sub: "stores:audit.count" }],
    ["subject", { sub: "" }],
    ["scope", { scopeHash: askScopeHash({ module: "host", ask: "audit.count", args: { ...ARGS, to: "2028-01-01T00:00:00.000Z" } }) }],
    ["scope", { scopeHash: undefined }],
  ])("is refused by the %s rule for %j", async (expected, override) => {
    const { privateKey, raw } = await keypair();
    const token = await mint(privateKey, { ...GOOD, ...override });
    expect(await rule(verifyGrant(token, raw, ORG, BIND))).toBe(expected);
  });

  test("lives at most a minute", async () => {
    const { privateKey, raw } = await keypair();
    expect(MODULE_GRANT_MAX_LIFETIME_SECONDS).toBe(60);
    expect(await rule(verifyGrant(await mint(privateKey, GOOD, { ttl: 60 }), raw, ORG, BIND))).toBe("accepted");
    expect(await rule(verifyGrant(await mint(privateKey, GOOD, { ttl: 61 }), raw, ORG, BIND))).toBe("lifetime");
    // A ten-minute grant is refused in its first second, not after its first minute.
    expect(await rule(verifyGrant(await mint(privateKey, GOOD, { ttl: 600 }), raw, ORG, BIND))).toBe("lifetime");
  });

  test("is refused once expired, and when issued too far in the future", async () => {
    const { privateKey, raw } = await keypair();
    const expired = await mint(privateKey, GOOD, { iat: IAT - 120, ttl: 60 });
    expect(await rule(verifyGrant(expired, raw, ORG, BIND))).toBe("expired");
    const ahead = await mint(privateKey, GOOD, { iat: IAT + 61, ttl: 60 });
    expect(await rule(verifyGrant(ahead, raw, ORG, BIND))).toBe("not_yet_valid");
    // A minute of clock difference in that direction is allowed.
    const slightlyAhead = await mint(privateKey, GOOD, { iat: IAT + 59, ttl: 60 });
    expect(await rule(verifyGrant(slightlyAhead, raw, ORG, BIND))).toBe("accepted");
  });

  test("must carry a jti, and an exp", async () => {
    const { privateKey, raw } = await keypair();
    expect(await rule(verifyGrant(await mint(privateKey, GOOD, { jti: null }), raw, ORG, BIND))).toBe(
      "single_use_id",
    );
    expect(await rule(verifyGrant(await mint(privateKey, GOOD, { jti: "x".repeat(129) }), raw, ORG, BIND))).toBe(
      "single_use_id",
    );
    const eternal = verifyGrant(await mint(privateKey, GOOD, { exp: false }), raw, ORG, BIND);
    expect(await rule(eternal)).toContain("ERR_JWT_CLAIM_VALIDATION_FAILED");
  });

  test("names the first rule in the documented order, whatever else is wrong", async () => {
    const { privateKey, raw } = await keypair();
    // Expired AND for another organization AND for another ask: the organization
    // is checked before the subject, and the subject before the expiry.
    const token = await mint(
      privateKey,
      { ...GOOD, org: "org_other", sub: "host:status" },
      { iat: IAT - 3600, ttl: 60 },
    );
    expect(await rule(verifyGrant(token, raw, ORG, BIND))).toBe("organization");
    const expiredWrongAsk = await mint(privateKey, { ...GOOD, sub: "host:status" }, { iat: IAT - 3600 });
    expect(await rule(verifyGrant(expiredWrongAsk, raw, ORG, BIND))).toBe("subject");
    const expiredWrongScope = await mint(privateKey, { ...GOOD, scopeHash: "other" }, { iat: IAT - 3600 });
    expect(await rule(verifyGrant(expiredWrongScope, raw, ORG, BIND))).toBe("scope");
  });
});

describe("no other surface accepts a module grant", () => {
  test("the vault RPC, the MCP tools and the gateway's own grant check refuse it", async () => {
    const { privateKey, raw } = await keypair();
    const token = await mint(privateKey, GOOD);
    for (const purpose of ["read", "ingest"] as const) {
      expect(await rule(verifyGrant(token, raw, ORG, { purpose, requireScope: false }))).toBe("purpose");
      expect(await rule(verifyGrant(token, raw, ORG, { purpose }))).toBe("purpose");
    }
  });

  test("the HTTP gateway refuses it as a capability token", async () => {
    const { privateKey, raw } = await keypair();
    // Even with the `repo` claim a capability token needs.
    const token = await mint(privateKey, { ...GOOD, repo: "acme/app" });
    await expect(verifyCapabilityToken(token, raw, ORG)).rejects.toThrow(/purpose is not valid here/);
  });

  test("the console door refuses it", async () => {
    const { privateKey, raw } = await keypair();
    const token = await mint(privateKey, { ...GOOD, origin: "https://fortress.example" });
    const verdict = await verifyConsoleGrant({
      grant: token,
      publicKey: raw,
      orgId: ORG,
      publicUrlOrigin: "https://fortress.example",
      ssoEnabled: true,
      now,
    });
    expect(verdict.ok).toBe(false);
  });

  test("and the module gate refuses every other purpose", async () => {
    const { privateKey, raw } = await keypair();
    for (const purpose of ["read", "ingest", "console"]) {
      const token = await mint(privateKey, { ...GOOD, purpose });
      expect(await rule(verifyGrant(token, raw, ORG, BIND))).toBe("purpose");
    }
  });
});

// A grant names two organizations. `aud` is the one this fortress enrolled
// as: who the grant is addressed to. `org` is the one the ask is for. A fortress
// that holds one organization accepts only a grant where they are the same.
describe("the organization a module grant is for", () => {
  const HELD = "alder-dental";

  test("a fortress that holds one organization accepts only its own, as it always did", async () => {
    const { privateKey, raw } = await keypair();
    const token = await mint(privateKey, { ...GOOD, org: HELD });
    // No `holds`: there is no other organization to be for.
    expect(await rule(verifyGrant(token, raw, ORG, BIND))).toBe("organization");
    expect(await rule(verifyGrant(token, raw, ORG, { ...BIND, holds: () => false }))).toBe("organization");
  });

  test("an organization this fortress holds is accepted, and the claims say which", async () => {
    const { privateKey, raw } = await keypair();
    const asked: string[] = [];
    const holds = (org: string): boolean => {
      asked.push(org);
      return org === HELD;
    };
    const claims = await verifyGrant(await mint(privateKey, { ...GOOD, org: HELD }), raw, ORG, { ...BIND, holds });
    expect(claims).toMatchObject({ org: HELD, aud: ORG, purpose: "module" });
    expect(asked).toEqual([HELD]);
    // The fortress's own organization is never asked about: it is the one the
    // grant is addressed to.
    await verifyGrant(await mint(privateKey, GOOD), raw, ORG, { ...BIND, holds });
    expect(asked).toEqual([HELD]);
    // An answer that is not exactly "yes" is a no.
    for (const answer of [undefined, null, 1, "yes", {}]) {
      const loose = (): boolean => answer as unknown as boolean;
      const token = await mint(privateKey, { ...GOOD, org: HELD });
      expect(await rule(verifyGrant(token, raw, ORG, { ...BIND, holds: loose }))).toBe("organization");
    }
  });

  test("it must still be addressed to this fortress", async () => {
    const { privateKey, raw } = await keypair();
    const holdsEverything = (): boolean => true;
    for (const override of [
      { org: HELD, aud: HELD },
      { org: HELD, aud: "org_other" },
      { org: ORG, aud: HELD },
      { org: HELD, aud: undefined },
      { org: HELD, aud: [ORG] },
    ]) {
      const token = await mint(privateKey, { ...GOOD, ...override });
      expect(await rule(verifyGrant(token, raw, ORG, { ...BIND, holds: holdsEverything }))).toBe("organization");
    }
  });

  test("the organization must be a string, whatever the fortress holds", async () => {
    const { privateKey, raw } = await keypair();
    const asked: unknown[] = [];
    const holds = (org: string): boolean => {
      asked.push(org);
      return true;
    };
    for (const org of [undefined, null, 7, [HELD], { id: HELD }]) {
      const token = await mint(privateKey, { ...GOOD, org });
      expect(await rule(verifyGrant(token, raw, ORG, { ...BIND, holds }))).toBe("organization");
    }
    expect(asked).toEqual([]);
  });

  test("nothing is looked up for a token that does not verify, or that is for another purpose", async () => {
    const { privateKey, raw } = await keypair();
    const other = await keypair();
    let asked = 0;
    const holds = (): boolean => {
      asked += 1;
      return true;
    };
    const forged = await mint(other.privateKey, { ...GOOD, org: HELD });
    await verifyGrant(forged, raw, ORG, { ...BIND, holds }).catch(() => undefined);
    const wrongPurpose = await mint(privateKey, { ...GOOD, org: HELD, purpose: "read" });
    expect(await rule(verifyGrant(wrongPurpose, raw, ORG, { ...BIND, holds }))).toBe("purpose");
    expect(asked).toBe(0);
  });

  test("whether the fortress holds it is asked last: a grant that fails another check looks nothing up", async () => {
    const { privateKey, raw } = await keypair();
    const asked: string[] = [];
    const holds = (org: string): boolean => {
      asked.push(org);
      return org === HELD;
    };
    // Each grant below fails one other check. It is refused by that check, for
    // an organization this fortress holds and for one it does not hold alike:
    // how a grant that does not verify is refused says nothing about the list.
    for (const org of [HELD, "dogwood-diner"]) {
      const refusedBy = async (
        claims: Record<string, unknown>,
        options: Parameters<typeof mint>[2] = {},
      ): Promise<string> =>
        rule(verifyGrant(await mint(privateKey, { ...GOOD, org, ...claims }, options), raw, ORG, { ...BIND, holds }));
      expect(await refusedBy({ sub: "host:status" })).toBe("subject");
      expect(await refusedBy({ scopeHash: "another-hash" })).toBe("scope");
      expect(await refusedBy({}, { iat: IAT - 3600 })).toBe("expired");
      expect(await refusedBy({}, { ttl: MODULE_GRANT_MAX_LIFETIME_SECONDS + 1 })).toBe("lifetime");
      expect(await refusedBy({}, { iat: IAT + 3600 })).toBe("not_yet_valid");
      expect(await refusedBy({}, { jti: null })).toBe("single_use_id");
    }
    expect(asked).toEqual([]);

    // A grant that passes every other check is the one that is asked about.
    expect(await rule(verifyGrant(await mint(privateKey, { ...GOOD, org: "dogwood-diner" }), raw, ORG, { ...BIND, holds }))).toBe(
      "organization",
    );
    await verifyGrant(await mint(privateKey, { ...GOOD, org: HELD }), raw, ORG, { ...BIND, holds });
    expect(asked).toEqual(["dogwood-diner", HELD]);
  });

  test("with nobody to ask, another organization is refused where it always was: before the ask and the arguments", async () => {
    const { privateKey, raw } = await keypair();
    let hashed = 0;
    const token = await mint(privateKey, { ...GOOD, org: "dogwood-diner", sub: "host:status" }, { iat: IAT - 3600 });
    const refusal = verifyGrant(token, raw, ORG, {
      ...BIND,
      scopeHash: () => {
        hashed += 1;
        return SCOPE;
      },
    });
    expect(await rule(refusal)).toBe("organization");
    expect(hashed).toBe(0);
  });

  test("no other grant can be for another organization than the fortress's own", async () => {
    const { privateKey, raw } = await keypair();
    for (const purpose of ["read", "ingest"] as const) {
      const token = await mint(privateKey, { v: 2, purpose, org: HELD, aud: ORG, sub: "user_1", scopeHash: "x" });
      // Even a caller that passed `holds` by mistake: it is read for a module grant only.
      const loose = { purpose, requireScope: false, holds: () => true } as { purpose: "read" | "ingest" };
      expect(await rule(verifyGrant(token, raw, ORG, loose))).toBe("organization");
    }
  });
});
