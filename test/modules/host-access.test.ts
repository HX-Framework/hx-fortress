// The `access.groups` ask of the `host` module: who holds each role on this
// HX Fortress, as counts, and what of it may cross to the control plane. And
// provider-people.json, the console's note of who signed in through the
// identity provider, which the count reads.
//
// Most cases build the answer from readers handed in, with no files. The cases
// about sign-ins note them in a real provider-people.json first, the way the
// console does. The cases about files use the daemon's own readers
// (`fileSources`) over a root of the case's own.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AskFailure, failureForLog, type ModuleContextV2 } from "../../src/host/module-contract";
import type { Organization } from "../../src/host/organization-id";
import { fortressPaths } from "../../src/host/paths";
import { conform } from "../../src/host/shape";
import {
  accessView,
  fileSources,
  groupClaim,
  groupMayCross,
  type AccessSources,
  type AccessView,
} from "../../src/modules/host/access";
import type { AuditTrail } from "../../src/modules/host/audit-trail";
import { ACCESS_MAX_ROWS, HOST_MANIFEST } from "../../src/modules/host/manifest";
import { createHostModule } from "../../src/modules/host/module";
import { MAX_GROUPS, OIDC_CONFIG_DEFAULTS, OidcConfigStore, type UiOidcConfig } from "../../src/ui/oidc-config";
import {
  groupKey,
  issuerKey,
  PEOPLE_DAYS,
  PeopleUnreadable,
  personKey,
  PROVIDER_PEOPLE_FILE,
  ProviderPeopleStore,
  type PeopleRead,
  type PersonSeen,
} from "../../src/ui/provider-people";
import { EMPTY_USERS_FILE, UsersStore, type UiRole, type UiUser, type UsersFile } from "../../src/ui/users";

const NOW = new Date("2027-03-14T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);
const SINCE = daysAgo(200).toISOString();

const ISSUER = "https://login.northstar.example";
const ADMINISTRATORS = "northstar-administrators";
const OPERATORS = "northstar-operators";
const AUDITORS = "northstar-auditors";
const VIEWERS = "northstar-viewers";
/** A group whose name is not a `name`: the brackets are not in the alphabet. */
const DATA_TEAM = "Data Team (EU)";

const REPLY = HOST_MANIFEST.asks.find((ask) => ask.name === "access.groups")!.reply;

/** Sign-in through the identity provider switched on, with all four lists set. */
function providerConfig(over: Partial<UiOidcConfig> = {}): UiOidcConfig {
  return {
    ...OIDC_CONFIG_DEFAULTS,
    enabled: true,
    issuer: ISSUER,
    clientId: "hx-fortress-console",
    administratorGroups: [ADMINISTRATORS],
    operatorGroups: [OPERATORS],
    readonlyGroups: [AUDITORS],
    viewerGroups: [VIEWERS, DATA_TEAM],
    ...over,
  };
}

function account(login: string, role: UiRole, over: Partial<UiUser> = {}): UiUser {
  return {
    login,
    role,
    pwdHash: null,
    pwdVersion: 0,
    createdAt: daysAgo(30).toISOString(),
    disabledAt: null,
    deletedAt: null,
    lockoutEpoch: 0,
    credentialEpoch: 0,
    setupTokens: [],
    secondStep: null,
    ...over,
  };
}

/** Two operators (one disabled), one auditor, and three viewers (one deleted). */
const ACCOUNTS: UsersFile = {
  ...EMPTY_USERS_FILE,
  users: [
    account("marta.lindqvist@northstar.example", "operator"),
    account("erik", "operator", { disabledAt: daysAgo(3).toISOString() }),
    account("audit-bot", "readonly"),
    account("lena.hart@northstar.example", "viewer"),
    account("vera", "viewer"),
    account("left-in-may", "viewer", { deletedAt: daysAgo(5).toISOString() }),
  ],
};

/** A reader the case must not call. A call fails the ask, and so the case. */
const notRead = async (): Promise<never> => {
  throw new Error("this file is not one this case reads");
};

function sources(over: Partial<AccessSources>): AccessSources {
  return {
    oidc: async () => ({ ...OIDC_CONFIG_DEFAULTS }),
    accounts: notRead,
    people: notRead,
    now: () => NOW,
    ...over,
  };
}

/** One person's last sign-in, as the file holds it: digests only. */
const seen = (days: number, groups: string[], issuer = ISSUER): PersonSeen => ({
  at: daysAgo(days).toISOString(),
  issuer: issuerKey(issuer),
  groups: groups.map(groupKey),
});
const held = (...people: PersonSeen[]): PeopleRead => ({ people, since: SINCE });

/** The provider in use, counted from people handed in, with the accounts. */
const counted = (people: PersonSeen[], over: Partial<UiOidcConfig> = {}): Promise<AccessView> =>
  accessView(
    sources({ oidc: async () => providerConfig(over), people: async () => held(...people), accounts: async () => ACCOUNTS }),
  );

/** A row's field names, for the cases where a field must be absent. */
const fields = (view: AccessView): string[][] => view.roles.map((row) => Object.keys(row).sort());

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "hx-access-"));
});
afterEach(async () => {
  await chmod(path.join(dir, PROVIDER_PEOPLE_FILE), 0o600).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

/** The people's sign-ins, noted one by one at their own times, as the console
 *  notes them, then written. Oldest first, as they happened. */
async function noteSignIns(...signIns: Array<[subject: string, days: number, groups: string[]]>): Promise<ProviderPeopleStore> {
  const clock = { now: NOW };
  const store = new ProviderPeopleStore(path.join(dir, PROVIDER_PEOPLE_FILE), { now: () => clock.now });
  for (const [subject, days, groups] of signIns) {
    clock.now = daysAgo(days);
    await store.note({ issuer: ISSUER, subject, groups });
  }
  // Written at the time of the last sign-in, as the console's next write would.
  await store.flush();
  clock.now = NOW;
  return store;
}

/** The answer with the provider in use, counted from a store's file. */
const fromSignIns = (store: ProviderPeopleStore, over: Partial<UiOidcConfig> = {}): Promise<AccessView> =>
  accessView(
    sources({ oidc: async () => providerConfig(over), people: () => store.recent(NOW), accounts: async () => ACCOUNTS }),
  );

/** A row as `[role, group or "(hidden)" or "(none)", people]`. */
const brief = (view: AccessView): Array<[string, string, number]> =>
  view.roles.map((row) => [row.role, row.group ?? (row.groupHidden ? "(hidden)" : "(none)"), row.people]);

describe("counted from the accounts, with no identity provider in use", () => {
  test("two operators (one disabled), one auditor and three viewers (one deleted) are 1, 1 and 2, with no group", async () => {
    const view = await accessView(sources({ accounts: async () => ACCOUNTS }));
    const rows: AccessView["roles"] = [
      { role: "operator", seesRows: true, people: 1 },
      { role: "readonly", seesRows: false, people: 1 },
      { role: "viewer", seesRows: true, people: 2 },
    ];
    expect(view).toEqual({ roles: rows, holders: rows, countedFrom: "accounts" });
    expect(fields(view)).toEqual([
      ["people", "role", "seesRows"],
      ["people", "role", "seesRows"],
      ["people", "role", "seesRows"],
    ]);
  });

  test("settings for a provider that are switched off, or on and incomplete, still count the accounts", async () => {
    for (const config of [providerConfig({ enabled: false }), providerConfig({ clientId: null })]) {
      const view = await accessView(sources({ oidc: async () => config, accounts: async () => ACCOUNTS }));
      expect(view.countedFrom).toBe("accounts");
      expect(view.roles.map((row) => row.people)).toEqual([1, 1, 2]);
    }
  });
});

describe("counted from the sign-ins, with the identity provider in use", () => {
  test("a person counts under the first list one of their groups is in, so a row's seesRows is true of everyone it counts", async () => {
    const view = await counted([
      // An administrator who is also in the operators' group: an administrator.
      seen(10, [ADMINISTRATORS, OPERATORS]),
      // An auditor who is also in the viewers' group: an auditor, who sees no rows.
      seen(3, [AUDITORS, VIEWERS]),
      seen(2, [VIEWERS]),
    ]);
    expect(brief(view)).toEqual([
      ["administrator", ADMINISTRATORS, 1],
      ["operator", OPERATORS, 0],
      ["readonly", AUDITORS, 1],
      ["viewer", VIEWERS, 1],
      ["viewer", "(hidden)", 0],
    ]);
    expect(view.roles.find((row) => row.role === "readonly")?.seesRows).toBe(false);
  });

  test("a person in two groups of one role counts in both of its rows, and once in holders", async () => {
    const view = await counted([seen(1, [VIEWERS, DATA_TEAM]), seen(2, [VIEWERS]), seen(4, [OPERATORS])]);
    expect(brief(view).slice(3)).toEqual([
      ["viewer", VIEWERS, 2],
      ["viewer", "(hidden)", 1],
    ]);
    expect(view.holders).toEqual([
      { role: "administrator", seesRows: true, people: 0 },
      { role: "operator", seesRows: true, people: 1 },
      { role: "readonly", seesRows: false, people: 0 },
      { role: "viewer", seesRows: true, people: 2 },
    ]);
    // Who can see rows, each person once.
    const seeRows = view.holders.filter((holder) => holder.seesRows).reduce((sum, holder) => sum + holder.people, 0);
    expect(seeRows).toBe(3);
  });

  test("a person seen more than 90 days ago does not count, as noted or as handed in", async () => {
    const store = await noteSignIns(["sub-olga", 100, [OPERATORS]]);
    expect((await fromSignIns(store)).roles[1]).toEqual({ role: "operator", group: OPERATORS, seesRows: true, people: 0 });
    const view = await counted([seen(100, [OPERATORS]), seen(PEOPLE_DAYS - 1, [OPERATORS])]);
    expect(view.roles[1]?.people).toBe(1);
  });

  test("a person whose last sign-in no longer carried a group does not count for it, even if an older one did", async () => {
    const store = await noteSignIns(["sub-ravi", 30, [AUDITORS, VIEWERS]], ["sub-ravi", 5, [VIEWERS]]);
    const view = await fromSignIns(store);
    expect(view.roles.find((row) => row.group === AUDITORS)?.people).toBe(0);
    expect(view.roles.find((row) => row.group === VIEWERS)?.people).toBe(1);
  });

  test("only sign-ins through the provider in use now count: one person seen through two never counts twice", async () => {
    const view = await counted([seen(10, [OPERATORS], "https://login.earlier-provider.example"), seen(2, [OPERATORS])]);
    expect(view.roles[1]).toEqual({ role: "operator", group: OPERATORS, seesRows: true, people: 1 });
  });

  test("Data Team (EU) is not a name, so its row says the group is hidden, with its count", async () => {
    const store = await noteSignIns(["sub-lena", 2, [DATA_TEAM]], ["sub-vera", 1, [VIEWERS, DATA_TEAM]]);
    const view = await fromSignIns(store);
    expect(view.roles.slice(3)).toEqual([
      { role: "viewer", group: VIEWERS, seesRows: true, people: 1 },
      { role: "viewer", groupHidden: true, seesRows: true, people: 2 },
    ]);
    expect(Object.keys(view.roles[4] ?? {})).not.toContain("group");
    expect(JSON.stringify(view)).not.toContain("Data Team");
  });

  test("a role whose list is empty has its row, with no group and no people", async () => {
    const view = await counted([seen(3, [VIEWERS])], { readonlyGroups: [] });
    expect(brief(view)).toEqual([
      ["administrator", ADMINISTRATORS, 0],
      ["operator", OPERATORS, 0],
      ["readonly", "(none)", 0],
      ["viewer", VIEWERS, 1],
      ["viewer", "(hidden)", 0],
    ]);
    expect(Object.keys(view.roles[2] ?? {}).sort()).toEqual(["people", "role", "seesRows"]);
  });

  test("the answer says since when sign-ins are counted, and how many accounts can sign in beside the provider", async () => {
    const store = await noteSignIns(
      ["sub-olga", 100, [OPERATORS]],
      ["sub-ravi", 30, [AUDITORS, VIEWERS]],
      ["sub-marta", 10, [ADMINISTRATORS, OPERATORS]],
      ["sub-ravi", 5, [VIEWERS]],
      ["sub-lena", 2, [DATA_TEAM]],
      ["sub-vera", 1, [VIEWERS, DATA_TEAM]],
    );
    expect(await fromSignIns(store)).toEqual({
      roles: [
        { role: "administrator", group: ADMINISTRATORS, seesRows: true, people: 1 },
        { role: "operator", group: OPERATORS, seesRows: true, people: 0 },
        { role: "readonly", group: AUDITORS, seesRows: false, people: 0 },
        { role: "viewer", group: VIEWERS, seesRows: true, people: 2 },
        { role: "viewer", groupHidden: true, seesRows: true, people: 2 },
      ],
      // vera is in both of the viewers' groups: in both rows, and once here.
      holders: [
        { role: "administrator", seesRows: true, people: 1 },
        { role: "operator", seesRows: true, people: 0 },
        { role: "readonly", seesRows: false, people: 0 },
        { role: "viewer", seesRows: true, people: 3 },
      ],
      countedFrom: "sign-ins",
      // The file was started at the first sign-in it noted.
      since: daysAgo(100).toISOString(),
      // marta, audit-bot, lena.hart and vera: erik is disabled, left-in-may deleted.
      accounts: 4,
    });
  });

  test("`since` is never earlier than the last change to the provider's settings, and never later than now", async () => {
    const store = await noteSignIns(["sub-olga", 30, [OPERATORS]]);
    // The file was started 30 days ago. The settings, written 5 days ago, may
    // have changed the provider or added a group: what was noted before
    // them may be missing from a row.
    expect((await fromSignIns(store, { epoch: daysAgo(5).getTime() })).since).toBe(daysAgo(5).toISOString());
    // Settings written before the file was started leave the file's start.
    expect((await fromSignIns(store, { epoch: daysAgo(40).getTime() })).since).toBe(daysAgo(30).toISOString());
    // A clock that ran ahead when the settings were written says no more than now.
    expect((await fromSignIns(store, { epoch: NOW.getTime() + 60_000 })).since).toBe(NOW.toISOString());
  });

  test("before anybody signed in, every row says nobody, and no `since` says that nothing is counted yet", async () => {
    const view = await accessView(
      sources({ oidc: async () => providerConfig(), people: async () => ({ people: [], since: null }), accounts: async () => ACCOUNTS }),
    );
    expect(view.roles.every((row) => row.people === 0)).toBe(true);
    expect(view).not.toHaveProperty("since");
    expect(view.accounts).toBe(4);
  });
});

describe("a group's name crosses only when it names no person", () => {
  test("with groupsClaim email each role has one row, its people counted together, and no address or name crosses", async () => {
    // A provider that sends no groups: each "group" is one person's address
    // or name. "olga.berg" is a name with no "@", and is held back all the same.
    const view = await counted(
      [seen(1, ["marta.lindqvist@northstar.example"]), seen(2, ["olga.berg"]), seen(3, ["ravi@northstar.example"])],
      {
        groupsClaim: "email",
        administratorGroups: ["marta.lindqvist@northstar.example", "olga.berg"],
        operatorGroups: [],
        readonlyGroups: ["ravi@northstar.example"],
        viewerGroups: ["lena@northstar.example"],
      },
    );
    expect(view.roles).toEqual([
      { role: "administrator", groupHidden: true, seesRows: true, people: 2 },
      { role: "operator", seesRows: true, people: 0 },
      { role: "readonly", groupHidden: true, seesRows: false, people: 1 },
      { role: "viewer", groupHidden: true, seesRows: true, people: 0 },
    ]);
    expect(view.holders.map((holder) => holder.people)).toEqual([2, 0, 1, 0]);
    const text = JSON.stringify(view);
    for (const name of ["marta", "olga", "ravi", "lena"]) expect(text).not.toContain(name);
  });

  test("only a claim of groups or roles lets a name cross; any other claim holds every group back", () => {
    const groupClaims = [
      "groups",
      "Groups",
      "roles",
      "group",
      "role",
      "memberOf",
      "wids",
      "cognito:groups",
      "https://northstar.example/claims/groups",
      "https://northstar.example/roles",
    ];
    for (const claim of groupClaims) {
      expect([claim, groupClaim(claim), groupMayCross(providerConfig({ groupsClaim: claim }), "eu-ops")]).toEqual([claim, true, true]);
    }
    const personClaims = [
      "email",
      "preferred_username",
      "upn",
      "unique_name",
      "name",
      "sub",
      "username",
      "login",
      "cognito:username",
      "uid",
      "employee_id",
      "https://northstar.example/claims/username",
    ];
    for (const claim of personClaims) {
      expect([claim, groupClaim(claim), groupMayCross(providerConfig({ groupsClaim: claim }), "eu-ops")]).toEqual([claim, false, false]);
    }
  });

  test("a group with @ in it is never sent, though @ is in a name's alphabet", async () => {
    const view = await counted([seen(1, ["eu@ops", "eu-ops"])], { operatorGroups: ["ops@northstar.example", "eu@ops", "eu-ops"] });
    expect(view.roles.filter((row) => row.role === "operator")).toEqual([
      { role: "operator", groupHidden: true, seesRows: true, people: 0 },
      { role: "operator", groupHidden: true, seesRows: true, people: 1 },
      { role: "operator", group: "eu-ops", seesRows: true, people: 1 },
    ]);
    expect(JSON.stringify(view)).not.toContain("@");
  });
});

describe("the reply's shape", () => {
  /** The answer of each kind of case, and of one that has every group a
   *  mapping can hold. */
  const cases: Array<[string, () => Promise<AccessView>]> = [
    ["accounts", () => accessView(sources({ accounts: async () => ACCOUNTS }))],
    ["sign-ins", () => counted([seen(10, [ADMINISTRATORS, OPERATORS]), seen(1, [VIEWERS, DATA_TEAM])])],
    ["an empty list", () => counted([], { readonlyGroups: [] })],
    [
      "groupsClaim email",
      () => counted([seen(2, ["olga@northstar.example"])], { groupsClaim: "email", operatorGroups: ["olga@northstar.example"] }),
    ],
    ["a group with @", () => counted([], { operatorGroups: ["eu@ops"] })],
    [
      "every group a mapping can hold",
      () => {
        const full = (prefix: string): string[] => Array.from({ length: MAX_GROUPS }, (_, i) => `${prefix}-${i}`);
        return counted([], {
          administratorGroups: full("administrators"),
          operatorGroups: full("operators"),
          readonlyGroups: full("auditors"),
          viewerGroups: full("viewers"),
        });
      },
    ],
  ];

  test.each(cases)("the answer of the case %s passes the manifest's reply shape", async (_, build) => {
    const view = await build();
    expect(conform(REPLY, view)).toEqual({ ok: true, value: view });
  });

  test("the cap on rows is four lists of MAX_GROUPS, and a full mapping fills it exactly", async () => {
    expect(ACCESS_MAX_ROWS).toBe(4 * MAX_GROUPS);
    expect(REPLY).toMatchObject({ kind: "record", fields: { roles: { kind: "list", max: ACCESS_MAX_ROWS } } });
    const full = await cases.at(-1)![1]();
    expect(full.roles).toHaveLength(ACCESS_MAX_ROWS);
  });

  test("an answer with a login in a row is refused, and so is one with a role, a count or a time it does not know", async () => {
    const view = await cases[1]![1]();
    const row = view.roles[0]!;
    const withRow = (changed: Record<string, unknown>): unknown => ({ ...view, roles: [{ ...row, ...changed }] });
    expect(conform(REPLY, withRow({ login: "marta.lindqvist@northstar.example" }))).toEqual({
      ok: false,
      issue: { path: "roles[0]", rule: "field_unknown" },
    });
    expect(conform(REPLY, withRow({ role: "owner" })).ok).toBe(false);
    expect(conform(REPLY, withRow({ people: -1 })).ok).toBe(false);
    expect(conform(REPLY, withRow({ group: "Data Team (EU)" })).ok).toBe(false);
    expect(conform(REPLY, { ...view, countedFrom: "guess" }).ok).toBe(false);
    expect(conform(REPLY, { ...view, since: "last spring" }).ok).toBe(false);
    expect(conform(REPLY, { ...view, accounts: -1 }).ok).toBe(false);
    const holder = view.holders[0]!;
    const withHolder = (changed: Record<string, unknown>): unknown => ({ ...view, holders: [{ ...holder, ...changed }] });
    expect(conform(REPLY, withHolder({ group: ADMINISTRATORS }))).toEqual({
      ok: false,
      issue: { path: "holders[0]", rule: "field_unknown" },
    });
    expect(conform(REPLY, withHolder({ role: "owner" })).ok).toBe(false);
    expect(conform(REPLY, withHolder({ people: 1.5 })).ok).toBe(false);
    expect(conform(REPLY, { ...view, holders: [...view.holders, holder] }).ok).toBe(false);
    const without: Record<string, unknown> = { ...view };
    delete without.holders;
    expect(conform(REPLY, without).ok).toBe(false);
  });
});

// ── Through the module, with the daemon's readers ────────────────────────────

const OWN: Organization = { id: "the-own-organization", own: true };
const ALDER: Organization = { id: "alder-dental", own: false };
const contextFor = (organization: Organization): ModuleContextV2 => ({ organization }) as unknown as ModuleContextV2;

/** The host module as the daemon builds it, over a root of the case's own. */
function hostModule(root: string) {
  const paths = fortressPaths(root);
  return createHostModule({
    version: "0.37.0",
    secretsKind: async () => "file",
    modules: async () => [],
    releases: async () => [],
    connection: () => {
      throw new Error("not asked here");
    },
    trail: {} as AuditTrail,
    access: (rows) => accessView(fileSources(paths), { rows }),
  });
}

/** Switch sign-in through the provider on in a root, as `ui oidc` does. */
async function switchProviderOn(root: string): Promise<void> {
  await new OidcConfigStore(path.join(fortressPaths(root).uiRoot, "oidc.json")).update((current) => ({
    ...current,
    enabled: true,
    issuer: ISSUER,
    clientId: "hx-fortress-console",
    operatorGroups: [OPERATORS],
  }));
}

describe("through the module", () => {
  test("with the daemon's readers over files, the answer is counted from users.json", async () => {
    const root = path.join(dir, "root");
    const store = new UsersStore(path.join(fortressPaths(root).uiRoot, "users.json"));
    await store.create("marta.lindqvist@northstar.example", "operator");
    await store.create("audit-bot", "readonly");
    await store.create("erik", "operator");
    await store.disable("erik");
    const rows = [
      { role: "operator", seesRows: true, people: 1 },
      { role: "readonly", seesRows: false, people: 1 },
      { role: "viewer", seesRows: true, people: 0 },
    ];
    expect(await hostModule(root).onAsk("access.groups", {}, contextFor(OWN))).toEqual({
      roles: rows,
      holders: rows,
      countedFrom: "accounts",
    });
  });

  test("with the daemon's readers over files, the answer is counted from the people the console wrote", async () => {
    const root = path.join(dir, "root");
    await switchProviderOn(root);
    const people = new ProviderPeopleStore(fortressPaths(root).providerPeople, { now: () => new Date() });
    await people.note({ issuer: ISSUER, subject: "sub-olga", groups: [OPERATORS] });
    await people.flush();
    expect(await hostModule(root).onAsk("access.groups", {}, contextFor(OWN))).toMatchObject({
      roles: [
        { role: "administrator", seesRows: true, people: 0 },
        { role: "operator", group: OPERATORS, seesRows: true, people: 1 },
        { role: "readonly", seesRows: false, people: 0 },
        { role: "viewer", seesRows: true, people: 0 },
      ],
      countedFrom: "sign-ins",
      accounts: 0,
    });
  });

  test("another organization is told how HX Fortress counts, and no row, and nothing but oidc.json is read for it", async () => {
    const root = path.join(dir, "root");
    await switchProviderOn(root);
    // Both other files are damaged: the own organization's ask fails, and
    // another's does not read them.
    await writeFile(path.join(fortressPaths(root).uiRoot, "users.json"), "{ damaged");
    await writeFile(fortressPaths(root).providerPeople, "{ damaged");
    const told = await hostModule(root).onAsk("access.groups", {}, contextFor(ALDER));
    expect(told).toEqual({ roles: [], holders: [], countedFrom: "sign-ins" });
    expect(conform(REPLY, told)).toEqual({ ok: true, value: told });
    await expect(hostModule(root).onAsk("access.groups", {}, contextFor(OWN))).rejects.toBeInstanceOf(AskFailure);
  });
});

describe("a file that cannot be read", () => {
  /** Text no answer and no error may repeat: an address, as a damaged file
   *  might hold one. */
  const MARKER = "marta.lindqvist@northstar.example";

  const damaged: Array<[string, (root: string) => Promise<void>]> = [
    [
      "oidc.json",
      async (root) => {
        await mkdir(fortressPaths(root).uiRoot, { recursive: true });
        await writeFile(path.join(fortressPaths(root).uiRoot, "oidc.json"), `{ "issuer": "${MARKER}`);
      },
    ],
    [
      "users.json",
      async (root) => {
        await mkdir(fortressPaths(root).uiRoot, { recursive: true });
        await writeFile(path.join(fortressPaths(root).uiRoot, "users.json"), `{ "users": [{ "login": "${MARKER}"`);
      },
    ],
    [
      PROVIDER_PEOPLE_FILE,
      async (root) => {
        await switchProviderOn(root);
        await writeFile(fortressPaths(root).providerPeople, `{ "version": 1, "people": "${MARKER}"`);
      },
    ],
  ];

  test.each(damaged)("a damaged %s fails the ask with access_unreadable, with no path and no content in its words", async (_, damage) => {
    const root = path.join(dir, "root");
    await damage(root);
    let thrown: unknown = null;
    try {
      await hostModule(root).onAsk("access.groups", {}, contextFor(OWN));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AskFailure);
    expect((thrown as AskFailure).code).toBe("access_unreadable");
    expect((thrown as AskFailure).message).toBe("ask failed: access_unreadable");
    expect(failureForLog(thrown)).toEqual({ code: "access_unreadable" });
    const words = `${String(thrown)} ${(thrown as Error).stack?.split("\n")[0] ?? ""}`;
    expect(words).not.toContain(root);
    expect(words).not.toContain(MARKER);
  });

  test("with no identity provider in use, provider-people.json is not read", async () => {
    const root = path.join(dir, "root");
    await mkdir(fortressPaths(root).uiRoot, { recursive: true });
    await writeFile(fortressPaths(root).providerPeople, "{ damaged");
    expect(await hostModule(root).onAsk("access.groups", {}, contextFor(OWN))).toMatchObject({ countedFrom: "accounts" });
  });
});

// ── The store ────────────────────────────────────────────────────────────────

describe("provider-people.json", () => {
  const file = (): string => path.join(dir, PROVIDER_PEOPLE_FILE);
  const people = async (): Promise<Record<string, PersonSeen>> =>
    (JSON.parse(await readFile(file(), "utf8")) as { people: Record<string, PersonSeen> }).people;
  /** A promise that settles at the store's next report of a write. */
  const nextWrite = (writes: boolean[]): Promise<boolean> =>
    new Promise((resolve, reject) => {
      const before = writes.length;
      const deadline = Date.now() + 10_000;
      const look = (): void => {
        if (writes.length > before) resolve(writes[writes.length - 1] as boolean);
        else if (Date.now() > deadline) reject(new Error("no write within 10 seconds"));
        else setTimeout(look, 10);
      };
      look();
    });

  test("a second sign-in of the same person replaces the first", async () => {
    await noteSignIns(["sub-marta", 20, [ADMINISTRATORS, OPERATORS]], ["sub-marta", 2, [OPERATORS]]);
    expect(await people()).toEqual({
      [personKey(ISSUER, "sub-marta")]: { at: daysAgo(2).toISOString(), issuer: issuerKey(ISSUER), groups: [groupKey(OPERATORS)] },
    });
  });

  test("a person whose last sign-in is older than 90 days is dropped at the next write", async () => {
    await noteSignIns(["sub-olga", 100, [OPERATORS]]);
    expect(Object.keys(await people())).toEqual([personKey(ISSUER, "sub-olga")]);
    await noteSignIns(["sub-marta", 1, [ADMINISTRATORS]]);
    expect(Object.keys(await people())).toEqual([personKey(ISSUER, "sub-marta")]);
  });

  test("what left the window while the console was away is dropped when the console reads the file", async () => {
    await noteSignIns(["sub-olga", 100, [OPERATORS]], ["sub-marta", 95, [ADMINISTRATORS]]);
    const writes: boolean[] = [];
    const store = new ProviderPeopleStore(file(), { now: () => NOW, flushMs: 20, onWrite: (ok) => writes.push(ok) });
    const written = nextWrite(writes);
    await store.warm();
    expect(await written).toBe(true);
    expect(await people()).toEqual({});
  });

  test("the console's sweep drops, once a day, what left the window while nobody signed in", async () => {
    const clock = { now: daysAgo(89.5) };
    const writes: boolean[] = [];
    const store = new ProviderPeopleStore(file(), { now: () => clock.now, onWrite: (ok) => writes.push(ok) });
    await store.note({ issuer: ISSUER, subject: "sub-olga", groups: [OPERATORS] });
    await store.flush();
    // A day later it looks: olga is 89.5 days old, and stays.
    clock.now = NOW;
    store.prune();
    // Olga leaves the window; the next look is a day after the last one.
    clock.now = new Date(NOW.getTime() + 18 * 60 * 60 * 1000);
    store.prune();
    await store.flush();
    expect(Object.keys(await people())).toEqual([personKey(ISSUER, "sub-olga")]);
    clock.now = new Date(NOW.getTime() + DAY_MS + 60_000);
    store.prune();
    await store.flush();
    expect(await people()).toEqual({});
    expect(writes).toEqual([true, true]);
  });

  test.skipIf(process.getuid?.() === 0)("the daily drop reads the file again when the read at start failed", async () => {
    await noteSignIns(["sub-olga", 95, [OPERATORS]]);
    const writes: boolean[] = [];
    const store = new ProviderPeopleStore(file(), { now: () => NOW, onWrite: (ok) => writes.push(ok) });
    await chmod(file(), 0o000);
    await store.warm();
    expect(writes).toEqual([false]);
    await chmod(file(), 0o600);
    store.prune();
    await store.flush();
    expect(await people()).toEqual({});
    expect(writes).toEqual([false, true]);
  });

  test("a next look set by a clock that ran ahead does not stop the daily drop", async () => {
    const clock = { now: new Date(NOW.getTime() + 200 * DAY_MS) };
    const store = new ProviderPeopleStore(file(), { now: () => clock.now });
    // Read with the clock 200 days ahead: the next look is 201 days ahead.
    await store.note({ issuer: ISSUER, subject: "sub-early", groups: [OPERATORS] });
    await store.flush();
    clock.now = NOW;
    await store.note({ issuer: ISSUER, subject: "sub-olga", groups: [OPERATORS] });
    await store.flush();
    // Olga leaves the window long before the look the fast clock set.
    clock.now = new Date(NOW.getTime() + (PEOPLE_DAYS + 1) * DAY_MS);
    store.prune();
    await store.flush();
    expect(Object.keys(await people())).toEqual([personKey(ISSUER, "sub-early")]);
  });

  test("past the cap, the oldest sign-ins are dropped first", async () => {
    const clock = { now: daysAgo(3) };
    const store = new ProviderPeopleStore(file(), { now: () => clock.now, maxPeople: 2 });
    for (const [subject, days] of [["sub-olga", 3], ["sub-marta", 2], ["sub-ravi", 1]] as const) {
      clock.now = daysAgo(days);
      await store.note({ issuer: ISSUER, subject, groups: [OPERATORS] });
    }
    await store.flush();
    expect(Object.keys(await people())).toEqual([personKey(ISSUER, "sub-ravi"), personKey(ISSUER, "sub-marta")]);
    // A person who signs in again is the newest, and the oldest left goes.
    clock.now = NOW;
    await store.note({ issuer: ISSUER, subject: "sub-marta", groups: [OPERATORS] });
    await store.note({ issuer: ISSUER, subject: "sub-lena", groups: [OPERATORS] });
    await store.flush();
    expect(Object.keys(await people()).sort()).toEqual([personKey(ISSUER, "sub-marta"), personKey(ISSUER, "sub-lena")].sort());
  });

  test("a write never makes a file larger than its limit: the oldest sign-ins are left out first", async () => {
    const clock = { now: NOW };
    const store = new ProviderPeopleStore(file(), { now: () => clock.now, maxBytes: 1_000 });
    for (let i = 0; i < 20; i += 1) {
      clock.now = new Date(NOW.getTime() - (20 - i) * 60_000);
      await store.note({ issuer: ISSUER, subject: `sub-${i}`, groups: [OPERATORS, VIEWERS] });
    }
    await store.flush();
    expect((await stat(file())).size).toBeLessThanOrEqual(1_000);
    const kept = Object.keys(await people());
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(20);
    expect(kept).toContain(personKey(ISSUER, "sub-19"));
    expect(kept).not.toContain(personKey(ISSUER, "sub-0"));
  });

  test("the file holds digests only: no person's id, no group's name and no provider's address", async () => {
    const subject = "sub-marta-northstar-0001";
    const address = "marta.lindqvist@northstar.example";
    const store = new ProviderPeopleStore(file(), { now: () => NOW });
    await store.note({ issuer: ISSUER, subject, groups: [address, ADMINISTRATORS] });
    await store.flush();
    const text = await readFile(file(), "utf8");
    for (const plain of [subject, "marta", ADMINISTRATORS, "northstar"]) expect(text).not.toContain(plain);
    expect(text).toContain(personKey(ISSUER, subject));
    expect(text).toContain(groupKey(address));
    // Two providers' ids for one subject never share a key.
    expect(personKey("https://login.other.example", subject)).not.toBe(personKey(ISSUER, subject));
  });

  test("the file is readable by HX Fortress's own user only", async () => {
    await noteSignIns(["sub-marta", 1, [ADMINISTRATORS]]);
    expect((await stat(file())).mode & 0o777).toBe(0o600);
  });

  test("two notes at once both land", async () => {
    const store = new ProviderPeopleStore(file(), { now: () => NOW });
    await Promise.all([
      store.note({ issuer: ISSUER, subject: "sub-marta", groups: [ADMINISTRATORS] }),
      store.note({ issuer: ISSUER, subject: "sub-vera", groups: [VIEWERS] }),
      store.note({ issuer: ISSUER, subject: "sub-ravi", groups: [AUDITORS] }),
    ]);
    await store.flush();
    expect(Object.keys(await people()).sort()).toEqual(
      ["sub-marta", "sub-vera", "sub-ravi"].map((subject) => personKey(ISSUER, subject)).sort(),
    );
  });

  test("a note right after a write starts is written too", async () => {
    const store = new ProviderPeopleStore(file(), { now: () => NOW });
    await store.note({ issuer: ISSUER, subject: "sub-marta", groups: [ADMINISTRATORS] });
    const writing = store.flush();
    const noting = store.note({ issuer: ISSUER, subject: "sub-vera", groups: [VIEWERS] });
    await Promise.all([writing, noting]);
    await store.flush();
    expect(Object.keys(await people()).sort()).toEqual([personKey(ISSUER, "sub-marta"), personKey(ISSUER, "sub-vera")].sort());
  });

  test("a damaged file is an error to the reader, and the next sign-in starts it again", async () => {
    await writeFile(file(), "{ not this file");
    const store = new ProviderPeopleStore(file(), { now: () => NOW });
    await expect(store.recent()).rejects.toBeInstanceOf(PeopleUnreadable);
    // Reading it when the console starts leaves it as it is.
    await store.warm();
    await store.flush();
    await expect(store.recent()).rejects.toBeInstanceOf(PeopleUnreadable);
    // Any sign-in starts it again, one in no mapped group too: nothing in it
    // could be counted, and reading it again at every such sign-in would cost
    // each one a parse of the whole file.
    await store.note({ issuer: ISSUER, subject: "sub-none", groups: [] });
    await store.flush();
    expect(await store.recent()).toEqual({ people: [], since: NOW.toISOString() });
    await store.note({ issuer: ISSUER, subject: "sub-marta", groups: [ADMINISTRATORS] });
    await store.flush();
    expect(await store.recent()).toEqual({
      people: [{ at: NOW.toISOString(), issuer: issuerKey(ISSUER), groups: [groupKey(ADMINISTRATORS)] }],
      since: NOW.toISOString(),
    });
  });

  test.skipIf(process.getuid?.() === 0)("a read that fails never starts the file again: what it holds stays, and is written on", async () => {
    await noteSignIns(["sub-olga", 3, [OPERATORS]], ["sub-ravi", 2, [AUDITORS]]);
    const writes: boolean[] = [];
    const store = new ProviderPeopleStore(file(), { now: () => NOW, onWrite: (ok) => writes.push(ok) });
    await chmod(file(), 0o000);
    await store.note({ issuer: ISSUER, subject: "sub-marta", groups: [ADMINISTRATORS] });
    await store.flush();
    expect(writes).toEqual([false]);
    await chmod(file(), 0o600);
    expect(Object.keys(await people()).sort()).toEqual([personKey(ISSUER, "sub-olga"), personKey(ISSUER, "sub-ravi")].sort());
    // Once the file reads again, the next note is written beside what it held.
    await store.note({ issuer: ISSUER, subject: "sub-vera", groups: [VIEWERS] });
    await store.flush();
    expect(Object.keys(await people()).sort()).toEqual(
      ["sub-olga", "sub-ravi", "sub-vera"].map((subject) => personKey(ISSUER, subject)).sort(),
    );
  });

  test("a sign-in in no mapped group removes the person, and writes nothing for a person never noted", async () => {
    const store = new ProviderPeopleStore(file(), { now: () => NOW });
    await store.note({ issuer: ISSUER, subject: "sub-none", groups: [] });
    await store.flush();
    await expect(stat(file())).rejects.toThrow();
    await store.note({ issuer: ISSUER, subject: "sub-marta", groups: [ADMINISTRATORS] });
    await store.note({ issuer: ISSUER, subject: "sub-vera", groups: [VIEWERS] });
    await store.note({ issuer: ISSUER, subject: "sub-marta", groups: [] });
    await store.flush();
    expect(Object.keys(await people())).toEqual([personKey(ISSUER, "sub-vera")]);
  });

  test("a group is kept once, and an entry that is not whole makes the file unreadable", async () => {
    const store = new ProviderPeopleStore(file(), { now: () => NOW });
    await store.note({ issuer: ISSUER, subject: "sub-vera", groups: [VIEWERS, VIEWERS, DATA_TEAM] });
    await store.flush();
    expect((await store.recent()).people).toEqual([
      { at: NOW.toISOString(), issuer: issuerKey(ISSUER), groups: [groupKey(VIEWERS), groupKey(DATA_TEAM)] },
    ]);
    const key = personKey(ISSUER, "sub-vera");
    const whole = { at: NOW.toISOString(), issuer: issuerKey(ISSUER), groups: [groupKey(VIEWERS)] };
    for (const entry of [
      { ...whole, at: "yesterday" },
      { ...whole, groups: [VIEWERS] },
      { ...whole, groups: [] },
      { ...whole, issuer: ISSUER },
      { at: whole.at, groups: whole.groups },
    ]) {
      await writeFile(file(), JSON.stringify({ version: 1, startedAt: NOW.toISOString(), people: { [key]: entry } }));
      await expect(store.recent()).rejects.toBeInstanceOf(PeopleUnreadable);
    }
    await writeFile(file(), JSON.stringify({ version: 1, startedAt: NOW.toISOString(), people: { "sub-vera": whole } }));
    await expect(store.recent()).rejects.toBeInstanceOf(PeopleUnreadable);
  });

  test("notes wait in memory and are written once, within the delay", async () => {
    const writes: boolean[] = [];
    // A delay long enough that a busy machine notes three before it ends.
    const store = new ProviderPeopleStore(file(), { now: () => NOW, flushMs: 1_000, onWrite: (ok) => writes.push(ok) });
    const written = nextWrite(writes);
    for (const subject of ["sub-marta", "sub-vera", "sub-ravi"]) {
      await store.note({ issuer: ISSUER, subject, groups: [OPERATORS] });
    }
    // Noted, and not written yet.
    await expect(stat(file())).rejects.toThrow();
    expect(await written).toBe(true);
    expect(writes).toEqual([true]);
    expect(Object.keys(await people())).toHaveLength(3);
  });

  test("a sign-in that changes nothing within a day is not written again, and one a day later is", async () => {
    const clock = { now: NOW };
    const writes: boolean[] = [];
    const store = new ProviderPeopleStore(file(), { now: () => clock.now, onWrite: (ok) => writes.push(ok) });
    await store.note({ issuer: ISSUER, subject: "sub-marta", groups: [ADMINISTRATORS, OPERATORS] });
    await store.flush();
    expect(writes).toEqual([true]);
    // An hour later, the same groups in another order: nothing to write.
    clock.now = new Date(NOW.getTime() + 60 * 60 * 1000);
    await store.note({ issuer: ISSUER, subject: "sub-marta", groups: [OPERATORS, ADMINISTRATORS] });
    await store.flush();
    expect(writes).toEqual([true]);
    // Another group is a change at once.
    await store.note({ issuer: ISSUER, subject: "sub-marta", groups: [OPERATORS] });
    await store.flush();
    expect(writes).toEqual([true, true]);
    // A day after the last note, the same groups move the time on.
    clock.now = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
    await store.note({ issuer: ISSUER, subject: "sub-marta", groups: [OPERATORS] });
    await store.flush();
    expect(writes).toEqual([true, true, true]);
    expect((await people())[personKey(ISSUER, "sub-marta")]?.at).toBe(clock.now.toISOString());
  });

  test("a write that fails keeps the notes, says so, and is tried again by itself", async () => {
    const writes: boolean[] = [];
    const store = new ProviderPeopleStore(file(), { now: () => NOW, flushMs: 40, onWrite: (ok) => writes.push(ok) });
    // The file is read first, then a folder takes its place: the write fails.
    await store.warm();
    await mkdir(file());
    const failed = nextWrite(writes);
    await store.note({ issuer: ISSUER, subject: "sub-marta", groups: [ADMINISTRATORS] });
    expect(await failed).toBe(false);
    // Nothing else is noted; the next try writes once the folder is gone.
    const retried = nextWrite(writes);
    await rm(file(), { recursive: true });
    expect(await retried).toBe(true);
    expect(Object.keys(await people())).toEqual([personKey(ISSUER, "sub-marta")]);
  });
});
