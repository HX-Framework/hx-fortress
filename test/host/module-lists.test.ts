// The two lists a person adds to, as files: what an entry must be, what a file
// that cannot be read means, and that two changes at once both land. And what
// the terminal and the What Leaves page say about acts and about these lists.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { runModulesVerb } from "../../src/cli-modules";
import {
  isAddableSecretName,
  isReachName,
  LIST_MAX_ENTRIES,
  ListUnreadable,
  ModuleLists,
  recordable,
} from "../../src/host/module-lists";
import { listModules, moduleDataPaths } from "../../src/host/modules-api";
import { UI_CONFIG_DEFAULTS } from "../../src/ui/config";
import { dataPathRows, type EgressInputs } from "../../src/ui/egress";
import { act, ACTS_CATALOG, makeActsRig, type ActsRig } from "./_acts-rig";
import { PROBE_CATALOG, tempRoot, writeConfig } from "./_module-rig";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function listsDir(): Promise<string> {
  const { paths, cleanup } = await tempRoot();
  cleanups.push(cleanup);
  return path.dirname(paths.moduleState("probe"));
}

const AT = "2027-03-14T09:00:00.000Z";
const reach = (name: string, host = "db.northstar.example", port = 5432) => ({ name, host, port, addedBy: "maya.chen", addedAt: AT });

// Made-up texts that look like a credential, as the audit trail's redaction
// sees one. Each is put together when the test runs: written out in one piece,
// the repository's own secret scan takes it for a real one, in every commit
// that holds it.
const MADE_UP = ["abcdefgh", "12345"].join("");
const LOOKS_LIKE_A_TOKEN = ["token", ": ", MADE_UP].join("");
const LOOKS_LIKE_A_BEARER = ["bearer", " ", MADE_UP].join("");

describe("what a list takes for a name", () => {
  test("a reach's name is a name of 1 to 64 characters that an audit record can hold", () => {
    for (const name of ["orders-1", "Northstar permits", "c1:1", "a", "x".repeat(64)]) {
      expect([name, isReachName(name)]).toEqual([name, true]);
    }
    for (const name of ["", " ", " padded", "padded ", "x".repeat(65), "semi;colon", "new\nline", LOOKS_LIKE_A_TOKEN, LOOKS_LIKE_A_BEARER, 7, null, undefined]) {
      expect([name, isReachName(name)]).toEqual([name, false]);
    }
  });

  test("a secret's name is the rule of every key store, and not one that looks like a credential", () => {
    for (const name of ["permits-reader", "a", "key-1", "x".repeat(64)]) {
      expect([name, isAddableSecretName(name)]).toEqual([name, true]);
    }
    for (const name of ["", "Permits-Reader", "permits_reader", "permits reader", "x".repeat(65), "sk-production-database-reader", 7, null]) {
      expect([name, isAddableSecretName(name)]).toEqual([name, false]);
    }
  });

  test("a text the audit trail would replace is not one a record can hold", () => {
    expect(recordable("sql01.northstar.example")).toBe(true);
    expect(recordable("postgres://reader:hunter2@db.northstar.example/billing")).toBe(false);
    expect(recordable("password=hunter2")).toBe(false);
  });
});

describe("the list of hosts, as a file", () => {
  test("an entry is added, found and removed, and the file is this user's only", async () => {
    const dir = await listsDir();
    const list = new ModuleLists().reaches(dir);
    expect(await list.list()).toEqual([]);
    expect(await list.find("orders-1")).toBeNull();
    expect(await list.add(reach("orders-1"))).toEqual({ ok: true });
    expect(await list.find("orders-1")).toEqual({ host: "db.northstar.example", port: 5432 });
    expect(await list.list()).toEqual([reach("orders-1")]);
    expect((await stat(path.join(dir, "reach.json"))).mode & 0o777).toBe(0o600);
    expect(await list.remove("orders-1")).toBe(true);
    expect(await list.remove("orders-1")).toBe(false);
    expect(await list.list()).toEqual([]);
    // No temporary file is left beside it.
    expect((await readdir(dir)).sort()).toEqual(["reach.json"]);
  });

  test("it refuses with the words this HX Fortress's one list of hosts will use, and changes nothing", async () => {
    const dir = await listsDir();
    const list = new ModuleLists().reaches(dir);
    await list.add(reach("orders-1"));
    expect(await list.add(reach("orders-1", "other.northstar.example"))).toEqual({ ok: false, reason: "name_taken" });
    expect(await list.add(reach("own", "127.0.0.1"))).toEqual({ ok: false, reason: "host_not_allowed" });
    expect(await list.add(reach("meta", "169.254.169.254"))).toEqual({ ok: false, reason: "host_not_allowed" });
    expect(await list.add(reach("bad", "not a host"))).toEqual({ ok: false, reason: "not_a_host" });
    expect(await list.add(reach("bad", "db.northstar.example", 0))).toEqual({ ok: false, reason: "not_a_host" });
    // An entry that is not one is the caller's mistake, and is not written.
    await expect(list.add({ ...reach("ok"), addedAt: "yesterday" })).rejects.toThrow(TypeError);
    await expect(list.add({ ...reach(""), })).rejects.toThrow(TypeError);
    expect(await list.list()).toEqual([reach("orders-1")]);
    for (let i = 1; i < LIST_MAX_ENTRIES; i += 1) expect(await list.add(reach(`db-${i}`))).toEqual({ ok: true });
    expect(await list.add(reach("one-more"))).toEqual({ ok: false, reason: "too_many" });
  });

  test("changes made at the same moment all land", async () => {
    const dir = await listsDir();
    const lists = new ModuleLists();
    // Two handles on the same file, as two acts at once have.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => lists.reaches(dir).add(reach(`db-${i}`))),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect((await lists.reaches(dir).list()).map((entry) => entry.name).sort()).toEqual(
      Array.from({ length: 20 }, (_, i) => `db-${i}`).sort(),
    );
    const removed = await Promise.all(Array.from({ length: 20 }, (_, i) => lists.reaches(dir).remove(`db-${i}`)));
    expect(removed.every(Boolean)).toBe(true);
    expect(await lists.reaches(dir).list()).toEqual([]);
  });

  test("a file that fails any check is not a list: nothing is found in it, added to it or written over it", async () => {
    const dir = await listsDir();
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "reach.json");
    const list = new ModuleLists().reaches(dir);
    const entry = reach("orders-1");
    const broken: [string, string][] = [
      ["not JSON", "{ not json"],
      ["a list, not an object", "[]"],
      ["another version", JSON.stringify({ version: 2, entries: [entry] })],
      ["no entries", JSON.stringify({ version: 1 })],
      ["an entry with a loopback address", JSON.stringify({ version: 1, entries: [{ ...entry, host: "127.0.0.1" }] })],
      ["an entry with a metadata name", JSON.stringify({ version: 1, entries: [{ ...entry, host: "metadata.google.internal" }] })],
      ["an entry with no port", JSON.stringify({ version: 1, entries: [{ ...entry, port: "5432" }] })],
      ["an entry with a name that is not one", JSON.stringify({ version: 1, entries: [{ ...entry, name: "" }] })],
      ["an entry with no time", JSON.stringify({ version: 1, entries: [{ ...entry, addedAt: "today" }] })],
      ["an entry that is not an object", JSON.stringify({ version: 1, entries: ["orders-1"] })],
      ["the same name twice", JSON.stringify({ version: 1, entries: [entry, entry] })],
      ["more entries than a list holds", JSON.stringify({ version: 1, entries: Array.from({ length: 65 }, (_, i) => reach(`db-${i}`)) })],
      ["a file far too large", JSON.stringify({ version: 1, entries: [], padding: "x".repeat(300_000) })],
    ];
    for (const [what, content] of broken) {
      await writeFile(file, content);
      await expect(list.list()).rejects.toBeInstanceOf(ListUnreadable);
      await expect(list.remove("orders-1")).rejects.toBeInstanceOf(ListUnreadable);
      expect([what, await list.find("orders-1")]).toEqual([what, null]);
      expect([what, await list.add(reach("new"))]).toEqual([what, { ok: false, reason: "list_unreadable" }]);
      expect([what, await readFile(file, "utf8")]).toEqual([what, content]);
    }
    // A folder where the file should be is not an empty list either.
    const other = await listsDir();
    await mkdir(path.join(other, "reach.json"), { recursive: true });
    await expect(new ModuleLists().reaches(other).list()).rejects.toBeInstanceOf(ListUnreadable);
  });
});

describe("the list of secret names, as a file", () => {
  test("a name is added once, found and removed", async () => {
    const dir = await listsDir();
    const list = new ModuleLists().secretNames(dir);
    const entry = { name: "permits-reader", addedBy: "maya.chen", addedAt: AT };
    expect(await list.has("permits-reader")).toBe(false);
    expect(await list.add(entry)).toEqual({ ok: true, added: true });
    expect(await list.add({ ...entry, addedBy: "somebody.else" })).toEqual({ ok: true, added: false });
    expect(await list.list()).toEqual([entry]);
    expect(await list.has("permits-reader")).toBe(true);
    expect((await stat(path.join(dir, "secret-names.json"))).mode & 0o777).toBe(0o600);
    expect(await list.remove("permits-reader")).toBe(true);
    expect(await list.has("permits-reader")).toBe(false);
    await expect(list.add({ ...entry, name: "Not A Name" })).rejects.toThrow(TypeError);
  });

  test("a file that cannot be read holds no name, and nothing is written over it", async () => {
    const dir = await listsDir();
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "secret-names.json");
    const content = JSON.stringify({ version: 1, entries: [{ name: "Not A Name", addedBy: "x", addedAt: AT }] });
    await writeFile(file, content);
    const list = new ModuleLists().secretNames(dir);
    expect(await list.has("Not A Name")).toBe(false);
    await expect(list.list()).rejects.toBeInstanceOf(ListUnreadable);
    expect(await list.add({ name: "permits-reader", addedBy: "maya.chen", addedAt: AT })).toEqual({ ok: false, reason: "list_unreadable" });
    expect(await readFile(file, "utf8")).toBe(content);
  });
});

describe("what the terminal and the What Leaves page say", () => {
  let rig: ActsRig;
  afterEach(async () => {
    await rig?.cleanup();
  });
  const egress = (modules: EgressInputs["modules"]): EgressInputs => ({
    ui: { ...UI_CONFIG_DEFAULTS, bind: "127.0.0.1", trustedProxies: [] },
    boundPort: 8788,
    postgres: { mode: "embedded", host: "127.0.0.1", port: 54329, database: "hx" },
    cloudUrl: "wss://control.example/v1/connection",
    downloadBase: "https://control.example/download",
    postgresBinariesUrl: "https://repo.example/binaries",
    bucket: null,
    embeddingEndpoint: null,
    ssoAdvertised: false,
    rosterRetentionDays: 90,
    ...(modules ? { modules } : {}),
  });

  test("`hx-fortress modules list` prints each act with who may do it, and nothing new for a module without acts", async () => {
    rig = await makeActsRig();
    const out: string[] = [];
    expect(await runModulesVerb(["list"], { fortressRoot: rig.paths.root, catalog: ACTS_CATALOG, writeLine: (line) => out.push(line) })).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("probe (Probe): on");
    expect(text).toContain("Acts:     12. A person signed in to this HX Fortress's console may have it do these");
    expect(text).toContain("    things.read (every signed-in person)");
    expect(text).toContain("    thing.add (operators only)");
    // A module with no acts is listed as it was.
    const before: string[] = [];
    await runModulesVerb(["list"], { fortressRoot: rig.paths.root, catalog: PROBE_CATALOG, writeLine: (line) => before.push(line) });
    expect(before.join("\n")).not.toContain("Acts:");
    const views = await listModules(rig.paths, { catalog: ACTS_CATALOG });
    expect(views.find((view) => view.id === "probe")?.acts.map((view) => `${view.name} ${view.role}`).slice(0, 2)).toEqual([
      "things.read readonly",
      "thing.add operator",
    ]);
    expect(views.find((view) => view.id === "session_vault")?.acts).toEqual([]);
  });

  test("the page lists the acts and what a person added, only while a module that takes acts is on", async () => {
    rig = await makeActsRig();
    await act(rig, "thing.add", { name: "orders-1", host: "db.northstar.example", port: 1433, keyName: "orders-reader" });
    const source = { cloudUrl: "wss://control.example/v1/connection", env: {} };
    const on = await moduleDataPaths(rig.paths, source, { catalog: ACTS_CATALOG });
    const rows = dataPathRows(egress(on));
    const acts = rows.find((row) => row.id === "module-acts");
    const reach = rows.find((row) => row.id === "module-reach");
    expect(acts?.peer).toContain("127.0.0.1");
    expect(acts?.carries).toContain("12 acts of probe");
    expect(acts?.notes).toContain("probe thing.add - operators only");
    expect(acts?.notes).toContain("probe things.read - every signed-in person");
    expect(reach?.peer).toBe("db.northstar.example:1433");
    expect(reach?.notes).toContain(`probe: orders-1 is db.northstar.example:1433, added by maya.chen on ${rig.now.value.toISOString().slice(0, 10)}`);
    expect(reach?.notes?.join("\n")).toContain("orders-reader");
    expect(reach?.carries).toContain("nothing yet");

    // A list that cannot be read is said to be so, and none of it is shown as used.
    await writeFile(path.join(path.dirname(rig.paths.moduleState("probe")), "reach.json"), "{ not json");
    const broken = dataPathRows(egress(await moduleDataPaths(rig.paths, source, { catalog: ACTS_CATALOG }))).find((row) => row.id === "module-reach");
    expect(broken?.peer).toBe("not readable");
    expect(broken?.notes?.[0]).toContain("cannot be read");

    // Switched off: the two rows are not on the page, and the others are as they were.
    await writeConfig(rig.paths, ["session_vault"]);
    const off = dataPathRows(egress(await moduleDataPaths(rig.paths, source, { catalog: ACTS_CATALOG })));
    expect(off.map((row) => row.id)).not.toContain("module-acts");
    expect(off.map((row) => row.id)).not.toContain("module-reach");
    expect(off.map((row) => row.id)).toEqual(dataPathRows(egress(undefined)).map((row) => row.id));
  });
});
