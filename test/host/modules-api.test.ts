import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ensureCoreModulesEnabled,
  ModuleSwitchRefused,
  readEnabledModules,
  setModuleEnabled,
} from "../../src/host/config";
import { STATUS_STALE_MS } from "../../src/daemon-state";
import { MODULE_CATALOG } from "../../src/host/module-catalog";
import {
  approveRelease,
  listAsks,
  listModules,
  listReleases,
  liveDaemonPid,
  NoDaemon,
  refuseRelease,
  switchModule,
} from "../../src/host/modules-api";
import {
  answerReleaseDecision,
  DECISION_REQUEST_TTL_MS,
  readReleaseAnswer,
  sweepReleaseAnswers,
  takeReleaseDecisions,
  writeReleaseDecision,
} from "../../src/host/release-intents";
import {
  makeReleaseSigner,
  makeRig,
  PROBE_CATALOG,
  sha256Hex,
  tempRoot,
  writeConfig,
  type Paths,
  type Rig,
  publishStatus,
} from "./_module-rig";

let rig: Rig | null = null;
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await rig?.cleanup();
  await cleanup?.();
  rig = null;
  cleanup = null;
});

async function bareRoot(enabled?: readonly string[]): Promise<Paths> {
  const root = await tempRoot();
  cleanup = root.cleanup;
  if (enabled) await writeConfig(root.paths, enabled);
  return root.paths;
}

const ARTIFACT = new TextEncoder().encode("release bytes");
const URL_1 = "https://relay.example/modules/probe.bin";

/** A rig with one release waiting, and a stand-in for the daemon's signal: the
 *  `kill` these functions call carries the request out, as SIGUSR2 does. */
async function rigWithWaitingRelease() {
  const signer = await makeReleaseSigner("hxf-prod-test-1", true);
  const r = await makeRig({
    deps: {
      trustedKeys: signer.trusted,
      releaseFetchImpl: (async () => new Response(ARTIFACT)) as unknown as typeof fetch,
    },
  });
  rig = r;
  await r.host.releases.offer({
    moduleId: "probe",
    version: "2.0.0",
    artifactUrl: URL_1,
    checksum: sha256Hex(ARTIFACT),
    signature: await signer.release("probe", "2.0.0", sha256Hex(ARTIFACT)),
  });
  const [release] = await listReleases(r.paths);
  if (!release) throw new Error("the release was not shelved");
  const signals: string[] = [];
  const daemon = {
    daemonPid: async () => 4242,
    kill: (_pid: number, signal: NodeJS.Signals) => {
      signals.push(signal);
      void r.host.applyRequests();
      return true;
    },
    pollMs: 5,
    waitMs: 2_000,
    // The terminal and the daemon share one host and so one clock; here that
    // clock is the rig's.
    now: () => new Date(r.now.value.getTime()),
  };
  return { r, release, daemon, signals };
}

describe("the switch in config.json", () => {
  test("adds and removes an id, and says whether anything changed", async () => {
    const paths = await bareRoot(["session_vault"]);
    expect(await setModuleEnabled(paths, "host", true)).toEqual({
      changed: true,
      enabled: ["session_vault", "host"],
    });
    expect(await setModuleEnabled(paths, "host", true)).toMatchObject({ changed: false });
    expect(await readEnabledModules(paths)).toEqual(["session_vault", "host"]);
    expect(await setModuleEnabled(paths, "host", false)).toEqual({ changed: true, enabled: ["session_vault"] });
    expect(await setModuleEnabled(paths, "host", false)).toMatchObject({ changed: false });
  });

  test("keeps every other key the file carried, and its owner-only mode", async () => {
    const paths = await bareRoot();
    await mkdir(path.dirname(paths.config), { recursive: true });
    await writeFile(
      paths.config,
      JSON.stringify({
        schemaVersion: 1,
        cloud: { url: "wss://relay.example/tunnel" },
        gateway: { publicUrl: "http://localhost:8787" },
        modules: { enabled: ["session_vault"] },
        roster: { inactivePurgeDays: 30 },
        secrets: { provider: "file", dir: "/run/secrets" },
        somethingALaterBuildAdds: { keep: true },
      }),
    );
    await setModuleEnabled(paths, "host", true);
    const written = JSON.parse(await readFile(paths.config, "utf8")) as Record<string, unknown>;
    expect(written.modules).toEqual({ enabled: ["session_vault", "host"] });
    expect(written.roster).toEqual({ inactivePurgeDays: 30 });
    expect(written.secrets).toEqual({ provider: "file", dir: "/run/secrets" });
    expect(written.somethingALaterBuildAdds).toEqual({ keep: true });
    expect((await Bun.file(paths.config).stat()).mode & 0o777).toBe(0o600);
  });

  test("Sessions can be switched off, and what the daemon does at each start does not switch it back on", async () => {
    const paths = await bareRoot(["session_vault"]);
    expect(await setModuleEnabled(paths, "session_vault", false)).toEqual({ changed: true, enabled: [] });
    expect(await readEnabledModules(paths)).toEqual([]);
    // The daemon applies the defaults of its build at every start. They were
    // applied once, before the switch was made, and are not applied again.
    await ensureCoreModulesEnabled(paths);
    expect(await readEnabledModules(paths)).toEqual([]);
    await setModuleEnabled(paths, "session_vault", true);
    await ensureCoreModulesEnabled(paths);
    expect(await readEnabledModules(paths)).toEqual(["session_vault"]);
  });

  test("refuses a fortress with no config, and an id that is not one", async () => {
    const paths = await bareRoot(["session_vault"]);
    const empty = await tempRoot();
    try {
      await expect(setModuleEnabled(empty.paths, "host", true)).rejects.toBeInstanceOf(ModuleSwitchRefused);
      await expect(setModuleEnabled(empty.paths, "host", true)).rejects.toThrow(/no config.json yet/);
      expect(await readEnabledModules(empty.paths)).toBeNull();
    } finally {
      await empty.cleanup();
    }
    await expect(setModuleEnabled(paths, "../etc", true)).rejects.toThrow(/Invalid module id/);
  });

  test("a config that cannot be read is told apart from one with nothing switched on", async () => {
    const paths = await bareRoot([]);
    expect(await readEnabledModules(paths)).toEqual([]);
    await writeFile(paths.config, "{ not json");
    expect(await readEnabledModules(paths)).toBeNull();
    // A page that lists the modules shows none of them on while it lasts.
    expect((await listModules(paths)).map((module) => module.on)).toEqual([false, false]);
  });
});

describe("listing", () => {
  test("every module of the build, with its switch, state, version and asks", async () => {
    const paths = await bareRoot(["session_vault"]);
    await publishStatus(paths, [{ id: "session_vault", state: "running" }]);
    const modules = await listModules(paths, { version: "1.2.3" });
    expect(modules.map((m) => [m.id, m.title, m.on, m.state, m.version])).toEqual([
      ["session_vault", "Sessions", true, "running", "1.2.3"],
      // The daemon is up and does not list it: it is not running.
      ["host", "Host", false, "stopped", "1.2.3"],
    ]);
    // A status file outlives its daemon. Once it is stale, nothing is running.
    await publishStatus(paths, [{ id: "session_vault", state: "running" }], {
      writtenAt: new Date(Date.now() - STATUS_STALE_MS - 1_000).toISOString(),
    });
    expect((await listModules(paths)).map((m) => m.state)).toEqual(["stopped", "stopped"]);
    const host = modules.find((m) => m.id === "host");
    expect(host?.asks.map((ask) => ask.name)).toEqual(["status", "audit.count", "audit.read"]);
    expect(host?.egress).toEqual([]);
    expect(host?.secrets).toEqual([]);
    expect(modules[0]?.asks).toEqual([]);
  });

  test("works with no daemon, no status and no config at all", async () => {
    const paths = await bareRoot();
    const modules = await listModules(paths);
    expect(modules.map((m) => [m.id, m.on, m.state])).toEqual([
      ["session_vault", false, "stopped"],
      ["host", false, "stopped"],
    ]);
    expect(await listReleases(paths)).toEqual([]);
  });

  test("the asks are the whole list, in words an operator can read", () => {
    const asks = listAsks();
    expect(asks.map((ask) => `${ask.module}:${ask.name}`)).toEqual([
      "host:status",
      "host:audit.count",
      "host:audit.read",
    ]);
    expect(asks[0]?.args).toBe("nothing");
    // The same shapes as data, for a page that lays them out itself.
    expect(asks[0]?.argsShape).toEqual({ kind: "record", fields: {} });
    expect(asks[1]?.replyShape).toMatchObject({ kind: "record", fields: { asksAllowed: { kind: "count" } } });
    expect(asks[1]).toMatchObject({
      args: "{ from: time, to: time }",
      reply:
        "{ asksAllowed: count, asksRefused: count, releasesInstalled: count, releasesWaiting: count, signIns: count }",
    });
    expect(asks[2]?.args).toBe(
      "{ from: time, to: time, kind?: one of ask | release | module | sign_in | command | other, before?: id, limit: count up to 100 }",
    );
    // Nothing in any reply is free text or bytes: only the closed kinds appear.
    for (const ask of asks) {
      for (const word of ask.reply.match(/[a-z]+(?= |,|\)|$)/g) ?? []) {
        expect(["count", "flag", "time", "name", "id", "nothing"].includes(word) || word.length > 0).toBe(true);
      }
      expect(ask.reply).not.toMatch(/text|bytes|string|any/);
    }
    expect(listAsks({ catalog: PROBE_CATALOG }).map((ask) => ask.name)).toContain("count.double");
  });

  test("a module reports the version of its last installed release", async () => {
    const { r, release, daemon } = await rigWithWaitingRelease();
    const before = await listModules(r.paths, { catalog: PROBE_CATALOG, version: "9.9.9" });
    expect(before.find((m) => m.id === "probe")?.version).toBe("9.9.9");
    await approveRelease(r.paths, release.id, "alice", daemon);
    const after = await listModules(r.paths, { catalog: PROBE_CATALOG, version: "9.9.9" });
    expect(after.find((m) => m.id === "probe")?.version).toBe("2.0.0");
    expect(after.find((m) => m.id === "session_vault")?.version).toBe("9.9.9");
  });
});

describe("switching a module", () => {
  test("refuses an id this build does not ship", async () => {
    const paths = await bareRoot(["session_vault"]);
    await expect(switchModule(paths, "payroll", true)).rejects.toThrow(/no module named payroll/);
    await expect(switchModule(paths, "../../x", true)).rejects.toThrow(/no module named that/);
    expect(await readEnabledModules(paths)).toEqual(["session_vault"]);
  });

  test("with no daemon the file is changed and nobody is signalled", async () => {
    const paths = await bareRoot(["session_vault"]);
    const killed: number[] = [];
    const result = await switchModule(paths, "host", true, {
      kill: (pid) => {
        killed.push(pid);
        return true;
      },
    });
    expect(result).toEqual({ changed: true, daemonTold: false });
    expect(killed).toEqual([]);
    expect(await readEnabledModules(paths)).toEqual(["session_vault", "host"]);
  });

  test("a running daemon is signalled, and starts or stops the module", async () => {
    const r = (rig = await makeRig({ enabled: ["session_vault"] }));
    const daemon = {
      catalog: PROBE_CATALOG,
      daemonPid: async () => 4242,
      kill: () => {
        void r.host.applyRequests();
        return true;
      },
    };
    expect(await switchModule(r.paths, "probe", true, daemon)).toEqual({ changed: true, daemonTold: true });
    await r.host.applyRequests();
    expect(r.registry.isRunning("probe")).toBe(true);
    expect(await switchModule(r.paths, "probe", false, daemon)).toEqual({ changed: true, daemonTold: true });
    await r.host.applyRequests();
    expect(r.registry.snapshot().map((m) => m.id)).toEqual(["session_vault"]);
  });
});

describe("which daemon may be signalled", () => {
  test("only one whose status is fresh and says it is up", async () => {
    const paths = await bareRoot();
    expect(await liveDaemonPid(paths)).toBeNull();
    await publishStatus(paths, []);
    expect(await liveDaemonPid(paths)).toBe(4242);
    await publishStatus(paths, [], { state: "starting" });
    expect(await liveDaemonPid(paths)).toBe(4242);
    // A status file outlives the daemon that wrote it, and a pid is reused.
    // The same 15 seconds the console calls stale: two surfaces with two numbers
    // is how one of them signals a daemon the other says has stopped answering.
    expect(STATUS_STALE_MS).toBe(15_000);
    const stale = new Date(Date.now() - STATUS_STALE_MS - 1_000).toISOString();
    await publishStatus(paths, [], { writtenAt: stale });
    expect(await liveDaemonPid(paths)).toBeNull();
    // A write time in the future is not fresh either: a clock that was set back
    // must not make a dead daemon's file read as live.
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    await publishStatus(paths, [], { writtenAt: future });
    expect(await liveDaemonPid(paths)).toBeNull();
    for (const host of [{ state: "stopped" }, { state: "failed" }, { state: "draining" }, { pid: 0 }, { pid: "4242" }]) {
      await publishStatus(paths, [], host);
      expect(await liveDaemonPid(paths)).toBeNull();
    }
    // Written by a build with no heartbeat: its age cannot be known.
    await publishStatus(paths, [], { writtenAt: undefined });
    expect(await liveDaemonPid(paths)).toBeNull();
    // Not a status file this program wrote, or a torn one.
    await writeFile(paths.status, JSON.stringify({ host: { state: "running", pid: 4242 } }));
    expect(await liveDaemonPid(paths)).toBeNull();
    await writeFile(paths.status, "{ torn");
    expect(await liveDaemonPid(paths)).toBeNull();
  });
});

describe("deciding a release", () => {
  test("approve: the daemon hands it to the module and answers", async () => {
    const { r, release, daemon, signals } = await rigWithWaitingRelease();
    const answer = await approveRelease(r.paths, release.id, "alice", daemon);
    expect(answer).toMatchObject({ ok: true, state: "installed", moduleId: "probe", version: "2.0.0" });
    expect(signals).toEqual(["SIGUSR2"]);
    expect(r.probe.applied.map((applied) => [applied.version, applied.approvedBy])).toEqual([["2.0.0", "alice"]]);
    expect((await listReleases(r.paths))[0]).toMatchObject({ state: "installed", decidedBy: "alice" });
    // Nothing is left behind in the request directory.
    expect(await readdir(r.paths.releaseDecisions)).toEqual([]);
  });

  test("refuse: the module never hears of it", async () => {
    const { r, release, daemon } = await rigWithWaitingRelease();
    const answer = await refuseRelease(r.paths, release.id, "alice", daemon);
    expect(answer).toMatchObject({ ok: true, state: "refused" });
    expect(r.probe.applied).toEqual([]);
  });

  test("a failed install is an answer, with its code", async () => {
    const { r, release, daemon } = await rigWithWaitingRelease();
    r.probe.applyFailure = new Error("boom");
    const answer = await approveRelease(r.paths, release.id, "alice", daemon);
    expect(answer).toMatchObject({ ok: true, state: "failed", error: "internal" });
  });

  test("a decision the daemon will not carry out says why", async () => {
    const { r, release, daemon } = await rigWithWaitingRelease();
    await refuseRelease(r.paths, release.id, "alice", daemon);
    expect(await approveRelease(r.paths, release.id, "alice", daemon)).toMatchObject({
      ok: false,
      reason: "not_waiting",
      state: "refused",
    });
    expect(await approveRelease(r.paths, "rel-00000000000000ff", "alice", daemon)).toMatchObject({
      ok: false,
      reason: "release_unknown",
    });
    // Not a release id at all: refused here, and nothing is written for the daemon.
    expect(await approveRelease(r.paths, "../../etc/passwd", "alice", daemon)).toMatchObject({
      ok: false,
      reason: "release_unknown",
    });
    expect(await readdir(r.paths.releaseDecisions)).toEqual([]);
  });

  test("with no daemon the request is withdrawn, not left for later", async () => {
    const { r, release } = await rigWithWaitingRelease();
    await expect(
      approveRelease(r.paths, release.id, "alice", { daemonPid: async () => null }),
    ).rejects.toBeInstanceOf(NoDaemon);
    await expect(
      approveRelease(r.paths, release.id, "alice", { daemonPid: async () => 4242, kill: () => { throw new Error("ESRCH"); } }),
    ).rejects.toBeInstanceOf(NoDaemon);
    expect(await readdir(r.paths.releaseDecisions)).toEqual([]);
    // A daemon that starts later finds nothing to carry out.
    await r.host.applyRequests();
    expect(r.probe.applied).toEqual([]);
    expect((await listReleases(r.paths))[0]?.state).toBe("waiting");
  });

  test("a daemon that does not answer in time is not a refusal", async () => {
    const { r, release, daemon } = await rigWithWaitingRelease();
    const answer = await approveRelease(r.paths, release.id, "alice", {
      ...daemon,
      kill: () => true, // signalled, and then nothing happens
      waitMs: 30,
      pollMs: 10,
    });
    expect(answer).toBeNull();
    expect((await listReleases(r.paths))[0]?.state).toBe("waiting");
    // The request is still there, and the daemon's own look carries it out.
    await r.host.applyRequests();
    expect(r.probe.applied).toHaveLength(1);
  });

  test("a request the daemon finds too late is answered expired, and changes nothing", async () => {
    const { r, release } = await rigWithWaitingRelease();
    const old = new Date(r.now.value.getTime() - DECISION_REQUEST_TTL_MS - 1_000);
    const requestId = await writeReleaseDecision(r.paths, { id: release.id, decision: "approve", decidedBy: "alice" }, old);
    await r.host.applyRequests();
    expect(await readReleaseAnswer(r.paths, requestId)).toMatchObject({ ok: false, reason: "expired" });
    expect(r.probe.applied).toEqual([]);
  });

  test("before the modules have started, a request waits where it is", async () => {
    const signer = await makeReleaseSigner("hxf-prod-test-1", true);
    const r = (rig = await makeRig({ start: false, deps: { trustedKeys: signer.trusted } }));
    await r.host.start();
    const requestId = await writeReleaseDecision(
      r.paths,
      { id: "rel-0123456789abcdef", decision: "approve", decidedBy: "alice" },
      r.now.value,
    );
    await r.host.applyRequests();
    expect(await readReleaseAnswer(r.paths, requestId)).toBeNull();
    expect(await readdir(r.paths.releaseDecisions)).toEqual([`${requestId}.json`]);
    await r.registry.startAll(["session_vault", "probe"]);
    await r.host.started();
    expect(await readReleaseAnswer(r.paths, requestId)).toMatchObject({ ok: false, reason: "release_unknown" });
  });
});

describe("the request files", () => {
  test("are owner-only, and taking one removes it, so it is carried out at most once", async () => {
    const paths = await bareRoot();
    const requestId = await writeReleaseDecision(paths, {
      id: "rel-0123456789abcdef",
      decision: "refuse",
      decidedBy: "alice",
    });
    const file = path.join(paths.releaseDecisions, `${requestId}.json`);
    expect((await Bun.file(file).stat()).mode & 0o777).toBe(0o600);
    expect((await Bun.file(paths.releaseDecisions).stat()).mode & 0o777).toBe(0o700);
    // Planted beside it: a wrong id inside, a wrong decision, a path as the release.
    const bad = (name: string, body: unknown) =>
      writeFile(path.join(paths.releaseDecisions, name), JSON.stringify(body));
    await bad(`${"a".repeat(32)}.json`, { requestId: "b".repeat(32), id: "rel-0123456789abcdef", decision: "approve", decidedBy: "x", at: new Date().toISOString() });
    await bad(`${"c".repeat(32)}.json`, { requestId: "c".repeat(32), id: "rel-0123456789abcdef", decision: "install", decidedBy: "x", at: new Date().toISOString() });
    await bad(`${"d".repeat(32)}.json`, { requestId: "d".repeat(32), id: "../../x", decision: "approve", decidedBy: "x", at: new Date().toISOString() });
    await writeFile(path.join(paths.releaseDecisions, `${"e".repeat(32)}.json`), "{ torn");
    await writeFile(path.join(paths.releaseDecisions, "notes.txt"), "not a request");
    const taken = await takeReleaseDecisions(paths);
    // Only the real request is returned. Its file is gone with the four that
    // were not requests: whoever took it owns it, and a second look finds none.
    expect(taken.map((request) => request.requestId)).toEqual([requestId]);
    expect(await readdir(paths.releaseDecisions)).toEqual(["notes.txt"]);
    expect(await takeReleaseDecisions(paths)).toEqual([]);
  });

  test("an answer nobody collected is swept after an hour", async () => {
    const paths = await bareRoot();
    const requestId = "f".repeat(32);
    await answerReleaseDecision(paths, { requestId, ok: true, at: new Date().toISOString() });
    await sweepReleaseAnswers(paths);
    expect(await readReleaseAnswer(paths, requestId)).toMatchObject({ ok: true });
    await sweepReleaseAnswers(paths, new Date(Date.now() + 61 * 60_000));
    expect(await readReleaseAnswer(paths, requestId)).toBeNull();
  });
});

describe("the catalog", () => {
  test("lists the modules this build ships, each once", () => {
    expect(MODULE_CATALOG.map((entry) => entry.id)).toEqual(["session_vault", "host"]);
    expect(new Set(MODULE_CATALOG.map((entry) => entry.id)).size).toBe(MODULE_CATALOG.length);
  });
});
