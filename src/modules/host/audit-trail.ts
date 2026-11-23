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
// empty table is fine — an HX Fortress whose console never ran has its whole trail
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
// A record of HX Fortress's own organization carries no organization: that is
// every record of an HX Fortress that holds one. A record of another organization
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
  ASK_NAME_MAX_CHARS,
  ASK_NAME_PATTERN,
  MODULE_ID_MAX_CHARS,
  isAskName,
  isModuleId,
} from "../../host/module-contract";
import { MODULE_ID_PATTERN } from "../../host/module-id";
import {
  ORGANIZATION_ID_PATTERN,
  ORGANIZATION_PARAM,
  organizationMark,
  organizationOfParams,
  type Organization,
} from "../../host/organization-id";
import { isName } from "../../host/shape";
import type { HxDb } from "../../host/postgres/db";
import {
  AUDIT_COUNT_MAX_ASKS,
  UNKNOWN_ASK,
  type ActorKind,
  type LineKind,
  type LineOutcome,
} from "./manifest";

export interface TrailLine {
  id: string;
  at: string;
  actorKind: ActorKind;
  actor: string;
  action: string;
  target: string;
  outcome: LineOutcome;
}

/** How often one ask was allowed and refused in a period. */
export interface AskCount {
  /** The module's id, or `unknown`. */
  module: string;
  /** The ask's name, or `unknown`. */
  ask: string;
  allowed: number;
  refused: number;
}

export interface TrailCounts {
  /** The sum of every `allowed` in `asks`. */
  asksAllowed: number;
  /** The sum of every `refused` in `asks`. */
  asksRefused: number;
  releasesInstalled: number;
  signIns: number;
  /** The two counts of asks, for each ask that was allowed or refused at least
   *  once, in the order of the module's id and then of the ask's name. */
  asks: AskCount[];
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
  /** How many open intents of the disk one count hands to the database
   *  (`OPEN_INTENTS_MAX`). A seam for tests. */
  openIntentsMax?: number;
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
//           decision, who decided; for a job's own record, its `job` detail;
//           for any other record of a module's own that it wrote while it
//           carried out a person's act, that person's console login. The
//           host writes that login on the record. A module cannot
//   target  an ask:            <module>:<ask>, both from this build's own lists
//           a release:         <module>@<version>, or the release's id
//           a module's record: its `target` detail
//           a module's switch: the module's id
//           a person's act:    <module>:<act>, both from this build's own lists
//           a host or a secret's name a person added to a module, or
//           removed: the module's id. The name, the host and the port are
//           not in a line
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
    if (/^module\.[a-z][a-z0-9_]*\.job\./.test(action)) return "job";
    // What a module recorded while it carried out a person's act: the record
    // names that person, and only the host can put a name there (the context
    // of an act, module-context.ts). A module's record with no actor is the
    // module's own work, for an ask or for nobody.
    return typeof record.actor === "string" && record.actor.length > 0 ? "person" : "fortress";
  }
  if (record.origin === "console" || record.origin === "cli") return "person";
  // What a person at the console had a module do. The daemon writes it,
  // because the module is in the daemon, under the login the console gave.
  if (action.startsWith("console.module.")) return "person";
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
  // A person's act: the module and the act. The act gate writes each by name
  // only once this build's own lists know it.
  if (action === AUDIT_ACTIONS.consoleModuleAct || action === AUDIT_ACTIONS.consoleModuleActEndedLate) {
    return nameOr(`${nameOr(params.module, "unknown")}:${nameOr(params.act, "unknown")}`, "act");
  }
  // A call the connection refused: what it was a call of.
  if (action === AUDIT_ACTIONS.controlPlaneSessionCall) return nameOr(params.method, "unknown");
  if (action === AUDIT_ACTIONS.controlPlaneToolCall) return "tools";
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
 * HX Fortress's own. The same rule as `organizationOfParams`: only an id counts,
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
/** `attempts` as a row that holds the object holds it, in SQL. Read only where
 *  the value is a number, which Postgres always takes as one. */
const ATTEMPTS_IN_ROW_OBJECT = sql`(a.params ->> 'attempts')::numeric`;

/**
 * How many refusals a row stands for, in SQL. One, unless it says more.
 *
 * The same rule as the reader of the files on disk, however the column holds
 * the parameters: `attempts` counts only when it is a whole number from 1 up
 * to the largest one JavaScript counts exactly. Anything else stands for one
 * refusal: a fraction, a number past that, a text.
 *
 * Most rows hold no `attempts`. The text of one is asked for the key first,
 * which is one search, and the pattern is run only where the key is.
 */
const ATTEMPTS = sql`(CASE jsonb_typeof(a.params)
    WHEN 'object' THEN
      CASE WHEN jsonb_typeof(a.params -> 'attempts') = 'number' THEN
        CASE WHEN ${ATTEMPTS_IN_ROW_OBJECT} BETWEEN 1 AND ${sql.raw(LARGEST_COUNT)}
              AND ${ATTEMPTS_IN_ROW_OBJECT} = trunc(${ATTEMPTS_IN_ROW_OBJECT})
             THEN ${ATTEMPTS_IN_ROW_OBJECT} ELSE 1 END
      ELSE 1 END
    WHEN 'string' THEN
      CASE WHEN strpos(${PARAMS_TEXT}, '"attempts":') = 0 THEN 1
           WHEN ${ATTEMPTS_IN_ROW_TEXT} BETWEEN 1 AND ${sql.raw(LARGEST_COUNT)}
           THEN ${ATTEMPTS_IN_ROW_TEXT} ELSE 1 END
    ELSE 1
  END)`;

// ── Which ask a record is of ─────────────────────────────────────────────────
//
// The gate writes the module and the ask into a record by name only once this
// build knows them, and the word `unknown` before that. A pair has them on its
// intent. A refusal is a single record and has them itself. Read here, a value
// counts only when it has the form of a module's id or of an ask's name: any
// other value is counted under `unknown`, and is never rewritten into a name.
//
// ONE READER FOR EACH PLACE. A record from the disk was parsed, and `askOf`
// reads its parameters. A row of the table is read in SQL, by `rawNameIn`, and
// EVERY row of the table is read that way: the rows a statement counts, and
// the intents fetched for outcomes that are still on the disk. So which ask a
// row names never depends on where the other half of its pair is. For
// parameters as a writer of this build makes them, the two readers give one
// answer, and the table's test holds them to it.
//
// THE STATEMENT GROUPS FIRST AND ASKS FOR THE FORM AFTERWARDS. It takes the
// text under each of the two names as it stands, counts the rows of each pair
// of texts, and only then holds each pair to the form of a name. Asked of
// every row instead, the form cost two pattern matches for each name and row,
// and a count of 100,000 asks took most of a second.

/** A pattern's source without its two anchors. */
function bodyOf(pattern: RegExp): string {
  return pattern.source.replace(/^\^/, "").replace(/\$$/, "");
}

/** Which ask a record's parameters name. Also asked of what the database
 *  answered: a value that is no name would make the whole answer fail its
 *  shape. */
function askOf(params: Record<string, unknown>): { module: string; ask: string } {
  return {
    module: isModuleId(params.module) ? params.module : UNKNOWN_ASK,
    ask: isAskName(params.ask) ? params.ask : UNKNOWN_ASK,
  };
}

/** One character more than the longest name. A text cut to this many is still
 *  too long to be a name, and a group's key stays small whatever a row holds. */
const RAW_NAME_CHARS = Math.max(MODULE_ID_MAX_CHARS, ASK_NAME_MAX_CHARS) + 1;

/**
 * The text under `key` in a row's parameters, in SQL, as it stands: NULL, or
 * any text of at most `RAW_NAME_CHARS` characters. Whether it is a name is
 * asked afterwards, by `nameOrUnknown` and by `askOf`.
 *
 * `params` is the column, which holds an object or the text of one. Read with
 * jsonb operators where it holds an object. Where it holds the text, the text
 * is what JSON.stringify made: no spaces, and every quote inside a value
 * written with a backslash in front. So the key is either the first one, right
 * after the opening brace, or it follows a comma, and its value ends at the
 * next quote. A text inside a value cannot be taken for the key, because every
 * quote in it follows a backslash. A value that holds a quote is cut short at
 * it and ends in a backslash, which no name does. A key of an object inside
 * the object can be taken for it. No record of an ask holds one: the gate
 * writes `module`, `ask` and `grant` or `rule`, each a text or a number.
 *
 * Never with a cast: see the top of this file. And with no pattern, so that a
 * count of many rows asks each of them only for two searches.
 */
function rawNameIn(params: SQL, key: string): SQL {
  const first = `{"${key}":"`;
  const later = `,"${key}":"`;
  const text = sql`(${params} #>> '{}')`;
  return sql`left(CASE jsonb_typeof(${params})
      WHEN 'object' THEN
        CASE WHEN jsonb_typeof(${params} -> ${key}) = 'string' THEN ${params} ->> ${key} END
      WHEN 'string' THEN
        CASE WHEN starts_with(${text}, ${first})
             THEN split_part(substr(${text}, ${sql.raw(String(first.length + 1))}), '"', 1)
             ELSE split_part(split_part(${text}, ${later}, 2), '"', 1) END
    END, ${sql.raw(String(RAW_NAME_CHARS))})`;
}

/** A text held to the form of a name, in SQL: the text when it has the form
 *  `body` and at most `max` characters, and the word `unknown` otherwise. */
function nameOrUnknown(raw: SQL, body: string, max: number): SQL {
  return sql`(CASE WHEN ${raw} ~ ${`^(?:${body})$`} AND char_length(${raw}) <= ${sql.raw(String(max))}
               THEN ${raw} ELSE ${UNKNOWN_ASK} END)`;
}

/** The parameters that name a row's ask: its intent's for the outcome of a
 *  pair, and its own for a single record. */
const NAMING_PARAMS = sql`(CASE WHEN a.ref_seq IS NOT NULL THEN i.params ELSE a.params END)`;

/** An ask that was asked and whose outcome the disk does not hold. */
interface OpenIntent {
  fileId: string;
  seq: number;
  module: string;
  ask: string;
}

/**
 * Most open intents of the disk that one count hands to the database.
 *
 * An intent is open when the disk holds it and not its outcome. That is an ask
 * that is running now, or one whose daemon stopped before it answered, or one
 * whose outcome went into a later file that the console has drained and
 * removed while the intent's own file is still here. Only the last kind has an
 * outcome in the table, and then the table may not hold the intent. So the
 * statement is handed these intents, and names such an outcome from them.
 *
 * There are as many as asks run at once, and a handful for each time the
 * daemon stopped hard. Past this many, the oldest are handed over, and an
 * outcome of one that was not is counted under `unknown`.
 */
const OPEN_INTENTS_MAX = 1000;

/**
 * The open intents of the disk as rows the statement can join, and the two
 * texts that name a row's ask with them taken into account.
 */
function namesWithOpenIntents(
  open: ReadonlyMap<string, OpenIntent>,
  max: number,
): { join: SQL; module: SQL; ask: SQL } {
  const module = rawNameIn(NAMING_PARAMS, "module");
  const ask = rawNameIn(NAMING_PARAMS, "ask");
  if (open.size === 0 || max <= 0) return { join: sql``, module, ask };
  const rows = sql.join(
    // A map gives its entries in the order they were put in, and the files
    // are read oldest first: these are the oldest.
    [...open.values()]
      .slice(0, max)
      .map((intent) => sql`(${intent.fileId}::text, ${intent.seq}::bigint, ${intent.module}::text, ${intent.ask}::text)`),
    sql`, `,
  );
  return {
    join: sql`LEFT JOIN (VALUES ${rows}) AS o(file_id, seq, module, ask)
                ON a.ref_seq IS NOT NULL
               AND o.file_id = coalesce(a.ref_file_id, a.spool_file_id)
               AND o.seq = a.ref_seq`,
    module: sql`(CASE WHEN o.file_id IS NOT NULL THEN o.module ELSE ${module} END)`,
    ask: sql`(CASE WHEN o.file_id IS NOT NULL THEN o.ask ELSE ${ask} END)`,
  };
}

/** The largest count an answer can hold exactly. */
const LARGEST_SUM = Number.MAX_SAFE_INTEGER;

/** The counts of a period's asks, by module and ask, as they are added up. */
class AskTally {
  private readonly counts = new Map<string, AskCount>();

  add(named: { module: string; ask: string }, allowed: number, refused: number): void {
    if (allowed <= 0 && refused <= 0) return;
    const key = `${named.module}\u0000${named.ask}`;
    const held = this.counts.get(key) ?? { module: named.module, ask: named.ask, allowed: 0, refused: 0 };
    held.allowed = Math.min(held.allowed + Math.max(allowed, 0), LARGEST_SUM);
    held.refused = Math.min(held.refused + Math.max(refused, 0), LARGEST_SUM);
    this.counts.set(key, held);
  }

  /**
   * Every ask that was counted, in the order of the module and then of the
   * ask, and at most `AUDIT_COUNT_MAX_ASKS` of them. Past that, the last ones
   * in that order are counted together under `unknown`, so no count is lost.
   */
  list(): AskCount[] {
    const inOrder = (a: AskCount, b: AskCount): number =>
      a.module !== b.module ? (a.module < b.module ? -1 : 1) : a.ask === b.ask ? 0 : a.ask < b.ask ? -1 : 1;
    const all = [...this.counts.values()].sort(inOrder);
    if (all.length <= AUDIT_COUNT_MAX_ASKS) return all;
    const isRest = (entry: AskCount): boolean => entry.module === UNKNOWN_ASK && entry.ask === UNKNOWN_ASK;
    const named = all.filter((entry) => !isRest(entry));
    const rest: AskCount = all.find(isRest) ?? { module: UNKNOWN_ASK, ask: UNKNOWN_ASK, allowed: 0, refused: 0 };
    for (const entry of named.slice(AUDIT_COUNT_MAX_ASKS - 1)) {
      rest.allowed = Math.min(rest.allowed + entry.allowed, LARGEST_SUM);
      rest.refused = Math.min(rest.refused + entry.refused, LARGEST_SUM);
    }
    return [...named.slice(0, AUDIT_COUNT_MAX_ASKS - 1), rest].sort(inOrder);
  }
}

/** How many intents one statement asks the table for. */
const INTENTS_PER_STATEMENT = 500;

/** The notice that this HX Fortress's module records were removed from its disk.
 *  It is about the trail, so every organization is shown it. */
function isReclaimNotice(record: { action: string; origin: string }): boolean {
  return record.action === AUDIT_ACTIONS.spoolReclaimed && record.origin === "system";
}

/**
 * Whether a record is one of an organization's.
 *
 * `mark` is the organization's mark: its id, or null for HX Fortress's own.
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
   * organization, and how many of each ask.
   *
   * An ask is `allowed` when it passed the gate and reached a module, however
   * the module then answered. It is `refused` when the gate turned it away, or
   * refused to send the module's reply. `asksAllowed` and `asksRefused` are the
   * sums over every ask, so the two ways of counting cannot differ.
   */
  count(range: { from: string; to: string }, organization: Organization): Promise<TrailCounts> {
    const mark = organizationMark(organization);
    const from = Date.parse(range.from);
    const to = Date.parse(range.to);
    if (!(from <= to)) return Promise.reject(new TrailUnavailable("range_invalid"));

    return this.exclusive(async () => {
      const asks = new AskTally();
      let releasesInstalled = 0;
      let signIns = 0;
      const addOther = (action: string, outcome: string | null, lines: number): void => {
        if (action === AUDIT_ACTIONS.releaseInstall) {
          if (outcome === "installed") releasesInstalled += lines;
        } else if (action === AUDIT_ACTIONS.signIn) {
          signIns += lines;
        }
      };

      // An ask that ran is a pair, and which ask it was is on its intent. The
      // files are read oldest first, and an intent is written before its
      // outcome, so an outcome usually finds its intent in `open`. Each is
      // taken out when it is found, so `open` holds the asks that were running
      // at the place the reading has got to, and not every ask on the disk.
      const open = new Map<string, OpenIntent>();
      // The outcomes of the period whose intent the reading has not shown.
      const owed = new Map<string, { fileId: string; seq: number; allowed: number; refused: number }>();

      const lowest = await this.scanDisk(to, (record) => {
        const ofAnAsk = record.action === AUDIT_ACTIONS.controlPlaneAsk;
        if (ofAnAsk && record.kind === "intent") {
          const key = intentKey(record.fileId, record.seq);
          const waiting = owed.get(key);
          if (waiting) {
            owed.delete(key);
            asks.add(askOf(record.params), waiting.allowed, waiting.refused);
          } else {
            open.set(key, { fileId: record.fileId, seq: record.seq, ...askOf(record.params) });
          }
          return;
        }
        if (record.kind !== "outcome") return;
        const counted = record.at >= from && record.at <= to && isOf(record, mark);
        if (!ofAnAsk) {
          if (counted) addOther(record.action, record.outcome, 1);
          return;
        }
        // A collapsed run of refusals is one record that stands for `attempts`.
        const attempts = record.params.attempts;
        const refused =
          record.outcome !== "refused"
            ? 0
            : typeof attempts === "number" && Number.isSafeInteger(attempts) && attempts > 0
              ? attempts
              : 1;
        const allowed = record.outcome === "refused" ? 0 : 1;
        if (record.refSeq === null) {
          // A single record: a refusal, which names its ask itself.
          if (counted) asks.add(askOf(record.params), allowed, refused);
          return;
        }
        const fileId = record.refFileId ?? record.fileId;
        const key = intentKey(fileId, record.refSeq);
        const named = open.get(key);
        // Taken out also for an outcome that is not counted: it is answered.
        if (named) open.delete(key);
        if (!counted) return;
        if (named) {
          asks.add(named, allowed, refused);
          return;
        }
        const waiting = owed.get(key) ?? { fileId, seq: record.refSeq, allowed: 0, refused: 0 };
        waiting.allowed += allowed;
        waiting.refused += refused;
        owed.set(key, waiting);
      });

      // An intent that is not on the disk was drained, and its file removed.
      // The table has it, and it is read there as the statement below reads
      // an intent: with `rawNameIn`, and not from its parameters parsed here.
      // One that is in neither place is gone, and its ask is counted under
      // `unknown`.
      const missing = [...owed.values()];
      for (let start = 0; start < missing.length; start += INTENTS_PER_STATEMENT) {
        const pairs = sql.join(
          missing
            .slice(start, start + INTENTS_PER_STATEMENT)
            .map((intent) => sql`(${intent.fileId}::text, ${intent.seq}::bigint)`),
          sql`, `,
        );
        const found = await this.query(
          sql`SELECT a.spool_file_id AS "fileId", a.seq AS "seq",
                     ${rawNameIn(sql`a.params`, "module")} AS "module",
                     ${rawNameIn(sql`a.params`, "ask")} AS "ask"
                FROM hx.admin_audit a
               WHERE a.kind = 'intent' AND (a.spool_file_id, a.seq) IN (${pairs})`,
        );
        for (const row of found) {
          if (typeof row.fileId !== "string") continue;
          const key = intentKey(row.fileId, Number(row.seq));
          const waiting = owed.get(key);
          if (!waiting) continue;
          owed.delete(key);
          asks.add(askOf({ module: row.module, ask: row.ask }), waiting.allowed, waiting.refused);
        }
      }
      for (const waiting of owed.values()) {
        asks.add({ module: UNKNOWN_ASK, ask: UNKNOWN_ASK }, waiting.allowed, waiting.refused);
      }

      const disk = onDiskJoin(lowest);
      const inPeriod = sql`a.kind = 'outcome'
               AND a.ts >= ${range.from}::timestamptz AND a.ts <= ${range.to}::timestamptz
               AND ${ofPredicate(mark)}
               AND ${disk.where}`;
      // The rows of each pair of texts are counted first, and each pair is
      // held to the form of a name afterwards: see "Which ask a record is of".
      // The outer grouping keeps the answer to one row for each ask, whatever
      // the table holds: every text that is no name is counted under one word.
      // Both are grouped by position: the same expression written twice would
      // be two different sets of parameters to the database.
      const names = namesWithOpenIntents(open, this.deps.openIntentsMax ?? OPEN_INTENTS_MAX);
      const askRows = await this.query(
        sql`SELECT ${nameOrUnknown(sql`g.module_text`, bodyOf(MODULE_ID_PATTERN), MODULE_ID_MAX_CHARS)} AS "module",
                   ${nameOrUnknown(sql`g.ask_text`, bodyOf(ASK_NAME_PATTERN), ASK_NAME_MAX_CHARS)} AS "ask",
                   g.how AS "how", sum(g.lines)::bigint AS "lines",
                   least(sum(g.weight), ${sql.raw(LARGEST_COUNT)})::bigint AS "weight"
              FROM (SELECT ${names.module} AS module_text, ${names.ask} AS ask_text,
                           (CASE WHEN a.outcome = 'refused' THEN 'refused' ELSE 'allowed' END) AS how,
                           count(*) AS lines, sum(${ATTEMPTS}) AS weight
                      FROM hx.admin_audit a ${INTENT_JOIN} ${names.join} ${disk.join}
                     WHERE a.action = ${AUDIT_ACTIONS.controlPlaneAsk}
                       AND ${inPeriod}
                     GROUP BY 1, 2, 3) g
             GROUP BY 1, 2, 3`,
      );
      for (const row of askRows) {
        // Held to the form of a name once more, whatever the database answered.
        const ask = askOf({ module: row.module, ask: row.ask });
        if (row.how === "refused") asks.add(ask, 0, Number(row.weight) || 0);
        else asks.add(ask, Number(row.lines) || 0, 0);
      }

      const others = [AUDIT_ACTIONS.releaseInstall, AUDIT_ACTIONS.signIn];
      const otherRows = await this.query(
        sql`SELECT a.action AS "action", a.outcome AS "outcome", count(*)::bigint AS "lines"
              FROM hx.admin_audit a ${disk.join}
             WHERE a.action IN (${sql.join(
               others.map((action) => sql`${action}`),
               sql`, `,
             )})
               AND ${inPeriod}
             GROUP BY a.action, a.outcome`,
      );
      for (const row of otherRows) {
        addOther(String(row.action), typeof row.outcome === "string" ? row.outcome : null, Number(row.lines) || 0);
      }

      const list = asks.list();
      const sum = (pick: (entry: AskCount) => number): number =>
        Math.min(
          list.reduce((total, entry) => total + pick(entry), 0),
          LARGEST_SUM,
        );
      return {
        asksAllowed: sum((entry) => entry.allowed),
        asksRefused: sum((entry) => entry.refused),
        releasesInstalled,
        signIns,
        asks: list,
      };
    });
  }
}
