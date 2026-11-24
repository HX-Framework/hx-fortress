// `hx-fortress control-plane`: what a person on the host reads about the
// connection, and the one decision made here, which key of the control plane
// this HX Fortress trusts.
//
// What is shown is what the RUNNING daemon goes by: its environment may name
// the key where this terminal's does not, or the other way round. A daemon
// writes down what its environment names when it starts
// (src/host/daemon-environment.ts), and these tests write that file as a
// daemon would. Every key is made for the test, and no test reads the status
// of a daemon on this computer: each one says which daemon runs, if any.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli";
import { runControlPlaneVerb, type ControlPlaneVerbDeps } from "../src/cli-control-plane";
import { AUDIT_ACTIONS, sanitizeParams } from "../src/console/audit-actions";
import { listSpoolFiles, readSpoolFile } from "../src/console/audit-spool";
import { publishDaemonEnvironment, type Named } from "../src/host/daemon-environment";
import { fortressPaths } from "../src/host/paths";
import {
  CONTROL_PLANE_KEY_ENV,
  ControlPlaneKeyStore,
  controlPlaneKeyNamedBy,
  keyFingerprint,
  type ControlPlaneKey,
} from "../src/host/trust/control-plane-keys";
import { SETUP_MARK_KEY, setupMark } from "../src/setup/state";

const ADDRESS = "wss://control.example/v1/connection";
const KEYS_URL = "https://control.example/v1/control-plane-keys";
/** The process id these tests give for a daemon that runs. No process has to have it. */
const DAEMON_PID = 424_242;
/** Put together at run time, so that no text in this file has the shape of a secret. */
const CREDENTIAL = ["a", "test", "credential"].join("-");
/** The line the part about the control plane's key starts with. */
const KEY_PART = "The control plane's key, which a change of the organization's key is checked against";

type Paths = ReturnType<typeof fortressPaths>;

async function makeKey(id: string): Promise<ControlPlaneKey> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { id, publicKey: Buffer.from(raw).toString("base64url") };
}

/** An environment that names these keys. */
const naming = (...keys: ControlPlaneKey[]): Record<string, string> => ({
  [CONTROL_PLANE_KEY_ENV]: keys.map((key) => `${key.id}:${key.publicKey}`).join(","),
});

let root: string | null = null;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

/**
 * An HX Fortress's folder. `enrolled` writes the credential an HX Fortress
 * holds once it is connected. `switchedOffFrom` writes the mark the setup
 * leaves when a person switched the connection off: config.json then names no
 * control plane, unless `address` is given too.
 */
async function fortressFolder(
  options: {
    address?: string | null;
    enrolled?: boolean;
    config?: Record<string, unknown>;
    switchedOffFrom?: string;
  } = {},
): Promise<Paths> {
  root = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-control-plane-verb-"));
  const paths = fortressPaths(root);
  const address = options.address !== undefined ? options.address : options.switchedOffFrom ? null : ADDRESS;
  if (address !== null || options.config || options.switchedOffFrom) {
    await writeFile(
      paths.config,
      JSON.stringify({
        schemaVersion: 1,
        ...(address !== null ? { cloud: { url: address } } : {}),
        modules: { enabled: [] },
        ...(options.switchedOffFrom
          ? {
              [SETUP_MARK_KEY]: {
                ...setupMark("terminal", new Date("2026-11-10T09:00:00.000Z")),
                disconnectedFrom: options.switchedOffFrom,
              },
            }
          : {}),
        ...options.config,
      }),
    );
  }
  if (options.enrolled) {
    await mkdir(path.dirname(paths.credentials), { recursive: true });
    await writeFile(
      paths.credentials,
      JSON.stringify({ orgId: "org-northstar", fortressId: "fortress-1", credential: CREDENTIAL }),
    );
  }
  return paths;
}

/** What a daemon that starts with `env` writes down about its environment. */
async function daemonStartedWith(
  paths: Paths,
  env: Record<string, string | undefined>,
  pid = DAEMON_PID,
): Promise<void> {
  await daemonWroteDown(paths, controlPlaneKeyNamedBy(env), pid);
}

/** The daemon's file, holding exactly `controlPlaneKey`. */
async function daemonWroteDown(paths: Paths, controlPlaneKey: Named<unknown>, pid = DAEMON_PID): Promise<void> {
  expect(await publishDaemonEnvironment(paths, { updateUrl: null, controlPlaneKey }, { pid })).toBe(true);
}

/** The daemon that wrote its file with DAEMON_PID is the one that runs. */
const daemonRuns: Partial<ControlPlaneVerbDeps> = { daemonPid: async () => DAEMON_PID };

function publishing(keys: readonly ControlPlaneKey[] | "none" | "down"): { fetchImpl: typeof fetch; asked: string[] } {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    asked.push(String(input));
    if (keys === "down") throw new Error("connect ECONNREFUSED");
    if (keys === "none") return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ v: 1, keys }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, asked };
}

async function verb(
  args: readonly string[],
  deps: Partial<ControlPlaneVerbDeps> = {},
): Promise<{ code: number; out: string[]; text: string; error: string | null }> {
  const out: string[] = [];
  try {
    const code = await runControlPlaneVerb(args, {
      writeLine: (line) => out.push(line),
      fortressRoot: root ?? undefined,
      env: {},
      interactive: false,
      // No daemon runs, unless the test says one does.
      daemonPid: async () => null,
      ...deps,
    });
    return { code, out, text: out.join("\n"), error: null };
  } catch (error) {
    return { code: 1, out, text: out.join("\n"), error: (error as Error).message };
  }
}

/** The part of what `hx-fortress control-plane` printed that is about the control plane's key. */
function keyPart(run: { out: string[] }): string[] {
  const start = run.out.indexOf(KEY_PART);
  return start < 0 ? [`(no line "${KEY_PART}" in what was printed)`, ...run.out] : run.out.slice(start);
}

async function auditRecords(paths: Paths): Promise<{ action: string; params: unknown; outcome?: string | null }[]> {
  const records = [];
  for (const file of await listSpoolFiles(paths.auditSpool)) {
    for (const record of await readSpoolFile(file.path)) {
      records.push({ action: record.action, params: record.params, outcome: record.outcome });
    }
  }
  return records;
}

describe("hx-fortress control-plane", () => {
  test("an HX Fortress with no control plane says so, and that it runs on its own", async () => {
    await fortressFolder({ address: null, config: {} });
    expect(await verb([])).toEqual({
      code: 0,
      out: ["No control plane. This HX Fortress runs on its own."],
      text: "No control plane. This HX Fortress runs on its own.",
      error: null,
    });
    // An HX Fortress that was never set up reads the same.
    await rm(root as string, { recursive: true, force: true });
    await fortressFolder({ address: null });
    expect((await verb([])).out).toEqual(["No control plane. This HX Fortress runs on its own."]);
  });

  test("a connected HX Fortress with no key of its control plane shows the address, the organization, and how to pin a key", async () => {
    await fortressFolder({ enrolled: true });
    const run = await verb([]);
    expect(run.code).toBe(0);
    expect(run.out).toEqual([
      "Control plane:  control.example",
      `  Address:      ${ADDRESS}`,
      "  Organization: org-northstar",
      "  This HX Fortress: fortress-1",
      "  `hx-fortress status` says whether the connection is open now.",
      "",
      "The organization's key, which the control plane signs its grants with",
      "  none pinned yet. It is pinned when this HX Fortress first connects.",
      "",
      KEY_PART,
      "  none pinned.",
      "  With no key pinned, a change of the organization's key is refused.",
      "  To pin the key the control plane publishes: hx-fortress control-plane pin",
    ]);
    // The credential itself is never printed.
    expect(run.text).not.toContain(CREDENTIAL);
  });

  test("an HX Fortress that holds no credential for its control plane says it is not connected yet", async () => {
    await fortressFolder();
    expect((await verb([])).out.slice(0, 4)).toEqual([
      "Control plane:  control.example",
      `  Address:      ${ADDRESS}`,
      "  Not connected yet: this HX Fortress holds no credential for it.",
      "  `hx-fortress status` says whether the connection is open now.",
    ]);
  });

  test("it shows the organization's key by its fingerprint, and whether a proof was checked", async () => {
    const paths = await fortressFolder({ enrolled: true });
    const organizationKey = await makeKey("organization");
    const record = { key: organizationKey.publicKey, pinnedAt: "2026-11-12T09:00:00.000Z", notBefore: null };
    await writeFile(paths.signingKey, JSON.stringify({ ...record, rootVerified: false }));
    const unproved = (await verb([])).text;
    expect(unproved).toContain(`${keyFingerprint(organizationKey)}   pinned 2026-11-12`);
    expect(unproved).toContain("It was pinned when first seen, with no proof checked.");
    expect(unproved).not.toContain(organizationKey.publicKey);

    await writeFile(paths.signingKey, JSON.stringify({ ...record, rootVerified: true }));
    expect((await verb([])).text).toContain("It came with a proof that was checked against the control plane's key.");
  });

  test("with no environment naming the key, a pin decides: one a person made, or one made at the first connection", async () => {
    const key = await makeKey("cp-2026-11");
    const paths = await fortressFolder({ enrolled: true });
    const store = new ControlPlaneKeyStore(paths, {});
    await store.pin(ADDRESS, [key], "person", new Date("2026-11-12T09:00:00.000Z"));
    expect(keyPart(await verb([]))).toEqual([
      KEY_PART,
      `  ${keyFingerprint(key)}   cp-2026-11`,
      "  Pinned by a person on this host on 2026-11-12.",
    ]);
    await store.pin(ADDRESS, [key], "enrollment", new Date("2026-11-12T09:00:00.000Z"));
    expect(keyPart(await verb([]))).toEqual([
      KEY_PART,
      `  ${keyFingerprint(key)}   cp-2026-11`,
      "  Pinned on 2026-11-12, when this HX Fortress first connected. Nobody compared the fingerprint then.",
    ]);
  });

  test("a pin made for the same control plane at the earlier path of the protocol is this control plane's", async () => {
    const key = await makeKey("cp-2026-11");
    const paths = await fortressFolder({ enrolled: true });
    await new ControlPlaneKeyStore(paths, {}).pin(
      "wss://control.example/_api/hx-gateway/vault-tunnel",
      [key],
      "person",
      new Date("2026-11-12T09:00:00.000Z"),
    );
    expect(keyPart(await verb([]))).toEqual([
      KEY_PART,
      `  ${keyFingerprint(key)}   cp-2026-11`,
      "  Pinned by a person on this host on 2026-11-12.",
    ]);
  });

  test("a pin made for another control plane is named as such, by the address a person would give", async () => {
    const paths = await fortressFolder({ enrolled: true });
    await new ControlPlaneKeyStore(paths, {}).pin("wss://old.control.example/v1/connection", [await makeKey("old")], "person");
    expect(keyPart(await verb([]))).toEqual([
      KEY_PART,
      "  none for this control plane. A key is pinned for old.control.example, which is another one.",
      "  With no key pinned, a change of the organization's key is refused.",
      "  To pin the key the control plane publishes: hx-fortress control-plane pin",
    ]);
  });

  test("while HX Fortress runs and its environment names the key, that key decides, whatever this terminal names and whatever is pinned", async () => {
    const paths = await fortressFolder({ enrolled: true });
    const [now, next] = [await makeKey("cp-now"), await makeKey("cp-next")];
    await new ControlPlaneKeyStore(paths, {}).pin(ADDRESS, [await makeKey("cp-pinned")], "person");
    await daemonStartedWith(paths, naming(now, next));
    expect(keyPart(await verb([], { ...daemonRuns, env: naming(await makeKey("cp-terminal")) }))).toEqual([
      KEY_PART,
      `  ${keyFingerprint(now)}   cp-now`,
      `  ${keyFingerprint(next)}   cp-next`,
      "  Named by FORTRESS_CONTROL_PLANE_KEY in the environment HX Fortress runs with. Nothing a control plane publishes changes it.",
    ]);
  });

  test("while HX Fortress runs and its environment names a value that is not a key, no key is trusted, and the words say where the value is", async () => {
    const paths = await fortressFolder({ enrolled: true });
    await new ControlPlaneKeyStore(paths, {}).pin(ADDRESS, [await makeKey("cp-pinned")], "person");
    await daemonStartedWith(paths, { [CONTROL_PLANE_KEY_ENV]: "no-colon" });
    expect(keyPart(await verb([], { ...daemonRuns, env: naming(await makeKey("cp-terminal")) }))).toEqual([
      KEY_PART,
      "  The key named in the environment HX Fortress runs with cannot be used: FORTRESS_CONTROL_PLANE_KEY must be written as <id>:<publicKey>.",
      "  No key is trusted until that setting is corrected.",
    ]);

    // The file is checked again as the variable itself would be: a value that
    // no daemon writes is not taken as keys.
    await daemonWroteDown(paths, { value: [{ id: "a", publicKey: "short" }] });
    expect(keyPart(await verb([], daemonRuns))).toEqual([
      KEY_PART,
      "  The key named in the environment HX Fortress runs with cannot be used: the publicKey of key 1 of FORTRESS_CONTROL_PLANE_KEY must be a 32-byte Ed25519 public key in base64url, 43 characters.",
      "  No key is trusted until that setting is corrected.",
    ]);
    await daemonWroteDown(paths, { value: "a text" });
    expect((await verb([], daemonRuns)).text).toContain("FORTRESS_CONTROL_PLANE_KEY must be a list of keys");
  });

  test("a daemon's file that names an empty list of keys is not taken as a key that is named, because the variable itself cannot be empty", async () => {
    // FORTRESS_CONTROL_PLANE_KEY="" is refused as "set and empty", so no
    // daemon writes an empty list: only a hand can. Read as the variable
    // would be, it is a value that cannot be used.
    const paths = await fortressFolder({ enrolled: true });
    await daemonWroteDown(paths, { value: [] });
    const part = keyPart(await verb([], daemonRuns));
    expect(part[1]).toStartWith("  The key named in the environment HX Fortress runs with cannot be used: ");
    expect(part).toContain("  No key is trusted until that setting is corrected.");
  });

  test("while HX Fortress runs and its environment names no key, a pin decides, and a variable in this terminal is said not to count", async () => {
    const paths = await fortressFolder({ enrolled: true });
    const pinned = await makeKey("cp-pinned");
    await new ControlPlaneKeyStore(paths, {}).pin(ADDRESS, [pinned], "person", new Date("2026-11-12T09:00:00.000Z"));
    await daemonStartedWith(paths, {});
    expect(keyPart(await verb([], { ...daemonRuns, env: naming(await makeKey("cp-terminal")) }))).toEqual([
      KEY_PART,
      `  ${keyFingerprint(pinned)}   cp-pinned`,
      "  Pinned by a person on this host on 2026-11-12.",
      "  This terminal's environment has FORTRESS_CONTROL_PLANE_KEY, and the running HX Fortress does not: it goes by what is shown here.",
    ]);
    // With nothing in this terminal either, there is nothing more to say.
    expect(keyPart(await verb([], daemonRuns))).toEqual([
      KEY_PART,
      `  ${keyFingerprint(pinned)}   cp-pinned`,
      "  Pinned by a person on this host on 2026-11-12.",
    ]);
  });

  test("with HX Fortress not running, this terminal's own variable is shown, with the words that the service must have it too, and a file of a daemon that stopped does not decide", async () => {
    const paths = await fortressFolder({ enrolled: true });
    const inTerminal = await makeKey("cp-terminal");
    // Written by a daemon that ran with another key, and does not run now.
    await daemonStartedWith(paths, naming(await makeKey("cp-service")));
    expect(keyPart(await verb([], { env: naming(inTerminal) }))).toEqual([
      KEY_PART,
      `  ${keyFingerprint(inTerminal)}   cp-terminal`,
      "  Named by FORTRESS_CONTROL_PLANE_KEY in this terminal's environment. Nothing a control plane publishes changes it.",
      "  HX Fortress is not running. It goes by this key only if the environment it starts with has the variable too.",
    ]);
  });

  test("with HX Fortress not running, a key its environment named when it last ran is mentioned, because that variable decides again if the service still has it", async () => {
    const paths = await fortressFolder({ enrolled: true });
    await daemonStartedWith(paths, naming(await makeKey("cp-service")));
    expect(keyPart(await verb([]))).toEqual([
      KEY_PART,
      "  none pinned.",
      "  With no key pinned, a change of the organization's key is refused.",
      "  To pin the key the control plane publishes: hx-fortress control-plane pin",
      "  HX Fortress is not running. When it last ran, its environment had FORTRESS_CONTROL_PLANE_KEY. If it still has it when it starts, that variable decides, and a pin is not used.",
    ]);
    // A daemon that named no key when it last ran leaves nothing to say.
    await daemonStartedWith(paths, {});
    expect(keyPart(await verb([])).at(-1)).toBe("  To pin the key the control plane publishes: hx-fortress control-plane pin");
  });

  test("with HX Fortress not running, a value in this terminal that is not a key is reported, and the words say for which environment it counts", async () => {
    // The terminal's variable is not the daemon's. What the line promises is
    // only what holds: with the same value where HX Fortress runs, no key is
    // trusted.
    await fortressFolder({ enrolled: true });
    expect(keyPart(await verb([], { env: { [CONTROL_PLANE_KEY_ENV]: "no-colon" } }))).toEqual([
      KEY_PART,
      "  The key named in this terminal's environment cannot be used: FORTRESS_CONTROL_PLANE_KEY must be written as <id>:<publicKey>.",
      "  With the same value in the environment HX Fortress runs with, no key is trusted until that setting is corrected.",
    ]);
  });

  test("while HX Fortress runs, the words never say that it is not running, also when the daemon that runs wrote nothing down about its environment", async () => {
    // The daemon that runs could not write its file (it says so in its own
    // log), or the file there is one an earlier daemon left. Either way this
    // terminal cannot see what the running daemon's environment names, and
    // the daemon is still running.
    const paths = await fortressFolder({ enrolled: true });
    const noFile = (await verb([], { ...daemonRuns, env: naming(await makeKey("cp-terminal")) })).text;
    await daemonStartedWith(paths, naming(await makeKey("cp-service")), DAEMON_PID - 1);
    const earlierDaemonsFile = (await verb([], daemonRuns)).text;
    expect([noFile, earlierDaemonsFile].filter((text) => text.includes("HX Fortress is not running"))).toEqual([]);
  });

  test("with the connection switched off, the control plane is the one the setup wrote down, and the words say the connection is switched off", async () => {
    const paths = await fortressFolder({ enrolled: true, switchedOffFrom: ADDRESS });
    const pinned = await makeKey("cp-pinned");
    await new ControlPlaneKeyStore(paths, {}).pin(ADDRESS, [pinned], "person", new Date("2026-11-12T09:00:00.000Z"));
    expect((await verb([])).out).toEqual([
      "Control plane:  control.example",
      `  Address:      ${ADDRESS}`,
      "  Organization: org-northstar",
      "  This HX Fortress: fortress-1",
      "  The connection is switched off. HX Fortress keeps what it needs to connect again.",
      "",
      "The organization's key, which the control plane signs its grants with",
      "  none pinned yet. It is pinned when this HX Fortress first connects.",
      "",
      KEY_PART,
      `  ${keyFingerprint(pinned)}   cp-pinned`,
      "  Pinned by a person on this host on 2026-11-12.",
    ]);
  });

  test("the address in config.json wins over one the setup wrote down when the connection was switched off", async () => {
    await fortressFolder({ enrolled: true, address: ADDRESS, switchedOffFrom: "wss://old.control.example/v1/connection" });
    const run = await verb([]);
    expect(run.out.slice(0, 2)).toEqual(["Control plane:  control.example", `  Address:      ${ADDRESS}`]);
    expect(run.out).toContain("  `hx-fortress status` says whether the connection is open now.");
    expect(run.text).not.toContain("switched off");
  });
});

describe("hx-fortress control-plane pin", () => {
  test("with a person at the terminal it shows every fingerprint, asks, pins on yes, and records it by the control plane's address", async () => {
    const paths = await fortressFolder({ enrolled: true });
    const [now, next] = [await makeKey("cp-now"), await makeKey("cp-next")];
    const cp = publishing([now, next]);
    const asked: string[] = [];
    const run = await verb(["pin"], {
      fetchImpl: cp.fetchImpl,
      interactive: true,
      confirm: async (question) => {
        asked.push(question);
        return true;
      },
      now: () => new Date("2026-11-12T09:00:00.000Z"),
    });
    expect(run.error).toBeNull();
    expect(run.code).toBe(0);
    expect(cp.asked).toEqual([KEYS_URL]);
    expect(run.out).toEqual([
      "The control plane at control.example publishes these keys:",
      `  ${keyFingerprint(now)}   cp-now`,
      `  ${keyFingerprint(next)}   cp-next`,
      "Compare each fingerprint with what the control plane states about itself.",
      "Pinned 2 keys.",
      "A change of the organization's key is checked against it from the next connection on.",
      "If such a change was refused before, restart HX Fortress to take it now: hx-fortress stop, then hx-fortress start",
    ]);
    expect(asked).toEqual(["Pin these 2 keys?"]);
    expect(await new ControlPlaneKeyStore(paths, {}).readPin()).toEqual({
      v: 1,
      address: ADDRESS,
      keys: [now, next],
      pinnedAt: "2026-11-12T09:00:00.000Z",
      how: "person",
    });
    expect(await new ControlPlaneKeyStore(paths, {}).trusted(ADDRESS)).toEqual([now, next]);
    // The act is in the audit trail, with fingerprints and no key material.
    const records = await auditRecords(paths);
    expect(records.map((record) => record.action)).toEqual(["cli.control_plane.pin", "cli.control_plane.pin"]);
    const params = {
      controlPlane: "control.example",
      ids: "cp-now, cp-next",
      fingerprints: `${keyFingerprint(now)}, ${keyFingerprint(next)}`,
    };
    expect(records[0]?.params).toEqual(params);
    // Each of them reaches the trail: none is dropped on the way in.
    expect(sanitizeParams(AUDIT_ACTIONS.cliControlPlanePin, params)).toEqual(params);
    expect(records[1]?.outcome).toBe("done");
  });

  test("a no leaves everything as it was", async () => {
    const paths = await fortressFolder({ enrolled: true });
    const run = await verb(["pin"], {
      fetchImpl: publishing([await makeKey("cp-now")]).fetchImpl,
      interactive: true,
      confirm: async () => false,
    });
    expect(run.code).toBe(1);
    expect(run.out).toContain("Nothing was pinned.");
    expect(await new ControlPlaneKeyStore(paths, {}).readPin()).toBeNull();
    expect(await auditRecords(paths)).toEqual([]);
  });

  test("with nobody at the terminal it needs the fingerprint, and pins only what was named", async () => {
    const paths = await fortressFolder({ enrolled: true });
    const [now, next] = [await makeKey("cp-now"), await makeKey("cp-next")];
    const cp = publishing([now, next]);
    const refused = await verb(["pin"], { fetchImpl: cp.fetchImpl });
    expect(refused.error).toContain("nobody is at this terminal to compare the fingerprint");
    expect(await new ControlPlaneKeyStore(paths, {}).readPin()).toBeNull();

    const typed = keyFingerprint(now).toUpperCase().replace(/ /g, ":");
    const run = await verb(["pin", "--fingerprint", typed], { fetchImpl: cp.fetchImpl });
    expect(run.error).toBeNull();
    expect(run.out).toContain("Pinned.");
    expect(await new ControlPlaneKeyStore(paths, {}).trusted(ADDRESS)).toEqual([now]);
  });

  test("a fingerprint the control plane does not publish pins nothing", async () => {
    const paths = await fortressFolder({ enrolled: true });
    const other = keyFingerprint(await makeKey("someone-else"));
    const run = await verb(["pin", "--fingerprint", other], { fetchImpl: publishing([await makeKey("cp-now")]).fetchImpl });
    expect(run.error).toBe(`the control plane publishes no key with the fingerprint ${other}. Nothing was pinned`);
    expect(await new ControlPlaneKeyStore(paths, {}).readPin()).toBeNull();
    expect(await auditRecords(paths)).toEqual([]);
  });

  test("a control plane that publishes no key, or does not answer, pins nothing", async () => {
    const paths = await fortressFolder({ enrolled: true });
    const none = await verb(["pin"], { fetchImpl: publishing("none").fetchImpl, interactive: true, confirm: async () => true });
    expect(none.code).toBe(1);
    expect(none.out).toEqual(["The control plane at control.example publishes no key. Nothing was pinned."]);
    const down = await verb(["pin"], { fetchImpl: publishing("down").fetchImpl, interactive: true, confirm: async () => true });
    expect(down.error).toBe("the control plane did not answer when asked for its key");
    expect(await new ControlPlaneKeyStore(paths, {}).readPin()).toBeNull();
  });

  test("it refuses while the environment HX Fortress runs with names the key, or a value that is not one, and asks nothing", async () => {
    const paths = await fortressFolder({ enrolled: true });
    const key = await makeKey("cp-now");
    const cp = publishing([key]);
    await daemonStartedWith(paths, naming(await makeKey("cp-service")));
    const named = await verb(["pin", "--fingerprint", keyFingerprint(key)], { ...daemonRuns, fetchImpl: cp.fetchImpl });
    expect(named.error).toBe(
      "the environment HX Fortress runs with names the control plane's key in FORTRESS_CONTROL_PLANE_KEY, so a pin would not be used. " +
        "Change that setting to change the key",
    );

    await daemonStartedWith(paths, { [CONTROL_PLANE_KEY_ENV]: "no-colon" });
    const invalid = await verb(["pin", "--fingerprint", keyFingerprint(key)], { ...daemonRuns, fetchImpl: cp.fetchImpl });
    expect(invalid.error).toBe(
      "the key named in the environment HX Fortress runs with (FORTRESS_CONTROL_PLANE_KEY) cannot be used: " +
        "FORTRESS_CONTROL_PLANE_KEY must be written as <id>:<publicKey>. " +
        "Correct or remove that setting first: while it is there, a pin is not used",
    );
    expect(cp.asked).toEqual([]);
    expect(await new ControlPlaneKeyStore(paths, {}).readPin()).toBeNull();
    expect(await auditRecords(paths)).toEqual([]);
  });

  test("with HX Fortress not running, it refuses while this terminal names the key, or a value that is not one, and says how to pin one", async () => {
    const paths = await fortressFolder({ enrolled: true });
    const key = await makeKey("cp-now");
    const cp = publishing([key]);
    const named = await verb(["pin", "--fingerprint", keyFingerprint(key)], { fetchImpl: cp.fetchImpl, env: naming(key) });
    expect(named.error).toBe(
      "this terminal's environment names the control plane's key in FORTRESS_CONTROL_PLANE_KEY, so a pin would not be used. " +
        "Change that setting to change the key, or run this command without the variable to pin one",
    );
    const invalid = await verb(["pin", "--fingerprint", keyFingerprint(key)], {
      fetchImpl: cp.fetchImpl,
      env: { [CONTROL_PLANE_KEY_ENV]: "no-colon" },
    });
    expect(invalid.error).toBe(
      "the key named in this terminal's environment (FORTRESS_CONTROL_PLANE_KEY) cannot be used: " +
        "FORTRESS_CONTROL_PLANE_KEY must be written as <id>:<publicKey>. " +
        "Correct or remove that setting first: while it is there, a pin is not used",
    );
    expect(cp.asked).toEqual([]);
    expect(await new ControlPlaneKeyStore(paths, {}).readPin()).toBeNull();
  });

  test("while HX Fortress runs with no key in its environment, a variable in this terminal does not stop a pin, and the words say it does not count", async () => {
    const paths = await fortressFolder({ enrolled: true });
    const key = await makeKey("cp-now");
    await daemonStartedWith(paths, {});
    const run = await verb(["pin", "--fingerprint", keyFingerprint(key)], {
      ...daemonRuns,
      env: naming(await makeKey("cp-terminal")),
      fetchImpl: publishing([key]).fetchImpl,
    });
    expect(run.error).toBeNull();
    expect(run.out).toContain("Pinned.");
    expect(run.out.at(-1)).toBe(
      "This terminal's environment has FORTRESS_CONTROL_PLANE_KEY, and the running HX Fortress does not: it goes by what is shown here.",
    );
    expect((await new ControlPlaneKeyStore(paths, {}).readPin())?.keys).toEqual([key]);
  });

  test("with the connection switched off, it asks the control plane the setup wrote down, and pins for it", async () => {
    const paths = await fortressFolder({ enrolled: true, switchedOffFrom: ADDRESS });
    const key = await makeKey("cp-now");
    const cp = publishing([key]);
    const run = await verb(["pin", "--fingerprint", keyFingerprint(key)], { fetchImpl: cp.fetchImpl });
    expect(run.error).toBeNull();
    expect(cp.asked).toEqual([KEYS_URL]);
    expect(await new ControlPlaneKeyStore(paths, {}).readPin()).toMatchObject({ address: ADDRESS, keys: [key], how: "person" });
  });

  test("it refuses where there is no control plane", async () => {
    await fortressFolder({ address: null, config: {} });
    const cp = publishing([await makeKey("cp-now")]);
    expect((await verb(["pin"], { fetchImpl: cp.fetchImpl })).error).toBe(
      "this HX Fortress has no control plane, so there is no key to pin",
    );
    expect(cp.asked).toEqual([]);
  });

  test("pinning the key that a person already pinned changes nothing and writes no record", async () => {
    const paths = await fortressFolder({ enrolled: true });
    const key = await makeKey("cp-now");
    const store = new ControlPlaneKeyStore(paths, {});
    const pin = await store.pin(ADDRESS, [key], "person", new Date("2026-11-01T00:00:00.000Z"));
    const run = await verb(["pin", "--fingerprint", keyFingerprint(key)], { fetchImpl: publishing([key]).fetchImpl });
    expect(run.out).toContain("This key is already pinned.");
    expect(await store.readPin()).toEqual(pin);
    expect(await auditRecords(paths)).toEqual([]);
  });

  test("a key the first connection pinned becomes a person's pin once a person confirms it", async () => {
    const paths = await fortressFolder({ enrolled: true });
    const key = await makeKey("cp-now");
    const store = new ControlPlaneKeyStore(paths, {});
    await store.pin(ADDRESS, [key], "enrollment");
    const run = await verb(["pin", "--fingerprint", keyFingerprint(key)], { fetchImpl: publishing([key]).fetchImpl });
    expect(run.out).toContain("Pinned.");
    expect((await store.readPin())?.how).toBe("person");
  });
});

describe("hx-fortress control-plane unpin", () => {
  test("stops trusting the pinned key, and records it by the control plane's address", async () => {
    const paths = await fortressFolder({ enrolled: true });
    const key = await makeKey("cp-now");
    const store = new ControlPlaneKeyStore(paths, {});
    await store.pin(ADDRESS, [key], "person");
    const run = await verb(["unpin"]);
    expect(run.out).toEqual([
      "The key pinned for control.example is no longer trusted.",
      "Until a key is pinned again, a change of the organization's key is refused.",
    ]);
    expect(await store.readPin()).toBeNull();
    const records = await auditRecords(paths);
    expect(records.map((record) => record.action)).toEqual(["cli.control_plane.unpin", "cli.control_plane.unpin"]);
    const params = { controlPlane: "control.example", ids: "cp-now", fingerprints: keyFingerprint(key) };
    expect(records[0]?.params).toEqual(params);
    expect(sanitizeParams(AUDIT_ACTIONS.cliControlPlaneUnpin, params)).toEqual(params);
    expect((await verb(["unpin"])).out).toEqual(["No key of a control plane is pinned."]);
  });

  test("while an environment names the key, it says that key is still the one in force", async () => {
    const paths = await fortressFolder({ enrolled: true });
    const store = new ControlPlaneKeyStore(paths, {});
    await store.pin(ADDRESS, [await makeKey("cp-pinned")], "person");
    await daemonStartedWith(paths, naming(await makeKey("cp-service")));
    expect((await verb(["unpin"], daemonRuns)).out).toEqual([
      "The key pinned for control.example is no longer trusted.",
      "The key that the environment HX Fortress runs with names in FORTRESS_CONTROL_PLANE_KEY is still the one in force.",
    ]);

    await store.pin(ADDRESS, [await makeKey("cp-pinned")], "person");
    expect((await verb(["unpin"], { env: naming(await makeKey("cp-terminal")) })).out).toEqual([
      "The key pinned for control.example is no longer trusted.",
      "The key that this terminal's environment names in FORTRESS_CONTROL_PLANE_KEY is still the one in force.",
    ]);
  });

  test("while the environment HX Fortress runs with holds a value that is not a key, it does not say that a new pin ends the refusal", async () => {
    // While that value is there no key is trusted, and `pin` refuses: the
    // setting is what has to change.
    const paths = await fortressFolder({ enrolled: true });
    await new ControlPlaneKeyStore(paths, {}).pin(ADDRESS, [await makeKey("cp-pinned")], "person");
    await daemonStartedWith(paths, { [CONTROL_PLANE_KEY_ENV]: "no-colon" });
    const run = await verb(["unpin"], daemonRuns);
    expect(run.out[0]).toBe("The key pinned for control.example is no longer trusted.");
    expect(run.text).not.toContain("Until a key is pinned again");
    expect(run.text).toContain(CONTROL_PLANE_KEY_ENV);
  });
});

describe("the verb in the command line", () => {
  test("is reached through hx-fortress, and an unknown form prints how it is used", async () => {
    // A folder with no control plane: the verb ends before it asks which
    // daemon runs, which runCli does not let a test say.
    await fortressFolder({ address: null, config: {} });
    const out: string[] = [];
    expect(await runCli(["control-plane"], { writeLine: (line) => out.push(line), fortressRoot: root as string })).toBe(0);
    expect(out).toEqual(["No control plane. This HX Fortress runs on its own."]);
    const wrong: string[] = [];
    expect(
      await runCli(["control-plane", "trust"], { writeLine: (line) => wrong.push(line), fortressRoot: root as string }),
    ).toBe(1);
    expect(wrong.join("\n")).toContain("usage: hx-fortress control-plane");
  });

  test("hx-fortress hands the verb the environment and the running daemon it was given", async () => {
    // Both decide what the verb says: without them it would read this test
    // process's own environment and this Mac's own status file.
    const paths = await fortressFolder({ enrolled: true });
    const service = await makeKey("cp-service");
    const terminal = await makeKey("cp-terminal");
    await daemonStartedWith(paths, naming(service));

    // A daemon runs: its environment decides, and the terminal's own does not.
    const running: string[] = [];
    expect(
      await runCli(["control-plane"], {
        writeLine: (line) => running.push(line),
        fortressRoot: root as string,
        env: naming(terminal),
        daemonPid: async () => DAEMON_PID,
      }),
    ).toBe(0);
    expect(running.join("\n")).toContain(`${keyFingerprint(service)}   cp-service`);
    expect(running.join("\n")).toContain("Named by FORTRESS_CONTROL_PLANE_KEY in the environment HX Fortress runs with.");
    expect(running.join("\n")).not.toContain("cp-terminal");

    // No daemon runs: the terminal's own environment is what there is.
    const stopped: string[] = [];
    expect(
      await runCli(["control-plane"], {
        writeLine: (line) => stopped.push(line),
        fortressRoot: root as string,
        env: naming(terminal),
        daemonPid: async () => null,
      }),
    ).toBe(0);
    expect(stopped.join("\n")).toContain(`${keyFingerprint(terminal)}   cp-terminal`);
    expect(stopped.join("\n")).toContain("Named by FORTRESS_CONTROL_PLANE_KEY in this terminal's environment.");
  });
});
