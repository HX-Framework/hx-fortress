// The read surface: every endpoint the console renders from, and the two effect
// classes they fall into.
//
// EVERY handler here is pure with respect to the fortress. It reads a port, it
// shapes a response, and it changes nothing - no store write, no filesystem
// write, no Postgres write, no ServiceManager call. That is not a convention:
// the read handlers are given a port that HAS no write method, so a route that
// wanted to mutate could not be written without changing this file's types, and
// changing them is a decision somebody makes deliberately.
//
// The read-AUDITED class is exactly five routes, and the list is here rather
// than spread across the handlers. They differ from plain reads in one respect -
// they are spool-logged - and the reason is the same for all five: each is a way
// for a COPY of something to leave this host. A bounded panel read is exempt
// (auditing a poll would grow a table with no DELETE anywhere in the system, and
// its size would become a function of how often somebody looked at it), but the
// only route to a full-range dump is audited, and every export drains as its own
// row with the parameters it ran under. An audit trail that cannot say WHICH
// copy left is not a trail.
//
// The admin-audit and spool-tail endpoints are plain reads for that exact
// reason. A "read-audited route that is never logged" is a contradiction, and a
// self-auditing panel is a growth driver aimed at the one table nothing prunes.

import {
  corroborationOf,
  disputedCopy,
  isTerminalStatus,
  type CommandOutcomeRecord,
  type Corroboration,
} from "./corroboration";
import { EVENTS_PATH, type EventStreamRegistry, type OpenStreamVerdict } from "./events";
import { redactCredentials, redactValue } from "./redact";
import { renderPdf } from "./pdf";
import type { VerifyResult } from "./residency-verify";
import { reportLines, REPORT_TITLE, type ReportPayload } from "./report";
import type { RouteSpec } from "./routes";
import type { DataPathRow } from "./egress";
import type { IdentityFacts } from "./identity";
import type { RemoteVersion } from "./version-check";
import type { MetricsSnapshot } from "../console/metrics";
import type { DaemonState } from "../daemon-state";
import type { AuditRow, CommandRowView } from "../query/console/audit";
import type { MigrationRunView } from "../query/console/migrations";
import type {
  ConsoleDeviceRow,
  ConsoleGrowthRow,
  ConsolePersonRow,
  ConsolePostgresFacts,
  ConsoleEmbeddingFacts,
} from "../query/console/inventory";
import type { ConsoleSessionRow, ConsoleSessionTotals } from "../query/console/sessions";
import type { ForeignOrgSummary } from "../query/console/universe";
import type { ConsoleDbState } from "./console-db";
import type { AdoptionView } from "./console-read-port";

// -- Paths --------------------------------------------------------------------

export const READ_PATHS = {
  status: "/ui/api/status",
  sessions: "/ui/api/sessions",
  people: "/ui/api/people",
  adoption: "/ui/api/adoption",
  devices: "/ui/api/devices",
  growth: "/ui/api/growth",
  facts: "/ui/api/facts",
  identity: "/ui/api/identity",
  metrics: "/ui/api/metrics",
  dataPaths: "/ui/api/data-paths",
  version: "/ui/api/version",
  commands: "/ui/api/commands",
  /** Storage-migration runs. A read: the daemon owns these rows and this only
   *  says what it recorded. */
  migrations: "/ui/api/migrations",
  audit: "/ui/api/audit",
  spool: "/ui/api/spool",
  /** One session's residency proof. A read: it asks Postgres and the object
   *  store what is there and writes nothing. The ACKNOWLEDGEMENT of a copied
   *  proof is the audited half, and it is a route of its own. */
  verify: "/ui/api/sessions/verify",
  posture: "/ui/api/posture",
  events: EVENTS_PATH,
} as const;

/** The five read routes that leave a record of themselves. Enumerated HERE and
 *  nowhere else: the effect-class test compares the registered route set against
 *  exactly these paths, so a sixth cannot be added by accident and one of these
 *  cannot be quietly demoted to a plain read. */
export const READ_AUDITED_PATHS = {
  report: "/ui/api/report",
  reportPdf: "/ui/api/report.pdf",
  logsExport: "/ui/api/logs/export",
  auditExport: "/ui/api/audit/export",
  proofCopyAck: "/ui/api/report/proof-copy",
} as const;

export const READ_ROUTES: readonly RouteSpec[] = [
  ...Object.values(READ_PATHS).map((path) => ({
    method: "GET" as const,
    path,
    cls: "read" as const,
    // Only the route that reaches the object store draws from a budget: the
    // others answer from this host alone.
    ...(path === READ_PATHS.verify ? { bucket: "storeOp" as const } : {}),
  })),
  { method: "GET", path: READ_AUDITED_PATHS.report, cls: "read-audited", bucket: "auditedRead" },
  { method: "GET", path: READ_AUDITED_PATHS.reportPdf, cls: "read-audited", bucket: "auditedRead" },
  { method: "GET", path: READ_AUDITED_PATHS.logsExport, cls: "read-audited", bucket: "auditedRead" },
  { method: "GET", path: READ_AUDITED_PATHS.auditExport, cls: "read-audited", bucket: "auditedRead" },
  { method: "POST", path: READ_AUDITED_PATHS.proofCopyAck, cls: "read-audited", bucket: "auditedRead" },
];

// -- The port -----------------------------------------------------------------

export interface ConsoleStatusView {
  daemon: DaemonState;
  /** The copy for that state, so a page never invents its own. */
  copy: string;
  /** The version of the binary SERVING this console. The console cannot read it
   *  from anywhere else without generating a report, and a page that has to
   *  produce an audited artifact to print a version number would record an
   *  export every time somebody looked at it. */
  version: string;
  /** Which lifecycle owns this fortress: a host service manager, or a container
   *  orchestrator. The console says different things about service and update
   *  under each, and guessing wrong promises verb families a container hides. */
  serviceManager: string;
  pid: number | null;
  writtenAt: string | null;
  /** Root identity comparison between the console and the daemon. */
  rootMatch: "same" | "different" | "unknown";
  database: ConsoleDbState;
  /** What the DAEMON says about Postgres, straight from its status file.
   *
   *  The console derives `database` from pg.json alone, and pg.json is written
   *  only once Postgres is ready — so a boot that died before that reads as
   *  "no coordinates", and the page told the operator to start a daemon that
   *  was already running. The daemon knew exactly what happened and nobody
   *  asked it. Null when there is no snapshot to read. */
  daemonPostgres: { phase: string; reason: string | null } | null;
  /** Present only in external mode. Both containment voids, stated. */
  externalBanner?: string[];
}

export interface ConsoleFactsView {
  postgres: ConsolePostgresFacts | null;
  embeddings: ConsoleEmbeddingFacts | null;
  storage: {
    provider: string | null;
    bucket: string | null;
    region: string | null;
    versioning: string;
    lifecycle: string;
  };
}

export interface PostureView {
  state: "fresh" | "stale" | "unavailable" | "never-fetched";
  asOf: string | null;
  cloudOnlySessions: number | null;
  routedHere: number | null;
  qualification: string;
  /** Present when the verifier last measured a clock offset beyond the allowed
   *  skew. Rendered with its remediation; absent when the clock is fine. */
  clockSkew?: { offsetSeconds: number; allowedSeconds: number; remediation: string };
  /** The cloud-witness setting AND its stamp. `hx.set_cloud_witness` cannot be
   *  fenced — the daemon and a leaked roles.json present the same Postgres role
   *  — so recording who last changed it is the whole compensating control, and a
   *  stamp nothing renders is not a control at all. */
  witness: { enabled: boolean; changedAt: string | null; changedBy: string | null } | null;
  /** The latest completed run's failing findings, named. Without this the
   *  compliance surface could say "N sessions have not been acknowledged" and
   *  name none of them, while the only acknowledgeable verdict had no control
   *  anywhere — a page stuck at failed with nothing an operator could do. */
  findings: {
    runStartedAt: string | null;
    total: number;
    shown: number;
    rows: ResidencyFindingRow[];
  } | null;
  /** The latest completed run, whatever it found. Carried separately from
   *  `findings` because a CLEAN run has no findings to hang a timestamp on, and
   *  a compliance surface that cannot say "checked, and clean, at 10:10" is not
   *  reporting the result of the action the operator just took. `null` means no
   *  run has ever completed here — which is not the same as a clean one. */
  lastRun: {
    startedAt: string | null;
    finishedAt: string | null;
    sessionsChecked: number;
    confirmed: number;
    qualification: string | null;
    trigger: string | null;
  } | null;
}

export interface ResidencyFindingRow {
  org: string;
  family: string;
  sessionId: string;
  verdict: string;
  ingestChannel: string | null;
  detail: string | null;
  observedAt: string | null;
  acknowledged: boolean;
  /** Whether THIS verdict is one an acknowledgement can clear. Only
   *  `also_at_letai` is: every other failing verdict is a statement about bytes
   *  that are not here, which no amount of sign-off makes true. */
  acknowledgeable: boolean;
}

export interface CommandView extends CommandRowView {
  corroboration: Corroboration;
  /** Rendered copy for the state. DISPUTED carries the full block. */
  copy: string[];
}

export interface ExportRange {
  from?: string;
  to?: string;
  action?: string;
  actor?: string;
  origin?: string;
  module?: string;
  level?: string;
}

/**
 * Everything the read handlers may do. There is no write here, deliberately: the
 * read class is defined by the absence, and an interface that cannot express a
 * write is an absence a reviewer can check in one place.
 */
export interface ConsoleReadPort {
  status(): Promise<ConsoleStatusView>;
  sessions(query: URLSearchParams): Promise<{
    rows: ConsoleSessionRow[];
    nextCursor?: string;
    totals: ConsoleSessionTotals;
    foreign: ForeignOrgSummary;
  }>;
  people(): Promise<ConsolePersonRow[]>;
  /** The roster, the funnel and everyone sending here the roster does not know. */
  adoption(): Promise<AdoptionView>;
  devices(): Promise<ConsoleDeviceRow[]>;
  growth(days: number): Promise<ConsoleGrowthRow[]>;
  facts(): Promise<ConsoleFactsView>;
  identity(): Promise<IdentityFacts>;
  metrics(): Promise<MetricsSnapshot | null>;
  dataPaths(): Promise<{ title: string; rows: DataPathRow[] }>;
  version(): Promise<RemoteVersion>;
  commands(): Promise<{ rows: CommandRowView[]; records: CommandOutcomeRecord[]; externalPostgres: boolean }>;
  migrations(): Promise<MigrationRunView[]>;
  audit(range: ExportRange & { limit?: number; cursor?: string }): Promise<{ rows: AuditRow[]; nextCursor?: string }>;
  auditExport(range: ExportRange): Promise<{ rows: AuditRow[]; truncated: boolean }>;
  spoolTail(limit: number): Promise<unknown[]>;
  verifySession(key: { family: string; sessionId: string }): Promise<VerifyResult>;
  posture(): Promise<PostureView>;
  logsExport(range: ExportRange & { lines?: number }): Promise<string>;
  report(): Promise<ReportPayload>;
  openEvents(args: { sessionId: string; userLogin: string; lastEventId: string | null }): OpenStreamVerdict;
}

/** The one thing read-AUDITED handlers may do that read handlers may not: append
 *  a durable record of the copy that left. */
export interface ConsoleExportAudit {
  recordExport(entry: {
    what: string;
    actor: string;
    sessionRef: string;
    params: Record<string, unknown>;
  }): Promise<void>;
}

export interface ReadRouteContext {
  port: ConsoleReadPort;
  audit: ConsoleExportAudit;
  /** The signed-in principal, for the export records. */
  actor: string;
  sessionId: string;
  /** Streams, for the events route. */
  streams?: EventStreamRegistry;
}

// -- Helpers ------------------------------------------------------------------

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  // Redacted on the way out, unconditionally. A DSN reaches a response through
  // a driver error nobody wrote a line for, and this is the last place to catch
  // it.
  return new Response(`${JSON.stringify(redactValue(body))}\n`, {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

function refusal(reason: string, status = 400): Response {
  return json({ error: reason }, status);
}

const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** Shape AND value. The pattern alone admits `2026-13-45`, `2026-02-30` and
 *  `9999-99-99T99:99Z`, each of which Postgres rejects with "date/time field
 *  value out of range" — a 500 out of a filter the caller cannot act on, where a
 *  400 naming the field is the honest answer. `Date.parse` is the same calendar
 *  the database uses for the cases that matter (it rejects month 13 and Feb 30
 *  alike), and it is the only check available that does not re-implement one. */
function isInstant(value: string): boolean {
  if (!ISO.test(value)) return false;
  if (!Number.isFinite(Date.parse(value))) return false;
  // `Date.parse` ROLLS OVER where Postgres refuses: `2026-02-30` reads back as
  // 2 March and reports finite, while the database raises "date/time field value
  // out of range". The calendar day is therefore compared against what was
  // written, which is the only way to tell the two apart without shipping a
  // second calendar.
  const [y, m, d] = value.slice(0, 10).split("-").map(Number);
  const back = new Date(Date.UTC(y, m - 1, d));
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d;
}

/** Range and filter, validated HERE. An export whose bounds are trimmed after
 *  the rows come back has already paid the cost the bound exists to prevent, and
 *  its recorded parameters would describe a query the server did not run. */
export function parseExportRange(query: URLSearchParams): { ok: true; range: ExportRange } | { ok: false; reason: string } {
  const range: ExportRange = {};
  for (const key of ["from", "to"] as const) {
    const value = query.get(key);
    if (value === null) continue;
    if (!isInstant(value)) return { ok: false, reason: `${key} must be an ISO-8601 instant` };
    range[key] = value;
  }
  if (range.from && range.to && Date.parse(range.from) > Date.parse(range.to)) {
    return { ok: false, reason: "from must not be later than to" };
  }
  for (const key of ["action", "actor", "origin", "module", "level"] as const) {
    const value = query.get(key);
    if (value === null) continue;
    if (value.length > 200) return { ok: false, reason: `${key} is too long` };
    range[key] = value;
  }
  return { ok: true, range };
}

function positiveInt(raw: string | null, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(1, Math.trunc(n)), max);
}

/** The disposition for a download whose name is server-built. Never derived from
 *  a query parameter: a caller-supplied filename is a header-injection seam. */
function attachment(name: string): Record<string, string> {
  return { "content-disposition": `attachment; filename="${name}"` };
}

// -- The handler --------------------------------------------------------------

/** Null when the path is not a read route - the caller falls through. */
export async function handleReadRoute(
  req: Request,
  ctx: ReadRouteContext,
): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  const { port } = ctx;

  if (req.method === "GET") {
    switch (path) {
      case READ_PATHS.status:
        return json(await port.status());
      case READ_PATHS.sessions: {
        // Validated HERE, like the export range above it. These two reach the
        // query as `::timestamptz` casts, so an unparseable value is not a bad
        // filter that returns nothing — it is a database error thrown out of the
        // handler, which is a 500 the caller cannot act on.
        for (const key of ["from", "to"] as const) {
          const value = url.searchParams.get(key);
          if (value !== null && value !== "" && !isInstant(value)) {
            return refusal(`${key} must be an ISO-8601 instant`);
          }
        }
        const page = await port.sessions(url.searchParams);
        return json(page);
      }
      case READ_PATHS.people:
        return json({ people: await port.people() });
      case READ_PATHS.adoption:
        return json(await port.adoption());
      case READ_PATHS.devices:
        return json({ devices: await port.devices() });
      case READ_PATHS.growth:
        return json({ days: await port.growth(positiveInt(url.searchParams.get("days"), 30, 400)) });
      case READ_PATHS.facts:
        return json(await port.facts());
      case READ_PATHS.identity:
        return json(await port.identity());
      case READ_PATHS.metrics: {
        const metrics = await port.metrics();
        // ABSENT is a state, not a zero: no metrics file means the daemon is not
        // running, and a page rendering zeros would say the opposite.
        return json(metrics ? { metrics } : { metrics: null, reason: "the daemon has published no metrics" });
      }
      case READ_PATHS.dataPaths:
        return json(await port.dataPaths());
      case READ_PATHS.version:
        return json(await port.version());
      case READ_PATHS.commands: {
        const { rows, records, externalPostgres } = await port.commands();
        return json({ commands: rows.map((row) => decorate(row, records, externalPostgres)) });
      }
      case READ_PATHS.migrations:
        return json({ migrations: await port.migrations() });
      case READ_PATHS.audit: {
        const parsed = parseExportRange(url.searchParams);
        if (!parsed.ok) return refusal(parsed.reason);
        const cursor = url.searchParams.get("cursor");
        return json(
          await port.audit({
            ...parsed.range,
            limit: positiveInt(url.searchParams.get("limit"), 100, 500),
            ...(cursor ? { cursor } : {}),
          }),
        );
      }
      case READ_PATHS.spool:
        return json({ records: await port.spoolTail(positiveInt(url.searchParams.get("limit"), 100, 500)) });
      case READ_PATHS.verify: {
        const family = url.searchParams.get("family");
        const sessionId = url.searchParams.get("session");
        if (!family || !sessionId) return refusal("family and session are both required");
        return json(await port.verifySession({ family, sessionId }));
      }
      case READ_PATHS.posture:
        return json(await port.posture());
      case READ_PATHS.events: {
        const verdict = port.openEvents({
          sessionId: ctx.sessionId,
          userLogin: ctx.actor,
          lastEventId: req.headers.get("last-event-id"),
        });
        if (!verdict.ok) {
          return json({ error: verdict.reason }, verdict.status, {
            "retry-after": String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))),
          });
        }
        return verdict.response;
      }

      // -- read-audited ------------------------------------------------------
      case READ_AUDITED_PATHS.report: {
        const payload = await port.report();
        await ctx.audit.recordExport({
          what: "report payload",
          actor: ctx.actor,
          sessionRef: ctx.sessionId,
          params: { format: "json", generatedAt: payload.generatedAt },
        });
        return json(payload);
      }
      case READ_AUDITED_PATHS.reportPdf: {
        const payload = await port.report();
        await ctx.audit.recordExport({
          what: "report PDF",
          actor: ctx.actor,
          sessionRef: ctx.sessionId,
          params: { format: "pdf", generatedAt: payload.generatedAt },
        });
        // Through the SAME belt as the JSON twin one case up. Nothing in a report
        // payload carries a credential shape today; this is the belt, not a fix
        // — the route is reachable by a readonly session and one added field is
        // all it would take.
        const bytes = renderPdf(REPORT_TITLE, reportLines(redactValue(payload)));
        return new Response(bytes.buffer as ArrayBuffer, {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "cache-control": "no-store",
            ...attachment("hx-fortress-report.pdf"),
          },
        });
      }
      case READ_AUDITED_PATHS.logsExport: {
        const parsed = parseExportRange(url.searchParams);
        if (!parsed.ok) return refusal(parsed.reason);
        const lines = positiveInt(url.searchParams.get("lines"), 5_000, 200_000);
        // Recorded BEFORE the read, and with the parameters the server will
        // actually use - never the ones the caller asked for.
        await ctx.audit.recordExport({
          what: "logs export",
          actor: ctx.actor,
          sessionRef: ctx.sessionId,
          params: { ...parsed.range, lines },
        });
        // Through the redactor, like every other value that leaves this console.
        // The daemon log quotes raw driver and SDK errors — a connection string
        // with its password, a rejected object-store key from a rotation — and
        // this route is reachable by a READONLY session.
        const text = redactCredentials(await port.logsExport({ ...parsed.range, lines }));
        return new Response(text, {
          status: 200,
          headers: {
            "content-type": "application/x-ndjson",
            "cache-control": "no-store",
            ...attachment("hx-fortress-logs.jsonl"),
          },
        });
      }
      case READ_AUDITED_PATHS.auditExport: {
        const parsed = parseExportRange(url.searchParams);
        if (!parsed.ok) return refusal(parsed.reason);
        await ctx.audit.recordExport({
          what: "audit export",
          actor: ctx.actor,
          sessionRef: ctx.sessionId,
          // Never collapsed with another export's record: the parameters ARE the
          // answer to "which copy left".
          params: { ...parsed.range },
        });
        const { rows, truncated } = await port.auditExport(parsed.range);
        if (truncated) {
          return refusal(
            "that range holds more records than one export may carry - narrow it with from/to and " +
              "export again. A short export that looked complete would be worse than none.",
            413,
          );
        }
        // REDACTED, like every other body that leaves. Its sibling two cases up
        // (`logsExport`) says why in its own comment — this route is reachable
        // by a READONLY session — and this one, which serialises rows straight
        // out of the audit table, did not. `error` is a thrown message and the
        // paged view of the same rows redacts it, so the export was the one way
        // to read a credential the panel would not show.
        return new Response(`${rows.map((r) => JSON.stringify(redactValue(r))).join("\n")}\n`, {
          status: 200,
          headers: {
            "content-type": "application/x-ndjson",
            "cache-control": "no-store",
            ...attachment("hx-fortress-audit.jsonl"),
          },
        });
      }
      default:
        return null;
    }
  }

  if (req.method === "POST" && path === READ_AUDITED_PATHS.proofCopyAck) {
    const parsed = parseExportRange(url.searchParams);
    if (!parsed.ok) return refusal(parsed.reason);
    const acknowledgedAt = new Date().toISOString();
    await ctx.audit.recordExport({
      what: "proof-copy ack",
      actor: ctx.actor,
      sessionRef: ctx.sessionId,
      // A residency proof is about ONE session, so the record names it. Without
      // that the trail could say a proof was copied but not of what, which is
      // the same gap that makes an unparameterized export record useless.
      params: { ...parsed.range, ...proofSubject(url.searchParams), acknowledgedAt },
    });
    return json({ acknowledgedAt, actor: ctx.actor });
  }

  return null;
}

/** The session a copied proof was about, when the caller named one. Bounded and
 *  copied verbatim - these are recorded, and a recorded field is not a place to
 *  put an unbounded string. */
function proofSubject(query: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["family", "session", "verdict"] as const) {
    const value = query.get(key);
    if (value !== null && value.length > 0 && value.length <= 200) out[key] = value;
  }
  return out;
}

/** Attach the corroboration verdict and its copy. Computed here, never stored:
 *  the read class writes nothing, and DISPUTED in particular is RENDERED from
 *  evidence rather than recorded as a fact of its own. */
function decorate(
  row: CommandRowView,
  records: readonly CommandOutcomeRecord[],
  externalPostgres: boolean,
): CommandView {
  if (!isTerminalStatus(row.status)) {
    return {
      ...row,
      corroboration: { state: "awaiting", expectedDigest: "", records: 0 },
      copy: [],
    };
  }
  const corroboration = corroborationOf({
    commandId: row.id,
    status: row.status,
    outcome: row.outcome,
    error: row.error,
    completedAt: row.completedAt,
    records,
  });
  return { ...row, corroboration, copy: corroborationLines(row, corroboration, externalPostgres) };
}

function corroborationLines(
  row: CommandRowView,
  corroboration: Corroboration,
  externalPostgres: boolean,
): string[] {
  if (corroboration.state !== "disputed") return [];
  return disputedCopy({
    commandId: row.id,
    commandKind: row.kind,
    arm: corroboration.arm ?? "fabricated",
    auditLink: `${READ_PATHS.audit}?action=console.command.outcome&actor=${encodeURIComponent(row.id)}`,
    externalPostgres,
  });
}
