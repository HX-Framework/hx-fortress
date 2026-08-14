// The read port, over the things that actually hold the answers: the console's
// own Postgres handle, the daemon's 0600 runtime files, the resolved
// configuration and the object store.
//
// It is separated from the handlers so the handlers can be tested without any of
// it, and so the DEGRADED paths live in one place. Every method here answers
// even when its source is missing - a null, an empty list, an honest
// "unavailable" - because the console's whole job on a broken fortress is to say
// what is broken, and an endpoint that throws when Postgres is down is an
// endpoint that renders a blank page at exactly the moment somebody needs it.

import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  adoptionStages,
  ADOPTION_ACTIVE_DAYS,
  attentionRows,
  rosterTeams,
  type AdoptionCounts,
  type AdoptionStageView,
  type AttentionRow,
  type TeamSummary,
} from "../console/adoption";
import { readSpool } from "../console/audit-spool";

/** One row of `auditLastRunQuery`. */
interface LastRunRow {
  startedAt: unknown;
  finishedAt: unknown;
  sessionsChecked: unknown;
  confirmed: unknown;
  qualification: string | null;
  trigger: string | null;
}

/** One row of `auditFindingsQuery`, as the driver hands it back. */
interface FindingRow {
  org: string;
  family: string;
  sessionId: string;
  verdict: string;
  ingestChannel: string | null;
  detail: string | null;
  observedAt: unknown;
  acknowledged: unknown;
  runStartedAt: unknown;
  total: unknown;
}

/** timestamptz comes back as a Date from the driver and as a string from a
 *  serialized row; both have to reach the page as one shape. */
function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}
import { readRosterSyncState, type RosterSyncState } from "../console/roster";
import { redactedMessage } from "./redact";
import type { MetricsSnapshot } from "../console/metrics";
import {
  postureFreshness,
  postureQualification,
  RoutingPostureCache,
  routingPosturePath,
} from "../cloud/fortress-query";
import type { CloudCredential } from "../cloud/credentials";
import { daemonState, DAEMON_STATE_COPY, compareRoots } from "../daemon-state";
import type { HxDb } from "../host/postgres/db";
import type { fortressPaths } from "../host/paths";
import type { HostStatusSnapshot } from "../host/types";
import { readLastLines, rotateKeepFromEnv } from "../log-tail";
import { BUCKET_CONFIG_UNAVAILABLE, type SessionStore } from "../modules/session-vault/store/types";
import {
  auditExportQuery,
  auditFindingsQuery,
  auditLastRunQuery,
  auditPageQuery,
  auditPageLimit,
  AUDIT_EXPORT_MAX,
  commandsQuery,
  drainedOutcomesQuery,
  encodeAuditCursor,
  type AuditRow,
  type CommandRowView,
} from "../query/console/audit";
import { readWitnessSetting } from "../console/audit-store";
import { acknowledgeable, type ResidencyVerdict } from "../console/audit-verdicts";
import {
  consoleDevicesQuery,
  consoleEmbeddingFactsQuery,
  consoleGrowthQuery,
  consolePeopleQuery,
  consolePostgresFactsQuery,
  type ConsoleDeviceRow,
  type ConsoleEmbeddingFacts,
  type ConsoleGrowthRow,
  type ConsolePersonRow,
  type ConsolePostgresFacts,
} from "../query/console/inventory";
import { migrationRunsQuery, type MigrationRunView } from "../query/console/migrations";
import {
  consoleAdoptionCountsQuery,
  consoleRosterQuery,
  consoleUnrosteredQuery,
  type AdoptionCountsRow,
  type RosterPersonRow,
  type UnrosteredPersonRow,
} from "../query/console/roster";
import {
  consolePageLimit,
  consoleSessionByKeyQuery,
  consoleSessionTotalsQuery,
  consoleSessionsQuery,
  encodeConsoleCursor,
  type ConsoleSessionRow,
  type ConsoleSessionTotals,
} from "../query/console/sessions";
import {
  foreignOrgCountQuery,
  foreignOrgLabel,
  type ConsoleUniverse,
  type ForeignOrgSummary,
} from "../query/console/universe";
import { parseCommandOutcomes, type CommandOutcomeRecord } from "./corroboration";
import { externalContainmentBanner, type ConsoleDbState } from "./console-db";
import { dataPathRows, EGRESS_TITLE, type EgressInputs } from "./egress";
import type { EventStreamRegistry, EventProducer, OpenStreamVerdict } from "./events";
import { readIdentityFacts, type IdentityFacts } from "./identity";
import type {
  ConsoleFactsView,
  ConsoleReadPort,
  ConsoleStatusView,
  ExportRange,
  PostureView,
} from "./read-routes";
import type { ReportPayload } from "./report";
import { verifySessionResidency, type VerifyResult } from "./residency-verify";
import { fetchRemoteFortressVersion, type RemoteVersion } from "./version-check";
import { FORTRESS_VERSION } from "../version";

type FortressPaths = ReturnType<typeof fortressPaths>;

/** Rows out of a Bun.SQL result, whichever shape the driver hands back. */
function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const wrapped = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(wrapped) ? (wrapped as T[]) : [];
}

export interface ConsoleReadPortDeps {
  paths: FortressPaths;
  universe: ConsoleUniverse;
  /** Absent when the database is not reachable; every method degrades. */
  db: () => HxDb | null;
  /** Settle the database handle — resolves when the current attempt to open it
   *  has finished, however it finished. De-duplicated by the mount, so calling
   *  it on every request costs one attempt, not one per caller. */
  awaitDb?: () => Promise<void>;
  database: () => ConsoleDbState;
  /** The daemon's published snapshot, or null. */
  status: () => Promise<HostStatusSnapshot | null>;
  service: () => Promise<{ loaded: boolean; pid: number | null } | null>;
  /** The name of the lifecycle owner, as the CLI resolved it. */
  serviceManager: () => string;
  credentials: () => Promise<CloudCredential | null>;
  egress: () => Promise<EgressInputs>;
  /** The vault store, when one is configured. Bucket facts degrade without it. */
  store: () => SessionStore | null;
  /** Size of one session's canonical object, or null when there is none.
   *  Rejecting (or absent) means the store could not be asked, which the verdict
   *  reports as unchecked rather than as absence — the two are different facts,
   *  and only one of them is an incident. */
  canonicalBytes?: (key: {
    /** The store's key is the user's EXTERNAL id, which is why the row has to be
     *  found before the bucket can be asked anything at all. */
    userId: string;
    family: string;
    sessionId: string;
  }) => Promise<number | null>;
  /** The bucket this fortress serves from RIGHT NOW. Asked rather than held: a
   *  rotation or a migration swap moves it under a console that is already
   *  running, and a compliance surface naming the previous one is a false
   *  statement about where the data lives. */
  bucket: () => Promise<{ provider: string; name: string; region: string | null } | null>;
  streams: EventStreamRegistry;
  /** Whether this login may still hold an open stream. The registry has always
   *  taken a `stillValid` belt and nothing ever passed one, so a revoked or
   *  disabled operator kept receiving the live daemon log — which quotes driver
   *  and SDK errors — until the idle sweep fired, up to an hour later. */
  sessionStillValid?: (sessionId: string) => boolean | Promise<boolean>;
  /** What an opened stream carries. */
  producer: EventProducer;
  downloadBase: () => string | null;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

/** Everything the adoption page renders, in one answer: who the organization
 *  employs, what the roster says they have, and what this host has actually
 *  seen. The two halves stay labelled all the way to the screen. */
export interface AdoptionView {
  sync: RosterSyncState | null;
  counts: AdoptionCounts;
  stages: AdoptionStageView[];
  roster: RosterPersonRow[];
  unrostered: UnrosteredPersonRow[];
  teams: TeamSummary[];
  attention: AttentionRow[];
}

/** jsonb comes back as whatever the driver made of it. A member whose teams
 *  arrive unusable belongs to no team, which is a valid answer — never a crash
 *  in a group-by. */
function normalizeRosterRow(row: RosterPersonRow): RosterPersonRow {
  const teams = Array.isArray(row.teams) ? row.teams.filter((t) => typeof t === "string") : [];
  return { ...row, teams, active: row.active === true };
}

/** The verifier's last measured clock offset, when it has measured one. Absent
 *  is the common case and renders nothing - a warning that is always on is a
 *  warning nobody reads. */
interface ClockSkewFile {
  offsetSeconds: number;
  allowedSeconds: number;
  measuredAt: string;
}

/** What the console says when it has no database to ask. Operator-legible on
 *  purpose: it is the sentence a page will show. */
export const CONSOLE_DB_UNREACHED =
  "this console has not reached the fortress's database yet — see the Postgres page for why";

export function createConsoleReadPort(deps: ConsoleReadPortDeps): ConsoleReadPort {
  const now = deps.now ?? ((): Date => new Date());
  const env = deps.env ?? process.env;
  const postureCache = new RoutingPostureCache(routingPosturePath(deps.paths.runtimeRoot));

  /**
   * For the callers that already model "no answer" as UNKNOWN.
   *
   * `facts()` returns `postgres: null` / `embeddings: null` and the page renders
   * those as "no answer from this fortress yet" — a true statement. Storage
   * facts come from the credential file and are knowable with Postgres down, so
   * refusing the whole call would hide something the console does know.
   */
  const queryIfReachable = async <T>(build: () => unknown): Promise<T[]> => {
    const db = deps.db();
    if (!db) return [];
    return rows<T>(await db.execute(build() as never));
  };

  /**
   * Run a query, or REFUSE — never invent an empty result.
   *
   * `[]` for "there is no database" was the same mistake as `?? 0`, one layer
   * lower: `totals()` substitutes a zero row when a query returns no rows, so a
   * console that had not yet reached Postgres answered 200 with
   * `sessions: 0, people: 0, bytes: 0` — a confident statement that this
   * fortress holds nothing, indistinguishable to the page from a fortress that
   * genuinely does. No loader on the client can correct that, because the client
   * was told a number. A refusal is the honest answer, and the page has a screen
   * for it.
   */
  const query = async <T>(build: () => unknown): Promise<T[]> => {
    let db = deps.db();
    if (!db) {
      // TRY, THEN SAY. `db()` returns null while merely KICKING OFF the
      // connection, so the first request after a boot lost a race with it and
      // the console told the operator it "has not reached the database" before
      // it had attempted to. That is a false statement with a real cost: the
      // first screen after signing in was an error about a fortress that was
      // fine, and it cleared only on a manual refresh.
      await deps.awaitDb?.();
      db = deps.db();
    }
    if (!db) throw new Error(CONSOLE_DB_UNREACHED);
    return rows<T>(await db.execute(build() as never));
  };

  const bucketFacts = async (): Promise<{ versioning: string; lifecycle: string }> => {
    const store = deps.store();
    if (!store) {
      return { versioning: BUCKET_CONFIG_UNAVAILABLE, lifecycle: BUCKET_CONFIG_UNAVAILABLE };
    }
    const [versioning, lifecycle] = await Promise.all([
      store.getBucketVersioning().catch(() => BUCKET_CONFIG_UNAVAILABLE),
      store.getLifecycle().catch(() => BUCKET_CONFIG_UNAVAILABLE),
    ]);
    return { versioning, lifecycle };
  };

  const totals = async (): Promise<ConsoleSessionTotals> => {
    const [row] = await query<ConsoleSessionTotals>(() => consoleSessionTotalsQuery(deps.universe));
    return (
      row ?? { sessions: 0, people: 0, bytes: 0, tunnel: 0, gateway: 0, unknownProvenance: 0 }
    );
  };

  const foreign = async (): Promise<ForeignOrgSummary> => {
    const [row] = await query<{ sessions: number }>(() => foreignOrgCountQuery(deps.universe));
    const count = row?.sessions ?? 0;
    return { sessions: count, label: foreignOrgLabel(count) };
  };

  const posture = async (): Promise<PostureView> => {
    const snapshot = await postureCache.read();
    const at = now().getTime();
    const state = postureFreshness(snapshot, at);
    const data = snapshot?.data;
    // Both come from the audit's own tables, so a database this console cannot
    // reach degrades them to null rather than failing the whole panel — the rest
    // of the posture is read from the published snapshot and is still true.
    const db = deps.db();
    const witness = db
      ? await readWitnessSetting(db).catch(() => null)
      : null;
    // `null` means UNKNOWN — no database, or the query failed — and the page
    // says so rather than rendering an empty list, which reads as "nothing to
    // act on" on a compliance surface.
    const findingRows = db
      ? await query<FindingRow>(() => auditFindingsQuery()).catch(() => null)
      : null;
    // Read separately, for the same reason it is carried separately: a clean run
    // has no finding row to hang its timestamp on.
    const runRows = db ? await query<LastRunRow>(() => auditLastRunQuery()).catch(() => null) : null;

    const view: PostureView = {
      state,
      asOf: snapshot?.fetchedAt ?? null,
      cloudOnlySessions: data?.cloudOnlySessions ?? null,
      routedHere: data?.routedHere ?? null,
      qualification: postureQualification(snapshot, data?.cloudOnlySessions ?? 0, at),
      witness,
      lastRun: runRows?.[0]
        ? {
            startedAt: isoOrNull(runRows[0].startedAt),
            finishedAt: isoOrNull(runRows[0].finishedAt),
            sessionsChecked: Number(runRows[0].sessionsChecked ?? 0),
            confirmed: Number(runRows[0].confirmed ?? 0),
            qualification: runRows[0].qualification ?? null,
            trigger: runRows[0].trigger ?? null,
          }
        : null,
      findings: findingRows
        ? {
            runStartedAt: isoOrNull(findingRows[0]?.runStartedAt),
            total: Number(findingRows[0]?.total ?? 0),
            shown: findingRows.length,
            rows: findingRows.map((row) => ({
              org: row.org,
              family: row.family,
              sessionId: row.sessionId,
              verdict: row.verdict,
              ingestChannel: row.ingestChannel,
              detail: row.detail,
              observedAt: isoOrNull(row.observedAt),
              // Both, and the flag is AND-ed with the verdict rather than left
              // to the page to combine: an acknowledgement clears exactly one
              // verdict, and a row that renders "acknowledged" over any other is
              // a green pill on a still-failing incident.
              acknowledged:
                row.acknowledged === true && acknowledgeable(row.verdict as ResidencyVerdict),
              acknowledgeable: acknowledgeable(row.verdict as ResidencyVerdict),
            })),
          }
        : null,
    };
    const skew = await readJsonFile<ClockSkewFile>(path.join(deps.paths.runtimeRoot, "clock-skew.json"));
    if (skew && Math.abs(skew.offsetSeconds) > skew.allowedSeconds) {
      view.clockSkew = {
        offsetSeconds: skew.offsetSeconds,
        allowedSeconds: skew.allowedSeconds,
        remediation:
          "This host's clock is outside the allowed skew, which makes one-click entry from the " +
          "workbench fail with a clock_skew page. Enable NTP on this host (timedatectl set-ntp true), " +
          "then retry.",
      };
    }
    return view;
  };

  const identity = async (): Promise<IdentityFacts> => {
    const snapshot = await deps.status().catch(() => null);
    const database = deps.database();
    return readIdentityFacts({
      paths: deps.paths,
      credentials: await deps.credentials().catch(() => null),
      daemonRoot: snapshot?.host.root ?? null,
      postgresMode: database.kind === "ready" ? database.mode : "unknown",
      env,
    });
  };

  return {
    async status(): Promise<ConsoleStatusView> {
      const [snapshot, service] = await Promise.all([
        deps.status().catch(() => null),
        deps.service().catch(() => ({ loaded: false, pid: null }) as { loaded: boolean; pid: number | null } | null),
      ]);
      const state = daemonState({ service, snapshot, now: now() });
      const database = deps.database();
      const view: ConsoleStatusView = {
        daemon: state,
        copy: DAEMON_STATE_COPY[state],
        version: FORTRESS_VERSION,
        serviceManager: deps.serviceManager(),
        pid: snapshot?.host.pid ?? null,
        writtenAt: snapshot?.host.writtenAt ?? null,
        rootMatch: await compareRoots(deps.paths.root, snapshot?.host.root),
        database,
        daemonPostgres: snapshot
          ? { phase: snapshot.postgres.phase, reason: snapshot.postgres.reason }
          : null,
      };
      if (database.kind === "ready" && database.mode === "external") {
        view.externalBanner = externalContainmentBanner();
      }
      return view;
    },

    async sessions(params) {
      const limit = consolePageLimit(Number(params.get("limit") ?? undefined));
      const input = {
        universe: deps.universe,
        limit,
        ...pick(params, "search", "family", "userExternalId", "from", "to", "cursor"),
      };
      const found = await query<ConsoleSessionRow>(() => consoleSessionsQuery(input));
      const hasMore = found.length > limit;
      const page = hasMore ? found.slice(0, limit) : found;
      const last = page[page.length - 1];
      const [t, f] = await Promise.all([totals(), foreign()]);
      return {
        rows: page,
        ...(hasMore && last
          ? { nextCursor: encodeConsoleCursor({ lastActivityAt: last.lastActivityAt, id: last.id }) }
          : {}),
        totals: t,
        foreign: f,
      };
    },

    people: () => query<ConsolePersonRow>(() => consolePeopleQuery(deps.universe)),

    async adoption(): Promise<AdoptionView> {
      const db = deps.db();
      const sync = db ? await readRosterSyncState(db).catch(() => null) : null;
      const [counts] = await query<AdoptionCountsRow>(() =>
        consoleAdoptionCountsQuery(deps.universe, ADOPTION_ACTIVE_DAYS),
      );
      const roster = (await query<RosterPersonRow>(() => consoleRosterQuery(deps.universe))).map(
        normalizeRosterRow,
      );
      const unrostered = await query<UnrosteredPersonRow>(() =>
        consoleUnrosteredQuery(deps.universe),
      );
      const totals: AdoptionCounts = counts ?? {
        rostered: 0,
        installed: 0,
        syncComplete: 0,
        sending: 0,
        active: 0,
        formerMembers: 0,
        unrostered: 0,
      };
      return {
        // Null means no roster has EVER arrived, which the page says in its own
        // words — never as an organization with nobody in it.
        sync,
        counts: totals,
        stages: adoptionStages(totals),
        roster,
        unrostered,
        teams: rosterTeams(roster),
        attention: attentionRows(roster, now().getTime()),
      };
    },
    devices: () => query<ConsoleDeviceRow>(() => consoleDevicesQuery(deps.universe)),
    growth: (days) => query<ConsoleGrowthRow>(() => consoleGrowthQuery(deps.universe, days)),

    async facts(): Promise<ConsoleFactsView> {
      const [pg] = await queryIfReachable<ConsolePostgresFacts>(() =>
        consolePostgresFactsQuery(deps.universe),
      );
      const [embeddings] = await queryIfReachable<ConsoleEmbeddingFacts>(() =>
        consoleEmbeddingFactsQuery(),
      );
      const bucket = await deps.bucket();
      const facts = await bucketFacts();
      return {
        postgres: pg ?? null,
        embeddings: embeddings ?? null,
        storage: {
          provider: bucket?.provider ?? null,
          bucket: bucket?.name ?? null,
          region: bucket?.region ?? null,
          ...facts,
        },
      };
    },

    identity,

    async metrics(): Promise<MetricsSnapshot | null> {
      return readJsonFile<MetricsSnapshot>(deps.paths.metrics);
    },

    async dataPaths() {
      return { title: EGRESS_TITLE, rows: dataPathRows(await deps.egress()) };
    },

    async version(): Promise<RemoteVersion> {
      const base = deps.downloadBase();
      if (!base) {
        return {
          kind: "unavailable",
          reason: "this fortress is not enrolled, so it has no release origin to ask",
          checkedAt: now().toISOString(),
          cached: false,
        };
      }
      return fetchRemoteFortressVersion(base);
    },

    async commands() {
      const rowsOut = await query<CommandRowView>(() => commandsQuery());
      const ids = rowsOut.map((r) => r.id);
      // Tail FIRST, table second. Both feed one ANY-MATCH predicate, so a
      // command corroborated before the drain still reads confirmed once its
      // spool file has been reclaimed.
      const tail = parseCommandOutcomes(
        (await readSpool(deps.paths.auditSpool).catch(() => [])).map((r) => ({
          action: r.action,
          kind: r.kind,
          sessionRef: r.sessionRef,
          params: r.params,
        })),
      );
      const drained = parseCommandOutcomes(
        await query<{ sessionRef: string | null; action: string; kind: string; params: unknown }>(() =>
          drainedOutcomesQuery(ids),
        ),
      );
      const database = deps.database();
      const records: CommandOutcomeRecord[] = [...tail, ...drained];
      return {
        rows: rowsOut,
        records,
        externalPostgres: database.kind === "ready" && database.mode === "external",
      };
    },

    async migrations() {
      const found = await query<MigrationRunView>(() => migrationRunsQuery());
      // bytea-sized counters come back as strings on some drivers, and a page
      // that formatted "1024" as bytes and "1024" as a string reads differently.
      return found.map((run) => ({
        ...run,
        sessionsTotal: Number(run.sessionsTotal ?? 0),
        sessionsCopied: Number(run.sessionsCopied ?? 0),
        bytesCopied: Number(run.bytesCopied ?? 0),
        deltaPasses: Number(run.deltaPasses ?? 0),
      }));
    },

    async audit(range) {
      const limit = auditPageLimit(range.limit);
      const found = await query<AuditRow>(() => auditPageQuery({ ...range, limit }));
      const hasMore = found.length > limit;
      const page = hasMore ? found.slice(0, limit) : found;
      const last = page[page.length - 1];
      return hasMore && last
        ? { rows: page, nextCursor: encodeAuditCursor({ ts: last.ts, id: last.id }) }
        : { rows: page };
    },

    async auditExport(range) {
      const found = await query<AuditRow>(() => auditExportQuery(range));
      return found.length > AUDIT_EXPORT_MAX
        ? { rows: [], truncated: true }
        : { rows: found, truncated: false };
    },

    async verifySession(key): Promise<VerifyResult> {
      const [row] = await query<ConsoleSessionRow>(() =>
        consoleSessionByKeyQuery(deps.universe, key),
      );
      const ask = deps.canonicalBytes;
      let canonical: { bytes: number | null } | null = null;
      let unavailable = "this console holds no handle to the object store";
      if (!row) {
        // The object path is keyed on the person's external id, which only the
        // row carries. Without it there is no prefix to stat, and guessing one
        // would turn "we could not look" into "it is not there".
        unavailable = "there is no metadata row here to resolve the object's prefix from";
      } else if (ask) {
        try {
          canonical = { bytes: await ask({ ...key, userId: row.userExternalId }) };
        } catch (err) {
          unavailable = redactedMessage(err);
        }
      }
      return verifySessionResidency({
        family: key.family,
        sessionId: key.sessionId,
        row: row
          ? {
              bytesUploaded: row.bytesUploaded ?? null,
              ingestChannel: row.ingestChannel,
              lastActivityAt: row.lastActivityAt,
            }
          : null,
        ...(canonical ? { canonicalBytes: canonical.bytes } : { storeUnavailable: unavailable }),
        // Staging chunks are composed and removed by the ingest path; nothing in
        // the store interface lists one session's leftovers without a
        // whole-bucket scan, so this console does not claim to have looked.
      });
    },

    async spoolTail(limit) {
      const records = await readSpool(deps.paths.auditSpool).catch(() => []);
      return records.slice(-limit);
    },

    posture,

    async logsExport(range: ExportRange & { lines?: number }) {
      const lines = await readLastLines(
        deps.paths.log,
        range.lines ?? 5_000,
        rotateKeepFromEnv(env),
      );
      const kept = filterLogLines(lines, range);
      return kept.length === 0 ? "" : `${kept.join("\n")}\n`;
    },

    async report(): Promise<ReportPayload> {
      const [facts, t, f, p, id] = await Promise.all([
        bucketFacts(),
        totals(),
        foreign(),
        posture(),
        identity(),
      ]);
      const bucket = await deps.bucket();
      return {
        generatedAt: now().toISOString(),
        version: FORTRESS_VERSION,
        identity: id,
        totals: t,
        foreign: f,
        storage: {
          provider: bucket?.provider ?? null,
          bucket: bucket?.name ?? null,
          region: bucket?.region ?? null,
          ...facts,
        },
        posture: {
          state: p.state,
          asOf: p.asOf,
          cloudOnlySessions: p.cloudOnlySessions,
          routedHere: p.routedHere,
          qualification: p.qualification,
        },
        dataPaths: dataPathRows(await deps.egress()),
      };
    },

    openEvents(args): OpenStreamVerdict {
      return deps.streams.open({
        sessionId: args.sessionId,
        userLogin: args.userLogin,
        lastEventId: args.lastEventId,
        producer: deps.producer,
        ...(deps.sessionStillValid
          ? { stillValid: (): boolean | Promise<boolean> => deps.sessionStillValid!(args.sessionId) }
          : {}),
      });
    },
  };
}

function pick(params: URLSearchParams, ...keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = params.get(key);
    if (value !== null && value !== "") out[key] = value;
  }
  return out;
}

async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Range and filter, applied SERVER-side.
 *
 * The client-side download this replaced pulled the whole log into a tab and
 * sliced it there - a memory problem on a large file, and an export nothing
 * recorded. Exported so the filtering can be asserted without a log file, since
 * "the server enforced it" is the property, not "the endpoint returned bytes".
 *
 * A line that does not parse as a record is kept only when no filter was asked
 * for. Dropping it under a filter is the safe direction: an unparseable line
 * cannot be shown to satisfy a module or a range, and including it would let a
 * filtered export carry records the filter excluded.
 */
export function filterLogLines(
  lines: readonly string[],
  range: ExportRange,
): string[] {
  const from = range.from ? Date.parse(range.from) : null;
  const to = range.to ? Date.parse(range.to) : null;
  const unfiltered = !range.module && !range.level && from === null && to === null;
  return lines.filter((line) => {
    const record = parseLine(line);
    if (!record) return unfiltered;
    if (range.module && record.module !== range.module) return false;
    if (range.level && record.level !== range.level) return false;
    const at = typeof record.ts === "string" ? Date.parse(record.ts) : NaN;
    if (from !== null && (!Number.isFinite(at) || at < from)) return false;
    if (to !== null && (!Number.isFinite(at) || at > to)) return false;
    return true;
  });
}

function parseLine(line: string): { module?: string; level?: string; ts?: string } | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" ? (value as { module?: string; level?: string; ts?: string }) : null;
  } catch {
    return null;
  }
}
