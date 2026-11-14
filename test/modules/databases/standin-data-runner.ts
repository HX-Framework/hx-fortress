// A stand-in for the data runner program, for the tests of the Databases
// module.
//
// The real data runner is a program of its own: for one job it dials one
// database, does one thing, prints one line and exits. This stand-in dials
// nothing. It answers from a made-up company's servers, written below, and it
// keeps the program's contract with its caller:
//
//   • `run --job-stdin`: the job is one JSON object on standard input
//   • an unknown field of the job is refused
//   • standard output holds one line, the output, and the exit code is 0 also
//     for a job that failed
//   • a query that is not one statement that only reads is refused
//   • the login is never printed
//
// Every name, address, row and password here is made up.

import { statementRefusal } from "../../../src/modules/databases/read-only";

// ── The made-up company ──────────────────────────────────────────────────────

export interface StandInColumn {
  name: string;
  type: string;
  nullable: boolean;
  key?: number;
}

export interface StandInTable {
  schema: string;
  name: string;
  kind: "table" | "view";
  /** The engine's own estimate of its rows. */
  estimate: number | null;
  columns: StandInColumn[];
  rows: (string | null)[][];
  /** Reading it fails, with these words of the database's own. */
  breaksWith?: string;
}

export interface StandInServer {
  host: string;
  port: number;
  engine: "sqlserver" | "oracle" | "mysql" | "postgres";
  database: string;
  version: string;
  /** `trusted`: a certificate a public authority signed, naming the host.
   *  `self-made`: one the server made itself. `none`: the server speaks no TLS. */
  certificate: "trusted" | "self-made" | "none";
  logins: { user: string; password: string; writable: string[]; powers: string[] }[];
  tables: StandInTable[];
}

/** Values that stand for rows. No answer to an ask, no audit record, no log
 *  line and no state file may ever hold one. */
export const ROW_VALUES = ["18 Mill Road", "7 Alder Court", "221 Main Street", "Okafor and Daughters"];

export const PERMITS_PASSWORD = "example-password-for-permits";
export const BILLING_PASSWORD = "example-password-for-billing";

const PERMIT_ROWS: (string | null)[][] = [
  ["BP-2026-0412", "18 Mill Road", "Deck", "2026-03-02", "4200.00", "Okafor and Daughters"],
  ["BP-2026-0413", "7 Alder Court", "Roof", "2026-03-02", "18500.00", null],
  ["BP-2026-0415", "221 Main Street", "Solar", "2026-03-03", "23900.50", null],
  ["BP-2026-0419", "3 Quarry Lane", "Fence", "2026-03-05", "1200.00", null],
  ["BP-2026-0423", "40 Station Road", "Garage", "2026-03-09", "31000.00", null],
];

export const NORTHSTAR_SERVERS: readonly StandInServer[] = [
  {
    host: "sql01.northstar.example",
    port: 1433,
    engine: "sqlserver",
    database: "Permits",
    version: "Example SQL Server 2022 (RTM) - 16.0.1000.6 (X64)",
    certificate: "trusted",
    logins: [{ user: "permits_reader", password: PERMITS_PASSWORD, writable: [], powers: [] }],
    tables: [
      {
        schema: "dbo",
        name: "permits",
        kind: "table",
        estimate: 1204,
        columns: [
          { name: "permit_no", type: "nvarchar(20)", nullable: false, key: 1 },
          { name: "address", type: "nvarchar(200)", nullable: false },
          { name: "type", type: "nvarchar(40)", nullable: false },
          { name: "issued", type: "date", nullable: true },
          { name: "valuation", type: "decimal(12,2)", nullable: true },
          { name: "applicant", type: "nvarchar(max)", nullable: true },
        ],
        rows: PERMIT_ROWS,
      },
      {
        schema: "dbo",
        name: "open_permits",
        kind: "view",
        estimate: null,
        columns: [
          { name: "permit_no", type: "nvarchar(20)", nullable: false },
          { name: "issued", type: "date", nullable: true },
        ],
        rows: PERMIT_ROWS.slice(0, 2).map((row) => [row[0] ?? null, row[3] ?? null]),
      },
      {
        // A name an answer cannot hold: it is left out of a catalog and counted.
        schema: "dbo",
        name: "Gebühren (alt)",
        kind: "table",
        estimate: 12,
        columns: [{ name: "id", type: "int", nullable: false, key: 1 }],
        rows: [],
      },
      {
        schema: "dbo",
        name: "inspections",
        kind: "table",
        estimate: 88,
        columns: [
          { name: "id", type: "bigint", nullable: false, key: 1 },
          { name: "permit_no", type: "nvarchar(20)", nullable: false },
          { name: "passed", type: "bit", nullable: false },
          { name: "seen_at", type: "datetime2(7)", nullable: false },
          { name: "row_version", type: "timestamp", nullable: false },
          // A column's name an answer cannot hold.
          { name: "fee (€)", type: "money", nullable: true },
        ],
        rows: [],
      },
      {
        schema: "dbo",
        name: "broken_view",
        kind: "view",
        estimate: null,
        columns: [{ name: "lot", type: "int", nullable: true }],
        rows: [],
        breaksWith: "Conversion failed when converting the nvarchar value '18 Mill Road' to data type int.",
      },
    ],
  },
  {
    host: "pg02.northstar.example",
    port: 5432,
    engine: "postgres",
    database: "billing",
    version: "Example PostgreSQL 16.4",
    certificate: "self-made",
    logins: [
      {
        user: "billing_reader",
        password: BILLING_PASSWORD,
        writable: ["public.invoices", "public.payments"],
        powers: ["CREATE in schema public"],
      },
    ],
    tables: [
      {
        schema: "public",
        name: "invoices",
        kind: "table",
        estimate: 5310,
        columns: [
          { name: "id", type: "uuid", nullable: false, key: 1 },
          { name: "issued_at", type: "timestamp with time zone", nullable: false },
          { name: "total", type: "numeric(12,2)", nullable: false },
          { name: "paid", type: "boolean", nullable: false },
        ],
        rows: [],
      },
    ],
  },
];

// ── The job, read strictly ───────────────────────────────────────────────────

const JOB_FIELDS = new Set([
  "v", "id", "kind", "engine", "database", "server", "tls", "reach", "login", "deadline", "params",
  "catalogMaxTables",
]);

interface Job {
  v: 1;
  id: string;
  kind: "test" | "query";
  engine: string;
  database: string;
  server: { host: string; port: number };
  tls: { mode: string; minVersion: string; serverName?: string };
  reach: { kind: "direct"; host: string; port: number };
  login: { kind: string; user: string; password: string };
  deadline: string;
  params?: { sql?: unknown; limit?: unknown };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

function readJob(raw: unknown): Job | null {
  if (!isRecord(raw) || raw.v !== 1) return null;
  if (!Object.keys(raw).every((key) => JOB_FIELDS.has(key))) return null;
  const { id, kind, engine, database, server, tls, reach, login, deadline, params } = raw;
  if (typeof id !== "string" || id.length < 1 || id.length > 64) return null;
  if (kind !== "test" && kind !== "query") return null;
  if (typeof engine !== "string" || typeof database !== "string" || typeof deadline !== "string") return null;
  if (!isRecord(server) || !onlyKeys(server, ["host", "port"])) return null;
  if (!isRecord(tls) || !onlyKeys(tls, ["mode", "minVersion", "serverName", "caCertificate"])) return null;
  if (!isRecord(reach) || !onlyKeys(reach, ["kind", "host", "port"]) || reach.kind !== "direct") return null;
  if (!isRecord(login) || !onlyKeys(login, ["kind", "user", "password"])) return null;
  if (typeof server.host !== "string" || typeof server.port !== "number") return null;
  if (typeof reach.host !== "string" || typeof reach.port !== "number") return null;
  if (typeof tls.mode !== "string" || typeof tls.minVersion !== "string") return null;
  if (typeof login.user !== "string" || typeof login.password !== "string") return null;
  if (params !== undefined && (!isRecord(params) || !onlyKeys(params, ["sql", "limit"]))) return null;
  return raw as unknown as Job;
}

// ── The output ───────────────────────────────────────────────────────────────

export type StandInOutput = Record<string, unknown>;

const failed = (id: string, code: string, message: string): StandInOutput => ({
  v: 1,
  id,
  ok: false,
  where: null,
  error: { code, message },
  ms: 3,
});

/** One SELECT over one table: all this stand-in understands of SQL. */
function select(
  server: StandInServer,
  sql: string,
  limit: number,
): { columns: { name: string; type: string }[]; rows: (string | null)[][]; truncated: boolean } | string {
  const parsed =
    // The statement is a test's own text, and the match is held to its start.
    // eslint-disable-next-line security/detect-unsafe-regex
    /^\s*select\s+(?:top\s+(\d+)\s+)?(.+?)\s+from\s+([A-Za-z_][\w.]*)(?:\s+order\s+by\s+([A-Za-z_]\w*))?\s*;?\s*$/is.exec(
      sql,
    );
  if (!parsed) return "Only SELECT columns FROM one table is understood here.";
  const [, top, list, from, orderBy] = parsed;
  const tableName = (from ?? "").split(".").pop() ?? "";
  const table = server.tables.find((candidate) => candidate.name === tableName);
  if (!table) return `Invalid object name '${from}'.`;
  if (table.breaksWith) return table.breaksWith;
  const wanted =
    (list ?? "").trim() === "*"
      ? table.columns.map((column) => column.name)
      : (list ?? "").split(",").map((name) => name.trim());
  const places: number[] = [];
  for (const name of wanted) {
    const place = table.columns.findIndex((column) => column.name === name);
    if (place < 0) return `Invalid column name '${name}'.`;
    places.push(place);
  }
  let rows = [...table.rows];
  // Every index below is the place of a column this function found by name.
  /* eslint-disable security/detect-object-injection */
  if (orderBy) {
    const by = table.columns.findIndex((column) => column.name === orderBy);
    if (by < 0) return `Invalid column name '${orderBy}'.`;
    rows.sort((a, b) => String(a[by] ?? "").localeCompare(String(b[by] ?? "")));
  }
  if (top !== undefined) rows = rows.slice(0, Number(top));
  const truncated = rows.length > limit;
  return {
    columns: places.map((place) => {
      const column = table.columns[place] as StandInColumn;
      return { name: column.name, type: column.type.replace(/\(.*$/, "") };
    }),
    rows: rows.slice(0, limit).map((row) => places.map((place) => row[place] ?? null)),
    truncated,
  };
  /* eslint-enable security/detect-object-injection */
}

/** Do one job, and answer what the program prints for it. */
export function runStandInJob(
  raw: unknown,
  servers: readonly StandInServer[] = NORTHSTAR_SERVERS,
  now: Date = new Date(),
): StandInOutput {
  const job = readJob(raw);
  if (!job) return failed("", "internal", "The job could not be read.");
  if (Date.parse(job.deadline) <= now.getTime()) {
    return failed(job.id, "deadline", "The job's deadline passed.");
  }
  const server = servers.find(
    (candidate) => candidate.host === job.reach.host && candidate.port === job.reach.port,
  );
  if (!server) return failed(job.id, "unreachable", "The server did not answer.");
  if (job.tls.mode !== "off" && server.certificate === "none") {
    return failed(job.id, "tls", "The server offers no encryption.");
  }
  const checks = job.tls.mode === "verify" || job.tls.mode === "strict";
  if (checks && server.certificate === "self-made") {
    return failed(job.id, "tls", `The certificate of ${server.host} is signed by nobody this machine trusts.`);
  }
  if (checks && (job.tls.serverName ?? job.server.host) !== server.host) {
    return failed(job.id, "tls", `The certificate names ${server.host}, not ${job.tls.serverName ?? job.server.host}.`);
  }
  const login = server.logins.find(
    (candidate) => candidate.user === job.login.user && candidate.password === job.login.password,
  );
  if (!login) return failed(job.id, "login", "The database refused the login.");
  if (server.database !== job.database || server.engine !== job.engine) {
    return failed(job.id, "database", `Cannot open database "${job.database}" requested by the login.`);
  }
  const encryption =
    job.tls.mode === "off"
      ? { kind: "none", version: null, cipher: null, verified: false }
      : { kind: "tls", version: "TLS 1.3", cipher: "TLS_AES_256_GCM_SHA384", verified: checks };

  if (job.kind === "query") {
    const sql = typeof job.params?.sql === "string" ? job.params.sql : "";
    const limit = typeof job.params?.limit === "number" ? job.params.limit : 200;
    if (statementRefusal(sql) !== null) {
      return failed(job.id, "database", "A query is one statement that only reads.");
    }
    const answer = select(server, sql, limit);
    if (typeof answer === "string") return failed(job.id, "database", answer);
    return {
      v: 1,
      id: job.id,
      ok: true,
      where: null,
      result: { kind: "query", ...answer, ms: { tunnel: 0, connect: 2, query: 1, total: 3 } },
      ms: 3,
    };
  }

  return {
    v: 1,
    id: job.id,
    ok: true,
    where: null,
    result: {
      kind: "test",
      login: "read",
      serverVersion: server.version,
      encryption,
      write: {
        canWrite: login.writable.length > 0 || login.powers.length > 0,
        writableCount: login.writable.length,
        writableTables: login.writable,
        powers: login.powers,
      },
      catalog: {
        engine: server.engine,
        database: server.database,
        tables: server.tables.map((table) => ({
          schema: table.schema,
          name: table.name,
          kind: table.kind,
          rows: table.estimate,
          columns: table.columns,
          writable: login.writable.includes(`${table.schema}.${table.name}`),
        })),
        truncated: false,
      },
      ms: { tunnel: 0, connect: 2, catalog: 4, total: 6 },
    },
    ms: 6,
  };
}

// ── As a program ─────────────────────────────────────────────────────────────

if (import.meta.main) {
  const [verb, flag, ...rest] = process.argv.slice(2);
  if (verb !== "run" || flag !== "--job-stdin" || rest.length > 0) {
    process.stderr.write("usage: data-runner run --job-stdin\n");
    process.exit(2);
  }
  let job: unknown;
  try {
    job = JSON.parse(await Bun.stdin.text());
  } catch {
    job = undefined;
  }
  // A job for this host is never answered: the test of a caller that stops a
  // program which does not end.
  if (isRecord(job) && isRecord(job.reach) && job.reach.host === "slow.northstar.example") {
    await new Promise(() => {});
  }
  process.stderr.write("data-runner: connect\n");
  process.stdout.write(`${JSON.stringify(runStandInJob(job))}\n`);
  process.exit(0);
}
