// A helper program as a module has the host run it: `ctx.programs.run`, through
// the real module host, with a real program.
//
// The module here has the id `databases`, because the host's list of programs
// gives its one program to that module. It is a module of this test, with two
// acts that add a host and a secret's name as a signed-in operator does.

import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runModulesVerb } from "../../src/cli-modules";
import { AUDIT_ACTIONS } from "../../src/console/audit-actions";
import type { AuditRecord } from "../../src/console/audit-spool";
import { setModuleEnabled } from "../../src/host/config";
import type { CatalogEntry } from "../../src/host/module-catalog";
import type { ModuleAudit } from "../../src/host/module-audit";
import { createModuleContext } from "../../src/host/module-context";
import {
  manifestDefect,
  PROGRAM_FAILURE_CODES,
  PROGRAM_JOB_MAX_BYTES,
  type ModuleActContext,
  type ModuleContextV2,
  type ModuleManifest,
  type ProgramOutcome,
  type ProgramRun,
} from "../../src/host/module-contract";
import type { ModuleHostDeps } from "../../src/host/module-host";
import type { Organizations } from "../../src/host/module-organizations";
import type { Organization } from "../../src/host/organization-id";
import { PROGRAMS_MAX_PER_MODULE, type ModulePrograms } from "../../src/host/module-programs";
import { listModules, moduleDataPaths } from "../../src/host/modules-api";
import type { ReachLookup } from "../../src/host/reach-resolve";
import { S } from "../../src/host/shape";
import { SecretUnavailable } from "../../src/secrets/types";
import { UI_CONFIG_DEFAULTS } from "../../src/ui/config";
import { dataPathRows, type EgressInputs } from "../../src/ui/egress";
import { OPERATOR, SESSION } from "./_acts-rig";
import {
  PROBE_CATALOG,
  PROBE_MANIFEST,
  createProbeModule,
  makeRig,
  spoolRecords,
  spoolText,
  type ProbeModule,
  type Rig,
} from "./_module-rig";

// ── The module of these tests ────────────────────────────────────────────────

// Every test here starts real programs, and a busy machine starts one slowly.
setDefaultTimeout(30_000);
afterAll(() => setDefaultTimeout(5_000));

const DATABASES: ModuleManifest = {
  id: "databases",
  asks: [],
  acts: [
    {
      name: "host.add",
      role: "operator",
      args: S.record({ name: S.name, host: S.name, port: S.count(65_535) }),
      reply: S.none,
    },
    { name: "host.remove", role: "operator", args: S.record({ name: S.name }), reply: S.none },
    { name: "key.add", role: "operator", args: S.record({ name: S.name }), reply: S.none },
    { name: "key.remove", role: "operator", args: S.record({ name: S.name }), reply: S.none },
  ],
  egress: [],
  // A secret of the module's own, from its manifest. No program is handed it.
  secrets: ["own-token"],
  programs: [{ id: "data-runner" }],
};

const catalogWith = (manifest: ModuleManifest): CatalogEntry[] => [
  PROBE_CATALOG[0] as CatalogEntry,
  { id: manifest.id, title: "Databases", summary: "a module of these tests", manifest, startOnly: false },
];

function databasesModule(manifest: ModuleManifest = DATABASES): ProbeModule {
  const module = createProbeModule(manifest, { takesReleases: false });
  module.onAct = async (act, args, ctx: ModuleActContext) => {
    const given = args as { name: string; host: string; port: number };
    if (act === "host.add") await ctx.reach.add(given.name, { host: given.host, port: given.port });
    if (act === "host.remove") await ctx.reach.remove(given.name);
    if (act === "key.add") await ctx.secretNames.add(given.name);
    if (act === "key.remove") await ctx.secretNames.remove(given.name);
    return {};
  };
  return module;
}

// ── The program ──────────────────────────────────────────────────────────────

let dirs: string[] = [];
let rigs: Rig[] = [];
afterEach(async () => {
  for (const rig of rigs) await rig.cleanup().catch(() => {});
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
  rigs = [];
});

async function folder(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "hx-fortress-program-port-")));
  dirs.push(dir);
  return dir;
}

/** The stand-in program as a file that can be run (see `_program-child.ts`). */
async function program(): Promise<string> {
  const source = await readFile(path.join(import.meta.dir, "_program-child.ts"), "utf8");
  const file = path.join(await folder(), "helper.ts");
  await writeFile(file, `#!/usr/bin/env bun\n${source}`, { mode: 0o755 });
  return file;
}

/** Where the runtime and `env` are found: what the daemon's own PATH is here. */
const PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;

// Made-up values in the place of a login's password and of a certificate.
const PASSWORD = ["a-password", "of-the", "tests"].join("-");
const CERTIFICATE = "-----BEGIN CERTIFICATE-----\nbm90IGEgcmVhbCBjZXJ0aWZpY2F0ZQ==\n-----END CERTIFICATE-----\n";
const SERVER = "db.northstar.example";
const ADDRESS = "203.0.113.7";

interface ProgramRig extends Rig {
  ctx: ModuleContextV2;
  /** The names that were looked up, in order. */
  lookedUp: string[];
  /** What a name leads to. A test replaces it. `before` runs at each look-up. */
  leadsTo: { addresses: readonly string[] | Error; before?: () => Promise<void> };
  env: Record<string, string | undefined>;
}

async function programRig(
  options: {
    installed?: boolean;
    env?: Record<string, string | undefined>;
    manifest?: ModuleManifest;
    deps?: Partial<ModuleHostDeps>;
  } = {},
): Promise<ProgramRig> {
  const manifest = options.manifest ?? DATABASES;
  const env: Record<string, string | undefined> = {
    PATH,
    ...(options.installed === false ? {} : { FORTRESS_DATA_RUNNER: await program() }),
    ...options.env,
  };
  const lookedUp: string[] = [];
  const leadsTo: ProgramRig["leadsTo"] = { addresses: [ADDRESS] };
  const reachLookup: ReachLookup = async (name) => {
    lookedUp.push(name);
    await leadsTo.before?.();
    if (leadsTo.addresses instanceof Error) throw leadsTo.addresses;
    return leadsTo.addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  const module = databasesModule(manifest);
  const rig = await makeRig({
    enabled: ["session_vault", manifest.id],
    probe: module,
    deps: {
      catalog: catalogWith(manifest),
      env,
      reachLookup,
      programStopGraceMs: 300,
      programEndWaitMs: 3_000,
      ...options.deps,
    },
  });
  rigs.push(rig);
  if (!module.context) throw new Error("the module was not started");
  return { ...rig, ctx: module.context, lookedUp, leadsTo, env };
}

async function act(rig: Rig, name: string, args: Record<string, unknown>): Promise<void> {
  const answer = await rig.host.acts.handle({
    v: 1,
    person: OPERATOR,
    session: SESSION,
    module: "databases",
    act: name,
    args,
  });
  if (!answer.ok) throw new Error(`the act ${name} was refused: ${answer.error}`);
}

/** A host and a secret's name, added as a signed-in operator adds them, and
 *  the secret's value in the key store. */
async function withOrders(rig: ProgramRig, host = SERVER): Promise<void> {
  await act(rig, "host.add", { name: "orders-1", host, port: 5432 });
  await act(rig, "key.add", { name: "orders-reader" });
  rig.secrets.values["orders-reader"] = PASSWORD;
}

/** The job a module hands over: no address, no password. */
const job = (more: Record<string, unknown> = {}): Record<string, unknown> => ({
  do: "echo",
  v: 1,
  id: "job-0001",
  kind: "test",
  engine: "postgres",
  database: "orders",
  tls: { mode: "verify", minVersion: "1.2" },
  login: { kind: "read", user: "orders_reader" },
  ...more,
});

async function run(
  rig: ProgramRig,
  more: Partial<Record<keyof ProgramRun, unknown>> = {},
  program: unknown = "data-runner",
): Promise<{ end: ProgramOutcome; values: unknown[] }> {
  const values: unknown[] = [];
  const end = await rig.ctx.programs.run(program as string, {
    reach: "orders-1",
    secrets: { password: "orders-reader" },
    input: job(),
    onOutput: (value: unknown) => void values.push(value),
    ...more,
  } as ProgramRun);
  return { end, values };
}

/** The four calls of an organization's audit writer, each bound to it. */
type Writer = Pick<ReturnType<ModuleAudit["for"]>, "intent" | "outcome" | "event" | "refused">;

/**
 * A context of the same module on the same host, whose audit writer a test
 * changes. For the moments a test cannot reach from outside: a record that
 * cannot be written, and what happens while one is being written.
 */
function contextWith(
  rig: ProgramRig,
  change: (writer: Writer) => Writer,
  more: { said?: unknown[]; programs?: ModulePrograms; organization?: Organization } = {},
): ModuleContextV2 {
  const say = (level: string) => (message: string, fields?: unknown) =>
    void more.said?.push({ level, message, fields });
  const audit = {
    for: (organization: Parameters<ModuleAudit["for"]>[0]) => {
      const real = rig.host.audit.for(organization);
      return change({
        intent: (...args) => real.intent(...args),
        outcome: (...args) => real.outcome(...args),
        event: (...args) => real.event(...args),
        refused: (...args) => real.refused(...args),
      });
    },
  } as unknown as ModuleAudit;
  const host = rig.host as unknown as {
    organizations: Organizations;
    lists: NonNullable<Parameters<typeof createModuleContext>[1]["lists"]>;
  };
  return createModuleContext(
    DATABASES,
    {
      logger: () => ({ debug: say("debug"), info: say("info"), warn: say("warn"), error: say("error") }) as never,
      identity: () => null,
      secrets: rig.secrets,
      audit,
      organizations: host.organizations,
      lists: host.lists,
      programs: more.programs ?? rig.host.programs,
      programEnv: () => rig.env,
      reachLookup: async (name) => {
        rig.lookedUp.push(name);
        return [{ address: ADDRESS, family: 4 }];
      },
    },
    more.organization ?? rig.ctx.organization,
  );
}

/** What the host itself wrote about programs: one line for each record. */
async function hostLines(rig: Rig): Promise<string[]> {
  return (await spoolRecords(rig.paths))
    .filter((record) => record.action === AUDIT_ACTIONS.moduleProgram || record.action === AUDIT_ACTIONS.moduleRefused)
    .map(
      (record: AuditRecord) =>
        `${record.action} ${record.kind} ${record.outcome ?? "-"} ${record.error ?? "-"} ${JSON.stringify(record.params)}`,
    );
}

/** The two halves of a run's record. The second names the first, and holds
 *  how the run ended and nothing else. */
const INTENT = `system.module.program intent - - {"module":"databases","program":"data-runner","reach":"orders-1"}`;
const outcome = (how: string): string => `system.module.program outcome ${how} null`;
const refusedLine = (rule: string): string =>
  `system.module.refused outcome refused - {"module":"databases","rule":"${rule}"}`;

async function until(done: () => boolean | Promise<boolean>, what: string, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

// ── The job the program reads ────────────────────────────────────────────────

describe("the job the host writes for a program", () => {
  test("holds the module's fields, the host as it was added, the address that was looked up, and the password", async () => {
    const rig = await programRig();
    await withOrders(rig);
    const { end, values } = await run(rig);
    expect(end).toEqual({ ok: true });
    expect(values).toHaveLength(1);
    const printed = values[0] as { args: string[]; cwd: string; job: unknown };
    expect(printed.job).toEqual({
      ...job(),
      // The name, which is what the server's certificate is checked against.
      server: { host: SERVER, port: 5432 },
      // The address the program connects to: the one this host looked up.
      reach: { kind: "direct", host: ADDRESS, port: 5432 },
      login: { kind: "read", user: "orders_reader", password: PASSWORD },
    });
    expect(printed.args).toEqual(["run", "--job-stdin"]);
    expect(printed.cwd).toBe("/");
    expect(rig.lookedUp).toEqual([SERVER]);
    expect(rig.secrets.reads).toEqual(["orders-reader"]);
  });

  test("holds a company's own certificate authority when the run names its secret", async () => {
    const rig = await programRig();
    await withOrders(rig);
    await act(rig, "key.add", { name: "orders-ca" });
    rig.secrets.values["orders-ca"] = CERTIFICATE;
    const { end, values } = await run(rig, { secrets: { password: "orders-reader", caCertificate: "orders-ca" } });
    expect(end).toEqual({ ok: true });
    expect((values[0] as { job: { tls: unknown } }).job.tls).toEqual({
      mode: "verify",
      minVersion: "1.2",
      caCertificate: CERTIFICATE,
    });
    // A job with no `tls` of its own gets one that holds the certificate.
    const bare = await run(rig, {
      input: { do: "echo", login: { kind: "read", user: "orders_reader" } },
      secrets: { password: "orders-reader", caCertificate: "orders-ca" },
    });
    expect((bare.values[0] as { job: Record<string, unknown> }).job.tls).toEqual({ caCertificate: CERTIFICATE });
    // And a job with no `tls` and no certificate keeps none.
    const none = await run(rig, { input: { do: "echo", login: { kind: "read", user: "orders_reader" } } });
    expect(Object.hasOwn((none.values[0] as { job: Record<string, unknown> }).job, "tls")).toBe(false);
  });

  test("a host that is an address is not looked up, and the program is given that address twice", async () => {
    const rig = await programRig();
    await withOrders(rig, "10.4.0.9");
    const { end, values } = await run(rig);
    expect(end).toEqual({ ok: true });
    expect((values[0] as { job: Record<string, unknown> }).job).toMatchObject({
      server: { host: "10.4.0.9", port: 5432 },
      reach: { kind: "direct", host: "10.4.0.9", port: 5432 },
    });
    expect(rig.lookedUp).toEqual([]);
  });

  test("is built from a copy: what the module changes after the call changes nothing", async () => {
    const rig = await programRig();
    await withOrders(rig);
    const input = job();
    const secrets: Record<string, string> = { password: "orders-reader" };
    const values: unknown[] = [];
    const running = rig.ctx.programs.run("data-runner", {
      reach: "orders-1",
      secrets,
      input,
      onOutput: (value) => void values.push(value),
    });
    // The call has returned a promise, and nothing of the run has been read.
    // Each of these would have been refused had it been there at the call.
    (input.login as Record<string, unknown>).password = "the module's own";
    (input.tls as Record<string, unknown>).caCertificate = CERTIFICATE;
    input.server = { host: "elsewhere.northstar.example", port: 1 };
    input.reach = { kind: "direct", host: "127.0.0.1", port: 1 };
    input.store = { gatewayUrl: "http://127.0.0.1:4100/local/a-token" };
    input.database = "another";
    secrets.password = "own-token";
    expect(await running).toEqual({ ok: true });
    // The job is the one that was handed over at the call, with what the host
    // put in: nothing that was written into the module's object afterwards.
    expect((values[0] as { job: Record<string, unknown> }).job).toEqual({
      ...job(),
      server: { host: SERVER, port: 5432 },
      reach: { kind: "direct", host: ADDRESS, port: 5432 },
      login: { kind: "read", user: "orders_reader", password: PASSWORD },
    });
    expect(rig.secrets.reads).toEqual(["orders-reader"]);
  });
});

describe("what a program is given of the daemon's own", () => {
  test("PATH and where the certificate authorities are, the list's own variable, and nothing else", async () => {
    const rig = await programRig({
      env: {
        SSL_CERT_FILE: "/etc/ssl/northstar/authorities.pem",
        SSL_CERT_DIR: "/etc/ssl/northstar",
        HTTPS_PROXY: "http://proxy.northstar.example:3128",
        NO_PROXY: "localhost",
        PGPASSWORD: PASSWORD,
        FORTRESS_DATABASE_URL: "postgres://fortress@127.0.0.1:5432/fortress",
        FORTRESS_ENROLL_TOKEN: "an-enrollment-token-of-the-tests",
        DB_IO_NAMES_ITSELF: "0",
        HOME: "/home/fortress",
      },
    });
    await withOrders(rig);
    const { values } = await run(rig);
    const given = (values[0] as { env: Record<string, string> }).env;
    // The runtime that runs the stand-in adds nothing of its own to these.
    expect(Object.fromEntries(Object.entries(given).filter(([name]) => !name.startsWith("BUN_")))).toEqual({
      PATH,
      SSL_CERT_FILE: "/etc/ssl/northstar/authorities.pem",
      SSL_CERT_DIR: "/etc/ssl/northstar",
      // The list's value, and not the daemon's.
      DB_IO_NAMES_ITSELF: "1",
    });
    // The path's own variable is not passed on either.
    expect(JSON.stringify(given)).not.toContain("FORTRESS_");
  });

  test("a daemon with no setting for the certificate authorities passes none on", async () => {
    const rig = await programRig({ env: { SSL_CERT_FILE: "" } });
    await withOrders(rig);
    const { values } = await run(rig);
    const given = (values[0] as { env: Record<string, string> }).env;
    expect(Object.keys(given).filter((name) => !name.startsWith("BUN_")).sort()).toEqual(["DB_IO_NAMES_ITSELF", "PATH"]);
  });
});

// ── What is refused before anything is read ──────────────────────────────────

describe("a run is refused before anything is read", () => {
  test("for a program the manifest does not list, or the host's list does not give to this module", async () => {
    const rig = await programRig();
    await withOrders(rig);
    for (const id of ["store-engine", "DATA-RUNNER", "data-runner ", "", "toString", "__proto__", null, 7, ["data-runner"]]) {
      expect([id, (await run(rig, {}, id)).end]).toEqual([id, { ok: false, code: "program_not_declared" }]);
    }
    // A module whose manifest lists no program.
    const silent = await programRig({ manifest: { ...DATABASES, programs: [] } });
    await withOrders(silent);
    expect((await run(silent)).end).toEqual({ ok: false, code: "program_not_declared" });
    expect(silent.secrets.reads).toEqual([]);
    expect(silent.lookedUp).toEqual([]);
    // A manifest that names the program for a module the list does not give
    // it to. No module host takes such a manifest, so the context is built here.
    const other: ModuleManifest = { ...PROBE_MANIFEST, programs: [{ id: "data-runner" }] };
    expect(manifestDefect(other)).toBe("this build runs no program data-runner for this module");
    const direct = createModuleContext(
      other,
      {
        logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) as never,
        identity: () => null,
        secrets: rig.secrets,
        audit: rig.host.audit,
        organizations: (rig.host as unknown as { organizations: Organizations }).organizations,
        programs: rig.host.programs,
        programEnv: () => rig.env,
      },
      rig.ctx.organization,
    );
    expect(
      await direct.programs.run("data-runner", {
        reach: "orders-1",
        secrets: { password: "orders-reader" },
        input: job(),
        onOutput: () => {},
      }),
    ).toEqual({ ok: false, code: "program_not_declared" });
    // And a context that was handed no launcher has none run.
    const none = createModuleContext(
      DATABASES,
      {
        logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) as never,
        identity: () => null,
        secrets: rig.secrets,
        audit: rig.host.audit,
        organizations: (rig.host as unknown as { organizations: Organizations }).organizations,
      },
      rig.ctx.organization,
    );
    expect(
      await none.programs.run("data-runner", {
        reach: "orders-1",
        secrets: { password: "orders-reader" },
        input: job(),
        onOutput: () => {},
      }),
    ).toEqual({ ok: false, code: "program_not_declared" });
    expect(rig.host.programs.count("databases")).toBe(0);
  });

  test("for a job that holds an address, a password or a certificate of the module's own", async () => {
    const rig = await programRig();
    await withOrders(rig);
    const holding: [string, unknown][] = [
      ["a server", job({ server: { host: "elsewhere.northstar.example", port: 5432 } })],
      ["a server that is null", job({ server: null })],
      ["a reach", job({ reach: { kind: "direct", host: "127.0.0.1", port: 5432 } })],
      ["a password", job({ login: { kind: "read", user: "orders_reader", password: "the module's own" } })],
      ["a password that is empty", job({ login: { kind: "read", user: "orders_reader", password: "" } })],
      ["a certificate", job({ tls: { mode: "verify", caCertificate: CERTIFICATE } })],
      ["no login", { do: "echo" }],
      ["a login that is a text", job({ login: "orders_reader" })],
      ["a login that is a list", job({ login: [] })],
      ["a tls that is a text", job({ tls: "verify" })],
      ["a tls that is null", job({ tls: null })],
      ["the address of a door", job({ store: { gatewayUrl: "http://127.0.0.1:4100/local/a-token", storeId: "s1" } })],
      ["a store that is a text", job({ store: "s1" })],
      ["nothing", undefined],
      ["null", null],
      ["a list", [job()]],
      ["a text", JSON.stringify(job())],
      ["a number", 7],
      // A field that DB IO would read as one of the host's own: it takes a
      // name without regard to the case of its letters.
      ["a Tls beside tls", job({ Tls: { mode: "verify", caCertificate: CERTIFICATE } })],
      ["a Tls and no tls", { do: "echo", login: { kind: "read", user: "orders_reader" }, Tls: { caCertificate: CERTIFICATE } }],
      ["a Store", job({ Store: { gatewayUrl: "http://127.0.0.1:4100/local/a-token" } })],
      ["a Login after login", job({ Login: { password: "the module's own" } })],
      ["a LOGIN and no login", { do: "echo", LOGIN: { kind: "read", user: "orders_reader" } }],
      ["a Server", job({ Server: { host: "elsewhere.northstar.example", port: 5432 } })],
      ["a REACH", job({ REACH: { kind: "direct", host: "127.0.0.1", port: 5432 } })],
      ["a Password in login", job({ login: { kind: "read", user: "orders_reader", Password: "the module's own" } })],
      ["a CaCertificate in tls", job({ tls: { mode: "verify", CaCertificate: CERTIFICATE } })],
      ["a CACERTIFICATE in tls", job({ tls: { mode: "verify", CACERTIFICATE: CERTIFICATE } })],
      ["a GatewayUrl in store", job({ store: { storeId: "s1", GatewayUrl: "http://127.0.0.1:4100/local/a-token" } })],
      // Two letters outside ASCII that DB IO reads as `s` and as `k`, and a
      // name that is no plain name.
      ["a long s in store", job({ ["ſtore"]: { gatewayUrl: "http://127.0.0.1:4100/local/a-token" } })],
      ["a long s in tls", job({ ["tlſ"]: { caCertificate: CERTIFICATE } })],
      ["a Kelvin sign in a name", job({ ["Kind"]: "test" })],
      ["a long s in password", job({ login: { kind: "read", user: "orders_reader", ["paſſword"]: "x" } })],
      ["a name with a space", job({ "a field": 1 })],
    ];
    for (const [what, input] of holding) {
      expect([what, (await run(rig, { input })).end]).toEqual([what, { ok: false, code: "job_invalid" }]);
    }
    // A value that JSON cannot write.
    const itself: Record<string, unknown> = job();
    itself.again = itself;
    expect((await run(rig, { input: itself })).end).toEqual({ ok: false, code: "job_invalid" });
    expect((await run(rig, { input: job({ rows: 12n }) })).end).toEqual({ ok: false, code: "job_invalid" });
    expect(rig.secrets.reads).toEqual([]);
    expect(rig.lookedUp).toEqual([]);
    expect(rig.host.programs.count("databases")).toBe(0);
  });

  test("for secrets that name another field, leave the password out, or are no names", async () => {
    const rig = await programRig();
    await withOrders(rig);
    for (const secrets of [
      {},
      { caCertificate: "orders-reader" },
      { password: "orders-reader", key: "orders-reader" },
      { password: "orders-reader", user: "orders-reader" },
      { password: 7 },
      { password: null },
      { password: ["orders-reader"] },
      { password: "orders-reader", caCertificate: null },
      { password: "orders-reader", toString: "orders-reader" },
      ["orders-reader"],
      "orders-reader",
      null,
      undefined,
    ]) {
      expect([secrets, (await run(rig, { secrets })).end]).toEqual([secrets, { ok: false, code: "job_invalid" }]);
    }
    expect(rig.secrets.reads).toEqual([]);
  });

  test("for a run with no listener, or with something that is no signal", async () => {
    const rig = await programRig();
    await withOrders(rig);
    for (const onOutput of [undefined, null, "print", {}]) {
      expect([onOutput, (await run(rig, { onOutput })).end]).toEqual([onOutput, { ok: false, code: "job_invalid" }]);
    }
    for (const signal of [null, "abort", { aborted: false }, new EventTarget()]) {
      expect([signal, (await run(rig, { signal })).end]).toEqual([signal, { ok: false, code: "job_invalid" }]);
    }
    // No run at all is one too.
    expect(await rig.ctx.programs.run("data-runner", undefined as unknown as ProgramRun)).toEqual({
      ok: false,
      code: "job_invalid",
    });
    expect(rig.host.programs.count("databases")).toBe(0);
  });

  test("for a job that is too large already", async () => {
    const rig = await programRig();
    await withOrders(rig);
    expect(PROGRAM_JOB_MAX_BYTES).toBe(1024 * 1024);
    const { end } = await run(rig, { input: job({ pad: "x".repeat(PROGRAM_JOB_MAX_BYTES) }) });
    expect(end).toEqual({ ok: false, code: "job_invalid" });
    expect(rig.secrets.reads).toEqual([]);
    expect(await hostLines(rig)).toEqual([refusedLine("job_invalid")]);
  });

  test("for a host that is not on the list", async () => {
    const rig = await programRig();
    await withOrders(rig);
    for (const reach of ["orders-2", "Orders-1", "orders-1 ", "", SERVER, ADDRESS, null, undefined, 7, ["orders-1"]]) {
      expect([reach, (await run(rig, { reach })).end]).toEqual([reach, { ok: false, code: "reach_not_listed" }]);
    }
    // A host that was taken off the list is not one any more.
    await act(rig, "host.remove", { name: "orders-1" });
    expect((await run(rig)).end).toEqual({ ok: false, code: "reach_not_listed" });
    expect(rig.secrets.reads).toEqual([]);
    expect(rig.lookedUp).toEqual([]);
  });

  test("for a list of hosts that cannot be read, and the record says so", async () => {
    const rig = await programRig();
    await withOrders(rig);
    const file = path.join(path.dirname(rig.paths.moduleState("databases")), "reach.json");
    await writeFile(file, "{ this is not the list");
    expect((await run(rig)).end).toEqual({ ok: false, code: "reach_not_listed" });
    expect(await hostLines(rig)).toEqual([refusedLine("reach_list_unreadable")]);
    expect(rig.secrets.reads).toEqual([]);
  });

  test("for a secret's name that no person added, and for a name from the manifest", async () => {
    const rig = await programRig();
    await withOrders(rig);
    rig.secrets.values["own-token"] = "the module's own secret";
    rig.secrets.values["never-added"] = PASSWORD;
    for (const name of ["never-added", "own-token", "Orders-Reader", "orders-reader ", ""]) {
      expect([name, (await run(rig, { secrets: { password: name } })).end]).toEqual([
        name,
        { ok: false, code: "secret_not_added" },
      ]);
    }
    // The certificate's name is held to the same rule.
    expect((await run(rig, { secrets: { password: "orders-reader", caCertificate: "own-token" } })).end).toEqual({
      ok: false,
      code: "secret_not_added",
    });
    // A name that was taken off the list is not one any more.
    await act(rig, "key.remove", { name: "orders-reader" });
    expect((await run(rig)).end).toEqual({ ok: false, code: "secret_not_added" });
    expect(rig.secrets.reads).toEqual([]);
    expect(rig.lookedUp).toEqual([]);
    expect(rig.host.programs.count("databases")).toBe(0);
  });

  test("for a list of names that cannot be read, and for a name that a setting reads too", async () => {
    const rig = await programRig();
    await withOrders(rig);
    const names = path.join(path.dirname(rig.paths.moduleState("databases")), "secret-names.json");
    const kept = await readFile(names, "utf8");
    await writeFile(names, "{ this is not the list");
    expect((await run(rig)).end).toEqual({ ok: false, code: "secret_not_added" });
    await writeFile(names, kept);
    // A context whose host says that a setting of its own reads this name.
    const reserving = createModuleContext(
      DATABASES,
      {
        logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) as never,
        identity: () => null,
        secrets: rig.secrets,
        audit: rig.host.audit,
        organizations: (rig.host as unknown as { organizations: Organizations }).organizations,
        lists: (rig.host as unknown as { lists: NonNullable<Parameters<typeof createModuleContext>[1]["lists"]> }).lists,
        reservedSecretNames: async () => new Set(["orders-reader"]),
        programs: rig.host.programs,
        programEnv: () => rig.env,
      },
      rig.ctx.organization,
    );
    expect(
      await reserving.programs.run("data-runner", {
        reach: "orders-1",
        secrets: { password: "orders-reader" },
        input: job(),
        onOutput: () => {},
      }),
    ).toEqual({ ok: false, code: "secret_not_added" });
    expect(await hostLines(rig)).toEqual([refusedLine("secret_names_unreadable"), refusedLine("secret_name_reserved")]);
    expect(rig.secrets.reads).toEqual([]);
  });

  test("on a host that has no such program: no secret is read for it", async () => {
    const nowhere = path.join(await folder(), "not-there");
    const plain = path.join(await folder(), "not-a-program");
    await writeFile(plain, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    const inside = await folder();
    for (const set of [undefined, "", "   ", "data-runner", "./data-runner", nowhere, plain, inside]) {
      const rig = await programRig({ installed: false, env: { FORTRESS_DATA_RUNNER: set } });
      await withOrders(rig);
      expect([set, (await run(rig)).end]).toEqual([set, { ok: false, code: "program_not_installed" }]);
      expect(rig.secrets.reads).toEqual([]);
      expect(rig.lookedUp).toEqual([]);
      expect(await hostLines(rig)).toEqual([refusedLine("program_not_installed")]);
    }
  });

  test("leaves one record with the word, and nothing of what was asked for", async () => {
    const rig = await programRig();
    await withOrders(rig);
    await run(rig, { reach: "a-host-that-nobody-added" });
    await run(rig, { secrets: { password: "a-name-that-nobody-added" } });
    await run(rig, { input: job({ server: { host: "elsewhere.northstar.example", port: 5432 } }) });
    await run(rig, {}, "a-program-that-is-not-one");
    expect(await hostLines(rig)).toEqual([
      refusedLine("reach_not_listed"),
      refusedLine("secret_not_added"),
      refusedLine("job_invalid"),
      refusedLine("program_not_declared"),
    ]);
    const spool = await spoolText(rig.paths);
    for (const asked of ["a-host-that-nobody-added", "a-name-that-nobody-added", "elsewhere", "a-program-that-is-not-one"]) {
      expect([asked, spool.includes(asked)]).toEqual([asked, false]);
    }
  });
});

// ── The record of a run ──────────────────────────────────────────────────────

describe("the record of a run", () => {
  test("is a pair with the module, the program and the host's name, and nothing of the job or of what was printed", async () => {
    const rig = await programRig();
    await withOrders(rig);
    const { end, values } = await run(rig, { input: job({ params: { sql: "SELECT fee FROM permits" } }) });
    expect(end).toEqual({ ok: true });
    expect(values).toHaveLength(1);
    expect(await hostLines(rig)).toEqual([INTENT, outcome("ok -")]);
    const records = (await spoolRecords(rig.paths)).filter((record) => record.action === AUDIT_ACTIONS.moduleProgram);
    // The second half names the first.
    expect([records[1]?.refFileId, records[1]?.refSeq]).toEqual([records[0]?.fileId ?? "", records[0]?.seq ?? -1]);
    // Nobody's: the host ran it for the module.
    expect(records.map((record) => [record.actor, record.sessionRef])).toEqual([
      [null, null],
      [null, null],
    ]);
    const own = JSON.stringify(records);
    for (const kept of [PASSWORD, "orders_reader", "orders-reader", SERVER, ADDRESS, "5432", "SELECT", "job-0001"]) {
      expect([kept, own.includes(kept)]).toEqual([kept, false]);
    }
    // The log holds none of them either, nor the path's value.
    const log = JSON.stringify(rig.logs);
    for (const kept of [PASSWORD, "orders_reader", "SELECT fee", ADDRESS]) expect([kept, log.includes(kept)]).toEqual([kept, false]);
  });

  test("its first half is on the disk before a secret is read and before the host's name is looked up", async () => {
    const rig = await programRig();
    await withOrders(rig);
    const seen: { at: string; lines: string[] }[] = [];
    const read = rig.secrets.get.bind(rig.secrets);
    rig.secrets.get = async (name) => {
      seen.push({ at: `read ${name}`, lines: await hostLines(rig) });
      return read(name);
    };
    rig.leadsTo.before = async () => void seen.push({ at: "looked up", lines: await hostLines(rig) });
    expect((await run(rig)).end).toEqual({ ok: true });
    expect(seen).toEqual([
      { at: "read orders-reader", lines: [INTENT] },
      { at: "looked up", lines: [INTENT] },
    ]);
  });

  test("a run that cannot be recorded is not made, and nothing is read for it", async () => {
    const rig = await programRig();
    await withOrders(rig);
    // The own organization's writer, with a first half that cannot be written.
    const said: unknown[] = [];
    const ctx = contextWith(
      rig,
      (writer) => ({ ...writer, intent: () => Promise.reject(new Error("the disk is full")) }),
      { said },
    );
    const values: unknown[] = [];
    expect(
      await ctx.programs.run("data-runner", {
        reach: "orders-1",
        secrets: { password: "orders-reader" },
        input: job(),
        onOutput: (value) => void values.push(value),
      }),
    ).toEqual({ ok: false, code: "audit_unavailable" });
    expect(values).toEqual([]);
    expect(rig.secrets.reads).toEqual([]);
    expect(rig.lookedUp).toEqual([]);
    // No record can say it, so the daemon's log does, and holds nothing of
    // what was thrown.
    expect(said).toEqual([
      {
        level: "error",
        message: "no program was run for a module: the record of the run could not be written",
        fields: { program: "data-runner", rule: "audit_unavailable" },
      },
    ]);
    expect(await hostLines(rig)).toEqual([]);
  });

  test("says how a run ended that was recorded: a failure, or a rule's refusal", async () => {
    const rig = await programRig();
    await withOrders(rig);
    const ends: [string, () => Promise<ProgramOutcome>, string][] = [
      [
        "the key store holds no such secret",
        async () => {
          delete rig.secrets.values["orders-reader"];
          const { end } = await run(rig);
          rig.secrets.values["orders-reader"] = PASSWORD;
          return end;
        },
        "failed secret_missing",
      ],
      [
        "the key store did not answer",
        async () => {
          const read = rig.secrets.get;
          rig.secrets.get = async (name) => {
            throw new SecretUnavailable(name, "the store returned 503 for vault.northstar.example");
          };
          const { end } = await run(rig);
          rig.secrets.get = read;
          return end;
        },
        "failed secret_unavailable",
      ],
      [
        "the name was not found",
        async () => {
          rig.leadsTo.addresses = Object.assign(new Error(`getaddrinfo ENOTFOUND ${SERVER}`), { code: "ENOTFOUND" });
          return (await run(rig)).end;
        },
        "failed reach_unresolved",
      ],
      [
        "the name leads to this machine",
        async () => {
          rig.leadsTo.addresses = ["127.0.0.1"];
          return (await run(rig)).end;
        },
        "refused reach_address_refused",
      ],
      [
        "the name leads to a cloud's metadata address among others",
        async () => {
          rig.leadsTo.addresses = [ADDRESS, "169.254.169.254"];
          return (await run(rig)).end;
        },
        "refused reach_address_refused",
      ],
      [
        "the program ended badly",
        async () => {
          rig.leadsTo.addresses = [ADDRESS];
          return (await run(rig, { input: job({ do: "exit", code: 3 }) })).end;
        },
        "failed program_failed",
      ],
      [
        "the program printed what is not JSON",
        async () => (await run(rig, { input: job({ do: "not-json" }) })).end,
        "failed program_failed",
      ],
      [
        "its time was up",
        async () => (await run(rig, { input: job({ do: "hang" }), timeoutMs: 300 })).end,
        "failed timeout",
      ],
    ];
    const expected: string[] = [];
    for (const [what, make, line] of ends) {
      const word = line.split(" ")[1];
      expect([what, await make()]).toEqual([what, { ok: false, code: word as never }]);
      expected.push(INTENT, outcome(line));
    }
    expect(await hostLines(rig)).toEqual(expected);
    // Nothing that a failure said is in a record or in the log.
    const written = (await spoolText(rig.paths)) + JSON.stringify(rig.logs);
    for (const said of ["vault.northstar.example", "ENOTFOUND", "169.254.169.254", "127.0.0.1"]) {
      expect([said, written.includes(said)]).toEqual([said, false]);
    }
    expect(rig.host.programs.count("databases")).toBe(0);
  });

  test("a finished job that is too large is not handed to the program", async () => {
    const rig = await programRig();
    await withOrders(rig);
    await act(rig, "key.add", { name: "orders-ca" });
    // The module's own part fits. The certificate makes the whole too large.
    rig.secrets.values["orders-ca"] = "c".repeat(PROGRAM_JOB_MAX_BYTES);
    const { end, values } = await run(rig, { secrets: { password: "orders-reader", caCertificate: "orders-ca" } });
    expect(end).toEqual({ ok: false, code: "job_invalid" });
    expect(values).toEqual([]);
    expect((await hostLines(rig)).slice(-2)).toEqual([INTENT, outcome("failed job_invalid")]);
  });

  test("a secret's name that is taken off the list after the check is not read", async () => {
    const rig = await programRig();
    await withOrders(rig);
    // The moment between the check of the names and the read is the write of
    // the record's first half. An operator takes the name off right then.
    const ctx = contextWith(rig, (writer) => ({
      ...writer,
      intent: async (...args) => {
        const written = await writer.intent(...args);
        await act(rig, "key.remove", { name: "orders-reader" });
        return written;
      },
    }));
    const values: unknown[] = [];
    expect(
      await ctx.programs.run("data-runner", {
        reach: "orders-1",
        secrets: { password: "orders-reader" },
        input: job(),
        onOutput: (value) => void values.push(value),
      }),
    ).toEqual({ ok: false, code: "secret_not_added" });
    expect(values).toEqual([]);
    expect(rig.secrets.reads).toEqual([]);
    expect(rig.lookedUp).toEqual([]);
    // One pair, and no second record beside it.
    expect(await hostLines(rig)).toEqual([INTENT, outcome("refused secret_not_added")]);
  });

  test("a host that is taken off the list after the check is sent no program", async () => {
    const rig = await programRig();
    await withOrders(rig);
    const ctx = contextWith(rig, (writer) => ({
      ...writer,
      intent: async (...args) => {
        const written = await writer.intent(...args);
        await act(rig, "host.remove", { name: "orders-1" });
        return written;
      },
    }));
    const values: unknown[] = [];
    expect(
      await ctx.programs.run("data-runner", {
        reach: "orders-1",
        secrets: { password: "orders-reader" },
        input: job(),
        onOutput: (value) => void values.push(value),
      }),
    ).toEqual({ ok: false, code: "reach_not_listed" });
    expect(values).toEqual([]);
    expect(rig.secrets.reads).toEqual([]);
    expect(rig.lookedUp).toEqual([]);
    expect(await hostLines(rig)).toEqual([INTENT, outcome("refused reach_not_listed")]);
  });

  test("a run that its caller gives up while its record is written has nothing read for it", async () => {
    const rig = await programRig();
    await withOrders(rig);
    const abort = new AbortController();
    const ctx = contextWith(rig, (writer) => ({
      ...writer,
      intent: async (...args) => {
        const written = await writer.intent(...args);
        abort.abort();
        return written;
      },
    }));
    expect(
      await ctx.programs.run("data-runner", {
        reach: "orders-1",
        secrets: { password: "orders-reader" },
        input: job(),
        onOutput: () => {},
        signal: abort.signal,
      }),
    ).toEqual({ ok: false, code: "program_failed" });
    expect(rig.secrets.reads).toEqual([]);
    expect(rig.lookedUp).toEqual([]);
    expect(await hostLines(rig)).toEqual([INTENT, outcome("failed program_failed")]);
  });

  test("what the launcher answers at the start is the second half: a refusal by a rule, or a failure", async () => {
    const rig = await programRig();
    await withOrders(rig);
    const expected: string[] = [];
    for (const [code, how] of [
      ["busy", "refused"],
      ["module_not_running", "refused"],
      ["program_not_installed", "failed"],
      ["timeout", "failed"],
      ["program_failed", "failed"],
    ] as const) {
      // A launcher whose first look takes the run, and whose start does not.
      const programs = {
        refusal: () => null,
        run: async () => ({ ok: false, code }),
      } as unknown as ModulePrograms;
      const ctx = contextWith(rig, (writer) => writer, { programs });
      expect([
        code,
        await ctx.programs.run("data-runner", {
          reach: "orders-1",
          secrets: { password: "orders-reader" },
          input: job(),
          onOutput: () => {},
        }),
      ]).toEqual([code, { ok: false, code }]);
      expected.push(INTENT, outcome(`${how} ${code}`));
    }
    expect(await hostLines(rig)).toEqual(expected);
  });

  test("its second half is on the disk before the launcher lets the run go", async () => {
    const rig = await programRig();
    await withOrders(rig);
    // A writer whose second half takes a while, as a slow disk makes it.
    const ctx = contextWith(rig, (writer) => ({
      ...writer,
      outcome: async (...args) => {
        await Bun.sleep(200);
        return writer.outcome(...args);
      },
    }));
    const values: unknown[] = [];
    const running = ctx.programs.run("data-runner", {
      reach: "orders-1",
      secrets: { password: "orders-reader" },
      input: job({ do: "hang" }),
      onOutput: (value) => void values.push(value),
    });
    await until(() => values.length === 1, "the program to start", 20_000);
    // What a module's switch-off and the daemon's stop call.
    await rig.host.programs.endAll("databases");
    expect(await hostLines(rig)).toEqual([INTENT, outcome("failed program_failed")]);
    expect(await running).toEqual({ ok: false, code: "program_failed" });
  });

  test("a context of another organization has no secret read for a program, whatever its lists hold", async () => {
    const rig = await programRig();
    await withOrders(rig);
    const other = { id: "alder-dental", own: false } as Organization;
    // The own organization's two lists, copied by hand to where another
    // organization's would be. No act can make such files: an act is for
    // this HX Fortress's own organization.
    const organizations = (rig.host as unknown as { organizations: Organizations }).organizations;
    const from = path.dirname(rig.paths.moduleState("databases"));
    const to = organizations.listsDir(other, "databases");
    await mkdir(to, { recursive: true });
    for (const file of ["reach.json", "secret-names.json"]) await copyFile(path.join(from, file), path.join(to, file));
    const ctx = contextWith(rig, (writer) => writer, { organization: other });
    expect(await ctx.reach.list()).toMatchObject([{ name: "orders-1" }]);
    expect(
      await ctx.programs.run("data-runner", {
        reach: "orders-1",
        secrets: { password: "orders-reader" },
        input: job(),
        onOutput: () => {},
      }),
    ).toEqual({ ok: false, code: "secret_not_added" });
    expect(rig.secrets.reads).toEqual([]);
    expect(rig.lookedUp).toEqual([]);
  });
});

// ── What is passed through, and what ends a run ──────────────────────────────

describe("what a program prints", () => {
  test("reaches the module's listener, value by value, and a listener's failure is its own", async () => {
    const rig = await programRig();
    await withOrders(rig);
    const { end, values } = await run(rig, {
      input: job({ do: "lines", values: [{ n: 1 }, "two", 3, null, [4, 5], { rows: [["Maria Okafor", 4471]] }] }),
    });
    expect(end).toEqual({ ok: true });
    expect(values).toEqual([{ n: 1 }, "two", 3, null, [4, 5], { rows: [["Maria Okafor", 4471]] }]);
    const thrown = await run(rig, {
      input: job({ do: "lines", values: [{ row: "Maria Okafor" }] }),
      onOutput: () => {
        throw new Error("could not keep Maria Okafor");
      },
    });
    expect(thrown.end).toEqual({ ok: true });
    expect(JSON.stringify(rig.logs) + (await spoolText(rig.paths))).not.toContain("Maria Okafor");
  });
});

describe("what ends a run", () => {
  test("its caller's signal", async () => {
    const rig = await programRig();
    await withOrders(rig);
    const abort = new AbortController();
    const values: unknown[] = [];
    const running = run(rig, { input: job({ do: "hang" }), signal: abort.signal, onOutput: (value: unknown) => void values.push(value) });
    await until(() => values.length === 1, "the program to start");
    abort.abort();
    expect((await running).end).toEqual({ ok: false, code: "program_failed" });
    expect(rig.host.programs.count("databases")).toBe(0);
    // A signal that was aborted before the call starts nothing. Nothing is
    // read for it, and nothing is recorded: its caller asked for nothing.
    const reads = rig.secrets.reads.length;
    const lines = (await hostLines(rig)).length;
    const { end } = await run(rig, { signal: AbortSignal.abort() });
    expect(end).toEqual({ ok: false, code: "program_failed" });
    expect([rig.secrets.reads.length, (await hostLines(rig)).length]).toEqual([reads, lines]);
  });

  test("the module being switched off, and a context it kept has none run after that", async () => {
    const rig = await programRig();
    await withOrders(rig);
    const values: unknown[] = [];
    const running = run(rig, { input: job({ do: "hang" }), onOutput: (value: unknown) => void values.push(value) });
    await until(() => values.length === 1, "the program to start");
    await setModuleEnabled(rig.paths, "databases", false);
    await rig.host.follow();
    // The switch-off waited for the run's record, as the daemon's stop does.
    expect((await hostLines(rig)).slice(-2)).toEqual([INTENT, outcome("failed program_failed")]);
    expect((await running).end).toEqual({ ok: false, code: "program_failed" });
    expect(rig.host.programs.count("databases")).toBe(0);
    const reads = rig.secrets.reads.length;
    expect((await run(rig)).end).toEqual({ ok: false, code: "module_not_running" });
    expect(rig.secrets.reads.length).toBe(reads);
    expect((await hostLines(rig)).slice(-3)).toEqual([
      INTENT,
      outcome("failed program_failed"),
      refusedLine("module_not_running"),
    ]);
  });

  test("the daemon's stop, and the second half of the record is still written", async () => {
    const rig = await programRig();
    await withOrders(rig);
    const values: unknown[] = [];
    const running = run(rig, {
      input: job({ do: "hang-through-a-stop" }),
      onOutput: (value: unknown) => void values.push(value),
    });
    await until(() => values.length === 1, "the program to start");
    await rig.host.stop();
    // The stop waited for the run's record. Both halves are on the disk when
    // it answers, before this test has looked at how the run ended.
    expect(await hostLines(rig)).toEqual([INTENT, outcome("failed program_failed")]);
    expect((await running).end).toEqual({ ok: false, code: "program_failed" });
    // Nothing is started after the stop.
    expect((await run(rig)).end.ok).toBe(false);
    expect(rig.host.programs.count("databases")).toBe(0);
  });

  test("a module runs four at once, and a fifth that comes while they run is refused before anything is read for it", async () => {
    const rig = await programRig();
    await withOrders(rig);
    const aborts: AbortController[] = [];
    const started: unknown[] = [];
    const runs: Promise<{ end: ProgramOutcome }>[] = [];
    for (let i = 0; i < PROGRAMS_MAX_PER_MODULE; i += 1) {
      const abort = new AbortController();
      aborts.push(abort);
      runs.push(run(rig, { input: job({ do: "hang" }), signal: abort.signal, onOutput: (value: unknown) => void started.push(value) }));
    }
    await until(() => started.length === PROGRAMS_MAX_PER_MODULE, "four programs to start", 20_000);
    const reads = rig.secrets.reads.length;
    expect((await run(rig)).end).toEqual({ ok: false, code: "busy" });
    expect(rig.secrets.reads.length).toBe(reads);
    expect((await hostLines(rig)).at(-1)).toBe(refusedLine("busy"));
    aborts[0]?.abort();
    await runs[0];
    // One has ended, so one more is taken.
    expect((await run(rig)).end).toEqual({ ok: true });
    for (const abort of aborts) abort.abort();
    await Promise.all(runs);
    expect(rig.host.programs.count("databases")).toBe(0);
  }, 40_000);
});

// ── The rest of the port ─────────────────────────────────────────────────────

describe("the port", () => {
  test("never rejects, whatever it is handed", async () => {
    const rig = await programRig();
    await withOrders(rig);
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error(`looked at ${PASSWORD}`);
        },
      },
    );
    const end = await rig.ctx.programs.run("data-runner", hostile as ProgramRun);
    expect(end).toEqual({ ok: false, code: "program_failed" });
    expect(JSON.stringify(rig.logs)).not.toContain(PASSWORD);
    for (const code of PROGRAM_FAILURE_CODES) expect(typeof code).toBe("string");
  });

  test("is on the context a module is started with, on an ask's and on an act's", async () => {
    const seen: { where: string; has: boolean }[] = [];
    const manifest: ModuleManifest = {
      ...DATABASES,
      asks: [{ name: "port.probe", args: S.none, reply: S.record({ ok: S.flag }) }],
      acts: [...(DATABASES.acts ?? []), { name: "port.probe", role: "readonly", args: S.none, reply: S.none }],
    };
    const module = databasesModule(manifest);
    const onAct = module.onAct;
    module.onAct = async (name, args, ctx, person) => {
      if (name === "port.probe") {
        seen.push({ where: "act", has: typeof ctx.programs.run === "function" });
        return {};
      }
      return onAct?.(name, args, ctx, person);
    };
    const rig = await makeRig({
      enabled: ["session_vault", "databases"],
      probe: module,
      deps: { catalog: catalogWith(manifest), env: {} },
    });
    rigs.push(rig);
    seen.push({ where: "start", has: typeof module.context?.programs.run === "function" });
    await rig.host.acts.handle({ v: 1, person: OPERATOR, session: SESSION, module: "databases", act: "port.probe", args: {} });
    expect(seen).toEqual([
      { where: "start", has: true },
      { where: "act", has: true },
    ]);
  });
});

// ── What a person is shown ───────────────────────────────────────────────────

describe("what the terminal and the What Leaves page say of a program", () => {
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

  test("the listing, the terminal and the page name the program and the variable that holds its path", async () => {
    const rig = await programRig();
    await withOrders(rig);
    const catalog = catalogWith(DATABASES);
    const view = (await listModules(rig.paths, { catalog })).find((module) => module.id === "databases");
    expect(view?.programs).toEqual([{ id: "data-runner", title: "DB IO", pathVariable: "FORTRESS_DATA_RUNNER" }]);
    // A module with no program has no such field.
    expect(Object.hasOwn((await listModules(rig.paths, { catalog: PROBE_CATALOG }))[0] ?? {}, "programs")).toBe(false);

    const out: string[] = [];
    expect(await runModulesVerb(["list"], { fortressRoot: rig.paths.root, catalog, writeLine: (line) => out.push(line) })).toBe(0);
    expect(out).toContain(
      "  Runs:     DB IO, the file that FORTRESS_DATA_RUNNER names. The daemon runs this helper program for the " +
        "module, with one job on its standard input.",
    );
    const plain: string[] = [];
    await runModulesVerb(["list"], { fortressRoot: rig.paths.root, catalog: PROBE_CATALOG, writeLine: (line) => plain.push(line) });
    expect(plain.join("\n")).not.toContain("Runs:");

    const source = { cloudUrl: "wss://control.example/v1/connection", env: {} };
    const paths = await moduleDataPaths(rig.paths, source, { catalog });
    expect(paths.on.find((module) => module.id === "databases")?.programs).toEqual(view?.programs);
    const row = dataPathRows(egress(paths)).find((found) => found.id === "module-reach");
    expect(row?.peer).toBe(`${SERVER}:5432`);
    expect(row?.carries).toContain("what a module's helper program sends to the database there");
    expect(row?.carries).toContain("its sign-in with the login whose secret the connection names");
    expect(row?.carries).toContain(
      "For a test of a connection that is the server's version, how the link was encrypted, what the login may " +
        "change, and the names of the tables and of their columns with a count of rows",
    );
    expect(row?.gate).toContain("The address that a name leads to is looked up each time a program is sent there");
    expect(row?.notes?.[0]).toBe(
      "databases: the daemon runs DB IO for it, the file that FORTRESS_DATA_RUNNER names in the daemon's own " +
        "environment. It is started with fixed arguments and no shell, and is given one job on its standard input: " +
        "the address, the login and its password. Of the daemon's environment it is given PATH, SSL_CERT_FILE and " +
        "SSL_CERT_DIR, and nothing else. Each run is a pair of records in the audit trail",
    );
    expect(row?.notes?.[1]).toBe(
      "Before each run the daemon asks this machine's own resolver for the address of the host's name. That " +
        "question holds the host's name and nothing else, and it goes to the name servers this machine uses",
    );
    // Nothing on the page or in the terminal says where the program is, or a secret's value.
    const shown = JSON.stringify(dataPathRows(egress(paths))) + out.join("\n");
    expect(shown).not.toContain(rig.env.FORTRESS_DATA_RUNNER as string);
    expect(shown).not.toContain(PASSWORD);
  });
});

// ── The manifest ─────────────────────────────────────────────────────────────

describe("a manifest's programs", () => {
  const withPrograms = (programs: unknown, id = "databases"): unknown => ({ ...DATABASES, id, programs });

  test("are ids of the host's own list, for this module, and nothing else", () => {
    expect(manifestDefect(DATABASES)).toBeNull();
    expect(manifestDefect(withPrograms([]))).toBeNull();
    expect(manifestDefect(withPrograms("data-runner"))).toBe("the manifest's programs must be a list");
    expect(manifestDefect(withPrograms({ id: "data-runner" }))).toBe("the manifest's programs must be a list");
    for (const entry of ["data-runner", null, 7, ["data-runner"]]) {
      expect([entry, manifestDefect(withPrograms([entry]))]).toEqual([entry, "a program is not an object"]);
    }
    // A manifest gives a program no path, no argument and no variable.
    for (const more of [
      { args: ["run", "--job-stdin"] },
      { path: "/usr/local/bin/data-runner" },
      { env: { PGPASSWORD: "x" } },
      { pathVariable: "PATH" },
      { title: "DB IO" },
    ]) {
      expect([more, manifestDefect(withPrograms([{ id: "data-runner", ...more }]))]).toEqual([
        more,
        "a program names its id and nothing else",
      ]);
    }
    for (const id of ["Data-Runner", "data runner", "../data-runner", "", "-x", "x".repeat(33), 7, null, undefined]) {
      expect([id, manifestDefect(withPrograms([{ id }]))]).toEqual([
        id,
        "a program's id must be lower-case letters, digits and hyphens",
      ]);
    }
    expect(manifestDefect(withPrograms([{ id: "data-runner" }, { id: "data-runner" }]))).toBe(
      "the program data-runner is listed twice",
    );
    expect(manifestDefect(withPrograms([{ id: "store-engine" }]))).toBe(
      "this build runs no program store-engine for this module",
    );
    expect(manifestDefect(withPrograms([{ id: "data-runner" }], "stores"))).toBe(
      "this build runs no program data-runner for this module",
    );
    expect(manifestDefect(withPrograms(Array.from({ length: 5 }, (_, i) => ({ id: `p${i}` }))))).toBe(
      "a module may list at most 4 programs",
    );
  });
});

