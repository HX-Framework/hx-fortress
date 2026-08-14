// The console door: what a one-click grant has to prove, what it produces, and
// what this fortress tells let.ai about itself while it is open.

import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportJWK, SignJWT, importPKCS8 } from "jose";

import { readConsoleAdvertisement } from "../src/ui/advertise";
import { clearClockSkew, clockSkewPath, writeClockSkew } from "../src/ui/clock-skew";
import { UI_CONFIG_DEFAULTS, type UiConfig } from "../src/ui/config";
import {
  ConsumedGrants,
  CONSOLE_GRANT_PURPOSE,
  EntryContexts,
  verifyConsoleGrant,
} from "../src/ui/sso-grant";
import { verifyCapabilityToken } from "../src/gateway/capability-token";
import { dataPathRows } from "../src/ui/egress";
import { SSO_ON_DISCLOSURE } from "../src/ui/copy";

const ORG = "org-abc";
const ORIGIN = "https://fortress.example";

async function signer(): Promise<{
  publicKey: string;
  mint: (
    claims: Record<string, unknown>,
    opts?: { expiresIn?: string | number; iat?: number },
  ) => Promise<string>;
  mintNotBefore: (notBefore: number) => Promise<string>;
}> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const key = await importPKCS8(privateKey, "EdDSA");
  const jwk = await exportJWK(
    (await import("node:crypto")).createPublicKey(publicKey),
  );
  const sign = async (
    claims: Record<string, unknown>,
    build: (jwt: SignJWT) => SignJWT,
  ): Promise<string> =>
    await build(new SignJWT(claims).setProtectedHeader({ alg: "EdDSA" })).sign(key);
  return {
    publicKey: jwk.x as string,
    mintNotBefore: async (notBefore) =>
      await sign(
        {
          purpose: CONSOLE_GRANT_PURPOSE,
          org: ORG,
          aud: ORG,
          sub: "u",
          origin: ORIGIN,
        },
        (jwt) => jwt.setJti("skewed").setIssuedAt(notBefore).setNotBefore(notBefore).setExpirationTime(notBefore + 120),
      ),
    mint: async (claims, opts = {}) => {
      let jwt = new SignJWT(claims).setProtectedHeader({ alg: "EdDSA" }).setJti(
        (claims.jti as string) ?? `jti-${Math.random().toString(36).slice(2)}`,
      );
      jwt = jwt.setIssuedAt(opts.iat).setExpirationTime(opts.expiresIn ?? "2m");
      return await jwt.sign(key);
    },
  };
}

function baseArgs(publicKey: string): Parameters<typeof verifyConsoleGrant>[0] {
  return {
    grant: "",
    publicKey,
    orgId: ORG,
    publicUrlOrigin: ORIGIN,
    ssoEnabled: true,
  };
}

describe("the console-grant verifier", () => {
  test("accepts a grant bound to this org, this origin and this purpose", async () => {
    const { publicKey, mint } = await signer();
    const grant = await mint({
      purpose: CONSOLE_GRANT_PURPOSE,
      org: ORG,
      aud: ORG,
      sub: "user-1",
      origin: ORIGIN,
    });
    const verdict = await verifyConsoleGrant({ ...baseArgs(publicKey), grant });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.claims.sub).toBe("user-1");
  });

  test.each([
    ["wrong org", { org: "other", aud: "other" }, "wrong_org"],
    ["a mismatched audience", { org: ORG, aud: "other" }, "wrong_org"],
    ["another origin", { origin: "https://elsewhere.example" }, "origin_mismatch"],
    ["a read purpose", { purpose: "read" }, "generic"],
    ["an ingest purpose", { purpose: "ingest" }, "generic"],
  ])("refuses %s", async (_name, override, reason) => {
    const { publicKey, mint } = await signer();
    const grant = await mint({
      purpose: CONSOLE_GRANT_PURPOSE,
      org: ORG,
      aud: ORG,
      sub: "user-1",
      origin: ORIGIN,
      ...override,
    });
    const verdict = await verifyConsoleGrant({ ...baseArgs(publicKey), grant });
    expect(verdict).toMatchObject({ ok: false, reason });
  });

  test("refuses when SSO is off — but only for a grant it could otherwise read", async () => {
    const { publicKey, mint } = await signer();
    const grant = await mint({
      purpose: CONSOLE_GRANT_PURPOSE,
      org: ORG,
      aud: ORG,
      sub: "u",
      origin: ORIGIN,
    });
    expect(
      await verifyConsoleGrant({ ...baseArgs(publicKey), grant, ssoEnabled: false }),
    ).toMatchObject({ ok: false, reason: "sso_disabled" });
  });

  test("an unverifiable token renders the generic page and names nothing", async () => {
    const { publicKey } = await signer();
    const other = await signer();
    const foreign = await other.mint({
      purpose: CONSOLE_GRANT_PURPOSE,
      org: ORG,
      aud: ORG,
      sub: "u",
      origin: ORIGIN,
    });
    // Signed by a key this fortress does not hold: nothing it claims is evidence.
    expect(await verifyConsoleGrant({ ...baseArgs(publicKey), grant: foreign })).toEqual({
      ok: false,
      reason: "generic",
    });
    // And before any key is pinned at all, the same page.
    expect(
      await verifyConsoleGrant({ ...baseArgs(publicKey), publicKey: null, grant: foreign }),
    ).toEqual({ ok: false, reason: "generic" });
  });

  test("names the offset when the clock is why, and records it for the console", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "hx-skew-"));
    try {
      const { publicKey, mintNotBefore } = await signer();
      const nowSeconds = Math.floor(Date.now() / 1000);
      // Minted by a peer whose clock is ten minutes ahead of this host's: the
      // signature is perfect and the window has not opened yet.
      const grant = await mintNotBefore(nowSeconds + 600);
      const measured: number[] = [];
      const verdict = await verifyConsoleGrant({
        ...baseArgs(publicKey),
        grant,
        onClockSkew: async (offset) => {
          measured.push(offset);
          await writeClockSkew(runtimeRoot, offset);
        },
      });
      expect(verdict).toMatchObject({ ok: false, reason: "clock_skew" });
      if (!verdict.ok) expect(Math.abs(verdict.offsetSeconds ?? 0)).toBeGreaterThan(30);
      // The Posture panel reads this file; nothing else writes it.
      const written = JSON.parse(await readFile(clockSkewPath(runtimeRoot), "utf8")) as {
        offsetSeconds: number;
        allowedSeconds: number;
      };
      expect(written.allowedSeconds).toBe(30);
      expect(Math.abs(written.offsetSeconds)).toBeGreaterThan(30);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  test("a merely STALE grant is not diagnosed as a broken clock", async () => {
    // A short window plus an operator who clicked late is an expired link, not a
    // drifted host. Diagnosing it as skew wrote a record nothing could clear and
    // pinned a permanent Posture warning on a healthy fortress.
    const { publicKey, mint } = await signer();
    const nowSeconds = Math.floor(Date.now() / 1000);
    // Minted 61 s ago with a 1 s window: expired 60 s ago, which is a slow
    // click, not a drifted clock.
    const grant = await mint(
      {
        jti: "stale-1",
        purpose: CONSOLE_GRANT_PURPOSE,
        org: ORG,
        aud: ORG,
        sub: "u",
        origin: ORIGIN,
      },
      { iat: nowSeconds - 61, expiresIn: nowSeconds - 60 },
    );
    const measured: number[] = [];
    const verdict = await verifyConsoleGrant({
      ...baseArgs(publicKey),
      grant,
      onClockSkew: async (offset) => {
        measured.push(offset);
      },
    });
    expect(verdict).toMatchObject({ ok: false, reason: "expired" });
    expect(measured).toEqual([]);
  });

  test("a hand-off that WORKS clears the skew record", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "hx-skew-clear-"));
    try {
      // A record left behind by an earlier failure — or by the mis-diagnosis
      // that used to be possible.
      await writeClockSkew(runtimeRoot, 900);
      expect(await readFile(clockSkewPath(runtimeRoot), "utf8")).toContain("offsetSeconds");

      const { publicKey, mint } = await signer();
      const grant = await mint({
        jti: "grant-ok",
        purpose: CONSOLE_GRANT_PURPOSE,
        org: ORG,
        aud: ORG,
        sub: "u",
        origin: ORIGIN,
      });
      const verdict = await verifyConsoleGrant({
        ...baseArgs(publicKey),
        grant,
        onClockOk: async () => {
          await clearClockSkew(runtimeRoot);
        },
      });
      expect(verdict.ok).toBe(true);
      await expect(readFile(clockSkewPath(runtimeRoot), "utf8")).rejects.toThrow();
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  test("is single-use, keyed on jti", async () => {
    const { publicKey, mint } = await signer();
    const grant = await mint({
      jti: "grant-1",
      purpose: CONSOLE_GRANT_PURPOSE,
      org: ORG,
      aud: ORG,
      sub: "u",
      origin: ORIGIN,
    });
    const consumed = new ConsumedGrants();
    const args = {
      ...baseArgs(publicKey),
      grant,
      consume: (jti: string, expiresAt: Date) => consumed.consume(jti, expiresAt),
    };
    expect((await verifyConsoleGrant(args)).ok).toBe(true);
    expect(await verifyConsoleGrant(args)).toMatchObject({ ok: false, reason: "grant_used" });
  });
});

describe("the realms are four one-way doors", () => {
  test("a console grant is not a capability token, in either direction", async () => {
    const { publicKey, mint } = await signer();
    const consoleGrant = await mint({
      purpose: CONSOLE_GRANT_PURPOSE,
      org: ORG,
      aud: ORG,
      repo: "r",
      sub: "u",
      origin: ORIGIN,
    });
    // The ingest/read realm refuses an unknown purpose outright rather than
    // reading it as a purpose-less legacy token.
    await expect(verifyCapabilityToken(consoleGrant, publicKey, ORG)).rejects.toThrow(
      /purpose is not valid here/,
    );

    for (const purpose of ["ingest", "read"]) {
      const token = await mint({ purpose, org: ORG, aud: ORG, repo: "r", sub: "u", origin: ORIGIN });
      expect(await verifyConsoleGrant({ ...baseArgs(publicKey), grant: token })).toMatchObject({
        ok: false,
        reason: "generic",
      });
    }
  });
});

describe("the entry record", () => {
  test("carries the workbench identity, and survives a failed password attempt", () => {
    const entries = new EntryContexts();
    const record = entries.create({ workbenchSub: "user-1", org: ORG });
    expect(entries.read(record.id)?.workbenchSub).toBe("user-1");
    // Read, not consumed: burning it on the first attempt would drop the dual
    // identity from the record of the attempt that succeeded.
    expect(entries.read(record.id)?.workbenchSub).toBe("user-1");
    expect(entries.read("made-up")).toBeNull();
  });

  test("expires on its own", () => {
    const entries = new EntryContexts(1_000);
    const now = new Date();
    const record = entries.create({ workbenchSub: "u", org: ORG }, now);
    expect(entries.read(record.id, new Date(now.getTime() + 500))).not.toBeNull();
    expect(entries.read(record.id, new Date(now.getTime() + 2_000))).toBeNull();
  });
});

describe("what this fortress advertises", () => {
  const config = (over: Partial<UiConfig>): { read: () => Promise<UiConfig> } => ({
    read: async () => ({ ...UI_CONFIG_DEFAULTS, ...over }),
  });

  test("advertises the origin only when sso, enablement and an https URL all hold", async () => {
    expect(
      await readConsoleAdvertisement({
        config: config({ sso: true, enabled: true, publicUrl: ORIGIN }),
        env: {},
      }),
    ).toEqual({ consoleUrl: ORIGIN, runtimeKind: "host" });

    for (const over of [
      { sso: false, enabled: true, publicUrl: ORIGIN },
      { sso: true, enabled: false, publicUrl: ORIGIN },
      { sso: true, enabled: true, publicUrl: null },
    ]) {
      expect(
        (await readConsoleAdvertisement({ config: config(over), env: {} })).consoleUrl,
      ).toBeNull();
    }
  });

  test("an env-enabled console still advertises, and unsetting the variable clears it", async () => {
    const stored = config({ sso: true, enabled: false, publicUrl: ORIGIN });
    expect(
      (await readConsoleAdvertisement({ config: stored, env: { FORTRESS_UI_ENABLE: "1" } }))
        .consoleUrl,
    ).toBe(ORIGIN);
    expect((await readConsoleAdvertisement({ config: stored, env: {} })).consoleUrl).toBeNull();
  });

  test("a URL with a path advertises nothing — the console app is root-absolute", async () => {
    expect(
      (
        await readConsoleAdvertisement({
          config: config({ sso: true, enabled: true, publicUrl: "https://host.example/console" }),
          env: {},
        })
      ).consoleUrl,
    ).toBeNull();
  });

  test("reports the deployment shape from the docker-class signals alone", async () => {
    const stored = config({ sso: true, enabled: true, publicUrl: ORIGIN });
    expect(
      (await readConsoleAdvertisement({ config: stored, env: { KUBERNETES_SERVICE_HOST: "1" } }))
        .runtimeKind,
    ).toBe("container");
    expect((await readConsoleAdvertisement({ config: stored, env: {} })).runtimeKind).toBe("host");
  });
});

describe("the door is in the inventory", () => {
  test("renders both halves: the grant coming in and the URL going out", () => {
    const rows = dataPathRows({
      ui: { ...UI_CONFIG_DEFAULTS, sso: true, publicUrl: ORIGIN },
      boundPort: 8788,
      postgres: { mode: "unknown" },
      cloudUrl: "wss://workbench.let.ai/_api/hx-gateway/vault-tunnel",
      downloadBase: null,
      postgresBinariesUrl: "https://example",
      bucket: null,
      embeddingEndpoint: null,
      ssoAdvertised: true,
    rosterRetentionDays: 90,
    });
    const door = rows.find((r) => r.id === "sso-door");
    expect(door?.direction).toBe("in");
    expect(door?.notes?.join(" ")).toContain("creates NO session");
    expect(rows.find((r) => r.id === "console-url-advertised")?.direction).toBe("out");
  });

  test("the sso-on disclosure says the URL travels on every reconnect", () => {
    expect(SSO_ON_DISCLOSURE.join(" ")).toContain("re-sent on every reconnect");
    expect(SSO_ON_DISCLOSURE.join(" ")).toContain("fleet view");
  });
});
