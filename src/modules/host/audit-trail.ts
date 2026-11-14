// The audit trail, as the `host` module reads it for the control plane.
//
// ONE TRAIL, TWO PLACES. A record is written to the 0600 spool first and
// drained into `hx.admin_audit` by the console afterwards; the console removes
// a spool file about an hour after it has emptied it. So at any moment the
// trail is the table PLUS whatever is still on disk, and the two overlap.
//
// The overlap is resolved per spool file, by sequence number. A spool file is
// append-only and is only ever removed whole, so what is on disk for one file
// id is always a SUFFIX of that file's records: everything from some sequence
// number up. (Usually that number is 1. It is higher when the console removed
// a drained file and its writer then appended again under the same id.) So for
// each file id on disk, the records at or after its lowest sequence number are
// read from disk, and the table is asked only for the ones before it. Each
// record is counted exactly once, and no answer depends on how far the drain
// happens to have got.
//
// A database that cannot be asked is an error, never a shorter answer. An
// empty table is fine — a fortress whose console never ran has its whole trail
// on disk — but a table that could not be read may hold years this host would
// then be silently leaving out, and "no lines" is not something to say on the
// strength of a failed query.
//
// WHAT LEAVES. A line is seven fields: an id, a time, who (and what kind of
// actor), an action, what it was done to, and how it ended. "Who" and "what" are
// two names, and "From a record to a line" below lists every place either can
// come from. A record's other parameters, its error text and its session
// reference are not sent.
//
// WHAT IS A LINE. An act with its ending: the single record of an event, or
// the outcome record of a pair. An intent that nothing answered — the daemon
// stopped between the two — is not a line here. It stays on this host, where
// the console's own trail page shows it.
//
// WHOSE LINES. Every read and every count is of ONE organization's records.
// A record of the fortress's own organization carries no organization: that is
// every record of a fortress that holds one. A record of another organization
// carries its id as `organization`, on a single event and on both halves of a
// pair. So "the own organization's records" are the ones with no organization,
// and another organization's are the ones with its id, and the two never mix.
// A line itself never holds an organization's id.
//
// One kind of record is shown to every organization: the notice that this
// writer removed old records from the disk. It is about the trail itself, and
// an organization whose records may be among the removed ones has to be able to
// see that.
//
// THE DATABASE NEVER PARSES A ROW'S PARAMETERS. The table holds what any writer
// of the spool recorded, and that includes text a person typed into the
// console. Text that Postgres will not take as jsonb (a zero character, half of
// a two-part character) would make a statement that parses it fail, for every
// row in the same period and for good. So the two things the database has to
// read inside the parameters, whose a row is and how many refusals it stands
// for, are read with jsonb operators where the column holds an object and with
// a pattern where it holds the text of one, and never with a cast.

import { sql, type SQL } from "drizzle-orm";

import { AUDIT_ACTIONS } from "../../console/audit-actions";
import { listSpoolFiles, readSpoolFile } from "../../console/audit-spool";
import {
  ORGANIZATION_ID_PATTERN,
  ORGANIZATION_PARAM,
  organizationMark,
  organizationOfParams,
  type Organization,
} from "../../host/organization-id";
import { isName } from "../../host/shape";
import type { HxDb } from "../../host/postgres/db";
import type { ActorKind, LineKind, LineOutcome } from "./manifest";

export interface TrailLine {
  id: string;
  at: string;
  actorKind: ActorKind;
  actor: string;
  action: string;
  target: string;
  outcome: LineOutcome;
}

export interface TrailCounts {
  asksAllowed: number;
  asksRefused: number;
  releasesInstalled: number;
  signIns: number;
}

/** The trail could not be read in full. Carries a code the control plane may
 *  see. */
export class TrailUnavailable extends Error {
  constructor(readonly code: "database_unavailable" | "cursor_invalid" | "range_invalid") {
    super(code);
    this.name = "TrailUnavailable";
  }
}

export interface AuditTrailDeps {
  spoolDir: string;
  /** The daemon's handle onto `hx.admin_audit`, or null while Postgres is down. */
  db: () => HxDb | null;
}

/** One record, from either place, in the one shape the rest of this file reads. */
interface TrailRecord {
  fileId: string;
  seq: number;
  /** Milliseconds since the epoch. */
  at: number;
  origin: string;
  actor: string | null;
  action: string;
  /** The record's own parameters. For the outcome of a pair that is at most
   *  whose record it is; what the act was done to is on its intent. */
  params: Record<string, unknown>;
  /** For the outcome of a pair: its intent's parameters, once they are known.
   *  Null until then, and for a single event. */
  intent: Record<string, unknown> | null;
  kind: string;
  /** For the outcome of a pair: where its intent is. Null for a single event. */
  refFileId: string | null;
  refSeq: number | null;
  outcome: string | null;
  error: string | null;
}

// ── What kind of line a record is ────────────────────────────────────────────

/** The action prefixes that make up each kind. One list, read by the filter in
 *  this process and by the same filter in SQL, so the two cannot disagree. */
const KIND_PREFIXES: Record<Exclude<LineKind, "other">, readonly string[]> = {
  ask: [AUDIT_ACTIONS.controlPlaneAsk],
  release: ["control_plane.release.", "system.release.", "cli.release.", "console.release."],
  module: ["control_plane.module.", "system.module.", "cli.module.", "console.module.", AUDIT_ACTIONS.modulePrefix],
  sign_in: ["console.signin", "console.signout", "console.sso.", "console.setup."],
  command: ["console.command.", "console.service."],
};
const ALL_KIND_PREFIXES = Object.values(KIND_PREFIXES).flat();

export function lineKind(action: string): LineKind {
  for (const [kind, prefixes] of Object.entries(KIND_PREFIXES)) {
    if (prefixes.some((prefix) => action.startsWith(prefix))) return kind as LineKind;
  }
  return "other";
}

function kindPredicate(kind: LineKind): SQL {
  const any = (prefixes: readonly string[]): SQL =>
    sql.join(
      prefixes.map((prefix) => sql`starts_with(a.action, ${prefix})`),
      sql` OR `,
    );
  return kind === "other"
    ? sql`NOT (${any(ALL_KIND_PREFIXES)})`
    : // The lookup is on a closed union, never on a caller's string.
      // eslint-disable-next-line security/detect-object-injection
      sql`(${any(KIND_PREFIXES[kind])})`;
}

// ── From a record to a line ──────────────────────────────────────────────────
//
// A line names WHO and WHAT with two names, `actor` and `target`. This section
// is the complete list of where those two can come from. Nothing else of a
// record leaves this host: not its other parameters, not its error text, not
// its session reference.
//
//   actor   "control plane", "fortress" or "terminal operator" (fixed words);
//           the console login of the person who acted; for a release
//           decision, who decided; for a job's own record, its `job` detail
//   target  an ask:            <module>:<ask>, both from this build's own lists
//           a release:         <module>@<version>, or the release's id
//           a module's record: its `target` detail
//           a module's switch: the module's id
//           a sign-in, a sign-out, a setup link: the console login
//           a terminal act on a console account: that account's login
//           a console command: the kind of command
//           a service action:  the action
//           an export:         which export
//           a system event:    its `engine`
//
// TWO RULES hold for every one of them.
//
// A value is sent only if it already IS a name: at most 128 characters of the
// name alphabet. A value that is not one is never rewritten into one. It is
// replaced whole by a fixed word. Rewriting would let any text in a record
// leave this host with its punctuation changed.
//
// A sign-in that FAILED names nobody. Its record holds a login, and that login
// is whatever was typed into the form by somebody who did not sign in: a
// mistyped name, or a password typed into the wrong field. The line says that
// a sign-in failed, when, and how many times, and that is all it says.

/** `value` if it is a name as it stands, else `fallback`. */
function nameOr(value: unknown, fallback: string): string {
  return isName(value) && value.length > 0 ? value : fallback;
}

/** `failed` or `refused` as one of an action's parts. Not only the last part:
 *  a sign-in the identity provider's answer did not allow is recorded as
 *  `console.signin.failed.oidc.<why>`. */
const REFUSED_ACTION = /\.(?:failed|refused)(?:\.|$)/;

/** A sign-in, a setup or an exchange that did not succeed. */
function failedSignIn(action: string): boolean {
  return lineKind(action) === "sign_in" && REFUSED_ACTION.test(action);
}

function actorKindOf(record: TrailRecord): ActorKind {
  const { action } = record;
  if (action.startsWith("control_plane.")) return "control_plane";
  if (action.startsWith(AUDIT_ACTIONS.modulePrefix)) {
    // `module.<id>.job.<…>` is a data job recording its own work.
    return /^module\.[a-z][a-z0-9_]*\.job\./.test(action) ? "job" : "fortress";
  }
  if (record.origin === "console" || record.origin === "cli") return "person";
  // Written by the daemon, about a decision a person made.
  if (action === AUDIT_ACTIONS.releaseApproved || action === AUDIT_ACTIONS.releaseRefused) {
    return "person";
  }
  return "fortress";
}

function actorOf(record: TrailRecord, kind: ActorKind): string {
  if (kind === "control_plane") return "control plane";
  if (kind === "fortress") return "fortress";
  if (kind === "job") return nameOr(record.params.job, "job");
  if (record.origin === "cli" || record.actor?.includes("(terminal)")) return "terminal operator";
  if (failedSignIn(record.action)) return "unknown";
  return nameOr(record.actor, "unknown");
}

function targetOf(record: TrailRecord): string {
  const { action, params } = record;
  const kind = lineKind(action);
  if (action === AUDIT_ACTIONS.controlPlaneAsk) {
    return nameOr(`${nameOr(params.module, "unknown")}:${nameOr(params.ask, "unknown")}`, "ask");
  }
  if (kind === "release") {
    const moduleId = nameOr(params.module, "");
    const version = nameOr(params.version, "");
    if (moduleId && version) return nameOr(`${moduleId}@${version}`, "release");
    return nameOr(params.release, moduleId || "release");
  }
  if (action.startsWith(AUDIT_ACTIONS.modulePrefix)) {
    const own = /^module\.([a-z][a-z0-9_]*)\./.exec(action)?.[1] ?? "module";
    return nameOr(params.target, own);
  }
  if (kind === "module") return nameOr(params.module, "module");
  if (kind === "sign_in") return failedSignIn(action) ? "console" : nameOr(params.login, "console");
  if (action.startsWith("console.command.")) return nameOr(params.commandKind, "command");
  if (action.startsWith("console.service.")) return nameOr(params.action, "service");
  if (action.startsWith(AUDIT_ACTIONS.exportPrefix)) {
    return nameOr(action.slice(AUDIT_ACTIONS.exportPrefix.length), "export");
  }
  if (action.startsWith(AUDIT_ACTIONS.cliPrefix)) return nameOr(params.login, "console");
  if (action.startsWith("system.")) return nameOr(params.engine, "fortress");
  return "fortress";
}

function outcomeOf(record: TrailRecord): LineOutcome {
  const outcome = (record.outcome ?? "").toLowerCase();
  if (outcome === "refused" || outcome === "rejected" || REFUSED_ACTION.test(record.action)) {
    return "refused";
  }
  if (outcome === "failed" || (record.error !== null && record.error !== "")) return "failed";
  return "ok";
}

function lineId(record: TrailRecord): string {
  return `${record.at}-${record.fileId}-${record.seq}`;
}

function lineOf(found: TrailRecord): TrailLine {
  // From here on the record's parameters are its intent's and its own together.
  const record: TrailRecord = { ...found, params: lineParams(found) };
  const actorKind = actorKindOf(record);
  return {
    id: lineId(record),
    at: new Date(record.at).toISOString(),
    actorKind,
    actor: actorOf(record, actorKind),
    action: nameOr(record.action, "unknown"),
    target: targetOf(record),
    outcome: outcomeOf(record),
  };
}

// ── Reading both places ──────────────────────────────────────────────────────

interface Position {
  at: number;
  fileId: string;
  seq: number;
}

const CURSOR = /^(\d{1,15})-([0-9a-f]{8,64})-(\d{1,12})$/;

function parseCursor(id: string): Position {
  const match = CURSOR.exec(id);
  if (!match) throw new TrailUnavailable("cursor_invalid");
  return { at: Number(match[1]), fileId: match[2] as string, seq: Number(match[3]) };
}

/** Newest first; ties broken the same way the SQL below breaks them. */
function newestFirst(a: Position, b: Position): number {
  if (a.at !== b.at) return b.at - a.at;
  if (a.fileId !== b.fileId) return a.fileId < b.fileId ? 1 : -1;
  return b.seq - a.seq;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const wrapped = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(wrapped) ? (wrapped as Record<string, unknown>[]) : [];
}

function millis(value: unknown): number | null {
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * A record's parameters, from whatever the driver hands back for the column.
 *
 * The drain writes the column as JSON TEXT inside a jsonb string, so a row read
 * back is a string that parses to the object — and, depending on whether the
 * driver has already parsed the jsonb once, sometimes a string that parses to
 * that string. A row written as a jsonb object comes back as the object. All
 * three are the same parameters.
 */
function paramsOf(value: unknown): Record<string, unknown> {
  let params = value;
  for (let pass = 0; pass < 2 && typeof params === "string"; pass += 1) {
    try {
      params = JSON.parse(params);
    } catch {
      return {};
    }
  }
  return isRecord(params) ? params : {};
}

/** A record from either place. Null for one this file cannot place in time or
 *  in its file, which nothing below could order or count. */
function normalize(raw: Record<string, unknown>): TrailRecord | null {
  const at = millis(raw.ts);
  const seq = Number(raw.seq);
  if (at === null || typeof raw.fileId !== "string" || !Number.isSafeInteger(seq)) return null;
  const refSeq = raw.refSeq === null || raw.refSeq === undefined ? null : Number(raw.refSeq);
  return {
    fileId: raw.fileId,
    seq,
    at,
    origin: typeof raw.origin === "string" ? raw.origin : "",
    actor: typeof raw.actor === "string" ? raw.actor : null,
    action: typeof raw.action === "string" ? raw.action : "",
    params: paramsOf(raw.params),
    // A row from the table arrives with its intent joined on. A record from
    // disk does not, and `withIntent` finds it.
    intent: raw.intentFound === true ? paramsOf(raw.intentParams) : null,
    kind: typeof raw.kind === "string" ? raw.kind : "",
    refFileId: typeof raw.refFileId === "string" ? raw.refFileId : null,
    refSeq: refSeq !== null && Number.isSafeInteger(refSeq) ? refSeq : null,
    outcome: typeof raw.outcome === "string" ? raw.outcome : null,
    error: typeof raw.error === "string" ? raw.error : null,
  };
}

/** The time a spool file was opened, from its name; null for a name this build
 *  did not write. Records in a file are never earlier than this. */
function startedAt(name: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(name);
  if (!m) return null;
  const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  return Number.isFinite(ms) ? ms : null;
}

// What the act of a pair was done TO is on its intent. Its outcome carries at
// most whose record it is. So a line's parameters are its intent's with its own
// on top — the join below for a row in the table, `withIntent` for a record on
// disk, and `lineParams` to put the two together.
//
// The time is projected as text in one fixed form. A driver is free to hand a
// timestamp back as a Date or in the server's own notation; this reads the same
// under all of them.
const PROJECTION = sql`
  a.spool_file_id AS "fileId", a.seq AS "seq",
  to_char(a.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "ts",
  a.origin AS "origin", a.actor AS "actor", a.action AS "action",
  a.params AS "params", i.params AS "intentParams", (i.seq IS NOT NULL) AS "intentFound",
  a.kind AS "kind",
  a.ref_file_id AS "refFileId", a.ref_seq AS "refSeq",
  a.outcome AS "outcome", a.error AS "error"`;

// A row the drain wrote holds a jsonb STRING whose text is the JSON object, as
// JSON.stringify wrote it: no spaces, and every quote inside a value escaped.
// A row may also hold the object itself. Both are read below.

/** The parameters as text, for a row that holds them as a string. */
const PARAMS_TEXT = sql`(a.params #>> '{}')`;

/** An organization's id, as the pattern that anchors it and as its body. */
const ID_PATTERN = ORGANIZATION_ID_PATTERN.source;
const ID_BODY = ID_PATTERN.replace(/^\^/, "").replace(/\$$/, "");
/**
 * `"organization":"<id>"` as a key of the object, in its text.
 *
 * A key's opening quote follows `{` or `,`. Inside a value every quote is
 * written `\"`, so a value cannot hold this text: a value that tries to holds
 * `,\"organization\"` and does not match.
 */
const MARK_IN_TEXT = `[{,]"${ORGANIZATION_PARAM}":"(${ID_BODY})"`;
/** `"attempts":<digits>` as a key of the object, in its text. Sixteen digits
 *  hold the largest whole number this file counts exactly. */
const ATTEMPTS_IN_TEXT = '[{,]"attempts":([0-9]{1,16})[,}]';
/** The largest whole number JavaScript counts exactly (`Number.MAX_SAFE_INTEGER`).
 *  The reader of the files on disk counts a larger `attempts` as one. */
const LARGEST_COUNT = "9007199254740991";

/**
 * Whose a row is, in SQL: another organization's id, or NULL for the
 * fortress's own. The same rule as `organizationOfParams`: only an id counts,
 * and anything else under the name is no mark.
 */
const MARK = sql`(CASE jsonb_typeof(a.params)
    WHEN 'object' THEN
      CASE WHEN jsonb_typeof(a.params -> ${ORGANIZATION_PARAM}) = 'string'
            AND (a.params ->> ${ORGANIZATION_PARAM}) ~ ${ID_PATTERN}
           THEN a.params ->> ${ORGANIZATION_PARAM} END
    WHEN 'string' THEN substring(${PARAMS_TEXT} from ${MARK_IN_TEXT})
  END)`;

/** `attempts` as the text of a row holds it, in SQL. NULL when it holds none. */
const ATTEMPTS_IN_ROW_TEXT = sql`substring(${PARAMS_TEXT} from ${ATTEMPTS_IN_TEXT})::numeric`;

/**
 * How many refusals a row stands for, in SQL. One, unless it says more.
 *
 * For a row as the drain writes it (the text of the object), the same rule as
 * the reader of the files on disk: `attempts` counts only when it is a whole
 * number from 1 up to the largest one JavaScript counts exactly. Anything else
 * stands for one refusal.
 */
const ATTEMPTS = sql`(CASE jsonb_typeof(a.params)
    WHEN 'object' THEN
      CASE WHEN jsonb_typeof(a.params -> 'attempts') = 'number'
           THEN greatest(trunc((a.params ->> 'attempts')::numeric), 1) ELSE 1 END
    WHEN 'string' THEN
      CASE WHEN ${ATTEMPTS_IN_ROW_TEXT} BETWEEN 1 AND ${sql.raw(LARGEST_COUNT)}
           THEN ${ATTEMPTS_IN_ROW_TEXT} ELSE 1 END
    ELSE 1
  END)`;

/** The notice that this fortress's module records were removed from its disk.
 *  It is about the trail, so every organization is shown it. */
function isReclaimNotice(record: { action: string; origin: string }): boolean {
  return record.action === AUDIT_ACTIONS.spoolReclaimed && record.origin === "system";
}

/**
 * Whether a record is one of an organization's.
 *
 * `mark` is the organization's mark: its id, or null for the fortress's own.
 * Read from the record's OWN parameters, never from its intent's: both halves
 * of a pair carry it, so a record says whose it is even when the file that held
 * its intent is gone.
 */
function isOf(record: TrailRecord, mark: string | null): boolean {
  return organizationOfParams(record.params) === mark || (mark !== null && isReclaimNotice(record));
}

/** The same question in SQL. */
function ofPredicate(mark: string | null): SQL {
  return mark === null
    ? sql`${MARK} IS NULL`
    : sql`(${MARK} = ${mark} OR (a.action = ${AUDIT_ACTIONS.spoolReclaimed} AND a.origin = 'system'))`;
}

/** What a line is made from: the intent's parameters with the record's own on
 *  top. */
function lineParams(record: TrailRecord): Record<string, unknown> {
  return record.intent ? { ...record.intent, ...record.params } : record.params;
}

const INTENT_JOIN = sql`
  LEFT JOIN hx.admin_audit i
    ON a.ref_seq IS NOT NULL
   AND i.kind = 'intent'
   AND i.spool_file_id = coalesce(a.ref_file_id, a.spool_file_id)
   AND i.seq = a.ref_seq`;

/** What the disk already answers for: per file id, its lowest sequence number
 *  on disk. Joined against the table so those records are not read twice. */
function onDiskJoin(lowest: ReadonlyMap<string, number>): { join: SQL; where: SQL } {
  if (lowest.size === 0) return { join: sql``, where: sql`true` };
  const rows = sql.join(
    [...lowest].map(([fileId, seq]) => sql`(${fileId}::text, ${seq}::bigint)`),
    sql`, `,
  );
  return {
    join: sql`LEFT JOIN (VALUES ${rows}) AS d(file_id, lowest_seq) ON d.file_id = a.spool_file_id`,
    where: sql`(d.file_id IS NULL OR a.seq < d.lowest_seq)`,
  };
}

const intentKey = (fileId: string, seq: number): string => `${fileId}:${seq}`;

export class AuditTrail {
  /** One read of the spool at a time. A read holds a file's records in memory
   *  while it looks at them, and sixteen asks doing that together would hold
   *  sixteen times as much. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: AuditTrailDeps) {}

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Show `visit` every record on disk that could be at or before `upTo`, one
   * file at a time, and return each file id's lowest sequence number on disk.
   *
   * Nothing is kept here: a file is read, its records are shown, and it is let
   * go before the next one is opened. A file opened after `upTo` holds only
   * later records and is not read.
   */
  private async scanDisk(
    upTo: number,
    visit: (record: TrailRecord) => void,
    only?: ReadonlySet<string>,
  ): Promise<Map<string, number>> {
    const lowest = new Map<string, number>();
    for (const file of await listSpoolFiles(this.deps.spoolDir)) {
      const started = startedAt(file.name);
      if (started !== null && started > upTo) continue;
      if (only && (file.fileId === null || !only.has(file.fileId))) continue;
      for (const raw of await readSpoolFile(file.path)) {
        const record = normalize(raw as unknown as Record<string, unknown>);
        if (!record) continue;
        const seen = lowest.get(record.fileId);
        if (seen === undefined || record.seq < seen) lowest.set(record.fileId, record.seq);
        visit(record);
      }
    }
    return lowest;
  }

  private async query(statement: SQL): Promise<Record<string, unknown>[]> {
    const db = this.deps.db();
    if (!db) throw new TrailUnavailable("database_unavailable");
    try {
      return rowsOf(await db.execute(statement));
    } catch {
      throw new TrailUnavailable("database_unavailable");
    }
  }

  /**
   * One page of one organization's lines, newest first.
   *
   * Whose lines is not optional: a reader that left it out would be answered
   * with the own organization's, whoever asked.
   */
  read(
    range: {
      from: string;
      to: string;
      kind?: LineKind;
      before?: string;
      limit: number;
    },
    organization: Organization,
  ): Promise<{ lines: TrailLine[]; next?: string }> {
    const mark = organizationMark(organization);
    const from = Date.parse(range.from);
    const to = Date.parse(range.to);
    if (!(from <= to)) return Promise.reject(new TrailUnavailable("range_invalid"));
    let before: Position | null;
    try {
      before = range.before === undefined ? null : parseCursor(range.before);
    } catch (error) {
      return Promise.reject(error);
    }
    if (range.limit <= 0) return Promise.resolve({ lines: [] });
    const keep = range.limit + 1;

    return this.exclusive(async () => {
      // Disk FIRST. A file drained and removed between the two reads is then
      // still in hand; read the other way round it would be in neither.
      let newest: TrailRecord[] = [];
      const lowest = await this.scanDisk(to, (record) => {
        if (
          record.kind !== "outcome" ||
          record.at < from ||
          record.at > to ||
          !isOf(record, mark) ||
          (range.kind !== undefined && lineKind(record.action) !== range.kind) ||
          (before !== null && newestFirst(before, record) >= 0)
        ) {
          return;
        }
        newest.push(record);
        // Only the newest `keep` can be on this page. Trimmed as it grows, so
        // what is held never depends on how much the spool holds.
        if (newest.length >= keep * 4) newest = newest.sort(newestFirst).slice(0, keep);
      });

      const disk = onDiskJoin(lowest);
      const filters: SQL[] = [
        sql`a.kind = 'outcome'`,
        sql`a.ts >= ${range.from}::timestamptz`,
        sql`a.ts <= ${range.to}::timestamptz`,
        ofPredicate(mark),
        disk.where,
      ];
      if (range.kind !== undefined) filters.push(kindPredicate(range.kind));
      if (before !== null) {
        filters.push(
          sql`(a.ts, a.spool_file_id COLLATE "C", a.seq) < (${new Date(before.at).toISOString()}::timestamptz, ${before.fileId}::text COLLATE "C", ${before.seq}::bigint)`,
        );
      }
      const rows = await this.query(
        sql`SELECT ${PROJECTION}
              FROM hx.admin_audit a ${INTENT_JOIN} ${disk.join}
             WHERE ${sql.join(filters, sql` AND `)}
             ORDER BY a.ts DESC, a.spool_file_id COLLATE "C" DESC, a.seq DESC
             LIMIT ${keep}`,
      );

      const merged = [
        ...newest,
        ...rows.map(normalize).filter((record): record is TrailRecord => record !== null),
      ].sort(newestFirst);
      const page = await this.withIntent(merged.slice(0, range.limit), to);
      const last = page[page.length - 1];
      return merged.length > range.limit && last
        ? { lines: page.map(lineOf), next: lineId(last) }
        : { lines: page.map(lineOf) };
    });
  }

  /**
   * Give each outcome on the page its intent's parameters.
   *
   * A row from the table already has them, from the join. A record from disk
   * finds its intent in the same file or, when a rotation fell between the two,
   * in the one before — so only the files the page names are read again. An
   * intent whose file has since been drained and removed is fetched from the
   * table, in one statement.
   */
  private async withIntent(page: readonly TrailRecord[], upTo: number): Promise<TrailRecord[]> {
    const needs = (record: TrailRecord): boolean => record.refSeq !== null && record.intent === null;
    const keyOf = (record: TrailRecord): string =>
      intentKey(record.refFileId ?? record.fileId, record.refSeq as number);
    const wanted = new Set(page.filter(needs).map(keyOf));
    if (wanted.size === 0) return [...page];

    const found = new Map<string, Record<string, unknown>>();
    const files = new Set(page.filter(needs).map((record) => record.refFileId ?? record.fileId));
    await this.scanDisk(
      upTo,
      (record) => {
        if (record.kind !== "intent") return;
        const key = intentKey(record.fileId, record.seq);
        if (wanted.has(key)) found.set(key, record.params);
      },
      files,
    );

    const missing = page.filter((record) => needs(record) && !found.has(keyOf(record)));
    if (missing.length > 0) {
      const pairs = sql.join(
        missing.map(
          (record) => sql`(${record.refFileId ?? record.fileId}::text, ${record.refSeq}::bigint)`,
        ),
        sql`, `,
      );
      const rows = await this.query(
        sql`SELECT a.spool_file_id AS "fileId", a.seq AS "seq", a.params AS "params"
              FROM hx.admin_audit a
             WHERE a.kind = 'intent' AND (a.spool_file_id, a.seq) IN (${pairs})`,
      );
      for (const row of rows) {
        if (typeof row.fileId === "string") {
          found.set(intentKey(row.fileId, Number(row.seq)), paramsOf(row.params));
        }
      }
    }
    return page.map((record) =>
      needs(record) ? { ...record, intent: found.get(keyOf(record)) ?? null } : record,
    );
  }

  /**
   * How many asks, installs and sign-ins the period holds, for one
   * organization.
   *
   * `asksAllowed` counts the asks that passed the gate and reached a module,
   * however the module then answered. `asksRefused` counts the ones the gate
   * turned away, and a reply the gate refused to send.
   */
  count(range: { from: string; to: string }, organization: Organization): Promise<TrailCounts> {
    const mark = organizationMark(organization);
    const from = Date.parse(range.from);
    const to = Date.parse(range.to);
    if (!(from <= to)) return Promise.reject(new TrailUnavailable("range_invalid"));

    return this.exclusive(async () => {
      const counts: TrailCounts = { asksAllowed: 0, asksRefused: 0, releasesInstalled: 0, signIns: 0 };
      const add = (action: string, outcome: string | null, lines: number, weight: number): void => {
        if (action === AUDIT_ACTIONS.controlPlaneAsk) {
          // A collapsed run of refusals is one record that stands for `attempts`.
          if (outcome === "refused") counts.asksRefused += weight;
          else counts.asksAllowed += lines;
        } else if (action === AUDIT_ACTIONS.releaseInstall) {
          if (outcome === "installed") counts.releasesInstalled += lines;
        } else if (action === AUDIT_ACTIONS.signIn) {
          counts.signIns += lines;
        }
      };

      const lowest = await this.scanDisk(to, (record) => {
        if (record.kind !== "outcome" || record.at < from || record.at > to || !isOf(record, mark)) {
          return;
        }
        const attempts = record.params.attempts;
        add(
          record.action,
          record.outcome,
          1,
          typeof attempts === "number" && Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 1,
        );
      });

      const disk = onDiskJoin(lowest);
      const counted = [AUDIT_ACTIONS.controlPlaneAsk, AUDIT_ACTIONS.releaseInstall, AUDIT_ACTIONS.signIn];
      const rows = await this.query(
        sql`SELECT a.action AS "action", a.outcome AS "outcome", count(*)::bigint AS "lines",
                   sum(${ATTEMPTS})::bigint AS "weight"
              FROM hx.admin_audit a ${disk.join}
             WHERE a.kind = 'outcome'
               AND a.ts >= ${range.from}::timestamptz AND a.ts <= ${range.to}::timestamptz
               AND a.action IN (${sql.join(
                 counted.map((action) => sql`${action}`),
                 sql`, `,
               )})
               AND ${ofPredicate(mark)}
               AND ${disk.where}
             GROUP BY a.action, a.outcome`,
      );
      for (const row of rows) {
        add(
          String(row.action),
          typeof row.outcome === "string" ? row.outcome : null,
          Number(row.lines) || 0,
          Number(row.weight) || 0,
        );
      }
      return counts;
    });
  }
}
