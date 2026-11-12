// Boots the real daemon (`runFortressHost`) in THIS process against a loopback
// hub, stops it, and writes down what happened.
//
// It is run only as a child process of test/rig/host-boot.ts. That is what
// keeps a boot away from the developer's own fortress: the daemon looks for an
// existing home under the home directory this process STARTED with, so the
// parent starts it with HOME set to a temporary directory. A boot run inside
// the test process itself would look under the developer's real home. The
// daemon also looks in a few fixed places a container keeps a home, so the
// driver refuses to boot on a machine that has one there.
//
// usage: bun host-boot-driver.ts <report.json> <scenario.json>

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

import { FilePendingEnrollmentStore, WsCloudConnection } from "../../src/cloud";
import { CONTAINER_HOME_CANDIDATES, credentialsUnder } from "../../src/host/daemon-home";
import { runFortressHost } from "../../src/host/main";
import { fortressPaths } from "../../src/host/paths";
import type { FortressToHubFrame, HubToFortressFrame } from "../../src/protocol";
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
  /** Frames the hub sends once the daemon is running. */
  hubSends?: HubToFortressFrame[];
  /** Frame kinds to wait for once the daemon is running, before it is stopped. */
  waitForFrames?: string[];
  /** Paths to GET on the daemon's gateway port (FORTRESS_GATEWAY_PORT) while
   *  it is running. Each answer is written to the report. */
  probeGatewayPort?: string[];
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
  /** One entry per path in `probeGatewayPort`. Status 0 means no answer. */
  probes: { path: string; status: number; body: string }[];
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
  // A temporary HOME is not the whole guard. A daemon that finds no home under
  // HOME also looks in a fixed list of places a container keeps one, and
  // adopts the first that holds credentials. A machine that has one of those
  // is not a machine to boot a test daemon on.
  const adoptable = CONTAINER_HOME_CANDIDATES.find((candidate) => existsSync(credentialsUnder(candidate)));
  if (adoptable !== undefined) {
    throw new Error(`refusing to boot: this machine has a fortress home at ${adoptable}, which the daemon would adopt`);
  }
  const scenario = JSON.parse(await readFile(scenarioPath, "utf8")) as HostBootScenario;

  const hub = await FakeHub.create();
  let azure: FakeAzure | null = null;
  const report: HostBootReport = {
    error: null,
    started: false,
    frames: [],
    hubUrl: hub.url,
    keyVault: null,
    probes: [],
  };

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
    process.env.FORTRESS_SECRETS_AZURE_VAULT_URL = `https://${FAKE_VAULT_HOST}`;
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
        for (const probePath of scenario.probeGatewayPort ?? []) {
          const url = `http://127.0.0.1:${process.env.FORTRESS_GATEWAY_PORT ?? ""}${probePath}`;
          try {
            const answer = await fetch(url, { signal: AbortSignal.timeout(2_000) });
            report.probes.push({ path: probePath, status: answer.status, body: (await answer.text()).slice(0, 200) });
          } catch {
            report.probes.push({ path: probePath, status: 0, body: "" });
          }
        }
        for (const frame of scenario.hubSends ?? []) hub.send(frame);
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
