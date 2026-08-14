import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ArgonBusyError, ArgonGate } from "../src/ui/argon-gate";
import {
  LOCKOUT_FREE_ATTEMPTS,
  LockoutTable,
  RateLimiter,
} from "../src/ui/rate-limit";
import { UiRuntime } from "../src/ui/runtime";
import { SESSION_HEADER, SessionTable } from "../src/ui/sessions";
import { StoreCorruptError } from "../src/ui/store-lock";
import {
  ARGON2ID_MEMORY_COST,
  ARGON2ID_TIME_COST,
  MIN_PASSWORD_LENGTH,
  UsersStore,
  checkLogin,
  findUserBySetupToken,
  liveUser,
  setupTokenDigest,
  setupUrl,
  signInEligible,
} from "../src/ui/users";

const PASSWORD = "correct-horse-battery";
const POLICY = { ttlHours: 12, idleMinutes: 60 };

let root: string;
let usersFile: string;
let store: UsersStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hx-ui-users-"));
  usersFile = path.join(root, "users.json");
  store = new UsersStore(usersFile);
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
  });
}

describe("the user lifecycle", () => {
  test("create prints a setup link and stores only its digest", async () => {
    const created = await store.create("ada", "operator");
    const raw = await readFile(usersFile, "utf8");
    expect(raw).not.toContain(created.token);
    expect(raw).toContain(setupTokenDigest(created.token));
    const user = liveUser(await store.load(), "ada");
    expect(user?.pwdHash).toBeNull();
    expect(signInEligible(await store.load(), "ada")).toBeNull();
  });

  test("the token rides the URL fragment, so it is never in a request line", () => {
    const url = setupUrl("https://console.example.com", "tok3n");
    expect(url).toBe("https://console.example.com/setup#t=tok3n");
    expect(new URL(url).pathname).toBe("/setup");
    expect(new URL(url).search).toBe("");
  });

  test("completion sets the password, burns the token and enables sign-in", async () => {
    const created = await store.create("ada", "operator");
    await store.completeSetup(created.token, PASSWORD);
    expect(signInEligible(await store.load(), "ada")).not.toBeNull();
    await expect(store.completeSetup(created.token, PASSWORD)).rejects.toThrow(
      /no longer valid/,
    );
  });

  test("the password policy is enforced at completion", async () => {
    const created = await store.create("ada", "operator");
    await expect(store.completeSetup(created.token, "short")).rejects.toThrow(
      new RegExp(`at least ${MIN_PASSWORD_LENGTH}`),
    );
  });

  test("the hash is argon2id at the pinned parameters", async () => {
    const created = await store.create("ada", "operator");
    const user = await store.completeSetup(created.token, PASSWORD);
    expect(user.pwdHash).toContain("$argon2id$");
    expect(user.pwdHash).toContain(`m=${ARGON2ID_MEMORY_COST},t=${ARGON2ID_TIME_COST},p=1`);
  });

  test("creating a second link kills the first", async () => {
    const first = await store.create("ada", "operator");
    const second = await store.reset("ada");
    const file = await store.load();
    expect(findUserBySetupToken(file, first.token, new Date())).toBeNull();
    expect(findUserBySetupToken(file, second.token, new Date())?.login).toBe("ada");
  });

  test("disable, delete and reset all invalidate outstanding links", async () => {
    for (const verb of ["disable", "remove"] as const) {
      const login = `user-${verb}`;
      const created = await store.create(login, "readonly");
      await store[verb](login);
      expect(findUserBySetupToken(await store.load(), created.token, new Date())).toBeNull();
    }
  });

  test("an expired link is dead even though its digest is still on file", async () => {
    const created = await store.create("ada", "operator", new Date(Date.now() - 25 * 3_600_000));
    expect(findUserBySetupToken(await store.load(), created.token, new Date())).toBeNull();
  });

  test("reset leaves the OLD password working until the new link completes", async () => {
    const created = await store.create("ada", "operator");
    await store.completeSetup(created.token, PASSWORD);
    const reset = await store.reset("ada");
    const stillWorking = liveUser(await store.load(), "ada");
    expect(stillWorking?.pwdHash).not.toBeNull();

    await store.completeSetup(reset.token, "a-brand-new-secret");
    const after = liveUser(await store.load(), "ada");
    expect(after?.pwdVersion).toBe(2);
  });

  test("delete is soft, so revalidation keeps refusing the login", async () => {
    await store.create("ada", "operator");
    await store.remove("ada");
    const file = await store.load();
    expect(file.users.find((u) => u.login === "ada")?.deletedAt).not.toBeNull();
    expect(liveUser(file, "ada")).toBeNull();
  });

  test("logins are validated before they reach a store", () => {
    expect(checkLogin("ada")).toBeNull();
    expect(checkLogin("a")).toContain("invalid login");
    expect(checkLogin("../etc/passwd")).toContain("invalid login");
    expect(checkLogin("Ada")).toContain("invalid login");
  });

  test("the store is 0600 and a corrupt one is refused, never rebuilt", async () => {
    await store.create("ada", "operator");
    expect((await stat(usersFile)).mode & 0o777).toBe(0o600);
    await writeFile(usersFile, '{"users": [{"login": 4}]}');
    await expect(store.create("bob", "operator")).rejects.toBeInstanceOf(StoreCorruptError);
    expect(await readFile(usersFile, "utf8")).toContain('"login": 4');
  });
});

describe("sign-in hardening", () => {
  test("an unknown login, a disabled one and a wrong password are indistinguishable", async () => {
    const runtime = runtimeOn(root);
    const created = await runtime.users.create("ada", "operator");
    await runtime.users.completeSetup(created.token, PASSWORD);
    await runtime.users.create("eve", "operator");
    await runtime.users.disable("eve");

    const answers = await Promise.all([
      runtime.signIn({ login: "nobody", password: PASSWORD, remoteKey: "a", remoteAddr: "a" }),
      runtime.signIn({ login: "eve", password: PASSWORD, remoteKey: "b", remoteAddr: "b" }),
      runtime.signIn({ login: "ada", password: "wrong-password-here", remoteKey: "c", remoteAddr: "c" }),
    ]);
    for (const answer of answers) {
      expect(answer.ok).toBe(false);
      expect(answer.ok === false && answer.status).toBe(401);
      expect(answer.ok === false && answer.reason).toBe("sign-in failed");
    }
  });

  test("a correct password issues a session with the user's role", async () => {
    const runtime = runtimeOn(root);
    const created = await runtime.users.create("ada", "readonly");
    await runtime.users.completeSetup(created.token, PASSWORD);
    const result = await runtime.signIn({
      login: "ada",
      password: PASSWORD,
      remoteKey: "k",
      remoteAddr: "127.0.0.1",
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.session.role).toBe("readonly");
    expect(result.ok && result.token.length).toBeGreaterThan(30);
  });

  test("sign-in works with no Postgres and no daemon — the store is the only dependency", async () => {
    const runtime = runtimeOn(root);
    const created = await runtime.users.create("ada", "operator");
    await runtime.users.completeSetup(created.token, PASSWORD);
    const result = await runtime.signIn({
      login: "ada",
      password: PASSWORD,
      remoteKey: "k",
      remoteAddr: "127.0.0.1",
    });
    expect(result.ok).toBe(true);
  });

  test("the per-(user, remote) bucket refuses the sixth attempt in a minute", async () => {
    const runtime = runtimeOn(root);
    const created = await runtime.users.create("ada", "operator");
    await runtime.users.completeSetup(created.token, PASSWORD);
    let last = await runtime.signIn({ login: "ada", password: "nope-nope-nope", remoteKey: "k", remoteAddr: "k" });
    for (let i = 0; i < 5; i += 1) {
      last = await runtime.signIn({ login: "ada", password: "nope-nope-nope", remoteKey: "k", remoteAddr: "k" });
    }
    expect(last.ok).toBe(false);
    expect(last.ok === false && last.status).toBe(429);
    // ...and another source is untouched: a lockout is never org-wide.
    const elsewhere = await runtime.signIn({
      login: "ada",
      password: PASSWORD,
      remoteKey: "other",
      remoteAddr: "other",
    });
    expect(elsewhere.ok).toBe(true);
  });
});

describe("lockout", () => {
  test("grows a delay after the free attempts and never becomes permanent", () => {
    const table = new LockoutTable();
    for (let i = 0; i < LOCKOUT_FREE_ATTEMPTS; i += 1) {
      expect(table.recordFailure("ada", "k", 0, 1_000).locked).toBe(false);
    }
    let capped = table.recordFailure("ada", "k", 0, 1_000);
    expect(capped.locked).toBe(true);
    for (let i = 0; i < 30; i += 1) capped = table.recordFailure("ada", "k", 0, 1_000);
    expect(capped.locked && capped.retryAfterMs).toBeLessThanOrEqual(15 * 60_000);
  });

  test("a lockout is per (user, remote) — another user from the same address is free", () => {
    const table = new LockoutTable();
    for (let i = 0; i < 20; i += 1) table.recordFailure("ada", "k", 0, 1_000);
    expect(table.state("ada", "k", 0, 1_000).locked).toBe(true);
    expect(table.state("bob", "k", 0, 1_000).locked).toBe(false);
    expect(table.state("ada", "other", 0, 1_000).locked).toBe(false);
  });

  test("bumping lockoutEpoch clears a lock held in memory — the CLI's channel", () => {
    const table = new LockoutTable();
    for (let i = 0; i < 20; i += 1) table.recordFailure("ada", "k", 0, 1_000);
    expect(table.state("ada", "k", 0, 1_000).locked).toBe(true);
    expect(table.state("ada", "k", 1, 1_000).locked).toBe(false);
  });

  test("a snapshot survives a restart without carrying a secret", () => {
    const table = new LockoutTable();
    table.recordFailure("ada", "k", 0, Date.now());
    const snapshot = table.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain("hash");
    const restored = new LockoutTable();
    restored.hydrate(snapshot);
    expect(restored.size).toBe(1);
  });

  test("the rate limiter meters per bucket and sweeps expired windows", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 5; i += 1) expect(limiter.take("signIn", "k", 1_000).ok).toBe(true);
    expect(limiter.take("signIn", "k", 1_000).ok).toBe(false);
    expect(limiter.take("ssoEntry", "k", 1_000).ok).toBe(true);
    expect(limiter.sweep(1_000 + 120_000)).toBeGreaterThan(0);
    expect(limiter.size).toBe(0);
  });
});

describe("the argon gate", () => {
  test("bounds concurrency, which is what bounds memory", async () => {
    const gate = new ArgonGate({ maxConcurrent: 3, reserved: 1, waitMs: 5_000 });
    let peak = 0;
    let live = 0;
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        gate.run(`k${i}`, true, async () => {
          live += 1;
          peak = Math.max(peak, live);
          await Bun.sleep(2);
          live -= 1;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(3);
  });

  test("caps a single source at one hash in flight", async () => {
    const gate = new ArgonGate({ maxConcurrent: 4, reserved: 1, waitMs: 5_000 });
    let peak = 0;
    let live = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        gate.run("one-source", false, async () => {
          live += 1;
          peak = Math.max(peak, live);
          await Bun.sleep(1);
          live -= 1;
        }),
      ),
    );
    expect(peak).toBe(1);
  });

  test("a success and a reset both clear the failure memory the argon slot reads", async () => {
    // Two ways the memory has to end, and neither worked: it survived a
    // successful sign-in for the full half hour, and `ui user reset` — the
    // remedy the console's own copy names — runs in the CLI process and can only
    // bump `lockoutEpoch` in users.json, which nothing here consulted.
    const table = new LockoutTable();
    table.recordFailure("ada", "proxy", 0);
    expect(table.isCleanPrincipal("ada", "proxy")).toBe(false);
    table.recordSuccess("ada", "proxy");
    expect(table.isCleanPrincipal("ada", "proxy")).toBe(true);

    table.recordFailure("ada", "proxy", 0);
    expect(table.isCleanPrincipal("ada", "proxy")).toBe(false);
    // A reset bumps the epoch; the memory recorded under the old one is spent.
    expect(table.isCleanPrincipal("ada", "proxy", Date.now(), 1)).toBe(true);
  });

  test("a SHARED remote key does not make everybody dirty — the proxy deployment", async () => {
    // The console ships for a `publicUrl` behind a reverse proxy, and the
    // default `trustedProxies: []` makes every caller present the same peer
    // address. Anything keyed on that address alone speaks for the whole
    // organization, so one stranger's failure must not change what an operator
    // who has failed at nothing is entitled to.
    const runtime = runtimeOn(root);
    const created = await runtime.users.create("ada", "operator");
    await runtime.users.completeSetup(created.token, PASSWORD);

    const attacker = await runtime.signIn({
      login: "eve",
      password: "wrong-password-here",
      remoteKey: "proxy",
      remoteAddr: "proxy",
    });
    expect(attacker.ok).toBe(false);
    // The shared address is dirty…
    expect(runtime.lockouts.isClean("proxy")).toBe(false);
    // …and the operator, whose own login has failed at nothing, is not.
    expect(runtime.lockouts.isCleanPrincipal("ada", "proxy")).toBe(true);
    const genuine = await runtime.signIn({
      login: "ada",
      password: PASSWORD,
      remoteKey: "proxy",
      remoteAddr: "proxy",
    });
    expect(genuine.ok).toBe(true);
  });

  test("a rotating-login flood is shed by the argon gate, not by a counter", async () => {
    // The process-wide ceiling is gone: it could only refuse everybody, which is
    // an org-wide lockout. What bounds the work is the gate — bounded
    // concurrency, one in-flight hash per remote key, and a bounded queue that
    // sheds as a fast 503 rather than a denial.
    const gate = new ArgonGate({ maxConcurrent: 1, reserved: 0, queueLimit: 1, waitMs: 20 });
    const release: Array<() => void> = [];
    const held = gate.run("a", false, () => new Promise<void>((r) => release.push(r)));
    await Bun.sleep(5);
    const queued = gate.run("b", false, async () => undefined);
    await expect(gate.run("c", false, async () => undefined)).rejects.toThrow(ArgonBusyError);
    for (const r of release) r();
    await held;
    await queued;
  });

  test("the per-principal bucket is what refuses, and only the principal who spent it", async () => {
    const runtime = runtimeOn(root);
    const created = await runtime.users.create("ada", "operator");
    await runtime.users.completeSetup(created.token, PASSWORD);
    // Six attempts from one (login, remote) exhausts that pair's five.
    let last = await runtime.signIn({ login: "ada", password: "nope-nope-nope", remoteKey: "proxy", remoteAddr: "proxy" });
    for (let i = 0; i < 5; i += 1) {
      last = await runtime.signIn({ login: "ada", password: "nope-nope-nope", remoteKey: "proxy", remoteAddr: "proxy" });
    }
    expect(last.ok === false && last.status).toBe(429);
    // …and a COLLEAGUE on the same shared address is untouched.
    const raj = await runtime.users.create("raj", "operator");
    await runtime.users.completeSetup(raj.token, PASSWORD);
    const colleague = await runtime.signIn({
      login: "raj",
      password: PASSWORD,
      remoteKey: "proxy",
      remoteAddr: "proxy",
    });
    expect(colleague.ok).toBe(true);
  });

  test("a principal with no recent failures still gets in during a flood", async () => {
    const gate = new ArgonGate({ maxConcurrent: 2, reserved: 1, waitMs: 2_000 });
    const release: Array<() => void> = [];
    const flood = gate.run("attacker", false, () => new Promise<void>((r) => release.push(r)));
    await Bun.sleep(5);
    // The one general slot is taken; only the reserved slot is left, and only a
    // clean principal may have it.
    let admitted = false;
    const genuine = gate.run("operator", true, async () => {
      admitted = true;
    });
    await genuine;
    expect(admitted).toBe(true);
    for (const r of release) r();
    await flood;
  });

  test("sheds rather than queueing without bound", async () => {
    const gate = new ArgonGate({ maxConcurrent: 1, reserved: 0, queueLimit: 1, waitMs: 50 });
    const release: Array<() => void> = [];
    const held = gate.run("a", true, () => new Promise<void>((r) => release.push(r)));
    await Bun.sleep(5);
    const queued = gate.run("b", true, async () => {});
    await expect(gate.run("c", true, async () => {})).rejects.toBeInstanceOf(ArgonBusyError);
    await expect(queued).rejects.toBeInstanceOf(ArgonBusyError);
    for (const r of release) r();
    await held;
  });
});

describe("sessions", () => {
  async function signedIn(): Promise<{ runtime: UiRuntime; token: string }> {
    const runtime = runtimeOn(root);
    const created = await runtime.users.create("ada", "operator");
    await runtime.users.completeSetup(created.token, PASSWORD);
    const result = await runtime.signIn({
      login: "ada",
      password: PASSWORD,
      remoteKey: "k",
      remoteAddr: "127.0.0.1",
    });
    if (!result.ok) throw new Error("sign-in failed");
    return { runtime, token: result.token };
  }

  test("validate re-reads the user record on EVERY request", async () => {
    const { runtime, token } = await signedIn();
    expect((await validate(runtime, token)).ok).toBe(true);
    await runtime.users.disable("ada");
    const after = await validate(runtime, token);
    expect(after.ok).toBe(false);
    expect(after.ok === false && after.reason).toBe("user-disabled");
  });

  test("deleting the user ends the session", async () => {
    const { runtime, token } = await signedIn();
    await runtime.users.remove("ada");
    expect((await validate(runtime, token)).ok).toBe(false);
  });

  test("a password change ends the session", async () => {
    const { runtime, token } = await signedIn();
    const reset = await runtime.users.reset("ada");
    await runtime.users.completeSetup(reset.token, "a-brand-new-secret");
    expect((await validate(runtime, token)).ok).toBe(false);
  });

  test("the GLOBAL session epoch kills sessions written by ANOTHER process", async () => {
    const { runtime, token } = await signedIn();
    expect((await validate(runtime, token)).ok).toBe(true);
    // A second store object standing in for the CLI process.
    await new UsersStore(usersFile).bumpSessionEpoch();
    const after = await validate(runtime, token);
    expect(after.ok).toBe(false);
    expect(after.ok === false && after.reason).toBe("revoked");
  });

  test("the absolute and idle budgets both expire a session", async () => {
    const table = new SessionTable();
    const file = await store.load();
    const created = await store.create("ada", "operator");
    const user = await store.completeSetup(created.token, PASSWORD);
    const issued = table.issue({ user, file, remoteAddr: "k", now: 0 });
    expect(table.validate(issued.token, await store.load(), POLICY, 1_000).ok).toBe(true);
    expect(table.validate(issued.token, await store.load(), POLICY, 13 * 3_600_000).ok).toBe(false);

    const second = table.issue({ user, file, remoteAddr: "k", now: 0 });
    expect(table.validate(second.token, await store.load(), POLICY, 61 * 60_000).ok).toBe(false);
  });

  test("the transport is the header, and the table holds digests rather than tokens", async () => {
    expect(SESSION_HEADER).toBe("x-fortress-ui-token");
    const { runtime, token } = await signedIn();
    expect(JSON.stringify(runtime.sessions.list())).not.toContain(token);
  });

  test("revocation by id and by user", async () => {
    const { runtime, token } = await signedIn();
    const [session] = runtime.sessions.list();
    expect(runtime.sessions.revoke(session?.id ?? "")).toBe(true);
    expect((await validate(runtime, token)).ok).toBe(false);
    expect(runtime.sessions.revokeUser("ada")).toBe(0);
  });
});

async function validate(
  runtime: UiRuntime,
  token: string,
): Promise<ReturnType<SessionTable["validate"]>> {
  return runtime.sessions.validate(token, await runtime.readUsers(), POLICY);
}

describe("recovery", () => {
  test("locked in memory, reset from the CLI, then setup and sign-in succeed", async () => {
    const runtime = runtimeOn(root);
    const created = await runtime.users.create("ada", "operator");
    await runtime.users.completeSetup(created.token, PASSWORD);
    for (let i = 0; i < 20; i += 1) {
      runtime.lockouts.recordFailure("ada", "k", 0);
    }
    expect(runtime.lockouts.state("ada", "k", 0).locked).toBe(true);

    // The CLI process, writing under the lock.
    const reset = await new UsersStore(usersFile).reset("ada");
    const epoch = liveUser(await runtime.readUsers(), "ada")?.lockoutEpoch ?? 0;
    expect(runtime.lockouts.state("ada", "k", epoch).locked).toBe(false);

    await runtime.users.completeSetup(reset.token, "a-brand-new-secret");
    const result = await runtime.signIn({
      login: "ada",
      password: "a-brand-new-secret",
      remoteKey: "k",
      remoteAddr: "k",
    });
    expect(result.ok).toBe(true);
  });

  test("a revocation write completes promptly while sign-ins are saturating the gate", async () => {
    const runtime = runtimeOn(root);
    const created = await runtime.users.create("ada", "operator");
    await runtime.users.completeSetup(created.token, PASSWORD);
    const flood = Array.from({ length: 24 }, (_, i) =>
      runtime
        .signIn({ login: `unknown${i}`, password: "whatever-goes-here", remoteKey: `s${i}`, remoteAddr: `s${i}` })
        .catch(() => undefined),
    );
    const started = Date.now();
    await runtime.users.disable("ada");
    expect(Date.now() - started).toBeLessThan(1_000);
    await Promise.all(flood);
  });
});
