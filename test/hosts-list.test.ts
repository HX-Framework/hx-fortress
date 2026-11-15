// The one list of hosts: what `add` refuses, the host rule, the stored file,
// and the order of the whole list.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ADD_REFUSALS,
  HostsList,
  HostsListUnreadable,
  MANIFEST_WHY,
  REACHES_MAX,
  ReachEntryInvalid,
  UNREADABLE_ADDRESS,
  hostAllowed,
  type HostEntry,
  type ReachEntry,
} from "../src/host/hosts-list";
import type { CatalogEntry } from "../src/host/module-catalog";
import { fortressPaths } from "../src/host/paths";
import { CONNECTIONS_MAX } from "../src/modules/databases/manifest";
import { defaultAnswers, type SetupAnswers } from "../src/setup/answers";
import { STEP_IDS } from "../src/setup/list";
import { reachOf } from "../src/setup/reach";

type Paths = ReturnType<typeof fortressPaths>;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempPaths(): Promise<Paths> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-hosts-"));
  roots.push(root);
  return fortressPaths(root);
}

/** Modules for these tests. Their order here is not the order of their ids. */
const CATALOG: readonly CatalogEntry[] = [
  { id: "session_vault", title: "Agentic Sessions", summary: "sessions", manifest: null, startOnly: true },
  {
    id: "weather",
    title: "Weather",
    summary: "forecasts",
    manifest: { id: "weather", asks: [], egress: ["api.weather.example", "*.tiles.example"], secrets: [] },
    startOnly: false,
  },
  {
    id: "databases",
    title: "Databases",
    summary: "databases",
    manifest: { id: "databases", asks: [], egress: [], secrets: [] },
    startOnly: false,
  },
  {
    id: "billing",
    title: "Billing",
    summary: "invoices",
    manifest: { id: "billing", asks: [], egress: ["pay.billing.example"], secrets: [] },
    startOnly: false,
  },
];

const MODULE_IDS = CATALOG.map((entry) => entry.id);

/** Answers that make no outside call at all. A database beside HX Fortress on
 *  a machine with Docker downloads nothing. */
function quietAnswers(): SetupAnswers {
  const answers = defaultAnswers(MODULE_IDS);
  answers.where = { place: "docker", region: "", ssh: "" };
  return answers;
}

/**
 * Answers that name one outside service in most questions, each address with
 * a user name or a query string in it. `reachOf` gives their rows in another
 * order than the order of the questions.
 */
function busyAnswers(): SetupAnswers {
  const answers = defaultAnswers(MODULE_IDS, { on: ["session_vault"] });
  answers.where = { place: "aws", region: "eu-west-1", ssh: "" };
  answers.keys.store = "aws-secrets-manager";
  answers.data.database = { store: "existing", address: "db-url" };
  answers.data.files = {
    ...answers.data.files,
    store: "s3-compatible",
    address: "https://files.northstar.example:9000",
    bucket: "sessions",
  };
  answers.signIn = {
    ...answers.signIn,
    provider: "openid-connect",
    issuer: "https://admin:hunter2@idp.northstar.example/realms/northstar?client_secret=abc",
    clientId: "hx-fortress",
  };
  answers.model = {
    ...answers.model,
    provider: "openai",
    route: "direct",
    address: "https://models.northstar.example/v1?api-key=sk-live-123",
    key: "model-key",
  };
  answers.auditTrail = {
    copyTo: "webhook",
    copyAddress: "https://hooks.northstar.example/trail?token=abc",
    keepFor: "until-removed",
  };
  answers.controlPlane = { connect: "yes", address: "control.example", token: "", connected: "on", pages: "" };
  return answers;
}

function listAt(paths: Paths, answers: () => SetupAnswers = quietAnswers): HostsList {
  return new HostsList(paths, { catalog: CATALOG, answers: async () => answers() });
}

function reach(fields: Partial<ReachEntry> = {}): ReachEntry {
  return {
    kind: "reach",
    module: "databases",
    name: "sales-1",
    host: "db.northstar.example",
    port: 5432,
    addedBy: "marta.lindqvist@northstar.example",
    addedAt: "2026-11-14T10:00:00.000Z",
    ...fields,
  };
}

/** The file's bytes, or null when there is no file. */
async function bytesOf(file: string): Promise<string | null> {
  return readFile(file, "utf8").catch(() => null);
}

/** A file of reaches as `add` writes one. */
async function writeReaches(paths: Paths, reaches: readonly ReachEntry[]): Promise<void> {
  await writeFile(paths.hostsList, `${JSON.stringify({ version: 1, reaches }, null, 2)}\n`, { mode: 0o600 });
}

describe("add, find and list", () => {
  test("add keeps a reach, and find and list give it back", async () => {
    const paths = await tempPaths();
    const list = listAt(paths);

    expect(await list.add(reach())).toEqual({ ok: true });

    expect(paths.hostsList).toBe(path.join(path.dirname(paths.config), "hosts.json"));
    expect(await list.find("databases", null, "sales-1")).toEqual({ host: "db.northstar.example", port: 5432 });
    expect(await list.list("databases", null)).toEqual([reach()]);
    const stored = JSON.parse((await bytesOf(paths.hostsList)) ?? "null");
    // The own organization's reach has no organization field, and nothing
    // that is worked out is stored.
    expect(stored).toEqual({ version: 1, reaches: [reach()] });
  });

  test("the host is kept in lower case, without brackets or a final dot", async () => {
    const paths = await tempPaths();
    const list = listAt(paths);

    expect(await list.add(reach({ name: "a", host: "DB.Northstar.Example." }))).toEqual({ ok: true });
    expect(await list.add(reach({ name: "b", host: "[2001:DB8::5]" }))).toEqual({ ok: true });

    expect(await list.find("databases", null, "a")).toEqual({ host: "db.northstar.example", port: 5432 });
    expect(await list.find("databases", null, "b")).toEqual({ host: "2001:db8::5", port: 5432 });
  });

  test.each([
    ["10.0.0.5"],
    ["172.16.4.2"],
    ["192.168.1.20"],
    ["100.64.0.7"],
    ["fd12:3456::5"],
    ["::ffff:10.0.0.5"],
  ])("a private address is allowed: %s", async (host) => {
    const paths = await tempPaths();
    expect(await listAt(paths).add(reach({ host }))).toEqual({ ok: true });
  });

  test("the same host and port under another name is allowed", async () => {
    const paths = await tempPaths();
    const list = listAt(paths);

    expect(await list.add(reach({ name: "sales" }))).toEqual({ ok: true });
    expect(await list.add(reach({ name: "sales-reports" }))).toEqual({ ok: true });
    expect((await list.list("databases", null)).map((entry) => entry.name)).toEqual(["sales", "sales-reports"]);
  });

  test("find reads the file as it is now, not as it was when the list was made", async () => {
    const paths = await tempPaths();
    const reader = listAt(paths);
    const writer = listAt(paths);
    expect(await reader.find("databases", null, "sales-1")).toBeNull();

    await writer.add(reach());
    expect(await reader.find("databases", null, "sales-1")).toEqual({ host: "db.northstar.example", port: 5432 });

    await writer.remove("databases", null, "sales-1");
    expect(await reader.find("databases", null, "sales-1")).toBeNull();
  });

  test("find and list for another module or organization see nothing", async () => {
    const paths = await tempPaths();
    const list = listAt(paths);
    await list.add(reach({ host: "db.northstar.example" }));
    await list.add(reach({ organization: "northstar-eu", host: "db.eu.northstar.example" }));

    expect(await list.find("databases", null, "sales-1")).toEqual({ host: "db.northstar.example", port: 5432 });
    expect(await list.find("databases", "northstar-eu", "sales-1")).toEqual({
      host: "db.eu.northstar.example",
      port: 5432,
    });
    expect(await list.find("weather", null, "sales-1")).toBeNull();
    expect(await list.find("databases", "northstar-us", "sales-1")).toBeNull();
    expect(await list.list("weather", null)).toEqual([]);
    expect(await list.list("databases", "northstar-us")).toEqual([]);
    expect((await list.list("databases", null)).map((entry) => entry.host)).toEqual(["db.northstar.example"]);
    expect((await list.list("databases", "northstar-eu")).map((entry) => entry.host)).toEqual([
      "db.eu.northstar.example",
    ]);
  });

  test("a name is found whatever the case of its letters", async () => {
    const paths = await tempPaths();
    const list = listAt(paths);
    await list.add(reach({ name: "Sales-1" }));

    expect(await list.find("databases", null, "SALES-1")).toEqual({ host: "db.northstar.example", port: 5432 });
  });

  test("find gives nothing for a module, an organization or a name of the wrong shape", async () => {
    const paths = await tempPaths();
    const list = listAt(paths);
    await list.add(reach());

    expect(await list.find("Databases", null, "sales-1")).toBeNull();
    expect(await list.find("databases", "North Star", "sales-1")).toBeNull();
    expect(await list.find("databases", null, "x".repeat(65))).toBeNull();
  });

  test("the list of a module and organization goes by name", async () => {
    const paths = await tempPaths();
    const list = listAt(paths);
    for (const name of ["orders", "Archive", "billing-2", "billing-10"]) await list.add(reach({ name }));

    expect((await list.list("databases", null)).map((entry) => entry.name)).toEqual([
      "Archive",
      "billing-10",
      "billing-2",
      "orders",
    ]);
  });

  test("the limit of reaches is the Databases module's limit of connections", () => {
    expect(REACHES_MAX).toBe(CONNECTIONS_MAX);
  });
});

describe("what add refuses", () => {
  test("the five reasons are the ones the module host was promised", () => {
    expect([...ADD_REFUSALS]).toEqual(["name_taken", "too_many", "not_a_host", "host_not_allowed", "list_unreadable"]);
  });

  test("name_taken: the module and organization already have a reach with this name", async () => {
    const paths = await tempPaths();
    const list = listAt(paths);
    await list.add(reach({ name: "sales" }));
    const before = await bytesOf(paths.hostsList);

    expect(await list.add(reach({ name: "sales", host: "db2.northstar.example" }))).toEqual({
      ok: false,
      reason: "name_taken",
    });
    expect(await list.add(reach({ name: "SALES", host: "db2.northstar.example" }))).toEqual({
      ok: false,
      reason: "name_taken",
    });
    expect(await bytesOf(paths.hostsList)).toBe(before);
    // The same name in another organization, or in another module, is another reach.
    expect(await list.add(reach({ name: "sales", organization: "northstar-eu" }))).toEqual({ ok: true });
    expect(await list.add(reach({ name: "sales", module: "billing" }))).toEqual({ ok: true });
  });

  test("too_many: the module and organization already have 64 reaches", async () => {
    const paths = await tempPaths();
    const list = listAt(paths);
    await writeReaches(
      paths,
      Array.from({ length: REACHES_MAX - 1 }, (_, i) => reach({ name: `db-${i}` })),
    );

    expect(await list.add(reach({ name: "db-63" }))).toEqual({ ok: true });
    const before = await bytesOf(paths.hostsList);
    expect(await list.add(reach({ name: "db-64" }))).toEqual({ ok: false, reason: "too_many" });
    expect(await bytesOf(paths.hostsList)).toBe(before);
    expect(await list.list("databases", null)).toHaveLength(REACHES_MAX);
    // Another organization of the same module, and another module, have their own 64.
    expect(await list.add(reach({ name: "db-64", organization: "northstar-eu" }))).toEqual({ ok: true });
    expect(await list.add(reach({ name: "db-64", module: "billing" }))).toEqual({ ok: true });
  });

  test.each([
    ["an empty host", "", 5432],
    ["a user name", "marta@db.northstar.example", 5432],
    ["a user name and a password", "app:secret@db.northstar.example", 5432],
    ["a path", "db.northstar.example/sales", 5432],
    ["a query string", "db.northstar.example?sslmode=require", 5432],
    ["a scheme", "postgres://db.northstar.example", 5432],
    ["a port written in the host", "db.northstar.example:5432", 5432],
    ["a wildcard", "*.northstar.example", 5432],
    ["a space", "db northstar.example", 5432],
    ["a space at the end", "db.northstar.example ", 5432],
    ["a label that starts with a dash", "-db.northstar.example", 5432],
    ["a label of 64 characters", `${"a".repeat(64)}.northstar.example`, 5432],
    ["a name of 254 characters", `${"abcdefghi.".repeat(25)}exam`, 5432],
    ["brackets around a name", "[db.northstar.example]", 5432],
    ["an IPv6 address with a zone", "fd12::5%en0", 5432],
    ["an IPv4 address written as one number", "167772165", 5432],
    ["an IPv4 address written in hex", "0x0a.0.0.5", 5432],
    ["an IPv4 address with a zero in front of a part", "010.0.0.5", 5432],
    ["an IPv4 address with a part left out", "10.5", 5432],
    ["port 0", "db.northstar.example", 0],
    ["port 65536", "db.northstar.example", 65_536],
    ["a port that is not a whole number", "db.northstar.example", 5432.5],
    ["a port written as text", "db.northstar.example", "5432" as unknown as number],
    ["a host that is not text", 42 as unknown as string, 5432],
  ])("not_a_host: %s", async (_label, host, port) => {
    const paths = await tempPaths();
    const list = listAt(paths);

    expect(await list.add(reach({ host, port }))).toEqual({ ok: false, reason: "not_a_host" });
    expect(existsSync(paths.hostsList)).toBe(false);
  });

  test.each([
    ["127.0.0.1"],
    ["::1"],
    ["[::1]"],
    ["0.0.0.0"],
    ["::"],
    ["169.254.169.254"],
    ["169.254.10.10"],
    ["fe80::1"],
    ["224.0.0.251"],
    ["ff02::fb"],
    ["::ffff:127.0.0.1"],
    ["::ffff:169.254.169.254"],
    ["fd00:ec2::254"],
    ["metadata.google.internal"],
    ["METADATA.AZURE.INTERNAL"],
    ["localhost"],
    ["db.localhost"],
  ])("host_not_allowed: %s", async (host) => {
    const paths = await tempPaths();
    const list = listAt(paths);

    expect(await list.add(reach({ host }))).toEqual({ ok: false, reason: "host_not_allowed" });
    expect(existsSync(paths.hostsList)).toBe(false);
  });

  test("list_unreadable: hosts.json is there and cannot be parsed", async () => {
    const paths = await tempPaths();
    await writeFile(paths.hostsList, "{ not json", { mode: 0o600 });

    expect(await listAt(paths).add(reach())).toEqual({ ok: false, reason: "list_unreadable" });
    expect(await bytesOf(paths.hostsList)).toBe("{ not json");
  });

  test("list_unreadable: hosts.json is there and cannot be opened as a file", async () => {
    const paths = await tempPaths();
    await mkdir(paths.hostsList);

    expect(await listAt(paths).add(reach())).toEqual({ ok: false, reason: "list_unreadable" });
    expect((await stat(paths.hostsList)).isDirectory()).toBe(true);
  });

  test.each([
    ["a module id", { module: "Databases" }],
    ["an organization id", { organization: "North Star" }],
    ["an empty name", { name: "" }],
    ["a name of 65 characters", { name: "x".repeat(65) }],
    ["a name with a character a name cannot hold", { name: "sales;drop" }],
    ["a login with a space", { addedBy: "marta lindqvist" }],
    ["a time that is not an instant", { addedAt: "yesterday" }],
    ["another kind of entry", { kind: "setting" as unknown as "reach" }],
  ])("a caller that passes %s is told, and nothing is written", async (_label, fields) => {
    const paths = await tempPaths();
    const list = listAt(paths);

    await expect(list.add(reach(fields as Partial<ReachEntry>))).rejects.toBeInstanceOf(ReachEntryInvalid);
    expect(existsSync(paths.hostsList)).toBe(false);
  });

  test("the error for a caller's mistake names the field and never the value", async () => {
    const paths = await tempPaths();
    const thrown = await listAt(paths)
      .add(reach({ addedBy: "token sk-live-123" }))
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ReachEntryInvalid);
    expect((thrown as Error).message).toContain("addedBy");
    expect((thrown as Error).message).not.toContain("sk-live");
  });
});

describe("hostAllowed", () => {
  const refused: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["IPv4 loopback", ["127.0.0.1", "127.8.9.10", "127.255.255.254"]],
    ["IPv4 loopback as one decimal number", ["2130706433"]],
    ["IPv4 loopback in hex", ["0x7f000001", "0X7F000001", "0x7f.0.0.1", "0x7f.1"]],
    ["IPv4 loopback in octal", ["0177.0.0.1", "017700000001", "0177.1"]],
    ["IPv4 loopback with parts left out", ["127.1", "127.0.1"]],
    ["IPv6 loopback", ["::1", "0:0:0:0:0:0:0:1", "0000:0000:0000:0000:0000:0000:0000:0001", "[::1]"]],
    ["IPv4 unspecified", ["0.0.0.0", "0.1.2.3", "0", "0x0", "00.0.0.0"]],
    ["IPv6 unspecified", ["::", "0:0:0:0:0:0:0:0", "[::]"]],
    ["IPv4 link-local", ["169.254.0.1", "169.254.255.255", "2851995649", "0xa9fe0001", "0251.0376.0.1"]],
    ["IPv6 link-local", ["fe80::1", "FE80::ABCD", "fe80::1%en0", "[fe80::1]", "febf:ffff::1"]],
    ["IPv4 multicast", ["224.0.0.1", "239.255.255.250", "3758096385", "0xe0000001"]],
    ["IPv6 multicast", ["ff02::1", "ff05::1:3", "FF0E::101"]],
    [
      "an IPv4 address written inside an IPv6 one",
      [
        "::ffff:127.0.0.1",
        "::ffff:7f00:1",
        "0:0:0:0:0:ffff:127.0.0.1",
        "::FFFF:169.254.169.254",
        "::ffff:a9fe:a9fe",
        "::ffff:224.0.0.1",
        "::ffff:0.0.0.0",
        "::127.0.0.1",
        "64:ff9b::127.0.0.1",
        "64:ff9b::a9fe:a9fe",
      ],
    ],
    [
      "the metadata addresses",
      [
        "169.254.169.254",
        "2852039166",
        "0xa9fea9fe",
        "0251.0376.0251.0376",
        "fd00:ec2::254",
        "FD00:0EC2:0000:0000:0000:0000:0000:0254",
        "[fd00:ec2::254]",
      ],
    ],
    [
      "the metadata names",
      [
        "metadata.google.internal",
        "METADATA.GOOGLE.INTERNAL",
        "metadata.google.internal.",
        "metadata.azure.internal",
        "Metadata.Azure.Internal.",
      ],
    ],
    ["localhost", ["localhost", "LOCALHOST", "localhost.", "db.localhost"]],
    [
      "text that is not a host",
      [
        "",
        " ",
        "db northstar",
        "marta@db.northstar.example",
        "db.northstar.example:5432",
        "*.northstar.example",
        "https://db.northstar.example",
        "[db.northstar.example]",
        "1.2.3.4.5",
        "db.10",
      ],
    ],
  ];

  for (const [family, spellings] of refused) {
    test(`refuses ${family}`, () => {
      for (const spelling of spellings) expect({ spelling, allowed: hostAllowed(spelling) }).toEqual({ spelling, allowed: false });
    });
  }

  test("allows a public or private address, and a name", () => {
    const allowed = [
      "10.0.0.5",
      "172.16.4.2",
      "172.31.255.254",
      "192.168.1.20",
      "100.64.0.7",
      "8.8.8.8",
      "169.255.0.1",
      "223.255.255.254",
      "fd12:3456:789a::5",
      "fc00::1",
      "2001:db8::5",
      "[2001:db8::5]",
      "::ffff:10.0.0.5",
      "::ffff:a00:5",
      "64:ff9b::808:808",
      "db.northstar.example",
      "DB.NORTHSTAR.EXAMPLE.",
      "metadata.northstar.example",
      "localhost.northstar.example",
      "db_1.northstar.example",
    ];
    for (const spelling of allowed) expect({ spelling, allowed: hostAllowed(spelling) }).toEqual({ spelling, allowed: true });
  });
});

describe("the stored file", () => {
  test("two add calls at once lose neither entry", async () => {
    const paths = await tempPaths();
    const one = listAt(paths);
    const two = listAt(paths);

    const results = await Promise.all([one.add(reach({ name: "sales" })), two.add(reach({ name: "orders" }))]);

    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect((await one.list("databases", null)).map((entry) => entry.name)).toEqual(["orders", "sales"]);
  });

  test("ten add calls at once from two lists keep all ten", async () => {
    const paths = await tempPaths();
    const lists = [listAt(paths), listAt(paths)];

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => lists[i % 2]?.add(reach({ name: `db-${i}` }))),
    );

    expect(results).toEqual(Array.from({ length: 10 }, () => ({ ok: true })));
    expect(await lists[0]?.list("databases", null)).toHaveLength(10);
  });

  test("two add calls at once with one name: one is kept, the other is told the name is taken", async () => {
    const paths = await tempPaths();
    const results = await Promise.all([
      listAt(paths).add(reach({ host: "db1.northstar.example" })),
      listAt(paths).add(reach({ host: "db2.northstar.example" })),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "name_taken" }]);
    expect(await listAt(paths).list("databases", null)).toHaveLength(1);
  });

  test("the file is readable and writable by its own user only", async () => {
    const paths = await tempPaths();
    await listAt(paths).add(reach());

    // Read first, then stat: the order a scanner does not flag.
    const text = await readFile(paths.hostsList, "utf8");
    const info = await stat(paths.hostsList);
    expect(text).toContain("db.northstar.example");
    expect(info.mode & 0o777).toBe(0o600);
  });

  test.each([
    ["text that is not JSON", "{ not json"],
    ["JSON that is not an object", "[]"],
    ["an object with no list of reaches", JSON.stringify({ version: 1, reaches: "none" })],
    [
      "a reach that add would refuse",
      JSON.stringify({ version: 1, reaches: [reach({ host: "127.0.0.1" })] }),
    ],
    [
      "a reach with a field of the wrong shape",
      JSON.stringify({ version: 1, reaches: [reach({ addedAt: "today" })] }),
    ],
    [
      "two reaches with one name",
      JSON.stringify({ version: 1, reaches: [reach({ name: "sales" }), reach({ name: "SALES" })] }),
    ],
  ])("a file that holds %s is never written over", async (_label, text) => {
    const paths = await tempPaths();
    await writeFile(paths.hostsList, text, { mode: 0o600 });
    const list = listAt(paths);

    expect(await list.add(reach({ name: "new" }))).toEqual({ ok: false, reason: "list_unreadable" });
    await expect(list.remove("databases", null, "sales")).rejects.toBeInstanceOf(HostsListUnreadable);
    expect(await list.find("databases", null, "sales")).toBeNull();
    await expect(list.list("databases", null)).rejects.toBeInstanceOf(HostsListUnreadable);
    await expect(list.all()).rejects.toBeInstanceOf(HostsListUnreadable);

    expect(await bytesOf(paths.hostsList)).toBe(text);
    expect(existsSync(`${paths.hostsList}.lock`)).toBe(false);
  });

  test("the error for a file that cannot be read names the file", async () => {
    const paths = await tempPaths();
    await writeFile(paths.hostsList, "{ not json", { mode: 0o600 });

    const thrown = await listAt(paths)
      .list("databases", null)
      .catch((error: unknown) => error);
    expect((thrown as Error).message).toContain(paths.hostsList);
    expect((thrown as Error).message).toContain("Nothing was written");
  });

  test("a key this build does not know is kept when the file is written again", async () => {
    const paths = await tempPaths();
    await writeFile(
      paths.hostsList,
      JSON.stringify({ version: 3, note: "kept", reaches: [{ ...reach({ name: "sales" }), tls: "verify" }] }),
      { mode: 0o600 },
    );
    const list = listAt(paths);

    expect(await list.add(reach({ name: "orders" }))).toEqual({ ok: true });

    const stored = JSON.parse((await bytesOf(paths.hostsList)) ?? "null");
    expect(stored.version).toBe(4);
    expect(stored.note).toBe("kept");
    expect(stored.reaches[0]).toEqual({ ...reach({ name: "sales" }), tls: "verify" });
    // What the list gives holds the fields of a reach and no other.
    expect((await list.list("databases", null))[1]).toEqual(reach({ name: "sales" }));
  });

  test("remove takes one reach away, and says when there was none", async () => {
    const paths = await tempPaths();
    const list = listAt(paths);
    await list.add(reach({ name: "sales" }));
    await list.add(reach({ name: "sales", organization: "northstar-eu" }));

    expect(await list.remove("databases", null, "SALES")).toBe(true);
    expect(await list.remove("databases", null, "sales")).toBe(false);

    expect(await list.list("databases", null)).toEqual([]);
    expect(await list.find("databases", "northstar-eu", "sales")).toEqual({ host: "db.northstar.example", port: 5432 });
  });

  test("remove with no file writes nothing", async () => {
    const paths = await tempPaths();

    expect(await listAt(paths).remove("databases", null, "sales")).toBe(false);
    expect(existsSync(paths.hostsList)).toBe(false);
    expect(existsSync(`${paths.hostsList}.lock`)).toBe(false);
  });

  test("remove that finds no such reach leaves the file as it was", async () => {
    const paths = await tempPaths();
    const list = listAt(paths);
    await list.add(reach({ name: "sales" }));
    const before = await bytesOf(paths.hostsList);

    expect(await list.remove("databases", null, "orders")).toBe(false);
    expect(await bytesOf(paths.hostsList)).toBe(before);
  });

  test("remove and list tell a caller that passes a module or organization of the wrong shape", async () => {
    const paths = await tempPaths();
    const list = listAt(paths);

    await expect(list.remove("Databases", null, "sales")).rejects.toBeInstanceOf(ReachEntryInvalid);
    await expect(list.remove("databases", "North Star", "sales")).rejects.toBeInstanceOf(ReachEntryInvalid);
    await expect(list.list("databases", "North Star")).rejects.toBeInstanceOf(ReachEntryInvalid);
  });
});

describe("the whole list", () => {
  async function busyList(): Promise<HostsList> {
    const paths = await tempPaths();
    const list = listAt(paths, busyAnswers);
    // Added in another order than the order of the list.
    await list.add(reach({ module: "databases", name: "sales-2", host: "db2.northstar.example" }));
    await list.add(reach({ module: "billing", organization: "northstar-eu", name: "ledger", host: "ledger.eu.northstar.example", port: 443 }));
    await list.add(reach({ module: "databases", organization: "northstar-eu", name: "Archive", host: "10.20.0.5", port: 1433 }));
    await list.add(reach({ module: "databases", name: "Sales-1", host: "fd12:3456::7" }));
    await list.add(reach({ module: "billing", name: "ledger", host: "ledger.northstar.example", port: 8443 }));
    return list;
  }

  test("reachOf gives these answers' rows in another order than the questions", () => {
    const answers = busyAnswers();
    expect(reachOf(answers, { needsFiles: true }).map((row) => row.why)).toEqual([
      "keys",
      "database",
      "files",
      "sign-in",
      "sign-in",
      "AI model",
      "audit trail copy",
      "control plane, new versions",
    ]);
  });

  test("settings in the order of the questions, then manifests by module, then reaches by module, organization and name", async () => {
    const list = await busyList();
    const by = { addedBy: "marta.lindqvist@northstar.example", addedAt: "2026-11-14T10:00:00.000Z" };

    expect(await list.all()).toEqual([
      { kind: "setting", host: "secretsmanager.eu-west-1.amazonaws.com", port: 443, why: "keys", question: "keys" },
      { kind: "setting", host: "idp.northstar.example", port: 443, why: "sign-in", question: "signIn" },
      {
        kind: "setting",
        host: null,
        port: null,
        described: "the addresses this provider names for its keys and tokens",
        why: "sign-in",
        question: "signIn",
      },
      {
        kind: "setting",
        host: null,
        port: null,
        described: "the address in db-url",
        why: "database",
        question: "data",
      },
      { kind: "setting", host: "files.northstar.example", port: 9000, why: "files", question: "data" },
      { kind: "setting", host: "models.northstar.example", port: 443, why: "AI model", question: "model" },
      {
        kind: "setting",
        host: "control.example",
        port: 443,
        why: "control plane, new versions",
        question: "controlPlane",
      },
      { kind: "setting", host: "hooks.northstar.example", port: 443, why: "audit trail copy", question: "auditTrail" },
      { kind: "manifest", host: "pay.billing.example", port: 443, why: MANIFEST_WHY, module: "billing" },
      { kind: "manifest", host: "api.weather.example", port: 443, why: MANIFEST_WHY, module: "weather" },
      { kind: "manifest", host: "*.tiles.example", port: 443, why: MANIFEST_WHY, module: "weather" },
      {
        kind: "reach",
        host: "ledger.northstar.example",
        port: 8443,
        why: "Billing: ledger",
        module: "billing",
        name: "ledger",
        ...by,
      },
      {
        kind: "reach",
        host: "ledger.eu.northstar.example",
        port: 443,
        why: "Billing: ledger",
        module: "billing",
        organization: "northstar-eu",
        name: "ledger",
        ...by,
      },
      {
        kind: "reach",
        host: "fd12:3456::7",
        port: 5432,
        why: "Databases: Sales-1",
        module: "databases",
        name: "Sales-1",
        ...by,
      },
      {
        kind: "reach",
        host: "db2.northstar.example",
        port: 5432,
        why: "Databases: sales-2",
        module: "databases",
        name: "sales-2",
        ...by,
      },
      {
        kind: "reach",
        host: "10.20.0.5",
        port: 1433,
        why: "Databases: Archive",
        module: "databases",
        organization: "northstar-eu",
        name: "Archive",
        ...by,
      },
    ]);
  });

  test("two calls give the same list, field for field", async () => {
    const list = await busyList();
    const first = await list.all();

    expect(JSON.stringify(await list.all())).toBe(JSON.stringify(first));
  });

  test("every setting names a question of the setup, by its id", async () => {
    const list = await busyList();
    const settings = (await list.all()).filter((entry) => entry.kind === "setting");

    expect(settings.length).toBeGreaterThan(0);
    for (const entry of settings) expect(STEP_IDS).toContain(entry.question);
  });

  test("a setting's port is 443 unless its answer gives one", async () => {
    const paths = await tempPaths();
    const answers = (): SetupAnswers => {
      const a = quietAnswers();
      a.signIn = { ...a.signIn, provider: "openid-connect", issuer: "https://idp.northstar.example:8443/realms/x" };
      a.controlPlane = { connect: "yes", address: "[2001:db8::7]:7443", token: "", connected: "on", pages: "" };
      a.model = { ...a.model, provider: "anthropic", route: "direct" };
      return a;
    };

    const settings = (await listAt(paths, answers).all())
      .filter((entry) => entry.kind === "setting")
      .map((entry) => [entry.host, entry.port, entry.why]);
    expect(settings).toEqual([
      ["idp.northstar.example", 8443, "sign-in"],
      // The provider's keys and tokens: their host is not known, so no port is claimed.
      [null, null, "sign-in"],
      ["api.anthropic.com", 443, "AI model"],
      ["2001:db8::7", 7443, "control plane, new versions"],
    ]);
  });

  test("the place the database program is downloaded from is under the data question", async () => {
    const paths = await tempPaths();
    // The defaults: a database beside HX Fortress, on this machine.
    const settings = (await listAt(paths, () => defaultAnswers(MODULE_IDS)).all()).filter(
      (entry) => entry.kind === "setting",
    );

    expect(settings).toEqual([
      { kind: "setting", host: "repo1.maven.org", port: 443, why: "database program, once", question: "data" },
    ]);
  });

  test("the phrases reachOf writes for services a cloud makes are kept as they are", async () => {
    const paths = await tempPaths();
    const answers = (): SetupAnswers => {
      const a = defaultAnswers(MODULE_IDS, { on: ["session_vault"] });
      a.where = { place: "azure", region: "westeurope", ssh: "" };
      a.keys = { ...a.keys, store: "azure-key-vault", vault: "northstar-hx" };
      a.data.database = { store: "managed", address: "" };
      a.data.files = { ...a.data.files, store: "azure-blob" };
      return a;
    };

    const settings = (await listAt(paths, answers).all()).filter((entry) => entry.kind === "setting");
    expect(settings).toEqual([
      { kind: "setting", host: "northstar-hx.vault.azure.net", port: 443, why: "keys", question: "keys" },
      {
        kind: "setting",
        host: null,
        port: null,
        described: "the Azure Database for PostgreSQL that is made",
        why: "database",
        question: "data",
      },
      {
        kind: "setting",
        host: null,
        port: null,
        described: "the Azure Blob Storage account that is made",
        why: "files",
        question: "data",
      },
    ]);
  });

  test("an empty list of reaches and no file: the settings and manifests alone", async () => {
    const paths = await tempPaths();
    const answers = (): SetupAnswers => {
      const a = quietAnswers();
      a.data.database = { store: "existing", address: "" };
      return a;
    };
    const entries = await listAt(paths, answers).all();

    expect(entries.map((entry) => entry.kind)).toEqual(["setting", "manifest", "manifest", "manifest"]);
    expect(entries[0]).toEqual({
      kind: "setting",
      host: null,
      port: null,
      described: "an existing Postgres",
      why: "database",
      question: "data",
    });
    expect(existsSync(paths.hostsList)).toBe(false);
  });

  test("no entry holds a key, an address's user name or a query string", async () => {
    const list = await busyList();
    const text = JSON.stringify(await list.all());

    for (const leak of ["admin", "hunter2", "client_secret", "sk-live", "api-key", "token=", "?", "realms", "/v1"]) {
      expect({ leak, found: text.includes(leak) }).toEqual({ leak, found: false });
    }
  });

  test("a setting whose answer cannot be read as an address is not repeated", async () => {
    const paths = await tempPaths();
    const answers = (): SetupAnswers => {
      const a = quietAnswers();
      a.signIn = {
        ...a.signIn,
        provider: "openid-connect",
        issuer: "https://admin:hunter2@idp northstar.example/?code=1",
      };
      return a;
    };

    const entries: HostEntry[] = await listAt(paths, answers).all();
    const signIn = entries.find((entry) => entry.why === "sign-in");
    expect(signIn).toEqual({
      kind: "setting",
      host: null,
      port: null,
      described: UNREADABLE_ADDRESS,
      why: "sign-in",
      question: "signIn",
    });
    const text = JSON.stringify(entries);
    expect(text).not.toContain("admin");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("code=1");
  });

  test("a reach of a module this build does not have is shown under the module's id", async () => {
    const paths = await tempPaths();
    const list = listAt(paths);
    await list.add(reach({ module: "ledgers", name: "main" }));

    const last = (await list.all()).at(-1);
    expect(last).toMatchObject({ kind: "reach", module: "ledgers", why: "ledgers: main" });
  });
});
