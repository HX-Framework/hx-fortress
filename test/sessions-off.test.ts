// A fortress with the Sessions module off: no bucket, no embedding key, and
// nothing about storage told to the hub. It still boots, enrolls, heartbeats
// and answers.
//
// The boots below run the real daemon in a child process with a temporary
// home (test/rig/host-boot.ts) against the loopback hub.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CORE_MODULE_IDS,
  DEFAULT_MODULE_IDS,
  ensureCoreModulesEnabled,
  ensureEnrollmentConfig,
  FileConfigStore,
  sessionsEnabledIn,
  sessionsSettingFromEnv,
  setSessionsEnabled,
} from "../src/host/config";
import { FilePendingEnrollmentStore } from "../src/cloud";
import { AuditSpool } from "../src/console/audit-spool";
import { fortressPaths } from "../src/host/paths";
import createSessionVaultModule from "../src/modules/session-vault/module";
import { runEnrollWizard } from "../src/modules/session-vault/wizard";
import type { FortressToHubFrame } from "../src/protocol";
import { ConsoleAudit } from "../src/ui/audit-writer";
import { createConsoleMount } from "../src/ui/console-mount";
import { createConsoleWritePort } from "../src/ui/console-write-port";
import { SESSIONS_OFF_REFUSAL } from "../src/ui/copy";
import {
  handleMutateRoute,
  MUTATE_PATHS,
  OFFERED_COMMAND_KINDS,
  SESSIONS_COMMAND_KINDS,
  type ConsoleWritePort,
} from "../src/ui/mutate-routes";
import { UiRuntime } from "../src/ui/runtime";
import { bootHost, UNREACHABLE_DATABASE_URL, type HostBoot } from "./rig/host-boot";

const CLOUD = "wss://hub.example.com/vault-tunnel";

describe("which modules a fortress has on", () => {
  let root = "";
  let paths: ReturnType<typeof fortressPaths>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-sessions-off-"));
    paths = fortressPaths(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const enabled = async (): Promise<string[]> => (await new FileConfigStore(paths).load()).modules.enabled;
  const raw = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(paths.config, "utf8")) as Record<string, unknown>;
  const write = (value: unknown): Promise<void> => writeFile(paths.config, JSON.stringify(value));
  const legacy = (modules: string[]): Record<string, unknown> => ({
    schemaVersion: 1,
    cloud: { url: CLOUD },
    gateway: { publicUrl: "https://fortress.example.com" },
    modules: { enabled: modules },
  });

  test("no module is forced on, and Sessions is the default", () => {
    expect([...CORE_MODULE_IDS]).toEqual([]);
    expect([...DEFAULT_MODULE_IDS]).toEqual(["session_vault"]);
  });

  test("a new fortress has Sessions on", async () => {
    await ensureEnrollmentConfig(paths, CLOUD);
    await ensureCoreModulesEnabled(paths);
    expect(await enabled()).toEqual(["session_vault"]);
    expect(sessionsEnabledIn(await new FileConfigStore(paths).load())).toBe(true);
  });

  test("a fortress enrolled before Sessions could be switched off keeps it on", async () => {
    // What an older version left behind, including one that listed no module.
    for (const modules of [["session_vault"], []]) {
      await write(legacy(modules));
      await ensureCoreModulesEnabled(paths);
      expect(await enabled()).toEqual(["session_vault"]);
    }
  });

  test("Sessions switched off stays off at every later boot", async () => {
    await ensureEnrollmentConfig(paths, CLOUD);
    await setSessionsEnabled(paths, false);
    expect(await enabled()).toEqual([]);
    expect((await raw()).moduleDefaultsApplied).toBe(1);

    // Boots with no setting: nothing adds the module back.
    await ensureCoreModulesEnabled(paths);
    await ensureCoreModulesEnabled(paths);
    expect(await enabled()).toEqual([]);
    expect(sessionsEnabledIn(await new FileConfigStore(paths).load())).toBe(false);

    // Enrolling again keeps the choice, too.
    await ensureEnrollmentConfig(paths, "wss://other.example.com/vault-tunnel");
    await ensureCoreModulesEnabled(paths);
    expect(await enabled()).toEqual([]);

    await setSessionsEnabled(paths, true);
    expect(await enabled()).toEqual(["session_vault"]);
  });

  test("switching Sessions leaves every other module and every other key alone", async () => {
    await write({ ...legacy(["session_vault", "another_module"]), secrets: { provider: "file" }, postgres: { port: 6543 } });
    await setSessionsEnabled(paths, false);
    expect(await enabled()).toEqual(["another_module"]);
    const after = await raw();
    expect(after.secrets).toEqual({ provider: "file" });
    expect(after.postgres).toEqual({ port: 6543 });
    await setSessionsEnabled(paths, true);
    expect(await enabled()).toEqual(["another_module", "session_vault"]);
  });

  test("a config that is already right is not rewritten", async () => {
    await ensureEnrollmentConfig(paths, CLOUD);
    await ensureCoreModulesEnabled(paths);
    const before = await readFile(paths.config, "utf8");
    await ensureCoreModulesEnabled(paths);
    await ensureCoreModulesEnabled(paths, { sessions: "on" });
    expect(await readFile(paths.config, "utf8")).toBe(before);
  });

  test("FORTRESS_SESSIONS is on, off, or refused", () => {
    expect(sessionsSettingFromEnv({})).toBeNull();
    expect(sessionsSettingFromEnv({ FORTRESS_SESSIONS: " " })).toBeNull();
    for (const value of ["on", "ON", "true", "1", "yes"]) {
      expect(sessionsSettingFromEnv({ FORTRESS_SESSIONS: value })).toBe("on");
    }
    for (const value of ["off", "Off", "false", "0", "no"]) {
      expect(sessionsSettingFromEnv({ FORTRESS_SESSIONS: value })).toBe("off");
    }
    // A mistyped "off" must not start a fortress that stores sessions.
    for (const value of ["of", "disabled", "none", "2"]) {
      expect(() => sessionsSettingFromEnv({ FORTRESS_SESSIONS: value })).toThrow(
        "FORTRESS_SESSIONS must be on or off",
      );
    }
  });

  test("the secrets block written before the first enrollment is kept", async () => {
    await mkdir(path.dirname(paths.config), { recursive: true });
    await write({ secrets: { provider: "file", dir: "/etc/hx-fortress/secrets" } });
    await ensureEnrollmentConfig(paths, CLOUD);
    const after = await raw();
    expect(after.secrets).toEqual({ provider: "file", dir: "/etc/hx-fortress/secrets" });
    expect(after.cloud).toEqual({ url: CLOUD });
  });
});

describe("the Sessions module in a run that started with Sessions off", () => {
  test("refuses to start, with the reason", async () => {
    const module = createSessionVaultModule({
      refuseStart: () => "Sessions was off when this fortress started. Restart the fortress to turn it on.",
    });
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    await expect(
      module.init?.({ moduleId: "session_vault", logger, fortressIdentity: null }),
    ).rejects.toThrow("Sessions was off when this fortress started. Restart the fortress to turn it on.");
    expect(module.getStore()).toBeNull();
  });
});

/**
 * A temporary fortress root, with HOME pointed at a second temporary
 * directory. The session credentials file is found under HOME, and a test must
 * never read or write the developer's own.
 */
function withTempRootAndHome(): { root: () => string; home: () => string } {
  let root = "";
  let home = "";
  let previousHome: string | undefined;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-sessions-off-root-"));
    home = await mkdtemp(path.join(os.tmpdir(), "hx-sessions-off-home-"));
    previousHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });
  return { root: () => root, home: () => home };
}

describe("setting up a fortress without Sessions", () => {
  const temp = withTempRootAndHome();

  test("the wizard asks for no bucket and no key, records the choice and leaves the token for the daemon", async () => {
    const lines: string[] = [];
    let started = 0;
    await runEnrollWizard(
      { token: "a-one-time-enrollment-token", cloudUrl: CLOUD, log: (m) => lines.push(m), fortressRoot: temp.root() },
      {
        chooseSessions: async () => "off",
        confirmStart: async () => true,
        start: async () => {
          started += 1;
        },
      },
    );

    const paths = fortressPaths(temp.root());
    const config = JSON.parse(await readFile(paths.config, "utf8")) as {
      cloud: { url: string };
      modules: { enabled: string[] };
      moduleDefaultsApplied?: number;
    };
    expect(config.cloud.url).toBe(CLOUD);
    expect(config.modules.enabled).toEqual([]);
    expect(config.moduleDefaultsApplied).toBe(1);
    expect(await new FilePendingEnrollmentStore(paths.pendingEnrollment).load()).toEqual({
      token: "a-one-time-enrollment-token",
      cloudUrl: CLOUD,
    });
    expect(started).toBe(1);
    expect(lines).toContain(
      "Sessions is off. This fortress stores no AI session transcripts and needs no bucket.",
    );
    // No session credentials file was written.
    expect(existsSync(path.join(temp.home(), ".let", "session-vault"))).toBe(false);
  });

  test("declining to start leaves the fortress set up and says how to start it", async () => {
    const lines: string[] = [];
    let started = 0;
    await runEnrollWizard(
      { token: "a-one-time-enrollment-token", cloudUrl: CLOUD, log: (m) => lines.push(m), fortressRoot: temp.root() },
      {
        chooseSessions: async () => "off",
        confirmStart: async () => false,
        start: async () => {
          started += 1;
        },
      },
    );
    expect(started).toBe(0);
    expect(lines).toContain("Start Fortress when ready:  hx-fortress start");
    expect(sessionsEnabledIn(await new FileConfigStore(fortressPaths(temp.root())).load())).toBe(false);
  });
});

describe("the console of a fortress with Sessions off", () => {
  const temp = withTempRootAndHome();

  const daemonConfig = (modules: string[]): string =>
    JSON.stringify({
      schemaVersion: 1,
      cloud: { url: CLOUD },
      gateway: { publicUrl: "http://localhost:8787" },
      modules: { enabled: modules },
      moduleDefaultsApplied: 1,
    });

  function mount(): ReturnType<typeof createConsoleMount> {
    const root = temp.root();
    return createConsoleMount({
      paths: fortressPaths(root),
      runtime: new UiRuntime({
        uiRoot: path.join(root, "ui"),
        uiConfigFile: path.join(root, "ui", "ui.json"),
        cmdCredsDir: path.join(root, "runtime", "cmd-creds"),
        env: {},
      }),
      boundPort: 8788,
      serviceManager: "container",
      env: {},
    });
  }

  test("the status says whether Sessions is on, from the daemon's own config", async () => {
    const paths = fortressPaths(temp.root());
    const console_ = mount();
    await console_.ready;
    // No config.json: not known, so not stated.
    expect("sessions" in (await console_.port.status())).toBe(false);

    await writeFile(paths.config, daemonConfig([]));
    expect((await console_.port.status()).sessions).toBe("off");

    // It follows the file, with no restart of the console.
    await writeFile(paths.config, daemonConfig(["session_vault"]));
    expect((await console_.port.status()).sessions).toBe("on");
  });

  test("a command that acts on stored sessions is refused before it is queued", async () => {
    const off = createConsoleWritePort({
      service: null,
      serviceLogPath: path.join(temp.root(), "service.log"),
      db: () => null,
      heartbeatAt: async () => new Date().toISOString(),
      offered: OFFERED_COMMAND_KINDS,
      cmdCredsDir: path.join(temp.root(), "cmd-creds"),
      sessionsOn: async () => false,
    });
    for (const kind of SESSIONS_COMMAND_KINDS) {
      expect(await off.commandRefusal?.(kind)).toBe(SESSIONS_OFF_REFUSAL);
    }
    // These do not act on sessions: an update, a checkup, and the rotation of
    // the credential this fortress presents to let.ai.
    for (const kind of ["update_apply", "run_checkup", "rotate_credentials"] as const) {
      expect(await off.commandRefusal?.(kind)).toBeNull();
    }
    // Every offered kind is either one or the other.
    expect(
      OFFERED_COMMAND_KINDS.filter((k) => !SESSIONS_COMMAND_KINDS.includes(k)).sort(),
    ).toEqual(["rotate_credentials", "run_checkup", "update_apply"]);

    // On, or not known: nothing is refused on this account.
    for (const sessionsOn of [async () => true, async () => null, undefined]) {
      const port = createConsoleWritePort({
        service: null,
        serviceLogPath: path.join(temp.root(), "service.log"),
        db: () => null,
        heartbeatAt: async () => null,
        offered: OFFERED_COMMAND_KINDS,
        cmdCredsDir: path.join(temp.root(), "cmd-creds"),
        ...(sessionsOn ? { sessionsOn } : {}),
      });
      expect(await port.commandRefusal?.("run_audit")).toBeNull();
    }
  });

  test("the route answers that refusal in one sentence and asks the daemon for nothing", async () => {
    const submitted: string[] = [];
    const port: ConsoleWritePort = {
      serviceRefusal: () => null,
      service: async () => {
        throw new Error("not used");
      },
      heartbeatAt: async () => new Date().toISOString(),
      mintCredential: async () => "0".repeat(32),
      submit: async (kind) => {
        submitted.push(kind);
        return { id: "11111111-2222-3333-4444-555555555555" };
      },
      offered: () => OFFERED_COMMAND_KINDS,
      commandRefusal: async (kind) => (SESSIONS_COMMAND_KINDS.includes(kind) ? SESSIONS_OFF_REFUSAL : null),
    };
    const audit = new ConsoleAudit(new AuditSpool({ dir: path.join(temp.root(), "spool"), writer: "ui" }));
    const ask = (kind: string): Promise<Response | null> =>
      handleMutateRoute(
        new Request(`http://console.local${MUTATE_PATHS.commands}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind, params: {} }),
        }),
        { port, audit, actor: "op", sessionId: "s1" },
      );

    const refused = await ask("self_test");
    expect(refused?.status).toBe(409);
    expect(((await refused?.json()) as { error: string }).error).toBe(SESSIONS_OFF_REFUSAL);
    expect(submitted).toEqual([]);

    // A command that does not act on sessions goes through as before.
    const accepted = await ask("run_checkup");
    expect(accepted?.status).toBe(202);
    expect(submitted).toEqual(["run_checkup"]);
  });
});

describe("a daemon with Sessions off", () => {
  let boot: HostBoot | null = null;
  afterEach(async () => {
    await boot?.cleanup();
    boot = null;
  });

  const frame = <T extends FortressToHubFrame["t"]>(kind: T): Extract<FortressToHubFrame, { t: T }> | undefined =>
    boot?.report.frames.find((f): f is Extract<FortressToHubFrame, { t: T }> => f.t === kind);

  test("boots, enrolls and heartbeats with no bucket and no embedding key", async () => {
    boot = await bootHost({
      // No FORTRESS_OPENAI_API_KEY and no FORTRESS_STORAGE_BUCKET.
      env: { FORTRESS_SESSIONS: "off", FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL },
      scenario: { heartbeatMs: 40, waitForFrames: ["enroll", "heartbeat"] },
    });
    expect(boot.report.error).toBeNull();
    expect(boot.report.started).toBe(true);

    // What it tells the hub about itself: a version, and nothing about storage.
    const enroll = frame("enroll");
    expect(enroll).toMatchObject({ t: "enroll", version: "0.0.0-test", protocolVersion: 1 });
    for (const key of ["storageKind", "bucket", "bucketRegion", "gatewayUrl"]) {
      expect(enroll && key in enroll).toBe(false);
    }
    expect(frame("heartbeat")).toBeDefined();
    // No session counts are reported either.
    expect(frame("collectionStats")).toBeUndefined();

    // The choice is written down, so the next boot needs no variable.
    const config = JSON.parse(await readFile(boot.paths.config, "utf8")) as {
      modules: { enabled: string[] };
      moduleDefaultsApplied?: number;
    };
    expect(config.modules.enabled).toEqual([]);
    expect(config.moduleDefaultsApplied).toBe(1);

    // The module was never started: it logged no store, it reported no error,
    // and no credentials file was made.
    expect(boot.stdout).toContain("Sessions is off");
    expect(boot.stdout).not.toContain("store initialized");
    const status = (await boot.status()) as {
      modules: { id: string; state: string; error: string | null }[];
    } | null;
    expect(status?.modules).toEqual([{ id: "session_vault", state: "stopped", error: null }]);
    expect(existsSync(path.join(boot.root, ".let", "session-vault"))).toBe(false);
  }, 30_000);

  test("answers a session request from the hub with a refusal, not a crash", async () => {
    boot = await bootHost({
      env: { FORTRESS_SESSIONS: "off", FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL },
      scenario: {
        hubSends: [
          { t: "rpc", id: "rpc-1", req: { method: "selfTest" } } as never,
          { t: "mcpRpc", id: "mcp-1", req: { method: "listTools" } },
        ],
        waitForFrames: ["rpcError", "mcpRpcResult"],
      },
    });
    expect(boot.report.error).toBeNull();
    expect(frame("rpcError")).toEqual({ t: "rpcError", id: "rpc-1", error: "Module not running: session_vault" });
    expect(frame("mcpRpcResult")).toEqual({
      t: "mcpRpcResult",
      id: "mcp-1",
      result: { method: "callTool", content: JSON.stringify({ error: "sessions_off" }), isError: true },
    });
  }, 30_000);

  test("stays off on a later boot that sets no variable", async () => {
    boot = await bootHost({
      env: { FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL },
      scenario: { waitForFrames: ["enroll"] },
      // config.json as an earlier boot with Sessions off left it. The hub's
      // address is replaced when the daemon enrolls.
      prepare: async (paths) => {
        await writeFile(
          paths.config,
          JSON.stringify({
            schemaVersion: 1,
            cloud: { url: "ws://127.0.0.1:1" },
            gateway: { publicUrl: "http://localhost:8787" },
            modules: { enabled: [] },
            moduleDefaultsApplied: 1,
          }),
        );
      },
    });
    expect(boot.report.error).toBeNull();
    expect(boot.report.started).toBe(true);
    expect(frame("enroll") && "storageKind" in (frame("enroll") as object)).toBe(false);
  }, 30_000);

  test("does not tell the hub about a bucket left over from an earlier setup, and starts no gateway", async () => {
    boot = await bootHost({
      env: {
        FORTRESS_SESSIONS: "off",
        FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL,
        FORTRESS_PUBLIC_URL: "https://ingest.example.com",
      },
      scenario: { waitForFrames: ["enroll"] },
      prepare: async (paths) => {
        const vaultHome = path.join(paths.root, ".let", "session-vault");
        await mkdir(vaultHome, { recursive: true });
        await writeFile(
          path.join(vaultHome, "credentials.json"),
          JSON.stringify({ store: "s3", bucket: "a-leftover-bucket", region: "eu-north-1" }),
        );
      },
    });
    expect(boot.report.error).toBeNull();
    const enroll = frame("enroll");
    for (const key of ["storageKind", "bucket", "bucketRegion", "gatewayUrl"]) {
      expect(enroll && key in enroll).toBe(false);
    }
    expect(JSON.stringify(boot.report.frames)).not.toContain("a-leftover-bucket");
    expect(boot.stdout).toContain(
      "FORTRESS_PUBLIC_URL is set, but Sessions is off, so the ingest gateway is not started",
    );
  }, 30_000);

  test("a value that is neither on nor off stops the start", async () => {
    boot = await bootHost({
      env: { FORTRESS_SESSIONS: "of", FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL },
      scenario: {},
    });
    expect(boot.report.started).toBe(false);
    expect(boot.report.error).toBe("FORTRESS_SESSIONS must be on or off");
    expect(boot.report.frames).toEqual([]);
  }, 30_000);
});

describe("a daemon with Sessions on, as before", () => {
  let boot: HostBoot | null = null;
  afterEach(async () => {
    await boot?.cleanup();
    boot = null;
  });

  test("still refuses to start without an embedding key", async () => {
    boot = await bootHost({
      env: { FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL },
      scenario: {},
    });
    expect(boot.report.started).toBe(false);
    expect(boot.report.error).toContain("hx-fortress needs an OpenAI API key");
  }, 30_000);

  test("a config from before Sessions could be switched off gets Sessions back, and needs the key", async () => {
    boot = await bootHost({
      env: { FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL },
      scenario: {},
      prepare: async (paths) => {
        await writeFile(
          paths.config,
          JSON.stringify({
            schemaVersion: 1,
            cloud: { url: "ws://127.0.0.1:1" },
            gateway: { publicUrl: "http://localhost:8787" },
            modules: { enabled: [] },
          }),
        );
      },
    });
    expect(boot.report.started).toBe(false);
    expect(boot.report.error).toContain("hx-fortress needs an OpenAI API key");
    const config = JSON.parse(await readFile(boot.paths.config, "utf8")) as { modules: { enabled: string[] } };
    expect(config.modules.enabled).toEqual(["session_vault"]);
  }, 30_000);

  test("tells the hub its storage, as it always did", async () => {
    boot = await bootHost({
      env: {
        FORTRESS_OPENAI_API_KEY: "sk-test-fortress-openai-key",
        FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL,
        FORTRESS_STORAGE_KIND: "s3",
        FORTRESS_STORAGE_BUCKET: "the-organization-bucket",
        FORTRESS_STORAGE_REGION: "eu-north-1",
        // Never reached: the store is built and not used.
        FORTRESS_STORE_PROBE_INTERVAL_MS: "0",
      },
      scenario: { waitForFrames: ["enroll"] },
    });
    expect(boot.report.error).toBeNull();
    const enroll = boot.report.frames.find((f) => f.t === "enroll");
    expect(enroll).toMatchObject({
      t: "enroll",
      storageKind: "s3",
      bucket: "the-organization-bucket",
      bucketRegion: "eu-north-1",
    });
    // And the module started its store.
    expect(boot.stdout).toContain('"msg":"store initialized"');
  }, 30_000);
});
