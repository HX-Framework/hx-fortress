// `hx-fortress hosts` and `hx-fortress hosts --json`: the one list of hosts,
// printed on the host.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli";
import { HOSTS_USAGE, runHostsVerb } from "../src/cli-hosts";
import { HostsList, type ReachEntry } from "../src/host/hosts-list";
import type { CatalogEntry } from "../src/host/module-catalog";
import { fortressPaths } from "../src/host/paths";
import { defaultAnswers, type SetupAnswers } from "../src/setup/answers";
import { readAnswers } from "../src/setup/read";
import { helpEntries } from "../src/ui/help";

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

describe("hx-fortress hosts", () => {
  test("prints one row per entry, with the port only when it is not 443", async () => {
    const { paths } = await withReaches();

    const { code, out } = await hosts(paths, []);

    expect(code).toBe(0);
    expect(out[0]).toBe("The addresses HX Fortress calls");
    expect(out[2]).toMatch(/^Address\s+What for\s+Module\s+Added$/);
    const rows = out.slice(3, 10);
    expect(rows[0]).toMatch(/^idp\.northstar\.example\s+sign-in$/);
    // A provider's keys and tokens can be at other hosts than the issuer's.
    expect(rows[1]).toMatch(/^the addresses this provider names for its keys and tokens\s+sign-in$/);
    expect(rows[2]).toMatch(/^the address in db-url\s+database$/);
    expect(rows[3]).toMatch(/^control\.example:8443\s+control plane, new versions$/);
    expect(rows[4]).toMatch(/^api\.weather\.example\s+named in its manifest\s+Weather$/);
    expect(rows[5]).toMatch(
      /^db\.northstar\.example:5432\s+Databases: sales-1\s+Databases\s+marta\.lindqvist@northstar\.example, 2026-11-14T10:00:00\.000Z$/,
    );
    expect(rows[6]).toMatch(
      /^\[2001:db8::5\]:1433\s+Databases: archive\s+Databases\s+marta\.lindqvist@northstar\.example, 2026-11-14T10:00:00\.000Z$/,
    );
    expect(out.slice(10)).toEqual([
      "",
      "This build does not yet refuse a call to an address that is not on this list.",
      "`hx-fortress hosts --json` prints every field, for a firewall rule or a template.",
    ]);
  });

  test("the columns line up", async () => {
    const { paths } = await withReaches();
    const { out } = await hosts(paths, []);

    const table = out.slice(2, 10);
    const start = (line: string, word: string): number => line.indexOf(word);
    const whatFor = start(table[0] ?? "", "What for");
    expect(start(table[1] ?? "", "sign-in")).toBe(whatFor);
    expect(start(table[2] ?? "", "sign-in")).toBe(whatFor);
    expect(start(table[6] ?? "", "Databases: sales-1")).toBe(whatFor);
  });

  test("a column that no row fills is left out", async () => {
    const paths = await tempPaths();
    const { code, out } = await hosts(paths, [], answers, [CATALOG[0] as CatalogEntry]);

    expect(code).toBe(0);
    expect(out[2]).toMatch(/^Address\s+What for$/);
  });

  test("with no entry at all it says so", async () => {
    const paths = await tempPaths();
    const { code, out } = await hosts(paths, [], quietAnswers, [CATALOG[0] as CatalogEntry]);

    expect(code).toBe(0);
    expect(out.slice(0, 3)).toEqual([
      "The addresses HX Fortress calls",
      "",
      "None. With the present settings and modules, HX Fortress calls no address.",
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
    expect(Object.keys(printed.hosts[5])).toEqual(["kind", "host", "port", "why", "module", "name", "addedBy", "addedAt"]);
    expect(printed.hosts[6]).toEqual({
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
      {
        kind: "setting",
        host: "control.example",
        port: 443,
        why: "control plane, new versions",
        question: "controlPlane",
      },
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
        why: "control plane, new versions",
        question: "controlPlane",
      });
    } finally {
      process.env.HOME = home;
    }
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
