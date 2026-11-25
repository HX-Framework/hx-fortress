// `hx-fortress hosts` and `hx-fortress hosts --json`: the one list of hosts,
// printed on the host.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli";
import { HOSTS_USAGE, runHostsVerb } from "../src/cli-hosts";
import { publishDaemonEnvironment } from "../src/host/daemon-environment";
import { HostsList, type HostEntry, type ReachEntry } from "../src/host/hosts-list";
import type { CatalogEntry } from "../src/host/module-catalog";
import { fortressPaths } from "../src/host/paths";
import { defaultAnswers, type SetupAnswers } from "../src/setup/answers";
import { NEW_VERSIONS_UNREADABLE } from "../src/setup/reach";
import { readAnswers } from "../src/setup/read";
import { helpEntries } from "../src/ui/help";
import { publishStatus } from "./host/_module-rig";

type Paths = ReturnType<typeof fortressPaths>;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempPaths(): Promise<Paths> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-hosts-cli-"));
  roots.push(root);
  return fortressPaths(root);
}

const CATALOG: readonly CatalogEntry[] = [
  { id: "session_vault", title: "Agentic Sessions", summary: "sessions", manifest: null, startOnly: true },
  {
    id: "weather",
    title: "Weather",
    summary: "forecasts",
    manifest: { id: "weather", asks: [], egress: ["api.weather.example"], secrets: [] },
    startOnly: false,
  },
  {
    id: "databases",
    title: "Databases",
    summary: "databases",
    manifest: { id: "databases", asks: [], egress: [], secrets: [] },
    startOnly: false,
  },
];

/** Answers that name a sign-in provider, a database by the name of its key,
 *  and a control plane on another port than 443. */
function answers(): SetupAnswers {
  const a = defaultAnswers(CATALOG.map((entry) => entry.id));
  a.where = { place: "docker", region: "", ssh: "" };
  a.data.database = { store: "existing", address: "db-url" };
  a.signIn = { ...a.signIn, provider: "openid-connect", issuer: "https://idp.northstar.example/realms/northstar" };
  a.controlPlane = { connect: "yes", address: "control.example:8443", token: "", connected: "on", pages: "" };
  return a;
}

function quietAnswers(): SetupAnswers {
  const a = defaultAnswers(CATALOG.map((entry) => entry.id));
  a.where = { place: "docker", region: "", ssh: "" };
  return a;
}

const SALES: ReachEntry = {
  kind: "reach",
  module: "databases",
  name: "sales-1",
  host: "db.northstar.example",
  port: 5432,
  addedBy: "marta.lindqvist@northstar.example",
  addedAt: "2026-11-14T10:00:00.000Z",
};

const ARCHIVE: ReachEntry = {
  ...SALES,
  organization: "northstar-eu",
  name: "archive",
  host: "2001:db8::5",
  port: 1433,
};

async function withReaches(): Promise<{ paths: Paths; list: HostsList }> {
  const paths = await tempPaths();
  const list = new HostsList(paths, { catalog: CATALOG, answers: async () => answers() });
  expect(await list.add(SALES)).toEqual({ ok: true });
  expect(await list.add(ARCHIVE)).toEqual({ ok: true });
  return { paths, list };
}

/** The real dispatch, with the answers and the modules of the test. */
async function hosts(
  paths: Paths,
  args: readonly string[],
  given: () => SetupAnswers | Promise<SetupAnswers> = answers,
  catalog: readonly CatalogEntry[] = CATALOG,
): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  const code = await runCli(["hosts", ...args], {
    fortressRoot: paths.root,
    writeLine: (line) => out.push(line),
    runHostsVerb: (verbArgs, deps) => runHostsVerb(verbArgs, { ...deps, catalog, answers: async () => given() }),
  });
  return { code, out };
}

/**
 * Run with FORTRESS_UPDATE_URL in this process's own environment, as the
 * terminal that types the command has it, and put the environment back
 * afterwards. The Agentic Sessions credentials file is under the home folder,
 * so the home folder is pointed at the test's own folder: nothing outside it
 * is read.
 */
async function inThisTerminal<T>(paths: Paths, updateUrl: string, work: () => Promise<T>): Promise<T> {
  const { HOME: home, FORTRESS_UPDATE_URL: before } = process.env;
  process.env.HOME = paths.root;
  process.env.FORTRESS_UPDATE_URL = updateUrl;
  try {
    return await work();
  } finally {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    if (before === undefined) delete process.env.FORTRESS_UPDATE_URL;
    else process.env.FORTRESS_UPDATE_URL = before;
  }
}

/** `hx-fortress hosts --json` with the terminal's own defaults: the answers
 *  are read from the folder and from this process's environment. */
async function hostsOfTheTerminal(paths: Paths): Promise<HostEntry[]> {
  const out: string[] = [];
  const code = await runCli(["hosts", "--json"], { fortressRoot: paths.root, writeLine: (line) => out.push(line) });
  expect(code).toBe(0);
  return JSON.parse(out.join("\n")).hosts as HostEntry[];
}

describe("hx-fortress hosts", () => {
  test("prints one row per entry, with the port only when it is not 443", async () => {
    const { paths } = await withReaches();

    const { code, out } = await hosts(paths, []);

    expect(code).toBe(0);
    expect(out[0]).toBe("The addresses HX Fortress calls");
    expect(out[2]).toMatch(/^Address\s+What for\s+Module\s+Added$/);
    const rows = out.slice(3, 12);
    expect(rows[0]).toMatch(/^idp\.northstar\.example\s+sign-in$/);
    // A provider's keys and tokens can be at other hosts than the issuer's.
    expect(rows[1]).toMatch(/^the addresses this provider names for its keys and tokens\s+sign-in$/);
    expect(rows[2]).toMatch(/^the address in db-url\s+database$/);
    // New versions come from the project's releases, never through the control plane.
    expect(rows[3]).toMatch(/^github\.com\s+new versions$/);
    expect(rows[4]).toMatch(/^the hosts GitHub serves release files from\s+new versions$/);
    expect(rows[5]).toMatch(/^control\.example:8443\s+control plane$/);
    expect(rows[6]).toMatch(/^api\.weather\.example\s+named in its manifest\s+Weather$/);
    expect(rows[7]).toMatch(
      /^db\.northstar\.example:5432\s+Databases: sales-1\s+Databases\s+marta\.lindqvist@northstar\.example, 2026-11-14T10:00:00\.000Z$/,
    );
    expect(rows[8]).toMatch(
      /^\[2001:db8::5\]:1433\s+Databases: archive\s+Databases\s+marta\.lindqvist@northstar\.example, 2026-11-14T10:00:00\.000Z$/,
    );
    expect(out.slice(12)).toEqual([
      "",
      "This build does not yet refuse a call to an address that is not on this list.",
      "`hx-fortress hosts --json` prints every field, for a firewall rule or a template.",
    ]);
  });

  test("the columns line up", async () => {
    const { paths } = await withReaches();
    const { out } = await hosts(paths, []);

    const table = out.slice(2, 12);
    const start = (line: string, word: string): number => line.indexOf(word);
    const whatFor = start(table[0] ?? "", "What for");
    expect(start(table[1] ?? "", "sign-in")).toBe(whatFor);
    expect(start(table[2] ?? "", "sign-in")).toBe(whatFor);
    expect(start(table[8] ?? "", "Databases: sales-1")).toBe(whatFor);
  });

  test("a column that no row fills is left out", async () => {
    const paths = await tempPaths();
    const { code, out } = await hosts(paths, [], answers, [CATALOG[0] as CatalogEntry]);

    expect(code).toBe(0);
    expect(out[2]).toMatch(/^Address\s+What for$/);
  });

  test("an HX Fortress that calls nothing else still lists where its new versions come from", async () => {
    const paths = await tempPaths();
    const { code, out } = await hosts(paths, [], quietAnswers, [CATALOG[0] as CatalogEntry]);

    expect(code).toBe(0);
    expect(out.slice(0, 5).map((line) => line.replace(/\s{2,}/g, "  "))).toEqual([
      "The addresses HX Fortress calls",
      "",
      "Address  What for",
      "github.com  new versions",
      "the hosts GitHub serves release files from  new versions",
    ]);
  });

  test("--json prints every field of every entry, and nothing else", async () => {
    const { paths, list } = await withReaches();

    const { code, out } = await hosts(paths, ["--json"]);

    expect(code).toBe(0);
    const printed = JSON.parse(out.join("\n"));
    expect(Object.keys(printed)).toEqual(["hosts"]);
    expect(printed.hosts).toEqual(await list.all());
    expect(printed.hosts[1]).toEqual({
      kind: "setting",
      host: null,
      port: null,
      described: "the addresses this provider names for its keys and tokens",
      why: "sign-in",
      question: "signIn",
    });
    expect(printed.hosts[2]).toEqual({
      kind: "setting",
      host: null,
      port: null,
      described: "the address in db-url",
      why: "database",
      question: "data",
    });
    expect(Object.keys(printed.hosts[7])).toEqual(["kind", "host", "port", "why", "module", "name", "addedBy", "addedAt"]);
    expect(printed.hosts[8]).toEqual({
      kind: "reach",
      host: "2001:db8::5",
      port: 1433,
      why: "Databases: archive",
      module: "databases",
      organization: "northstar-eu",
      name: "archive",
      addedBy: "marta.lindqvist@northstar.example",
      addedAt: "2026-11-14T10:00:00.000Z",
    });
  });

  test("an unknown option is refused", async () => {
    const paths = await tempPaths();

    expect(await hosts(paths, ["--yaml"])).toEqual({
      code: 1,
      out: [`error: unknown option --yaml. ${HOSTS_USAGE}`],
    });
    expect(await hosts(paths, ["--json", "--yaml"])).toEqual({
      code: 1,
      out: [`error: unknown option --yaml. ${HOSTS_USAGE}`],
    });
    expect(await hosts(paths, ["--json", "--json"])).toEqual({
      code: 1,
      out: [`error: --json is given more than once. ${HOSTS_USAGE}`],
    });
  });

  test.each([
    ["an option with a value in it", "--json=$(cat /etc/passwd)"],
    ["an address with a key in it", "https://db.northstar.example/?key=sk-live-123"],
    ["a word that is not an option", "list"],
    ["an option in capitals", "--JSON"],
    ["a terminal control sequence", "\u001b[31m--json"],
    ["a very long option", `--${"x".repeat(40)}`],
  ])("%s is refused and not repeated", async (_label, arg) => {
    const paths = await tempPaths();

    const { code, out } = await hosts(paths, [arg]);

    expect(code).toBe(1);
    expect(out).toEqual([`error: that is not an option of hx-fortress hosts. ${HOSTS_USAGE}`]);
  });

  test("it runs with no daemon, and changes nothing", async () => {
    const { paths } = await withReaches();
    const before = await readFile(paths.hostsList, "utf8");

    expect((await hosts(paths, [])).code).toBe(0);
    expect((await hosts(paths, ["--json"])).code).toBe(0);

    expect(await readFile(paths.hostsList, "utf8")).toBe(before);
    expect(existsSync(`${paths.hostsList}.lock`)).toBe(false);
    expect(existsSync(paths.runtimeRoot)).toBe(false);
  });

  test("a list that cannot be read stops the command, names the file, and is left as it is", async () => {
    const paths = await tempPaths();
    await writeFile(paths.hostsList, "{ not json", { mode: 0o600 });

    const { code, out } = await hosts(paths, ["--json"]);

    expect(code).toBe(1);
    expect(out).toHaveLength(1);
    expect(out[0]).toStartWith(`error: The list of hosts at ${paths.hostsList} cannot be read.`);
    expect(await readFile(paths.hostsList, "utf8")).toBe("{ not json");
  });

  test("it reads the present answers as the setup does, and prints no key, user name or query string", async () => {
    const paths = await tempPaths();
    await writeFile(paths.config, JSON.stringify({ cloud: { url: "wss://control.example/v1/connection" } }));
    const env = {
      FORTRESS_DATABASE_URL: "postgres://app:s3cret-pw@db.northstar.example:5432/app?sslmode=require",
      FORTRESS_OPENAI_API_KEY: "sk-test-not-a-real-key-123",
    };
    const present = async (): Promise<SetupAnswers> =>
      (await readAnswers(paths, env, { catalog: CATALOG, vaultCredentials: async () => null })).answers;

    const plain = await hosts(paths, [], present);
    const json = await hosts(paths, ["--json"], present);

    expect(plain.code).toBe(0);
    expect(json.code).toBe(0);
    const rows = JSON.parse(json.out.join("\n")).hosts.filter((entry: { kind: string }) => entry.kind === "setting");
    expect(rows).toEqual([
      { kind: "setting", host: null, port: null, described: "an existing Postgres", why: "database", question: "data" },
      { kind: "setting", host: "api.openai.com", port: 443, why: "AI model", question: "model" },
      { kind: "setting", host: "github.com", port: 443, why: "new versions", question: "updates" },
      {
        kind: "setting",
        host: null,
        port: null,
        described: "the hosts GitHub serves release files from",
        why: "new versions",
        question: "updates",
      },
      { kind: "setting", host: "control.example", port: 443, why: "control plane", question: "controlPlane" },
    ]);
    const text = [...plain.out, ...json.out].join("\n");
    for (const leak of ["s3cret", "sslmode", "app:", "sk-test", "/v1/connection"]) {
      expect({ leak, found: text.includes(leak) }).toEqual({ leak, found: false });
    }
  });

  test("the terminal's own defaults read the folder it is given", async () => {
    const paths = await tempPaths();
    await writeFile(paths.config, JSON.stringify({ cloud: { url: "wss://control.example/v1/connection" } }));
    // The Agentic Sessions credentials file is under the home folder. The test
    // points that at its own folder, so nothing outside it is read.
    const home = process.env.HOME;
    process.env.HOME = paths.root;
    try {
      const out: string[] = [];
      const code = await runCli(["hosts", "--json"], { fortressRoot: paths.root, writeLine: (line) => out.push(line) });

      expect(code).toBe(0);
      const printed = JSON.parse(out.join("\n"));
      expect(printed.hosts).toContainEqual({
        kind: "setting",
        host: "control.example",
        port: 443,
        why: "control plane",
        question: "controlPlane",
      });
    } finally {
      process.env.HOME = home;
    }
  });

  test("where new versions come from, when this host's update settings cannot be read, is one row that names no host", async () => {
    const paths = await tempPaths();
    await writeFile(paths.config, JSON.stringify({ updates: { from: "own-address", address: "http://files.northstar.example/hx" } }));
    const present = async (): Promise<SetupAnswers> =>
      (await readAnswers(paths, {}, { catalog: CATALOG, vaultCredentials: async () => null })).answers;

    const plain = await hosts(paths, [], present);
    const json = await hosts(paths, ["--json"], present);

    expect([plain.code, json.code]).toEqual([0, 0]);
    const printed: HostEntry[] = JSON.parse(json.out.join("\n")).hosts;
    expect(printed.filter((entry) => entry.why === "new versions").map((entry) => [entry.host, entry.port])).toEqual([
      [null, null],
    ]);
    expect(plain.out.filter((line) => line.endsWith("new versions"))).toHaveLength(1);
    // Never the project's releases, which the settings may have turned away
    // from, and not the address that could not be read.
    const text = [...plain.out, ...json.out].join("\n");
    for (const named of ["github.com", "GitHub", "files.northstar.example"]) {
      expect({ named, found: text.includes(named) }).toEqual({ named, found: false });
    }
  });

  test("the row for new versions from a place that is not known says so in the setup's own words", async () => {
    const paths = await tempPaths();
    await writeFile(paths.config, JSON.stringify({ updates: { from: "elsewhere" } }));
    const present = async (): Promise<SetupAnswers> =>
      (await readAnswers(paths, {}, { catalog: CATALOG, vaultCredentials: async () => null })).answers;

    const { out } = await hosts(paths, [], present, [CATALOG[0] as CatalogEntry]);
    expect(out.slice(0, 5).map((line) => line.replace(/\s{2,}/g, "  "))).toEqual([
      "The addresses HX Fortress calls",
      "",
      "Address  What for",
      "repo1.maven.org  database program, once",
      `${NEW_VERSIONS_UNREADABLE}  new versions`,
    ]);
  });

  test("the terminal's own defaults: a wrong address in this terminal's own variable, with HX Fortress not running, names no host for new versions", async () => {
    const paths = await tempPaths();
    const printed = await inThisTerminal(paths, "http://files.northstar.example/hx", () => hostsOfTheTerminal(paths));
    expect(printed.filter((entry) => entry.why === "new versions").map((entry) => [entry.host, entry.port])).toEqual([
      [null, null],
    ]);
    expect(printed.map((entry) => entry.host)).not.toContain("github.com");
    expect(printed.map((entry) => entry.host)).not.toContain("files.northstar.example");
  });

  test("the terminal's own defaults list the address the running HX Fortress was started with, and not this terminal's own", async () => {
    const paths = await tempPaths();
    await publishStatus(paths, [], { pid: 4242 });
    expect(
      await publishDaemonEnvironment(
        paths,
        { updateUrl: { value: "https://mirror.northstar.example/f" }, controlPlaneKey: null },
        { pid: 4242 },
      ),
    ).toBe(true);
    const printed = await inThisTerminal(paths, "https://other.northstar.example/x", () => hostsOfTheTerminal(paths));
    expect(printed.filter((entry) => entry.why === "new versions")).toEqual([
      { kind: "setting", host: "mirror.northstar.example", port: 443, why: "new versions", question: "updates" },
    ]);
    expect(printed.map((entry) => entry.host)).not.toContain("other.northstar.example");
  });

  test("help lists both forms", async () => {
    const usages = helpEntries().map((entry) => entry.usage);
    expect(usages).toContain("hx-fortress hosts");
    expect(usages).toContain("hx-fortress hosts --json");

    const out: string[] = [];
    expect(await runCli(["help"], { writeLine: (line) => out.push(line) })).toBe(0);
    expect(out.some((line) => line.includes("hx-fortress hosts --json"))).toBe(true);
  });
});
