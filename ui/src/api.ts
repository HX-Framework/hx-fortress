// The console's one door to the fortress.
//
// Every call goes through `request` below, so four decisions are made once
// rather than at forty call sites: the session rides the x-fortress-ui-token
// HEADER (never a cookie — a cookie is attached by the browser to requests an
// attacker can cause, which is what makes CSRF a category), a 401 signs the tab
// out instead of leaving a page rendering stale numbers, an error carries the
// server's own sentence rather than one invented here, and nothing is retried
// silently.
//
// There is no mock layer. A page renders what a fortress answered, or it renders
// the reason it could not — never a plausible number.

import { EVENTS_BACKOFF_MS, EVENTS_PATH } from "../../src/ui/events";
// The header names are the SERVER's, imported across a boundary this file
// already crosses. Restated here, a rename on one side is a console that stops
// authenticating with no build error to say so.
import { SESSION_HEADER, SETUP_TOKEN_HEADER } from "../../src/ui/wire";

/** Per TAB, not per browser: localStorage would widen an XSS from "read this
 *  tab" to "read every tab, forever". The visible consequence is that a second
 *  tab signs in again, and the sign-in copy says so. */
const TOKEN_KEY = "hx-fortress-ui-token";

export const API = {
  session: "/ui/api/session",
  ssoExchange: "/ui/api/sso/exchange",
  setupStatus: "/ui/api/setup/status",
  setupComplete: "/ui/api/setup/complete",
  status: "/ui/api/status",
  service: "/ui/api/service",
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
  migrations: "/ui/api/migrations",
  audit: "/ui/api/audit",
  spool: "/ui/api/spool",
  verify: "/ui/api/sessions/verify",
  posture: "/ui/api/posture",
  events: EVENTS_PATH,
  report: "/ui/api/report",
  reportPdf: "/ui/api/report.pdf",
  logsExport: "/ui/api/logs/export",
  auditExport: "/ui/api/audit/export",
  proofCopyAck: "/ui/api/report/proof-copy",
} as const;

// ── the session token ────────────────────────────────────────────────────────

export function readToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeToken(token: string | null): void {
  try {
    if (token === null) sessionStorage.removeItem(TOKEN_KEY);
    else sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // A browser with storage denied can still hold the token for this page's
    // lifetime; the reload behaviour degrades, nothing else does.
  }
}

/** The status of an answer that never arrived. Every real HTTP status is
 *  non-zero, so a page can distinguish "the console is gone" from "the console
 *  said no" without parsing a message. */
export const NO_ANSWER = 0;

/** Raised when the fortress refused. `status` is the server's, `message` is the
 *  server's sentence — the console does not paraphrase a refusal. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** True when the message is the FORTRESS's own sentence rather than this
     *  client's description of a bare status. A screen that would otherwise
     *  print "the fortress answered 405" at a person can check this and say
     *  something a person can act on instead. */
    readonly fromBody: boolean,
    readonly recovery?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Set by the app so a 401 anywhere lands the tab back on sign-in. */
let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

async function errorFrom(res: Response): Promise<ApiError> {
  let message = `the fortress answered ${res.status}`;
  let fromBody = false;
  let recovery: string | undefined;
  try {
    const body = (await res.json()) as { error?: unknown; recovery?: unknown };
    if (typeof body.error === "string") {
      message = body.error;
      fromBody = true;
    }
    if (typeof body.recovery === "string") recovery = body.recovery;
  } catch {
    // A refusal with no JSON body — the status is the whole answer.
  }
  const retryAfter = Number(res.headers.get("retry-after"));
  return new ApiError(
    res.status,
    message,
    fromBody,
    recovery,
    Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
  );
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** The setup/entry token, which rides a header and never a URL. */
  setupToken?: string;
  /** Suppresses the sign-out on 401 — the sign-in probe itself must not. */
  anonymous?: boolean;
  signal?: AbortSignal;
}

async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = readToken();
  if (token && !options.anonymous) headers[SESSION_HEADER] = token;
  if (options.setupToken) headers[SETUP_TOKEN_HEADER] = options.setupToken;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch {
    // The console did not answer at all - it restarted, it was stopped, or the
    // network between here and it went away. Status 0 is how the app tells that
    // apart from a fortress that answered with a refusal.
    throw new ApiError(
      NO_ANSWER,
      "this console did not answer — it may be restarting after an update",
      false,
    );
  }
  if (res.status === 401 && !options.anonymous) {
    writeToken(null);
    onUnauthorized();
  }
  if (!res.ok) throw await errorFrom(res);
  return res;
}

async function getJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return (await request(path, options)).json() as Promise<T>;
}

// ── shapes, as the read API answers them ─────────────────────────────────────

export type DaemonState =
  | "stopped"
  | "loaded"
  | "starting"
  | "running"
  | "pre-heartbeat"
  | "stale"
  | "failed";

export type ConsoleDbState =
  | { kind: "ready"; mode: "embedded" | "external"; dsn: string }
  | { kind: "not-configured" }
  | { kind: "role-not-provisioned"; detail: string }
  | { kind: "postgres-stopped"; detail: string }
  | { kind: "unavailable"; detail: string };

export interface StatusView {
  daemon: DaemonState;
  copy: string;
  version: string;
  serviceManager: string;
  pid: number | null;
  writtenAt: string | null;
  rootMatch: "same" | "different" | "unknown";
  database: ConsoleDbState;
  /** What the DAEMON says about Postgres. `database` above is derived from
   *  pg.json, which only exists once Postgres is READY — so on a failed boot it
   *  reads "no coordinates" and says nothing about why. This is the daemon's
   *  own verdict, and it is the one that names the cause. */
  daemonPostgres: { phase: string; reason: string | null } | null;
  externalBanner?: string[];
}

export interface SessionRow {
  id: string;
  sessionId: string;
  family: string;
  title: string | null;
  titleSource: string | null;
  cwd: string | null;
  gitBranch: string | null;
  sourcePath: string | null;
  ingestChannel: string | null;
  eventCount: number;
  userTextCount: number;
  assistantCount: number;
  toolCallCount: number;
  inputTokens: number | string;
  outputTokens: number | string;
  estCostUsd: number | null;
  bytesUploaded: number | string;
  chunkCount: number;
  firstEventAt: string | null;
  lastActivityAt: string | null;
  userExternalId: string;
  userDisplayName: string | null;
  deviceName: string | null;
  repoSlug: string | null;
}

export interface SessionTotals {
  sessions: number;
  people: number;
  bytes: number | string;
  tunnel: number;
  gateway: number;
  unknownProvenance: number;
}

export interface SessionsPage {
  rows: SessionRow[];
  nextCursor?: string;
  totals: SessionTotals;
  foreign: { sessions: number; label: string };
}

export interface PersonRow {
  userExternalId: string;
  displayName: string | null;
  sessions: number;
  bytes: number | string;
  devices: number;
  lastActivityAt: string | null;
  lastUploadAt: string | null;
}

export interface RosterPersonRow {
  externalId: string;
  displayName: string;
  email: string | null;
  teams: string[];
  installed: number;
  lastSeenAt: string | null;
  lastUploadAt: string | null;
  syncTotal: number | null;
  syncDone: number | null;
  syncReportedAt: string | null;
  active: boolean;
  inactiveSince: string | null;
  sessions: number;
  bytes: number | string;
  lastActivityAt: string | null;
}

export interface AdoptionStageView {
  id: string;
  label: string;
  /** The ONE thing this number was computed from. Rendered beside it, because a
   *  funnel whose stages come from different places is only readable if it says
   *  which is which. */
  source: string;
  attestation: "cloud-attested" | "fortress-observed";
  detail: string;
  count: number;
  share: number | null;
}

export interface AdoptionView {
  /** Null when no roster has ever arrived — a different fact from a roster that
   *  reported nobody, and the page says so in different words. */
  sync: { asOf: string; receivedAt: string; members: number } | null;
  counts: {
    rostered: number;
    installed: number;
    syncComplete: number;
    sending: number;
    active: number;
    formerMembers: number;
    unrostered: number;
  };
  stages: AdoptionStageView[];
  roster: RosterPersonRow[];
  unrostered: Array<{
    userExternalId: string;
    displayName: string | null;
    sessions: number;
    bytes: number | string;
    lastActivityAt: string | null;
  }>;
  teams: Array<{ name: string; members: number; sending: number }>;
  attention: Array<{ externalId: string; displayName: string; kind: string; detail: string }>;
}

export interface DeviceRow {
  userExternalId: string;
  deviceId: string;
  name: string | null;
  os: string | null;
  arch: string | null;
  lastSeenAt: string | null;
  lastUploadAt: string | null;
  syncTotal: number | null;
  syncDone: number | null;
  syncReportedAt: string | null;
}

export interface GrowthRow {
  day: string;
  sessions: number;
  bytes: number | string;
}

export interface FactsView {
  postgres: { databaseBytes: number | string; sessions: number; people: number; tombstones: number } | null;
  embeddings: { embedded: number; models: number; newestAt: string | null } | null;
  storage: {
    provider: string | null;
    bucket: string | null;
    region: string | null;
    versioning: string;
    lifecycle: string;
  };
}

export interface IdentityFacts {
  fortressId: string | null;
  boundOrgId: string | null;
  credentialWrittenAt: string | null;
  root: string;
  daemonRoot: string | null;
  rootMatch: "same" | "different" | "unknown";
  paths: Record<string, string>;
  roles: { name: string; what: string }[];
  postgresMode: "embedded" | "external" | "unknown";
  retention: { logs: string; auditTrail: string };
}

export interface MetricsView {
  metrics: { schemaVersion: 1; writtenAt: string; counters: Record<string, number>; gauges: Record<string, number> } | null;
  reason?: string;
}

export interface DataPathRow {
  id: string;
  name: string;
  direction: "in" | "out" | "both";
  peer: string;
  carries: string;
  gate: string;
  notes?: string[];
}

export type RemoteVersion =
  | { kind: "available"; version: string; checkedAt: string; cached: boolean }
  | { kind: "unavailable"; reason: string; checkedAt: string; cached: boolean };

/** One storage-migration run, as the daemon recorded it. Buckets and counts; no
 *  keys, and nothing that binds this fortress to either bucket. */
export interface MigrationRunView {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  mode: string;
  status: string;
  phase: string;
  sourceBucket: string;
  targetBucket: string;
  sessionsTotal: number;
  sessionsCopied: number;
  bytesCopied: number;
  deltaPasses: number;
  switchedAt: string | null;
  error: string | null;
}

export interface CommandView {
  id: string;
  kind: string;
  status: string;
  requestedAt: string;
  requestedBy: string | null;
  completedAt: string | null;
  outcome: string | null;
  error: string | null;
  corroboration: {
    state: "confirmed" | "awaiting" | "reported-unconfirmed" | "disputed";
    arm?: "fabricated" | "denied";
    expectedDigest: string;
    records: number;
  };
  copy: string[];
}

export interface PostureView {
  state: "fresh" | "stale" | "unavailable" | "never-fetched";
  asOf: string | null;
  cloudOnlySessions: number | null;
  routedHere: number | null;
  qualification: string;
  clockSkew?: { offsetSeconds: number; allowedSeconds: number; remediation: string };
  witness: { enabled: boolean; changedAt: string | null; changedBy: string | null } | null;
  findings: {
    runStartedAt: string | null;
    total: number;
    shown: number;
    rows: ResidencyFindingRow[];
  } | null;
  /** The latest completed run, whatever it found — carried apart from
   *  `findings` because a CLEAN run has no finding row to hang a timestamp on.
   *  `null` means no run has ever completed here, which is not the same thing. */
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
  acknowledgeable: boolean;
}

export interface AuditRow {
  id: string;
  ts: string;
  origin: string;
  actor: string | null;
  sessionRef: string | null;
  tier: string | null;
  action: string;
  params: unknown;
  kind: string;
  refFileId: string | null;
  refSeq: number | null;
  outcome: string | null;
  error: string | null;
  spoolFileId: string;
  seq: number;
}

/** A record as it sits in the spool, before any drain. The audit panel renders
 *  these when Postgres is down: the trail is still being written, and a panel
 *  that showed nothing would say the opposite. */
export interface SpoolRecord {
  fileId: string;
  seq: number;
  ts: string;
  origin: string;
  actor: string | null;
  sessionRef: string | null;
  action: string;
  kind: string;
  outcome: string | null;
  error: string | null;
}

export type VerifyVerdict = "healthy" | "missing" | "mismatch" | "orphan" | "witness-unavailable";

export interface VerifyResult {
  family: string;
  sessionId: string;
  verdict: VerifyVerdict;
  headline: string;
  checks: { name: string; state: "passed" | "failed" | "not-checked"; detail: string }[];
  proof: string[];
}

export interface SignedIn {
  login: string;
  role: "operator" | "readonly";
  workbenchSub: string | null;
  createdAt: string;
}

// ── the calls ────────────────────────────────────────────────────────────────

export const api = {
  /** `entryId` names a server-side record. The workbench identity is stamped
   *  from that record — never from anything this client sends — so a forged one
   *  annotates nothing. */
  signIn: (login: string, password: string, entryId?: string | null) =>
    getJson<{ token: string; login: string; role: "operator" | "readonly"; sessions: string }>(
      API.session,
      {
        method: "POST",
        body: { login, password, ...(entryId ? { entryId } : {}) },
        anonymous: true,
      },
    ),
  whoami: () => getJson<SignedIn>(API.session),
  signOut: () => request(API.session, { method: "DELETE" }).then(() => undefined),

  setupStatus: (setupToken: string) =>
    getJson<{ status: "live"; login: string; marker: string | null }>(API.setupStatus, {
      setupToken,
      anonymous: true,
    }),
  completeSetup: (setupToken: string, password: string) =>
    getJson<{ completed: true; login: string; role: string }>(API.setupComplete, {
      method: "POST",
      setupToken,
      body: { password },
      anonymous: true,
    }),
  /** FOUR fields. Three are for the page to render; only `entryId` is carried
   *  onward, and all it carries is an annotation the SERVER stamps. */
  ssoExchange: (grant: string) =>
    getJson<{ entryId: string; workbenchSub: string; org: string; marker: string | null }>(
      API.ssoExchange,
      { method: "POST", body: { grant }, anonymous: true },
    ),

  status: () => getJson<StatusView>(API.status),
  /** Drive the daemon's own unit. Runs in the console process, because a
   *  stopped daemon polls for nothing. */
  serviceAction: (action: "start" | "stop" | "restart") =>
    getJson<{ action: string; manager: string; pid: number | null; copy: string }>(API.service, {
      method: "POST",
      body: { action },
    }),
  /** Ask the daemon to do something. The answer is the REQUEST's id; what
   *  happened is read back off the command row and its corroboration. */
  submitCommand: (kind: string, params: Record<string, unknown> = {}) =>
    getJson<{ id: string; kind: string; status: string }>(API.commands, {
      method: "POST",
      body: { kind, params },
    }),
  /** A command that carries material the row must never hold. The secret goes
   *  to a 0600 single-use file on the fortress; the row gets its reference. */
  submitCommandWithSecret: (
    kind: string,
    secret: Record<string, unknown>,
    params: Record<string, unknown> = {},
  ) =>
    getJson<{ id: string; kind: string; status: string }>(API.commands, {
      method: "POST",
      body: { kind, params, secret },
    }),
  sessions: (query: Record<string, string>) =>
    getJson<SessionsPage>(`${API.sessions}?${new URLSearchParams(query).toString()}`),
  people: () => getJson<{ people: PersonRow[] }>(API.people),
  adoption: () => getJson<AdoptionView>(API.adoption),
  devices: () => getJson<{ devices: DeviceRow[] }>(API.devices),
  growth: (days: number) => getJson<{ days: GrowthRow[] }>(`${API.growth}?days=${days}`),
  facts: () => getJson<FactsView>(API.facts),
  identity: () => getJson<IdentityFacts>(API.identity),
  metrics: () => getJson<MetricsView>(API.metrics),
  dataPaths: () => getJson<{ title: string; rows: DataPathRow[] }>(API.dataPaths),
  version: () => getJson<RemoteVersion>(API.version),
  commands: () => getJson<{ commands: CommandView[] }>(API.commands),
  migrations: () => getJson<{ migrations: MigrationRunView[] }>(API.migrations),
  posture: () => getJson<PostureView>(API.posture),
  audit: (query: Record<string, string>) =>
    getJson<{ rows: AuditRow[]; nextCursor?: string }>(
      `${API.audit}?${new URLSearchParams(query).toString()}`,
    ),
  report: () => getJson<Record<string, unknown>>(API.report),
  spool: (limit = 100) => getJson<{ records: SpoolRecord[] }>(`${API.spool}?limit=${limit}`),
  verify: (family: string, session: string) =>
    getJson<VerifyResult>(
      `${API.verify}?${new URLSearchParams({ family, session }).toString()}`,
    ),
  /** Acknowledging a copied proof is a read-AUDITED act: the copy left the box,
   *  and the trail records which one. */
  proofCopyAck: (query: Record<string, string>) =>
    getJson<{ acknowledgedAt: string; actor: string }>(
      `${API.proofCopyAck}?${new URLSearchParams(query).toString()}`,
      { method: "POST" },
    ),
};

/**
 * A download the SERVER produced.
 *
 * The console generates no artifact of its own: a report or a PDF assembled in
 * the tab would leave the box with nothing recorded, and an audit trail that
 * cannot say which copy left is not a trail. So this fetches the audited
 * endpoint with the session header — an anchor href cannot carry one — and hands
 * the bytes the server sent to the browser unchanged.
 */
export async function downloadFromServer(path: string, filename: string): Promise<void> {
  const res = await request(path);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

// ── the one long-lived connection ────────────────────────────────────────────

export interface StreamHandlers {
  onEvent(event: string, data: unknown, id: string | null): void;
  onOpen?(): void;
  /** Called with the reason a connection ended, so a banner can say whether the
   *  console is reconnecting or the session is gone. */
  onClosed?(reason: string): void;
}

/**
 * Follow /ui/api/events.
 *
 * fetch + ReadableStream rather than EventSource, because EventSource cannot set
 * a request header and the session lives in one by design. The framing is parsed
 * by hand for the same reason.
 *
 * The connection CLOSES when the tab is hidden: a background tab holding a
 * stream spends a per-user cap slot on a page nobody is reading. It reopens on
 * the way back, and `last-event-id` makes that resume rather than replay.
 */
export function openEventStream(handlers: StreamHandlers): () => void {
  let stopped = false;
  let attempt = 0;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastEventId: string | null = null;

  const backoff = (): number =>
    EVENTS_BACKOFF_MS[Math.min(attempt, EVENTS_BACKOFF_MS.length - 1)] as number;

  const schedule = (): void => {
    if (stopped || document.visibilityState === "hidden") return;
    const wait = backoff();
    attempt += 1;
    timer = setTimeout(() => void connect(), wait);
  };

  const connect = async (): Promise<void> => {
    if (stopped || document.visibilityState === "hidden") return;
    controller = new AbortController();
    const token = readToken();
    if (!token) return;
    try {
      const res = await fetch(API.events, {
        headers: {
          [SESSION_HEADER]: token,
          ...(lastEventId ? { "last-event-id": lastEventId } : {}),
        },
        signal: controller.signal,
      });
      if (res.status === 401) {
        writeToken(null);
        onUnauthorized();
        return;
      }
      if (!res.ok || !res.body) {
        handlers.onClosed?.("the fortress refused the live connection");
        schedule();
        return;
      }
      attempt = 0;
      handlers.onOpen?.();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split = buffer.indexOf("\n\n");
        while (split >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const parsed = parseFrame(frame);
          if (parsed) {
            if (parsed.id !== null) lastEventId = parsed.id;
            handlers.onEvent(parsed.event, parsed.data, parsed.id);
          }
          split = buffer.indexOf("\n\n");
        }
      }
      handlers.onClosed?.("the live connection ended");
      schedule();
    } catch {
      if (stopped) return;
      handlers.onClosed?.("the live connection dropped");
      schedule();
    }
  };

  const onVisibility = (): void => {
    if (document.visibilityState === "hidden") {
      controller?.abort();
      if (timer) clearTimeout(timer);
    } else {
      attempt = 0;
      void connect();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  void connect();

  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", onVisibility);
    if (timer) clearTimeout(timer);
    controller?.abort();
  };
}

function parseFrame(frame: string): { event: string; data: unknown; id: string | null } | null {
  let event = "message";
  let id: string | null = null;
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    // A comment frame is the heartbeat. It keeps proxies from idling the
    // connection out and carries nothing to render.
    if (line.startsWith(":") || line === "") continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
    else if (field === "id") id = value;
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")), id };
  } catch {
    return { event, data: dataLines.join("\n"), id };
  }
}
