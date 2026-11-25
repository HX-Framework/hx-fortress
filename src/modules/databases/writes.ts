// A write into a database: the two asks that start one, the job that runs it,
// and the module's own record of such jobs.
//
// WHO MAY START ONE. The control plane, with the ask `write.start` or
// `write.undo`, and nobody else. The ask gate has checked the control plane's
// grant for exactly the ask's arguments before this file sees them, and those
// arguments name the person who approved the write and each preview by the
// Store's checksum of what that person was shown. So the grant is the
// approval. No act of a person at the console starts a write, and no other
// module can: `DatabasesForModules.run` takes a pull and a compare only.
//
// THIS IS THE ONE PLACE WHERE A JOB GETS A WRITE LOGIN. `pushJob` builds the
// one kind of job that signs in with a connection's write login, and `run`
// below is its one caller. A test holds the source files to that.
//
// WHAT IS CHECKED BEFORE A PROGRAM IS STARTED, in this order:
//
//    1. the arguments, beyond their shape: who writes, and the previews
//    2. the request was not taken before (the same request with the same
//       arguments answers the job it started, and starts nothing)
//    3. the connection is there, has passed a test since it was added or
//       changed, and names a write login that no database has refused
//    4. the Stores module says what the write holds, and opens nothing yet
//    5. each preview's checksum is the one the ask names, and each part's
//       table is one the connection may write
//    6. a place is free, and no other write runs on the connection
//    7. the Stores module opens the store job, and its parts are checked
//       again as in 5
//    8. the connection is still the one that was checked, with a test that
//       passed and the same write settings
//
// A refusal at any of them is one word, and nothing was started. From 7 on, a
// refusal also fails the store job that was opened. Step 8 is made under the
// lock that a change of a connection holds from before it stops what runs on
// the connection until it is saved. So a write either sees the change, or has
// its place by the time the change stops what runs.
//
// WHEN THE STORE JOB IS ENDED FROM HERE. Every time a job of this file is over
// and no program can still be running for it: the module host answered for
// the run, or no run was started. The Stores module then fails the store job,
// unless the Store has heard that job's end from the program, or the job
// ended already: such a job it leaves as it is. So a store job whose program
// never told the Store anything does not keep the Store's other jobs waiting
// until its key's time is up. The store job is never ended from here while a
// program may still run for it, which is when the module host stayed silent
// about the run or threw: that program's own word of its end would then be
// refused. Such a store job ends by itself when its key's time is up.
//
// WHAT IS KEPT. One record for each job, in the module's own state, apart from
// the record of the connections: its ids, its kind, how it ended, and a hash
// of what was asked. No person, no table and no row is in it. The audit trail
// holds who approved what.

import { createHash } from "node:crypto";

import { canonicalJson } from "../../host/ask-scope";
import { AskFailure, type ModuleContextV2 } from "../../host/module-contract";
import { ID_MAX_CHARS, ID_PATTERN, isName } from "../../host/shape";
import { withDeadline } from "../../host/with-deadline";
import {
  changedFields,
  findConnection,
  idForModules,
  sameTable,
  sameWrites,
  subjectOf,
  type Book,
  type Connection,
  type TableName,
} from "./connections";
import { pushJob, runJob, STORE_JOB_MAX_MS, type ProgramName } from "./data-runner";
import type { ConnectionRef, StoreJobTarget } from "./for-modules";
import type { ProgramsPort } from "./host-ports";
import { isLocalGateway } from "./host-text";
import {
  WRITE_FAILURE_CODES,
  WRITE_PREVIEWS_MAX,
  type JobState,
  type WriteFailureCode,
  type WriteJobKind,
} from "./manifest";
import {
  STORE_CALL_WORDS,
  STORE_JOB_STATES,
  STORE_JOB_WORDS,
  type StoreAnswer,
  type StoreJobState,
  type StoreJobWord,
  type StoresForWrites,
  type WritePart,
  type WriteRequest,
} from "./stores-port";

// ── The record of the jobs that write ────────────────────────────────────────

const WRITES_KEY = "writes";

/** Ended jobs that are kept: the ones that ended last. A job that runs is
 *  always kept. */
export const WRITE_JOBS_KEPT = 100;

/**
 * How long the Stores module may take for the calls of one ask, together:
 * reading what a write holds, and opening its store job. An ask has 25
 * seconds, so a slow Stores module alone does not use them up.
 *
 * An ask can still run past its time: this module's own records can be slow
 * to read or write, and a change of a connection holds the organization's
 * lock while it is saved. The gate then answers `timeout` while this module
 * works on, and the write may start after that answer. That is what `request`
 * is for: asked again with the same request and arguments, the ask answers the
 * job that was started, and starts nothing.
 *
 * It is also the time one later call may take: ending a store job, or reading
 * how one stands.
 */
export const STORE_CALL_MS = 20_000;

/** One job that writes: how it stands, and what it was for. */
export interface WriteJob {
  id: string;
  kind: WriteJobKind;
  /** The control plane's id for the approval this job was started with. */
  request: string;
  /** SHA-256 of the ask's name and its arguments, in one spelling. The same
   *  request with other arguments is another ask. */
  asked: string;
  /** The connection's own id, and its name when the job started. */
  connectionId: string;
  connection: string;
  store: string;
  storeJob: string;
  state: JobState;
  startedAt: string;
  finishedAt?: string;
  code?: WriteFailureCode;
  /** How the Store's own job stood when this one ended, when that could be
   *  read. */
  storeState?: StoreJobState;
  /** The Store's word for its own job, when that job had failed by then. */
  refusal?: StoreJobWord;
  batches?: number;
  inserted?: number;
  updated?: number;
  deleted?: number;
  held?: number;
  /** Which program ran it, when the program said so. */
  dbIo?: ProgramName;
  /** The version of the HX Fortress that started the program. */
  release?: string;
}

interface WritesBook {
  v: 1;
  /** The job that started or ended last comes first. */
  jobs: WriteJob[];
}

/** The record of the jobs that write could not be read. Nothing is guessed. */
class WritesUnreadable extends Error {
  constructor(cause?: unknown) {
    super("the module's own record of its writes cannot be read", { cause });
    this.name = "WritesUnreadable";
  }
}

// ── What was asked ───────────────────────────────────────────────────────────

export type WriteAsk = "write.start" | "write.undo";

interface Asked {
  kind: WriteJobKind;
  request: string;
  connection: string;
  store: string;
  previews: { table: string; version: number; checksum: string }[];
  /** For an undo: the store job of the write it takes back. */
  write?: string;
  writer: string;
  approvedBy: { id: string; email: string };
  asked: string;
}

/** Who writes, as the control plane names them: a version of a program, or a
 *  person. One token on each side of the marks. */
const WRITER = /^(?:program:[^\s:@]+@[^\s:@]+|user:[^\s:@]+)$/;
/** The Store's checksum of a saved preview: SHA-256 in lower-case hex. */
const CHECKSUM = /^[0-9a-f]{64}$/;

const isId = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= ID_MAX_CHARS && ID_PATTERN.test(value);

/**
 * An ask's arguments, with the rules their shape cannot state. The gate has
 * held them to the shape. Throws `AskFailure` with the word for the first
 * thing that breaks a rule.
 */
function readAsk(ask: WriteAsk, raw: unknown): Asked {
  const args = (raw ?? {}) as Record<string, unknown>;
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  const approved = (args.approvedBy ?? {}) as Record<string, unknown>;
  const writer = text(args.writer);
  if (!WRITER.test(writer)) throw new AskFailure("writer_invalid");
  // Who approved has no rule here: the ask's shape holds the id to an id and
  // the email to an email address, and the gate has checked both.
  const approvedBy = { id: text(approved.id), email: text(approved.email) };

  const previews: Asked["previews"] = [];
  let write: string | undefined;
  if (ask === "write.start") {
    const given = Array.isArray(args.previews) ? (args.previews as unknown[]) : [];
    if (given.length < 1 || given.length > WRITE_PREVIEWS_MAX) throw new AskFailure("previews_invalid");
    for (const entry of given) {
      const { table, version, checksum } = (entry ?? {}) as Record<string, unknown>;
      if (!isId(table) || typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) {
        throw new AskFailure("previews_invalid");
      }
      if (typeof checksum !== "string" || !CHECKSUM.test(checksum)) throw new AskFailure("previews_invalid");
      // A preview's table holds one preview. Named twice, it is two writes of
      // the same rows.
      if (previews.some((other) => other.table === table)) throw new AskFailure("previews_invalid");
      previews.push({ table, version, checksum });
    }
  } else {
    write = text(args.write);
  }
  const asked: Omit<Asked, "asked"> = {
    kind: ask === "write.undo" ? "undo" : args.rehearse === true ? "rehearsal" : "write",
    request: text(args.request),
    connection: text(args.connection),
    store: text(args.store),
    previews,
    ...(write === undefined ? {} : { write }),
    writer,
    approvedBy,
  };
  return { ...asked, asked: createHash("sha256").update(canonicalJson([ask, asked]), "utf8").digest("hex") };
}

/** What the Stores module is asked for: the write as the ask names it, on the
 *  connection as this module found it. */
function requestOf(asked: Asked, connection: ConnectionRef): WriteRequest {
  const by = `user:${asked.approvedBy.id}`;
  return asked.kind === "undo"
    ? { kind: "push_undo", connection, write: asked.write ?? "", writer: asked.writer, by }
    : {
        kind: "push",
        connection,
        previews: asked.previews.map(({ table, version }) => ({ table, version })),
        rehearse: asked.kind === "rehearsal",
        writer: asked.writer,
        by,
      };
}

/** The parts of a write as the Stores module answered them, or null for an
 *  answer that is not parts. */
function readParts(value: unknown): WritePart[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > WRITE_PREVIEWS_MAX) return null;
  const parts: WritePart[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const { table, version, checksum, target } = entry as Record<string, unknown>;
    if (typeof table !== "string" || typeof version !== "number") return null;
    if (checksum !== undefined && typeof checksum !== "string") return null;
    if (typeof target !== "object" || target === null) return null;
    const { schema, name } = target as Record<string, unknown>;
    if (typeof schema !== "string" || typeof name !== "string") return null;
    parts.push({ table, version, ...(checksum === undefined ? {} : { checksum }), target: { schema, name } });
  }
  return parts;
}

/**
 * Hold what the Store says a write holds against what was asked and against
 * the tables the connection may write. Throws `AskFailure`.
 *
 *   preview_changed    a write's parts are not the previews the ask names, in
 *                      its order, each with the checksum the ask names
 *   table_not_listed   a part's table is not one the connection may write
 */
function checkParts(asked: Asked, parts: readonly WritePart[], tables: readonly TableName[]): void {
  if (asked.kind !== "undo") {
    if (parts.length !== asked.previews.length) throw new AskFailure("preview_changed");
    for (const [at, preview] of asked.previews.entries()) {
      const part = parts.at(at);
      if (
        part === undefined ||
        part.table !== preview.table ||
        part.version !== preview.version ||
        part.checksum !== preview.checksum
      ) {
        throw new AskFailure("preview_changed");
      }
    }
  }
  for (const part of parts) {
    if (!tables.some((table) => sameTable(table, part.target))) throw new AskFailure("table_not_listed");
  }
}

/** A word of the Stores module's calls as an ask answers it: its own word
 *  when it is one of the list, `timeout` for a call that did not answer in
 *  its time, and one word for any other. */
function passedOn(code: unknown): string {
  if (code === "timeout") return code;
  return typeof code === "string" && (STORE_CALL_WORDS as readonly string[]).includes(code) ? code : "store_refused";
}

// ── The jobs ─────────────────────────────────────────────────────────────────

type Detail = Record<string, string | number | boolean>;

/** One of the module's places for a job, as module.ts hands it out. */
export interface WritePlace {
  id: string;
  abort: AbortController;
  /** Why the module itself stopped the job, when it did: one word. */
  stopped: () => string | null;
  release: () => void;
}

export interface WritesDeps {
  clock: () => Date;
  /** The Stores module's calls, looked up at each ask. Null when this build or
   *  this organization has none. */
  stores: () => StoresForWrites | null;
  programs: (ctx: ModuleContextV2) => ProgramsPort;
  /** One writer at a time for one organization's records. */
  locked: <T>(ctx: ModuleContextV2, work: () => Promise<T>) => Promise<T>;
  /** The organization's connections. Rejects with `AskFailure`. */
  book: (ctx: ModuleContextV2) => Promise<Book>;
  /** A place for a job that writes on this connection, or null when none is
   *  free or another write runs on the connection. */
  takePlace: (connectionId: string) => WritePlace | null;
  isRunning: (jobId: string) => boolean;
  /** What the module keys its own memory by, for one organization. */
  organizationKey: (ctx: ModuleContextV2) => string;
  report: (ctx: ModuleContextV2, message: string, thrown: unknown, more?: Detail) => void;
  /** Whether a database refused the connection's write login, and no operator
   *  has set it again since. */
  writeLoginRefused: (held: Book, connection: Connection) => boolean;
  /** Write down that a database refused the connection's write login. Never
   *  rejects. */
  noteRefusedWriteLogin: (ctx: ModuleContextV2, connection: Connection) => Promise<void>;
  /** This HX Fortress's own version, for the record of a write. */
  release?: string;
  /** A seam for tests, as in module.ts. */
  hostSilentAfterMs?: number;
  /** How long one call of the Stores module may take. A seam for tests: the
   *  default is `STORE_CALL_MS`. */
  storeCallMs?: number;
}

export interface Writes {
  /** Start a write, a rehearsal or an undo, or answer the job the same
   *  request started before. Rejects with `AskFailure`. */
  start(ctx: ModuleContextV2, ask: WriteAsk, args: unknown): Promise<{ job: string; storeJob: string }>;
  /** A job that writes as `job.read` answers it, or null when this module
   *  keeps no such job. */
  read(ctx: ModuleContextV2, id: string): Promise<unknown>;
  /** Write as interrupted every job the record calls running that is not. */
  closeLost(ctx: ModuleContextV2): Promise<void>;
}

export function createWrites(deps: WritesDeps): Writes {
  const silent = deps.hostSilentAfterMs === undefined ? {} : { silentAfterMs: deps.hostSilentAfterMs };
  const callMs = deps.storeCallMs ?? STORE_CALL_MS;
  // `job.read` answers the version as a name. One that is no name is left
  // out, so that this one field never costs a job's whole answer.
  const release = isName(deps.release) && deps.release !== "" ? deps.release : undefined;
  /** The asks that are being worked on, by organization and request. A second
   *  ask with the same request waits for the first one's answer. */
  const inFlight = new Map<string, { asked: string; answer: Promise<{ job: string; storeJob: string }> }>();
  /**
   * Jobs that ended and whose end could not be written, by organization and
   * job. The record still calls such a job running. While this process lives
   * it knows better, and says so: a write that happened is not answered as one
   * that was interrupted. The end is written with the next write of the
   * record.
   */
  const unwritten = new Map<string, WriteJob>();
  const jobKey = (ctx: ModuleContextV2, id: string): string => `${deps.organizationKey(ctx)} ${id}`;

  async function load(ctx: ModuleContextV2): Promise<WritesBook> {
    let stored: unknown;
    try {
      stored = await ctx.state.read<unknown>(WRITES_KEY);
    } catch (thrown) {
      throw new WritesUnreadable(thrown);
    }
    if (stored === null) return { v: 1, jobs: [] };
    const book = stored as Partial<WritesBook>;
    if (book.v !== 1 || !Array.isArray(book.jobs)) throw new WritesUnreadable();
    return { v: 1, jobs: book.jobs };
  }

  async function writes(ctx: ModuleContextV2): Promise<WritesBook> {
    try {
      return await load(ctx);
    } catch (thrown) {
      if (!(thrown instanceof WritesUnreadable)) throw thrown;
      deps.report(ctx, "the record of this organization's writes cannot be read", thrown.cause);
      throw new AskFailure("state_unreadable");
    }
  }

  /**
   * Write the record, and leave `book` as it was written.
   *
   * An end that this process holds and could not write before (`unwritten`)
   * is written here, with whatever else is being written: this is the one
   * function that writes the record.
   *
   * The ended jobs that are kept are the first of the list. So a job whose
   * end is new in a write must be at the front of what is handed over,
   * however long ago it started: its callers put it there, and this function
   * does so for an end that could not be written before.
   */
  async function save(ctx: ModuleContextV2, book: WritesBook): Promise<void> {
    const late: WriteJob[] = [];
    const rest = book.jobs.filter((job) => {
      const end = job.state === "running" ? unwritten.get(jobKey(ctx, job.id)) : undefined;
      if (end === undefined) return true;
      late.push(end);
      return false;
    });
    let ended = 0;
    const jobs = [...late, ...rest].filter((job) => {
      if (job.state === "running") return true;
      ended += 1;
      return ended <= WRITE_JOBS_KEPT;
    });
    await ctx.state.write<WritesBook>(WRITES_KEY, { v: 1, jobs });
    for (const job of late) unwritten.delete(jobKey(ctx, job.id));
    book.jobs = jobs;
  }

  /** The line a job leaves in the audit trail: ids and names. */
  const lineOf = (job: WriteJob): Detail => ({
    target: job.connection,
    kind: job.kind,
    job: job.id,
    request: job.request,
    store: job.store,
    storeJob: job.storeJob,
  });

  function recordEnd(ctx: ModuleContextV2, job: WriteJob, who: Detail = {}): void {
    // Which program wrote, and which HX Fortress started it.
    const more: Detail = {
      ...who,
      ...(job.dbIo === undefined ? {} : { dbIoVersion: job.dbIo.version }),
      ...(job.dbIo?.commit === undefined ? {} : { dbIoCommit: job.dbIo.commit }),
      ...(job.release === undefined ? {} : { release: job.release }),
      ...(job.storeState === undefined ? {} : { storeState: job.storeState }),
    };
    if (job.state === "done") {
      ctx.audit.record("connection.write.done", {
        ...lineOf(job),
        ...more,
        batches: job.batches ?? 0,
        inserted: job.inserted ?? 0,
        updated: job.updated ?? 0,
        deleted: job.deleted ?? 0,
        held: job.held ?? 0,
        ...(job.refusal === undefined ? {} : { refusal: job.refusal }),
      });
    } else {
      ctx.audit.record("connection.write.failed", {
        ...lineOf(job),
        ...more,
        code: job.code ?? "internal",
        ...(job.refusal === undefined ? {} : { refusal: job.refusal }),
      });
    }
  }

  /**
   * A job as it is. One the record calls running, with nothing behind it in
   * this process, has ended: as this process saw it end, when it did, and as
   * interrupted otherwise.
   */
  const asItIs = (ctx: ModuleContextV2, job: WriteJob): WriteJob =>
    job.state === "running" && !deps.isRunning(job.id)
      ? (unwritten.get(jobKey(ctx, job.id)) ?? { ...job, state: "failed", code: "interrupted" })
      : job;

  /**
   * Under the organization's lock: correct every job the record calls running
   * that is not, and answer the record and the jobs that were written as
   * interrupted. A job whose end this process saw is written as it ended
   * (`save` does that).
   */
  async function closed(ctx: ModuleContextV2): Promise<{ book: WritesBook; lost: WriteJob[] }> {
    const book = await writes(ctx);
    const stale = book.jobs.filter((job) => job.state === "running" && !deps.isRunning(job.id));
    if (stale.length === 0) return { book, lost: [] };
    const finishedAt = deps.clock().toISOString();
    const lost = stale
      .filter((job) => !unwritten.has(jobKey(ctx, job.id)))
      .map((job): WriteJob => ({ ...job, state: "failed", code: "interrupted", finishedAt }));
    // A job that is written as ended now is the newest of the ended ones,
    // however long ago it started. It goes to the front, as a job that `run`
    // ends does: left where it started, it could be behind a hundred jobs
    // that ended since, and the save below would drop it at once.
    book.jobs = [...lost, ...book.jobs.filter((job) => !lost.some((ended) => ended.id === job.id))];
    await save(ctx, book);
    return { book, lost };
  }

  /**
   * One call of the Stores module, held to a time. A call that throws or runs
   * out of time is a refusal, in one word. Never rejects.
   *
   * A call that ran out of time is not stopped: the Stores module may still
   * answer. `late` is handed that answer, so that what it opened can be ended.
   */
  async function call<T>(
    ctx: ModuleContextV2,
    what: string,
    ms: number,
    work: () => Promise<StoreAnswer<T>>,
    late?: (answer: StoreAnswer<T>) => void,
  ): Promise<StoreAnswer<T>> {
    class TimedOut extends Error {}
    let pending: Promise<StoreAnswer<T>>;
    try {
      pending = work();
    } catch (thrown) {
      deps.report(ctx, `the Stores module threw while it was asked to ${what}`, thrown);
      return { ok: false, code: "store_refused" };
    }
    try {
      const answer = await withDeadline(pending, ms, "the Stores module did not answer", {
        error: () => new TimedOut(),
        unref: true,
      });
      if (typeof answer !== "object" || answer === null || typeof answer.ok !== "boolean") {
        return { ok: false, code: "store_refused" };
      }
      return answer;
    } catch (thrown) {
      if (thrown instanceof TimedOut) {
        if (late) void pending.then(late).catch(() => {});
        return { ok: false, code: "timeout" };
      }
      deps.report(ctx, `the Stores module threw while it was asked to ${what}`, thrown);
      return { ok: false, code: "store_refused" };
    }
  }

  /** Tell the Stores module to end a store job: it fails the job, unless the
   *  Store has heard its end or the job ended already. Never rejects: what
   *  could not be ended ends by itself when its time is up. */
  async function endQuietly(ctx: ModuleContextV2, stores: StoresForWrites, store: string, storeJob: string): Promise<void> {
    try {
      await withDeadline(stores.endWrite(callerOf(ctx), store, storeJob), callMs, "the Stores module did not answer", {
        unref: true,
      });
    } catch (thrown) {
      deps.report(ctx, "an open store job could not be ended", thrown, { storeJob });
    }
  }

  /**
   * End a store job that the Stores module opened and that no program will
   * work for, when it has an id to end it by. Never rejects.
   *
   * It is ended in the Store that was asked for, whatever Store the job says
   * it is of. A job that names another Store is an answer this module does
   * not trust: it does not then act on that answer in a Store that the ask's
   * grant did not name, where the job could be another write's.
   */
  async function endOpened(ctx: ModuleContextV2, stores: StoresForWrites, store: string, opened: unknown): Promise<void> {
    if (typeof opened !== "object" || opened === null) return;
    const jobId: unknown = (opened as { jobId?: unknown }).jobId;
    if (isId(jobId)) await endQuietly(ctx, stores, store, jobId);
  }

  const callerOf = (ctx: ModuleContextV2): Pick<ModuleContextV2, "organization" | "moduleId"> => ({
    organization: ctx.organization,
    moduleId: ctx.moduleId,
  });

  /**
   * Whether the job the Stores module opened is one the program can be handed:
   * of the Store that was asked for, with an id, a key, and a gateway on this
   * machine, in the one form a job of another module is held to as well.
   * Whether that address is this HX Fortress's own door is the module host's
   * to check when it starts the program.
   */
  function soundTarget(job: unknown, store: string): job is StoreJobTarget {
    if (typeof job !== "object" || job === null) return false;
    const { gatewayUrl, storeId, jobId, key } = job as Record<string, unknown>;
    return (
      storeId === store &&
      isId(jobId) &&
      typeof gatewayUrl === "string" &&
      isLocalGateway(gatewayUrl) &&
      typeof key === "string" &&
      /^[\x21-\x7e]{1,512}$/.test(key)
    );
  }

  async function begin(ctx: ModuleContextV2, asked: Asked): Promise<{ job: string; storeJob: string }> {
    // 2. A request this module took before.
    const before = await deps.locked(ctx, () => closed(ctx));
    for (const job of before.lost) recordEnd(ctx, job);
    const taken = before.book.jobs.find((job) => job.request === asked.request);
    if (taken) {
      if (taken.asked !== asked.asked) throw new AskFailure("request_reused");
      return { job: taken.id, storeJob: taken.storeJob };
    }

    // 3. The connection.
    const held = await deps.book(ctx);
    const connection = findConnection(held, asked.connection);
    if (!connection) throw new AskFailure("connection_unknown");
    if (!connection.verified) throw new AskFailure("not_tested");
    const settings = connection.writes;
    if (!settings) throw new AskFailure("write_login_missing");
    if (deps.writeLoginRefused(held, connection)) throw new AskFailure("write_login_refused");

    // 4 and 5. What the write holds, before anything is opened.
    const stores = deps.stores();
    if (!stores) throw new AskFailure("stores_off");
    const ref: ConnectionRef = { id: idForModules(connection), name: connection.name, engine: connection.engine };
    const request = requestOf(asked, ref);
    const caller = callerOf(ctx);
    // The two calls share one time: see `STORE_CALL_MS`. This is the wall
    // clock, and not the module's own, which says what time a record gets.
    const until = Date.now() + callMs;
    const left = (): number => Math.max(1, until - Date.now());
    const read = await call(ctx, "read a write's parts", left(), () => stores.writeParts(caller, asked.store, request));
    if (!read.ok) throw new AskFailure(passedOn(read.code));
    const parts = readParts(read.parts);
    if (!parts) throw new AskFailure("store_refused");
    checkParts(asked, parts, settings.tables);

    // 6. A place.
    const place = deps.takePlace(connection.id);
    if (!place) throw new AskFailure("busy");

    let opened: StoreJobTarget | null = null;
    /** What the opened store job holds: the parts that are written. */
    let written: WritePart[];
    let job: WriteJob;
    // The connection as the record has it when the job starts. The job runs
    // on this reading, and not on the one the checks began with.
    let current: Connection;
    try {
      // 7. The store job.
      const open = await call(
        ctx,
        "open a write",
        left(),
        () => stores.openWrite(caller, asked.store, request),
        // The ask has given up by now. A store job that is opened after that
        // has no program coming: it is failed again at once.
        (late) => {
          if (late.ok) void endOpened(ctx, stores, asked.store, late.job);
        },
      );
      if (!open.ok) throw new AskFailure(passedOn(open.code));
      const target: unknown = open.job;
      if (!soundTarget(target, asked.store)) {
        // Not waited for, here and below: the Stores module has had its time
        // for this ask, and the ask's own word is not held back for it.
        void endOpened(ctx, stores, asked.store, target);
        throw new AskFailure("store_refused");
      }
      opened = target;
      const openedParts = readParts(open.parts);
      if (!openedParts) throw new AskFailure("store_refused");
      checkParts(asked, openedParts, settings.tables);
      written = openedParts;

      // 8. The connection again, and the job's record, in one step.
      const record: WriteJob = {
        id: place.id,
        kind: asked.kind,
        request: asked.request,
        asked: asked.asked,
        connectionId: connection.id,
        connection: connection.name,
        store: asked.store,
        storeJob: opened.jobId,
        state: "running",
        startedAt: deps.clock().toISOString(),
      };
      current = await deps.locked(ctx, async (): Promise<Connection> => {
        const heldNow = await deps.book(ctx);
        const now = findConnection(heldNow, asked.connection);
        // Everything of check 3 once more, and that this is still the
        // connection the Stores module was asked about: an operator may have
        // changed it, or its write settings, while that module answered. A
        // change leaves the connection with no test that passed, until one
        // does. A connection that was changed and changed back, and has
        // passed a test since, is the connection that was checked.
        if (
          !now ||
          !now.verified ||
          changedFields(connection, now).length > 0 ||
          idForModules(now) !== ref.id ||
          !sameWrites(now.writes, settings) ||
          deps.writeLoginRefused(heldNow, now)
        ) {
          throw new AskFailure("connection_changed");
        }
        // The place was stopped while the Stores module opened the job. By an
        // operator's act on the connection: the job would be ended as soon
        // as it started, so it is not started. Or by the module's own stop,
        // which is no change of the connection: the control plane asks
        // again.
        if (place.abort.signal.aborted) {
          throw new AskFailure(place.stopped() === null ? "busy" : "connection_changed");
        }
        const book = await writes(ctx);
        // Two asks with one request cannot both get here: the second waits
        // for the first one's answer. This is for a record that changed on
        // the disk all the same.
        if (book.jobs.some((other) => other.request === asked.request)) throw new AskFailure("request_reused");
        book.jobs.unshift(record);
        await save(ctx, book);
        return now;
      });
      job = record;
    } catch (thrown) {
      if (opened) void endQuietly(ctx, stores, asked.store, opened.jobId);
      place.release();
      throw thrown;
    }

    const who: Detail = { writer: asked.writer, approver: asked.approvedBy.id, email: asked.approvedBy.email };
    // The job has its record and its place from here on, so nothing below may
    // keep it from running and from giving its place back. A line that the
    // audit trail's writer throws on is said in this host's log, as a line of
    // the job's end is.
    try {
      ctx.audit.record("connection.write", { ...lineOf(job), ...who, parts: written.length });
      // One line for each part: the table of the database that is written, as
      // the Store names it and as the connection's write settings list it,
      // and the Store's table that holds what is written there. For a write
      // and a rehearsal also that preview's version and checksum.
      for (const part of written) {
        ctx.audit.record("connection.write.part", {
          target: job.connection,
          job: job.id,
          schema: part.target.schema,
          table: part.target.name,
          preview: part.table,
          version: part.version,
          ...(part.checksum === undefined ? {} : { checksum: part.checksum }),
        });
      }
    } catch (thrown) {
      deps.report(ctx, "the start of a job that writes could not be recorded", thrown, { job: job.id });
    }
    // The ask is answered now. The job goes on by itself.
    void run(ctx, place, job, current, opened, stores, who);
    return { job: job.id, storeJob: job.storeJob };
  }

  /** Run one job to its end, write how it ended, and give its place back
   *  whatever happens. Never rejects. */
  async function run(
    ctx: ModuleContextV2,
    place: WritePlace,
    job: WriteJob,
    connection: Connection,
    target: StoreJobTarget,
    stores: StoresForWrites,
    who: Detail,
  ): Promise<void> {
    try {
      await runToItsEnd(ctx, place, job, connection, target, stores, who);
    } catch (thrown) {
      // Nothing in there is meant to throw. The record still calls the job
      // running, and a job that the record calls running with nothing behind
      // it reads as interrupted.
      deps.report(ctx, "how a job that writes ended could not be worked out", thrown, { job: job.id });
    } finally {
      place.release();
    }
  }

  async function runToItsEnd(
    ctx: ModuleContextV2,
    place: WritePlace,
    job: WriteJob,
    connection: Connection,
    target: StoreJobTarget,
    stores: StoresForWrites,
    who: Detail,
  ): Promise<void> {
    const ended: WriteJob = { ...job, ...(release === undefined ? {} : { release }) };
    // Whether a program may still be running for the job: one was handed to
    // the module host, and the host has not answered for that run.
    const program = { mayStillRun: false };
    try {
      const settings = connection.writes;
      if (!settings) throw new Error("a job that writes was started with no write login");
      const programs = deps.programs(ctx);
      // THE WRITE LOGIN: its user name here, and the name of its secret
      // below. The host reads the password and hands it to the program.
      const input = pushJob(job.id, { ...subjectOf(connection), user: settings.user }, target, deps.clock(), STORE_JOB_MAX_MS);
      // From the next line on a program may be running for the job.
      program.mayStillRun = true;
      const out = await runJob(
        programs,
        input,
        { reach: connection.reach, keyName: settings.keyName },
        place.abort,
        {
          deadlineMs: STORE_JOB_MAX_MS,
          ...silent,
          // A write that the program finished happened, whatever stopped the
          // job in that moment: its output is read.
          keepOutputWhenStopped: true,
          onHostAnswered: () => {
            program.mayStillRun = false;
          },
          onThrown: (thrown) => deps.report(ctx, "the host threw while it ran a job that writes", thrown, { job: job.id }),
        },
      );
      if (out.program !== undefined) ended.dbIo = out.program;
      if (out.ok && out.findings.kind === "push") {
        const { batches, inserted, updated, deleted, held } = out.findings;
        Object.assign(ended, { state: "done", batches, inserted, updated, deleted, held });
      } else {
        // The module's own reason for stopping the job comes before the word
        // the stopped run ended with.
        const word = place.stopped() ?? (out.ok ? "output_invalid" : out.code);
        const code = (WRITE_FAILURE_CODES as readonly string[]).includes(word) ? (word as WriteFailureCode) : "program_failed";
        Object.assign(ended, { state: "failed", code });
      }
      if (ended.code === "login") await deps.noteRefusedWriteLogin(ctx, connection);
    } catch (thrown) {
      deps.report(ctx, "a job that writes failed", thrown, { job: job.id });
      Object.assign(ended, { state: "failed", code: "internal" });
    }
    // The program is gone, or was never started: the Stores module is told to
    // end the store job (see the head of this file). It leaves a job whose
    // end the Store heard as it is, and fails any other, so that the Store
    // takes its next job. Not while a program may still run.
    if (!program.mayStillRun) await endQuietly(ctx, stores, job.store, job.storeJob);
    // How the Store's own job stands now, read after that. The two can
    // differ: a program that was stopped, or ended with no answer, may have
    // told the Store of a write before that, and the Store's `done` is then
    // the truth.
    const stood = await storeJobOf(ctx, stores, job);
    if (stood !== undefined) {
      ended.storeState = stood.state;
      if (stood.refusal !== undefined) ended.refusal = stood.refusal;
    }
    ended.finishedAt = deps.clock().toISOString();
    try {
      await deps.locked(ctx, async () => {
        const book = await writes(ctx);
        // The job that ended now is the newest of the ended ones, however
        // long ago it started: it goes to the front, so that it is not the
        // first to be dropped.
        book.jobs = [ended, ...book.jobs.filter((other) => other.id !== job.id)];
        await save(ctx, book);
      });
    } catch (thrown) {
      // The record still says "running". This process keeps how the job
      // ended, answers it, and writes it with the next write of the record.
      unwritten.set(jobKey(ctx, job.id), ended);
      deps.report(ctx, "how a job that writes ended could not be written", thrown, { job: job.id });
    }
    try {
      recordEnd(ctx, ended, who);
    } catch (thrown) {
      deps.report(ctx, "the end of a job that writes could not be recorded", thrown, { job: job.id });
    }
  }

  /**
   * How the Store's own job stands, and the Store's word for it when it has
   * failed: a word of its list, and `failed` for any other. Undefined when the
   * Store does not say. Never rejects.
   */
  async function storeJobOf(
    ctx: ModuleContextV2,
    stores: StoresForWrites,
    job: WriteJob,
  ): Promise<{ state: StoreJobState; refusal?: StoreJobWord } | undefined> {
    try {
      const answer: unknown = await withDeadline(
        stores.jobState(callerOf(ctx), job.store, job.storeJob),
        callMs,
        "the Stores module did not answer",
        { unref: true },
      );
      if (typeof answer !== "object" || answer === null) return undefined;
      const { state, word } = answer as { state?: unknown; word?: unknown };
      const known = STORE_JOB_STATES.find((one) => one === state);
      if (known === undefined) return undefined;
      if (known !== "failed") return { state: known };
      return { state: known, refusal: STORE_JOB_WORDS.find((one) => one === word) ?? "failed" };
    } catch (thrown) {
      deps.report(ctx, "a store job's state could not be read", thrown, { job: job.id });
      return undefined;
    }
  }

  return {
    async start(ctx, ask, args): Promise<{ job: string; storeJob: string }> {
      // 1. The arguments.
      const asked = readAsk(ask, args);
      const key = `${deps.organizationKey(ctx)} ${asked.request}`;
      const flying = inFlight.get(key);
      if (flying) {
        if (flying.asked !== asked.asked) throw new AskFailure("request_reused");
        return flying.answer;
      }
      const answer = begin(ctx, asked);
      inFlight.set(key, { asked: asked.asked, answer });
      try {
        return await answer;
      } finally {
        inFlight.delete(key);
      }
    },

    async read(ctx, id): Promise<unknown> {
      const found = (await writes(ctx)).jobs.find((job) => job.id === id);
      if (!found) return null;
      const job = asItIs(ctx, found);
      return {
        connection: job.connection,
        state: job.state,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        code: job.code,
        kind: job.kind,
        store: job.store,
        storeJob: job.storeJob,
        storeState: job.storeState,
        refusal: job.refusal,
        batches: job.batches,
        inserted: job.inserted,
        updated: job.updated,
        deleted: job.deleted,
        held: job.held,
        dbIo: job.dbIo,
        release: job.release,
      };
    },

    async closeLost(ctx): Promise<void> {
      const { lost } = await deps.locked(ctx, () => closed(ctx));
      for (const job of lost) recordEnd(ctx, job);
    },
  };
}
