// The terminal's side of the second step: the setting, what `ui user list`
// says about each account, what `ui user reset` removes and records, the
// account an install makes from a setup-token digest it minted elsewhere, and
// the viewer kind of account.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CliAudit } from "../src/cli-audit";
import { runUiVerb } from "../src/cli-ui-verbs";
import { readSpool } from "../src/console/audit-spool";
import { fortressPaths } from "../src/host/paths";
import { LiveUiConfig, parseUiConfig, printableUiConfig, UiConfigStore } from "../src/ui/config";
import { machineBootId, processStartToken } from "../src/ui/instance";
import type { UiServiceControl } from "../src/ui/service-control";
import { newSecret } from "../src/ui/totp";
import {
  findUserBySetupToken,
  hashPassword,
  liveUser,
  SETUP_TOKEN_TTL_MS,
  setupTokenDigest,
  UsersStore,
} from "../src/ui/users";

const PASSWORD = "correct-horse-battery";

let root: string;

const noUnit: UiServiceControl = {
  name: "fake",
  installed: async () => false,
  install: async () => {},
  start: async () => {},
  uninstall: async () => {},
  stopAndDisable: async () => {},
};

async function ui(
  args: readonly string[],
  over: { audit?: CliAudit } = {},
): Promise<{ code: number; out: string; error: string | null }> {
  const lines: string[] = [];
  let error: string | null = null;
  let code: number;
  try {
    code = await runUiVerb(args, {
      writeLine: (line) => lines.push(line),
      env: {},
      fortressRoot: root,
      platform: "linux",
      hostName: "fortress-1",
      service: noUnit,
      ...over,
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    code = 1;
  }
  return { code, out: lines.join("\n"), error };
}

const configFile = (): string => fortressPaths(root).uiConfig;
const usersFile = (): string => path.join(fortressPaths(root).uiRoot, "users.json");
const usersStore = (): UsersStore => new UsersStore(usersFile());

/** An account with a password, and a second step when `withSecondStep`, made
 *  through its setup link the way the console makes one. */
async function account(login: string, withSecondStep: boolean): Promise<string | null> {
  const store = usersStore();
  const created = await store.create(login, "operator");
  if (!withSecondStep) {
    await store.completeSetup(created.token, PASSWORD);
    return null;
  }
  const secret = newSecret();
  const written = await store.completeSetupWithSecondStep(login, {
    setupDigest: setupTokenDigest(created.token),
    credentialEpoch: 0,
    pwdVersion: 0,
    pwdHash: await hashPassword(PASSWORD),
    secret,
    step: 1,
    now: new Date(),
  });
  expect(written).not.toBe("stale");
  return secret;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hx-second-step-cli-"));
  await mkdir(fortressPaths(root).uiRoot, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the secondStep setting", () => {
  test("absent reads as off; null is not absent, and reads as required", () => {
    expect(parseUiConfig({})?.secondStep).toBe("off");
    const cleared = parseUiConfig({ secondStep: null });
    expect(cleared?.secondStep).toBe("required");
    expect(printableUiConfig(cleared!).find(([key]) => key === "secondStep")?.[1]).toContain("the file says null");
  });

  test("ui config set takes required and off, and says what each means", async () => {
    const on = await ui(["config", "set", "secondStep", "required"]);
    expect(on.code).toBe(0);
    expect(on.out).toContain("ui.json secondStep set to required.");
    expect(on.out).toContain("6-digit code from an authenticator app");
    expect(on.out).toContain("set up from a one-time link only");
    expect((await new UiConfigStore(configFile()).load()).secondStep).toBe("required");

    const off = await ui(["config", "set", "secondStep", "off"]);
    expect(off.code).toBe(0);
    expect(off.out).toContain("asks for the password alone");
    expect((await new UiConfigStore(configFile()).load()).secondStep).toBe("off");
  });

  test("turning it on names the accounts that need a new link", async () => {
    await account("ada", true);
    await account("bob", false);
    await account("carl", false);
    const on = await ui(["config", "set", "secondStep", "required"]);
    expect(on.out).toContain("Accounts with no second step yet, each needing a new link: bob, carl.");
  });

  test("anything else is refused in plain words, and nothing is written", async () => {
    await ui(["config", "set", "secondStep", "required"]);
    for (const value of ["on", "true", "Required", "", "of"]) {
      const refused = await ui(["config", "set", "secondStep", value]);
      expect(refused.code).toBe(1);
      expect(refused.error).toBe(`secondStep must be required or off (got ${value})`);
    }
    expect((await new UiConfigStore(configFile()).load()).secondStep).toBe("required");
  });

  test("ui config shows it", async () => {
    expect((await ui(["config"])).out).toContain("secondStep: off (the password alone)");
    await ui(["config", "set", "secondStep", "required"]);
    expect((await ui(["config"])).out).toContain(
      "secondStep: required (a code from an authenticator app after the password)",
    );
  });

  test("a value that is neither word is never read as off: it reads as required, and says so", async () => {
    for (const value of ["requird", "of", "Off", true, false, 0, 1, " off", { off: true }, null]) {
      const parsed = parseUiConfig({ secondStep: value });
      expect([value, parsed?.secondStep]).toEqual([value, "required"]);
    }
    await writeFile(configFile(), JSON.stringify({ enabled: true, secondStep: "requird" }));
    const shown = (await ui(["config"])).out;
    expect(shown).toContain('secondStep: required (the file says "requird", which is neither required nor off');
    expect(shown).toContain("hx-fortress ui config set secondStep required|off");

    // The console says it once for each version of the file, not per request.
    const warnings: string[] = [];
    const live = new LiveUiConfig(configFile(), (message) => warnings.push(message));
    expect((await live.read()).secondStep).toBe("required");
    expect((await live.read()).secondStep).toBe("required");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('secondStep is "requird", which is neither "required" nor "off"');
    // The note is not part of the config: a write does not carry it into ui.json.
    await ui(["config", "set", "port", "9100"]);
    const written = JSON.parse(await readFile(configFile(), "utf8")) as Record<string, unknown>;
    expect(written.secondStep).toBe("required");
    expect(Object.keys(written).some((key) => key.toLowerCase().includes("misread"))).toBe(false);
  });
});

describe("ui user list", () => {
  beforeEach(async () => {
    await ui(["enable"]);
  });

  test("says for each account whether it has a second step, and never what it is", async () => {
    const secret = await account("ada", true);
    await account("bob", false);
    const listed = await ui(["user", "list"]);
    expect(listed.code).toBe(0);
    const line = (login: string): string => listed.out.split("\n").find((l) => l.includes(` ${login} `)) ?? "";
    expect(line("ada")).toContain("second step set up");
    expect(line("bob")).toContain("no second step");
    expect(listed.out).not.toContain(secret as string);
  });

  test("a record that can never accept a code is named, so it can be reset", async () => {
    const secret = await account("ada", true);
    for (const damaged of [
      { secret: 7 },
      { secret, confirmedAt: "2026-11-01T00:00:00.000Z", lastStep: -1 },
      { secret, confirmedAt: "2026-11-01T00:00:00.000Z", lastStep: "12" },
      { secret, confirmedAt: "2026-11-01T00:00:00.000Z", lastStep: 1.5 },
      { secret, confirmedAt: "2026-11-01T00:00:00.000Z", lastStep: 2 ** 60 },
    ]) {
      const raw = JSON.parse(await readFile(usersFile(), "utf8")) as { users: Array<Record<string, unknown>> };
      (raw.users[0] as Record<string, unknown>).secondStep = damaged;
      await writeFile(usersFile(), JSON.stringify(raw));
      const listed = (await ui(["user", "list"])).out;
      expect([damaged, listed.includes("second step unreadable: reset the account")]).toEqual([damaged, true]);
    }
  });
});

describe("ui user reset", () => {
  beforeEach(async () => {
    await ui(["enable"]);
  });

  test("removes the second step, says so, and writes a record of its own", async () => {
    const secret = await account("ada", true);
    const reset = await ui(["user", "reset", "ada"]);
    expect(reset.code).toBe(0);
    expect(reset.out).toContain("Its second step is removed.");
    expect(reset.out).toContain("keeps working until this link is completed");
    expect(liveUser(await usersStore().load(), "ada")?.secondStep).toBeNull();

    const records = await readSpool(fortressPaths(root).auditSpool);
    const removed = records.filter((r) => r.action === "cli.ui.second_step_removed");
    expect(removed).toHaveLength(1);
    expect(removed[0]?.params).toEqual({ login: "ada" });
    expect(JSON.stringify(records)).not.toContain(secret as string);
  });

  test("an account with none: no removal, and no record of one", async () => {
    await account("bob", false);
    const reset = await ui(["user", "reset", "bob"]);
    expect(reset.code).toBe(0);
    expect(reset.out).not.toContain("second step is removed");
    const records = await readSpool(fortressPaths(root).auditSpool);
    expect(records.some((r) => r.action === "cli.ui.second_step_removed")).toBe(false);
  });

  test("with the second step required, it says the account waits for the link", async () => {
    await account("ada", true);
    await ui(["config", "set", "secondStep", "required"]);
    const reset = await ui(["user", "reset", "ada"]);
    expect(reset.out).toContain(
      "Until this link is used the account cannot sign in: the link sets a new password and a new second step.",
    );
    expect(reset.out).not.toContain("keeps working until this link is completed");
  });

  test("the link is printed even when the record of the removal cannot be written", async () => {
    await account("ada", true);
    class FailingEvent extends CliAudit {
      override async event(): Promise<void> {
        throw new Error("the spool is full");
      }
    }
    const audit = new FailingEvent({ dir: fortressPaths(root).auditSpool });
    const reset = await ui(["user", "reset", "ada"], { audit });
    expect(reset.code).toBe(0);
    expect(reset.out).toContain("could not be written - the spool is full");
    const link = reset.out.split("\n").find((l) => l.includes("/setup#t="));
    expect(link).toBeDefined();
    // The printed link is the one that works.
    const token = (link as string).split("#t=")[1] as string;
    expect(findUserBySetupToken(await usersStore().load(), token, new Date())?.login).toBe("ada");
  });

  test("a settings file that cannot be read stops it before anything changes", async () => {
    const secret = await account("ada", true);
    // A live console on this root, so the serving check reads no settings.
    await writeFile(
      path.join(fortressPaths(root).uiRoot, "instance.lock"),
      JSON.stringify({ pid: process.pid, bootId: machineBootId(), ...processStartToken(process.pid), port: 8788 }),
    );
    await writeFile(configFile(), "{ this is not json");
    const before = await readFile(usersFile(), "utf8");
    const reset = await ui(["user", "reset", "ada"]);
    expect(reset.code).toBe(1);
    // Nothing changed: the second step and the account are as they were.
    expect(await readFile(usersFile(), "utf8")).toBe(before);
    expect(liveUser(await usersStore().load(), "ada")?.secondStep?.secret).toBe(secret as string);
  });
});

describe("a Viewer's account", () => {
  beforeEach(async () => {
    await ui(["enable"]);
  });

  test("is made like the others, with a link, and the terminal says it opens nothing in the console", async () => {
    const made = await ui(["user", "create", "vera", "--role", "viewer"]);
    expect(made.code).toBe(0);
    expect(made.out).toContain("Created vera (viewer).");
    expect(made.out).toContain("Viewers open nothing in this console.");
    // It promises no page this build does not have.
    expect(made.out).toContain("this build serves none yet");
    expect(made.out).toContain("/setup#t=");
    expect(liveUser(await usersStore().load(), "vera")?.role).toBe("viewer");
    expect((await ui(["user", "list"])).out).toMatch(/vera\s+viewer\s+awaiting setup/);
    expect((await ui(["user", "create", "x1", "--role", "admin"])).error).toBe(
      "--role is required and must be operator, readonly or viewer",
    );
  });
});

describe("an account made from a setup-token digest", () => {
  const token = "a-token-the-install-minted-on-its-own-computer";
  const inAnHour = (now: Date): Date => new Date(now.getTime() + 3_600_000);

  test("is made exactly as create makes one, with the digest as its one setup token and the given end", async () => {
    const now = new Date();
    const store = usersStore();
    const returned = await store.createWithSetupDigest("ada", "operator", setupTokenDigest(token), inAnHour(now), now);
    expect(returned).toBeUndefined();
    const file = await store.load();
    expect(file.users).toHaveLength(1);
    expect(file.users[0]).toMatchObject({
      login: "ada",
      role: "operator",
      pwdHash: null,
      pwdVersion: 0,
      disabledAt: null,
      deletedAt: null,
      lockoutEpoch: 0,
      credentialEpoch: 0,
      secondStep: null,
      setupTokens: [
        {
          digest: setupTokenDigest(token),
          createdAt: now.toISOString(),
          expiresAt: inAnHour(now).toISOString(),
        },
      ],
    });
    // The link the install holds is the one that works here, once.
    expect(findUserBySetupToken(file, token, now)?.login).toBe("ada");
    await store.completeSetup(token, PASSWORD, now);
    await expect(store.completeSetup(token, PASSWORD, now)).rejects.toThrow(/no longer valid/);
  });

  test("reads upper-case hex, and keeps it in lower case", async () => {
    const store = usersStore();
    const now = new Date();
    await store.createWithSetupDigest("ada", "readonly", setupTokenDigest(token).toUpperCase(), inAnHour(now), now);
    expect((await store.load()).users[0]?.setupTokens[0]?.digest).toBe(setupTokenDigest(token));
  });

  test("its link ends when it was told to", async () => {
    const store = usersStore();
    const now = new Date();
    await store.createWithSetupDigest("ada", "operator", setupTokenDigest(token), inAnHour(now), now);
    expect(findUserBySetupToken(await store.load(), token, new Date(now.getTime() + 3_600_000 - 1))?.login).toBe("ada");
    expect(findUserBySetupToken(await store.load(), token, new Date(now.getTime() + 3_600_000))).toBeNull();
  });

  test("refuses an end that has passed or is more than a day ahead", async () => {
    const store = usersStore();
    const now = new Date();
    for (const end of [new Date(now.getTime() - 1), now, new Date(now.getTime() + SETUP_TOKEN_TTL_MS + 1), new Date(Number.NaN)]) {
      await expect(store.createWithSetupDigest("ada", "operator", setupTokenDigest(token), end, now)).rejects.toThrow("the link's end time");
    }
    expect((await store.load()).users).toEqual([]);
    await store.createWithSetupDigest("ada", "operator", setupTokenDigest(token), new Date(now.getTime() + SETUP_TOKEN_TTL_MS), now);
    expect((await store.load()).users).toHaveLength(1);
  });

  test("refuses a digest of another shape, without repeating it, and makes nothing", async () => {
    const store = usersStore();
    const now = new Date();
    for (const digest of ["", "abc", "g".repeat(64), "a".repeat(63), "a".repeat(65), token]) {
      const attempt = store.createWithSetupDigest("ada", "operator", digest, inAnHour(now), now);
      await expect(attempt).rejects.toThrow("64 hexadecimal characters");
      await attempt.catch((error: Error) => {
        if (digest.length > 3) expect(error.message).not.toContain(digest);
      });
    }
    expect((await store.load()).users).toEqual([]);
  });

  test("refuses an account that already exists", async () => {
    const store = usersStore();
    const first = await store.create("ada", "operator");
    await expect(store.createWithSetupDigest("ada", "operator", setupTokenDigest(token), inAnHour(new Date()))).rejects.toThrow(
      "user 'ada' already exists",
    );
    const file = await store.load();
    expect(file.users).toHaveLength(1);
    expect(findUserBySetupToken(file, first.token, new Date())?.login).toBe("ada");
    expect(findUserBySetupToken(file, token, new Date())).toBeNull();
  });

  test("an account deleted and made again from a digest starts past the deleted one's counters", async () => {
    const store = usersStore();
    await store.create("ada", "operator");
    await store.remove("ada");
    const deleted = (await store.load()).users[0];
    const now = new Date();
    await store.createWithSetupDigest("ada", "operator", setupTokenDigest(token), inAnHour(now), now);
    const made = liveUser(await store.load(), "ada");
    expect(made?.credentialEpoch).toBe((deleted?.credentialEpoch ?? 0) + 1);
    expect(made?.pwdVersion).toBe((deleted?.pwdVersion ?? 0) + 1);
  });
});
