import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportJWK, generateKeyPair } from "jose";

import {
  FileSigningKeyStore,
  persistSigningKeyPin,
  resolveSigningKeyPin,
  type PinnedSigningKey,
} from "../../src/gateway/signing-key-store";
import { verifyKeyProof, type TrustedSigningKey } from "../../src/host/trust/signing-keys";
import type { KeyProof } from "../../src/protocol";

// A fixture let.ai ROOT keypair — stands in for the baked LETAI_ROOT_KEYS so the
// proof paths can be exercised without the production private key.
async function makeRootKeypair(): Promise<{
  anchor: TrustedSigningKey;
  sign: (orgId: string, key: string, notBefore: string) => Promise<KeyProof>;
}> {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  const publicKeyB64url = (await exportJWK(publicKey)).x as string;
  return {
    anchor: { keyid: "letai-root-test", publicKey: publicKeyB64url, production: false },
    async sign(orgId, key, notBefore) {
      const msg = new TextEncoder().encode(`${orgId}|${key}|${notBefore}`);
      const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, msg));
      return { alg: "Ed25519-root", notBefore, sig: Buffer.from(sig).toString("base64url") };
    },
  };
}

function memStore(initial: PinnedSigningKey | null = null) {
  let record = initial;
  return {
    async loadRecord() {
      return record;
    },
    async saveRecord(r: PinnedSigningKey) {
      record = r;
    },
    get record() {
      return record;
    },
  };
}

describe("FileSigningKeyStore", () => {
  it("round-trips a JSON record and returns null when absent", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sk-"));
    const store = new FileSigningKeyStore(path.join(dir, "signing-key"));
    expect(await store.loadRecord()).toBeNull();
    expect(await store.load()).toBeNull();
    await store.saveRecord({
      key: "BASE64URLKEY",
      pinnedAt: "2026-07-06T00:00:00.000Z",
      rootVerified: true,
      notBefore: "2026-07-06T00:00:00Z",
    });
    expect(await store.load()).toBe("BASE64URLKEY");
    expect(await store.pinnedKey()).toBe("BASE64URLKEY");
    expect(await store.loadRecord()).toEqual({
      key: "BASE64URLKEY",
      pinnedAt: "2026-07-06T00:00:00.000Z",
      rootVerified: true,
      notBefore: "2026-07-06T00:00:00Z",
    });
  });

  it("loads a legacy bare-string key as an unverified pin", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sk-legacy-"));
    const keyPath = path.join(dir, "signing-key");
    writeFileSync(keyPath, "LEGACYBAREKEY\n");
    const store = new FileSigningKeyStore(keyPath);
    expect(await store.load()).toBe("LEGACYBAREKEY");
    expect(await store.loadRecord()).toEqual({
      key: "LEGACYBAREKEY",
      pinnedAt: null,
      rootVerified: false,
      notBefore: null,
    });
  });
});

describe("resolveSigningKeyPin", () => {
  it("pins when there is no existing pin (rootVerified tracks the proof)", () => {
    expect(resolveSigningKeyPin(null, "k1", false)).toEqual({ action: "pin", rootVerified: false });
    expect(resolveSigningKeyPin(null, "k1", true)).toEqual({ action: "pin", rootVerified: true });
  });

  it("is a no-op when the incoming key equals the pin", () => {
    const cur: PinnedSigningKey = { key: "k1", pinnedAt: null, rootVerified: false, notBefore: null };
    expect(resolveSigningKeyPin(cur, "k1", false)).toEqual({ action: "noop" });
  });

  it("rejects a changed key with no valid proof, replaces one with a valid proof", () => {
    const cur: PinnedSigningKey = { key: "k1", pinnedAt: null, rootVerified: true, notBefore: null };
    expect(resolveSigningKeyPin(cur, "k2", false)).toEqual({ action: "reject" });
    expect(resolveSigningKeyPin(cur, "k2", true)).toEqual({ action: "replace" });
  });
});

describe("verifyKeyProof", () => {
  it("accepts a proof signed by the root over `${orgId}|${key}|${notBefore}`", async () => {
    const root = await makeRootKeypair();
    const proof = await root.sign("org_1", "signkey_1", "2026-07-06T00:00:00Z");
    expect(await verifyKeyProof("org_1", "signkey_1", proof, [root.anchor])).toBe(true);
  });

  it("rejects a proof when any bound field is tampered", async () => {
    const root = await makeRootKeypair();
    const proof = await root.sign("org_1", "signkey_1", "2026-07-06T00:00:00Z");
    expect(await verifyKeyProof("org_OTHER", "signkey_1", proof, [root.anchor])).toBe(false);
    expect(await verifyKeyProof("org_1", "signkey_OTHER", proof, [root.anchor])).toBe(false);
    expect(
      await verifyKeyProof("org_1", "signkey_1", { ...proof, notBefore: "2026-01-01T00:00:00Z" }, [
        root.anchor,
      ]),
    ).toBe(false);
  });

  it("rejects a proof signed by a non-root key and a bad alg", async () => {
    const root = await makeRootKeypair();
    const impostor = await makeRootKeypair();
    const proof = await impostor.sign("org_1", "signkey_1", "2026-07-06T00:00:00Z");
    expect(await verifyKeyProof("org_1", "signkey_1", proof, [root.anchor])).toBe(false);
    const good = await root.sign("org_1", "signkey_1", "2026-07-06T00:00:00Z");
    expect(
      await verifyKeyProof("org_1", "signkey_1", { ...good, alg: "HS256" } as unknown as KeyProof, [
        root.anchor,
      ]),
    ).toBe(false);
  });
});

describe("persistSigningKeyPin (H-2)", () => {
  const useFixtureRoot = (anchor: TrustedSigningKey) => (o: string, k: string, p: KeyProof) =>
    verifyKeyProof(o, k, p, [anchor]);

  it("pins the first key seen", async () => {
    const store = memStore();
    const action = await persistSigningKeyPin({
      store,
      orgId: "org_1",
      incomingKey: "k1",
      now: () => new Date("2026-07-06T00:00:00Z"),
    });
    expect(action).toBe("pin");
    expect(store.record).toEqual({
      key: "k1",
      pinnedAt: "2026-07-06T00:00:00.000Z",
      rootVerified: false,
      notBefore: null,
    });
  });

  it("is a no-op when the SAME key is re-pushed", async () => {
    const store = memStore({ key: "k1", pinnedAt: "2026-07-06T00:00:00.000Z", rootVerified: false, notBefore: null });
    const action = await persistSigningKeyPin({ store, orgId: "org_1", incomingKey: "k1" });
    expect(action).toBe("noop");
    expect(store.record?.key).toBe("k1");
  });

  it("REJECTS a changed key with no proof — pin unchanged, rotation logged", async () => {
    const store = memStore({ key: "k1", pinnedAt: "2026-07-06T00:00:00.000Z", rootVerified: true, notBefore: null });
    const logged: string[] = [];
    const action = await persistSigningKeyPin({
      store,
      orgId: "org_1",
      incomingKey: "k2-attacker",
      log: (msg) => logged.push(msg),
    });
    expect(action).toBe("reject");
    expect(store.record?.key).toBe("k1"); // pin untouched
    expect(logged).toContain("signing_key_rotation_rejected");
  });

  it("REPLACES a changed key that carries a valid root proof (newer notBefore)", async () => {
    const root = await makeRootKeypair();
    const store = memStore({
      key: "k1",
      pinnedAt: "2026-07-06T00:00:00.000Z",
      rootVerified: true,
      notBefore: "2026-07-06T00:00:00Z",
    });
    const proof = await root.sign("org_1", "k2-authorized", "2026-07-07T00:00:00Z");
    const action = await persistSigningKeyPin({
      store,
      orgId: "org_1",
      incomingKey: "k2-authorized",
      keyProof: proof,
      verifyProof: useFixtureRoot(root.anchor),
      now: () => new Date("2026-07-07T00:00:00Z"),
    });
    expect(action).toBe("replace");
    expect(store.record).toEqual({
      key: "k2-authorized",
      pinnedAt: "2026-07-07T00:00:00.000Z",
      rootVerified: true,
      notBefore: "2026-07-07T00:00:00Z",
    });
  });

  it("REJECTS a changed key whose proof is for a DIFFERENT key (no downgrade)", async () => {
    const root = await makeRootKeypair();
    const store = memStore({ key: "k1", pinnedAt: null, rootVerified: true, notBefore: null });
    // Proof authorizes k2, but the pushed key is k3 → verify fails → reject.
    const proof = await root.sign("org_1", "k2", "2026-07-07T00:00:00Z");
    const action = await persistSigningKeyPin({
      store,
      orgId: "org_1",
      incomingKey: "k3",
      keyProof: proof,
      verifyProof: useFixtureRoot(root.anchor),
    });
    expect(action).toBe("reject");
    expect(store.record?.key).toBe("k1");
  });

  // H-2b · monotonic notBefore — a replayed OLDER root proof must not roll the pin
  // back to a prior key, even though its signature is valid.
  it("REJECTS a replayed proof whose notBefore is OLDER than the pinned floor (no rollback)", async () => {
    const root = await makeRootKeypair();
    // Pinned to k2 with an accepted proof floor at 2026-07-07.
    const store = memStore({
      key: "k2",
      pinnedAt: "2026-07-07T00:00:00.000Z",
      rootVerified: true,
      notBefore: "2026-07-07T00:00:00Z",
    });
    const logged: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    // A validly-signed but STALE proof (notBefore 2026-07-01 < floor) authorizing
    // a prior key k1 — the rollback attempt a compromised hub / MITM would replay.
    const stale = await root.sign("org_1", "k1", "2026-07-01T00:00:00Z");
    const action = await persistSigningKeyPin({
      store,
      orgId: "org_1",
      incomingKey: "k1",
      keyProof: stale,
      verifyProof: useFixtureRoot(root.anchor),
      log: (msg, fields) => logged.push({ msg, fields }),
    });
    expect(action).toBe("reject");
    expect(store.record?.key).toBe("k2"); // pin untouched — no rollback
    expect(logged.some((l) => l.msg === "signing_key_rotation_rejected")).toBe(true);
  });

  it("REJECTS a proof whose notBefore EQUALS the pinned floor (strict monotonicity)", async () => {
    const root = await makeRootKeypair();
    const store = memStore({
      key: "k2",
      pinnedAt: "2026-07-07T00:00:00.000Z",
      rootVerified: true,
      notBefore: "2026-07-07T00:00:00Z",
    });
    const same = await root.sign("org_1", "k9", "2026-07-07T00:00:00Z");
    const action = await persistSigningKeyPin({
      store,
      orgId: "org_1",
      incomingKey: "k9",
      keyProof: same,
      verifyProof: useFixtureRoot(root.anchor),
    });
    expect(action).toBe("reject");
    expect(store.record?.key).toBe("k2");
  });

  it("ACCEPTS a genuine forward rotation (newer notBefore) and advances the floor", async () => {
    const root = await makeRootKeypair();
    const store = memStore({
      key: "k2",
      pinnedAt: "2026-07-07T00:00:00.000Z",
      rootVerified: true,
      notBefore: "2026-07-07T00:00:00Z",
    });
    const forward = await root.sign("org_1", "k3", "2026-07-09T00:00:00Z");
    const action = await persistSigningKeyPin({
      store,
      orgId: "org_1",
      incomingKey: "k3",
      keyProof: forward,
      verifyProof: useFixtureRoot(root.anchor),
      now: () => new Date("2026-07-09T00:00:00Z"),
    });
    expect(action).toBe("replace");
    expect(store.record).toEqual({
      key: "k3",
      pinnedAt: "2026-07-09T00:00:00.000Z",
      rootVerified: true,
      notBefore: "2026-07-09T00:00:00Z",
    });
  });
});
