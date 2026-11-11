import { afterEach, describe, expect, test } from "bun:test";

import { AuditSpool } from "../../src/console/audit-spool";
import { verifyGrant } from "../../src/gateway/capability-token";
import { setModuleEnabled } from "../../src/host/config";
import { MODULE_CATALOG } from "../../src/host/module-catalog";
import { manifestDefect } from "../../src/host/module-contract";
import { ModuleHost } from "../../src/host/module-host";
import { ModuleRegistry } from "../../src/host/module-registry";
import type { HxDb } from "../../src/host/postgres/db";
import { conform } from "../../src/host/shape";
import { AuditTrail, lineKind } from "../../src/modules/host/audit-trail";
import { HOST_MANIFEST, LINE_KINDS } from "../../src/modules/host/manifest";
import { createHostModule } from "../../src/modules/host/module";
import {
  captureBus,
  fixedSecrets,
  legacyModule,
  makeOrgKey,
  makeReleaseSigner,
  ORG,
  sha256Hex,
  spoolRecords,
  tempRoot,
  writeConfig,
  type OrgKey,
  type Paths,
  type ReleaseSigner,
} from "../host/_module-rig";

interface HostRig {
  paths: Paths;
  host: ModuleHost;
  key: OrgKey;
  now: { value: Date };
  db: { value: HxDb | null; statements: unknown[] };
  secretsSetting: { broken: boolean };
  /** The key this rig's fortress trusts for releases. */
  signer: ReleaseSigner;
  ask(name: string, args?: Record<string, unknown>): Promise<unknown>;
  cleanup(): Promise<void>;
}

let rig: HostRig;
afterEach(async () => {
  await rig?.cleanup();
});

/** A daemon-shaped host with the REAL catalog and the real `host` module, over
 *  a table that is empty unless a test says otherwise. */
async function hostRig(enabled: readonly string[] = ["session_vault", "host"]): Promise<HostRig> {
  const { paths, cleanup } = await tempRoot();
  await writeConfig(paths, enabled);
  const now = { value: new Date("2027-03-14T12:00:00.000Z") };
  const clock = (): Date => new Date(now.value.getTime());
  const key = await makeOrgKey(clock);
  const { bus } = captureBus();
  const registry = new ModuleRegistry(bus);
  registry.register(legacyModule());
  const statements: unknown[] = [];
  const emptyTable = {
    execute: async (statement: unknown) => {
      statements.push(statement);
      return [];
    },
  } as unknown as HxDb;
  const db: HostRig["db"] = { value: emptyTable, statements };
  const store = fixedSecrets({});
  const secretsSetting = { broken: false };
  const signer = await makeReleaseSigner("hxf-prod-test-1", true);
  const host: ModuleHost = new ModuleHost({
    paths,
    registry,
    bus,
    version: "0.37.0",
    secrets: async () => {
      if (secretsSetting.broken) throw new Error("Invalid secrets config: secrets must be an object");
      return store;
    },
    verifyGrant: (token, bind) =>
      verifyGrant(token, key.publicKey, ORG, { purpose: "module", ...bind, now: clock }),
    clock,
    env: {},
    trustedKeys: signer.trusted,
  });
  host.provide(
    createHostModule({
      version: "0.37.0",
      secretsKind: () => host.secretsKind(),
      modules: () => host.modulesView(),
      releases: () => host.shelf.list(),
      trail: new AuditTrail({ spoolDir: paths.auditSpool, db: () => db.value }),
    }),
  );
  await host.start();
  await registry.startAll(enabled);
  await host.started();
  return {
    paths,
    host,
    key,
    now,
    db,
    secretsSetting,
    signer,
    ask: async (name, args = {}) => {
      const reply = await host.asks.handle({
        module: "host",
        id: `m-${name}`,
        kind: "request",
        payload: { v: 1, ask: name, args, grant: await key.grant("host", name, args) },
      });
      return reply;
    },
    cleanup: async () => {
      await host.stop();
      await cleanup();
    },
  };
}

const DAY = { from: "2027-03-14T00:00:00.000Z", to: "2027-03-14T23:59:59.999Z" };

/** Write records as another process would have: a console, a terminal. */
async function seed(
  paths: Paths,
  writer: "ui" | "cli" | "modules",
  at: string,
  write: (spool: AuditSpool) => Promise<unknown>,
): Promise<void> {
  await write(new AuditSpool({ dir: paths.auditSpool, writer, clock: () => new Date(at) }));
}

describe("the host manifest", () => {
  test("is one the host can enforce, and is what the catalog lists", () => {
    expect(manifestDefect(HOST_MANIFEST)).toBeNull();
    expect(MODULE_CATALOG.find((entry) => entry.id === "host")?.manifest).toBe(HOST_MANIFEST);
    expect(HOST_MANIFEST.asks.map((ask) => ask.name)).toEqual(["status", "audit.count", "audit.read"]);
    // It calls nothing and reads no secret.
    expect(HOST_MANIFEST.egress).toEqual([]);
    expect(HOST_MANIFEST.secrets).toEqual([]);
  });

  test("is off until somebody switches it on", async () => {
    rig = await hostRig(["session_vault"]);
    expect(await rig.ask("status")).toEqual({ ok: false, error: "module_off" });
    await setModuleEnabled(rig.paths, "host", true);
    expect(await rig.ask("status")).toMatchObject({ ok: true });
  });
});

describe("status", () => {
  test("says what this Fortress is, which modules are on, and nothing else", async () => {
    rig = await hostRig();
    expect(await rig.ask("status")).toEqual({
      ok: true,
      payload: {
        version: "0.37.0",
        secrets: "file",
        sessions: true,
        modules: [
          { id: "session_vault", on: true, version: "0.37.0" },
          { id: "host", on: true, version: "0.37.0" },
        ],
        releases: [],
      },
    });
  });

  test("reports Sessions off as a flag, not as a missing module", async () => {
    rig = await hostRig(["host"]);
    const reply = (await rig.ask("status")) as {
      payload: { sessions: boolean; modules: { id: string; on: boolean; version: string }[] };
    };
    expect(reply.payload.sessions).toBe(false);
    expect(reply.payload.modules).toContainEqual({ id: "session_vault", on: false, version: "0.37.0" });
  });

  test("reports Sessions as this run has it, not as a switch that waits for a restart", async () => {
    rig = await hostRig();
    // Switched off at the terminal. The daemon reads this switch only when it
    // starts, so this run still stores sessions, and that is what it says.
    await setModuleEnabled(rig.paths, "session_vault", false);
    await rig.host.applyRequests();
    const still = (await rig.ask("status")) as {
      payload: { sessions: boolean; modules: { id: string; on: boolean }[] };
    };
    expect(still.payload.sessions).toBe(true);
    expect(still.payload.modules).toContainEqual(expect.objectContaining({ id: "session_vault", on: true }));
    // A module this host follows is reported as its switch reads now.
    expect(still.payload.modules).toContainEqual(expect.objectContaining({ id: "host", on: true }));
    await rig.cleanup();

    // The other way round: started with Sessions off, switched on since.
    rig = await hostRig(["host"]);
    await setModuleEnabled(rig.paths, "session_vault", true);
    await rig.host.applyRequests();
    const off = (await rig.ask("status")) as { payload: { sessions: boolean } };
    expect(off.payload.sessions).toBe(false);
  });

  test("does not guess where the keys are when the secrets setting cannot be read", async () => {
    rig = await hostRig();
    rig.secretsSetting.broken = true;
    expect(await rig.ask("status")).toEqual({ ok: false, error: "failed:secrets_setting_invalid" });
    // The setting is read again on the next ask, with no restart.
    rig.secretsSetting.broken = false;
    expect(await rig.ask("status")).toMatchObject({ ok: true, payload: { secrets: "file" } });
  });

  test("takes no arguments", async () => {
    rig = await hostRig();
    expect(await rig.ask("status", { verbose: true })).toEqual({ ok: false, error: "args_invalid" });
  });
});

describe("audit.read", () => {
  test("returns a line per act, newest first, with who did what to what and how it ended", async () => {
    rig = await hostRig();
    await seed(rig.paths, "ui", "2027-03-14T09:12:00.000Z", (spool) =>
      spool.event("console.signin", { actor: "alice", params: { login: "alice", role: "operator" }, outcome: "signed in" }),
    );
    await seed(rig.paths, "cli", "2027-03-14T10:00:00.000Z", async (spool) => {
      const intent = await spool.intent("cli.module.on", { actor: "root operator (terminal)", params: { module: "host", state: "on" } });
      await spool.outcome(intent, "done");
    });
    rig.now.value = new Date("2027-03-14T11:00:00.000Z");
    await rig.ask("status");
    const reply = (await rig.ask("audit.read", { ...DAY, limit: 100 })) as {
      ok: true;
      payload: { lines: Record<string, string>[]; next?: string };
    };
    expect(reply.ok).toBe(true);
    const lines = reply.payload.lines.map((line) =>
      Object.fromEntries(Object.entries(line).filter(([field]) => field !== "id")),
    );
    expect(lines).toEqual([
      { at: "2027-03-14T11:00:00.000Z", actorKind: "relay", actor: "relay", action: "relay.ask", target: "host:status", outcome: "ok" },
      { at: "2027-03-14T10:00:00.000Z", actorKind: "person", actor: "terminal operator", action: "cli.module.on", target: "host", outcome: "ok" },
      { at: "2027-03-14T09:12:00.000Z", actorKind: "person", actor: "alice", action: "console.signin", target: "alice", outcome: "ok" },
    ]);
    expect(reply.payload.next).toBeUndefined();
    for (const line of reply.payload.lines) expect(line.id).toMatch(/^\d+-[0-9a-f]{32}-\d+$/);
  });

  test("pages with `next`, never repeating and never skipping a line", async () => {
    rig = await hostRig();
    await seed(rig.paths, "ui", "2027-03-14T09:00:00.000Z", async (spool) => {
      for (let i = 0; i < 7; i += 1) {
        await spool.event("console.signin", { actor: `user-${i}`, params: { login: `user-${i}` }, outcome: "signed in" });
      }
    });
    const seen: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const reply = (await rig.ask("audit.read", {
        ...DAY,
        kind: "sign_in",
        limit: 3,
        ...(before ? { before } : {}),
      })) as { payload: { lines: { actor: string }[]; next?: string } };
      seen.push(...reply.payload.lines.map((line) => line.actor));
      before = reply.payload.next;
      if (!before) break;
    }
    // Same instant for all seven, so the order is by sequence: newest first.
    expect(seen).toEqual(["user-6", "user-5", "user-4", "user-3", "user-2", "user-1", "user-0"]);
  });

  test("narrows by kind and by the period", async () => {
    rig = await hostRig();
    await seed(rig.paths, "ui", "2027-03-13T23:59:59.000Z", (spool) =>
      spool.event("console.signin", { actor: "yesterday", params: { login: "yesterday" } }),
    );
    await seed(rig.paths, "ui", "2027-03-14T09:00:00.000Z", (spool) =>
      spool.event("console.signin", { actor: "today", params: { login: "today" } }),
    );
    await rig.host.asks.handle({ module: "host", id: "x", kind: "request", payload: { v: 1, ask: "status", args: {} } });
    const read = async (args: Record<string, unknown>) =>
      ((await rig.ask("audit.read", { ...DAY, limit: 100, ...args })) as { payload: { lines: { action: string; actor: string; outcome: string }[] } }).payload.lines;
    expect((await read({ kind: "sign_in" })).map((line) => line.actor)).toEqual(["today"]);
    const asks = await read({ kind: "ask" });
    expect(asks.at(-1)).toMatchObject({ action: "relay.ask", outcome: "refused" });
    expect(await read({ kind: "release" })).toEqual([]);
    expect(await read({ from: "2027-03-15T00:00:00.000Z", to: "2027-03-16T00:00:00.000Z" })).toEqual([]);
  });

  test("a sign-in that failed names nobody: what was typed into the form stays here", async () => {
    rig = await hostRig();
    // Somebody typed their password into the login field. It has the form of a
    // login, so the console recorded it as one.
    await seed(rig.paths, "ui", "2027-03-14T09:00:00.000Z", async (spool) => {
      await spool.event("console.signin.failed", {
        actor: "correct-horse-battery",
        params: { login: "correct-horse-battery", attempts: 3 },
      });
      await spool.event("console.signin.failed.oidc.group_missing", {
        actor: "sub:8f1c2a",
        params: { login: "sub:8f1c2a", attempts: 1 },
      });
    });
    const reply = (await rig.ask("audit.read", { ...DAY, kind: "sign_in", limit: 10 })) as {
      ok: boolean;
      payload: { lines: { actor: string; target: string; outcome: string; action: string }[] };
    };
    expect(reply.ok).toBe(true);
    expect(reply.payload.lines.map((line) => [line.action, line.actor, line.target, line.outcome])).toEqual([
      ["console.signin.failed.oidc.group_missing", "unknown", "console", "refused"],
      ["console.signin.failed", "unknown", "console", "refused"],
    ]);
    expect(JSON.stringify(reply)).not.toContain("correct-horse");
    expect(JSON.stringify(reply)).not.toContain("8f1c2a");
  });

  test("a value that is not a name is replaced whole, never rewritten into one", async () => {
    rig = await hostRig();
    await seed(rig.paths, "ui", "2027-03-14T09:00:00.000Z", async (spool) => {
      // An account whose login is not made of name characters, signing in.
      await spool.event("console.signin", {
        actor: "<script>alert('x')</script>; DROP TABLE",
        params: { login: "robert'); DROP TABLE users;--" },
        outcome: "signed in",
      });
      // And one whose login is longer than a name may be.
      await spool.event("console.signout", { actor: "x".repeat(129), params: { login: "y".repeat(129) } });
    });
    const reply = (await rig.ask("audit.read", { ...DAY, kind: "sign_in", limit: 10 })) as {
      ok: boolean;
      payload: { lines: { actor: string; target: string }[] };
    };
    expect(reply.ok).toBe(true);
    expect(reply.payload.lines.map((line) => [line.actor, line.target])).toEqual([
      ["unknown", "console"],
      ["unknown", "console"],
    ]);
    // Not one character of either value left this host, in any form.
    for (const piece of ["script", "alert", "DROP", "robert", "users", "xxxx", "yyyy"]) {
      expect(JSON.stringify(reply)).not.toContain(piece);
    }
  });

  test("of a module's own record, only its `target` and a job's `job` leave", async () => {
    rig = await hostRig();
    await seed(rig.paths, "modules", "2027-03-14T09:00:00.000Z", async (spool) => {
      await spool.event("module.stores.sync", {
        params: { target: "warehouse", table: "invoices", store: "eu-7", name: "Maria", rows: 1204 },
        outcome: "done",
      });
      await spool.event("module.stores.job.nightly", {
        params: { job: "nightly-copy", target: "orders", table: "payroll" },
        outcome: "done",
      });
      // A record that names no target is reported under its module's id.
      await spool.event("module.stores.check", { params: { table: "salaries" }, outcome: "done" });
    });
    const reply = (await rig.ask("audit.read", { ...DAY, kind: "module", limit: 10 })) as {
      payload: { lines: { actorKind: string; actor: string; action: string; target: string }[] };
    };
    expect(reply.payload.lines.map((l) => [l.action, l.actorKind, l.actor, l.target])).toEqual([
      ["module.stores.check", "fortress", "fortress", "stores"],
      ["module.stores.job.nightly", "job", "nightly-copy", "orders"],
      ["module.stores.sync", "fortress", "fortress", "warehouse"],
    ]);
    for (const hidden of ["invoices", "eu-7", "Maria", "1204", "payroll", "salaries"]) {
      expect(JSON.stringify(reply)).not.toContain(hidden);
    }
  });

  test("a record's parameters, error text and session reference do not leave", async () => {
    rig = await hostRig();
    await seed(rig.paths, "ui", "2027-03-14T09:00:00.000Z", (spool) =>
      spool.event("console.command.submit", {
        actor: "bo",
        sessionRef: "command-7f3a",
        params: { commandKind: "rotate_credentials", reason: "the old key leaked in ticket 4471" },
        error: "connection to 10.1.2.3 refused",
      }),
    );
    const reply = await rig.ask("audit.read", { ...DAY, limit: 10 });
    const text = JSON.stringify(reply);
    expect(text).toContain("rotate_credentials");
    for (const hidden of ["ticket 4471", "10.1.2.3", "command-7f3a", "leaked"]) {
      expect(text).not.toContain(hidden);
    }
  });

  test("refuses a limit over 100, a bad cursor and an inverted period", async () => {
    rig = await hostRig();
    expect(await rig.ask("audit.read", { ...DAY, limit: 101 })).toEqual({ ok: false, error: "args_invalid" });
    expect(await rig.ask("audit.read", { ...DAY })).toEqual({ ok: false, error: "args_invalid" });
    expect(await rig.ask("audit.read", { ...DAY, limit: 5, kind: "everything" })).toEqual({ ok: false, error: "args_invalid" });
    expect(await rig.ask("audit.read", { ...DAY, limit: 5, before: "not-a-cursor" })).toEqual({
      ok: false,
      error: "failed:cursor_invalid",
    });
    expect(await rig.ask("audit.read", { from: DAY.to, to: DAY.from, limit: 5 })).toEqual({
      ok: false,
      error: "failed:range_invalid",
    });
    expect(await rig.ask("audit.read", { ...DAY, limit: 0 })).toEqual({ ok: true, payload: { lines: [] } });
  });

  test("a database that cannot be asked is an error, never a shorter answer", async () => {
    rig = await hostRig();
    rig.db.value = null;
    expect(await rig.ask("audit.read", { ...DAY, limit: 5 })).toEqual({ ok: false, error: "failed:database_unavailable" });
    expect(await rig.ask("audit.count", DAY)).toEqual({ ok: false, error: "failed:database_unavailable" });
    rig.db.value = {
      execute: async () => {
        throw new Error("connection to postgresql://hx_app_rw:hunter2@127.0.0.1 failed");
      },
    } as unknown as HxDb;
    const reply = await rig.ask("audit.read", { ...DAY, limit: 5 });
    expect(reply).toEqual({ ok: false, error: "failed:database_unavailable" });
    expect(JSON.stringify(await spoolRecords(rig.paths))).not.toContain("hunter2");
  });

  test("the table is asked for everything except the files still on disk", async () => {
    rig = await hostRig();
    await rig.ask("status");
    rig.db.statements.length = 0;
    await rig.ask("audit.read", { ...DAY, limit: 5 });
    expect(rig.db.statements).toHaveLength(1);
  });
});

describe("audit.count", () => {
  test("counts asks allowed and refused, installs, sign-ins, and releases that wait", async () => {
    rig = await hostRig();
    await rig.ask("status");
    await rig.ask("status");
    await rig.ask("status", { extra: 1 });
    // A burst of refusals is a few records standing for many asks.
    for (let i = 0; i < 12; i += 1) {
      await rig.host.asks.handle({ module: "host", id: `r${i}`, kind: "request", payload: { v: 1, ask: "status", args: {} } });
    }
    await rig.host.audit.flush();
    await seed(rig.paths, "ui", "2027-03-14T09:00:00.000Z", async (spool) => {
      await spool.event("console.signin", { actor: "a", params: { login: "a" }, outcome: "signed in" });
      await spool.event("console.signin", { actor: "b", params: { login: "b" }, outcome: "signed in" });
      await spool.event("console.signin.failed", { actor: "c", params: { login: "c", attempts: 9 } });
    });
    const reply = await rig.ask("audit.count", DAY);
    expect(reply).toEqual({
      ok: true,
      payload: { asksAllowed: 2, asksRefused: 13, releasesInstalled: 0, releasesWaiting: 0, signIns: 2 },
    });
  });

  test("counts only the period", async () => {
    rig = await hostRig();
    await rig.ask("status");
    const reply = await rig.ask("audit.count", { from: "2027-03-15T00:00:00.000Z", to: "2027-03-16T00:00:00.000Z" });
    expect(reply).toMatchObject({ payload: { asksAllowed: 0, asksRefused: 0, signIns: 0 } });
  });
});

describe("a release, as status and the counts see it", () => {
  test("waiting, then installed", async () => {
    rig = await hostRig();
    // The host module itself takes no releases; the shelf says so.
    const bytes = new TextEncoder().encode("x");
    const refused = await rig.host.releases.offer({
      moduleId: "host",
      version: "1.0.0",
      artifactUrl: "https://relay.example/modules/x.bin",
      checksum: sha256Hex(bytes),
      signature: await rig.signer.release("host", "1.0.0", sha256Hex(bytes)),
    });
    expect(refused).toMatchObject({ ok: false, error: "refused:module_takes_no_releases" });
    const status = (await rig.ask("status")) as { payload: { releases: unknown[] } };
    expect(status.payload.releases).toEqual([]);
  });
});

describe("every reply has its declared shape", () => {
  test.each(HOST_MANIFEST.asks.map((ask) => ask.name))("%s", async (name) => {
    rig = await hostRig();
    await rig.ask("status");
    const args = name === "status" ? {} : name === "audit.count" ? DAY : { ...DAY, limit: 100 };
    const reply = (await rig.ask(name, args)) as { ok: boolean; payload: unknown };
    expect(reply.ok).toBe(true);
    const spec = HOST_MANIFEST.asks.find((ask) => ask.name === name);
    expect(conform(spec!.reply, reply.payload)).toEqual({ ok: true, value: reply.payload });
  });
});

describe("the kinds of line", () => {
  test("every action lands in exactly one kind", () => {
    const cases: Record<string, string> = {
      "relay.ask": "ask",
      "relay.release.offer": "release",
      "system.release.install": "release",
      "cli.release.approve": "release",
      "relay.module.remove": "module",
      "cli.module.on": "module",
      "system.module.switch": "module",
      "module.stores.job.started": "module",
      "console.signin": "sign_in",
      "console.signin.failed": "sign_in",
      "console.sso.exchange": "sign_in",
      "console.command.submit": "command",
      "console.service.restart": "command",
      "console.export.audit": "other",
      "cli.update": "other",
      "system.roster_purge": "other",
    };
    for (const [action, kind] of Object.entries(cases)) expect([action, lineKind(action)]).toEqual([action, kind]);
    expect(new Set(Object.values(cases))).toEqual(new Set(LINE_KINDS));
  });
});
