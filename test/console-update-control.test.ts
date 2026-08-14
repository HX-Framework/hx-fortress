// The update path's two branches, the console's write surface, and the
// verification posture a console-initiated update runs under.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli";
import { AuditSpool } from "../src/console/audit-spool";
import { ConsoleAudit } from "../src/ui/audit-writer";
import { NO_POLLER_REFUSAL } from "../src/ui/copy";
import {
  handleMutateRoute,
  MUTATE_PATHS,
  MUTATE_ROUTES,
  OFFERED_COMMAND_KINDS,
  type ConsoleWritePort,
} from "../src/ui/mutate-routes";
import { gate, RouteRegistry } from "../src/ui/routes";
import { acquireUpdateLock } from "../src/update";
import {
  consoleUpdateGate,
  productionAnchorRefusal,
  UNSIGNED_BUILD_WARNING,
} from "../src/host/trust/verify";
import { hasProductionAnchor, PRODUCTION_KEYID_PREFIX } from "../src/host/trust/signing-keys";
import type { ConsoleCommandKind } from "../src/host/postgres/console-plane";
import type { UpdateResult } from "../src/update";
import type { ServiceManager, ServiceState, ServiceUnit } from "../src/service/types";
import type { UiServiceControl } from "../src/ui/service-control";

const INSTALLED: UpdateResult = {
  asset: "hx-fortress-linux-x64",
  sha256: "c".repeat(64),
  installedPath: "/opt/hx/hx-fortress",
  alreadyLatest: false,
  localVersion: "0.1.1",
  remoteVersion: "0.2.0",
};

async function withRoot<T>(work: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hx-update-"));
  try {
    await writeFile(
      path.join(root, "config.json"),
      JSON.stringify({
        schemaVersion: 1,
        cloud: { url: "wss://workbench.let.ai/_api/hx-gateway/vault-tunnel" },
        modules: { enabled: ["session_vault"] },
      }),
    );
    return await work(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("hx-fortress update", () => {
  test("with NO unit: swaps this process's binary and skips the restart", async () => {
    await withRoot(async (root) => {
      const manager = fakeManager({ present: false, executablePath: null }, [
        { loaded: false, pid: null },
      ]);
      let binPath: string | undefined;
      const code = await runCli(["update"], {
        fortressRoot: root,
        runUpdate: async (opts) => {
          binPath = opts.binPath;
          return INSTALLED;
        },
        getServiceManager: () => manager,
        getUiServiceControl: () => noUiUnit(),
        writeLine: () => {},
      });
      expect(code).toBe(0);
      expect(binPath).toBe(process.execPath);
      expect(manager.restarts).toBe(0);
    });
  });

  test("after a stop, the swap target still comes from the unit's ExecStart", async () => {
    await withRoot(async (root) => {
      // `hx-fortress stop` leaves the unit unloaded and the FILE in place. This
      // is the rung the runbook contains, and the branch a loaded-ness test
      // would get wrong.
      const manager = fakeManager({ present: true, executablePath: process.execPath }, [
        { loaded: false, pid: null },
      ]);
      let binPath: string | undefined;
      await runCli(["update"], {
        fortressRoot: root,
        runUpdate: async (opts) => {
          binPath = opts.binPath;
          return INSTALLED;
        },
        getServiceManager: () => manager,
        getUiServiceControl: () => noUiUnit(),
        writeLine: () => {},
      });
      expect(binPath).toBe(process.execPath);
      expect(manager.restarts).toBe(0);
    });
  });

  test("a divergent unit ExecStart is a named refusal, never a silent old-binary restart", async () => {
    await withRoot(async (root) => {
      const lines: string[] = [];
      let ran = false;
      const code = await runCli(["update"], {
        fortressRoot: root,
        runUpdate: async () => {
          ran = true;
          return INSTALLED;
        },
        getServiceManager: () =>
          fakeManager({ present: true, executablePath: "/opt/other/hx-fortress" }, [
            { loaded: true, pid: 5 },
          ]),
        getUiServiceControl: () => noUiUnit(),
        writeLine: (line) => lines.push(line),
      });
      expect(code).toBe(1);
      expect(ran).toBe(false);
      expect(lines[0]).toContain("refusing to update");
      expect(lines[0]).toContain("/opt/other/hx-fortress");
    });
  });

  test("with a console unit installed: the outcome is on disk BEFORE the restart", async () => {
    await withRoot(async (root) => {
      // Read SYNCHRONOUSLY at the moment of the restart: the ordering is the
      // property, and a restart can kill the process that owes the record.
      const seen: Array<string | null> = [];
      // The console must be ENABLED for the restart to fire: `installed()`
      // reports the unit file, and `ui disable` stops the unit without removing
      // it, so restarting on that alone put a console the operator had switched
      // off back on the network. The ordering property this test is named for is
      // unchanged; it just needs a console the daemon is allowed to restart.
      // Enabled on disk, because the restart is now gated on it: `installed()`
      // reports the unit FILE, and `ui disable` stops the unit without removing
      // it, so restarting on that alone put a console the operator had switched
      // off back on the network. The ordering property this test is named for is
      // unchanged; it just needs a console the CLI is allowed to restart.
      await mkdir(path.join(root, "ui"), { recursive: true });
      await writeFile(path.join(root, "ui", "ui.json"), JSON.stringify({ enabled: true }), "utf8");
      const code = await runCli(["update"], {
        fortressRoot: root,
        runUpdate: async () => INSTALLED,
        getServiceManager: () =>
          fakeManager({ present: true, executablePath: process.execPath }, [
            { loaded: false, pid: null },
          ]),
        getUiServiceControl: () => ({ ...noUiUnit(), installed: async () => true }),
        restartUiUnit: () => {
          seen.push(
            spoolRecordsSync(path.join(root, "ui", "spool")).find(
              (r) => r.action === "cli.update" && r.kind === "outcome",
            )?.outcome ?? null,
          );
        },
        writeLine: () => {},
      });
      expect(code).toBe(0);
      expect(seen).toEqual(["done"]);
      const records = await spoolRecords(path.join(root, "ui", "spool"));
      const update = records.filter((r) => r.action === "cli.update");
      expect(update.map((r) => r.kind)).toEqual(["intent", "outcome"]);
      expect(update[1]?.outcome).toBe("done");
    });
  });

  test("two updaters on one binary: one proceeds, the other is refused", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hx-lock-"));
    try {
      const binPath = path.join(dir, "hx-fortress");
      const first = await acquireUpdateLock(binPath);
      expect(first.ok).toBe(true);
      const second = await acquireUpdateLock(binPath);
      expect(second.ok).toBe(false);
      if (first.ok) await first.release();
      const third = await acquireUpdateLock(binPath);
      expect(third.ok).toBe(true);
      if (third.ok) await third.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the console's verification posture", () => {
  test("this build has no production anchor, so it warns instead of offering a dead button", () => {
    expect(hasProductionAnchor()).toBe(false);
    expect(consoleUpdateGate()).toEqual({ enforce: false, warning: UNSIGNED_BUILD_WARNING });
  });

  test("an anchor alone does NOT enforce — the flag has to be on too", () => {
    // The runbook bakes production anchors at rung 8, whose acceptance criterion
    // is that the assets still carry no `.sig`; signing starts at rung 12, a
    // separate later release. Enforcing on the anchor alone made every
    // console-initiated update fail on a missing signature for that whole
    // window — the outcome the gate exists to avoid.
    const anchors = [{ keyid: `${PRODUCTION_KEYID_PREFIX}2026-08`, publicKey: "AAAA", production: true }];
    expect(consoleUpdateGate(anchors, false)).toEqual({ enforce: false, warning: null });
    expect(consoleUpdateGate(anchors, true)).toEqual({ enforce: true, warning: null });
  });

  test("enforcement against development-only anchors is a NAMED refusal", () => {
    expect(() =>
      consoleUpdateGate([{ keyid: "hxf-dev-2026-07", publicKey: "AAAA", production: false }], true),
    ).toThrow(productionAnchorRefusal());
  });

  test("the prefix and the flag must AGREE — neither alone promotes a key", () => {
    expect(
      hasProductionAnchor([{ keyid: "hxf-dev-2026-07", publicKey: "A", production: true }]),
    ).toBe(false);
    expect(
      hasProductionAnchor([
        { keyid: `${PRODUCTION_KEYID_PREFIX}x`, publicKey: "A", production: false },
      ]),
    ).toBe(false);
  });
});

describe("the console's write surface", () => {
  test("is classified `mutate`, so a readonly session is refused by the gate", () => {
    const registry = new RouteRegistry();
    for (const route of MUTATE_ROUTES) registry.register(route);
    for (const spec of MUTATE_ROUTES) {
      const route = registry.lookup("POST", spec.path);
      expect(gate({ method: "POST", path: spec.path, route, role: "readonly" })).toMatchObject({
        allow: false,
        status: 403,
      });
      expect(gate({ method: "POST", path: spec.path, route, role: "operator" })).toMatchObject({
        allow: true,
      });
      expect(gate({ method: "POST", path: spec.path, route, role: null })).toMatchObject({
        allow: false,
        status: 401,
      });
    }
  });

  test("drives the daemon's unit and answers with the server's own sentence", async () => {
    await withAudit(async (audit) => {
      const port = fakePort();
      const res = await handleMutateRoute(post(MUTATE_PATHS.service, { action: "restart" }), {
        port,
        audit,
        actor: "op",
        sessionId: "s1",
      });
      expect(res?.status).toBe(200);
      expect(((await res?.json()) as { copy: string }).copy).toContain("restarted");
      expect(port.actions).toEqual(["restart"]);
    });
  });

  test("refuses an unknown action and an orchestrator-owned lifecycle", async () => {
    await withAudit(async (audit) => {
      const ctx = { port: fakePort({ refusal: "your orchestrator owns this" }), audit, actor: "op", sessionId: "s1" };
      const bad = await handleMutateRoute(post(MUTATE_PATHS.service, { action: "reboot" }), ctx);
      expect(bad?.status).toBe(400);
      const blocked = await handleMutateRoute(post(MUTATE_PATHS.service, { action: "stop" }), ctx);
      expect(blocked?.status).toBe(409);
      expect(ctx.port.actions).toEqual([]);
    });
  });

  test("mints a command row, and refuses when nothing is polling for it", async () => {
    await withAudit(async (audit) => {
      const port = fakePort();
      const ok = await handleMutateRoute(post(MUTATE_PATHS.commands, { kind: "update_apply" }), {
        port,
        audit,
        actor: "op",
        sessionId: "s1",
      });
      expect(ok?.status).toBe(202);
      expect(port.submitted).toEqual([["update_apply", "op"]]);

      const stale = fakePort({ heartbeat: null });
      const refused = await handleMutateRoute(
        post(MUTATE_PATHS.commands, { kind: "update_apply" }),
        { port: stale, audit, actor: "op", sessionId: "s1" },
      );
      expect(refused?.status).toBe(409);
      expect(((await refused?.json()) as { error: string }).error).toBe(NO_POLLER_REFUSAL);
      expect(stale.submitted).toEqual([]);
    });
  });

  test("refuses a kind this console has no control for, and one with bad parameters", async () => {
    await withAudit(async (audit) => {
      const port = fakePort();
      const ctx = { port, audit, actor: "op", sessionId: "s1" };
      // A build whose console has no control for a kind refuses it BY NAME
      // rather than queueing a row for an executor nothing would drive. Every
      // shipped kind is offered today, so the narrowed port is what exercises
      // the branch — the guard is the contract, not the current list.
      const narrowed = fakePort({ offered: ["update_apply"] });
      const unoffered = await handleMutateRoute(
        post(MUTATE_PATHS.commands, { kind: "run_migration", params: { phase: "arm" } }),
        { ...ctx, port: narrowed },
      );
      expect(unoffered?.status).toBe(404);
      expect(narrowed.submitted).toEqual([]);
      const invalid = await handleMutateRoute(
        post(MUTATE_PATHS.commands, { kind: "update_apply", params: { nope: 1 } }),
        ctx,
      );
      expect(invalid?.status).toBe(400);
      expect(port.submitted).toEqual([]);
    });
  });

  test("records an intent/outcome pair around every act", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hx-audit-"));
    try {
      const audit = new ConsoleAudit(new AuditSpool({ dir, writer: "ui" }));
      await handleMutateRoute(post(MUTATE_PATHS.service, { action: "stop" }), {
        port: fakePort(),
        audit,
        actor: "op",
        sessionId: "s1",
      });
      const records = (await spoolRecords(dir)).filter((r) => r.action === "console.service.stop");
      expect(records.map((r) => r.kind)).toEqual(["intent", "outcome"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

function post(pathname: string, body: unknown): Request {
  return new Request(`http://console.local${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function withAudit(work: (audit: ConsoleAudit) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hx-audit-"));
  try {
    await work(new ConsoleAudit(new AuditSpool({ dir, writer: "ui" })));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface FakePort extends ConsoleWritePort {
  actions: string[];
  submitted: Array<[string, string]>;
}

function fakePort(
  options: {
    refusal?: string;
    heartbeat?: string | null;
    offered?: readonly ConsoleCommandKind[];
  } = {},
): FakePort {
  return {
    actions: [],
    submitted: [],
    serviceRefusal: () => options.refusal ?? null,
    async service(action) {
      this.actions.push(action);
      return { action, manager: "systemd (user)", pid: 42, copy: `Fortress restarted (pid 42).` };
    },
    async heartbeatAt() {
      return options.heartbeat === undefined ? new Date().toISOString() : options.heartbeat;
    },
    offered: () => options.offered ?? OFFERED_COMMAND_KINDS,
    async mintCredential() {
      return "0".repeat(32);
    },
    async submit(kind, _params, requestedBy) {
      this.submitted.push([kind, requestedBy]);
      return { id: "00000000-0000-4000-8000-000000000000" };
    },
  } as FakePort;
}

interface SpoolRecord {
  action: string;
  kind: string;
  outcome: string | null;
}

function spoolRecordsSync(dir: string): SpoolRecord[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  const out: SpoolRecord[] = [];
  for (const file of files) {
    for (const line of readFileSync(path.join(dir, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      out.push(JSON.parse(line) as SpoolRecord);
    }
  }
  return out;
}

async function spoolRecords(dir: string): Promise<SpoolRecord[]> {
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".jsonl")).sort();
  const out: SpoolRecord[] = [];
  for (const file of files) {
    const text = await readFile(path.join(dir, file), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      out.push(JSON.parse(line) as SpoolRecord);
    }
  }
  return out;
}

interface FakeManager extends ServiceManager {
  restarts: number;
  installs: number;
}

function fakeManager(unit: Omit<ServiceUnit, "path">, states: ServiceState[]): FakeManager {
  const queue = [...states];
  return {
    name: "systemd (user)",
    restarts: 0,
    installs: 0,
    async unit() {
      return { path: "/home/op/.config/systemd/user/hx-fortress.service", ...unit };
    },
    async state() {
      return queue.shift() ?? states[states.length - 1] ?? { loaded: false, pid: null };
    },
    async install() {
      this.installs += 1;
    },
    async start() {},
    async restart() {
      this.restarts += 1;
    },
    async stop() {
      return { wasRunning: false };
    },
    async uninstall() {},
    async ensureLogDir() {},
  } as FakeManager;
}

function noUiUnit(): UiServiceControl {
  return {
    name: "none",
    async installed() {
      return false;
    },
    async install() {},
    async start() {},
    async uninstall() {},
    async stopAndDisable() {},
  };
}
