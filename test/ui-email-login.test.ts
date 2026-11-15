// A login may be a lowercase email address, beside the name it has always
// been. What one may hold, and that it goes everywhere a name goes: the
// terminal verbs, the setup link, the second step, the sign-in, the tables
// keyed by login and the audit trail.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runUiVerb } from "../src/cli-ui-verbs";
import { AUDIT_ACTIONS, MAX_ACTOR_CHARS, MAX_PARAM_CHARS, sanitizeParams } from "../src/console/audit-actions";
import { AuditSpool, readSpool } from "../src/console/audit-spool";
import { fortressPaths } from "../src/host/paths";
import type { UiAssets } from "../src/ui/assets";
import { ConsoleAudit } from "../src/ui/audit-writer";
import { SETUP_TOKEN_HEADER } from "../src/ui/auth-routes";
import { UiConfigStore } from "../src/ui/config";
import { SIGN_IN_FAILURE_COPY } from "../src/ui/copy";
import { OidcConfigStore } from "../src/ui/oidc-config";
import { LockoutTable } from "../src/ui/rate-limit";
import { UiRuntime } from "../src/ui/runtime";
import { CEILING_WRONG_CODES, CodeCeiling } from "../src/ui/second-step";
import { startUiServer } from "../src/ui/server";
import type { UiServiceControl } from "../src/ui/service-control";
import { SESSION_HEADER } from "../src/ui/sessions";
import { base32Decode, hotp, OTPAUTH_MAX_BYTES, otpauthUri, stepAt } from "../src/ui/totp";
import { checkLogin, emailOf, liveUser, MAX_EMAIL_LOGIN_LENGTH, UsersStore } from "../src/ui/users";
import { SECOND_STEP_PATH } from "../src/ui/wire";
import { encodeQr } from "../ui/src/qr";

const PASSWORD = "correct-horse-battery";
const MARTA = "marta.lindqvist@northstar.example";
const TAGGED = "marta+ops@northstar.example";
/** The longest address the rule takes: 64 characters before the "@" and a
 *  189-character host, 254 in all. */
const LONGEST = `${"m".repeat(64)}@${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(61)}`;

let root: string;
let clock: number;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hx-email-login-"));
  await mkdir(fortressPaths(root).uiRoot, { recursive: true });
  clock = Date.now();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("what a login may be", () => {
  test("a name, as always, or a lowercase email address", () => {
    expect(LONGEST).toHaveLength(MAX_EMAIL_LOGIN_LENGTH);
    for (const login of [
      "marta",
      "ops-1",
      "a.b_c-d",
      MARTA,
      TAGGED,
      "m@n.example",
      "1x@north-star.example",
      "a_b-c.d+e@x.y.example",
      `${"a".repeat(64)}@northstar.example`,
      `a@${"b".repeat(63)}.example`,
      LONGEST,
    ]) {
      expect([login, checkLogin(login)]).toEqual([login, null]);
    }
  });

  test("anything else is refused, and the sentence names both shapes", () => {
    for (const login of [
      "Marta.Lindqvist@northstar.example",
      "marta@Northstar.example",
      "marta@north@star.example",
      ".marta@northstar.example",
      "+marta@northstar.example",
      "@northstar.example",
      "marta@.northstar.example",
      "marta @northstar.example",
      " marta@northstar.example",
      "marta@northstar.example ",
      "marta@northstar.example\n",
      "marta/ops@northstar.example",
      "marta@northstar.example/x",
      '"marta"@northstar.example',
      "mar'ta@northstar.example",
      "marta\\ops@northstar.example",
      "marta:ops@northstar.example",
      "marta..lindqvist@northstar.example",
      "marta@northstar..example",
      "marta@northstar.example.",
      "marta@localhost",
      "marta@-north.example",
      "marta@north-.example",
      "marta@north_star.example",
      `${"a".repeat(65)}@northstar.example`,
      `a@${"b".repeat(64)}.example`,
      `${LONGEST.slice(0, -1)}cc`,
      "a",
    ]) {
      const problem = checkLogin(login);
      expect([login, problem === null]).toEqual([login, false]);
    }
    expect(`${LONGEST.slice(0, -1)}cc`).toHaveLength(255);
    expect(checkLogin("Marta")).toContain(
      "either 2-64 characters of lowercase letters, digits, dot, dash or underscore, starting with a letter or digit, " +
        "or a lowercase email address",
    );
  });

  test("emailOf names the address, and nothing else", () => {
    expect(emailOf(MARTA)).toBe(MARTA);
    expect(emailOf(TAGGED)).toBe(TAGGED);
    expect(emailOf("marta")).toBeNull();
    expect(emailOf("Marta@northstar.example")).toBeNull();
    expect(emailOf("marta@localhost")).toBeNull();
  });
});

describe("where an address goes", () => {
  test("the QR code's label is percent-encoded", () => {
    const uri = otpauthUri(TAGGED, "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
    expect(uri.startsWith("otpauth://totp/HX%20Fortress:marta%2Bops%40northstar.example?secret=")).toBe(true);
    // Taken apart the way an app takes it apart, it is the login again.
    const label = decodeURIComponent(new URL(uri).pathname.replace(/^\/+/, "").split(":")[1] ?? "");
    expect(label).toBe(TAGGED);
  });

  test("the audit trail keeps the longest address whole, as actor and as parameter", async () => {
    expect(MAX_ACTOR_CHARS).toBeGreaterThanOrEqual(MAX_EMAIL_LOGIN_LENGTH);
    expect(MAX_PARAM_CHARS).toBeGreaterThanOrEqual(MAX_EMAIL_LOGIN_LENGTH);
    expect(sanitizeParams(AUDIT_ACTIONS.signIn, { login: LONGEST })).toEqual({ login: LONGEST });
    const dir = path.join(root, "spool");
    const written = await new AuditSpool({ dir, writer: "ui" }).append({
      action: AUDIT_ACTIONS.signIn,
      actor: LONGEST,
      sessionRef: null,
      tier: null,
      params: { login: LONGEST },
      kind: "outcome",
      refFileId: null,
      refSeq: null,
      outcome: null,
      error: null,
    });
    expect(written.actor).toBe(LONGEST);
    const [onDisk] = await readSpool(dir);
    expect(onDisk?.actor).toBe(LONGEST);
    expect(onDisk?.params).toEqual({ login: LONGEST });
  });

  test("the lockout and the code ceiling keep two addresses apart", () => {
    const lockout = new LockoutTable();
    let state = lockout.recordFailure(TAGGED, "203.0.113.5", 0, clock);
    for (let n = 0; n < 6; n += 1) state = lockout.recordFailure(TAGGED, "203.0.113.5", 0, clock);
    expect(state.locked).toBe(true);
    expect(lockout.state(TAGGED, "203.0.113.5", 0, clock).locked).toBe(true);
    for (const other of ["marta@northstar.example", "marta", MARTA]) {
      expect([other, lockout.state(other, "203.0.113.5", 0, clock).locked]).toEqual([other, false]);
    }

    const ceiling = new CodeCeiling();
    for (let n = 0; n < CEILING_WRONG_CODES; n += 1) ceiling.wrong(TAGGED, 0, clock);
    expect(ceiling.closedFor(TAGGED, 0, clock)).toBeGreaterThan(0);
    expect(ceiling.closedFor("marta@northstar.example", 0, clock)).toBe(0);
  });
});

// ── the same login text, two principals ──────────────────────────────────────

describe("a console account and a person from the identity provider under the same login", () => {
  test("disabling the console account ends its session, and the provider's session goes on", async () => {
    const uiRoot = fortressPaths(root).uiRoot;
    const runtime = new UiRuntime({
      uiRoot,
      uiConfigFile: fortressPaths(root).uiConfig,
      cmdCredsDir: path.join(uiRoot, "cmd-creds"),
      env: {},
      now: () => clock,
    });
    const oidc = await new OidcConfigStore(path.join(uiRoot, "oidc.json")).update((config) => ({
      ...config,
      enabled: true,
      issuer: "https://login.northstar.example",
      clientId: "hx-fortress-console",
      operatorGroups: ["northstar-operators"],
    }));
    const created = await runtime.users.create(MARTA, "operator");
    await runtime.users.completeSetup(created.token, PASSWORD);
    let file = await runtime.users.load();
    const account = liveUser(file, MARTA);
    if (!account) throw new Error("no account");
    const local = runtime.sessions.issue({ user: account, file, remoteAddr: "127.0.0.1", now: clock });
    const vouched = runtime.sessions.issueOidc({
      login: MARTA,
      role: "operator",
      subject: "sub-marta",
      epoch: oidc.epoch,
      sessionEpoch: file.sessionEpoch,
      remoteAddr: "127.0.0.1",
      now: clock,
    });
    const policy = UiRuntime.policyOf(await runtime.readConfig());
    // Both are valid, under the same text, and each knows which it is.
    const before = [local.token, vouched.token].map((token) => runtime.sessions.validate(token, file, policy, clock, oidc.epoch));
    expect(before.map((check) => check.ok && check.session.userLogin)).toEqual([MARTA, MARTA]);
    expect(before.map((check) => check.ok && check.session.oidc !== undefined)).toEqual([false, true]);

    // What `ui user disable` writes.
    await runtime.users.disable(MARTA);
    file = await runtime.users.load();
    expect(runtime.sessions.validate(local.token, file, policy, clock, oidc.epoch)).toEqual({
      ok: false,
      reason: "user-disabled",
    });
    const after = runtime.sessions.validate(vouched.token, file, policy, clock, oidc.epoch);
    expect(after.ok).toBe(true);
    expect(after.ok && after.session.userLogin).toBe(MARTA);
    expect(after.ok && after.session.oidc?.subject).toBe("sub-marta");
  });

  test("ui user disable and delete say which sessions they end, for a login that is an address", async () => {
    await ui(["enable"]);
    await ui(["user", "create", MARTA, "--role", "operator"]);
    await ui(["user", "create", "audit-bot", "--role", "readonly"]);
    const disabled = (await ui(["user", "disable", MARTA])).out;
    expect(disabled).toContain("This account's console sessions end on their next request");
    expect(disabled).toContain(`A person who signs in through the identity provider as ${MARTA} is not this account`);
    expect(disabled).toContain("hx-fortress ui oidc revoke");
    const deleted = (await ui(["user", "delete", MARTA])).out;
    expect(deleted).toContain(`as ${MARTA} is not this account`);
    // A short name can never be a provider's login, so nothing is said of one.
    expect((await ui(["user", "disable", "audit-bot"])).out).not.toContain("identity provider");
  });
});

// ── the terminal verbs ───────────────────────────────────────────────────────

const noUnit: UiServiceControl = {
  name: "fake",
  installed: async () => false,
  install: async () => {},
  start: async () => {},
  uninstall: async () => {},
  stopAndDisable: async () => {},
};

async function ui(args: readonly string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await runUiVerb(args, {
    writeLine: (line) => lines.push(line),
    env: {},
    fortressRoot: root,
    platform: "linux",
    hostName: "fortress-1",
    service: noUnit,
  });
  return { code, out: lines.join("\n") };
}

const tokenIn = (out: string): string => {
  const link = out.split("\n").find((line) => line.includes("/setup#t="));
  if (!link) throw new Error(`no link in: ${out}`);
  return link.trim().split("#t=")[1] as string;
};

const users = (): UsersStore => new UsersStore(path.join(fortressPaths(root).uiRoot, "users.json"));

describe("the terminal verbs", () => {
  beforeEach(async () => {
    await ui(["enable"]);
  });

  test("an address is created, listed, reset, disabled and deleted like a name", async () => {
    for (const login of [MARTA, TAGGED]) {
      const made = await ui(["user", "create", login, "--role", "operator"]);
      expect(made.code).toBe(0);
      expect(made.out).toContain(`Created ${login} (operator).`);
      await users().completeSetup(tokenIn(made.out), PASSWORD);
    }
    const listed = (await ui(["user", "list"])).out;
    expect(listed).toContain(MARTA);
    expect(listed).toContain(TAGGED);

    const reset = await ui(["user", "reset", TAGGED]);
    expect(reset.code).toBe(0);
    expect(reset.out).toContain(`Setup link for ${TAGGED}:`);
    expect(liveUser(await users().load(), TAGGED)?.setupTokens).toHaveLength(1);
    // The other address is untouched.
    expect(liveUser(await users().load(), MARTA)?.setupTokens).toHaveLength(0);

    expect((await ui(["user", "disable", MARTA])).code).toBe(0);
    expect(liveUser(await users().load(), MARTA)?.disabledAt).not.toBeNull();
    expect(liveUser(await users().load(), TAGGED)?.disabledAt).toBeNull();
    expect((await ui(["user", "delete", TAGGED])).code).toBe(0);
    expect(liveUser(await users().load(), TAGGED)).toBeNull();
  });

  test("an address that breaks the rule is refused, and nothing is made", async () => {
    await expect(ui(["user", "create", "Marta@northstar.example", "--role", "operator"])).rejects.toThrow(
      "or a lowercase email address",
    );
    expect((await users().load()).users).toEqual([]);
  });
});

// ── through the real server ──────────────────────────────────────────────────

const assets: UiAssets = {
  mode: "disk",
  files: { "/index.html": path.join(import.meta.dir, "..", "package.json") },
  inlineScriptHashes: [],
  manifest: { hash: "e".repeat(64), files: 1, bytes: 1 },
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
  const uiRoot = fortressPaths(root).uiRoot;
  const runtime = new UiRuntime({
    uiRoot,
    uiConfigFile: fortressPaths(root).uiConfig,
    cmdCredsDir: path.join(uiRoot, "cmd-creds"),
    env: {},
    now: () => clock,
  });
  const spool = path.join(root, "console-spool");
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

const codeOf = (secret: string): string => hotp(base32Decode(secret) as Buffer, stepAt(clock));

describe("signing in with an address", () => {
  test("its setup link sets up the second step, and it signs in with the password and a code", async () => {
    await ui(["enable"]);
    await new UiConfigStore(fortressPaths(root).uiConfig).update((c) => ({ ...c, secondStep: "required" }));
    const token = tokenIn((await ui(["user", "create", TAGGED, "--role", "operator"])).out);
    const at = await serve();

    const set = await post(at, "/ui/api/setup/complete", { password: PASSWORD }, { [SETUP_TOKEN_HEADER]: token });
    expect(set.body).toMatchObject({ completed: false, login: TAGGED, secondStep: "enroll" });
    expect(set.body.uri).toContain("HX%20Fortress:marta%2Bops%40northstar.example?");
    const secret = set.body.secret as string;
    const enrolled = await post(at, SECOND_STEP_PATH, { ticket: set.body.ticket, code: codeOf(secret) });
    expect(enrolled.status).toBe(200);
    expect(enrolled.body).toMatchObject({ login: TAGGED, role: "operator" });

    clock += 30_000;
    const password = await post(at, "/ui/api/session", { login: TAGGED, password: PASSWORD });
    expect(password.body).toMatchObject({ secondStep: "code" });
    const signedIn = await post(at, SECOND_STEP_PATH, { ticket: password.body.ticket, code: codeOf(secret) });
    expect(signedIn.status).toBe(200);
    const me = await fetch(`${at.origin}/ui/api/session`, { headers: { [SESSION_HEADER]: signedIn.body.token as string } });
    expect(await me.json()).toMatchObject({ login: TAGGED, role: "operator" });

    const records = await readSpool(at.spool);
    expect(records.some((r) => r.action === AUDIT_ACTIONS.secondStepSetUp && r.actor === TAGGED)).toBe(true);
    expect(records.filter((r) => r.action === AUDIT_ACTIONS.signIn).map((r) => [r.actor, r.params?.login])).toEqual([
      [TAGGED, TAGGED],
      [TAGGED, TAGGED],
    ]);
  });

  test("the longest address sets up its second step: its QR code's address fits, and the key is whole", async () => {
    await ui(["enable"]);
    await new UiConfigStore(fortressPaths(root).uiConfig).update((c) => ({ ...c, secondStep: "required" }));
    const token = tokenIn((await ui(["user", "create", LONGEST, "--role", "operator"])).out);
    const at = await serve();
    const set = await post(at, "/ui/api/setup/complete", { password: PASSWORD }, { [SETUP_TOKEN_HEADER]: token });
    expect(set.body).toMatchObject({ completed: false, login: LONGEST, secondStep: "enroll" });
    const uri = set.body.uri as string;
    expect(new TextEncoder().encode(uri).length).toBeLessThanOrEqual(OTPAUTH_MAX_BYTES);
    // The page draws it: the encoder that throws on a longer text does not here.
    expect(encodeQr(uri).version).toBe(10);
    expect(new URL(uri).searchParams.get("secret")).toBe(set.body.secret as string);
    expect(decodeURIComponent(new URL(uri).pathname).endsWith("…")).toBe(true);
    const done = await post(at, SECOND_STEP_PATH, { ticket: set.body.ticket, code: codeOf(set.body.secret as string) });
    expect(done.status).toBe(200);
    expect(done.body.login).toBe(LONGEST);
  });

  test("the longest address signs in, and the trail names it whole", async () => {
    await ui(["enable"]);
    const token = tokenIn((await ui(["user", "create", LONGEST, "--role", "readonly"])).out);
    await users().completeSetup(token, PASSWORD);
    const at = await serve();
    const signedIn = await post(at, "/ui/api/session", { login: LONGEST, password: PASSWORD });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.login).toBe(LONGEST);
    const record = (await readSpool(at.spool)).find((r) => r.action === AUDIT_ACTIONS.signIn);
    expect(record?.actor).toBe(LONGEST);
    expect(record?.params?.login).toBe(LONGEST);
  });

  test("the server matches the login exactly: an address in capitals is refused at the door, like any wrong login", async () => {
    await ui(["enable"]);
    const token = tokenIn((await ui(["user", "create", MARTA, "--role", "operator"])).out);
    await users().completeSetup(token, PASSWORD);
    const at = await serve();
    const refused = await post(at, "/ui/api/session", { login: "Marta.Lindqvist@Northstar.Example", password: PASSWORD });
    expect(refused.status).toBe(401);
    expect(refused.body.error).toBe(SIGN_IN_FAILURE_COPY);
    // The sign-in page sends what was typed trimmed and in lower case, which
    // is this login.
    const typed = "  Marta.Lindqvist@Northstar.Example ";
    const sent = await post(at, "/ui/api/session", { login: typed.trim().toLowerCase(), password: PASSWORD });
    expect(sent.status).toBe(200);
  });
});
