// What the control plane may ask the Fortress about its databases, and what a
// signed-in person of this organization may do to them.
//
// A CONNECTION is a database this Fortress may reach, kept under a name: its
// engine, its server and port, the database, how the link is encrypted, and the
// login. The login is a user name and the NAME of a secret in the
// organization's own key store. The password itself is never typed into the
// Fortress and never kept by it.
//
// Two lists are here, and they are separate on purpose.
//
//   ASKS   what the control plane may ask, through the ask gate. Four of them.
//          Every field of every answer is below: names, counts, states and
//          times. No ask takes a statement, and no answer has a field a row
//          could travel in. No ask adds or changes a connection.
//
//   ACTS   what a person signed in to this Fortress's console may do: read the
//          connections in full, add one, change one, remove one, test one.
//          Adding a host this Fortress may reach is a change on the
//          organization's own side, so only its own people make it.
//
// A query's rows travel neither way. They go from the database to the browser
// of the person who asked, through `onDataIsland` (see query.ts).
//
// Pure data, with no imports from the daemon: the terminal and the console read
// these same objects to show what may be asked.

import type { ModuleManifest } from "../../host/module-contract";
import { S, type Shape } from "../../host/shape";

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
 * How this Fortress reaches a connection's database. `direct`: it starts the
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
 * stays in the Fortress: it can quote a value.
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
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/** How a tested connection's link was encrypted, as the data runner saw it. */
export const LINK_ENCRYPTIONS = ["verified", "not_verified", "none"] as const;
export type LinkEncryption = (typeof LINK_ENCRYPTIONS)[number];

/** Who started a job. */
export const JOB_ORIGINS = ["person", "control_plane"] as const;
export type JobOrigin = (typeof JOB_ORIGINS)[number];

// ── Limits ───────────────────────────────────────────────────────────────────

/** Most connections one organization keeps. The Fortress's list of hosts takes
 *  the same number of entries from one module. */
export const CONNECTIONS_MAX = 64;
/** Longest name of a connection. */
export const CONNECTION_NAME_MAX_CHARS = 64;

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
    step: S.state(...JOB_STEPS),
    startedAt: S.time,
    finishedAt: S.time,
    // Set when the state is `failed`.
    code: S.state(...FAILURE_CODES),
    // Set when a test passed: what it found.
    tables: S.count(),
    columns: S.count(),
    encryption: S.state(...LINK_ENCRYPTIONS),
    // Whether the connection's login may change anything in the database.
    canWrite: S.flag,
  },
  ["finishedAt", "code", "tables", "columns", "encryption", "canWrite"],
);

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

export const DATABASES_MANIFEST: ModuleManifest = {
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
// The module host's contract names three more lists of a manifest: acts,
// programs and data island kinds. Its manifest type does not have them yet, so
// they are constants of their own here, in the form that contract gives. They
// move into the manifest when its type takes them.

export type ActRole = "operator" | "readonly";

export interface ActSpec {
  /** Lower-case words joined by dots, as an ask's name. */
  name: string;
  /** Who may do it: any signed-in person (`readonly`), or an operator. */
  role: ActRole;
  /** Always a record. No free text and no bytes, as for an ask. */
  args: Shape;
  reply: Shape;
}

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
            state: S.state(...CONNECTION_STATES),
            addedAt: S.time,
            addedBy: S.name,
            changedAt: S.time,
            changedBy: S.name,
            // The newest test, whoever started it.
            test: TEST_VIEW,
          },
          ["serverName", "addedBy", "changedAt", "changedBy", "test"],
        ),
        CONNECTIONS_MAX,
      ),
    }),
  },
  { name: "connection.add", role: "operator", args: CONNECTION_FIELDS, reply: S.record({ name: S.name }) },
  { name: "connection.change", role: "operator", args: CONNECTION_FIELDS, reply: S.record({ name: S.name }) },
  { name: "connection.remove", role: "operator", args: S.record({ name: S.name }), reply: S.none },
  { name: "connection.test", role: "operator", args: S.record({ name: S.name }), reply: S.record({ job: S.id }) },
  { name: "job.read", role: "readonly", args: S.record({ job: S.id }), reply: JOB_VIEW },
];

/** The helper program this module has the host start, and the fixed arguments
 *  it is started with. One job goes to its standard input. */
export const DATA_RUNNER_PROGRAM = "data-runner";
export const DATABASES_PROGRAMS: readonly { id: string; args: readonly string[] }[] = [
  { id: DATA_RUNNER_PROGRAM, args: ["run", "--job-stdin"] },
];

/** The kinds of data island this module answers: the two that show a query's
 *  rows. */
export const DATABASES_ISLAND_KINDS = ["rows", "table"] as const;
export type DatabasesIslandKind = (typeof DATABASES_ISLAND_KINDS)[number];
export const DATABASES_ISLANDS: readonly { kind: DatabasesIslandKind }[] = DATABASES_ISLAND_KINDS.map(
  (kind) => ({ kind }),
);
