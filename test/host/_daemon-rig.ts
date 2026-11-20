// For the tests of how a module is wired into this build: the daemon,
// composed as `hx-fortress host` composes it and not run, and one module's
// own lines in the terminal's list of modules.
//
// Apart from `_module-rig.ts` on purpose: this file loads the whole daemon,
// and most tests of a module need none of it.

import type { WsCloudConnectionDeps } from "../../src/cloud";
import { runFortressHost } from "../../src/host/main";
import type { ModuleRegistry } from "../../src/host/module-registry";
import type { CloudConnection } from "../../src/host/types";
import type { Paths } from "./_module-rig";

/** The one variable of the environment the daemon needs to be composed. */
const DAEMON_KEY = "FORTRESS_OPENAI_API_KEY";
const priorKey = process.env[DAEMON_KEY];

/**
 * Compose the daemon exactly as `hx-fortress host` does, without running it.
 * Answers what the daemon handed its connection to the control plane, and the
 * registry of its modules.
 *
 * It sets the one variable the daemon needs. A test file that calls this
 * puts the environment back when a test ends (`restoreDaemonEnvironment`).
 */
export async function composeDaemon(
  paths: Paths,
): Promise<{ deps: WsCloudConnectionDeps; registry: ModuleRegistry }> {
  // eslint-disable-next-line security/detect-object-injection -- this file's own constant
  process.env[DAEMON_KEY] = "sk-test-fortress-openai-key";
  let captured: WsCloudConnectionDeps | null = null;
  await runFortressHost({
    root: paths.root,
    version: "0.0.0-test",
    createConnection(dependencies) {
      captured = dependencies;
      const connection: CloudConnection = {
        state: () => "offline",
        status: () => ({ state: "offline", reason: null, message: null }),
        open: async () => {},
        close: async () => {},
        notifyIngest: () => {},
      };
      return connection;
    },
    run: async () => {},
  });
  if (!captured) throw new Error("the connection was never built");
  const deps = captured as WsCloudConnectionDeps;
  return { deps, registry: deps.dispatcher as ModuleRegistry };
}

/** Put the environment back as it was before any daemon was composed. For a
 *  test file's `afterEach`. */
export function restoreDaemonEnvironment(): void {
  // eslint-disable-next-line security/detect-object-injection, @typescript-eslint/no-dynamic-delete -- this file's own constant
  if (priorKey === undefined) delete process.env[DAEMON_KEY];
  // eslint-disable-next-line security/detect-object-injection -- this file's own constant
  else process.env[DAEMON_KEY] = priorKey;
}

/**
 * One module's own lines in what `hx-fortress modules list` printed: from the
 * line `heading`, such as `stores (Stores): off`, up to where the next
 * module's lines begin. Empty when the list has no such line.
 */
export function moduleLines(out: readonly string[], heading: string): string[] {
  const from = out.indexOf(heading);
  if (from === -1) return [];
  const next = out.findIndex((line, at) => at > from && /^\S+ \(.+\): (?:on|off)$/.test(line));
  return out.slice(from, next === -1 ? undefined : next);
}
