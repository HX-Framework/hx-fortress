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
//            ask takes a statement or answers a row.
//
//   onAct    a person signed in to this Fortress's console. Adding a
//            connection adds a host this Fortress may reach and the name of a
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
// reach and the name of a secret. It never holds an address it did not get
// from a person, and never a password.
//
// EVERYTHING IT KEEPS IS ONE ORGANIZATION'S. It keeps what it keeps through
// the context's own state, which the host holds apart for each organization,
// and what it holds in memory is keyed by the organization.

import { randomBytes } from "node:crypto";

import {
  AskFailure,
  failureForLog,
  type FortressModule,
  type ModuleContextV2,
  type ModuleStartContext,
} from "../../host/module-contract";
import { isName } from "../../host/shape";
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
  loadBook,
  loginKey,
  newestJob,
  saveBook,
  stateOf,
  subjectOf,
  type Book,
  type Connection,
  type ConnectionFields,
  type JobRecord,
} from "./connections";
import { runJob, stepOfFailure, testJob } from "./data-runner";
import {
  ReachRefused,
  SecretNameRefused,
  type ContextPorts,
  type DatabasesHostPorts,
  type ModuleActContext,
  type Person,
} from "./host-ports";
import {
  CONNECTIONS_MAX,
  DATABASES_ACTS,
  DATABASES_MANIFEST,
  DATABASES_MODULE_ID,
  type FailureCode,
  type LinkEncryption,
} from "./manifest";
import { runQuery, type DataIslandRequest, type QueryAnswer } from "./query";

/** Jobs that may run at once, tests and queries together, over every
 *  organization. The module host runs at most this many programs for one
 *  module. */
export const JOBS_MAX_RUNNING = 4;

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
   * Answer one read of a data island: run the statement in the request's
   * settings on the connection it names, for this person.
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
  /** Resolves when no job of this module is running. */
  idle(): Promise<void>;
}

type Detail = Record<string, string | number | boolean>;

/** One of the places a job runs in. */
interface Place {
  id: string;
  abort: AbortController;
  /** Give the place back. The job has ended and written how. */
  release: () => void;
}

type TestOrigin = { kind: "control_plane" } | { kind: "person"; login: string };

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
  const running = new Map<string, { abort: AbortController; done: Promise<void> }>();
  /** One writer at a time for each organization's book. */
  const locks = new Map<string, Promise<void>>();
  let stopping = false;

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
  function takePlace(): Place | null {
    if (stopping || running.size >= maxRunning) return null;
    const id = `job_${randomId()}`;
    const abort = new AbortController();
    let ended = (): void => {};
    const done = new Promise<void>((resolve) => {
      ended = resolve;
    });
    running.set(id, { abort, done });
    return {
      id,
      abort,
      release: (): void => {
        running.delete(id);
        ended();
      },
    };
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
      ctx.audit.record("connection.test", {
        target: connection.name,
        job: place.id,
        origin: origin.kind,
        ...(origin.kind === "person" ? { by: origin.login } : {}),
      });
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
      end = { ok: false, code: read.code };
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
    if (written) recordTestEnd(ctx, written);
  }

  // ── What a person does ─────────────────────────────────────────────────────

  /** A refusal of one of the host's two lists, as the one word that is shown. */
  const shown = (thrown: unknown): unknown =>
    thrown instanceof ReachRefused || thrown instanceof SecretNameRefused
      ? new AskFailure(thrown.rule)
      : thrown;

  const usesKey = (held: Book, keyName: string, except: string): boolean =>
    held.connections.some((other) => other.id !== except && other.keyName === keyName);

  const isTesting = (held: Book, connection: Connection): boolean =>
    newestJob(held, connection)?.state === "running";

  /**
   * Take off the host's two lists every entry no connection points at. Such
   * an entry is what a failed write left behind: a host this HX Fortress may
   * reach, or a secret's name, that nothing uses. It runs at the start of
   * every act that changes something. A failure here is not the act's.
   */
  async function tidyLists(ctx: ModuleActContext, held: Book): Promise<void> {
    try {
      const reaches = new Set(held.connections.map((connection) => connection.reach));
      for (const entry of await ctx.reach.list()) {
        if (!reaches.has(entry.name)) await ctx.reach.remove(entry.name);
      }
      const names = new Set(held.connections.map((connection) => connection.keyName));
      for (const name of await ctx.secretNames.list()) {
        if (!names.has(name)) await ctx.secretNames.remove(name);
      }
    } catch (thrown) {
      report(ctx, "an unused entry could not be taken off the list of hosts or of secret names", thrown);
    }
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
    ctx.audit.record("connection.add", { ...described(added), by: person.login });
    return { name: added.name };
  }

  async function changeConnection(ctx: ModuleActContext, person: Person, fields: ConnectionFields): Promise<unknown> {
    const result = await withBook(ctx, async (held): Promise<{ after: Connection; changed: string[] }> => {
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

      const moved = before.host !== after.host || before.port !== after.port;
      const rekeyed = before.keyName !== after.keyName;
      const reachCount = before.reachCount + (moved ? 1 : 0);
      const reach = moved ? `${before.id}-${reachCount}` : before.reach;
      const oldKeyFree = rekeyed && !usesKey(held, before.keyName, before.id);
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
        if (rekeyed) {
          if (!usesKey(held, after.keyName, before.id)) await ctx.secretNames.remove(after.keyName).catch(() => {});
          if (oldKeyFree) await ctx.secretNames.add(before.keyName).catch(() => {});
        }
      };
      try {
        if (moved) {
          await ctx.reach.remove(before.reach);
          await ctx.reach.add(reach, { host: after.host, port: after.port });
        }
        if (rekeyed) {
          if (oldKeyFree) await ctx.secretNames.remove(before.keyName);
          await ctx.secretNames.add(after.keyName);
        }
      } catch (thrown) {
        await putBack();
        throw shown(thrown);
      }
      const next: Connection = {
        ...after,
        id: before.id,
        reach,
        reachCount,
        addedAt: before.addedAt,
        ...(before.addedBy === undefined ? {} : { addedBy: before.addedBy }),
        changedAt: clock().toISOString(),
        ...(isName(person.login) ? { changedBy: person.login } : {}),
        // No `job`, no `catalog` and no `verified`: the tests so far were of
        // the connection as it was, and so is what they read.
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
      // data nothing reads. Overwriting it can fail without harm.
      await clearCatalog(ctx.state, before.id).catch((thrown: unknown) =>
        report(ctx, "a changed connection's old catalog could not be overwritten", thrown),
      );
      return { after: next, changed };
    });
    if (result.changed.length > 0) {
      ctx.audit.record("connection.change", {
        ...described(result.after),
        changed: result.changed.join(" "),
        by: person.login,
      });
    }
    return { name: result.after.name };
  }

  async function removeConnection(ctx: ModuleActContext, person: Person, name: string): Promise<unknown> {
    const removed = await withBook(ctx, async (held): Promise<Connection> => {
      await tidyLists(ctx, held);
      const connection = findConnection(held, name);
      if (!connection) throw new AskFailure("connection_unknown");
      if (isTesting(held, connection)) throw new AskFailure("connection_busy");
      // Off the list of hosts first. If the book then cannot be saved, what is
      // left is a connection that can dial nothing, and removing it again
      // works. The other order could leave a host this HX Fortress may reach
      // with no connection to show for it.
      await ctx.reach.remove(connection.reach);
      if (!usesKey(held, connection.keyName, connection.id)) await ctx.secretNames.remove(connection.keyName);
      await saveBook(ctx.state, {
        ...held,
        connections: held.connections.filter((other) => other.id !== connection.id),
        jobs: held.jobs.filter((job) => job.connectionId !== connection.id),
      });
      await clearCatalog(ctx.state, connection.id).catch((thrown: unknown) =>
        report(ctx, "a removed connection's catalog could not be overwritten", thrown),
      );
      return connection;
    });
    ctx.audit.record("connection.remove", { ...described(removed), by: person.login });
    return {};
  }

  function nameOf(args: unknown): string {
    const name = (args as { name?: unknown } | null)?.name;
    return typeof name === "string" ? name : "";
  }

  async function readJob(ctx: ModuleContextV2, args: unknown): Promise<unknown> {
    const job = asItIs(findJob(await book(ctx), (args as { job: string }).job));
    if (!job) throw new AskFailure("job_unknown");
    return jobView(job);
  }

  return {
    id: DATABASES_MODULE_ID,
    manifest: DATABASES_MANIFEST,

    async init(context: ModuleStartContext): Promise<void> {
      stopping = false;
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
        case "connection.test":
          return { job: await startTest(ctx, nameOf(args), { kind: "person", login: person.login }) };
        case "job.read":
          return readJob(ctx, args);
        default:
          throw new AskFailure("act_not_implemented");
      }
    },

    onDataIsland(request: DataIslandRequest, ctx: ModuleContextV2, person: Person): Promise<QueryAnswer> {
      return runQuery(request, person, {
        ports: deps.ports.forContext(ctx),
        connection: async (name) => findConnection(await book(ctx), name),
        // A query takes one of the places a test takes, so the two together
        // never hand the host more jobs than it runs for one module.
        begin: takePlace,
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
