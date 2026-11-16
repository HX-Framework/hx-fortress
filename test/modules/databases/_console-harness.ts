// The console's Databases page, running on this machine with nothing real
// behind it: for looking at the page, and for taking pictures of it.
//
//   bun test/modules/databases/_console-harness.ts <file for the two tokens>
//
// It needs the console built first (`bun run build:ui`). It prints the address
// it serves, writes two session tokens to the file it was given (an
// operator's and a read-only person's), and stops by itself after fifteen
// minutes, or sooner on a signal.
//
//   HARNESS_PORT=8799        the port to serve on, in place of a free one
//   HARNESS_DATABASES=off    the console's switch for the module is off, so
//                            its acts are no routes
//   HARNESS_DAEMON=stopped   the daemon's door is closed before anything is
//                            served, as with a daemon that is not running
//
// WHAT IS REAL: the console's server with its gate, its sessions and its act
// route; the daemon's door on this machine; the act gate; the module host with
// its two lists; and the Databases module.
//
// WHAT IS A STAND-IN: the data runner, and every database. The module is
// handed ports that run the stand-in program of this folder, which answers
// from made-up servers of the made-up company Northstar. The product hands the
// module ports that start no program at all (src/modules/databases/standins.ts),
// so on a real HX Fortress of this build every test ends with "the data runner
// is not installed". Every name, address and password here is made up.

import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { AuditSpool } from "../../../src/console/audit-spool";
import { sendAct } from "../../../src/host/local-door-client";
import type { ModuleContextV2 } from "../../../src/host/module-contract";
import type { DatabasesHostPorts } from "../../../src/modules/databases/host-ports";
import { createDatabasesModule } from "../../../src/modules/databases/module";
import { createActRoutes } from "../../../src/ui/act-routes";
import { inlineScriptHashesOf, manifestOf, mapDistDir, type UiAssets } from "../../../src/ui/assets";
import { ConsoleAudit } from "../../../src/ui/audit-writer";
import { UiConfigStore } from "../../../src/ui/config";
import { UiRuntime } from "../../../src/ui/runtime";
import { startUiServer } from "../../../src/ui/server";
import { fixedSecrets, makeRig } from "../../host/_module-rig";
import { CATALOG, KEY_STORE, keptQueryRecords, standInLauncher } from "./_rig";

const LIFETIME_MS = 15 * 60_000;
/** How long the stand-in program takes over one job, so a test can be seen running. */
const JOB_MS = 2_500;
const ENABLED = ["session_vault", "databases"] as const;

const tokensFile = process.argv[2];
if (!tokensFile) {
  console.error("usage: bun test/modules/databases/_console-harness.ts <file for the two tokens>");
  process.exit(2);
}

// Both paths below are this repository's own, or the one this was started with.
/* eslint-disable security/detect-non-literal-fs-filename */

const dist = path.join(import.meta.dir, "..", "..", "..", "ui", "dist");
const indexHtml = await readFile(path.join(dist, "index.html"), "utf8").catch(() => null);
if (indexHtml === null) {
  console.error("The console is not built. Run `bun run build:ui` first.");
  process.exit(2);
}

// ── The daemon's side ────────────────────────────────────────────────────────

const rig = await makeRig({ enabled: ENABLED, deps: { catalog: CATALOG }, start: false });
// A job is "now" on the clock a person reads the page by.
rig.now.value = new Date();
const tick = setInterval(() => {
  rig.now.value = new Date();
}, 250);

const launcher = standInLauncher({
  secrets: fixedSecrets({ ...KEY_STORE }),
  hold: () => new Promise((resolve) => setTimeout(resolve, JOB_MS)),
  clock: () => new Date(),
});
const queryRecords = keptQueryRecords();
const ports: DatabasesHostPorts = {
  forContext(ctx: ModuleContextV2) {
    return {
      programs: {
        // What the module host will do: look the host up on its own list by
        // the name the module gave, and start the program for that address.
        async run(_program, run) {
          const entry = (await ctx.reach.list()).find((candidate) => candidate.name === run.reach);
          if (!entry) return { ok: false, code: "reach_not_listed" };
          const added = await ctx.secretNames.list();
          if (Object.values(run.secrets).some((name) => !added.includes(name))) {
            return { ok: false, code: "secret_not_added" };
          }
          return launcher({
            args: ["run", "--job-stdin"],
            reach: { host: entry.host, port: entry.port },
            secrets: run.secrets,
            input: run.input,
            onOutput: run.onOutput,
            ...(run.timeoutMs === undefined ? {} : { timeoutMs: run.timeoutMs }),
            ...(run.signal === undefined ? {} : { signal: run.signal }),
          });
        },
      },
      queryRecords: queryRecords.port(ctx),
    };
  },
};
rig.host.provide(createDatabasesModule({ ports, clock: () => new Date() }));
await rig.host.start();
await rig.registry.startAll([...ENABLED]);
await rig.host.started();

// ── The console ──────────────────────────────────────────────────────────────

const files = mapDistDir(dist);
const assets: UiAssets = {
  mode: "disk",
  files,
  inlineScriptHashes: inlineScriptHashesOf(indexHtml),
  manifest: await manifestOf(files),
};
const uiRoot = path.join(rig.paths.root, "console");
const uiConfigFile = path.join(uiRoot, "ui.json");
await new UiConfigStore(uiConfigFile).update((current) => ({ ...current, enabled: true }));
const runtime = new UiRuntime({
  uiRoot,
  uiConfigFile,
  cmdCredsDir: path.join(uiRoot, "cmd-creds"),
  env: {},
  acts: createActRoutes({
    enabled: async () => (process.env.HARNESS_DATABASES === "off" ? ["session_vault"] : [...ENABLED]),
    catalog: CATALOG,
  }),
});
const server = startUiServer(
  {
    assets,
    port: Number(process.env.HARNESS_PORT ?? 0),
    runtime,
    audit: new ConsoleAudit(new AuditSpool({ dir: path.join(uiRoot, "spool"), writer: "ui" })),
    acts: { door: (request) => sendAct(rig.paths.localDoor, request) },
  },
  "127.0.0.1",
);

/** A signed-in session for a made-up person. The passphrase is random, used
 *  once here and kept nowhere. */
async function tokenFor(login: string, role: "operator" | "readonly"): Promise<string> {
  const created = await runtime.users.create(login, role);
  await runtime.users.completeSetup(created.token, randomBytes(24).toString("base64url"));
  const file = await runtime.readUsers();
  const user = file.users.find((candidate) => candidate.login === login);
  if (!user) throw new Error(`no such account: ${login}`);
  return runtime.sessions.issue({ user, file, remoteAddr: "127.0.0.1" }).token;
}

if (process.env.HARNESS_DAEMON === "stopped") await rig.host.stop();

const origin = `http://127.0.0.1:${server.port}`;
await writeFile(
  tokensFile,
  `${JSON.stringify({ origin, operator: await tokenFor("marta", "operator"), reader: await tokenFor("ruth", "readonly") })}\n`,
  { mode: 0o600 },
);
console.log(`The console's Databases page is at ${origin}/databases`);

// ── A bounded life ───────────────────────────────────────────────────────────

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(tick);
  runtime.streams.closeAll("shutdown");
  await server.stop(true);
  await rig.cleanup();
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
setTimeout(() => void stop(), LIFETIME_MS);
