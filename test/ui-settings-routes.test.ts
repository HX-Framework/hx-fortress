// The console's Settings routes, served by the console itself: who may read
// and who may change, the code before a save, one section at a time, the new
// install id that leaves no trace, and what is recorded.
//
// Every test owns a clock. A code belongs to a 30-second step, and the
// per-(login, network) bucket takes five codes a minute, so a test that needs
// more codes moves the clock on rather than waiting.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { FileCredentialStore, FilePendingEnrollmentStore } from "../src/cloud/credentials";
import { AUDIT_ACTIONS, MAX_PARAM_CHARS, sanitizeParams } from "../src/console/audit-actions";
import { AuditSpool } from "../src/console/audit-spool";
import { MODEL_SET_ON_HOST } from "../src/setup/checks";
import { SETTINGS_ORDER, type StepId } from "../src/setup/list";
import { readAnswers } from "../src/setup/read";
import { applyAnswers, SetupRefusal } from "../src/setup/apply";
import {
  newRefusalsOnly,
  NOT_SET_UP_HERE,
  sectionVersion,
  settingOrder,
  SetupRun,
  type SetupRunDeps,
} from "../src/setup/run";
import type { UiAssets } from "../src/ui/assets";
import { ConsoleAudit } from "../src/ui/audit-writer";
import { UiConfigStore } from "../src/ui/config";
import { READONLY_REFUSAL_COPY } from "../src/ui/copy";
import { OidcConfigStore } from "../src/ui/oidc-config";
import { MAX_GROUP_CHARS, MAX_GROUP_LIST_CHARS, MAX_GROUPS } from "../src/ui/oidc-limits";
import { CODE_PASS_MS, UiRuntime } from "../src/ui/runtime";
import { CEILING_CLOSED_MS, CEILING_WRONG_CODES } from "../src/ui/second-step";
import { startUiServer } from "../src/ui/server";
import { SESSION_HEADER, type UiSession } from "../src/ui/sessions";
import {
  CODE_NEEDED,
  CODE_REFUSED,
  codeClosed,
  ID_ONLY_AFTER_REFUSAL,
  INSTALL_ID_NOT_SAVED,
  NOT_SAVED,
  SETTINGS_PATHS,
  SETTINGS_ROUTES,
  SIGN_IN_NEEDED,
  STALE,
  tooManyAttempts,
} from "../src/ui/settings-routes";
import { BUCKETS, LOCKOUT_BASE_MS, LOCKOUT_FREE_ATTEMPTS } from "../src/ui/rate-limit";
import type { ConnectionShown, SettingsSaved, SettingsState } from "../src/ui/settings-wire";
import { base32Decode, hotp, stepAt } from "../src/ui/totp";
import type { UiRole } from "../src/ui/users";
import { fixedSecrets, spoolRecords, tempRoot, type Paths } from "./host/_module-rig";
import { CONNECT, CONTROL, DB_URL, INSTALL_ID, northstar, providerDocument, rawConfig, runDeps } from "./setup-rig";

const PASSWORD = "correct-horse-battery";
const LOGIN = "marta.lindqvist";
const OTHER_NET = "198.51.100.7";
// The value of a model's key in the key store, put together at run time so
// that nothing key-shaped sits in the repository.
const MODEL_KEY_VALUE = ["model", "key", "of", "a", "test", "Zq8"].join("-");
// A new one-time install id, put together at run time so that nothing
// key-shaped sits in the repository.
const NEW_ID = ["second", "install", "id", "7Qz4"].join("-");

const CONNECTED: ConnectionShown = { state: "connected", reason: null, refused: false, idWaiting: false };
const ENDED: ConnectionShown = { state: "offline", reason: "revoked", refused: true, idWaiting: false };

let clock: number;
const cleanups: (() => Promise<void> | void)[] = [];

beforeEach(() => {
  // Near the real time: the setup's links are minted against the real clock.
  clock = Date.now();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const assets: UiAssets = {
  mode: "disk",
  files: { "/index.html": path.join(import.meta.dir, "..", "package.json") },
  inlineScriptHashes: [],
  manifest: { hash: "c".repeat(64), files: 1, bytes: 1 },
};

// ── A set-up HX Fortress, its console, and people signed in to it ─────────────

/** An HX Fortress set up on its machine, as `hx-fortress setup` leaves it: the
 *  second step is required, and the first administrator has a one-time link.
 *  With `model`, it asks Anthropic, or OpenAI when it says so, with a key the
 *  setup's key store held. With `ownModelAddress`, it asks a model the way
 *  OpenAI is asked, at that address of the organization's own. With
 *  `database`, it reaches an existing Postgres by the address in the key named
 *  `db-url`. With `vault`, its keys are in an Azure Key Vault: a key store
 *  that is not on this host. */
async function hxFortress(
  options: {
    connect?: boolean;
    model?: boolean | "openai";
    ownModelAddress?: string;
    database?: boolean;
    vault?: boolean;
  } = {},
): Promise<{ paths: Paths; link: string }> {
  const made = await tempRoot();
  cleanups.push(made.cleanup);
  const deps = runDeps(made.paths, options.connect ? { connect: CONNECT } : {});
  const withModel = options.model !== undefined && options.model !== false;
  const run = await SetupRun.open(
    withModel || options.ownModelAddress !== undefined ? { ...deps, check: { ...deps.check, ...withModelKey() } } : deps,
  );
  northstar(run);
  if (options.vault) {
    run.set("keys.store", "azure-key-vault");
    run.set("keys.address", "https://northstar-hx.vault.azure.net");
  }
  if (options.database) {
    run.set("data.database.store", "existing");
    run.set("data.database.address", "db-url");
  }
  if (withModel || options.ownModelAddress !== undefined) {
    run.set("model.provider", options.ownModelAddress || options.model === "openai" ? "openai" : "anthropic");
    run.set("model.key", "model-key");
    if (options.ownModelAddress) run.set("model.address", options.ownModelAddress);
  }
  const result = await run.finish("terminal");
  if (!result.ok) throw new Error(JSON.stringify(result.checks));
  const link = result.applied.firstAccount?.token;
  if (!link) throw new Error("the setup made no first account");
  return { paths: made.paths, link };
}

interface Console {
  paths: Paths;
  runtime: UiRuntime;
  origin: string;
  warnings: string[];
  signals: () => number;
}

type CheckFakes = Partial<NonNullable<SetupRunDeps["check"]>>;

/** A key store that holds the model's key as well. */
function withModelKey(): CheckFakes {
  return { keyStore: () => fixedSecrets({ "db-url": DB_URL, "install-id": INSTALL_ID, "model-key": MODEL_KEY_VALUE }) };
}

async function serve(
  paths: Paths,
  /** What the daemon's status says, or how to read it now. Null: the
   *  console reads the daemon's own status file, as it does in use. */
  connection: ConnectionShown | (() => ConnectionShown) | null = CONNECTED,
  check: CheckFakes = {},
  more: Partial<SetupRunDeps> = {},
): Promise<Console> {
  const warnings: string[] = [];
  const runtime = new UiRuntime({
    uiRoot: paths.uiRoot,
    uiConfigFile: paths.uiConfig,
    cmdCredsDir: paths.cmdCreds,
    env: {},
    now: () => clock,
    onWarn: (message) => warnings.push(message),
  });
  const audit = new ConsoleAudit(new AuditSpool({ dir: paths.auditSpool, writer: "ui", clock: () => new Date(clock) }), {
    now: () => new Date(clock),
  });
  let signals = 0;
  const fakes = runDeps(paths);
  const server = startUiServer(
    {
      assets,
      port: 0,
      runtime,
      audit,
      settings: {
        paths,
        env: {},
        signalDaemon: async () => {
          signals += 1;
        },
        run: { read: fakes.read, apply: fakes.apply, check: { ...fakes.check, ...check }, ...more },
        ...(connection === null
          ? {}
          : { connection: async () => (typeof connection === "function" ? connection() : connection) }),
      },
    },
    "127.0.0.1",
  );
  cleanups.push(() => server.stop(true));
  return { paths, runtime, origin: `http://127.0.0.1:${server.port}`, warnings, signals: () => signals };
}

/** The code an app holding `secret` shows now. */
function codeOf(secret: string, offset = 0): string {
  return hotp(base32Decode(secret) as Buffer, stepAt(clock) + offset);
}

/** A code that is wrong for every step the window accepts. */
function wrongCodeOf(secret: string): string {
  const near = new Set([-1, 0, 1].map((offset) => codeOf(secret, offset)));
  for (let n = 0; ; n += 1) {
    const candidate = String(n).padStart(6, "0");
    if (!near.has(candidate)) return candidate;
  }
}

interface Person {
  token: string;
  session: UiSession;
  secret: string;
}

/** Set a password and an app from a one-time link, the only way to set up a
 *  second step. The code that finishes it opens the session. */
async function signInFromLink(runtime: UiRuntime, link: string, network = "127.0.0.1"): Promise<Person> {
  const prepared = await runtime.prepareSetup(link, PASSWORD, network);
  if (prepared.challenge.kind !== "setup") throw new Error("expected a setup");
  const done = await runtime.completeSecondStep({
    ticket: prepared.challenge.ticket,
    code: codeOf(prepared.challenge.secret),
    remoteKey: network,
    remoteAddr: network,
  });
  if (!done.ok) throw new Error(JSON.stringify(done));
  return { token: done.token, session: done.session, secret: prepared.challenge.secret };
}

/** Another account of this console, signed in. */
async function account(c: Console, login: string, role: UiRole): Promise<Person> {
  const created = await c.runtime.users.create(login, role, new Date(clock));
  return signInFromLink(c.runtime, created.token);
}

/** Sign in again with the password and the app's code at this moment. */
async function signInAgain(runtime: UiRuntime, secret: string, network: string): Promise<Person> {
  const first = await runtime.signIn({ login: LOGIN, password: PASSWORD, remoteKey: network, remoteAddr: network });
  if (first.ok || first.status !== 200) throw new Error(JSON.stringify(first));
  const done = await runtime.completeSecondStep({
    ticket: first.challenge.ticket,
    code: codeOf(secret),
    remoteKey: network,
    remoteAddr: network,
  });
  if (!done.ok) throw new Error(JSON.stringify(done));
  return { token: done.token, session: done.session, secret };
}

async function read(c: Console, token: string | null): Promise<{ status: number; body: SettingsState }> {
  const response = await fetch(`${c.origin}${SETTINGS_PATHS.read}`, {
    headers: token ? { [SESSION_HEADER]: token } : {},
  });
  return { status: response.status, body: (await response.json()) as SettingsState };
}

/** A request as the page sends it. A save carries the version of its section
 *  that the page read, as the page does, unless the test gives one: then that
 *  one goes, missing included. */
async function post(
  c: Console,
  token: string,
  route: string,
  body: unknown,
): Promise<{ status: number; text: string; body: SettingsSaved & { error?: string } }> {
  let sent = body;
  if (route === SETTINGS_PATHS.save && typeof body === "object" && body !== null && !("version" in body)) {
    const section = (body as { section?: unknown }).section;
    const versions = (await read(c, token)).body.versions ?? {};
    sent = { ...body, version: typeof section === "string" ? versions[section as StepId] : undefined };
  }
  const response = await fetch(`${c.origin}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: c.origin, [SESSION_HEADER]: token },
    body: JSON.stringify(sent),
  });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as SettingsSaved & { error?: string } };
}

/** A save of one module's switch, the plainest change Settings has. */
function toggle(c: Console, token: string, on: boolean, code?: string): ReturnType<typeof post> {
  return post(c, token, SETTINGS_PATHS.save, {
    section: "modules",
    answers: { modules: { databases: on } },
    ...(code ? { code } : {}),
  });
}

async function answersNow(paths: Paths): Promise<SettingsState["answers"]> {
  return (await readAnswers(paths, {}, { vaultCredentials: async () => null })).answers;
}

async function databasesNow(paths: Paths): Promise<boolean> {
  return (await answersNow(paths)).modules.databases === true;
}

/** Past the few minutes a given code counts for. */
function passEnds(): void {
  clock += CODE_PASS_MS;
}

// ── Reading, and who may change ──────────────────────────────────────────────

describe("who reads Settings and who changes them", () => {
  test("an operator and a read-only account read the same state; only the operator changes anything", async () => {
    const { paths, link } = await hxFortress();
    const c = await serve(paths);
    const marta = await signInFromLink(c.runtime, link);
    const ingrid = await account(c, "ingrid.berg", "readonly");

    const asOperator = await read(c, marta.token);
    expect(asOperator.status).toBe(200);
    expect(Object.keys(asOperator.body).sort()).toEqual(
      ["answers", "asksCode", "asksSignIn", "connection", "derived", "frame", "sections", "versions"].sort(),
    );
    expect(asOperator.body.sections).toEqual([...SETTINGS_ORDER]);
    expect(asOperator.body.connection).toEqual(CONNECTED);
    expect(asOperator.body.answers.organization.name).toBe("Northstar");
    expect(Object.keys(asOperator.body.derived.facts).sort()).toEqual(
      ["controlPlane", "files", "install", "signIn", "thisInstall"].sort(),
    );

    // The whole state, and not only the answers: both gave a code just now.
    const asAuditor = await read(c, ingrid.token);
    expect(asAuditor.status).toBe(200);
    expect(asAuditor.body).toEqual(asOperator.body);

    // Every write is an operator's: a read-only session gets the console's own refusal.
    for (const [route, body] of [
      [SETTINGS_PATHS.check, { section: "modules", answers: { modules: { databases: false } } }],
      [SETTINGS_PATHS.save, { section: "modules", answers: { modules: { databases: false } } }],
      [SETTINGS_PATHS.installId, { id: NEW_ID }],
    ] as const) {
      const refused = await post(c, ingrid.token, route, body);
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe(READONLY_REFUSAL_COPY);
    }
    expect(await databasesNow(paths)).toBe(true);

    // Nobody signed in reads nothing.
    expect((await read(c, null)).status).toBe(401);
  });

  test("checks while typing have a budget of their own: many of them leave every write its own budget", async () => {
    const spec = (route: string) => SETTINGS_ROUTES.find((r) => r.method === "POST" && r.path === route);
    expect(spec(SETTINGS_PATHS.check)?.bucket).toBe("settingsCheck");
    expect(spec(SETTINGS_PATHS.save)?.bucket).toBe("control");
    expect(spec(SETTINGS_PATHS.installId)?.bucket).toBe("control");
    expect(BUCKETS.settingsCheck.limit).toBeGreaterThanOrEqual(10 * BUCKETS.control.limit);

    const { paths, link } = await hxFortress();
    const c = await serve(paths);
    const marta = await signInFromLink(c.runtime, link);
    // More checks in a minute than every write of the console may take.
    for (let i = 0; i <= BUCKETS.control.limit; i += 1) {
      const checked = await post(c, marta.token, SETTINGS_PATHS.check, {
        section: "modules",
        answers: { modules: { databases: i % 2 === 0 } },
      });
      expect(checked.status).toBe(200);
    }
    expect((await toggle(c, marta.token, false)).body.saved).toBe(true);
  });

  test("a check answers the section's own lines and writes nothing", async () => {
    const { paths, link } = await hxFortress();
    const c = await serve(paths);
    const marta = await signInFromLink(c.runtime, link);
    const checked = await post(c, marta.token, SETTINGS_PATHS.check, {
      section: "signIn",
      answers: { signIn: { provider: "openid-connect" } },
      quick: true,
    });
    expect(checked.status).toBe(200);
    const body = checked.body as unknown as { check: { step: string; ok: boolean }; derived: unknown };
    expect(body.check.step).toBe("signIn");
    expect(body.check.ok).toBe(false);
    expect((await answersNow(paths)).signIn.provider).toBe("local");
    // A section Settings does not have is not checked.
    const none = await post(c, marta.token, SETTINGS_PATHS.check, { section: "organization", answers: {} });
    expect(none.status).toBe(400);
  });
});

// ── A check stays on the host ────────────────────────────────────────────────

describe("no key leaves the host from Settings", () => {
  test("a check and a save of the model call nobody and read no key: the key store is asked whether it holds one", async () => {
    const { paths, link } = await hxFortress();
    const called: string[] = [];
    const keys = fixedSecrets({ "db-url": DB_URL, "install-id": INSTALL_ID, "model-key": MODEL_KEY_VALUE });
    const c = await serve(paths, CONNECTED, {
      keyStore: () => keys,
      fetch: (async (input: string | URL | Request) => {
        called.push(new URL(input instanceof Request ? input.url : input).host);
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
    });
    const marta = await signInFromLink(c.runtime, link);
    const answers = { model: { provider: "openai", key: "model-key" } };

    // Asked for the real check by name, a check is still the one made while
    // typing.
    const checked = await post(c, marta.token, SETTINGS_PATHS.check, { section: "model", answers, quick: false });
    expect(checked.status).toBe(200);
    expect((checked.body as unknown as { check: { step: string } }).check.step).toBe("model");

    // A save checks the section in full, and the model's check sends no key
    // out in this way.
    const saved = await post(c, marta.token, SETTINGS_PATHS.save, { section: "model", answers });
    expect(saved.body.saved).toBe(true);
    expect((await answersNow(paths)).model).toMatchObject({ provider: "openai", key: "model-key" });
    expect(called).toEqual([]);
    expect(keys.reads).toEqual([]);

    // A name the key store does not hold is refused by that name, all the same.
    const missing = await post(c, marta.token, SETTINGS_PATHS.save, {
      section: "model",
      answers: { model: { key: "no-such-key" } },
    });
    expect(missing.body.saved).toBe(false);
    expect(JSON.stringify(missing.body)).toContain(JSON.stringify({ ok: false, text: "No key with this name", path: "model.key" }));
    expect(called).toEqual([]);
    expect(keys.reads).toEqual([]);
  });

  test("the model's key may not be a key another answer names: the database's address is refused as the model's key", async () => {
    const { paths, link } = await hxFortress({ database: true });
    const before = await rawConfig(paths);
    const c = await serve(paths, CONNECTED, withModelKey());
    const marta = await signInFromLink(c.runtime, link);
    const refusal = { ok: false, text: "This key is the database's address. Give the model a key of its own", path: "model.key" };
    const answers = { model: { provider: "openai", key: "db-url" } };

    const checked = await post(c, marta.token, SETTINGS_PATHS.check, { section: "model", answers });
    expect(JSON.stringify(checked.body)).toContain(JSON.stringify(refusal));
    const refused = await post(c, marta.token, SETTINGS_PATHS.save, { section: "model", answers });
    expect(refused.body.saved).toBe(false);
    expect(JSON.stringify(refused.body)).toContain(JSON.stringify(refusal));
    expect(await rawConfig(paths)).toEqual(before);
  });
});

// ── One section at a time ────────────────────────────────────────────────────

describe("a save takes one section", () => {
  test("only the named section's answers are read from the request; another section's are ignored", async () => {
    const { paths, link } = await hxFortress();
    const c = await serve(paths);
    const marta = await signInFromLink(c.runtime, link);
    const before = await answersNow(paths);
    expect(before.modules.databases).toBe(true);

    const saved = await post(c, marta.token, SETTINGS_PATHS.save, {
      section: "modules",
      answers: {
        modules: { databases: false },
        // Other sections' answers, and answers Settings never asks.
        signIn: { provider: "openid-connect", issuer: "https://id.elsewhere.example" },
        auditTrail: { copyTo: "webhook", copyAddress: "https://hook.elsewhere.example" },
        organization: { name: "Elsewhere" },
        controlPlane: { connect: "yes", address: "control.example", pages: "https://pages.example" },
        where: { place: "azure" },
      },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.saved).toBe(true);
    if (!saved.body.saved) return;
    expect(saved.body.changed).toEqual(["modules"]);

    const after = await answersNow(paths);
    expect(after.modules.databases).toBe(false);
    for (const kept of ["signIn", "auditTrail", "organization", "controlPlane", "where"] as const) {
      expect(after[kept]).toEqual(before[kept]);
    }
    // The page is handed the state as it is now.
    expect(saved.body.state.answers.modules.databases).toBe(false);
    expect(c.signals()).toBe(1);
  });

  test("each section has the version of its saved answers, and a save of one section changes that one only", async () => {
    const { paths, link } = await hxFortress();
    const c = await serve(paths);
    const marta = await signInFromLink(c.runtime, link);
    const before = (await read(c, marta.token)).body.versions;
    expect(Object.keys(before).sort()).toEqual([...SETTINGS_ORDER].sort());
    const present = await readAnswers(paths, {}, { vaultCredentials: async () => null });
    for (const section of SETTINGS_ORDER) {
      expect(before[section]).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(before[section]).toBe(sectionVersion(present.answers, section));
    }
    const saved = await toggle(c, marta.token, false);
    if (!saved.body.saved) throw new Error("expected a save");
    const after = saved.body.state.versions;
    expect(after.modules).not.toBe(before.modules);
    for (const section of SETTINGS_ORDER.filter((s) => s !== "modules")) expect(after[section]).toBe(before[section]);
  });

  test("a page that is behind does not undo another person's save in the same section", async () => {
    const { paths, link } = await hxFortress();
    const c = await serve(paths);
    const marta = await signInFromLink(c.runtime, link);
    const nils = await account(c, "nils.ek", "operator");
    // Both pages read the modules as they are.
    const read1 = (await read(c, nils.token)).body.versions.modules;

    // Marta switches Databases off.
    expect((await toggle(c, marta.token, false)).body.saved).toBe(true);

    // Nils's page, behind, sends what he read with his change: nothing is written.
    const stale = await post(c, nils.token, SETTINGS_PATHS.save, {
      section: "modules",
      answers: { modules: { databases: true, host: false } },
      version: read1,
    });
    expect(stale.status).toBe(200);
    expect(stale.body).toEqual({ saved: false, stale: STALE });
    expect((await answersNow(paths)).modules).toMatchObject({ databases: false, host: true });
    expect((await spoolRecords(paths)).filter((r) => r.sessionRef === nils.session.id && r.action.startsWith("console.settings."))).toEqual([]);

    // A save with no version at all is one that read nothing.
    const none = await post(c, nils.token, SETTINGS_PATHS.save, {
      section: "modules",
      answers: { modules: { host: false } },
      version: undefined,
    });
    expect(none.body).toEqual({ saved: false, stale: STALE });

    // Read again, his page saves his change, and Marta's stays.
    const again = await post(c, nils.token, SETTINGS_PATHS.save, { section: "modules", answers: { modules: { host: false } } });
    expect(again.body.saved).toBe(true);
    expect((await answersNow(paths)).modules).toMatchObject({ databases: false, host: false });
  });

  test("the origin of the control plane's pages and its address are not changed from the console", async () => {
    const { paths, link } = await hxFortress({ connect: true });
    const c = await serve(paths);
    const marta = await signInFromLink(c.runtime, link);
    const before = (await answersNow(paths)).controlPlane;
    expect(before.connect).toBe("yes");

    const saved = await post(c, marta.token, SETTINGS_PATHS.save, {
      section: "controlPlane",
      answers: {
        controlPlane: { connected: "off", pages: "https://pages.example", address: "elsewhere.example", connect: "no" },
      },
    });
    expect(saved.body.saved).toBe(true);
    if (!saved.body.saved) return;
    // Switched off, and nothing else of it moved.
    const after = (await answersNow(paths)).controlPlane;
    expect(after.connected).toBe("off");
    expect(after.pages).toBe(before.pages);
    expect(after.address).toBe(before.address);
    expect(after.connect).toBe("yes");
    expect(saved.body.restart).toEqual(["controlPlane"]);
  });

  test("a save its checks refuse writes nothing, and is recorded as refused, with its section", async () => {
    const { paths, link } = await hxFortress();
    const before = await rawConfig(paths);
    const c = await serve(paths);
    const marta = await signInFromLink(c.runtime, link);
    const refused = await post(c, marta.token, SETTINGS_PATHS.save, {
      section: "signIn",
      answers: { signIn: { provider: "openid-connect" } },
    });
    expect(refused.status).toBe(200);
    expect(refused.body.saved).toBe(false);
    expect("checks" in refused.body && refused.body.checks.some((check) => check.step === "signIn" && !check.ok)).toBe(true);
    expect((await answersNow(paths)).signIn.provider).toBe("local");
    expect(await rawConfig(paths)).toEqual(before);
    const records = (await spoolRecords(paths)).filter((r) => r.action.startsWith("console.settings."));
    expect(records.map((r) => [r.action, r.kind, r.outcome])).toEqual([
      ["console.settings.saved", "intent", null],
      ["console.settings.saved", "outcome", "refused"],
    ]);
    expect(records[0]?.actor).toBe(LOGIN);
    expect(records[0]?.params).toEqual({
      section: "signIn",
      changed: "signIn",
      restart: "nothing",
      provider: "openid-connect",
      administratorGroups: "",
      operatorGroups: "",
      readonlyGroups: "",
      viewerGroups: "",
    });
  });

  test("a save is recorded as a pair around the writing, with the section, what changed and what waits for a start", async () => {
    const { paths, link } = await hxFortress();
    const c = await serve(paths);
    const marta = await signInFromLink(c.runtime, link);
    expect((await toggle(c, marta.token, false)).body.saved).toBe(true);
    const off = await post(c, marta.token, SETTINGS_PATHS.save, {
      section: "auditTrail",
      answers: { auditTrail: { copyTo: "none", keepFor: "until-removed" } },
    });
    expect(off.body.saved).toBe(true);
    const records = (await spoolRecords(paths)).filter((r) => r.action === "console.settings.saved");
    expect(records.map((r) => r.kind)).toEqual(["intent", "outcome", "intent", "outcome"]);
    expect([records[0]?.actor, records[0]?.sessionRef, records[0]?.outcome]).toEqual([LOGIN, marta.session.id, null]);
    // Exactly these, and nothing of the answers.
    expect(records[0]?.params).toEqual({ section: "modules", changed: "modules", restart: "nothing" });
    expect([records[1]?.outcome, records[1]?.params]).toEqual(["done", null]);
    // A save that changes nothing is a save all the same, and says so.
    if (off.body.saved) expect(off.body.changed).toEqual([]);
    expect(records[2]?.params).toEqual({ section: "auditTrail", changed: "nothing", restart: "nothing" });
  });

  test("a switch of the connection is recorded as waiting for a start", async () => {
    const { paths, link } = await hxFortress({ connect: true });
    const c = await serve(paths);
    const marta = await signInFromLink(c.runtime, link);
    const off = await post(c, marta.token, SETTINGS_PATHS.save, {
      section: "controlPlane",
      answers: { controlPlane: { connected: "off" } },
    });
    expect(off.body.saved && off.body.restart).toEqual(["controlPlane"]);
    const intent = (await spoolRecords(paths)).find((r) => r.action === "console.settings.saved" && r.kind === "intent");
    expect(intent?.params).toEqual({ section: "controlPlane", changed: "controlPlane", restart: "controlPlane" });
  });

  test("two saves of two sections at once: both changes hold", async () => {
    const { paths, link } = await hxFortress({ connect: true });
    const c = await serve(paths);
    const marta = await signInFromLink(c.runtime, link);
    // Both read the state first, as two pages would, then send at once.
    const [modules, connection] = await Promise.all([
      toggle(c, marta.token, false),
      post(c, marta.token, SETTINGS_PATHS.save, {
        section: "controlPlane",
        answers: { controlPlane: { connected: "off" } },
      }),
    ]);
    expect([modules.body.saved, connection.body.saved]).toEqual([true, true]);
    const now = await answersNow(paths);
    expect([now.modules.databases, now.controlPlane.connected]).toEqual([false, "off"]);
  });
});

// ── Sign-in through the identity provider ────────────────────────────────────

describe("the identity provider's groups, from Settings", () => {
  const ISSUER = "https://id.northstar.example";

  /** An HX Fortress whose console signs people in through the identity
   *  provider, set up on the host, and a provider that describes itself. */
  async function withProvider(): Promise<{ paths: Paths; link: string; check: CheckFakes }> {
    const made = await hxFortress();
    await new OidcConfigStore(path.join(made.paths.uiRoot, "oidc.json")).update(
      (config) => ({
        ...config,
        enabled: true,
        issuer: ISSUER,
        clientId: "hx-console",
        administratorGroups: ["hx-admins"],
      }),
      clock,
    );
    const check: CheckFakes = {
      fetch: (async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input);
        return url === `${ISSUER}/.well-known/openid-configuration`
          ? Response.json(providerDocument(ISSUER))
          : new Response(null, { status: 404 });
      }) as unknown as typeof fetch,
    };
    return { ...made, check };
  }

  test("the issuer, the client ID and the client secret are never settable, and a save that carries them changes nothing", async () => {
    const { paths, link, check } = await withProvider();
    const run = await SetupRun.open({ ...runDeps(paths), way: "settings" });
    const settable = run.settableIn("signIn");
    for (const at of ["signIn.issuer", "signIn.clientId", "signIn.clientSecret", "signIn.groupsClaim"]) {
      expect([at, settable.has(at), run.set(at, "elsewhere")]).toEqual([at, false, false]);
    }
    expect([...settable].sort()).toEqual(
      [
        "signIn.provider",
        "signIn.administratorGroups",
        "signIn.operatorGroups",
        "signIn.readonlyGroups",
        "signIn.viewerGroups",
      ].sort(),
    );

    const oidc = new OidcConfigStore(path.join(paths.uiRoot, "oidc.json"));
    const before = await oidc.load();
    const c = await serve(paths, CONNECTED, check);
    const marta = await signInFromLink(c.runtime, link);
    const saved = await post(c, marta.token, SETTINGS_PATHS.save, {
      section: "signIn",
      answers: {
        signIn: { issuer: "https://id.elsewhere.example", clientId: "elsewhere", clientSecret: "elsewhere-secret" },
      },
    });
    expect(saved.body.saved).toBe(true);
    if (saved.body.saved) expect(saved.body.changed).toEqual([]);
    expect(await oidc.load()).toEqual(before);
  });

  test("the record of a Sign-in save holds each group list whole, however long it is", async () => {
    const { paths, link, check } = await withProvider();
    const c = await serve(paths, CONNECTED, check);
    const marta = await signInFromLink(c.runtime, link);
    const long = "g".repeat(MAX_GROUP_CHARS);
    const saved = await post(c, marta.token, SETTINGS_PATHS.save, {
      section: "signIn",
      answers: { signIn: { administratorGroups: ["hx-admins", long, "intruders"] } },
    });
    expect(saved.body.saved).toBe(true);
    const intent = (await spoolRecords(paths)).find((r) => r.action === "console.settings.saved" && r.kind === "intent");
    expect(intent?.params?.administratorGroups).toBe(`hx-admins,${long},intruders`);

    // The longest list a role can have fits whole, and every other parameter
    // keeps the cap it had.
    const longest = Array.from({ length: MAX_GROUPS }, (_, i) => String(i).padStart(MAX_GROUP_CHARS, "g")).join(",");
    expect(longest.length).toBeLessThanOrEqual(MAX_GROUP_LIST_CHARS);
    expect(sanitizeParams(AUDIT_ACTIONS.settingsSaved, { operatorGroups: longest })).toEqual({ operatorGroups: longest });
    const tooLong = "x".repeat(MAX_PARAM_CHARS + 50);
    expect(sanitizeParams(AUDIT_ACTIONS.settingsSaved, { section: tooLong })).toEqual({
      section: tooLong.slice(0, MAX_PARAM_CHARS),
    });
    expect(sanitizeParams("cli.ui.oidc_set_operatorGroups", { value: longest })).toEqual({
      value: longest.slice(0, MAX_PARAM_CHARS),
    });
  });

  test("a list of a blank name is refused exactly as an empty one, and nothing is written", async () => {
    const { paths, link, check } = await withProvider();
    const oidc = new OidcConfigStore(path.join(paths.uiRoot, "oidc.json"));
    const before = await oidc.load();
    const c = await serve(paths, CONNECTED, check);
    const marta = await signInFromLink(c.runtime, link);
    const save = (administratorGroups: string[]): ReturnType<typeof post> =>
      post(c, marta.token, SETTINGS_PATHS.save, { section: "signIn", answers: { signIn: { administratorGroups } } });

    const blank = await save([" "]);
    expect(blank.body.saved).toBe(false);
    expect(JSON.stringify(blank.body)).toContain("Give at least one group a role");
    expect(blank.body).toEqual((await save([])).body);
    expect(await oidc.load()).toEqual(before);
  });

  test("a save changes the group lists, and is recorded with them and the provider, as names", async () => {
    const { paths, link, check } = await withProvider();
    const c = await serve(paths, CONNECTED, check);
    const marta = await signInFromLink(c.runtime, link);
    const saved = await post(c, marta.token, SETTINGS_PATHS.save, {
      section: "signIn",
      answers: { signIn: { administratorGroups: ["hx-admins", "hx-owners"], operatorGroups: ["data-team"] } },
    });
    expect(saved.body.saved).toBe(true);
    const oidc = await new OidcConfigStore(path.join(paths.uiRoot, "oidc.json")).load();
    expect([oidc.administratorGroups, oidc.operatorGroups, oidc.issuer, oidc.clientId]).toEqual([
      ["hx-admins", "hx-owners"],
      ["data-team"],
      ISSUER,
      "hx-console",
    ]);
    const intent = (await spoolRecords(paths)).find((r) => r.action === "console.settings.saved" && r.kind === "intent");
    expect(intent?.params).toEqual({
      section: "signIn",
      changed: "signIn",
      restart: "nothing",
      provider: "openid-connect",
      administratorGroups: "hx-admins,hx-owners",
      operatorGroups: "data-team",
      readonlyGroups: "",
      viewerGroups: "",
    });

    // Switched to accounts on this HX Fortress: the provider's settings are
    // kept, and the record says which way people sign in.
    const local = await post(c, marta.token, SETTINGS_PATHS.save, {
      section: "signIn",
      answers: { signIn: { provider: "local" } },
    });
    expect(local.body.saved).toBe(true);
    const kept = await new OidcConfigStore(path.join(paths.uiRoot, "oidc.json")).load();
    expect([kept.enabled, kept.issuer, kept.administratorGroups]).toEqual([false, ISSUER, ["hx-admins", "hx-owners"]]);
    const second = (await spoolRecords(paths)).filter((r) => r.action === "console.settings.saved" && r.kind === "intent")[1];
    expect(second?.params).toEqual({ section: "signIn", changed: "signIn", restart: "nothing", provider: "local" });
  });
});

// ── What a save answers for ──────────────────────────────────────────────────

describe("a save is refused by its own section and by what it causes, not by what was wrong before", () => {
  test("with the model's key gone from the key store, the connection is still switched off", async () => {
    const { paths, link } = await hxFortress({ connect: true, model: true });
    // This console's key store has no key named "model-key".
    const c = await serve(paths);
    const marta = await signInFromLink(c.runtime, link);
    const saved = await post(c, marta.token, SETTINGS_PATHS.save, {
      section: "controlPlane",
      answers: { controlPlane: { connected: "off" } },
    });
    expect(saved.body.saved).toBe(true);
    expect((await answersNow(paths)).controlPlane.connected).toBe("off");
  });

  test("a module that needs a model is not switched on while no model is chosen", async () => {
    const { paths, link } = await hxFortress();
    const c = await serve(paths);
    const marta = await signInFromLink(c.runtime, link);
    expect((await answersNow(paths)).model.provider).toBe("none");
    const refused = await post(c, marta.token, SETTINGS_PATHS.save, {
      section: "modules",
      answers: { modules: { session_vault: true } },
    });
    expect(refused.body.saved).toBe(false);
    const model = "checks" in refused.body ? refused.body.checks.find((check) => check.step === "model") : undefined;
    expect(model?.ok).toBe(false);
    expect(model?.lines.some((line) => !line.ok && line.text.startsWith("Agentic Sessions needs an AI model"))).toBe(true);
    expect((await answersNow(paths)).modules.session_vault).toBe(false);
  });

  /** What a console needs to switch Agentic Sessions on, beside its model: a
   *  bucket, kept on the host as an earlier setup kept it, and where the
   *  search extension is downloaded from. `env` is the console's environment,
   *  which a test may change between two saves. */
  function sessionsReady(env: Record<string, string | undefined>, probe = async (): Promise<void> => {}): Partial<SetupRunDeps> {
    env.FORTRESS_PGVECTOR_URL = "https://downloads.northstar.example/pgvector";
    return {
      env,
      read: { vaultCredentials: async () => ({ store: "s3", bucket: "northstar-hx", region: "us-east-1" }) },
      // No key store is given: the one the answers name is asked.
      check: {
        fetch: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
        probeDatabase: async () => "PostgreSQL 17.2",
        probeFiles: probe,
        timeoutMs: 2_000,
      },
    };
  }
  const sessionsOn = (c: Console, token: string): ReturnType<typeof post> =>
    post(c, token, SETTINGS_PATHS.save, { section: "modules", answers: { modules: { session_vault: true } } });
  const keyRefused = (body: unknown): boolean =>
    JSON.stringify(body).includes(JSON.stringify({ ok: false, text: "No key with this name", path: "model.key" }));

  test("Agentic Sessions is not switched on while the model's key is missing from a key store on this host", async () => {
    const { paths, link } = await hxFortress({ model: "openai" });
    // This host's own environment is the key store, and it holds no model key.
    const env: Record<string, string | undefined> = {};
    const c = await serve(paths, CONNECTED, {}, sessionsReady(env));
    const marta = await signInFromLink(c.runtime, link);

    const refused = await sessionsOn(c, marta.token);
    expect(refused.body.saved).toBe(false);
    expect(keyRefused(refused.body)).toBe(true);
    expect((await answersNow(paths)).modules.session_vault).toBe(false);

    // With the key in the environment, the same save is taken.
    env.FORTRESS_SECRET_MODEL_KEY = MODEL_KEY_VALUE;
    expect((await sessionsOn(c, marta.token)).body.saved).toBe(true);
    expect((await answersNow(paths)).modules.session_vault).toBe(true);
  });

  test("Agentic Sessions is not switched on while the model's key is missing from a key store that only the full check asks", async () => {
    const { paths, link } = await hxFortress({ model: "openai", vault: true });
    // A vault is not on this host, so only a full check asks it for the key.
    const values: Record<string, string> = { "db-url": DB_URL };
    const ready = sessionsReady({});
    const c = await serve(paths, CONNECTED, {}, { ...ready, check: { ...ready.check, keyStore: () => fixedSecrets(values) } });
    const marta = await signInFromLink(c.runtime, link);

    const refused = await sessionsOn(c, marta.token);
    expect(refused.body.saved).toBe(false);
    expect(keyRefused(refused.body)).toBe(true);
    expect((await answersNow(paths)).modules.session_vault).toBe(false);

    values["model-key"] = MODEL_KEY_VALUE;
    expect((await sessionsOn(c, marta.token)).body.saved).toBe(true);
  });

  test("Agentic Sessions is not switched on while its file store does not take a test file", async () => {
    const { paths, link } = await hxFortress({ model: "openai" });
    let refuses = true;
    const env: Record<string, string | undefined> = { FORTRESS_SECRET_MODEL_KEY: MODEL_KEY_VALUE };
    const c = await serve(paths, CONNECTED, {}, sessionsReady(env, async () => {
      if (refuses) throw Object.assign(new Error("denied"), { $metadata: { httpStatusCode: 403 } });
    }));
    const marta = await signInFromLink(c.runtime, link);

    const refused = await sessionsOn(c, marta.token);
    expect(refused.body.saved).toBe(false);
    expect(JSON.stringify(refused.body)).toContain("The test file could not be written: the store refused this host's access");
    expect((await answersNow(paths)).modules.session_vault).toBe(false);

    refuses = false;
    expect((await sessionsOn(c, marta.token)).body.saved).toBe(true);
  });

  test("a refusal in the section being saved refuses the save, even one that was there before", async () => {
    const { paths, link } = await hxFortress({ model: true });
    // This console's key store has no key named "model-key", before the save
    // and after it.
    const c = await serve(paths);
    const marta = await signInFromLink(c.runtime, link);
    const refused = await post(c, marta.token, SETTINGS_PATHS.save, {
      section: "model",
      answers: { model: { provider: "openai", key: "model-key" } },
    });
    expect(refused.body.saved).toBe(false);
    const model = "checks" in refused.body ? refused.body.checks.find((check) => check.step === "model") : undefined;
    expect(model?.lines.some((line) => !line.ok && line.path === "model.key")).toBe(true);
  });

  test("of another step's refusals, only those the saved answers do not get count", () => {
    const before = {
      step: "model" as const,
      ok: false,
      lines: [
        { ok: false, text: "No key with this name", path: "model.key" },
        { ok: false, text: "Not reached from here", soft: true },
      ],
    };
    const now = {
      step: "model" as const,
      ok: false,
      lines: [
        { ok: false, text: "No key with this name", path: "model.key" },
        { ok: false, text: "No key with this name", path: "model.address" },
        { ok: false, text: "Not reached from here", soft: true },
        { ok: true, text: "Anthropic, directly" },
      ],
    };
    const kept = newRefusalsOnly(now, before);
    expect(kept.ok).toBe(false);
    expect(kept.lines.map((line) => `${line.ok} ${line.path ?? "-"} ${line.text}`)).toEqual([
      "false model.address No key with this name",
      "false - Not reached from here",
      "true - Anthropic, directly",
    ]);
    expect(newRefusalsOnly({ ...now, lines: now.lines.slice(0, 1) }, before)).toEqual({ step: "model", ok: true, lines: [] });
  });
});

// ── A connection the environment sets ────────────────────────────────────────

describe("a connection that the environment sets, in a container that has not enrolled yet", () => {
  const ENV = { FORTRESS_CLOUD_URL: CONTROL, FORTRESS_ENROLL_TOKEN: ["token", "from", "the", "environment"].join("-") };
  const SAID = "The connection is set by this HX Fortress's environment (FORTRESS_CLOUD_URL). Change it there";

  test("is not switched off from Settings, and nothing is written", async () => {
    const { paths, link } = await hxFortress();
    const before = await rawConfig(paths);
    const c = await serve(paths, CONNECTED, {}, { env: ENV });
    const marta = await signInFromLink(c.runtime, link);
    expect((await read(c, marta.token)).body.answers.controlPlane).toMatchObject({ connect: "yes", connected: "on" });

    const refused = await post(c, marta.token, SETTINGS_PATHS.save, {
      section: "controlPlane",
      answers: { controlPlane: { connected: "off" } },
    });
    expect(refused.body.saved).toBe(false);
    expect(JSON.stringify(refused.body)).toContain(JSON.stringify({ ok: false, text: SAID, path: "controlPlane.connected" }));
    expect(await rawConfig(paths)).toEqual(before);
  });

  test("takes no new install id, also after the control plane refused the connection", async () => {
    const { paths, link } = await hxFortress();
    const c = await serve(paths, ENDED, {}, { env: ENV });
    const marta = await signInFromLink(c.runtime, link);
    const refused = await post(c, marta.token, SETTINGS_PATHS.installId, { id: NEW_ID });
    expect(refused.status).toBe(200);
    expect(refused.body as unknown).toEqual({
      saved: false,
      checks: [{ step: "controlPlane", ok: false, lines: [{ ok: false, text: SAID }] }],
    });
    expect(refused.text).not.toContain(NEW_ID);
    expect(await new FilePendingEnrollmentStore(paths.pendingEnrollment).load()).toBeNull();
  });
});

// ── The model's provider ─────────────────────────────────────────────────────

describe("the provider of a model with an address or a name of the organization's own is changed on the host", () => {
  const OWN = "https://ai.northstar.example/v1";
  const ownRefusal = (body: unknown): boolean =>
    JSON.stringify(body).includes(JSON.stringify({ ok: false, text: MODEL_SET_ON_HOST, path: "model.provider" }));

  test("an address in the saved answers: the change is refused, while typing and on save, and the address stays", async () => {
    const { paths, link } = await hxFortress({ ownModelAddress: OWN });
    const before = await rawConfig(paths);
    expect((before.model as { address?: string }).address).toBe(OWN);
    const c = await serve(paths, CONNECTED, withModelKey());
    const marta = await signInFromLink(c.runtime, link);
    const answers = { model: { provider: "anthropic", key: "model-key" } };

    const checked = await post(c, marta.token, SETTINGS_PATHS.check, { section: "model", answers });
    expect(ownRefusal(checked.body)).toBe(true);
    const refused = await post(c, marta.token, SETTINGS_PATHS.save, { section: "model", answers });
    expect(refused.body.saved).toBe(false);
    expect(ownRefusal(refused.body)).toBe(true);
    expect(await rawConfig(paths)).toEqual(before);

    // The address itself is never settable from Settings: a save that
    // carries another changes nothing.
    const run = await SetupRun.open({ ...runDeps(paths), way: "settings" });
    expect(run.settableIn("model").has("model.address")).toBe(false);
    expect(run.set("model.address", "https://ai.elsewhere.example/v1")).toBe(false);
    const elsewhere = await post(c, marta.token, SETTINGS_PATHS.save, {
      section: "model",
      answers: { model: { address: "https://ai.elsewhere.example/v1" } },
    });
    expect(elsewhere.body.saved).toBe(true);
    if (elsewhere.body.saved) expect(elsewhere.body.changed).toEqual([]);
    expect(await rawConfig(paths)).toEqual(before);

    // A save that keeps the provider is not held to this rule.
    const kept = await post(c, marta.token, SETTINGS_PATHS.save, {
      section: "model",
      answers: { model: { provider: "openai", key: "model-key" } },
    });
    expect(ownRefusal(kept.body)).toBe(false);
  });

  for (const [variable, value] of [
    ["FORTRESS_OPENAI_BASE_URL", OWN],
    ["FORTRESS_EMBED_MODEL", "text-embedding-3-large"],
  ] as const) {
    test(`an answer that ${variable} pins in the console's environment: the change is refused`, async () => {
      const { paths, link } = await hxFortress({ model: true });
      const before = await rawConfig(paths);
      const c = await serve(paths, CONNECTED, withModelKey(), { env: { [variable]: value } });
      const marta = await signInFromLink(c.runtime, link);
      const refused = await post(c, marta.token, SETTINGS_PATHS.save, {
        section: "model",
        answers: { model: { provider: "openai", key: "model-key" } },
      });
      expect(refused.body.saved).toBe(false);
      expect(ownRefusal(refused.body)).toBe(true);
      expect(await rawConfig(paths)).toEqual(before);
    });
  }
});

describe("what waits for HX Fortress to start again", () => {
  /** The status file of a daemon that runs now, and started with Agentic
   *  Sessions as `sessions` says. */
  async function daemonRuns(paths: Paths, sessions: "on" | "off"): Promise<void> {
    const now = new Date().toISOString();
    await mkdir(path.dirname(paths.status), { recursive: true });
    await writeFile(
      paths.status,
      JSON.stringify({
        schemaVersion: 1,
        sessions,
        host: { state: "running", pid: 4242, startedAt: now, updatedAt: now, error: null, writtenAt: now },
        connection: { state: "offline", reason: "no_control_plane", message: null },
        postgres: { phase: "ready", reason: null },
        modules: [],
      }),
    );
  }

  /** An HX Fortress whose saved answers have Agentic Sessions on. */
  async function withSessions(): Promise<{ paths: Paths; link: string }> {
    const made = await hxFortress();
    const config = await rawConfig(made.paths);
    const modules = config.modules as { enabled: string[] };
    await writeFile(made.paths.config, JSON.stringify({ ...config, modules: { enabled: [...modules.enabled, "session_vault"] } }));
    return made;
  }

  test("Agentic Sessions off, then Databases off: the first still waits for a start after the second", async () => {
    const { paths, link } = await withSessions();
    await daemonRuns(paths, "on");
    const c = await serve(paths);
    const marta = await signInFromLink(c.runtime, link);

    const sessionsOff = await post(c, marta.token, SETTINGS_PATHS.save, {
      section: "modules",
      answers: { modules: { session_vault: false } },
    });
    expect(sessionsOff.body.saved && sessionsOff.body.restart).toEqual(["modules"]);
    const databasesOff = await toggle(c, marta.token, false);
    expect(databasesOff.body.saved && databasesOff.body.restart).toEqual(["modules"]);
    const records = (await spoolRecords(paths)).filter((r) => r.action === "console.settings.saved" && r.kind === "intent");
    expect(records.map((r) => r.params?.restart)).toEqual(["modules", "modules"]);
  });

  test("a daemon that started with Agentic Sessions off needs no start to have it off", async () => {
    const { paths, link } = await withSessions();
    await daemonRuns(paths, "off");
    const c = await serve(paths);
    const marta = await signInFromLink(c.runtime, link);
    const off = await post(c, marta.token, SETTINGS_PATHS.save, {
      section: "modules",
      answers: { modules: { session_vault: false } },
    });
    expect(off.body.saved && off.body.restart).toEqual([]);
  });

  test("with no daemon running, what was saved is what a save is held to", async () => {
    const { paths, link } = await withSessions();
    // A status file a daemon left when it stopped describes none that runs.
    await daemonRuns(paths, "on");
    const status = JSON.parse(await Bun.file(paths.status).text()) as { host: Record<string, unknown> };
    await writeFile(paths.status, JSON.stringify({ ...status, host: { ...status.host, state: "stopped" } }));
    const c = await serve(paths);
    const marta = await signInFromLink(c.runtime, link);
    const off = await post(c, marta.token, SETTINGS_PATHS.save, {
      section: "modules",
      answers: { modules: { session_vault: false } },
    });
    expect(off.body.saved && off.body.restart).toEqual(["modules"]);
    expect((await toggle(c, marta.token, false)).body.saved).toBe(true);
    const second = (await spoolRecords(paths)).filter((r) => r.action === "console.settings.saved" && r.kind === "intent")[1];
    expect(second?.params?.restart).toBe("nothing");
  });
});

describe("what a save writes", () => {
  test("on an HX Fortress that is not set up, every save is refused, and nothing is written", async () => {
    const made = await tempRoot();
    cleanups.push(made.cleanup);
    const paths = made.paths;
    // A console with an account, on a root the setup never wrote.
    await new UiConfigStore(paths.uiConfig).update((config) => ({ ...config, secondStep: "required" }));
    const c = await serve(paths, ENDED);
    const marta = await account(c, LOGIN, "operator");
    expect((await read(c, marta.token)).body.frame.setUp).toBe(false);
    const refusal = (section: string): unknown => ({
      saved: false,
      checks: [{ step: section, ok: false, lines: [{ ok: false, text: NOT_SET_UP_HERE }] }],
    });

    const modules = await toggle(c, marta.token, false);
    expect(modules.body as unknown).toEqual(refusal("modules"));
    const signIn = await post(c, marta.token, SETTINGS_PATHS.save, {
      section: "signIn",
      answers: { signIn: { provider: "openid-connect" } },
    });
    expect(signIn.body as unknown).toEqual(refusal("signIn"));
    const id = await post(c, marta.token, SETTINGS_PATHS.installId, { id: NEW_ID });
    expect(id.body as unknown).toEqual(refusal("controlPlane"));

    expect(await Bun.file(paths.config).exists()).toBe(false);
    expect(await new FilePendingEnrollmentStore(paths.pendingEnrollment).load()).toBeNull();
    expect((await spoolRecords(paths)).filter((r) => r.action.startsWith("console.settings."))).toEqual([]);
  });

  test("a save that changes nothing writes no file, not even the setup's mark", async () => {
    const { paths, link } = await hxFortress();
    const c = await serve(paths);
    const marta = await signInFromLink(c.runtime, link);
    const files = [paths.config, paths.uiConfig, path.join(paths.uiRoot, "oidc.json"), paths.pendingEnrollment];
    const before = await Promise.all(files.map(async (file) => ((await Bun.file(file).exists()) ? Bun.file(file).text() : null)));
    clock += 60_000;

    const same = await post(c, marta.token, SETTINGS_PATHS.save, {
      section: "modules",
      answers: { modules: { databases: true, host: true } },
    });
    expect(same.body.saved).toBe(true);
    if (same.body.saved) expect([same.body.changed, same.body.restart, same.body.notes]).toEqual([[], [], []]);
    const after = await Promise.all(files.map(async (file) => ((await Bun.file(file).exists()) ? Bun.file(file).text() : null)));
    expect(after).toEqual(before);
  });
});

describe("an answer is settable only while its field is in effect", () => {
  async function settingsRun(paths: Paths): Promise<SetupRun> {
    return SetupRun.open({ ...runDeps(paths), way: "settings" });
  }

  test("a model's region and project, for a route this build does not have, are not settable, and a save that carries them changes nothing", async () => {
    const { paths, link } = await hxFortress({ model: "openai" });
    const run = await settingsRun(paths);
    const model = run.settableIn("model");
    expect([...model].sort()).toEqual(["model.key", "model.provider", "model.route"]);
    expect(run.set("model.region", "us east 1")).toBe(false);
    expect(run.set("model.project", "a project")).toBe(false);

    const before = await rawConfig(paths);
    const c = await serve(paths, CONNECTED, withModelKey());
    const marta = await signInFromLink(c.runtime, link);
    const saved = await post(c, marta.token, SETTINGS_PATHS.save, {
      section: "model",
      answers: { model: { region: "us east 1", project: "a project" } },
    });
    expect(saved.body.saved).toBe(true);
    if (saved.body.saved) expect(saved.body.changed).toEqual([]);
    expect(await rawConfig(paths)).toEqual(before);
  });

  test("the groups of the identity provider are settable only while sign-in through it is chosen", async () => {
    const { paths } = await hxFortress();
    const run = await settingsRun(paths);
    const groups = ["signIn.administratorGroups", "signIn.operatorGroups", "signIn.readonlyGroups", "signIn.viewerGroups"];
    expect([...run.settableIn("signIn")]).toEqual(["signIn.provider"]);
    expect(run.set("signIn.administratorGroups", "hx-admins")).toBe(false);
    expect(run.set("signIn.provider", "openid-connect")).toBe(true);
    expect([...run.settableIn("signIn")].sort()).toEqual(["signIn.provider", ...groups].sort());
    expect(run.set("signIn.administratorGroups", "hx-admins")).toBe(true);
  });

  test("a request is taken in the same way whatever order its answers come in", async () => {
    expect(settingOrder("model.provider")).toBeLessThan(settingOrder("model.route"));
    expect(settingOrder("model.route")).toBeLessThan(settingOrder("model.region"));
    expect(settingOrder("signIn.provider")).toBeLessThan(settingOrder("signIn.administratorGroups"));
    // A new provider starts with no key: the key that comes before it in the
    // request is set after it, and kept.
    const { paths, link } = await hxFortress();
    const c = await serve(paths, CONNECTED, withModelKey());
    const marta = await signInFromLink(c.runtime, link);
    const saved = await post(c, marta.token, SETTINGS_PATHS.save, {
      section: "model",
      answers: { model: { key: "model-key", provider: "openai" } },
    });
    expect(saved.body.saved).toBe(true);
    expect((await answersNow(paths)).model).toMatchObject({ provider: "openai", key: "model-key" });
  });
});

describe("a save moves no answer it does not name", () => {
  test("a change of the model leaves the key store as it is, also one the place would not offer today", async () => {
    // Keys in an Azure Key Vault, on a machine with Docker: a pair the setup
    // would not offer now, as an older HX Fortress's settings can hold it.
    const { paths, link } = await hxFortress({ vault: true });
    const config = await rawConfig(paths);
    await writeFile(
      paths.config,
      JSON.stringify({
        ...config,
        install: { place: "docker", ssh: "marta@hx-fortress-vm.northstar.example", certificate: "own", database: "beside" },
      }),
    );
    const before = await rawConfig(paths);
    const c = await serve(paths, CONNECTED, withModelKey());
    const marta = await signInFromLink(c.runtime, link);
    const saved = await post(c, marta.token, SETTINGS_PATHS.save, {
      section: "model",
      answers: { model: { provider: "anthropic", key: "model-key" } },
    });
    expect(saved.body.saved).toBe(true);
    if (saved.body.saved) expect(saved.body.changed).toEqual(["model"]);
    const after = await rawConfig(paths);
    expect([after.secrets, after.install]).toEqual([before.secrets, before.install]);
    expect((after.model as { provider?: string }).provider).toBe("anthropic");
  });
});

// ── A failed save ────────────────────────────────────────────────────────────

describe("a failed save says this program's sentence, never an error's words", () => {
  // Words an error from the file system, or from a service, could hold.
  const OUTSIDE = "EACCES: permission denied, open '/srv/hx/identity/credentials.json' token=4f9c";
  // The writer reads its clock once, as it writes the settings: a clock that
  // fails is a writer that fails there.
  const failingWriter = (error: Error): Partial<SetupRunDeps> => ({
    now: () => {
      throw error;
    },
  });

  test("an error while writing is answered and recorded as this program's sentence", async () => {
    const { paths, link } = await hxFortress();
    const c = await serve(paths, CONNECTED, {}, failingWriter(new Error(OUTSIDE)));
    const marta = await signInFromLink(c.runtime, link);
    const failed = await toggle(c, marta.token, false);
    expect(failed.status).toBe(500);
    expect(failed.body as unknown).toEqual({ error: NOT_SAVED });
    expect(failed.text).not.toContain("EACCES");
    const outcome = (await spoolRecords(paths)).find((r) => r.action === "console.settings.saved" && r.kind === "outcome");
    expect(outcome).toMatchObject({ outcome: "failed", error: NOT_SAVED });
    expect(JSON.stringify(await spoolRecords(paths))).not.toContain("EACCES");
    expect(await databasesNow(paths)).toBe(true);
  });

  test("a refusal of the writer is said, and recorded, in its own sentence, on both routes", async () => {
    const sentence = "This HX Fortress is enrolled with another control plane, so it was not connected to this one";
    const { paths, link } = await hxFortress({ connect: true });
    const c = await serve(paths, ENDED, {}, failingWriter(new SetupRefusal(sentence)));
    const marta = await signInFromLink(c.runtime, link);
    const refused = await toggle(c, marta.token, false);
    expect(refused.status).toBe(409);
    expect(refused.body as unknown).toEqual({ error: sentence });
    const id = await post(c, marta.token, SETTINGS_PATHS.installId, { id: NEW_ID });
    expect(id.status).toBe(409);
    expect(id.body as unknown).toEqual({ error: sentence });
    expect(id.text).not.toContain(NEW_ID);
    const outcomes = (await spoolRecords(paths)).filter((r) => r.kind === "outcome" && r.action.startsWith("console.settings."));
    expect(outcomes.map((r) => [r.action, r.outcome, r.error])).toEqual([
      ["console.settings.saved", "failed", sentence],
      ["console.settings.install_id", "failed", sentence],
    ]);
  });

  test("an error while writing an install id is answered in the install id's sentence", async () => {
    const { paths, link } = await hxFortress({ connect: true });
    const c = await serve(paths, ENDED, {}, failingWriter(new Error(`${OUTSIDE} ${NEW_ID}`)));
    const marta = await signInFromLink(c.runtime, link);
    const failed = await post(c, marta.token, SETTINGS_PATHS.installId, { id: NEW_ID });
    expect(failed.status).toBe(500);
    expect(failed.body as unknown).toEqual({ error: INSTALL_ID_NOT_SAVED });
    expect(JSON.stringify(await spoolRecords(paths))).not.toContain(NEW_ID);
  });

  test("the writer's sentences for a person are of their own class", async () => {
    const { paths } = await hxFortress();
    const present = await readAnswers(paths, {}, { vaultCredentials: async () => null });
    const answers = structuredClone(present.answers);
    answers.controlPlane = { ...answers.controlPlane, connect: "yes", address: "control.example", connected: "on" };
    const thrown = await applyAnswers(answers, { paths, present, way: "console" }).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(SetupRefusal);
    expect((thrown as Error).message).toBe(
      "No install id was given for this control plane, so this HX Fortress was not enrolled",
    );
  });
});

// ── The code before a save ───────────────────────────────────────────────────

describe("the code before a save", () => {
  test("the code given at sign-in counts for five minutes; after them a save asks for one, as an answer", async () => {
    const { paths, link } = await hxFortress({ connect: true });
    // Refused, so that a new install id is one this HX Fortress may take.
    const c = await serve(paths, ENDED);
    const marta = await signInFromLink(c.runtime, link);

    expect((await read(c, marta.token)).body.asksCode).toBe(false);
    expect((await toggle(c, marta.token, false)).body.saved).toBe(true);

    passEnds();
    expect((await read(c, marta.token)).body.asksCode).toBe(true);
    const asked = await toggle(c, marta.token, true);
    expect(asked.status).toBe(200);
    expect(asked.body).toEqual({ saved: false, codeNeeded: CODE_NEEDED });
    expect(await databasesNow(paths)).toBe(false);

    // The same for a new install id: nothing is taken without the code.
    const id = await post(c, marta.token, SETTINGS_PATHS.installId, { id: NEW_ID });
    expect(id.body).toEqual({ saved: false, codeNeeded: CODE_NEEDED });
  });

  test("a right code saves, starts another five minutes, and is taken once", async () => {
    const { paths, link } = await hxFortress();
    const c = await serve(paths);
    const marta = await signInFromLink(c.runtime, link);
    clock += 31_000;
    // A second session of the same account, signed in from another network.
    const other = await signInAgain(c.runtime, marta.secret, OTHER_NET);

    passEnds();
    const code = codeOf(marta.secret);
    const saved = await toggle(c, marta.token, false, code);
    expect(saved.body.saved).toBe(true);
    if (saved.body.saved) expect(saved.body.state.asksCode).toBe(false);
    expect((await read(c, marta.token)).body.asksCode).toBe(false);
    expect((await toggle(c, marta.token, true)).body.saved).toBe(true);

    // The same code from the other session is used already.
    const again = await toggle(c, other.token, false, code);
    expect(again.body).toEqual({ saved: false, codeNeeded: CODE_REFUSED });
    expect(await databasesNow(paths)).toBe(true);
  });

  test("one code sent twice at once, from two sessions of the account, saves once", async () => {
    const { paths, link } = await hxFortress({ connect: true });
    const c = await serve(paths);
    const marta = await signInFromLink(c.runtime, link);
    clock += 31_000;
    const other = await signInAgain(c.runtime, marta.secret, OTHER_NET);
    passEnds();
    const code = codeOf(marta.secret);

    const answers = await Promise.all([
      toggle(c, marta.token, false, code),
      post(c, other.token, SETTINGS_PATHS.save, {
        section: "controlPlane",
        answers: { controlPlane: { connected: "off" } },
        code,
      }),
    ]);
    const saved = answers.filter((answer) => answer.body.saved);
    const refused = answers.filter((answer) => !answer.body.saved);
    expect(saved).toHaveLength(1);
    expect(refused.map((answer) => answer.body)).toEqual([{ saved: false, codeNeeded: CODE_REFUSED }]);
    // Exactly one of the two changes was written.
    const now = await answersNow(paths);
    expect([now.modules.databases === false, now.controlPlane.connected === "off"].filter(Boolean)).toHaveLength(1);
  });

  test("a wrong code from Settings counts in the lockout table, so the next one within its delay is not looked at", async () => {
    const { paths, link } = await hxFortress();
    const c = await serve(paths);
    const marta = await signInFromLink(c.runtime, link);
    passEnds();
    // A minute apart, so that the bucket of five a minute stops none of them.
    for (let i = 0; i <= LOCKOUT_FREE_ATTEMPTS; i += 1) {
      clock += 61_000;
      expect((await toggle(c, marta.token, false, wrongCodeOf(marta.secret))).body).toEqual({
        saved: false,
        codeNeeded: CODE_REFUSED,
      });
    }
    // The last wrong code began a delay: a right code within it is not looked at.
    const right = await toggle(c, marta.token, false, codeOf(marta.secret));
    expect(right.body).toEqual({ saved: false, codeNeeded: tooManyAttempts(LOCKOUT_BASE_MS) });
    expect(await databasesNow(paths)).toBe(true);
    // After the delay, the right code is taken.
    clock += LOCKOUT_BASE_MS + 1;
    expect((await toggle(c, marta.token, false, codeOf(marta.secret))).body.saved).toBe(true);
  });

  test("a wrong code is refused, counts as one at sign-in does, and is recorded with the section only", async () => {
    const { paths, link } = await hxFortress();
    const c = await serve(paths);
    const marta = await signInFromLink(c.runtime, link);
    passEnds();

    const refused = await toggle(c, marta.token, false, wrongCodeOf(marta.secret));
    expect(refused.body).toEqual({ saved: false, codeNeeded: CODE_REFUSED });
    expect(await databasesNow(paths)).toBe(true);

    const records = (await spoolRecords(paths)).filter((r) => r.action.startsWith("console.settings."));
    expect(records.map((r) => r.action)).toEqual(["console.settings.code_refused"]);
    expect([records[0]?.actor, records[0]?.sessionRef, records[0]?.outcome]).toEqual([LOGIN, marta.session.id, "refused"]);
    // The section only: nothing of the code, and nothing of the answers.
    expect(records[0]?.params).toEqual({ section: "modules" });

    // The account took nine more wrong codes, a minute apart, so neither the
    // bucket nor the lockout stops them first. The last one closes the second
    // step, and the answer says how long to wait.
    let last = refused;
    for (let i = 1; i < CEILING_WRONG_CODES; i += 1) {
      clock += 61_000;
      last = await toggle(c, marta.token, false, wrongCodeOf(marta.secret));
    }
    expect(last.body).toEqual({ saved: false, codeNeeded: codeClosed(CEILING_CLOSED_MS) });
    expect(codeClosed(CEILING_CLOSED_MS)).toContain("15 minutes");

    // Closed means closed: a right code is not looked at, here or at sign-in.
    clock += 61_000;
    const right = await toggle(c, marta.token, false, codeOf(marta.secret));
    expect("codeNeeded" in right.body && right.body.codeNeeded).toContain("Too many wrong codes");
    expect(await databasesNow(paths)).toBe(true);
    const first = await c.runtime.signIn({ login: LOGIN, password: PASSWORD, remoteKey: OTHER_NET, remoteAddr: OTHER_NET });
    if (first.ok || first.status !== 200) throw new Error("expected the code step");
    const atSignIn = await c.runtime.completeSecondStep({
      ticket: first.challenge.ticket,
      code: codeOf(marta.secret),
      remoteKey: OTHER_NET,
      remoteAddr: OTHER_NET,
    });
    expect(atSignIn).toMatchObject({ ok: false, status: 429, reason: "too many codes" });
  });

  test("with the setting off nobody is asked", async () => {
    const { paths, link } = await hxFortress();
    const c = await serve(paths);
    const marta = await signInFromLink(c.runtime, link);
    await new UiConfigStore(paths.uiConfig).update((config) => ({ ...config, secondStep: "off" }));
    passEnds();
    expect((await read(c, marta.token)).body.asksCode).toBe(false);
    expect((await toggle(c, marta.token, false)).body.saved).toBe(true);
  });

  test("a sign-in through the identity provider counts for five minutes; after them a save asks the person to sign in again", async () => {
    expect(CODE_PASS_MS).toBe(5 * 60_000);
    expect(SIGN_IN_NEEDED).toContain("5 minutes");
    const { paths } = await hxFortress();
    const c = await serve(paths);
    const provider = await new OidcConfigStore(path.join(paths.uiRoot, "oidc.json")).update(
      (config) => ({
        ...config,
        enabled: true,
        issuer: "https://id.northstar.example",
        clientId: "hx-console",
        operatorGroups: ["hx-operators"],
      }),
      clock,
    );
    const signIn = async (): Promise<string> => {
      const issued = await c.runtime.issueOidcSession({
        identity: { subject: "lena-1", login: "lena.hart@northstar.example", role: "operator", groups: ["hx-operators"] },
        epoch: provider.epoch,
        remoteAddr: "127.0.0.1",
      });
      if (!issued.ok) throw new Error("expected a session");
      return issued.token;
    };
    const lena = await signIn();

    // Just signed in: never a code, and no new sign-in either.
    const fresh = (await read(c, lena)).body;
    expect([fresh.asksCode, fresh.asksSignIn]).toEqual([false, false]);
    expect((await toggle(c, lena, false)).body.saved).toBe(true);

    // After the pass: the page is told, and a save is answered, not taken.
    passEnds();
    const later = (await read(c, lena)).body;
    expect([later.asksCode, later.asksSignIn]).toEqual([false, true]);
    expect((await toggle(c, lena, true, "123456")).body).toEqual({ saved: false, signInNeeded: SIGN_IN_NEEDED });
    expect(await databasesNow(paths)).toBe(false);
    // The console's own second step being off changes nothing for it: that
    // setting is about the accounts of this console.
    await new UiConfigStore(paths.uiConfig).update((config) => ({ ...config, secondStep: "off" }));
    expect((await toggle(c, lena, true)).body).toEqual({ saved: false, signInNeeded: SIGN_IN_NEEDED });

    // Such a session has no code to judge.
    const session = c.runtime.sessions.list().find((s) => s.userLogin === "lena.hart@northstar.example") as UiSession;
    expect(await c.runtime.asksCode(session)).toBe(false);
    expect(c.runtime.asksSignIn(session)).toBe(true);
    expect(await c.runtime.confirmWithCode({ session, code: "123456", remoteKey: "127.0.0.1" })).toEqual({
      ok: false,
      reason: "refused",
    });

    // A new sign-in through the provider saves again.
    const again = await signIn();
    expect((await toggle(c, again, true)).body.saved).toBe(true);
    expect(await databasesNow(paths)).toBe(true);
  });

  test("the pass is held in the session only: another session, and a sign-out, do not carry it", async () => {
    const { paths, link } = await hxFortress();
    const c = await serve(paths);
    const marta = await signInFromLink(c.runtime, link);
    passEnds();
    expect((await toggle(c, marta.token, false, codeOf(marta.secret))).body.saved).toBe(true);
    clock += 31_000;
    const other = await signInAgain(c.runtime, marta.secret, OTHER_NET);
    // The other session's own code counts for it, from its own sign-in.
    expect(other.session.codePassedAt).toBe(clock);
    expect(marta.session.codePassedAt).toBe(clock - 31_000);
    // Nothing of the pass is written to a file.
    const users = await Bun.file(path.join(paths.uiRoot, "users.json")).text();
    expect(users).not.toContain("codePassedAt");
    expect(c.runtime.sessions.revoke(marta.session.id, "logout")).toBe(true);
    expect((await read(c, marta.token)).status).toBe(401);
  });
});

// ── A new install id ─────────────────────────────────────────────────────────

describe("a new install id", () => {
  /** An HX Fortress that enrolled with its control plane, which then ended
   *  the connection. */
  async function ended(): Promise<{ c: Console; marta: Person }> {
    const { paths, link } = await hxFortress({ connect: true });
    await new FileCredentialStore(paths.credentials).save({
      orgId: "org_northstar",
      fortressId: "hx_1",
      credential: ["credential", "for", "a", "test"].join("-"),
    });
    const c = await serve(paths, ENDED);
    return { c, marta: await signInFromLink(c.runtime, link) };
  }

  test("is written as the pending enrollment, and is in no reply, record, error or log", async () => {
    const { c, marta } = await ended();
    const saved = await post(c, marta.token, SETTINGS_PATHS.installId, { id: NEW_ID });
    expect(saved.status).toBe(200);
    expect(saved.body.saved).toBe(true);
    if (!saved.body.saved) return;
    expect(saved.body.restart).toEqual(["controlPlane"]);
    expect(saved.body.state.connection).toEqual(ENDED);

    const pending = await new FilePendingEnrollmentStore(c.paths.pendingEnrollment).load();
    expect(pending?.token).toBe(NEW_ID);
    expect(c.signals()).toBe(1);

    expect(saved.text).not.toContain(NEW_ID);
    const records = await spoolRecords(c.paths);
    expect(JSON.stringify(records)).not.toContain(NEW_ID);
    const intent = records.find((r) => r.action === "console.settings.install_id" && r.kind === "intent");
    expect(intent?.params).toEqual({ section: "controlPlane", changed: "controlPlane", restart: "controlPlane" });
    expect(records.find((r) => r.action === "console.settings.install_id" && r.kind === "outcome")?.outcome).toBe("done");
    expect(c.warnings.join("\n")).not.toContain(NEW_ID);
    // The page reads the state again, and the id is not in it.
    const after = await read(c, marta.token);
    expect(JSON.stringify(after.body)).not.toContain(NEW_ID);
  });

  test("is refused unless the daemon says the control plane refused the connection, before any code, and nothing is written or recorded", async () => {
    const { paths, link } = await hxFortress({ connect: true });
    let now: ConnectionShown = CONNECTED;
    const c = await serve(paths, () => now);
    const marta = await signInFromLink(c.runtime, link);
    // The code would be asked by now. It is not: nothing the person types
    // makes a working connection need a new id.
    passEnds();
    const pending = new FilePendingEnrollmentStore(paths.pendingEnrollment);
    const waiting = await pending.load();
    const refusal = {
      saved: false,
      checks: [{ step: "controlPlane", ok: false, lines: [{ ok: false, text: ID_ONLY_AFTER_REFUSAL }] }],
    };
    for (const connection of [
      CONNECTED,
      { state: "connecting", reason: null, refused: false, idWaiting: false },
      { state: "offline", reason: "no_control_plane", refused: false, idWaiting: false },
      { state: "unknown", reason: null, refused: false, idWaiting: false },
    ]) {
      now = connection;
      const refused = await post(c, marta.token, SETTINGS_PATHS.installId, { id: NEW_ID, code: codeOf(marta.secret) });
      expect(refused.status).toBe(200);
      expect(refused.body as unknown).toEqual(refusal);
      expect(refused.text).not.toContain(NEW_ID);
    }
    expect(await pending.load()).toEqual(waiting);
    expect((await spoolRecords(paths)).filter((r) => r.action.startsWith("console.settings."))).toEqual([]);
    expect(c.signals()).toBe(0);
    // Once it was refused, the same id is taken.
    now = ENDED;
    const taken = await post(c, marta.token, SETTINGS_PATHS.installId, { id: NEW_ID, code: codeOf(marta.secret) });
    expect(taken.body.saved).toBe(true);
    expect((await pending.load())?.token).toBe(NEW_ID);
  });

  test("the daemon's own status file decides: an old 'connected' says nothing, and a start that failed on a refusal takes an id", async () => {
    const { paths, link } = await hxFortress({ connect: true });
    await new FileCredentialStore(paths.credentials).save({
      orgId: "org_northstar",
      fortressId: "hx_1",
      credential: ["credential", "for", "a", "test"].join("-"),
    });
    await new FilePendingEnrollmentStore(paths.pendingEnrollment).clear();
    const writeStatus = async (
      host: Record<string, unknown>,
      connection: Record<string, unknown>,
      writtenAt: Date,
    ): Promise<void> => {
      const at = writtenAt.toISOString();
      await mkdir(path.dirname(paths.status), { recursive: true });
      await writeFile(
        paths.status,
        JSON.stringify({
          schemaVersion: 1,
          host: { state: "running", pid: 4242, startedAt: at, updatedAt: at, error: null, writtenAt: at, ...host },
          connection: { message: null, ...connection },
          postgres: { phase: "ready", reason: null },
          modules: [],
        }),
      );
    };
    // No injected connection: the route reads the file.
    const c = await serve(paths, null);
    const marta = await signInFromLink(c.runtime, link);

    // An old file of a daemon that said it was connected: nothing is known.
    await writeStatus({}, { state: "connected", reason: null }, new Date(Date.now() - 60_000));
    expect((await read(c, marta.token)).body.connection).toEqual({
      state: "unknown",
      reason: null,
      refused: false,
      idWaiting: false,
    });
    const notNow = await post(c, marta.token, SETTINGS_PATHS.installId, { id: NEW_ID });
    expect(JSON.stringify(notNow.body)).toContain(ID_ONLY_AFTER_REFUSAL);

    // The control plane refused the first connection of a start, so the start
    // failed: its last write is old and says `failed`, and holds the refusal.
    await writeStatus(
      { state: "failed", error: "The control plane refused the connection: invalid_credential" },
      { state: "offline", reason: "invalid_credential" },
      new Date(Date.now() - 60_000),
    );
    const taken = await post(c, marta.token, SETTINGS_PATHS.installId, { id: NEW_ID });
    expect(taken.body.saved).toBe(true);
    if (taken.body.saved) {
      expect(taken.body.state.connection).toEqual({
        state: "unknown",
        reason: "invalid_credential",
        refused: true,
        idWaiting: true,
      });
    }
    expect((await new FilePendingEnrollmentStore(paths.pendingEnrollment).load())?.token).toBe(NEW_ID);
  });

  test("switching the connection off removes the new id that waits, and keeps the enrollment", async () => {
    const { c, marta } = await ended();
    expect((await post(c, marta.token, SETTINGS_PATHS.installId, { id: NEW_ID })).body.saved).toBe(true);
    const pending = new FilePendingEnrollmentStore(c.paths.pendingEnrollment);
    expect((await pending.load())?.token).toBe(NEW_ID);

    const off = await post(c, marta.token, SETTINGS_PATHS.save, {
      section: "controlPlane",
      answers: { controlPlane: { connected: "off" } },
    });
    expect(off.body.saved).toBe(true);
    expect(await pending.load()).toBeNull();
    expect(await new FileCredentialStore(c.paths.credentials).load()).not.toBeNull();
    expect((await answersNow(c.paths)).controlPlane.connected).toBe("off");
  });

  test("an id of the wrong shape is refused without repeating it", async () => {
    const { c, marta } = await ended();
    const bad = "not an id; " + NEW_ID;
    const refused = await post(c, marta.token, SETTINGS_PATHS.installId, { id: bad });
    expect(refused.status).toBe(400);
    expect(refused.text).not.toContain(NEW_ID);
    expect((await new FilePendingEnrollmentStore(c.paths.pendingEnrollment).load())?.token).not.toBe(NEW_ID);
  });

  test("a failure while writing says this program's sentence, never the error's, in the reply and in the record", async () => {
    const { c, marta } = await ended();
    // The pending enrollment cannot be written: a folder stands where its file goes.
    await rm(c.paths.pendingEnrollment, { force: true });
    await mkdir(path.join(c.paths.pendingEnrollment, "in-the-way"), { recursive: true });
    await writeFile(path.join(c.paths.pendingEnrollment, "in-the-way", "file"), "x");
    const failed = await post(c, marta.token, SETTINGS_PATHS.installId, { id: NEW_ID });
    expect(failed.status).toBe(500);
    expect(failed.body.error).toBe(INSTALL_ID_NOT_SAVED);
    expect(failed.text).not.toContain(NEW_ID);
    expect(failed.text).not.toContain(c.paths.pendingEnrollment);
    expect(await new FilePendingEnrollmentStore(c.paths.pendingEnrollment).load().catch(() => null)).toBeNull();
    const outcome = (await spoolRecords(c.paths)).find(
      (r) => r.action === "console.settings.install_id" && r.kind === "outcome",
    );
    expect(outcome?.outcome).toBe("failed");
    expect(outcome?.error).toBe(INSTALL_ID_NOT_SAVED);
    expect(JSON.stringify(await spoolRecords(c.paths))).not.toContain(NEW_ID);
  });

  test("an HX Fortress that names no control plane takes none", async () => {
    const { paths, link } = await hxFortress();
    const c = await serve(paths);
    const marta = await signInFromLink(c.runtime, link);
    const refused = await post(c, marta.token, SETTINGS_PATHS.installId, { id: NEW_ID });
    expect(refused.body.saved).toBe(false);
    expect(refused.text).not.toContain(NEW_ID);
    expect(await new FilePendingEnrollmentStore(paths.pendingEnrollment).load()).toBeNull();
  });
});
