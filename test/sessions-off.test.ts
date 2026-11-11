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
  sessionsChosenOnDisk,
  sessionsEnabledIn,
  sessionsSettingFromEnv,
  sessionsStatedOnDisk,
  setSessionsEnabled,
} from "../src/host/config";
import { FilePendingEnrollmentStore } from "../src/cloud";
import { AuditSpool } from "../src/console/audit-spool";
import { mintCredentialRef, writeCredentialRef } from "../src/console/cmd-creds";
import { createCommandExecutors } from "../src/console/executors";
import { fortressPaths } from "../src/host/paths";
import createSessionVaultModule from "../src/modules/session-vault/module";
import { handOffSetup, runEnrollWizard } from "../src/modules/session-vault/wizard";
import type { FortressToHubFrame } from "../src/protocol";
import { ConsoleAudit } from "../src/ui/audit-writer";
import { createConsoleMount, type ConsoleMountOptions } from "../src/ui/console-mount";
import { createConsoleWritePort } from "../src/ui/console-write-port";
import { SESSIONS_OFF_REFUSAL } from "../src/ui/copy";
import {
  handleMutateRoute,
  MUTATE_PATHS,
  OFFERED_COMMAND_KINDS,
  SESSIONS_COMMAND_KINDS,
  SESSIONS_ROTATION_TARGETS,
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

  test("a fortress enrolled before Sessions could be switched off keeps it on, and its file is not rewritten", async () => {
    // What every older version left behind: it added the module at each boot.
    await write(legacy(["session_vault"]));
    const before = await readFile(paths.config, "utf8");
    await ensureCoreModulesEnabled(paths);
    expect(await enabled()).toEqual(["session_vault"]);
    // Byte for byte. A config.json on a read-only mount must not stop the
    // first start after an upgrade.
    expect(await readFile(paths.config, "utf8")).toBe(before);
  });

  test("a list that leaves Sessions out stays that way only once the file says the list is the operator's own", async () => {
    // Without the key the next start adds the default, as every older version did.
    await write(legacy([]));
    expect(await sessionsChosenOnDisk(paths)).toBe(true);
    await ensureCoreModulesEnabled(paths);
    expect(await enabled()).toEqual(["session_vault"]);

    // With it, nothing is added back, and the file is not written again.
    await write({ ...legacy([]), moduleDefaultsApplied: 1 });
    const before = await readFile(paths.config, "utf8");
    expect(await sessionsChosenOnDisk(paths)).toBe(false);
    await ensureCoreModulesEnabled(paths);
    expect(await enabled()).toEqual([]);
    expect(await readFile(paths.config, "utf8")).toBe(before);
  });

  test("a start with FORTRESS_SESSIONS=off on an older config writes the key with the list", async () => {
    await write(legacy(["session_vault"]));
    await ensureCoreModulesEnabled(paths, { sessions: "off" });
    expect(await enabled()).toEqual([]);
    expect((await raw()).moduleDefaultsApplied).toBe(1);
    // So the next start, with no variable, leaves it off.
    await ensureCoreModulesEnabled(paths);
    expect(await enabled()).toEqual([]);
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
    for (const value of ["on", "ON", " on "]) {
      expect(sessionsSettingFromEnv({ FORTRESS_SESSIONS: value })).toBe("on");
    }
    for (const value of ["off", "Off"]) {
      expect(sessionsSettingFromEnv({ FORTRESS_SESSIONS: value })).toBe("off");
    }
    // A mistyped "off" must not start a fortress that stores sessions, and the
    // two documented words are the only ones.
    for (const value of ["of", "disabled", "none", "2", "true", "1", "yes", "false", "0", "no"]) {
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

/** Module lists an edit by hand can leave: each holds something that is not a
 *  module id. */
const MISTYPED_LISTS: unknown[] = [["session-vault"], ["session_vault "], ["Session_Vault"], ["session_vault", ""]];

describe("a config.json that cannot be read in full", () => {
  let root = "";
  let paths: ReturnType<typeof fortressPaths>;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-sessions-off-"));
    paths = fortressPaths(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const write = (value: unknown): Promise<void> => writeFile(paths.config, JSON.stringify(value));
  // One field the check refuses, beside a module list that is perfectly clear.
  const damaged = (modules: unknown): Record<string, unknown> => ({
    schemaVersion: 1,
    cloud: { url: "https://not-a-websocket.example.com" },
    gateway: { publicUrl: "https://fortress.example.com" },
    modules: { enabled: modules },
  });

  test("the choice cannot be saved, and the caller is told so", async () => {
    // No file at all.
    await expect(setSessionsEnabled(paths, false)).rejects.toThrow("the Sessions choice was not saved");
    // A file that does not pass its check.
    await write(damaged(["session_vault"]));
    await expect(setSessionsEnabled(paths, false)).rejects.toThrow("the Sessions choice was not saved");
    expect(JSON.parse(await readFile(paths.config, "utf8"))).toEqual(damaged(["session_vault"]));
  });

  test("its module list still decides whether Sessions is on", async () => {
    expect(await sessionsStatedOnDisk(paths)).toBeNull(); // no file: it says nothing
    expect(await sessionsChosenOnDisk(paths)).toBe(true); // and the default is on
    await write({ ...damaged([]), moduleDefaultsApplied: 1 });
    expect(await sessionsChosenOnDisk(paths)).toBe(false);
    await write({ ...damaged(["session_vault"]), moduleDefaultsApplied: 1 });
    expect(await sessionsChosenOnDisk(paths)).toBe(true);
    // A list that is itself not usable says nothing, and the default stands.
    // That includes a list with something the config check does not take as a
    // module id, such as an id with "-" for "_".
    for (const list of [[42], "session_vault", ["a", "a"], null, ...MISTYPED_LISTS]) {
      await write({ ...damaged(list), moduleDefaultsApplied: 1 });
      expect(await sessionsStatedOnDisk(paths)).toBeNull();
      expect(await sessionsChosenOnDisk(paths)).toBe(true);
    }
  });

  test("enrolling again repairs a module list that the config check refuses", async () => {
    // The rest of the file is fine: the list alone keeps it from being read.
    const withList = (list: unknown): Record<string, unknown> => ({
      schemaVersion: 1,
      cloud: { url: CLOUD },
      gateway: { publicUrl: "http://localhost:8787" },
      modules: { enabled: list },
      moduleDefaultsApplied: 1,
    });
    for (const list of MISTYPED_LISTS) {
      await write(withList(list));
      await expect(new FileConfigStore(paths).load()).rejects.toThrow();

      await ensureEnrollmentConfig(paths, CLOUD);
      // The file can be read again, so the fortress can start. A list that
      // stated no choice was replaced by the default, and it is not marked as
      // the operator's own.
      const after = await new FileConfigStore(paths).load();
      expect(after.modules.enabled).toEqual(["session_vault"]);
      const raw = JSON.parse(await readFile(paths.config, "utf8")) as Record<string, unknown>;
      expect("moduleDefaultsApplied" in raw).toBe(false);
      expect(await sessionsChosenOnDisk(paths)).toBe(true);
    }
  });

  test("enrolling again keeps Sessions off, and does not bring the default back", async () => {
    await write({ ...damaged([]), moduleDefaultsApplied: 1 });
    await ensureEnrollmentConfig(paths, CLOUD);
    const after = await new FileConfigStore(paths).load();
    expect(after.cloud.url).toBe(CLOUD);
    expect(after.modules.enabled).toEqual([]);
    // The next start adds nothing back either.
    await ensureCoreModulesEnabled(paths);
    expect((await new FileConfigStore(paths).load()).modules.enabled).toEqual([]);
    expect(await sessionsChosenOnDisk(paths)).toBe(false);
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
        running: async () => false,
        start: async () => {
          started += 1;
        },
      },
    );

    const paths = fortressPaths(temp.root());
    const config = JSON.parse(await readFile(paths.config, "utf8")) as {
      cloud: { url: string };
      modules: { enabled: string[] };
    };
    expect(config.cloud.url).toBe(CLOUD);
    expect(config.modules.enabled).toEqual([]);
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
        running: async () => false,
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

describe("what the setup says and writes when the answer cannot take effect yet", () => {
  const temp = withTempRootAndHome();
  const wizard = (
    lines: string[],
    deps: Parameters<typeof runEnrollWizard>[1],
    cloudUrl = CLOUD,
  ): Promise<void> =>
    runEnrollWizard(
      { token: "a-one-time-enrollment-token", cloudUrl, log: (m) => lines.push(m), fortressRoot: temp.root() },
      deps,
    );

  test("a fortress that is running is not said to have Sessions off: it is told how to apply the choice", async () => {
    const lines: string[] = [];
    await wizard(lines, {
      chooseSessions: async () => "off",
      confirmStart: async () => false,
      running: async () => true,
    });
    expect(lines).not.toContain(
      "Sessions is off. This fortress stores no AI session transcripts and needs no bucket.",
    );
    expect(lines).toContain("Sessions is switched off in this fortress's settings.");
    expect(lines.join("\n")).toContain("keeps them until it restarts");
    expect(lines.join("\n")).toContain("hx-fortress stop  and then  hx-fortress start");
    expect(sessionsEnabledIn(await new FileConfigStore(fortressPaths(temp.root())).load())).toBe(false);
  });

  test("answering Yes and leaving at the next question leaves a fortress that had Sessions off as it was", async () => {
    const paths = fortressPaths(temp.root());
    await ensureEnrollmentConfig(paths, CLOUD);
    await setSessionsEnabled(paths, false);
    const before = await readFile(paths.config, "utf8");

    await expect(
      wizard([], {
        chooseSessions: async () => "on",
        chooseStore: async () => {
          throw new Error("the operator left the setup at this question");
        },
      }),
    ).rejects.toThrow("the operator left the setup at this question");

    // Still off, so the next restart of this fortress does not ask for a
    // bucket and an embedding key that nobody gave it.
    expect(await readFile(paths.config, "utf8")).toBe(before);
    expect(await sessionsChosenOnDisk(paths)).toBe(false);
  });

  describe("a setup that hands the bucket to the operator to finish", () => {
    const handOff = (lines: string[], running: boolean): Promise<void> =>
      handOffSetup(
        {
          store: "s3",
          bucket: "a-bucket-to-finish-by-hand",
          region: "eu-north-1",
          cloudUrl: CLOUD,
          token: "a-one-time-enrollment-token",
          fortressRoot: temp.root(),
        },
        (m) => lines.push(m),
        { running: async () => running },
      );

    test("saves the answer Yes, so the start it tells the operator to run has Sessions on", async () => {
      const paths = fortressPaths(temp.root());
      // A fortress that had Sessions off.
      await ensureEnrollmentConfig(paths, CLOUD);
      await setSessionsEnabled(paths, false);
      expect(await sessionsChosenOnDisk(paths)).toBe(false);

      const lines: string[] = [];
      await handOff(lines, false);

      expect(await sessionsChosenOnDisk(paths)).toBe(true);
      expect(sessionsEnabledIn(await new FileConfigStore(paths).load())).toBe(true);
      // The token is left for that start, and the file to complete is in place.
      const pending = await new FilePendingEnrollmentStore(paths.pendingEnrollment).load();
      expect(pending?.token).toBe("a-one-time-enrollment-token");
      expect(existsSync(path.join(temp.home(), ".let", "session-vault", "credentials.json"))).toBe(true);
      // It says what it switched, what that means, and how to switch it back.
      expect(lines).toContain("Sessions is switched on in this fortress's settings.");
      expect(lines.join("\n")).toContain("does not start until that file is complete");
      expect(lines).toContain("To leave Sessions off instead:  hx-fortress modules off session_vault");
      expect(lines.join("\n")).not.toContain("keeps them until it restarts");
      expect(lines.at(-1)).toBe("Then run: hx-fortress start");
    });

    test("on a fortress that is running, it also says that a restart applies the choice", async () => {
      const paths = fortressPaths(temp.root());
      await ensureEnrollmentConfig(paths, CLOUD);
      await setSessionsEnabled(paths, false);
      const lines: string[] = [];
      await handOff(lines, true);
      expect(await sessionsChosenOnDisk(paths)).toBe(true);
      expect(lines).toContain("Sessions is switched on in this fortress's settings.");
      expect(lines.join("\n")).toContain("keeps them until it restarts");
    });

    test("on a fortress that already had Sessions on, nothing is said about a switch", async () => {
      const paths = fortressPaths(temp.root());
      await ensureEnrollmentConfig(paths, CLOUD);
      expect(await sessionsChosenOnDisk(paths)).toBe(true);
      const before = await readFile(paths.config, "utf8");
      const lines: string[] = [];
      await handOff(lines, true);
      expect(await sessionsChosenOnDisk(paths)).toBe(true);
      expect(lines.join("\n")).not.toContain("switched on");
      expect(lines.join("\n")).not.toContain("modules off");
      // A choice that was already made is not written again.
      expect(await readFile(paths.config, "utf8")).toBe(before);
    });

    test("when the answer cannot be saved, the setup stops and does not say that it was", async () => {
      const paths = fortressPaths(temp.root());
      // A config.json that does not pass its check.
      await mkdir(path.dirname(paths.config), { recursive: true });
      await writeFile(paths.config, JSON.stringify({ schemaVersion: 1, cloud: { url: "https://not-a-websocket.example.com" } }));
      const lines: string[] = [];
      await expect(handOff(lines, false)).rejects.toThrow("the Sessions choice was not saved");
      expect(lines.join("\n")).not.toContain("switched on");
      expect(lines.join("\n")).not.toContain("Then run");
    });
  });

  test("an answer that cannot be saved stops the setup, and nothing says that Sessions is off", async () => {
    const lines: string[] = [];
    // An address the fortress's own config check refuses, so config.json is
    // written and cannot be read back.
    await expect(
      wizard(
        lines,
        { chooseSessions: async () => "off", confirmStart: async () => false, running: async () => false },
        "https://hub.example.com/not-a-websocket-address",
      ),
    ).rejects.toThrow("the Sessions choice was not saved");
    expect(lines.join("\n")).not.toContain("Sessions is off");
    expect(lines.join("\n")).not.toContain("switched off");
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

  function mount(extra: Partial<ConsoleMountOptions> = {}): ReturnType<typeof createConsoleMount> {
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
      ...extra,
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

  test("a running daemon's own word wins over config.json, which only says what the next start will do", async () => {
    const paths = fortressPaths(temp.root());
    const console_ = mount();
    await console_.ready;
    const daemonSays = async (sessions: "on" | "off" | undefined, writtenAt: Date): Promise<void> => {
      await mkdir(path.dirname(paths.status), { recursive: true });
      await writeFile(
        paths.status,
        JSON.stringify({
          schemaVersion: 1,
          ...(sessions ? { sessions } : {}),
          host: {
            state: "running",
            pid: process.pid,
            startedAt: writtenAt.toISOString(),
            updatedAt: writtenAt.toISOString(),
            error: null,
            writtenAt: writtenAt.toISOString(),
          },
          connection: { state: "connected", reason: null, message: null },
          postgres: { phase: "retrying", reason: null },
          modules: [],
        }),
      );
    };

    // A setup switched Sessions off in config.json. The daemon that is running
    // started with it on and still stores transcripts.
    await writeFile(paths.config, daemonConfig([]));
    await daemonSays("on", new Date());
    expect((await console_.port.status()).sessions).toBe("on");

    // The other way round, too.
    await writeFile(paths.config, daemonConfig(["session_vault"]));
    await daemonSays("off", new Date());
    expect((await console_.port.status()).sessions).toBe("off");

    // A status file that is no longer being written describes no running
    // daemon, and one from an older build does not say: config.json decides.
    await daemonSays("off", new Date(Date.now() - 60 * 60_000));
    expect((await console_.port.status()).sessions).toBe("on");
    await daemonSays(undefined, new Date());
    expect((await console_.port.status()).sessions).toBe("on");
  });

  test("a bucket left in credentials.json by an earlier setup is not shown as this fortress's storage", async () => {
    const paths = fortressPaths(temp.root());
    const vaultHome = path.join(temp.home(), ".let", "session-vault");
    await mkdir(vaultHome, { recursive: true });
    await writeFile(
      path.join(vaultHome, "credentials.json"),
      JSON.stringify({ store: "s3", bucket: "the-earlier-bucket", region: "eu-north-1" }),
    );
    const console_ = mount();
    await console_.ready;
    const row = async (id: string): Promise<{ peer: string; carries: string } | undefined> =>
      (await console_.port.dataPaths()).rows.find((r) => r.id === id);

    await writeFile(paths.config, daemonConfig(["session_vault"]));
    expect((await row("console-bucket"))?.peer).toBe("s3://the-earlier-bucket (eu-north-1)");

    await writeFile(paths.config, daemonConfig([]));
    const bucket = await row("console-bucket");
    expect(bucket?.peer).toBe("none - Sessions is off");
    expect(bucket?.carries).toBe("nothing");
    expect(JSON.stringify(await console_.port.dataPaths())).not.toContain("the-earlier-bucket");
    expect(JSON.stringify(await console_.port.facts())).not.toContain("the-earlier-bucket");
    expect((await row("relay-tunnel"))?.carries).toContain("nothing while Sessions is off");
  });

  test("a check of one earlier session asks the earlier bucket nothing, and says why it did not look", async () => {
    const paths = fortressPaths(temp.root());
    // The bucket an earlier setup wrote to, played by a server on this host
    // that writes down every request it gets.
    const asked: string[] = [];
    const bucket = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        asked.push(`${req.method} ${new URL(req.url).pathname}`);
        return new Response(null, { status: 200, headers: { "content-length": "10", etag: '"0"' } });
      },
    });
    const previous = process.env.FORTRESS_S3_ALLOW_PRIVATE_ENDPOINT;
    process.env.FORTRESS_S3_ALLOW_PRIVATE_ENDPOINT = "1";
    try {
      // The credentials file that setup left behind.
      const vaultHome = path.join(temp.home(), ".let", "session-vault");
      await mkdir(vaultHome, { recursive: true });
      await writeFile(
        path.join(vaultHome, "credentials.json"),
        JSON.stringify({
          store: "s3",
          bucket: "the-earlier-bucket",
          region: "us-east-1",
          endpoint: `http://127.0.0.1:${bucket.port}`,
          forcePathStyle: true,
          // The access key id is the example one from AWS's own documentation.
          s3: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: ["an", "example", "key"].join("-") },
        }),
        { mode: 0o600 },
      );
      // The database still holds the record of an earlier session. It is played
      // by a handle that answers every query with that one record.
      const record = {
        family: "claude-code",
        sessionId: "s-earlier",
        userExternalId: "u-1",
        bytesUploaded: 10,
        ingestChannel: "tunnel",
        lastActivityAt: new Date().toISOString(),
      };
      await mkdir(path.join(temp.root(), "ui"), { recursive: true });
      await writeFile(
        path.join(temp.root(), "ui", "ui.json"),
        JSON.stringify({ databaseUrl: "postgres://console@127.0.0.1:1/hx" }),
      );
      const console_ = mount({ createDb: () => ({ execute: async () => [record] }) as never });
      const check = async (): Promise<{ state: string; detail: string } | undefined> =>
        (await console_.port.verifySession({ family: record.family, sessionId: record.sessionId })).checks.find(
          (c) => c.name === "Transcript object",
        );

      await writeFile(paths.config, daemonConfig([]));
      await console_.ready;
      expect((await console_.port.status()).sessions).toBe("off");
      const off = await check();
      expect(asked).toEqual([]);
      expect(off?.state).toBe("not-checked");
      expect(off?.detail).toBe("Sessions is off on this fortress, so it reads no bucket");

      // The same check with Sessions on does ask that bucket. So the lines
      // above fail if the console stops looking at the Sessions choice.
      await writeFile(paths.config, daemonConfig(["session_vault"]));
      const on = await check();
      expect(asked.length).toBeGreaterThan(0);
      expect(asked[0]).toContain("/the-earlier-bucket/");
      expect(on?.state).not.toBe("not-checked");

      // Switched off again, the console drops the key it had read and asks no more.
      await writeFile(paths.config, daemonConfig([]));
      const before = asked.length;
      expect((await check())?.detail).toBe("Sessions is off on this fortress, so it reads no bucket");
      expect(asked.length).toBe(before);
    } finally {
      if (previous === undefined) delete process.env.FORTRESS_S3_ALLOW_PRIVATE_ENDPOINT;
      else process.env.FORTRESS_S3_ALLOW_PRIVATE_ENDPOINT = previous;
      await bucket.stop(true);
    }
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
    // A rotation is judged by its target. The bucket credentials and the
    // embedding key belong to Sessions; the credential for let.ai does not.
    expect(await off.commandRefusal?.("rotate_credentials", "storage")).toBe(SESSIONS_OFF_REFUSAL);
    expect(await off.commandRefusal?.("rotate_credentials", "openai")).toBe(SESSIONS_OFF_REFUSAL);
    expect(await off.commandRefusal?.("rotate_credentials", "cloud")).toBeNull();
    expect([...SESSIONS_ROTATION_TARGETS].sort()).toEqual(["openai", "storage"]);
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
      commandRefusal: async (kind, rotationTarget) =>
        SESSIONS_COMMAND_KINDS.includes(kind) ||
        (kind === "rotate_credentials" && rotationTarget !== "cloud" && rotationTarget != null)
          ? SESSIONS_OFF_REFUSAL
          : null,
    };
    let minted = 0;
    const mint = port.mintCredential;
    port.mintCredential = async (payload) => {
      minted += 1;
      return mint(payload);
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

    // A rotation of the bucket credentials is refused before its key material
    // is stored anywhere: the route is told the target the request names.
    const rotation = await handleMutateRoute(
      new Request(`http://console.local${MUTATE_PATHS.commands}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "rotate_credentials",
          params: {},
          secret: { target: "storage", credentials: { store: "s3", bucket: "a-bucket" } },
        }),
      }),
      { port, audit, actor: "op", sessionId: "s1" },
    );
    expect(rotation?.status).toBe(409);
    expect(((await rotation?.json()) as { error: string }).error).toBe(SESSIONS_OFF_REFUSAL);
    expect(minted).toBe(0);
    expect(submitted).toEqual(["run_checkup"]);
  });
});

describe("commands that reach a daemon with Sessions off", () => {
  const temp = withTempRootAndHome();

  /** A loopback stand-in for a bucket. It records what it is asked. */
  function fakeBucket(): { endpoint: string; requests: string[]; stop: () => Promise<void> } {
    const requests: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        requests.push(`${req.method} ${new URL(req.url).pathname}`);
        return new Response(null, { status: 200, headers: { ETag: '"0"' } });
      },
    });
    return { endpoint: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
  }

  /** The executors as the daemon wires them, in a run with Sessions on or off. */
  function executors(sessionsOn: boolean, cmdCredsDir: string): ReturnType<typeof createCommandExecutors> {
    const unused = async (): Promise<never> => {
      throw new Error("not used in this test");
    };
    return createCommandExecutors({
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      store: () => null,
      downloadBaseUrl: async () => null,
      service: {
        name: "test-manager",
        state: async () => ({ loaded: true, pid: process.pid }),
      } as never,
      cmdCredsDir,
      env: {},
      db: () => ({ execute: async () => [] }) as never,
      rebindStore: unused,
      setCloudCredential: unused,
      status: async () => null,
      embeddingEndpoint: () => null,
      sessionsOn: () => sessionsOn,
      runAudit: unused,
      runMigration: unused,
      setCloudWitness: async () => {},
      acknowledgeFinding: async () => {},
      onBinarySwapped: () => {},
    } as never);
  }

  test("a storage or embedding-key rotation is refused before the bucket is touched or anything is written", async () => {
    const bucket = fakeBucket();
    try {
      const cmdCredsDir = path.join(temp.root(), "cmd-creds");
      await mkdir(cmdCredsDir, { recursive: true });
      const run = executors(false, cmdCredsDir);
      const payloads = [
        {
          target: "storage",
          credentials: {
            store: "s3",
            bucket: "a-bucket-typed-into-the-console",
            region: "us-east-1",
            endpoint: bucket.endpoint,
            forcePathStyle: true,
            s3: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "an-example-secret-of-this-test" },
          },
        },
        { target: "openai", apiKey: "sk-an-example-key-of-this-test" },
      ];
      for (const payload of payloads) {
        const ref = mintCredentialRef();
        await writeCredentialRef(cmdCredsDir, ref, payload);
        await expect(run.rotate_credentials({ id: "c1", params: {}, credentialRef: ref } as never)).rejects.toThrow(
          "Sessions is off on this fortress",
        );
      }
      expect(bucket.requests).toEqual([]);
      expect(existsSync(path.join(temp.home(), ".let", "session-vault"))).toBe(false);
    } finally {
      await bucket.stop();
    }
  });

  test("the checkup reports what is off by choice as not configured, never as failed", async () => {
    const off = await executors(false, temp.root()).run_checkup({ id: "c1", params: {}, credentialRef: null } as never);
    expect(off).toContain("object store: not-configured (Sessions is off, so this fortress has no object store)");
    expect(off).toContain("embeddings: not-configured (Sessions is off, so nothing is embedded)");
    expect(off).not.toContain("failed (the vault store is not initialized)");

    // With Sessions on, a store that is not there is still a failure.
    const on = await executors(true, temp.root()).run_checkup({ id: "c2", params: {}, credentialRef: null } as never);
    expect(on).toContain("object store: failed (the vault store is not initialized)");
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
    };
    expect(config.modules.enabled).toEqual([]);

    // The module was never started: it logged no store, it reported no error,
    // and no credentials file was made.
    expect(boot.stdout).toContain("Sessions is off");
    expect(boot.stdout).not.toContain("store initialized");
    const status = (await boot.status()) as {
      sessions?: string;
      modules: { id: string; state: string; error: string | null }[];
    } | null;
    expect(status?.modules).toEqual([{ id: "session_vault", state: "stopped", error: null }]);
    // The daemon says what this run does, for the console to read.
    expect(status?.sessions).toBe("off");
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

  test("a config from before Sessions could be switched off still has it on, and still needs the key", async () => {
    // Every older version listed the module: it added it at each boot.
    const legacy = JSON.stringify({
      schemaVersion: 1,
      cloud: { url: "ws://127.0.0.1:1" },
      gateway: { publicUrl: "http://localhost:8787" },
      modules: { enabled: ["session_vault"] },
    });
    boot = await bootHost({
      env: { FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL },
      scenario: {},
      prepare: async (paths) => {
        await writeFile(paths.config, legacy);
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
    // The daemon says what this run does, for the console to read.
    expect(((await boot.status()) as { sessions?: string } | null)?.sessions).toBe("on");
  }, 30_000);
});

describe("a daemon with Sessions off and settings left over from Sessions on", () => {
  let boot: HostBoot | null = null;
  afterEach(async () => {
    await boot?.cleanup();
    boot = null;
  });
  const vaultCredentials = (root: string): string => path.join(root, ".let", "session-vault", "credentials.json");

  test("the storage variables are not read, and no bucket key is written to its disk", async () => {
    boot = await bootHost({
      env: {
        FORTRESS_SESSIONS: "off",
        FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL,
        FORTRESS_STORAGE_KIND: "s3",
        FORTRESS_STORAGE_BUCKET: "the-earlier-bucket",
        FORTRESS_STORAGE_REGION: "eu-north-1",
        FORTRESS_S3_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
        FORTRESS_S3_SECRET_ACCESS_KEY: "an-example-secret-access-key-of-this-test",
      },
      scenario: { waitForFrames: ["enroll"] },
    });
    expect(boot.report.error).toBeNull();
    expect(boot.report.started).toBe(true);
    expect(existsSync(vaultCredentials(boot.root))).toBe(false);
    expect(await boot.whereWritten("an-example-secret-access-key-of-this-test")).toEqual([]);
    expect(boot.stdout).toContain(
      "FORTRESS_STORAGE_BUCKET is set, but Sessions is off, so no storage credentials are written",
    );
    expect(JSON.stringify(boot.report.frames)).not.toContain("the-earlier-bucket");
  }, 30_000);

  test("a storage setting that Sessions would refuse does not stop the start", async () => {
    boot = await bootHost({
      env: {
        FORTRESS_SESSIONS: "off",
        FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL,
        FORTRESS_STORAGE_KIND: "a-kind-that-does-not-exist",
        FORTRESS_STORAGE_BUCKET: "the-earlier-bucket",
      },
      scenario: { waitForFrames: ["enroll"] },
    });
    expect(boot.report.error).toBeNull();
    expect(boot.report.started).toBe(true);
  }, 30_000);

  test("a credentials file that cannot be read does not stop the start, and is left as it is", async () => {
    const torn = '{"store":"s3","bucket":"the-earlier-buck';
    boot = await bootHost({
      env: {
        FORTRESS_SESSIONS: "off",
        FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL,
        FORTRESS_STORAGE_KIND: "s3",
        FORTRESS_STORAGE_BUCKET: "the-earlier-bucket",
      },
      scenario: { waitForFrames: ["enroll"] },
      prepare: async (paths) => {
        await mkdir(path.dirname(vaultCredentials(paths.root)), { recursive: true });
        await writeFile(vaultCredentials(paths.root), torn);
      },
    });
    expect(boot.report.error).toBeNull();
    expect(boot.report.started).toBe(true);
    expect(await readFile(vaultCredentials(boot.root), "utf8")).toBe(torn);
  }, 30_000);

  test("config.json switched off, with no variable: the storage variables are ignored the same way", async () => {
    boot = await bootHost({
      env: {
        FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL,
        FORTRESS_STORAGE_KIND: "s3",
        FORTRESS_STORAGE_BUCKET: "the-earlier-bucket",
      },
      scenario: { waitForFrames: ["enroll"] },
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
    expect(existsSync(vaultCredentials(boot.root))).toBe(false);
  }, 30_000);

  test("a start that is refused for its FORTRESS_SESSIONS value has written nothing", async () => {
    boot = await bootHost({
      env: {
        FORTRESS_SESSIONS: "of",
        FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL,
        FORTRESS_STORAGE_KIND: "s3",
        FORTRESS_STORAGE_BUCKET: "the-earlier-bucket",
      },
      scenario: {},
    });
    expect(boot.report.started).toBe(false);
    expect(boot.report.error).toBe("FORTRESS_SESSIONS must be on or off");
    expect(boot.stdout).toContain("FORTRESS_SESSIONS is not valid, so this fortress will not start");
    expect(existsSync(vaultCredentials(boot.root))).toBe(false);
    expect(existsSync(boot.paths.config)).toBe(false);
    expect(existsSync(boot.paths.pendingEnrollment)).toBe(false);
  }, 30_000);
});

describe("the health endpoints of a daemon with Sessions off", () => {
  let boot: HostBoot | null = null;
  afterEach(async () => {
    await boot?.cleanup();
    boot = null;
  });

  /** A port nothing listens on right now. */
  const freePort = (): number => {
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = probe.port;
    void probe.stop(true);
    return port ?? 0;
  };

  test("the gateway port answers /healthz and /readyz, and nothing else", async () => {
    const port = freePort();
    boot = await bootHost({
      env: {
        FORTRESS_SESSIONS: "off",
        FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL,
        FORTRESS_PUBLIC_URL: "https://ingest.example.com",
        FORTRESS_GATEWAY_PORT: String(port),
      },
      scenario: {
        waitForFrames: ["enroll"],
        probeGatewayPort: ["/healthz", "/readyz", "/mcp", "/v1/ingest", "/"],
      },
    });
    expect(boot.report.error).toBeNull();
    const answers = Object.fromEntries(boot.report.probes.map((p) => [p.path, p]));
    expect(answers["/healthz"]).toEqual({ path: "/healthz", status: 200, body: '{"ok":true}' });
    // The database of this test never answers, so the fortress is alive and not ready.
    expect(answers["/readyz"]).toEqual({ path: "/readyz", status: 503, body: '{"ok":false,"ready":false}' });
    for (const other of ["/mcp", "/v1/ingest", "/"]) {
      expect(answers[other]?.status).toBe(404);
    }
    // The gateway itself is not advertised to the hub.
    const enroll = boot.report.frames.find((f) => f.t === "enroll");
    expect(enroll && "gatewayUrl" in enroll).toBe(false);
  }, 30_000);

  test("with no public URL set, nothing listens on the gateway port", async () => {
    const port = freePort();
    boot = await bootHost({
      env: {
        FORTRESS_SESSIONS: "off",
        FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL,
        FORTRESS_GATEWAY_PORT: String(port),
      },
      scenario: { waitForFrames: ["enroll"], probeGatewayPort: ["/healthz"] },
    });
    expect(boot.report.error).toBeNull();
    expect(boot.report.probes).toEqual([{ path: "/healthz", status: 0, body: "" }]);
  }, 30_000);
});
