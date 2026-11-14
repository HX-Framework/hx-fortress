import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";

import { runCli } from "../src/cli";
import { runModulesVerb, runReleasesVerb, type ModulesVerbDeps } from "../src/cli-modules";
import { readEnabledModules } from "../src/host/config";
import { listReleases } from "../src/host/modules-api";
import { FORTRESS_VERSION } from "../src/version";
import {
  makeReleaseSigner,
  makeRig,
  PROBE_CATALOG,
  sha256Hex,
  spoolRecords,
  tempRoot,
  writeConfig,
  type Paths,
  type Rig,
  publishStatus,
} from "./host/_module-rig";

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

/** Run the real binary's dispatch against a root, capturing what it prints. */
async function cli(paths: Paths, ...args: string[]): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  const code = await runCli(args, { fortressRoot: paths.root, writeLine: (line) => out.push(line) });
  // Records are ordered by the millisecond they were written in, so two
  // invocations never share one.
  await Bun.sleep(2);
  return { code, out };
}

/** The terminal's records, as (action, kind, outcome, params). */
async function cliRecords(paths: Paths) {
  // Each invocation writes its own file, and two in one second sort by a random
  // id. Ordered here by when each record was written.
  return (await spoolRecords(paths))
    .filter((record) => record.origin === "cli")
    .sort((x, y) => (x.ts === y.ts ? x.seq - y.seq : x.ts < y.ts ? -1 : 1))
    .map((record) => [record.action, record.kind, record.outcome, record.params]);
}

const ARTIFACT = new TextEncoder().encode("release bytes");

/** A daemon-shaped rig with one release waiting, and verb dependencies whose
 *  signal is carried out by that rig — what SIGUSR2 does to the real daemon. */
async function withDaemon(enabled: readonly string[] = ["session_vault", "probe"]) {
  const signer = await makeReleaseSigner("hxf-prod-test-1", true);
  const r = await makeRig({
    enabled,
    deps: {
      trustedKeys: signer.trusted,
      releaseFetchImpl: (async () => new Response(ARTIFACT)) as unknown as typeof fetch,
    },
  });
  rig = r;
  const out: string[] = [];
  const publish = (): Promise<void> =>
    // The daemon and the terminal share a host, and so a clock: the rig's.
    publishStatus(r.paths, r.registry.snapshot(), { writtenAt: r.now.value.toISOString() });
  await publish();
  const deps: ModulesVerbDeps = {
    writeLine: (line) => out.push(line),
    fortressRoot: r.paths.root,
    catalog: PROBE_CATALOG,
    daemonPid: async () => 4242,
    kill: () => {
      void r.host.applyRequests().then(publish);
      return true;
    },
    pollMs: 5,
    waitMs: 2_000,
    settleMs: 2_000,
    now: () => new Date(r.now.value.getTime()),
  };
  const offer = async (version = "2.0.0") => {
    await r.host.releases.offer({
      moduleId: "probe",
      version,
      artifactUrl: `https://control.example/modules/probe-${version}.bin`,
      checksum: sha256Hex(ARTIFACT),
      signature: await signer.release("probe", version, sha256Hex(ARTIFACT)),
    });
    const release = (await listReleases(r.paths)).find((candidate) => candidate.version === version);
    if (!release) throw new Error("the release was not shelved");
    return release;
  };
  return { r, out, deps, offer };
}

describe("hx-fortress modules list", () => {
  test("prints every module, its switch, and exactly what a control plane may ask it", async () => {
    const paths = await bareRoot(["session_vault"]);
    const { code, out } = await cli(paths, "modules", "list");
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(out[0]).toBe(`Modules in this build (hx-fortress ${FORTRESS_VERSION})`);
    expect(out[1]).toBe("The Fortress is not running, so no module is.");
    expect(text).toContain("  State:    stopped");
    expect(text).toContain("session_vault (Sessions): on");
    expect(text).toContain("host (Host): off");
    // Sessions has no manifest. The list says so. It does not say "no hosts"
    // of a module that writes to the organization's bucket.
    const sessions = out.slice(out.indexOf("session_vault (Sessions): on"), out.indexOf("host (Host): off"));
    expect(sessions).toEqual([
      "session_vault (Sessions): on",
      "  Does:     keeps AI session transcripts and their search index on this host",
      "  State:    stopped",
      `  Version:  ${FORTRESS_VERSION}`,
      "  Calls:    not listed. This module has no manifest, so it is held to no list of hosts.",
      "            The console's list of data paths shows what it reaches, and what reaches it.",
      "  Secrets:  not listed.",
      "  Asks:     none. A control plane can send this module no ask.",
      "",
    ]);
    expect(text).toContain("  Asks:     3. A control plane may ask it these and nothing else:");
    // Every field an ask takes and every field an answer can hold, a line each.
    const from = out.indexOf("    audit.count");
    expect(out.slice(from, from + 8)).toEqual([
      "    audit.count",
      "      takes    from: time",
      "               to: time",
      "      answers  asksAllowed: count",
      "               asksRefused: count",
      "               releasesInstalled: count",
      "               releasesWaiting: count",
      "               signIns: count",
    ]);
    expect(text).toContain("      takes    nothing");
    expect(text).toContain("               releases: list of up to 100, each:");
    expect(text).toContain("                 decidedAt (optional): time");
    expect(text).toContain("No ask takes free text or bytes, and no answer can hold either.");
    // The `host` module does have a manifest, and it lists no host and no secret.
    const host = out.slice(out.indexOf("host (Host): off"));
    expect(host).toContain("  Calls:    no hosts");
    expect(host).toContain("  Secrets:  none");
    expect(out.at(-1)).toBe("Switch one with `hx-fortress modules on <id>` or `hx-fortress modules off <id>`.");
    // A read: nothing is written to the trail.
    expect(await cliRecords(paths)).toEqual([]);
  });

  test("is in the help, with the release verbs", async () => {
    const paths = await bareRoot();
    const { out } = await cli(paths, "help");
    const help = out.join("\n");
    for (const usage of [
      "hx-fortress modules list",
      "hx-fortress modules on <id>",
      "hx-fortress modules off <id>",
      "hx-fortress releases list",
      "hx-fortress releases approve <id>",
      "hx-fortress releases refuse <id>",
    ]) {
      expect(help).toContain(usage);
    }
  });
});

describe("hx-fortress modules on|off", () => {
  test("with no daemon: the switch is written, recorded, and takes effect at the next start", async () => {
    const paths = await bareRoot(["session_vault"]);
    const on = await cli(paths, "modules", "on", "host");
    expect(on).toEqual({
      code: 0,
      out: ["host is switched on.", "The Fortress is not running. The module starts with it."],
    });
    expect(await readEnabledModules(paths)).toEqual(["session_vault", "host"]);
    expect(await cli(paths, "modules", "on", "host")).toEqual({ code: 0, out: ["host is already switched on."] });
    const off = await cli(paths, "modules", "off", "host");
    expect(off.out).toEqual([
      "host is switched off.",
      "The Fortress is not running. The module stays off when it starts.",
    ]);
    expect(await readEnabledModules(paths)).toEqual(["session_vault"]);
    expect(await cliRecords(paths)).toEqual([
      ["cli.module.on", "intent", null, { module: "host", state: "on" }],
      ["cli.module.on", "outcome", "done", null],
      ["cli.module.on", "intent", null, { module: "host", state: "on" }],
      ["cli.module.on", "outcome", "done", null],
      ["cli.module.off", "intent", null, { module: "host", state: "off" }],
      ["cli.module.off", "outcome", "done", null],
    ]);
  });

  test("says that nothing was saved when config.json cannot be read", async () => {
    const paths = await bareRoot(["session_vault"]);
    await writeFile(paths.config, "{ not json");
    for (const [verb, id] of [["off", "session_vault"], ["on", "host"]] as const) {
      expect(await cli(paths, "modules", verb, id)).toEqual({
        code: 1,
        out: ["error: config.json cannot be read, so nothing was saved. Fix the file, then run this again."],
      });
    }
    expect(await readFile(paths.config, "utf8")).toBe("{ not json");
    // The two attempts are in the trail as acts that failed.
    expect((await cliRecords(paths)).map(([action, kind, outcome]) => [action, kind, outcome])).toEqual([
      ["cli.module.off", "intent", null],
      ["cli.module.off", "outcome", "failed"],
      ["cli.module.on", "intent", null],
      ["cli.module.on", "outcome", "failed"],
    ]);
  });

  test("refuses a module this build does not ship, and bad usage", async () => {
    const paths = await bareRoot(["session_vault"]);
    const unknown = await cli(paths, "modules", "on", "payroll");
    expect(unknown.code).toBe(1);
    expect(unknown.out[0]).toContain("this build has no module named payroll");
    for (const args of [["modules"], ["modules", "on"], ["modules", "toggle", "host"], ["modules", "on", "host", "now"], ["modules", "list", "all"]]) {
      expect(await cli(paths, ...args)).toEqual({
        code: 1,
        out: ["error: usage: hx-fortress modules list | on <id> | off <id>"],
      });
    }
    expect(await readEnabledModules(paths)).toEqual(["session_vault"]);
    // The refusals are in the trail as failed acts; a name nobody ships is not.
    const records = await cliRecords(paths);
    expect(records.filter(([, kind]) => kind === "outcome").map(([action, , outcome]) => [action, outcome])).toEqual([
      ["cli.module.on", "failed"],
    ]);
    expect(records[0]?.[3]).toEqual({ module: "payroll", state: "on" });
  });

  test("where FORTRESS_SESSIONS says the opposite, the terminal says the switch will not last", async () => {
    const paths = await bareRoot(["session_vault"]);
    const run = async (verb: "on" | "off", setting: string | undefined): Promise<string[]> => {
      const out: string[] = [];
      await runModulesVerb([verb, "session_vault"], {
        writeLine: (line) => out.push(line),
        fortressRoot: paths.root,
        env: { FORTRESS_SESSIONS: setting },
      });
      return out;
    };
    expect(await run("off", "on")).toEqual([
      "session_vault is switched off.",
      "FORTRESS_SESSIONS is set to on here. The Fortress applies it at every start, so it will switch Sessions on again. Change that setting to keep this.",
      "The Fortress is not running. The module stays off when it starts.",
    ]);
    // The setting agrees, is not set, or is not one the Fortress would accept:
    // nothing is added.
    expect(await run("on", "on")).toHaveLength(2);
    expect(await run("off", undefined)).toHaveLength(2);
    expect(await run("on", "maybe")).toHaveLength(2);
    // Only the words `on` and `off` are accepted. Any other value stops the
    // Fortress from starting, so it is not a setting that switches anything.
    expect(await run("off", "TRUE")).toHaveLength(2);
  });

  test("Sessions is switched for the next start: a running Fortress is not stopped", async () => {
    // The rig is a daemon after boot: Sessions and the probe are both running.
    const { r, out, deps } = await withDaemon(["session_vault", "probe"]);
    expect(r.registry.isRunning("session_vault")).toBe(true);

    expect(await runModulesVerb(["off", "session_vault"], deps)).toBe(0);
    expect(out).toEqual([
      "session_vault is switched off.",
      "The running Fortress reads this switch only when it starts. Restart the Fortress to apply it.",
    ]);
    expect(await readEnabledModules(r.paths)).toEqual(["probe"]);
    // The daemon was told, looked, and left the module as it was.
    await r.host.applyRequests();
    expect(r.registry.isRunning("session_vault")).toBe(true);

    // The list says both things, and why they differ.
    out.length = 0;
    expect(await runModulesVerb(["list"], deps)).toBe(0);
    expect(out).toContain("session_vault (Sessions): off");
    expect(out).toContain(
      "  State:    running. The switch is read when the Fortress starts: restart it to apply.",
    );

    // And back on: the same sentence, and nothing is started twice.
    out.length = 0;
    expect(await runModulesVerb(["on", "session_vault"], deps)).toBe(0);
    expect(out[1]).toContain("Restart the Fortress to apply it.");
    await r.host.applyRequests();
    expect(r.registry.isRunning("session_vault")).toBe(true);
    expect(
      (await spoolRecords(r.paths)).filter((record) => record.action === "system.module.switch"),
    ).toEqual([]);
  });

  test("on an unenrolled fortress it says to enroll first", async () => {
    const paths = await bareRoot();
    expect(await cli(paths, "modules", "on", "host")).toEqual({
      code: 1,
      out: ["error: this fortress has no config.json yet. Run `hx-fortress enroll` first."],
    });
  });

  test("with a daemon: it is told, and the verb reports what it did", async () => {
    const { r, out, deps } = await withDaemon(["session_vault"]);
    expect(await runModulesVerb(["on", "probe"], deps)).toBe(0);
    expect(out).toEqual([
      "probe is switched on.",
      "The running Fortress started it. The control plane may now ask probe what its list allows.",
    ]);
    expect(r.registry.isRunning("probe")).toBe(true);
    out.length = 0;
    expect(await runModulesVerb(["off", "probe"], deps)).toBe(0);
    expect(out).toEqual([
      "probe is switched off.",
      "The running Fortress stopped it. Every ask to probe is refused from now on.",
    ]);
    expect(r.registry.snapshot().map((module) => module.id)).toEqual(["session_vault"]);
  });

  test("a module that cannot start is reported as a failure", async () => {
    const { r, out, deps } = await withDaemon(["session_vault"]);
    r.probe.init = () => {
      throw new Error("no credentials");
    };
    expect(await runModulesVerb(["on", "probe"], deps)).toBe(1);
    expect(out).toEqual([
      "probe is switched on.",
      "The Fortress could not start probe. `hx-fortress logs --module probe` says why.",
    ]);
  });
});

describe("hx-fortress releases", () => {
  test("list: nothing offered", async () => {
    const paths = await bareRoot(["session_vault"]);
    expect(await cli(paths, "releases", "list")).toEqual({
      code: 0,
      out: ["No control plane has offered a release to this Fortress."],
    });
  });

  test("list shows what waits, who signed it, and how to decide", async () => {
    const { r, offer } = await withDaemon();
    const release = await offer();
    const { code, out } = await cli(r.paths, "releases", "list");
    expect(code).toBe(0);
    expect(out).toEqual([
      "Releases the control plane has offered, newest first",
      "",
      `${release.id}: probe 2.0.0, waiting`,
      `  Offered:   ${release.offeredAt}`,
      "  Signed by: hxf-prod-test-1",
      `  sha256:    ${sha256Hex(ARTIFACT)}`,
      "",
      "Decide one with `hx-fortress releases approve <id>` or `hx-fortress releases refuse <id>`.",
    ]);
  });

  test("approve: the module receives it, and the act is in the trail under the terminal", async () => {
    const { r, out, deps, offer } = await withDaemon();
    const release = await offer();
    expect(await runReleasesVerb(["approve", release.id], deps)).toBe(0);
    expect(out).toEqual(["probe 2.0.0 is approved and installed."]);
    expect(r.probe.applied.map((applied) => [applied.version, applied.approvedBy])).toEqual([
      ["2.0.0", "root operator (terminal)"],
    ]);
    expect(await cliRecords(r.paths)).toEqual([
      ["cli.release.approve", "intent", null, { release: release.id, module: "probe", version: "2.0.0" }],
      ["cli.release.approve", "outcome", "done", null],
    ]);
    const listed = await cli(r.paths, "releases", "list");
    expect(listed.out).toContain(`${release.id}: probe 2.0.0, installed`);
    expect(listed.out.join("\n")).toContain("by root operator (terminal)");
    expect(listed.out.join("\n")).not.toContain("Decide one with");
  });

  test("refuse: it is never handed to the module", async () => {
    const { r, out, deps, offer } = await withDaemon();
    const release = await offer();
    expect(await runReleasesVerb(["refuse", release.id], deps)).toBe(0);
    expect(out).toEqual(["probe 2.0.0 is refused. It was never handed to probe."]);
    expect(r.probe.applied).toEqual([]);
    const listed = await cli(r.paths, "releases", "list");
    expect(listed.out.join("\n")).toMatch(/Refused: {3}\S+ by root operator \(terminal\)/);
  });

  test("a module that cannot apply it: exit 1, the code, and it may be approved again", async () => {
    const { r, out, deps, offer } = await withDaemon();
    const release = await offer();
    r.probe.applyFailure = new Error("the API said no: token sk-live-123");
    expect(await runReleasesVerb(["approve", release.id], deps)).toBe(1);
    expect(out).toEqual([
      "probe 2.0.0 is approved, and probe could not apply it (internal).",
      "Fix the cause, then approve it again.",
    ]);
    expect(out.join("\n")).not.toContain("sk-live");
    r.probe.applyFailure = null;
    out.length = 0;
    expect(await runReleasesVerb(["approve", release.id], deps)).toBe(0);
    expect(out).toEqual(["probe 2.0.0 is approved and installed."]);
  });

  test("a decision the Fortress will not carry out is a failed act, with a sentence", async () => {
    const { r, deps, offer } = await withDaemon();
    const release = await offer();
    await runReleasesVerb(["refuse", release.id], deps);
    // Each invocation writes its own spool file; a second apart, they sort.
    r.now.value = new Date(r.now.value.getTime() + 1_000);
    await expect(runReleasesVerb(["approve", release.id], deps)).rejects.toThrow(
      "probe 2.0.0 is refused, so there is nothing to decide.",
    );
    const second = await offer("2.1.0");
    r.now.value = new Date(r.now.value.getTime() + 1_000);
    await r.registry.stopOne("probe");
    await expect(runReleasesVerb(["approve", second.id], deps)).rejects.toThrow(
      "probe is switched on and is not running. `hx-fortress logs --module probe` says why.",
    );
    const outcomes = (await cliRecords(r.paths)).filter(([, kind]) => kind === "outcome").map(([action, , outcome]) => [action, outcome]);
    expect(outcomes).toEqual([
      ["cli.release.refuse", "done"],
      ["cli.release.approve", "failed"],
      ["cli.release.approve", "failed"],
    ]);
  });

  test("with no daemon: refused by name, exit 1, and nothing is left to run later", async () => {
    const { r, offer } = await withDaemon();
    const release = await offer();
    // Through the real dispatch: there is no status file from a live daemon.
    await publishStatus(r.paths, [], { state: "stopped" });
    const { code, out } = await cli(r.paths, "releases", "approve", release.id);
    expect(code).toBe(1);
    expect(out).toEqual([
      "error: the daemon is not running, and it is the only thing that can hand a release to its module. " +
        "Start it with `hx-fortress start`, then run this again.",
    ]);
    await r.host.applyRequests();
    expect(r.probe.applied).toEqual([]);
  });

  test("an id that is not on the shelf, or not an id, is refused before anything is written", async () => {
    const paths = await bareRoot(["session_vault"]);
    expect(await cli(paths, "releases", "approve", "rel-0123456789abcdef")).toEqual({
      code: 1,
      out: ["error: there is no release rel-0123456789abcdef on this Fortress. `hx-fortress releases list` shows them."],
    });
    expect(await cli(paths, "releases", "approve", "../../etc/passwd")).toEqual({
      code: 1,
      out: ["error: that is not a release id. `hx-fortress releases list` shows them."],
    });
    for (const args of [["releases"], ["releases", "approve"], ["releases", "install", "x"], ["releases", "refuse", "a", "b"]]) {
      expect(await cli(paths, ...args)).toEqual({
        code: 1,
        out: ["error: usage: hx-fortress releases list | approve <id> | refuse <id>"],
      });
    }
    expect(await cliRecords(paths)).toEqual([]);
  });

  test("a daemon that has not answered yet is reported as that, not as a result", async () => {
    const { deps, out, offer } = await withDaemon();
    const release = await offer();
    expect(await runReleasesVerb(["approve", release.id], { ...deps, kill: () => true, waitMs: 20 })).toBe(0);
    expect(out).toEqual([
      "Asked the Fortress to approve probe 2.0.0.",
      "It has not answered yet. `hx-fortress releases list` shows where the release stands.",
    ]);
  });
});

describe("the shelf file", () => {
  test("is owner-only, and holds no artifact bytes or URL", async () => {
    const { r, offer } = await withDaemon();
    await offer();
    expect((await Bun.file(r.paths.moduleReleases).stat()).mode & 0o777).toBe(0o600);
    const text = await readFile(r.paths.moduleReleases, "utf8");
    expect(text).not.toContain("releases.example");
    expect(text).not.toContain("release bytes");
  });
});
