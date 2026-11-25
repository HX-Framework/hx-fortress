// What the daemon does about the key of its control plane, driven through the
// real connection against a stand-in control plane on this host.
//
// No key of any control plane is compiled into the program. These are the
// facts a person relies on, each proved with throwaway keys:
//
//   - At its FIRST enrollment (the connection presented a one-time token, and
//     HX Fortress held no key of the organization yet) HX Fortress saves the
//     enrollment, and only then pins the key the control plane publishes,
//     unless its environment names one or a person pinned one ahead. The
//     fingerprint goes to the log and to the audit trail.
//   - Nothing else pins a key of the control plane: not an `enrolled` frame
//     that answers a `hello`, not an enrollment of a host that already holds a
//     key of the organization, not a reconnect. Whoever can send such a frame
//     can also answer the request for the key.
//   - A change of the organization's key is taken only with a proof made with
//     a key this host trusted before the frame that asks for the change.
//   - With no key trusted, a change is refused, and the key pinned before stays.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WsCloudConnection, SUPPORTED_PROTOCOL_VERSION } from "../src/cloud/connection";
import type { CloudCredential } from "../src/cloud/credentials";
import { AUDIT_ACTIONS, sanitizeParams } from "../src/console/audit-actions";
import { FileSigningKeyStore } from "../src/gateway/signing-key-store";
import { createControlPlaneTrust } from "../src/host/control-plane-trust";
import { fortressPaths } from "../src/host/paths";
import {
  CONTROL_PLANE_KEY_ENV,
  ControlPlaneKeyStore,
  keyFingerprint,
  type ControlPlaneKey,
  type ControlPlanePin,
} from "../src/host/trust/control-plane-keys";
import type { FortressConfig, HostLogger } from "../src/host/types";
import type { KeyProof } from "../src/protocol";
import { FakeHub } from "./fake-hub";

const TIMING = { heartbeatMs: 20, reconnectMinMs: 5, reconnectMaxMs: 20 };
const IDENTITY = { version: "0.0.0-test", protocolVersion: SUPPORTED_PROTOCOL_VERSION };
const ORG = "org-northstar";
const FORTRESS_ID = "fortress-northstar-1";
// Put together at run time, so that no text in this file has the shape of a secret.
const CREDENTIAL = ["enrolled", "credential", "1"].join("-");
const TOKEN = ["one", "time", "token"].join("-");
/** The stand-in takes the connection at this path, as a control plane does... */
const CONNECTION_PATH = "/v1/connection";
/** ...and publishes its keys beside it. */
const KEYS_PATH = "/v1/control-plane-keys";
/** How long an absence is waited for: time enough for a request that must not
 *  be made to reach the stand-in, had it been made. */
const SETTLE_MS = 150;
/** When a key that this host held before the test was pinned. */
const HELD_SINCE = "2026-11-01T00:00:00.000Z";
/** The time a proof is made for, a day of November 2026. */
const day = (n: number): string => `2026-11-${String(n).padStart(2, "0")}T00:00:00Z`;

/** A throwaway Ed25519 key: its public half as the wire carries it, and a
 *  signer for the proof that comes with a change of the organization's key. */
async function makeKey(id: string) {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))).toString(
    "base64url",
  );
  return {
    id,
    publicKey,
    /** The key as a control plane publishes it. */
    wire: { id, publicKey } as ControlPlaneKey,
    async prove(orgId: string, organizationKey: string, notBefore: string): Promise<KeyProof> {
      const message = new TextEncoder().encode(`${orgId}|${organizationKey}|${notBefore}`);
      const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, message));
      return { alg: "Ed25519-root", notBefore, sig: Buffer.from(sig).toString("base64url") };
    },
  };
}

async function until(what: string, check: () => Promise<boolean> | boolean, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(5);
  }
  throw new Error(`did not happen within ${ms} ms: ${what}`);
}

async function within<T>(what: string, promise: Promise<T>, ms = 3_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`did not happen within ${ms} ms: ${what}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface FolderOptions {
  /** The organization's key the stand-in sends with its answer to a greeting.
   *  Left out, it sends none. */
  organizationKey?: string;
  /** The proof it sends with that key. */
  organizationProof?: KeyProof;
  /** What the stand-in answers when asked for its keys: a body it sends as
   *  JSON, null for 404, or an answer of its own. */
  published: Record<string, unknown> | null | (() => Response);
  /** The environment HX Fortress runs with. */
  env?: Record<string, string | undefined>;
  /** HX Fortress holds a credential and no token, so it greets with `hello`. */
  enrolled?: boolean;
  /** A key of the organization this HX Fortress pinned before. */
  holdsOrganizationKey?: string;
  /** Keys of the control plane pinned on this host before the connection
   *  opens: at the address that is dialed, or at the earlier path of the
   *  protocol on the same host. */
  pinnedAhead?: { keys: ControlPlaneKey[]; how: ControlPlanePin["how"]; at?: "earlier-path" };
  /** The stand-in holds its answer about its keys until this settles. */
  keyAnswerWaitsFor?: Promise<void>;
}

describe("the control plane's key, through a real connection", () => {
  const roots: string[] = [];
  const hubs: FakeHub[] = [];
  const connections: WsCloudConnection[] = [];
  afterEach(async () => {
    for (const conn of connections.splice(0)) await conn.close().catch(() => {});
    for (const hub of hubs.splice(0)) await hub.stop();
    for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  /** An HX Fortress's folder, a stand-in control plane, and a connection wired
   *  as the daemon wires it, opened. */
  async function fortressFolder(options: FolderOptions) {
    const root = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-trust-"));
    roots.push(root);
    const paths = fortressPaths(root);
    const env = options.env ?? {};
    const asked: string[] = [];
    const hub = await FakeHub.create({
      orgId: ORG,
      fortressId: FORTRESS_ID,
      credential: CREDENTIAL,
      ...(options.organizationKey ? { signingPublicKey: options.organizationKey } : {}),
      http: async (request) => {
        const { pathname } = new URL(request.url);
        asked.push(pathname);
        if (pathname !== KEYS_PATH) return undefined;
        await options.keyAnswerWaitsFor;
        const published = options.published;
        if (published === null) return undefined;
        if (typeof published === "function") return published();
        return new Response(JSON.stringify(published), { headers: { "content-type": "application/json" } });
      },
    });
    hubs.push(hub);
    if (options.organizationKey && options.organizationProof) {
      hub.setSigningKey(options.organizationKey, options.organizationProof);
    }
    const address = `${hub.url}${CONNECTION_PATH}`;
    await writeFile(paths.config, JSON.stringify({ schemaVersion: 1, cloud: { url: address } }));

    const signingKeyStore = new FileSigningKeyStore(paths.signingKey);
    if (options.holdsOrganizationKey) {
      await signingKeyStore.saveRecord({
        key: options.holdsOrganizationKey,
        pinnedAt: HELD_SINCE,
        rootVerified: false,
        notBefore: null,
      });
    }
    const store = new ControlPlaneKeyStore(paths, env);
    const pinnedAhead = options.pinnedAhead
      ? await store.pin(
          options.pinnedAhead.at === "earlier-path" ? `${hub.url}/_api/hx-gateway/vault-tunnel` : address,
          options.pinnedAhead.keys,
          options.pinnedAhead.how,
          new Date(HELD_SINCE),
        )
      : null;

    const logged: Array<{ level: "info" | "warn"; msg: string; fields?: Record<string, unknown> }> = [];
    const audited: Array<{ action: string; params: Record<string, string>; outcome: string }> = [];
    const errors: string[] = [];
    const logger: HostLogger = { error: (message) => void errors.push(message) };
    let stored: CloudCredential | null = options.enrolled
      ? { orgId: ORG, fortressId: FORTRESS_ID, credential: CREDENTIAL }
      : null;
    const trust = createControlPlaneTrust({
      paths,
      env,
      log: {
        info: (msg, fields) => void logged.push({ level: "info", msg, fields }),
        warn: (msg, fields) => void logged.push({ level: "warn", msg, fields }),
      },
      audit: async (action, fields) => void audited.push({ action, ...fields }),
    });
    const firstEnrollment = { called: [] as string[], finished: [] as string[] };
    let authenticated = 0;
    const conn = new WsCloudConnection({
      dispatcher: { dispatch: async () => undefined },
      credentialStore: {
        load: async () => stored,
        save: async (credential) => {
          stored = credential;
        },
      },
      logger,
      identity: IDENTITY,
      signingKeyStore,
      // The trust as the daemon passes it, with a record of when the
      // connection calls it, and of when that call is over.
      controlPlaneKeys: {
        atFirstEnrollment: async (dialed) => {
          firstEnrollment.called.push(dialed);
          await trust.atFirstEnrollment(dialed);
          firstEnrollment.finished.push(dialed);
        },
        verifyProof: (dialed, orgId, key, proof) => trust.verifyProof(dialed, orgId, key, proof),
      },
      onAuthenticated: () => {
        authenticated += 1;
      },
      ...(options.enrolled ? {} : { enrollToken: TOKEN }),
      ...TIMING,
    });
    connections.push(conn);
    const config: FortressConfig = {
      schemaVersion: 1,
      cloud: { url: address },
      gateway: { publicUrl: "http://localhost:8787" },
      modules: { enabled: [] },
    };
    await within("the connection opened", conn.open(config));

    return {
      hub,
      conn,
      paths,
      address,
      store,
      pinnedAhead,
      /** The paths the stand-in was asked for over https, in order. */
      asked,
      logged,
      audited,
      errors,
      firstEnrollment,
      /** The address a person would give for the stand-in: its host, as the
       *  setup turns `http://127.0.0.1:<port>` into this connection's address. */
      controlPlane: hub.url.replace(/^ws:\/\//, "http://"),
      saved: (): CloudCredential | null => stored,
      authenticated: (): number => authenticated,
      /** How HX Fortress greeted the stand-in, at each connection. */
      greetings: (): string[] =>
        hub
          .received()
          .map((frame) => frame.t)
          .filter((t) => t === "enroll" || t === "hello"),
      organizationKey: (): Promise<string | null> => signingKeyStore.pinnedKey(),
      organizationKeyRecord: () => signingKeyStore.loadRecord(),
      /** How many times a change of the organization's key was refused. */
      refusals: (): number => errors.filter((line) => line.includes("presented a different key")).length,
      /** Drop the connection, and wait until HX Fortress connected again and
       *  dealt with the greeting it got back. */
      reconnect: async (): Promise<void> => {
        const before = authenticated;
        hub.dropConnection();
        await until("HX Fortress connected again and was greeted", () => authenticated > before);
      },
      firstEnrollmentOver: (): Promise<void> =>
        until("the first enrollment was dealt with", () => firstEnrollment.finished.length > 0),
    };
  }

  /** What an `enrolled` frame of the stand-in holds, sent on the socket that is open. */
  function enrolledFrame(organizationKey: string, keyProof?: KeyProof) {
    return {
      t: "enrolled" as const,
      orgId: ORG,
      fortressId: FORTRESS_ID,
      credential: CREDENTIAL,
      protocolVersion: SUPPORTED_PROTOCOL_VERSION,
      signingPublicKey: organizationKey,
      ...(keyProof ? { keyProof } : {}),
    };
  }

  test("at a first enrollment the organization's key and the credential are saved, then the published key is pinned for the address that was dialed, and its fingerprint is logged and audited", async () => {
    const startedAt = Date.now();
    const controlPlane = await makeKey("cp-2026-11");
    const organization = await makeKey("org");
    const f = await fortressFolder({
      organizationKey: organization.publicKey,
      published: { v: 1, keys: [controlPlane.wire] },
    });
    await f.firstEnrollmentOver();

    // This connection presented the one-time token.
    expect(f.greetings()).toEqual(["enroll"]);
    expect(f.hub.received().find((frame) => frame.t === "enroll")).toMatchObject({ enrollToken: TOKEN });
    expect(f.saved()).toEqual({ orgId: ORG, fortressId: FORTRESS_ID, credential: CREDENTIAL });
    // The organization's key is taken on first sight. No key of the control
    // plane was trusted when it came, so no proof was checked.
    expect(await f.organizationKeyRecord()).toMatchObject({
      key: organization.publicKey,
      rootVerified: false,
      notBefore: null,
    });

    // Asked once, beside the address that was dialed.
    expect(f.firstEnrollment.called).toEqual([f.address]);
    expect(f.asked).toEqual([KEYS_PATH]);
    const pin = await f.store.readPin();
    expect(pin).toEqual({
      v: 1,
      address: f.address,
      keys: [controlPlane.wire],
      pinnedAt: expect.any(String),
      how: "enrollment",
    });
    expect(Date.parse(pin?.pinnedAt ?? "")).toBeGreaterThanOrEqual(startedAt - 1_000);
    expect(Date.parse(pin?.pinnedAt ?? "")).toBeLessThanOrEqual(Date.now());

    const params = {
      controlPlane: f.controlPlane,
      ids: "cp-2026-11",
      fingerprints: keyFingerprint(controlPlane),
      how: "enrollment",
    };
    expect(f.audited).toEqual([{ action: AUDIT_ACTIONS.controlPlaneKey, params, outcome: "pinned" }]);
    // Each of them reaches the trail: none is dropped on the way in.
    expect(sanitizeParams(AUDIT_ACTIONS.controlPlaneKey, params)).toEqual(params);
    expect(f.logged).toEqual([
      { level: "info", msg: expect.stringContaining("nobody compared its fingerprint"), fields: params },
    ]);
    expect(f.errors).toEqual([]);
    // The pin file holds public keys only.
    const file = await readFile(f.paths.controlPlaneKeys, "utf8");
    expect(file).not.toContain(TOKEN);
    expect(file).not.toContain(CREDENTIAL);
  });

  test("the enrollment is saved, and the connection is connected, before the control plane answers the request for its key", async () => {
    const controlPlane = await makeKey("cp-2026-11");
    const organization = await makeKey("org");
    let answer!: () => void;
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const f = await fortressFolder({
      organizationKey: organization.publicKey,
      published: { v: 1, keys: [controlPlane.wire] },
      keyAnswerWaitsFor: held,
    });
    await until("the control plane was asked for its key", () => f.asked.includes(KEYS_PATH));

    // The answer has not come, and everything the enrollment saves is saved.
    expect(f.conn.state()).toBe("connected");
    expect(f.saved()).toEqual({ orgId: ORG, fortressId: FORTRESS_ID, credential: CREDENTIAL });
    expect(await f.organizationKey()).toBe(organization.publicKey);
    expect(await f.store.readPin()).toBeNull();
    expect(f.firstEnrollment.finished).toEqual([]);
    expect(f.audited).toEqual([]);

    answer();
    await f.firstEnrollmentOver();
    expect((await f.store.readPin())?.keys).toEqual([controlPlane.wire]);
    expect(f.audited).toEqual([expect.objectContaining({ outcome: "pinned" })]);
  });

  test("an enrolled frame on a connection that greeted with hello pins no key of the control plane, even when the control plane publishes one", async () => {
    const controlPlane = await makeKey("cp-2026-11");
    const organization = await makeKey("org");
    // The stand-in sends no key of the organization with its welcome, so the
    // key in the frame below is the first one this HX Fortress sees.
    const f = await fortressFolder({ enrolled: true, published: { v: 1, keys: [controlPlane.wire] } });
    expect(f.greetings()).toEqual(["hello"]);

    f.hub.send(enrolledFrame(organization.publicKey));
    await until("the enrolled frame was dealt with", () => f.authenticated() === 2);
    // The organization's key is taken on first sight, as at any greeting...
    expect(await f.organizationKeyRecord()).toMatchObject({ key: organization.publicKey, rootVerified: false });
    // ...and nothing is asked of the control plane, and nothing is pinned.
    await Bun.sleep(SETTLE_MS);
    expect(f.firstEnrollment.called).toEqual([]);
    expect(f.asked).toEqual([]);
    expect(await f.store.readPin()).toBeNull();
    expect(f.audited).toEqual([]);
  });

  test("an enrolled frame on a connection that greeted with hello cannot change the organization's key with a proof made by the key the control plane publishes", async () => {
    const controlPlane = await makeKey("cp-2026-11");
    const first = await makeKey("org-1");
    const second = await makeKey("org-2");
    const f = await fortressFolder({
      enrolled: true,
      holdsOrganizationKey: first.publicKey,
      organizationKey: first.publicKey,
      published: { v: 1, keys: [controlPlane.wire] },
    });
    expect(f.greetings()).toEqual(["hello"]);

    f.hub.send(enrolledFrame(second.publicKey, await controlPlane.prove(ORG, second.publicKey, day(13))));
    await until("the change was refused", () => f.refusals() === 1);
    expect(await f.organizationKey()).toBe(first.publicKey);
    expect(f.errors.join("\n")).toContain("hx-fortress control-plane");

    await Bun.sleep(SETTLE_MS);
    expect(f.firstEnrollment.called).toEqual([]);
    expect(f.asked).toEqual([]);
    expect(await f.store.readPin()).toBeNull();
    expect(f.audited).toEqual([]);
  });

  test("an enrollment with a token by an HX Fortress that already holds a key of the organization pins no key of the control plane, and the same key changes nothing", async () => {
    const controlPlane = await makeKey("cp-2026-11");
    const organization = await makeKey("org");
    const f = await fortressFolder({
      holdsOrganizationKey: organization.publicKey,
      organizationKey: organization.publicKey,
      published: { v: 1, keys: [controlPlane.wire] },
    });
    expect(f.greetings()).toEqual(["enroll"]);
    expect(f.saved()).toEqual({ orgId: ORG, fortressId: FORTRESS_ID, credential: CREDENTIAL });
    expect(await f.organizationKeyRecord()).toEqual({
      key: organization.publicKey,
      pinnedAt: HELD_SINCE,
      rootVerified: false,
      notBefore: null,
    });

    await Bun.sleep(SETTLE_MS);
    expect(f.firstEnrollment.called).toEqual([]);
    expect(f.asked).toEqual([]);
    expect(await f.store.readPin()).toBeNull();
    expect(f.audited).toEqual([]);
    expect(f.errors).toEqual([]);
  });

  test("an enrollment with a token by an HX Fortress that already holds a key of the organization cannot change that key with a proof made by the key the control plane publishes", async () => {
    const controlPlane = await makeKey("cp-2026-11");
    const first = await makeKey("org-1");
    const second = await makeKey("org-2");
    const f = await fortressFolder({
      holdsOrganizationKey: first.publicKey,
      organizationKey: second.publicKey,
      organizationProof: await controlPlane.prove(ORG, second.publicKey, day(13)),
      published: { v: 1, keys: [controlPlane.wire] },
    });
    // The enrollment itself went through.
    expect(f.greetings()).toEqual(["enroll"]);
    expect(f.conn.state()).toBe("connected");
    expect(f.saved()).toEqual({ orgId: ORG, fortressId: FORTRESS_ID, credential: CREDENTIAL });
    // The change of the organization's key did not: this host never trusted
    // the key the proof was made with.
    expect(f.refusals()).toBe(1);
    expect(await f.organizationKey()).toBe(first.publicKey);

    await Bun.sleep(SETTLE_MS);
    expect(f.firstEnrollment.called).toEqual([]);
    expect(f.asked).toEqual([]);
    expect(await f.store.readPin()).toBeNull();
    expect(f.audited).toEqual([]);
  });

  test("after the first enrollment, a control plane that publishes another key cannot have it trusted by enrolling HX Fortress again", async () => {
    const pinnedAtFirst = await makeKey("cp-2026-11");
    const publishedNow = await makeKey("cp-2026-12");
    const first = await makeKey("org-1");
    const second = await makeKey("org-2");
    const third = await makeKey("org-3");
    // The state after a first enrollment: a key of the organization, and the
    // control plane's key pinned then. A person runs the enrollment again.
    const f = await fortressFolder({
      holdsOrganizationKey: first.publicKey,
      pinnedAhead: { keys: [pinnedAtFirst.wire], how: "enrollment" },
      organizationKey: second.publicKey,
      organizationProof: await publishedNow.prove(ORG, second.publicKey, day(13)),
      published: { v: 1, keys: [publishedNow.wire] },
    });
    expect(f.greetings()).toEqual(["enroll"]);
    expect(f.refusals()).toBe(1);
    expect(await f.organizationKey()).toBe(first.publicKey);
    await Bun.sleep(SETTLE_MS);
    expect(f.firstEnrollment.called).toEqual([]);
    expect(f.asked).toEqual([]);
    expect(await f.store.readPin()).toEqual(f.pinnedAhead);

    // The key pinned at the first enrollment is still the one in force.
    f.hub.setSigningKey(third.publicKey, await pinnedAtFirst.prove(ORG, third.publicKey, day(14)));
    await f.reconnect();
    expect(await f.organizationKey()).toBe(third.publicKey);
    expect(f.asked).toEqual([]);
  });

  test("an enrollment that carries no key of the organization pins no key of the control plane, and neither does the greeting that brings that key later", async () => {
    const controlPlane = await makeKey("cp-2026-11");
    const organization = await makeKey("org");
    const f = await fortressFolder({ published: { v: 1, keys: [controlPlane.wire] } });
    expect(f.greetings()).toEqual(["enroll"]);
    expect(f.saved()).toEqual({ orgId: ORG, fortressId: FORTRESS_ID, credential: CREDENTIAL });
    await Bun.sleep(SETTLE_MS);
    expect(f.firstEnrollment.called).toEqual([]);
    expect(f.asked).toEqual([]);

    f.hub.setSigningKey(organization.publicKey);
    await f.reconnect();
    expect(f.greetings()).toEqual(["enroll", "hello"]);
    expect(await f.organizationKey()).toBe(organization.publicKey);
    await Bun.sleep(SETTLE_MS);
    expect(f.firstEnrollment.called).toEqual([]);
    expect(f.asked).toEqual([]);
    expect(await f.store.readPin()).toBeNull();
    expect(f.audited).toEqual([]);
  });

  test("a key named in the environment HX Fortress runs with is the key: nothing is asked at the first enrollment, and only a change it proves is taken", async () => {
    const named = await makeKey("named-here");
    const published = await makeKey("published");
    const first = await makeKey("org-1");
    const second = await makeKey("org-2");
    const third = await makeKey("org-3");
    const f = await fortressFolder({
      organizationKey: first.publicKey,
      organizationProof: await named.prove(ORG, first.publicKey, day(12)),
      published: { v: 1, keys: [published.wire] },
      env: { [CONTROL_PLANE_KEY_ENV]: `${named.id}:${named.publicKey}` },
    });
    await f.firstEnrollmentOver();
    // A first enrollment, and this host had already decided.
    expect(f.firstEnrollment.called).toEqual([f.address]);
    expect(f.asked).toEqual([]);
    expect(await f.store.readPin()).toBeNull();
    expect(f.audited).toEqual([]);
    expect(f.logged).toEqual([]);
    // The organization's key of the first greeting was checked against the named key.
    expect(await f.organizationKeyRecord()).toMatchObject({
      key: first.publicKey,
      rootVerified: true,
      notBefore: day(12),
    });

    // A proof made with the published key is not one made with the named key.
    f.hub.setSigningKey(second.publicKey, await published.prove(ORG, second.publicKey, day(13)));
    await f.reconnect();
    expect(f.refusals()).toBe(1);
    expect(await f.organizationKey()).toBe(first.publicKey);

    f.hub.setSigningKey(third.publicKey, await named.prove(ORG, third.publicKey, day(13)));
    await f.reconnect();
    expect(await f.organizationKey()).toBe(third.publicKey);
    expect(f.asked).toEqual([]);
  });

  test("a key a person pinned for this control plane before the first enrollment stays as it is: nothing is asked, and only a change it proves is taken", async () => {
    const byAPerson = await makeKey("cp-by-a-person");
    const published = await makeKey("published");
    const first = await makeKey("org-1");
    const second = await makeKey("org-2");
    const third = await makeKey("org-3");
    const f = await fortressFolder({
      pinnedAhead: { keys: [byAPerson.wire], how: "person" },
      organizationKey: first.publicKey,
      organizationProof: await byAPerson.prove(ORG, first.publicKey, day(12)),
      published: { v: 1, keys: [published.wire] },
    });
    await f.firstEnrollmentOver();
    expect(f.firstEnrollment.called).toEqual([f.address]);
    expect(f.asked).toEqual([]);
    expect(await f.store.readPin()).toEqual(f.pinnedAhead);
    expect(f.audited).toEqual([]);
    expect(await f.organizationKeyRecord()).toMatchObject({ key: first.publicKey, rootVerified: true });

    f.hub.setSigningKey(second.publicKey, await published.prove(ORG, second.publicKey, day(13)));
    await f.reconnect();
    expect(f.refusals()).toBe(1);
    expect(await f.organizationKey()).toBe(first.publicKey);

    f.hub.setSigningKey(third.publicKey, await byAPerson.prove(ORG, third.publicKey, day(13)));
    await f.reconnect();
    expect(await f.organizationKey()).toBe(third.publicKey);
    expect(f.asked).toEqual([]);
  });

  test("a key pinned for the same control plane at the earlier path of the protocol counts as this control plane's", async () => {
    const byAPerson = await makeKey("cp-by-a-person");
    const published = await makeKey("published");
    const first = await makeKey("org-1");
    const second = await makeKey("org-2");
    const f = await fortressFolder({
      pinnedAhead: { keys: [byAPerson.wire], how: "person", at: "earlier-path" },
      organizationKey: first.publicKey,
      published: { v: 1, keys: [published.wire] },
    });
    await f.firstEnrollmentOver();
    expect(f.asked).toEqual([]);
    expect(await f.store.readPin()).toEqual(f.pinnedAhead);

    f.hub.setSigningKey(second.publicKey, await byAPerson.prove(ORG, second.publicKey, day(13)));
    await f.reconnect();
    expect(await f.organizationKey()).toBe(second.publicKey);
  });

  test("a change of the organization's key is taken with a proof made with the key pinned at the first enrollment, and refused with any other", async () => {
    const controlPlane = await makeKey("cp-2026-11");
    const impostor = await makeKey("cp-2026-11");
    const first = await makeKey("org-1");
    const second = await makeKey("org-2");
    const third = await makeKey("org-3");
    const f = await fortressFolder({
      organizationKey: first.publicKey,
      published: { v: 1, keys: [controlPlane.wire] },
    });
    await f.firstEnrollmentOver();
    expect(await f.organizationKey()).toBe(first.publicKey);

    // The control plane moves the organization to a second key, and proves it.
    f.hub.setSigningKey(second.publicKey, await controlPlane.prove(ORG, second.publicKey, day(13)));
    await f.reconnect();
    expect(await f.organizationKey()).toBe(second.publicKey);
    expect(f.errors).toEqual([]);

    // A third key, with a proof from a key that only has the same id.
    f.hub.setSigningKey(third.publicKey, await impostor.prove(ORG, third.publicKey, day(14)));
    await f.reconnect();
    expect(f.refusals()).toBe(1);
    expect(await f.organizationKey()).toBe(second.publicKey);
    expect(f.errors.join("\n")).toContain("hx-fortress control-plane");

    // And a proof that is older than the one already taken: an old proof must
    // not bring an old key back.
    f.hub.setSigningKey(first.publicKey, await controlPlane.prove(ORG, first.publicKey, day(12)));
    await f.reconnect();
    expect(f.refusals()).toBe(2);
    expect(await f.organizationKey()).toBe(second.publicKey);

    // The key was asked for once, at the first enrollment. A reconnect asks for nothing.
    expect(f.greetings()).toEqual(["enroll", "hello", "hello", "hello"]);
    expect(f.firstEnrollment.called).toEqual([f.address]);
    expect(f.asked).toEqual([KEYS_PATH]);
  });

  test("a proof that came with the first enrollment is checked once the published key is pinned, and an older proof shown later brings no older key back", async () => {
    // At the first enrollment the organization's key is pinned before any key
    // of the control plane is held, so its proof cannot be checked then. Once
    // the published key is pinned the proof is checked, and its time becomes
    // the time a later change has to be newer than.
    const controlPlane = await makeKey("cp-2026-11");
    const earlier = await makeKey("org-0");
    const first = await makeKey("org-1");
    const f = await fortressFolder({
      organizationKey: first.publicKey,
      organizationProof: await controlPlane.prove(ORG, first.publicKey, day(12)),
      published: { v: 1, keys: [controlPlane.wire] },
    });
    await f.firstEnrollmentOver();
    await until("the proof of the first key to be recorded", async () => (await f.organizationKeyRecord())?.rootVerified === true);
    expect(await f.organizationKeyRecord()).toMatchObject({
      key: first.publicKey,
      rootVerified: true,
      notBefore: day(12),
    });

    // A genuine proof from before that time, for a key the organization held
    // earlier. Whoever kept it shows it again.
    f.hub.setSigningKey(earlier.publicKey, await controlPlane.prove(ORG, earlier.publicKey, day(11)));
    await f.reconnect();
    expect(f.refusals()).toBe(1);
    expect(await f.organizationKey()).toBe(first.publicKey);
  });

  test("a proof in the first enrollment that the published key did not make leaves the organization's key as taken on first sight", async () => {
    const controlPlane = await makeKey("cp-2026-11");
    const impostor = await makeKey("cp-2026-11");
    const first = await makeKey("org-1");
    const f = await fortressFolder({
      organizationKey: first.publicKey,
      organizationProof: await impostor.prove(ORG, first.publicKey, day(12)),
      published: { v: 1, keys: [controlPlane.wire] },
    });
    await f.firstEnrollmentOver();
    // The published key is pinned, and the record of the organization's key
    // says what is true: no proof of it was checked.
    await until("the published key to be pinned", async () => (await f.store.pinFor(f.address)) !== null);
    expect(await f.organizationKeyRecord()).toMatchObject({ key: first.publicKey, rootVerified: false, notBefore: null });
  });

  test("an HX Fortress that enrolled earlier pins nothing on its own, keeps its organization key, and refuses a change until a person pins the key", async () => {
    // The state of an HX Fortress after an update from a build that carried a
    // control plane's key: a credential, a pinned organization key, no pin.
    const controlPlane = await makeKey("cp-2026-11");
    const first = await makeKey("org-1");
    const second = await makeKey("org-2");
    const f = await fortressFolder({
      enrolled: true,
      holdsOrganizationKey: first.publicKey,
      organizationKey: first.publicKey,
      published: { v: 1, keys: [controlPlane.wire] },
    });
    expect(f.greetings()).toEqual(["hello"]);
    expect(await f.organizationKey()).toBe(first.publicKey);

    // A change with a proof that is valid is still refused: nothing here says
    // which key the proof should be checked against.
    f.hub.setSigningKey(second.publicKey, await controlPlane.prove(ORG, second.publicKey, day(13)));
    await f.reconnect();
    expect(f.refusals()).toBe(1);
    expect(await f.organizationKey()).toBe(first.publicKey);
    await Bun.sleep(SETTLE_MS);
    expect(f.firstEnrollment.called).toEqual([]);
    expect(f.asked).toEqual([]);
    expect(await f.store.readPin()).toBeNull();
    expect(f.audited).toEqual([]);

    // A person pins the key on this host. The change is taken at the next connection.
    await f.store.pin(f.address, [controlPlane.wire], "person");
    await f.reconnect();
    expect(await f.organizationKey()).toBe(second.publicKey);
  });

  test("a control plane that publishes no key, or answers with a redirect: the first enrollment goes on, nothing is pinned, and the trail says why", async () => {
    const answers: [FolderOptions["published"], string][] = [
      [null, "the control plane publishes no key"],
      [
        // Were the redirect followed, the stand-in would be asked at this path too.
        () => new Response(null, { status: 302, headers: { location: "/v1/elsewhere" } }),
        "the control plane answered with a redirect when asked for its key, and a redirect is not followed",
      ],
    ];
    for (const [published, reason] of answers) {
      const organization = await makeKey("org");
      const f = await fortressFolder({ organizationKey: organization.publicKey, published });
      await f.firstEnrollmentOver();
      expect(f.conn.state()).toBe("connected");
      expect(f.saved()).toEqual({ orgId: ORG, fortressId: FORTRESS_ID, credential: CREDENTIAL });
      expect(await f.organizationKey()).toBe(organization.publicKey);
      expect(f.asked).toEqual([KEYS_PATH]);
      expect(await f.store.readPin()).toBeNull();
      expect(f.audited).toEqual([
        { action: AUDIT_ACTIONS.controlPlaneKey, params: { reason }, outcome: "not_pinned" },
      ]);
      expect(sanitizeParams(AUDIT_ACTIONS.controlPlaneKey, { reason })).toEqual({ reason });
      expect(f.logged).toEqual([{ level: "warn", msg: expect.stringContaining("hx-fortress control-plane pin"), fields: { reason } }]);
    }
  });

  test("a value of the variable that is not a key yields no key at all: nothing is asked or pinned at the first enrollment, and a proof is refused, not checked against a guess", async () => {
    const controlPlane = await makeKey("cp-2026-11");
    const first = await makeKey("org-1");
    const second = await makeKey("org-2");
    const f = await fortressFolder({
      organizationKey: first.publicKey,
      published: { v: 1, keys: [controlPlane.wire] },
      env: { [CONTROL_PLANE_KEY_ENV]: "not-a-key" },
    });
    await f.firstEnrollmentOver();
    // The enrollment went on, and nothing was pinned over the wrong setting.
    expect(f.conn.state()).toBe("connected");
    expect(f.asked).toEqual([]);
    expect(await f.store.readPin()).toBeNull();
    expect(f.audited).toEqual([
      {
        action: AUDIT_ACTIONS.controlPlaneKey,
        params: { reason: "FORTRESS_CONTROL_PLANE_KEY must be written as <id>:<publicKey>" },
        outcome: "not_pinned",
      },
    ]);

    f.hub.setSigningKey(second.publicKey, await controlPlane.prove(ORG, second.publicKey, day(13)));
    await f.reconnect();
    expect(f.refusals()).toBe(1);
    expect(await f.organizationKey()).toBe(first.publicKey);
  });
});
