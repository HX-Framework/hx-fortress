// Modules, asks and releases, end to end.
//
// What is real here: the tunnel (a loopback WebSocket), the cloud connection,
// the host runtime and its status file, the module registry, the module host
// with its ask gate and release shelf, the organization key pinned from the
// hub's own `welcome`, the grant verifier the daemon uses, the fetch of the
// release from the relay's own origin, the audit spool on disk, and the
// terminal — `runCli`, signalling this process exactly as it signals a daemon.
//
// What is a stand-in: the hub (the same fake the connection tests use, which
// also serves the release from its own origin), the Postgres provider (nothing
// here needs a database), the audit table (empty: the whole trail is still on
// disk), and the Sessions module.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { runCli } from "../src/cli";
import { SUPPORTED_PROTOCOL_VERSION, WsCloudConnection } from "../src/cloud/connection";
import type { CloudCredential } from "../src/cloud/credentials";
import { FileSigningKeyStore } from "../src/gateway/signing-key-store";
import { FileConfigStore } from "../src/host/config";
import { MODULE_CATALOG } from "../src/host/module-catalog";
import { createModuleGrantVerifier, ModuleHost } from "../src/host/module-host";
import { ModuleRegistry } from "../src/host/module-registry";
import { listModules, listReleases } from "../src/host/modules-api";
import type { HxDb } from "../src/host/postgres/db";
import { HostRuntime } from "../src/host/runtime";
import { FileStatusStore } from "../src/host/status";
import type { PostgresProvider } from "../src/host/types";
import { AuditTrail } from "../src/modules/host/audit-trail";
import { createHostModule } from "../src/modules/host/module";
import type { FortressToHubFrame, HubToFortressFrame, MsgReply } from "../src/protocol";
import { FakeHub } from "./fake-hub";
import {
  captureBus,
  createProbeModule,
  fixedSecrets,
  legacyModule,
  makeOrgKey,
  makeReleaseSigner,
  ORG,
  PROBE_MANIFEST,
  sha256Hex,
  spoolRecords,
  spoolText,
  tempRoot,
  type OrgKey,
  type Paths,
  type ProbeModule,
  type ReleaseSigner,
} from "./host/_module-rig";

const ARTIFACT = new TextEncoder().encode("probe release 1.4.1");
/** Where the hub serves a module's release, on its own origin. */
const ARTIFACT_PATH = "/_api/hx-gateway/download/modules/probe.bin";
const CATALOG = [
  ...MODULE_CATALOG,
  {
    id: "probe",
    title: "Probe",
    summary: "a module for tests",
    manifest: PROBE_MANIFEST,
    startOnly: false,
  },
];

interface Stack {
  paths: Paths;
  hub: FakeHub;
  conn: WsCloudConnection;
  runtime: HostRuntime;
  registry: ModuleRegistry;
  host: ModuleHost;
  probe: ProbeModule;
  sessions: ReturnType<typeof legacyModule>;
  key: OrgKey;
  signer: ReleaseSigner;
  /** The artifact's URL on the hub's own origin. */
  artifactUrl: string;
  /** The paths the hub was asked for over plain HTTP. */
  fetched: string[];
  logs: ReturnType<typeof captureBus>["records"];
  cleanup: () => Promise<void>;
}

let stack: Stack;
const onSignal = (): void => void stack?.host.applyRequests();

async function waitFor<T>(
  read: () => T | undefined | false | null | Promise<T | undefined | false | null>,
  what: string,
  timeoutMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** Frames of one kind the hub has received, in order. */
function received<T extends FortressToHubFrame["t"]>(t: T): Extract<FortressToHubFrame, { t: T }>[] {
  return stack.hub.received().filter((frame): frame is Extract<FortressToHubFrame, { t: T }> => frame.t === t);
}

/** Send one ask down the tunnel as the relay does, and wait for its reply. */
async function relayAsks(
  module: string,
  ask: string,
  args: Record<string, unknown> = {},
  grant?: string | null,
): Promise<MsgReply> {
  const id = `ask-${randomUUID()}`;
  const token = grant === undefined ? await stack.key.grant(module, ask, args) : grant;
  stack.hub.send({
    t: "moduleMessage",
    data: {
      module,
      id,
      kind: "request",
      payload: { v: 1, ask, args, ...(token === null ? {} : { grant: token }) },
    },
  });
  const frame = await waitFor(() => received("moduleReply").find((reply) => reply.id === id), `the reply to ${ask}`);
  return frame.reply;
}

async function relayOffers(overrides: Partial<Extract<HubToFortressFrame, { t: "moduleAdvertise" }>> = {}) {
  const frame = {
    moduleId: "probe",
    version: "1.4.1",
    artifactUrl: stack.artifactUrl,
    checksum: sha256Hex(ARTIFACT),
    ...overrides,
  };
  stack.hub.send({
    t: "moduleAdvertise",
    ...frame,
    // What a release's publisher signs: the module, the version and the file's
    // sha256. Not the file, and not anything the relay adds.
    signature:
      "signature" in overrides
        ? overrides.signature
        : await stack.signer.release(frame.moduleId, frame.version, frame.checksum),
  } as Extract<HubToFortressFrame, { t: "moduleAdvertise" }>);
}

/** The real terminal, against this stack's root. */
async function cli(...args: string[]): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  const code = await runCli(args, { fortressRoot: stack.paths.root, writeLine: (line) => out.push(line) });
  return { code, out };
}

/** Every record in the spool, in the order it was written. The daemon, the
 *  terminal and the module host each write their own file, so the order across
 *  them is the order of their timestamps. */
async function timeline() {
  await stack.host.audit.flush();
  const records = await spoolRecords(stack.paths);
  return records
    .map((record, index) => ({ record, index }))
    .sort((a, b) => (a.record.ts === b.record.ts ? a.index - b.index : a.record.ts < b.record.ts ? -1 : 1))
    .map((entry) => entry.record);
}

async function trail(action: string) {
  return (await timeline())
    .filter((record) => record.action === action)
    .map((record) => ({ kind: record.kind, outcome: record.outcome, params: record.params, error: record.error }));
}

beforeAll(async () => {
  const { paths, cleanup } = await tempRoot();
  const key = await makeOrgKey();
  const signer = await makeReleaseSigner("hxf-prod-test-1", true);
  const fetched: string[] = [];
  // The hub pushes the organization's key on welcome, as the real one does, and
  // serves the release from its own origin, as the real one serves downloads.
  const hub = await FakeHub.create({
    orgId: ORG,
    signingPublicKey: key.publicKey,
    http: (request) => {
      const { pathname } = new URL(request.url);
      fetched.push(pathname);
      return pathname === ARTIFACT_PATH ? new Response(ARTIFACT) : undefined;
    },
  });
  const artifactUrl = `${hub.url.replace(/^ws:/, "http:")}${ARTIFACT_PATH}`;

  await mkdir(path.dirname(paths.config), { recursive: true });
  await writeFile(
    paths.config,
    JSON.stringify({
      schemaVersion: 1,
      cloud: { url: hub.url },
      gateway: { publicUrl: "http://localhost:8787" },
      modules: { enabled: ["session_vault", "host", "probe"] },
    }),
  );

  const { bus, records } = captureBus();
  const registry = new ModuleRegistry(bus);
  const sessions = legacyModule();
  registry.register(sessions);
  const credential: CloudCredential = { orgId: ORG, fortressId: "fortress-1", credential: "c" };
  const credentialStore = { load: async () => credential, save: async () => {} };
  const signingKeyStore = new FileSigningKeyStore(paths.signingKey);
  const host: ModuleHost = new ModuleHost({
    paths,
    registry,
    bus,
    version: "9.9.9",
    secrets: async () => fixedSecrets({}),
    // The verifier the daemon builds: the key this fortress pinned, and the
    // organization it enrolled into.
    verifyGrant: createModuleGrantVerifier({
      pinnedKey: () => signingKeyStore.pinnedKey(),
      orgId: async () => (await credentialStore.load()).orgId,
    }),
    catalog: CATALOG,
    trustedKeys: signer.trusted,
    env: {},
  });
  const emptyTable = { execute: async () => [] } as unknown as HxDb;
  host.provide(
    createHostModule({
      version: "9.9.9",
      secretsKind: () => host.secretsKind(),
      modules: () => host.modulesView(),
      releases: () => host.shelf.list(),
      trail: new AuditTrail({ spoolDir: paths.auditSpool, db: () => emptyTable }),
    }),
  );
  const probe = createProbeModule();
  host.provide(probe);

  const conn = new WsCloudConnection({
    dispatcher: registry,
    credentialStore,
    logger: { error() {} },
    identity: { version: "9.9.9", protocolVersion: SUPPORTED_PROTOCOL_VERSION },
    signingKeyStore,
    asks: host.asks,
    releases: host.releases,
    onAuthenticated: () => host.onConnected(),
    heartbeatMs: 20,
    reconnectMinMs: 10,
    reconnectMaxMs: 50,
  });
  host.shelf.setReporter((result) => conn.reportModuleInstall(result));

  const postgres: PostgresProvider = {
    start: async () => {},
    stop: async () => {},
    status: () => ({ phase: "ready", reason: null }),
    isReady: () => true,
    dsn: () => null,
  };
  const runtime = new HostRuntime({
    configStore: new FileConfigStore(paths),
    connection: conn,
    postgres,
    supervisor: registry,
    statusStore: new FileStatusStore(paths),
    logger: { error() {} },
    root: paths.root,
    // The daemon rewrites its status every five seconds; here, every 25 ms.
    heartbeatMs: 25,
    afterConnect: async () => registry.setFortressIdentity(credential),
    afterStart: () => host.started(),
  });

  stack = {
    paths,
    hub,
    conn,
    runtime,
    registry,
    host,
    probe,
    sessions,
    key,
    signer,
    artifactUrl,
    fetched,
    logs: records,
    cleanup: async () => {
      await runtime.stop();
      await host.stop();
      await hub.stop();
      await cleanup();
    },
  };

  // The terminal signals the daemon with SIGUSR2. In this test the daemon is
  // this process, so it listens the way the daemon does.
  process.on("SIGUSR2", onSignal);
  await host.start();
  await runtime.start();
});

afterAll(async () => {
  await stack?.cleanup();
  process.removeListener("SIGUSR2", onSignal);
});

describe("an ask from the relay", () => {
  test("the fortress pinned the key the hub pushed, and started what is switched on", async () => {
    expect(await new FileSigningKeyStore(stack.paths.signingKey).pinnedKey()).toBe(stack.key.publicKey);
    expect(stack.registry.snapshot().map((module) => [module.id, module.state])).toEqual([
      ["session_vault", "running"],
      ["host", "running"],
      ["probe", "running"],
    ]);
  });

  test("with a valid grant it gets a reply of the declared shape", async () => {
    expect(await relayAsks("probe", "count.double", { n: 21 })).toEqual({ ok: true, payload: { n: 42 } });
    expect(await relayAsks("host", "status")).toEqual({
      ok: true,
      payload: {
        version: "9.9.9",
        secrets: "file",
        sessions: true,
        modules: [
          { id: "session_vault", on: true, version: "9.9.9" },
          { id: "host", on: true, version: "9.9.9" },
          { id: "probe", on: true, version: "9.9.9" },
        ],
        releases: [],
      },
    });
  });

  test("with no grant, or a wrong one, it is refused and the module never runs", async () => {
    const before = stack.probe.calls.length;
    expect(await relayAsks("probe", "count.double", { n: 1 }, null)).toEqual({ ok: false, error: "grant_missing" });
    // Signed by a key this fortress did not pin.
    const stranger = await makeOrgKey();
    expect(
      await relayAsks("probe", "count.double", { n: 1 }, await stranger.grant("probe", "count.double", { n: 1 })),
    ).toEqual({ ok: false, error: "grant_invalid" });
    // Good key, good ask, different arguments.
    expect(
      await relayAsks("probe", "count.double", { n: 999 }, await stack.key.grant("probe", "count.double", { n: 1 })),
    ).toEqual({ ok: false, error: "grant_invalid" });
    // A read grant, as the session tools use, is not a module grant.
    expect(
      await relayAsks("probe", "count.double", { n: 1 }, await stack.key.grant("probe", "count.double", { n: 1 }, { purpose: "read" })),
    ).toEqual({ ok: false, error: "grant_invalid" });
    expect(stack.probe.calls).toHaveLength(before);
  });

  test("an ask that is not on the module's list is refused", async () => {
    expect(await relayAsks("probe", "rows.read", { table: "orders" })).toEqual({ ok: false, error: "ask_unknown" });
    expect(await relayAsks("host", "config.read")).toEqual({ ok: false, error: "ask_unknown" });
  });

  test("a reply that breaks its shape is refused before it leaves", async () => {
    const reply = await relayAsks("probe", "leak.row");
    expect(reply).toEqual({ ok: false, error: "reply_invalid" });
    // Nothing of the refused value went up the tunnel, in any frame.
    expect(JSON.stringify(stack.hub.received())).not.toContain("Okafor");
  });

  test("a plain module message reaches no module, Sessions included", async () => {
    // Before the gate, this frame was handed straight to the module it named.
    stack.hub.send({
      t: "moduleMessage",
      data: { module: "session_vault", id: "legacy-1", kind: "request", payload: { method: "deleteSession" } },
    });
    const frame = await waitFor(() => received("moduleReply").find((reply) => reply.id === "legacy-1"), "the reply");
    expect(frame.reply).toEqual({ ok: false, error: "ask_unknown" });
    expect(stack.sessions.messages).toEqual([]);
  });

  test("every one of those is in the audit trail, with the rule that refused it", async () => {
    const records = await trail("relay.ask");
    const refused = records.filter((record) => record.outcome === "refused").map((record) => record.params ?? record.error);
    expect(refused).toEqual([
      { module: "probe", ask: "count.double", rule: "grant_missing" },
      { module: "probe", ask: "count.double", rule: "grant_signature" },
      { module: "probe", ask: "count.double", rule: "grant_scope" },
      { module: "probe", ask: "count.double", rule: "grant_purpose" },
      { module: "probe", ask: "unknown", rule: "ask_not_in_manifest" },
      { module: "host", ask: "unknown", rule: "ask_not_in_manifest" },
      // The reply that broke its shape: the outcome half of a pair.
      "reply_not_a_name at name",
      { module: "session_vault", ask: "unknown", rule: "envelope_version" },
    ]);
    // The asks that ran are pairs: asked for, then answered.
    // Each carries a digest of the grant that was spent on it, so a daemon that
    // restarts still knows the grant was used.
    const digest = expect.stringMatching(/^[A-Za-z0-9_-]{22}$/);
    expect(records.filter((record) => record.kind === "intent").map((record) => record.params)).toEqual([
      { module: "probe", ask: "count.double", grant: digest },
      { module: "host", ask: "status", grant: digest },
      { module: "probe", ask: "leak.row", grant: digest },
    ]);
    expect(records.filter((record) => record.outcome === "ok")).toHaveLength(2);
    // And the names the relay invented are nowhere in it.
    const text = await spoolText(stack.paths);
    expect(text).not.toContain("rows.read");
    expect(text).not.toContain("config.read");
    expect(text).not.toContain("Okafor");
  });

  test("the relay can read that trail back, as lines", async () => {
    const reply = await relayAsks("host", "audit.read", {
      from: "2020-01-01T00:00:00.000Z",
      to: "2099-01-01T00:00:00.000Z",
      kind: "ask",
      limit: 100,
    });
    if (!reply.ok) throw new Error(`audit.read failed: ${reply.error}`);
    const lines = (reply.payload as { lines: { actorKind: string; target: string; outcome: string }[] }).lines;
    expect(lines.every((line) => line.actorKind === "relay")).toBe(true);
    const summary = lines.map((line) => `${line.target} ${line.outcome}`);
    expect(summary).toContain("probe:count.double ok");
    expect(summary).toContain("probe:count.double refused");
    expect(summary).toContain("probe:leak.row refused");
    expect(summary).toContain("host:status ok");
    const counts = await relayAsks("host", "audit.count", {
      from: "2020-01-01T00:00:00.000Z",
      to: "2099-01-01T00:00:00.000Z",
    });
    // Three asks ran to an answer before this one: count.double, status and
    // audit.read. The ask being answered is not in its own count.
    expect(counts).toEqual({
      ok: true,
      payload: { asksAllowed: 3, asksRefused: 8, releasesInstalled: 0, releasesWaiting: 0, signIns: 0 },
    });
  });
});

describe("a release from the relay", () => {
  test("an unsigned release is refused, and nothing is fetched", async () => {
    await relayOffers({ signature: undefined });
    const frame = await waitFor(() => received("moduleInstallResult")[0], "the refusal");
    expect(frame).toEqual({
      t: "moduleInstallResult",
      moduleId: "probe",
      version: "1.4.1",
      ok: false,
      error: "refused:signature_missing",
    });
    expect(stack.fetched).toEqual([]);
    expect(await listReleases(stack.paths)).toEqual([]);
  });

  test("a signed release is verified and held: nothing is installed, and the relay hears nothing", async () => {
    await relayOffers();
    const release = await waitFor(
      async () => (await listReleases(stack.paths))[0],
      "the release to reach the shelf",
    );
    expect(release).toMatchObject({
      moduleId: "probe",
      version: "1.4.1",
      signedBy: "hxf-prod-test-1",
      checksum: sha256Hex(ARTIFACT),
      state: "waiting",
    });
    // Fetched once, over a real request to the relay's own origin.
    expect(stack.fetched).toEqual([ARTIFACT_PATH]);
    expect(stack.probe.applied).toEqual([]);
    expect(received("moduleInstallResult")).toHaveLength(1);
    // The relay can see that it waits, through the one ask that says so.
    const status = await relayAsks("host", "status");
    expect(status).toMatchObject({
      ok: true,
      payload: { releases: [{ id: release.id, module: "probe", version: "1.4.1", state: "waiting" }] },
    });
  });

  test("the terminal lists it, approves it, and the module receives the verified bytes", async () => {
    const [release] = await listReleases(stack.paths);
    if (!release) throw new Error("no release on the shelf");
    const listed = await cli("releases", "list");
    expect(listed.code).toBe(0);
    expect(listed.out).toContain(`${release.id}: probe 1.4.1, waiting`);

    // A real signal to a real daemon: this process.
    const approved = await cli("releases", "approve", release.id);
    expect(approved).toEqual({ code: 0, out: ["probe 1.4.1 is approved and installed."] });

    expect(stack.probe.applied).toHaveLength(1);
    expect(stack.probe.applied[0]).toMatchObject({
      id: release.id,
      moduleId: "probe",
      version: "1.4.1",
      signedBy: "hxf-prod-test-1",
      approvedBy: "root operator (terminal)",
    });
    expect(new Uint8Array(stack.probe.applied[0]!.artifact)).toEqual(ARTIFACT);

    const told = await waitFor(() => received("moduleInstallResult")[1], "the install result");
    expect(told).toEqual({ t: "moduleInstallResult", moduleId: "probe", version: "1.4.1", ok: true });

    const status = await relayAsks("host", "status");
    expect(status).toMatchObject({
      ok: true,
      payload: {
        modules: expect.arrayContaining([{ id: "probe", on: true, version: "1.4.1" }]),
        releases: [{ id: release.id, state: "installed" }],
      },
    });
  });

  test("the whole life of the release is in the trail: offered, approved by whom, installed", async () => {
    const [release] = await listReleases(stack.paths);
    const all = await timeline();
    const story = (origin: string): string[] =>
      all
        .filter((record) => record.origin === origin && /release/.test(record.action))
        .map((record) => `${record.action} ${record.kind} ${record.outcome ?? ""}`.trim());
    // What the fortress recorded, in the order it happened.
    expect(story("system")).toEqual([
      "relay.release.offer outcome refused",
      "relay.release.offer intent",
      "relay.release.offer outcome waiting",
      "system.release.approved outcome approved",
      "system.release.install intent",
      "system.release.install outcome installed",
    ]);
    // What the terminal recorded: the act, before it and after it.
    expect(story("cli")).toEqual(["cli.release.approve intent", "cli.release.approve outcome done"]);
    const approvedBy = all.find((record) => record.action === "system.release.approved");
    expect(approvedBy?.actor).toBe("root operator (terminal)");
    expect(approvedBy?.params).toMatchObject({ release: release?.id, module: "probe", version: "1.4.1" });
  });

  test("a decision made while the tunnel is down reaches the relay when it is back", async () => {
    await relayOffers({ version: "1.5.0" });
    const release = await waitFor(
      async () => (await listReleases(stack.paths)).find((candidate) => candidate.version === "1.5.0"),
      "the second release",
    );
    const before = received("moduleInstallResult").length;

    await stack.conn.close();
    const refused = await cli("releases", "refuse", release.id);
    expect(refused).toEqual({ code: 0, out: ["probe 1.5.0 is refused. It was never handed to probe."] });
    expect(received("moduleInstallResult")).toHaveLength(before);

    await stack.conn.open(await new FileConfigStore(stack.paths).load());
    const told = await waitFor(() => received("moduleInstallResult")[before], "the refusal to arrive");
    expect(told).toEqual({
      t: "moduleInstallResult",
      moduleId: "probe",
      version: "1.5.0",
      ok: false,
      error: "refused:operator",
    });
    // Told once, not on every reconnect.
    stack.hub.dropConnection();
    await waitFor(() => stack.hub.received().filter((frame) => frame.t === "hello").length >= 3, "a reconnect");
    await Bun.sleep(50);
    expect(received("moduleInstallResult")).toHaveLength(before + 1);
    expect(stack.probe.applied).toHaveLength(1);
  });

  test("the relay cannot remove a module", async () => {
    stack.hub.send({ t: "moduleRemove", moduleId: "probe" });
    const frame = await waitFor(() => received("moduleRemoveResult")[0], "the refusal");
    expect(frame).toEqual({ t: "moduleRemoveResult", moduleId: "probe", ok: false, error: "refused:not_supported" });
    expect(stack.registry.isRunning("probe")).toBe(true);
    expect(await relayAsks("probe", "count.double", { n: 2 })).toEqual({ ok: true, payload: { n: 4 } });
  });
});

describe("the switch", () => {
  test("the terminal switches a module off, and every ask to it is refused from then on", async () => {
    const off = await cli("modules", "off", "host");
    expect(off).toEqual({
      code: 0,
      out: [
        "host is switched off.",
        "The running Fortress stopped it. Every ask to host is refused from now on.",
      ],
    });
    expect(await relayAsks("host", "status")).toEqual({ ok: false, error: "module_off" });
    expect((await trail("relay.ask")).at(-1)).toMatchObject({
      outcome: "refused",
      params: { module: "host", ask: "status", rule: "module_off" },
    });
    // The daemon's own status no longer lists it; the others are untouched.
    const modules = await listModules(stack.paths, { catalog: CATALOG });
    expect(modules.map((module) => [module.id, module.on, module.state])).toEqual([
      ["session_vault", true, "running"],
      ["host", false, "stopped"],
      ["probe", true, "running"],
    ]);
  });

  test("and back on, with the act recorded on both sides", async () => {
    const on = await cli("modules", "on", "host");
    expect(on).toEqual({
      code: 0,
      out: [
        "host is switched on.",
        "The running Fortress started it. The control plane may now ask host what its list allows.",
      ],
    });
    expect(await relayAsks("host", "status")).toMatchObject({ ok: true });
    const all = await timeline();
    const switches = (origin: string): string[] =>
      all
        .filter((record) => record.origin === origin && /module\.(on|off|switch)$/.test(record.action))
        .map((record) => `${record.action} ${record.kind} ${record.outcome ?? ""} ${JSON.stringify(record.params ?? {})}`);
    // The person's gesture, as the terminal recorded it.
    expect(switches("cli")).toEqual([
      'cli.module.off intent  {"module":"host","state":"off"}',
      "cli.module.off outcome done {}",
      'cli.module.on intent  {"module":"host","state":"on"}',
      "cli.module.on outcome done {}",
    ]);
    // What the fortress did about it.
    expect(switches("system")).toEqual([
      'system.module.switch outcome done {"module":"host","state":"off"}',
      'system.module.switch outcome done {"module":"host","state":"on"}',
    ]);
  });
});

describe("what never happened", () => {
  test("no module code was loaded from the relay, and no secret or row value was written anywhere", async () => {
    // The only frames a relay can use on a module: an ask and an offer. The
    // offer's bytes went to disk as an opaque file and to the module that owns
    // them; nothing imported them.
    const text = await spoolText(stack.paths);
    for (const forbidden of ["Okafor", "sk-live", ARTIFACT_PATH, "probe release 1.4.1"]) {
      expect(text).not.toContain(forbidden);
      expect(JSON.stringify(stack.logs)).not.toContain(forbidden);
    }
  });
});
