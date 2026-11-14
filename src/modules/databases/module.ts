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
  saveCatalog,
} from "./catalog";
import {
  BookUnreadable,
  changedFields,
  connectionFields,
  connectionState,
  findConnection,
  findJob,
  loadBook,
  newestJob,
  saveBook,
  subjectOf,
  type Book,
  type Connection,
  type ConnectionFields,
  type JobRecord,
} from "./connections";
import {
  JOB_DEADLINE_MS,
  JOB_GRACE_MS,
  PASSWORD_FIELD,
  readOutput,
  stepOfFailure,
  testJob,
  type TestFindings,
} from "./data-runner";
import {
  ReachRefused,
  SecretNameRefused,
  type ActPorts,
  type ContextPorts,
  type DatabasesHostPorts,
  type Person,
  type ProgramOutcome,
} from "./host-ports";
import { runQuery, type DataIslandRequest, type QueryAnswer } from "./query";
import {
  CONNECTIONS_MAX,
  DATA_RUNNER_PROGRAM,
  DATABASES_ACTS,
  DATABASES_MANIFEST,
  DATABASES_MODULE_ID,
  type FailureCode,
  type JobOrigin,
} from "./manifest";

/** Tests that may run at once, over every organization. The module host runs
 *  at most this many programs for one module. */
export const TESTS_MAX_RUNNING = 4;

/**
 * How long after a test of a connection started the control plane may start
 * the next one. Until then `test.start` answers the id of the test it already
 * has.
 *
 * Every test signs in to the database. A wrong password tried over and over
 * locks a login on most servers, and the control plane chooses how often it
 * asks. A person at the console is not held to this: they pressed the button.
 */
export const ASK_TEST_INTERVAL_MS = 60_000;

/** How long `stop` waits for the tests it interrupted to write how they ended. */
const STOP_WAIT_MS = 5_000;

export interface DatabasesModuleDeps {
  /** The ports the module host does not hand a module yet (host-ports.ts). */
  ports: DatabasesHostPorts;
  clock?: () => Date;
  /** Sixteen random hex characters. A seam for tests. */
  randomId?: () => string;
  askTestIntervalMs?: number;
  maxRunning?: number;
}

export interface DatabasesModule extends FortressModule {
  /**
   * Carry out one act of a signed-in person. `args` already has the shape the
   * act declares, and the caller has checked the person's sign-in and role.
   * The value returned is held to the act's declared reply before it is shown.
   *
   * It fails with `AskFailure`, whose one word is all that is shown.
   */
  onAct(act: string, args: unknown, ctx: ModuleContextV2, person: Person): Promise<unknown>;
  /**
   * Answer one read of a data island: run the statement in the request's
   * settings on the connection it names, for this person.
   *
   * The caller is the door, and it has checked both keys before this is
   * called: the person's sign-in at this Fortress, and the control plane's
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

interface Running {
  abort: AbortController;
  /** Resolves when the job has ended and written how. */
  done: Promise<void>;
  ended: () => void;
}

type TestOrigin = { kind: "control_plane" } | { kind: "person"; login: string };

type TestEnd = { ok: true; findings: TestFindings } | { ok: false; code: FailureCode };

export function createDatabasesModule(deps: DatabasesModuleDeps): DatabasesModule {
  const clock = deps.clock ?? ((): Date => new Date());
  const randomId = deps.randomId ?? ((): string => randomBytes(8).toString("hex"));
  const askTestIntervalMs = deps.askTestIntervalMs ?? ASK_TEST_INTERVAL_MS;
  const maxRunning = deps.maxRunning ?? TESTS_MAX_RUNNING;

  /** The jobs that are running, by id. In memory: a job does not outlive the
   *  process that started it. */
  const running = new Map<string, Running>();
  /** One writer at a time for each organization's book. */
  const locks = new Map<string, Promise<void>>();
  let stopping = false;

  // ── One organization's book, read and written under a lock ─────────────────

  /** What this module keys its own memory by. Never sent, never recorded. The
   *  Fortress's own organization is one fixed key, so its id is not read. */
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
      if (thrown instanceof BookUnreadable) throw new AskFailure("state_unreadable");
      throw thrown;
    }
  }

  // ── What is answered ───────────────────────────────────────────────────────

  function jobView(job: JobRecord): unknown {
    return {
      connection: job.connection,
      state: job.state,
      step: job.step,
      startedAt: job.startedAt,
      ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
      ...(job.code === undefined ? {} : { code: job.code }),
      ...(job.tables === undefined ? {} : { tables: job.tables }),
      ...(job.columns === undefined ? {} : { columns: job.columns }),
      ...(job.encryption === undefined ? {} : { encryption: job.encryption }),
      ...(job.canWrite === undefined ? {} : { canWrite: job.canWrite }),
    };
  }

  /** A connection as the control plane is told it: its name, its engine and
   *  where it stands. Not its server, not its login. */
  function listed(held: Book, connection: Connection): unknown {
    const job = newestJob(held, connection);
    return {
      name: connection.name,
      engine: connection.engine,
      reach: "direct",
      state: connectionState(held, connection),
      ...(job?.finishedAt === undefined ? {} : { testedAt: job.finishedAt }),
      ...(job?.state === "failed" && job.code !== undefined ? { failure: job.code } : {}),
      ...(job?.state === "done" && job.canWrite !== undefined ? { canWrite: job.canWrite } : {}),
    };
  }

  /** A connection as a person signed in to this Fortress sees it. */
  function detailed(held: Book, connection: Connection): unknown {
    const job = newestJob(held, connection);
    const test =
      job === undefined
        ? undefined
        : {
            job: job.id,
            state: job.state,
            step: job.step,
            origin: job.origin,
            ...(job.by !== undefined && isName(job.by) ? { by: job.by } : {}),
            startedAt: job.startedAt,
            ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
            ...(job.code === undefined ? {} : { code: job.code }),
            ...(job.encryption === undefined ? {} : { encryption: job.encryption }),
            ...(job.canWrite === undefined ? {} : { canWrite: job.canWrite }),
            ...(job.writableTables === undefined ? {} : { writableTables: job.writableTables }),
            ...(job.tables === undefined ? {} : { tables: job.tables }),
            ...(job.columns === undefined ? {} : { columns: job.columns }),
            ...(job.leftOutTables === undefined ? {} : { leftOutTables: job.leftOutTables }),
            ...(job.leftOutColumns === undefined ? {} : { leftOutColumns: job.leftOutColumns }),
            ...(job.truncated === undefined ? {} : { truncated: job.truncated }),
          };
    return {
      name: connection.name,
      engine: connection.engine,
      reach: "direct",
      host: connection.host,
      port: connection.port,
      database: connection.database,
      encryption: connection.encryption,
      minTls: connection.minTls,
      ...(connection.serverName === undefined ? {} : { serverName: connection.serverName }),
      user: connection.user,
      keyName: connection.keyName,
      state: connectionState(held, connection),
      addedAt: connection.addedAt,
      ...(connection.addedBy === undefined ? {} : { addedBy: connection.addedBy }),
      ...(connection.changedAt === undefined ? {} : { changedAt: connection.changedAt }),
      ...(connection.changedBy === undefined ? {} : { changedBy: connection.changedBy }),
      ...(test === undefined ? {} : { test }),
    };
  }

  /** What a record of a connection says about it: names and one count. The
   *  secret's NAME is there under `keyName`. Its value is nowhere in this
   *  module. */
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
    if (stopping) throw new AskFailure("busy");
    const ports = deps.ports.forContext(ctx);
    const started = await locked(ctx, async () => {
      const held = await book(ctx);
      const connection = findConnection(held, name);
      if (!connection) throw new AskFailure("connection_unknown");
      const newest = newestJob(held, connection);
      if (newest?.state === "running") return { id: newest.id, connection: null };
      const now = clock();
      if (
        origin.kind === "control_plane" &&
        newest !== undefined &&
        now.getTime() - Date.parse(newest.startedAt) < askTestIntervalMs
      ) {
        return { id: newest.id, connection: null };
      }
      if (running.size >= maxRunning) throw new AskFailure("busy");
      const id = `job_${randomId()}`;
      // The place is taken before the first wait, so two tests that start
      // together cannot both find the last one free.
      const abort = new AbortController();
      let ended = (): void => {};
      const done = new Promise<void>((resolve) => {
        ended = resolve;
      });
      running.set(id, { abort, done, ended });
      try {
        const job: JobRecord = {
          id,
          connectionId: connection.id,
          connection: connection.name,
          origin: origin.kind satisfies JobOrigin,
          ...(origin.kind === "person" ? { by: origin.login } : {}),
          state: "running",
          step: "start",
          startedAt: now.toISOString(),
        };
        held.jobs.unshift(job);
        connection.job = id;
        await saveBook(ctx.state, held);
      } catch (thrown) {
        running.delete(id);
        ended();
        throw thrown;
      }
      return { id, connection: { ...connection } };
    });
    if (started.connection) {
      const connection = started.connection;
      ctx.audit.record("connection.test", {
        target: connection.name,
        job: started.id,
        origin: origin.kind,
        ...(origin.kind === "person" ? { by: origin.login } : {}),
      });
      const entry = running.get(started.id);
      if (entry) {
        // Not waited for: the ask or the act that started the test is answered
        // with the job's id now, and `job.read` says how it went.
        void runTest(ctx, ports, connection, started.id, entry.abort).finally(() => {
          running.delete(started.id);
          entry.ended();
        });
      }
    }
    return started.id;
  }

  /** Hand the host one test job, wait for it, and write how it ended. Never
   *  rejects: nobody is waiting for it. */
  async function runTest(
    ctx: ModuleContextV2,
    ports: ContextPorts,
    connection: Connection,
    jobId: string,
    abort: AbortController,
  ): Promise<void> {
    let printed: unknown;
    let outputs = 0;
    let outcome: ProgramOutcome;
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      outcome = await Promise.race([
        ports.programs.run(DATA_RUNNER_PROGRAM, {
          reach: connection.name,
          secrets: { [PASSWORD_FIELD]: connection.keyName },
          input: testJob(jobId, subjectOf(connection), clock()),
          onOutput: (value) => {
            outputs += 1;
            printed = value;
          },
          timeoutMs: JOB_DEADLINE_MS + JOB_GRACE_MS,
          signal: abort.signal,
        }),
        // The host ends a program that outlives its time. This is for a host
        // that never answers at all, so that a test always ends.
        new Promise<ProgramOutcome>((resolve) => {
          guard = setTimeout(
            () => resolve({ ok: false, code: "timeout" }),
            JOB_DEADLINE_MS + 2 * JOB_GRACE_MS,
          );
          (guard as { unref?: () => void }).unref?.();
        }),
      ]);
    } catch {
      // What was thrown is not looked at: it is another component's text.
      outcome = { ok: false, code: "program_failed" };
    } finally {
      if (guard) clearTimeout(guard);
    }

    let end: TestEnd;
    if (abort.signal.aborted) {
      end = { ok: false, code: "interrupted" };
    } else if (!outcome.ok) {
      end = { ok: false, code: outcome.code };
    } else if (outputs === 0) {
      end = { ok: false, code: "output_invalid" };
    } else {
      // The program prints one line. Were there more, the last is its output.
      const read = readOutput(printed, { id: jobId, kind: "test" });
      if (!read.ok) end = { ok: false, code: read.code };
      else if (read.findings.kind !== "test") end = { ok: false, code: "output_invalid" };
      else end = { ok: true, findings: read.findings };
    }

    try {
      await finishTest(ctx, connection, jobId, end);
    } catch (thrown) {
      ctx.logger.error("a test's result could not be written", {
        job: jobId,
        error: thrown instanceof Error ? thrown.name : typeof thrown,
      });
    }
  }

  async function finishTest(
    ctx: ModuleContextV2,
    connection: Connection,
    jobId: string,
    end: TestEnd,
  ): Promise<void> {
    const finishedAt = clock().toISOString();
    const written = await locked(ctx, async (): Promise<JobRecord | null> => {
      const held = await book(ctx);
      const job = findJob(held, jobId);
      if (!job || job.state !== "running") return null;
      job.finishedAt = finishedAt;
      let failure: FailureCode | null = end.ok ? null : end.code;
      if (end.ok) {
        const { findings } = end;
        const reading = readCatalog(connection.engine, findings.tables, findings.truncated, finishedAt);
        try {
          await saveCatalog(ctx.state, connection.id, reading, jobId);
          job.state = "done";
          job.step = "catalog";
          job.encryption = findings.encryption;
          job.canWrite = findings.canWrite;
          job.writableTables = findings.writableTables;
          job.tables = reading.tables;
          job.columns = reading.columns;
          job.leftOutTables = reading.leftOut.tables;
          job.leftOutColumns = reading.leftOut.columns;
          job.truncated = reading.truncated;
        } catch {
          // Part of a reading may be on disk. A catalog that is half of one
          // reading and half of another is worse than none, so there is none
          // until the next test.
          await clearCatalog(ctx.state, connection.id).catch(() => {});
          failure = "internal";
        }
      }
      if (failure !== null) {
        job.state = "failed";
        job.code = failure;
        job.step = stepOfFailure(failure);
      }
      await saveBook(ctx.state, held);
      return job;
    });
    if (!written) return;
    ctx.audit.record("connection.tested", {
      target: written.connection,
      job: written.id,
      result: written.state === "done" ? "ready" : "failed",
      ...(written.code === undefined ? {} : { code: written.code }),
      ...(written.tables === undefined ? {} : { tables: written.tables }),
      ...(written.columns === undefined ? {} : { columns: written.columns }),
      ...(written.canWrite === undefined ? {} : { canWrite: written.canWrite }),
    });
  }

  /** A job the book calls running, with no process behind it: the Fortress
   *  stopped while the job ran. Say so, once, when the module starts. */
  async function sweepInterrupted(ctx: ModuleContextV2): Promise<void> {
    const ended = await locked(ctx, async (): Promise<JobRecord[]> => {
      const held = await book(ctx);
      const lost = held.jobs.filter((job) => job.state === "running" && !running.has(job.id));
      if (lost.length === 0) return [];
      const finishedAt = clock().toISOString();
      for (const job of lost) {
        job.state = "failed";
        job.code = "interrupted";
        job.finishedAt = finishedAt;
      }
      await saveBook(ctx.state, held);
      return lost;
    });
    for (const job of ended) {
      ctx.audit.record("connection.tested", {
        target: job.connection,
        job: job.id,
        result: "failed",
        code: "interrupted",
      });
    }
  }

  // ── What a person does ─────────────────────────────────────────────────────

  /** The one word a refusal of the host's two lists is shown as. */
  function refusalWord(thrown: unknown): AskFailure | null {
    if (thrown instanceof ReachRefused || thrown instanceof SecretNameRefused) {
      return new AskFailure(thrown.rule);
    }
    return null;
  }

  const usesKey = (held: Book, keyName: string, except: string): boolean =>
    held.connections.some((other) => other.id !== except && other.keyName === keyName);

  async function addConnection(
    ctx: ModuleContextV2,
    ports: ActPorts,
    person: Person,
    fields: ConnectionFields,
  ): Promise<unknown> {
    const added = await locked(ctx, async (): Promise<Connection> => {
      const held = await book(ctx);
      if (findConnection(held, fields.name)) throw new AskFailure("name_taken");
      if (held.connections.length >= CONNECTIONS_MAX) throw new AskFailure("connections_full");
      // The host's two lists first. Either may refuse, and a connection whose
      // host or secret the host did not take must not exist.
      try {
        await ports.reach.add(fields.name, { host: fields.host, port: fields.port });
      } catch (thrown) {
        throw refusalWord(thrown) ?? thrown;
      }
      const undo = async (): Promise<void> => {
        await ports.reach.remove(fields.name).catch(() => {});
        if (!usesKey(held, fields.keyName, "")) {
          await ports.secretNames.remove(fields.keyName).catch(() => {});
        }
      };
      try {
        await ports.secretNames.add(fields.keyName);
      } catch (thrown) {
        await ports.reach.remove(fields.name).catch(() => {});
        throw refusalWord(thrown) ?? thrown;
      }
      const connection: Connection = {
        ...fields,
        id: `c${randomId()}`,
        addedAt: clock().toISOString(),
        ...(isName(person.login) ? { addedBy: person.login } : {}),
      };
      try {
        await saveBook(ctx.state, { ...held, connections: [...held.connections, connection] });
      } catch (thrown) {
        await undo();
        throw thrown;
      }
      return connection;
    });
    ctx.audit.record("connection.add", { ...described(added), by: person.login });
    return { name: added.name };
  }

  async function changeConnection(
    ctx: ModuleContextV2,
    ports: ActPorts,
    person: Person,
    fields: ConnectionFields,
  ): Promise<unknown> {
    const result = await locked(ctx, async (): Promise<{ after: Connection; changed: string[] }> => {
      const held = await book(ctx);
      const connection = findConnection(held, fields.name);
      if (!connection) throw new AskFailure("connection_unknown");
      // A test in flight was started with the fields as they were.
      if (connectionState(held, connection) === "testing") throw new AskFailure("connection_busy");
      const before: Connection = { ...connection };
      // The name is the connection's identity, and it keeps the spelling it
      // was added with.
      const after: ConnectionFields = { ...fields, name: before.name };
      const changed = changedFields(before, after);
      if (changed.length === 0) return { after: before, changed };

      const moved = before.host !== after.host || before.port !== after.port;
      const rekeyed = before.keyName !== after.keyName;
      const restoreReach = async (): Promise<void> => {
        await ports.reach.remove(before.name).catch(() => {});
        await ports.reach.add(before.name, { host: before.host, port: before.port }).catch(() => {});
      };
      if (moved) {
        await ports.reach.remove(before.name);
        try {
          await ports.reach.add(before.name, { host: after.host, port: after.port });
        } catch (thrown) {
          await restoreReach();
          throw refusalWord(thrown) ?? thrown;
        }
      }
      if (rekeyed) {
        try {
          await ports.secretNames.add(after.keyName);
        } catch (thrown) {
          if (moved) await restoreReach();
          throw refusalWord(thrown) ?? thrown;
        }
      }
      const next: Connection = {
        ...after,
        id: before.id,
        addedAt: before.addedAt,
        ...(before.addedBy === undefined ? {} : { addedBy: before.addedBy }),
        changedAt: clock().toISOString(),
        ...(isName(person.login) ? { changedBy: person.login } : {}),
        // No `job`: the tests so far were of the connection as it was.
      };
      try {
        // What the last test read is of the database the connection named
        // before, so it goes with the change.
        await clearCatalog(ctx.state, before.id);
        await saveBook(ctx.state, {
          ...held,
          connections: held.connections.map((other) => (other.id === before.id ? next : other)),
        });
      } catch (thrown) {
        if (moved) await restoreReach();
        if (rekeyed && !usesKey(held, after.keyName, before.id)) {
          await ports.secretNames.remove(after.keyName).catch(() => {});
        }
        throw thrown;
      }
      if (rekeyed && !usesKey(held, before.keyName, before.id)) {
        await ports.secretNames.remove(before.keyName).catch(() => {});
      }
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

  async function removeConnection(
    ctx: ModuleContextV2,
    ports: ActPorts,
    person: Person,
    name: string,
  ): Promise<unknown> {
    const removed = await locked(ctx, async (): Promise<Connection> => {
      const held = await book(ctx);
      const connection = findConnection(held, name);
      if (!connection) throw new AskFailure("connection_unknown");
      if (connectionState(held, connection) === "testing") throw new AskFailure("connection_busy");
      // The book first. If the host's lists then keep an entry, it is an entry
      // nothing uses. The other order could leave a connection the host no
      // longer lets this module reach.
      await saveBook(ctx.state, {
        ...held,
        connections: held.connections.filter((other) => other.id !== connection.id),
      });
      await clearCatalog(ctx.state, connection.id).catch(() => {});
      await ports.reach.remove(connection.name).catch(() => {});
      if (!usesKey(held, connection.keyName, connection.id)) {
        await ports.secretNames.remove(connection.keyName).catch(() => {});
      }
      return connection;
    });
    ctx.audit.record("connection.remove", { ...described(removed), by: person.login });
    return {};
  }

  function nameOf(args: unknown): string {
    const name = (args as { name?: unknown } | null)?.name;
    return typeof name === "string" ? name : "";
  }

  return {
    id: DATABASES_MODULE_ID,
    manifest: DATABASES_MANIFEST,

    async init(context: ModuleStartContext): Promise<void> {
      stopping = false;
      try {
        for (const ctx of await context.organizations()) await sweepInterrupted(ctx);
      } catch (thrown) {
        // Not a reason for the module not to start: an ask that needs the
        // book says the same when it cannot read it.
        context.logger.error("could not look for tests that were interrupted", {
          error: thrown instanceof Error ? thrown.name : typeof thrown,
        });
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
          let read: Awaited<ReturnType<typeof catalogPage>>;
          try {
            read = await catalogPage(ctx.state, connection.id, page);
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
        case "job.read": {
          const job = findJob(await book(ctx), (args as { job: string }).job);
          if (!job) throw new AskFailure("job_unknown");
          return jobView(job);
        }
        default:
          // The gate refuses an ask the manifest does not list before it gets
          // here. This is the same answer for a manifest and a module that
          // have drifted apart.
          throw new AskFailure("ask_not_implemented");
      }
    },

    async onAct(act: string, args: unknown, ctx: ModuleContextV2, person: Person): Promise<unknown> {
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
          return addConnection(ctx, deps.ports.forAct(ctx, person), person, connectionFields(args));
        case "connection.change":
          return changeConnection(ctx, deps.ports.forAct(ctx, person), person, connectionFields(args));
        case "connection.remove":
          return removeConnection(ctx, deps.ports.forAct(ctx, person), person, nameOf(args));
        case "connection.test":
          return { job: await startTest(ctx, nameOf(args), { kind: "person", login: person.login }) };
        case "job.read": {
          const job = findJob(await book(ctx), (args as { job: string }).job);
          if (!job) throw new AskFailure("job_unknown");
          return jobView(job);
        }
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
        begin: () => {
          if (stopping || running.size >= maxRunning) return null;
          const id = `job_${randomId()}`;
          const abort = new AbortController();
          let ended = (): void => {};
          const done = new Promise<void>((resolve) => {
            ended = resolve;
          });
          running.set(id, { abort, done, ended });
          return {
            id,
            signal: abort.signal,
            end: (): void => {
              running.delete(id);
              ended();
            },
          };
        },
        clock,
      });
    },

    async idle(): Promise<void> {
      while (running.size > 0) {
        await Promise.allSettled([...running.values()].map((entry) => entry.done));
      }
    },
  };
}
