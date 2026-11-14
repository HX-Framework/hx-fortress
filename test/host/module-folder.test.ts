// A module's folder on the disk.
//
// A module keeps small values under `ctx.state`. A module that keeps a
// database file and the files beside it asks the host for a folder:
// `ctx.folder(...names)`. These tests hold the host to four things. The folder
// is the module's and the organization's own. Only this HX Fortress's user can
// read it. No name a module passes gets out of it. And an organization that
// this HX Fortress no longer holds gets no folder.

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  failureCode,
  failureForLog,
  FOLDER_MAX_DEPTH,
  FolderRefused,
  type ModuleContextV2,
  type ModuleStartContext,
} from "../../src/host/module-contract";
import {
  ask,
  createProbeModule,
  makeRig,
  PROBE_CATALOG,
  ROW_VALUE,
  spoolRecords,
  spoolText,
  writeOrganizations,
  type Rig,
} from "./_module-rig";

const ALDER = "alder-dental";
const BIRCH = "birch-books";

let rig: Rig;
afterEach(async () => {
  await rig?.cleanup();
});

/** The context of the probe module's last ask, for this HX Fortress's own
 *  organization or for another one it holds. */
async function contextFor(r: Rig, organization: string | null = null): Promise<ModuleContextV2> {
  const grant = await r.key.grant("probe", "context.probe", {}, organization === null ? {} : { org: organization });
  const reply = await ask(r, "probe", "context.probe", {}, grant);
  if (!reply?.ok) throw new Error(`the ask was refused: ${JSON.stringify(reply)}`);
  const context = r.probe.context;
  if (!context) throw new Error("the module was never called");
  return context;
}

/** A module host that holds these organizations beside its own. */
async function rigHolding(held: readonly unknown[]): Promise<Rig> {
  const made = await makeRig({ enabled: ["session_vault", "probe"], deps: { catalog: PROBE_CATALOG }, start: false });
  rig = made;
  await writeOrganizations(made.paths, held);
  await made.host.start();
  await made.registry.startAll(["session_vault", "probe"]);
  await made.host.started();
  return made;
}

const mode = async (dir: string): Promise<number> => (await stat(dir)).mode & 0o777;

async function refusal(promise: Promise<unknown>): Promise<FolderRefused> {
  const thrown: unknown = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  if (!(thrown instanceof FolderRefused)) throw new Error(`expected a refusal, got ${String(thrown)}`);
  return thrown;
}

describe("a module's folder for its own organization", () => {
  test("is beside its state, made on first use, and only this HX Fortress's user can read it", async () => {
    rig = await makeRig();
    const ctx = await contextFor(rig);
    const root = path.join(rig.paths.root, "modules", "probe");
    // Nothing is made until a module asks.
    expect(await readdir(root).catch(() => [])).not.toContain("data");

    const dir = await ctx.folder();
    expect(dir).toBe(path.join(root, "data"));
    expect(path.isAbsolute(dir)).toBe(true);
    expect(await mode(dir)).toBe(0o700);
    // Beside the state, never inside it.
    expect(dir).not.toContain(`${path.sep}state`);
    expect(rig.paths.moduleState("probe")).toBe(path.join(root, "state"));
  });

  test("each name is one more level, and every level is the user's own", async () => {
    rig = await makeRig();
    const ctx = await contextFor(rig);
    const dir = await ctx.folder("stores", "permits-2027", "snapshots");
    const base = path.join(rig.paths.root, "modules", "probe", "data");
    expect(dir).toBe(path.join(base, "stores", "permits-2027", "snapshots"));
    for (const level of [base, path.join(base, "stores"), path.join(base, "stores", "permits-2027"), dir]) {
      expect([level, await mode(level)]).toEqual([level, 0o700]);
    }
  });

  test("a level that was already there with a wider mode is narrowed", async () => {
    rig = await makeRig();
    const ctx = await contextFor(rig);
    const dir = await ctx.folder("stores", "permits");
    // As a copy from a backup can leave it.
    const base = path.join(rig.paths.root, "modules", "probe", "data");
    for (const level of [base, path.join(base, "stores"), dir]) await chmod(level, 0o755);
    await ctx.folder("stores", "permits");
    for (const level of [base, path.join(base, "stores"), dir]) expect([level, await mode(level)]).toEqual([level, 0o700]);
  });

  test("asking again gives the same folder and keeps what is in it", async () => {
    rig = await makeRig();
    const ctx = await contextFor(rig);
    const first = await ctx.folder("stores", "permits");
    await writeFile(path.join(first, "note.txt"), "kept");
    const second = await (await contextFor(rig)).folder("stores", "permits");
    expect(second).toBe(first);
    expect(await readFile(path.join(second, "note.txt"), "utf8")).toBe("kept");
  });

  test("holds a SQLite file that is there again after the file is closed", async () => {
    rig = await makeRig();
    const dir = await (await contextFor(rig)).folder("stores", "permits");
    const file = path.join(dir, "store.sqlite");
    const first = new Database(file, { create: true });
    first.run("CREATE TABLE permits (permit_no TEXT PRIMARY KEY, issued TEXT)");
    first.run("INSERT INTO permits VALUES ('P-1001', '2027-03-14'), ('P-1002', '2027-03-15')");
    first.close();
    const again = new Database(file, { readonly: true });
    expect(again.query("SELECT count(*) AS n FROM permits").get()).toEqual({ n: 2 });
    again.close();
  });

  test("the context a module is started with has the same folder", async () => {
    const probe = createProbeModule();
    let started: ModuleStartContext | null = null;
    const init = probe.init?.bind(probe);
    probe.init = (context) => {
      started = context as ModuleStartContext;
      return init?.(context);
    };
    rig = await makeRig({ probe });
    if (!started) throw new Error("the module was never started");
    const dir = await (started as ModuleStartContext).folder("stores");
    expect(dir).toBe(path.join(rig.paths.root, "modules", "probe", "data", "stores"));
    expect(dir).toBe(await (await contextFor(rig)).folder("stores"));
  });
});

describe("a name that is not one plain level is refused", () => {
  const REFUSED: readonly unknown[] = [
    "",
    ".",
    "..",
    "../state",
    "a/b",
    "a\\b",
    "/etc",
    "name.with.dot",
    "a:b",
    "a b",
    "-leading",
    "_leading",
    // Upper case: two names must never be one folder on a disk that ignores case.
    "Stores",
    "x".repeat(65),
    "café",
    "nul\u0000",
    "line\nbreak",
    // Not text at all: a module written in good faith can still hand one over.
    7,
    null,
    undefined,
    ["stores"],
    { toString: () => "stores" },
  ];

  test("with one word, nothing is made, and the name is in no record and no message", async () => {
    rig = await makeRig();
    const ctx = await contextFor(rig);
    for (const name of REFUSED) {
      const refused = await refusal(ctx.folder(name as string));
      expect([name, refused.rule]).toEqual([name, "folder_name_invalid"]);
      // What was asked for is never repeated: it may be a value from an ask.
      expect(refused.message).toBe("module probe may not have this folder: folder_name_invalid");
    }
    // A refused name in a later place refuses the whole call: no level before it is made.
    await refusal(ctx.folder("stores", "..", "state"));
    await refusal(ctx.folder("stores", ROW_VALUE));
    const root = path.join(rig.paths.root, "modules", "probe");
    expect(await readdir(root).catch(() => [])).not.toContain("data");

    await rig.host.audit.flush();
    const records = (await spoolRecords(rig.paths)).filter((r) => r.action === "system.module.refused");
    expect(records[0]?.params).toEqual({ module: "probe", rule: "folder_name_invalid" });
    // A run of the same refusal is two records: the first, and one with the count of the rest.
    expect(records).toHaveLength(2);
    const text = await spoolText(rig.paths);
    expect(text).not.toContain(ROW_VALUE);
    expect(text).not.toContain("../state");
  });

  test("the longest name is 64 characters, and it may start with a digit", async () => {
    rig = await makeRig();
    const ctx = await contextFor(rig);
    const longest = "x".repeat(64);
    expect(path.basename(await ctx.folder(longest))).toBe(longest);
    expect(path.basename(await ctx.folder("2027-permits_v2"))).toBe("2027-permits_v2");
  });

  test(`at most ${FOLDER_MAX_DEPTH} levels`, async () => {
    rig = await makeRig();
    const ctx = await contextFor(rig);
    const four = ["a", "b", "c", "d"];
    expect(await ctx.folder(...four)).toEndWith(path.join("data", ...four));
    expect((await refusal(ctx.folder(...four, "e"))).rule).toBe("folder_too_deep");
    // Nothing of the refused call was made.
    expect(await readdir(await ctx.folder(...four))).toEqual([]);
  });

  test("a refusal has its own word wherever a failure is named", () => {
    expect(failureCode(new FolderRefused("probe", "folder_name_invalid"))).toBe("folder_name_invalid");
    expect(failureCode(new FolderRefused("probe", "folder_too_deep"))).toBe("folder_too_deep");
    expect(failureCode(new FolderRefused("probe", "organization_not_held"))).toBe("organization_not_held");
    expect(failureForLog(new FolderRefused("probe", "folder_too_deep"))).toEqual({
      code: "folder_too_deep",
      error: "module probe may not have this folder: folder_too_deep",
    });
  });
});

describe("a module's folder for another organization this HX Fortress holds", () => {
  const held = [
    { id: ALDER, modules: ["probe"] },
    { id: BIRCH, modules: ["probe"] },
  ];

  test("is that organization's own, and a file in one is in no other", async () => {
    const made = await rigHolding(held);
    const own = await (await contextFor(made)).folder("stores");
    const alder = await (await contextFor(made, ALDER)).folder("stores");
    const birch = await (await contextFor(made, BIRCH)).folder("stores");
    expect(own).toBe(path.join(made.paths.root, "modules", "probe", "data", "stores"));
    expect(alder).toBe(path.join(made.paths.root, "organizations", ALDER, "modules", "probe", "data", "stores"));
    expect(birch).toBe(path.join(made.paths.root, "organizations", BIRCH, "modules", "probe", "data", "stores"));
    expect(await mode(alder)).toBe(0o700);
    expect(await mode(path.join(made.paths.root, "organizations", ALDER))).toBe(0o700);

    await writeFile(path.join(alder, "store.sqlite"), "alder's");
    expect(await readdir(own)).toEqual([]);
    expect(await readdir(birch)).toEqual([]);
    expect(await readdir(alder)).toEqual(["store.sqlite"]);
  });

  test("an organization that left the list gets no folder, and what it left stays on the disk", async () => {
    const made = await rigHolding(held);
    const ctx = await contextFor(made, ALDER);
    const dir = await ctx.folder("stores");
    await writeFile(path.join(dir, "store.sqlite"), "alder's");

    // Whoever runs this HX Fortress takes the organization off the list. The
    // module still holds the context it was handed.
    await writeOrganizations(made.paths, [{ id: BIRCH, modules: ["probe"] }]);
    expect((await refusal(ctx.folder("stores"))).rule).toBe("organization_not_held");
    expect((await refusal(ctx.folder())).rule).toBe("organization_not_held");
    // Nothing is removed: a person removes a folder.
    expect(await readFile(path.join(dir, "store.sqlite"), "utf8")).toBe("alder's");
    // The other organization is not affected.
    expect(await (await contextFor(made, BIRCH)).folder("stores")).toContain(BIRCH);

    await made.host.audit.flush();
    const refused = (await spoolRecords(made.paths)).filter(
      (r) => r.action === "system.module.refused" && (r.params as { rule?: string } | null)?.rule === "organization_not_held",
    );
    expect(refused.length).toBeGreaterThanOrEqual(1);
  });

  test("an organization whose entry stopped listing the module gets no folder either", async () => {
    const made = await rigHolding(held);
    const ctx = await contextFor(made, ALDER);
    await ctx.folder("stores");
    await writeOrganizations(made.paths, [{ id: ALDER, modules: [] }, { id: BIRCH, modules: ["probe"] }]);
    expect((await refusal(ctx.folder("stores"))).rule).toBe("organization_not_held");
    // Listed again: the folder is there as it was.
    await writeOrganizations(made.paths, held);
    expect(await ctx.folder("stores")).toContain(path.join("organizations", ALDER));
  });

  test("a name is checked before the list is read: a bad name is never an organization's fault", async () => {
    const made = await rigHolding(held);
    const ctx = await contextFor(made, ALDER);
    await writeOrganizations(made.paths, []);
    expect((await refusal(ctx.folder(".."))).rule).toBe("folder_name_invalid");
  });
});
