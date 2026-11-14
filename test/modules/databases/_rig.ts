// Shared rig for the Databases module's tests.
//
// The module is run by the real module host, behind the real ask gate, over a
// temp fortress root. What the module host does not hand a module yet is stood
// in for here, each to the rule the host's contract gives for it:
//
//   • a launcher that takes the place of the host starting the data runner: it
//     reads the secret a job names, puts the address and the password into the
//     job, and hands the job to the stand-in program (in this process, or as a
//     real child process)
//   • a place where the record of a query is kept
//   • the act door, which checks a person's act the way the console's route will
//   • the query door, which checks the two keys of a data island's read
//
// Every key, name, address and password here is made up for the test run.

import { createHash } from "node:crypto";
import path from "node:path";

import { jwtVerify, importJWK } from "jose";

import type { CatalogEntry } from "../../../src/host/module-catalog";
import { failureCode, type ModuleContextV2 } from "../../../src/host/module-contract";
import { conform } from "../../../src/host/shape";
import type {
  OpenQueryRecord,
  Person,
  ProgramOutcome,
  QueryIntent,
  QueryOutcome,
  QueryRecordsPort,
} from "../../../src/modules/databases/host-ports";
import { DATABASES_ACTS, DATABASES_MANIFEST } from "../../../src/modules/databases/manifest";
import { createDatabasesModule, type DatabasesModule } from "../../../src/modules/databases/module";
import { QueryRefused, type DataIslandRequest } from "../../../src/modules/databases/query";
import {
  createStandInPorts,
  type ProgramLaunch,
  type ProgramLauncher,
} from "../../../src/modules/databases/standins";
import { SecretMissing } from "../../../src/secrets/types";
import { fixedSecrets, makeRig, ORG, PROBE_CATALOG, type FixedSecrets, type Rig } from "../../host/_module-rig";
import {
  BILLING_PASSWORD,
  NORTHSTAR_SERVERS,
  PERMITS_PASSWORD,
  runStandInJob,
  type StandInServer,
} from "./standin-data-runner";

export const DATABASES_ENTRY: CatalogEntry = {
  id: "databases",
  title: "Databases",
  summary: "connections to this organization's own databases",
  manifest: DATABASES_MANIFEST,
  startOnly: false,
};

export const CATALOG: readonly CatalogEntry[] = [...PROBE_CATALOG, DATABASES_ENTRY];

/** The made-up company's people. */
export const MARTA: Person = { login: "marta", email: "marta.lindqvist@northstar.example", role: "operator" };
export const RUTH: Person = { login: "ruth", email: "ruth.abebe@northstar.example", role: "readonly" };
export const LENA: Person = { login: "lena", email: "lena.hart@northstar.example", role: "readonly" };

/** The made-up company's key store: the two logins' passwords, by name. */
export const KEY_STORE = {
  "permits-reader": PERMITS_PASSWORD,
  "billing-reader": BILLING_PASSWORD,
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
  /** Ends a child process sooner than the module asks, for a test of that. */
  timeoutMs?: number;
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

async function runAsProcess(launch: ProgramLaunch, job: unknown): Promise<ProgramOutcome> {
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
      if (line.trim()) launch.onOutput(JSON.parse(line));
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
    if (options.mode === "process") {
      return runAsProcess(
        options.timeoutMs === undefined ? launch : { ...launch, timeoutMs: options.timeoutMs },
        job,
      );
    }
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
    if (launch.signal?.aborted) return { ok: false, code: "program_failed" };
    launch.onOutput(runStandInJob(job, options.servers?.() ?? NORTHSTAR_SERVERS, options.clock?.() ?? new Date()));
    return { ok: true };
  };
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

export interface DatabasesRig extends Rig {
  module: DatabasesModule;
  /** The module's context for the Fortress's own organization. */
  ctx: ModuleContextV2;
  keyStore: FixedSecrets;
  queries: KeptQueryRecords;
  /** Every job the stand-in program was handed. */
  jobs: unknown[];
  /** Grant ids the query door has taken. */
  usedGrants: Set<string>;
}

export interface RigOptions {
  mode?: "function" | "process";
  enabled?: readonly string[];
  askTestIntervalMs?: number;
  maxRunning?: number;
  hold?: () => Promise<void>;
  /** Other servers than the made-up company's, read at each job. */
  servers?: () => readonly StandInServer[];
  /** Ends a child process after this long, whatever the module asked for. */
  programTimeoutMs?: number;
  /** Give the module the stand-ins the daemon runs with: no launcher and no
   *  place for a query's record. */
  asInTheDaemon?: boolean;
  restartOf?: DatabasesRig;
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
  let counter = 0;
  const module = createDatabasesModule({
    ports: options.asInTheDaemon
      ? createStandInPorts({ clock })
      : createStandInPorts({
          clock,
          launcher: standInLauncher({
            secrets: keyStore,
            clock,
            jobs,
            ...(options.mode ? { mode: options.mode } : {}),
            ...(options.hold ? { hold: options.hold } : {}),
            ...(options.servers ? { servers: options.servers } : {}),
            ...(options.programTimeoutMs === undefined ? {} : { timeoutMs: options.programTimeoutMs }),
          }),
          queryRecords: queries.port,
        }),
    clock,
    // Ids a test can tell apart, and that differ after a restart.
    randomId: () => `${(options.restartOf ? 0xb000 : 0xa000) + (counter += 1)}`.padStart(16, "0"),
    ...(options.askTestIntervalMs === undefined ? {} : { askTestIntervalMs: options.askTestIntervalMs }),
    ...(options.maxRunning === undefined ? {} : { maxRunning: options.maxRunning }),
  });
  // The context the module is started with is the own organization's. The rig
  // keeps it, to hand to an act the way the act door will.
  let ctx: ModuleContextV2 | null = null;
  const started: DatabasesModule = {
    ...module,
    async init(context) {
      ctx = context;
      await module.init?.(context);
    },
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
    usedGrants: options.restartOf?.usedGrants ?? new Set<string>(),
    cleanup: async () => {
      await module.stop?.();
      await rig.cleanup();
    },
  };
}

// ── The act door ─────────────────────────────────────────────────────────────

export type ActReply = { ok: true; payload: unknown } | { ok: false; error: string };

/**
 * Carry out one act the way the console's route will: a signed-in person, a
 * role that may, a module that is on, an act on the module's list, arguments
 * that fit, and a reply that fits.
 */
export async function act(
  rig: DatabasesRig,
  name: string,
  args: unknown = {},
  person: Person | null = MARTA,
): Promise<ActReply> {
  if (!person) return { ok: false, error: "signed_out" };
  if (!(await rig.host.isOn("databases", rig.host.organizations.own))) return { ok: false, error: "module_off" };
  const spec = DATABASES_ACTS.find((entry) => entry.name === name);
  if (!spec) return { ok: false, error: "act_unknown" };
  if (spec.role === "operator" && person.role !== "operator") return { ok: false, error: "not_allowed" };
  const fit = conform(spec.args, args);
  if (!fit.ok) return { ok: false, error: "args_invalid" };
  try {
    const reply = await rig.module.onAct(name, fit.value, rig.ctx, person);
    const shaped = conform(spec.reply, reply);
    return shaped.ok ? { ok: true, payload: shaped.value } : { ok: false, error: "reply_invalid" };
  } catch (thrown) {
    return { ok: false, error: `failed:${failureCode(thrown)}` };
  }
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

/** One spelling of a settings object, so both sides hash the same bytes. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const held = value as Record<string, unknown>;
    return `{${Object.keys(held)
      .sort()
      // An own key of the object, read back from the same object.
      // eslint-disable-next-line security/detect-object-injection
      .map((key) => `${JSON.stringify(key)}:${canonical(held[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const settingsHash = (settings: unknown): string =>
  createHash("sha256").update(canonical(settings), "utf8").digest("base64url");

/** The id this made-up Fortress enrolled with. */
export const FORTRESS_ID = "fortress_test_1";

/** A grant for a data island, as the control plane signs one. `overrides`
 *  replaces claims, and a claim set to undefined is left out. */
export function islandGrant(
  rig: DatabasesRig,
  island: { kind: string; target: string; settings: unknown; person: string },
  overrides: Record<string, unknown> = {},
  options: { ttl?: number; iat?: number; jti?: string | null } = {},
): Promise<string> {
  const claims: Record<string, unknown> = {
    v: 2,
    purpose: "data-island",
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
  /** The person signed in at the Fortress, or null when nobody is. */
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
 * The door a data island's read comes through, as the host's contract gives
 * it: the person's sign-in first, then the grant's checks in their order, then
 * that the module is on and answers this kind, then the person's right to see
 * rows. Only then is the module called.
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
  if (claims.v !== 2 || claims.purpose !== "data-island") return refused(403, "grant-purpose");
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
