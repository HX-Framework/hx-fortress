import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { AskFailure } from "../../src/host/module-contract";
import {
  installedVersions,
  readReleaseShelf,
  releaseAnchors,
  SHELF_MAX_WAITING,
  type InstallResult,
  type OfferFrame,
  RELEASE_STATEMENT_CONTEXT,
  RELEASE_VERSION_PATTERN,
  releaseStatement,
} from "../../src/host/release-shelf";
import { conform, S } from "../../src/host/shape";
import type { TrustedSigningKey } from "../../src/host/trust/signing-keys";
import {
  createProbeModule,
  makeReleaseSigner,
  makeRig,
  PROBE_MANIFEST,
  sha256Hex,
  spoolRecords,
  spoolText,
  type ReleaseSigner,
  type Rig,
} from "./_module-rig";

const ARTIFACT = new TextEncoder().encode("probe release 1.4.1: opaque bytes the module applies");
// The rig's fortress is enrolled at relay.example, so this is the relay's own origin.
const RELAY = "https://relay.example/_api/hx-gateway/download/modules";
const URL_1 = `${RELAY}/probe-1.4.1.bin`;

let rig: Rig;
afterEach(async () => {
  await rig?.cleanup();
});

interface ShelfRig extends Rig {
  signer: ReleaseSigner;
  fetched: string[];
  reported: InstallResult[];
  offer(overrides?: Partial<OfferFrame>, bytes?: Uint8Array): Promise<InstallResult | null>;
}

/** A rig whose shelf trusts one throwaway PRODUCTION anchor and serves
 *  `artifacts` to any fetch. */
async function shelfRig(
  options: {
    signer?: ReleaseSigner;
    trustedKeys?: readonly TrustedSigningKey[];
    env?: Record<string, string | undefined>;
    artifacts?: Record<string, Uint8Array<ArrayBuffer> | (() => Response)>;
    enabled?: string[];
    takesReleases?: boolean;
    applyDeadlineMs?: number;
  } = {},
): Promise<ShelfRig> {
  const signer = options.signer ?? (await makeReleaseSigner("hxf-prod-test-1", true));
  const fetched: string[] = [];
  const artifacts = options.artifacts ?? { [URL_1]: ARTIFACT };
  const base = await makeRig({
    enabled: options.enabled ?? ["session_vault", "probe"],
    probe: createProbeModule(PROBE_MANIFEST, { takesReleases: options.takesReleases }),
    deps: {
      trustedKeys: options.trustedKeys ?? signer.trusted,
      env: options.env ?? {},
      ...(options.applyDeadlineMs !== undefined ? { applyDeadlineMs: options.applyDeadlineMs } : {}),
      releaseFetchImpl: (async (input: string | URL) => {
        const url = String(input);
        fetched.push(url);
        // The lookup is by a URL the test itself wrote.
        // eslint-disable-next-line security/detect-object-injection
        const found = artifacts[url];
        if (found === undefined) return new Response("not found", { status: 404 });
        return typeof found === "function" ? found() : new Response(found);
      }) as unknown as typeof fetch,
    },
  });
  const reported: InstallResult[] = [];
  base.host.shelf.setReporter((result) => {
    reported.push(result);
    return true;
  });
  const shelf: ShelfRig = Object.assign(base, {
    signer,
    fetched,
    reported,
    // The signature is over the module, the version and the checksum the frame
    // ends up carrying, unless the test supplies a signature of its own.
    offer: async (overrides: Partial<OfferFrame> = {}, bytes: Uint8Array = ARTIFACT) => {
      const frame = {
        moduleId: "probe",
        version: "1.4.1",
        artifactUrl: URL_1,
        checksum: sha256Hex(bytes),
        ...overrides,
      };
      return base.host.releases.offer({
        ...frame,
        signature:
          "signature" in overrides
            ? overrides.signature
            : await signer.release(
                String(frame.moduleId),
                String(frame.version),
                // The statement holds the checksum as the fortress reads it.
                String(frame.checksum).trim().toLowerCase(),
              ),
      });
    },
  });
  return shelf;
}

async function offerRecords(r: Rig) {
  await r.host.audit.flush();
  return (await spoolRecords(r.paths))
    .filter((record) => record.action === "relay.release.offer")
    .map((record) => ({ kind: record.kind, outcome: record.outcome, params: record.params, error: record.error }));
}

async function onlyRelease(r: Rig) {
  const releases = await readReleaseShelf(r.paths);
  expect(releases).toHaveLength(1);
  return releases[0]!;
}

describe("an offer", () => {
  test("a signed release is verified and held as waiting, and nothing else happens", async () => {
    const r = (rig = await shelfRig());
    expect(await r.offer()).toBeNull();
    const release = await onlyRelease(r);
    expect(release).toMatchObject({
      moduleId: "probe",
      version: "1.4.1",
      checksum: sha256Hex(ARTIFACT),
      signedBy: "hxf-prod-test-1",
      state: "waiting",
    });
    expect(release.id).toMatch(/^rel-[0-9a-f]{16}$/);
    expect(release.decidedAt).toBeUndefined();
    // Held, not applied: the module has heard nothing, and neither has the relay.
    expect(r.probe.applied).toEqual([]);
    expect(r.reported).toEqual([]);
    expect(await offerRecords(r)).toEqual([
      {
        kind: "intent",
        outcome: null,
        params: { module: "probe", version: "1.4.1", release: release.id, signedBy: "hxf-prod-test-1" },
        error: null,
      },
      { kind: "outcome", outcome: "waiting", params: null, error: null },
    ]);
    // The artifact is on disk, owner-only.
    const dir = r.paths.moduleArtifacts("probe");
    expect(await readdir(dir)).toEqual([`${release.id}.bin`]);
    expect(new Uint8Array(await readFile(path.join(dir, `${release.id}.bin`)))).toEqual(ARTIFACT);
    expect((await Bun.file(path.join(dir, `${release.id}.bin`)).stat()).mode & 0o777).toBe(0o600);
  });

  test("an unsigned release is refused, and nothing is fetched", async () => {
    const r = (rig = await shelfRig());
    for (const signature of [undefined, "", null, 7]) {
      expect(await r.offer({ signature })).toEqual({
        moduleId: "probe",
        version: "1.4.1",
        ok: false,
        error: "refused:signature_missing",
      });
    }
    expect(r.fetched).toEqual([]);
    expect(await readReleaseShelf(r.paths)).toEqual([]);
    const records = await offerRecords(r);
    expect(records[0]).toEqual({
      kind: "outcome",
      outcome: "refused",
      params: { module: "probe", rule: "signature_missing" },
      error: null,
    });
  });

  test("a signature that is not a sidecar, or names a key this build does not trust, is refused unfetched", async () => {
    const r = (rig = await shelfRig());
    expect(await r.offer({ signature: "not json" })).toMatchObject({ error: "refused:signature_malformed" });
    const stranger = await makeReleaseSigner("hxf-prod-someone-else", true);
    expect(await r.offer({ signature: await stranger.sign(ARTIFACT) })).toMatchObject({
      error: "refused:signer_untrusted",
    });
    expect(r.fetched).toEqual([]);
  });

  test("a signature made for another file is refused, and nothing is fetched", async () => {
    const r = (rig = await shelfRig());
    const other = new TextEncoder().encode("different bytes");
    const forOther = await r.signer.release("probe", "1.4.1", sha256Hex(other));
    expect(await r.offer({ signature: forOther })).toMatchObject({ error: "refused:signature_invalid" });
    expect(r.fetched).toEqual([]);
    expect(await readReleaseShelf(r.paths)).toEqual([]);
    expect((await offerRecords(r)).at(-1)).toMatchObject({
      outcome: "refused",
      params: { module: "probe", rule: "signature_invalid" },
    });
  });

  test("the signature binds the module and the version, not only the file", async () => {
    const r = (rig = await shelfRig());
    const checksum = sha256Hex(ARTIFACT);
    // A real signature, by the trusted key, for this very file: as version
    // 1.0.0 of this module, and as version 1.4.1 of another module.
    const older = await r.signer.release("probe", "1.0.0", checksum);
    const elsewhere = await r.signer.release("session_vault", "1.4.1", checksum);
    for (const signature of [older, elsewhere]) {
      expect(await r.offer({ version: "1.4.1", signature })).toMatchObject({
        error: "refused:signature_invalid",
      });
    }
    // And the way a Fortress binary is signed, over the file's own bytes, does
    // not count here: whatever else that key signed is not a module release.
    expect(await r.offer({ signature: await r.signer.sign(ARTIFACT) })).toMatchObject({
      error: "refused:signature_invalid",
    });
    expect(r.fetched).toEqual([]);
    expect(await readReleaseShelf(r.paths)).toEqual([]);
  });

  test("a file that is not the one that was signed is refused after the fetch", async () => {
    const other = new TextEncoder().encode("what the relay serves instead");
    const r = (rig = await shelfRig({ artifacts: { [URL_1]: other } }));
    // The offer is genuine: signed for ARTIFACT. The relay serves other bytes.
    expect(await r.offer()).toMatchObject({ error: "refused:checksum_mismatch" });
    expect(r.fetched).toEqual([URL_1]);
    expect(await readReleaseShelf(r.paths)).toEqual([]);
    expect((await offerRecords(r)).at(-1)).toMatchObject({ outcome: "refused", error: "checksum_mismatch" });
  });

  test("until the signature verifies, the offer is told nothing about this host", async () => {
    const r = (rig = await shelfRig({ enabled: ["session_vault"] }));
    const bad = await r.signer.release("probe", "9.9.9", sha256Hex(ARTIFACT));
    // The module is off and the URL is on a host nobody listed. Neither is what
    // the relay hears: the signature is checked first.
    expect(
      await r.offer({ signature: bad, artifactUrl: "https://elsewhere.example/a.bin" }),
    ).toMatchObject({ error: "refused:signature_invalid" });
    // With a genuine statement it is told the first of them.
    expect(await r.offer({ artifactUrl: "https://elsewhere.example/a.bin" })).toMatchObject({
      error: "refused:url_host_not_allowed",
    });
    expect(await r.offer()).toMatchObject({ error: "refused:module_off" });
    expect(r.fetched).toEqual([]);
  });

  test("a version is made of characters a name may hold", async () => {
    const r = (rig = await shelfRig());
    // No answer: the frame names no version this host could repeat back.
    expect(await r.offer({ version: "1.4.0+build.7" })).toBeNull();
    expect((await offerRecords(r)).at(-1)?.params).toEqual({ module: "probe", rule: "version_malformed" });
    // Every character a version may hold, in one version. The `host` module
    // reports versions as names, so each of them must be a name.
    const every = "Az09._-";
    expect(RELEASE_VERSION_PATTERN.test(every)).toBe(true);
    expect(conform(S.name, every)).toEqual({ ok: true, value: every });
    for (let code = 33; code < 127; code += 1) {
      const candidate = `1${String.fromCharCode(code)}2`;
      if (RELEASE_VERSION_PATTERN.test(candidate)) {
        expect([candidate, conform(S.name, candidate).ok]).toEqual([candidate, true]);
      }
    }
  });

  test("a key with the trusted id and the wrong private half is refused", async () => {
    const real = await makeReleaseSigner("hxf-prod-test-1", true);
    const forger = await makeReleaseSigner("hxf-prod-test-1", true);
    const r = (rig = await shelfRig({ signer: forger, trustedKeys: real.trusted }));
    expect(await r.offer()).toMatchObject({ error: "refused:signature_invalid" });
  });

  test("bytes that do not match the checksum are refused, signed or not", async () => {
    const r = (rig = await shelfRig());
    expect(await r.offer({ checksum: "0".repeat(64) })).toMatchObject({ error: "refused:checksum_mismatch" });
    expect(await r.offer({ checksum: "abc" })).toMatchObject({ error: "refused:checksum_malformed" });
    expect(await r.offer({ checksum: undefined })).toMatchObject({ error: "refused:checksum_malformed" });
    expect(await readReleaseShelf(r.paths)).toEqual([]);
  });

  test("the checksum is compared without regard to case or padding", async () => {
    const r = (rig = await shelfRig());
    expect(await r.offer({ checksum: `  ${sha256Hex(ARTIFACT).toUpperCase()} ` })).toBeNull();
    expect((await onlyRelease(r)).state).toBe("waiting");
  });

  test.each([
    ["https://releases.example/a.bin", "url_host_not_allowed"],
    ["https://github.com/owner/repo/releases/download/v1/a.bin", "url_host_not_allowed"],
    ["https://relay.example:8443/a.bin", "url_host_not_allowed"],
    ["http://relay.example/a.bin", "url_not_https"],
    ["https://user:pw@relay.example/a.bin", "url_credentials"],
    ["https://169.254.169.254/latest/meta-data", "url_private_address"],
    ["https://127.0.0.1/a.bin", "url_private_address"],
    ["https://10.0.0.8/a.bin", "url_private_address"],
    ["https://[::1]/a.bin", "url_private_address"],
    ["https://2852039166/a.bin", "url_private_address"],
    ["file:///etc/passwd", "url_not_https"],
    ["not a url", "url_malformed"],
    [42, "url_malformed"],
  ])("an artifact URL of %p is refused as %s, unfetched", async (artifactUrl, rule) => {
    const r = (rig = await shelfRig());
    expect(await r.offer({ artifactUrl })).toMatchObject({ error: `refused:${rule}` });
    expect(r.fetched).toEqual([]);
  });

  test("a host the operator listed in FORTRESS_RELEASE_HOSTS is fetched from too, and no other", async () => {
    const r = (rig = await shelfRig({
      env: { FORTRESS_RELEASE_HOSTS: "downloads.example, other.example" },
      artifacts: { "https://downloads.example/probe.bin": ARTIFACT, [URL_1]: ARTIFACT },
    }));
    expect(await r.offer({ artifactUrl: "https://elsewhere.example/probe.bin" })).toMatchObject({
      error: "refused:url_host_not_allowed",
    });
    expect(r.fetched).toEqual([]);
    expect(await r.offer({ artifactUrl: "https://downloads.example/probe.bin" })).toBeNull();
    expect(r.fetched).toEqual(["https://downloads.example/probe.bin"]);
    // The relay's own origin still counts beside the list.
    expect(await r.offer({ version: "1.4.2" })).toBeNull();
  });

  test("a fortress with no readable cloud URL fetches nothing from the relay", async () => {
    const r = (rig = await shelfRig());
    await Bun.write(r.paths.config, "{ not json");
    expect(await r.offer()).toMatchObject({ error: "refused:url_host_not_allowed" });
    expect(r.fetched).toEqual([]);
  });

  test("a fetch that fails is refused with the rule that failed", async () => {
    const tooLarge = (): Response =>
      new Response("x", { headers: { "content-length": String(65 * 1024 * 1024) } });
    const r = (rig = await shelfRig({ artifacts: { [URL_1]: tooLarge } }));
    expect(await r.offer()).toMatchObject({ error: "refused:fetch_too_large" });
    expect((await offerRecords(r)).at(-1)).toMatchObject({ outcome: "refused", error: "fetch_too_large" });
    await r.cleanup();
    const missing = (rig = await shelfRig({ artifacts: {} }));
    expect(await missing.offer()).toMatchObject({ error: "refused:fetch_status" });
    await missing.cleanup();
    const redirected = (rig = await shelfRig({
      artifacts: {
        [URL_1]: () => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } }),
      },
    }));
    expect(await redirected.offer()).toMatchObject({ error: "refused:fetch_redirect_refused" });
    expect(redirected.fetched).toEqual([URL_1]);
  });

  test("offers that arrive together are fetched one at a time, and each lands", async () => {
    const artifacts: Record<string, Uint8Array<ArrayBuffer>> = {};
    for (let i = 0; i < 4; i += 1) artifacts[`${RELAY}/probe-3.0.${i}.bin`] = ARTIFACT;
    const r = (rig = await shelfRig({ artifacts }));
    const results = await Promise.all(
      [0, 1, 2, 3].map((i) => r.offer({ version: `3.0.${i}`, artifactUrl: `${RELAY}/probe-3.0.${i}.bin` })),
    );
    expect(results).toEqual([null, null, null, null]);
    expect((await readReleaseShelf(r.paths)).map((release) => release.version).sort()).toEqual([
      "3.0.0",
      "3.0.1",
      "3.0.2",
      "3.0.3",
    ]);
  });

  test("the same offer sent twice at once is fetched once", async () => {
    const r = (rig = await shelfRig());
    expect(await Promise.all([r.offer(), r.offer(), r.offer()])).toEqual([null, null, null]);
    expect(r.fetched).toEqual([URL_1]);
    expect(await readReleaseShelf(r.paths)).toHaveLength(1);
  });

  test("an offer for a module this build does not ship, or malformed, gets no answer", async () => {
    const r = (rig = await shelfRig());
    expect(await r.offer({ moduleId: "payroll" })).toBeNull();
    expect(await r.offer({ moduleId: "../../etc" })).toBeNull();
    expect(await r.offer({ version: "../1.0" })).toBeNull();
    expect(await r.offer({ version: 5 })).toBeNull();
    expect(r.fetched).toEqual([]);
    const text = await spoolText(r.paths);
    expect(text).not.toContain("payroll");
    expect(text).not.toContain("etc");
  });

  test("an unsigned offer is refused as unsigned, whatever else is wrong with it", async () => {
    const r = (rig = await shelfRig({ enabled: ["session_vault"] }));
    // The module is off and the URL is nowhere this fortress fetches from.
    expect(await r.offer({ signature: undefined, artifactUrl: "https://elsewhere.example/x.bin" })).toMatchObject({
      error: "refused:signature_missing",
    });
  });

  test("a module that is off, or that takes no releases, is refused", async () => {
    const off = (rig = await shelfRig({ enabled: ["session_vault"] }));
    expect(await off.offer()).toMatchObject({ error: "refused:module_off" });
    await off.cleanup();
    const none = (rig = await shelfRig({ takesReleases: false }));
    expect(await none.offer()).toMatchObject({ error: "refused:module_takes_no_releases" });
    expect(await none.offer({ moduleId: "session_vault" })).toMatchObject({
      error: "refused:module_takes_no_releases",
    });
    expect(none.fetched).toEqual([]);
  });

  test("the same offer again is not fetched again, and says nothing", async () => {
    const r = (rig = await shelfRig());
    await r.offer();
    expect(await r.offer()).toBeNull();
    expect(await r.offer()).toBeNull();
    expect(r.fetched).toEqual([URL_1]);
    expect(await readReleaseShelf(r.paths)).toHaveLength(1);
    expect(await offerRecords(r)).toHaveLength(2);
  });

  test("different bytes under a version already on the shelf are refused", async () => {
    const r = (rig = await shelfRig());
    await r.offer();
    const other = new TextEncoder().encode("not the same release");
    expect(await r.offer({}, other)).toMatchObject({ error: "refused:version_conflict" });
    expect(r.fetched).toEqual([URL_1]);
  });

  test("the shelf holds a bounded number of waiting releases, and fetches are rate-limited", async () => {
    const artifacts: Record<string, Uint8Array<ArrayBuffer>> = {};
    for (let i = 0; i < SHELF_MAX_WAITING + 2; i += 1) artifacts[`${RELAY}/${i}.bin`] = ARTIFACT;
    const r = (rig = await shelfRig({ artifacts }));
    const results: (InstallResult | null)[] = [];
    for (let i = 0; i < SHELF_MAX_WAITING + 2; i += 1) {
      results.push(await r.offer({ version: `1.0.${i}`, artifactUrl: `${RELAY}/${i}.bin` }));
      // The intake budget refills at six a minute.
      r.now.value = new Date(r.now.value.getTime() + 11_000);
    }
    expect(results.filter((result) => result === null)).toHaveLength(SHELF_MAX_WAITING);
    expect(results.at(-1)).toMatchObject({ error: "refused:shelf_full" });
    // Without waiting, the seventh offer in a minute is not fetched.
    const burst = (rig = await shelfRig({ artifacts }));
    await r.cleanup();
    const burstResults: (InstallResult | null)[] = [];
    for (let i = 0; i < 8; i += 1) {
      burstResults.push(await burst.offer({ version: `2.0.${i}`, artifactUrl: `${RELAY}/${i}.bin` }));
    }
    expect(burstResults.filter((result) => result === null)).toHaveLength(6);
    expect(burstResults.at(-1)).toMatchObject({ error: "refused:rate_limited" });
    expect(burst.fetched).toHaveLength(6);
  });
});

describe("which signing keys count", () => {
  const dev: TrustedSigningKey = { keyid: "hxf-dev-test", publicKey: "x", production: false };
  const prod: TrustedSigningKey = { keyid: "hxf-prod-test", publicKey: "y", production: true };

  test("a development anchor counts only when asked for, and only without a production one", () => {
    expect(releaseAnchors({}, [dev])).toEqual([]);
    expect(releaseAnchors({ FORTRESS_ALLOW_DEV_RELEASES: "0" }, [dev])).toEqual([]);
    expect(releaseAnchors({ FORTRESS_ALLOW_DEV_RELEASES: "1" }, [dev])).toEqual([dev]);
    expect(releaseAnchors({ FORTRESS_ALLOW_DEV_RELEASES: "1" }, [dev, prod])).toEqual([prod]);
    expect(releaseAnchors({}, [dev, prod])).toEqual([prod]);
    // A key promoted by editing one field alone is not a production anchor.
    const halfPromoted: TrustedSigningKey = { keyid: "hxf-dev-test", publicKey: "x", production: true };
    expect(releaseAnchors({}, [halfPromoted])).toEqual([]);
  });

  test("the anchors this build ships accept nothing without the flag", () => {
    expect(releaseAnchors({})).toEqual([]);
  });

  test("a release signed by the development key is refused without the flag", async () => {
    const devSigner = await makeReleaseSigner("hxf-dev-test-1", false);
    const r = (rig = await shelfRig({ signer: devSigner }));
    expect(await r.offer()).toMatchObject({ error: "refused:no_trusted_anchor" });
    expect(r.fetched).toEqual([]);
    await r.cleanup();
    const allowed = (rig = await shelfRig({ signer: devSigner, env: { FORTRESS_ALLOW_DEV_RELEASES: "1" } }));
    expect(await allowed.offer()).toBeNull();
    expect((await onlyRelease(allowed)).signedBy).toBe("hxf-dev-test-1");
  });

  test("with a production anchor baked in, the development key never counts", async () => {
    const devSigner = await makeReleaseSigner("hxf-dev-test-1", false);
    const prodSigner = await makeReleaseSigner("hxf-prod-test-1", true);
    const r = (rig = await shelfRig({
      signer: devSigner,
      trustedKeys: [...devSigner.trusted, ...prodSigner.trusted],
      env: { FORTRESS_ALLOW_DEV_RELEASES: "1" },
    }));
    expect(await r.offer()).toMatchObject({ error: "refused:signer_untrusted" });
  });
});

describe("a decision", () => {
  test("approving hands the verified bytes to the module, and the relay is told", async () => {
    const r = (rig = await shelfRig());
    await r.offer();
    const { id } = await onlyRelease(r);
    const result = await r.host.shelf.decide({ id, decision: "approve", decidedBy: "alice" });
    expect(result).toMatchObject({ ok: true, release: { id, state: "installed", decidedBy: "alice" } });
    expect(r.probe.applied).toHaveLength(1);
    expect(r.probe.applied[0]).toMatchObject({
      id,
      moduleId: "probe",
      version: "1.4.1",
      checksum: sha256Hex(ARTIFACT),
      signedBy: "hxf-prod-test-1",
      approvedBy: "alice",
    });
    expect(new Uint8Array(r.probe.applied[0]!.artifact)).toEqual(ARTIFACT);
    expect(r.reported).toEqual([{ moduleId: "probe", version: "1.4.1", ok: true }]);
    expect(installedVersions(await readReleaseShelf(r.paths)).get("probe")).toBe("1.4.1");
    // Applied: the bytes are gone, the record of them stays.
    expect(await readdir(r.paths.moduleArtifacts("probe"))).toEqual([]);

    const trail = (await spoolRecords(r.paths)).filter((record) => record.action.startsWith("system.release."));
    expect(trail.map((record) => [record.action, record.kind, record.outcome, record.actor])).toEqual([
      ["system.release.approved", "outcome", "approved", "alice"],
      ["system.release.install", "intent", null, null],
      ["system.release.install", "outcome", "installed", null],
    ]);
    expect(trail[0]?.params).toEqual({
      release: id,
      module: "probe",
      version: "1.4.1",
      signedBy: "hxf-prod-test-1",
      decidedBy: "alice",
    });
  });

  test("nothing is applied until somebody approves", async () => {
    const r = (rig = await shelfRig());
    await r.offer();
    await r.host.applyRequests();
    await r.host.shelf.reportPending();
    expect(r.probe.applied).toEqual([]);
    expect((await onlyRelease(r)).state).toBe("waiting");
  });

  test("refusing never reaches the module, and removes the artifact", async () => {
    const r = (rig = await shelfRig());
    await r.offer();
    const { id } = await onlyRelease(r);
    const result = await r.host.shelf.decide({ id, decision: "refuse", decidedBy: "alice" });
    expect(result).toMatchObject({ ok: true, release: { state: "refused", decidedBy: "alice" } });
    expect(r.probe.applied).toEqual([]);
    expect(r.reported).toEqual([{ moduleId: "probe", version: "1.4.1", ok: false, error: "refused:operator" }]);
    expect(await readdir(r.paths.moduleArtifacts("probe"))).toEqual([]);
    // A refusal stands: it cannot be approved afterwards, and the same offer is not taken again.
    expect(await r.host.shelf.decide({ id, decision: "approve", decidedBy: "x" })).toMatchObject({
      ok: false,
      reason: "not_waiting",
    });
    expect(await r.offer()).toBeNull();
    expect(r.fetched).toHaveLength(1);
  });

  test("a module that cannot apply it leaves the release failed, and it may be approved again", async () => {
    const r = (rig = await shelfRig());
    await r.offer();
    const { id } = await onlyRelease(r);
    r.probe.applyFailure = new AskFailure("deploy_rejected");
    expect(await r.host.shelf.decide({ id, decision: "approve", decidedBy: "alice" })).toMatchObject({
      ok: true,
      release: { state: "failed", error: "deploy_rejected" },
    });
    expect(r.reported.at(-1)).toEqual({ moduleId: "probe", version: "1.4.1", ok: false, error: "failed:deploy_rejected" });
    r.probe.applyFailure = null;
    expect(await r.host.shelf.decide({ id, decision: "approve", decidedBy: "alice" })).toMatchObject({
      ok: true,
      release: { state: "installed" },
    });
    expect(r.probe.applied).toHaveLength(1);
  });

  test("a thrown message from applyRelease goes nowhere", async () => {
    const r = (rig = await shelfRig());
    await r.offer();
    const { id } = await onlyRelease(r);
    r.probe.applyFailure = new Error("token sk-live-do-not-leak rejected by the API");
    const result = await r.host.shelf.decide({ id, decision: "approve", decidedBy: "alice" });
    expect(result).toMatchObject({ ok: true, release: { state: "failed", error: "internal" } });
    for (const text of [JSON.stringify(r.reported), await spoolText(r.paths), JSON.stringify(r.logs), JSON.stringify(await readReleaseShelf(r.paths))]) {
      expect(text).not.toContain("sk-live");
    }
  });

  test("an install that never finishes fails as a timeout", async () => {
    const r = (rig = await shelfRig({ applyDeadlineMs: 20 }));
    await r.offer();
    const { id } = await onlyRelease(r);
    r.probe.applyRelease = () => new Promise(() => {});
    expect(await r.host.shelf.decide({ id, decision: "approve", decidedBy: "alice" })).toMatchObject({
      ok: true,
      release: { state: "failed", error: "timeout" },
    });
  });

  test("an artifact changed on disk since it was verified is not applied", async () => {
    const r = (rig = await shelfRig());
    await r.offer();
    const { id } = await onlyRelease(r);
    await writeFile(path.join(r.paths.moduleArtifacts("probe"), `${id}.bin`), "tampered");
    expect(await r.host.shelf.decide({ id, decision: "approve", decidedBy: "alice" })).toMatchObject({
      ok: false,
      reason: "artifact_changed",
    });
    expect(r.probe.applied).toEqual([]);
    expect((await onlyRelease(r)).state).toBe("failed");
    expect(r.reported.at(-1)).toMatchObject({ ok: false, error: "failed:artifact_changed" });
  });

  test("a decision is refused for an unknown release, and while the module is off", async () => {
    const r = (rig = await shelfRig());
    await r.offer();
    const { id } = await onlyRelease(r);
    expect(await r.host.shelf.decide({ id: "rel-0000000000000000", decision: "approve", decidedBy: "x" })).toEqual({
      ok: false,
      reason: "release_unknown",
    });
    expect(await r.host.shelf.decide({ id: "../../x", decision: "approve", decidedBy: "x" })).toEqual({
      ok: false,
      reason: "release_unknown",
    });
    await r.registry.stopOne("probe");
    expect(await r.host.shelf.decide({ id, decision: "approve", decidedBy: "x" })).toMatchObject({
      ok: false,
      reason: "module_not_running",
    });
    expect((await onlyRelease(r)).state).toBe("waiting");
    expect(r.probe.applied).toEqual([]);
  });

  test("a result the relay did not hear is sent again on the next connect", async () => {
    const r = (rig = await shelfRig());
    await r.offer();
    const { id } = await onlyRelease(r);
    let online = false;
    const heard: InstallResult[] = [];
    r.host.shelf.setReporter((result) => {
      if (online) heard.push(result);
      return online;
    });
    await r.host.shelf.decide({ id, decision: "approve", decidedBy: "alice" });
    expect(heard).toEqual([]);
    online = true;
    await r.host.shelf.reportPending();
    await r.host.shelf.reportPending();
    expect(heard).toEqual([{ moduleId: "probe", version: "1.4.1", ok: true }]);
  });

  test("an approval the daemon died in the middle of is failed at boot, not run again", async () => {
    const r = (rig = await shelfRig());
    await r.offer();
    const { id } = await onlyRelease(r);
    const file = JSON.parse(await readFile(r.paths.moduleReleases, "utf8")) as {
      releases: { state: string; decidedBy?: string; decidedAt?: string }[];
    };
    file.releases[0]!.state = "approved";
    file.releases[0]!.decidedBy = "alice";
    file.releases[0]!.decidedAt = "2027-03-14T08:00:00.000Z";
    await writeFile(r.paths.moduleReleases, JSON.stringify(file));
    await r.host.shelf.recover();
    expect(await onlyRelease(r)).toMatchObject({ id, state: "failed", error: "interrupted" });
    expect(r.probe.applied).toEqual([]);
    // And a person may approve it again.
    expect(await r.host.shelf.decide({ id, decision: "approve", decidedBy: "alice" })).toMatchObject({
      ok: true,
      release: { state: "installed" },
    });
  });
});

describe("signing a release", () => {
  test("the statement, signed as a file by the repository's own signing script, is accepted", async () => {
    // A throwaway key, made here. The script reads the private half from the
    // environment, as the release pipeline gives it.
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const keyid = "hxf-prod-test-script";
    const r = (rig = await shelfRig({
      trustedKeys: [{ keyid, publicKey: publicJwk.x ?? "", production: true }],
    }));

    // The four lines, written to a file, and that file signed.
    const checksum = sha256Hex(ARTIFACT);
    const statement = releaseStatement("probe", "1.4.1", checksum);
    expect(new TextDecoder().decode(statement)).toBe(
      `${RELEASE_STATEMENT_CONTEXT}\nprobe\n1.4.1\n${checksum}\n`,
    );
    expect(RELEASE_STATEMENT_CONTEXT).toBe("hx-fortress module release v1");
    const file = path.join(r.paths.root, "probe-1.4.1.statement");
    await writeFile(file, statement);
    const script = path.join(import.meta.dir, "..", "..", "scripts", "sign-artifact.ts");
    const signed = Bun.spawnSync(["bun", "run", script, file], {
      env: {
        PATH: process.env.PATH ?? "",
        FORTRESS_SIGNING_KEY: Buffer.from(JSON.stringify(privateJwk)).toString("base64url"),
        FORTRESS_SIGNING_KEYID: keyid,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect([signed.exitCode, signed.stderr.toString()]).toEqual([0, ""]);
    const signature = await readFile(`${file}.sig`, "utf8");

    expect(await r.offer({ signature })).toBeNull();
    expect(await onlyRelease(r)).toMatchObject({ state: "waiting", signedBy: keyid, version: "1.4.1" });
    // The same sidecar does not carry over to another version of the module.
    expect(await r.offer({ version: "1.4.2", signature })).toMatchObject({
      error: "refused:signature_invalid",
    });
  });
});

describe("an approval checks again what the offer checked", () => {
  test("a release shelved under a key that no longer counts is not installed", async () => {
    const dev = await makeReleaseSigner("hxf-dev-test", false);
    const env: Record<string, string | undefined> = { FORTRESS_ALLOW_DEV_RELEASES: "1" };
    const r = (rig = await shelfRig({ signer: dev, trustedKeys: dev.trusted, env }));
    await r.offer();
    const { id } = await onlyRelease(r);
    // The setting that let a development key count is taken away again.
    delete env.FORTRESS_ALLOW_DEV_RELEASES;
    expect(await r.host.shelf.decide({ id, decision: "approve", decidedBy: "alice" })).toMatchObject({
      ok: false,
      reason: "signer_untrusted",
    });
    expect(r.probe.applied).toEqual([]);
    expect((await onlyRelease(r)).state).toBe("waiting");
    // It can still be refused.
    expect(await r.host.shelf.decide({ id, decision: "refuse", decidedBy: "alice" })).toMatchObject({ ok: true });
  });

  test("a shelf record whose name or version was edited on disk does not verify", async () => {
    const r = (rig = await shelfRig());
    await r.offer();
    const { id } = await onlyRelease(r);
    const file = JSON.parse(await readFile(r.paths.moduleReleases, "utf8")) as {
      releases: { version: string }[];
    };
    file.releases[0]!.version = "9.9.9";
    await writeFile(r.paths.moduleReleases, JSON.stringify(file));
    expect(await r.host.shelf.decide({ id, decision: "approve", decidedBy: "alice" })).toMatchObject({
      ok: false,
      reason: "signer_untrusted",
    });
    expect(r.probe.applied).toEqual([]);
  });
});

describe("a module that is slow to apply a release", () => {
  test("is not handed it a second time, and a late finish is recorded as installed", async () => {
    const r = (rig = await shelfRig({ applyDeadlineMs: 20 }));
    await r.offer();
    const { id } = await onlyRelease(r);
    let finish: () => void = () => {};
    let calls = 0;
    r.probe.applyRelease = () => {
      calls += 1;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    };
    expect(await r.host.shelf.decide({ id, decision: "approve", decidedBy: "alice" })).toMatchObject({
      ok: true,
      release: { state: "failed", error: "timeout" },
    });
    expect(r.reported.at(-1)).toMatchObject({ ok: false, error: "failed:timeout" });
    // The deadline answered; the module is still working. Nothing can be
    // decided about the release until it stops.
    for (const decision of ["approve", "refuse"] as const) {
      expect(await r.host.shelf.decide({ id, decision, decidedBy: "alice" })).toMatchObject({
        ok: false,
        reason: "still_applying",
      });
    }
    expect(calls).toBe(1);
    // The same offer again does not put a second copy on the shelf either.
    expect(await r.offer()).toBeNull();
    expect(r.fetched).toHaveLength(1);

    finish();
    await Bun.sleep(20);
    // It WAS applied, so the shelf says so and the relay is told.
    expect(await onlyRelease(r)).toMatchObject({ id, state: "installed" });
    expect(r.reported.at(-1)).toEqual({ moduleId: "probe", version: "1.4.1", ok: true });
    const installs = (await spoolRecords(r.paths)).filter((record) => record.action === "system.release.install");
    expect(installs.map((record) => [record.kind, record.outcome, record.error])).toEqual([
      ["intent", null, null],
      ["outcome", "failed", "timeout"],
      ["outcome", "installed", "after_deadline"],
    ]);
  });

  test("a late failure leaves the release failed, and it may then be decided again", async () => {
    const r = (rig = await shelfRig({ applyDeadlineMs: 20 }));
    await r.offer();
    const { id } = await onlyRelease(r);
    let fail: (error: Error) => void = () => {};
    r.probe.applyRelease = () =>
      new Promise<void>((_resolve, reject) => {
        fail = reject;
      });
    await r.host.shelf.decide({ id, decision: "approve", decidedBy: "alice" });
    fail(new Error("gave up"));
    await Bun.sleep(20);
    expect(await onlyRelease(r)).toMatchObject({ state: "failed", error: "timeout" });
    expect(await r.host.shelf.decide({ id, decision: "refuse", decidedBy: "alice" })).toMatchObject({ ok: true });
  });
});

describe("a failed release whose file is gone", () => {
  test("comes back when it is offered again, under the same id, and can then be approved", async () => {
    const r = (rig = await shelfRig());
    await r.offer();
    const { id } = await onlyRelease(r);
    await rm(path.join(r.paths.moduleArtifacts("probe"), `${id}.bin`));
    expect(await r.host.shelf.decide({ id, decision: "approve", decidedBy: "alice" })).toMatchObject({
      ok: false,
      reason: "artifact_missing",
    });
    expect(await onlyRelease(r)).toMatchObject({ id, state: "failed", error: "artifact_missing" });

    expect(await r.offer()).toBeNull();
    expect(r.fetched).toHaveLength(2);
    const back = await onlyRelease(r);
    expect(back).toMatchObject({ id, state: "waiting" });
    expect(back.error).toBeUndefined();
    expect(await r.host.shelf.decide({ id, decision: "approve", decidedBy: "alice" })).toMatchObject({
      ok: true,
      release: { state: "installed" },
    });
    expect(r.probe.applied).toHaveLength(1);
  });

  test("a failed release whose file is still there is not fetched again", async () => {
    const r = (rig = await shelfRig());
    await r.offer();
    const { id } = await onlyRelease(r);
    r.probe.applyFailure = new AskFailure("store_unreachable");
    await r.host.shelf.decide({ id, decision: "approve", decidedBy: "alice" });
    expect(await r.offer()).toBeNull();
    expect(r.fetched).toHaveLength(1);
    expect((await onlyRelease(r)).state).toBe("failed");
  });

  test("a release somebody refused stays refused when it is offered again", async () => {
    const r = (rig = await shelfRig());
    await r.offer();
    const { id } = await onlyRelease(r);
    await r.host.shelf.decide({ id, decision: "refuse", decidedBy: "alice" });
    expect(await r.offer()).toBeNull();
    expect(r.fetched).toHaveLength(1);
    expect((await onlyRelease(r)).state).toBe("refused");
  });
});

describe("the relay cannot remove a module", () => {
  test("a remove is refused and recorded", async () => {
    const r = (rig = await shelfRig());
    expect(await r.host.releases.remove("probe")).toEqual({ moduleId: "probe", error: "refused:not_supported" });
    expect(await r.host.releases.remove("payroll")).toBeNull();
    expect(await r.host.releases.remove(7)).toBeNull();
    expect(r.registry.isRunning("probe")).toBe(true);
    await r.host.audit.flush();
    const records = (await spoolRecords(r.paths)).filter((record) => record.action === "relay.module.remove");
    expect(records.map((record) => [record.params, record.outcome])).toEqual([
      [{ module: "probe", rule: "not_supported" }, "refused"],
      [{ module: "unknown", rule: "not_supported" }, "refused"],
      [expect.objectContaining({ module: "unknown", attempts: 1 }), "refused"],
    ]);
  });
});
