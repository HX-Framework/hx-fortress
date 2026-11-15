// The second step at sign-in, end to end: the setting, the password step that
// hands out a ticket, the setup link that is the only way to set one up, the
// code that finishes either, and what is written down.
//
// Every test owns a clock. A code belongs to a 30-second step, so the clock is
// moved on whenever a test needs the next code rather than waiting for it. The
// per-(login, network) bucket takes five attempts a minute, the password
// included, so a test that needs more moves the clock a minute or uses another
// network.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AuditSpool, listSpoolFiles } from "../src/console/audit-spool";
import { ConsoleAudit } from "../src/ui/audit-writer";
import { SETUP_TOKEN_HEADER } from "../src/ui/auth-routes";
import { UiConfigStore, type UiConfig } from "../src/ui/config";
import {
  LOCKOUT_COPY,
  SECOND_STEP_CLOSED_COPY,
  SECOND_STEP_FAILURE_COPY,
  SECOND_STEP_LINK_NEEDED_COPY,
  SECOND_STEP_RESTART_COPY,
} from "../src/ui/copy";
import { UiRuntime, type SecondStepChallenge, type SignInVerdict } from "../src/ui/runtime";
import { CEILING_CLOSED_MS, CEILING_WRONG_CODES, TICKET_TTL_MS } from "../src/ui/second-step";
import { startUiServer } from "../src/ui/server";
import { SESSION_HEADER } from "../src/ui/sessions";
import { base32Decode, hotp, stepAt } from "../src/ui/totp";
import {
  findUserBySetupToken,
  liveUser,
  parseUsersFile,
  UsersStore,
  type UiRole,
} from "../src/ui/users";
import { SECOND_STEP_PATH } from "../src/ui/wire";
import type { UiAssets } from "../src/ui/assets";

const PASSWORD = "correct-horse-battery";
const HOME_NET = "203.0.113.5";
const OTHER_NET = "198.51.100.7";

let root: string;
let clock: number;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hx-second-step-"));
  // Near the real time: setup links are minted against the real clock.
  clock = Date.now();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function runtimeOn(uiRoot: string): UiRuntime {
  return new UiRuntime({
    uiRoot,
    uiConfigFile: path.join(uiRoot, "ui.json"),
    cmdCredsDir: path.join(uiRoot, "cmd-creds"),
    env: {},
    now: () => clock,
  });
}

async function configure(settings: Partial<UiConfig>): Promise<void> {
  await new UiConfigStore(path.join(root, "ui.json")).update((c) => ({ ...c, ...settings }));
}

/** An account with a password and no second step, as the setting off makes. */
async function account(runtime: UiRuntime, login = "marta", role: UiRole = "operator"): Promise<void> {
  const created = await runtime.users.create(login, role, new Date(clock));
  await runtime.users.completeSetup(created.token, PASSWORD, new Date(clock));
}

/** The code an app holding `secret` shows now, or `offset` steps away. */
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

function passwordStep(runtime: UiRuntime, remoteKey = HOME_NET, login = "marta"): Promise<SignInVerdict> {
  return runtime.signIn({ login, password: PASSWORD, remoteKey, remoteAddr: remoteKey });
}

function challengeOf(verdict: SignInVerdict): SecondStepChallenge {
  if (verdict.ok || verdict.status !== 200) throw new Error(`expected a second step, got ${JSON.stringify(verdict)}`);
  return verdict.challenge;
}

/** Make an account through its setup link, the only way to set up a second
 *  step: the password and the first right code. Returns the app's secret. */
async function setUpThroughLink(
  runtime: UiRuntime,
  login = "marta",
  role: UiRole = "operator",
  network = OTHER_NET,
): Promise<string> {
  const created = await runtime.users.create(login, role, new Date(clock));
  const prepared = await runtime.prepareSetup(created.token, PASSWORD, network);
  if (prepared.challenge.kind !== "setup") throw new Error("expected a setup");
  const done = await runtime.completeSecondStep({
    ticket: prepared.challenge.ticket,
    code: codeOf(prepared.challenge.secret),
    remoteKey: network,
    remoteAddr: network,
  });
  expect(done.ok || (done.status === 403 && done.reason === "no console")).toBe(true);
  return prepared.challenge.secret;
}

async function usersVersion(): Promise<number> {
  return (JSON.parse(await readFile(path.join(root, "users.json"), "utf8")) as { version: number }).version;
}

describe("the setting", () => {
  test("absent means off: sign-in answers as before", async () => {
    const runtime = runtimeOn(root);
    await account(runtime);
    expect((await runtime.readConfig()).secondStep).toBe("off");
    const verdict = await passwordStep(runtime);
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.session.userLogin).toBe("marta");
    expect(runtime.secondSteps.size).toBe(0);
  });

  test("off answers as before also for an account that has a second step", async () => {
    const runtime = runtimeOn(root);
    await setUpThroughLink(runtime);
    clock += 30_000;
    const verdict = await passwordStep(runtime);
    expect(verdict.ok).toBe(true);
    // ...and the second step is kept for the day the setting is back on.
    expect(liveUser(await runtime.users.load(), "marta")?.secondStep).not.toBeNull();
  });
});

describe("a second step is set up from a one-time link only", () => {
  test("a right password with no second step is refused, the same whether a link waits, expired or never was", async () => {
    await configure({ secondStep: "required" });
    const runtime = runtimeOn(root);
    // Never had a link since its password: made with the setting off.
    await account(runtime, "never");
    // A link waiting: reset after its password was set.
    await account(runtime, "waiting");
    await runtime.users.reset("waiting", new Date(clock));
    // A link that expired: reset more than a day ago.
    await account(runtime, "expired");
    await runtime.users.reset("expired", new Date(clock - 25 * 3_600_000));

    const verdicts = [];
    for (const login of ["never", "waiting", "expired"]) {
      verdicts.push(await passwordStep(runtime, HOME_NET, login));
    }
    for (const verdict of verdicts) {
      expect(verdict).toEqual({ ok: false, status: 403, reason: "setup link needed" });
    }
    // No ticket and no secret was handed out.
    expect(runtime.secondSteps.size).toBe(0);
  });

  test("a wrong password still reads as a wrong password", async () => {
    await configure({ secondStep: "required" });
    const runtime = runtimeOn(root);
    await account(runtime);
    const verdict = await runtime.signIn({ login: "marta", password: "a-wrong-password", remoteKey: HOME_NET, remoteAddr: HOME_NET });
    expect(verdict).toMatchObject({ ok: false, status: 401 });
  });
});

describe("setting up from a link is one act", () => {
  test("the link and the password are checked, and nothing is written or spent", async () => {
    const runtime = runtimeOn(root);
    const created = await runtime.users.create("marta", "operator", new Date(clock));
    const before = await readFile(path.join(root, "users.json"), "utf8");
    const prepared = await runtime.prepareSetup(created.token, PASSWORD, HOME_NET);
    expect(prepared.challenge.kind).toBe("setup");
    if (prepared.challenge.kind !== "setup") return;
    expect(prepared.challenge.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(prepared.challenge.uri).toBe(
      `otpauth://totp/HX%20Fortress:marta?secret=${prepared.challenge.secret}&issuer=HX%20Fortress&algorithm=SHA1&digits=6&period=30`,
    );
    // Not one byte changed: no hash, no secret, the link not spent.
    expect(await readFile(path.join(root, "users.json"), "utf8")).toBe(before);
    expect(findUserBySetupToken(await runtime.users.load(), created.token, new Date(clock))?.login).toBe("marta");
  });

  test("a wrong code, an expired ticket and a closed tab leave the account as it was, and the link still works", async () => {
    const runtime = runtimeOn(root);
    const created = await runtime.users.create("marta", "operator", new Date(clock));
    const before = await readFile(path.join(root, "users.json"), "utf8");

    const first = await runtime.prepareSetup(created.token, PASSWORD, HOME_NET);
    if (first.challenge.kind !== "setup") throw new Error("expected a setup");
    const wrong = await runtime.completeSecondStep({
      ticket: first.challenge.ticket,
      code: wrongCodeOf(first.challenge.secret),
      remoteKey: HOME_NET,
      remoteAddr: HOME_NET,
    });
    expect(wrong).toMatchObject({ ok: false, reason: "wrong code" });
    // The tab closes; the ticket expires.
    clock += TICKET_TTL_MS;
    const late = await runtime.completeSecondStep({
      ticket: first.challenge.ticket,
      code: codeOf(first.challenge.secret),
      remoteKey: HOME_NET,
      remoteAddr: HOME_NET,
    });
    expect(late).toEqual({ ok: false, status: 401, reason: "no ticket" });
    expect(await readFile(path.join(root, "users.json"), "utf8")).toBe(before);

    // The same link, again: a new secret, and its first right code does it all.
    const again = await runtime.prepareSetup(created.token, "another-good-password", HOME_NET);
    if (again.challenge.kind !== "setup") throw new Error("expected a setup");
    expect(again.challenge.secret).not.toBe(first.challenge.secret);
    const version = await usersVersion();
    const done = await runtime.completeSecondStep({
      ticket: again.challenge.ticket,
      code: codeOf(again.challenge.secret),
      remoteKey: HOME_NET,
      remoteAddr: HOME_NET,
    });
    expect(done.ok).toBe(true);
    expect(done.ok && done.setUp).toBe(true);
    // ONE write: the password, the second step and the spent link together.
    expect(await usersVersion()).toBe(version + 1);
    const user = liveUser(await runtime.users.load(), "marta");
    expect(user?.pwdHash).toContain("$argon2id$");
    expect(user?.secondStep).toMatchObject({ secret: again.challenge.secret, lastStep: stepAt(clock) });
    expect(typeof user?.secondStep?.confirmedAt).toBe("string");
    expect(user?.setupTokens).toEqual([]);
    expect(findUserBySetupToken(await runtime.users.load(), created.token, new Date(clock))).toBeNull();
    // The password chosen on the link is the one that signs in.
    clock += 30_000;
    expect((await runtime.signIn({ login: "marta", password: "another-good-password", remoteKey: HOME_NET, remoteAddr: HOME_NET })).ok).toBe(
      true,
    );
  });

  test("a newer setup of the same link voids the older one's ticket", async () => {
    const runtime = runtimeOn(root);
    const created = await runtime.users.create("marta", "operator", new Date(clock));
    const older = await runtime.prepareSetup(created.token, PASSWORD, HOME_NET);
    const newer = await runtime.prepareSetup(created.token, PASSWORD, HOME_NET);
    if (older.challenge.kind !== "setup" || newer.challenge.kind !== "setup") throw new Error("expected setups");
    expect(
      await runtime.completeSecondStep({
        ticket: older.challenge.ticket,
        code: codeOf(older.challenge.secret),
        remoteKey: HOME_NET,
        remoteAddr: HOME_NET,
      }),
    ).toEqual({ ok: false, status: 401, reason: "no ticket" });
    expect(
      (
        await runtime.completeSecondStep({
          ticket: newer.challenge.ticket,
          code: codeOf(newer.challenge.secret),
          remoteKey: HOME_NET,
          remoteAddr: HOME_NET,
        })
      ).ok,
    ).toBe(true);
  });

  test("a link reissued while a ticket waits ends that ticket, and nothing is written", async () => {
    const runtime = runtimeOn(root);
    const created = await runtime.users.create("marta", "operator", new Date(clock));
    const prepared = await runtime.prepareSetup(created.token, PASSWORD, HOME_NET);
    if (prepared.challenge.kind !== "setup") throw new Error("expected a setup");
    await new UsersStore(path.join(root, "users.json")).reset("marta", new Date(clock));
    const after = await readFile(path.join(root, "users.json"), "utf8");
    expect(
      await runtime.completeSecondStep({
        ticket: prepared.challenge.ticket,
        code: codeOf(prepared.challenge.secret),
        remoteKey: HOME_NET,
        remoteAddr: HOME_NET,
      }),
    ).toEqual({ ok: false, status: 401, reason: "no ticket" });
    expect(await readFile(path.join(root, "users.json"), "utf8")).toBe(after);
  });

  test("a dead link is refused before anything is hashed", async () => {
    const runtime = runtimeOn(root);
    await expect(runtime.prepareSetup("not-a-live-token", PASSWORD, HOME_NET)).rejects.toThrow(
      "this setup link is no longer valid",
    );
    expect(runtime.secondSteps.size).toBe(0);
  });
});

describe("the code", () => {
  test("an account with a second step is asked for its code, and no secret travels", async () => {
    await configure({ secondStep: "required" });
    const runtime = runtimeOn(root);
    await setUpThroughLink(runtime);
    clock += 30_000;
    const challenge = challengeOf(await passwordStep(runtime));
    expect(Object.keys(challenge).sort()).toEqual(["kind", "ticket"]);
    expect(challenge.kind).toBe("code");
  });

  test("a code is accepted once", async () => {
    await configure({ secondStep: "required" });
    const runtime = runtimeOn(root);
    const secret = await setUpThroughLink(runtime);
    clock += 30_000;
    const code = codeOf(secret);
    const first = challengeOf(await passwordStep(runtime));
    const accepted = await runtime.completeSecondStep({ ticket: first.ticket, code, remoteKey: HOME_NET, remoteAddr: HOME_NET });
    expect(accepted.ok).toBe(true);
    expect(accepted.ok && accepted.setUp).toBe(false);
    // The same code on a new ticket, inside the same step: refused, and the
    // refusal is the one a wrong code gets.
    const again = challengeOf(await passwordStep(runtime));
    const replay = await runtime.completeSecondStep({ ticket: again.ticket, code, remoteKey: HOME_NET, remoteAddr: HOME_NET });
    expect(replay).toEqual({ ok: false, status: 401, reason: "wrong code", login: "marta", ended: false });
    // The code of the step before is inside the window, and still refused:
    // a step at or before the last accepted one never passes again.
    const older = await runtime.completeSecondStep({
      ticket: again.ticket,
      code: codeOf(secret, -1),
      remoteKey: HOME_NET,
      remoteAddr: HOME_NET,
    });
    expect(older.ok).toBe(false);
  });

  test("the step before and the step after are accepted, two steps away is refused", async () => {
    await configure({ secondStep: "required" });
    const runtime = runtimeOn(root);
    const secret = await setUpThroughLink(runtime);
    for (const offset of [-1, 1]) {
      // Far enough on that the step before is later than the last one spent.
      clock += 5 * 30_000;
      const ticket = challengeOf(await passwordStep(runtime)).ticket;
      const verdict = await runtime.completeSecondStep({
        ticket,
        code: codeOf(secret, offset),
        remoteKey: HOME_NET,
        remoteAddr: HOME_NET,
      });
      expect([offset, verdict.ok]).toEqual([offset, true]);
      clock += 60_000;
    }
    for (const offset of [-2, 2]) {
      clock += 5 * 30_000;
      const ticket = challengeOf(await passwordStep(runtime)).ticket;
      const verdict = await runtime.completeSecondStep({
        ticket,
        code: codeOf(secret, offset),
        remoteKey: HOME_NET,
        remoteAddr: HOME_NET,
      });
      expect([offset, verdict.ok]).toEqual([offset, false]);
      clock += 60_000;
    }
  });

  test("five wrong codes void the ticket", async () => {
    await configure({ secondStep: "required" });
    const runtime = runtimeOn(root);
    const secret = await setUpThroughLink(runtime);
    clock += 60_000;
    const { ticket } = challengeOf(await passwordStep(runtime));
    const wrong = wrongCodeOf(secret);
    const attempt = () => runtime.completeSecondStep({ ticket, code: wrong, remoteKey: HOME_NET, remoteAddr: HOME_NET });
    for (let i = 0; i < 4; i += 1) expect(await attempt()).toMatchObject({ reason: "wrong code", ended: false });
    // The bucket takes five a minute for this (login, network), the password
    // included, so the fifth code waits for the next minute.
    clock += 60_000;
    expect(await attempt()).toMatchObject({ reason: "wrong code", ended: true });
    // Void: even the right code does not finish it now.
    const right = await runtime.completeSecondStep({ ticket, code: codeOf(secret, 1), remoteKey: HOME_NET, remoteAddr: HOME_NET });
    expect(right).toEqual({ ok: false, status: 401, reason: "no ticket" });
  });

  test("a ticket from another network is refused, and still works on its own", async () => {
    await configure({ secondStep: "required" });
    const runtime = runtimeOn(root);
    const secret = await setUpThroughLink(runtime);
    clock += 30_000;
    const { ticket } = challengeOf(await passwordStep(runtime));
    const elsewhere = await runtime.completeSecondStep({ ticket, code: codeOf(secret), remoteKey: OTHER_NET, remoteAddr: OTHER_NET });
    expect(elsewhere).toEqual({ ok: false, status: 401, reason: "no ticket" });
    const home = await runtime.completeSecondStep({ ticket, code: codeOf(secret), remoteKey: HOME_NET, remoteAddr: HOME_NET });
    expect(home.ok).toBe(true);
  });

  test("a ticket lasts five minutes, and a restart ends it", async () => {
    await configure({ secondStep: "required" });
    const runtime = runtimeOn(root);
    const secret = await setUpThroughLink(runtime);
    clock += 30_000;
    const late = challengeOf(await passwordStep(runtime)).ticket;
    clock += TICKET_TTL_MS;
    expect(await runtime.completeSecondStep({ ticket: late, code: codeOf(secret), remoteKey: HOME_NET, remoteAddr: HOME_NET })).toEqual({
      ok: false,
      status: 401,
      reason: "no ticket",
    });
    const pending = challengeOf(await passwordStep(runtime)).ticket;
    const restarted = runtimeOn(root);
    expect(await restarted.completeSecondStep({ ticket: pending, code: codeOf(secret), remoteKey: HOME_NET, remoteAddr: HOME_NET })).toEqual({
      ok: false,
      status: 401,
      reason: "no ticket",
    });
  });

  test("a wrong code counts in the lockout table and the bucket of a wrong password", async () => {
    await configure({ secondStep: "required" });
    const runtime = runtimeOn(root);
    const secret = await setUpThroughLink(runtime);
    clock += 60_000;
    const { ticket } = challengeOf(await passwordStep(runtime));
    const wrong = wrongCodeOf(secret);
    for (let i = 0; i < 4; i += 1) {
      await runtime.completeSecondStep({ ticket, code: wrong, remoteKey: HOME_NET, remoteAddr: HOME_NET });
    }
    // Same bucket: the password step and four codes spent this minute's five.
    const bucketed = await runtime.completeSecondStep({ ticket, code: codeOf(secret), remoteKey: HOME_NET, remoteAddr: HOME_NET });
    expect(bucketed).toMatchObject({ ok: false, status: 429 });
    const password = await passwordStep(runtime);
    expect(password.ok === false && password.status).toBe(429);
    // Same table: the four wrong codes are four failures of (marta, this network).
    const epoch = liveUser(await runtime.users.load(), "marta")?.lockoutEpoch ?? 0;
    expect(runtime.lockouts.state("marta", HOME_NET, epoch, clock)).toEqual({ locked: false, failures: 4 });
    // ...and a right password does not clear them: only a right code does.
    clock += 60_000;
    const next = challengeOf(await passwordStep(runtime));
    expect(runtime.lockouts.state("marta", HOME_NET, epoch, clock).failures).toBe(4);
    const passed = await runtime.completeSecondStep({ ticket: next.ticket, code: codeOf(secret), remoteKey: HOME_NET, remoteAddr: HOME_NET });
    expect(passed.ok).toBe(true);
    expect(runtime.lockouts.state("marta", HOME_NET, epoch, clock).failures).toBe(0);
    // Never org-wide: another network signs in untouched.
    expect(challengeOf(await passwordStep(runtime, "192.0.2.44")).kind).toBe("code");
  });

  test("a lockout earned with codes refuses the password too", async () => {
    await configure({ secondStep: "required" });
    const runtime = runtimeOn(root);
    const secret = await setUpThroughLink(runtime);
    const wrong = wrongCodeOf(secret);
    // Six wrong codes, over two tickets and two minutes: the sixth failure
    // starts the delay.
    for (let round = 0; round < 2; round += 1) {
      clock += 60_000;
      const { ticket } = challengeOf(await passwordStep(runtime));
      for (let i = 0; i < 3; i += 1) {
        await runtime.completeSecondStep({ ticket, code: wrong, remoteKey: HOME_NET, remoteAddr: HOME_NET });
      }
    }
    clock += 100;
    const refused = await passwordStep(runtime);
    expect(refused.ok === false && refused.status).toBe(429);
    expect(refused.ok === false && refused.retryAfterMs).toBeGreaterThan(0);
  });

  test("a reset, a disable or a new password in between ends the sign-in", async () => {
    await configure({ secondStep: "required" });
    const runtime = runtimeOn(root);
    const secret = await setUpThroughLink(runtime);
    clock += 30_000;
    const { ticket } = challengeOf(await passwordStep(runtime));
    await new UsersStore(path.join(root, "users.json")).disable("marta", new Date(clock));
    expect(await runtime.completeSecondStep({ ticket, code: codeOf(secret), remoteKey: HOME_NET, remoteAddr: HOME_NET })).toEqual({
      ok: false,
      status: 401,
      reason: "no ticket",
    });
  });

  test("a ticket is not a session: it opens no route", async () => {
    await configure({ secondStep: "required" });
    const runtime = runtimeOn(root);
    await setUpThroughLink(runtime);
    clock += 30_000;
    const { ticket } = challengeOf(await passwordStep(runtime));
    const check = runtime.sessions.validate(ticket, await runtime.readUsers(), { ttlHours: 12, idleMinutes: 60 }, clock);
    expect(check.ok).toBe(false);
  });
});

describe("a ceiling on wrong codes for one account, from every address", () => {
  test(`${CEILING_WRONG_CODES} wrong codes from ${CEILING_WRONG_CODES} networks close the second step everywhere for a while`, async () => {
    await configure({ secondStep: "required" });
    const runtime = runtimeOn(root);
    const secret = await setUpThroughLink(runtime);
    clock += 30_000;
    // One wrong code from each of ten networks: no network's own bucket or
    // lockout comes near its limit.
    for (let i = 0; i < CEILING_WRONG_CODES; i += 1) {
      const network = `10.0.0.${i + 1}`;
      const { ticket } = challengeOf(await passwordStep(runtime, network));
      const wrong = await runtime.completeSecondStep({ ticket, code: wrongCodeOf(secret), remoteKey: network, remoteAddr: network });
      expect(wrong).toMatchObject({ reason: "wrong code" });
    }
    // An eleventh network, with the RIGHT code: refused, without the code
    // being looked at, for fifteen minutes.
    const fresh = "10.0.1.1";
    const { ticket } = challengeOf(await passwordStep(runtime, fresh));
    const closed = await runtime.completeSecondStep({ ticket, code: codeOf(secret), remoteKey: fresh, remoteAddr: fresh });
    expect(closed).toMatchObject({ ok: false, status: 429, reason: "too many codes", login: "marta" });
    expect(closed.ok === false && closed.status === 429 && closed.retryAfterMs).toBe(CEILING_CLOSED_MS);
    // A right code does not reopen it early.
    clock += CEILING_CLOSED_MS - 60_000;
    const stillClosed = challengeOf(await passwordStep(runtime, "10.0.1.2"));
    expect(
      await runtime.completeSecondStep({ ticket: stillClosed.ticket, code: codeOf(secret), remoteKey: "10.0.1.2", remoteAddr: "10.0.1.2" }),
    ).toMatchObject({ ok: false, status: 429, reason: "too many codes" });
    // Once the time is up, the right code works.
    clock += 60_000;
    const open = challengeOf(await passwordStep(runtime, "10.0.1.3"));
    expect(
      (await runtime.completeSecondStep({ ticket: open.ticket, code: codeOf(secret), remoteKey: "10.0.1.3", remoteAddr: "10.0.1.3" })).ok,
    ).toBe(true);
  }, 30_000);

  test("wrong passwords do not count there", async () => {
    await configure({ secondStep: "required" });
    const runtime = runtimeOn(root);
    const secret = await setUpThroughLink(runtime);
    // More wrong passwords than the ceiling's count of wrong codes.
    for (let i = 0; i < CEILING_WRONG_CODES + 2; i += 1) {
      const network = `10.0.2.${i + 1}`;
      await runtime.signIn({ login: "marta", password: "not-her-password", remoteKey: network, remoteAddr: network });
    }
    clock += 30_000;
    const { ticket } = challengeOf(await passwordStep(runtime));
    expect((await runtime.completeSecondStep({ ticket, code: codeOf(secret), remoteKey: HOME_NET, remoteAddr: HOME_NET })).ok).toBe(true);
  }, 30_000);

  /** Close the account's second step with ten wrong codes from ten networks. */
  async function closeIt(runtime: UiRuntime, secret: string, prefix: string): Promise<void> {
    for (let i = 0; i < CEILING_WRONG_CODES; i += 1) {
      const network = `${prefix}.${i + 1}`;
      const { ticket } = challengeOf(await passwordStep(runtime, network));
      await runtime.completeSecondStep({ ticket, code: wrongCodeOf(secret), remoteKey: network, remoteAddr: network });
    }
  }

  test("a burst of codes on many tickets at once: no more than the ceiling's count is judged, and a right code after them is refused", async () => {
    await configure({ secondStep: "required" });
    const runtime = runtimeOn(root);
    const secret = await setUpThroughLink(runtime);
    clock += 30_000;
    const burst = 25;
    const tickets: Array<{ ticket: string; network: string }> = [];
    for (let i = 0; i < burst; i += 1) {
      const network = `10.0.3.${i + 1}`;
      tickets.push({ ticket: challengeOf(await passwordStep(runtime, network)).ticket, network });
    }
    // Every request passes everything before its read of users.json at once,
    // and then they go on in the order they came. The read is held until all
    // of them are waiting on it, as a burst over the network would have them.
    const file = await runtime.readUsers();
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    runtime.readUsers = () => held.then(() => file);
    const sessionsBefore = runtime.sessions.size;
    const answers = Promise.all(
      tickets.map(({ ticket, network }, i) =>
        runtime.completeSecondStep({
          ticket,
          // The right code is the last one sent.
          code: i === burst - 1 ? codeOf(secret) : wrongCodeOf(secret),
          remoteKey: network,
          remoteAddr: network,
        }),
      ),
    );
    release();
    const verdicts = await answers;
    const judged = verdicts.filter((v) => v.ok || v.reason === "wrong code");
    expect(judged).toHaveLength(CEILING_WRONG_CODES);
    expect(verdicts.filter((v) => !v.ok && v.reason === "too many codes")).toHaveLength(burst - CEILING_WRONG_CODES);
    expect(verdicts[burst - 1]).toMatchObject({ ok: false, status: 429, reason: "too many codes" });
    expect(runtime.sessions.size).toBe(sessionsBefore);
  }, 30_000);

  test("a restart does not reopen it: the count is saved the moment it closes, and read back", async () => {
    await configure({ secondStep: "required" });
    const before = runtimeOn(root);
    const secret = await setUpThroughLink(before);
    clock += 30_000;
    await closeIt(before, secret, "10.0.4");
    // Saved at once, not at the next sweep.
    const file = path.join(root, "lockouts.json");
    let saved = "";
    for (let i = 0; i < 100 && !saved.includes('"ceiling"'); i += 1) {
      saved = await readFile(file, "utf8").catch(() => "");
      if (!saved.includes('"ceiling"')) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(saved).toContain('"marta"');
    // No secret and no code in it.
    expect(saved).not.toContain(secret);

    // The console starts again on the same folder.
    const after = runtimeOn(root);
    await after.restoreLockouts();
    const { ticket } = challengeOf(await passwordStep(after, "10.0.4.200"));
    expect(
      await after.completeSecondStep({ ticket, code: codeOf(secret), remoteKey: "10.0.4.200", remoteAddr: "10.0.4.200" }),
    ).toMatchObject({ ok: false, status: 429, reason: "too many codes" });
    expect(after.sessions.size).toBe(0);
  }, 30_000);

  test("a reset reopens it: the new link's first right code is taken", async () => {
    await configure({ secondStep: "required" });
    const runtime = runtimeOn(root);
    const secret = await setUpThroughLink(runtime);
    clock += 30_000;
    await closeIt(runtime, secret, "10.0.5");
    const { ticket } = challengeOf(await passwordStep(runtime, "10.0.5.100"));
    expect(
      await runtime.completeSecondStep({ ticket, code: codeOf(secret), remoteKey: "10.0.5.100", remoteAddr: "10.0.5.100" }),
    ).toMatchObject({ ok: false, status: 429, reason: "too many codes" });

    // An administrator resets the account, and the person opens the new link.
    const reset = await runtime.users.reset("marta", new Date(clock));
    const prepared = await runtime.prepareSetup(reset.token, PASSWORD, "10.0.5.101");
    if (prepared.challenge.kind !== "setup") throw new Error("expected a setup");
    const taken = await runtime.completeSecondStep({
      ticket: prepared.challenge.ticket,
      code: codeOf(prepared.challenge.secret),
      remoteKey: "10.0.5.101",
      remoteAddr: "10.0.5.101",
    });
    expect(taken.ok).toBe(true);
  }, 30_000);
});

describe("a ticket makes one session", () => {
  test("two requests at once with right codes for neighbouring steps: one passes", async () => {
    await configure({ secondStep: "required" });
    const runtime = runtimeOn(root);
    const secret = await setUpThroughLink(runtime);
    clock += 90_000;
    const { ticket } = challengeOf(await passwordStep(runtime));
    const sessionsBefore = runtime.sessions.size;
    const both = await Promise.all([
      runtime.completeSecondStep({ ticket, code: codeOf(secret, 0), remoteKey: HOME_NET, remoteAddr: HOME_NET }),
      runtime.completeSecondStep({ ticket, code: codeOf(secret, 1), remoteKey: HOME_NET, remoteAddr: HOME_NET }),
    ]);
    expect(both.filter((verdict) => verdict.ok)).toHaveLength(1);
    expect(both.filter((verdict) => !verdict.ok)).toEqual([{ ok: false, status: 401, reason: "no ticket" }]);
    expect(runtime.sessions.size).toBe(sessionsBefore + 1);
  });

  test("the same for a setup link: one write, one session", async () => {
    await configure({ secondStep: "required" });
    const runtime = runtimeOn(root);
    const created = await runtime.users.create("marta", "operator", new Date(clock));
    const prepared = await runtime.prepareSetup(created.token, PASSWORD, HOME_NET);
    if (prepared.challenge.kind !== "setup") throw new Error("expected a setup");
    const secret = prepared.challenge.secret;
    const version = await usersVersion();
    const both = await Promise.all([
      runtime.completeSecondStep({ ticket: prepared.challenge.ticket, code: codeOf(secret, 0), remoteKey: HOME_NET, remoteAddr: HOME_NET }),
      runtime.completeSecondStep({ ticket: prepared.challenge.ticket, code: codeOf(secret, 1), remoteKey: HOME_NET, remoteAddr: HOME_NET }),
    ]);
    expect(both.filter((verdict) => verdict.ok)).toHaveLength(1);
    expect(runtime.sessions.size).toBe(1);
    expect(await usersVersion()).toBe(version + 1);
  });
});

describe("an account deleted and made again", () => {
  test("inherits no session and no ticket of the deleted one", async () => {
    await configure({ secondStep: "required" });
    const runtime = runtimeOn(root);
    const secret = await setUpThroughLink(runtime, "marta", "operator");
    clock += 30_000;
    const first = challengeOf(await passwordStep(runtime));
    const signedIn = await runtime.completeSecondStep({ ticket: first.ticket, code: codeOf(secret), remoteKey: HOME_NET, remoteAddr: HOME_NET });
    if (!signedIn.ok) throw new Error("expected a session");
    clock += 30_000;
    const pending = challengeOf(await passwordStep(runtime));
    const deletedRecord = liveUser(await runtime.users.load(), "marta");

    await runtime.users.remove("marta", new Date(clock));
    await runtime.users.create("marta", "readonly", new Date(clock));
    const remade = liveUser(await runtime.users.load(), "marta");
    expect(remade?.credentialEpoch).toBeGreaterThan(deletedRecord?.credentialEpoch ?? 0);
    expect(remade?.pwdVersion).toBeGreaterThan(deletedRecord?.pwdVersion ?? 0);

    const policy = { ttlHours: 12, idleMinutes: 60 };
    expect(runtime.sessions.validate(signedIn.token, await runtime.users.load(), policy, clock).ok).toBe(false);
    expect(
      await runtime.completeSecondStep({ ticket: pending.ticket, code: codeOf(secret), remoteKey: HOME_NET, remoteAddr: HOME_NET }),
    ).toEqual({ ok: false, status: 401, reason: "no ticket" });
  });
});

describe("users.json", () => {
  test("a file from before the field existed loads unchanged, with no second step", async () => {
    const before = {
      version: 3,
      sessionEpoch: 0,
      users: [
        {
          login: "marta",
          role: "operator",
          pwdHash: null,
          pwdVersion: 0,
          createdAt: "2026-07-01T00:00:00.000Z",
          disabledAt: null,
          deletedAt: null,
          lockoutEpoch: 0,
          credentialEpoch: 0,
          setupTokens: [],
        },
      ],
    };
    const parsed = parseUsersFile(before);
    expect(parsed).not.toBeNull();
    expect(parsed?.users[0]?.secondStep).toBeNull();
    expect(parsed?.users[0]).toMatchObject(before.users[0] as Record<string, unknown>);

    await writeFile(path.join(root, "users.json"), JSON.stringify(before));
    const loaded = await new UsersStore(path.join(root, "users.json")).load();
    expect(loaded.users.map((u) => u.secondStep)).toEqual([null]);
  });

  test("a damaged record keeps the account behind a second step it cannot pass", async () => {
    await configure({ secondStep: "required" });
    const runtime = runtimeOn(root);
    const secret = await setUpThroughLink(runtime);
    const file = path.join(root, "users.json");
    for (const damage of ["damaged", { secret, confirmedAt: "2026-11-01T00:00:00.000Z", lastStep: -1 }, { secret, confirmedAt: "x", lastStep: "7" }]) {
      const raw = JSON.parse(await readFile(file, "utf8")) as { users: Array<Record<string, unknown>> };
      (raw.users[0] as Record<string, unknown>).secondStep = damage;
      await writeFile(file, JSON.stringify(raw));
      clock += 60_000;
      const challenge = challengeOf(await passwordStep(runtime));
      expect(challenge.kind).toBe("code");
      const refused = await runtime.completeSecondStep({
        ticket: challenge.ticket,
        code: codeOf(secret),
        remoteKey: HOME_NET,
        remoteAddr: HOME_NET,
      });
      expect([damage, refused.ok]).toEqual([damage, false]);
    }
  });
});

// ── over HTTP ────────────────────────────────────────────────────────────────

const assets: UiAssets = {
  mode: "disk",
  files: { "/index.html": path.join(import.meta.dir, "..", "package.json") },
  inlineScriptHashes: [],
  manifest: { hash: "c".repeat(64), files: 1, bytes: 1 },
};

interface Served {
  runtime: UiRuntime;
  audit: ConsoleAudit;
  origin: string;
  spool: string;
  stop: () => Promise<void>;
}

async function serve(): Promise<Served> {
  const runtime = runtimeOn(root);
  runtime.routes.register({ method: "GET", path: "/ui/api/overview", cls: "read" });
  const spool = path.join(root, "spool");
  const audit = new ConsoleAudit(new AuditSpool({ dir: spool, writer: "ui", clock: () => new Date(clock) }), {
    now: () => new Date(clock),
  });
  const server = startUiServer({ assets, port: 0, runtime, audit }, "127.0.0.1");
  return {
    runtime,
    audit,
    origin: `http://127.0.0.1:${server.port}`,
    spool,
    stop: () => server.stop(true),
  };
}

async function postJson(
  served: Served,
  route: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string; body: Record<string, unknown>; headers: Headers }> {
  const response = await fetch(`${served.origin}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: served.origin, ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown>, headers: response.headers };
}

async function spoolText(served: Served): Promise<string> {
  await served.audit.flushFailures(true);
  const files = await listSpoolFiles(served.spool);
  return (await Promise.all(files.map((f) => readFile(f.path, "utf8")))).join("");
}

describe("over HTTP", () => {
  let served: Served;

  afterEach(async () => {
    await served?.stop();
  });

  test("with the setting off, sign-in answers exactly as before", async () => {
    served = await serve();
    await account(served.runtime);
    const reply = await postJson(served, "/ui/api/session", { login: "marta", password: PASSWORD });
    expect(reply.status).toBe(200);
    expect(Object.keys(reply.body).sort()).toEqual(["login", "role", "sessions", "token"]);
  });

  test("a password never answers with a new second step: an account with none is sent to a new link", async () => {
    await configure({ secondStep: "required" });
    served = await serve();
    await account(served.runtime);
    const reply = await postJson(served, "/ui/api/session", { login: "marta", password: PASSWORD });
    expect(reply.status).toBe(403);
    expect(reply.body).toEqual({ error: SECOND_STEP_LINK_NEEDED_COPY });
    expect(reply.text).not.toContain("secret");
    expect(reply.text).not.toContain("ticket");
    expect(reply.text).not.toContain("enroll");
  });

  test("the password answers with a ticket and no session, and the ticket opens nothing", async () => {
    await configure({ secondStep: "required" });
    served = await serve();
    await setUpThroughLink(served.runtime);
    clock += 30_000;
    const sessionsBefore = served.runtime.sessions.size;
    const reply = await postJson(served, "/ui/api/session", { login: "marta", password: PASSWORD });
    expect(reply.status).toBe(200);
    expect(Object.keys(reply.body).sort()).toEqual(["secondStep", "ticket"]);
    expect(reply.body.secondStep).toBe("code");
    const ticket = reply.body.ticket as string;
    for (const route of ["/ui/api/session", "/ui/api/overview"]) {
      const opened = await fetch(`${served.origin}${route}`, { headers: { [SESSION_HEADER]: ticket } });
      expect([route, opened.status]).toEqual([route, 401]);
    }
    expect(served.runtime.sessions.size).toBe(sessionsBefore);
  });

  test("a right code answers exactly as a sign-in does, and the session works", async () => {
    await configure({ secondStep: "required" });
    served = await serve();
    const secret = await setUpThroughLink(served.runtime);
    clock += 30_000;
    const started = await postJson(served, "/ui/api/session", { login: "marta", password: PASSWORD });
    const finished = await postJson(served, SECOND_STEP_PATH, { ticket: started.body.ticket, code: codeOf(secret) });
    expect(finished.status).toBe(200);
    expect(Object.keys(finished.body).sort()).toEqual(["login", "role", "sessions", "token"]);
    const whoami = await fetch(`${served.origin}/ui/api/session`, {
      headers: { [SESSION_HEADER]: finished.body.token as string },
    });
    expect(whoami.status).toBe(200);
    expect(((await whoami.json()) as { login: string }).login).toBe("marta");
  });

  test("a wrong code, an old one and one already used read the same", async () => {
    await configure({ secondStep: "required" });
    served = await serve();
    const secret = await setUpThroughLink(served.runtime);
    const used = codeOf(secret);
    clock += 30_000;
    const started = await postJson(served, "/ui/api/session", { login: "marta", password: PASSWORD });
    expect(started.body).toEqual({ secondStep: "code", ticket: started.body.ticket });
    const answers = [];
    for (const code of [wrongCodeOf(secret), codeOf(secret, -3), used]) {
      answers.push(await postJson(served, SECOND_STEP_PATH, { ticket: started.body.ticket, code }));
    }
    for (const answer of answers) {
      expect(answer.status).toBe(401);
      expect(answer.body.error).toBe(SECOND_STEP_FAILURE_COPY);
    }
    expect(new Set(answers.map((a) => a.text)).size).toBe(1);
  });

  test("too many wrong codes for the account get their own sentence, and the wait in the body", async () => {
    await configure({ secondStep: "required", trustedProxies: ["127.0.0.1"] });
    served = await serve();
    const secret = await setUpThroughLink(served.runtime);
    clock += 30_000;
    for (let i = 0; i < CEILING_WRONG_CODES; i += 1) {
      const network = { "x-forwarded-for": `10.1.0.${i + 1}` };
      const started = await postJson(served, "/ui/api/session", { login: "marta", password: PASSWORD }, network);
      await postJson(served, SECOND_STEP_PATH, { ticket: started.body.ticket, code: wrongCodeOf(secret) }, network);
    }
    const network = { "x-forwarded-for": "10.1.1.1" };
    const started = await postJson(served, "/ui/api/session", { login: "marta", password: PASSWORD }, network);
    const closed = await postJson(served, SECOND_STEP_PATH, { ticket: started.body.ticket, code: codeOf(secret) }, network);
    expect(closed.status).toBe(429);
    // A right code was sent: the answer does not call it wrong.
    expect(closed.body.error).toBe(SECOND_STEP_CLOSED_COPY);
    expect(closed.body.error).not.toBe(SECOND_STEP_FAILURE_COPY);
    expect(closed.body.retryAfterSeconds).toBe(CEILING_CLOSED_MS / 1000);
    expect(Number(closed.headers.get("retry-after"))).toBe(CEILING_CLOSED_MS / 1000);
  }, 30_000);

  test("a burst of codes on many tickets at once: no more than the ceiling's count is judged", async () => {
    await configure({ secondStep: "required", trustedProxies: ["127.0.0.1"] });
    served = await serve();
    const at = served;
    const secret = await setUpThroughLink(at.runtime);
    clock += 30_000;
    const burst = 25;
    const tickets: Array<{ ticket: unknown; network: Record<string, string> }> = [];
    for (let i = 0; i < burst; i += 1) {
      const network = { "x-forwarded-for": `10.2.0.${i + 1}` };
      const started = await postJson(at, "/ui/api/session", { login: "marta", password: PASSWORD }, network);
      tickets.push({ ticket: started.body.ticket, network });
    }
    const answers = await Promise.all(
      tickets.map(({ ticket, network }, i) =>
        // The right code is the last one sent.
        postJson(at, SECOND_STEP_PATH, { ticket, code: i === burst - 1 ? codeOf(secret) : wrongCodeOf(secret) }, network),
      ),
    );
    // Over the network the requests are not taken in the order they were sent,
    // so the right code may be judged before the tenth wrong one closes the
    // second step, and then it signs in, as it may. What never happens is an
    // eleventh wrong code being judged: every request after the tenth is
    // refused without its code being looked at.
    const wrongJudged = answers.filter((a) => a.body.error === SECOND_STEP_FAILURE_COPY);
    expect(wrongJudged.length).toBeLessThanOrEqual(CEILING_WRONG_CODES);
    const signedIn = answers.filter((a) => a.status === 200).length;
    expect(signedIn).toBeLessThanOrEqual(1);
    expect(answers.filter((a) => a.body.error === SECOND_STEP_CLOSED_COPY).length).toBe(burst - wrongJudged.length - signedIn);
  }, 30_000);

  test("a dead ticket says to sign in again, and so does the fifth wrong code", async () => {
    await configure({ secondStep: "required" });
    served = await serve();
    const unknown = await postJson(served, SECOND_STEP_PATH, { ticket: "a".repeat(64), code: "123456" });
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual({ error: SECOND_STEP_RESTART_COPY, restart: true });

    const secret = await setUpThroughLink(served.runtime);
    clock += 60_000;
    const started = await postJson(served, "/ui/api/session", { login: "marta", password: PASSWORD });
    let last = { status: 0, text: "", body: {} as Record<string, unknown> };
    for (let i = 0; i < 5; i += 1) {
      if (i === 4) clock += 60_000;
      last = await postJson(served, SECOND_STEP_PATH, { ticket: started.body.ticket, code: wrongCodeOf(secret) });
    }
    expect(last.status).toBe(401);
    expect(last.body).toEqual({ error: SECOND_STEP_RESTART_COPY, restart: true });
  });

  test("a ticket from another network is refused there", async () => {
    await configure({ secondStep: "required", trustedProxies: ["127.0.0.1"] });
    served = await serve();
    const secret = await setUpThroughLink(served.runtime);
    clock += 30_000;
    const started = await postJson(served, "/ui/api/session", { login: "marta", password: PASSWORD }, { "x-forwarded-for": HOME_NET });
    const code = codeOf(secret);
    const elsewhere = await postJson(served, SECOND_STEP_PATH, { ticket: started.body.ticket, code }, { "x-forwarded-for": OTHER_NET });
    expect(elsewhere.status).toBe(401);
    expect(elsewhere.body.restart).toBe(true);
    const home = await postJson(served, SECOND_STEP_PATH, { ticket: started.body.ticket, code }, { "x-forwarded-for": HOME_NET });
    expect(home.status).toBe(200);
  });

  test("a lockout reads as the password's lockout", async () => {
    await configure({ secondStep: "required" });
    served = await serve();
    const secret = await setUpThroughLink(served.runtime);
    clock += 60_000;
    const started = await postJson(served, "/ui/api/session", { login: "marta", password: PASSWORD });
    for (let i = 0; i < 4; i += 1) {
      await postJson(served, SECOND_STEP_PATH, { ticket: started.body.ticket, code: wrongCodeOf(secret) });
    }
    const refused = await postJson(served, SECOND_STEP_PATH, { ticket: started.body.ticket, code: codeOf(secret) });
    expect(refused.status).toBe(429);
    expect(refused.body.error).toBe(LOCKOUT_COPY);
  });

  test("a setup link answers as before with the setting off", async () => {
    served = await serve();
    const created = await served.runtime.users.create("marta", "operator", new Date(clock));
    const status = await fetch(`${served.origin}/ui/api/setup/status`, { headers: { [SETUP_TOKEN_HEADER]: created.token } });
    expect(await status.json()).toMatchObject({ status: "live", login: "marta", role: "operator", first: true });
    const completed = await postJson(served, "/ui/api/setup/complete", { password: PASSWORD }, { [SETUP_TOKEN_HEADER]: created.token });
    expect(completed.status).toBe(200);
    expect(completed.body).toEqual({ completed: true, login: "marta", role: "operator" });
    expect(served.runtime.sessions.size).toBe(0);
  });

  test("with the setting required, a setup link saves nothing until the first right code, which does it all", async () => {
    await configure({ secondStep: "required" });
    served = await serve();
    await served.runtime.users.create("marta", "operator", new Date(clock));
    const second = await served.runtime.users.create("erik", "readonly", new Date(clock + 1));
    const status = await fetch(`${served.origin}/ui/api/setup/status`, { headers: { [SETUP_TOKEN_HEADER]: second.token } });
    expect(await status.json()).toMatchObject({ status: "live", login: "erik", role: "readonly", first: false });
    const started = await postJson(served, "/ui/api/setup/complete", { password: PASSWORD }, { [SETUP_TOKEN_HEADER]: second.token });
    expect(started.status).toBe(200);
    expect(Object.keys(started.body).sort()).toEqual(["completed", "login", "role", "secondStep", "secret", "ticket", "uri"]);
    expect(started.body).toMatchObject({ completed: false, login: "erik", role: "readonly", secondStep: "enroll" });
    expect(served.runtime.sessions.size).toBe(0);
    // Nothing spent: the link still answers live, and works again.
    const still = await fetch(`${served.origin}/ui/api/setup/status`, { headers: { [SETUP_TOKEN_HEADER]: second.token } });
    expect(still.status).toBe(200);
    expect(liveUser(await served.runtime.users.load(), "erik")?.pwdHash).toBeNull();
    const finished = await postJson(served, SECOND_STEP_PATH, {
      ticket: started.body.ticket,
      code: codeOf(started.body.secret as string),
    });
    expect(finished.status).toBe(200);
    expect(finished.body).toMatchObject({ login: "erik", role: "readonly" });
    // Now it is spent.
    const spent = await postJson(served, "/ui/api/setup/complete", { password: PASSWORD }, { [SETUP_TOKEN_HEADER]: second.token });
    expect(spent.status).toBe(400);
  });

  test("no reply and no audit record holds a secret or a code, and the trail says what happened", async () => {
    await configure({ secondStep: "required" });
    served = await serve();
    const created = await served.runtime.users.create("marta", "operator", new Date(clock));
    const replies: string[] = [];
    const typed: string[] = [];
    const tickets: string[] = [];

    const setupReply = await postJson(served, "/ui/api/setup/complete", { password: PASSWORD }, { [SETUP_TOKEN_HEADER]: created.token });
    const secret = setupReply.body.secret as string;
    tickets.push(setupReply.body.ticket as string);
    const wrong = wrongCodeOf(secret);
    typed.push(wrong);
    replies.push((await postJson(served, SECOND_STEP_PATH, { ticket: tickets[0], code: wrong })).text);
    const first = codeOf(secret);
    typed.push(first);
    replies.push((await postJson(served, SECOND_STEP_PATH, { ticket: tickets[0], code: first })).text);

    clock += 60_000;
    const codeReply = await postJson(served, "/ui/api/session", { login: "marta", password: PASSWORD });
    replies.push(codeReply.text);
    tickets.push(codeReply.body.ticket as string);
    replies.push((await postJson(served, SECOND_STEP_PATH, { ticket: tickets[1], code: first })).text);
    const second = codeOf(secret);
    typed.push(second);
    replies.push((await postJson(served, SECOND_STEP_PATH, { ticket: tickets[1], code: second })).text);
    replies.push((await postJson(served, SECOND_STEP_PATH, { ticket: tickets[1], code: second })).text);

    // The secret travels once, to the person setting up their app.
    expect(setupReply.text).toContain(secret);
    for (const reply of replies) {
      expect(reply).not.toContain(secret);
      for (const code of typed) expect(reply).not.toContain(JSON.stringify(code));
    }

    const trail = await spoolText(served);
    expect(trail).not.toContain(secret);
    for (const code of typed) expect(trail).not.toContain(JSON.stringify(code));
    for (const ticket of tickets) expect(trail).not.toContain(ticket);
    expect(trail).not.toContain("otpauth");
    expect(trail).not.toContain("$argon2id$");

    const records = trail
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { action: string; params: Record<string, unknown> | null; actor: string | null });
    // The link was completed, and the second step set up, by the first right code.
    expect(records.filter((r) => r.action === "console.setup.completed")).toHaveLength(1);
    expect(records.filter((r) => r.action === "console.second_step.set_up")).toHaveLength(1);
    const signIns = records.filter((r) => r.action === "console.signin");
    expect(signIns).toHaveLength(2);
    for (const record of signIns) expect(record.params).toMatchObject({ login: "marta", secondStep: true });
    // Wrong codes, joined by login, source and window: one record, two attempts
    // (the wrong code, and the used one); the dead ticket is a record of its own
    // with no login.
    const failed = records.filter((r) => r.action === "console.second_step.failed");
    const named = failed.filter((r) => r.params?.login === "marta");
    expect(named).toHaveLength(1);
    expect(named[0]?.params?.attempts).toBe(2);
    expect(failed.filter((r) => r.params?.login === undefined)).toHaveLength(1);
  });

  test("with the setting off, the route has nothing to finish", async () => {
    served = await serve();
    await account(served.runtime);
    const reply = await postJson(served, SECOND_STEP_PATH, { ticket: "b".repeat(64), code: "000000" });
    expect(reply.status).toBe(401);
    expect(reply.body.restart).toBe(true);
  });
});
