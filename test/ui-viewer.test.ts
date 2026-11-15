// The fourth kind of person: Viewers (`viewer` in code), who see rows in
// Secure Data Islands, change nothing, and open nothing in the console. Every
// way into the console is walked: the password, the code after it, the setup
// link, and a session that exists anyway. The identity provider's way is walked
// in oidc-sign-in.test.ts, beside the provider it needs.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AUDIT_ACTIONS } from "../src/console/audit-actions";
import { AuditSpool, readSpool } from "../src/console/audit-spool";
import type { UiAssets } from "../src/ui/assets";
import { ConsoleAudit } from "../src/ui/audit-writer";
import { SETUP_TOKEN_HEADER } from "../src/ui/auth-routes";
import { UiConfigStore } from "../src/ui/config";
import {
  NO_CONSOLE_COPY,
  SECOND_STEP_FAILURE_COPY,
  SECOND_STEP_LINK_NEEDED_COPY,
  SIGN_IN_FAILURE_COPY,
} from "../src/ui/copy";
import { OidcConfigStore } from "../src/ui/oidc-config";
import { gate, type RouteClass } from "../src/ui/routes";
import { UiRuntime } from "../src/ui/runtime";
import { startUiServer } from "../src/ui/server";
import { SESSION_HEADER } from "../src/ui/sessions";
import { base32Decode, hotp, stepAt } from "../src/ui/totp";
import { isUiRole, liveUser, opensConsole, parseUsersFile, seesRows, UI_ROLES, UsersStore } from "../src/ui/users";
import { SECOND_STEP_PATH } from "../src/ui/wire";

const PASSWORD = "correct-horse-battery";
const PORT = 8788;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let root: string;
/** The console's clock. A code belongs to a 30-second step, so a test moves it
 *  on rather than waiting for the next code. */
let clock: number;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hx-viewer-"));
  clock = Date.now();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function runtimeOn(): UiRuntime {
  return new UiRuntime({
    uiRoot: root,
    uiConfigFile: path.join(root, "ui.json"),
    cmdCredsDir: path.join(root, "cmd-creds"),
    env: {},
    now: () => clock,
  });
}

/** An account with a password and no second step. */
async function account(users: UsersStore, login: string, role: "operator" | "readonly" | "viewer"): Promise<void> {
  const created = await users.create(login, role);
  await users.completeSetup(created.token, PASSWORD);
}

const codeOf = (secret: string, offset = 0): string => hotp(base32Decode(secret) as Buffer, stepAt(clock) + offset);

describe("the kind of account", () => {
  test("a viewer is a role like the others, and the only one that does not open the console", () => {
    expect(UI_ROLES).toEqual(["operator", "readonly", "viewer"]);
    expect(isUiRole("viewer")).toBe(true);
    expect(UI_ROLES.filter((role) => opensConsole(role))).toEqual(["operator", "readonly"]);
    expect(opensConsole("viewer")).toBe(false);
  });

  test("who sees rows: Administrators and Operators (operator) and Viewers do, Auditors (readonly) do not", () => {
    expect(seesRows("operator")).toBe(true);
    expect(seesRows("viewer")).toBe(true);
    expect(seesRows("readonly")).toBe(false);
    expect(UI_ROLES.filter((role) => seesRows(role))).toEqual(["operator", "viewer"]);
  });

  test("a role this build does not know is refused at the one door, before either question can be asked", () => {
    for (const unknown of ["admin", "administrator", "auditor", "Viewer", "OPERATOR", "viewer ", "", "sees-rows"]) {
      expect([unknown, isUiRole(unknown)]).toEqual([unknown, false]);
    }
    // users.json with such a role is refused whole: none of its accounts is read.
    const account = { login: "vera", pwdHash: null, setupTokens: [], createdAt: "2026-11-15T00:00:00.000Z" };
    expect(parseUsersFile({ users: [{ ...account, role: "viewer" }] })?.users[0]?.role).toBe("viewer");
    expect(parseUsersFile({ users: [{ ...account, role: "auditor" }] })).toBeNull();
    expect(parseUsersFile({ users: [{ ...account, login: "ada", role: "operator" }, { ...account, role: "admin" }] })).toBeNull();
  });

  test("the gate closes every class but the public one to it", () => {
    const classes: RouteClass[] = ["public", "self", "read", "read-audited", "mutate"];
    for (const cls of classes) {
      const decision = gate({ method: "GET", path: "/ui/api/x", route: { method: "GET", path: "/ui/api/x", cls }, role: "viewer" });
      expect([cls, decision]).toEqual([
        cls,
        cls === "public" ? { allow: true, cls } : { allow: false, status: 403, reason: NO_CONSOLE_COPY },
      ]);
    }
  });
});

describe("a session that exists anyway", () => {
  /** Turn sign-in through a provider on, so a session issued through it is
   *  judged by its role and not dropped for its settings. */
  async function providerOn(): Promise<number> {
    const config = await new OidcConfigStore(path.join(root, "oidc.json")).update((current) => ({
      ...current,
      enabled: true,
      issuer: "https://login.northstar.example",
      clientId: "hx-fortress-console",
      viewerGroups: ["northstar-viewers"],
    }));
    return config.epoch;
  }

  test("the session table refuses one, made here or through the provider, and drops it", async () => {
    const runtime = runtimeOn();
    await account(runtime.users, "vera", "viewer");
    const file = await runtime.users.load();
    const user = liveUser(file, "vera");
    if (!user) throw new Error("no account");
    const policy = UiRuntime.policyOf(await runtime.readConfig());

    const local = runtime.sessions.issue({ user, file, remoteAddr: "127.0.0.1" });
    expect(runtime.sessions.validate(local.token, file, policy)).toEqual({ ok: false, reason: "no-console" });
    // Dropped, not only refused: the next request finds nothing.
    expect(runtime.sessions.validate(local.token, file, policy)).toEqual({ ok: false, reason: "unknown-session" });

    const epoch = await providerOn();
    const vouched = runtime.sessions.issueOidc({
      login: "vera@northstar.example",
      role: "viewer",
      subject: "sub-vera",
      epoch,
      sessionEpoch: file.sessionEpoch,
      remoteAddr: "127.0.0.1",
    });
    expect(runtime.sessions.validate(vouched.token, file, policy, Date.now(), epoch)).toEqual({
      ok: false,
      reason: "no-console",
    });
    const streamed = runtime.sessions.issueOidc({
      login: "vera@northstar.example",
      role: "viewer",
      subject: "sub-vera",
      epoch,
      sessionEpoch: file.sessionEpoch,
      remoteAddr: "127.0.0.1",
    });
    expect(runtime.sessions.revocationCheck(streamed.session.id, file, epoch)).toBe(false);
    expect(runtime.sessions.size).toBe(0);
  });

  test("an account changed to a viewer after its session was made loses the session", async () => {
    const runtime = runtimeOn();
    await account(runtime.users, "vera", "operator");
    const file = await runtime.users.load();
    const user = liveUser(file, "vera");
    if (!user) throw new Error("no account");
    const policy = UiRuntime.policyOf(await runtime.readConfig());
    const issued = runtime.sessions.issue({ user, file, remoteAddr: "127.0.0.1" });
    const changed = { ...file, users: file.users.map((u) => (u.login === "vera" ? { ...u, role: "viewer" as const } : u)) };
    expect(runtime.sessions.validate(issued.token, changed, policy)).toEqual({ ok: false, reason: "no-console" });
  });

  test("walking every route that needs a session, a viewer's session reaches none of them", async () => {
    const runtime = runtimeOn();
    await account(runtime.users, "vera", "viewer");
    const epoch = await providerOn();
    const routes = runtime.routes.all().filter((route) => route.cls !== "public");
    // The read routes, the self routes and the write routes are all here.
    for (const cls of ["self", "read", "read-audited", "mutate"] as const) {
      expect([cls, routes.some((route) => route.cls === cls)]).toEqual([cls, true]);
    }
    for (const route of routes) {
      for (const made of ["here", "through the provider"] as const) {
        const file = await runtime.users.load();
        const user = liveUser(file, "vera");
        if (!user) throw new Error("no account");
        const { token } =
          made === "here"
            ? runtime.sessions.issue({ user, file, remoteAddr: "127.0.0.1" })
            : runtime.sessions.issueOidc({
                login: "vera@northstar.example",
                role: "viewer",
                subject: "sub-vera",
                epoch,
                sessionEpoch: file.sessionEpoch,
                remoteAddr: "127.0.0.1",
              });
        const request = new Request(`${ORIGIN}${route.path}`, {
          method: route.method,
          headers: { [SESSION_HEADER]: token, origin: ORIGIN, host: `127.0.0.1:${PORT}` },
        });
        const verdict = await runtime.authorize(request, "127.0.0.1", PORT);
        expect([route.method, route.path, made, verdict.ok]).toEqual([route.method, route.path, made, false]);
        if (!verdict.ok) expect([route.path, [401, 403].includes(verdict.status)]).toEqual([route.path, true]);
      }
    }
  });
});

// ── through the real server ──────────────────────────────────────────────────

const assets: UiAssets = {
  mode: "disk",
  files: { "/index.html": path.join(import.meta.dir, "..", "package.json") },
  inlineScriptHashes: [],
  manifest: { hash: "d".repeat(64), files: 1, bytes: 1 },
};

interface Served {
  runtime: UiRuntime;
  audit: ConsoleAudit;
  origin: string;
  spool: string;
  stop: () => Promise<void>;
}

let served: Served | null = null;

async function serve(): Promise<Served> {
  const runtime = runtimeOn();
  const spool = path.join(root, "spool");
  const audit = new ConsoleAudit(new AuditSpool({ dir: spool, writer: "ui" }));
  const server = startUiServer({ assets, port: 0, runtime, audit }, "127.0.0.1");
  served = { runtime, audit, origin: `http://127.0.0.1:${server.port}`, spool, stop: () => server.stop(true) };
  return served;
}

afterEach(async () => {
  await served?.stop();
  served = null;
});

async function post(
  at: Served,
  route: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${at.origin}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: at.origin, ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function notes(at: Served): Promise<Array<{ action: string; actor: string | null; params: unknown }>> {
  await at.audit.flushFailures(true);
  return (await readSpool(at.spool)).map((r) => ({ action: r.action, actor: r.actor, params: r.params }));
}

describe("signing in with a password, the second step off", () => {
  test("the right password is refused with one sentence, no session, and a note", async () => {
    const at = await serve();
    await account(at.runtime.users, "vera", "viewer");
    const refused = await post(at, "/ui/api/session", { login: "vera", password: PASSWORD });
    expect(refused).toEqual({ status: 403, body: { error: NO_CONSOLE_COPY } });
    expect(at.runtime.sessions.size).toBe(0);
    const written = await notes(at);
    expect(written.filter((r) => r.action === AUDIT_ACTIONS.signInNoConsole)).toEqual([
      { action: AUDIT_ACTIONS.signInNoConsole, actor: "vera", params: expect.objectContaining({ login: "vera" }) },
    ]);
    expect(written.some((r) => r.action === AUDIT_ACTIONS.signIn)).toBe(false);
  });

  test("a wrong password reads as a wrong password: the kind of account is said only after the whole sign-in", async () => {
    const at = await serve();
    await account(at.runtime.users, "vera", "viewer");
    const wrong = await post(at, "/ui/api/session", { login: "vera", password: "a-wrong-password" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe(SIGN_IN_FAILURE_COPY);
    expect(JSON.stringify(wrong.body)).not.toContain(NO_CONSOLE_COPY);
  });

  test("the other two kinds still sign in", async () => {
    const at = await serve();
    await account(at.runtime.users, "ada", "operator");
    await account(at.runtime.users, "ravi", "readonly");
    expect((await post(at, "/ui/api/session", { login: "ada", password: PASSWORD })).body.role).toBe("operator");
    expect((await post(at, "/ui/api/session", { login: "ravi", password: PASSWORD })).body.role).toBe("readonly");
    expect(at.runtime.sessions.size).toBe(2);
  });
});

describe("signing in with the second step required", () => {
  beforeEach(async () => {
    await new UiConfigStore(path.join(root, "ui.json")).update((c) => ({ ...c, secondStep: "required" }));
  });

  test("a viewer's setup link is finished in one write, and the console is refused after the code", async () => {
    const at = await serve();
    const created = await at.runtime.users.create("vera", "viewer");
    const before = (JSON.parse(await readFile(path.join(root, "users.json"), "utf8")) as { version: number }).version;
    const set = await post(at, "/ui/api/setup/complete", { password: PASSWORD }, { [SETUP_TOKEN_HEADER]: created.token });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ completed: false, login: "vera", role: "viewer", secondStep: "enroll" });
    const finished = await post(at, SECOND_STEP_PATH, { ticket: set.body.ticket, code: codeOf(set.body.secret as string) });
    expect(finished).toEqual({ status: 403, body: { error: NO_CONSOLE_COPY, restart: true } });
    expect(at.runtime.sessions.size).toBe(0);

    // One write: the password, the second step and the spent link together.
    const file = JSON.parse(await readFile(path.join(root, "users.json"), "utf8")) as { version: number };
    expect(file.version).toBe(before + 1);
    const user = liveUser(await at.runtime.users.load(), "vera");
    expect(user?.pwdHash).not.toBeNull();
    expect(user?.secondStep?.confirmedAt).toBeTruthy();
    expect(user?.setupTokens).toEqual([]);

    const written = await notes(at);
    expect(written.some((r) => r.action === AUDIT_ACTIONS.setupCompleted && r.actor === "vera")).toBe(true);
    expect(written.some((r) => r.action === AUDIT_ACTIONS.secondStepSetUp && r.actor === "vera")).toBe(true);
    expect(written.some((r) => r.action === AUDIT_ACTIONS.signInNoConsole && r.actor === "vera")).toBe(true);
    expect(written.some((r) => r.action === AUDIT_ACTIONS.signIn)).toBe(false);
  });

  test("its password and code later are refused after the code, and a wrong code reads as a wrong code", async () => {
    const at = await serve();
    const created = await at.runtime.users.create("vera", "viewer");
    const set = await post(at, "/ui/api/setup/complete", { password: PASSWORD }, { [SETUP_TOKEN_HEADER]: created.token });
    const secret = set.body.secret as string;
    await post(at, SECOND_STEP_PATH, { ticket: set.body.ticket, code: codeOf(secret) });

    const password = await post(at, "/ui/api/session", { login: "vera", password: PASSWORD });
    expect(password.status).toBe(200);
    expect(password.body).toMatchObject({ secondStep: "code" });
    // A code no step near now accepts.
    const near = new Set([-1, 0, 1].map((offset) => codeOf(secret, offset)));
    const wrongCode = ["000000", "111111", "222222", "333333"].find((code) => !near.has(code)) as string;
    const wrong = await post(at, SECOND_STEP_PATH, { ticket: password.body.ticket, code: wrongCode });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe(SECOND_STEP_FAILURE_COPY);

    // The code used at setup is spent; the next step brings the next one.
    clock += 30_000;
    const later = await post(at, "/ui/api/session", { login: "vera", password: PASSWORD });
    const refused = await post(at, SECOND_STEP_PATH, { ticket: later.body.ticket, code: codeOf(secret) });
    expect(refused).toEqual({ status: 403, body: { error: NO_CONSOLE_COPY, restart: true } });
    expect(at.runtime.sessions.size).toBe(0);
  });

  test("a viewer with no second step yet is told what any account is told", async () => {
    const at = await serve();
    await account(at.runtime.users, "vera", "viewer");
    const refused = await post(at, "/ui/api/session", { login: "vera", password: PASSWORD });
    expect(refused).toEqual({ status: 403, body: { error: SECOND_STEP_LINK_NEEDED_COPY } });
  });
});
