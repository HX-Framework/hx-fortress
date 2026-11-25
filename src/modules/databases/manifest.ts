// What the control plane may ask HX Fortress about its databases, and what a
// signed-in person of this organization may do to them.
//
// A CONNECTION is a local database this HX Fortress may reach, kept under a name: its
// engine, its server and port, the database, how the link is encrypted, and the
// login. The login is a user name and the NAME of a secret in the
// organization's own key store. The password itself is never typed into
// HX Fortress and never kept by it.
//
// Two lists are here, and they are separate on purpose.
//
//   ASKS   what the control plane may ask, through the ask gate. Six of them.
//          Every field of every answer is below: names, counts, states and
//          times. No ask takes a statement, and no answer has a field a row
//          could travel in. No ask adds or changes a connection. Two of them
//          start a write into a database: each names the person who approved
//          it, and the gate lets it through only with the control plane's
//          grant for exactly its arguments.
//
//   ACTS   what a person signed in to the console of this HX Fortress may do: read the
//          connections in full, add one, change one, remove one, test one,
//          and read, set or take away one connection's write settings.
//          Adding a host this HX Fortress may reach is a change on the
//          organization's own side, so only its own people make it.
//
// A query's rows travel neither way. They go from the database to the browser
// of the person who asked, through `onDataIsland` (see query.ts).
//
// Pure data, with no imports from the daemon: the terminal and the console read
// these same objects to show what may be asked.

import type { ActSpec, ModuleManifest } from "../../host/module-contract";
import { S, type Shape } from "../../host/shape";
import { STORE_JOB_STATES, STORE_JOB_WORDS } from "./stores-port";

export type { ActRole, ActSpec } from "../../host/module-contract";

export const DATABASES_MODULE_ID = "databases";

// ── The closed lists ─────────────────────────────────────────────────────────

/** The database engines the data runner speaks. */
export const ENGINES = ["sqlserver", "oracle", "mysql", "postgres"] as const;
export type Engine = (typeof ENGINES)[number];

/**
 * How the link to the database is encrypted.
 *
 *   verify   encrypted, and the server's certificate is checked
 *   require  encrypted, and the certificate is not checked: a server that made
 *            its own certificate
 *   strict   SQL Server only: encrypted before the first packet (TDS 8), and
 *            the certificate is checked
 *   off      not encrypted
 */
export const ENCRYPTION_MODES = ["verify", "require", "strict", "off"] as const;
export type EncryptionMode = (typeof ENCRYPTION_MODES)[number];

/** The oldest TLS version a connection accepts. */
export const TLS_VERSIONS = ["1.0", "1.1", "1.2", "1.3"] as const;
export type TlsVersion = (typeof TLS_VERSIONS)[number];
export const DEFAULT_MIN_TLS: TlsVersion = "1.2";

/**
 * How this HX Fortress reaches a connection's database. `direct`: it starts the
 * data runner program beside itself, and that program dials the server.
 */
export const REACHES = ["direct"] as const;
export type Reach = (typeof REACHES)[number];

/** Where a connection stands: never tested, a test under way, the last test
 *  passed, the last test failed. */
export const CONNECTION_STATES = ["not_tested", "testing", "ready", "failed"] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

/**
 * A column's type, as one word. The engine's own type ("nvarchar(20)",
 * "NUMBER(10,2)") is text the database chose, so it does not cross: the
 * module reads it and answers with the word it belongs to, and its length as a
 * count.
 *
 * `characters` is a column of text and `binary` a column of bytes. They are not
 * called "text" and "bytes" here: a list of what an answer can hold must not
 * read as if an answer could hold either.
 */
export const COLUMN_TYPES = [
  "characters",
  "whole_number",
  "decimal",
  "date",
  "time",
  "date_time",
  "flag",
  "binary",
  "other",
] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export const TABLE_KINDS = ["table", "view"] as const;
export type TableKind = (typeof TABLE_KINDS)[number];

export const JOB_STATES = ["running", "done", "failed"] as const;
export type JobState = (typeof JOB_STATES)[number];

/**
 * The step a job is on, or the step it stopped at.
 *
 *   start       the data runner program is being started, or is running
 *   reach       reaching the server
 *   encryption  agreeing the encryption, and checking the certificate
 *   sign_in     signing in with the connection's login
 *   catalog     reading the names of the tables and their columns
 */
export const JOB_STEPS = ["start", "reach", "encryption", "sign_in", "catalog"] as const;
export type JobStep = (typeof JOB_STEPS)[number];

/**
 * Why a job failed, as one word. The database's own sentence about a failure
 * stays in this HX Fortress: it can quote a value.
 *
 * The first group is what the data runner answers. The second is what the
 * module host answers when it could not run the program. The third is this
 * module's own.
 */
export const FAILURE_CODES = [
  "unreachable",
  "tls",
  "login",
  "database",
  "deadline",
  "not_ready",
  "internal",

  "program_not_declared",
  "program_not_installed",
  "reach_not_listed",
  "secret_not_added",
  "secret_missing",
  "secret_unavailable",
  "busy",
  "timeout",
  "program_failed",

  "output_invalid",
  "interrupted",
  // The test passed, and what it read could not be kept on this host's disk.
  "catalog_not_kept",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/**
 * The kinds of job that write to a database. A rehearsal writes and then puts
 * everything back. An undo takes one earlier write back.
 */
export const WRITE_JOB_KINDS = ["write", "rehearsal", "undo"] as const;
export type WriteJobKind = (typeof WRITE_JOB_KINDS)[number];

/**
 * Why a job that writes failed, as one word: a test's words, and five more.
 *
 *   store, store_limit        the data runner's: the Store's gateway refused a
 *                             call, or the Store reached its limit of writes
 *   job_invalid               the module host's: the job named an address for
 *                             the Store that is not this HX Fortress's own
 *   connection_changed        an operator changed or removed the connection
 *   write_settings_changed    an operator changed its write settings, or
 *                             took them away
 */
export const WRITE_FAILURE_CODES = [
  ...FAILURE_CODES,
  "store",
  "store_limit",
  "job_invalid",
  "connection_changed",
  "write_settings_changed",
] as const;
export type WriteFailureCode = (typeof WRITE_FAILURE_CODES)[number];

/** How a tested connection's link was encrypted, as the data runner saw it. */
export const LINK_ENCRYPTIONS = ["verified", "not_verified", "none"] as const;
export type LinkEncryption = (typeof LINK_ENCRYPTIONS)[number];

/** Who started a job. */
export const JOB_ORIGINS = ["person", "control_plane"] as const;
export type JobOrigin = (typeof JOB_ORIGINS)[number];

// ── Limits ───────────────────────────────────────────────────────────────────

/** Most connections one organization keeps. The list of hosts of an HX Fortress takes
 *  the same number of entries from one module. */
export const CONNECTIONS_MAX = 64;
/** Most tables a connection may name as ones a write may reach. */
export const WRITE_TABLES_MAX = 200;
/**
 * Most such tables that all connections of one organization name together.
 *
 * The module keeps its connections in one record, which the host holds to
 * 1 MiB. A table's schema and name are up to 128 characters each, so this many
 * tables are at most 280 KiB of that record, whatever their names are. That
 * leaves more than 700 KiB for the connections themselves and their newest
 * jobs, which take less than half of it at their longest.
 */
export const WRITE_TABLES_MAX_IN_ALL = 1_000;
/** Longest name of a connection. */
export const CONNECTION_NAME_MAX_CHARS = 64;

/** Most previews one write names. More than one are written in one transaction. */
export const WRITE_PREVIEWS_MAX = 8;

/** Most tables on one page of a catalog. */
export const CATALOG_PAGE_TABLES_MAX = 100;
/** Most columns one table carries on one page. A wider table goes on over the
 *  next pages. */
export const CATALOG_ITEM_COLUMNS_MAX = 400;
/** The highest page number an ask may name. */
export const CATALOG_PAGE_NUMBER_MAX = 100_000;

// ── The shapes ───────────────────────────────────────────────────────────────

const JOB_VIEW: Shape = S.record(
  {
    connection: S.name,
    state: S.state(...JOB_STATES),
    // A test's step. A job that writes has none.
    step: S.state(...JOB_STEPS),
    startedAt: S.time,
    finishedAt: S.time,
    // Set when the state is `failed`.
    code: S.state(...WRITE_FAILURE_CODES),
    // Set when a test passed: what it found.
    tables: S.count(),
    columns: S.count(),
    encryption: S.state(...LINK_ENCRYPTIONS),
    // Whether the connection's login may change anything in the database.
    canWrite: S.flag,
    // ── Only for a job that writes ──
    kind: S.state(...WRITE_JOB_KINDS),
    // The Store whose rows are written, and the Store's own job for it. The
    // Store's record of the write is read from the Stores module by this job.
    store: S.id,
    storeJob: S.id,
    // How the Store's own job stood when this job ended, as far as it could
    // be read: `done` there is a write the Store was told of, whatever this
    // job's own state says. And the Store's word for that job, when it
    // failed. The Store's own asks answer what was written.
    storeState: S.state(...STORE_JOB_STATES),
    refusal: S.state(...STORE_JOB_WORDS),
    // What the data runner counted, when it ended well: the batches it wrote,
    // and how their rows ended.
    batches: S.count(),
    inserted: S.count(),
    updated: S.count(),
    deleted: S.count(),
    held: S.count(),
    // Which program did it, as the program named itself: the day of the
    // commit it was built from, and that commit. And the version of the
    // HX Fortress that started it.
    dbIo: S.record({ version: S.id, commit: S.id }, ["commit"]),
    release: S.name,
  },
  [
    "step",
    "finishedAt",
    "code",
    "tables",
    "columns",
    "encryption",
    "canWrite",
    "kind",
    "store",
    "storeJob",
    "storeState",
    "refusal",
    "batches",
    "inserted",
    "updated",
    "deleted",
    "held",
    "dbIo",
    "release",
  ],
);

/** Who approved a write: the control plane's id of the person, and their
 *  email, as the module host's shape for an email address takes one: lower
 *  case, with a plus sign or an apostrophe where the address has one. */
const APPROVED_BY: Shape = S.record({ id: S.id, email: S.email });

const COLUMN_VIEW: Shape = S.record(
  {
    name: S.name,
    type: S.state(...COLUMN_TYPES),
    nullable: S.flag,
    // The longest value of a column of characters or of binary data, or a
    // decimal's digits.
    length: S.count(),
    // A decimal's digits after the point.
    scale: S.count(),
    // Its place in the table's primary key, from 1. Absent when it has none.
    key: S.count(),
  },
  ["length", "scale", "key"],
);

/** The manifest without its acts, which are written out further down. */
const MANIFEST_WITHOUT_ACTS: ModuleManifest = {
  id: DATABASES_MODULE_ID,
  asks: [
    {
      name: "connections.list",
      args: S.none,
      reply: S.record({
        connections: S.list(
          S.record(
            {
              name: S.name,
              engine: S.state(...ENGINES),
              reach: S.state(...REACHES),
              state: S.state(...CONNECTION_STATES),
              // When the last test ended.
              testedAt: S.time,
              // Why the last test failed, when it did.
              failure: S.state(...FAILURE_CODES),
              // Whether the login may change anything, as the last test that
              // passed found it.
              canWrite: S.flag,
            },
            ["testedAt", "failure", "canWrite"],
          ),
          CONNECTIONS_MAX,
        ),
      }),
    },
    {
      // The names of a connection's tables and columns, as its last test that
      // passed read them, a page at a time.
      name: "catalog.read",
      args: S.record({ connection: S.name, page: S.count(CATALOG_PAGE_NUMBER_MAX) }),
      reply: S.record({
        // When the catalog was read from the database. It is the same on every
        // page of one reading.
        readAt: S.time,
        page: S.count(),
        pages: S.count(),
        // How many tables and columns the reading holds, on all its pages.
        tables: S.count(),
        columns: S.count(),
        // Names the database spells with a character an answer cannot hold.
        // They are left out, never rewritten, and counted here.
        leftOut: S.record({ tables: S.count(), columns: S.count() }),
        // The database has more tables than one reading takes.
        truncated: S.flag,
        items: S.list(
          S.record(
            {
              schema: S.name,
              name: S.name,
              kind: S.state(...TABLE_KINDS),
              // The engine's own estimate. Absent when it has none.
              rows: S.count(),
              // How many columns the table has in this reading, and the place
              // of this item's first one, from 0. A table with more columns
              // than one item carries comes as several items in a row.
              columnCount: S.count(),
              first: S.count(),
              columns: S.list(COLUMN_VIEW, CATALOG_ITEM_COLUMNS_MAX),
            },
            ["rows"],
          ),
          CATALOG_PAGE_TABLES_MAX,
        ),
      }),
    },
    {
      // Start a test of one connection: reach the server, sign in, read the
      // catalog. The answer is the job's id. `job.read` says how it went.
      name: "test.start",
      args: S.record({ connection: S.name }),
      reply: S.record({ job: S.id }),
    },
    {
      name: "job.read",
      args: S.record({ job: S.id }),
      reply: JOB_VIEW,
    },
    {
      // Start a write, or a rehearsal of one, of previews that a Store holds.
      // The gate has checked the control plane's grant for exactly these
      // arguments, so the grant is the approval: it names the person who
      // approved, and each preview by the Store's checksum of what that
      // person was shown.
      //
      // `request` is the control plane's own id for this one approval. The
      // same request with the same arguments answers the same job and starts
      // nothing. `writer` is `program:<id>@<version>` or `user:<id>`.
      //
      // The answer comes at once: `job` is this module's job, which `job.read`
      // answers, and `storeJob` is the Store's own job for the write.
      name: "write.start",
      args: S.record({
        request: S.id,
        connection: S.name,
        store: S.id,
        previews: S.list(S.record({ table: S.id, version: S.count(), checksum: S.id }), WRITE_PREVIEWS_MAX),
        rehearse: S.flag,
        writer: S.name,
        approvedBy: APPROVED_BY,
      }),
      reply: S.record({ job: S.id, storeJob: S.id }),
    },
    {
      // Take one earlier write back. `write` is the `storeJob` that the
      // write's `write.start` answered.
      name: "write.undo",
      args: S.record({
        request: S.id,
        connection: S.name,
        store: S.id,
        write: S.id,
        writer: S.name,
        approvedBy: APPROVED_BY,
      }),
      reply: S.record({ job: S.id, storeJob: S.id }),
    },
  ],
  // The module calls no host over HTTPS and reads no secret itself. A
  // database's host and port, and the name of a login's secret, are not written
  // here: a person adds each one with a connection, and the module host keeps
  // and shows them.
  egress: [],
  secrets: [],
};

// ── What a person may do ─────────────────────────────────────────────────────
//
// The acts are part of the manifest: the module host serves each one at the
// console's act route, and checks the person's role and the arguments before
// `onAct` is called. `DATABASES_MANIFEST` is put together at the end of this
// file, once the acts are written out.
//
// The module host's contract names two more lists of a manifest: programs,
// and the kinds of a Secure Data Island. Its manifest type does not have them
// yet, so they are constants of their own here, in the form that contract
// gives. They move into the manifest when its type takes them.

/** A table of a database, as the database spells its schema and its name. */
const TABLE_NAME: Shape = S.record({ schema: S.name, name: S.name });

/** A connection's write login: a user name, and the name of the secret that
 *  holds its password. */
const WRITE_LOGIN = { user: S.name, keyName: S.name };

/** A connection's write settings: the write login, and the tables a write may
 *  reach. */
const WRITE_SETTINGS = { ...WRITE_LOGIN, tables: S.list(TABLE_NAME, WRITE_TABLES_MAX) };

/** Everything a person names a connection by. The name is its identity: a
 *  change keeps it. */
const CONNECTION_FIELDS: Shape = S.record(
  {
    name: S.name,
    engine: S.state(...ENGINES),
    host: S.name,
    port: S.count(65_535),
    database: S.name,
    encryption: S.state(...ENCRYPTION_MODES),
    minTls: S.state(...TLS_VERSIONS),
    // The name the server's certificate must carry, when it is not the host.
    serverName: S.name,
    // The login: a user name, and the name of the secret that holds its
    // password in the organization's key store.
    user: S.name,
    keyName: S.name,
  },
  ["minTls", "serverName"],
);

const TEST_VIEW: Shape = S.record(
  {
    job: S.id,
    state: S.state(...JOB_STATES),
    step: S.state(...JOB_STEPS),
    origin: S.state(...JOB_ORIGINS),
    // The console login of the person who started it.
    by: S.name,
    startedAt: S.time,
    finishedAt: S.time,
    code: S.state(...FAILURE_CODES),
    encryption: S.state(...LINK_ENCRYPTIONS),
    canWrite: S.flag,
    // How many tables the login may change rows in.
    writableTables: S.count(),
    tables: S.count(),
    columns: S.count(),
    leftOutTables: S.count(),
    leftOutColumns: S.count(),
    truncated: S.flag,
  },
  [
    "by",
    "finishedAt",
    "code",
    "encryption",
    "canWrite",
    "writableTables",
    "tables",
    "columns",
    "leftOutTables",
    "leftOutColumns",
    "truncated",
  ],
);

export const DATABASES_ACTS: readonly ActSpec[] = [
  {
    name: "connections.read",
    role: "readonly",
    args: S.none,
    reply: S.record({
      connections: S.list(
        S.record(
          {
            name: S.name,
            engine: S.state(...ENGINES),
            reach: S.state(...REACHES),
            host: S.name,
            port: S.count(65_535),
            database: S.name,
            encryption: S.state(...ENCRYPTION_MODES),
            minTls: S.state(...TLS_VERSIONS),
            serverName: S.name,
            user: S.name,
            keyName: S.name,
            // Its write login, and how many tables a write may reach, when it
            // has them. The tables themselves are read one connection at a
            // time, with `connection.writes.read`: every connection's tables
            // in one answer would be past what an act may answer.
            writes: S.record({ ...WRITE_LOGIN, tables: S.count(WRITE_TABLES_MAX) }),
            state: S.state(...CONNECTION_STATES),
            addedAt: S.time,
            addedBy: S.name,
            changedAt: S.time,
            changedBy: S.name,
            // The newest test, whoever started it.
            test: TEST_VIEW,
          },
          ["serverName", "writes", "addedBy", "changedAt", "changedBy", "test"],
        ),
        CONNECTIONS_MAX,
      ),
    }),
  },
  { name: "connection.add", role: "operator", args: CONNECTION_FIELDS, reply: S.record({ name: S.name }) },
  { name: "connection.change", role: "operator", args: CONNECTION_FIELDS, reply: S.record({ name: S.name }) },
  { name: "connection.remove", role: "operator", args: S.record({ name: S.name }), reply: S.none },
  // A connection's write login and the tables a write may reach. They are set
  // apart from the connection's own fields: who may write, and where, is its
  // own decision and its own line in the audit trail. Setting them again
  // replaces them whole. Reading them answers one connection's, with its
  // tables, and no `writes` for a connection that has none.
  {
    name: "connection.writes.read",
    role: "readonly",
    args: S.record({ name: S.name }),
    reply: S.record({ name: S.name, writes: S.record(WRITE_SETTINGS) }, ["writes"]),
  },
  {
    name: "connection.writes.set",
    role: "operator",
    args: S.record({ name: S.name, ...WRITE_SETTINGS }, ["tables"]),
    reply: S.record({ name: S.name }),
  },
  {
    name: "connection.writes.remove",
    role: "operator",
    args: S.record({ name: S.name }),
    reply: S.record({ name: S.name }),
  },
  { name: "connection.test", role: "operator", args: S.record({ name: S.name }), reply: S.record({ job: S.id }) },
  { name: "job.read", role: "readonly", args: S.record({ job: S.id }), reply: JOB_VIEW },
];

/** The helper program this module has the host start, and the fixed arguments
 *  it is started with. One job goes to its standard input. */
export const DATA_RUNNER_PROGRAM = "data-runner";
export const DATABASES_PROGRAMS: readonly { id: string; args: readonly string[] }[] = [
  { id: DATA_RUNNER_PROGRAM, args: ["run", "--job-stdin"] },
];

/** The kinds of Secure Data Island this module answers: the two that show a
 *  query's rows. */
export const DATABASES_ISLAND_KINDS = ["rows", "table"] as const;
export type DatabasesIslandKind = (typeof DATABASES_ISLAND_KINDS)[number];
export const DATABASES_ISLANDS: readonly { kind: DatabasesIslandKind }[] = DATABASES_ISLAND_KINDS.map(
  (kind) => ({ kind }),
);

/** What the catalog lists for this module and what the module carries: the
 *  asks of the control plane, and the acts of a signed-in person. */
export const DATABASES_MANIFEST: ModuleManifest = { ...MANIFEST_WITHOUT_ACTS, acts: DATABASES_ACTS };
