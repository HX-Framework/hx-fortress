// Shared rig for the Databases module's tests.
//
// The module is run by the real module host, behind its real ask gate and its
// real act gate, over a temp folder of an HX Fortress. A person's act goes
// through the host's gate, and the list of hosts and the list of secret names
// that an act adds to are the host's own. What the module host does not hand a
// module yet is stood in for here, each to the rule the host's contract gives
// for it:
//
//   • a launcher that takes the place of the host starting the data runner: it
//     reads the secret a job names, puts the address and the password into the
//     job, and hands the job to the stand-in program (in this process, or as a
//     real child process)
//   • a place where the record of a query is kept
//   • the query door, which checks the two keys of a Secure Data Island's read
//
// Every key, name, address and password here is made up for the test run.

import { createHash } from "node:crypto";
import path from "node:path";

import { jwtVerify, importJWK } from "jose";

import { canonicalJson } from "../../../src/host/ask-scope";
import type { CatalogEntry } from "../../../src/host/module-catalog";
import type { ModuleActContext, ModuleContextV2 } from "../../../src/host/module-contract";
import type {
  ContextPorts,
  OpenQueryRecord,
  Person,
  ProgramOutcome,
  ProgramRun,
  QueryIntent,
  QueryOutcome,
  QueryRecordsPort,
} from "../../../src/modules/databases/host-ports";
import { DATABASES_MANIFEST } from "../../../src/modules/databases/manifest";
import { createDatabasesModule, type DatabasesModule } from "../../../src/modules/databases/module";
import { QueryRefused, type DataIslandRequest } from "../../../src/modules/databases/query";
import { createStandInPorts } from "../../../src/modules/databases/standins";
import type { StoresForWrites } from "../../../src/modules/databases/stores-port";
import { SecretMissing } from "../../../src/secrets/types";
import { fixedSecrets, makeRig, ORG, PROBE_CATALOG, type FixedSecrets, type Rig } from "../../host/_module-rig";
import { lookUp } from "./_host-standins";
import {
  BILLING_PASSWORD,
  NORTHSTAR_SERVERS,
  PERMITS_PASSWORD,
  PERMITS_WRITER_PASSWORD,
  runStandInJob,
  type StandInServer,
} from "./standin-data-runner";

export const DATABASES_ENTRY: CatalogEntry = {
  id: "databases",
  title: "Databases",
  summary: "reads and writes local databases",
  manifest: DATABASES_MANIFEST,
  startOnly: false,
};

export const CATALOG: readonly CatalogEntry[] = [...PROBE_CATALOG, DATABASES_ENTRY];

/** The made-up company's people. */
export const MARTA: Person = { login: "marta", email: "marta.lindqvist@northstar.example", role: "operator" };
export const RUTH: Person = { login: "ruth", email: "ruth.abebe@northstar.example", role: "readonly" };
export const LENA: Person = { login: "lena", email: "lena.hart@northstar.example", role: "readonly" };

/** The made-up company's key store: the logins' passwords, by name. */
export const KEY_STORE = {
  "permits-reader": PERMITS_PASSWORD,
  "billing-reader": BILLING_PASSWORD,
  "permits-writer": PERMITS_WRITER_PASSWORD,
};

export const PERMITS = {
  name: "Northstar permits",
  engine: "sqlserver",
  host: "sql01.northstar.example",
  port: 1433,
  database: "Permits",
  encryption: "verify",
  user: "permits_reader",
  keyName: "permits-reader",
};

export const BILLING = {
  name: "Northstar billing",
  engine: "postgres",
  host: "pg02.northstar.example",
  port: 5432,
  database: "billing",
  encryption: "require",
  user: "billing_reader",
  keyName: "billing-reader",
};

const RUNNER = path.join(import.meta.dir, "standin-data-runner.ts");

// ── The launcher: what the host does to start the program for one job ────────

/** What the launcher is handed: what the host has looked up for one run. */
export interface ProgramLaunch {
  args: readonly string[];
  reach: { host: string; port: number };
  /** A field's name to the NAME of its secret. The launcher reads the values. */
  secrets: Readonly<Record<string, string>>;
  input: unknown;
  onOutput: (value: unknown) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type ProgramLauncher = (launch: ProgramLaunch) => Promise<ProgramOutcome>;

export interface LauncherOptions {
  secrets: FixedSecrets;
  /** `function`: the stand-in program's work is done in this process.
   *  `process`: it is started as a child process, as the real one is. */
  mode?: "function" | "process";
  /** The servers the stand-in program answers from, read at each job. */
  servers?: () => readonly StandInServer[];
  clock?: () => Date;
  /** Every job as the program was handed it. It holds a password, as the real
   *  job does: a test reads it to see what the program was given. */
  jobs?: unknown[];
  /** Held until it resolves, before a job in `function` mode answers. */
  hold?: () => Promise<void>;
  /** Never answers, whatever the signal says: a host that has gone silent.
   *  A function is asked at each job. */
  silent?: boolean | (() => boolean);
  /** Called with a job when its program printed an output: it got to its own
   *  end, whatever that end was. A test's stand-in for a Store hears of a
   *  program's end here, as a real Store hears it at its gateway. */
  printed?: (job: unknown) => void;
  /** What the program says of itself in every output, as it does when the
   *  host starts it with `DB_IO_NAMES_ITSELF=1`. Read at each job. */
  namesItself?: () => unknown;
  /** A job that was told to stop ends well all the same, with its output: the
   *  program was past its last step when the word to stop came. */
  finishesWhenStopped?: boolean;
}

/** The job as the program reads it: the module's fields, with the address and
 *  the password the host adds. */
export function programJob(
  input: unknown,
  reach: { host: string; port: number },
  secrets: Record<string, string>,
): unknown {
  const fields = input as { login: Record<string, unknown> } & Record<string, unknown>;
  return {
    ...fields,
    server: { host: reach.host, port: reach.port },
    reach: { kind: "direct", host: reach.host, port: reach.port },
    login: { ...fields.login, password: secrets.password ?? "" },
  };
}

async function runAsProcess(launch: ProgramLaunch, job: unknown, printedOne?: (job: unknown) => void): Promise<ProgramOutcome> {
  const child = Bun.spawn([process.execPath, RUNNER, ...launch.args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // The program is given a PATH and nothing else of its caller's.
    env: { PATH: process.env.PATH ?? "" },
  });
  let stopped: "timeout" | "signal" | null = null;
  const stop = (why: "timeout" | "signal"): void => {
    stopped ??= why;
    child.kill();
  };
  const timer = launch.timeoutMs === undefined ? null : setTimeout(() => stop("timeout"), launch.timeoutMs);
  const onAbort = (): void => stop("signal");
  launch.signal?.addEventListener("abort", onAbort, { once: true });
  if (launch.signal?.aborted) stop("signal");
  try {
    child.stdin.write(JSON.stringify(job));
    await child.stdin.end();
    const [printed, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (stopped === "timeout") return { ok: false, code: "timeout" };
    if (stopped === "signal" || code !== 0) return { ok: false, code: "program_failed" };
    for (const line of printed.split("\n")) {
      if (!line.trim()) continue;
      launch.onOutput(JSON.parse(line));
      printedOne?.(job);
    }
    return { ok: true };
  } finally {
    if (timer) clearTimeout(timer);
    launch.signal?.removeEventListener("abort", onAbort);
  }
}

export function standInLauncher(options: LauncherOptions): ProgramLauncher {
  return async (launch) => {
    // The host reads each secret by its name and gives the value to the
    // program. The module that asked never holds it.
    const values: Record<string, string> = {};
    for (const [field, name] of Object.entries(launch.secrets)) {
      try {
        // A field's name the module's own code chose.
        // eslint-disable-next-line security/detect-object-injection
        values[field] = await options.secrets.get(name);
      } catch (thrown) {
        return { ok: false, code: thrown instanceof SecretMissing ? "secret_missing" : "secret_unavailable" };
      }
    }
    const job = programJob(launch.input, launch.reach, values);
    options.jobs?.push(job);
    if (typeof options.silent === "function" ? options.silent() : options.silent) return new Promise<ProgramOutcome>(() => {});
    if (options.mode === "process") return runAsProcess(launch, job, options.printed);
    if (options.hold) {
      // Held until the test lets go, or until the caller stops the program.
      await Promise.race([
        options.hold(),
        new Promise<void>((resolve) => {
          if (launch.signal?.aborted) resolve();
          launch.signal?.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
    }
    if (launch.signal?.aborted && !options.finishesWhenStopped) return { ok: false, code: "program_failed" };
    const output = runStandInJob(job, options.servers?.() ?? NORTHSTAR_SERVERS, options.clock?.() ?? new Date());
    const dbIo = options.namesItself?.();
    launch.onOutput(dbIo === undefined ? output : { ...output, dbIo });
    options.printed?.(job);
    return { ok: true };
  };
}

/** A promise a test resolves when it chooses to. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// ── The record of a query ────────────────────────────────────────────────────

export interface KeptQueryRecord extends QueryIntent {
  outcome: QueryOutcome | { outcome: "open" };
}

export interface KeptQueryRecords {
  records: KeptQueryRecord[];
  /** Set to make every record fail to be written. */
  unwritable: boolean;
  port: (ctx: ModuleContextV2) => QueryRecordsPort;
}

export function keptQueryRecords(): KeptQueryRecords {
  const kept: KeptQueryRecords = {
    records: [],
    unwritable: false,
    port: () => ({
      async open(intent): Promise<OpenQueryRecord> {
        if (kept.unwritable) throw new Error("the record could not be written");
        const record: KeptQueryRecord = { ...intent, outcome: { outcome: "open" } };
        kept.records.push(record);
        return {
          async close(outcome) {
            record.outcome = outcome;
          },
        };
      },
      async refused(intent, rule) {
        if (kept.unwritable) throw new Error("the record could not be written");
        kept.records.push({ ...intent, outcome: { outcome: "refused", rule } });
      },
    }),
  };
  return kept;
}

// ── The rig ──────────────────────────────────────────────────────────────────

/** One call of `programs.run`, as the module made it. */
export interface SeenRun {
  program: string;
  reach: string;
  secrets: Readonly<Record<string, string>>;
  timeoutMs: number | undefined;
  signal: AbortSignal | undefined;
}

export interface DatabasesRig extends Rig {
  module: DatabasesModule;
  /** The module's context for the own organization of this HX Fortress. */
  ctx: ModuleContextV2;
  /** The key store the tests' launcher reads a login's password from. */
  keyStore: FixedSecrets;
  queries: KeptQueryRecords;
  /** Every job the stand-in program was handed. */
  jobs: unknown[];
  /** Every run the module asked the host for. */
  runs: SeenRun[];
  /** The ports the module is given for a context, as the host will give them. */
  forContext: (ctx: ModuleContextV2) => ContextPorts;
  /** Grant ids the query door has taken. */
  usedGrants: Set<string>;
  /** Calls of the host's two lists that a test has made fail. */
  faults: ListFaults;
}

/**
 * A fault a test puts in front of one call of the host's two lists, as an act
 * makes it. Set a function to have every such call run it first, and set it
 * back to undefined to mend.
 *
 * THE FAULT IS THROWN BEFORE THE HOST'S PORT IS REACHED. So the list is not
 * changed, and the host records nothing of the call, where a write of its own
 * that failed would leave the start of a record and a `failed` end. These
 * faults test what the MODULE does when a call of a list fails. They test
 * nothing of the host.
 */
export interface ListFaults {
  reachList?: (() => void) | undefined;
  reachAdd?: (() => void) | undefined;
  reachRemove?: (() => void) | undefined;
  secretNameList?: (() => void) | undefined;
  secretNameAdd?: (() => void) | undefined;
  secretNameRemove?: (() => void) | undefined;
}

/**
 * The context of an act, with a test's faults in front of its two lists.
 *
 * It is built ON the act's own context and is no copy of it: everything but
 * the two lists is read from that context when it is asked for, so a value
 * the host computes at each read stays one.
 */
function withFaults(ctx: ModuleActContext, faults: ListFaults): ModuleActContext {
  const reach: ModuleActContext["reach"] = {
    async list() {
      faults.reachList?.();
      return ctx.reach.list();
    },
    async add(name, to) {
      faults.reachAdd?.();
      return ctx.reach.add(name, to);
    },
    async remove(name) {
      faults.reachRemove?.();
      return ctx.reach.remove(name);
    },
  };
  const secretNames: ModuleActContext["secretNames"] = {
    async list() {
      faults.secretNameList?.();
      return ctx.secretNames.list();
    },
    async add(name) {
      faults.secretNameAdd?.();
      return ctx.secretNames.add(name);
    },
    async remove(name) {
      faults.secretNameRemove?.();
      return ctx.secretNames.remove(name);
    },
  };
  return Object.create(ctx, {
    reach: { value: reach, enumerable: true },
    secretNames: { value: secretNames, enumerable: true },
  }) as ModuleActContext;
}

export interface RigOptions {
  mode?: "function" | "process";
  enabled?: readonly string[];
  maxRunning?: number;
  hold?: () => Promise<void>;
  /** Other servers than the made-up company's, read at each job. */
  servers?: () => readonly StandInServer[];
  /** The host never answers a run. A function is asked at each run. */
  silentHost?: boolean | (() => boolean);
  /** Called with a job when its program printed an output. */
  printed?: (job: unknown) => void;
  /** How long the module waits for a silent host. */
  hostSilentAfterMs?: number;
  /** Give the module the stand-ins the daemon runs with: no program is
   *  started and no query can be recorded. */
  asInTheDaemon?: boolean;
  restartOf?: DatabasesRig;
  /** The Stores module's calls for a write, as the module looks them up. */
  stores?: () => StoresForWrites | null;
  /** How long the module waits for one call of the Stores module. */
  storeCallMs?: number;
  /** What the program says of itself in every output. Read at each job. */
  namesItself?: () => unknown;
  /** A job that was told to stop ends well all the same, with its output. */
  finishesWhenStopped?: boolean;
  /** This HX Fortress's own version, as the daemon hands it to the module. */
  version?: string;
}

export async function makeDatabasesRig(options: RigOptions = {}): Promise<DatabasesRig> {
  const enabled = options.enabled ?? ["session_vault", "probe", "databases"];
  const rig = await makeRig({
    enabled,
    deps: { catalog: CATALOG },
    start: false,
    ...(options.restartOf ? { restartOf: options.restartOf } : {}),
  });
  const clock = (): Date => new Date(rig.now.value.getTime());
  const keyStore = options.restartOf?.keyStore ?? fixedSecrets({ ...KEY_STORE });
  const queries = keptQueryRecords();
  const jobs: unknown[] = [];
  const runs: SeenRun[] = [];
  const launcher = standInLauncher({
    secrets: keyStore,
    clock,
    jobs,
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.hold ? { hold: options.hold } : {}),
    ...(options.servers ? { servers: options.servers } : {}),
    ...(options.silentHost ? { silent: options.silentHost } : {}),
    ...(options.printed ? { printed: options.printed } : {}),
    ...(options.namesItself ? { namesItself: options.namesItself } : {}),
    ...(options.finishesWhenStopped ? { finishesWhenStopped: true } : {}),
  });
  // What the host will do for a run: look the reach and the secrets' names up,
  // then start the program.
  const forContext = (ctx: ModuleContextV2): ContextPorts => ({
    programs: {
      async run(program: string, run: ProgramRun): Promise<ProgramOutcome> {
        runs.push({ program, reach: run.reach, secrets: run.secrets, timeoutMs: run.timeoutMs, signal: run.signal });
        const found = await lookUp(ctx, program, run);
        if (!found.ok) return found;
        return launcher({
          args: found.args,
          reach: found.reach,
          secrets: run.secrets,
          input: run.input,
          onOutput: run.onOutput,
          ...(run.timeoutMs === undefined ? {} : { timeoutMs: run.timeoutMs }),
          ...(run.signal === undefined ? {} : { signal: run.signal }),
        });
      },
    },
    queryRecords: queries.port(ctx),
  });
  let counter = 0;
  const module = createDatabasesModule({
    ports: options.asInTheDaemon ? createStandInPorts() : { forContext },
    clock,
    // Ids a test can tell apart, and that differ after a restart.
    randomId: () => `${(options.restartOf ? 0xb000 : 0xa000) + (counter += 1)}`.padStart(16, "0"),
    ...(options.maxRunning === undefined ? {} : { maxRunning: options.maxRunning }),
    ...(options.hostSilentAfterMs === undefined ? {} : { hostSilentAfterMs: options.hostSilentAfterMs }),
    ...(options.stores === undefined ? {} : { stores: options.stores }),
    ...(options.storeCallMs === undefined ? {} : { storeCallMs: options.storeCallMs }),
    ...(options.version === undefined ? {} : { version: options.version }),
  });
  // The context the module is started with is the own organization's. The rig
  // keeps it, so that a test can read the module's state and the two lists.
  let ctx: ModuleContextV2 | null = null;
  const faults: ListFaults = {};
  const started: DatabasesModule = {
    ...module,
    async init(context) {
      ctx = context;
      await module.init?.(context);
    },
    // The act's context is the one the host's gate made for this act.
    onAct: (name, args, context, person) => module.onAct(name, args, withFaults(context, faults), person),
  };
  rig.host.provide(started);
  await rig.host.start();
  await rig.registry.startAll(enabled);
  await rig.host.started();
  if (enabled.includes("databases") && !ctx) throw new Error("the module was not started");
  return {
    ...rig,
    module,
    ctx: ctx as unknown as ModuleContextV2,
    keyStore,
    queries,
    jobs,
    runs,
    forContext,
    usedGrants: options.restartOf?.usedGrants ?? new Set<string>(),
    faults,
    cleanup: async () => {
      await module.stop?.();
      await rig.cleanup();
    },
  };
}

// ── A person's act ───────────────────────────────────────────────────────────

export type ActReply = { ok: true; payload: unknown } | { ok: false; error: string };

/**
 * Carry out one act of a person, through the module host's own gate, as the
 * daemon's door hands it over: the gate checks the role, the act, the shape of
 * the arguments and of the reply, and records every act that only operators
 * may do.
 *
 * The person is one who is signed in. One who is not never reaches the gate:
 * the console answers them itself, and that is the console's to test.
 *
 * THE GATE TAKES 120 RECORDED ACTS A MINUTE, and this rig's clock stands
 * still. A test that makes more acts than that moves the clock on itself.
 */
export async function act(
  rig: DatabasesRig,
  name: string,
  args: unknown = {},
  person: Person = MARTA,
): Promise<ActReply> {
  const answer = await rig.host.acts.handle({ v: 1, person, session: null, module: "databases", act: name, args });
  return answer.ok ? { ok: true, payload: answer.reply } : { ok: false, error: answer.error };
}

/** Add a connection and expect it to be taken. */
export async function addConnection(rig: DatabasesRig, fields: Record<string, unknown> = PERMITS): Promise<void> {
  const reply = await act(rig, "connection.add", fields);
  if (!reply.ok) throw new Error(`the connection was not added: ${reply.error}`);
}

/** Test a connection as a person, and wait for the test to end. */
export async function testConnection(rig: DatabasesRig, name: string = PERMITS.name): Promise<string> {
  const reply = await act(rig, "connection.test", { name });
  if (!reply.ok) throw new Error(`the test was not started: ${reply.error}`);
  await rig.module.idle();
  return (reply.payload as { job: string }).job;
}

// ── The query door ───────────────────────────────────────────────────────────

/** The hash of a Secure Data Island's settings, in the one spelling both
 *  sides use. */
export const settingsHash = (settings: unknown): string =>
  createHash("sha256").update(canonicalJson(settings), "utf8").digest("base64url");

/** The id this made-up HX Fortress enrolled with. */
export const FORTRESS_ID = "fortress_test_1";

/** A grant for a Secure Data Island, as the control plane signs one.
 *  `overrides` replaces claims, and a claim set to undefined is left out. */
export function islandGrant(
  rig: DatabasesRig,
  island: { kind: string; target: string; settings: unknown; person: string },
  overrides: Record<string, unknown> = {},
  options: { ttl?: number; iat?: number; jti?: string | null } = {},
): Promise<string> {
  const claims: Record<string, unknown> = {
    v: 2,
    purpose: "secure-data-island",
    org: ORG,
    aud: ORG,
    fortress: FORTRESS_ID,
    kind: island.kind,
    target: island.target,
    settingsHash: settingsHash(island.settings),
    person: island.person.toLowerCase(),
    ...overrides,
  };
  for (const [name, value] of Object.entries(claims)) {
    // A claim's own name, from the object built above.
    // eslint-disable-next-line security/detect-object-injection
    if (value === undefined) delete claims[name];
  }
  return rig.key.mint(claims, options);
}

export interface QueryCall {
  /** The person signed in at this HX Fortress, or null when nobody is. */
  session: Person | null;
  /** The grant sent with the read. Null when none was sent. */
  grant: string | null;
  kind: string;
  target: string;
  settings: unknown;
  /** Whether the person's groups may see rows. */
  mayReadRows?: boolean;
}

export type QueryReply =
  | { status: 200; columns: { name: string; type: string }[]; rows: (string | null)[][]; more: boolean }
  | { status: 401 | 403 | 422; code: string; words: string };

/**
 * The door a Secure Data Island's read comes through, as the host's contract
 * gives it: the person's sign-in first, then the grant's checks in their
 * order, then that the module is on and answers this kind, then the person's
 * right to see rows. Only then is the module called.
 */
export async function query(rig: DatabasesRig, call: QueryCall): Promise<QueryReply> {
  const refused = (status: 401 | 403, code: string): QueryReply => ({ status, code, words: "" });
  if (!call.session) return refused(401, "signed-out");
  if (!call.grant) return refused(403, "grant-missing");
  let claims: Record<string, unknown>;
  const key = await importJWK({ kty: "OKP", crv: "Ed25519", x: rig.key.publicKey }, "EdDSA");
  try {
    // The times are checked below, against the rig's own clock.
    claims = (await jwtVerify(call.grant, key, { algorithms: ["EdDSA"], currentDate: new Date(0) }))
      .payload as Record<string, unknown>;
  } catch (thrown) {
    // jose refuses a token whose `exp` is before `currentDate`. With the date
    // at zero that never happens, so what is left is the signature.
    void thrown;
    return refused(403, "grant-signature");
  }
  if (claims.v !== 2 || claims.purpose !== "secure-data-island") return refused(403, "grant-purpose");
  if (claims.aud !== ORG || claims.fortress !== FORTRESS_ID) return refused(403, "grant-signature");
  if (claims.kind !== call.kind || claims.target !== call.target) return refused(403, "grant-other-island");
  if (claims.settingsHash !== settingsHash(call.settings)) return refused(403, "grant-other-settings");
  if (claims.person !== (call.session.email ?? "").toLowerCase() || claims.person === "") {
    return refused(403, "grant-other-person");
  }
  const now = Math.floor(rig.now.value.getTime() / 1000);
  const { iat, exp, jti } = claims as { iat?: number; exp?: number; jti?: string };
  if (typeof iat !== "number" || typeof exp !== "number" || exp - iat > 60 || iat > now + 60 || exp <= now) {
    return refused(403, "grant-expired");
  }
  if (typeof jti !== "string" || jti.length === 0 || rig.usedGrants.has(jti)) return refused(403, "grant-used");
  rig.usedGrants.add(jti);
  if (claims.org !== ORG) return refused(403, "grant-signature");
  if (!(await rig.host.isOn("databases", rig.host.organizations.own))) return refused(403, "not-allowed");
  if (call.mayReadRows === false) return refused(403, "not-allowed");
  const request: DataIslandRequest = { kind: call.kind, target: call.target, settings: call.settings };
  try {
    const answer = await rig.module.onDataIsland(request, rig.ctx, call.session);
    return { status: 200, ...answer };
  } catch (thrown) {
    if (thrown instanceof QueryRefused) {
      return { status: thrown.code === "not-allowed" ? 403 : 422, code: thrown.code, words: thrown.words };
    }
    return { status: 422, code: "query-failed", words: "" };
  }
}

/** A read with both keys in order, for one person and one statement. */
export async function readRows(
  rig: DatabasesRig,
  statement: string,
  person: Person = LENA,
  settings: Record<string, unknown> = {},
): Promise<QueryReply> {
  const all = { query: statement, ...settings };
  return query(rig, {
    session: person,
    grant: await islandGrant(rig, {
      kind: "table",
      target: PERMITS.name,
      settings: all,
      person: person.email ?? "",
    }),
    kind: "table",
    target: PERMITS.name,
    settings: all,
  });
}
