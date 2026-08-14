// The console read API: what it may read, what it may not, and what it says when
// it cannot.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import { fortressPaths } from "../src/host/paths";
import { UI_SESSION_COLUMNS, UI_READ_TABLES } from "../src/host/postgres/console-plane";
import { SESSION_META_SELECT } from "../src/query/sessions-list";
import {
  CONSOLE_DENIED_TABLES,
  CONSOLE_SEARCH_FIELDS,
  CONTENT_COLUMNS,
  classifySessionColumn,
  namesForbiddenColumn,
  SESSION_COLUMN_CLASSES,
} from "../src/query/console/columns";
import {
  auditExportQuery,
  auditPageQuery,
  commandsQuery,
  decodeAuditCursor,
  drainedOutcomesQuery,
  encodeAuditCursor,
} from "../src/query/console/audit";
import {
  consoleDevicesQuery,
  consoleEmbeddingFactsQuery,
  consoleGrowthQuery,
  consolePeopleQuery,
  consolePostgresFactsQuery,
} from "../src/query/console/inventory";
import {
  consoleSessionByKeyQuery,
  consoleSessionTotalsQuery,
  consoleSessionsQuery,
} from "../src/query/console/sessions";
import {
  consoleAdoptionCountsQuery,
  consoleRosterQuery,
  consoleUnrosteredQuery,
} from "../src/query/console/roster";
import { migrationRunsQuery } from "../src/query/console/migrations";
import {
  consoleUniversePredicate,
  foreignOrgCountQuery,
  foreignOrgLabel,
  universeConstrains,
} from "../src/query/console/universe";
import { classifyConnectError, consoleDbCopy, externalContainmentBanner, resolveConsoleDb, withStatementTimeout } from "../src/ui/console-db";
import { dataPathRows, EGRESS_TITLE, relayMethodNames } from "../src/ui/egress";
import { filterLogLines } from "../src/ui/console-read-port";
import { EventStreamRegistry, EVENTS_PER_SESSION_CAP } from "../src/ui/events";
import { Glob } from "bun";
import { AUDIT_RETENTION_LINE, logRetentionLine, readIdentityFacts } from "../src/ui/identity";
import { renderPdf } from "../src/ui/pdf";
import { verifySessionResidency } from "../src/ui/residency-verify";
import { redactCredentials, redactValue, REDACTED } from "../src/ui/redact";
import { reportLines, REPORT_TITLE } from "../src/ui/report";
import {
  handleReadRoute,
  parseExportRange,
  READ_AUDITED_PATHS,
  READ_PATHS,
  READ_ROUTES,
  type ConsoleExportAudit,
  type ConsoleReadPort,
} from "../src/ui/read-routes";
import { gate } from "../src/ui/routes";
import { UI_CONFIG_DEFAULTS } from "../src/ui/config";
import { createConsoleMount } from "../src/ui/console-mount";
import { UiRuntime } from "../src/ui/runtime";
import {
  updateVaultCredentials,
  writeVaultCredentials,
} from "../src/modules/session-vault/credentials";
import type { EgressInputs } from "../src/ui/egress";

const dialect = new PgDialect();
const render = (q: SQL): string => dialect.sqlToQuery(q).sql;

const UNIVERSE = { orgExternalId: "org_orange" };

/** Every statement the console layer can build, so the boundary is asserted over
 *  the whole surface rather than over the ones somebody remembered. */
function everyConsoleStatement(): Array<{ name: string; sql: string }> {
  return [
    { name: "sessions", sql: render(consoleSessionsQuery({ universe: UNIVERSE, search: "checkout" })) },
    { name: "sessions:cursor", sql: render(consoleSessionsQuery({ universe: UNIVERSE, cursor: "MjAyNi0wNy0wMXwx" })) },
    { name: "totals", sql: render(consoleSessionTotalsQuery(UNIVERSE)) },
    { name: "foreign", sql: render(foreignOrgCountQuery(UNIVERSE)) },
    { name: "byKey", sql: render(consoleSessionByKeyQuery(UNIVERSE, { family: "claude", sessionId: "s1" })) },
    { name: "people", sql: render(consolePeopleQuery(UNIVERSE)) },
    { name: "devices", sql: render(consoleDevicesQuery(UNIVERSE)) },
    { name: "growth", sql: render(consoleGrowthQuery(UNIVERSE, 30)) },
    { name: "embeddings", sql: render(consoleEmbeddingFactsQuery()) },
    { name: "postgres", sql: render(consolePostgresFactsQuery(UNIVERSE)) },
    { name: "roster", sql: render(consoleRosterQuery(UNIVERSE)) },
    { name: "unrostered", sql: render(consoleUnrosteredQuery(UNIVERSE)) },
    { name: "adoption", sql: render(consoleAdoptionCountsQuery(UNIVERSE, 30)) },
    { name: "migrations", sql: render(migrationRunsQuery()) },
    { name: "audit", sql: render(auditPageQuery({ from: "2026-07-01T00:00:00Z" })) },
    { name: "auditExport", sql: render(auditExportQuery({ action: "console.rotate" })) },
    { name: "commands", sql: render(commandsQuery()) },
    { name: "drained", sql: render(drainedOutcomesQuery(["a", "b"])) },
  ];
}

describe("the console boundary", () => {
  test("no console statement names a transcript table or a content column", () => {
    for (const { name, sql } of everyConsoleStatement()) {
      expect([name, namesForbiddenColumn(sql)]).toEqual([name, []]);
    }
  });

  test("the boundary names the two text columns explicitly, not by pattern", () => {
    expect(CONTENT_COLUMNS).toEqual(["last_user_text", "last_assistant_text"]);
    for (const column of CONTENT_COLUMNS) {
      expect(namesForbiddenColumn(`SELECT ${column} FROM hx.sessions`)).toContain(column);
    }
    for (const table of ["turns", "tool_calls", "v_turn_search"]) {
      expect(CONSOLE_DENIED_TABLES).toContain(table);
      expect(namesForbiddenColumn(`SELECT 1 FROM hx.${table}`)).toContain(table);
    }
  });

  test("column classification covers every granted column, in three classes", () => {
    for (const column of UI_SESSION_COLUMNS) {
      expect(SESSION_COLUMN_CLASSES.get(column)).toBeDefined();
    }
    expect(classifySessionColumn("title")).toBe("derived-from-content");
    expect(classifySessionColumn("last_user_text")).toBe("content");
    expect(classifySessionColumn("event_count")).toBe("metadata");
    // The grant itself must not carry the content columns.
    for (const column of CONTENT_COLUMNS) {
      expect(UI_SESSION_COLUMNS as readonly string[]).not.toContain(column);
    }
  });

  test("search touches five metadata fields and no content column", () => {
    const sql = render(consoleSessionsQuery({ universe: UNIVERSE, search: "x" })).toLowerCase();
    for (const field of CONSOLE_SEARCH_FIELDS) {
      const token = field === "repo" ? "r.slug" : `s.${field}`;
      expect(sql).toContain(token.toLowerCase());
    }
    expect(sql).not.toContain("last_user_text");
    expect(sql).not.toContain("last_assistant_text");
  });

  test("the MCP session projection is untouched", () => {
    // The console withholds these; the MCP tools, which answer under a
    // consent-resolved scope, still project them. Narrowing that projection here
    // would be a silent behaviour change on a surface this task does not own.
    expect(Object.keys(SESSION_META_SELECT)).toContain("lastUserText");
    expect(Object.keys(SESSION_META_SELECT)).toContain("lastAssistantText");
  });

  test("the console query layer never imports the MCP scope", async () => {
    const modules = ["columns", "universe", "sessions", "inventory", "audit", "index"];
    for (const name of modules) {
      const source = await Bun.file(`${import.meta.dir}/../src/query/console/${name}.ts`).text();
      const imports = [...source.matchAll(/^import[\s\S]*?from "([^"]+)";$/gm)].map((m) => m[1]);
      expect([name, imports.filter((m) => m.endsWith("/scope"))]).toEqual([name, []]);
      // The token may appear in prose explaining WHY it is absent; a call may not.
      expect([name, /\bscopePredicate\s*\(/.test(source)]).toEqual([name, false]);
    }
  });
});

describe("the universe predicate", () => {
  test("constrains org and soft-delete, and never matches everything", () => {
    const withOrg = render(consoleUniversePredicate(UNIVERSE));
    expect(universeConstrains(withOrg)).toEqual({ org: true, softDelete: true });
    const unbound = render(consoleUniversePredicate({ orgExternalId: "" }));
    expect(universeConstrains(unbound)).toEqual({ org: true, softDelete: true });
    // An unenrolled fortress narrows to the unattributed rows; it does not widen.
    expect(unbound).toContain("org_id IS NULL");
    expect(unbound).not.toContain("OR");
  });

  test("own-org plus unattributed, and nothing else", () => {
    const sql = render(consoleUniversePredicate(UNIVERSE));
    expect(sql).toContain("org_id IS NULL");
    expect(sql).toContain("external_id");
  });

  test("foreign-org rows are counted and labelled, never listed", () => {
    const counted = render(foreignOrgCountQuery(UNIVERSE));
    expect(counted).toContain("count(*)");
    expect(counted).toContain("org_id IS NOT NULL");
    expect(foreignOrgLabel(0)).toContain("No sessions");
    const label = foreignOrgLabel(3);
    expect(label).toContain("3 session");
    expect(label).toContain("another organization");
  });

  test("every statement naming hx.sessions or hx.users constrains org_id", () => {
    // Derived from the SQL, not from a list somebody maintains. The device
    // inventory was absent from the list it used to check, and shipped joining
    // hx.devices to hx.users with nothing but a soft-delete filter — every
    // signed-in local user could read another organization's external ids,
    // machine names and upload times. A rule that reads the statement cannot be
    // passed by forgetting to add one.
    const reads = everyConsoleStatement().filter(({ sql }) =>
      /hx\.(sessions|users)\b/i.test(sql),
    );
    // Guards the guard: a projection change that stopped naming either table by
    // hand would empty this set and the assertion below would pass vacuously.
    expect(reads.map((r) => r.name).sort()).toEqual([
      "adoption",
      "byKey",
      "devices",
      "foreign",
      "growth",
      "people",
      "postgres",
      "roster",
      "sessions",
      "sessions:cursor",
      "totals",
      "unrostered",
    ]);
    for (const { name, sql } of reads) {
      expect([name, universeConstrains(sql).org]).toEqual([name, true]);
    }
  });
});

// -- the port double --------------------------------------------------------

interface Recorded {
  exports: Array<{ what: string; params: Record<string, unknown> }>;
}

function fakePort(overrides: Partial<ConsoleReadPort> = {}): ConsoleReadPort {
  const identity = {
    fortressId: "vault_1",
    boundOrgId: "org_orange",
    credentialWrittenAt: "2026-07-01T00:00:00.000Z",
    root: "/srv/fortress",
    daemonRoot: "/srv/fortress",
    rootMatch: "same" as const,
    paths: { root: "/srv/fortress", log: "/srv/fortress/logs/fortress.jsonl" },
    roles: [],
    postgresMode: "embedded" as const,
    retention: { logs: logRetentionLine({}), auditTrail: AUDIT_RETENTION_LINE },
  };
  const totals = { sessions: 3, people: 2, bytes: 10, tunnel: 1, gateway: 1, unknownProvenance: 1 };
  const foreign = { sessions: 2, label: foreignOrgLabel(2) };
  return {
    status: async () => ({
      daemon: "running",
      copy: "running",
      daemonPostgres: null,
      version: "0.0.0-test",
      serviceManager: "systemd (user)",
      pid: 42,
      writtenAt: "2026-07-01T00:00:00.000Z",
      rootMatch: "same",
      database: { kind: "ready", mode: "embedded", dsn: "postgresql://hx_ui:secret@127.0.0.1:5432/hx" },
    }),
    sessions: async () => ({ rows: [], totals, foreign }),
    people: async () => [],
    adoption: async () => ({
      sync: null,
      counts: { rostered: 0, installed: 0, syncComplete: 0, sending: 0, active: 0, formerMembers: 0, unrostered: 0 },
      stages: [],
      roster: [],
      unrostered: [],
      teams: [],
      attention: [],
    }),
    devices: async () => [],
    growth: async () => [],
    facts: async () => ({
      postgres: null,
      embeddings: null,
      storage: {
        provider: "gcs",
        bucket: "b",
        region: null,
        versioning: "unavailable - the fortress key cannot read bucket configuration",
        lifecycle: "unavailable - the fortress key cannot read bucket configuration",
      },
    }),
    identity: async () => identity as never,
    metrics: async () => null,
    dataPaths: async () => ({ title: EGRESS_TITLE, rows: [] }),
    version: async () => ({ kind: "unavailable", reason: "offline", checkedAt: "", cached: false }),
    commands: async () => ({ rows: [], records: [], externalPostgres: false }),
    migrations: async () => [],
    audit: async () => ({ rows: [] }),
    auditExport: async () => ({ rows: [], truncated: false }),
    spoolTail: async () => [],
    verifySession: async (key) =>
      verifySessionResidency({ ...key, row: null, storeUnavailable: "no store in this test" }),
    posture: async () => ({
      state: "unavailable",
      asOf: null,
      cloudOnlySessions: null,
      routedHere: null,
      lastRun: null,
      qualification: "unqualified - posture unavailable, cloud-only sessions not checked",
      witness: null,
      findings: null,
    }),
    logsExport: async () => "{}\n",
    report: async () => ({
      generatedAt: "2026-07-01T00:00:00.000Z",
      version: "0.16.1",
      identity: identity as never,
      totals,
      foreign,
      storage: {
        provider: "gcs",
        bucket: "b",
        region: null,
        versioning: "unavailable - the fortress key cannot read bucket configuration",
        lifecycle: "unavailable - the fortress key cannot read bucket configuration",
      },
      posture: {
        state: "unavailable",
        asOf: null,
        cloudOnlySessions: null,
        routedHere: null,
        qualification: "unqualified",
      },
      dataPaths: [],
    }),
    openEvents: () => ({ ok: false, status: 429, reason: "no streams here", retryAfterMs: 1000 }),
    ...overrides,
  };
}

function ctxFor(port: ConsoleReadPort, recorded: Recorded, audit?: ConsoleExportAudit) {
  return {
    port,
    audit:
      audit ??
      ({
        async recordExport(entry) {
          recorded.exports.push({ what: entry.what, params: entry.params });
        },
      } satisfies ConsoleExportAudit),
    actor: "auditor",
    sessionId: "sess-1",
  };
}

async function get(path: string, port = fakePort(), recorded: Recorded = { exports: [] }) {
  const res = await handleReadRoute(new Request(`http://console.local${path}`), ctxFor(port, recorded));
  return { res, recorded };
}

describe("effect classes", () => {
  test("the read-audited set is exactly five routes", () => {
    const audited = READ_ROUTES.filter((r) => r.cls === "read-audited").map((r) => r.path).sort();
    expect(audited).toEqual(Object.values(READ_AUDITED_PATHS).sort());
    expect(audited).toHaveLength(5);
  });

  test("every other read route is plain read", () => {
    const plain = READ_ROUTES.filter((r) => r.cls === "read").map((r) => r.path);
    expect(plain).toContain(READ_PATHS.audit);
    expect(plain).toContain(READ_PATHS.spool);
    expect(plain).toContain(READ_PATHS.version);
    expect(plain).toContain(READ_PATHS.events);
  });

  test("a plain read never records an export, even when recording would throw", async () => {
    const port = fakePort();
    const exploding: ConsoleExportAudit = {
      async recordExport() {
        throw new Error("a read must not reach the audit spool");
      },
    };
    for (const path of Object.values(READ_PATHS)) {
      // The verify route names one session; without it there is nothing to
      // verify, and the refusal is the answer.
      const query = path === READ_PATHS.verify ? "?family=claude-cli&session=s1" : "";
      const res = await handleReadRoute(
        new Request(`http://console.local${path}${query}`),
        ctxFor(port, { exports: [] }, exploding),
      );
      expect([path, res?.status]).toEqual([path, path === READ_PATHS.events ? 429 : 200]);
    }
  });

  test("every read-audited route records its own export with its parameters", async () => {
    const recorded: Recorded = { exports: [] };
    const port = fakePort();
    await handleReadRoute(new Request(`http://console.local${READ_AUDITED_PATHS.report}`), ctxFor(port, recorded));
    await handleReadRoute(new Request(`http://console.local${READ_AUDITED_PATHS.reportPdf}`), ctxFor(port, recorded));
    await handleReadRoute(
      new Request(`http://console.local${READ_AUDITED_PATHS.logsExport}?module=host&lines=10`),
      ctxFor(port, recorded),
    );
    await handleReadRoute(
      new Request(`http://console.local${READ_AUDITED_PATHS.auditExport}?from=2026-07-01&to=2026-07-02`),
      ctxFor(port, recorded),
    );
    await handleReadRoute(
      new Request(`http://console.local${READ_AUDITED_PATHS.proofCopyAck}`, { method: "POST" }),
      ctxFor(port, recorded),
    );
    expect(recorded.exports.map((e) => e.what).sort()).toEqual([
      "audit export",
      "logs export",
      "proof-copy ack",
      "report PDF",
      "report payload",
    ]);
    // Never collapsed: each export drains with the parameters it ran under.
    const logs = recorded.exports.find((e) => e.what === "logs export");
    expect(logs?.params).toMatchObject({ module: "host", lines: 10 });
    const audit = recorded.exports.find((e) => e.what === "audit export");
    expect(audit?.params).toMatchObject({ from: "2026-07-01", to: "2026-07-02" });
  });

  test("a readonly session may reach every read and read-audited route", () => {
    for (const route of READ_ROUTES) {
      const decision = gate({ method: route.method, path: route.path, route, role: "readonly" });
      expect([route.path, decision.allow]).toEqual([route.path, true]);
    }
  });

  test("no signed-out caller reaches any of them", () => {
    for (const route of READ_ROUTES) {
      const decision = gate({ method: route.method, path: route.path, route, role: null });
      expect([route.path, decision.allow]).toEqual([route.path, false]);
    }
  });
});

describe("range and filter, enforced by the server", () => {
  test("a malformed range is refused rather than trimmed", () => {
    expect(parseExportRange(new URLSearchParams("from=yesterday")).ok).toBe(false);
    expect(parseExportRange(new URLSearchParams("from=2026-07-02&to=2026-07-01")).ok).toBe(false);
    expect(parseExportRange(new URLSearchParams(`action=${"x".repeat(300)}`)).ok).toBe(false);
  });

  test("a good range parses into the statement's own filters", () => {
    const parsed = parseExportRange(new URLSearchParams("from=2026-07-01T00:00:00Z&action=console.rotate"));
    expect(parsed.ok).toBe(true);
    const sql = render(auditExportQuery(parsed.ok ? parsed.range : {}));
    expect(sql).toContain("a.ts >=");
    expect(sql).toContain("a.action =");
    expect(sql).toContain("LIMIT");
  });

  test("the audit export refuses a bad range at the endpoint", async () => {
    const { res, recorded } = await get(`${READ_AUDITED_PATHS.auditExport}?from=nope`);
    expect(res?.status).toBe(400);
    // A refused export is not an export: nothing left, so nothing is recorded.
    expect(recorded.exports).toHaveLength(0);
  });

  test("an over-large export refuses rather than truncating", async () => {
    const port = fakePort({ auditExport: async () => ({ rows: [], truncated: true }) });
    const res = await handleReadRoute(
      new Request(`http://console.local${READ_AUDITED_PATHS.auditExport}`),
      ctxFor(port, { exports: [] }),
    );
    expect(res?.status).toBe(413);
    expect(await res?.text()).toContain("narrow it");
  });

  test("the logs export is reachable and served as a file", async () => {
    const { res } = await get(`${READ_AUDITED_PATHS.logsExport}?lines=5`);
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toBe("application/x-ndjson");
    expect(res?.headers.get("content-disposition")).toContain("hx-fortress-logs.jsonl");
  });

  test("audit cursors round-trip and reject a forged id", () => {
    const cursor = encodeAuditCursor({ ts: "2026-07-01T00:00:00Z", id: "11111111-2222-3333-4444-555555555555" });
    expect(decodeAuditCursor(cursor)).toEqual({
      ts: "2026-07-01T00:00:00Z",
      id: "11111111-2222-3333-4444-555555555555",
    });
    expect(decodeAuditCursor(Buffer.from("x|DROP TABLE").toString("base64url"))).toBeNull();
  });
});

describe("degraded states", () => {
  test("role-not-provisioned is distinct from a stopped Postgres", () => {
    const auth = classifyConnectError(Object.assign(new Error("password authentication failed for user hx_ui"), { code: "28P01" }));
    expect(auth.kind).toBe("role-not-provisioned");
    expect(consoleDbCopy(auth)).toContain("restart the fortress daemon");

    const down = classifyConnectError(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:54329"), { code: "ECONNREFUSED" }));
    expect(down.kind).toBe("postgres-stopped");
    expect(consoleDbCopy(down)).not.toContain("role");

    expect(resolveConsoleDb({ pgJson: null, uiDatabaseUrl: null }).kind).toBe("not-configured");
  });

  test("the console's DSN carries a statement timeout", () => {
    const dsn = withStatementTimeout("postgresql://hx_ui:pw@127.0.0.1:5432/hx", 5000);
    expect(decodeURIComponent(dsn)).toContain("statement_timeout=5000");
  });

  test("the external banner states BOTH containment voids", () => {
    const banner = externalContainmentBanner().join(" ");
    expect(banner).toContain("command fence is void");
    expect(banner).toContain("audit tamper fence is void");
    expect(banner).toContain("does not own the tables");
  });

  test("external mode reports the external database on every surface", async () => {
    const external = resolveConsoleDb({
      pgJson: { mode: "external", databaseUrl: "postgresql://ops:pw@db.example.com:5432/hx" },
      uiDatabaseUrl: null,
    });
    expect(external).toMatchObject({ kind: "ready", mode: "external" });
    const rows = dataPathRows(externalEgress());
    const db = rows.find((r) => r.id === "metadata-database");
    expect(db?.peer).toContain("db.example.com");
    expect(db?.peer).toContain("external");
    expect(db?.notes?.join(" ")).toContain("leave this host");

    const port = fakePort({
      status: async () => ({
        daemon: "running",
        copy: "running",
        daemonPostgres: null,
        version: "0.0.0-test",
        serviceManager: "systemd (user)",
        pid: 1,
        writtenAt: null,
        rootMatch: "same",
        database: external,
        externalBanner: externalContainmentBanner(),
      }),
    });
    const { res } = await get(READ_PATHS.status, port);
    const body = await res?.json();
    expect(JSON.stringify(body)).toContain("command fence is void");
  });
});

describe("staleness and the pre-heartbeat state", () => {
  test("a snapshot with no writtenAt renders pre-heartbeat, never stale", async () => {
    const port = fakePort({
      status: async () => ({
        daemon: "pre-heartbeat",
        copy: "pre-heartbeat daemon - restart to finish the upgrade",
        daemonPostgres: null,
        version: "0.0.0-test",
        serviceManager: "systemd (user)",
        pid: 7,
        writtenAt: null,
        rootMatch: "unknown",
        database: { kind: "not-configured" },
      }),
    });
    const { res } = await get(READ_PATHS.status, port);
    const body = (await res?.json()) as { copy: string; writtenAt: string | null };
    expect(body.copy).toContain("restart to finish the upgrade");
    expect(body.copy).not.toContain("not responding");
    // No fabricated freshness: the absent timestamp stays absent.
    expect(body.writtenAt).toBeNull();
  });

  test("a cleanly stopped daemon reads stopped, and a silent one reads not responding", async () => {
    for (const [state, copy] of [
      ["stopped", "stopped"],
      ["stale", "not responding"],
    ] as const) {
      const port = fakePort({
        status: async () => ({
          daemon: state,
          copy,
          version: "0.0.0-test",
          serviceManager: "systemd (user)",
          pid: null,
          writtenAt: null,
          rootMatch: "unknown",
          database: { kind: "not-configured" },
      daemonPostgres: null,
        }),
      });
      const { res } = await get(READ_PATHS.status, port);
      expect(((await res?.json()) as { copy: string }).copy).toBe(copy);
    }
  });
});

function externalEgress(): EgressInputs {
  return {
    ui: { ...UI_CONFIG_DEFAULTS, bind: "127.0.0.1", trustedProxies: [] },
    boundPort: 8788,
    postgres: { mode: "external", host: "db.example.com", database: "hx", tls: false },
    cloudUrl: "wss://let.ai/_api/hx-gateway/vault-tunnel",
    downloadBase: "https://let.ai/_api/hx-gateway/download",
    postgresBinariesUrl: "https://repo1.maven.org/maven2",
    bucket: { provider: "gcs", name: "orange-hx", region: "eu-north-1" },
    embeddingEndpoint: "https://api.openai.com/v1",
    ssoAdvertised: true,
    rosterRetentionDays: 90,
  };
}

describe("the data-paths inventory", () => {
  test("is titled for what it is, and computed from configuration", () => {
    expect(EGRESS_TITLE).toBe("Data paths in and out of this host");
    const loopback = dataPathRows({
      ...externalEgress(),
      postgres: { mode: "embedded", host: "127.0.0.1", port: 54329, database: "hx" },
    });
    const db = loopback.find((r) => r.id === "metadata-database");
    expect(db?.peer).toContain("embedded, loopback");
    expect(db?.carries).toContain("transcript text and embeddings");
    expect(db?.notes?.join(" ")).toContain("Nothing leaves this host");
  });

  test("the console-listener row reports the effective remote-key source", () => {
    const ignored = dataPathRows(externalEgress()).find((r) => r.id === "console-listener");
    expect(ignored?.notes?.join(" ")).toContain("X-Forwarded-For ignored");
    expect(ignored?.notes?.join(" ")).toContain("trustedProxies");

    const honored = dataPathRows({
      ...externalEgress(),
      ui: { ...UI_CONFIG_DEFAULTS, trustedProxies: ["10.0.0.0/8"] },
    }).find((r) => r.id === "console-listener");
    expect(honored?.notes?.join(" ")).toContain("honored via trustedProxies");
    expect(honored?.notes?.join(" ")).toContain("10.0.0.0/8");
  });

  test("`ui config` prints the same sentence", async () => {
    const { printableUiConfig } = await import("../src/ui/config");
    const printed = printableUiConfig({ ...UI_CONFIG_DEFAULTS });
    const line = printed.find(([key]) => key === "remote-key source");
    expect(line?.[1]).toContain("X-Forwarded-For ignored");
  });

  test("the console-to-bucket row admits the key is write-capable", () => {
    const row = dataPathRows(externalEgress()).find((r) => r.id === "console-bucket");
    expect(row?.notes?.join(" ")).toContain("BUCKET-WRITE-CAPABLE");
  });

  test("the downloads row names the Postgres binaries host too", () => {
    const row = dataPathRows(externalEgress()).find((r) => r.id === "downloads");
    expect(row?.peer).toContain("repo1.maven.org");
    expect(row?.notes?.join(" ")).toContain("pgvector");
  });

  test("the relay row enumerates exactly the methods the dispatcher serves", async () => {
    const source = await Bun.file(
      `${import.meta.dir}/../src/modules/session-vault/store/rpc.ts`,
    ).text();
    // The switch IS the authority. Reading it rather than a parallel constant is
    // the whole point: a method added to the dispatcher and forgotten here is a
    // data path the inventory would not mention.
    const switchBody = source.slice(source.indexOf("switch (req.method)"));
    const served = [...switchBody.matchAll(/case "([A-Za-z]+)":/g)].map((m) => m[1]).sort();
    expect(served.length).toBeGreaterThan(10);
    expect(relayMethodNames()).toEqual(served);
  });

  test("the relay row does not claim it never carries transcript objects", () => {
    const row = dataPathRows(externalEgress()).find((r) => r.id === "relay-tunnel");
    expect(row?.carries).toContain("session bytes");
    expect(JSON.stringify(row)).not.toContain("never transcript");
  });
});

describe("identity and retention facts", () => {
  test("every path is resolved from a non-default root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hx-root-"));
    try {
      const paths = fortressPaths(root);
      const facts = await readIdentityFacts({
        paths,
        credentials: { orgId: "org_orange", fortressId: "vault_1", credential: "s3cr3t" },
        daemonRoot: root,
        postgresMode: "embedded",
        env: {},
        mtimeOf: async () => "2026-07-01T00:00:00.000Z",
      });
      for (const value of Object.values(facts.paths)) {
        expect(value.startsWith(root)).toBe(true);
      }
      expect(facts.root).toBe(root);
      expect(facts.rootMatch).toBe("same");
      expect(facts.fortressId).toBe("vault_1");
      // Never the credential itself.
      expect(JSON.stringify(facts)).not.toContain("s3cr3t");
      expect(facts.roles.map((r) => r.name)).toContain("hx_ui");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an external database reports no provisioned roles", async () => {
    const facts = await readIdentityFacts({
      paths: fortressPaths("/srv/fortress"),
      credentials: null,
      postgresMode: "external",
      env: {},
      mtimeOf: async () => null,
    });
    expect(facts.roles).toEqual([]);
    expect(facts.fortressId).toBeNull();
  });

  test("retention lines are derived, not invented", () => {
    expect(logRetentionLine({})).toBe("the last 16 MB across 5 rotated segments (6 files, oldest discarded)");
    expect(
      logRetentionLine({ FORTRESS_LOG_ROTATE_BYTES: String(4 * 1024 * 1024), FORTRESS_LOG_ROTATE_KEEP: "2" }),
    ).toBe("the last 4 MB across 2 rotated segments (3 files, oldest discarded)");
    expect(AUDIT_RETENTION_LINE).toContain("life of the database");
    expect(AUDIT_RETENTION_LINE).toContain("no delete sweep");
    expect(AUDIT_RETENTION_LINE).not.toMatch(/\d+\s*d(ays)?\b/);
  });
});

describe("bucket facts", () => {
  test("unreadable bucket configuration is reported honestly", async () => {
    const { res } = await get(READ_PATHS.facts);
    const body = (await res?.json()) as { storage: { versioning: string; lifecycle: string } };
    expect(body.storage.versioning).toContain("cannot read bucket configuration");
    expect(body.storage.lifecycle).toContain("cannot read bucket configuration");
  });

  test("the report carries the same honest answer", async () => {
    const { res } = await get(READ_AUDITED_PATHS.report);
    const payload = await res?.json();
    const lines = reportLines(payload as never).join("\n");
    expect(lines).toContain("cannot read bucket configuration");
    expect(lines).toContain(EGRESS_TITLE);
  });
});

describe("credentials never leave", () => {
  test("a DSN in a response body is redacted", () => {
    expect(redactCredentials("postgresql://hx_ui:sup3rsecret@127.0.0.1:5432/hx")).toBe(
      `postgresql://hx_ui:${REDACTED}@127.0.0.1:5432/hx`,
    );
    expect(redactCredentials("Authorization: Bearer abcdef0123456789")).toContain(REDACTED);
    expect(redactCredentials("https://x/y?token=abcdef0123")).toContain(REDACTED);
    expect(redactCredentials("password = 'hunter22'")).toContain(REDACTED);
  });

  test("the JSON form credentials.json is actually WRITTEN in is redacted too", () => {
    // Every field rule required its separator to follow the bare name, and in
    // JSON the next character is a quote — so the rules added for this file
    // matched the file's own contents in none of its shapes. Probed one shape
    // per rule, in the form `writePrivateJson` produces.
    const file = JSON.stringify(
      {
        store: "s3",
        bucket: "letai-sessions",
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        sessionToken: "FQoGZXIvYXdzEBYaDEXAMPLETOKENvalue0123456789",
        password: "hunter22",
        openaiApiKey: "sk-abcdefghijklmnopqrstuvwxyz012345",
        gcs: { private_key_id: "0123456789abcdef0123456789abcdef01234567" },
      },
      null,
      2,
    );
    const redacted = redactCredentials(file);
    for (const secret of [
      "AKIAIOSFODNN7EXAMPLE",
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "FQoGZXIvYXdzEBYaDEXAMPLETOKENvalue0123456789",
      "hunter22",
      "sk-abcdefghijklmnopqrstuvwxyz012345",
      "0123456789abcdef0123456789abcdef01234567",
    ]) {
      expect(redacted).not.toContain(secret);
    }
    // …and the shape is still readable, which is the whole point of redacting
    // rather than dropping.
    expect(redacted).toContain('"bucket": "letai-sessions"');
    expect(redacted).toContain('"store": "s3"');
    // STILL JSON. The field rules used to eat the value's closing quote, so a
    // redacted log line stopped parsing — on the tab whose value is that a
    // machine can read it back.
    expect(() => JSON.parse(redacted)).not.toThrow();
  });

  test("a STRUCTURED secret is consumed whole, and the line still parses", () => {
    // The unquoted arm stopped at the first delimiter, so an array or an object
    // under a secret name lost only its head — the rest stayed in the clear and
    // the line stopped being JSON, on the tab whose value is that a machine can
    // read it back.
    const shapes = [
      '{"ts":"x","password":["s3cr3tA","s3cr3tB"],"host":"db"}',
      '{"ts":"x","password":{"v":"s3cr3tHunter2"},"host":"db"}',
      // NESTED two deep, with a field after it — the shape that proves the
      // structured arm consumed the whole value rather than its head.
      '{"ts":"x","password":{"a":{"b":"s3cr3tHunter2"}},"host":"db"}',
      '{"ts":"x","secretAccessKey":[["s3cr3tA"]],"host":"db"}',
      '{"password":1234567890,"host":"db"}',
    ];
    for (const line of shapes) {
      const out = redactCredentials(line);
      expect(out).not.toContain("s3cr3t");
      expect(out).not.toContain("1234567890");
      expect(() => JSON.parse(out)).not.toThrow();
      // BY VALUE, not merely parseable. Every earlier version of this rule
      // deleted the fields AFTER the secret and still produced valid JSON, so
      // "it parses" could not see the defect at all.
      expect((JSON.parse(out) as { host?: string }).host).toBe("db");
    }
    // …and a state stays a state: `null` is "not configured", not a secret.
    const withNull = '{"level":"error","password":null,"host":"10.0.0.4"}';
    expect(redactCredentials(withNull)).toBe(withNull);
  });

  test("an EMBEDDED error keeps every field after the secret", () => {
    // `JSON.stringify` writes a nested driver error as an escaped string. The
    // escaped-quote arm has to stop at the first `\\"`; treating it as an
    // ordinary escape ran the match to the last plain quote on the line and
    // deleted the host, the port and the TLS flag — while the outer JSON still
    // parsed, so nothing downstream noticed.
    const line =
      '{"ts":"t","msg":"connect failed: {\\"password\\":\\"hunter2\\",\\"host\\":\\"db.internal\\",\\"port\\":5432}","bucket":"hx"}';
    const out = redactCredentials(line);
    expect(out).not.toContain("hunter2");
    expect(out).toContain("db.internal");
    expect(out).toContain("5432");
    expect((JSON.parse(out) as { bucket?: string }).bucket).toBe("hx");
  });

  test("an unquoted value beginning with a JSON literal is still a secret", () => {
    // The literal arm was unanchored, so `null` matched the head of
    // `nullS3cretValue` and the state passthrough then emitted the whole
    // credential untouched.
    expect(redactCredentials("password=nullS3cretValue host=db")).toBe(
      `password=${REDACTED} host=db`,
    );
    expect(redactCredentials("secret_access_key=trueSecretHere region=eu")).toBe(
      `secret_access_key=${REDACTED} region=eu`,
    );
  });

  test("a prefixed field name is the same field", () => {
    // `\b(password)` cannot match after an underscore — both are word
    // characters — so the two spellings this appliance actually writes went
    // through in the clear, while the object-key rule called them secrets.
    expect(redactCredentials("dsn_password=hunter2 host=db")).toBe(
      `dsn_password=${REDACTED} host=db`,
    );
    expect(redactCredentials("POSTGRES_PASSWORD=hunter2 host=db")).toBe(
      `POSTGRES_PASSWORD=${REDACTED} host=db`,
    );
  });

  test("a numeric secret is redacted on BOTH paths", () => {
    // The two halves of the file had disagreed: the string rule called a number
    // under one of these names a value somebody chose, and the object rule
    // called it a configuration fact.
    // Typed through Record, because `redactValue<T>(v: T): T` returns the input
    // type and a number-valued property cannot be compared against the string
    // it redacts to. `bun test` does not typecheck, so this only ever fails in
    // `bun run typecheck` — which is what CI runs.
    const body: Record<string, unknown> = { password: 1234567890, dsn: 1234567890, hasPassword: false };
    expect(redactValue(body)).toEqual({
      password: REDACTED,
      dsn: REDACTED,
      hasPassword: false,
    });
  });

  test("an env value keeps the bracket that closes its diagnostic", () => {
    expect(redactCredentials("rotate failed (password=hunter2) at 10:00")).toBe(
      `rotate failed (password=${REDACTED}) at 10:00`,
    );
  });

  test("a DSN with no user, and one whose password holds a slash", () => {
    // `redis://:secret@host` carries no user, and requiring one left that
    // password in the clear.
    expect(redactCredentials("redis://:justpass@h:6379")).toBe(`redis://:${REDACTED}@h:6379`);
    expect(redactCredentials("postgresql://u:pa/ss@h:5432/db")).toBe(
      `postgresql://u:${REDACTED}@h:5432/db`,
    );
  });

  test("a long dotted token does not stall the redactor", () => {
    // `[a-z0-9+.-]*` after a `\b` rescans from every word boundary inside a
    // dotted run: one 128 KB token blocked the event loop for 8.8 s, and every
    // later open of the Logs tab paid it again.
    // THREE shapes, because the first bound only fixed the first of them: a
    // dotted run against the scheme (8.8 s), repeated `a://` (3.6 s) and
    // repeated `redis://h:1/` (1.2 s) against the user and password runs. A test
    // that pinned only the dotted one could not see the other two.
    for (const token of ["a.".repeat(64_000), "a://".repeat(32_000), "redis://h:1/".repeat(10_923)]) {
      const line = `{"msg":"${token}","password":"x"}`;
      const started = Date.now();
      redactCredentials(line);
      expect(Date.now() - started).toBeLessThan(1_000);
    }
  });

  test("an unquoted value keeps its whole tail — the env and DSN form", () => {
    // Stopping at a comma left the rest of a comma-bearing value in the clear.
    expect(redactCredentials("password=s3c,r3tHunter2 host=db")).toBe(
      `password=${REDACTED} host=db`,
    );
  });

  test("a redaction keeps the value's TYPE — a boolean is not a secret", () => {
    // `hasPassword: false` is a fact about configuration. Replacing it with a
    // string changes what it means as well as what it is, for the same reason
    // `null` is left alone: "not configured" and "withheld" must not read alike.
    expect(redactValue({ passwordSet: true, hasPassword: false, password: null })).toEqual({
      passwordSet: true,
      hasPassword: false,
      password: null,
    });
  });

  test("the equals form still works, and both separators live in one rule", () => {
    expect(redactCredentials("password = 'hunter22'")).toContain(REDACTED);
    expect(redactCredentials("PGPASSWORD=hunter22")).toContain(REDACTED);
    expect(redactCredentials("secret_access_key = wJalrXUtnFEMI/K7MDENG/bPx")).toContain(REDACTED);
    expect(redactCredentials("https://x/y?X-Amz-Signature=deadbeefdeadbeef01")).toContain(REDACTED);
    expect(
      redactCredentials("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"),
    ).toBe(REDACTED);
  });

  test("a named secret in a STRUCTURED body goes by its name", () => {
    // Every field rule needs name, separator and value inside one string, which
    // is how a log line reads. A response body is not shaped that way — the name
    // is the object key and the value a bare leaf — so the secrets these rules
    // were written for went through untouched on the very path redactValue
    // exists for.
    const body = redactValue({
      openaiApiKey: "sk-abcdefghijklmnopqrstuvwxyz012345",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      gcsPrivateKeyId: "1a2b3c4d",
      sessionToken: "FQoGZXIvYXdz",
      bucket: "acme-vault",
      nested: { password: "hunter22", note: "fine" },
      absent: null,
    });
    expect(body).toEqual({
      openaiApiKey: REDACTED,
      secretAccessKey: REDACTED,
      gcsPrivateKeyId: REDACTED,
      sessionToken: REDACTED,
      bucket: "acme-vault",
      nested: { password: REDACTED, note: "fine" },
      // Absent stays absent: "not configured" and "withheld" must not read alike.
      absent: null,
    });
  });

  test("what the console MINTS is not redacted by name", () => {
    // The sign-in response carries the session token and the setup link carries
    // its own; a credentialRef names an indirection precisely so the secret it
    // points at never travels. Blanking these broke sign-in outright.
    expect(
      redactValue({ token: "s3ss10n-t0ken-value", credentialRef: "0123456789abcdef0123456789abcdef" }),
    ).toEqual({ token: "s3ss10n-t0ken-value", credentialRef: "0123456789abcdef0123456789abcdef" });
  });

  test("the entropy rule leaves ordinary diagnostics alone", () => {
    // The Logs tab is the surface that says what is broken; a redactor that
    // blanks object keys and checksums makes it useless.
    const key = '{"key":"u-denis/claude-code/0199abcd-ef01-2345-6789-abcdef012345"}';
    expect(redactCredentials(key)).toBe(key);
    const sum = 'checksum mismatch: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"';
    expect(redactCredentials(sum)).toBe(sum);
    // …and still catches the shape of a generated key.
    expect(redactCredentials('"AKIAIOSFODNN7EXAMPLEwJalrXUtnFEMIK7MDENGbPxRfiCY"')).toContain(REDACTED);
  });

  test("an instant survives redaction as an instant", () => {
    // The driver hands timestamptz back as a Date. Rebuilt from its enumerable
    // properties it becomes `{}`, and every "last activity" on every page reads
    // as unknown — which is what happened until the SPA rendered one.
    const at = new Date("2026-07-01T12:00:00.000Z");
    const body = redactValue({ lastActivityAt: at, rows: [{ ts: at }] });
    expect(JSON.parse(JSON.stringify(body))).toEqual({
      lastActivityAt: "2026-07-01T12:00:00.000Z",
      rows: [{ ts: "2026-07-01T12:00:00.000Z" }],
    });
  });

  test("redaction reaches nested response values", () => {
    const out = redactValue({ a: [{ dsn: "postgres://u:pw@h/db" }] });
    expect(JSON.stringify(out)).not.toContain("pw@h");
  });

  test("no endpoint echoes the console's own password", async () => {
    for (const path of Object.values(READ_PATHS)) {
      if (path === READ_PATHS.events) continue;
      const { res } = await get(path);
      const text = await res?.text();
      expect([path, text?.includes("secret")]).toEqual([path, false]);
    }
  });

  test("an error body carries no credential either", async () => {
    const port = fakePort({
      status: async () => {
        throw new Error("connect failed: postgresql://hx_ui:sup3rsecret@127.0.0.1:5432/hx");
      },
    });
    // The handler does not swallow it; the port's own classifier is what renders
    // it, and that path is redacted at the source.
    const state = classifyConnectError(
      new Error("connect failed: postgresql://hx_ui:sup3rsecret@127.0.0.1:5432/hx"),
    );
    expect(JSON.stringify(state)).not.toContain("sup3rsecret");
    await expect(get(READ_PATHS.status, port)).rejects.toThrow();
  });
});

describe("the report PDF", () => {
  test("is rendered on the server and survives a hostile title", () => {
    const bytes = renderPdf(REPORT_TITLE, [
      // Every shape a session title can carry that breaks a naive writer: the
      // string syntax itself, and the control bytes a client can put in a title
      // simply by pasting one.
      "Session title: ) evil \\ (unbalanced",
      "control bytes: \u0000\u0007\n\r\u001b[31m and a \u00e9",
      "a".repeat(400),
    ]);
    const text = Buffer.from(bytes).toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("\\) evil \\\\ \\(unbalanced");
    expect(text).toContain("/Type /Catalog");
    // Nothing outside printable ASCII survives into the content stream, so a
    // byte in a title can never terminate a PDF object or move the cursor.
    expect(text).toContain("control bytes: ?????[31m and a ?");
    const stream = text.slice(text.indexOf("stream"), text.indexOf("endstream"));
    // Checked by code point rather than by a regex: a pattern that has to CARRY
    // the control characters to look for them is itself the thing being banned.
    const control = [...stream].some((ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x20 && code !== 0x0a && code !== 0x0d && code !== 0x09;
    });
    expect(control).toBe(false);
  });

  test("the endpoint serves it as a download", async () => {
    const { res } = await get(READ_AUDITED_PATHS.reportPdf);
    expect(res?.headers.get("content-type")).toBe("application/pdf");
    expect(res?.headers.get("content-disposition")).toContain("hx-fortress-report.pdf");
  });
});

describe("the hx_ui grant covers what the console reads", () => {
  test("every console read table is granted", () => {
    for (const table of ["users", "orgs", "repos", "devices", "session_facts"]) {
      expect(UI_READ_TABLES as readonly string[]).toContain(table);
    }
  });
});


describe("the logs export is filtered by the server", () => {
  const lines = [
    JSON.stringify({ ts: "2026-07-01T00:00:00.000Z", module: "host", level: "info", msg: "a" }),
    JSON.stringify({ ts: "2026-07-01T06:00:00.000Z", module: "session_vault", level: "warn", msg: "b" }),
    JSON.stringify({ ts: "2026-07-02T00:00:00.000Z", module: "host", level: "error", msg: "c" }),
    "not json at all",
  ];

  test("no filter keeps everything, including a torn line", () => {
    expect(filterLogLines(lines, {})).toHaveLength(4);
  });

  test("a module filter narrows, and drops what it cannot classify", () => {
    const kept = filterLogLines(lines, { module: "host" });
    expect(kept).toHaveLength(2);
    expect(kept.join("")).not.toContain("not json at all");
  });

  test("a range is applied on the record's own timestamp", () => {
    expect(filterLogLines(lines, { from: "2026-07-01T05:00:00.000Z" })).toHaveLength(2);
    expect(filterLogLines(lines, { to: "2026-07-01T05:00:00.000Z" })).toHaveLength(1);
    expect(
      filterLogLines(lines, { from: "2026-07-01T05:00:00.000Z", to: "2026-07-01T07:00:00.000Z" }),
    ).toHaveLength(1);
  });

  test("level and module compose", () => {
    expect(filterLogLines(lines, { module: "host", level: "error" })).toHaveLength(1);
  });
});

describe("outbound call sites", () => {
  /** Every module that can open a connection to something outside this host,
   *  mapped to the inventory row that discloses it. A file that starts making
   *  outbound calls and is not mapped fails here rather than becoming a data
   *  path nobody wrote down. */
  const OUTBOUND: Record<string, string> = {
    "src/cloud/connection.ts": "relay-tunnel",
    "src/modules/session-vault/store/rpc.ts": "relay-tunnel",
    "src/modules/session-vault/store/gcs-store.ts": "console-bucket",
    "src/modules/session-vault/store/s3-store.ts": "console-bucket",
    "src/update.ts": "downloads",
    "src/ui/version-check.ts": "downloads",
    "src/host/postgres/acquire.ts": "downloads",
    "src/host/postgres/pgvector-artifact.ts": "downloads",
    "src/host/postgres/pgvector-install.ts": "downloads",
    "src/modules/embed-worker/openai.ts": "embeddings",
    // The signature sidecar rides the same origin as the artifact it verifies.
    "src/host/trust/verify.ts": "downloads",
    // Wires the fetch into the Postgres binary acquisition above.
    "src/host/postgres/index.ts": "downloads",
    "src/modules/session-vault/browser-enroll.ts": "enrollment",
    // Loopback only, and to this console's own port: the instance handshake that
    // decides whether a busy port is another console or a stranger.
    "src/ui/instance.ts": "console-listener",
  };

  test("every outbound module is disclosed by a row", async () => {
    const root = path.resolve(import.meta.dir, "..");
    const found: string[] = [];
    for await (const file of new Glob("src/**/*.ts").scan({ cwd: root })) {
      if (file.endsWith(".test.ts")) continue;
      const source = await Bun.file(path.join(root, file)).text();
      const opensASocket =
        /\bfetch\(/.test(source) ||
        /fetchImpl/.test(source) ||
        /new WebSocket\(/.test(source) ||
        /new Storage\(/.test(source) ||
        /new S3Client\(/.test(source);
      if (opensASocket) found.push(file);
    }
    expect(found.length).toBeGreaterThan(5);
    const unmapped = found.filter((f) => !(f in OUTBOUND));
    expect(unmapped).toEqual([]);

    const rowIds = new Set(dataPathRows(externalEgress()).map((r) => r.id));
    for (const id of new Set(Object.values(OUTBOUND))) {
      expect([id, rowIds.has(id)]).toEqual([id, true]);
    }
  });
});

describe("the app keeps working while streams are open", () => {
  test("N tabs hold streams and every other read route still answers", async () => {
    const registry = new EventStreamRegistry();
    const port = fakePort({
      openEvents: ({ sessionId, userLogin }) =>
        registry.open({
          sessionId,
          userLogin,
          producer: {
            start(_sink, signal) {
              return new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), { once: true }),
              );
            },
          },
        }),
    });
    try {
      for (let tab = 0; tab < 3; tab += 1) {
        for (let i = 0; i < EVENTS_PER_SESSION_CAP; i += 1) {
          const res = await handleReadRoute(new Request(`http://console.local${READ_PATHS.events}`), {
            port,
            audit: { async recordExport() {} },
            actor: "marta",
            sessionId: `tab-${tab}`,
          });
          // Beyond the per-USER cap the extra tabs are refused, which is the
          // designed behaviour - what must NOT happen is the rest of the app
          // failing with them.
          expect([res?.status === 200 || res?.status === 429, true]).toEqual([true, true]);
        }
      }
      for (const p of [READ_PATHS.status, READ_PATHS.sessions, READ_PATHS.identity, READ_PATHS.facts]) {
        const res = await handleReadRoute(new Request(`http://console.local${p}`), {
          port,
          audit: { async recordExport() {} },
          actor: "marta",
          sessionId: "tab-0",
        });
        expect([p, res?.status]).toEqual([p, 200]);
      }
    } finally {
      registry.closeAll();
    }
  });
});

describe("the console follows credentials.json", () => {
  let home = "";
  let root = "";
  let previousHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "hx-mount-home-"));
    root = await mkdtemp(path.join(os.tmpdir(), "hx-mount-root-"));
    previousHome = process.env.HOME;
    process.env.HOME = home;
    await writeVaultCredentials({
      store: "s3",
      bucket: "the-original-bucket",
      region: "us-east-1",
      openaiApiKey: "sk-embedding-key",
    });
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  function mount(): ReturnType<typeof createConsoleMount> {
    return createConsoleMount({
      paths: fortressPaths(root),
      runtime: new UiRuntime({
        uiRoot: path.join(root, "ui"),
        uiConfigFile: path.join(root, "ui", "ui.json"),
        cmdCredsDir: path.join(root, "runtime", "cmd-creds"),
        env: {},
      }),
      boundPort: 8788,
      serviceManager: "container",
      env: {},
    });
  }

  test("the database tile follows a pg.json that appears AFTER the mount", async () => {
    // The console and the daemon start together, and the daemon writes pg.json
    // on its way up — so a console that resolved this once at mount reported
    // "not configured" for the whole life of the process. It healed only when
    // the operator happened to open a view that touched the database, because
    // that path had its own lazy re-read and this one did not. Observed live:
    // the Overview said "Metadata database: not configured · Sessions on this
    // fortress: 0" while the Sessions view, against the same fortress, listed
    // four.
    const console_ = mount();
    await console_.ready;
    expect((await console_.port.status()).database.kind).toBe("not-configured");

    // The daemon comes up and writes its coordinates. Unreachable on purpose:
    // what is under test is that the console RE-READS, not what it finds.
    await mkdir(path.join(root, "ui"), { recursive: true });
    await writeFile(
      path.join(root, "ui", "pg.json"),
      JSON.stringify({
        mode: "embedded",
        host: "127.0.0.1",
        port: 1,
        database: "hx",
        user: "hx_ui",
        password: "unreachable-on-purpose",
      }),
      "utf8",
    );

    // The re-read is fire-and-forget on purpose — awaiting it would put a
    // connect timeout inside the polled status path — so the tile corrects on
    // the NEXT poll rather than this one. The Overview polls every 10s.
    let after = "not-configured";
    for (let i = 0; i < 40 && after === "not-configured"; i += 1) {
      after = (await console_.port.status()).database.kind;
      if (after === "not-configured") await new Promise((r) => setTimeout(r, 50));
    }
    expect(after).not.toBe("not-configured");
  });

  test("the FIRST request waits for the connection instead of racing it", async () => {
    // `db()` returns null while merely KICKING OFF the connection, so the first
    // request after a boot lost that race and the console announced "this
    // console has not reached the fortress's database yet" about a fortress
    // that was fine — the first screen after signing in, cleared only by a
    // manual refresh. The port settles the handle before it judges, and the
    // mount hands it the de-duplicated refresh to settle with.
    const port = await Bun.file(new URL("../src/ui/console-read-port.ts", import.meta.url)).text();
    const q = port.slice(port.indexOf("const query = async"), port.indexOf("const bucketFacts"));
    expect(q).toMatch(/await deps\.awaitDb\?\.\(\);[\s\S]*db = deps\.db\(\);/);
    expect(q.indexOf("awaitDb")).toBeLessThan(q.indexOf("CONSOLE_DB_UNREACHED"));
    const mount = await Bun.file(new URL("../src/ui/console-mount.ts", import.meta.url)).text();
    expect(mount).toMatch(/awaitDb: \(\) => refresh\(\)/);
  });

  test("with no database, counts REFUSE — they never answer zero", async () => {
    // The bug: `query()` returned [] for "there is no database", and `totals()`
    // substitutes a zero row for "no rows" — so a console that had not yet
    // reached Postgres answered 200 with `sessions: 0, people: 0, bytes: 0`.
    // Indistinguishable, to the page, from a fortress that genuinely holds
    // nothing; no client-side loader can correct a number it was handed.
    const console_ = mount();
    await console_.ready;
    await expect(console_.port.sessions(new URLSearchParams())).rejects.toThrow(
      /has not reached the fortress's database/,
    );
  });

  test("…but a fact that needs no database is still answered", async () => {
    // Storage comes from the credential file. Refusing it because Postgres is
    // down would hide something this console genuinely knows, so `facts()`
    // degrades per section: the DB-derived halves go null — which the page
    // renders as "no answer from this fortress yet" — and storage answers.
    const console_ = mount();
    await console_.ready;
    const facts = await console_.port.facts();
    expect(facts.postgres).toBeNull();
    expect(facts.embeddings).toBeNull();
    expect(facts.storage.bucket).toBe("the-original-bucket");
  });

  test("a migration swap moves the bucket the compliance surface names, with no restart", async () => {
    const console_ = mount();
    await console_.ready;
    expect((await console_.port.facts()).storage.bucket).toBe("the-original-bucket");

    // The daemon cuts over: same file, new bucket, version bumped. Read once at
    // boot, this console would keep asserting the previous bucket — a false
    // statement about where this appliance's data lives, on the surface whose
    // whole deliverable is that statement — and would sign with a key the
    // provider has already revoked.
    await updateVaultCredentials(() => ({
      store: "s3",
      bucket: "the-bucket-it-was-moved-to",
      region: "eu-west-1",
    }));
    const after = (await console_.port.facts()).storage;
    expect([after.bucket, after.region]).toEqual(["the-bucket-it-was-moved-to", "eu-west-1"]);
  });

  test("credentials reach this process through the stripped view, never the raw file", () => {
    // Asserted over the source because the console's copy is private to the
    // mount: the embedding key lives in the same file, belongs to the daemon's
    // worker, and has no signing use here — so it must not enter this process at
    // all. The view that strips it existed and nothing called it.
    const source = readFileSync(
      path.join(import.meta.dir, "..", "src", "ui", "console-mount.ts"),
      "utf8",
    );
    expect(source).toContain("storeCredentialsForConsole(");
    expect(source).not.toMatch(/\breadVaultCredentials\s*\(/);
  });
});
