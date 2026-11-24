// The `databases` module: the connections an organization keeps to its own
// databases, what the control plane may ask about them, and what a signed-in
// person may do to them.
//
// It ships in every build and, like every module, is OFF until somebody on this
// host switches it on (`hx-fortress modules on databases`).
//
// THREE WAYS IN, AND WHAT EACH MAY DO.
//
//   onAsk    the control plane, through the ask gate. It may list the
//            connections, read a catalog's names, start a test and read how a
//            job went. It cannot add, change or remove a connection, and no
//            ask takes a statement or answers a row. Two asks start a write
//            into a database, each with a person's approval (writes.ts).
//
//   onAct    a person signed in to the console of this HX Fortress. Adding a
//            connection adds a host this HX Fortress may reach and the name of a
//            secret it may have read, so only a person does it, and only an
//            act's ports can.
//
//   a job    the module's own work, after the ask or the act that started it
//            has been answered: one test of one connection. It keeps the
//            context it was started with, which is one organization's.
//
// A fourth, `onDataIsland`, is for a person too: it runs one query and hands
// its rows back to the caller (query.ts).
//
// THE MODULE OPENS NO SOCKET AND STARTS NO PROCESS. To reach a database it
// hands the module host one job for the data runner program, the name of a
// reach and the name of a secret. It never holds a database's address that it
// did not get from a person, and never a login's password. For a job of
// another module it holds, for as long as the job runs, the address of the
// store's gateway on this machine and the key of one store job.
//
// EVERYTHING IT KEEPS IS ONE ORGANIZATION'S. It keeps what it keeps through
// the context's own state, which the host holds apart for each organization,
// and what it holds in memory is keyed by the organization.

import { randomBytes } from "node:crypto";

import {
  AskFailure,
  failureForLog,
  isModuleId,
  type FortressModule,
  type ModuleContextV2,
  type ModuleStartContext,
} from "../../host/module-contract";
import { ID_MAX_CHARS, ID_PATTERN, isName } from "../../host/shape";
import type { MsgReply } from "../../protocol";
import {
  CatalogChanged,
  catalogPage,
  clearCatalog,
  readCatalog,
  spareSlot,
  writeCatalog,
  type CatalogSlot,
} from "./catalog";
import {
  BookUnreadable,
  changedFields,
  connectionFields,
  findConnection,
  findJob,
  idForModules,
  keyNamesOf,
  loadBook,
  loginKey,
  namesAnotherDatabase,
  newestJob,
  sameTable,
  sameUser,
  sameWrites,
  saveBook,
  stateOf,
  subjectOf,
  writeLoginKey,
  writeSettings,
  type Book,
  type Connection,
  type ConnectionFields,
  type JobRecord,
  type TableName,
  type WriteSettings,
} from "./connections";
import { ownCode, runJob, stepOfFailure, STORE_JOB_MAX_MS, storeJob, testJob } from "./data-runner";
import type {
  CallingContext,
  ConnectionRef,
  ConnectionView,
  DatabasesForModules,
  ModuleJob,
  ModuleJobFailure,
  ModuleJobOptions,
  ModuleJobOutcome,
} from "./for-modules";
import {
  ReachRefused,
  SecretNameRefused,
  type ContextPorts,
  type DatabasesHostPorts,
  type ModuleActContext,
  type Person,
} from "./host-ports";
import { isLocalGateway } from "./host-text";
import {
  CONNECTIONS_MAX,
  DATABASES_ACTS,
  DATABASES_MANIFEST,
  DATABASES_MODULE_ID,
  WRITE_TABLES_MAX_IN_ALL,
  type FailureCode,
  type LinkEncryption,
} from "./manifest";
import { runQuery, type DataIslandRequest, type QueryAnswer } from "./query";
import type { StoresForWrites } from "./stores-port";
import { createWrites, type WriteAsk } from "./writes";

/** Jobs that may run at once, tests and queries together, over every
 *  organization. The module host runs at most this many programs for one
 *  module. */
export const JOBS_MAX_RUNNING = 4;
// (Tests, queries and other modules' jobs share these places.)

/** Jobs of other modules that may run at once. They can take half an hour, so
 *  the other places stay free for a person's test or query. */
export const OTHER_MODULES_MAX_RUNNING = 2;

/**
 * How long after a test of a connection started the control plane may start
 * the next one. Until then `test.start` answers the id of the test it already
 * has. A person at the console is not held to this: they pressed the button.
 *
 * Every test signs in to the database, and the control plane chooses how often
 * it asks. A second rule covers a login that a database refused: see
 * `Book.refusedLogins`.
 */
export const ASK_TEST_INTERVAL_MS = 60_000;

/** How long `stop` waits for the jobs it interrupted to write how they ended. */
const STOP_WAIT_MS = 5_000;

export interface DatabasesModuleDeps {
  /** The ports the module host does not hand a module yet (host-ports.ts). */
  ports: DatabasesHostPorts;
  clock?: () => Date;
  /** Sixteen random hex characters. A seam for tests. */
  randomId?: () => string;
  maxRunning?: number;
  /** How long the host may stay silent about a job before the module gives it
   *  up. A seam for tests: the default is the job's time and twice its grace. */
  hostSilentAfterMs?: number;
  /**
   * The Stores module's calls for a write (stores-port.ts), looked up at each
   * ask, so that it does not matter which of the two modules is made first.
   * Left out, or answering null, where there is no Stores module to ask: a
   * write is then refused with `stores_off`.
   */
  stores?: () => StoresForWrites | null;
  /** How long one call of the Stores module may take. A seam for tests. */
  storeCallMs?: number;
  /** This HX Fortress's own version. It is kept with a write's record. */
  version?: string;
}

export interface DatabasesModule extends FortressModule {
  /**
   * Carry out one act of a signed-in person. `args` already has the shape the
   * act declares, and the caller has checked the person's sign-in and role.
   * The value returned is held to the act's declared reply before it is shown.
   *
   * `ctx` is the act's own context: the only place the two lists a person may
   * change can be reached from. It fails with `AskFailure`, whose one word is
   * all that is shown.
   */
  onAct(act: string, args: unknown, ctx: ModuleActContext, person: Person): Promise<unknown>;
  /**
   * Answer one read of a Secure Data Island: run the statement in the
   * request's settings on the connection it names, for this person.
   *
   * The caller is the door, and it has checked both keys before this is
   * called: the person's sign-in at this HX Fortress, and the control plane's
   * grant for this person, this connection and these settings.
   *
   * This is the one place where the module returns values that have no shape:
   * a query's rows, for that person's browser and nothing else. It fails with
   * `QueryRefused`.
   */
  onDataIsland(request: DataIslandRequest, ctx: ModuleContextV2, person: Person): Promise<QueryAnswer>;
  /** What another module of this HX Fortress may ask: a connection by its
   *  name, and one job of the data runner on it (for-modules.ts). */
  readonly forModules: DatabasesForModules;
  /** Resolves when no job of this module is running. */
  idle(): Promise<void>;
}

type Detail = Record<string, string | number | boolean>;

/** One of the places a job runs in. */
interface Place {
  id: string;
  abort: AbortController;
  /** Why the module itself stopped the job, when it did: one word. */
  stopped: () => StopWord | null;
  /** Give the place back. The job has ended and written how. */
  release: () => void;
}

/**
 * Why the module stops a job that is running on a connection.
 *
 *   connection_changed       an operator changed or removed the connection:
 *                            every job on it is stopped
 *   login_can_write          a test found that the read login can change the
 *                            database: every job that signs in with it is
 *                            stopped. A job that writes signs in with the
 *                            write login, and goes on
 *   write_settings_changed   an operator set the connection's write settings
 *                            again or took them away: every job that writes
 *                            on it is stopped
 */
type StopWord = "connection_changed" | "login_can_write" | "write_settings_changed";

/** One running job, as the module keeps it in memory. */
interface RunningJob {
  abort: AbortController;
  done: Promise<void>;
  /** The connection a query or another module's job runs on. A test has none
   *  here: a connection under test is not changed or removed. */
  connectionId?: string;
  /** The job signs in with the connection's write login. */
  writes?: true;
  /** The job may run for half an hour: another module's, or one that writes. */
  long?: true;
  stopped: StopWord | null;
}

/**
 * Who started a test. A person's start carries the context of that person's
 * act: the line of the start is the person's, and the host writes it under
 * the person's login (`recordAct`). Every other line of a test is written
 * with `record`, which names nobody: the line of its end, and the line of the
 * end of a test that somebody else started and that was lost.
 */
type TestOrigin = { kind: "control_plane" } | { kind: "person"; login: string; act: ModuleActContext };

/** What a test that passed found, without the names it read. */
interface TestResult {
  encryption: LinkEncryption;
  canWrite: boolean;
  writableTables: number;
  slot: CatalogSlot;
  tables: number;
  columns: number;
  leftOutTables: number;
  leftOutColumns: number;
  truncated: boolean;
}

type TestEnd = { ok: true; result: TestResult } | { ok: false; code: FailureCode };

export function createDatabasesModule(deps: DatabasesModuleDeps): DatabasesModule {
  const clock = deps.clock ?? ((): Date => new Date());
  const randomId = deps.randomId ?? ((): string => randomBytes(8).toString("hex"));
  const maxRunning = deps.maxRunning ?? JOBS_MAX_RUNNING;
  const silent = deps.hostSilentAfterMs === undefined ? {} : { silentAfterMs: deps.hostSilentAfterMs };

  /**
   * The jobs that are running, by id. THIS MAP IS THE TRUTH about what runs:
   * a job does not outlive the process that started it. The stored record also
   * says "running", so that another start can see it. Where the two disagree,
   * the record is wrong and is corrected (`closeLost`).
   */
  const running = new Map<string, RunningJob>();
  /** One writer at a time for each organization's book. */
  const locks = new Map<string, Promise<void>>();
  let stopping = false;
  /** How many of the running jobs are other modules'. */
  let others = 0;
  /** The context the module was started with. It is the way to the module's
   *  own context of each organization it is on for. */
  let started: ModuleStartContext | null = null;

  /** Say what failed in this host's own log: its kind and where, never its
   *  message. Never throws: it is called where nothing may. */
  function report(ctx: ModuleContextV2, message: string, thrown: unknown, more: Detail = {}): void {
    try {
      ctx.logger.error(message, { ...more, ...failureForLog(thrown) });
    } catch {
      // The log could not take it. There is nowhere left to say so.
    }
  }

  /** Take one of the places a job runs in, or null when there is none. Checked
   *  and taken in one step, so two starts cannot both find the last one free,
   *  and nothing starts once the module is stopping. */
  function takePlace(options: { other?: boolean; connectionId?: string; writes?: boolean } = {}): Place | null {
    const other = options.other === true;
    const long = other || options.writes === true;
    if (stopping || running.size >= maxRunning) return null;
    if (other && others >= OTHER_MODULES_MAX_RUNNING) return null;
    // A job of another module and a job that writes may each run for half an
    // hour. Together they take all places but one, so that a person's test
    // or query always finds a place within the two minutes those take.
    if (long && [...running.values()].filter((job) => job.long).length >= Math.max(1, maxRunning - 1)) return null;
    // One job that writes at a time on one connection: two would wait for
    // each other's rows in the database.
    if (options.writes) {
      for (const job of running.values()) {
        if (job.writes && job.connectionId === options.connectionId) return null;
      }
    }
    if (other) others += 1;
    const id = `job_${randomId()}`;
    const abort = new AbortController();
    let ended = (): void => {};
    const done = new Promise<void>((resolve) => {
      ended = resolve;
    });
    const job: RunningJob = {
      abort,
      done,
      stopped: null,
      ...(options.connectionId === undefined ? {} : { connectionId: options.connectionId }),
      ...(options.writes ? { writes: true as const } : {}),
      ...(long ? { long: true as const } : {}),
    };
    running.set(id, job);
    return {
      id,
      abort,
      stopped: () => job.stopped,
      release: (): void => {
        if (!running.delete(id)) return;
        if (other) others -= 1;
        ended();
      },
    };
  }

  /** Why the module stopped a job that signs in with the read login, when it
   *  did. Such a job is never stopped for a connection's write settings. */
  const stoppedReading = (place: Place): "connection_changed" | "login_can_write" | null => {
    const why = place.stopped();
    return why === "write_settings_changed" ? null : why;
  };

  /** Stop the jobs that run on a connection and that `why` is about (see
   *  `StopWord`), and keep the word for why. */
  function stopJobsOn(connectionId: string, why: StopWord): void {
    for (const job of running.values()) {
      if (job.connectionId !== connectionId || job.abort.signal.aborted) continue;
      if (why === "login_can_write" && job.writes) continue;
      if (why === "write_settings_changed" && !job.writes) continue;
      job.stopped = why;
      job.abort.abort();
    }
  }

  /** Write down that a database refused a connection's login, so that nothing
   *  signs in with it again until a person's test passes. Never rejects. */
  async function noteRefusedLogin(ctx: ModuleContextV2, connection: Connection): Promise<void> {
    try {
      await withBook(ctx, async (held) => {
        held.refusedLogins = [...new Set([...(held.refusedLogins ?? []), loginKey(connection)])];
        await saveBook(ctx.state, held);
      });
    } catch (thrown) {
      report(ctx, "a refused login could not be written down", thrown);
    }
  }

  const loginRefused = (held: Book, connection: Connection): boolean =>
    (held.refusedLogins ?? []).includes(loginKey(connection));

  /** Whether a database refused the connection's write login, and no
   *  operator has set its write settings again since. */
  const writeLoginRefused = (held: Book, connection: Connection): boolean => {
    const key = writeLoginKey(connection);
    return key !== null && (held.refusedLogins ?? []).includes(key);
  };

  /** Write down that a database refused a connection's write login, so that
   *  no write signs in with it again until an operator sets it again. Never
   *  rejects. */
  async function noteRefusedWriteLogin(ctx: ModuleContextV2, connection: Connection): Promise<void> {
    const key = writeLoginKey(connection);
    if (key === null) return;
    try {
      await withBook(ctx, async (held) => {
        held.refusedLogins = [...new Set([...(held.refusedLogins ?? []), key])];
        await saveBook(ctx.state, held);
      });
    } catch (thrown) {
      report(ctx, "a refused write login could not be written down", thrown);
    }
  }

  // ── One organization's book, read and written under a lock ─────────────────
  //
  // The book is the one document connections.ts keeps: an organization's
  // connections and their newest jobs.

  /** What this module keys its own memory by. Never sent, never recorded. The
   *  HX Fortress's own organization is one fixed key, so its id is not read. */
  const organizationKey = (ctx: ModuleContextV2): string =>
    ctx.organization.own ? "own" : `held:${ctx.organization.id}`;

  async function locked<T>(ctx: ModuleContextV2, work: () => Promise<T>): Promise<T> {
    const key = organizationKey(ctx);
    const before = locks.get(key) ?? Promise.resolve();
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The next writer waits for everybody before this one, and for this one.
    const mine = before.then(() => held);
    locks.set(key, mine);
    await before;
    try {
      return await work();
    } finally {
      release();
      if (locks.get(key) === mine) locks.delete(key);
    }
  }

  async function book(ctx: ModuleContextV2): Promise<Book> {
    try {
      return await loadBook(ctx.state);
    } catch (thrown) {
      if (!(thrown instanceof BookUnreadable)) throw thrown;
      report(ctx, "the record of this organization's connections cannot be read", thrown.cause);
      throw new AskFailure("state_unreadable");
    }
  }

  /** A job as it is: one the book calls running, with nothing behind it in
   *  this process, was interrupted. */
  const asItIs = (job: JobRecord | undefined): JobRecord | undefined =>
    job !== undefined && job.state === "running" && !running.has(job.id)
      ? { ...job, state: "failed", code: "interrupted" }
      : job;

  /** Close every job the book calls running that is not running. */
  function closeLost(held: Book): JobRecord[] {
    const lost = held.jobs.filter((job) => job.state === "running" && !running.has(job.id));
    const finishedAt = clock().toISOString();
    for (const job of lost) {
      job.state = "failed";
      job.code = "interrupted";
      job.finishedAt = finishedAt;
    }
    return lost;
  }

  /**
   * Read the book under the organization's lock and work on it. Before the
   * work, a job that was interrupted is written as that, with its line in the
   * audit trail. So a test that died with its process, or whose end could not
   * be written, never leaves a connection that cannot be tested, changed or
   * removed.
   */
  async function withBook<T>(ctx: ModuleContextV2, work: (held: Book) => Promise<T>): Promise<T> {
    let closed: JobRecord[] = [];
    try {
      return await locked(ctx, async () => {
        const held = await book(ctx);
        const lost = closeLost(held);
        if (lost.length > 0) {
          await saveBook(ctx.state, held);
          closed = lost;
        }
        return work(held);
      });
    } finally {
      for (const job of closed) recordTestEnd(ctx, job);
    }
  }

  /** The line a test leaves when it ends. A failed test's action ends in
   *  `.failed`, so a reader of the trail does not take it for one that passed. */
  function recordTestEnd(ctx: ModuleContextV2, job: JobRecord): void {
    if (job.state === "done") {
      ctx.audit.record("connection.tested", {
        target: job.connection,
        job: job.id,
        tables: job.tables ?? 0,
        columns: job.columns ?? 0,
        canWrite: job.canWrite ?? false,
      });
    } else {
      ctx.audit.record("connection.test.failed", {
        target: job.connection,
        job: job.id,
        code: job.code ?? "internal",
      });
    }
  }

  // ── What is answered ───────────────────────────────────────────────────────
  //
  // A field that has no value is left undefined. The gate and the act door
  // rebuild every answer against its declared shape, and a field with no value
  // is no field there.

  function jobView(job: JobRecord): unknown {
    return {
      connection: job.connection,
      state: job.state,
      step: job.step,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      code: job.code,
      tables: job.tables,
      columns: job.columns,
      encryption: job.encryption,
      canWrite: job.canWrite,
    };
  }

  /** A connection as the control plane is told it: its name, its engine and
   *  where it stands. Not its server, not its login. */
  function listed(held: Book, connection: Connection): unknown {
    const job = asItIs(newestJob(held, connection));
    return {
      name: connection.name,
      engine: connection.engine,
      reach: "direct",
      state: stateOf(job),
      testedAt: job?.finishedAt,
      failure: job?.state === "failed" ? job.code : undefined,
      canWrite: job?.state === "done" ? job.canWrite : undefined,
    };
  }

  /** A connection as a person signed in to this HX Fortress sees it. */
  function detailed(held: Book, connection: Connection): unknown {
    const job = asItIs(newestJob(held, connection));
    return {
      name: connection.name,
      engine: connection.engine,
      reach: "direct",
      host: connection.host,
      port: connection.port,
      database: connection.database,
      encryption: connection.encryption,
      minTls: connection.minTls,
      serverName: connection.serverName,
      user: connection.user,
      keyName: connection.keyName,
      // Its write login, and how many tables a write may reach. The tables
      // are read one connection at a time (`connection.writes.read`).
      writes:
        connection.writes === undefined
          ? undefined
          : {
              user: connection.writes.user,
              keyName: connection.writes.keyName,
              tables: connection.writes.tables.length,
            },
      state: stateOf(job),
      addedAt: connection.addedAt,
      addedBy: connection.addedBy,
      changedAt: connection.changedAt,
      changedBy: connection.changedBy,
      test:
        job === undefined
          ? undefined
          : {
              job: job.id,
              state: job.state,
              step: job.step,
              origin: job.origin,
              by: job.by !== undefined && isName(job.by) ? job.by : undefined,
              startedAt: job.startedAt,
              finishedAt: job.finishedAt,
              code: job.code,
              encryption: job.encryption,
              canWrite: job.canWrite,
              writableTables: job.writableTables,
              tables: job.tables,
              columns: job.columns,
              leftOutTables: job.leftOutTables,
              leftOutColumns: job.leftOutColumns,
              truncated: job.truncated,
            },
    };
  }

  /**
   * What a record of a connection says about it: names and one count. The
   * NAME of the login's secret is there, under `keyName`. Its value is nowhere
   * in this module. The host's audit writer may still replace a value that
   * reads like a credential.
   */
  function described(connection: ConnectionFields): Detail {
    return {
      target: connection.name,
      engine: connection.engine,
      host: connection.host,
      port: connection.port,
      database: connection.database,
      encryption: connection.encryption,
      minTls: connection.minTls,
      ...(connection.serverName === undefined ? {} : { serverName: connection.serverName }),
      user: connection.user,
      keyName: connection.keyName,
    };
  }

  // ── A test ─────────────────────────────────────────────────────────────────

  /** Start a test of one connection, or answer the one that already stands for
   *  it. Returns the job's id. */
  async function startTest(ctx: ModuleContextV2, name: string, origin: TestOrigin): Promise<string> {
    const ports = deps.ports.forContext(ctx);
    const started = await withBook(ctx, async (held) => {
      const connection = findConnection(held, name);
      if (!connection) throw new AskFailure("connection_unknown");
      const newest = newestJob(held, connection);
      if (newest?.state === "running") return { id: newest.id, start: null };
      const now = clock();
      if (origin.kind === "control_plane") {
        // A database refused this login. Trying it again on the control
        // plane's word is how a login gets locked.
        if ((held.refusedLogins ?? []).includes(loginKey(connection))) {
          if (newest) return { id: newest.id, start: null };
          throw new AskFailure("login_refused");
        }
        if (newest !== undefined && now.getTime() - Date.parse(newest.startedAt) < ASK_TEST_INTERVAL_MS) {
          return { id: newest.id, start: null };
        }
      }
      const place = takePlace();
      if (!place) throw new AskFailure("busy");
      try {
        held.jobs.unshift({
          id: place.id,
          connectionId: connection.id,
          connection: connection.name,
          origin: origin.kind,
          ...(origin.kind === "person" ? { by: origin.login } : {}),
          state: "running",
          step: "start",
          startedAt: now.toISOString(),
        });
        connection.job = place.id;
        await saveBook(ctx.state, held);
      } catch (thrown) {
        place.release();
        throw thrown;
      }
      return { id: place.id, start: { connection: { ...connection }, place } };
    });
    if (started.start) {
      const { connection, place } = started.start;
      const line = {
        target: connection.name,
        job: place.id,
        origin: origin.kind,
        ...(origin.kind === "person" ? { by: origin.login } : {}),
      };
      // A person's own act: the host names the person on the line.
      if (origin.kind === "person") origin.act.audit.recordAct("connection.test", line);
      else ctx.audit.record("connection.test", line);
      // Not waited for: the ask or the act that started the test is answered
      // with the job's id now, and `job.read` says how it went.
      void runTest(ctx, ports, connection, place).finally(place.release);
    }
    return started.id;
  }

  /** Hand the host one test job, wait for it, and write how it ended. Never
   *  rejects: nobody is waiting for it. */
  async function runTest(
    ctx: ModuleContextV2,
    ports: ContextPorts,
    connection: Connection,
    place: Place,
  ): Promise<void> {
    const read = await runJob(
      ports.programs,
      testJob(place.id, subjectOf(connection), clock()),
      { reach: connection.reach, keyName: connection.keyName },
      place.abort,
      {
        ...silent,
        onThrown: (thrown) => report(ctx, "the host threw while it ran a test", thrown, { job: place.id }),
      },
    );
    let end: TestEnd;
    if (!read.ok) {
      end = { ok: false, code: ownCode(read.code) };
    } else if (read.findings.kind !== "test") {
      end = { ok: false, code: "output_invalid" };
    } else {
      const { findings } = read;
      const reading = readCatalog(connection.engine, findings.tables, findings.truncated, clock().toISOString());
      // The reading goes to the slot the connection's record does not point
      // at, and nothing reads it until the record is saved with that slot. So
      // it is written here, outside the lock, however large it is.
      const slot = spareSlot(connection.catalog);
      try {
        await writeCatalog(ctx.state, connection.id, slot, reading, place.id);
        end = {
          ok: true,
          result: {
            encryption: findings.encryption,
            canWrite: findings.canWrite,
            writableTables: findings.writableTables,
            slot,
            tables: reading.tables,
            columns: reading.columns,
            leftOutTables: reading.leftOut.tables,
            leftOutColumns: reading.leftOut.columns,
            truncated: reading.truncated,
          },
        };
      } catch (thrown) {
        report(ctx, "what a test read could not be kept", thrown, { job: place.id });
        end = { ok: false, code: "catalog_not_kept" };
      }
    }
    try {
      await finishTest(ctx, connection.id, place.id, end);
    } catch (thrown) {
      // The book still calls the job running. The next read of it under the
      // lock closes it as interrupted.
      report(ctx, "how a test ended could not be written", thrown, { job: place.id });
    }
  }

  async function finishTest(
    ctx: ModuleContextV2,
    connectionId: string,
    jobId: string,
    end: TestEnd,
  ): Promise<void> {
    const written = await withBook(ctx, async (held): Promise<JobRecord | null> => {
      const job = findJob(held, jobId);
      if (!job || job.state !== "running") return null;
      const connection = held.connections.find((other) => other.id === connectionId);
      job.finishedAt = clock().toISOString();
      if (end.ok && connection) {
        const { result } = end;
        job.state = "done";
        job.step = "catalog";
        job.encryption = result.encryption;
        job.canWrite = result.canWrite;
        job.writableTables = result.writableTables;
        job.tables = result.tables;
        job.columns = result.columns;
        job.leftOutTables = result.leftOutTables;
        job.leftOutColumns = result.leftOutColumns;
        job.truncated = result.truncated;
        // This save is the switch: from here on the connection's catalog is
        // the reading this test wrote.
        connection.catalog = { slot: result.slot, reading: jobId };
        connection.verified = { at: job.finishedAt, canWrite: result.canWrite };
        held.refusedLogins = (held.refusedLogins ?? []).filter((login) => login !== loginKey(connection));
      } else {
        const code: FailureCode = end.ok ? "interrupted" : end.code;
        job.state = "failed";
        job.code = code;
        job.step = stepOfFailure(code);
        if (code === "login" && connection) {
          held.refusedLogins = [...new Set([...(held.refusedLogins ?? []), loginKey(connection)])];
        }
      }
      await saveBook(ctx.state, held);
      return { ...job };
    });
    if (!written) return;
    recordTestEnd(ctx, written);
    // A login that can write runs no query and no job of another module, and
    // the ones that are running on it now are stopped.
    if (written.state === "done" && written.canWrite) stopJobsOn(connectionId, "login_can_write");
  }

  // ── What a person does ─────────────────────────────────────────────────────

  /** A refusal of one of the host's two lists, as the one word that is shown. */
  const shown = (thrown: unknown): unknown =>
    thrown instanceof ReachRefused || thrown instanceof SecretNameRefused
      ? new AskFailure(thrown.rule)
      : thrown;

  /** Whether a login of another connection is kept under this secret's name. */
  const usesKey = (held: Book, keyName: string, except: string): boolean =>
    held.connections.some((other) => other.id !== except && keyNamesOf(other).includes(keyName));

  /**
   * The change to the host's list of secret names that takes one connection
   * from one set of names to another.
   *
   * `apply` gives up the names the connection no longer uses, where no other
   * connection uses them, and then takes the new ones: a list that is full
   * still has room for a change. `undo` puts the list back, for a change that
   * then could not be saved. A name the list does not take back stays off it,
   * and a job that needs it fails with the host's word for a name that was
   * not added. The next act that adds, changes or removes a connection, or
   * sets or takes away write settings, puts it back: `tidyLists` runs at the
   * start of each one. A test of a connection does not.
   */
  function keyNameChange(
    held: Book,
    id: string,
    before: readonly string[],
    after: readonly string[],
  ): { apply(ctx: ModuleActContext): Promise<void>; undo(ctx: ModuleActContext): Promise<void> } {
    const given = before.filter((name) => !after.includes(name) && !usesKey(held, name, id));
    const taken = after.filter((name) => !before.includes(name));
    return {
      async apply(ctx): Promise<void> {
        for (const name of given) await ctx.secretNames.remove(name);
        for (const name of taken) await ctx.secretNames.add(name);
      },
      async undo(ctx): Promise<void> {
        for (const name of taken) {
          if (!usesKey(held, name, id)) await ctx.secretNames.remove(name).catch(() => {});
        }
        for (const name of given) await ctx.secretNames.add(name).catch(() => {});
      },
    };
  }

  const isTesting = (held: Book, connection: Connection): boolean =>
    newestJob(held, connection)?.state === "running";

  /**
   * Take off the host's two lists what no connection uses, and put back on
   * the list of secret names what a connection uses. It runs at the start of
   * every act that adds, changes or removes a connection, or sets or takes
   * away write settings. A failure here is not the act's.
   *
   * WHAT IT TAKES OFF: every entry no connection points at, on both lists. A
   * host this HX Fortress may reach, or a secret's name, that a failed write
   * left behind.
   *
   * WHAT IT PUTS BACK: a secret's name that a connection's login uses and the
   * list lacks. That is what is left by a change that could be neither saved
   * nor undone (`keyNameChange`), and by a removal that could not be saved:
   * a removal takes the names off before it saves. The unused
   * names come off first, so that a full list has room for a name that is put
   * back. It puts back NO HOST: a connection whose host is not on the list of
   * hosts can dial nothing until an operator changes its server or its port,
   * or removes it.
   *
   * Each entry is tried by itself: one that the list does not take leaves the
   * others to be tried, and is tried again at the next such act.
   *
   * The module host records every change of a list under the person whose act
   * it is part of. So what this mends is recorded under the operator of the
   * NEXT act, whoever's act left it undone.
   */
  async function tidyLists(ctx: ModuleActContext, held: Book): Promise<void> {
    const reaches = new Set(held.connections.map((connection) => connection.reach));
    const names = new Set(held.connections.flatMap(keyNamesOf));
    /** Do one thing for each entry. An entry that fails does not end the
     *  others, and one line in this host's log says how many failed. */
    const each = async <T>(
      what: string,
      entries: () => Promise<readonly T[]>,
      one: (entry: T) => Promise<unknown>,
    ): Promise<void> => {
      let failed = 0;
      let first: unknown;
      try {
        for (const entry of await entries()) {
          try {
            await one(entry);
          } catch (thrown) {
            if (failed === 0) first = thrown;
            failed += 1;
          }
        }
      } catch (thrown) {
        // The list itself could not be read.
        if (failed === 0) first = thrown;
        failed += 1;
      }
      if (failed > 0) report(ctx, what, first, { failed });
    };
    await each(
      "an unused host could not be taken off the list of hosts",
      async () => (await ctx.reach.list()).filter((entry) => !reaches.has(entry.name)),
      (entry) => ctx.reach.remove(entry.name),
    );
    await each(
      "an unused name could not be taken off the list of secret names",
      async () => (await ctx.secretNames.list()).filter((name) => !names.has(name)),
      (name) => ctx.secretNames.remove(name),
    );
    await each(
      "a secret's name that a connection uses could not be put back on the list of secret names",
      async () => {
        const listed = new Set(await ctx.secretNames.list());
        return [...names].filter((name) => !listed.has(name));
      },
      (name) => ctx.secretNames.add(name),
    );
  }

  async function addConnection(ctx: ModuleActContext, person: Person, fields: ConnectionFields): Promise<unknown> {
    const added = await withBook(ctx, async (held): Promise<Connection> => {
      await tidyLists(ctx, held);
      if (findConnection(held, fields.name)) throw new AskFailure("name_taken");
      if (held.connections.length >= CONNECTIONS_MAX) throw new AskFailure("connections_full");
      const id = `c${randomId()}`;
      const reach = `${id}-1`;
      // The host's two lists first. Either may refuse, and a connection whose
      // host or secret's name the host did not take must not exist.
      try {
        await ctx.reach.add(reach, { host: fields.host, port: fields.port });
      } catch (thrown) {
        throw shown(thrown);
      }
      try {
        await ctx.secretNames.add(fields.keyName);
      } catch (thrown) {
        await ctx.reach.remove(reach).catch(() => {});
        throw shown(thrown);
      }
      const connection: Connection = {
        ...fields,
        id,
        reach,
        reachCount: 1,
        databaseCount: 1,
        addedAt: clock().toISOString(),
        ...(isName(person.login) ? { addedBy: person.login } : {}),
      };
      try {
        await saveBook(ctx.state, { ...held, connections: [...held.connections, connection] });
      } catch (thrown) {
        // Whatever this cannot take back, the next act takes off the lists.
        await ctx.reach.remove(reach).catch(() => {});
        if (!usesKey(held, fields.keyName, id)) await ctx.secretNames.remove(fields.keyName).catch(() => {});
        throw thrown;
      }
      return connection;
    });
    ctx.audit.recordAct("connection.add", { ...described(added), by: person.login });
    return { name: added.name };
  }

  async function changeConnection(ctx: ModuleActContext, person: Person, fields: ConnectionFields): Promise<unknown> {
    type Changed = { after: Connection; changed: string[]; closed?: WriteSettings };
    const result = await withBook(ctx, async (held): Promise<Changed> => {
      await tidyLists(ctx, held);
      const before = findConnection(held, fields.name);
      if (!before) throw new AskFailure("connection_unknown");
      // A test in flight was started with the fields as they were.
      if (isTesting(held, before)) throw new AskFailure("connection_busy");
      // The name is the connection's identity, and it keeps the spelling it
      // was added with.
      const after: ConnectionFields = { ...fields, name: before.name };
      const changed = changedFields(before, after);
      if (changed.length === 0) return { after: before, changed };
      // The write settings are an operator's own decision, made with an act of
      // its own, and they stay through a change of the connection's other
      // fields. They do not stay when the connection now names another
      // database: the tables an operator opened to writes were tables of the
      // database it named before.
      const another = namesAnotherDatabase(before, after);
      const closed = another ? before.writes : undefined;
      const writes = closed === undefined ? before.writes : undefined;
      // The read login is the one a query runs with, so it is never the login
      // that writes.
      if (writes !== undefined && sameUser(after.user, writes.user)) throw new AskFailure("user_is_write_user");
      // What runs on the connection as it was is stopped: it reads the server
      // the connection named before.
      stopJobsOn(before.id, "connection_changed");

      const moved = before.host !== after.host || before.port !== after.port;
      const reachCount = before.reachCount + (moved ? 1 : 0);
      const reach = moved ? `${before.id}-${reachCount}` : before.reach;
      // The write login's name stays on the list whatever the read login's
      // name becomes, for as long as the write settings stay.
      const names = keyNameChange(
        held,
        before.id,
        keyNamesOf(before),
        keyNamesOf({ keyName: after.keyName, ...(writes === undefined ? {} : { writes }) }),
      );
      // Each list gives up the old entry before it takes the new one: a list
      // that is full still has room for a change. Until the book is saved the
      // connection points at an entry that is gone, so nothing can dial on its
      // word in between, and nothing ever dials the new server with the login
      // of the old one.
      const putBack = async (): Promise<void> => {
        if (moved) {
          await ctx.reach.remove(reach).catch(() => {});
          await ctx.reach.add(before.reach, { host: before.host, port: before.port }).catch(() => {});
        }
        await names.undo(ctx);
      };
      try {
        if (moved) {
          await ctx.reach.remove(before.reach);
          await ctx.reach.add(reach, { host: after.host, port: after.port });
        }
        await names.apply(ctx);
      } catch (thrown) {
        await putBack();
        throw shown(thrown);
      }
      const next: Connection = {
        ...after,
        id: before.id,
        reach,
        reachCount,
        // Another database is another id for other modules.
        databaseCount: (before.databaseCount ?? 1) + (another ? 1 : 0),
        addedAt: before.addedAt,
        ...(before.addedBy === undefined ? {} : { addedBy: before.addedBy }),
        changedAt: clock().toISOString(),
        ...(isName(person.login) ? { changedBy: person.login } : {}),
        // No `job`, no `catalog` and no `verified`: the tests so far were of
        // the connection as it was, and so is what they read.
        ...(writes === undefined ? {} : { writes }),
      };
      try {
        await saveBook(ctx.state, {
          ...held,
          connections: held.connections.map((other) => (other.id === before.id ? next : other)),
        });
      } catch (thrown) {
        await putBack();
        throw thrown;
      }
      // The record no longer points at a reading, so what the slots hold is
      // data nothing reads. Removing it can fail without failing the change:
      // the next reading into a slot removes what was left there, and so does
      // the connection's own removal.
      await clearCatalog(ctx.state, before.id).catch((thrown: unknown) =>
        report(ctx, "a changed connection's old catalog could not be removed", thrown),
      );
      return { after: next, changed, ...(closed === undefined ? {} : { closed }) };
    });
    if (result.changed.length > 0) {
      ctx.audit.recordAct("connection.change", {
        ...described(result.after),
        changed: result.changed.join(" "),
        by: person.login,
      });
    }
    if (result.closed !== undefined) {
      // The change took the write settings away. The trail says so in the
      // words it has for an operator taking them away, and says why.
      ctx.audit.recordAct("connection.writes.remove", {
        target: result.after.name,
        why: "connection_changed",
        by: person.login,
      });
      recordWriteTables(ctx, result.after.name, result.closed.tables, [], person.login);
    }
    return { name: result.after.name };
  }

  async function removeConnection(ctx: ModuleActContext, person: Person, name: string): Promise<unknown> {
    const removed = await withBook(ctx, async (held): Promise<Connection> => {
      await tidyLists(ctx, held);
      const connection = findConnection(held, name);
      if (!connection) throw new AskFailure("connection_unknown");
      if (isTesting(held, connection)) throw new AskFailure("connection_busy");
      stopJobsOn(connection.id, "connection_changed");
      // Off the list of hosts first. If the book then cannot be saved, what is
      // left is a connection that can dial nothing, and removing it again
      // works. The other order could leave a host this HX Fortress may reach
      // with no connection to show for it.
      await ctx.reach.remove(connection.reach);
      for (const keyName of keyNamesOf(connection)) {
        if (!usesKey(held, keyName, connection.id)) await ctx.secretNames.remove(keyName);
      }
      // What its tests read goes before the connection does. If that cannot
      // be removed, the act fails and the connection stays in the book, as
      // one that can dial nothing, and removing it again removes the rest.
      // The other order could leave the names of a database's tables on the
      // disk with no connection left to remove them by.
      await clearCatalog(ctx.state, connection.id);
      await saveBook(ctx.state, {
        ...held,
        connections: held.connections.filter((other) => other.id !== connection.id),
        jobs: held.jobs.filter((job) => job.connectionId !== connection.id),
      });
      return connection;
    });
    ctx.audit.recordAct("connection.remove", { ...described(removed), by: person.login });
    recordWriteTables(ctx, removed.name, removed.writes?.tables ?? [], [], person.login);
    return {};
  }

  // ── A connection's write settings ──────────────────────────────────────────
  //
  // A connection is added with one login, the one its tests and its queries
  // sign in with. Before anything can write through it, an operator names a
  // second login for it and the tables a write may reach. A job signs in
  // with that login only when the control plane's ask `write.start` or
  // `write.undo` started it, with a grant that names who approved the write
  // (writes.ts).

  /**
   * Which tables a change opened to writes, and which it closed, in the audit
   * trail: who opened which table to writes is what such a trail is read for.
   * One record for each table, with its schema and its name as two values: a
   * value of a module's record is one name, so a list of tables does not fit
   * in one. Only what changed is written, so a list of two hundred tables
   * that gains one leaves one such record.
   *
   * Each is a record of the operator's own act, so the host writes it under
   * the operator's login (`recordAct`).
   */
  function recordWriteTables(
    ctx: ModuleActContext,
    connection: string,
    before: readonly TableName[],
    after: readonly TableName[],
    by: string,
  ): void {
    const line = (table: TableName): Detail => ({ target: connection, schema: table.schema, table: table.name, by });
    for (const table of after) {
      if (!before.some((other) => sameTable(other, table))) ctx.audit.recordAct("connection.writes.table.add", line(table));
    }
    for (const table of before) {
      if (!after.some((other) => sameTable(other, table))) ctx.audit.recordAct("connection.writes.table.remove", line(table));
    }
  }

  /** One connection's write settings with its tables, as a signed-in person
   *  reads them. A connection that has none answers its name alone. */
  async function readWrites(ctx: ModuleContextV2, name: string): Promise<unknown> {
    const connection = findConnection(await book(ctx), name);
    if (!connection) throw new AskFailure("connection_unknown");
    return { name: connection.name, ...(connection.writes === undefined ? {} : { writes: connection.writes }) };
  }

  /** Set a connection's write login and the tables a write may reach, or take
   *  them away (`args` null). What stood before is replaced whole. */
  async function setWrites(ctx: ModuleActContext, person: Person, name: string, args: unknown): Promise<unknown> {
    const result = await withBook(ctx, async (held): Promise<{ before: Connection; after: Connection }> => {
      await tidyLists(ctx, held);
      const before = findConnection(held, name);
      if (!before) throw new AskFailure("connection_unknown");
      const writes = args === null ? undefined : writeSettings(args, before.user);
      // A database refused this write login, and an operator sets it again:
      // that is their word that it may be tried once more.
      const key = writes === undefined ? null : loginKey({ ...before, user: writes.user });
      const refused = key !== null && (held.refusedLogins ?? []).includes(key);
      if (sameWrites(before.writes, writes) && !refused) return { before, after: before };
      // All connections together name only so many tables: the record that
      // holds them has a size the host limits (`WRITE_TABLES_MAX_IN_ALL`).
      if (writes !== undefined) {
        const others = held.connections
          .filter((other) => other.id !== before.id)
          .reduce((count, other) => count + (other.writes?.tables.length ?? 0), 0);
        if (others + writes.tables.length > WRITE_TABLES_MAX_IN_ALL) throw new AskFailure("write_tables_full");
      }
      const after: Connection = { ...before };
      if (writes === undefined) delete after.writes;
      else after.writes = writes;
      // The connection's own fields, its last test and its catalog stay: the
      // read login is the one they are about, and it did not change.
      const names = keyNameChange(held, before.id, keyNamesOf(before), keyNamesOf(after));
      try {
        await names.apply(ctx);
      } catch (thrown) {
        await names.undo(ctx);
        throw shown(thrown);
      }
      try {
        await saveBook(ctx.state, {
          ...held,
          connections: held.connections.map((other) => (other.id === before.id ? after : other)),
          refusedLogins: (held.refusedLogins ?? []).filter((login) => login !== key),
        });
      } catch (thrown) {
        await names.undo(ctx);
        throw thrown;
      }
      // A job that writes on the connection signed in with the write login as
      // it was, for the tables as they were. It is stopped, as a change of
      // the connection stops what runs on it.
      if (!sameWrites(before.writes, writes)) stopJobsOn(before.id, "write_settings_changed");
      return { before, after };
    });
    const { before, after } = result;
    if (before !== after) {
      if (after.writes === undefined) {
        ctx.audit.recordAct("connection.writes.remove", { target: after.name, by: person.login });
      } else {
        ctx.audit.recordAct("connection.writes.set", {
          target: after.name,
          user: after.writes.user,
          keyName: after.writes.keyName,
          tables: after.writes.tables.length,
          by: person.login,
        });
      }
      recordWriteTables(ctx, after.name, before.writes?.tables ?? [], after.writes?.tables ?? [], person.login);
    }
    return { name: after.name };
  }

  // ── What another module asks ───────────────────────────────────────────────

  /**
   * This module's own context of the caller's organization, or null when the
   * module is not on for it. For the own organization that is the context the
   * module was started with, so nothing is read to find it.
   */
  async function contextOf(caller: CallingContext): Promise<ModuleContextV2 | null> {
    if (!started || stopping) return null;
    const organization: unknown = (caller as CallingContext | null)?.organization;
    if (typeof organization !== "object" || organization === null) return null;
    const { own, id } = organization as { own?: unknown; id?: unknown };
    if (own === true) return started;
    let contexts: ModuleContextV2[];
    try {
      contexts = await started.organizations();
    } catch (thrown) {
      report(started, "the organizations this module is on for could not be listed", thrown);
      return null;
    }
    return contexts.find((ctx) => !ctx.organization.own && ctx.organization.id === id) ?? null;
  }

  const refOf = (connection: Connection): ConnectionRef => ({
    id: idForModules(connection),
    name: connection.name,
    engine: connection.engine,
  });

  const viewOf = (held: Book, connection: Connection): ConnectionView => ({
    ...refOf(connection),
    state: stateOf(asItIs(newestJob(held, connection))),
    runnable: connection.verified?.canWrite === false && !loginRefused(held, connection),
  });

  async function viewAll(caller: CallingContext): Promise<ConnectionView[]> {
    const ctx = await contextOf(caller);
    if (!ctx) return [];
    const held = await book(ctx);
    return held.connections.map((connection) => viewOf(held, connection));
  }

  async function viewOne(caller: CallingContext, name: string): Promise<ConnectionView | null> {
    const ctx = await contextOf(caller);
    if (!ctx || typeof name !== "string") return null;
    const held = await book(ctx);
    const connection = findConnection(held, name);
    return connection ? viewOf(held, connection) : null;
  }

  /** One token that is safe as a part of a path, and is a name in a record. */
  const isToken = (value: unknown): value is string =>
    typeof value === "string" && value.length <= ID_MAX_CHARS && ID_PATTERN.test(value) && value !== "." && value !== "..";

  /** A key that is safe as a header's value: printable, with no space. */
  const isKey = (value: unknown): value is string => typeof value === "string" && /^[\x21-\x7e]{1,512}$/.test(value);

  async function runForModule(
    caller: CallingContext,
    name: string,
    job: ModuleJob,
    options: ModuleJobOptions = {},
  ): Promise<ModuleJobOutcome> {
    const refused = (code: ModuleJobFailure, jobId?: string): ModuleJobOutcome =>
      jobId === undefined ? { ok: false, code } : { ok: false, code, jobId };
    let place: Place | null = null;
    let ctx: ModuleContextV2 | null = null;
    let stop: (() => void) | null = null;
    const signal: unknown = (options as ModuleJobOptions | null)?.signal;
    try {
      ctx = await contextOf(caller);
      if (!ctx) return refused("databases_off");
      const by: unknown = (caller as CallingContext | null)?.moduleId;
      const store = (job as ModuleJob | null)?.store;
      const kind: unknown = (job as ModuleJob | null)?.kind;
      if (
        (kind !== "pull" && kind !== "compare") ||
        !isModuleId(by) ||
        typeof name !== "string" ||
        typeof store !== "object" ||
        store === null ||
        !isToken(store.storeId) ||
        !isToken(store.jobId) ||
        !isKey(store.key) ||
        typeof store.gatewayUrl !== "string" ||
        (signal !== undefined && !(signal instanceof AbortSignal))
      ) {
        return refused("job_invalid");
      }
      let held: Book;
      try {
        held = await book(ctx);
      } catch {
        return refused("state_unreadable");
      }
      const connection = findConnection(held, name);
      if (!connection) return refused("connection_unknown");
      // The same rules as for a query: nothing runs with a login that a test
      // did not find to be one that can only read, and nothing signs in with a
      // login that a database refused.
      if (!connection.verified) return refused("not_tested");
      if (connection.verified.canWrite) return refused("login_can_write");
      if (loginRefused(held, connection)) return refused("login_refused");
      if (!isLocalGateway(store.gatewayUrl)) return refused("gateway_not_local");
      // A caller that has already given up is handed nothing.
      if (signal?.aborted) return refused("interrupted");
      place = takePlace({ other: true, connectionId: connection.id });
      if (!place) return refused("busy");
      const mine = place;
      stop = (): void => mine.abort.abort();
      signal?.addEventListener("abort", stop, { once: true });
      const asked = (options as ModuleJobOptions | null)?.deadlineMs;
      const deadlineMs =
        typeof asked === "number" && Number.isFinite(asked)
          ? Math.min(Math.max(Math.round(asked), 1_000), STORE_JOB_MAX_MS)
          : STORE_JOB_MAX_MS;
      const line = {
        target: connection.name,
        kind,
        by,
        job: mine.id,
        store: store.storeId,
        storeJob: store.jobId,
      };
      ctx.audit.record("connection.job", line);
      // The connection as the job runs on it: this id, and what the job below
      // names (the engine, the database, the user, the reach and the secret),
      // come from one reading of the record. The host looks the address up by
      // the reach's name, and a reach's name is never used for a second
      // address. So a job that ends well ran on the database this id names,
      // whatever an operator has made of the connection by then.
      const ran = refOf(connection);
      const read = await runJob(
        deps.ports.forContext(ctx).programs,
        storeJob(mine.id, subjectOf(connection), kind, store, clock(), deadlineMs),
        { reach: connection.reach, keyName: connection.keyName },
        mine.abort,
        {
          deadlineMs,
          ...silent,
          onThrown: (thrown) => report(ctx as ModuleContextV2, "the host threw while it ran a job", thrown, { job: mine.id }),
        },
      );
      if (read.ok && read.findings.kind === "pull" && kind === "pull") {
        const { tables } = read.findings;
        const sum = (of: (table: (typeof tables)[number]) => number): number =>
          tables.reduce((total, table) => total + of(table), 0);
        ctx.audit.record("connection.job.done", {
          ...line,
          tables: tables.length,
          read: sum((table) => table.read),
          sent: sum((table) => table.sent),
        });
        return { ok: true, kind: "pull", jobId: mine.id, connection: ran, tables };
      }
      if (read.ok && read.findings.kind === "compare" && kind === "compare") {
        const found = read.findings;
        ctx.audit.record("connection.job.done", { ...line, read: found.read, sent: found.sent });
        return {
          ok: true,
          kind: "compare",
          jobId: mine.id,
          connection: ran,
          job: found.job,
          read: found.read,
          targetRows: found.targetRows,
          sent: found.sent,
          same: found.same,
          otherRows: found.otherRows,
        };
      }
      // The module's own reason for stopping the job comes before the word
      // the stopped run ended with.
      const ended: ModuleJobFailure = read.ok
        ? "output_invalid"
        : read.code === "catalog_not_kept"
          ? "internal"
          : read.code;
      const code: ModuleJobFailure = stoppedReading(mine) ?? ended;
      if (code === "login") await noteRefusedLogin(ctx, connection);
      ctx.audit.record("connection.job.failed", { ...line, code });
      return refused(code, mine.id);
    } catch (thrown) {
      // Nothing above is meant to throw. A caller is told one word all the
      // same, the job has its line of an end, and this host's log has the kind
      // of what was thrown.
      if (ctx) {
        report(ctx, "a job for another module failed", thrown, place ? { job: place.id } : {});
        if (place) {
          try {
            ctx.audit.record("connection.job.failed", { target: typeof name === "string" ? name : "", job: place.id, code: "internal" });
          } catch {
            // The record's own writer threw. The log above has it.
          }
        }
      }
      return refused("internal", place?.id);
    } finally {
      if (stop && signal instanceof AbortSignal) signal.removeEventListener("abort", stop);
      place?.release();
    }
  }

  function nameOf(args: unknown): string {
    const name = (args as { name?: unknown } | null)?.name;
    return typeof name === "string" ? name : "";
  }

  // ── A write into a database ────────────────────────────────────────────────

  const writes = createWrites({
    clock,
    stores: deps.stores ?? ((): null => null),
    programs: (ctx) => deps.ports.forContext(ctx).programs,
    locked,
    book,
    takePlace: (connectionId) => takePlace({ connectionId, writes: true }),
    isRunning: (jobId) => running.has(jobId),
    organizationKey,
    report,
    writeLoginRefused,
    noteRefusedWriteLogin,
    ...(deps.hostSilentAfterMs === undefined ? {} : { hostSilentAfterMs: deps.hostSilentAfterMs }),
    ...(deps.storeCallMs === undefined ? {} : { storeCallMs: deps.storeCallMs }),
    ...(deps.version === undefined ? {} : { release: deps.version }),
  });

  async function readJob(ctx: ModuleContextV2, args: unknown): Promise<unknown> {
    const id = (args as { job: string }).job;
    const job = asItIs(findJob(await book(ctx), id));
    if (job) return jobView(job);
    // A test's job is in the record of the connections. A job that writes has
    // a record of its own.
    const write = await writes.read(ctx, id);
    if (!write) throw new AskFailure("job_unknown");
    return write;
  }

  return {
    id: DATABASES_MODULE_ID,
    manifest: DATABASES_MANIFEST,

    forModules: { connection: viewOne, connections: viewAll, run: runForModule },

    async init(context: ModuleStartContext): Promise<void> {
      stopping = false;
      started = context;
      // A test that was running when the process last stopped is written as
      // interrupted now, for every organization the module is on for. Reading
      // a book under the lock does that. One organization's failure is its own.
      let contexts: ModuleContextV2[] = [];
      try {
        contexts = await context.organizations();
      } catch (thrown) {
        report(context, "could not list the organizations to look for interrupted tests", thrown);
      }
      for (const ctx of contexts) {
        await withBook(ctx, async () => undefined).catch((thrown: unknown) =>
          report(ctx, "could not look for tests that were interrupted", thrown),
        );
        // And a job that writes: its program ended with the process.
        await writes.closeLost(ctx).catch((thrown: unknown) =>
          report(ctx, "could not look for writes that were interrupted", thrown),
        );
      }
    },

    async stop(): Promise<void> {
      stopping = true;
      const open = [...running.values()];
      for (const entry of open) entry.abort.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(open.map((entry) => entry.done)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, STOP_WAIT_MS);
        }),
      ]);
      if (timer) clearTimeout(timer);
    },

    // The control plane reaches a module through `onAsk`, behind the gate, and
    // through nothing else. A plain module message is not something this
    // module takes.
    onMessage(): MsgReply {
      return { ok: false, error: "ask_unknown" };
    },

    async onAsk(ask: string, args: unknown, ctx: ModuleContextV2): Promise<unknown> {
      switch (ask) {
        case "connections.list": {
          const held = await book(ctx);
          return { connections: held.connections.map((connection) => listed(held, connection)) };
        }
        case "catalog.read": {
          const { connection: name, page } = args as { connection: string; page: number };
          const connection = findConnection(await book(ctx), name);
          if (!connection) throw new AskFailure("connection_unknown");
          if (!connection.catalog) throw new AskFailure("catalog_not_read");
          let read: Awaited<ReturnType<typeof catalogPage>>;
          try {
            read = await catalogPage(ctx.state, connection.id, connection.catalog, page);
          } catch (thrown) {
            if (thrown instanceof CatalogChanged) throw new AskFailure("catalog_changed");
            throw thrown;
          }
          if (!read) throw new AskFailure("catalog_not_read");
          if (!read.items) throw new AskFailure("page_unknown");
          return { ...read.summary, page, items: read.items };
        }
        case "test.start": {
          const { connection } = args as { connection: string };
          return { job: await startTest(ctx, connection, { kind: "control_plane" }) };
        }
        case "job.read":
          return readJob(ctx, args);
        case "write.start":
        case "write.undo":
          return writes.start(ctx, ask as WriteAsk, args);
        default:
          // The gate refuses an ask the manifest does not list before it gets
          // here. This is the same answer for a manifest and a module that
          // have drifted apart.
          throw new AskFailure("ask_not_implemented");
      }
    },

    async onAct(act: string, args: unknown, ctx: ModuleActContext, person: Person): Promise<unknown> {
      const spec = DATABASES_ACTS.find((entry) => entry.name === act);
      if (!spec) throw new AskFailure("act_not_implemented");
      // The door has checked the role. Checked here too, because what an act
      // can change is this module's to guard.
      if (spec.role === "operator" && person.role !== "operator") throw new AskFailure("not_allowed");
      switch (act) {
        case "connections.read": {
          const held = await book(ctx);
          return { connections: held.connections.map((connection) => detailed(held, connection)) };
        }
        case "connection.add":
          return addConnection(ctx, person, connectionFields(args));
        case "connection.change":
          return changeConnection(ctx, person, connectionFields(args));
        case "connection.remove":
          return removeConnection(ctx, person, nameOf(args));
        case "connection.writes.read":
          return readWrites(ctx, nameOf(args));
        case "connection.writes.set":
          return setWrites(ctx, person, nameOf(args), args);
        case "connection.writes.remove":
          return setWrites(ctx, person, nameOf(args), null);
        case "connection.test":
          return { job: await startTest(ctx, nameOf(args), { kind: "person", login: person.login, act: ctx }) };
        case "job.read":
          return readJob(ctx, args);
        default:
          throw new AskFailure("act_not_implemented");
      }
    },

    onDataIsland(request: DataIslandRequest, ctx: ModuleContextV2, person: Person): Promise<QueryAnswer> {
      return runQuery(request, person, {
        ports: deps.ports.forContext(ctx),
        connection: async (name) => {
          const held = await book(ctx);
          const connection = findConnection(held, name);
          return connection && { connection, loginRefused: loginRefused(held, connection) };
        },
        loginFailed: (connection) => noteRefusedLogin(ctx, connection),
        // A query takes one of the places a test takes, so together they never
        // hand the host more jobs than it runs for one module.
        begin: (connectionId) => {
          const place = takePlace({ connectionId });
          return place && { ...place, stopped: () => stoppedReading(place) };
        },
        clock,
        ...silent,
        onThrown: (thrown) => report(ctx, "the host threw while it ran a query", thrown),
      });
    },

    async idle(): Promise<void> {
      while (running.size > 0) {
        await Promise.allSettled([...running.values()].map((entry) => entry.done));
      }
    },
  };
}
