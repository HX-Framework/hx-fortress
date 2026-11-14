// Organizations: whose data an ask is for, and how everything a module keeps is
// kept for one organization.
//
// Almost every Fortress holds one organization, its own, and has to look
// exactly as it did before there could be a second: nothing on its disk and
// nothing in its records names an organization. A Fortress that holds more must
// keep each one's state, keys, switches and records apart. Both halves are
// tested here, through the real gate and the real module host.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, writeFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { CatalogEntry } from "../../src/host/module-catalog";
import {
  AskFailure,
  type FortressModule,
  type ModuleContextV2,
  type ModuleManifest,
  type ModuleStartContext,
} from "../../src/host/module-contract";
import {
  isOrganizationId,
  Organizations,
  OwnOrganizationUnreadable,
  ownOrganizationId,
  parseOrganizations,
  type OrganizationsDeps,
} from "../../src/host/module-organizations";
import { S } from "../../src/host/shape";
import {
  ask,
  makeRig,
  ORG,
  SECRET_VALUE,
  spoolRecords,
  tempRoot,
  writeConfig,
  writeOrganizations,
  type Paths,
  type Rig,
} from "./_module-rig";

// Made-up organizations. Northstar runs the Fortress; the others are held by it.
const ALDER = "alder-dental";
const BIRCH = "birch-books";
const CEDAR = "cedar-labs";
/** The id a Fortress in the tests of the directory enrolled as: the one a grant
 *  is held to, which a look for an ask is told. */
const NORTHSTAR = "northstar";

let rig: Rig | null = null;
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await rig?.cleanup();
  await cleanup?.();
  rig = null;
  cleanup = null;
});

async function bareRoot(): Promise<Paths> {
  const root = await tempRoot();
  cleanup = root.cleanup;
  return root.paths;
}

/** The organizations of a Fortress that has not enrolled, unless told otherwise. */
function organizationsOf(paths: Paths, overrides: Partial<OrganizationsDeps> = {}): Organizations {
  return new Organizations({ paths, enrolledAs: () => null, ...overrides });
}

/** Every file and folder under the Fortress's folder, as paths from it. */
async function everythingUnder(root: string, at = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(root, at), { withFileTypes: true })) {
    const here = path.join(at, entry.name);
    found.push(here);
    if (entry.isDirectory()) found.push(...(await everythingUnder(root, here)));
  }
  return found.sort();
}

// ── A module that keeps things: a state value, a key, records ────────────────

const LEDGER_MANIFEST: ModuleManifest = {
  id: "ledger",
  asks: [
    { name: "whose", args: S.none, reply: S.record({ own: S.flag }) },
    { name: "note.write", args: S.record({ value: S.count() }), reply: S.record({ ok: S.flag }) },
    { name: "note.read", args: S.none, reply: S.record({ value: S.count(), written: S.flag }) },
    { name: "key.use", args: S.none, reply: S.record({ length: S.count() }) },
    { name: "record", args: S.none, reply: S.record({ ok: S.flag }) },
    { name: "others", args: S.none, reply: S.record({ contexts: S.count(), first: S.flag }) },
    { name: "handed", args: S.none, reply: S.record({ lists: S.flag, identity: S.flag }) },
    { name: "fail", args: S.none, reply: S.none },
  ],
  egress: [],
  secrets: ["ledger-token"],
};

interface Ledger extends FortressModule {
  /** The context the module was started with. */
  started: ModuleStartContext | null;
  /** The context of the last ask, and every organization an ask was for. */
  last: ModuleContextV2 | null;
  seen: { id: string | null; own: boolean }[];
}

function createLedger(): Ledger {
  const module: Ledger = {
    id: "ledger",
    manifest: LEDGER_MANIFEST,
    started: null,
    last: null,
    seen: [],
    init(context) {
      module.started = context;
    },
    onMessage() {
      return { ok: false, error: "ask_unknown" };
    },
    async onAsk(name, args, ctx) {
      module.last = ctx;
      // The id of the Fortress's own organization is made when it is first
      // read, so a test that must not make one does not read it here.
      module.seen.push({ id: ctx.organization.own ? null : ctx.organization.id, own: ctx.organization.own });
      switch (name) {
        case "whose":
          return { own: ctx.organization.own };
        case "note.write":
          await ctx.state.write("note", (args as { value: number }).value);
          return { ok: true };
        case "note.read": {
          const value = await ctx.state.read<number>("note");
          return { value: value ?? 0, written: value !== null };
        }
        case "key.use":
          return { length: (await ctx.secrets.get("ledger-token")).length };
        case "record":
          // The module tries to say whose record this is. That is not its to say.
          ctx.audit.record("entry.added", { target: "ledger", organization: BIRCH, count: 3 });
          return { ok: true };
        case "others": {
          // Work that is not one organization's: only the context the module
          // was started with can list the others.
          const contexts = await module.started!.organizations();
          return { contexts: contexts.length, first: contexts[0]?.organization.own === true };
        }
        case "handed":
          // What the context of an ask holds besides its own organization's things.
          return { lists: "organizations" in ctx, identity: ctx.fortressIdentity !== null };
        default:
          throw new AskFailure("ask_not_implemented");
      }
    },
  };
  return module;
}

const LEDGER_CATALOG: readonly CatalogEntry[] = [
  { id: "session_vault", title: "Sessions", summary: "transcripts", manifest: null, startOnly: true },
  { id: "ledger", title: "Ledger", summary: "a module for tests", manifest: LEDGER_MANIFEST, startOnly: false },
];

/** A daemon-shaped host with the ledger module on, and this list of organizations. */
async function ledgerRig(held?: readonly unknown[]): Promise<{ rig: Rig; ledger: Ledger }> {
  const ledger = createLedger();
  const made = await makeRig({
    enabled: ["session_vault", "ledger"],
    deps: { catalog: LEDGER_CATALOG },
    probe: ledger as never,
    start: false,
  });
  rig = made;
  if (held) await writeOrganizations(made.paths, held);
  made.secrets.values = { "ledger-token": SECRET_VALUE };
  await made.host.start();
  await made.registry.startAll(["session_vault", "ledger"]);
  await made.host.started();
  return { rig: made, ledger };
}

/** One ask to the ledger, for the Fortress's own organization or for another. */
async function askFor(
  made: Rig,
  organization: string | null,
  name: string,
  args: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) {
  const grant = await made.key.grant("ledger", name, args, {
    ...(organization === null ? {} : { org: organization }),
    ...overrides,
  });
  return ask(made, "ledger", name, args, grant);
}

async function askRecords(paths: Paths) {
  return (await spoolRecords(paths)).filter((record) => record.action === "relay.ask");
}

// ── The list ─────────────────────────────────────────────────────────────────

describe("an organization's id", () => {
  test("is lower-case letters, digits and hyphens, so two ids never differ by case alone", () => {
    for (const id of ["a", "alder-dental", "0", "9f2c1d6e-0b7a-4c2e-9d1f-3a5b7c9e1f00", "a".repeat(64)]) {
      expect(isOrganizationId(id)).toBe(true);
    }
    for (const id of ["", "Alder", "alder_dental", "-alder", "alder.dental", "a/b", "..", "a".repeat(65), 7, null]) {
      expect(isOrganizationId(id)).toBe(false);
    }
  });
});

describe("the list of organizations", () => {
  const entry = { id: ALDER, modules: ["ledger"], keys: { ledger: { "ledger-token": "alder-ledger-token" } } };

  test("is read whole", () => {
    const parsed = parseOrganizations(JSON.stringify({ version: 1, organizations: [entry, { id: BIRCH }] }));
    expect(parsed).toEqual({
      ok: true,
      organizations: [
        {
          id: ALDER,
          modules: new Set(["ledger"]),
          keys: new Map([["ledger", new Map([["ledger-token", "alder-ledger-token"]])]]),
        },
        { id: BIRCH, modules: new Set(), keys: new Map() },
      ],
    });
  });

  test("is refused whole when one entry breaks a rule, and says which entry, counted from 1", () => {
    const refused = (organizations: unknown, version: unknown = 1) =>
      parseOrganizations(JSON.stringify({ version, organizations }));
    expect(parseOrganizations("{ not json")).toEqual({ ok: false, defect: "not_json" });
    expect(parseOrganizations(JSON.stringify([entry]))).toEqual({ ok: false, defect: "not_a_list" });
    expect(refused("alder")).toEqual({ ok: false, defect: "not_a_list" });
    expect(refused([entry], 2)).toEqual({ ok: false, defect: "version" });
    expect(refused([entry, "birch-books"])).toEqual({ ok: false, defect: "entry_not_an_object", entry: 2 });
    expect(refused([{ ...entry, admin: true }])).toEqual({ ok: false, defect: "entry_unknown_field", entry: 1 });
    expect(refused([{ id: "Alder Dental" }])).toEqual({ ok: false, defect: "id", entry: 1 });
    expect(refused([{ id: "../northstar" }])).toEqual({ ok: false, defect: "id", entry: 1 });
    expect(refused([entry, { id: ALDER }])).toEqual({ ok: false, defect: "id_listed_twice", entry: 2 });
    expect(refused([{ id: ALDER, modules: "ledger" }])).toEqual({ ok: false, defect: "modules", entry: 1 });
    expect(refused([{ id: ALDER, modules: ["Ledger"] }])).toEqual({ ok: false, defect: "modules", entry: 1 });
    expect(refused([{ id: ALDER, modules: ["l".repeat(65)] }])).toEqual({ ok: false, defect: "modules", entry: 1 });
    expect(refused([{ id: ALDER, modules: ["ledger", "ledger"] }])).toEqual({ ok: false, defect: "modules", entry: 1 });
    expect(refused([{ id: ALDER, keys: [] }])).toEqual({ ok: false, defect: "keys", entry: 1 });
    expect(refused([{ id: ALDER, keys: { ledger: "token" } }])).toEqual({ ok: false, defect: "keys", entry: 1 });
    // A value pasted where a secret's NAME belongs is not a name, and is not repeated.
    const pasted = refused([{ id: ALDER, keys: { ledger: { "ledger-token": SECRET_VALUE.toUpperCase() } } }]);
    expect(pasted).toEqual({ ok: false, defect: "keys", entry: 1 });
    expect(JSON.stringify(pasted)).not.toContain(SECRET_VALUE.toUpperCase());
  });

  test("refuses an id that looks like a credential, which is most likely one pasted into the wrong place", () => {
    // Each fits the id rule. Each is also what an API key pasted into the wrong
    // field looks like. As an id it would be written into every record of that
    // organization and into a folder's name.
    for (const id of ["acme-sk-northstar-holdings-europe", "sk-alder-dental-clinic-01", "xoxb-alder-dental"]) {
      expect(isOrganizationId(id)).toBe(true);
      expect(parseOrganizations(JSON.stringify({ version: 1, organizations: [entry, { id }] }))).toEqual({
        ok: false,
        defect: "id",
        entry: 2,
      });
    }
  });

  test("may not hold the Fortress's own organization under another role", () => {
    const text = JSON.stringify({ version: 1, organizations: [{ id: BIRCH }, entry] });
    const refused = { ok: false, defect: "id_is_the_own_organization", entry: 2 } as const;
    // Neither the id the Fortress enrolled as, nor the one it made for itself.
    expect(parseOrganizations(text, [ALDER, null])).toEqual(refused);
    expect(parseOrganizations(text, [null, ALDER])).toEqual(refused);
    expect(parseOrganizations(text, ["northstar", ALDER])).toEqual(refused);
    expect(parseOrganizations(text, [null, null])).toMatchObject({ ok: true });
    expect(parseOrganizations(text, ["northstar", null])).toMatchObject({ ok: true });
    expect(parseOrganizations(text)).toMatchObject({ ok: true });
  });
});

describe("the Fortress's own organization's id", () => {
  test("is made once, kept in a file only the Fortress's user can read, and never changes", async () => {
    const paths = await bareRoot();
    const file = paths.ownOrganization;
    expect(file).toBe(path.join(paths.root, "identity", "organization.json"));
    expect(existsSync(file)).toBe(false);
    const id = ownOrganizationId(file);
    expect(isOrganizationId(id)).toBe(true);
    expect(ownOrganizationId(file)).toBe(id);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ id });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    // No temporary file is left beside it.
    expect(await readdir(path.dirname(file))).toEqual(["organization.json"]);
    // Another process, later: the same id.
    expect(organizationsOf(paths).own.id).toBe(id);
  });

  test("is not replaced when its file cannot be read: the rows keyed by it would belong to nobody", async () => {
    const paths = await bareRoot();
    const file = paths.ownOrganization;
    await mkdir(path.dirname(file), { recursive: true });
    for (const damaged of ["", "{ not json", JSON.stringify({ id: "Not An Id" }), JSON.stringify([])]) {
      await writeFile(file, damaged);
      expect(() => ownOrganizationId(file)).toThrow(OwnOrganizationUnreadable);
      expect(await readFile(file, "utf8")).toBe(damaged);
    }
  });

  test("is not made while the name is taken by something that is not the file", async () => {
    const paths = await bareRoot();
    const file = paths.ownOrganization;
    const noLinks = (): void => {
      throw Object.assign(new Error("operation not supported"), { code: "ENOTSUP" });
    };
    await mkdir(path.dirname(file), { recursive: true });

    // A folder where the file belongs.
    await mkdir(file);
    expect(() => ownOrganizationId(file)).toThrow(OwnOrganizationUnreadable);
    expect(() => ownOrganizationId(file, noLinks)).toThrow(OwnOrganizationUnreadable);
    expect(lstatSync(file).isDirectory()).toBe(true);
    await rm(file, { recursive: true });

    // A link to a place that is not there now, as when a volume is not mounted
    // yet. The id may be in what it points at: no new one is made, with hard
    // links and without.
    await symlink(path.join(paths.root, "not-mounted", "organization.json"), file);
    expect(() => ownOrganizationId(file)).toThrow(OwnOrganizationUnreadable);
    expect(() => ownOrganizationId(file, noLinks)).toThrow(OwnOrganizationUnreadable);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(await readdir(path.dirname(file))).toEqual(["organization.json"]);
    // The directory that hands out the id refuses too, and keeps refusing.
    const organizations = organizationsOf(paths);
    expect(() => organizations.own.id).toThrow(OwnOrganizationUnreadable);
    expect(() => organizations.own.id).toThrow(OwnOrganizationUnreadable);
  });

  // Root reads a file whatever its mode says, so there is nothing to see as root.
  test.skipIf(process.getuid?.() === 0)("is not replaced when its file may not be read", async () => {
    const paths = await bareRoot();
    const file = paths.ownOrganization;
    const id = ownOrganizationId(file);
    await chmod(file, 0o000);
    try {
      expect(() => ownOrganizationId(file)).toThrow(OwnOrganizationUnreadable);
    } finally {
      await chmod(file, 0o600);
    }
    expect(ownOrganizationId(file)).toBe(id);
  });

  test("says so in the log, once, when it is made", async () => {
    const paths = await bareRoot();
    const said: string[] = [];
    const logger = { error: (): void => {}, info: (message: string) => void said.push(message) };
    const organizations = organizationsOf(paths, { logger });
    expect(said).toEqual([]);
    const id = organizations.own.id;
    expect(organizations.own.id).toBe(id);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("made an id for its own organization");
    // The id itself is not in the log.
    expect(said[0]).not.toContain(id);
    // A later process reads the id that is there and says nothing.
    const later = organizationsOf(paths, { logger });
    expect(later.own.id).toBe(id);
    expect(said).toHaveLength(1);
  });

  test("differs from Fortress to Fortress", async () => {
    const a = await tempRoot();
    const b = await tempRoot();
    try {
      expect(ownOrganizationId(a.paths.ownOrganization)).not.toBe(ownOrganizationId(b.paths.ownOrganization));
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  test("is made on a file system that has no hard links", async () => {
    const paths = await bareRoot();
    const file = paths.ownOrganization;
    // What `link` answers on a network share or a mounted object store.
    for (const code of ["EPERM", "ENOTSUP"]) {
      await rm(path.dirname(file), { recursive: true, force: true });
      const noLinks = (): void => {
        throw Object.assign(new Error("operation not permitted"), { code });
      };
      const id = ownOrganizationId(file, noLinks);
      expect(isOrganizationId(id)).toBe(true);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ id });
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(await readdir(path.dirname(file))).toEqual(["organization.json"]);
      // The file has its name now, and is never written again.
      expect(ownOrganizationId(file, noLinks)).toBe(id);
    }
    // Any other failure to give the file its name is a failure: no id is made up.
    await rm(path.dirname(file), { recursive: true, force: true });
    const denied = (): void => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    };
    expect(() => ownOrganizationId(file, denied)).toThrow("permission denied");
    expect(await readdir(path.dirname(file))).toEqual([]);
  });

  test("when two make it at the same moment, both get the one that got its name", async () => {
    const paths = await bareRoot();
    const file = paths.ownOrganization;
    const winner = "9f2c1d6e-0b7a-4c2e-9d1f-3a5b7c9e1f00";
    // Another process gives its own file the name first: this one's link fails.
    const lost = (): void => {
      writeFileSync(file, JSON.stringify({ id: winner }));
      throw Object.assign(new Error("file exists"), { code: "EEXIST" });
    };
    expect(ownOrganizationId(file, lost)).toBe(winner);
    expect(await readdir(path.dirname(file))).toEqual(["organization.json"]);

    // The same where there are no hard links: the name was free a moment ago
    // and is taken now, so nothing is renamed over it.
    await rm(file);
    const lostWithoutLinks = (): void => {
      writeFileSync(file, JSON.stringify({ id: winner }));
      throw Object.assign(new Error("operation not supported"), { code: "ENOTSUP" });
    };
    expect(ownOrganizationId(file, lostWithoutLinks)).toBe(winner);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ id: winner });
    expect(await readdir(path.dirname(file))).toEqual(["organization.json"]);
  });
});

describe("the organizations of a Fortress", () => {
  test("with no list there is the own organization and no other", async () => {
    const paths = await bareRoot();
    const organizations = organizationsOf(paths);
    expect(await organizations.held(ALDER, NORTHSTAR)).toBeNull();
    expect((await organizations.all()).map((organization) => organization.own)).toEqual([true]);
    await organizations.look();
    // Asking any of that made nothing on disk.
    expect(await everythingUnder(paths.root)).toEqual([]);
  });

  test("a listed organization has its own state folder, its own switches and its own secret names", async () => {
    const paths = await bareRoot();
    await writeOrganizations(paths, [
      { id: ALDER, modules: ["ledger"], keys: { ledger: { "ledger-token": "alder-ledger-token" } } },
      { id: BIRCH },
      // Names for a module its entry does not list.
      { id: CEDAR, keys: { ledger: { "ledger-token": "cedar-ledger-token" } } },
    ]);
    const organizations = organizationsOf(paths);
    const alder = (await organizations.held(ALDER, NORTHSTAR))!;
    const birch = (await organizations.held(BIRCH, NORTHSTAR))!;
    const cedar = (await organizations.held(CEDAR, NORTHSTAR))!;
    expect(alder).toEqual({ id: ALDER, own: false });
    expect(Object.isFrozen(alder)).toBe(true);
    expect((await organizations.all()).map((organization) => organization.own)).toEqual([true, false, false, false]);
    expect(await organizations.held("dogwood-diner", NORTHSTAR)).toBeNull();
    expect(await organizations.held("../northstar", NORTHSTAR)).toBeNull();

    expect(organizations.stateDir(organizations.own, "ledger")).toBe(paths.moduleState("ledger"));
    expect(organizations.stateDir(alder, "ledger")).toBe(
      path.join(paths.root, "organizations", ALDER, "modules", "ledger", "state"),
    );
    expect(() => organizations.stateDir({ id: "../northstar", own: false }, "ledger")).toThrow();
    expect(() => organizations.stateDir(alder, "../ledger")).toThrow();

    expect(organizations.listsModule(organizations.own, "ledger")).toBe(true);
    expect(organizations.listsModule(alder, "ledger")).toBe(true);
    expect(organizations.listsModule(birch, "ledger")).toBe(false);
    // An organization this directory did not hand out lists nothing.
    expect(organizations.listsModule({ id: ALDER, own: false }, "ledger")).toBe(false);

    expect(await organizations.keyName(organizations.own, "ledger", "ledger-token")).toBe("ledger-token");
    expect(await organizations.keyName(alder, "ledger", "ledger-token")).toBe("alder-ledger-token");
    // No name for it: no secret. Never the own organization's.
    expect(await organizations.keyName(birch, "ledger", "ledger-token")).toBeNull();
    expect(await organizations.keyName(alder, "ledger", "another-token")).toBeNull();
    // A name for a module the entry does not list is no name.
    expect(await organizations.keyName(cedar, "ledger", "ledger-token")).toBeNull();
  });

  test("a module whose id is a word every object has finds no name it was not given", async () => {
    const paths = await bareRoot();
    // `constructor` fits the rule for a module's id.
    await writeOrganizations(paths, [{ id: ALDER, modules: ["constructor", "ledger"] }]);
    const organizations = organizationsOf(paths);
    const alder = (await organizations.held(ALDER, NORTHSTAR))!;
    expect(organizations.listsModule(alder, "constructor")).toBe(true);
    for (const declared of ["name", "length", "prototype", "constructor"]) {
      expect(await organizations.keyName(alder, "constructor", declared)).toBeNull();
      expect(await organizations.keyName(alder, "ledger", declared)).toBeNull();
    }
  });

  test("a list that cannot be used holds nobody, says so once, and is read again when it changes", async () => {
    const paths = await bareRoot();
    const said: unknown[] = [];
    const organizations = organizationsOf(paths, {
      logger: { error: (message: string, fields?: unknown) => void said.push([message, fields]) },
    });
    await writeOrganizations(paths, [{ id: ALDER, modules: ["ledger"] }, { id: "Birch Books" }]);
    expect(await organizations.held(ALDER, NORTHSTAR)).toBeNull();
    expect(await organizations.held(ALDER, NORTHSTAR)).toBeNull();
    expect((await organizations.all()).map((organization) => organization.own)).toEqual([true]);
    expect(said).toHaveLength(1);
    // The second entry, counted from 1.
    expect(said[0]).toEqual([expect.stringContaining("organizations.json cannot be used"), { defect: "id", entry: 2 }]);

    // Fixed, and read again at the next look.
    await writeOrganizations(paths, [{ id: ALDER, modules: ["ledger"] }]);
    expect(await organizations.held(ALDER, NORTHSTAR)).not.toBeNull();
    expect(said).toHaveLength(1);

    // Broken another way: said again, once, with the new rule.
    await writeOrganizations(paths, [{ id: ALDER, modules: ["ledger"] }], 2);
    expect(await organizations.held(ALDER, NORTHSTAR)).toBeNull();
    expect(await organizations.held(ALDER, NORTHSTAR)).toBeNull();
    expect(said).toHaveLength(2);
    expect(said[1]).toEqual([expect.stringContaining("organizations.json cannot be used"), { defect: "version" }]);
  });

  test("a list that cannot be read at all holds nobody, and says that it could not be read", async () => {
    const paths = await bareRoot();
    const said: unknown[] = [];
    const organizations = organizationsOf(paths, {
      logger: { error: (message: string, fields?: unknown) => void said.push(fields) },
    });
    // A folder where the file belongs: there, and not a file anyone can read.
    await mkdir(paths.organizations);
    expect(await organizations.held(ALDER, NORTHSTAR)).toBeNull();
    expect(await organizations.held(ALDER, NORTHSTAR)).toBeNull();
    expect((await organizations.all()).map((organization) => organization.own)).toEqual([true]);
    expect(said).toEqual([{ defect: "unreadable" }]);

    await rm(paths.organizations, { recursive: true });
    await writeOrganizations(paths, [{ id: ALDER }]);
    expect(await organizations.held(ALDER, NORTHSTAR)).not.toBeNull();
  });

  // Root reads a file whatever its mode says, so there is nothing to see as root.
  test.skipIf(process.getuid?.() === 0)(
    "a list that can no longer be read stops holding anybody at once",
    async () => {
      const paths = await bareRoot();
      const said: unknown[] = [];
      const organizations = organizationsOf(paths, {
        logger: { error: (message: string, fields?: unknown) => void said.push(fields) },
      });
      await writeOrganizations(paths, [{ id: ALDER }]);
      expect(await organizations.held(ALDER, NORTHSTAR)).not.toBeNull();
      expect(await organizations.held(ALDER, NORTHSTAR)).not.toBeNull();
      // Same bytes, same size, same time of change. Only who may read it changed.
      await chmod(paths.organizations, 0o000);
      try {
        expect(await organizations.held(ALDER, NORTHSTAR)).toBeNull();
        expect(said).toEqual([{ defect: "unreadable" }]);
      } finally {
        await chmod(paths.organizations, 0o600);
      }
      expect(await organizations.held(ALDER, NORTHSTAR)).not.toBeNull();
    },
  );

  test("a change is seen at the next look, whatever the file system says about when it changed", async () => {
    const paths = await bareRoot();
    // Two ids of one length, written in place with the time of change put back:
    // the same file, the same size and the same time. Only the bytes differ.
    const MAPLE = "maple-dental";
    expect(MAPLE).toHaveLength(ALDER.length);
    const changed = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    const write = async (id: string): Promise<void> => {
      await writeOrganizations(paths, [{ id }]);
      await utimes(paths.organizations, changed, changed);
    };
    const organizations = organizationsOf(paths);
    await write(ALDER);
    expect(await organizations.held(ALDER, NORTHSTAR)).not.toBeNull();
    expect(await organizations.held(ALDER, NORTHSTAR)).not.toBeNull();
    const before = await stat(paths.organizations);
    await write(MAPLE);
    const after = await stat(paths.organizations);
    expect([after.ino, after.size, after.mtimeMs]).toEqual([before.ino, before.size, before.mtimeMs]);
    expect(await organizations.held(ALDER, NORTHSTAR)).toBeNull();
    expect(await organizations.held(MAPLE, NORTHSTAR)).not.toBeNull();
  });

  test("an entry may not carry the id this Fortress enrolled as: the whole list is refused", async () => {
    const paths = await bareRoot();
    const said: unknown[] = [];
    let enrolled: string | null = null;
    const organizations = organizationsOf(paths, {
      enrolledAs: () => enrolled,
      logger: { error: (message: string, fields?: unknown) => void said.push(fields) },
    });
    await writeOrganizations(paths, [{ id: ALDER }, { id: BIRCH }]);
    const others = async (): Promise<string[]> =>
      (await organizations.all()).filter((organization) => !organization.own).map((organization) => organization.id);
    // Not enrolled yet: there is no such id to check against, and the list holds.
    expect(await others()).toEqual([ALDER, BIRCH]);

    // Enrolled as one of its own entries. An ask that names that id is for the
    // own organization, so the entry could never be asked for. The same file is
    // now refused, and nobody on it is held.
    enrolled = ALDER;
    expect(await others()).toEqual([]);
    expect(await organizations.keyName({ id: BIRCH, own: false }, "ledger", "ledger-token")).toBeNull();
    expect(said).toEqual([{ defect: "id_is_the_own_organization", entry: 1 }]);

    enrolled = NORTHSTAR;
    expect(await others()).toEqual([ALDER, BIRCH]);

    // A look for an ask is told the id the ask's grant was held to, and checks
    // the list against that one, whatever a second reading would say.
    expect(await organizations.held(BIRCH, NORTHSTAR)).not.toBeNull();
    expect(await organizations.held(BIRCH, ALDER)).toBeNull();
    expect(await organizations.held(ALDER, ALDER)).toBeNull();
    expect(await organizations.held(BIRCH, BIRCH)).toBeNull();
  });

  test("a list cannot be checked while the id the Fortress enrolled as cannot be read, so it holds nobody", async () => {
    const paths = await bareRoot();
    const said: unknown[] = [];
    let broken = true;
    const organizations = organizationsOf(paths, {
      // Not "not enrolled": the credentials are there and cannot be read.
      enrolledAs: () => (broken ? Promise.reject(new Error("credentials cannot be read")) : NORTHSTAR),
      logger: { error: (message: string, fields?: unknown) => void said.push([message, fields]) },
    });
    await writeOrganizations(paths, [{ id: ALDER, modules: ["ledger"], keys: { ledger: { "ledger-token": "a-token" } } }]);
    expect((await organizations.all()).map((organization) => organization.own)).toEqual([true]);
    expect(await organizations.keyName({ id: ALDER, own: false }, "ledger", "ledger-token")).toBeNull();
    await organizations.look();
    expect(said).toEqual([
      [expect.stringContaining("credentials this Fortress enrolled with cannot be read"), { defect: "enrolled_id_unreadable" }],
    ]);
    // An ask does not depend on that second reading: its grant was verified
    // against an id that could be read, and the list is checked against it.
    expect(await organizations.held(ALDER, NORTHSTAR)).not.toBeNull();
    broken = false;
    expect((await organizations.all()).map((organization) => organization.own)).toEqual([true, false]);
    expect(await organizations.keyName({ id: ALDER, own: false }, "ledger", "ledger-token")).toBe("a-token");
  });

  test("one thing that is wrong is said once, also when the ids it was checked against change", async () => {
    const paths = await bareRoot();
    const said: unknown[] = [];
    let enrolled: string | null = null;
    const organizations = organizationsOf(paths, {
      enrolledAs: () => enrolled,
      logger: { error: (message: string, fields?: unknown) => void said.push(fields) },
    });
    await writeOrganizations(paths, [{ id: ALDER }, { id: "Birch Books" }]);
    await organizations.look();
    // The Fortress enrolls, and a module reads the own organization's id. The
    // file is the same and so is what is wrong with it.
    enrolled = NORTHSTAR;
    await organizations.look();
    expect(isOrganizationId(organizations.own.id)).toBe(true);
    await organizations.look();
    expect(await organizations.held(ALDER, CEDAR)).toBeNull();
    expect(said).toEqual([{ defect: "id", entry: 2 }]);
  });

  test("a name that is not a file is refused without being read, and never waited for", async () => {
    const paths = await bareRoot();
    const said: unknown[] = [];
    // Every read of the opened file is counted: what is refused is refused
    // before a byte is read.
    let reads = 0;
    const organizations = organizationsOf(paths, {
      logger: { error: (message: string, fields?: unknown) => void said.push(fields) },
      open: async (file, flags) => {
        const handle = await open(file, flags);
        const read = handle.read.bind(handle) as (...args: unknown[]) => unknown;
        (handle as unknown as { read: (...args: unknown[]) => unknown }).read = (...args) => {
          reads += 1;
          return read(...args);
        };
        return handle;
      },
    });
    // A pipe with nobody writing to it: reading it would wait for ever.
    expect(Bun.spawnSync(["mkfifo", paths.organizations]).exitCode).toBe(0);
    const looked = await Promise.race([
      organizations.held(ALDER, NORTHSTAR),
      new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 3_000)),
    ]);
    expect(looked).toBeNull();
    await organizations.look();
    expect(said).toEqual([{ defect: "unreadable" }]);

    // A link to something that never ends.
    await rm(paths.organizations);
    await symlink("/dev/zero", paths.organizations);
    expect(await organizations.held(ALDER, NORTHSTAR)).toBeNull();
    // A folder.
    await rm(paths.organizations);
    await mkdir(paths.organizations);
    expect(await organizations.held(ALDER, NORTHSTAR)).toBeNull();
    await rm(paths.organizations, { recursive: true });
    // A file past the limit is refused by its size.
    const big = await open(paths.organizations, "w");
    await big.truncate(8 * 1024 * 1024 + 1);
    await big.close();
    expect(await organizations.held(ALDER, NORTHSTAR)).toBeNull();
    expect(said.at(-1)).toEqual({ defect: "too_large" });
    // None of the four was read.
    expect(reads).toBe(0);

    // A link to nothing is no list. And a real list is read.
    await rm(paths.organizations);
    await symlink(path.join(paths.root, "nowhere.json"), paths.organizations);
    expect(await organizations.held(ALDER, NORTHSTAR)).toBeNull();
    await rm(paths.organizations);
    await writeOrganizations(paths, [{ id: ALDER }]);
    expect(await organizations.held(ALDER, NORTHSTAR)).not.toBeNull();
    expect(reads).toBeGreaterThan(0);
  });

  test("looks that arrive while the file is being read share one read that starts after them", async () => {
    const paths = await bareRoot();
    // The real `open`, held at a gate so that the test decides when a read goes on.
    let opens = 0;
    let release: (() => void) | null = null;
    const organizations = organizationsOf(paths, {
      open: async (file, flags) => {
        opens += 1;
        const handle = await open(file, flags);
        if (opens === 1) await new Promise<void>((resolve) => (release = resolve));
        return handle;
      },
    });
    await writeOrganizations(paths, [{ id: ALDER }]);

    // The first look has opened the file and is held there.
    const first = organizations.held(ALDER, NORTHSTAR);
    while (release === null) await new Promise((resolve) => setTimeout(resolve, 1));
    // The list is replaced by another file under the same name: Alder is off it.
    const replacement = `${paths.organizations}.new`;
    await writeFile(replacement, JSON.stringify({ version: 1, organizations: [{ id: BIRCH }] }));
    await rename(replacement, paths.organizations);
    // Five looks arrive after that, while the first read is still going on.
    const later = [
      organizations.held(ALDER, NORTHSTAR),
      organizations.held(BIRCH, NORTHSTAR),
      organizations.held(ALDER, NORTHSTAR),
      organizations.all(),
      organizations.keyName({ id: BIRCH, own: false }, "ledger", "ledger-token"),
    ];
    (release as () => void)();

    // The first look read the file it had opened: the list as it was.
    expect(await first).not.toBeNull();
    // Every later look sees the list as it is, although the first read began
    // before the change.
    const [alder, birch, alderAgain, all] = await Promise.all(later);
    expect(alder).toBeNull();
    expect(birch).not.toBeNull();
    expect(alderAgain).toBeNull();
    expect((all as { own: boolean }[]).map((organization) => organization.own)).toEqual([true, false]);
    // And the five cost one read between them: two in all.
    expect(opens).toBe(2);
  });

  test("an entry may not carry the id the Fortress made for its own organization", async () => {
    const paths = await bareRoot();
    const organizations = organizationsOf(paths);
    await writeOrganizations(paths, [{ id: ALDER }]);
    expect(await organizations.held(ALDER, NORTHSTAR)).not.toBeNull();
    // The id is made now. A list that names it stops holding anybody.
    const own = organizations.own.id;
    await writeOrganizations(paths, [{ id: ALDER }, { id: own }]);
    expect(await organizations.held(ALDER, NORTHSTAR)).toBeNull();
    expect(await organizations.held(own, NORTHSTAR)).toBeNull();
    // And for a process that starts later and has not read the id itself.
    expect(await organizationsOf(paths).held(ALDER, NORTHSTAR)).toBeNull();
  });

  test("a list cannot be checked while the own organization's id cannot be read, so it holds nobody", async () => {
    const paths = await bareRoot();
    const said: unknown[] = [];
    const organizations = organizationsOf(paths, {
      logger: { error: (message: string, fields?: unknown) => void said.push([message, fields]) },
    });
    await writeOrganizations(paths, [{ id: ALDER }]);
    await mkdir(path.dirname(paths.ownOrganization), { recursive: true });
    // The file is there and does not hold an id. No entry can be held up to it.
    await writeFile(paths.ownOrganization, "{ damaged");
    expect(await organizations.held(ALDER, NORTHSTAR)).toBeNull();
    expect(await organizations.held(ALDER, NORTHSTAR)).toBeNull();
    expect(said).toEqual([[expect.stringContaining("identity/organization.json cannot be read"), { defect: "own_id_unreadable" }]]);
    // Restored: the list holds again.
    await writeFile(paths.ownOrganization, JSON.stringify({ id: "9f2c1d6e-0b7a-4c2e-9d1f-3a5b7c9e1f00" }));
    expect(await organizations.held(ALDER, NORTHSTAR)).not.toBeNull();
  });
});

// ── A Fortress with one organization ─────────────────────────────────────────

describe("a Fortress with one organization", () => {
  test("keeps everything where it was: no file, folder or record names an organization", async () => {
    const { rig: made, ledger } = await ledgerRig();
    const before = await everythingUnder(made.paths.root);

    expect(await askFor(made, null, "whose")).toEqual({ ok: true, payload: { own: true } });
    expect(await askFor(made, null, "note.write", { value: 7 })).toEqual({ ok: true, payload: { ok: true } });
    expect(await askFor(made, null, "note.read")).toEqual({ ok: true, payload: { value: 7, written: true } });
    expect(await askFor(made, null, "key.use")).toEqual({ ok: true, payload: { length: SECRET_VALUE.length } });
    expect(await askFor(made, null, "record")).toEqual({ ok: true, payload: { ok: true } });
    expect(await askFor(made, null, "others")).toEqual({ ok: true, payload: { contexts: 1, first: true } });
    await made.host.audit.flush();

    // The state rests where a module's state always rested.
    expect(JSON.parse(await readFile(path.join(made.paths.moduleState("ledger"), "note.json"), "utf8"))).toEqual({
      value: 7,
    });
    // The key was read under the name the manifest declares.
    expect(made.secrets.reads).toEqual(["ledger-token"]);
    // Nothing new on disk but that state file and the audit spool's own files.
    const after = (await everythingUnder(made.paths.root)).filter((entry) => !before.includes(entry));
    expect(after.filter((entry) => entry !== "ui" && !entry.startsWith(path.join("ui", "spool")))).toEqual([
      "modules",
      path.join("modules", "ledger"),
      path.join("modules", "ledger", "state"),
      path.join("modules", "ledger", "state", "note.json"),
    ]);
    expect(existsSync(made.paths.organizations)).toBe(false);
    expect(existsSync(path.join(made.paths.root, "organizations"))).toBe(false);
    // The Fortress did not even make its own organization an id: nothing asked.
    expect(existsSync(path.join(made.paths.root, "identity", "organization.json"))).toBe(false);

    // No record carries an organization, and the module's own attempt to name
    // one was dropped.
    const records = await spoolRecords(made.paths);
    expect(records.length).toBeGreaterThan(10);
    for (const record of records) expect(record.params ?? {}).not.toHaveProperty("organization");
    expect(JSON.stringify(records)).not.toContain(BIRCH);
    const own = records.find((record) => record.action === "module.ledger.entry.added");
    expect(own?.params).toEqual({ target: "ledger", count: 3 });
    expect(ledger.seen.every((seen) => seen.own)).toBe(true);
  });

  test("refuses a grant for any other organization, and records it as nobody's", async () => {
    const { rig: made, ledger } = await ledgerRig();
    expect(await askFor(made, ALDER, "whose")).toEqual({ ok: false, error: "grant_invalid" });
    // Addressed to another Fortress: refused whatever organization it names.
    expect(await askFor(made, null, "whose", {}, { aud: "org_other" })).toEqual({ ok: false, error: "grant_invalid" });
    expect(await askFor(made, null, "whose", {}, { org: "org_other", aud: "org_other" })).toEqual({
      ok: false,
      error: "grant_invalid",
    });
    expect(ledger.seen).toEqual([]);
    await made.host.audit.flush();
    const refusals = await askRecords(made.paths);
    // The three are one refusal to the trail: the first at once, and one more
    // record for the two that followed. None names an organization.
    expect(
      refusals.map((record) => {
        const params = record.params as { rule: string; attempts?: number };
        return [record.outcome, params.rule, params.attempts ?? 1];
      }),
    ).toEqual([
      ["refused", "grant_organization", 1],
      ["refused", "grant_organization", 2],
    ]);
    for (const record of refusals) expect(record.params).not.toHaveProperty("organization");
    expect(JSON.stringify(await spoolRecords(made.paths))).not.toContain(ALDER);
  });

  test("gives a module its organization's id only when the module asks for it", async () => {
    const { rig: made, ledger } = await ledgerRig();
    await askFor(made, null, "whose");
    const file = path.join(made.paths.root, "identity", "organization.json");
    expect(existsSync(file)).toBe(false);
    const id = ledger.last!.organization.id;
    expect(isOrganizationId(id)).toBe(true);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ id });
    // It is not the id the control plane knows the organization by.
    expect(id).not.toBe(ORG);
    // The same on every later ask, and after a restart.
    await askFor(made, null, "whose");
    expect(ledger.last!.organization.id).toBe(id);
  });
});

// ── A Fortress that holds more than one ──────────────────────────────────────

describe("a Fortress that holds another organization", () => {
  const held = [
    { id: ALDER, modules: ["ledger"], keys: { ledger: { "ledger-token": "alder-ledger-token" } } },
    { id: BIRCH, modules: ["ledger"] },
    { id: CEDAR, modules: [] },
  ];

  test("hands the module the context of the organization the grant names", async () => {
    const { rig: made, ledger } = await ledgerRig(held);
    expect(await askFor(made, ALDER, "whose")).toEqual({ ok: true, payload: { own: false } });
    expect(ledger.last!.organization).toEqual({ id: ALDER, own: false });
    expect(await askFor(made, null, "whose")).toEqual({ ok: true, payload: { own: true } });
    expect(await askFor(made, BIRCH, "whose")).toEqual({ ok: true, payload: { own: false } });
    expect(ledger.seen).toEqual([
      { id: ALDER, own: false },
      { id: null, own: true },
      { id: BIRCH, own: false },
    ]);
  });

  test("keeps each organization's state apart, and the own organization's where it always was", async () => {
    const { rig: made } = await ledgerRig(held);
    await askFor(made, null, "note.write", { value: 1 });
    await askFor(made, ALDER, "note.write", { value: 2 });
    expect(await askFor(made, null, "note.read")).toEqual({ ok: true, payload: { value: 1, written: true } });
    expect(await askFor(made, ALDER, "note.read")).toEqual({ ok: true, payload: { value: 2, written: true } });
    // Birch wrote nothing, and sees nothing of anybody's.
    expect(await askFor(made, BIRCH, "note.read")).toEqual({ ok: true, payload: { value: 0, written: false } });

    const read = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, "utf8"));
    expect(await read(path.join(made.paths.moduleState("ledger"), "note.json"))).toEqual({ value: 1 });
    expect(
      await read(path.join(made.paths.root, "organizations", ALDER, "modules", "ledger", "state", "note.json")),
    ).toEqual({ value: 2 });
    expect(existsSync(path.join(made.paths.root, "organizations", BIRCH))).toBe(false);
    const file = path.join(made.paths.root, "organizations", ALDER, "modules", "ledger", "state", "note.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test("reads each organization's key under that organization's name, and never lends one out", async () => {
    const { rig: made } = await ledgerRig(held);
    made.secrets.values = { "ledger-token": SECRET_VALUE, "alder-ledger-token": "alder-key-value" };
    expect(await askFor(made, ALDER, "key.use")).toEqual({ ok: true, payload: { length: "alder-key-value".length } });
    // Birch has no name for this key. It gets no key: not Northstar's, not Alder's.
    expect(await askFor(made, BIRCH, "key.use")).toEqual({ ok: false, error: "failed:secret_missing" });
    expect(await askFor(made, null, "key.use")).toEqual({ ok: true, payload: { length: SECRET_VALUE.length } });
    expect(made.secrets.reads).toEqual(["alder-ledger-token", "ledger-token"]);

    // Alder's name is there and its key is not: missing, and still nobody else's.
    made.secrets.values = { "ledger-token": SECRET_VALUE };
    expect(await askFor(made, ALDER, "key.use")).toEqual({ ok: false, error: "failed:secret_missing" });
  });

  test("a module is on for an organization only when its entry lists it", async () => {
    const { rig: made, ledger } = await ledgerRig(held);
    expect(await askFor(made, CEDAR, "whose")).toEqual({ ok: false, error: "module_off" });
    expect(ledger.seen).toEqual([]);
    // And off for everybody when it is off for the Fortress.
    await writeConfig(made.paths, ["session_vault"]);
    expect(await askFor(made, ALDER, "whose")).toEqual({ ok: false, error: "module_off" });
    expect(await askFor(made, null, "whose")).toEqual({ ok: false, error: "module_off" });
  });

  test("the context of an ask is one organization's: it lists nobody, and only the own one has the enrollment's identity", async () => {
    const { rig: made, ledger } = await ledgerRig(held);
    made.registry.setFortressIdentity({ orgId: ORG, fortressId: "fortress-1", credential: "c" });
    expect(await askFor(made, ALDER, "handed")).toEqual({ ok: true, payload: { lists: false, identity: false } });
    expect(ledger.last!.fortressIdentity).toBeNull();
    expect(await askFor(made, null, "handed")).toEqual({ ok: true, payload: { lists: false, identity: true } });
    // The context the module was started with is the own organization's, and
    // it is the one that can list the others.
    expect(ledger.started!.organization.own).toBe(true);
    expect("organizations" in ledger.started!).toBe(true);
    expect(ledger.started!.fortressIdentity).toEqual({ orgId: ORG, fortressId: "fortress-1", credential: "c" });
  });

  test("gives the context a module is started with the contexts of the organizations it is on for, its own first", async () => {
    const { rig: made, ledger } = await ledgerRig(held);
    expect(await askFor(made, ALDER, "others")).toEqual({ ok: true, payload: { contexts: 3, first: true } });
    const contexts = await ledger.started!.organizations();
    expect(contexts.map((context) => (context.organization.own ? "own" : context.organization.id))).toEqual([
      "own",
      ALDER,
      BIRCH,
    ]);
    // None of them can list anybody in turn.
    for (const context of contexts) expect("organizations" in context).toBe(false);
    // Each one's state is its own.
    await contexts[1]!.state.write("cursor", 5);
    expect(await contexts[0]!.state.read("cursor")).toBeNull();
    expect(await contexts[2]!.state.read("cursor")).toBeNull();
    expect(await contexts[1]!.state.read<number>("cursor")).toBe(5);
    // Switched off for the Fortress: on for nobody.
    await writeConfig(made.paths, ["session_vault"]);
    expect(await ledger.started!.organizations()).toEqual([]);
  });

  test("a context a module kept stops reading secrets when its organization leaves the list", async () => {
    const { rig: made, ledger } = await ledgerRig(held);
    made.secrets.values = { "ledger-token": SECRET_VALUE, "alder-ledger-token": "alder-key-value" };
    await askFor(made, ALDER, "whose");
    const kept = ledger.last!;
    expect(await kept.secrets.get("ledger-token")).toBe("alder-key-value");
    // The entry no longer lists the module. Its names stay in the file.
    await writeOrganizations(made.paths, [
      { id: ALDER, modules: [], keys: { ledger: { "ledger-token": "alder-ledger-token" } } },
    ]);
    await expect(kept.secrets.get("ledger-token")).rejects.toThrow('secret "ledger-token" is not set');
    expect(await kept.secrets.has("ledger-token")).toBe(false);
    // Off the list altogether: the same.
    await writeOrganizations(made.paths, []);
    await expect(kept.secrets.get("ledger-token")).rejects.toThrow('secret "ledger-token" is not set');
  });

  test("a secret that is missing is missing under the name the module declared", async () => {
    const { rig: made, ledger } = await ledgerRig(held);
    // Alder's entry names its secret, and the store holds nothing under that name.
    made.secrets.values = { "ledger-token": SECRET_VALUE };
    expect(await askFor(made, ALDER, "key.use")).toEqual({ ok: false, error: "failed:secret_missing" });
    const failure = await ledger.last!.secrets.get("ledger-token").catch((thrown: unknown) => thrown);
    expect(failure).toMatchObject({ name: "SecretMissing", secretName: "ledger-token" });
    expect((failure as Error).message).toBe('secret "ledger-token" is not set');
    // The name from the list is in no reply and no log line.
    expect(JSON.stringify(made.logs)).not.toContain("alder-ledger-token");
  });

  test("records whose ask it was, on both halves, and never lets a module say otherwise", async () => {
    const { rig: made } = await ledgerRig(held);
    await askFor(made, ALDER, "record");
    await askFor(made, null, "record");
    await askFor(made, CEDAR, "whose");
    await askFor(made, ALDER, "fail");
    await made.host.audit.flush();
    const records = await spoolRecords(made.paths);
    const of = (action: string) =>
      records
        .filter((record) => record.action === action)
        .map((record) => [
          record.kind,
          record.outcome,
          (record.params as { organization?: string } | null)?.organization ?? null,
        ]);

    expect(of("relay.ask")).toEqual([
      // Alder's ask: the intent and the outcome both say whose.
      ["intent", null, ALDER],
      ["outcome", "ok", ALDER],
      // Northstar's own: nothing says whose, as on a Fortress with one organization.
      ["intent", null, null],
      ["outcome", "ok", null],
      // Refused after the grant verified: the refusal is Cedar's.
      ["outcome", "refused", CEDAR],
      // A failure is recorded as Alder's too.
      ["intent", null, ALDER],
      ["outcome", "failed", ALDER],
    ]);
    // The module passed `organization: birch-books` both times. The host's word stands.
    expect(of("module.ledger.entry.added")).toEqual([
      ["outcome", "done", ALDER],
      ["outcome", "done", null],
    ]);
    expect(JSON.stringify(records)).not.toContain(BIRCH);
    // An outcome carries whose it is and nothing else.
    const outcome = records.find((record) => record.action === "relay.ask" && record.kind === "outcome");
    expect(outcome?.params).toEqual({ organization: ALDER });
  });

  test("counts repeated refusals for each organization on their own", async () => {
    const { rig: made } = await ledgerRig(held);
    for (let i = 0; i < 4; i += 1) await askFor(made, CEDAR, "whose");
    for (let i = 0; i < 2; i += 1) await askFor(made, ALDER, "note.write", { value: -1 });
    await made.host.audit.flush();
    const refusals = (await askRecords(made.paths)).map((record) => {
      const params = record.params as { organization?: string; rule: string; attempts?: number };
      return [params.organization, params.rule, params.attempts ?? 1];
    });
    expect(refusals).toEqual([
      [CEDAR, "module_off", 1],
      [ALDER, "args_not_a_count", 1],
      [CEDAR, "module_off", 3],
      [ALDER, "args_not_a_count", 1],
    ]);
  });

  test("refuses an organization that is not on the list, and one addressed to another Fortress", async () => {
    const { rig: made, ledger } = await ledgerRig(held);
    expect(await askFor(made, "dogwood-diner", "whose")).toEqual({ ok: false, error: "grant_invalid" });
    // A listed organization, in a grant addressed to another Fortress.
    expect(await askFor(made, ALDER, "whose", {}, { aud: ALDER })).toEqual({ ok: false, error: "grant_invalid" });
    expect(await askFor(made, ALDER, "whose", {}, { aud: "org_other" })).toEqual({ ok: false, error: "grant_invalid" });
    // An id that is no id at all.
    for (const org of ["../northstar", "", 7, null, ["alder-dental"]]) {
      expect(await askFor(made, null, "whose", {}, { org })).toEqual({ ok: false, error: "grant_invalid" });
    }
    expect(ledger.seen).toEqual([]);
    await made.host.audit.flush();
    const records = await spoolRecords(made.paths);
    // Each is the same refusal, recorded as the Fortress's own: nothing the
    // other side sent is written down.
    for (const record of records.filter((r) => r.action === "relay.ask")) {
      expect((record.params as { rule: string }).rule).toBe("grant_organization");
      expect(record.params).not.toHaveProperty("organization");
    }
    expect(JSON.stringify(records)).not.toContain("dogwood");
  });

  test("a grant for one organization is no grant for another", async () => {
    const { rig: made, ledger } = await ledgerRig(held);
    // The grant commits to one organization: it is a signed claim. A frame that
    // reuses Alder's grant is Alder's ask, whatever else is in the frame.
    const grant = await made.key.grant("ledger", "whose", {}, { org: ALDER });
    expect(await ask(made, "ledger", "whose", {}, grant)).toEqual({ ok: true, payload: { own: false } });
    expect(ledger.seen).toEqual([{ id: ALDER, own: false }]);
    // And it works once, for Alder too.
    expect(await ask(made, "ledger", "whose", {}, grant)).toEqual({ ok: false, error: "grant_invalid" });
  });

  test("with a list that cannot be used, holds nobody and still serves its own organization", async () => {
    const { rig: made, ledger } = await ledgerRig(held);
    expect(await askFor(made, ALDER, "whose")).toEqual({ ok: true, payload: { own: false } });
    await writeFile(made.paths.organizations, "{ a typo");
    expect(await askFor(made, ALDER, "whose")).toEqual({ ok: false, error: "grant_invalid" });
    expect(await askFor(made, null, "whose")).toEqual({ ok: true, payload: { own: true } });
    // Fixed: the very next ask is served, with no restart.
    await writeOrganizations(made.paths, held);
    expect(await askFor(made, ALDER, "whose")).toEqual({ ok: true, payload: { own: false } });
    expect(ledger.seen.map((seen) => seen.own)).toEqual([false, true, false]);
    const said = made.logs.filter((record) => record.msg.includes("organizations.json cannot be used"));
    expect(said).toHaveLength(1);
  });

  test("a list that cannot be used is in the log when the Fortress starts, before any ask", async () => {
    const { rig: made } = await ledgerRig([{ id: ALDER, modules: ["ledger"] }, { id: ALDER }]);
    const said = made.logs.filter((record) => record.msg.includes("organizations.json cannot be used"));
    expect(said.map((record) => record.fields)).toEqual([{ defect: "id_listed_twice", entry: 2 }]);
  });

  test("an entry that carries the id the Fortress enrolled as refuses the whole list", async () => {
    // The rig's Fortress enrolled as `ORG`. A valid id is needed to list one.
    const { rig: made } = await ledgerRig([{ id: ALDER, modules: ["ledger"] }]);
    expect(await askFor(made, ALDER, "whose")).toEqual({ ok: true, payload: { own: false } });
    expect(isOrganizationId(ORG)).toBe(false);
    // So the rule is shown on the host's own directory, with an enrolled id that is one.
    const organizations = organizationsOf(made.paths, { enrolledAs: () => ALDER });
    expect(await organizations.held(ALDER, ALDER)).toBeNull();
    expect((await organizations.all()).map((organization) => organization.own)).toEqual([true]);
  });

  test("a grant that names a listed organization and fails another check is the Fortress's own refusal, and looks nothing up", async () => {
    const { rig: made, ledger } = await ledgerRig(held);
    // Every look the gate makes at the list goes through here.
    const looked: string[] = [];
    const directory = made.host.organizations;
    const original = directory.held.bind(directory);
    directory.held = (id, enrolledAs) => {
      looked.push(id);
      return original(id, enrolledAs);
    };
    const refusedAs = async (rule: string): Promise<void> => {
      await made.host.audit.flush();
      const last = (await askRecords(made.paths)).at(-1);
      expect(last?.outcome).toBe("refused");
      expect(last?.params).toEqual({ module: "ledger", ask: "whose", rule });
    };
    // For another ask than the frame's.
    let grant = await made.key.grant("ledger", "whose", {}, { org: ALDER, sub: "ledger:note.read" });
    expect(await ask(made, "ledger", "whose", {}, grant)).toEqual({ ok: false, error: "grant_invalid" });
    await refusedAs("grant_subject");
    // For other arguments.
    grant = await made.key.grant("ledger", "whose", {}, { org: ALDER, scopeHash: "another-hash" });
    expect(await ask(made, "ledger", "whose", {}, grant)).toEqual({ ok: false, error: "grant_invalid" });
    await refusedAs("grant_scope");
    // Expired an hour ago.
    grant = await made.key.grant("ledger", "whose", {}, { org: ALDER }, { iat: Math.floor(made.now.value.getTime() / 1000) - 3600 });
    expect(await ask(made, "ledger", "whose", {}, grant)).toEqual({ ok: false, error: "grant_invalid" });
    await refusedAs("grant_expired");
    // The same three for an organization that is not on the list are refused
    // the same way: a grant that does not verify learns nothing about the list.
    grant = await made.key.grant("ledger", "whose", {}, { org: "dogwood-diner", sub: "ledger:note.read" });
    expect(await ask(made, "ledger", "whose", {}, grant)).toEqual({ ok: false, error: "grant_invalid" });
    await refusedAs("grant_subject");

    // None of them named an organization in the trail, reached the module or
    // made the host look at its list.
    expect(JSON.stringify(await spoolRecords(made.paths))).not.toContain(ALDER);
    expect(ledger.seen).toEqual([]);
    expect(looked).toEqual([]);
    // A grant that verifies is the one that is looked up.
    expect(await askFor(made, ALDER, "whose")).toEqual({ ok: true, payload: { own: false } });
    expect(looked).toEqual([ALDER]);
  });

  test("a list that is broken while the Fortress runs is in the log at the host's next pass, with no ask for another organization", async () => {
    const { rig: made } = await ledgerRig(held);
    const said = (): unknown[] =>
      made.logs.filter((record) => record.msg.includes("organizations.json cannot be used")).map((record) => record.fields);
    expect(said()).toEqual([]);
    await writeFile(made.paths.organizations, "{ a typo");
    // Only the own organization is asked for. Its ask does not read the list.
    expect(await askFor(made, null, "whose")).toEqual({ ok: true, payload: { own: true } });
    expect(said()).toEqual([]);
    // The module host's own pass, which a timer runs every few seconds.
    await made.host.applyRequests();
    expect(said()).toEqual([{ defect: "not_json" }]);
    // The next pass finds the same file and says nothing more.
    await made.host.applyRequests();
    expect(said()).toEqual([{ defect: "not_json" }]);
  });

  test("nothing a frame carries adds an organization or names one outside the grant", async () => {
    const { rig: made, ledger } = await ledgerRig([]);
    // The envelope and the arguments are not where an organization is named.
    const grant = await made.key.grant("ledger", "whose", {});
    const reply = await made.host.asks.handle({
      module: "ledger",
      id: "msg-1",
      kind: "request",
      payload: { v: 1, ask: "whose", args: {}, grant, org: ALDER, organization: ALDER },
    } as never);
    expect(reply).toEqual({ ok: true, payload: { own: true } });
    expect(ledger.seen).toEqual([{ id: null, own: true }]);
    expect(JSON.parse(await readFile(made.paths.organizations, "utf8"))).toEqual({ version: 1, organizations: [] });
    expect(existsSync(path.join(made.paths.root, "organizations"))).toBe(false);
  });
});
