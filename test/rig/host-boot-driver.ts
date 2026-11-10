// Boots the real daemon (`runFortressHost`) in THIS process against a loopback
// hub, stops it, and writes down what happened.
//
// It is run only as a child process of test/rig/host-boot.ts. That is what
// keeps a boot away from the developer's own fortress: the daemon looks for an
// existing home under the home directory this process STARTED with, so the
// parent starts it with HOME set to a temporary directory. A boot run inside
// the test process itself would look under the developer's real home.
//
// usage: bun host-boot-driver.ts <report.json> <scenario.json>

import { readFile, writeFile } from "node:fs/promises";

import { FilePendingEnrollmentStore, WsCloudConnection } from "../../src/cloud";
import { runFortressHost } from "../../src/host/main";
import { fortressPaths } from "../../src/host/paths";
import type { FortressToHubFrame } from "../../src/protocol";
import { FakeHub } from "../fake-hub";
import { routeHostToFake, startFakeAzure, type FakeAzure } from "./azure-fakes";

export interface HostBootScenario {
  /**
   * How the daemon learns its enrollment token.
   * `env`: FORTRESS_ENROLL_TOKEN and FORTRESS_CLOUD_URL, as a container does.
   * `pending-file`: the file the enroll wizard leaves behind.
   */
  enroll?: "env" | "pending-file";
  /** Milliseconds between the daemon's heartbeats to the hub. */
  heartbeatMs?: number;
  /** Frame kinds to wait for once the daemon is running, before it is stopped. */
  waitForFrames?: string[];
  /**
   * Start a fake managed identity endpoint and a fake Key Vault that holds
   * these secrets, and point the daemon's azure-key-vault provider at them.
   */
  keyVault?: { secrets: Record<string, string> };
}

export interface HostBootReport {
  /** Null when the daemon started and stopped. Otherwise what it failed with. */
  error: string | null;
  /** True once the daemon reported that it was running. */
  started: boolean;
  /** Every frame the hub received, in order. */
  frames: FortressToHubFrame[];
  hubUrl: string;
  /** Present when the scenario asked for a Key Vault. */
  keyVault: { tokenRequests: number; secretPaths: string[] } | null;
}

/** The address the daemon is configured with. Requests for it are sent to the
 *  fake vault, because the provider accepts only a real Key Vault host name. */
export const FAKE_VAULT_HOST = "fortress-test.vault.azure.net";

const ENROLL_TOKEN = "test-enroll-token";
const DEADLINE_MS = 20_000;

async function until(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await Bun.sleep(10);
  }
  return condition();
}

async function main(): Promise<void> {
  const [reportPath, scenarioPath] = process.argv.slice(2);
  if (!reportPath || !scenarioPath) throw new Error("usage: host-boot-driver.ts <report.json> <scenario.json>");
  const root = process.env.FORTRESS_ROOT;
  if (!root || process.env.HOME !== root) {
    throw new Error("refusing to boot: HOME and FORTRESS_ROOT must both name the temporary root");
  }
  const scenario = JSON.parse(await readFile(scenarioPath, "utf8")) as HostBootScenario;

  const hub = await FakeHub.create();
  let azure: FakeAzure | null = null;
  const report: HostBootReport = { error: null, started: false, frames: [], hubUrl: hub.url, keyVault: null };

  const finish = async (code: number): Promise<never> => {
    report.frames = [...hub.received()];
    if (azure) {
      report.keyVault = {
        tokenRequests: azure.identity.requests.length,
        secretPaths: azure.vault.requests.map((r) => r.path),
      };
    }
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.exit(code);
  };

  // A boot that hangs must not hang the suite.
  const watchdog = setTimeout(() => {
    report.error = `the boot did not finish within ${DEADLINE_MS} ms`;
    void finish(3);
  }, DEADLINE_MS);

  if ((scenario.enroll ?? "env") === "env") {
    process.env.FORTRESS_ENROLL_TOKEN = ENROLL_TOKEN;
    process.env.FORTRESS_CLOUD_URL = hub.url;
  } else {
    await new FilePendingEnrollmentStore(fortressPaths(root).pendingEnrollment).save({
      token: ENROLL_TOKEN,
      cloudUrl: hub.url,
    });
  }

  if (scenario.keyVault) {
    azure = startFakeAzure({ now: Date.now() });
    for (const [name, value] of Object.entries(scenario.keyVault.secrets)) azure.secrets.set(name, value);
    process.env.IDENTITY_ENDPOINT = `${azure.identity.origin}/msi/token`;
    process.env.IDENTITY_HEADER = azure.identityHeader;
    process.env.FORTRESS_SECRETS_PROVIDER = "azure-key-vault";
    process.env.FORTRESS_KEY_VAULT_URL = `https://${FAKE_VAULT_HOST}`;
    routeHostToFake(FAKE_VAULT_HOST, azure.vault);
  }

  try {
    await runFortressHost({
      root,
      version: "0.0.0-test",
      createConnection: (deps) =>
        new WsCloudConnection({
          ...deps,
          heartbeatMs: scenario.heartbeatMs ?? 30_000,
          reconnectMinMs: 50,
        }),
      // What `runHost` does, with "wait for a signal" replaced by "wait for
      // the frames the scenario names".
      run: async (runtime) => {
        try {
          await runtime.start();
        } catch (error) {
          await runtime.stop().catch(() => {});
          throw error;
        }
        report.started = true;
        const wanted = scenario.waitForFrames ?? [];
        const seen = await until(
          () => wanted.every((kind) => hub.received().some((frame) => frame.t === kind)),
          5_000,
        );
        await runtime.stop();
        if (!seen) throw new Error(`the hub never received: ${wanted.join(", ")}`);
      },
    });
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }

  clearTimeout(watchdog);
  await hub.stop();
  await azure?.stop();
  await finish(0);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(2);
});
