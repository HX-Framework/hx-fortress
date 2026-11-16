import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ConnectionView, DayView } from "../../src/cloud/counts";
import { MESSAGE_KINDS } from "../../src/cloud/kinds";
import { AUDIT_ACTIONS } from "../../src/console/audit-actions";
import { AuditSpool } from "../../src/console/audit-spool";
import { verifyGrant } from "../../src/gateway/capability-token";
import { setModuleEnabled } from "../../src/host/config";
import { MODULE_CATALOG } from "../../src/host/module-catalog";
import { manifestDefect } from "../../src/host/module-contract";
import { ModuleHost, moduleGrantOptions } from "../../src/host/module-host";
import { ModuleRegistry } from "../../src/host/module-registry";
import type { HxDb } from "../../src/host/postgres/db";
import { conform, describeShape } from "../../src/host/shape";
import { AuditTrail, lineKind } from "../../src/modules/host/audit-trail";
import {
  AUDIT_COUNT_MAX_ASKS,
  CONNECTION_COUNT_MAX_DAYS,
  HOST_MANIFEST,
  LINE_KINDS,
} from "../../src/modules/host/manifest";
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
  writeOrganizations,
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
  /** What the daemon's counts answer for a period: `value` is the days, or
   *  null while the counts of earlier runs are not known. `asked` is every
   *  period the module asked for, as two UTC days. */
  days: { value: DayView[] | null; asked: [string, string][] };
  /** `broken`: the secrets setting cannot be read. `kind`: the name the key
   *  store gives itself, when a test wants one other than the rig's "file". */
  secretsSetting: { broken: boolean; kind: string | null };
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
  const days: HostRig["days"] = { value: [], asked: [] };
  const store = fixedSecrets({});
  const secretsSetting: HostRig["secretsSetting"] = { broken: false, kind: null };
  const signer = await makeReleaseSigner("hxf-prod-test-1", true);
  const host: ModuleHost = new ModuleHost({
    paths,
    registry,
    bus,
    version: "0.37.0",
    secrets: async () => {
      if (secretsSetting.broken) throw new Error("Invalid secrets config: secrets must be an object");
      if (secretsSetting.kind === null) return store;
      // The same store under another name, as a key store of another kind.
      return { ...store, kind: secretsSetting.kind } as unknown as typeof store;
    },
    verifyGrant: (token, bind) =>
      verifyGrant(token, key.publicKey, ORG, { ...moduleGrantOptions(bind, ORG), now: clock }),
    enrolledAs: async () => ORG,
    clock,
    env: {},
    trustedKeys: signer.trusted,
  });
  host.provide(
    createHostModule({
      version: "0.37.0",
      secretsKind: () => host.secretsKind(),
      modules: (organization) => host.modulesView(organization),
      releases: (organization) => host.releasesFor(organization),
      connection: () => CONNECTION,
      connectionDays: (fromDay, toDay) => {
        days.asked.push([fromDay, toDay]);
        return days.value;
      },
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
    days,
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

/** What the connection carried on the day of these tests, as the daemon hands
 *  it to the module. */
const CONNECTION: ConnectionView = {
  sessionContent: "off",
  since: "2027-03-14T00:00:00.000Z",
  messages: [
    { kind: "greeting", frame: "welcome", direction: "in", count: 1, refused: 0 },
    { kind: "greeting", frame: "hello", direction: "out", count: 1, refused: 0 },
    { kind: "ask", frame: "moduleMessage", direction: "in", count: 12, refused: 0 },
    { kind: "ask", frame: "moduleReply", direction: "out", count: 12, refused: 0 },
    { kind: "session_call", frame: "rpc", direction: "in", count: 0, refused: 3 },
    { kind: "session_call", frame: "rpcError", direction: "out", count: 3, refused: 0 },
  ],
  dropped: { tooLarge: 1, unreadable: 0, unknown: 2 },
};

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
    expect(HOST_MANIFEST.asks.map((ask) => ask.name)).toEqual([
      "status",
      "connection.count",
      "audit.count",
      "audit.read",
    ]);
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
          { id: "databases", on: false, version: "0.37.0" },
        ],
        releases: [],
        // What the connection may carry, and what it carried today.
        connection: CONNECTION,
      },
    });
  });

  test("the counts of the connection are names and counts, held to the shape like every answer", async () => {
    rig = await hostRig();
    const spec = HOST_MANIFEST.asks.find((ask) => ask.name === "status");
    const ok = { version: "0.37.0", secrets: "file", sessions: true, modules: [], releases: [], connection: CONNECTION };
    expect(conform(spec!.reply, ok)).toEqual({ ok: true, value: ok });
    // A state this build does not know, a frame that is not a name, a count
    // that is not one: each is refused before it could leave.
    for (const connection of [
      { ...CONNECTION, sessionContent: "maybe" },
      { ...CONNECTION, messages: [{ ...CONNECTION.messages[0], frame: "a frame\nwith a line break" }] },
      { ...CONNECTION, messages: [{ ...CONNECTION.messages[0], direction: "sideways" }] },
      { ...CONNECTION, messages: [{ ...CONNECTION.messages[0], count: -1 }] },
      { ...CONNECTION, messages: [{ ...CONNECTION.messages[0], text: "free text" }] },
      { ...CONNECTION, dropped: { tooLarge: 0, unreadable: 0 } },
      { ...CONNECTION, since: "today" },
    ]) {
      expect(conform(spec!.reply, { ...ok, connection }).ok).toBe(false);
    }
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

  test("names the key store by its own name, whichever kind a build has", async () => {
    rig = await hostRig();
    // The answer's shape says "a name" and lists no kinds. A key store that a
    // later build adds is reported under its own name, and nothing in the
    // contract with the control plane changes for it.
    const status = HOST_MANIFEST.asks.find((ask) => ask.name === "status");
    expect(describeShape(status!.reply)).toContain("secrets: name,");
    rig.secretsSetting.kind = "aws-secrets-manager";
    expect(await rig.ask("status")).toMatchObject({ ok: true, payload: { secrets: "aws-secrets-manager" } });
    rig.secretsSetting.kind = "azure-key-vault";
    expect(await rig.ask("status")).toMatchObject({ ok: true, payload: { secrets: "azure-key-vault" } });
  });

  test("a key store kind that is not a name does not leave the host", async () => {
    rig = await hostRig();
    // The field is a name, so it is held to a name's alphabet and length like
    // every other name in an answer. Anything else is refused whole.
    rig.secretsSetting.kind = "a kind with=a;value";
    expect(await rig.ask("status")).toEqual({ ok: false, error: "reply_invalid" });
    rig.secretsSetting.kind = "k".repeat(129);
    expect(await rig.ask("status")).toEqual({ ok: false, error: "reply_invalid" });
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
      { at: "2027-03-14T11:00:00.000Z", actorKind: "control_plane", actor: "control plane", action: "control_plane.ask", target: "host:status", outcome: "ok" },
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
    expect(asks.at(-1)).toMatchObject({ action: "control_plane.ask", outcome: "refused" });
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
      payload: {
        asksAllowed: 2,
        asksRefused: 13,
        releasesInstalled: 0,
        releasesWaiting: 0,
        signIns: 2,
        // The same two counts, by ask: every one of these was `status`.
        asks: [{ module: "host", ask: "status", allowed: 2, refused: 13 }],
      },
    });
  });

  test("counts only the period", async () => {
    rig = await hostRig();
    await rig.ask("status");
    const reply = await rig.ask("audit.count", { from: "2027-03-15T00:00:00.000Z", to: "2027-03-16T00:00:00.000Z" });
    expect(reply).toMatchObject({ payload: { asksAllowed: 0, asksRefused: 0, signIns: 0, asks: [] } });
  });

  type Counted = {
    ok: true;
    payload: { asksAllowed: number; asksRefused: number; asks: { module: string; ask: string; allowed: number; refused: number }[] };
  };
  const refusedAsk = (module: string, ask: string, more: Record<string, unknown> = {}) => ({
    actor: "control plane",
    params: { module, ask, rule: "grant_missing", ...more },
    outcome: "refused",
  });

  test("says how often each ask was allowed and refused, in the order of the module and the ask", async () => {
    rig = await hostRig();
    await rig.ask("status");
    await rig.ask("status");
    await rig.ask("audit.read", { ...DAY, limit: 1 });
    // Refused with its name: this build knows the module and the ask.
    await rig.ask("status", { extra: 1 });
    // Refused before this build knew the ask: the module has no ask of that name.
    await rig.host.asks.handle({ module: "host", id: "n1", kind: "request", payload: { v: 1, ask: "nope.nothing", args: {} } });
    // Refused before it knew the module: this build ships no module of that name.
    await rig.host.asks.handle({ module: "ghost", id: "n2", kind: "request", payload: { v: 1, ask: "status", args: {} } });
    await rig.host.audit.flush();

    const reply = (await rig.ask("audit.count", DAY)) as Counted;
    expect(reply.payload.asks).toEqual([
      { module: "host", ask: "audit.read", allowed: 1, refused: 0 },
      { module: "host", ask: "status", allowed: 2, refused: 1 },
      { module: "host", ask: "unknown", allowed: 0, refused: 1 },
      { module: "unknown", ask: "unknown", allowed: 0, refused: 1 },
    ]);
    // The two counts of the period are the sums, and cannot differ from them.
    expect(reply.payload.asksAllowed).toBe(3);
    expect(reply.payload.asksRefused).toBe(3);
    // No name the control plane chose is in the answer.
    expect(JSON.stringify(reply)).not.toContain("nope");
    expect(JSON.stringify(reply)).not.toContain("ghost");
  });

  test("an ask whose reply the gate refused to send is counted as refused, under its own name", async () => {
    rig = await hostRig();
    await rig.ask("status");
    rig.secretsSetting.kind = "a kind\nwith a line break";
    expect(await rig.ask("status")).toEqual({ ok: false, error: "reply_invalid" });
    rig.secretsSetting.kind = null;
    const reply = (await rig.ask("audit.count", DAY)) as Counted;
    expect(reply.payload.asks).toEqual([{ module: "host", ask: "status", allowed: 1, refused: 1 }]);
  });

  test("a run of the same refusal is counted by what it stands for, and refusals past the minute's budget under `unknown`", async () => {
    rig = await hostRig();
    await seed(rig.paths, "modules", "2027-03-14T09:00:00.000Z", async (spool) => {
      await spool.event("control_plane.ask", refusedAsk("host", "status"));
      await spool.event("control_plane.ask", refusedAsk("host", "status", { attempts: 40 }));
      // What the audit writer leaves for refusals it counted and did not write.
      await spool.event("control_plane.ask", {
        actor: "control plane",
        params: { rule: "refusals_over_budget", attempts: 7 },
        outcome: "refused",
      });
    });
    const reply = (await rig.ask("audit.count", DAY)) as Counted;
    expect(reply.payload.asks).toEqual([
      { module: "host", ask: "status", allowed: 0, refused: 41 },
      { module: "unknown", ask: "unknown", allowed: 0, refused: 7 },
    ]);
    expect(reply.payload.asksRefused).toBe(48);
  });

  test("a value that is not a module's id or an ask's name is counted under `unknown`, never rewritten into a name", async () => {
    rig = await hostRig();
    await seed(rig.paths, "modules", "2027-03-14T09:00:00.000Z", async (spool) => {
      for (const [module, ask] of [
        ["Host", "status"],
        ["host", "status and more"],
        ["host", `a${".b".repeat(40)}`],
        ["host/../x", "status"],
        ["m".repeat(65), "status"],
      ] as const) {
        await spool.event("control_plane.ask", refusedAsk(module, ask));
      }
      await spool.event("control_plane.ask", {
        actor: "control plane",
        params: { module: ["host"], ask: { name: "status" }, rule: "grant_missing" },
        outcome: "refused",
      });
    });
    const reply = (await rig.ask("audit.count", DAY)) as Counted;
    expect(reply.payload.asks).toEqual([
      { module: "host", ask: "unknown", allowed: 0, refused: 2 },
      { module: "unknown", ask: "status", allowed: 0, refused: 3 },
      { module: "unknown", ask: "unknown", allowed: 0, refused: 1 },
    ]);
  });

  test("an ask whose intent is gone from both places is counted, under `unknown`", async () => {
    rig = await hostRig();
    // A pair that a file rotation split. Then the file with the intent is
    // removed, and the table, which is empty here, does not have it either.
    const first = new AuditSpool({ dir: rig.paths.auditSpool, writer: "modules", clock: () => new Date("2027-03-14T08:00:00.000Z") });
    const intent = await first.intent("control_plane.ask", { actor: "control plane", params: { module: "host", ask: "status" } });
    const kept = await first.intent("control_plane.ask", { actor: "control plane", params: { module: "host", ask: "audit.read" } });
    const second = new AuditSpool({ dir: rig.paths.auditSpool, writer: "modules", clock: () => new Date("2027-03-14T08:00:05.000Z") });
    await second.outcome(intent, "ok");
    await second.outcome(kept, "failed", "timeout");

    // While the first file is there, each outcome finds its intent in it.
    let reply = (await rig.ask("audit.count", DAY)) as Counted;
    expect(reply.payload.asks).toEqual([
      { module: "host", ask: "audit.read", allowed: 1, refused: 0 },
      { module: "host", ask: "status", allowed: 1, refused: 0 },
    ]);

    const files = (await readdir(rig.paths.auditSpool)).filter((name) => name.includes(intent.fileId));
    expect(files).toHaveLength(1);
    await rm(path.join(rig.paths.auditSpool, files[0] as string));
    reply = (await rig.ask("audit.count", DAY)) as Counted;
    // Still two asks that were allowed. Which asks they were went with the
    // file. The count above was an ask too, and its own record names it.
    expect(reply.payload.asks).toEqual([
      { module: "host", ask: "audit.count", allowed: 1, refused: 0 },
      { module: "unknown", ask: "unknown", allowed: 2, refused: 0 },
    ]);
    expect(reply.payload.asksAllowed).toBe(3);
  });

  test("more different asks than one answer lists are counted together, and no count is lost", async () => {
    rig = await hostRig();
    const different = AUDIT_COUNT_MAX_ASKS + 40;
    await seed(rig.paths, "modules", "2027-03-14T09:00:00.000Z", async (spool) => {
      for (let i = 0; i < different; i += 1) {
        await spool.event("control_plane.ask", refusedAsk("host", `ask_${String(i).padStart(4, "0")}`, { attempts: 2 }));
      }
    });
    const reply = (await rig.ask("audit.count", DAY)) as Counted;
    expect(reply.ok).toBe(true);
    const { asks } = reply.payload;
    expect(asks).toHaveLength(AUDIT_COUNT_MAX_ASKS);
    // The first ones in the order, each under its own name, and the rest in one entry.
    expect(asks[0]).toEqual({ module: "host", ask: "ask_0000", allowed: 0, refused: 2 });
    expect(asks[asks.length - 1]).toEqual({ module: "unknown", ask: "unknown", allowed: 0, refused: 2 * 41 });
    expect(reply.payload.asksRefused).toBe(2 * different);
    expect(asks.reduce((sum, entry) => sum + entry.refused, 0)).toBe(2 * different);
  });
});

describe("connection.count", () => {
  const day = (date: string, moduleMessages: number): DayView => ({
    day: `${date}T00:00:00.000Z`,
    messages: [
      { kind: "greeting", frame: "welcome", direction: "in", count: 1, refused: 0 },
      { kind: "ask", frame: "moduleMessage", direction: "in", count: moduleMessages, refused: 0 },
      { kind: "ask", frame: "moduleReply", direction: "out", count: moduleMessages, refused: 0 },
      { kind: "session_call", frame: "rpc", direction: "in", count: 0, refused: 2 },
    ],
    dropped: { tooLarge: 0, unreadable: 1, unknown: 0 },
  });

  test("answers what crossed on each UTC day of the period, the oldest day first", async () => {
    rig = await hostRig();
    rig.days.value = [day("2027-03-12", 4), day("2027-03-14", 9)];
    // A period that starts and ends in the middle of a day is answered in whole
    // days: the counts are kept by UTC day.
    const reply = await rig.ask("connection.count", { from: "2027-03-12T15:30:00.000Z", to: "2027-03-14T08:00:00.000Z" });
    expect(reply).toEqual({ ok: true, payload: { days: [day("2027-03-12", 4), day("2027-03-14", 9)] } });
    expect(rig.days.asked).toEqual([["2027-03-12", "2027-03-14"]]);
  });

  test("a period with nothing counted is an empty list, not a failure", async () => {
    rig = await hostRig();
    expect(await rig.ask("connection.count", DAY)).toEqual({ ok: true, payload: { days: [] } });
  });

  test(`answers at most ${CONNECTION_COUNT_MAX_DAYS} days, and refuses a longer period whole`, async () => {
    rig = await hostRig();
    const from = "2027-01-01T00:00:00.000Z";
    // The first of January and the 99 days after it: a hundred days.
    expect(await rig.ask("connection.count", { from, to: "2027-04-10T23:59:59.999Z" })).toMatchObject({ ok: true });
    expect(rig.days.asked).toEqual([["2027-01-01", "2027-04-10"]]);
    // One day more. Nothing is answered in part, and the counts are not read.
    expect(await rig.ask("connection.count", { from, to: "2027-04-11T00:00:00.000Z" })).toEqual({
      ok: false,
      error: "failed:range_too_long",
    });
    expect(rig.days.asked).toHaveLength(1);
  });

  test("refuses a period that ends before it starts", async () => {
    rig = await hostRig();
    expect(
      await rig.ask("connection.count", { from: "2027-03-14T12:00:00.000Z", to: "2027-03-14T11:59:59.999Z" }),
    ).toEqual({ ok: false, error: "failed:range_invalid" });
    expect(rig.days.asked).toEqual([]);
  });

  test("a day that is not written as a time is refused before the module hears of it", async () => {
    rig = await hostRig();
    for (const args of [{ from: "2027-03-14", to: "2027-03-15" }, { from: DAY.from }, { ...DAY, limit: 5 }, {}]) {
      expect(await rig.ask("connection.count", args)).toEqual({ ok: false, error: "args_invalid" });
    }
    expect(rig.days.asked).toEqual([]);
  });

  test("answers no part of a period while the counts of earlier runs are not known", async () => {
    rig = await hostRig();
    rig.days.value = null;
    expect(await rig.ask("connection.count", DAY)).toEqual({ ok: false, error: "failed:counts_unreadable" });
  });

  test("a hundred days on which every frame was carried and refused fit in one answer", async () => {
    rig = await hostRig();
    // The most one answer can hold. The shape check refuses an answer of more
    // than 20,000 values, so a build that adds frames has to lower the number
    // of days or fail here.
    const everyFrame = MESSAGE_KINDS.flatMap((kind) =>
      (["in", "out"] as const).flatMap((direction) =>
        kind[direction].map((frame) => ({ kind: kind.id, frame, direction, count: 1_000_000, refused: 1_000_000 })),
      ),
    );
    rig.days.value = Array.from({ length: CONNECTION_COUNT_MAX_DAYS }, (_, i) => ({
      day: new Date(Date.UTC(2027, 0, 1 + i)).toISOString(),
      messages: everyFrame,
      dropped: { tooLarge: 1, unreadable: 1, unknown: 1 },
    }));
    const reply = (await rig.ask("connection.count", { from: "2027-01-01T00:00:00.000Z", to: "2027-04-10T00:00:00.000Z" })) as {
      ok: boolean;
      payload: { days: DayView[] };
    };
    expect(reply.ok).toBe(true);
    expect(reply.payload.days).toHaveLength(CONNECTION_COUNT_MAX_DAYS);
    expect(reply.payload.days[99]?.messages).toHaveLength(everyFrame.length);
  });

  test("the answer is held to the shape: names, counts and times, and nothing else", () => {
    const spec = HOST_MANIFEST.asks.find((ask) => ask.name === "connection.count");
    const ok = { days: [day("2027-03-14", 1)] };
    expect(conform(spec!.reply, ok)).toEqual({ ok: true, value: ok });
    const first = ok.days[0] as DayView;
    for (const days of [
      [{ ...first, day: "2027-03-14" }],
      [{ ...first, note: "free text" }],
      [{ ...first, messages: [{ ...first.messages[0], frame: "a frame\nwith a line break" }] }],
      [{ ...first, messages: [{ ...first.messages[0], count: 1.5 }] }],
      [{ ...first, dropped: { tooLarge: 0, unreadable: 0 } }],
      Array.from({ length: CONNECTION_COUNT_MAX_DAYS + 1 }, () => first),
    ]) {
      expect(conform(spec!.reply, { days }).ok).toBe(false);
    }
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
      artifactUrl: "https://control.example/modules/x.bin",
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
    const args = name === "status" ? {} : name === "audit.read" ? { ...DAY, limit: 100 } : DAY;
    const reply = (await rig.ask(name, args)) as { ok: boolean; payload: unknown };
    expect(reply.ok).toBe(true);
    const spec = HOST_MANIFEST.asks.find((ask) => ask.name === name);
    expect(conform(spec!.reply, reply.payload)).toEqual({ ok: true, value: reply.payload });
  });
});

describe("the kinds of line", () => {
  test("every action lands in exactly one kind", () => {
    const cases: Record<string, string> = {
      "control_plane.ask": "ask",
      "control_plane.release.offer": "release",
      "system.release.install": "release",
      "cli.release.approve": "release",
      "control_plane.module.remove": "module",
      "cli.module.on": "module",
      "system.module.switch": "module",
      "module.stores.job.started": "module",
      "console.module.act": "module",
      "console.module.reach.add": "module",
      "console.module.secret.remove": "module",
      "console.signin": "sign_in",
      "console.signin.failed": "sign_in",
      "console.sso.exchange": "sign_in",
      "console.command.submit": "command",
      "console.service.restart": "command",
      "console.export.audit": "other",
      "cli.update": "other",
      "system.roster_purge": "other",
      // What the connection itself refused. Neither is an ask.
      "control_plane.session_call": "other",
      "control_plane.tool_call": "other",
    };
    for (const [action, kind] of Object.entries(cases)) expect([action, lineKind(action)]).toEqual([action, kind]);
    expect(new Set(Object.values(cases))).toEqual(new Set(LINE_KINDS));
  });

  test("a call the connection refused is a line of the control plane, named by a method this build knows", async () => {
    rig = await hostRig();
    // As the daemon records them: see `onRefusedCall` in src/host/main.ts.
    await rig.host.audit.refused(AUDIT_ACTIONS.controlPlaneSessionCall, {
      method: "readChunkText",
      rule: "session_content_off",
      // Not on the action's list of parameters, so it is not written.
      sessionId: "s1",
    });
    await rig.host.audit.refused(AUDIT_ACTIONS.controlPlaneToolCall, { rule: "session_content_off" });
    await rig.host.audit.flush();
    const reply = (await rig.ask("audit.read", { ...DAY, kind: "other", limit: 100 })) as {
      ok: boolean;
      payload: { lines: { actorKind: string; actor: string; action: string; target: string; outcome: string }[] };
    };
    expect(reply.ok).toBe(true);
    expect(
      reply.payload.lines
        .map(({ actorKind, actor, action, target, outcome }) => ({ actorKind, actor, action, target, outcome }))
        .sort((a, b) => a.action.localeCompare(b.action)),
    ).toEqual([
      {
        actorKind: "control_plane",
        actor: "control plane",
        action: "control_plane.session_call",
        target: "readChunkText",
        outcome: "refused",
      },
      {
        actorKind: "control_plane",
        actor: "control plane",
        action: "control_plane.tool_call",
        target: "tools",
        outcome: "refused",
      },
    ]);
    // And they are not counted as asks.
    expect(await rig.ask("audit.count", DAY)).toMatchObject({ payload: { asksRefused: 0 } });
    let written = "";
    for (const name of await readdir(rig.paths.auditSpool)) {
      written += await Bun.file(path.join(rig.paths.auditSpool, name)).text();
    }
    expect(written).toContain("readChunkText");
    expect(written).not.toContain("sessionId");
  });

  test("what a person had a module do is a line under that person's login, and names no host and no secret", async () => {
    rig = await hostRig();
    // As the daemon records them: the act gate and the context of an act.
    const act = await rig.host.audit.intent(AUDIT_ACTIONS.consoleModuleAct, {
      actor: "marta",
      sessionRef: "0123456789abcdef0123456789abcdef",
      params: { module: "databases", act: "connection.add" },
    });
    const reach = await rig.host.audit.intent(AUDIT_ACTIONS.consoleModuleReachAdd, {
      actor: "marta",
      params: { module: "databases", name: "c1-1", host: "sql01.northstar.example", port: 1433 },
    });
    await rig.host.audit.outcome(reach, "ok");
    const name = await rig.host.audit.intent(AUDIT_ACTIONS.consoleModuleSecretAdd, {
      actor: "marta",
      params: { module: "databases", name: "permits-reader" },
    });
    await rig.host.audit.outcome(name, "refused", "secret_name_reserved");
    await rig.host.audit.outcome(act, "failed", "secret_name_reserved");
    await rig.host.audit.refused(AUDIT_ACTIONS.consoleModuleAct, { module: "databases", act: "unknown", rule: "act_not_in_manifest" }, "ruth");
    // An act that was answered as timed out, and then ended.
    await rig.host.audit.event(AUDIT_ACTIONS.consoleModuleActEndedLate, {
      actor: "marta",
      sessionRef: "0123456789abcdef0123456789abcdef",
      params: { module: "databases", act: "connection.test" },
      outcome: "ok",
    });
    await rig.host.audit.refused(AUDIT_ACTIONS.localDoorRefused, { rule: "door_secret" }, null);
    await rig.host.audit.flush();
    const reply = (await rig.ask("audit.read", { ...DAY, limit: 100 })) as {
      ok: boolean;
      payload: { lines: { actorKind: string; actor: string; action: string; target: string; outcome: string }[] };
    };
    expect(reply.ok).toBe(true);
    const lines = reply.payload.lines
      .filter((line) => line.action.startsWith("console.module.") || line.action.startsWith("system.local_door."))
      .map(({ actorKind, actor, action, target, outcome }) => `${actorKind} ${actor} ${action} ${target} ${outcome}`)
      .sort();
    expect(lines).toEqual([
      "fortress fortress system.local_door.refused fortress refused",
      "person marta console.module.act databases:connection.add failed",
      "person marta console.module.act.ended_late databases:connection.test ok",
      "person marta console.module.reach.add databases ok",
      "person marta console.module.secret.add databases refused",
      "person ruth console.module.act databases:unknown refused",
    ]);
    // What a line never holds, though the record on this host does.
    const sent = JSON.stringify(reply.payload);
    for (const kept of ["sql01.northstar.example", "1433", "permits-reader", "c1-1", "0123456789abcdef"]) {
      expect(sent).not.toContain(kept);
    }
    expect(lineKind(AUDIT_ACTIONS.consoleModuleAct)).toBe("module");
    expect(lineKind(AUDIT_ACTIONS.consoleModuleActEndedLate)).toBe("module");
    expect(lineKind(AUDIT_ACTIONS.consoleModuleReachRemove)).toBe("module");
    expect(lineKind(AUDIT_ACTIONS.localDoorRefused)).toBe("other");
  });

  test("the names the writers use land in the kinds the reader files them under", () => {
    // The gate, the shelf and the module host take an action's name from
    // AUDIT_ACTIONS. The reader sorts a line by prefixes it holds itself. The
    // cases above are typed by hand, so they would still pass if one of the
    // two were renamed without the other.
    expect(lineKind(AUDIT_ACTIONS.controlPlaneAsk)).toBe("ask");
    expect(lineKind(AUDIT_ACTIONS.controlPlaneReleaseOffer)).toBe("release");
    expect(lineKind(AUDIT_ACTIONS.controlPlaneModuleRemove)).toBe("module");
    expect(lineKind(AUDIT_ACTIONS.releaseInstall)).toBe("release");
    expect(lineKind(AUDIT_ACTIONS.releaseApproved)).toBe("release");
    expect(lineKind(AUDIT_ACTIONS.releaseRefused)).toBe("release");
  });
});

// ── One organization at a time ───────────────────────────────────────────────
//
// Almost every fortress holds one organization, and every test above is such a
// fortress. Where a fortress holds more, each answer is about the organization
// the ask was for and tells it nothing of anybody else's.

describe("each answer is about the organization the ask was for", () => {
  const ALDER = "alder-dental";
  const BIRCH = "birch-books";

  const hold = (target: HostRig, organizations: unknown[]): Promise<void> =>
    writeOrganizations(target.paths, organizations);

  /** One ask to `host` for another organization than the fortress's own. */
  async function askFor(target: HostRig, org: string, name: string, args: Record<string, unknown> = {}) {
    return target.host.asks.handle({
      module: "host",
      id: `m-${org}-${name}`,
      kind: "request",
      payload: { v: 1, ask: name, args, grant: await target.key.grant("host", name, args, { org }) },
    });
  }

  type Lines = { ok: true; payload: { lines: Record<string, string>[]; next?: string } };
  const targets = (reply: unknown): string[] =>
    (reply as Lines).payload.lines.map((line) => `${line.actor} ${line.action} ${line.target} ${line.outcome}`);

  test("status says which modules are on for that organization, and shows it no release", async () => {
    rig = await hostRig();
    await hold(rig, [{ id: ALDER, modules: ["host"] }, { id: BIRCH }]);
    // A release that waits on the shelf. It is for the whole fortress.
    await mkdir(path.dirname(rig.paths.moduleReleases), { recursive: true });
    await writeFile(
      rig.paths.moduleReleases,
      JSON.stringify({
        schemaVersion: 1,
        releases: [
          {
            id: "rel-0123456789abcdef",
            moduleId: "host",
            version: "1.2.0",
            checksum: "0".repeat(64),
            signedBy: "hxf-prod-test-1",
            offeredAt: "2027-03-14T08:00:00.000Z",
            state: "waiting",
            signature: "{}",
            artifact: null,
            bytes: 1,
            reported: false,
          },
        ],
      }),
    );

    const own = (await rig.ask("status")) as { payload: { releases: { id: string }[]; modules: unknown[] } };
    expect(own.payload.releases.map((release) => release.id)).toEqual(["rel-0123456789abcdef"]);
    expect(own.payload.modules).toEqual([
      { id: "session_vault", on: true, version: "0.37.0" },
      { id: "host", on: true, version: "0.37.0" },
      { id: "databases", on: false, version: "0.37.0" },
    ]);

    // Alder's entry lists `host` and nothing else. Sessions keeps the own
    // organization's sessions, so it is not on for Alder, and Alder is not told
    // that the fortress has it on.
    expect(await askFor(rig, ALDER, "status")).toEqual({
      ok: true,
      payload: {
        version: "0.37.0",
        secrets: "file",
        sessions: false,
        modules: [
          { id: "session_vault", on: false, version: "0.37.0" },
          { id: "host", on: true, version: "0.37.0" },
          { id: "databases", on: false, version: "0.37.0" },
        ],
        releases: [],
        // The connection is the whole HX Fortress's, and its counts hold every
        // organization's asks. Alder is told what it may carry, and no count.
        connection: {
          sessionContent: "off",
          since: "2027-03-14T00:00:00.000Z",
          messages: [],
          dropped: { tooLarge: 0, unreadable: 0, unknown: 0 },
        },
      },
    });
    // Birch's entry does not list `host`: the module is off for it.
    expect(await askFor(rig, BIRCH, "status")).toEqual({ ok: false, error: "module_off" });

    // The count of releases that wait is the fortress's own too.
    expect(await rig.ask("audit.count", DAY)).toMatchObject({ payload: { releasesWaiting: 1 } });
    expect(await askFor(rig, ALDER, "audit.count", DAY)).toMatchObject({ payload: { releasesWaiting: 0 } });
  });

  test("what crossed the connection is told to the own organization only", async () => {
    rig = await hostRig();
    await hold(rig, [{ id: ALDER, modules: ["host"] }]);
    rig.days.value = [
      {
        day: "2027-03-14T00:00:00.000Z",
        messages: [{ kind: "ask", frame: "moduleMessage", direction: "in", count: 12, refused: 0 }],
        dropped: { tooLarge: 0, unreadable: 0, unknown: 0 },
      },
    ];
    expect(await rig.ask("connection.count", DAY)).toMatchObject({ payload: { days: [{ day: DAY.from }] } });
    rig.days.asked.length = 0;
    // The connection is the whole HX Fortress's, and its counts hold every
    // organization's asks. Alder is told no day, and the counts are not read
    // for it: not even while they could not be read.
    expect(await askFor(rig, ALDER, "connection.count", DAY)).toEqual({ ok: true, payload: { days: [] } });
    rig.days.value = null;
    expect(await askFor(rig, ALDER, "connection.count", DAY)).toEqual({ ok: true, payload: { days: [] } });
    expect(rig.days.asked).toEqual([]);
    // A period that no ask may have is refused for Alder as for anybody.
    expect(
      await askFor(rig, ALDER, "connection.count", { from: "2026-01-01T00:00:00.000Z", to: "2027-03-14T00:00:00.000Z" }),
    ).toEqual({ ok: false, error: "failed:range_too_long" });
  });

  test("the count by ask is of the organization's own asks", async () => {
    rig = await hostRig();
    await hold(rig, [{ id: ALDER, modules: ["host"] }]);
    await rig.ask("status");
    await askFor(rig, ALDER, "status");
    await askFor(rig, ALDER, "status");
    await askFor(rig, ALDER, "audit.read", { ...DAY, limit: 1 });
    // A refusal that was made before the grant verified is the own organization's.
    await rig.host.asks.handle({ module: "host", id: "g1", kind: "request", payload: { v: 1, ask: "status", args: {} } });
    await rig.host.audit.flush();
    expect(await askFor(rig, ALDER, "audit.count", DAY)).toMatchObject({
      payload: {
        asksAllowed: 3,
        asksRefused: 0,
        asks: [
          { module: "host", ask: "audit.read", allowed: 1, refused: 0 },
          { module: "host", ask: "status", allowed: 2, refused: 0 },
        ],
      },
    });
    expect(await rig.ask("audit.count", DAY)).toMatchObject({
      payload: { asksAllowed: 1, asksRefused: 1, asks: [{ module: "host", ask: "status", allowed: 1, refused: 1 }] },
    });
  });

  test("the audit trail is read one organization at a time, and a line names none", async () => {
    rig = await hostRig();
    await hold(rig, [{ id: ALDER, modules: ["host"] }, { id: BIRCH, modules: ["host"] }]);
    await seed(rig.paths, "ui", "2027-03-14T09:12:00.000Z", (spool) =>
      spool.event("console.signin", { actor: "marta", params: { login: "marta", role: "operator" }, outcome: "signed in" }),
    );
    rig.now.value = new Date("2027-03-14T10:00:00.000Z");
    await rig.ask("status");
    rig.now.value = new Date("2027-03-14T10:01:00.000Z");
    await askFor(rig, ALDER, "status");
    await askFor(rig, ALDER, "status", { verbose: true });
    rig.now.value = new Date("2027-03-14T10:02:00.000Z");
    await askFor(rig, BIRCH, "status");
    // A grant that names nobody this fortress holds: refused, and nobody's but its own.
    await askFor(rig, "dogwood-diner", "status");
    await rig.host.audit.flush();
    rig.now.value = new Date("2027-03-14T11:00:00.000Z");

    const own = await rig.ask("audit.read", { ...DAY, limit: 100 });
    const alder = await askFor(rig, ALDER, "audit.read", { ...DAY, limit: 100 });
    const birch = await askFor(rig, BIRCH, "audit.read", { ...DAY, limit: 100 });

    expect(targets(alder)).toEqual([
      "control plane control_plane.ask host:status refused",
      "control plane control_plane.ask host:status ok",
    ]);
    expect(targets(birch)).toEqual(["control plane control_plane.ask host:status ok"]);
    // The fortress's own: its ask, the sign-in, and the refusal made before
    // any organization was known. Nothing of Alder's or Birch's.
    expect(targets(own)).toEqual([
      "control plane control_plane.ask host:status refused",
      "control plane control_plane.ask host:status ok",
      "marta console.signin marta ok",
    ]);
    for (const reply of [own, alder, birch]) {
      expect(JSON.stringify(reply)).not.toContain("alder");
      expect(JSON.stringify(reply)).not.toContain("birch");
      expect(JSON.stringify(reply)).not.toContain("dogwood");
    }

    // The counts follow the same line.
    const read = { module: "host", ask: "audit.read", allowed: 1, refused: 0 };
    expect(await askFor(rig, ALDER, "audit.count", DAY)).toEqual({
      ok: true,
      // The two reads above are Alder's and Birch's own asks too.
      payload: {
        asksAllowed: 2,
        asksRefused: 1,
        releasesInstalled: 0,
        releasesWaiting: 0,
        signIns: 0,
        // Alder's `status` with an argument it does not take was refused.
        asks: [read, { module: "host", ask: "status", allowed: 1, refused: 1 }],
      },
    });
    expect(await askFor(rig, BIRCH, "audit.count", DAY)).toEqual({
      ok: true,
      payload: {
        asksAllowed: 2,
        asksRefused: 0,
        releasesInstalled: 0,
        releasesWaiting: 0,
        signIns: 0,
        asks: [read, { module: "host", ask: "status", allowed: 1, refused: 0 }],
      },
    });
    expect(await rig.ask("audit.count", DAY)).toEqual({
      ok: true,
      payload: {
        asksAllowed: 2,
        asksRefused: 1,
        releasesInstalled: 0,
        releasesWaiting: 0,
        signIns: 1,
        // The refusal is the ask for an organization this HX Fortress does not hold.
        asks: [read, { module: "host", ask: "status", allowed: 1, refused: 1 }],
      },
    });
  });

  test("a page's cursor does not walk into another organization's lines", async () => {
    rig = await hostRig();
    await hold(rig, [{ id: ALDER, modules: ["host"] }]);
    for (let i = 0; i < 3; i += 1) {
      rig.now.value = new Date(Date.UTC(2027, 2, 14, 10, i));
      await rig.ask("status");
      await askFor(rig, ALDER, "status");
    }
    rig.now.value = new Date("2027-03-14T11:00:00.000Z");
    const ownFirst = (await rig.ask("audit.read", { ...DAY, limit: 2 })) as Lines;
    expect(ownFirst.payload.next).toBeString();
    // Alder reads on from the fortress's own cursor: it gets Alder's older lines only.
    const alder = (await askFor(rig, ALDER, "audit.read", {
      ...DAY,
      limit: 100,
      before: ownFirst.payload.next,
    })) as Lines;
    const all = (await askFor(rig, ALDER, "audit.read", { ...DAY, limit: 100 })) as Lines;
    // Of everything Alder may see (its three status asks and its own read),
    // only what is older than the cursor comes back.
    expect(all.payload.lines).toHaveLength(4);
    expect(alder.payload.lines.length).toBeGreaterThan(0);
    for (const line of alder.payload.lines) {
      expect(all.payload.lines.map((known) => known.id)).toContain(line.id);
    }
  });

  test("an outcome says whose it is even when the file that held its intent is gone", async () => {
    rig = await hostRig();
    await hold(rig, [{ id: ALDER, modules: ["host"] }]);
    // A pair that a file rotation split: the intent in one file, the outcome
    // in the next. Then the first file is drained and removed, as a console
    // does an hour after its last write.
    const first = new AuditSpool({ dir: rig.paths.auditSpool, writer: "modules", clock: () => new Date("2027-03-14T08:00:00.000Z") });
    const intent = await first.intent("control_plane.ask", {
      actor: "control plane",
      params: { module: "host", ask: "status" },
      organization: ALDER,
    });
    const second = new AuditSpool({ dir: rig.paths.auditSpool, writer: "modules", clock: () => new Date("2027-03-14T08:00:05.000Z") });
    await second.outcome(intent, "ok");
    const files = (await readdir(rig.paths.auditSpool)).filter((name) => name.includes(intent.fileId));
    expect(files).toHaveLength(1);
    await rm(path.join(rig.paths.auditSpool, files[0] as string));

    rig.now.value = new Date("2027-03-14T11:00:00.000Z");
    const own = await rig.ask("audit.read", { ...DAY, limit: 100 });
    const alder = await askFor(rig, ALDER, "audit.read", { ...DAY, limit: 100 });
    // The line is Alder's and stays Alder's. What it was done to went with the
    // intent, and the line says so with the fixed word.
    expect(targets(alder)).toEqual(["control plane control_plane.ask unknown:unknown ok"]);
    expect(targets(own)).toEqual([]);
  });

  test("the console's own `org` on a record is not this mark: the record stays the fortress's own", async () => {
    rig = await hostRig();
    await hold(rig, [{ id: ALDER, modules: ["host"] }]);
    // A sign-in through the control plane records the organization of the
    // person who signed in, as `org`. That record is this fortress's own.
    await seed(rig.paths, "ui", "2027-03-14T09:00:00.000Z", (spool) =>
      spool.event("console.sso.exchange", { actor: "marta", params: { org: ALDER }, outcome: "ok" }),
    );
    rig.now.value = new Date("2027-03-14T11:00:00.000Z");
    expect(targets(await rig.ask("audit.read", { ...DAY, kind: "sign_in", limit: 10 }))).toEqual([
      "marta console.sso.exchange console ok",
    ]);
    expect(targets(await askFor(rig, ALDER, "audit.read", { ...DAY, kind: "sign_in", limit: 10 }))).toEqual([]);
  });

  test("a module's own record is read by the organization it was written for", async () => {
    rig = await hostRig();
    await hold(rig, [{ id: ALDER, modules: ["host"] }]);
    await seed(rig.paths, "modules", "2027-03-14T09:00:00.000Z", async (spool) => {
      await spool.event("module.stores.table.loaded", {
        params: { target: "orders", rows: 12 },
        organization: ALDER,
        outcome: "done",
      });
      await spool.event("module.stores.table.loaded", { params: { target: "invoices", rows: 4 }, outcome: "done" });
    });
    rig.now.value = new Date("2027-03-14T11:00:00.000Z");
    expect(targets(await askFor(rig, ALDER, "audit.read", { ...DAY, kind: "module", limit: 10 }))).toEqual([
      "fortress module.stores.table.loaded orders ok",
    ]);
    expect(targets(await rig.ask("audit.read", { ...DAY, kind: "module", limit: 10 }))).toEqual([
      "fortress module.stores.table.loaded invoices ok",
    ]);
  });
});
